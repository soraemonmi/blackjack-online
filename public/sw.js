const CACHE = "bj-online-v4";
const ASSETS = ["/", "/index.html", "/style.css", "/client.js", "/manifest.webmanifest", "/bgm.mp3"];
self.addEventListener("install", e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS))));
self.addEventListener("activate", e => e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))));
self.addEventListener("fetch", e => { if (e.request.headers.get("upgrade") === "websocket") return; e.respondWith(caches.match(e.request).then(r => r || fetch(e.request))); });
