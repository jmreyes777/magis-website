// backend/routes/gold.js
//
// Gold pricing intel API for the admin header ticker (see utils/goldPrice.js).
//
//   GET  /api/gold/summary   — history-derived trend summary + baseline drift.
//                              Any authenticated admin-side session (super,
//                              branch admin, or staff — staff share the
//                              branchadmin role) may READ.
//   POST /api/gold/baseline  — record "we repriced at ₱X/g" (+ threshold).
//                              MANAGEMENT ONLY: staff sessions (staff:true
//                              claim) are rejected — they see alerts, they
//                              don't move prices.
//
// Additive module: no existing route/middleware is touched.

const express = require("express");
const router = express.Router();

// Combined super-admin + branch-admin (incl. staff) session verifier.
const authenticateAdminSession = require("../middlewares/authenticateAuditViewer");
const { getSummary, setBaseline, sampleOnce } = require("../utils/goldPrice");

router.use(authenticateAdminSession);

router.get("/summary", async (req, res) => {
  try {
    let summary = await getSummary();
    if (!summary) {
      // Cold start (no sampler tick yet): take the first sample on demand so
      // the panel is never empty for the first operator of the day.
      try {
        await sampleOnce();
        summary = await getSummary();
      } catch (e) {
        console.warn("[gold] on-demand sample failed:", e?.message || e);
      }
    }
    if (!summary) return res.status(503).json({ error: "No price history yet. Try again shortly." });
    return res.json(summary);
  } catch (err) {
    console.error("[gold] summary failed:", err?.message || err);
    return res.status(500).json({ error: "Failed to load gold price summary." });
  }
});

router.post("/baseline", express.json(), async (req, res) => {
  try {
    if (req.audit.staff) {
      return res.status(403).json({ error: "Only branch management can set the pricing baseline." });
    }
    const { phpPerGram, thresholdPct } = req.body || {};
    if (phpPerGram != null && (!Number.isFinite(Number(phpPerGram)) || Number(phpPerGram) <= 0)) {
      return res.status(400).json({ error: "phpPerGram must be a positive number." });
    }
    if (thresholdPct != null) {
      const t = Number(thresholdPct);
      if (!Number.isFinite(t) || t < 0.5 || t > 15) {
        return res.status(400).json({ error: "thresholdPct must be between 0.5 and 15." });
      }
    }
    const summary = await setBaseline({
      phpPerGram: phpPerGram != null ? Number(phpPerGram) : undefined,
      thresholdPct: thresholdPct != null ? Number(thresholdPct) : undefined,
      setBy: req.audit.email,
    });
    return res.json(summary);
  } catch (err) {
    console.error("[gold] baseline failed:", err?.message || err);
    return res.status(500).json({ error: "Failed to set the pricing baseline." });
  }
});

module.exports = router;
