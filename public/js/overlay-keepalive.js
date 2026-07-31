/**
 * Keepalive para Browser Source (Live Studio / OBS).
 * Si el servidor se cae un momento y vuelve, recarga la página sola
 * para que la fuente deje de verse negra sin borrar/pegar el link.
 */
(function () {
  if (window.__lcOverlayKeepalive) return;
  window.__lcOverlayKeepalive = true;

  const PING = '/api/overlay-ping';
  const INTERVAL_MS = 4000;
  const DOWN_BEFORE_RELOAD_MS = 2500;
  const COOLDOWN_MS = 20000;

  let downSince = 0;
  let lastReloadAt = 0;
  let checking = false;

  async function pingOk() {
    try {
      const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const t = ctrl ? setTimeout(() => { try { ctrl.abort(); } catch {} }, 2500) : null;
      const r = await fetch(PING + '?t=' + Date.now(), {
        cache: 'no-store',
        credentials: 'omit',
        signal: ctrl ? ctrl.signal : undefined,
      });
      if (t) clearTimeout(t);
      return !!r && (r.ok || r.status === 204);
    } catch {
      return false;
    }
  }

  function maybeReload(reason) {
    const now = Date.now();
    if (now - lastReloadAt < COOLDOWN_MS) return;
    lastReloadAt = now;
    try {
      console.info('[livecoins-keepalive] reload:', reason || '');
    } catch {}
    try {
      location.reload();
    } catch {}
  }

  async function tick() {
    if (checking) return;
    checking = true;
    try {
      const up = await pingOk();
      if (!up) {
        if (!downSince) downSince = Date.now();
        return;
      }
      if (downSince && Date.now() - downSince >= DOWN_BEFORE_RELOAD_MS) {
        downSince = 0;
        maybeReload('server-back');
        return;
      }
      downSince = 0;
    } finally {
      checking = false;
    }
  }

  setInterval(tick, INTERVAL_MS);
  setTimeout(tick, 1500);

  window.addEventListener('pageshow', (ev) => {
    if (ev && ev.persisted) maybeReload('pageshow-bfcache');
    else setTimeout(tick, 400);
  });
  window.addEventListener('online', () => setTimeout(tick, 500));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') setTimeout(tick, 300);
  });
})();
