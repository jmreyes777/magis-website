// CHATUX3: staff web-push plumbing for the admin app.
//
// Owns the full lifecycle: register the dedicated push service worker
// (/push-sw.js — no fetch handler, cannot interfere with requests), ask
// notification permission, subscribe with the server's VAPID key, and tell
// the backend about it. Everything fails soft: an unsupported browser or a
// denied permission just means "no push", never a broken dashboard.

const API = process.env.REACT_APP_API_URL || "";

const authToken = () =>
  sessionStorage.getItem("branchAdminToken") ||
  sessionStorage.getItem("superAdminToken") ||
  "";

export function isPushSupported() {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

// The subscribe call wants the VAPID key as a Uint8Array, servers hand it
// out base64url-encoded. Standard conversion.
function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
  return output;
}

async function getRegistration() {
  // Idempotent: register() returns the existing registration if unchanged.
  return navigator.serviceWorker.register("/push-sw.js");
}

/**
 * Current state for the toggle UI:
 *   "unsupported" | "denied" | "subscribed" | "unsubscribed"
 */
export async function getPushState() {
  if (!isPushSupported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  try {
    const reg = await navigator.serviceWorker.getRegistration("/push-sw.js");
    const sub = reg && (await reg.pushManager.getSubscription());
    return sub ? "subscribed" : "unsubscribed";
  } catch {
    return "unsubscribed";
  }
}

/**
 * Full enable flow. Returns the resulting state string; throws only on
 * unexpected server errors so the toggle can show a message.
 */
export async function enablePush() {
  if (!isPushSupported()) return "unsupported";

  const permission = await Notification.requestPermission();
  if (permission !== "granted") return permission === "denied" ? "denied" : "unsubscribed";

  // 503 here means VAPID isn't configured server-side — surface as unsupported.
  const keyRes = await fetch(`${API}/api/push/public-key`, {
    headers: { Authorization: `Bearer ${authToken()}` },
  });
  if (keyRes.status === 503) return "unsupported";
  if (!keyRes.ok) throw new Error(`public-key ${keyRes.status}`);
  const { key } = await keyRes.json();

  const reg = await getRegistration();
  await navigator.serviceWorker.ready;

  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(key),
    });
  }

  const saveRes = await fetch(`${API}/api/push/subscribe`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${authToken()}`,
    },
    body: JSON.stringify({ subscription: sub.toJSON() }),
  });
  if (!saveRes.ok) {
    // Don't leave a dangling browser subscription the server doesn't know about.
    await sub.unsubscribe().catch(() => {});
    throw new Error(`subscribe ${saveRes.status}`);
  }
  return "subscribed";
}

/**
 * Disable: best-effort on both sides (browser + server). Never throws.
 */
export async function disablePush() {
  if (!isPushSupported()) return "unsupported";
  try {
    const reg = await navigator.serviceWorker.getRegistration("/push-sw.js");
    const sub = reg && (await reg.pushManager.getSubscription());
    if (sub) {
      const endpoint = sub.endpoint;
      await sub.unsubscribe().catch(() => {});
      await fetch(`${API}/api/push/unsubscribe`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken()}`,
        },
        body: JSON.stringify({ endpoint }),
      }).catch(() => {});
    }
  } catch {
    /* fall through — state resolves below */
  }
  return "unsubscribed";
}
