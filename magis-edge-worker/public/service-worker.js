self.addEventListener('install', evt => {
  evt.waitUntil(
    caches.open('v1').then(cache =>
      cache.addAll([
        '/', '/index.html',
        '/static/js/bundle.js',
        'https://maps.googleapis.com/maps/api/js',
      ])
    )
  );
});
self.addEventListener('fetch', evt => {
  evt.respondWith(
    caches.match(evt.request).then(res => res || fetch(evt.request))
  );
});