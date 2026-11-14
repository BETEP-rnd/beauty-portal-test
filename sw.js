const CACHE = "mf-v202611142350";
const BASE = new URL("./", self.location).href;
const CORE = [
  "", "index.html", "auth/", "booking/", "cabinet/", "certs/", "clients/", "price/", "schedule/", "windows/",
  "offline.html", "manifest.webmanifest",
  "kit/kit.css", "kit/kit.js", "kit/pwa.js", "kit/backgrounds.js", "kit/trends.js",
  "kit/grain.svg", "kit/paper-leaves.png", "kit/herbs-light.svg", "kit/herbs-dark.svg",
  "icons/icon.svg", "icons/icon-192.png", "icons/icon-512.png", "icons/icon-maskable-512.png", "icons/apple-touch-icon.png"
].map(path => new URL(path, BASE).href);

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname.includes("/api/")) return;

  if (request.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (response && response.ok) {
          const cache = await caches.open(CACHE);
          cache.put(request, response.clone());
        }
        return response;
      } catch (error) {
        return (await caches.match(request, { ignoreSearch: true })) ||
          (await caches.match(new URL("offline.html", BASE).href)) ||
          Response.error();
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cached = await caches.match(request, { ignoreSearch: true });
    const network = fetch(request).then(response => {
      if (response && response.ok) {
        caches.open(CACHE).then(cache => cache.put(request, response.clone()));
      }
      return response;
    }).catch(() => cached);
    if (cached) {
      event.waitUntil(network);
      return cached;
    }
    return network;
  })());
});
