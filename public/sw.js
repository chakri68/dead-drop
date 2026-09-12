/**
 * Service worker. The app has to work with the network switched off — that is
 * the entire premise — so this caches everything it sees and serves from cache
 * first once it has it.
 *
 * Cache-first rather than stale-while-revalidate because a device in a field
 * with no signal shouldn't wait for a fetch to time out before rendering.
 */
const CACHE = "dead-drop-v1";
const CORE = ["/", "/index.html", "/manifest.webmanifest", "/favicon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  // Same-origin assets, the Google Fonts CSS/woff2 files, and the shared theme
  // tokens. Nothing else is fetched by this app, and nothing should be.
  const isTheme = url.hostname === "theme.chakri.me";
  const cacheable =
    url.origin === self.location.origin ||
    url.hostname === "fonts.googleapis.com" ||
    url.hostname === "fonts.gstatic.com" ||
    isTheme;
  if (!cacheable) return;

  event.respondWith(
    caches.match(request).then((hit) => {
      // The theme tokens are the one thing here that is edited at its source and
      // expected to reach every site without a redeploy. Cache-first would pin
      // whatever amber we saw the first time, forever. So: serve the cached copy
      // (instant, and correct with no signal at all) and refresh it in the
      // background, so the next load carries any theme edit.
      if (hit && isTheme) {
        event.waitUntil(
          fetch(request)
            .then((response) => {
              if (response.ok || response.type === "opaque") {
                return caches.open(CACHE).then((c) => c.put(request, response));
              }
            })
            .catch(() => {}),
        );
        return hit;
      }
      if (hit) return hit;
      return fetch(request)
        .then((response) => {
          if (response.ok || response.type === "opaque") {
            const copy = response.clone();
            void caches.open(CACHE).then((c) => c.put(request, copy));
          }
          return response;
        })
        .catch(async () => {
          // Offline and never cached: fall back to the shell for navigations.
          if (request.mode === "navigate") return (await caches.match("/index.html")) ?? Response.error();
          return Response.error();
        });
    }),
  );
});
