/* Service Worker de Livecoins.
 * Objetivo: que el panel y los overlays carguen al instante al recargar,
 * cacheando los archivos pesados (videos de AI, audios, imágenes subidas).
 *
 * Estrategia:
 *  - Medios (/video, /uploads, /audios, imágenes): CACHE-FIRST.
 *  - Estáticos de la app (css, js): STALE-WHILE-REVALIDATE.
 *  - HTML de overlays: red primero; si Render/502/caída → caché o página
 *    de recuperación que reintenta sola (Live Studio no se queda en 502).
 *  - API y WebSocket: NUNCA se cachean (siempre red).
 */
const VERSION = 'lc-v18';
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

function isPanelHtml(pathname) {
  const base = String(pathname || '').split('/').pop().toLowerCase();
  return base === 'index.html' || base === 'login.html' || base === 'register.html'
    || String(pathname || '').toLowerCase().includes('/intro/');
}

function isOverlayHtml(pathname) {
  return /\.html$/i.test(pathname) && !isPanelHtml(pathname);
}

function overlayRecoveryResponse(targetHref) {
  const safe = String(targetHref || '/').replace(/</g, '');
  const html = `<!DOCTYPE html><html lang="es"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Cache-Control" content="no-store">
<title>Livecoins — reconectando</title>
<style>
html,body{margin:0;width:100%;height:100%;background:transparent!important;overflow:hidden}
.msg{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);
  font:600 13px system-ui,sans-serif;color:rgba(255,255,255,.5);
  text-shadow:0 1px 3px rgba(0,0,0,.7);letter-spacing:.02em;opacity:0;
  animation:fade .7s ease .5s forwards;white-space:nowrap}
@keyframes fade{to{opacity:1}}
</style></head><body>
<div class="msg">Reconectando overlay…</div>
<script>
(function () {
  var target = ${JSON.stringify(safe)};
  var tries = 0;
  function nextUrl() {
    try {
      var u = new URL(target, location.href);
      u.searchParams.set('_lc', String(Date.now()));
      return u.toString();
    } catch (e) {
      return target + (target.indexOf('?') >= 0 ? '&' : '?') + '_lc=' + Date.now();
    }
  }
  async function go() {
    tries += 1;
    try {
      var r = await fetch('/api/overlay-ping?t=' + Date.now(), { cache: 'no-store', credentials: 'omit' });
      if (r && (r.ok || r.status === 204)) {
        location.replace(nextUrl());
        return;
      }
    } catch (e) {}
    setTimeout(go, tries < 12 ? 1500 : 3500);
  }
  go();
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') go();
  });
  window.addEventListener('online', go);
})();
</script>
</body></html>`;
  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
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

async function matchCachedHtml(url) {
  const cache = await caches.open(ASSET_CACHE);
  const exact = await cache.match(new Request(url.href));
  if (exact) return exact;
  const keys = await cache.keys();
  const hit = keys.find((k) => {
    try {
      const u = new URL(k.url);
      return u.origin === url.origin && u.pathname === url.pathname;
    } catch {
      return false;
    }
  });
  return hit ? cache.match(hit) : null;
}

async function networkFirstOverlayHtml(req, url) {
  try {
    const res = await fetch(req);
    if (res && res.ok) {
      try {
        const cache = await caches.open(ASSET_CACHE);
        cache.put(req, res.clone());
      } catch { /* ignore */ }
      return res;
    }
    // 502/503 de Render u otro edge: no dejar la pantalla de error fija
    if (res && res.status >= 500) {
      const cached = await matchCachedHtml(url);
      if (cached) return cached;
      return overlayRecoveryResponse(url.href);
    }
    return res;
  } catch {
    const cached = await matchCachedHtml(url);
    if (cached) return cached;
    return overlayRecoveryResponse(url.href);
  }
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
    // No duplicar videos grandes en Cache Storage (llenaba el disco).
    if (/\.(mp4|webm|mov|mkv)$/i.test(url.pathname)) return;
    e.respondWith(cacheFirst(req, MEDIA_CACHE));
    return;
  }
  if (ASSET_EXT.test(url.pathname)) {
    e.respondWith(staleWhileRevalidate(req, ASSET_CACHE));
    return;
  }
  if (isOverlayHtml(url.pathname)) {
    e.respondWith(networkFirstOverlayHtml(req, url));
    return;
  }
  // Panel / resto: red primero, fallback a caché si no hay conexión.
  e.respondWith(
    fetch(req).catch(() => caches.match(req)),
  );
});
