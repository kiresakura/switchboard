// Switchboard Service Worker
// 2026-05-21 v2:bump cache name → 強制 evict v1 stale chunks。
// 舊版對 /_next/static/* 走 cache-first 在 dev 會把舊 chunk hash 黏死,大改後
// 瀏覽器一直拿不到新 chunk factory → "module factory not available" 錯誤。
// 新註冊時 activate handler 會刪除非當前 CACHE_NAME 的所有 cache,自然清乾淨。
const CACHE_NAME = "bbcs-v2";
const OFFLINE_URL = "/offline";

// Assets to precache on install
const PRECACHE_ASSETS = [
  "/",
  "/offline",
  "/favicon.svg",
  "/manifest.json",
];

// Install: precache core assets
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(PRECACHE_ASSETS).catch(() => {
        // Some assets may fail in dev, continue anyway
      });
    })
  );
  self.skipWaiting();
});

// Activate: clean old caches
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

// Fetch strategy: Network-first for API/navigation, Cache-first for static assets
self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET, cross-origin, and SSE/WebSocket requests
  if (
    request.method !== "GET" ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith("/api/realtime") ||
    url.pathname.startsWith("/api/ws")
  ) {
    return;
  }

  // API requests: network-only (don't cache stale data)
  if (url.pathname.startsWith("/api/")) {
    return;
  }

  // Static assets (JS, CSS, images): cache-first
  if (
    url.pathname.match(/\.(js|css|png|jpg|jpeg|svg|ico|woff2?)$/) ||
    url.pathname.startsWith("/_next/static/")
  ) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        });
      })
    );
    return;
  }

  // Navigation: network-first with offline fallback
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(() => {
        return caches.match(OFFLINE_URL).then((cached) => {
          return cached || new Response("離線中 - 請檢查網路連線", {
            status: 503,
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        });
      })
    );
    return;
  }

  // Default: network-first
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        }
        return response;
      })
      .catch(() => caches.match(request))
  );
});

// Push notifications
self.addEventListener("push", (event) => {
  if (!event.data) return;

  let data;
  try {
    data = event.data.json();
  } catch {
    data = { title: "Switchboard 通知", body: event.data.text() };
  }

  const options = {
    body: data.body || "",
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    tag: data.tag || "switchboard-notification",
    data: {
      url: data.url || "/",
    },
    actions: data.actions || [],
    requireInteraction: data.requireInteraction || false,
  };

  event.waitUntil(self.registration.showNotification(data.title || "Switchboard", options));
});

// Notification click: open the relevant page
self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const url = event.notification.data?.url || "/";

  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clients) => {
        // Focus existing window if available
        for (const client of clients) {
          if (client.url.includes(self.location.origin) && "focus" in client) {
            client.navigate(url);
            return client.focus();
          }
        }
        // Otherwise open new window
        return self.clients.openWindow(url);
      })
  );
});
