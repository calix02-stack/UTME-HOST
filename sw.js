/*! MyUTME service worker · enzo-ai
 * Fast install: the app shell is revalidated (tiny "not changed" reply) instead of
 * being force-downloaded again, so installing no longer waits on the 1.4 MB page.
 */

const CACHE_NAME = "myutme-cache-v91";

const APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./offline-db.js",
];

const FETCH_TIMEOUT_MS = 8000;
const PAGE_TIMEOUT_MS = 12000;
const QUESTION_TIMEOUT_MS = 15000;

function freshFetch(request, timeoutMs = FETCH_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
      reject(new Error("Network request timed out"));
    }, timeoutMs);

    fetch(request, {
      cache: "no-store",
      signal: controller.signal,
    }).then(
      (response) => {
        clearTimeout(timer);
        resolve(response);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function revalidateFetch(request, timeoutMs = FETCH_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
      reject(new Error("Network request timed out"));
    }, timeoutMs);

    fetch(request, {
      cache: "no-cache",
      signal: controller.signal,
    }).then(
      (response) => {
        clearTimeout(timer);
        resolve(response);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

// Install: the app shell MUST be saved before this worker takes over.
// If index.html or offline-db.js cannot be saved, installation fails and the
// previous worker (with its working offline cache) keeps running.
const REQUIRED_SHELL = ["./index.html", "./offline-db.js"];

async function cacheShellFile(cache, url) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // "no-cache" asks the server "has this changed?". If not, the reply is a tiny
      // 304 and the copy the browser just downloaded is reused, so install is quick.
      const response = await revalidateFetch(url, 20000);
      if (!response || !response.ok) throw new Error("Bad response for " + url);
      // A redirected response cannot be used to answer a page navigation.
      const clean = response.redirected
        ? new Response(await response.blob(), {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          })
        : response;
      await cache.put(url, clean);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

// Install is now FAST: only the tiny files are saved here, so the app can finish
// installing right away. The big app page (index.html) and offline-db.js are saved
// straight after the install (CHECK_UPDATE message) or on the first open, whichever
// comes first, so the home-screen app is ready quickly and the rest downloads after.
const FAST_SHELL = ["./manifest.json", "./icon-192.png", "./icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      await Promise.all(
        FAST_SHELL.map(async (url) => {
          try {
            await cacheShellFile(cache, url);
          } catch (error) {}
        })
      );
    })()
  );

  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.map((key) => (key !== CACHE_NAME ? caches.delete(key) : null))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  // The app installer file is never cached, so people always get the newest APK.
  if (url.pathname.endsWith(".apk")) return;

  const isAppShell =
    event.request.mode === "navigate" ||
    url.pathname.endsWith(".html") ||
    url.pathname === "/" ||
    url.pathname.endsWith("/");

  const isQuestionDataFile =
    /^\/?(questions|notes)-[^/]+\.json$/.test(url.pathname) ||
    url.pathname.endsWith("questions-seed.json");

  const isAppScript =
    url.pathname.endsWith(".js") && /offline-db/.test(url.pathname);

  const isShellNav =
    (event.request.mode === "navigate" &&
      !/\.[a-z0-9]+$/i.test(url.pathname)) ||
    url.pathname === "/" ||
    url.pathname.endsWith("/index.html");

  if (isShellNav || isAppScript) {
    const key = isShellNav ? "./index.html" : "./offline-db.js";

    event.respondWith(
      caches.match(key, { ignoreSearch: true }).then((cached) => {
        if (cached) return cached;

        return freshFetch(event.request, PAGE_TIMEOUT_MS)
          .then((response) => {
            if (response && response.status === 200) {
              const clone = response.clone();
              event.waitUntil(
                caches.open(CACHE_NAME).then((c) => c.put(key, clone))
              );
            }
            return response;
          })
          .catch(() =>
            caches
              .match("./index.html")
              .then((cachedPage) => cachedPage || Response.error())
          );
      })
    );
    return;
  }

  if (isAppShell || isAppScript) {
    event.respondWith(
      freshFetch(event.request, PAGE_TIMEOUT_MS)
        .then((response) => {
          if (response && response.status === 200) {
            const clone = response.clone();
            event.waitUntil(
              caches.open(CACHE_NAME).then((c) => c.put(event.request, clone))
            );
          }
          return response;
        })
        .catch(() =>
          caches
            .match(event.request, { ignoreSearch: isAppScript })
            .then((cached) => cached || Response.error())
        )
    );
    return;
  }

  if (isQuestionDataFile) {
    // Offline-first: answer instantly from the saved copy, refresh quietly in the background.
    const cacheKey = new Request(url.origin + url.pathname);

    event.respondWith(
      caches.match(cacheKey).then((cached) => {
        const refresh = revalidateFetch(cacheKey, QUESTION_TIMEOUT_MS)
          .then((response) => {
            if (response && response.status === 200) {
              const clone = response.clone();
              caches.open(CACHE_NAME).then((c) => c.put(cacheKey, clone));
            }
            return response;
          })
          .catch(() => null);

        if (cached) {
          event.waitUntil(refresh);
          return cached;
        }
        return refresh.then((response) => response || Response.error());
      })
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const fetchPromise = freshFetch(event.request)
        .then((response) => {
          if (response && response.status === 200) {
            const clone = response.clone();
            event.waitUntil(
              caches.open(CACHE_NAME).then((c) => c.put(event.request, clone))
            );
          }
          return response;
        })
        .catch(() => cached || Response.error());

      return cached || fetchPromise;
    })
  );
});

async function refreshShell() {
  const urls = ["./index.html", "./offline-db.js", "./manifest.json"];
  const fetched = [];

  for (const url of urls) {
    const response = await revalidateFetch(new Request(url), 20000);
    if (!response || !response.ok) {
      throw new Error("Update check failed for " + url);
    }
    fetched.push([url, response]);
  }

  const cache = await caches.open(CACHE_NAME);
  let changed = false;

  for (const [url, response] of fetched) {
    if (url === "./manifest.json") continue;

    try {
      const old = await cache.match(url);
      if (!old) {
        changed = true;
        continue;
      }

      const [a, b] = await Promise.all([
        old.clone().text(),
        response.clone().text(),
      ]);

      if (a !== b) changed = true;
    } catch (error) {}
  }

  for (const [url, response] of fetched) {
    await cache.put(url, response.clone());
    if (url === "./index.html") {
      await cache.put("./", response.clone());
    }
  }

  return changed;
}

self.addEventListener("message", (event) => {
  if (!event.data || event.data.type !== "CHECK_UPDATE") return;

  const port = event.ports && event.ports[0];

  event.waitUntil(
    refreshShell().then(
      (changed) => port && port.postMessage({ ok: true, changed: !!changed }),
      () => port && port.postMessage({ ok: false })
    )
  );
});

self.addEventListener("push", (event) => {
  let data = {};

  try {
    data = event.data ? event.data.json() : {};
  } catch (error) {
    data = {
      title: "MyUTME",
      body: event.data ? event.data.text() : "",
    };
  }

  let openUrl = data.url || "/";
  if (!data.url && data.news_id) {
    openUrl = "/?news=" + data.news_id;
  } else if (
    !data.url &&
    String(data.title || "").indexOf("\uD83D\uDCF0") === 0
  ) {
    openUrl = "/?news=latest";
  }

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
    clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clientList) => {
        for (const client of clientList) {
          if ("focus" in client) {
            client.postMessage({ type: "open-url", url: targetUrl });
            return client.focus();
          }
        }

        if (clients.openWindow) return clients.openWindow(targetUrl);
      })
  );
});
