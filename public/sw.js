'use strict';
// Offline shell for tampercheck.
//
// Only the static shell is cached. Reports, the device list and the analyse endpoint are never
// cached here: a cached verdict would be a stale claim about a device, which is exactly the kind
// of thing this tool exists to avoid.

const CACHE = 'tampercheck-shell-v1';
const SHELL = [
  '/',
  '/assets/styles.css',
  '/assets/app.js',
  '/assets/icon-192.png',
  '/assets/icon-512.png',
  '/manifest.webmanifest',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // never serve a cached report, device list or analysis
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/r/')) return;

  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).catch(() => caches.match('/')));
    return;
  }
  if (url.pathname.startsWith('/assets/') || url.pathname === '/manifest.webmanifest') {
    e.respondWith(
      caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      }))
    );
  }
});
