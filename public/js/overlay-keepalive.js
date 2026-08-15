/**
 * Keepalive / anti-negro para Browser Source (Live Studio / OBS).
 *
 * Casos que cubre:
 * 1) Servidor local (.exe) cae un momento y vuelve → reload.
 * 2) Live Studio abre la fuente ANTES de que Livecoins esté listo → página
 *    en negro/error; cuando el ping ya responde, recarga sola (hasta 3 veces).
 * 3) CEF se “congela” (ping OK pero WebSocket no abre) → reload.
 * 4) Vuelta a la escena / pageshow / online → re-chequeo.
 * 5) Reinicio de Render (502): registra SW para que el próximo fallo
 *    sirva caché/recuperación en vez de quedarse en Bad Gateway.
 * 6) Sondeo WS periódico en vivo (por si CEF se queda mudo a media transmisión).
 *
 * Así no hace falta borrar y volver a pegar el link en Live Studio.
 */
(function () {
  // Preview del panel (?embed=1): no ping, no WS extra, no Service Worker.
  // Eso competía con el dashboard (mismo origen) y dejaba la app menos fluida.
  try {
    if (new URLSearchParams(location.search).get('embed') === '1') return;
  } catch {}
  if (window.__lcOverlayKeepalive) return;
  window.__lcOverlayKeepalive = true;

  const PING = '/api/overlay-ping';
  const INTERVAL_MS = 3000;
  const DOWN_BEFORE_RELOAD_MS = 1500;
  const COOLDOWN_MS = 10000;
  const BOOT_WINDOW_MS = 60000;
  const MAX_BOOT_RELOADS = 5;
  const WS_FAIL_BEFORE_RELOAD = 2;
  const PERIODIC_WS_PROBE_MS = 45000;

  let downSince = 0;
  let lastReloadAt = 0;
  let checking = false;
  let bootReloads = 0;
  let wsFailStreak = 0;
  let forceWsProbe = true; // primer tick + al volver a la escena
  let lastPeriodicProbeAt = 0;
  const bootAt = Date.now();

  // SW solo en la web (Render). En localhost/.exe controlaba el panel, cacheaba
  // dashboard.js viejo y llenaba Roaming con cientos de miles de archivos.
  try {
    const host = String(location.hostname || '');
    const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
    if ('serviceWorker' in navigator) {
      if (isLocal) {
        navigator.serviceWorker.getRegistrations().then((rs) => rs.forEach((r) => r.unregister())).catch(() => {});
      } else {
        navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
      }
    }
  } catch { /* ignore */ }

  try {
    const n = Number(sessionStorage.getItem('lc_ov_boot_reloads') || 0);
    if (Number.isFinite(n) && n > 0) bootReloads = Math.min(MAX_BOOT_RELOADS, n);
  } catch { /* ignore */ }

  function inBootWindow() {
    return Date.now() - bootAt < BOOT_WINDOW_MS;
  }

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

  /** Sondeo corto del WS (misma room que el overlay). Si falla con ping OK → CEF/arranque roto. */
  function probeWs(timeoutMs) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (ok) => {
        if (settled) return;
        settled = true;
        try { clearTimeout(timer); } catch {}
        try { if (sock && sock.readyState <= 1) sock.close(); } catch {}
        resolve(!!ok);
      };
      let sock = null;
      const timer = setTimeout(() => done(false), timeoutMs || 2800);
      try {
        const proto = location.protocol === 'https:' ? 'wss' : 'ws';
        const q = location.search || '';
        sock = new WebSocket(`${proto}://${location.host}/ws${q}`);
        sock.onopen = () => done(true);
        sock.onerror = () => done(false);
        sock.onclose = () => { if (!settled) done(false); };
      } catch {
        done(false);
      }
    });
  }

  function maybeReload(reason) {
    const now = Date.now();
    if (now - lastReloadAt < COOLDOWN_MS) return false;
    lastReloadAt = now;
    if (inBootWindow() || reason === 'boot-recover' || reason === 'ws-stuck') {
      bootReloads += 1;
      try { sessionStorage.setItem('lc_ov_boot_reloads', String(bootReloads)); } catch { /* ignore */ }
    }
    try {
      console.info('[livecoins-keepalive] reload:', reason || '', 'boot#', bootReloads);
    } catch {}
    try {
      const u = new URL(location.href);
      u.searchParams.set('_lc', String(now));
      location.replace(u.toString());
    } catch {
      try { location.reload(); } catch {}
    }
    return true;
  }

  async function tick() {
    if (checking) return;
    checking = true;
    try {
      const up = await pingOk();
      if (!up) {
        if (!downSince) downSince = Date.now();
        wsFailStreak = 0;
        return;
      }

      // Servidor volvió tras caída → recargar (Live Studio se queda en negro/502).
      if (downSince && Date.now() - downSince >= DOWN_BEFORE_RELOAD_MS) {
        downSince = 0;
        maybeReload('server-back');
        return;
      }
      downSince = 0;

      const now = Date.now();
      const visible = !document.hidden && document.visibilityState !== 'hidden';
      if (visible && now - lastPeriodicProbeAt >= PERIODIC_WS_PROBE_MS) {
        lastPeriodicProbeAt = now;
        forceWsProbe = true;
      }

      // Arranque en frío / CEF negro / WS mudo a media transmisión.
      const needWsCheck = forceWsProbe || inBootWindow();
      forceWsProbe = false;
      const allowBootLimited = bootReloads < MAX_BOOT_RELOADS;
      const allowPeriodic = !inBootWindow(); // fuera del boot no hay tope duro
      if (needWsCheck && (allowBootLimited || allowPeriodic)) {
        const wsOk = await probeWs(2600);
        if (wsOk) {
          wsFailStreak = 0;
          bootReloads = 0;
          try { sessionStorage.removeItem('lc_ov_boot_reloads'); } catch { /* ignore */ }
        } else {
          wsFailStreak += 1;
          if (wsFailStreak >= WS_FAIL_BEFORE_RELOAD) {
            wsFailStreak = 0;
            maybeReload(inBootWindow() ? 'boot-recover' : 'ws-stuck');
            return;
          }
          if (inBootWindow()) forceWsProbe = true;
        }
      }
    } finally {
      checking = false;
    }
  }

  setInterval(tick, INTERVAL_MS);
  setTimeout(tick, 800);
  // Segundo pase temprano: típico “abrí Live Studio y Livecoins aún no”.
  setTimeout(tick, 4000);
  setTimeout(tick, 10000);
  setTimeout(tick, 20000);

  window.addEventListener('pageshow', (ev) => {
    if (ev && ev.persisted) maybeReload('pageshow-bfcache');
    else setTimeout(tick, 400);
  });
  window.addEventListener('online', () => setTimeout(tick, 500));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      forceWsProbe = true;
      setTimeout(tick, 300);
    }
  });
})();
