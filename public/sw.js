/* Service worker – wuxuu app-ka u oggolaanayaa inuu offline ku shaqeeyo */
const CACHE = 'ghdd-natiijo-v1';
const ASSETS = [
  '/', '/natiijo', '/admin', '/kaar.html',
  '/css/app.css', '/js/calc.js', '/js/qr.js', '/js/xlsx.js', '/js/charts.js', '/js/result-view.js', '/js/admin.js',
  '/vendor/jszip.min.js', '/icon.svg', '/manifest.webmanifest'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin || url.pathname.startsWith('/api/')) return;

  // Bogagga: internet marka hore, haddii la waayo kan kaydsan
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        if (res.ok) caches.open(CACHE).then((c) => c.put(url.pathname.startsWith('/kaar/') ? '/kaar.html' : req, copy));
        return res;
      }).catch(async () => {
        const c = await caches.open(CACHE);
        if (url.pathname.startsWith('/kaar/')) return (await c.match('/kaar.html')) || Response.error();
        return (await c.match(req)) || (await c.match(url.pathname)) || (await c.match('/admin')) || Response.error();
      })
    );
    return;
  }
  // Faylasha kale: kaydka marka hore, gadaal ka cusboonaysii
  e.respondWith(
    caches.open(CACHE).then(async (c) => {
      const hit = await c.match(req);
      const net = fetch(req).then((res) => { if (res.ok) c.put(req, res.clone()); return res; }).catch(() => hit);
      return hit || net;
    })
  );
});
