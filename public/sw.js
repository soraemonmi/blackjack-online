const CACHE = "bj-online-v6";
const STATIC_ASSETS = ["/", "/index.html", "/style.css", "/client.js", "/manifest.webmanifest"];
const MEDIA_ASSETS = ["/bgm.mp3"];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll([...STATIC_ASSETS, ...MEDIA_ASSETS])));
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  if (event.request.headers.get("upgrade") === "websocket") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  // Always prefer the network for app code so GitHub/Render updates are visible immediately.
  if (["document", "script", "style"].includes(event.request.destination)) {
    event.respondWith(
      fetch(event.request, { cache: "no-store" })
        .then(response => {
          const copy = response.clone();
          caches.open(CACHE).then(cache => cache.put(event.request, copy));
          return response;
        })
        .catch(() => caches.match(event.request).then(cached => cached || caches.match("/index.html")))
    );
    return;
  }

  // BGM and other static assets can use cache-first.
  event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request)));
});
