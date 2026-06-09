// Service worker KILL-SWITCH (legacy URL /service-worker.js).
// ============================================================================
// This file PREVIOUSLY shipped a naive cache-first worker that precached
// index.html and served EVERYTHING from cache — which served a stale CSP nonce
// and broke the app. Nothing registers this URL anymore (the app registers
// /sw.js, gated by REACT_APP_ENABLE_SW). This kill-switch exists so any browser
// still controlled by that old worker fetches this on its next update check,
// stops intercepting, unregisters itself, purges all caches, and reloads —
// recovering automatically without manual DevTools intervention.
// ============================================================================

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      try {
        const keys = await caches.keys();
        await Promise.all(keys.map((key) => caches.delete(key)));
      } catch (e) {
        // ignore
      }
      try {
        await self.registration.unregister();
      } catch (e) {
        // ignore
      }
      try {
        const clients = await self.clients.matchAll({ type: "window" });
        clients.forEach((client) => {
          try {
            client.navigate(client.url);
          } catch (e) {
            // ignore
          }
        });
      } catch (e) {
        // ignore
      }
    })()
  );
});

// Intentionally NO "fetch" listener — never intercept requests.