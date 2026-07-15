// backend/routes/obs.js
//
// OBS4/OBS6 (observability megaplan): observability API.
//
//   POST /api/obs/incidents  — uptime incident intake from the edge worker's
//        scheduled health watchdog. NOT superadmin-authed (the worker has no
//        JWT); instead it must present X-Obs-Auth: <OBS_SHARED_SECRET>.
//        NOTE: X-Edge-Auth is NOT sufficient here — the worker injects that
//        header on EVERY proxied public request, so it only proves "came
//        through the edge", not "sent BY the edge". X-Obs-Auth is only ever
//        attached by the worker's own scheduled handler.
//
//   GET  /api/obs/summary    — super-admin read API for the Observability
//        dashboard: backend health snapshot, RUM daily rollups (rumDaily),
//        recent client errors (clientErrors), recent incidents (obsIncidents).
//        Read-only, time-bounded, hard-capped (routes/audit.js conventions).

const crypto = require("crypto");
const express = require("express");
const router = express.Router();
const { db } = require("../utils/firebase");
const authenticateSuperAdmin = require("../middlewares/authenticateSuperAdmin");

const OBS_SECRET = process.env.OBS_SHARED_SECRET || process.env.EDGE_SHARED_SECRET || "";
const INCIDENT_RETENTION_DAYS = Math.max(parseInt(process.env.OBS_INCIDENT_RETENTION_DAYS, 10) || 180, 1);
const RUM_DAYS = 14; // rollup window the dashboard shows
const ERRORS_LIMIT = 50;
const INCIDENTS_LIMIT = 20;

function safeEqual(a, b) {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  if (A.length !== B.length) return false;
  return crypto.timingSafeEqual(A, B);
}

// ── POST /api/obs/incidents (edge worker only) ──────────────────────────────
router.post("/incidents", express.json({ limit: "4kb" }), async (req, res) => {
  try {
    if (!OBS_SECRET || !safeEqual(req.headers["x-obs-auth"] || "", OBS_SECRET)) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const b = req.body || {};
    const doc = {
      target: String(b.target || "unknown").slice(0, 40),
      downSince: String(b.downSince || "").slice(0, 40) || null,
      upAt: String(b.upAt || new Date().toISOString()).slice(0, 40),
      durationMin: Math.max(0, Math.min(Number(b.durationMin) || 0, 60 * 24 * 30)),
      checksFailed: Math.max(0, Math.min(Number(b.checksFailed) || 0, 100000)),
      lastError: String(b.lastError || "").slice(0, 300) || null,
      recordedAt: new Date().toISOString(),
      expireAt: new Date(Date.now() + INCIDENT_RETENTION_DAYS * 86400_000),
    };
    await db.collection("obsIncidents").add(doc);
    console.log(JSON.stringify({ t: "obs-incident", ...doc, expireAt: undefined }));
    return res.status(204).end();
  } catch (e) {
    console.warn("[OBS] incident write failed:", e.message);
    return res.status(500).json({ error: "Internal error" });
  }
});

// ── GET /api/obs/summary (super-admin) ──────────────────────────────────────
router.get("/summary", authenticateSuperAdmin, async (req, res) => {
  const out = { at: new Date().toISOString() };

  // 1) Live backend snapshot (cheap, in-process).
  try {
    let version = null;
    try { version = require("../package.json").version || null; } catch { /* optional */ }
    let redis = "off";
    try {
      const { getRedis, isRedisConfigured } = require("../utils/redis");
      if (isRedisConfigured()) {
        const pong = await Promise.race([
          getRedis().ping(),
          new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 500)),
        ]);
        redis = pong === "PONG" ? "ok" : "degraded";
      }
    } catch {
      redis = "degraded";
    }
    out.health = {
      status: "ok",
      uptimeSec: Math.round(process.uptime()),
      rssMb: Math.round(process.memoryUsage().rss / 1048576),
      redis,
      node: process.version,
      version,
    };
  } catch (e) {
    out.health = { status: "error", error: e.message };
  }

  // 2) RUM daily rollups (written by routes/rum.js flusher — OBS3).
  try {
    const since = new Date(Date.now() - RUM_DAYS * 86400_000);
    const sinceKey = since.toLocaleDateString("en-CA", { timeZone: "Asia/Manila" }); // YYYY-MM-DD
    const snap = await db
      .collection("rumDaily")
      .where("day", ">=", sinceKey)
      .orderBy("day", "desc")
      .limit(RUM_DAYS + 1)
      .get();
    out.rumDaily = snap.docs.map((d) => ({ id: d.id, ...d.data(), expireAt: undefined }));
  } catch (e) {
    out.rumDaily = [];
    out.rumDailyError = e.message;
  }

  // 3) Recent client errors (OBS1 intake).
  try {
    const snap = await db
      .collection("clientErrors")
      .orderBy("at", "desc")
      .limit(ERRORS_LIMIT)
      .get();
    out.clientErrors = snap.docs.map((d) => ({ id: d.id, ...d.data(), expireAt: undefined }));
    // Accurate 24h count without transferring docs (count() aggregation).
    const dayAgo = new Date(Date.now() - 86400_000).toISOString();
    const agg = await db
      .collection("clientErrors")
      .where("at", ">=", dayAgo)
      .count()
      .get();
    out.clientErrors24h = agg.data().count;
  } catch (e) {
    out.clientErrors = [];
    out.clientErrorsError = e.message;
  }

  // 4) Recent uptime incidents (OBS4 watchdog).
  try {
    const snap = await db
      .collection("obsIncidents")
      .orderBy("upAt", "desc")
      .limit(INCIDENTS_LIMIT)
      .get();
    out.incidents = snap.docs.map((d) => ({ id: d.id, ...d.data(), expireAt: undefined }));
  } catch (e) {
    out.incidents = [];
    out.incidentsError = e.message;
  }

  res.set("Cache-Control", "no-store");
  return res.status(200).json(out);
});

module.exports = router;
