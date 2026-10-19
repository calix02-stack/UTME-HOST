/* MyUTME Service Worker — Fast Installation + Offline CBT */

"use strict";

const CACHE_NAME = "myutme-cache-v87";

const APP_SHELL = [
    "./index.html",
    "./offline-db.js"
];

const OPTIONAL_FILES = [
    "./manifest.json",
    "./icon-192.png",
    "./icon-512.png"
];

const INSTALL_TIMEOUT = 15000;
const NAVIGATION_TIMEOUT = 4000;
const QUESTION_TIMEOUT = 8000;

const BASE_URL = self.registration.scope;

function absoluteURL(path) {
    return new URL(path, BASE_URL).href;
}

async function fetchWithTimeout(request, timeout) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
        return await fetch(request, {
            cache: "no-store",
            signal: controller.signal
        });
    } finally {
        clearTimeout(timer);
    }
}

async function cacheFile(cache, path, timeout = INSTALL_TIMEOUT) {
    const url = absoluteURL(path);

    const response = await fetchWithTimeout(url, timeout);

    if (!response.ok) {
        throw new Error("Failed to cache " + path);
    }

    await cache.put(url, response.clone());
}

self.addEventListener("install", event => {
    event.waitUntil((async () => {
        const cache = await caches.open(CACHE_NAME);

        /*
         * Fetch essential files simultaneously.
         * No duplicate "./" request and no repeated retries.
         */
        await Promise.all(
            APP_SHELL.map(path => cacheFile(cache, path))
        );

        /*
         * Icons and manifest are optional for offline operation.
         * Their failure must not block installation.
         */
        await Promise.allSettled(
            OPTIONAL_FILES.map(path =>
                cacheFile(cache, path, 5000)
            )
        );

        await self.skipWaiting();
    })());
});

self.addEventListener("activate", event => {
    event.waitUntil((async () => {
        const keys = await caches.keys();

        await Promise.all(
            keys
                .filter(key =>
                    key.startsWith("myutme-cache-") &&
                    key !== CACHE_NAME
                )
                .map(key => caches.delete(key))
        );

        await self.clients.claim();
    })());
});

async function cachedFallback(request, fallbackPath) {
    const cache = await caches.open(CACHE_NAME);

    const cached = await cache.match(request);

    if (cached) return cached;

    if (fallbackPath) {
        const fallback = await cache.match(
            absoluteURL(fallbackPath)
        );

        if (fallback) return fallback;
    }

    return null;
}

async function handleNavigation(request) {
    try {
        const response = await fetchWithTimeout(
            request,
            NAVIGATION_TIMEOUT
        );

        if (response.ok) {
            const cache = await caches.open(CACHE_NAME);

            await cache.put(
                absoluteURL("./index.html"),
                response.clone()
            );
        }

        return response;
    } catch (error) {
        const fallback = await cachedFallback(
            request,
            "./index.html"
        );

        if (fallback) return fallback;

        return new Response(
            "MyUTME is unavailable offline. Please reconnect and reload.",
            {
                status: 503,
                headers: {
                    "Content-Type": "text/plain; charset=utf-8"
                }
            }
        );
    }
}

async function handleQuestionFile(request) {
    try {
        const response = await fetchWithTimeout(
            request,
            QUESTION_TIMEOUT
        );

        if (response.ok) {
            const cache = await caches.open(CACHE_NAME);

            await cache.put(request, response.clone());
        }

        return response;
    } catch (error) {
        const cached = await cachedFallback(request);

        if (cached) return cached;

        return new Response(
            JSON.stringify({
                error: "Question file unavailable offline."
            }),
            {
                status: 503,
                headers: {
                    "Content-Type": "application/json"
                }
            }
        );
    }
}

self.addEventListener("fetch", event => {
    const request = event.request;

    if (request.method !== "GET") return;

    const url = new URL(request.url);

    // Do not intercept requests to Supabase or other external services.
    if (url.origin !== self.location.origin) return;

    if (request.mode === "navigate") {
        event.respondWith(handleNavigation(request));
        return;
    }

    const pathname = url.pathname.toLowerCase();

    // Question files: network first, with offline cache fallback.
    if (pathname.endsWith(".json")) {
        event.respondWith(handleQuestionFile(request));
        return;
    }

    // App shell scripts and manifest: cache first.
    if (
        pathname.endsWith("/offline-db.js") ||
        pathname.endsWith("/manifest.json") ||
        pathname.endsWith("/icon-192.png") ||
        pathname.endsWith("/icon-512.png")
    ) {
        event.respondWith((async () => {
            const cached = await caches.match(request);

            if (cached) return cached;

            try {
                const response = await fetch(request);

                if (response.ok) {
                    const cache = await caches.open(CACHE_NAME);
                    await cache.put(request, response.clone());
                }

                return response;
            } catch (error) {
                return new Response("File unavailable offline.", {
                    status: 503
                });
            }
        })());
    }
});