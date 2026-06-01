// src/utils/api.js
let _accessToken = null;

/**
 * Store the latest access token in memory
 */
export function setAccessToken(token) {
  _accessToken = token;
}

/**
 * Wrapper around fetch that:
 * 1. Attaches Bearer <accessToken>
 * 2. On 401, calls refresh-endpoint (sending the HTTP-only cookie)
 * 3. Retries the original request with the new access token once
 */
export async function apiFetch(input, init = {}) {
  init.credentials = "include";
  init.headers     = init.headers || {};
  if (_accessToken) {
    init.headers["Authorization"] = `Bearer ${_accessToken}`;
  }

  let res = await fetch(input, init);
  if (res.status === 401 && !input.endsWith("/refresh-token")) {
    // Try to refresh
    const refreshRes = await fetch(
      `${process.env.REACT_APP_API_URL}/api/guest/refresh-token`,
      { method: "POST", credentials: "include" }
    );
    if (refreshRes.ok) {
      const { accessToken } = await refreshRes.json();
      setAccessToken(accessToken);
      // retry original
      init.headers["Authorization"] = `Bearer ${accessToken}`;
      res = await fetch(input, init);
    }
  }
  return res;
}
