// routes/branchStatus.js
const express = require("express");
const router = express.Router();
const { db } = require("../utils/firebase");
const publicCache = require("../middlewares/publicCache"); // PERF1-3

// NEW: Redis presence fast-path
const { getRedis, ensureRedisConnected } = require("../utils/redis");
const PRESENCE_PREFIX = process.env.REDIS_PRESENCE_PREFIX || "branch:online:";

/**
 * GET /branch-status/all
 * Returns { statuses: { [branchEmail]: { online: boolean, lastSeen: ISOString | "Unavailable" } } }
 *
 * Bulk variant powering the footer live-chat indicators (one request instead
 * of N per-branch polls). Same order of truth as the single-branch route:
 *  1) Redis TTL presence keys (branch:online:<email>) → online now
 *  2) Firestore `branchStatus` docs → lastSeen / offline entries
 *
 * When Redis is reachable it is AUTHORITATIVE for "online now": presence
 * keys self-heal via TTL, whereas the Firestore `online` flag can stick at
 * true forever if a server dies before writing the offline flip — trusting
 * it would advertise a chat nobody is staffing. Firestore `online` flags are
 * honored only as a degraded fallback when the Redis scan itself fails.
 *
 * NOTE: registered before "/branch-status" only for readability; the paths
 * are distinct so Express routing is unambiguous either way.
 */
router.get("/branch-status/all", publicCache(30, 60), async (req, res) => {
  const statuses = {};

  // 1) Firestore baseline — enumerates every known branch + lastSeen. The
  //    stored `online` flag is kept aside; whether we trust it depends on
  //    Redis health below.
  try {
    const snap = await db.collection("branchStatus").get();
    snap.docs.forEach((doc) => {
      const data = doc.data() || {};
      statuses[doc.id.toLowerCase()] = {
        online: !!data.online, // provisional — overridden if Redis is healthy
        lastSeen: data.lastSeen || "Unavailable",
      };
    });
  } catch (error) {
    console.error("[branch-status/all] ❌ Firestore read failed:", error.message);
    return res.status(500).json({ error: "Internal server error" });
  }

  // 2) Redis presence (authoritative when reachable; TTL keys exist only
  //    while presence touches keep landing)
  try {
    const client = getRedis();
    await ensureRedisConnected(client);
    const keys = [];
    let cursor = "0";
    do {
      const [next, batch] = await client.scan(
        cursor,
        "MATCH",
        `${PRESENCE_PREFIX}*`,
        "COUNT",
        100
      );
      cursor = next;
      keys.push(...batch);
    } while (cursor !== "0");

    // Scan succeeded → Redis owns "online now". Reset any Firestore
    // online:true (possibly stale) before overlaying live presence keys.
    Object.values(statuses).forEach((s) => { s.online = false; });

    if (keys.length) {
      const values = await client.mget(keys);
      keys.forEach((key, i) => {
        const email = key.slice(PRESENCE_PREFIX.length).toLowerCase();
        const ts = Number(values[i]);
        statuses[email] = {
          online: true,
          lastSeen: Number.isFinite(ts)
            ? new Date(ts).toISOString()
            : statuses[email]?.lastSeen || "Unavailable",
        };
      });
    }
  } catch (e) {
    // Degraded mode: Redis unreachable → keep the Firestore flags collected
    // above (better than reporting everyone offline during a Redis outage).
    console.warn("[branch-status/all] Redis scan failed; serving Firestore flags:", e.message);
  }

  return res.status(200).json({ statuses });
});

/**
 * GET /branch-status?branchEmail=<email>
 * Returns { online: boolean, lastSeen: ISOString | "Unavailable" }
 *
 * Order of truth:
 *  1) Redis TTL presence key (most current, cross-instance, survives restarts)
 *  2) Firestore doc (existing behavior / fallback)
 *
 * As in /branch-status/all: a HEALTHY Redis that has no presence key means
 * the branch is offline — the Firestore `online` flag is only trusted when
 * the Redis read itself fails, because that flag can stick at true if a
 * server dies before writing the offline flip.
 *
 * PERF1-3: public, non-authenticated read keyed only on the `branchEmail`
 * query — safe to cache briefly. A short TTL trades up to ~60s of presence
 * staleness for far fewer Redis/Firestore reads on this high-frequency poll;
 * `lastSeen` still reflects the real timestamp. publicCache only stamps 2xx
 * responses (errors stay no-store) and appends `Vary: Origin`.
 */
router.get("/branch-status", publicCache(30, 60), async (req, res) => {
  const { branchEmail: rawEmail } = req.query || {};
  if (!rawEmail) {
    return res.status(400).json({ error: "branchEmail is required" });
  }
  const branchEmail = String(rawEmail).toLowerCase();

  // 1) Redis fast-path (authoritative when reachable)
  let redisHealthy = false;
  try {
    const client = getRedis();
    await ensureRedisConnected(client); // no-op if already connected
    const val = await client.get(`${PRESENCE_PREFIX}${branchEmail}`);
    redisHealthy = true;
    if (val) {
      // val is Date.now().toString() from socket presence touches
      const ts = Number(val);
      const lastSeenIso = Number.isFinite(ts) ? new Date(ts).toISOString() : "Unavailable";
      return res.status(200).json({ online: true, lastSeen: lastSeenIso });
    }
  } catch (e) {
    // Soft-fail to Firestore
    console.warn("[branch-status] Redis read failed; falling back to Firestore:", e.message);
  }

  // 2) Firestore — lastSeen always; the stored `online` flag only when Redis
  //    was unreachable (degraded mode). With healthy Redis and no presence
  //    key, the branch is offline regardless of what the flag says.
  try {
    const docRef = db.collection("branchStatus").doc(branchEmail);
    const docSnap = await docRef.get();
    if (!docSnap.exists) {
      return res.status(200).json({ online: false, lastSeen: "Unavailable" });
    }
    const data = docSnap.data() || {};
    return res.status(200).json({
      ...data,
      online: redisHealthy ? false : !!data.online,
    });
  } catch (error) {
    console.error("[API] ❌ Error fetching branch status:", error.message);
    return res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
