// App-shell cache only. Cycle data itself is mirrored to localStorage by
// index.html, not intercepted here — Supabase API requests always go to the
// network so auth/session state stays correct. The Supabase SDK script is
// the one cross-origin exception: it's part of the shell (the app can't even
// start without it), so it's precached and served cache-first like the rest.
const CACHE_NAME = 'cycle-tracker-shell-v1';
const SUPABASE_SDK_URL = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';
const SHELL_FILES = [
  './',
  './index.html',
  './manifest.json',
  './js/config.js',
  './js/cycleFlag.js',
  './js/app.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  SUPABASE_SDK_URL,
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const isShell = url.origin === self.location.origin || event.request.url === SUPABASE_SDK_URL;
  if (!isShell) return; // let Supabase API calls pass straight through, uncached

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      }).catch(() => cached);
    })
  );
});
