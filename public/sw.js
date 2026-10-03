/* Bench service worker: macht die App installierbar und hält die Oberfläche
   für schlechten Empfang vor. Daten (/api) und Dateien (/_blob) gehen immer ans Netz. */
const CACHE = 'bench-v1';
const SHELL = ['/', '/runtime.js', '/config.js'];

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

async function networkFirst(req, key) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req);
    // Weiterleitungen (z. B. zum Login) nicht zwischenspeichern
    if (res.ok && !res.redirected && res.type === 'basic') cache.put(key || req, res.clone());
    return res;
  } catch (e) {
    const hit = await cache.match(key || req);
    if (hit) return hit;
    throw e;
  }
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  const net = fetch(req).then(res => { if (res.ok || res.type === 'opaque') cache.put(req, res.clone()); return res; }).catch(() => hit);
  return hit || net;
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === location.origin) {
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/_blob/') || url.pathname === '/login' || url.pathname === '/healthz') return;
    if (req.mode === 'navigate') { e.respondWith(networkFirst(req, '/')); return; }
    if (SHELL.includes(url.pathname)) { e.respondWith(networkFirst(req)); return; }
    if (url.pathname.startsWith('/icons/')) { e.respondWith(staleWhileRevalidate(req)); return; }
    return;
  }
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') e.respondWith(staleWhileRevalidate(req));
});
