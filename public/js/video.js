const stage = document.getElementById('stage');
const stageGeneral = document.getElementById('stageGeneral');
const params = new URLSearchParams(location.search);
const screen = Math.max(1, Math.min(10, parseInt(params.get('screen'), 10) || 1));

let ws, reconnectTimer, keepWorker;
let settings = {};

/** Tope absoluto: evita cola bloqueada / frame negro eterno en Live Studio */
const ABSOLUTE_MAX_MS = 180000;
/** Segundos sin avance de tiempo → cortar */
const STALL_LIMIT = 12;

function sendHello(sock) {
  try {
    sock.send(JSON.stringify({ action: 'hello', role: 'videoScreen', screen }));
  } catch {}
}

function buildKeepAliveWorker() {
  if (keepWorker) return keepWorker;
  try {
    const code = 'setInterval(function(){ postMessage(1); }, 5000);';
    const blob = new Blob([code], { type: 'application/javascript' });
    keepWorker = new Worker(URL.createObjectURL(blob));
    keepWorker.onmessage = () => {
      if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
        connectWS();
      } else if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify({ action: 'ping' })); } catch {}
        sendHello(ws);
      }
    };
  } catch { keepWorker = null; }
  return keepWorker;
}

function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${proto}://${location.host}/ws${location.search}`;
  if (ws) {
    if (ws.url === url && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    try { ws.close(); } catch {}
    ws = null;
  }
  const sock = new WebSocket(url);
  ws = sock;
  sock.onopen = () => {
    if (ws !== sock) return;
    clearTimeout(reconnectTimer);
    buildKeepAliveWorker();
    sendHello(sock);
  };
  sock.onclose = () => {
    if (ws !== sock) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectWS, 800);
  };
  sock.onmessage = (ev) => {
    if (ws !== sock) return;
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    const { type, payload } = msg;
    if (type === 'pong') return;
    if (type === 'settings') { settings = payload || {}; return; }
    if (type === 'media' && (Number(payload.screen) || 1) === screen) {
      if (payload.screenTest) { showScreenTest(); return; }
      enqueue(payload);
    }
    if (type === 'stopMedia' && (Number(payload.screen) || 1) === screen) { clearAllQueues(); stopAllStages(); }
    if (type === 'panic') { clearAllQueues(); stopAllStages(); }
  };
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && ws?.readyState !== WebSocket.OPEN) connectWS();
});
window.addEventListener('focus', () => { if (ws?.readyState !== WebSocket.OPEN) connectWS(); });
window.addEventListener('online', () => { if (ws?.readyState !== WebSocket.OPEN) connectWS(); });

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
  // WS caído en Live Studio (CEF a veces no dispara onclose a tiempo)
  if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
    connectWS();
  }
}, 4000);

connectWS();
