const FALLBACK_KEY = 'fallbackToken';
const FALLBACK_LOCAL_KEY = 'fallbackTokenLocal';
const CSRF_KEY = 'csrfToken';

/**
 * Store the fallback JWT in sessionStorage (and optionally localStorage).
 * Also posts the token to the active Service Worker.
 *
 * @param {string} token - JWT string
 * @param {boolean} persist - whether to also store in localStorage
 */
export function setFallbackToken(token, persist = false) {
  sessionStorage.setItem(FALLBACK_KEY, token);
  if (persist) {
    localStorage.setItem(FALLBACK_LOCAL_KEY, token);
  }

  if (navigator.serviceWorker && navigator.serviceWorker.controller) {
    navigator.serviceWorker.controller.postMessage({
      type: 'SET_FALLBACK_TOKEN',
      token,
    });
  }
}

/**
 * Retrieve the fallback JWT, preferring sessionStorage over localStorage.
 *
 * @returns {string|null}
 */
export function getFallbackToken() {
  return sessionStorage.getItem(FALLBACK_KEY) || localStorage.getItem(FALLBACK_LOCAL_KEY);
}

/**
 * Check if a JWT is expired based on its "exp" claim.
 *
 * @param {string} token
 * @returns {boolean}
 */
function isTokenExpired(token) {
  try {
    const [, payload] = token.split('.');
    const { exp } = JSON.parse(atob(payload));
    return exp * 1000 < Date.now();
  } catch {
    return true;
  }
}

/**
 * Read CSRF token from cookie or sessionStorage.
 *
 * @returns {string|null}
 */
export function getCsrfToken() {
  const match = document.cookie.match(new RegExp('(^|; )' + CSRF_KEY + '=([^;]+)'));
  if (match) return decodeURIComponent(match[2]);
  return sessionStorage.getItem(CSRF_KEY);
}

/**
 * Explicitly set a CSRF token in sessionStorage and the Service Worker.
 *
 * @param {string} token - CSRF token string
 */
export function setCsrfToken(token) {
  sessionStorage.setItem(CSRF_KEY, token);

  if (navigator.serviceWorker && navigator.serviceWorker.controller) {
    navigator.serviceWorker.controller.postMessage({
      type: 'SET_CSRF_TOKEN',
      token,
    });
  }
}

/**
 * Retrieve the active JWT, refreshing it silently if missing or expired.
 *
 * @returns {Promise<string|null>}
 */
export async function getToken() {
  let token = getFallbackToken();
  if (!token || isTokenExpired(token)) {
    try {
      const guestId = sessionStorage.getItem('guestId');
      const branchEmail = sessionStorage.getItem('branchEmail');
      const res = await fetch(
        `${process.env.REACT_APP_API_URL}/api/guest/refresh-token`,
        {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': getCsrfToken(),
          },
          body: JSON.stringify({ guestId, branchEmail }),
        }
      );
      const data = await res.json();
      if (res.ok && data.token) {
        token = data.token;
        setFallbackToken(token);
      } else {
        console.warn('[tokenManager] Token refresh failed:', data.error);
      }
    } catch (err) {
      console.error('[tokenManager] Error during token refresh:', err);
    }
  }
  return token;
}

/**
 * Initialize the token manager by pushing any existing tokens to the Service Worker.
 * Call this on page load after the Service Worker is ready.
 */
export function initTokenManager() {
  const fallback = getFallbackToken();
  if (fallback && navigator.serviceWorker && navigator.serviceWorker.controller) {
    navigator.serviceWorker.controller.postMessage({
      type: 'SET_FALLBACK_TOKEN',
      token: fallback,
    });
  }

  const csrf = getCsrfToken();
  if (csrf && navigator.serviceWorker && navigator.serviceWorker.controller) {
    navigator.serviceWorker.controller.postMessage({
      type: 'SET_CSRF_TOKEN',
      token: csrf,
    });
  }
}
