/*! MyUTME service worker · enzo-ai

* Installation timeout optimization
  */

const CACHE_NAME = "myutme-cache-v82";

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

// Install fast: only the small files are awaited. The big files
// (index.html, offline-db.js) are fetched with no abort timer, using the
// normal HTTP cache so a page that was just downloaded is not downloaded
// twice. Install never waits more than a few seconds for them; anything not
// finished is cached by the fetch handler on first use.
const SMALL_SHELL = ["./manifest.json", "./icon-192.png", "./icon-512.png"];
const BIG_SHELL = ["./", "./index.html", "./offline-db.js"];

async function cacheOne(cache, url, mode) {
try {
const response = await fetch(url, { cache: mode });
if (response && response.ok) await cache.put(url, response);
} catch (error) {
// Continue when a file is unavailable.
}
}

self.addEventListener("install", (event) => {
self.skipWaiting();
event.waitUntil(
(async () => {
const cache = await caches.open(CACHE_NAME);
const small = Promise.all(SMALL_SHELL.map((u) => cacheOne(cache, u, "reload")));
const big = Promise.all(BIG_SHELL.map((u) => cacheOne(cache, u, "default")));
await small;
await Promise.race([big, new Promise((r) => setTimeout(r, 4000))]);
})()
);
});

// Look in the current cache first, then fall back to any older cache.
// (caches.match() alone searches the OLDEST cache first, which would keep
// serving an old index.html forever once old caches are no longer deleted.)
async function matchCurrent(request, options) {
try {
const cache = await caches.open(CACHE_NAME);
const hit = await cache.match(request, options);
if (hit) return hit;
} catch (error) {}
return caches.match(request, options);
}

// Old caches are only removed once the new cache holds the page,
// so a slow first download never leaves the app with nothing cached.
async function cleanOldCaches() {
const cache = await caches.open(CACHE_NAME);
const ready = await cache.match("./index.html");
if (!ready) return;
const keys = await caches.keys();
await Promise.all(keys.map((key) => (key !== CACHE_NAME ? caches.delete(key) : null)));
}

self.addEventListener("activate", (event) => {
event.waitUntil(self.clients.claim());
event.waitUntil(cleanOldCaches().catch(() => {}));
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

const isAppScript =
url.pathname.endsWith(".js") &&
/offline-db/.test(url.pathname);

const isShellNav =
(event.request.mode === "navigate" &&
!/\.[a-z0-9]+$/i.test(url.pathname)) ||
url.pathname === "/" ||
url.pathname.endsWith("/index.html");

if (isShellNav || isAppScript) {
const key = isShellNav ? "./index.html" : "./offline-db.js";

event.respondWith(
  matchCurrent(key, { ignoreSearch: true }).then((cached) => {
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
        matchCurrent("./index.html").then(
          (cachedPage) => cachedPage || Response.error()
        )
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
caches.open(CACHE_NAME).then((c) =>
c.put(event.request, clone)
)
);
}
return response;
})
.catch(() =>
matchCurrent(event.request, {
ignoreSearch: isAppScript,
}).then((cached) => cached || Response.error())
)
);
return;
}

if (isQuestionDataFile) {
const cacheKey = new Request(url.origin + url.pathname);

event.respondWith(
  revalidateFetch(cacheKey, QUESTION_TIMEOUT_MS)
    .then((response) => {
      if (response && response.status === 200) {
        const clone = response.clone();
        event.waitUntil(
          caches.open(CACHE_NAME).then((c) =>
            c.put(cacheKey, clone)
          )
        );
        return response;
      }

      return matchCurrent(cacheKey).then(
        (cached) => cached || response
      );
    })
    .catch(() =>
      matchCurrent(cacheKey).then(
        (cached) => cached || Response.error()
      )
    )
);
return;

}

event.respondWith(
matchCurrent(event.request).then((cached) => {
const fetchPromise = freshFetch(event.request)
.then((response) => {
if (response && response.status === 200) {
const clone = response.clone();
event.waitUntil(
caches.open(CACHE_NAME).then((c) =>
c.put(event.request, clone)
)
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

try { await cleanOldCaches(); } catch (error) {}
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
clients.matchAll({ type: "window", includeUncontrolled: true })
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