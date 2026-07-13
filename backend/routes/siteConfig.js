// backend/routes/siteConfig.js
//
// SPD2-4 (speed megaplan): public site-config reads for the guest SPA.
//
// GET /api/site-config/auction returns the next-auction schedule that the
// homepage previously read via the client Firestore SDK. Moving this one read
// behind a tiny cached API lets the homepage ship WITHOUT the ~105KB-gzip
// Firebase chunk (the largest asset on the public site). Timestamps are
// normalized to ISO strings (the SPA's existing date parsing handles them).
//
// Caching: Redis read-through (fail-open) + browser/edge Cache-Control via
// publicCache. The admin writes this doc rarely (siteConfig/auction), so a
// 5-minute TTL is far fresher than needed.

const express = require("express");
const router = express.Router();
const { db } = require("../utils/firebase");
const publicCache = require("../middlewares/publicCache");
const { cached } = require("../utils/cache");

const TTL = Number(process.env.CACHE_SITECONFIG_TTL || 300);

function toIso(value) {
  if (!value) return null;
  try {
    if (typeof value.toDate === "function") return value.toDate().toISOString();
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  } catch {
    return null;
  }
}

router.get("/auction", publicCache(300, 600), async (_req, res) => {
  try {
    const payload = await cached("cache:siteconfig:auction", TTL, async () => {
      const snap = await db.collection("siteConfig").doc("auction").get();
      if (!snap.exists) return { exists: false };
      const data = snap.data() || {};
      return {
        exists: true,
        nextAuctionAt: toIso(data.nextAuctionAt),
        upcomingDates: Array.isArray(data.upcomingDates)
          ? data.upcomingDates
              .map((e) => ({
                startAt: toIso(e && e.startAt),
                endAt: toIso(e && e.endAt),
                label: (e && e.label) || null,
              }))
              .filter((e) => e.startAt)
          : [],
      };
    });
    return res.status(200).json(payload);
  } catch (e) {
    console.error("[site-config] auction read failed:", e.message);
    return res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
