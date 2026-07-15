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
const { db, admin } = require("../utils/firebase");

// SCT (SPD4-3): socket connect fast-path — ms from socket.connect() to the
// server's joinRoom ack, beaconed by the guest chat client. Same pipeline,
// same clamps as the Web Vitals.
const METRICS = new Set(["LCP", "INP", "CLS", "FCP", "TTFB", "SCT"]);
const RATINGS = new Set(["good", "needs-improvement", "poor"]);
// Log sampling keeps the log stream bounded under traffic spikes (rate limit
// is the hard cap; this is the soft one). 1 = log everything.
const SAMPLE = Math.min(1, Math.max(0, Number(process.env.RUM_LOG_SAMPLE || 1)));

// ── OBS3 (observability megaplan): daily rollups for the dashboard ──────────
// Render's log stream is ephemeral, so raw beacons vanish. This accumulates
// per-metric counters in memory and flushes them every FLUSH_MS as ONE merged
// FieldValue.increment write to rumDaily/{YYYY-MM-DD} (Asia/Manila day —
// that's where the operator reads trends). Cost ceiling: 288 writes/day per
// instance regardless of traffic; increments merge safely across instances.
// A restart drops at most one unflushed window — the log lines remain the
// uncut source of truth. Histogram buckets (not raw samples) let the
// dashboard show pass-rates and a p75 bucket estimate honestly and cheaply.
const FLUSH_MS = Math.max(Number(process.env.RUM_ROLLUP_FLUSH_MS) || 5 * 60 * 1000, 30_000);
const ROLLUP_RETENTION_DAYS = Math.max(parseInt(process.env.RUM_ROLLUP_RETENTION_DAYS, 10) || 90, 1);
const ROLLUP_DISABLED = String(process.env.RUM_ROLLUP_DISABLED || "") === "true";

// Upper edges per metric (last bucket is open-ended). Chosen so the CWV
// good/poor thresholds are always bucket edges.
const BUCKETS = {
  LCP: [1000, 2500, 4000],
  FCP: [1000, 1800, 3000],
  TTFB: [200, 800, 1800],
  INP: [200, 500],
  CLS: [0.1, 0.25],
  SCT: [500, 1500, 3000],
};

const RATING_KEYS = { good: "good", "needs-improvement": "ni", poor: "poor" };
let pending = new Map(); // day -> { METRIC: { count, good, ni, poor, b0..bN } }

function dayKeyManila(d = new Date()) {
  return d.toLocaleDateString("en-CA", { timeZone: "Asia/Manila" }); // YYYY-MM-DD
}

function accumulate(name, value, rating) {
  if (ROLLUP_DISABLED) return;
  const day = dayKeyManila();
  let metrics = pending.get(day);
  if (!metrics) {
    metrics = {};
    pending.set(day, metrics);
  }
  const m = metrics[name] || (metrics[name] = {});
  m.count = (m.count || 0) + 1;
  const rk = RATING_KEYS[rating];
  if (rk) m[rk] = (m[rk] || 0) + 1;
  const edges = BUCKETS[name] || [];
  let b = edges.length; // open-ended last bucket
  for (let i = 0; i < edges.length; i++) {
    if (value <= edges[i]) {
      b = i;
      break;
    }
  }
  m[`b${b}`] = (m[`b${b}`] || 0) + 1;
}

async function flushRollups() {
  if (pending.size === 0) return;
  const batch = pending;
  pending = new Map();
  const inc = admin.firestore.FieldValue.increment;
  for (const [day, metrics] of batch) {
    try {
      // NOTE: with set()+merge, dotted string keys are literal field names —
      // nested objects are required for a recursive merge of the counters.
      const update = {
        day,
        expireAt: new Date(Date.now() + ROLLUP_RETENTION_DAYS * 86400_000),
      };
      for (const [name, counters] of Object.entries(metrics)) {
        const node = {};
        for (const [k, v] of Object.entries(counters)) node[k] = inc(v);
        update[name] = node;
      }
      await db.collection("rumDaily").doc(day).set(update, { merge: true });
    } catch (e) {
      // Dropped rollup ≠ dropped data (log lines survive). Never throw.
      console.warn("[RUM] rollup flush failed:", e.message);
    }
  }
}

// unref(): the timer must never hold the process (or tests) open.
const flushTimer = setInterval(() => flushRollups().catch(() => {}), FLUSH_MS);
if (flushTimer.unref) flushTimer.unref();

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
    accumulate(name, entry.value, entry.rating); // OBS3: never samples, never throws
    return res.status(204).end();
  } catch {
    return res.status(204).end(); // never make the client care
  }
});

module.exports = router;
