// src/utils/csrf.js

import {
    setCsrfToken as tokenManagerSetCsrf,
    getCsrfToken as tokenManagerGetCsrf,
  } from "./tokenManager";
  
  // Determine the CSRF endpoint, allow relative as fallback
  const CSRF_ENDPOINT =
  process.env.NODE_ENV === "development"
    ? "/api/csrf-token" // let CRA proxy handle it over HTTP
    : `${(process.env.REACT_APP_API_URL || "").replace(/\/$/, "")}/api/csrf-token`;
  
  /**
   * Internal helper to fetch from a given URL and return csrfToken or null.
   */
  async function doFetch(url) {
    try {
      const res = await fetch(url, {
        method: "GET",
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      if (!res.ok) {
        console.warn("[csrf] unexpected status from", url, res.status, res.statusText);
        return null;
      }
      const json = await res.json();
      return json.csrfToken ?? null;
    } catch (err) {
      console.error("[csrf] network error fetching token from", url, err);
      return null;
    }
  }
  
  /**
   * Fetch a fresh CSRF token from the server and store it in sessionStorage & SW.
   * Server endpoint should set a csrfToken cookie AND return { csrfToken } in JSON.
   *
   * @returns {Promise<string|null>} the fetched CSRF token or null on failure
   */
  export async function fetchCsrfToken() {
    console.debug("[csrf] fetching CSRF token from", CSRF_ENDPOINT);
  
    // Try primary endpoint
    let token = await doFetch(CSRF_ENDPOINT);
  
    // If that failed and we used an absolute URL, retry the relative path once
    if (token === null && CSRF_ENDPOINT !== "/api/csrf-token") {
      console.warn("[csrf] retrying against relative path /api/csrf-token");
      token = await doFetch("/api/csrf-token");
    }
  
    if (token) {
      tokenManagerSetCsrf(token);
      return token;
    }
  
    return null;
  }
  
  /**
   * Read the CSRF token (from cookie or sessionStorage) and inject it into headers.
   *
   * @param {Object} headers - existing headers object or init.headers
   * @returns {Object} headers augmented with X-CSRF-Token if available
   */
  export function attachCsrfHeader(headers = {}) {
    const token = tokenManagerGetCsrf();
    if (token) {
      return { ...headers, "X-CSRF-Token": token };
    }
    return headers;
  }
  
  /**
   * Wrapper around fetch that injects CSRF header automatically for unsafe methods.
   *
   * @param {string|Request} input - request URL or Request object
   * @param {Object} init - fetch init options
   * @returns {Promise<Response>}
   */
  export async function fetchWithCsrf(input, init = {}) {
    const method = (init.method || "GET").toUpperCase();
    const needsHeader = !["GET", "HEAD", "OPTIONS"].includes(method);
    const mergedInit = {
      ...init,
      credentials: "include",
      headers: needsHeader
        ? attachCsrfHeader(init.headers || {})
        : init.headers,
    };
    return fetch(input, mergedInit);
  }
  