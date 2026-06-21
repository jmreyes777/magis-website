// middlewares/rateLimitByGuest.js
//
// Per-guest message rate limit, backed by the SAME Redis counter the Socket.IO
// `sendMessage` path uses (see utils/socket.js). Because both transports INCR
// the identical key, a guest's socket sends and REST `/api/messages/send` calls
// (media uploads + retries) now draw from ONE shared hourly budget. This closes
// the previous gaps in the in-memory implementation, which was per-process (the
// limit multiplied under horizontal scaling) and grew an unbounded Map (a slow
// memory leak).
//
// IMPORTANT: the key format, prefix, window, and max MUST stay in sync with the
// `sendMessage` handler in utils/socket.js so both paths share the same bucket.

const { getRedis, ensureRedisConnected } = require("../utils/redis");

// 1-hour fixed window, default 100 msgs/hour (override via ENV). These mirror
// the constants in utils/socket.js.
const MAX_PER_WINDOW = parseInt(process.env.MAX_MESSAGES_PER_HOUR, 10) || 100;
const RATE_KEY_PREFIX = process.env.REDIS_RATE_PREFIX || "ratelimit:guest:";
const WINDOW_SEC = 60 * 60;

module.exports = async function rateLimitByGuest(req, res, next) {
  const guestId = req.user?.guestId;
  if (!guestId) {
    return res
      .status(400)
      .json({ error: "Missing guest identity for rate limiting." });
  }

  // Shared key with the socket path → unified hourly quota per guest.
  const key = `${RATE_KEY_PREFIX}${guestId}:h`;

  try {
    const client = getRedis();
    await ensureRedisConnected(client);
    const count = await client.incr(key);
    if (count === 1) {
      // First hit in this window — set the 1-hour TTL.
      await client.expire(key, WINDOW_SEC);
    }
    if (count > MAX_PER_WINDOW) {
      console.warn(`[RATE LIMIT] guest ${guestId} ≥ ${MAX_PER_WINDOW}/hr (=${count})`);
      return res
        .status(429)
        .json({ error: `Rate limit exceeded: max ${MAX_PER_WINDOW} messages per hour.` });
    }
  } catch (redisErr) {
    // Fail open if Redis is unavailable — consistent with the socket path so a
    // Redis blip never blocks legitimate chat (availability over strictness).
    console.warn("[RATE LIMIT] Redis unavailable, skipping guest limit:", redisErr.message);
  }

  return next();
};
