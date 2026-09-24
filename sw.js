// MyUTME service worker
const CACHE_NAME = "myutme-cache-v7";

const APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./offline-db.js",
  "./offline-db-boost.js",
];

// How long to give a background revalidation fetch before giving up.
const FETCH_TIMEOUT_MS = 8000;

function fetchWithTimeout(request, timeoutMs = FETCH_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Network request timed out"));
    }, timeoutMs);

    fetch(request).then(
      (response) => {
        clearTimeout(timer);
        resolve(response);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

self.addEventListener("install", (event) => {
  // Add files one by one so a single missing file can't break the install.
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.all(APP_SHELL.map((url) => cache.add(url).catch(() => null)))
    )
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

  // The app's own scripts (offline-db.js etc.): also stale-while-revalidate,
  // ignoring the ?v= query so the cached copy is always found offline.
  const isAppScript = url.pathname.endsWith(".js") && /offline-db/.test(url.pathname);

  if (isAppShell || isQuestionDataFile || isAppScript) {
    // STALE-WHILE-REVALIDATE: answer from cache immediately when a copy
    // exists; refresh in the background for next time.
    const ignoreSearch = isQuestionDataFile || isAppScript;
    event.respondWith(
      caches.match(event.request, { ignoreSearch }).then((cached) => {
        const revalidate = fetchWithTimeout(event.request)
          .then((networkResponse) => {
            if (networkResponse && networkResponse.status === 200) {
              const clone = networkResponse.clone();
              // Store script copies under the plain path so ?v= changes still match.
              const key = isAppScript ? new Request(url.origin + url.pathname) : event.request;
              caches.open(CACHE_NAME).then((cache) => cache.put(key, clone));
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

  // Everything else (icons, manifest, other static assets).
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const fetchPromise = fetchWithTimeout(event.request)
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
