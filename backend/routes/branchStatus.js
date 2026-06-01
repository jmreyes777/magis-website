// routes/branchStatus.js
const express = require("express");
const router = express.Router();
const { db } = require("../utils/firebase");

// NEW: Redis presence fast-path
const { getRedis, ensureRedisConnected } = require("../utils/redis");
const PRESENCE_PREFIX = process.env.REDIS_PRESENCE_PREFIX || "branch:online:";

/**
 * GET /branch-status?branchEmail=<email>
 * Returns { online: boolean, lastSeen: ISOString | "Unavailable" }
 *
 * Order of truth:
 *  1) Redis TTL presence key (most current, cross-instance, survives restarts)
 *  2) Firestore doc (existing behavior / fallback)
 */
router.get("/branch-status", async (req, res) => {
  const { branchEmail: rawEmail } = req.query || {};
  if (!rawEmail) {
    return res.status(400).json({ error: "branchEmail is required" });
  }
  const branchEmail = String(rawEmail).toLowerCase();

  // 1) Redis fast-path
  try {
    const client = getRedis();
    await ensureRedisConnected(client); // no-op if already connected
    const val = await client.get(`${PRESENCE_PREFIX}${branchEmail}`);
    if (val) {
      // val is Date.now().toString() from socket presence touches
      const ts = Number(val);
      const lastSeenIso = Number.isFinite(ts) ? new Date(ts).toISOString() : "Unavailable";
      return res.status(200).json({ online: true, lastSeen: lastSeenIso });
    }
  } catch (e) {
    // Soft-fail to Firestore
    console.warn("[branch-status] Redis read failed; falling back to Firestore:", e.message);
  }

  // 2) Firestore fallback (existing behavior)
  try {
    const docRef = db.collection("branchStatus").doc(branchEmail);
    const docSnap = await docRef.get();
    if (!docSnap.exists) {
      return res.status(200).json({ online: false, lastSeen: "Unavailable" });
    }
    return res.status(200).json(docSnap.data());
  } catch (error) {
    console.error("[API] ❌ Error fetching branch status:", error.message);
    return res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
