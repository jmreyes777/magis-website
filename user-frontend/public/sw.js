// Service worker KILL-SWITCH.
//
// This app no longer ships a service worker. Browsers that still have an older
// (broken) worker registered will fetch this file on their next update check
// and replace the old worker with this one. Because this worker has NO fetch
// handler, it immediately stops intercepting navigations, then unregisters
// itself, purges all caches, and reloads any open clients so the page recovers
// without manual DevTools intervention.

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
