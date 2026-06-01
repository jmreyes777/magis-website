// src/sw.js
/* eslint-disable no-restricted-globals */
import { precacheAndRoute } from "workbox-precaching";
import { clientsClaim }      from "workbox-core";
import { registerRoute }     from "workbox-routing";
import {
  StaleWhileRevalidate,
  CacheFirst,
  NetworkFirst,
  NetworkOnly
} from "workbox-strategies";
import { ExpirationPlugin }      from "workbox-expiration";
import { BackgroundSyncPlugin }  from "workbox-background-sync";

precacheAndRoute(self.__WB_MANIFEST || []);
clientsClaim();

self.addEventListener('message', (evt) => {
  if (evt.data === 'SKIP_WAITING') self.skipWaiting();
});

// Fallback to “index.html” for navigation requests (SPA offline support)
registerRoute(
  ({ request }) => request.mode === 'navigate',
  async () => {
    try {
      return await caches.match('/index.html');
    } catch {
      return Response.error();
    }
  }
);

// •––––– Cache JS/CSS (stale-while-revalidate) –––––•
registerRoute(
  ({ request }) =>
    request.destination === "script" ||
    request.destination === "style",
  new StaleWhileRevalidate({
    cacheName: "static-resources",
  })
);

// •––––– Cache web fonts (cache-first, 30d) –––––•
registerRoute(
  ({ request }) => request.destination === "font",
  new CacheFirst({
    cacheName: "fonts-cache",
    plugins: [
      new ExpirationPlugin({
        maxEntries: 20,
        maxAgeSeconds: 30 * 24 * 60 * 60,
      }),
    ],
  })
);

// •––––– SPA navigations (network-first, 3s timeout) –––––•
registerRoute(
  ({ request }) => request.mode === "navigate",
  new NetworkFirst({
    cacheName: "pages-cache",
    networkTimeoutSeconds: 3,
  })
);

// •––––– Branch-status API (stale-while-revalidate) –––––•
registerRoute(
  ({ url }) => url.pathname.startsWith("/api/branch-status"),
  new StaleWhileRevalidate({
    cacheName: "api-status",
  })
);

// •––––– Chat-history API (network-first) –––––//
//  history is critical, so prefer fresh data with a short fallback
registerRoute(
  ({ url }) => url.pathname.match(/\/api\/messages\/history/),
  new NetworkFirst({
    cacheName: "chat-history",
    networkTimeoutSeconds: 2,
    plugins: [
      new ExpirationPlugin({
        maxEntries: 30,
        maxAgeSeconds: 5 * 60, //  5 min
      }),
    ],
  })
);

// •––––– Outgoing “send message” POSTs (background-sync) –––––//
const bgSyncPlugin = new BackgroundSyncPlugin("outbox-queue", {
  maxRetentionTime: 24 * 60, // Retry for up to 24h
});
registerRoute(
  ({ url, request }) =>
    url.pathname.endsWith("/api/messages/send") &&
    request.method === "POST",
  new NetworkOnly({
    plugins: [bgSyncPlugin],
  }),
  "POST"
);

// •––––– Images & attachments (cache-first, 50 entries) –––––•
registerRoute(
  ({ request }) => request.destination === "image",
  new CacheFirst({
    cacheName: "images",
    plugins: [
      new ExpirationPlugin({
        maxEntries: 50,
        maxAgeSeconds: 7 * 24 * 60 * 60,
      }),
    ],
  })
);
