const stage = document.getElementById('stage');
const screen = Number(new URLSearchParams(location.search).get('screen')) || 1;

let ws, reconnectTimer;
let settings = {};

function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws${location.search}`);
  ws.onopen = () => {
    clearTimeout(reconnectTimer);
    ws.send(JSON.stringify({ action: 'hello', role: 'videoScreen', screen }));
  };
  ws.onclose = () => { reconnectTimer = setTimeout(connectWS, 1500); };
  ws.onmessage = (ev) => {
    const { type, payload } = JSON.parse(ev.data);
    if (type === 'settings') { settings = payload || {}; return; }
    if (type === 'media' && (Number(payload.screen) || 1) === screen) {
      if (payload.screenTest) { showScreenTest(); return; }
      enqueue(payload);
    }
    if (type === 'stopMedia' && (Number(payload.screen) || 1) === screen) { clearQueue(); stopStage(); }
    if (type === 'panic') { clearQueue(); stopStage(); }
  };
}

/* Cola de reproducción: con la cola activada cada video espera a que termine el anterior. */
let queue = [];
let busy = false;
let safetyTimer = null;

function queueOn() { return settings?.playback?.playQueue !== false; }

function enqueue(m) {
  if (!queueOn()) { play(m, null); return; }
  queue.push(m);
  pump();
}
function pump() {
  if (busy) return;
  const m = queue.shift();
  if (!m) return;
  busy = true;
  play(m, () => {
    if (safetyTimer) { clearTimeout(safetyTimer); safetyTimer = null; }
    if (!busy) return;
    busy = false;
    pump();
  });
}
function clearQueue() {
  queue = [];
  busy = false;
  if (safetyTimer) { clearTimeout(safetyTimer); safetyTimer = null; }
}

function play(m, done) {
  if (!m.url) { done?.(); return; }

  stage.innerHTML = '';
  const size = Math.max(10, Math.min(100, m.size ?? 100));
  const isImg = /\.(gif|png|jpe?g|webp)(\?|$)/i.test(m.url);

  let el;
  if (isImg) {
    el = document.createElement('img');
    el.src = m.url;
    const finish = () => { if (el.parentNode) el.remove(); done?.(); };
    el.onerror = finish;
    safetyTimer = setTimeout(finish, 8000);
  } else {
    el = document.createElement('video');
    el.src = m.url;
    el.autoplay = true;
    el.volume = (m.volume ?? 100) / 100;
    const finish = () => { try { if (el.parentNode) el.remove(); } catch {} done?.(); };
    el.onended = finish;
    el.onerror = finish;
    safetyTimer = setTimeout(finish, 60000);
  }
  el.className = 'media';
  el.style.maxWidth = size + 'vw';
  el.style.maxHeight = size + 'vh';
  stage.appendChild(el);
}

function stopStage() {
  // Pausamos y vaciamos cualquier video para cortar imagen y audio al instante
  stage.querySelectorAll('video').forEach((vid) => {
    try { vid.pause(); vid.muted = true; vid.removeAttribute('src'); vid.load(); } catch {}
  });
  stage.innerHTML = '';
}

function showScreenTest() {
  stage.innerHTML = `<div class="screen-test">✅ Pantalla ${screen} conectada<small>Browser Source funcionando</small></div>`;
  setTimeout(() => { stage.innerHTML = ''; }, 3500);
}

connectWS();
