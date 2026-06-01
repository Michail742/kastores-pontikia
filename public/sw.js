const CACHE = 'kastores-v1';
const ASSETS = ['/', '/manifest.json', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

// Network-first for socket.io and API; cache-first for static shell
self.addEventListener('fetch', e => {
  if (e.request.url.includes('/socket.io')) return; // never cache WS upgrade
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});
