'use strict';
// Моите финанси — service worker: приложението работи и без интернет.
// VERSION се сменя при всяко качване (deploy.sh), за да се изтегли новата версия.
const VERSION = '20261010090149';
const CACHE = `moite-finansi-${VERSION}`;
const ASSETS = [
  './', 'index.html', 'app.css', 'app.js', 'core.js',
  'lib/sql-wasm.js', 'lib/sql-wasm.wasm',
  'icon.svg', 'apple-touch-icon.png', 'manifest.webmanifest',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS.map((a) => new Request(a, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('moite-finansi-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => {
      if (hit) return hit;
      return fetch(req).catch(() => (req.mode === 'navigate' ? caches.match('index.html') : Response.error()));
    }),
  );
});
