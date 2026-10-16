/* MyUTME Service Worker */

const CACHE_NAME = "myutme-cache-v83";

const APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./offline-db.js"
];

const SMALL_SHELL = [
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png"
];

const BIG_SHELL = [
  "./",
  "./index.html",
  "./offline-db.js"
];

const FETCH_TIMEOUT_MS = 8000;
const PAGE_TIMEOUT_MS = 12000;
const QUESTION_TIMEOUT_MS = 15000;

/* Network request with timeout */
function timedFetch(request, timeoutMs = FETCH_TIMEOUT_MS, cacheMode = "no-store") {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();

    const timer = setTimeout(() => {
      controller.abort();
      reject(new Error("Network request timed out"));
    }, timeoutMs);

    fetch(request, {
      cache: cacheMode,
      signal: controller.signal
    }).then(
      response => {
        clearTimeout(timer);
        resolve(response);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

/* Fetch and cache a single file */
async function cacheOne(cache, url, mode = "default") {
  try {
    const response = await fetch(url, { cache: mode });

    if (response && response.ok) {
      await cache.put(url, response);
    }
  } catch (error) {
    // Continue if a file cannot be downloaded.
  }
}

/* Check whether the new cache contains essential files */
async function newShellIsReady() {
  try {
    const cache = await caches.open(CACHE_NAME);

    const index = await cache.match("./index.html");
    const database = await cache.match("./offline-db.js");

    return !!(index && database);
  } catch (error) {
    return false;
  }
}

/* Remove old caches only after the new shell is ready */
async function cleanOldCaches() {
  if (!(await newShellIsReady())) return;

  const keys = await caches.keys();

  await Promise.all(
    keys
      .filter(key => key.startsWith("myutme-cache-") && key !== CACHE_NAME)
      .map(key => caches.delete(key))
  );
}

/* Search current cache first, then retained older caches */
async function getCachedFile(request, options = {}) {
  const currentCache = await caches.open(CACHE_NAME);

  let response = await currentCache.match(request, options);

  if (response) return response;

  const keys = await caches.keys();

  for (const key of keys) {
    if (key === CACHE_NAME) continue;

    const oldCache = await caches.open(key);
    response = await oldCache.match(request, options);

    if (response) return response;
  }

  return undefined;
}

/* INSTALL */
self.addEventListener("install", event => {
  self.skipWaiting();

  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);

      // Download small files first.
      await Promise.all(
        SMALL_SHELL.map(url => cacheOne(cache, url, "reload"))
      );

      // Start downloading large files without blocking installation for long.
      const bigFiles = Promise.all(
        BIG_SHELL.map(url => cacheOne(cache, url, "default"))
      );

      await Promise.race([
        bigFiles,
        new Promise(resolve => setTimeout(resolve, 4000))
      ]);
    })()
  );
});

/* ACTIVATE */
self.addEventListener("activate", event => {
  event.waitUntil(
    (async () => {
      // Do not delete old caches before the new shell is ready.
      await self.clients.claim();

      // Clean up only if essential files are present.
      await cleanOldCaches();
    })()
  );
});

/* FETCH */
self.addEventListener("fetch", event => {
  const request = event.request;

  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // Do not intercept requests to external websites.
  if (url.origin !== self.location.origin) return;

  const isQuestionDataFile =
    /^\/?(questions|notes)-[^/]+\.json$/.test(url.pathname) ||
    url.pathname.endsWith("questions-seed.json");

  const isAppScript =
    url.pathname.endsWith(".js") &&
    /offline-db/.test(url.pathname);

  const isShellNav =
    (
      request.mode === "navigate" &&
      !/\.[a-z0-9]+$/i.test(url.pathname)
    ) ||
    url.pathname === "/" ||
    url.pathname.endsWith("/index.html");

  /* Main app page and offline database */
  if (isShellNav || isAppScript) {
    event.respondWith(
      (async () => {
        const key = isShellNav
          ? "./index.html"
          : "./offline-db.js";

        const cached = await getCachedFile(key);

        if (cached) {
          // Refresh the cache in the background.
          event.waitUntil(
            timedFetch(request, PAGE_TIMEOUT_MS)
              .then(async response => {
                if (response && response.status === 200) {
                  const cache = await caches.open(CACHE_NAME);
                  await cache.put(key, response.clone());
                  await cleanOldCaches();
                }
              })
              .catch(() => {})
          );

          return cached;
        }

        try {
          const response = await timedFetch(
            request,
            PAGE_TIMEOUT_MS
          );

          if (response && response.status === 200) {
            const cache = await caches.open(CACHE_NAME);
            await cache.put(key, response.clone());

            if (isShellNav) {
              await cache.put("./", response.clone());
            }

            event.waitUntil(cleanOldCaches());
          }

          return response;
        } catch (error) {
          const offlinePage = await getCachedFile("./index.html");

          return offlinePage || Response.error();
        }
      })()
    );

    return;
  }

  /* Question and notes JSON files */
  if (isQuestionDataFile) {
    const cacheKey = new Request(url.origin + url.pathname);

    event.respondWith(
      (async () => {
        const cached = await getCachedFile(cacheKey);

        try {
          const response = await timedFetch(
            cacheKey,
            QUESTION_TIMEOUT_MS,
            "no-cache"
          );

          if (response && response.status === 200) {
            const cache = await caches.open(CACHE_NAME);

            event.waitUntil(
              cache.put(cacheKey, response.clone())
            );

            return response;
          }

          return cached || response;
        } catch (error) {
          return cached || Response.error();
        }
      })()
    );

    return;
  }

  /* Other same-origin resources */
  event.respondWith(
    (async () => {
      const cached = await getCachedFile(request);

      if (cached) {
        // Return cached content immediately and refresh it in the background.
        event.waitUntil(
          timedFetch(request)
            .then(async response => {
              if (response && response.status === 200) {
                const cache = await caches.open(CACHE_NAME);
                await cache.put(request, response.clone());
              }
            })
            .catch(() => {})
        );

        return cached;
      }

      try {
        const response = await timedFetch(request);

        if (response && response.status === 200) {
          const cache = await caches.open(CACHE_NAME);

          event.waitUntil(
            cache.put(request, response.clone())
          );
        }

        return response;
      } catch (error) {
        return Response.error();
      }
    })()
  );
});

/* Refresh app files when the website requests an update check */
async function refreshShell() {
  const urls = [
    "./index.html",
    "./offline-db.js",
    "./manifest.json"
  ];

  const fetched = [];

  for (const url of urls) {
    const response = await timedFetch(
      new Request(url),
      20000,
      "no-cache"
    );

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
      const old = await getCachedFile(url);

      if (!old) {
        changed = true;
        continue;
      }

      const [oldText, newText] = await Promise.all([
        old.clone().text(),
        response.clone().text()
      ]);

      if (oldText !== newText) changed = true;
    } catch (error) {
      changed = true;
    }
  }

  for (const [url, response] of fetched) {
    await cache.put(url, response.clone());

    if (url === "./index.html") {
      await cache.put("./", response.clone());
    }
  }

  await cleanOldCaches();

  return changed;
}

/* Update-check messages */
self.addEventListener("message", event => {
  if (!event.data || event.data.type !== "CHECK_UPDATE") return;

  const port = event.ports && event.ports[0];

  event.waitUntil(
    refreshShell().then(
      changed => {
        if (port) {
          port.postMessage({
            ok: true,
            changed: !!changed
          });
        }
      },
      () => {
        if (port) {
          port.postMessage({ ok: false });
        }
      }
    )
  );
});

/* Push notifications */
self.addEventListener("push", event => {
  let data = {};

  try {
    data = event.data ? event.data.json() : {};
  } catch (error) {
    data = {
      title: "MyUTME",
      body: event.data ? event.data.text() : ""
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
    self.registration.showNotification(
      data.title || "MyUTME",
      {
        body: data.body || "",
        icon: "./icon-192.png",
        badge: "./icon-badge-96.png",
        tag: data.tag || "myutme-notification",
        data: openUrl
      }
    )
  );
});

/* Notification click */
self.addEventListener("notificationclick", event => {
  event.notification.close();

  const targetUrl = event.notification.data || "/";

  event.waitUntil(
    clients.matchAll({
      type: "window",
      includeUncontrolled: true
    }).then(clientList => {
      for (const client of clientList) {
        if ("focus" in client) {
          client.postMessage({
            type: "open-url",
            url: targetUrl
          });

          return client.focus();
        }
      }

      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});