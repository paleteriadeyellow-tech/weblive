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
    el.playsInline = true;
    el.preload = 'auto';
    el.volume = (m.volume ?? 100) / 100;

    let finished = false;
    let errorRetries = 0;
    let lastTime = -1;
    let stalledSecs = 0;
    const STALL_LIMIT = 25; // segundos sin avanzar antes de rendirse

    const finish = () => {
      if (finished) return;
      finished = true;
      if (safetyTimer) { clearTimeout(safetyTimer); safetyTimer = null; }
      try { if (el.parentNode) el.remove(); } catch {}
      done?.();
    };

    // Lanza la reproducción y, si el navegador bloquea el autoplay con sonido (caso de
    // vistas previas fuera de OBS), reintenta en silencio para que igual se vea.
    const safePlay = () => {
      try {
        const p = el.play && el.play();
        if (p && typeof p.catch === 'function') {
          p.catch(() => { el.muted = true; try { el.play && el.play().catch(() => {}); } catch {} });
        }
      } catch {}
    };

    el.onended = finish;

    // El chat de voz (TTS) NO debe detener el video por nada. Cuando la voz toca el
    // dispositivo de audio, el navegador a veces pausa el video; aquí lo reanudamos
    // EN EL ACTO (mismo instante del 'pause'), así el corte es imperceptible. No se
    // reanuda si la parada fue intencional (stopMedia/panic), si ya terminó, o si está
    // justo al final.
    el.onpause = () => {
      if (finished || el.dataset.stopped || !el.isConnected || el.ended) return;
      const nearEnd = el.duration && el.currentTime >= el.duration - 0.4;
      if (!nearEnd) safePlay();
    };

    // CLAVE: ante un error transitorio (CPU saturada durante el live, hipo de red en
    // weblive…) NO cortamos el video de inmediato. Antes, cualquier 'error' lo eliminaba
    // a media reproducción —esa era la causa de que se cortaran solo en vivo—. Ahora
    // reintentamos reanudar desde donde iba; solo nos rendimos tras varios fallos.
    el.onerror = () => {
      if (finished) return;
      if (errorRetries >= 3) { finish(); return; }
      errorRetries += 1;
      const resumeAt = el.currentTime || 0;
      try {
        el.load();
        el.addEventListener('loadedmetadata', () => {
          try { if (resumeAt > 0 && resumeAt < (el.duration || Infinity)) el.currentTime = resumeAt; } catch {}
          safePlay();
        }, { once: true });
      } catch { finish(); }
    };

    // Vigilante de reproducción: en lugar de cortar a los 60s (lo que truncaba los
    // videos largos), solo terminamos si el tiempo deja de AVANZAR durante mucho rato
    // (cuelgue real). Así un video se reproduce COMPLETO sin importar su duración, y
    // seguimos teniendo un respaldo por si nunca dispara 'ended'.
    const watch = () => {
      if (finished || !el.isConnected) return;
      const t = el.currentTime || 0;
      if (t > lastTime + 0.05) { lastTime = t; stalledSecs = 0; }
      else {
        stalledSecs += 1;
        // Si quedó en PAUSA sin haber terminado (p. ej. el chat de voz/TTS tocó el
        // dispositivo de audio y el navegador pausó el video), intentamos reanudarlo
        // en vez de esperar a rendirnos. Así la voz ya no corta el video.
        const nearEnd = el.duration && el.currentTime >= el.duration - 0.4;
        if (el.paused && !el.ended && !nearEnd) safePlay();
      }
      if (stalledSecs >= STALL_LIMIT) { finish(); return; }
      safetyTimer = setTimeout(watch, 1000);
    };
    safetyTimer = setTimeout(watch, 1000);
    safePlay();
  }
  el.className = 'media';
  el.style.maxWidth = size + 'vw';
  el.style.maxHeight = size + 'vh';
  stage.appendChild(el);
}

function stopStage() {
  // Pausamos y vaciamos cualquier video para cortar imagen y audio al instante.
  // Marcamos 'stopped' para que el auto-reanudar (onpause) NO lo vuelva a reproducir.
  stage.querySelectorAll('video').forEach((vid) => {
    try { vid.dataset.stopped = '1'; vid.pause(); vid.muted = true; vid.removeAttribute('src'); vid.load(); } catch {}
  });
  stage.innerHTML = '';
}

function showScreenTest() {
  stage.innerHTML = `<div class="screen-test">✅ Pantalla ${screen} conectada<small>Browser Source funcionando</small></div>`;
  setTimeout(() => { stage.innerHTML = ''; }, 3500);
}

connectWS();
