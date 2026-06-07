// src/Shared/turnstile.js
// P1-4 (Part B): Cloudflare Turnstile invisible-token helper for guest /init.
// The guest session is created programmatically (no form), so we render a
// one-shot INVISIBLE widget on demand and resolve its token. Fail-OPEN on the
// client (returns null if Turnstile is unavailable/slow) — the backend enforces
// only when TURNSTILE_SECRET is configured, so this never hard-blocks chat.

const SITE_KEY =
  process.env.REACT_APP_TURNSTILE_SITE_KEY || "0x4AAAAAADgNT1R9swehb1UE";
const SCRIPT_SRC =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

let scriptPromise = null;

function loadScript() {
  if (typeof window === "undefined") return Promise.resolve(null);
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (scriptPromise) return scriptPromise;

  scriptPromise = new Promise((resolve) => {
    const onReady = () => resolve(window.turnstile || null);
    const base = SCRIPT_SRC.split("?")[0];
    const existing = document.querySelector(`script[src^="${base}"]`);
    if (existing) {
      if (window.turnstile) return onReady();
      existing.addEventListener("load", onReady, { once: true });
      existing.addEventListener("error", () => resolve(null), { once: true });
      return;
    }
    const s = document.createElement("script");
    s.src = SCRIPT_SRC;
    s.async = true;
    s.defer = true;
    s.addEventListener("load", onReady, { once: true });
    s.addEventListener("error", () => resolve(null), { once: true });
    document.head.appendChild(s);
  });
  return scriptPromise;
}

/**
 * Resolve a fresh Turnstile token, or null if it can't be obtained in time.
 * @param {number} timeoutMs
 * @returns {Promise<string|null>}
 */
export async function getTurnstileToken(timeoutMs = 8000) {
  try {
    const ts = await loadScript();
    if (!ts || typeof ts.render !== "function") return null;

    return await new Promise((resolve) => {
      let settled = false;
      let widgetId;
      const el = document.createElement("div");
      el.style.position = "fixed";
      el.style.left = "-9999px";
      el.style.bottom = "0";
      el.setAttribute("aria-hidden", "true");
      document.body.appendChild(el);

      const cleanup = () => {
        try { ts.remove(widgetId); } catch (_) {}
        try { el.remove(); } catch (_) {}
      };
      const finish = (val) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cleanup();
        resolve(val);
      };
      const timer = setTimeout(() => finish(null), timeoutMs);

      try {
        widgetId = ts.render(el, {
          sitekey: SITE_KEY,
          size: "invisible",
          callback: (token) => finish(token),
          "error-callback": () => finish(null),
          "timeout-callback": () => finish(null),
          "expired-callback": () => finish(null),
        });
        try { ts.execute(widgetId); } catch (_) {}
      } catch (_) {
        finish(null);
      }
    });
  } catch (_) {
    return null;
  }
}
