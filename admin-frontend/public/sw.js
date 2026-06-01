// public/service-worker.js

// This Service Worker intercepts all same‑origin requests to /api/*,
// injects the stored auth token into the Authorization header, and
// proxies them onward. Other requests (static assets, socket.io, etc.)
// pass through unmodified.

let authToken = null;

// Immediately take control of the page
self.addEventListener('install', event => {
  self.skipWaiting();
});
self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

// Receive token updates from the page
self.addEventListener('message', event => {
  if (!event.data || event.data.type !== 'SET_TOKEN') return;
  authToken = event.data.token || null;
  console.log('[SW] authToken updated:', authToken);
});

// Intercept fetches
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Only proxy same‑origin /api/* calls
  if (url.origin === self.location.origin && url.pathname.startsWith('/api/')) {
    // Clone and modify headers
    const headers = new Headers(request.headers);
    if (authToken) {
      headers.set('Authorization', `Bearer ${authToken}`);
    } else {
      headers.delete('Authorization');
    }

    const modifiedRequest = new Request(request, { headers });
    event.respondWith(fetch(modifiedRequest));
  }
  // All other requests (e.g. /socket.io, static files) fall through to default network behavior
});
