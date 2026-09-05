// MyUTME service worker
const CACHE_NAME = "myutme-cache-v4";

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
  if (url.origin !== self.location.origin) return;

  // App shell (the HTML page itself, whether navigated to directly or
  // requested as "./" / "./index.html") — always try the network first so
  // a fresh deploy is picked up on the very next load, not the one after.
  // Falls back to cache only when the network is unreachable (offline).
  const isAppShell =
    event.request.mode === "navigate" ||
    url.pathname.endsWith(".html") ||
    url.pathname === "/" ||
    url.pathname.endsWith("/");

  // Per-subject question data files (questions-<subjectId>.json) and the
  // legacy seed file. These are the files the app checks on every open to
  // decide what to add/update/DELETE offline, so they must always go to
  // the network first — a cache-first strategy here would keep silently
  // serving an old (or since-deleted) file's contents forever, since the
  // app would never even see a 404 from the real server. Falls back to the
  // last-known-good cached copy only when there's truly no network, so
  // offline use still works.
  const isQuestionDataFile =
    /^\/?questions-[^/]+\.json$/.test(url.pathname) ||
    url.pathname.endsWith("questions-seed.json");

  if (isAppShell || isQuestionDataFile) {
    event.respondWith(
      fetch(event.request)
        .then((networkResponse) => {
          // Cache successful responses only — never cache a 404/500 so a
          // later real network check isn't shadowed by a bad cached entry.
          if (networkResponse && networkResponse.status === 200) {
            const clone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return networkResponse;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // Everything else (icons, manifest, other static assets) — cache-first
  // is fine since these rarely change and don't need to be instantly fresh.
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
        .catch(() => cached);
      return cached || fetchPromise;
    })
  );
});

// ===== PUSH NOTIFICATIONS =====
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    // Payload wasn't valid JSON — fall back to plain text rather than
    // dropping the notification entirely.
    data = { title: "MyUTME", body: event.data ? event.data.text() : "" };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || "MyUTME", {
      body: data.body || "",
      icon: "./icon-192.png",
      badge: "./icon-badge-96.png",
      // A stable tag means a second reminder replaces the first
      // notification in the tray instead of stacking duplicates.
      tag: data.tag || "myutme-notification",
      data: data.url || "/",
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = event.notification.data || "/";

  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      // Focus an already-open app tab instead of piling up new ones.
      for (const client of clientList) {
        if ("focus" in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow(targetUrl);
    })
  );
});
