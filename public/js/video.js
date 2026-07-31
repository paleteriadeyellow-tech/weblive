const stage = document.getElementById('stage');
const stageGeneral = document.getElementById('stageGeneral');
const params = new URLSearchParams(location.search);
const screen = Math.max(1, Math.min(10, parseInt(params.get('screen'), 10) || 1));

let ws, reconnectTimer, keepWorker;
let settings = {};
let connectStartedAt = 0;
/** Si el WS se queda en CONNECTING (típico tras redeploy en Render), forzar reintento. */
const CONNECT_STUCK_MS = 8000;

/** Tope absoluto: evita cola bloqueada / frame negro eterno en Live Studio */
const ABSOLUTE_MAX_MS = 180000;
/** Segundos sin avance de tiempo → cortar */
const STALL_LIMIT = 12;

function sendHello(sock) {
  try {
    sock.send(JSON.stringify({ action: 'hello', role: 'videoScreen', screen }));
  } catch {}
}

function wsNeedsReconnect() {
  if (!ws) return true;
  const st = ws.readyState;
  if (st === WebSocket.CLOSED || st === WebSocket.CLOSING) return true;
  if (st === WebSocket.CONNECTING && Date.now() - connectStartedAt > CONNECT_STUCK_MS) return true;
  return false;
}

function buildKeepAliveWorker() {
  if (keepWorker) return keepWorker;
  try {
    const code = 'setInterval(function(){ postMessage(1); }, 4000);';
    const blob = new Blob([code], { type: 'application/javascript' });
    keepWorker = new Worker(URL.createObjectURL(blob));
    keepWorker.onmessage = () => {
      if (wsNeedsReconnect()) {
        connectWS(true);
      } else if (ws && ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify({ action: 'ping' })); } catch {}
        sendHello(ws);
      }
    };
  } catch { keepWorker = null; }
  return keepWorker;
}

function connectWS(force) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  // location.search incluye ?room=… — esa clave NO cambia entre reinicios/deploys.
  const url = `${proto}://${location.host}/ws${location.search}`;
  if (!force && ws) {
    if (ws.url === url && ws.readyState === WebSocket.OPEN) return;
    if (ws.url === url && ws.readyState === WebSocket.CONNECTING
      && Date.now() - connectStartedAt < CONNECT_STUCK_MS) return;
  }
  if (ws) {
    try { ws.onopen = ws.onclose = ws.onmessage = ws.onerror = null; } catch {}
    try { ws.close(); } catch {}
    ws = null;
  }
  connectStartedAt = Date.now();
  const sock = new WebSocket(url);
  ws = sock;
  sock.onopen = () => {
    if (ws !== sock) return;
    clearTimeout(reconnectTimer);
    connectStartedAt = Date.now();
    buildKeepAliveWorker();
    sendHello(sock);
  };
  sock.onerror = () => {
    if (ws !== sock) return;
    try { sock.close(); } catch {}
  };
  sock.onclose = () => {
    if (ws !== sock) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => connectWS(true), 600);
  };
  sock.onmessage = (ev) => {
    if (ws !== sock) return;
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    const { type, payload } = msg;
    if (type === 'pong') return;
    if (type === 'settings') { settings = payload || {}; return; }
    if (type === 'media') {
      const want = Math.max(1, Math.min(10, Number(payload?.screen) || 1));
      if (want !== screen) return;
      if (payload.screenTest) { showScreenTest(); return; }
      enqueue(payload);
    }
    if (type === 'stopMedia') {
      const want = Math.max(1, Math.min(10, Number(payload?.screen) || 1));
      if (want !== screen) return;
      clearAllQueues();
      stopAllStages();
    }
    if (type === 'panic') { clearAllQueues(); stopAllStages(); }
  };
}

function ensureConnected() {
  if (wsNeedsReconnect() || (ws && ws.readyState !== WebSocket.OPEN)) connectWS(true);
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') ensureConnected();
});
window.addEventListener('focus', ensureConnected);
window.addEventListener('online', ensureConnected);
// bfcache / vuelta de pestaña en Live Studio tras caída del servidor
window.addEventListener('pageshow', ensureConnected);

/** Si el WS lleva mucho caído pero el HTTP ya responde, recargar (Live Studio CEF). */
let __vidDownSince = 0;
setInterval(() => {
  const dead = wsNeedsReconnect() || !ws || ws.readyState !== WebSocket.OPEN;
  if (dead) {
    if (!__vidDownSince) __vidDownSince = Date.now();
    if (Date.now() - __vidDownSince < 8000) return;
    fetch('/api/overlay-ping?t=' + Date.now(), { cache: 'no-store', credentials: 'omit' })
      .then((r) => {
        if (r && (r.ok || r.status === 204)) {
          __vidDownSince = 0;
          try { location.reload(); } catch {}
        }
      })
      .catch(() => {});
    return;
  }
  __vidDownSince = 0;
}, 4000);

/* Cola de reproducción: con la cola activada cada video espera a que termine el anterior.
   El Perfil General usa su propia capa/cola para no bloquearse con el perfil activo. */
const lanes = {
  active: { stage, queue: [], busy: false, timers: new Set(), token: 0 },
  general: { stage: stageGeneral, queue: [], busy: false, timers: new Set(), token: 0 },
};

function laneFor(m) {
  return (m && (m.general || m.profileGeneral)) ? lanes.general : lanes.active;
}

function queueOn(m) {
  if (m && typeof m.playQueue === 'boolean') return m.playQueue;
  return settings?.playback?.playQueue !== false;
}

function addTimer(lane, fn, ms) {
  const id = setTimeout(() => {
    lane.timers.delete(id);
    try { fn(); } catch {}
  }, ms);
  lane.timers.add(id);
  return id;
}

function clearLaneTimers(lane) {
  lane.timers.forEach((id) => clearTimeout(id));
  lane.timers.clear();
}

function enqueue(m) {
  const lane = laneFor(m);
  // Anti-doble: el mismo clip no se encola dos veces seguidas (relay / perfil general).
  const dedupeKey = `${m?.id || ''}|${String(m?.url || '')}|${lane === lanes.general ? 'g' : 'a'}`;
  const now = Date.now();
  if (lane._lastKey === dedupeKey && now - (lane._lastAt || 0) < 400) return;
  lane._lastKey = dedupeKey;
  lane._lastAt = now;
  if (!queueOn(m)) {
    // Sin cola: corta lo actual y reproduce ya (invalidando callbacks viejos)
    lane.token += 1;
    clearLaneTimers(lane);
    lane.busy = false;
    lane.queue = [];
    playOnStage(lane, m, null);
    return;
  }
  lane.queue.push(m);
  pump(lane);
}

function pump(lane) {
  if (lane.busy) return;
  const m = lane.queue.shift();
  if (!m) return;
  lane.busy = true;
  playOnStage(lane, m, () => {
    // Solo libera si este play sigue siendo el vigente
    lane.busy = false;
    clearLaneTimers(lane);
    pump(lane);
  });
}

function clearLane(lane) {
  lane.token += 1; // invalida finish/watch en vuelo
  lane.queue = [];
  lane.busy = false;
  clearLaneTimers(lane);
}

function clearAllQueues() {
  clearLane(lanes.active);
  clearLane(lanes.general);
}

function playOnStage(lane, m, done) {
  const host = lane.stage;
  const token = (lane.token += 1);
  clearLaneTimers(lane);

  const alive = () => lane.token === token;

  const finish = () => {
    if (!alive()) return;
    lane.token += 1; // marca este play como terminado
    clearLaneTimers(lane);
    try {
      host.querySelectorAll('video').forEach((vid) => {
        try {
          vid.dataset.stopped = '1';
          vid.pause();
          vid.removeAttribute('src');
          vid.load();
        } catch {}
      });
    } catch {}
    try { if (host) host.innerHTML = ''; } catch {}
    try {
      if (m?.id && ws?.readyState === 1) {
        ws.send(JSON.stringify({ action: 'mediaEnded', id: m.id, screen }));
      }
    } catch {}
    done?.();
  };

  if (!host || !m?.url) { done?.(); return; }

  host.innerHTML = '';
  const size = Math.max(10, Math.min(100, m.size ?? 100));
  const maxSec = Number(m.maxDurationSec) > 0 ? Number(m.maxDurationSec) : 0;
  const isImg = /\.(gif|png|jpe?g|webp)(\?|$)/i.test(m.url);

  let el;
  if (isImg) {
    el = document.createElement('img');
    el.src = m.url;
    el.onerror = () => { if (alive()) finish(); };
    const imgMs = maxSec > 0 ? maxSec * 1000 : 8000;
    addTimer(lane, () => { if (alive()) finish(); }, imgMs);
  } else {
    el = document.createElement('video');
    el.src = m.url;
    el.autoplay = true;
    el.playsInline = true;
    el.preload = 'auto';
    el.setAttribute('playsinline', '');
    el.volume = (m.volume ?? 100) / 100;

    let errorRetries = 0;
    let lastTime = -1;
    let stalledSecs = 0;

    const safePlay = () => {
      if (!alive() || !el.isConnected) return;
      try {
        const p = el.play && el.play();
        if (p && typeof p.catch === 'function') {
          p.catch(() => {
            if (!alive()) return;
            el.muted = true;
            try { el.play && el.play().catch(() => {}); } catch {}
          });
        }
      } catch {}
    };

    el.onended = () => { if (alive()) finish(); };

    el.onpause = () => {
      if (!alive() || el.dataset.stopped || !el.isConnected || el.ended) return;
      const nearEnd = el.duration && el.currentTime >= el.duration - 0.4;
      if (!nearEnd) safePlay();
      // Colgado al final sin evento ended → cortar
      if (nearEnd) addTimer(lane, () => { if (alive() && !el.ended) finish(); }, 1500);
    };

    el.onerror = () => {
      if (!alive()) return;
      if (errorRetries >= 3) { finish(); return; }
      errorRetries += 1;
      const resumeAt = el.currentTime || 0;
      try {
        el.load();
        el.addEventListener('loadedmetadata', () => {
          if (!alive()) return;
          try { if (resumeAt > 0 && resumeAt < (el.duration || Infinity)) el.currentTime = resumeAt; } catch {}
          safePlay();
        }, { once: true });
      } catch { finish(); }
    };

    const watch = () => {
      if (!alive() || !el.isConnected) return;
      const t = el.currentTime || 0;
      if (t > lastTime + 0.05) {
        lastTime = t;
        stalledSecs = 0;
      } else {
        stalledSecs += 1;
        const nearEnd = el.duration && el.currentTime >= el.duration - 0.4;
        if (el.paused && !el.ended && !nearEnd) safePlay();
        // Negro / colgado al final
        if (nearEnd && stalledSecs >= 2) { finish(); return; }
      }
      if (stalledSecs >= STALL_LIMIT) { finish(); return; }
      addTimer(lane, watch, 1000);
    };
    addTimer(lane, watch, 1000);

    if (maxSec > 0) addTimer(lane, () => { if (alive()) finish(); }, maxSec * 1000);
    // Tope duro siempre (Live Studio a veces no dispara ended)
    addTimer(lane, () => { if (alive()) finish(); }, ABSOLUTE_MAX_MS);
    safePlay();
  }

  el.className = 'media';
  el.style.maxWidth = size + 'vw';
  el.style.maxHeight = size + 'vh';
  host.appendChild(el);

  // Imágenes ya tienen su timer; videos/imagen sin avance → absoluto
  if (isImg) addTimer(lane, () => { if (alive()) finish(); }, ABSOLUTE_MAX_MS);
}

function stopStageEl(host) {
  if (!host) return;
  host.querySelectorAll('video').forEach((vid) => {
    try { vid.dataset.stopped = '1'; vid.pause(); vid.muted = true; vid.removeAttribute('src'); vid.load(); } catch {}
  });
  host.innerHTML = '';
}

function stopAllStages() {
  stopStageEl(stage);
  stopStageEl(stageGeneral);
}

function showScreenTest() {
  const lane = lanes.active;
  lane.token += 1;
  clearLaneTimers(lane);
  lane.busy = false;
  stage.innerHTML = `<div class="screen-test">✅ Pantalla ${screen} conectada<small>Browser Source funcionando</small></div>`;
  addTimer(lane, () => {
    if (stage.querySelector('.screen-test')) stage.innerHTML = '';
  }, 3500);
}

/** Autosanación: busy sin media en stage = cola colgada (pantalla negra eternamente) */
setInterval(() => {
  [lanes.active, lanes.general].forEach((lane) => {
    if (!lane.busy) return;
    const hasMedia = !!lane.stage?.querySelector('video.media, img.media');
    if (!hasMedia) {
      clearLaneTimers(lane);
      lane.busy = false;
      pump(lane);
    }
  });
  // WS caído o CONNECTING eterno (CEF / redeploy Render)
  if (wsNeedsReconnect()) connectWS(true);
}, 3000);

connectWS();
