/* Service Worker de Livecoins.
 * Objetivo: que el panel y los overlays carguen al instante al recargar,
 * cacheando los archivos pesados (videos de AI, audios, imágenes subidas).
 *
 * Estrategia:
 *  - Medios (/video, /uploads, /audios, imágenes): CACHE-FIRST.
 *    Una vez descargados, se sirven desde el dispositivo (instantáneo) y no
 *    se vuelven a bajar. Si no están en caché, se descargan y se guardan.
 *  - Estáticos de la app (css, js, html de overlays): STALE-WHILE-REVALIDATE.
 *    Se sirve la copia guardada de inmediato y se actualiza en segundo plano,
 *    así siempre cargas rápido y al siguiente refresh ya tienes lo último.
 *  - API y WebSocket: NUNCA se cachean (siempre red).
 */
const VERSION = 'lc-v4';
const MEDIA_CACHE = `media-${VERSION}`;
const ASSET_CACHE = `assets-${VERSION}`;

const MEDIA_PREFIXES = ['/video/', '/uploads/', '/audios/'];
const MEDIA_EXT = /\.(mp4|webm|mov|mkv|gif|png|jpe?g|webp|mp3|wav|ogg|m4a|aac|flac|svg|woff2?|ttf)$/i;
const ASSET_EXT = /\.(css|js)$/i;

self.addEventListener('install', (e) => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((k) => k !== MEDIA_CACHE && k !== ASSET_CACHE).map((k) => caches.delete(k)),
    );
    await self.clients.claim();
  })());
});

function isMedia(url) {
  return MEDIA_PREFIXES.some((p) => url.pathname.startsWith(p)) || MEDIA_EXT.test(url.pathname);
}

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res && res.ok) cache.put(req, res.clone());
  return res;
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  const fetching = fetch(req).then((res) => {
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  }).catch(() => hit);
  return hit || fetching;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch { return; }

  // Solo nuestro propio origen.
  if (url.origin !== self.location.origin) return;
  // Nunca interceptar API ni websockets.
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/ws')) return;

  if (isMedia(url)) {
    e.respondWith(cacheFirst(req, MEDIA_CACHE));
    return;
  }
  if (ASSET_EXT.test(url.pathname)) {
    e.respondWith(staleWhileRevalidate(req, ASSET_CACHE));
    return;
  }
  // Resto (HTML/navegación): red primero, con fallback a caché si no hay conexión.
  e.respondWith(
    fetch(req).catch(() => caches.match(req)),
  );
});
