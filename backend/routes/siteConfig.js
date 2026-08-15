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
const { cached, key } = require("../utils/cache");

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

// GET /api/site-config/branches — public branch directory for the guest SPA.
//
// SPD2-4 follow-up: /branches was the LAST public page shipping the client
// Firestore SDK (~105KB gzip) just to read this near-static collection, and
// the SDK's cold-start channel handshake delayed the list render by several
// roundtrips. This endpoint returns ONLY the whitelisted, non-sensitive
// fields the page already rendered via the client SDK (list/map/SEO + the
// branch email the guest chat flow targets). It reuses the admin list's
// Redis key (PERF2-1) so the branch write routes' invalidation covers it,
// and publicCache adds browser/edge caching on top.
const BRANCHES_TTL = Number(process.env.CACHE_BRANCHES_TTL || 300);
const PUBLIC_BRANCH_FIELDS = [
  "name",
  "slug",
  "email",
  "phone",
  "address",
  "actualAddress",
  "schedule",
  "location",
  "hasJewelryDisplay",
];

router.get("/branches", publicCache(300, 600), async (_req, res) => {
  try {
    // Same producer + key as the admin list route (routes/branches.js).
    const full = await cached(key("branches", "list"), BRANCHES_TTL, async () => {
      const snap = await db.collection("branches").get();
      return snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    });
    const rows = (Array.isArray(full) ? full : []).map((b) => {
      const row = { id: b.id };
      for (const f of PUBLIC_BRANCH_FIELDS) {
        if (b[f] !== undefined) row[f] = b[f];
      }
      return row;
    });
    return res.status(200).json(rows);
  } catch (e) {
    console.error("[site-config] branches read failed:", e.message);
    return res.status(500).json({ error: "Internal server error" });
  }
});

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
