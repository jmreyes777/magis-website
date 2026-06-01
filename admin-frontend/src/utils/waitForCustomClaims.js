// utils/waitForCustomClaims.js
import { getAuth } from "firebase/auth";

/**
 * Resolves whether the current user's ID token contains the expectedRole
 * in its custom claims.
 *
 * Quota-safety notes:
 * - The previous implementation force-refreshed the ID token (getIdTokenResult(true))
 *   on every poll iteration, for up to 30s, on every call. When invoked from
 *   frequently-firing handlers (e.g. socket events) this produced hundreds of
 *   forced token refreshes and tripped Firebase's "auth/quota-exceeded".
 * - This version: (1) checks the CACHED token first (no network), (2) force-refreshes
 *   only a small, bounded number of times to pick up newly-set claims, and
 *   (3) caches the confirmed result per-user so repeated calls are free.
 *
 * @param {string} expectedRole              The custom claim role to wait for.
 * @param {object} [options]
 * @param {number} [options.maxForcedRefreshes] Max forced network refreshes (default: 2).
 * @param {number} [options.interval]           Delay in ms between forced refreshes (default: 3000).
 * @returns {Promise<boolean>} True if the role was found, false otherwise.
 */

// Module-level cache + in-flight de-duplication shared across all callers.
let cachedUid = null;
let cachedRole = null;
let inFlight = null;

/** Clear the cached claim result (call on logout / account switch). */
export function clearCustomClaimsCache() {
  cachedUid = null;
  cachedRole = null;
  inFlight = null;
}

const ABORT_CODES = new Set([
  "auth/quota-exceeded",
  "auth/invalid-user-token",
  "auth/user-token-expired",
  "auth/user-disabled",
  "auth/network-request-failed",
]);

export async function waitForCustomClaims(
  expectedRole,
  { maxForcedRefreshes = 2, interval = 3000 } = {}
) {
  const auth = getAuth();
  const user = auth.currentUser;
  if (!user) return false;

  // Fast path: previously confirmed for this exact user — no network at all.
  if (cachedUid === user.uid && cachedRole === expectedRole) {
    return true;
  }

  // Collapse concurrent invocations (e.g. a burst of socket events) into one.
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      // 1) Cheap check using the cached ID token (NO network refresh).
      try {
        const { claims } = await user.getIdTokenResult(false);
        if (claims.role === expectedRole) {
          cachedUid = user.uid;
          cachedRole = expectedRole;
          return true;
        }
      } catch (err) {
        if (ABORT_CODES.has(err?.code)) {
          console.warn("[waitForCustomClaims] aborting on", err.code);
          return false;
        }
      }

      // 2) Force-refresh a bounded number of times to pick up just-set claims.
      for (let attempt = 0; attempt < maxForcedRefreshes; attempt++) {
        try {
          const { claims } = await user.getIdTokenResult(true);
          if (claims.role === expectedRole) {
            cachedUid = user.uid;
            cachedRole = expectedRole;
            return true;
          }
        } catch (err) {
          // Never loop on quota/auth errors — bail immediately.
          if (ABORT_CODES.has(err?.code)) {
            console.warn("[waitForCustomClaims] aborting on", err.code);
            return false;
          }
          console.error("[waitForCustomClaims] token refresh error:", err);
        }
        // Backoff before the next forced refresh (skip after the last attempt).
        if (attempt < maxForcedRefreshes - 1) {
          await new Promise((resolve) => setTimeout(resolve, interval));
        }
      }

      return false;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}
