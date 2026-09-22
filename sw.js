// MyUTME service worker
const CACHE_NAME = "myutme-cache-v6";

const APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
];

// How long to give a background revalidation fetch before giving up.
// This no longer blocks anything the user sees (see the app-shell
// strategy below) — it only bounds how long we keep trying to refresh
// the cache behind the scenes.
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
  // requested as "./" / "./index.html").
  const isAppShell =
    event.request.mode === "navigate" ||
    url.pathname.endsWith(".html") ||
    url.pathname === "/" ||
    url.pathname.endsWith("/");

  // Per-subject question data files (questions-<subjectId>.json) and the
  // legacy seed file.
  const isQuestionDataFile =
    /^\/?questions-[^/]+\.json$/.test(url.pathname) ||
    url.pathname.endsWith("questions-seed.json");

  if (isAppShell || isQuestionDataFile) {
    // STALE-WHILE-REVALIDATE: answer from cache immediately whenever a
    // cached copy exists, so the app opens instantly every time — poor
    // signal, mobile data off, a slow/hanging request, none of it can
    // block the app from opening. A fresh copy is fetched in the
    // background and saved for next time; the client already reloads
    // itself the moment that new version takes over (see
    // "controllerchange" in index.html), so this trades "may be a few
    // minutes behind on the very latest deploy" for "never stuck on a
    // loading screen," which is the right trade for an exam-prep app.
    // Only when there is truly no cached copy yet (first-ever install,
    // or this exact file was never cached) do we fall back to waiting on
    // the network directly.
    event.respondWith(
      caches.match(event.request, { ignoreSearch: isQuestionDataFile }).then((cached) => {
        const revalidate = fetchWithTimeout(event.request)
          .then((networkResponse) => {
            if (networkResponse && networkResponse.status === 200) {
              const clone = networkResponse.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
            }
            return networkResponse;
          })
          .catch(() => null);

        if (cached) {
          // Kick off the background refresh but don't make the page wait
          // on it — respond with what we already have right now.
          event.waitUntil(revalidate);
          return cached;
        }
        // Nothing cached yet at all: this is the one case where we do
        // need to wait for the network (or its timeout) before we have
        // anything to show.
        return revalidate.then((res) => res || Response.error());
      })
    );
    return;
  }

  // Everything else (icons, manifest, other static assets) — cache-first
  // is fine since these rarely change and don't need to be instantly fresh.
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
