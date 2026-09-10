const CACHE = 'sen-tracker-v8';

const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './gate.json',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // addAll goes through the HTTP cache, which can quietly install the very
      // files this update is meant to replace. Force each one from the network.
      .then((cache) => cache.addAll(
        SHELL.map((url) => new Request(url, { cache: 'reload' }))
      ))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // JSON the app fetches with a cache-busting query: always try the network
  // first, and key the cached copy on the bare path so repeated launches
  // cannot pile up one entry per query string.
  if (/\/(data|seed|gate)\.json$/.test(url.pathname)) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(stripQuery(url), copy));
          return response;
        })
        .catch(() => caches.match(stripQuery(url)))
    );
    return;
  }

  // App shell: cache first, refresh in the background. Requests carrying a
  // query string are served but never stored, so cache-busted one-off fetches
  // do not accumulate.
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response && response.ok && !url.search && url.origin === self.location.origin) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});

function stripQuery(url) {
  return url.origin + url.pathname;
}
