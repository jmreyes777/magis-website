// backend/middlewares/hotReadLimiter.js
//
// SEC26 Wave 0 (A06-1 closure): origin-side rate limits for the "hot read"
// endpoints that previously relied on edge rate-limiting alone — media
// resolvers, /history, and /conversation-key. These mint signed URLs / decrypt
// keys / page Firestore, so an authed-but-abusive client could otherwise
// hammer them for free (API4: unrestricted resource consumption).
//
// Perf-sensitive by design (this was deferred for exactly that reason):
//   - Keyed on the AUTHENTICATED identity (guestId / branchEmail), not IP —
//     shared NATs never collide, and one hostile identity can't consume a
//     branch's budget. Falls back to the edge-authenticated IP key only when
//     identity is somehow absent.
//   - Generous ceilings (default 300/hr per identity per bucket) — an order of
//     magnitude above observed legitimate use, so real users never see 429s.
//   - Same store strategy as every other limiter (P2-1): Redis when
//     REDIS_URL is configured (cluster-correct), in-memory otherwise
//     (single-instance + hermetic under tests).

const rateLimit = require("express-rate-limit");
const { RedisStore } = require("rate-limit-redis");
const { getRedis, isRedisConfigured } = require("../utils/redis");
const { rateLimitKey } = require("../utils/geoSecurity");

const WINDOW_MS = Number(process.env.HOT_READ_RL_WINDOW_MS) || 60 * 60 * 1000; // 1h
const MAX = Number(process.env.HOT_READ_RL_MAX) || 300; // per identity / bucket / window

const rlStore = (prefix) =>
  isRedisConfigured()
    ? new RedisStore({ prefix, sendCommand: (...args) => getRedis().call(...args) })
    : undefined;

// Identity precedence: guest token → guestId; branch admin → branchEmail.
// Fallback: the edge-authenticated client IP (never plain req.ip — P3-2).
const identityKey = (req) =>
  (req.user && req.user.guestId) ||
  req.branchEmail ||
  rateLimitKey(req);

/**
 * Build a limiter for one hot-read bucket. Separate buckets so media abuse
 * can't starve history paging and vice versa.
 * @param {"media"|"history"|"convkey"} bucket
 */
function hotReadLimiter(bucket) {
  return rateLimit({
    windowMs: WINDOW_MS,
    max: MAX,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `${bucket}:${identityKey(req)}`,
    message: { error: "Too many requests. Please slow down and try again shortly." },
    store: rlStore(`rl:hot:${bucket}:`),
  });
}

module.exports = { hotReadLimiter };
