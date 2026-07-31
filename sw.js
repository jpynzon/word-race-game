/**
 * Service worker: offline support, without holding the app hostage to a stale cache.
 *
 * The previous revision was cache-first for everything, which is the wrong
 * strategy for an app that ships changes. Once a document was cached, every
 * later visit was served the old shell and updates never arrived — and because
 * its precache list named a file that had been deleted, `addAll` rejected and
 * the install failed outright, leaving whatever was already cached in place
 * permanently.
 *
 * So: network-first for anything that is code or markup, cache-first only for
 * genuinely immutable assets. The cache exists to make the game playable
 * offline, not to decide which version you run.
 */

const CACHE_NAME = "word-race-v3";

/**
 * Precached so a cold offline start works. Deliberately excludes third-party
 * URLs (fonts, PeerJS): a cross-origin failure inside addAll would reject the
 * whole install, which is exactly the trap the previous version fell into.
 */
const APP_SHELL = [
  "./",
  "./index.html",
  "./play.html",
  "./manifest.webmanifest",
  "./css/reset.css",
  "./css/variables.css",
  "./css/layout.css",
  "./css/components.css",
  "./css/animations.css",
  "./js/home.js",
  "./js/play.js",
  "./js/constants.js",
  "./js/state.js",
  "./js/router.js",
  "./js/profile.js",
  "./js/messages.js",
  "./assets/favicon.svg",
  "./assets/wordlist.txt",
];

/** Paths that never change meaningfully, so the cache may answer first. */
const IMMUTABLE = [/\/assets\//, /\.woff2?$/];

const isImmutable = (url) => IMMUTABLE.some((pattern) => pattern.test(url.pathname));

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      // Added one at a time: a single 404 must not sink the whole install.
      await Promise.allSettled(APP_SHELL.map((path) => cache.add(path)));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Immutable assets: cache first, since there is nothing to be stale about.
  if (isImmutable(url)) {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ??
          fetch(request).then((response) => {
            if (response.ok) {
              const clone = response.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
            }
            return response;
          }),
      ),
    );
    return;
  }

  /* Everything else — documents, modules, stylesheets — comes from the network
     when the network is there, and the cache is refreshed behind it. Offline
     falls back to the cache, then to the landing page for a navigation so a
     cold start still shows something rather than a browser error. */
  event.respondWith(
    (async () => {
      try {
        const response = await fetch(request);
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        }
        return response;
      } catch {
        const cached = await caches.match(request);
        if (cached) return cached;
        if (request.mode === "navigate") {
          const shell = await caches.match("./index.html");
          if (shell) return shell;
        }
        throw new Error("offline and uncached");
      }
    })(),
  );
});
