// Service Worker para Cámaras V.
// Estrategia: "network-first" para HTML/API (siempre datos frescos) con fallback
// al último HTML cacheado si el técnico está sin señal. Assets estáticos (íconos,
// manifest) van a "cache-first" para no pegar al server en cada carga.
const CACHE_VERSION = 'camaras-v5';
const APP_SHELL = [
  '/manifest.json',
  '/icon.png',
  '/icon-192.png',
  '/icon-192-maskable.png',
  '/icon-512-maskable.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(APP_SHELL)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_VERSION).map((n) => caches.delete(n)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return; // POST/PUT no cachea

  const url = new URL(req.url);
  // Nunca cachear la API dinámica (data, status, hyperlinks, photos, upload…)
  if (url.pathname.startsWith('/api/')) return;

  const isNav = req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html');
  if (isNav) {
    // Network-first para páginas HTML
    event.respondWith(
      fetch(req).then((resp) => {
        const copy = resp.clone();
        caches.open(CACHE_VERSION).then((c) => c.put(req, copy)).catch(() => {});
        return resp;
      }).catch(() => caches.match(req).then((hit) => hit || caches.match('/isp') || caches.match('/')))
    );
    return;
  }

  // Cache-first para estáticos (íconos, manifest, etc.)
  event.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((resp) => {
      const copy = resp.clone();
      caches.open(CACHE_VERSION).then((c) => c.put(req, copy)).catch(() => {});
      return resp;
    }).catch(() => hit))
  );
});
