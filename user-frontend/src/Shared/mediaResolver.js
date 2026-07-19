// src/Shared/mediaResolver.js
// P1-3: chat media objects are stored PRIVATE. This resolves a message's media
// into a short-lived signed URL via the backend, scoped to the guest. Results
// are cached briefly and refetched before the server-side signed-URL expiry.
//
// AUTH: guest JWTs live 1 HOUR. The chat's send path refreshes proactively
// (ensureValidGuestToken), but this resolver used to send the stored token
// raw — so any chat older than an hour resolved 401 on every attempt and the
// guest saw "Attachment unavailable" forever (2026-07-19, 06:17 PM incident:
// session started 04:51). The resolver now (a) skips known-expired tokens and
// (b) on a 401, refreshes once via the same /api/guest/refresh-token contract
// the chat box uses, then retries.

const API = process.env.REACT_APP_API_URL || "";
const cache = new Map(); // messageId -> { data, ts }
const TTL_MS = 12 * 60 * 1000; // refetch before the ~15-min signed-URL expiry

const getStoredToken = () =>
  sessionStorage.getItem("guestToken") || localStorage.getItem("guestToken");

const isExpired = (jwt) => {
  try {
    const { exp } = JSON.parse(atob(jwt.split(".")[1]));
    // 30s early: don't spend a request on a token about to die in flight.
    return typeof exp === "number" && exp * 1000 < Date.now() + 30 * 1000;
  } catch {
    return false; // unparsable → let the server be the judge
  }
};

// Single-flight refresh: N message bubbles resolving at once must not fire N
// concurrent refresh calls (the endpoint may rotate the CSRF/refresh cookie,
// making later duplicates fail spuriously).
let refreshInFlight = null;
async function refreshGuestToken() {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      if (!window.__CSRF_TOKEN__) {
        const res = await fetch(`${API}/api/csrf-token`, { credentials: "include" });
        const { csrfToken } = await res.json();
        if (csrfToken) window.__CSRF_TOKEN__ = csrfToken;
      }
      const res = await fetch(`${API}/api/guest/refresh-token`, {
        method: "POST",
        credentials: "include",
        headers: {
          "X-CSRF-Token": window.__CSRF_TOKEN__ || "",
          // P1-4: prior token as proof (in case the cross-site cookie is blocked).
          Authorization: `Bearer ${getStoredToken() || ""}`,
        },
      });
      if (!res.ok) return null;
      const { token } = await res.json();
      if (token) sessionStorage.setItem("guestToken", token);
      return token || null;
    } catch {
      return null;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

async function fetchSigned(messageId, token) {
  return fetch(`${API}/api/messages/media/${encodeURIComponent(messageId)}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

export async function resolveGuestMedia(messageId) {
  if (!messageId) return null;
  const hit = cache.get(messageId);
  if (hit && Date.now() - hit.ts < TTL_MS) return hit.data;

  let token = getStoredToken();
  if (token && isExpired(token)) {
    token = (await refreshGuestToken()) || token;
  }

  let res = await fetchSigned(messageId, token);
  if (res.status === 401) {
    const fresh = await refreshGuestToken();
    if (fresh) res = await fetchSigned(messageId, fresh);
  }
  if (!res.ok) throw new Error(`media resolve failed (${res.status})`);
  const data = await res.json();
  cache.set(messageId, { data, ts: Date.now() });
  return data;
}

export function invalidateGuestMedia(messageId) {
  if (messageId) cache.delete(messageId);
}
