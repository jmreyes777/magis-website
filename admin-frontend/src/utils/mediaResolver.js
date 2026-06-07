// src/utils/mediaResolver.js
// P1-3: chat media objects are stored PRIVATE. This resolves a message's media
// into a short-lived signed URL via the backend, scoped to the branch admin and
// gated by an active MFA session (mirrors the conversation-key call pattern).

const API = process.env.REACT_APP_API_URL || "";
const cache = new Map(); // messageId -> { data, ts }
const TTL_MS = 12 * 60 * 1000; // refetch before the ~15-min signed-URL expiry

export async function resolveAdminMedia(messageId) {
  if (!messageId) return null;
  const hit = cache.get(messageId);
  if (hit && Date.now() - hit.ts < TTL_MS) return hit.data;

  const token =
    sessionStorage.getItem("branchAdminToken") ||
    localStorage.getItem("branchAdminToken");
  const res = await fetch(
    `${API}/api/messages/admin-media/${encodeURIComponent(messageId)}`,
    {
      method: "GET",
      credentials: "include",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }
  );
  if (!res.ok) throw new Error(`media resolve failed (${res.status})`);
  const data = await res.json();
  cache.set(messageId, { data, ts: Date.now() });
  return data;
}

export function invalidateAdminMedia(messageId) {
  if (messageId) cache.delete(messageId);
}
