/* GHDD Assessment Pro – service worker: wuxuu app-ka u oggolaanayaa in desktop-ka/taleefoonka lagu rakibo.
   Xogta iyo bogagga mar walba internet-ka ayaa laga keenaa (wax hore u kaydsan ma jiraan), si isbeddel kasta isla markiiba u muuqdo. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || e.request.mode !== 'navigate') return;
  e.respondWith(fetch(e.request).catch(() => new Response(
    '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>GHDD Assessment Pro</title>' +
    '<body style="font-family:Arial,sans-serif;text-align:center;padding:60px 20px;color:#172338"><h2>Internet ma jiro</h2><p>GHDD Assessment Pro wuxuu u baahan yahay internet. Hubi xiriirka kadibna mar kale isku day.</p>' +
    '<button onclick="location.reload()" style="padding:12px 18px;border:0;border-radius:8px;background:#123b78;color:#fff;font-weight:bold">Isku day mar kale</button></body>',
    { headers: { 'Content-Type': 'text/html; charset=utf-8' } })));
});
