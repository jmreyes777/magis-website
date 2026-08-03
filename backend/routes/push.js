// backend/routes/push.js
//
// CHATUX3: staff web-push subscription management. All routes are branch-admin
// authed — subscriptions are per-branch, per-device. See utils/pushNotify.js
// for the send side + VAPID configuration.

const express = require("express");
const router = express.Router();
const { db } = require("../utils/firebase");
const authenticateBranchAdmin = require("../middlewares/authenticateBranchAdmin");
const { isPushConfigured, publicKey, endpointDocId } = require("../utils/pushNotify");

router.use(authenticateBranchAdmin);
router.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

/** GET /api/push/public-key — the VAPID public key the browser subscribes with. */
router.get("/public-key", (req, res) => {
  if (!isPushConfigured()) {
    return res.status(503).json({ error: "Push notifications are not configured." });
  }
  return res.json({ key: publicKey() });
});

/**
 * POST /api/push/subscribe
 * Body: { subscription: { endpoint, keys: { p256dh, auth } } }
 * Idempotent: doc id is a hash of the endpoint, so re-subscribing the same
 * browser overwrites rather than duplicates.
 */
router.post("/subscribe", async (req, res) => {
  if (!isPushConfigured()) {
    return res.status(503).json({ error: "Push notifications are not configured." });
  }
  const sub = req.body?.subscription;
  const endpoint = sub?.endpoint;
  const p256dh = sub?.keys?.p256dh;
  const auth = sub?.keys?.auth;
  if (
    typeof endpoint !== "string" ||
    !/^https:\/\//.test(endpoint) ||
    endpoint.length > 1024 ||
    typeof p256dh !== "string" ||
    typeof auth !== "string"
  ) {
    return res.status(400).json({ error: "Invalid subscription." });
  }

  try {
    await db.collection("pushSubscriptions").doc(endpointDocId(endpoint)).set({
      branchEmail: req.branchEmail,
      // Store only the fields web-push needs — never persist arbitrary body.
      subscription: { endpoint, keys: { p256dh, auth } },
      createdAt: new Date().toISOString(),
    });
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("[PUSH] ❌ subscribe:", err.message);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * POST /api/push/unsubscribe
 * Body: { endpoint }
 * Only removes a subscription belonging to the caller's branch.
 */
router.post("/unsubscribe", async (req, res) => {
  const endpoint = req.body?.endpoint;
  if (typeof endpoint !== "string" || !endpoint) {
    return res.status(400).json({ error: "Missing endpoint." });
  }
  try {
    const ref = db.collection("pushSubscriptions").doc(endpointDocId(endpoint));
    const doc = await ref.get();
    if (doc.exists && doc.data().branchEmail === req.branchEmail) {
      await ref.delete();
    }
    // Same response whether it existed or not — nothing to enumerate.
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("[PUSH] ❌ unsubscribe:", err.message);
    return res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
