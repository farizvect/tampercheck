'use strict';
// Offline shell for tampercheck.
//
// Only the static shell is cached. Reports, the device list and the analyse endpoint are never
// cached here: a cached verdict would be a stale claim about a device, which is exactly the kind
// of thing this tool exists to avoid.

const CACHE = 'tampercheck-shell-v2';
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
    // Stale-while-revalidate. Cache-first would mean a deployed fix never reaches an installed app:
    // the cache is only refilled on a miss, and there is never a miss. Here the shell still loads
    // instantly from cache, and the fresh copy is fetched behind it for the next load.
    e.respondWith(
      caches.open(CACHE).then((c) => c.match(e.request).then((hit) => {
        const fresh = fetch(e.request).then((res) => {
          if (res && res.ok) c.put(e.request, res.clone());
          return res;
        }).catch(() => hit);
        return hit || fresh;
      }))
    );
  }
});
