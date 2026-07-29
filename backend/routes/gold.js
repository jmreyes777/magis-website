// backend/routes/gold.js
//
// Gold pricing intel API for the admin header ticker (see utils/goldPrice.js).
//
//   GET /api/gold/summary — history-derived trend summary + the 24h-movement
//                           alert (information only; the actionable side is
//                           the daily 08:15 manager email sent by the
//                           scheduler in server.js). Any authenticated
//                           admin-side session (super, branch admin, or staff
//                           — staff share the branchadmin role) may read.
//                           Deliberately no write endpoints: repricing is an
//                           internal daily process, not a dashboard workflow.
//
// Additive module: no existing route/middleware is touched.

const express = require("express");
const router = express.Router();

// Combined super-admin + branch-admin (incl. staff) session verifier.
const authenticateAdminSession = require("../middlewares/authenticateAuditViewer");
const { getSummary, sampleOnce } = require("../utils/goldPrice");

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

module.exports = router;
