// middlewares/rateLimitByGuest.js

// 1 hour window, default 100 msgs/hour (override via ENV)
const WINDOW_MS = 60 * 60 * 1000;
const MAX_PER_WINDOW = parseInt(process.env.MAX_MESSAGES_PER_HOUR, 10) || 100;

// Map<guestId, Array<timestamp>>
const messageLog = new Map();

module.exports = function rateLimitByGuest(req, res, next) {
  const guestId = req.user?.guestId;
  if (!guestId) {
    return res
      .status(400)
      .json({ error: "Missing guest identity for rate limiting." });
  }

  const now = Date.now();
  // get or init
  const timestamps = messageLog.get(guestId) || [];
  // keep only those inside our window
  const windowed = timestamps.filter(ts => now - ts <= WINDOW_MS);

  if (windowed.length >= MAX_PER_WINDOW) {
    return res
      .status(429)
      .json({ error: `Rate limit exceeded: max ${MAX_PER_WINDOW} messages per hour.` });
  }

  // record this request
  windowed.push(now);
  messageLog.set(guestId, windowed);

  next();
};
