/* MyUTME service worker — fast, upgrade-safe install
 * Keeps offline question fetching and push notifications.
 */
'use strict';

const CACHE_NAME = 'myutme-cache-v94';
const CACHE_PREFIX = 'myutme-cache-';

const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './offline-db.js'
];

const REQUIRED_SHELL = ['./index.html', './offline-db.js'];
const INSTALL_FETCH_TIMEOUT_MS = 15000;
const FETCH_TIMEOUT_MS = 8000;
const PAGE_TIMEOUT_MS = 12000;
const QUESTION_TIMEOUT_MS = 15000;

function absolute(url) {
  return new URL(url, self.registration.scope).href;
}

function timedFetch(request, timeoutMs, cacheMode) {
  // A timeout of 0 means do not abort the request. Cached file writes use
  // fetchAndStore so its timeout stays active until the response is stored.
  if (!timeoutMs || timeoutMs <= 0) {
    return fetch(request, { cache: cacheMode || 'no-store' });
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  return fetch(request, {
    cache: cacheMode || 'no-store',
    signal: controller.signal
  }).finally(() => clearTimeout(timer));
}

async function getOldCacheNames() {
  const keys = await caches.keys();

  return keys.filter(name =>
    name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME
  );
}

async function findPreviousResponse(url) {
  const target = absolute(url);
  const names = await getOldCacheNames();

  for (const name of names) {
    const cache = await caches.open(name);
    const response = await cache.match(target);

    if (response) return response;
  }

  return null;
}

async function seedFromPreviousCache(newCache, url) {
  const previous = await findPreviousResponse(url);

  if (!previous) return false;

  await newCache.put(absolute(url), previous.clone());
  return true;
}

async function fetchAndStore(cache, url, timeoutMs) {
  const target = absolute(url);
  const controller = timeoutMs > 0 ? new AbortController() : null;
  let timer = null;

  const storeResponse = async () => {
    const response = await fetch(target, {
      cache: 'no-store',
      ...(controller ? { signal: controller.signal } : {})
    });

    if (!response || !response.ok) {
      throw new Error('HTTP error for ' + url);
    }

    await cache.put(target, response.clone());
    return response;
  };

  if (!controller) return storeResponse();

  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('Timed out fetching ' + url));
    }, timeoutMs);
  });

  try {
    return await Promise.race([storeResponse(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/*
 * Fast installation:
 * Reuse cached files from the previous MyUTME version.
 * Only download required files that are missing.
 */
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);

    // Installation is deliberately limited to the app shell. Never download
    // subject/question JSON files, icons, or other optional assets here.
    // Reuse cached shell files from the previous version whenever possible.
    // A slow or failed fetch must not block Chrome's install prompt indefinitely;
    // normal online navigation can populate any shell files that were skipped.
    await Promise.all(REQUIRED_SHELL.map(async url => {
      try {
        if (await cache.match(absolute(url))) return;
        if (await seedFromPreviousCache(cache, url)) return;
        await fetchAndStore(cache, url, INSTALL_FETCH_TIMEOUT_MS);
      } catch (error) {
        console.warn('MyUTME: app shell cache deferred during install', url, error);
      }
    }));

    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    // Delete only previous MyUTME caches.
    const keys = await caches.keys();

    await Promise.all(
      keys.map(name => {
        if (
          name.startsWith(CACHE_PREFIX) &&
          name !== CACHE_NAME
        ) {
          return caches.delete(name);
        }
      })
    );

    await self.clients.claim();
  })());
});

async function networkThenCache(request, timeoutMs, cacheUrl) {
  const cache = await caches.open(CACHE_NAME);

  try {
    const response = await timedFetch(
      request,
      timeoutMs,
      'no-store'
    );

    if (response && response.ok) {
      await cache.put(
        cacheUrl || request,
        response.clone()
      );
    }

    return response;
  } catch (error) {
    const cached = await cache.match(cacheUrl || request);

    if (cached) return cached;

    throw error;
  }
}

self.addEventListener('fetch', event => {
  const request = event.request;

  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  if (url.origin !== self.location.origin) return;

  const pathname = url.pathname;

  const isQuestionFile =
    /\.json$/i.test(pathname) &&
    /(eng|phy|chm|bio|math|lit|gov|eco|crs|irs|commerce|account|agric|geog|history|subject|question|topic)/i.test(pathname);

  // Navigation: open cached app immediately when available.
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);

      const cached = await cache.match(
        absolute('./index.html')
      );

      if (cached) {
        event.waitUntil((async () => {
          try {
            const fresh = await timedFetch(
              request,
              PAGE_TIMEOUT_MS,
              'no-store'
            );

            if (fresh && fresh.ok) {
              await cache.put(
                absolute('./index.html'),
                fresh.clone()
              );
            }
          } catch (_) {}
        })());

        return cached;
      }

      return networkThenCache(
        request,
        PAGE_TIMEOUT_MS,
        absolute('./index.html')
      );
    })());

    return;
  }

  // Question JSON is never prefetched or cached by the service worker.
  // The app requests only the selected subject when the student starts a CBT.
  // Let that request pass directly to the network; no bulk downloads during install/startup.
  if (isQuestionFile) return;

  // Core app files: return cached versions immediately.
  if (
    /\/(?:index\.html|offline-db\.js|manifest\.json|icon-192\.png|icon-512\.png)$/.test(pathname)
  ) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(request);

      if (cached) {
        event.waitUntil((async () => {
          try {
            const fresh = await timedFetch(
              request,
              FETCH_TIMEOUT_MS,
              'no-store'
            );

            if (fresh && fresh.ok) {
              await cache.put(request, fresh.clone());
            }
          } catch (_) {}
        })());

        return cached;
      }

      return networkThenCache(
        request,
        FETCH_TIMEOUT_MS,
        request
      );
    })());

    return;
  }

  // Other same-origin GET requests.
  event.respondWith(
    networkThenCache(request, FETCH_TIMEOUT_MS, request)
  );
});

/* Manual update check used by the app. */
async function refreshShell() {
  const cache = await caches.open(CACHE_NAME);

  const urls = [
    './index.html',
    './offline-db.js',
    './manifest.json'
  ];

  return Promise.allSettled(
    urls.map(async url => {
      try {
        return await fetchAndStore(cache, url, 5000);
      } catch (_) {
        // Keep the existing cached copy if refreshing fails.
        return null;
      }
    })
  );
}

self.addEventListener('message', event => {
  const data = event.data || {};

  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  } else if (data.type === 'CHECK_UPDATE') {
    event.waitUntil(refreshShell());
  }
});

/* Push notifications */
self.addEventListener('push', event => {
  let payload = {};

  try {
    payload = event.data ? event.data.json() : {};
  } catch (_) {
    payload = {
      body: event.data ? event.data.text() : ''
    };
  }

  const title = payload.title || 'MyUTME';

  const options = {
    body: payload.body || 'You have a new update from MyUTME.',
    icon: './icon-192.png',
    badge: './icon-192.png',

    data: {
      url: payload.url || (payload.data && payload.data.url) || './'
    },

    tag: payload.tag || 'myutme-notification',
    renotify: Boolean(payload.renotify)
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();

  const target =
    event.notification.data && event.notification.data.url
      ? event.notification.data.url
      : './';

  event.waitUntil((async () => {
    const targetUrl = new URL(
      target,
      self.registration.scope
    ).href;

    const windows = await self.clients.matchAll({
      type: 'window',
      includeUncontrolled: true
    });

    for (const client of windows) {
      if (
        client.url.startsWith(self.registration.scope) &&
        'focus' in client
      ) {
        try {
          if (client.navigate) {
            await client.navigate(targetUrl);
          }
        } catch (_) {}

        return client.focus();
      }
    }

    if (self.clients.openWindow) {
      return self.clients.openWindow(targetUrl);
    }
  })());
});