// MyUTME service worker (v13) — always loads the NEWEST app, still works offline.
//
// WHAT CHANGED vs v12:
//  - Page + offline-db.js: fetched fresh from the network EVERY time with cache:"no-store"
//    (this bypasses the browser/host HTTP cache, which is what kept serving the old index.html).
//  - The saved copy is used ONLY if the network fails or takes longer than PAGE_TIMEOUT_MS.
//  - Cache name bumped to v13 so all v12 data is deleted on activate.
//  - Question data files keep the "instant + refresh in background" behaviour (good for offline use),
//    but the background refresh now also bypasses the HTTP cache.
const CACHE_NAME = "myutme-cache-v13";

const APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./offline-db.js",
];

const FETCH_TIMEOUT_MS = 8000;
// Only fall back to the saved page if the network has not answered in this long (very slow / no internet).
const PAGE_TIMEOUT_MS = 12000;

// fetch that skips the browser's HTTP cache, with a timeout
function freshFetch(request, timeoutMs = FETCH_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Network request timed out")), timeoutMs);
    fetch(request, { cache: "no-store" }).then(
      (response) => { clearTimeout(timer); resolve(response); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.all(
        APP_SHELL.map((url) =>
          fetch(url, { cache: "no-store" })
            .then((res) => (res && res.ok ? cache.put(url, res) : null))
            .catch(() => null)
        )
      )
    )
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.map((key) => (key !== CACHE_NAME ? caches.delete(key) : null))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  const isAppShell =
    event.request.mode === "navigate" ||
    url.pathname.endsWith(".html") ||
    url.pathname === "/" ||
    url.pathname.endsWith("/");

  const isQuestionDataFile =
    /^\/?questions-[^/]+\.json$/.test(url.pathname) ||
    url.pathname.endsWith("questions-seed.json");

  const isAppScript = url.pathname.endsWith(".js") && /offline-db/.test(url.pathname);

  // The app page and offline-db.js: NETWORK FIRST, always fresh. Saved copy only if offline/very slow.
  if (isAppShell || isAppScript) {
    event.respondWith(
      freshFetch(event.request, PAGE_TIMEOUT_MS)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const clone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return networkResponse;
        })
        .catch(() =>
          caches
            .match(event.request, { ignoreSearch: isAppScript })
            .then((cached) => cached || (isAppShell ? caches.match("./index.html") : null))
            .then((cached) => cached || Response.error())
        )
    );
    return;
  }

  // Question data: show saved copy instantly, refresh in the background (fresh, not from HTTP cache).
  if (isQuestionDataFile) {
    event.respondWith(
      caches.match(event.request, { ignoreSearch: true }).then((cached) => {
        const revalidate = freshFetch(event.request)
          .then((networkResponse) => {
            if (networkResponse && networkResponse.status === 200) {
              const clone = networkResponse.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
            }
            return networkResponse;
          })
          .catch(() => null);

        if (cached) {
          event.waitUntil(revalidate);
          return cached;
        }
        return revalidate.then((res) => res || Response.error());
      })
    );
    return;
  }

  // Everything else on your site (icons, manifest...): saved copy first, refreshed in the background.
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const fetchPromise = freshFetch(event.request)
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

// ---- Push notifications (unchanged from v12) ----
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: "MyUTME", body: event.data ? event.data.text() : "" };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || "MyUTME", {
      body: data.body || "",
      icon: "./icon-192.png",
      badge: "./icon-badge-96.png",
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
      for (const client of clientList) {
        if ("focus" in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow(targetUrl);
    })
  );
});
