/*! MyUTME service worker · enzo-ai
 * Built by Enzo · © 2026 Enzo. All rights reserved. */
// MyUTME service worker (v27 — question files now network-first; was v24 — topic progress + question-count picker + 249 new Physics questions; v14 notes below) — always loads the NEWEST app, still works offline.
//
// WHAT CHANGED vs v13:
//  - Cache name bumped to v14 so all v13 data is deleted on activate and everyone gets the new
//    News feature (News page, likes, comments, WhatsApp share links like /?news=ID).
//  - Tapping a News phone alert now opens that news (or the latest news) directly.
//  - Nothing else changed: shared news links open fresh from the network like any page, and
//    fall back to the saved app if the person is offline.
//
// WHAT CHANGED in v13 vs v12:
//  - Page + offline-db.js: fetched fresh from the network EVERY time with cache:"no-store"
//    (this bypasses the browser/host HTTP cache, which is what kept serving the old index.html).
//  - The saved copy is used ONLY if the network fails or takes longer than PAGE_TIMEOUT_MS.
//  - Question data files keep the "instant + refresh in background" behaviour (good for offline use),
//    but the background refresh now also bypasses the HTTP cache.
// v27: question files (questions-*.json) are now NETWORK-FIRST, so newly uploaded questions show
// up straight away — you never need to edit this file just to publish questions again.
const CACHE_NAME = "myutme-cache-v42";

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
// Question files are big, so give them a little longer before falling back to the saved copy.
const QUESTION_TIMEOUT_MS = 15000;

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

// like freshFetch, but lets the browser reuse its copy when the server says "not modified"
function revalidateFetch(request, timeoutMs = FETCH_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Network request timed out")), timeoutMs);
    fetch(request, { cache: "no-cache" }).then(
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
    /^\/?(questions|notes)-[^/]+\.json$/.test(url.pathname) ||
    url.pathname.endsWith("questions-seed.json");

  const isAppScript = url.pathname.endsWith(".js") && /offline-db/.test(url.pathname);

  // INSTANT OPEN: the app page (any route like /, /account) and offline-db.js come straight from
  // the saved copy — no waiting on the network, so no loading bar on open and no hang without data.
  // New versions are downloaded quietly by the CHECK_UPDATE message below (page sends it at most
  // once every 24h, or when the refresh button is tapped) and are used on the next open.
  const isShellNav =
    (event.request.mode === "navigate" && !/\.[a-z0-9]+$/i.test(url.pathname)) ||
    url.pathname === "/" ||
    url.pathname.endsWith("/index.html");
  if (isShellNav || isAppScript) {
    const key = isShellNav ? "./index.html" : "./offline-db.js";
    event.respondWith(
      caches.match(key, { ignoreSearch: true }).then((cached) => {
        if (cached) return cached;
        return freshFetch(event.request, PAGE_TIMEOUT_MS).then((res) => {
          if (res && res.status === 200) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put(key, clone));
          }
          return res;
        }).catch(() => (isShellNav ? caches.match("./") : null).then((c) => c || Response.error()));
      })
    );
    return;
  }

  // Other pages (privacy.html, terms.html...): NETWORK FIRST. Saved copy only if offline/very slow.
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

  // Question data: NETWORK FIRST (always the newest file), saved copy only if offline / very slow.
  // The cache key ignores the ?v=timestamp the app adds, so only ONE copy per subject is kept
  // (before, every visit stored another ~900 KB copy under a new ?v= address).
  if (isQuestionDataFile) {
    const cacheKey = new Request(url.origin + url.pathname);
    event.respondWith(
      // Revalidate (ETag / 304) instead of re-downloading the whole file every time.
      revalidateFetch(cacheKey, QUESTION_TIMEOUT_MS)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const clone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(cacheKey, clone));
          }
          return networkResponse;
        })
        .catch(() => caches.match(cacheKey).then((cached) => cached || Response.error()))
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

// ---- Quiet update check (sent by the page: at most once per 24h, or on the refresh button) ----
async function refreshShell() {
  const urls = ["./index.html", "./offline-db.js", "./manifest.json"];
  const fetched = [];
  for (const u of urls) {
    const res = await revalidateFetch(new Request(u), 20000); // ETag check: tiny reply if unchanged
    if (!res || !res.ok) throw new Error("update check failed for " + u);
    fetched.push([u, res]);
  }
  const cache = await caches.open(CACHE_NAME);
  for (const [u, res] of fetched) {
    await cache.put(u, res.clone());
    if (u === "./index.html") await cache.put("./", res.clone());
  }
}

self.addEventListener("message", (event) => {
  if (!event.data || event.data.type !== "CHECK_UPDATE") return;
  const port = event.ports && event.ports[0];
  event.waitUntil(
    refreshShell().then(
      () => port && port.postMessage({ ok: true }),
      () => port && port.postMessage({ ok: false })
    )
  );
});

// ---- Push notifications (v14: News alerts open the news) ----
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: "MyUTME", body: event.data ? event.data.text() : "" };
  }
  // News alerts: open the news when tapped. Uses the link the server sends if any, otherwise
  // a news_id, otherwise (title starts with the newspaper emoji) opens the latest news.
  let openUrl = data.url || "/";
  if (!data.url && data.news_id) openUrl = "/?news=" + data.news_id;
  else if (!data.url && String(data.title || "").indexOf("\uD83D\uDCF0") === 0) openUrl = "/?news=latest";
  event.waitUntil(
    self.registration.showNotification(data.title || "MyUTME", {
      body: data.body || "",
      icon: "./icon-192.png",
      badge: "./icon-badge-96.png",
      tag: data.tag || "myutme-notification",
      data: openUrl,
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = event.notification.data || "/";

  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ("focus" in client) {
          // app already open: bring it forward and tell it where to go (no reload)
          client.postMessage({ type: "open-url", url: targetUrl });
          return client.focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(targetUrl);
    })
  );
});
