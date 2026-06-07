// src/utils/api.js
let _accessToken = null;

/**
 * Store the latest access token in memory
 */
export function setAccessToken(token) {
  _accessToken = token;
}

/**
 * A universal fetch wrapper that:
 * - prefixes relative paths with `${API_URL}/api/`
 * - attaches HTTP-only cookies (credentials)
 * - injects Bearer <accessToken> when set
 * - retries once on 401 by calling guest/refresh-token
 * - auto-stringifies JSON bodies and sets Content-Type
 * - returns parsed JSON or throws Error(data.error||statusText)
 */
export async function apiFetch(input, options = {}) {
  const {
    method = "GET",
    headers: customHeaders = {},
    body,      // JS object for JSON
    formData,  // FormData instance for uploads
    ...rest
  } = options;

  // Build URL: if you passed a full URL, use it; otherwise prefix
  const url =
    /^https?:\/\//i.test(input)
      ? input
      : `${process.env.REACT_APP_API_URL.replace(/\/+$/,"")}/api/${input.replace(/^\/+/, "")}`;

  // Prepare init
  const init = {
    method,
    credentials: "include",
    ...rest,
    headers: { ...customHeaders },
  };

  // Attach token if present
  if (_accessToken) {
    init.headers["Authorization"] = `Bearer ${_accessToken}`;
  }

  // Choose body
  if (formData) {
    init.body = formData;
  } else if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  // First attempt
  let res = await fetch(url, init);

  // On 401, try to refresh once (but don’t loop)
  if (
    res.status === 401 &&
    !url.endsWith("/guest/refresh-token")
  ) {
    // call refresh endpoint (cookie travels automatically)
    const refreshRes = await fetch(
      `${process.env.REACT_APP_API_URL.replace(/\/+$/,"")}/api/guest/refresh-token`,
      {
        method: "POST",
        credentials: "include",
        // P1-4: prior token as proof (in case the cross-site cookie is blocked).
        headers: {
          Authorization: `Bearer ${sessionStorage.getItem("guestToken") || localStorage.getItem("guestToken") || ""}`,
        },
      }
    );
    if (refreshRes.ok) {
      const { token } = await refreshRes.json();
      setAccessToken(token);
      init.headers["Authorization"] = `Bearer ${token}`;
      res = await fetch(url, init);
    } else {
      // if refresh itself failed, throw its error
      let errMsg = refreshRes.statusText;
      try {
        const errBody = await refreshRes.json();
        errMsg = errBody.error || errMsg;
      } catch {}
      throw new Error(`Session refresh failed: ${errMsg}`);
    }
  }

  // Parse JSON
  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    // bubble up backend error
    throw new Error(data.error || res.statusText);
  }

  return data;
}
