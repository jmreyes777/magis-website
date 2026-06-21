/**
 * utils/socket.js
 * ---------------------------------------------------------------------------------------
 * Socket.IO server with Redis adapter + presence TTL + JWT verification (HS256 + Firebase)
 * Cluster-safe, idempotent Redis connects, and minimal hot-path overhead.
 *
 * NOTE TO MAINTAINERS:
 * - Presence is written to Redis using short TTL keys (PRESENCE_PREFIX + branchEmail).
 * - Redis adapter is initialized once at startup using ensureRedisConnected() guards.
 * - Multi-instance correctness: presence + adapter + rate-limits + undelivered queue
 *   are Redis-backed. We keep some in-memory maps for ephemeral per-process runtime
 *   conveniences (e.g., sockets, heartbeats, local presence lists for UI push).
 * ---------------------------------------------------------------------------------------
 */

const { Server } = require("socket.io");
const cookie = require("cookie");
const { db, admin } = require("./firebase");
const { verifyJWT } = require("./secretPool");   // worker-thread backed JWT ops
const CLOCK_TOLERANCE_SEC = Number(process.env.JWT_CLOCK_SKEW_SEC || "30");

// Message rate-limit (guest -> server). Fixed window = 1 hour.
const MAX_PER_WINDOW = parseInt(process.env.MAX_MESSAGES_PER_HOUR, 10) || 100;
const RATE_KEY_PREFIX = process.env.REDIS_RATE_PREFIX || "ratelimit:guest:";

// Redis queue (undelivered guest→admin messages)
const UNDELIVERED_PREFIX = process.env.REDIS_UNDELIVERED_PREFIX || "queue:undelivered:";

// Optional Redis adapter
let createAdapter;
try {
  createAdapter = require("@socket.io/redis-adapter").createAdapter;
} catch (err) {
  console.log("[SOCKET] Redis adapter not available, running without Redis");
  createAdapter = null;
}

const { z } = require("zod");

// IMPORTANT: ioredis helper (idempotent connect guards)
const { getRedis, getRedisSub, ensureRedisConnected } = require("./redis");

// ─────────────────────────────────────────────────────────────────────────────
// Global-runtime structures (per-process)
// ─────────────────────────────────────────────────────────────────────────────
let io;
const clients = new Map();         // socket.id -> { role, identifier, room, branchEmail, tabId, sessionTabId, lastSeen }
const sessionTracker = new Map();  // branchEmail -> Set(sessionTabIds)
const heartbeatMap = new Map();    // "branchEmail::sessionTabId" -> last heartbeat timestamp
const broadcastMap = new Map();    // "branchEmail::sessionTabId" -> last broadcastAlive timestamp
const readyAdmins = {};            // branchEmail -> { sessionTabId: true }

const HEARTBEAT_INTERVAL = 30000;
const MAX_MISSED_PINGS = 10;

// 👥 Track active guests per branch (ephemeral in-memory list of recent/active guests)
const branchGuests = new Map();     // branchEmail -> Set(guestIds)
const onlineAdminsMap = {};         // branchEmail -> { sessionTabId: socketId }
const branchAwayGuests = new Map(); // branchEmail -> Set(guestIds considered idle)

// ─────────────────────────────────────────────────────────────
// Presence in Redis: TTL keys to mark branch online
// ─────────────────────────────────────────────────────────────
const PRESENCE_PREFIX = process.env.REDIS_PRESENCE_PREFIX || "branch:online:";
const ONLINE_TTL_SEC = Number(process.env.ONLINE_TTL_SEC || 90);

/**
 * Mark a branch online in Redis with a short TTL (idempotent; refreshes TTL).
 */
async function touchBranchOnline(branchEmail) {
  if (!branchEmail) return;
  const client = getRedis();
  try {
    await ensureRedisConnected(client);
    await client.set(
      `${PRESENCE_PREFIX}${branchEmail.toLowerCase()}`,
      Date.now().toString(),
      "EX",
      ONLINE_TTL_SEC
    );
  } catch (e) {
    console.warn("[presence] Redis touch failed:", e.message);
  }
}

// ─────────────────────────────────────────────────────────────
// Guest presence in Redis (Phase C): ONE sorted set per branch,
// `guest:online:z:<email>`, where member = guestId and score = last-seen epoch ms.
// A guest is "online" while their score is within GUEST_ONLINE_TTL_SEC of now; the
// score is refreshed by the guest heartbeat. This gives cross-instance correctness
// and a bounded ghost window (~GUEST_ONLINE_TTL_SEC) for silently-dropped guests,
// with keyspace-independent O(log N + M) reads (no SCAN — avoids any PERF3-2
// regression on the frequent presence reconciliation path). branchGuests stays as a
// local cache + fail-open fallback when Redis is unavailable (C3).
// ─────────────────────────────────────────────────────────────
const GUEST_PRESENCE_PREFIX = process.env.REDIS_GUEST_PRESENCE_PREFIX || "guest:online:z:";
const GUEST_ONLINE_TTL_SEC = Number(process.env.GUEST_ONLINE_TTL_SEC || 90);

const guestZsetKey = (branchEmail) =>
  `${GUEST_PRESENCE_PREFIX}${(branchEmail || "").toLowerCase()}`;

/** C1: mark/refresh a guest online (bump score to now). Best-effort; never throws. */
async function markGuestOnline(branchEmail, guestId) {
  if (!branchEmail || !guestId) return;
  const client = getRedis();
  try {
    await ensureRedisConnected(client);
    const key = guestZsetKey(branchEmail);
    // Backstop EXPIRE so an abandoned set (all guests silently dropped, no admin
    // reading to prune) eventually self-cleans; refreshed on every heartbeat.
    await client
      .multi()
      .zadd(key, Date.now(), guestId)
      .expire(key, GUEST_ONLINE_TTL_SEC * 4)
      .exec();
  } catch (e) {
    console.warn("[presence] Redis guest touch failed:", e.message);
  }
}

/** C1: explicitly mark a guest offline (used on clean chatClosed). Never throws. */
async function markGuestOffline(branchEmail, guestId) {
  if (!branchEmail || !guestId) return;
  const client = getRedis();
  try {
    await ensureRedisConnected(client);
    await client.zrem(guestZsetKey(branchEmail), guestId);
  } catch (e) {
    console.warn("[presence] Redis guest untouch failed:", e.message);
  }
}

/**
 * C2: authoritative online-guest read — members of the per-branch sorted set whose
 * last-seen score is within the TTL window (cross-instance truth). Stale members are
 * pruned opportunistically. Throws if Redis is unreachable so callers can fail open
 * to the in-memory cache (C3).
 */
async function getOnlineGuestsFromRedis(branchEmail) {
  const client = getRedis();
  await ensureRedisConnected(client);
  const key = guestZsetKey(branchEmail);
  const cutoff = Date.now() - GUEST_ONLINE_TTL_SEC * 1000;
  // Live = refreshed within the TTL window (score >= cutoff). Uses the modern
  // ZRANGE … BYSCORE (Redis ≥ 6.2; ZRANGEBYSCORE is deprecated).
  const live = await client.zrange(key, cutoff, "+inf", "BYSCORE");
  // Opportunistically drop members that have aged out (best-effort, fire-and-forget).
  // ZREMRANGEBYSCORE is the canonical ranged-removal command (not deprecated).
  client.zremrangebyscore(key, "-inf", `(${cutoff}`).catch(() => {});
  return live || [];
}

/**
 * Online guests for a branch — Redis-authoritative (C2) with fail-open to the
 * in-memory `branchGuests` cache (C3). Mirrors the existing "running without Redis
 * adapter" tolerance: no hard new dependency.
 */
async function getBranchPresence(branchEmail) {
  if (!branchEmail) return [];
  try {
    return await getOnlineGuestsFromRedis(branchEmail);
  } catch (e) {
    console.warn("[presence] Redis read failed; falling back to in-memory branchGuests:", e.message);
    const local = branchGuests.get(branchEmail);
    return local ? [...local] : [];
  }
}

/**
 * Normalize a room name. Returns "<prefix>-<identifier>".
 */
const normalizeRoomName = (role, id) => {
  if (!id || typeof id !== "string") {
    console.warn("[SOCKET] Invalid room identifier received. Defaulting to 'unknown'.");
    id = "unknown";
  }
  const prefix = role === "admin" || role === "branchadmin" ? "admin" : "guest";
  const regex = new RegExp(`^${prefix}-`, "i");
  id = id.replace(regex, "");
  return `${prefix}-${id}`;
};

const getRoomName = (role, id) => normalizeRoomName(role, id);

/**
 * Compute away/online lists for guests and emit presence only for those truly online.
 */
async function checkForStaleGuests(branchEmail) {
  if (!branchEmail) return;

  let onlineNow;
  try {
    // C2: Redis is authoritative when available — cross-instance set with TTL
    // auto-expiry already removes silently-dropped guests, so no local away-scan.
    onlineNow = await getOnlineGuestsFromRedis(branchEmail);
  } catch (e) {
    // C3 fallback (Redis down): legacy per-instance away detection.
    const liveSet = branchGuests.get(branchEmail);
    if (!liveSet) return;

    const currentActive = new Set();
    for (const client of clients.values()) {
      if (client.role === "user" && client.branchEmail === branchEmail) {
        currentActive.add(client.identifier);
      }
    }

    let awaySet = branchAwayGuests.get(branchEmail);
    if (!awaySet) {
      awaySet = new Set();
      branchAwayGuests.set(branchEmail, awaySet);
    }

    for (const guestId of liveSet) {
      if (!currentActive.has(guestId)) awaySet.add(guestId);
      else awaySet.delete(guestId);
    }

    onlineNow = [...liveSet].filter((id) => !awaySet.has(id));
  }

  io.to(getRoomName("admin", branchEmail)).emit("guestPresenceUpdate", onlineNow);
}

// ─────────────────────────────────────────────────────────────
// Redis-backed undelivered queue helpers
// ─────────────────────────────────────────────────────────────
async function bufferUndelivered(branchEmail, messageObj) {
  if (!branchEmail) return;
  try {
    const client = getRedis();
    await ensureRedisConnected(client);
    await client.rpush(`${UNDELIVERED_PREFIX}${branchEmail.toLowerCase()}`, JSON.stringify(messageObj));
  } catch (err) {
    console.warn("[SOCKET] Redis bufferUndelivered unavailable:", err.message);
  }
}

/**
 * Drain all buffered messages for a branch (returns Array<messageObj>).
 * Uses LRANGE + DEL (simple & sufficient here).
 */
async function drainUndelivered(branchEmail) {
  if (!branchEmail) return [];
  try {
    const client = getRedis();
    await ensureRedisConnected(client);
    const key = `${UNDELIVERED_PREFIX}${branchEmail.toLowerCase()}`;
    const messages = await client.lrange(key, 0, -1);
    if (messages.length > 0) {
      await client.del(key);
    }
    return messages.map((m) => JSON.parse(m));
  } catch (err) {
    console.warn("[SOCKET] Redis drainUndelivered unavailable:", err.message);
    return [];
  }
}

// ─────────────────────────────────────────────────────────────
// Zod schema for socket messages
// ─────────────────────────────────────────────────────────────
const messageSchema = z.object({
  guestId: z.string().nonempty(),
  content: z.string().optional(),
  media: z
    .object({
      url: z.string().url(),
      type: z.string(),
    })
    .optional(),
  sender: z.string().nonempty(),
});

// ─────────────────────────────────────────────────────────────────────────────
// MAIN INITIALIZER
// ─────────────────────────────────────────────────────────────────────────────
const initializeSocket = (server) => {
  if (io) return io;

  io = new Server(server, {
    cors: {
      origin: [
        "http://localhost:3000",
        "https://localhost:3000",
        "http://localhost:3001",
        "https://localhost:3001",
        "http://localhost:3002",
        "https://localhost:3002",
        "http://localhost:4000",
        "https://localhost:4000",
      ],
      methods: ["GET", "POST"],
    },
    pingInterval: 25000,
    pingTimeout: 60000,
    perMessageDeflate: true,
    // PERF3-2: pin WebSocket-only transport. Every client already connects with
    // transports:['websocket'], so this is a no-op for real traffic — but it is
    // what makes HORIZONTAL SCALING safe: a WebSocket is a single TCP connection
    // pinned to one instance for its lifetime (no HTTP long-polling), so NO
    // sticky sessions are required across instances. Cross-instance broadcast is
    // handled by the Redis adapter below. It also stops a stray client/proxy
    // from silently downgrading to polling against a non-sticky multi-instance
    // backend (which would break the session).
    transports: ["websocket"],
    allowUpgrades: false,
  });

  // Redis adapter for multi-instance Socket.IO (optional)
  if (createAdapter) {
    const pubClient = getRedis();
    const subClient = getRedisSub();
    (async () => {
      try {
        await ensureRedisConnected(pubClient);
        await ensureRedisConnected(subClient);
        io.adapter(createAdapter(pubClient, subClient));
        console.log("[socket] Redis adapter enabled");
      } catch (err) {
        console.warn("[socket] Redis adapter not connected, running in-memory only", err.message);
      }
    })();
  } else {
    console.log("[socket] Running without Redis adapter");
  }

  const jwt = require("jsonwebtoken"); // used only for cookie decode fallback if needed

  // ───────────────────────────────────────────────────────────────────────────
  // Handshake authentication (HS256 fallback or Firebase ID token)
  // ───────────────────────────────────────────────────────────────────────────
  io.use(async (socket, next) => {
    const { token, tabId, sessionTabId, branchEmail: clientEmail, guestId } =
      socket.handshake.auth || {};

    console.log("[SOCKET AUTH] 🔐 Incoming connection auth payload:", {
      tokenSnippet: token ? token.substring(0, 20) + "..." : "(none)",
      tabId,
      sessionTabId,
      clientEmail,
      guestId,
    });

    if (!token || !tabId || !sessionTabId || (!clientEmail && !guestId)) {
      console.warn("[SOCKET AUTH] ❌ Missing required auth fields");
      return next(new Error("Missing required auth details"));
    }

    try {
      let decodedToken;
      let branchEmail = (clientEmail || "").toLowerCase();
      let isFallbackToken = false;

      // 1) Try worker-backed HS256
      try {
        decodedToken = await verifyJWT(token, {
          algorithms: ["HS256"],
          clockTolerance: CLOCK_TOLERANCE_SEC,
        });

        if (decodedToken?.fallback === true && decodedToken.email) {
          branchEmail = decodedToken.email.toLowerCase();
          isFallbackToken = true;
          console.log(`[SOCKET AUTH] 🟡 Verified fallback token for ${branchEmail}`);
        } else {
          throw new Error("Not a fallback HMAC token");
        }
      } catch (fallbackErr) {
        // 2) Firebase ID token
        try {
          const firebaseDecoded = await admin.auth().verifyIdToken(token);
          decodedToken = firebaseDecoded;
          branchEmail = (firebaseDecoded.email || clientEmail || "").toLowerCase();
          console.log(`[SOCKET AUTH] 🟢 Verified Firebase token for ${branchEmail}`);
        } catch (firebaseErr) {
          // HMAC path saturated (worker pool full) → signal a transient, retryable
          // error so the client reconnects rather than treating it as an auth
          // failure. A valid Firebase token still authenticates above.
          if (fallbackErr && fallbackErr.code === "EWORKERBUSY") {
            return next(new Error("ServiceBusy"));
          }
          console.error("[SOCKET AUTH] 🔥 Both fallback and Firebase verification failed:", {
            fallbackError: fallbackErr.message,
            firebaseError: firebaseErr.message,
          });
          return next(new Error("Unauthorized"));
        }
      }

      // 3) Guest flow
      if (decodedToken.role === "user" && decodedToken.guestId) {
        branchEmail = (decodedToken.email || clientEmail || "").toLowerCase();
        socket.user = {
          role: "user",
          guestId: decodedToken.guestId,
          branchEmail,
          tabId,
          sessionTabId,
          authSource: isFallbackToken ? "fallback" : "firebase",
        };
        console.log(`[SOCKET AUTH] ✅ Guest user authenticated: ${decodedToken.guestId}`);
        return next();
      }

      // 4) Admin flow
      const sessions = sessionTracker.get(branchEmail) || new Set();
      if (!sessions.has(sessionTabId)) {
        sessions.add(sessionTabId);
        sessionTracker.set(branchEmail, sessions);
      }

      branchEmail = (decodedToken.email || clientEmail || "").toLowerCase();

      socket.user = {
        ...decodedToken,
        tabId,
        sessionTabId,
        branchEmail,
        authSource: isFallbackToken ? "fallback" : "firebase",
      };

      console.log(`[SOCKET AUTH] ✅ Auth success for ${branchEmail} via ${socket.user.authSource}`);
      return next();
    } catch (err) {
      console.error("[SOCKET AUTH] ❌ Token verification failed:", err);
      return next(new Error("Unauthorized"));
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Per-event JWT re-verification (non-heartbeat)
  // ───────────────────────────────────────────────────────────────────────────
  io.on("connection", async (socket) => {
    if (socket._hasInitialized) return;
    socket._hasInitialized = true;

    socket.use(async (packet, next) => {
      const eventName = packet[0];
      // Lightweight presence/lifecycle pings skip per-event JWT re-verification.
      // Privileged reads — including `requestGuestPresence` (B3) — are deliberately
      // NOT listed here, so they pass full token re-verification below like every
      // other data event. Do not add requestGuestPresence to this allow-list.
      if (["heartbeat", "tabAlive", "broadcastAlive", "chatClosed", "markRead"].includes(eventName)) {
        return next();
      }

      let token =
        (socket.auth && socket.auth.token) ||
        (socket.handshake && socket.handshake.auth && socket.handshake.auth.token) ||
        null;

      const looksExpired = (t) => {
        try {
          const parts = (t || "").split(".");
          if (parts.length !== 3) return true;
          const payload = JSON.parse(Buffer.from(parts[1], "base64").toString("utf8"));
          if (!payload || typeof payload.exp !== "number") return true;
          return Date.now() >= payload.exp * 1000;
        } catch {
          return true;
        }
      };

      if (!token || looksExpired(token)) {
        try {
          const raw = socket.request?.headers?.cookie || "";
          const cookies = cookie.parse(raw || "");
          if (cookies.guestToken) {
            token = cookies.guestToken;
            console.debug("[SOCKET AUTH] 🔄 Using guestToken from cookie for event:", eventName);
          } else if (cookies.branchAdminToken) {
            token = cookies.branchAdminToken;
            console.debug("[SOCKET AUTH] 🔄 Using branchAdminToken from cookie for event:", eventName);
          }
        } catch {
          // ignore
        }
      }

      if (!token) {
        console.warn("[SOCKET AUTH] ❌ No JWT available for event:", eventName);
        return socket.disconnect(true);
      }

      try {
        await verifyJWT(token, { algorithms: ["HS256"], clockTolerance: CLOCK_TOLERANCE_SEC });
        return next();
      } catch (err) {
        console.error("[SOCKET AUTH] ❌ JWT re-verification failed:", err.message);
        return socket.disconnect(true);
      }
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Presence / rooms / registration logic
    // ─────────────────────────────────────────────────────────────────────────
    const { role, guestId, branchEmail, tabId, sessionTabId } = socket.user || {};
    const isAdmin = role === "admin" || role === "branchadmin";
    const identifier = isAdmin ? socket.user?.email : guestId;
    const room = getRoomName(role, identifier);

    if (!socket.rooms.has(room)) {
      socket.join(room);
      console.log(`[SOCKET] ✅ Socket ${socket.id} joined room: ${room}`);
    }

    if (isAdmin && branchEmail) {
      const branchRoom = getRoomName("admin", branchEmail);
      if (!socket.rooms.has(branchRoom)) {
        socket.join(branchRoom);
        console.log(`[SOCKET] 👑 Admin socket joined branch room: ${branchRoom}`);
      }

      // ▶️ Replay any buffered undelivered messages from Redis
      const pending = await drainUndelivered(branchEmail);
      if (pending?.length) {
        pending.forEach((msg) => socket.emit("receiveMessage", msg));

        // Recompute unread and broadcast
        const guests = [...new Set(pending.map((m) => m.guestId))];
        for (const gId of guests) {
          const snap = await db
            .collection("messages")
            .where("branchEmail", "==", branchEmail)
            .where("guestId", "==", gId)
            .where("seenByAdmin", "==", false)
            .get();
          io.to(getRoomName("admin", branchEmail)).emit("updateUnread", {
            guestId: gId,
            unreadCount: snap.size,
          });
        }

        console.log(`[SOCKET] 🔄 Replayed ${pending.length} buffered msgs for ${branchEmail}`);
      }

      // Send initial presence to this admin (C2: Redis-authoritative, fail-open).
      const initialPresence = await getBranchPresence(branchEmail);
      socket.emit("guestPresenceUpdate", initialPresence);
      console.log(`[SOCKET] ⏯ Sent initial guestPresenceUpdate to admin ${branchEmail}:`, initialPresence);
    }

    // For branch admins, register them and mark branch online (presence)
    if (isAdmin && branchEmail && sessionTabId) {
      if (!onlineAdminsMap[branchEmail]) {
        onlineAdminsMap[branchEmail] = {};
      }
      onlineAdminsMap[branchEmail][sessionTabId] = socket.id;
      console.log(`[SOCKET] ✅ Registered admin ${branchEmail} tab ${sessionTabId} with socket ID: ${socket.id}`);

      try { await touchBranchOnline(branchEmail); } catch (_) {}

      const guestSet = branchGuests.get(branchEmail);
      if (guestSet && guestSet.size > 0) {
        guestSet.forEach((gid) => {
          const guestRoom = getRoomName("guest", gid);
          io.to(guestRoom).emit("branchStatus", {
            branchEmail,
            online: true,
            lastSeen: new Date().toISOString(),
          });
        });
        console.log(`[SOCKET] 🔔 Emitted branchStatus ONLINE to guests for ${branchEmail}:`, [...guestSet]);
      }
    }

    clients.set(socket.id, {
      role,
      identifier,
      room,
      branchEmail,
      tabId,
      sessionTabId,
      lastSeen: Date.now(),
    });

    // For guest users, track presence and send branch status
    if (!isAdmin && guestId && branchEmail) {
      const guestSet = branchGuests.get(branchEmail) || new Set();
      guestSet.add(guestId);
      branchGuests.set(branchEmail, guestSet);

      // C1: record this guest in Redis (TTL) BEFORE computing the authoritative set.
      await markGuestOnline(branchEmail, guestId);
      // C2: emit the cross-instance authoritative set (not just this instance's),
      // so an admin on any instance sees every online guest.
      const presence = await getBranchPresence(branchEmail);
      io.to(getRoomName("admin", branchEmail)).emit("guestPresenceUpdate", presence);
      console.log(`[GUEST PRESENCE] ✅ ${guestId} marked online for ${branchEmail} (${presence.length} online)`);

      // Check if any admin is online for this branch (guest presence should NOT mark branch as online)
      const anyAdminOnline = !!(onlineAdminsMap[branchEmail] && Object.keys(onlineAdminsMap[branchEmail]).length > 0);
      const branchOnline = anyAdminOnline;
      
      socket.emit("branchStatus", {
        branchEmail,
        online: branchOnline,
        lastSeen: new Date().toISOString(),
      });
      console.log(`[SOCKET] 🔔 Sent initial branchStatus to guest ${guestId}:`, { branchEmail, online: branchOnline });
    }

    // ───────────────────────────────────────────────────────────────────
    // joinRoom
    // ───────────────────────────────────────────────────────────────────
    socket.on("joinRoom", async (roomName, ack) => {
      // SECURITY (P1-2): never trust the client-supplied room. Derive the room
      // strictly from the verified token identity so a branch admin cannot
      // subscribe to another branch's conversations, and a guest cannot
      // subscribe to another guest's chat. `roomName` is advisory only.
      const u = socket.user || {};
      const isAdminUser = u.role === "admin" || u.role === "branchadmin";
      const ownIdentifier = isAdminUser ? (u.branchEmail || u.email) : u.guestId;

      if (!ownIdentifier) {
        console.warn(`[SOCKET] 🚫 joinRoom: no identity on socket ${socket.id} (role=${u.role}); ignoring`);
        if (typeof ack === "function") ack();
        return;
      }

      const normalizedRoom = getRoomName(u.role, ownIdentifier);

      if (typeof roomName === "string" && roomName.trim()) {
        const requested = normalizeRoomName(u.role, roomName);
        if (requested !== normalizedRoom) {
          console.warn(
            `[SOCKET] 🚫 joinRoom denied: socket ${socket.id} (${u.role}/${ownIdentifier}) requested "${requested}" — bound to own room "${normalizedRoom}"`
          );
        }
      }

      if (!socket.rooms.has(normalizedRoom)) {
        socket.join(normalizedRoom);
        console.log(`[SOCKET] ✅ Socket ${socket.id} joined room: ${normalizedRoom}`);
      }

      const user = socket.user;
      if (!user || !user.branchEmail) {
        if (typeof ack === "function") ack();
        return;
      }
      const { role, branchEmail, sessionTabId } = user;
      const isAdmin = role === "admin" || role === "branchadmin";

      if (isAdmin && branchEmail && sessionTabId) {
        if (!onlineAdminsMap[branchEmail]) {
          onlineAdminsMap[branchEmail] = {};
        }
        onlineAdminsMap[branchEmail][sessionTabId] = socket.id;
        console.log(`[SOCKET] ✅ Registered admin ${branchEmail} tab ${sessionTabId} with socket ID: ${socket.id}`);

        const guestSet = branchGuests.get(branchEmail);
        if (guestSet && guestSet.size > 0) {
          guestSet.forEach((gId) => {
            io.to(getRoomName("guest", gId)).emit("branchStatus", {
              branchEmail,
              online: true,
              lastSeen: new Date().toISOString(),
            });
          });
          console.log(`[SOCKET] 🔔 Emitted branchStatus ONLINE to guests for ${branchEmail}:`, [...guestSet]);
        }

        try { await touchBranchOnline(branchEmail); } catch (_) {}

        // B2: re-emit authoritative presence to THIS admin on (re)join, so a correct
        // guest set exists even if the A3 `requestGuestPresence` pull is still in
        // flight. Third layer alongside the connection-time push (:436) and the
        // explicit pull handler. Sent to the requesting socket only.
        socket.emit("guestPresenceUpdate", await getBranchPresence(branchEmail));
      }

      if (typeof ack === "function") ack();
    });

    // ───────────────────────────────────────────────────────────────────
    // requestGuestPresence (R1 server-side): an admin client explicitly pulls the
    // authoritative live guest set AFTER it has (re)bound its listeners, so the UI
    // can never depend on the racing connection-time push. The reply is sent to the
    // REQUESTING socket only. `branchEmail` is derived strictly from the verified
    // token identity (P1-2) — client input is never trusted (mirrors joinRoom). This
    // event is intentionally excluded from the socket.use bypass list (B3), so it
    // passes full per-event JWT re-verification like any other privileged read.
    // ───────────────────────────────────────────────────────────────────
    socket.on("requestGuestPresence", async (ack) => {
      const u = socket.user || {};
      const isAdminUser = u.role === "admin" || u.role === "branchadmin";
      const bEmail = (u.branchEmail || "").toLowerCase();

      if (!isAdminUser || !bEmail) {
        // Guests / identity-less sockets get no presence data.
        if (typeof ack === "function") ack({ ok: false });
        return;
      }

      // C2: authoritative cross-instance set from Redis (fail-open to in-memory).
      const ids = await getBranchPresence(bEmail);
      socket.emit("guestPresenceUpdate", ids);
      console.log(`[SOCKET] 📡 requestGuestPresence → ${ids.length} guest(s) to admin ${bEmail}`);
      if (typeof ack === "function") ack({ ok: true, count: ids.length });
    });

    socket.on("confirmReady", ({ branchEmail, sessionTabId }) => {
      if (!readyAdmins[branchEmail]) readyAdmins[branchEmail] = {};
      readyAdmins[branchEmail][sessionTabId] = true;
      console.log(`[SOCKET] ✅ Admin tab ${sessionTabId} confirmed ready for ${branchEmail}`);
    });

    socket.on("tabAlive", ({ sessionTabId, timestamp }) => {
      const key = `${socket.user.branchEmail}::${sessionTabId}`;
      heartbeatMap.set(key, timestamp);
    });

    socket.on("broadcastAlive", async ({ sessionTabId, timestamp }) => {
      const key = `${socket.user.branchEmail}::${sessionTabId}`;
      broadcastMap.set(key, timestamp);

      const client = clients.get(socket.id);
      if (client) client.lastSeen = Date.now();

      if (socket.user && (socket.user.role === "admin" || socket.user.role === "branchadmin")) {
        try { await touchBranchOnline(socket.user.branchEmail); } catch (_) {}
      }

      checkForStaleGuests(socket.user.branchEmail);
    });

    socket.on("debugLog", (log) => {
      if (process.env.NODE_ENV === "production") return;
      const safe = typeof log === "string" ? log.replace(/[\r\n]+/g, " ") : log;
      console.log(`[DEBUG]`, safe);
    });

    // NOTE: The ephemeral ECDH key-exchange relays (e2ee:guest_key /
    // e2ee:branch_key / e2ee:request_key) were removed. E2EE now uses a
    // persistent per-conversation AES key fetched from the backend
    // (/api/messages/conversation-key), so no socket handshake is needed.
    // The `e2ee` flag on relayed messages (below) is still honored so the
    // recipient knows `content` is ciphertext.

    // ───────────────────────────────────────────────────────────────────
    // sendMessage (ACL + validation + emits + unread count)
    // ───────────────────────────────────────────────────────────────────
    socket.on("sendMessage", async (data, callback) => {
      try {
        // ─── Redis rate limit for guests (fixed 1-hour window) ─────────────
        if (socket.user.role === "user") {
          const gId = socket.user.guestId;
          try {
            const client = getRedis();
            await ensureRedisConnected(client);
            const key = `${RATE_KEY_PREFIX}${gId}:h`;
            const count = await client.incr(key);
            if (count === 1) {
              await client.expire(key, 60 * 60); // 1 hour
            }
            if (count > MAX_PER_WINDOW) {
              console.warn(`[RATE LIMIT] guest ${gId} ≥ ${MAX_PER_WINDOW}/hr (=${count})`);
              return typeof callback === "function"
                ? callback({ success: false, error: `Rate limit exceeded: max ${MAX_PER_WINDOW} messages per hour.` })
                : null;
            }
          } catch (redisErr) {
            console.warn("[SOCKET] Redis rate limit unavailable, skipping:", redisErr.message);
            // Continue without rate limiting if Redis is unavailable
          }
        }
        // ─────────────────────────────────────────────────────────────────

        // ACL
        if (socket.user.role === "user") {
          if (data.guestId !== socket.user.guestId) {
            console.warn(`[ACL] guest ${socket.user.guestId} tried to send as ${data.guestId}`);
            return typeof callback === "function" && callback({ success: false, error: "Forbidden – guestId mismatch" });
          }
        }
        if (socket.user.role === "branchadmin") {
          const tokenBranch = socket.user.branchEmail.toLowerCase();
          const payloadBranch = (data.branchEmail || tokenBranch).toLowerCase();
          if (payloadBranch !== tokenBranch) {
            console.warn(`[ACL] branch ${tokenBranch} tried to send as ${payloadBranch}`);
            return typeof callback === "function" && callback({ success: false, error: "Forbidden – branchEmail mismatch" });
          }
        }

        // Validate payload
        const payloadSchema = z.object({
          room: z.string().min(1),
          guestId: z.string().min(1),
          content: z.string().optional(),
          media: z.any().optional(),
          sender: z.enum(["guest", "branch"]),
          id: z.string().optional(),
          branchEmail: z.string().optional(),
          e2ee: z.boolean().optional(),
        });
        const parsed = payloadSchema.parse(data);
        let { room, guestId, content, media, sender, id, branchEmail: payloadBranchEmail, e2ee } = parsed;

        if (!content && !media) {
          if (typeof callback === "function") {
            return callback({ success: false, error: "Message must have content or media." });
          }
          return;
        }

        const guestRoom = getRoomName("guest", guestId);
        const branchEmail = socket.user?.branchEmail || "unknown";

        // Resend / confirmation path
        if (id) {
          const relayedMessage = {
            id,
            guestId,
            content,
            media: media || null,
            sender,
            // Carry the E2EE flag so the recipient knows `content` is ciphertext
            // ({ciphertext, iv} JSON) and must be decrypted, not shown raw.
            e2ee: !!e2ee,
            timestamp: new Date().toISOString(),
          };

          if (sender === "guest") {
            if (onlineAdminsMap[branchEmail]) {
              let delivered = false;
              Object.entries(onlineAdminsMap[branchEmail]).forEach(([sessionTabId, socketId]) => {
                const targetSocket = io.sockets.sockets.get(socketId);
                const isReady = readyAdmins[branchEmail]?.[sessionTabId];

                if (targetSocket && isReady) {
                  targetSocket.emit("receiveMessage", relayedMessage);
                  db.collection("messages").doc(id).update({ status: "delivered" }).catch(console.error);
                  delivered = true;
                } else {
                  console.warn(`[SOCKET] ⏳ Skipping admin socket ${socketId} — not confirmed ready`);
                }
              });

              if (!delivered) {
                io.to(getRoomName("admin", branchEmail)).emit("receiveMessage", relayedMessage);
                console.log(`[SOCKET] 📡 Fallback: delivering guest message to admin-${branchEmail}`);
                await bufferUndelivered(branchEmail, relayedMessage);
              }
            } else {
              io.to(getRoomName("admin", branchEmail)).emit("receiveMessage", relayedMessage);
              await bufferUndelivered(branchEmail, relayedMessage);
            }
          } else if (sender === "branch") {
            const guestSnap = await db
              .collection("messages")
              .where("guestId", "==", guestId)
              .where("branchEmail", "==", branchEmail)
              .where("sender", "==", "guest")
              .limit(1)
              .get();

            if (guestSnap.empty) {
              console.warn(`[SOCKET] Blocked branch relay—guest has not initiated chat.`, { guestId, branchEmail });
              if (typeof callback === "function") {
                return callback({ success: false, error: "Guest has not initiated chat." });
              }
              return;
            }

            socket.broadcast.to(guestRoom).emit("receiveMessage", relayedMessage);
          }

          if (typeof callback === "function") return callback({ success: true });
          return;
        }

        // New message path
        const newMessage = {
          branchEmail,
          guestId,
          content: content || null,
          media: media || null,
          sender,
          e2ee: !!e2ee,
          status: "sent",
          seenByAdmin: false,
          timestamp: new Date().toISOString(),
        };

        const ref = await db.collection("messages").add(newMessage);
        const savedMessage = { id: ref.id, ...newMessage };

        io.to(guestRoom).emit("receiveMessage", savedMessage);
        io.to(getRoomName("admin", branchEmail)).emit("receiveMessage", savedMessage);

        const unreadSnap = await db
          .collection("messages")
          .where("branchEmail", "==", branchEmail)
          .where("guestId", "==", guestId)
          .where("seenByAdmin", "==", false)
          .get();
        io.to(getRoomName("admin", branchEmail)).emit("updateUnread", {
          guestId,
          unreadCount: unreadSnap.size,
        });

        await db.collection("messages").doc(savedMessage.id).update({ status: "delivered" }).catch(console.error);

        if (typeof callback === "function") {
          callback({ success: true, message: savedMessage });
        }
      } catch (err) {
        console.error("[SOCKET] sendMessage error:", err.message);
        const errorMsg = err instanceof z.ZodError ? err.errors.map((e) => e.message).join(", ") : err.message;
        if (typeof callback === "function") {
          callback({ success: false, error: errorMsg });
        } else {
          socket.emit("messageError", { error: "Invalid message format or internal error" });
        }
      }
    });

    // ───────────────────────────────────────────────────────────────────
    // markRead (Admin SDK version — no client SDK import needed)
    // ───────────────────────────────────────────────────────────────────
    socket.on("markRead", async ({ guestId }) => {
      console.log("[SOCKET] 📨 markRead event received:", { guestId, branchEmail: socket.user.branchEmail });
      try {
        const branchEmail = socket.user.branchEmail;
        if (!branchEmail || !guestId) {
          console.log("[SOCKET] ❌ markRead missing branchEmail or guestId");
          return;
        }

        // 1️⃣ Fetch unseen messages for this guest/branch
        const snap = await db
          .collection("messages")
          .where("branchEmail", "==", branchEmail)
          .where("guestId", "==", guestId)
          .where("seenByAdmin", "==", false)
          .get();

        // 2️⃣ Batch mark them as seen
        const batch = db.batch();
        snap.forEach((doc) => batch.update(doc.ref, { seenByAdmin: true }));
        await batch.commit();

        // 3️⃣ Tell admins the count is now zero
        io.to(`admin-${branchEmail}`).emit("updateUnread", { guestId, unreadCount: 0 });

        // 4️⃣ Notify the guest that their messages have been seen
        const guestRoom = getRoomName("guest", guestId);
        io.to(guestRoom).emit("markRead", { guestId });
        console.log(`[SOCKET] 📡 Emitted markRead to guest room: ${guestRoom}`);
      } catch (err) {
        console.error("[SOCKET] markRead error:", err.message);
      }
    });

    socket.on("markSeen", async ({ messageId }) => {
      if (!messageId) return;
      try {
        const ref = db.collection("messages").doc(messageId);
        const snap = await ref.get();
        if (!snap.exists) return;
        const msg = snap.data();
        const u = socket.user || {};
        const isAdmin = u.role === "admin" || u.role === "branchadmin";
        const owns = isAdmin
          ? msg.branchEmail === (u.branchEmail || "").toLowerCase()
          : msg.guestId === u.guestId;
        if (!owns) {
          console.warn(`[ACL] markSeen denied: ${u.role}/${u.branchEmail || u.guestId} on message ${messageId}`);
          return;
        }
        await ref.update({ status: "seen", seenByAdmin: true });
        io.to(getRoomName("guest", msg.guestId)).emit("messageSeen", { messageId, seenByAdmin: true });
      } catch (err) {
        console.error("[SOCKET] markSeen error:", err.message);
      }
    });

    // typing
    socket.lastTyping = 0;
    socket.on("typing", ({ room, sender, isTyping }) => {
      const now = Date.now();
      if (now - socket.lastTyping < 1000) return;
      socket.lastTyping = now;

      const u = socket.user || {};
      const isAdmin = u.role === "admin" || u.role === "branchadmin";

      if (isAdmin) {
        const guestRoom = normalizeRoomName("guest", room);
        io.to(guestRoom).emit("typing", { room: guestRoom, sender, isTyping });
        if (u.branchEmail) {
          io.to(normalizeRoomName("admin", u.branchEmail)).emit("typing", { sender, isTyping, guestRoom });
        }
      } else if (u.branchEmail) {
        io.to(normalizeRoomName("admin", u.branchEmail)).emit("typing", {
          sender,
          isTyping,
          guestRoom: getRoomName("guest", u.guestId),
        });
      }
    });

    // chatClosed (guest)
    socket.on("chatClosed", async ({ guestId }) => {
      const canon = (id) =>
        id?.toLowerCase().startsWith("guest-") ? id.toLowerCase() : `guest-${id?.toLowerCase()}`;
      const incomingGuestId = canon(guestId);
      const actualGuestId = canon(socket.user?.guestId);
      const actualBranchEmail = socket.user?.branchEmail?.toLowerCase();

      console.log("[SERVER] chatClosed event received:", {
        incomingGuestId,
        actualGuestId,
        branchEmail: actualBranchEmail,
      });

      if (!incomingGuestId || incomingGuestId !== actualGuestId || !actualBranchEmail) {
        console.warn("[SERVER] Invalid chatClosed payload – skipping:", {
          incoming: incomingGuestId,
          expected: actualGuestId,
          branch: actualBranchEmail,
        });
        return;
      }

      try {
        const snap = await db
          .collection("messages")
          .where("guestId", "==", actualGuestId)
          .where("branchEmail", "==", actualBranchEmail)
          .get();
        if (!snap.empty) {
          const batch = db.batch();
          snap.forEach((doc) => batch.update(doc.ref, { archived: true }));
          await batch.commit();
          console.log(`[SERVER] chatClosed archived ${snap.size} message(s) for ${actualGuestId}`);
        }
      } catch (err) {
        console.error("[SERVER] chatClosed archive error:", err.message);
      }

      const liveSet = branchGuests.get(actualBranchEmail) || new Set();
      liveSet.delete(incomingGuestId);
      if (liveSet.size) branchGuests.set(actualBranchEmail, liveSet);
      else branchGuests.delete(actualBranchEmail);

      // C1: drop the guest's Redis presence key immediately on EXPLICIT close, so the
      // authoritative set (and any admin pull) reflects the closure at once across
      // every instance. (Transport disconnects are NOT deleted here — they rely on
      // TTL expiry to tolerate reconnects without flapping a guest offline.)
      await markGuestOffline(actualBranchEmail, incomingGuestId);

      const awaySet = branchAwayGuests.get(actualBranchEmail) || new Set();
      awaySet.delete(incomingGuestId);
      if (awaySet.size) branchAwayGuests.set(actualBranchEmail, awaySet);
      else branchAwayGuests.delete(actualBranchEmail);

      const guestRoom = getRoomName("guest", incomingGuestId);
      const adminRoom = getRoomName("admin", actualBranchEmail);

      io.to(guestRoom).emit("chatClosed", { message: "Chat has been closed by the guest." });
      io.to(adminRoom).emit("chatClosed", { guestId: incomingGuestId });
      console.log(`[BACKEND] Emitted chatClosed to admin room: ${adminRoom} for guestId=${incomingGuestId}`);

      // Belt-and-suspenders: also push the authoritative presence set. markGuestOffline
      // above just deleted this guest's Redis key, so getBranchPresence now excludes
      // them. The admin re-binds `guestPresenceUpdate` on every reconnect and PRUNES
      // any chat row not in the live set — so the conversation is removed even if the
      // one-shot `chatClosed` event is missed during a socket rebind.
      try {
        const updatedPresence = await getBranchPresence(actualBranchEmail);
        io.to(adminRoom).emit("guestPresenceUpdate", updatedPresence);
        console.log(`[BACKEND] Re-emitted guestPresenceUpdate after close → ${updatedPresence.length} online`);
      } catch (e) {
        console.warn("[SERVER] chatClosed presence re-emit failed:", e.message);
      }

      checkForStaleGuests(actualBranchEmail);
    });

    // NOTE: ECDH public-key exchange handlers (e2ee:public_key / e2ee:branch_key)
    // were removed — E2EE now uses a persistent per-conversation AES key fetched
    // from the backend, so no socket key handshake is required.

    // disconnect
    socket.on("disconnect", () => {
      if (isAdmin && branchEmail) {
        if (onlineAdminsMap[branchEmail]) {
          delete onlineAdminsMap[branchEmail][sessionTabId];
          if (Object.keys(onlineAdminsMap[branchEmail]).length === 0) {
            delete onlineAdminsMap[branchEmail];
          }
        }

        const guestSet = branchGuests.get(branchEmail) || new Set();
        guestSet.forEach((gId) => {
          io.to(getRoomName("guest", gId)).emit("branchStatus", {
            branchEmail,
            online: false,
            lastSeen: new Date().toISOString(),
          });
        });
        console.log(`[SOCKET] 🔕 Emitted branchStatus OFFLINE to guests for ${branchEmail}:`, [...guestSet]);
      }
      handleDisconnect(socket);
    });

    // start heartbeat tracking
    trackHeartbeat(socket);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // TTL Cleanup Job: prune stale sockets
  // ───────────────────────────────────────────────────────────────────────────
  const STALE_MS = 10 * 60 * 1000;
  setInterval(() => {
    const now = Date.now();

    for (const [socketId, client] of clients.entries()) {
      if (now - client.lastSeen > STALE_MS) {
        clients.delete(socketId);
        console.log(`[TTL] Removed stale socket client ${socketId}`);

        const staleSocket = io.sockets.sockets.get(socketId);
        if (staleSocket) {
          staleSocket.disconnect(true);
          console.log(`[TTL] Force-disconnected stale socket ${socketId}`);
        }

        const { branchEmail, identifier: guestId, role } = client;

        if (role === "user" && branchEmail) {
          io.to(`admin-${branchEmail}`).emit("chatClosed", { guestId });
          console.log(`[TTL] Emitted chatClosed for guest ${guestId} to admin ${branchEmail}`);

          const guestSet = branchGuests.get(branchEmail);
          if (guestSet) {
            guestSet.delete(guestId);
            if (guestSet.size) {
              branchGuests.set(branchEmail, guestSet);
              console.log(`[TTL] Pruned guest ${guestId} from branchGuests; remaining: ${[...guestSet]}`);
            } else {
              branchGuests.delete(branchEmail);
              console.log(`[TTL] branchGuests empty for ${branchEmail}, deleted key`);
            }
          }
        }

        if (branchEmail) checkForStaleGuests(branchEmail);
      }
    }
  }, STALE_MS);

  return io;
};

// ─────────────────────────────────────────────────────────────────────────────
// HEARTBEAT TRACKING (per socket)
// ─────────────────────────────────────────────────────────────────────────────
const trackHeartbeat = (socket) => {
  let missed = 0;

  socket.on("heartbeat", async () => {
    missed = 0;
    socket.emit("heartbeat-ack");

    if (socket.user && (socket.user.role === "admin" || socket.user.role === "branchadmin")) {
      try { await touchBranchOnline(socket.user.branchEmail); } catch (_) {}
    } else if (socket.user && socket.user.role === "user") {
      // C1: refresh the guest's Redis presence TTL. The 30s heartbeat tolerates ~2
      // missed beats before the 90s key expires (bounded ghost window).
      await markGuestOnline(socket.user.branchEmail, socket.user.guestId);
    }
  });

  const interval = setInterval(() => {
    if (socket.user && (socket.user.role === "admin" || socket.user.role === "branchadmin")) {
      missed = 0;
      return;
    }

    if (socket.__suppressDisconnect === true) {
      missed = 0;
      return;
    }

    missed++;

    const shouldSkipDisconnect =
      socket.__suppressDisconnect === true ||
      socket.handshake?.headers?.["x-transcript-mode"] === "true" ||
      global.__SENDING_TRANSCRIPT === true;

    if (!shouldSkipDisconnect && missed >= MAX_MISSED_PINGS) {
      console.warn(`[HEARTBEAT] Max missed pings reached (${missed}). Disconnecting socket ${socket.id}`);
      socket.disconnect();
    }
  }, HEARTBEAT_INTERVAL);

  socket.on("disconnect", () => clearInterval(interval));
};

// ─────────────────────────────────────────────────────────────────────────────
const handleDisconnect = async (socket) => {
  const client = clients.get(socket.id);
  if (!client) return;

  const { role, sessionTabId, tabId, room, identifier } = client;
  const isAdmin = role === "admin" || role === "branchadmin";
  const verifiedBranchEmail = socket.user?.branchEmail;

  clients.delete(socket.id);

  if (isAdmin && verifiedBranchEmail && sessionTabId) {
    const sessions = sessionTracker.get(verifiedBranchEmail) || new Set();
    sessions.delete(sessionTabId);
    sessionTracker.set(verifiedBranchEmail, sessions);

    const sessionKey = `${verifiedBranchEmail}::${sessionTabId}`;
    if (heartbeatMap.has(sessionKey)) {
      heartbeatMap.delete(sessionKey);
      console.log(`[HEARTBEAT] Deleted heartbeat key ${sessionKey}`);
    }
    if (broadcastMap.has(sessionKey)) {
      broadcastMap.delete(sessionKey);
      console.log(`[HEARTBEAT] Deleted broadcast key ${sessionKey}`);
    }
    console.log(`[SOCKET] Cleaned heartbeat and broadcast entries for ${sessionKey}`);
    console.log(`[SOCKET] Disconnect from tabId=${tabId}, sessionTabId=${sessionTabId}, branch=${verifiedBranchEmail}`);
    console.log(`[SOCKET] Scheduling presence check for ${verifiedBranchEmail} in 30 seconds...`);

    setTimeout(async () => {
      const now = Date.now();
      const THRESHOLD = 30_000;

      for (const [key, ts] of heartbeatMap.entries()) {
        if (now - ts >= THRESHOLD) {
          heartbeatMap.delete(key);
          console.log(`[HEARTBEAT] Deleted stale heartbeat key ${key}`);
        }
      }
      for (const [key, ts] of broadcastMap.entries()) {
        if (now - ts >= THRESHOLD) {
          broadcastMap.delete(key);
          console.log(`[HEARTBEAT] Deleted stale broadcast key ${key}`);
        }
      }

      const onlineAdmins = onlineAdminsMap[verifiedBranchEmail] || {};
      if (Object.keys(onlineAdmins).length === 0) {
        sessionTracker.delete(verifiedBranchEmail);

        // Delete Redis presence key to immediately mark branch offline
        try {
          const redisClient = getRedis();
          await ensureRedisConnected(redisClient);
          await redisClient.del(`${PRESENCE_PREFIX}${verifiedBranchEmail.toLowerCase()}`);
          console.log(`[SOCKET] Deleted Redis presence key for ${verifiedBranchEmail}`);
        } catch (e) {
          console.warn(`[SOCKET] Failed to delete Redis presence key:`, e.message);
        }

        const branchDoc = db.collection("branchStatus").doc(verifiedBranchEmail.toLowerCase());
        await branchDoc.set({ online: false, lastSeen: new Date().toISOString() }, { merge: true });
        io.to(room).emit("branchStatus", {
          branchEmail: verifiedBranchEmail,
          online: false,
          lastSeen: new Date().toISOString(),
        });
        console.log(`[SOCKET] ${verifiedBranchEmail} marked OFFLINE via presence check.`);
      }
    }, 30_000);
  }

  if (!isAdmin && verifiedBranchEmail && identifier) {
    const guestSet = branchGuests.get(verifiedBranchEmail) || new Set();
    if (guestSet.has(identifier)) {
      guestSet.delete(identifier);
      if (guestSet.size > 0) branchGuests.set(verifiedBranchEmail, guestSet);
      else branchGuests.delete(verifiedBranchEmail);

      // C1/C2: do NOT delete the guest's Redis key here — a transport disconnect is
      // often a transient blip or a reconnect to another instance. We let the short
      // TTL expire it (bounded ~GUEST_ONLINE_TTL_SEC ghost window) so a still-present
      // guest is never flapped offline. Explicit closes go through chatClosed (which
      // DOES delete). Emit the authoritative cross-instance set (Redis-backed; falls
      // back to the local cache if Redis is down).
      const presence = await getBranchPresence(verifiedBranchEmail);
      io.to(getRoomName("admin", verifiedBranchEmail)).emit("guestPresenceUpdate", presence);
      console.log(`[GUEST PRESENCE] Guest ${identifier} disconnected — ${presence.length} online (cross-instance; TTL-bounded)`);
    } else {
      console.warn(`[DISCONNECT] Guest ${identifier} not found in branchGuests — no action taken.`);
    }
  }
};

// ─────────────────────────────────────────────────────────────────────────────
const getSocketIOInstance = () => {
  if (!io) throw new Error("[SOCKET] Socket.IO not initialized");
  return io;
};

module.exports = {
  initializeSocket,
  getSocketIOInstance,
};

