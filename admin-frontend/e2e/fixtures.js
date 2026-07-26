// Shared UAT fixtures: a fake-but-well-formed JWT factory and a full network
// mock for the admin SPA. The app never reaches a real backend — every /api/*
// call is answered here (host-agnostic, so it works whether the build baked
// localhost:5000 or the staging edge-worker URL), and third-party surfaces
// (Firebase, reCAPTCHA, socket.io) are blocked so pages must degrade the way
// they would during a real outage. Handlers mirror the REAL response shapes
// from backend/routes/branchAuth.js + routes/mfa.js + routes/messages.js.
//
// Phase A (chat-dashboard UAT) additions: pass { socket: "fake" } to
// mockNetwork and the suite runs a fake socket.io server (engine.io v4 over
// routeWebSocket — same protocol fake as the guest suite, but playing the
// GUEST/server role): the dashboard truly connects, joins its admin room, and
// the test can push receiveMessage / typing / guestPresenceUpdate / chatClosed
// as the guest side while recording everything the dashboard emits.

const crypto = require("crypto");

const BRANCH = {
  id: "branch-1",
  email: "branch1@magis.test",
  name: "Test Branch",
};

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");

// jwt-decode only parses the payload; no real signature needed.
const makeJwt = (payload = {}) => {
  const now = Math.floor(Date.now() / 1000);
  return [
    b64url({ alg: "HS256", typ: "JWT" }),
    b64url({
      uid: "ba_e2e",
      branchId: BRANCH.id,
      email: BRANCH.email,
      branchName: BRANCH.name,
      role: "branchadmin",
      fallback: true,
      authVia: "branch_email_otp",
      jti: "jti-e2e",
      iat: now,
      exp: now + 240 * 60,
      ...payload,
    }),
    "e2e-fake-signature",
  ].join(".");
};

const OTP_GOOD = "123456";
const OTP_BAD = "000000";

const GUEST = { id: "guest-e2e-77", name: "Maria" };

// ── AES-256-GCM helpers (same wire format as src/utils/e2eeCrypto.js) ───────
// The dashboard fetches the per-conversation key from the backend and feeds it
// to WebCrypto; these mirror that so tests can decrypt what the dashboard
// sends and encrypt fake guest messages under the same key.
const subtle = crypto.webcrypto.subtle;

async function encryptWithKey(keyB64, plaintext) {
  const key = await subtle.importKey(
    "raw", Buffer.from(keyB64, "base64"), { name: "AES-GCM" }, false, ["encrypt"]);
  const iv = crypto.webcrypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt({ name: "AES-GCM", iv }, key, Buffer.from(plaintext, "utf8"));
  return { ciphertext: Buffer.from(ct).toString("base64"), iv: Buffer.from(iv).toString("base64") };
}

async function decryptWithKey(keyB64, { ciphertext, iv }) {
  const key = await subtle.importKey(
    "raw", Buffer.from(keyB64, "base64"), { name: "AES-GCM" }, false, ["decrypt"]);
  const pt = await subtle.decrypt(
    { name: "AES-GCM", iv: Buffer.from(iv, "base64") }, key, Buffer.from(ciphertext, "base64"));
  return Buffer.from(pt).toString("utf8");
}

// 1×1 red PNG — served as the "signed URL" target and used as an upload file.
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

/**
 * Install the network mock. Returns a `state` object the test can inspect
 * (recorded calls) and mutate (e.g. flip mfaVerified) mid-test.
 */
async function mockNetwork(page, opts = {}) {
  const state = {
    calls: [], // { method, path, postData, contentType } in arrival order
    mfaVerified: opts.mfaVerified ?? false,
    mfaEnrolled: opts.mfaEnrolled ?? true,
    mfaExpired: opts.mfaExpired ?? false,
    mustChangePassword: opts.mustChangePassword ?? false,
    rotationFails: opts.rotationFails ?? false,
    stepupRequestFails: opts.stepupRequestFails ?? false,
    loginRateLimited: opts.loginRateLimited ?? false,
    // ── chat-dashboard messaging (Phase A) ───────────────────────────────
    replyFails: opts.replyFails ?? false, // POST /api/messages/reply → 500
    convKeyFails: opts.convKeyFails ?? false, // conversation-key → 500
    mediaResolveFails: opts.mediaResolveFails ?? false, // admin-media → 500
    sendMessageAckFails: opts.sendMessageAckFails ?? false, // WS ack → failure
    convKeyB64: crypto.randomBytes(32).toString("base64"),
    replyCount: 0,
    // ── superadmin tooling (Phase C) ──────────────────────────────────
    superSessionExpired: opts.superSessionExpired ?? false, // cred list → 401
    analyticsFails: opts.analyticsFails ?? false, // analytics → 500
    obsFails: opts.obsFails ?? false, // obs summary → 500
    staffList: [
      {
        id: "staff-1",
        email: "ana@magis.test",
        displayName: "Ana Cruz",
        branchId: BRANCH.id,
        branchName: BRANCH.name,
        branchEmail: BRANCH.email,
        twoFactorEnabled: true,
        status: "active",
        createdAt: new Date(Date.now() - 86_400_000).toISOString(),
      },
      {
        id: "staff-2",
        email: "ben@magis.test",
        displayName: "Ben Reyes",
        branchId: BRANCH.id,
        branchName: BRANCH.name,
        branchEmail: BRANCH.email,
        twoFactorEnabled: false,
        status: "disabled",
        createdAt: new Date(Date.now() - 172_800_000).toISOString(),
      },
    ],
    // ── gold ticker trend intel (header widget polls this on mount) ──────
    goldSummary: {
      current: { t: Date.now(), phpPerGram: 5594.23 },
      deltas: {
        d1: { pct: 0.42, from: 5570.85, fromT: Date.now() - 86_400_000 },
        d7: { pct: 1.8, from: 5495.32, fromT: Date.now() - 7 * 86_400_000 },
        d30: { pct: 4.1, from: 5373.9, fromT: Date.now() - 30 * 86_400_000 },
      },
      week: { high: 5601.1, low: 5488.4 },
      sparkline: Array.from({ length: 12 }, (_, i) => ({
        t: Date.now() - (11 - i) * 14_400_000,
        g: 5490 + i * 9.5,
      })),
      baseline: null,
      drift: null,
    },
    // populated by the fake socket server when { socket: "fake" }:
    wsConnections: [],
    socketEmits: [], // { event, args } — everything the dashboard emits
    pushEvent: () => {
      throw new Error("pushEvent needs mockNetwork(page, { socket: 'fake' })");
    },
  };

  // Third-party surfaces: fail FAST (fulfill errors, don't abort) so SDK retry
  // loops can't stall the page. Covers Firebase Auth/Firestore, reCAPTCHA,
  // fonts, analytics.
  await page.route(
    /(googleapis\.com|gstatic\.com|google\.com|firebaseio\.com|googletagmanager)/,
    (route) => route.fulfill({ status: 403, contentType: "text/plain", body: "blocked by UAT fixture" })
  );
  await page.route("**/socket.io/**", (route) => route.abort());
  // page.route only sees HTTP — WebSocket upgrades sailed through to the REAL
  // staging socket server ("Unauthorized" storms). Harmless under
  // engine.io-client 6.6.5, but 6.6.6's reconnect behavior piles up pending
  // connections until same-origin API fetches starve (stuck "Verifying…").
  // Refuse the handshake so the suite is hermetic for realtime too — unless
  // the test asked for the fake socket server (chat-dashboard UAT).
  if (opts.socket === "fake") {
    await fakeAdminSocket(page, state);
  } else {
    await page.routeWebSocket(/\/socket\.io\//, (ws) => {
      ws.close({ code: 1008, reason: "blocked by e2e fixtures" });
    });
  }

  // Same-origin "signed URL" target for resolved chat media.
  await page.route("**/e2e-media.png", (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: TINY_PNG })
  );

  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const method = req.method();
    let body = {};
    try {
      body = req.postDataJSON() || {};
    } catch {
      /* not JSON (multipart uploads land here) */
    }
    const contentType = req.headers()["content-type"] || "";
    state.calls.push({ method, path, postData: body, contentType });

    const json = (status, payload) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(payload) });

    // ── Login (password → emailed OTP) ────────────────────────────────────
    if (path === "/api/branch/login" && method === "POST") {
      if (state.loginRateLimited) {
        return json(429, { error: "Too many attempts. Please try again later." });
      }
      if (body.password === "wrong-password") {
        return json(401, { error: "Invalid email or password." });
      }
      if (body.password === "disabled-account") {
        return json(403, { error: "This account has been disabled. Contact your administrator." });
      }
      return json(200, {
        otpRequired: true,
        loginTicket: "ticket-e2e",
        email: body.email,
        emailSent: true,
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      });
    }
    if (path === "/api/branch/login/verify-otp" && method === "POST") {
      if (body.code === OTP_BAD) {
        return json(401, { error: "Incorrect code.", attemptsLeft: 4 });
      }
      return json(200, {
        token: makeJwt(),
        branchName: BRANCH.name,
        mustChangePassword: state.mustChangePassword,
      });
    }
    if (path === "/api/branch/login/resend-otp" && method === "POST") {
      return json(200, { sent: true, emailSent: true });
    }
    if (path === "/api/branch/change-password" && method === "POST") {
      if ((body.newPassword || "").length < 10) {
        return json(400, { error: "New password must be at least 10 characters." });
      }
      state.mustChangePassword = false;
      return json(200, { success: true });
    }

    // ── MFA session gate (dashboard + modal poll this) ────────────────────
    if (path === "/api/mfa/session-status") {
      return json(200, {
        enrolled: state.mfaEnrolled,
        verified: state.mfaVerified,
        expired: state.mfaExpired && !state.mfaVerified,
        geoAnomaly: false,
        timeRemainingMinutes: state.mfaVerified ? 480 : 0,
      });
    }
    if (path === "/api/mfa/extend-session" && method === "POST") {
      return json(200, { success: true, timeRemainingMinutes: 480 });
    }
    if (path === "/api/mfa/status") {
      return json(200, { enrolled: state.mfaEnrolled, required: true });
    }

    // ── Branch email-OTP step-up (the flow under test) ────────────────────
    if (path === "/api/branch/stepup/request" && method === "POST") {
      if (state.stepupRequestFails) {
        return json(429, { error: "Please wait before requesting another code.", retryAfterSec: 60 });
      }
      return json(200, { sent: true, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() });
    }
    if (path === "/api/branch/stepup/verify" && method === "POST") {
      if (body.code === OTP_GOOD) {
        state.mfaVerified = true;
        return json(200, { success: true, verified: true });
      }
      return json(401, { error: "Incorrect code.", attemptsLeft: 4 });
    }

    // Regression trap: a branch email-OTP account must NEVER hit the staff
    // step-up (staff !== branch account collections). 403 mirrors the backend.
    if (path.startsWith("/api/staff/stepup")) {
      return json(403, { error: "Not a staff account." });
    }

    // ── Session plumbing ──────────────────────────────────────────────────
    if (path === "/api/issue-fallback-token" && method === "POST") {
      if (state.rotationFails) return json(401, { error: "Authentication required." });
      return json(200, { token: makeJwt() });
    }
    if (path === "/api/branch/firebase-token" && method === "POST") {
      // Soft-fail path: dashboard must work without client-side Firestore.
      return json(503, { error: "unavailable in UAT" });
    }

    // ── Chat messaging (Phase A: routes/messages.js shapes) ──────────────
    if (path.startsWith("/api/messages/conversation-key/") && method === "GET") {
      if (state.convKeyFails) return json(500, { error: "kms unavailable" });
      return json(200, { key: state.convKeyB64 });
    }
    if (path === "/api/messages/reply" && method === "POST") {
      state.replyCount += 1;
      if (state.replyFails) return json(500, { error: "Message could not be saved." });
      const isMultipart = contentType.includes("multipart/form-data");
      // Multipart bodies aren't JSON — recover the text fields from the raw
      // form payload so specs can still assert on what was sent.
      let content = body.content ?? "";
      if (isMultipart) {
        const raw = req.postData() || "";
        const m = /name="content"\r?\n\r?\n([\s\S]*?)\r?\n--/.exec(raw);
        content = m ? m[1] : "";
      }
      return json(200, {
        savedReply: {
          id: `reply-${state.replyCount}`,
          content, // echoed opaquely — ciphertext stays ciphertext
          timestamp: new Date().toISOString(),
          // Private media carries a storage path (resolved to a signed URL
          // via /api/messages/admin-media/:id), never a direct link.
          media: isMultipart ? { type: "image", path: `chat-media/e2e-${state.replyCount}.jpg` } : null,
        },
      });
    }
    if (path.startsWith("/api/messages/admin-media/") && method === "GET") {
      if (state.mediaResolveFails) return json(500, { error: "unavailable" });
      return json(200, { url: "/e2e-media.png" });
    }

    // ── Superadmin tooling (Phase C: branchAuth admin + staffAdmin + analytics
    //    + audit + obs route shapes) ─────────────────────────────────────
    if (path === "/api/branch/admin/list" && method === "GET") {
      if (state.superSessionExpired) return json(401, { error: "Authentication required." });
      return json(200, [
        { branchId: BRANCH.id, email: BRANCH.email, hasPassword: true, updatedAt: new Date().toISOString() },
      ]);
    }
    if (path === "/api/branch/admin/set-password" && method === "POST") {
      return json(200, { ok: true });
    }
    if (path === "/api/branch/admin/reset-mfa" && method === "POST") {
      return json(200, { message: `MFA reset for ${body.email}. The branch re-enrolls at next login.` });
    }

    if (path === "/api/admin/staff" && method === "GET") {
      return json(200, { staff: state.staffList });
    }
    if (path === "/api/admin/staff" && method === "POST") {
      const created = {
        id: `staff-${state.staffList.length + 1}`,
        email: body.email,
        displayName: body.displayName || null,
        branchId: body.branchId,
        branchName: body.branchName,
        branchEmail: body.branchEmail,
        twoFactorEnabled: !!body.twoFactorEnabled,
        status: "active",
        createdAt: new Date().toISOString(),
      };
      state.staffList.push(created);
      return json(200, { staff: created, tempPassword: "Temp-Pass-1234", emailed: true });
    }
    {
      const m = /^\/api\/admin\/staff\/([^/]+)(?:\/(reset-password|2fa|enable|disable|revoke-devices))?$/.exec(path);
      if (m) {
        const target = state.staffList.find((s) => s.id === m[1]);
        if (!target) return json(404, { error: "Staff not found." });
        if (method === "DELETE") {
          state.staffList = state.staffList.filter((s) => s.id !== m[1]);
          return json(200, { ok: true });
        }
        if (m[2] === "reset-password") {
          // emailError path on purpose — the reveal modal must surface it.
          return json(200, { tempPassword: "Reset-Pass-5678", emailed: false, emailError: "SMTP unavailable (e2e)" });
        }
        if (m[2] === "2fa") {
          target.twoFactorEnabled = !!body.enabled;
          return json(200, { ok: true });
        }
        if (m[2] === "enable" || m[2] === "disable") {
          target.status = m[2] === "enable" ? "active" : "disabled";
          return json(200, { ok: true });
        }
        if (m[2] === "revoke-devices") return json(200, { revoked: 2 });
      }
    }

    if (path.startsWith("/api/analytics/")) {
      if (state.analyticsFails) return json(500, { error: "analytics unavailable" });
      if (path.endsWith("/message-volume")) {
        return json(200, {
          totalMessages: 342,
          averageDaily: 11,
          volumeByDate: [
            { date: "2026-07-20", count: 12 },
            { date: "2026-07-21", count: 9 },
            { date: "2026-07-22", count: 17 },
          ],
        });
      }
      if (path.endsWith("/response-time")) {
        return json(200, { averageResponseTime: 7, responseTimeDistribution: { under5: 40, under15: 12, over30: 1 } });
      }
      if (path.endsWith("/conversation-summary")) {
        return json(200, {
          totalConversations: 58,
          conversationsWithMedia: 9,
          avgConversationDuration: 12,
          avgMessagesPerConversation: 6,
        });
      }
      if (path.endsWith("/branch-performance")) {
        return json(200, { branches: [{ branchEmail: BRANCH.email, messageCount: 342, uniqueConversations: 58, avgMessagesPerConversation: 6 }] });
      }
      return json(200, {});
    }

    if (path === "/api/audit/meta") {
      return json(200, {
        categories: ["chat", "access", "auth", "admin", "security"],
        severities: ["info", "notice", "warning", "critical"],
        outcomes: ["success", "failure", "blocked"],
        retentionDays: 365,
        scope: { branchEmail: BRANCH.email },
      });
    }
    if (path === "/api/audit/summary") {
      return json(200, { total: 3, bySeverity: { info: 2, warning: 1 }, byCategory: { chat: 2, auth: 1 } });
    }
    if (path === "/api/audit/events") {
      return json(200, {
        total: 2,
        nextCursor: null,
        events: [
          {
            id: "ev-1",
            ts: new Date().toISOString(),
            category: "chat",
            action: "message.read",
            severity: "info",
            outcome: "success",
            actor: { type: "branch", email: BRANCH.email },
            branchEmail: BRANCH.email,
            target: { type: "guest", guestId: GUEST.id },
            meta: { count: 3 },
          },
          {
            id: "ev-2",
            ts: new Date(Date.now() - 3_600_000).toISOString(),
            category: "auth",
            action: "stepup.verify",
            severity: "warning",
            outcome: "failure",
            actor: { type: "branch", email: BRANCH.email },
            branchEmail: BRANCH.email,
            target: null,
            meta: { reason: "wrong code" },
          },
        ],
      });
    }
    if (path === "/api/audit/export.csv") {
      return route.fulfill({ status: 200, contentType: "text/csv", body: "id,action\nev-1,message.read\n" });
    }

    if (path === "/api/obs/summary") {
      if (state.obsFails) return json(500, { error: "snapshot unavailable" });
      return json(200, {
        at: new Date().toISOString(),
        backup: { ok: true, stale: false, date: "2026-07-26", docs: 1234, gzBytes: 1_048_576 },
      });
    }

    // ── Gold pricing intel (routes/gold.js shapes) — the header ticker polls
    //    /summary on mount; POST /baseline returns the refreshed summary. ────
    if (path === "/api/gold/summary" && method === "GET") {
      return json(200, state.goldSummary);
    }
    if (path === "/api/gold/baseline" && method === "POST") {
      const g = Number.isFinite(body.phpPerGram)
        ? body.phpPerGram
        : state.goldSummary.current.phpPerGram;
      state.goldSummary = {
        ...state.goldSummary,
        baseline: { phpPerGram: g, thresholdPct: body.thresholdPct ?? 2, setAt: Date.now() },
        drift: { pct: 0, thresholdPct: body.thresholdPct ?? 2, reprice: false },
      };
      return json(200, state.goldSummary);
    }

    // Everything else the dashboard fires on mount (presence, chats REST,
    // logout, audit pings...) — benign empty success.
    return json(200, {});
  });

  return state;
}

/** Seed a logged-in branch email-OTP session directly into storage. */
async function seedBranchSession(page, { token } = {}) {
  const jwt = token || makeJwt();
  await page.addInitScript(
    ({ jwt, branch }) => {
      // Init scripts re-run on EVERY navigation; seed only once per context so
      // logout flows stay logged out (localStorage survives handleLogout's
      // selective clears, so this marker persists).
      if (localStorage.getItem("__uat_seeded__")) return;
      localStorage.setItem("__uat_seeded__", "1");
      const tabId = "tab-e2e-1";
      sessionStorage.setItem("branchAdminToken", jwt);
      sessionStorage.setItem("branchAdminRole", "branchadmin");
      sessionStorage.setItem("branchId", branch.id);
      sessionStorage.setItem("branchEmail", branch.email);
      sessionStorage.setItem("branchName", branch.name);
      sessionStorage.setItem("sessionTabId", "session-e2e-1");
      sessionStorage.setItem("mfaSessionId", "sess_e2e_1");
      localStorage.setItem("tabId", tabId);
      localStorage.setItem("activeSocketTabId", tabId);
      localStorage.setItem("branchAdminToken", jwt);
      localStorage.setItem("fallbackBranchEmail", branch.email);
      localStorage.setItem("fallbackBranchId", branch.id);
      localStorage.setItem("fallbackBranchRole", "branchadmin");
      localStorage.setItem("fallbackBranchName", branch.name);
    },
    { jwt, branch: BRANCH }
  );
  return jwt;
}

/**
 * Fake socket.io server (engine.io v4 over WebSocket) playing the guest side.
 * Ack-replies to every emit-with-ack (joinRoom, sendMessage, chatClosed…);
 * records all dashboard emits into state.socketEmits; exposes
 * state.pushEvent(event, ...args) so tests can act as the guest/backend.
 */
async function fakeAdminSocket(page, state) {
  await page.routeWebSocket(/\/socket\.io\//, (ws) => {
    state.wsConnections.push(ws);
    ws.onMessage((raw) => {
      const msg = String(raw);
      if (msg.startsWith("40")) return ws.send('40{"sid":"e2e-nsp-sid"}');
      if (msg === "2") return ws.send("3"); // ping → pong (either direction)
      if (msg === "3") return; // pong
      const m = /^42(\d*)(\[[\s\S]*\])$/.exec(msg);
      if (!m) return;
      let parsed = [];
      try { parsed = JSON.parse(m[2]); } catch { return; }
      const [event, ...args] = parsed;
      state.socketEmits.push({ event, args });
      if (m[1] !== "") {
        // sendMessage() resolves only when ack.success is truthy; joinRoom's
        // callback ignores its args, so one ack shape serves every event.
        const ack =
          event === "sendMessage" && state.sendMessageAckFails
            ? { success: false, error: "relay unavailable (e2e)" }
            : { success: true, message: { status: "delivered" } };
        ws.send(`43${m[1]}${JSON.stringify([ack])}`);
      }
    });
    // engine.io OPEN packet — client then sends "40" to join the namespace.
    ws.send('0{"sid":"e2e-eio-sid","upgrades":[],"pingInterval":25000,"pingTimeout":20000,"maxPayload":1000000}');
    // EIO4: the SERVER initiates heartbeats — without them the client watchdog
    // kills the connection after ~45s and long tests watch it die mid-flight.
    const heartbeat = setInterval(() => {
      try { ws.send("2"); } catch { clearInterval(heartbeat); }
    }, 20_000);
    ws.onClose(() => clearInterval(heartbeat));
  });

  state.pushEvent = (event, ...args) => {
    for (const ws of state.wsConnections) {
      try { ws.send(`42${JSON.stringify([event, ...args])}`); } catch { /* closed */ }
    }
  };
  return state;
}

/** Seed a logged-in SUPERADMIN session directly into storage. */
async function seedSuperAdminSession(page, { token } = {}) {
  const jwt = token || makeJwt({ role: "superadmin", email: "admin@magisgold.com" });
  await page.addInitScript(
    ({ jwt }) => {
      if (localStorage.getItem("__uat_seeded__")) return;
      localStorage.setItem("__uat_seeded__", "1");
      sessionStorage.setItem("superAdminToken", jwt);
      sessionStorage.setItem("superAdminRole", "superadmin");
      localStorage.setItem("tabId", "tab-e2e-1");
      sessionStorage.setItem("sessionTabId", "session-e2e-1");
    },
    { jwt }
  );
  return jwt;
}

/** Gate: the dashboard has joined its admin room over the fake socket. */
async function waitForAdminSocket(state, expect) {
  await expect
    .poll(() => state.socketEmits.some((e) => e.event === "joinRoom"), { timeout: 20_000 })
    .toBe(true);
}

const callsTo = (state, pathPrefix) => state.calls.filter((c) => c.path.startsWith(pathPrefix));
const emitsOf = (state, event) => state.socketEmits.filter((e) => e.event === event);

/** A well-formed incoming guest message (override any field per test). */
const guestMessage = (overrides = {}) => ({
  id: `gm-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
  guestId: GUEST.id,
  guestName: GUEST.name,
  branchEmail: BRANCH.email,
  sender: "guest",
  content: "Hello, is my item ready for pickup?",
  timestamp: new Date().toISOString(),
  ...overrides,
});

module.exports = {
  BRANCH,
  GUEST,
  OTP_GOOD,
  OTP_BAD,
  TINY_PNG,
  makeJwt,
  mockNetwork,
  seedBranchSession,
  seedSuperAdminSession,
  callsTo,
  emitsOf,
  guestMessage,
  waitForAdminSocket,
  encryptWithKey,
  decryptWithKey,
};
