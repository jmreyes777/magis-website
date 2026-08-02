// backend/routes/clientErrors.js
//
// OBS1 (observability megaplan): intake for client-side error telemetry.
//
// The public site AND the admin dashboard beacon uncaught errors / promise
// rejections / ErrorBoundary crashes / React hydration recoveries via
// navigator.sendBeacon (user-frontend/src/utils/errorReporter.js and
// admin-frontend/src/utils/errorReporter.js — the latter tags app:"admin").
// Mirrors the RUM intake contract
// (routes/rum.js): text/plain body parsed here (no CORS preflight, no
// express.json), hard schema clamps, its own rate-limit bucket (mounted in
// server.js), 204-always so the client never cares.
//
// Storage (both best-effort, neither blocks the response):
//   1. One structured log line {t:"cerr", ...} on the Render log stream.
//   2. A Firestore doc in `clientErrors` (expireAt TTL, +CERR_RETENTION_DAYS)
//      so the super-admin Observability dashboard can query recent errors.
//      Guarded by an in-process hourly cap so an error loop in a popular
//      release can't burn Firestore quota (the log line still records it).
//
// Alerting: R6 client-error-spike — >= CERR_SPIKE_THRESHOLD accepted events in
// a 15-min window fires sendSecurityAlert (Redis-counted, alert-throttled).

const express = require("express");
const router = express.Router();
const { db } = require("../utils/firebase");
const { sendSecurityAlert } = require("../utils/securityAlerts");

const TYPES = new Set(["error", "rejection", "boundary", "hydration", "recoverable"]);
const SAMPLE = Math.min(1, Math.max(0, Number(process.env.CERR_LOG_SAMPLE || 1)));
const RETENTION_DAYS = Math.max(parseInt(process.env.CERR_RETENTION_DAYS, 10) || 30, 1);
const FS_MAX_PER_HOUR = Math.max(parseInt(process.env.CERR_FS_MAX_PER_HOUR, 10) || 200, 0);
const SPIKE_THRESHOLD = Math.max(parseInt(process.env.CERR_SPIKE_THRESHOLD, 10) || 10, 2);
const SPIKE_WINDOW_SEC = 15 * 60;

// ── Firestore write cap (per-process; the hard cap is the route limiter) ────
let fsHour = 0;
let fsWrites = 0;
function underFirestoreCap() {
  const hour = Math.floor(Date.now() / 3600_000);
  if (hour !== fsHour) {
    fsHour = hour;
    fsWrites = 0;
  }
  if (fsWrites >= FS_MAX_PER_HOUR) return false;
  fsWrites += 1;
  return true;
}

// ── R6 spike counter (Redis INCR/EXPIRE, in-memory fallback) ────────────────
let memCount = 0;
let memResetAt = 0;
async function countAndCheckSpike() {
  try {
    const { getRedis, isRedisConfigured } = require("../utils/redis");
    if (isRedisConfigured()) {
      const r = getRedis();
      const n = await r.incr("obs:cerr:15m");
      if (n === 1) await r.expire("obs:cerr:15m", SPIKE_WINDOW_SEC);
      return n === SPIKE_THRESHOLD; // fire exactly once per window crossing
    }
  } catch {
    /* fall through to memory */
  }
  const now = Date.now();
  if (now >= memResetAt) {
    memResetAt = now + SPIKE_WINDOW_SEC * 1000;
    memCount = 0;
  }
  memCount += 1;
  return memCount === SPIKE_THRESHOLD;
}

router.post("/", express.text({ type: "*/*", limit: "4kb" }), (req, res) => {
  try {
    const raw = typeof req.body === "string" ? req.body : "";
    const data = JSON.parse(raw || "{}");

    const type = String(data.type || "");
    if (!TYPES.has(type)) return res.status(204).end(); // silently drop junk

    const message = String(data.message || "").slice(0, 500);
    if (!message) return res.status(204).end();

    // Which app the beacon came from (guest site vs staff dashboard).
    const app = data.app === "admin" ? "admin" : "guest";

    const entry = {
      t: "cerr",
      app,
      type,
      message,
      stack: String(data.stack || "").slice(0, 1500) || null,
      detail: String(data.detail || "").slice(0, 1500) || null,
      path: String(data.path || "/").split("?")[0].slice(0, 100),
      release: String(data.release || "").slice(0, 20) || null,
      ua: (req.headers["user-agent"] || "").slice(0, 120),
      at: new Date().toISOString(),
    };

    // 1) Log line (sampled) — always survives even when Firestore is capped.
    if (Math.random() < SAMPLE) console.log(JSON.stringify(entry));

    // 2) Firestore (best-effort, capped) for the Observability dashboard.
    if (FS_MAX_PER_HOUR > 0 && underFirestoreCap()) {
      const expireAt = new Date(Date.now() + RETENTION_DAYS * 86400_000);
      db.collection("clientErrors")
        .add({ ...entry, expireAt })
        .catch((e) => console.warn("[CERR] Firestore write failed:", e.message));
    }

    // 3) R6 spike alert (fire-and-forget).
    countAndCheckSpike()
      .then((crossed) => {
        if (!crossed) return;
        return sendSecurityAlert(
          "client-error-spike",
          `Client-error spike: ${SPIKE_THRESHOLD}+ errors in 15 min`,
          [
            `latest: [${entry.app}/${entry.type}] ${entry.message.slice(0, 160)}`,
            `path: ${entry.path}`,
            `release: ${entry.release || "unknown"}`,
            "action: check /observability in the admin app or filter Render logs for '\"t\":\"cerr\"'",
          ]
        );
      })
      .catch(() => {});

    return res.status(204).end();
  } catch {
    return res.status(204).end(); // never make the client care
  }
});

module.exports = router;
