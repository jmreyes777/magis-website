// src/Shared/mediaResolver.js
// P1-3: chat media objects are stored PRIVATE. This resolves a message's media
// into a short-lived signed URL via the backend, scoped to the guest. Results
// are cached briefly and refetched before the server-side signed-URL expiry.

const API = process.env.REACT_APP_API_URL || "";
const cache = new Map(); // messageId -> { data, ts }
const TTL_MS = 12 * 60 * 1000; // refetch before the ~15-min signed-URL expiry

export async function resolveGuestMedia(messageId) {
  if (!messageId) return null;
  const hit = cache.get(messageId);
  if (hit && Date.now() - hit.ts < TTL_MS) return hit.data;

  const token =
    sessionStorage.getItem("guestToken") || localStorage.getItem("guestToken");
  const res = await fetch(
    `${API}/api/messages/media/${encodeURIComponent(messageId)}`,
    { headers: token ? { Authorization: `Bearer ${token}` } : {} }
  );
  if (!res.ok) throw new Error(`media resolve failed (${res.status})`);
  const data = await res.json();
  cache.set(messageId, { data, ts: Date.now() });
  return data;
}

export function invalidateGuestMedia(messageId) {
  if (messageId) cache.delete(messageId);
}
