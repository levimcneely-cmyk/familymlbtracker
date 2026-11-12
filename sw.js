/* Service worker: makes the app open offline and installable.
   - App files: network first (so updates arrive), cache as fallback.
   - Team logos / fonts: cache first.
   - MLB data is never cached here (the page keeps its own last-good copy). */
const VERSION = 'mlbft-v1';
const SHELL = ['./', 'index.html', 'css/style.css', 'js/config.js', 'js/core.js', 'js/app.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-180.png'];
const ASSET_HOSTS = ['www.mlbstatic.com', 'fonts.gstatic.com', 'fonts.googleapis.com'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    e.respondWith(fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req).then(r => r || (req.mode === 'navigate' ? caches.match('index.html') : Response.error()))));
  } else if (ASSET_HOSTS.includes(url.hostname)) {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
      if (res.ok || res.type === 'opaque') { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); }
      return res;
    })));
  }
});
