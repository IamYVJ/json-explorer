/* Minimal offline cache. All paths are relative so the worker also works
   when the site is served from a GitHub Pages subpath. */

const CACHE = 'json-explorer-v5';
const ASSETS = [
  './',
  './index.html',
  './css/styles.css',
  './js/app.js',
  './js/parser.js',
  './js/serialize.js',
  './js/stats.js',
  './js/tree.js',
  './js/jsonpath.js',
  './js/sample.js',
  './manifest.webmanifest',
  './assets/icon.svg',
  './assets/favicon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) =>
        // Fetch with { cache: 'reload' } so precaching bypasses the browser's
        // HTTP cache — otherwise a returning visitor could re-cache stale files
        // even after the CACHE version is bumped.
        Promise.all(
          ASSETS.map((url) =>
            fetch(new Request(url, { cache: 'reload' })).then((res) => {
              if (!res || !res.ok) throw new Error('Precache failed: ' + url);
              return cache.put(url, res);
            })
          )
        )
      )
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req)
        .then((res) => {
          if (res && res.status === 200 && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
    })
  );
});
