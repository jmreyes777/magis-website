// backend/routes/rum.js
//
// SPD0-2 (speed megaplan): Real-User-Monitoring intake for Web Vitals.
//
// The public site beacons LCP/INP/CLS/FCP/TTFB via navigator.sendBeacon.
// Deliberately minimal: log-only storage (Render log stream), no PII, no
// cookies, hard schema clamps, its own rate-limit bucket (mounted in
// server.js). sendBeacon posts as text/plain (avoids a CORS preflight), so
// this route parses the raw body itself and never relies on express.json.

const express = require("express");
const router = express.Router();

// SCT (SPD4-3): socket connect fast-path — ms from socket.connect() to the
// server's joinRoom ack, beaconed by the guest chat client. Same pipeline,
// same clamps as the Web Vitals.
const METRICS = new Set(["LCP", "INP", "CLS", "FCP", "TTFB", "SCT"]);
const RATINGS = new Set(["good", "needs-improvement", "poor"]);
// Log sampling keeps the log stream bounded under traffic spikes (rate limit
// is the hard cap; this is the soft one). 1 = log everything.
const SAMPLE = Math.min(1, Math.max(0, Number(process.env.RUM_LOG_SAMPLE || 1)));

router.post("/", express.text({ type: "*/*", limit: "2kb" }), (req, res) => {
  try {
    const raw = typeof req.body === "string" ? req.body : "";
    const data = JSON.parse(raw || "{}");

    const name = String(data.name || "").toUpperCase();
    if (!METRICS.has(name)) return res.status(204).end(); // silently drop junk

    const value = Number(data.value);
    if (!Number.isFinite(value) || value < 0 || value > 300000) return res.status(204).end();

    const entry = {
      t: "rum",
      name,
      value: Math.round(value * 100) / 100,
      rating: RATINGS.has(data.rating) ? data.rating : null,
      path: String(data.path || "/").slice(0, 100),
      conn: String(data.conn || "").slice(0, 10) || null,
      ua: (req.headers["user-agent"] || "").slice(0, 60),
      at: new Date().toISOString(),
    };

    if (Math.random() < SAMPLE) console.log(JSON.stringify(entry));
    return res.status(204).end();
  } catch {
    return res.status(204).end(); // never make the client care
  }
});

module.exports = router;
