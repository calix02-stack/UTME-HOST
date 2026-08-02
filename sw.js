// MyUTME service worker
// Bump this string any time you change index.html / assets so old caches get replaced.
const CACHE_NAME = "myutme-cache-v2";

// Only cache the app shell. Supabase API calls are NOT cached — they always go to the network.
const APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) return caches.delete(key);
        })
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Never intercept Supabase (auth/data) or cross-origin API calls — always go live.
  if (url.origin !== self.location.origin) {
    return;
  }

  // App shell: try cache first, fall back to network, and refresh cache in background.
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const fetchPromise = fetch(event.request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const clone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return networkResponse;
        })
        .catch(() => cached); // offline fallback

      return cached || fetchPromise;
    })
  );
});