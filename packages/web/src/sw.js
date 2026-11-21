/* phone-code service worker.
 *
 * - App shell (index + hashed assets) is precached, so launch is instant and
 *   works offline; navigations are served cache-first and refreshed in the
 *   background (stale-while-revalidate), hashed assets are immutable.
 * - /api and /ws are never cached or intercepted.
 * - Web Push: shows the daemon's notification; tapping it opens the session.
 *
 * The build replaces self.__SHELL__ and self.__BUILD__ (see vite.config.ts).
 */

const SHELL = self.__SHELL__;
const BUILD = self.__BUILD__;
const CACHE = `phone-code-${BUILD}`;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL.filter((u) => !u.endsWith('sw.js'))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k.startsWith('phone-code-') && k !== CACHE).map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

const bypass = (url) =>
  url.origin !== self.location.origin ||
  url.pathname.startsWith('/api') ||
  url.pathname.startsWith('/ws') ||
  url.pathname === '/manifest.webmanifest' ||
  url.pathname === '/sw.js';

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (bypass(url)) return;

  if (req.mode === 'navigate') {
    // App shell: instant from cache, refreshed in the background.
    event.respondWith(
      caches.open(CACHE).then(async (cache) => {
        const cached = await cache.match('/');
        const network = fetch(req)
          .then((res) => {
            if (res.ok) void cache.put('/', res.clone());
            return res;
          })
          .catch(() => cached);
        return cached ?? network;
      }),
    );
    return;
  }

  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.open(CACHE).then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) void cache.put(req, res.clone());
        return res;
      }),
    );
    return;
  }

  // Icons and other static files: stale-while-revalidate.
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const hit = await cache.match(req);
      const net = fetch(req)
        .then((res) => {
          if (res.ok) void cache.put(req, res.clone());
          return res;
        })
        .catch(() => hit);
      return hit ?? net;
    }),
  );
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'phone-code', body: event.data ? event.data.text() : '' };
  }
  const title = data.title || 'phone-code';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || '',
      tag: data.tag || data.sessionId || undefined,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data: { sessionId: data.sessionId },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const sessionId = event.notification.data && event.notification.data.sessionId;
  const target = sessionId ? `/#/s/${encodeURIComponent(sessionId)}` : '/#/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      const client = list.find((c) => new URL(c.url).origin === self.location.origin);
      if (client) {
        if (sessionId) client.postMessage({ type: 'open-session', sessionId });
        return client.focus();
      }
      return self.clients.openWindow(target);
    }),
  );
});
