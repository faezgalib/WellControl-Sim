// Offline cache. The cache name follows the app version, so a new release installs a fresh copy.
const VERSION = 'wcsim-0.2.0';
const FILES = [
  './', './index.html', './manifest.webmanifest', './version.json', './css/app.css',
  './js/app.js', './js/store.js', './js/version.js', './js/disclaimer.js',
  './js/core/engine.js', './js/core/geometry.js', './js/core/scenario.js', './js/core/killsheet.js', './js/core/procedure.js', './js/core/analysis.js',
  './js/ui/dom.js', './js/ui/sim.js', './js/ui/charts.js', './js/ui/killsheet-form.js',
  './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png',
];

self.addEventListener('install', (e) => {
  // cache: 'reload' skips the browser HTTP cache so a release never mixes old and new files
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  // version.json: always ask the network (used by "Check for update"), cache only as fallback
  if (url.pathname.endsWith('/version.json')) {
    e.respondWith(fetch(e.request, { cache: 'no-store' }).catch(() => caches.match('./version.json')));
    return;
  }
  // everything else: cache first, so the app works offline and never half-updates
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request)));
});
