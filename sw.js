// Insta Report service worker — precache the shell so the app opens offline.
const VERSION = 'v1.9.0';
const CACHE = (self.APP_CACHE_PREFIX || 'instareport-admin-') + VERSION;

const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './css/report.css',
  './js/app.js',
  './js/build.js',
  './js/pdf.js',
  './js/report-pdf.js',
  './js/assist.js',
  './js/fallback.js',
  './js/ui.js',
  './js/db.js',
  './js/store.js',
  './js/image.js',
  './js/ai.js',
  './js/backup.js',
  './js/captions.js',
  './js/screens/projects.js',
  './js/screens/project.js',
  './js/screens/section.js',
  './js/screens/annotate.js',
  './js/screens/report.js',
  './js/screens/settings.js',
  './js/screens/assistant.js',
  './js/screens/library.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-180.png',
];

// Note: no skipWaiting() here. A new worker stays parked until the page has
// shown "App is updating" and told it to take over, so assets never swap
// underneath a session that is mid-capture.
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Never cache API traffic.
  if (url.origin !== self.location.origin) return;

  // Navigations fall back to the cached shell when offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() => caches.match('./index.html').then((r) => r || caches.match('./')))
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((hit) => {
      if (hit) {
        // Refresh in the background so an update lands on the next launch.
        fetch(req).then((res) => {
          if (res && res.ok) caches.open(CACHE).then((c) => c.put(req, res.clone()));
        }).catch(() => {});
        return hit;
      }
      return fetch(req).then((res) => {
        if (res && res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => caches.match('./index.html'));
    })
  );
});

self.addEventListener('message', (e) => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});
