// backend/utils/pushNotify.js
//
// CHATUX3: Web Push to branch staff. Solves the "nobody saw the chat" gap:
// today a guest message is only visible if the dashboard tab is open and
// focused — response times (measured in /api/analytics/response-time) hinge
// on staff happening to be looking. Push notifies the OS even when the tab
// is closed.
//
// Design:
//   - VAPID keys come from env (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY —
//     generate once with `npx web-push generate-vapid-keys`). Without them
//     the whole feature degrades to a clean no-op: routes 503, sends skip.
//   - Subscriptions live in `pushSubscriptions`, doc id = sha256(endpoint)
//     (idempotent re-subscribes), scoped by branchEmail. Multiple devices
//     per branch are naturally supported (one doc each).
//   - Gone subscriptions (404/410 from the push service) are pruned on send.
//   - Per guest+branch cooldown so a message burst = ONE notification, not
//     one per keystroke. In-memory: multi-instance duplicates are acceptable
//     for v1 (worst case: one extra notification per extra instance).

const crypto = require("crypto");
const webpush = require("web-push");
const { db } = require("./firebase");

const PUSH_COOLDOWN_MS =
  Math.max(parseInt(process.env.PUSH_COOLDOWN_MIN, 10) || 5, 1) * 60_000;

let configured = false;
(function initVapid() {
  const pub = (process.env.VAPID_PUBLIC_KEY || "").trim();
  const priv = (process.env.VAPID_PRIVATE_KEY || "").trim();
  if (!pub || !priv) {
    console.warn(
      "[PUSH] ⚠️ VAPID keys not set — staff web push is DISABLED. " +
        "Generate with `npx web-push generate-vapid-keys` and set " +
        "VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY."
    );
    return;
  }
  try {
    webpush.setVapidDetails(
      process.env.PUSH_CONTACT || "mailto:admin@magisgoldandgems.com",
      pub,
      priv
    );
    configured = true;
    console.log("[PUSH] ✅ VAPID configured — staff web push enabled.");
  } catch (err) {
    console.error("[PUSH] ❌ Invalid VAPID keys:", err.message);
  }
})();

const isPushConfigured = () => configured;
const publicKey = () => (configured ? process.env.VAPID_PUBLIC_KEY.trim() : null);

const endpointDocId = (endpoint) =>
  crypto.createHash("sha256").update(String(endpoint)).digest("hex");

// ── Cooldown ────────────────────────────────────────────────────────────────
// key -> last-notified epoch ms. Bounded: entries older than the cooldown are
// swept opportunistically so the map cannot grow without limit.
const lastNotified = new Map();

function shouldNotify(branchEmail, guestId, now = Date.now()) {
  const key = `${branchEmail}|${guestId}`;
  const last = lastNotified.get(key) || 0;
  if (now - last < PUSH_COOLDOWN_MS) return false;
  lastNotified.set(key, now);
  if (lastNotified.size > 5000) {
    for (const [k, t] of lastNotified) {
      if (now - t >= PUSH_COOLDOWN_MS) lastNotified.delete(k);
    }
  }
  return true;
}

// ── Send ────────────────────────────────────────────────────────────────────
/**
 * Push a notification to every subscribed device of a branch. Fire-and-forget
 * safe: never throws; returns { sent, pruned }. Payload content stays generic
 * (no message text) — push payloads traverse third-party push services, so we
 * send "who/where", never "what".
 */
async function sendBranchPush(branchEmail, { title, body, tag, url } = {}) {
  if (!configured || !branchEmail) return { sent: 0, pruned: 0 };
  try {
    const snap = await db
      .collection("pushSubscriptions")
      .where("branchEmail", "==", String(branchEmail).toLowerCase())
      .limit(50)
      .get();
    if (snap.empty) return { sent: 0, pruned: 0 };

    const payload = JSON.stringify({
      title: title || "New chat message",
      body: body || "A guest is waiting in the chat dashboard.",
      tag: tag || "magis-chat",
      url: url || "/admin/chats",
    });

    let sent = 0;
    let pruned = 0;
    await Promise.all(
      snap.docs.map(async (doc) => {
        try {
          await webpush.sendNotification(doc.data().subscription, payload, {
            TTL: 15 * 60, // stale chat pings are worthless after 15 min
            urgency: "high",
          });
          sent += 1;
        } catch (err) {
          const code = err && err.statusCode;
          if (code === 404 || code === 410) {
            // Subscription expired/revoked at the push service — prune it.
            await doc.ref.delete().catch(() => {});
            pruned += 1;
          } else {
            console.warn("[PUSH] send failed:", code || err.message);
          }
        }
      })
    );
    if (sent || pruned) {
      console.log(JSON.stringify({ t: "push", branch: branchEmail, sent, pruned }));
    }
    return { sent, pruned };
  } catch (err) {
    console.error("[PUSH] ❌ sendBranchPush:", err.message);
    return { sent: 0, pruned: 0 };
  }
}

/**
 * The one call sites use: notify a branch that a guest is waiting, subject to
 * the per-conversation cooldown. Deliberately does not await the send.
 */
function notifyGuestWaiting(branchEmail, guestId) {
  if (!configured) return;
  const branch = String(branchEmail || "").toLowerCase();
  if (!branch || !guestId) return;
  if (!shouldNotify(branch, guestId)) return;
  sendBranchPush(branch, {
    title: "Guest waiting in chat",
    body: "A guest sent a message and no one has it open. Tap to respond.",
    tag: `magis-chat-${guestId}`,
  });
}

module.exports = {
  isPushConfigured,
  publicKey,
  endpointDocId,
  shouldNotify,
  sendBranchPush,
  notifyGuestWaiting,
  __testResetCooldowns: () => lastNotified.clear(),
};
