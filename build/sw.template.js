// Service worker: serves the app from Cache Storage so it works offline.
// The page itself downloads the files (to show progress) into the cache named below;
// see src/lib/offline.ts. Generated from build/sw.template.js.
const CACHE = "pdf-image-compress-__VERSION__";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.endsWith("/sw.js") || url.pathname.endsWith("/precache.json")) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      // Pages: network first, so a new deployment is picked up; the cached copy when offline.
      if (request.mode === "navigate") {
        try {
          return await fetch(request);
        } catch (err) {
          const page = await cache.match("./");
          if (page) return page;
          throw err;
        }
      }
      // Build assets have content hashes in their names: the cache is always right.
      return (await cache.match(request, { ignoreSearch: true })) ?? fetch(request);
    })(),
  );
});
