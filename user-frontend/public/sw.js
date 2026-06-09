// Magis user-frontend service worker (PERF4-1) — served at /sw.js.
// ============================================================================
// SAFE-BY-DESIGN. This worker caches ONLY content-hashed, immutable build
// assets (/static/*), same-origin images, and same-origin fonts. It NEVER
// intercepts:
//   • HTML navigations  -> always go to the network, so index.html (and its
//     PER-REQUEST CSP NONCE) is always fresh. Serving a cached HTML page would
//     carry a stale nonce and the CSP would block our own scripts.
//   • API / cross-origin requests -> always network (no auth/state caching).
//
// It is only ever registered when REACT_APP_ENABLE_SW === 'true'
// (see src/index.js); with the flag off, src/index.js unregisters + purges.
// ============================================================================

const VERSION = "v1";
const STATIC_CACHE = `magis-static-${VERSION}`;
const IMAGE_CACHE = `magis-images-${VERSION}`;
const FONT_CACHE = `magis-fonts-${VERSION}`;
const ALLOWED_CACHES = new Set([STATIC_CACHE, IMAGE_CACHE, FONT_CACHE]);

// Soft caps so caches can't grow unbounded (FIFO eviction).
const STATIC_MAX_ENTRIES = 80;
const IMAGE_MAX_ENTRIES = 60;
const FONT_MAX_ENTRIES = 20;

self.addEventListener("install", () => {
  // No HTML/asset precaching — assets are cached lazily on first request.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Purge any cache not in the current allowlist — including the old
      // cache-first "v1" cache from the previous (broken) worker, and any
      // earlier SW versions after a VERSION bump.
      try {
        const keys = await caches.keys();
        await Promise.all(
          keys.filter((k) => !ALLOWED_CACHES.has(k)).map((k) => caches.delete(k))
        );
      } catch (e) {
        // ignore
      }
      await self.clients.claim();
    })()
  );
});

self.addEventListener("message", (event) => {
  // src/index.js posts the string 'SKIP_WAITING' when a new SW is installed.
  const data = event.data;
  if (data === "SKIP_WAITING" || (data && data.type === "SKIP_WAITING")) {
    self.skipWaiting();
  }
});

async function trimCache(cacheName, maxEntries) {
  try {
    const cache = await caches.open(cacheName);
    const keys = await cache.keys();
    for (let i = 0; i < keys.length - maxEntries; i++) {
      await cache.delete(keys[i]); // oldest first (FIFO)
    }
  } catch (e) {
    // ignore
  }
}

async function cacheFirst(request, cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  // Only store successful, non-opaque responses (never cache errors/redirects
  // or opaque cross-origin bodies).
  if (response && response.status === 200 && response.type !== "opaque") {
    cache.put(request, response.clone());
    if (maxEntries) trimCache(cacheName, maxEntries);
  }
  return response;
}

function isStaticAsset(url) {
  return (
    url.origin === self.location.origin && url.pathname.startsWith("/static/")
  );
}

function isImage(request, url) {
  if (url.origin !== self.location.origin) return false; // never cache cross-origin (opaque)
  if (request.destination === "image") return true;
  return /\.(?:png|jpe?g|gif|svg|webp|avif|ico)$/i.test(url.pathname);
}

function isFont(request, url) {
  if (url.origin !== self.location.origin) return false;
  if (request.destination === "font") return true;
  return /\.(?:woff2?|ttf|otf|eot)$/i.test(url.pathname);
}

self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Only same-origin GETs are ever cached. Everything else — navigations,
  // API calls, POST/PUT, cross-origin — falls through to normal network
  // handling (no respondWith), which is what keeps the CSP nonce fresh.
  if (request.method !== "GET") return;
  if (request.mode === "navigate") return; // HTML -> network, always

  let url;
  try {
    url = new URL(request.url);
  } catch (e) {
    return;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return;

  if (isStaticAsset(url)) {
    event.respondWith(cacheFirst(request, STATIC_CACHE, STATIC_MAX_ENTRIES));
  } else if (isImage(request, url)) {
    event.respondWith(cacheFirst(request, IMAGE_CACHE, IMAGE_MAX_ENTRIES));
  } else if (isFont(request, url)) {
    event.respondWith(cacheFirst(request, FONT_CACHE, FONT_MAX_ENTRIES));
  }
  // else: do nothing -> default network fetch.
});
