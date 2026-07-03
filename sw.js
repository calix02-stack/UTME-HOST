const CACHE_NAME = "my-utme-v1";
const urlsToCache = [
  "/",
  "/index.html",
  "/manifest.json"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log("✅ Caching app files");
        return cache.addAll(urlsToCache);
      })
      .catch((err) => console.log("❌ Cache error:", err))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      );
    })
  );
  return self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  event.respondWith(
    caches.match(event.request)
      .then((response) => {
        return response || fetch(event.request);
      })
  );
});

self.addEventListener('push', e => {
  const data = e.data ? e.data.json() : {};
  self.registration.showNotification(data.title || 'My UTME', {
    body: data.body || '',
    icon: 'https://rofssssxyxamolmkypqz.supabase.co/storage/v1/object/public/My%20image/icon-192.png',
    badge: 'https://rofssssxyxamolmkypqz.supabase.co/storage/v1/object/public/My%20image/icon-192.png',
    image: data.image || undefined,
    data: { url: data.url || '/' }
  });
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.openWindow(e.notification.data.url || '/'));
});