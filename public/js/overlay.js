const alertsEl = document.getElementById('alerts');
const videoLayer = document.getElementById('videoLayer');
const MAX_ALERTS = 5;

let ws, reconnectTimer;
let settings = { alerts: { gift: true, follow: true, share: true, like: false, member: false, minDiamonds: 1, duration: 5 } };

/** 0–100 (alertas/videos) o 0–1 (acciones). Curva al cuadrado para que bajar el slider se note. */
function lcVolume01(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 1;
  const lin = n > 1 ? Math.min(1, n / 100) : Math.min(1, n);
  return lin * lin;
}
function applyMediaVolume(el, raw) {
  if (!el) return;
  const v = lcVolume01(raw);
  const set = () => {
    try { el.volume = v; el.muted = v <= 0; } catch { /* ignore */ }
  };
  set();
  el.addEventListener('loadedmetadata', set);
  el.addEventListener('canplay', set);
  el.addEventListener('playing', set);
}

function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws${location.search}`);
  ws.onopen = () => clearTimeout(reconnectTimer);
  ws.onclose = () => { reconnectTimer = setTimeout(connectWS, 1500); };
  ws.onmessage = (ev) => {
    const { type, payload } = JSON.parse(ev.data);
    if (type === 'settings') { settings = payload; warmSoundsFromSettings(payload); return; }
    if (type === 'media') { if (!payload.screenTest) enqueue({ kind: 'video', payload }); return; }
    if (type === 'actionAnim') { enqueue({ kind: 'actionAnim', payload }); return; }
    if (type === 'actionAlert') { enqueue({ kind: 'actionAlert', payload }); return; }
    if (type === 'stopMedia') { stopMediaForScreen(payload?.screen); return; }
    if (type === 'sound') { enqueue({ kind: 'sound', payload }); return; }
    if (type === 'stopSound') {
      // Sin id = stop global de sonidos (botón Stop del panel). Con id (webhooks)
      // no tocamos nada aquí para no cortar otros sonidos.
      if (payload?.id == null || payload.id === '') stopSoundsOnly();
      return;
    }
    if (type === 'panic') { clearQueue(); stopAllSounds(); stopVideoLayer(); return; }
    const a = settings.alerts || {};
    if (type === 'gift') onGift(payload, a);
    else if (type === 'follow' && a.follow) showAlert('follow', payload, '➕', 'te empezó a seguir');
    else if (type === 'share' && a.share) showAlert('share', payload, '🔁', 'compartió el live');
    else if (type === 'member' && a.member) showAlert('member', payload, '🙋', 'entró a la sala');
    else if (type === 'like' && a.like) showAlert('like', payload, '❤️', 'dio like');
  };
}

function onGift(p, a) {
  if (!a.gift) return;
  if (p.streak) return; // espera a que termine la racha
  const total = (p.diamonds || 0) * (p.repeatCount || 1);
  if (!p.test && total < (a.minDiamonds || 0)) return;
  showAlert('gift', p, '🎁', `envió ${esc(p.giftName)} x${p.repeatCount || 1}`, p, total);
}

function showAlert(kind, user, emoji, action, gift = null, diamonds = null) {
  const div = document.createElement('div');
  div.className = `alert ${kind}`;
  const giftImg = gift?.image ? `<img class="giftimg" src="${esc(gift.image)}" />` : '';
  const dia = diamonds ? `<span class="dia">💎 ${diamonds}</span>` : '';
  div.innerHTML = `
    ${avatar(user)}
    <div class="body">
      <span class="who">${esc(user.nickname)}</span>
      <span class="what">${emoji} ${action}</span>
    </div>${giftImg}${dia}`;

  const dur = (settings.alerts?.duration || 5) * 1000;
  div.style.animation = `pop .4s cubic-bezier(.2,1.4,.4,1) forwards, fade .5s ease forwards ${(dur - 500) / 1000}s`;

  alertsEl.appendChild(div);
  while (alertsEl.children.length > MAX_ALERTS) alertsEl.removeChild(alertsEl.firstChild);
  setTimeout(() => div.remove(), dur + 200);
}

/* ----- Cola de reproducción (videos + sonidos) -----
   Con la cola activada (settings.playback.playQueue), cada alerta/video/sonido espera a
   que termine el anterior antes de reproducirse, así nunca se cortan entre sí. */
let mediaQueue = [];
let queueBusy = false;
let activeDoneTimer = null;
let currentItem = null;
let currentDone = null;

function queueOn() { return settings?.playback?.playQueue !== false; }

function soundSrc(url) {
  if (!url) return '';
  const s = String(url);
  if (/^https?:\/\//i.test(s) || s.startsWith('data:')) return s;
  return s.startsWith('/') ? s : `/${s}`;
}

const soundPreload = new Map();
function warmSoundPreload(url) {
  const src = soundSrc(url);
  if (!src || soundPreload.has(src)) return;
  const a = new Audio();
  a.preload = 'auto';
  a.src = src;
  soundPreload.set(src, a);
}
function warmSoundsFromSettings(s) {
  for (const a of (s?.soundAlerts || [])) {
    if (a?.sound) warmSoundPreload(a.sound);
  }
}
function makeSoundAudio(url) {
  const src = soundSrc(url);
  warmSoundPreload(src);
  const audio = new Audio();
  audio.preload = 'auto';
  audio.src = src;
  return audio;
}

function enqueue(item) {
  if (item.kind === 'sound' && (item.payload?.playQueue === false || item.payload?.webhookToggle)) {
    playSoundNow(item.payload, null);
    return;
  }
  if (!queueOn()) {
    // Modo sin cola: comportamiento directo (puede solaparse / cortar como antes)
    if (item.kind === 'actionAnim') playActionAnimNow(item.payload, null);
    else if (item.kind === 'actionAlert') playActionAlertNow(item.payload, null);
    else if (item.kind === 'video') playVideoNow(item.payload, null);
    else playSoundNow(item.payload, null);
    return;
  }
  mediaQueue.push(item);
  pump();
}

function pump() {
  if (queueBusy) return;
  const item = mediaQueue.shift();
  if (!item) return;
  queueBusy = true;
  currentItem = item;
  const done = () => {
    if (activeDoneTimer) { clearTimeout(activeDoneTimer); activeDoneTimer = null; }
    if (!queueBusy) return;
    queueBusy = false;
    currentItem = null;
    currentDone = null;
    pump();
  };
  currentDone = done;
  if (item.kind === 'actionAnim') playActionAnimNow(item.payload, done);
  else if (item.kind === 'actionAlert') playActionAlertNow(item.payload, done);
  else if (item.kind === 'video') playVideoNow(item.payload, done);
  else playSoundNow(item.payload, done);
}

function clearQueue() {
  mediaQueue = [];
  queueBusy = false;
  currentItem = null;
  currentDone = null;
  clearMediaTimers();
  if (activeDoneTimer) { clearTimeout(activeDoneTimer); activeDoneTimer = null; }
  cancelOverlaySpeech();
}

/* Stop de sonidos: quita los sonidos de la cola y corta el que suena; los videos siguen. */
function stopSoundsOnly() {
  mediaQueue = mediaQueue.filter((it) => it.kind !== 'sound');
  playingSounds.forEach((a) => { try { a.pause(); a.currentTime = 0; } catch {} });
  playingSounds.clear();
  if (queueBusy && currentItem?.kind === 'sound') {
    // La imagen de la alerta sonora vive en videoLayer; limpiarla solo si lo actual es un sonido.
    videoLayer.innerHTML = '';
    const done = currentDone;
    currentDone = null;
    done?.();
  }
}

/* stopMedia con pantalla: solo quita videos de esa pantalla; los sonidos en cola siguen. */
function stopMediaForScreen(scr) {
  const screen = Number(scr) || 0;
  const matches = (p) => !screen || (Number(p?.screen) || 1) === screen;
  mediaQueue = mediaQueue.filter((it) => !(it.kind === 'video' && matches(it.payload)));
  if (queueBusy && currentItem?.kind === 'video' && matches(currentItem.payload)) {
    stopVideoLayer();
    const done = currentDone;
    currentDone = null;
    done?.();
  } else if (!queueBusy) {
    // Modo sin cola: no sabemos la pantalla del video actual; conservar el comportamiento anterior.
    stopVideoLayer();
  }
}

function playActionAnimNow(media, done) {
  if (!media?.url) { done?.(); return; }
  clearMediaTimers();
  videoLayer.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'action-anim';
  const url = media.url;
  const isImg = media.kind === 'image' || /\.(gif|png|jpe?g|webp)(\?|$)/i.test(url);
  let el;
  const finish = () => {
    try { wrap.remove(); } catch {}
    done?.();
  };
  if (isImg) {
    el = document.createElement('img');
    el.src = url;
    el.onload = () => { activeDoneTimer = setTimeout(finish, 6000); };
    el.onerror = finish;
  } else {
    el = document.createElement('video');
    bindLocalVideo(el, media, finish);
  }
  el.className = 'media';
  wrap.appendChild(el);
  const nick = String(media.nickname || '').trim();
  if (nick) {
    const tag = document.createElement('div');
    tag.className = 'action-anim-tag';
    tag.textContent = nick;
    wrap.appendChild(tag);
  }
  videoLayer.appendChild(wrap);
}

let overlayTtsAudio = null;

function cancelOverlaySpeech() {
  try { window.speechSynthesis?.cancel(); } catch { /* ignore */ }
  try {
    if (overlayTtsAudio) {
      overlayTtsAudio.onended = null;
      overlayTtsAudio.onerror = null;
      overlayTtsAudio.pause();
      overlayTtsAudio.src = '';
      overlayTtsAudio = null;
    }
  } catch { /* ignore */ }
}

function pickSpanishVoice() {
  const list = (typeof speechSynthesis !== 'undefined' && speechSynthesis.getVoices()) || [];
  return list.find((v) => /es[-_]MX/i.test(v.lang))
    || list.find((v) => /es[-_]ES/i.test(v.lang))
    || list.find((v) => /^es/i.test(v.lang))
    || null;
}

function pickOverlayVoice(want) {
  const list = (typeof speechSynthesis !== 'undefined' && speechSynthesis.getVoices()) || [];
  const name = String(want || '');
  if (name) {
    const hit = list.find((v) => v.name === name || v.voiceURI === name);
    if (hit) return hit;
  }
  return pickSpanishVoice();
}

function speakOverlayTts(text, done, opts = {}) {
  if (!String(text || '').trim()) { done?.(); return; }
  const rate = Math.max(0.5, Math.min(2, Number(opts.rate) || 1));
  let once = false;
  const end = () => { if (once) return; once = true; done?.(); };

  const playData = (b64, mime) => {
    cancelOverlaySpeech();
    const audio = new Audio('data:' + (mime || 'audio/mpeg') + ';base64,' + b64);
    if (Math.abs(rate - 1) > 0.02) audio.playbackRate = rate;
    overlayTtsAudio = audio;
    audio.onended = end;
    audio.onerror = end;
    audio.play().catch(end);
  };

  if (opts.audio) { playData(opts.audio, opts.mime); return; }

  const playSys = () => {
    if (typeof speechSynthesis === 'undefined') { end(); return; }
    const start = () => {
      cancelOverlaySpeech();
      const u = new SpeechSynthesisUtterance(String(text));
      u.lang = 'es-MX';
      u.rate = rate;
      u.pitch = 1;
      const voice = pickOverlayVoice(opts.voice);
      if (voice) {
        u.voice = voice;
        u.lang = voice.lang || 'es-MX';
      }
      u.onend = end;
      u.onerror = end;
      try { speechSynthesis.speak(u); } catch { end(); }
    };
    const voices = speechSynthesis.getVoices();
    if (voices && voices.length) { start(); return; }
    const t = setTimeout(start, 280);
    try {
      speechSynthesis.addEventListener('voiceschanged', () => { clearTimeout(t); start(); }, { once: true });
    } catch { start(); }
  };
  playSys();
}

function playActionAlertNow(p, done) {
  const text = String(p?.text || '').trim();
  if (!text) { done?.(); return; }
  videoLayer.innerHTML = '';
  cancelOverlaySpeech();
  const wrap = document.createElement('div');
  wrap.className = 'action-alert';
  const nick = String(p.nickname || '').trim();
  const photo = String(p.photo || '').trim();
  const av = photo
    ? `<img class="action-alert-av" src="${esc(photo)}" alt="">`
    : `<div class="action-alert-ph" aria-hidden="true"><svg viewBox="0 0 80 80"><circle cx="40" cy="40" r="40" fill="#d0d4dc"/><circle cx="40" cy="30" r="14" fill="#8b93a3"/><path d="M14 70c4-16 14-24 26-24s22 8 26 24" fill="#8b93a3"/></svg></div>`;
  const who = nick
    ? `<div class="action-alert-who">${[...nick].map((ch, i) => (
      ch === ' '
        ? '<span class="action-alert-sp"> </span>'
        : `<span class="action-alert-ch" style="--i:${i}">${esc(ch)}</span>`
    )).join('')}</div>`
    : '';
  wrap.innerHTML = `
    <div class="action-alert-card">
      ${av}
      ${who}
      <div class="action-alert-text">${esc(text)}</div>
    </div>`;
  videoLayer.appendChild(wrap);
  let finished = false;
  const FADE_MS = 1100;
  const finish = () => {
    if (finished) return;
    finished = true;
    cancelOverlaySpeech();
    try { wrap.remove(); } catch { /* ignore */ }
    done?.();
  };
  const startFade = () => {
    wrap.classList.add('is-out');
    activeDoneTimer = setTimeout(finish, FADE_MS);
  };
  const holdUntil = Date.now() + 6000;
  const wrapUp = () => {
    if (activeDoneTimer) { clearTimeout(activeDoneTimer); activeDoneTimer = null; }
    const wait = Math.max(400, holdUntil - Date.now());
    activeDoneTimer = setTimeout(startFade, wait);
  };
  activeDoneTimer = setTimeout(finish, 20000);
  if (p.playTTS) speakOverlayTts(text, wrapUp, { voice: p.voice, rate: p.rate, audio: p.audio, mime: p.mime });
  else wrapUp();
}

const ABSOLUTE_MAX_MS = 180000;
const STALL_LIMIT = 12;
let mediaTimers = new Set();
function addMediaTimer(fn, ms) {
  const id = setTimeout(() => {
    mediaTimers.delete(id);
    try { fn(); } catch { /* ignore */ }
  }, ms);
  mediaTimers.add(id);
  return id;
}
function clearMediaTimers() {
  mediaTimers.forEach((id) => clearTimeout(id));
  mediaTimers.clear();
}

function bindLocalVideo(el, media, finish) {
  const url = media.url;
  el.src = url;
  el.autoplay = true;
  el.playsInline = true;
  el.preload = 'auto';
  el.setAttribute('playsinline', '');
  applyMediaVolume(el, media.volume);

  let errorRetries = 0;
  let lastTime = -1;
  let stalledSecs = 0;
  let finished = false;
  const alive = () => !finished && el.isConnected && !el.dataset.stopped;
  const done = () => {
    if (finished) return;
    finished = true;
    clearMediaTimers();
    finish?.();
  };
  const safePlay = () => {
    if (!alive()) return;
    try {
      const p = el.play && el.play();
      if (p && typeof p.catch === 'function') {
        p.catch(() => {
          if (!alive()) return;
          try { el.muted = true; } catch { /* ignore */ }
          try { el.play && el.play().catch(() => {}); } catch { /* ignore */ }
        });
      }
    } catch { /* ignore */ }
  };

  el.onended = () => { if (alive()) done(); };
  el.onpause = () => {
    if (!alive() || el.ended) return;
    const nearEnd = el.duration && el.currentTime >= el.duration - 0.4;
    if (!nearEnd) safePlay();
    if (nearEnd) addMediaTimer(() => { if (alive() && !el.ended) done(); }, 1500);
  };
  el.onerror = () => {
    if (!alive()) return;
    if (errorRetries >= 3) { done(); return; }
    errorRetries += 1;
    const resumeAt = el.currentTime || 0;
    try {
      el.load();
      el.addEventListener('loadedmetadata', () => {
        if (!alive()) return;
        applyMediaVolume(el, media.volume);
        try {
          if (resumeAt > 0 && resumeAt < (el.duration || Infinity)) el.currentTime = resumeAt;
        } catch { /* ignore */ }
        safePlay();
      }, { once: true });
    } catch { done(); }
  };
  el.onloadedmetadata = () => {
    if (!alive()) return;
    applyMediaVolume(el, media.volume);
    const d = Number(el.duration);
    if (Number.isFinite(d) && d > 0) {
      addMediaTimer(() => { if (alive()) done(); }, d * 1000 + 2000);
    }
  };
  const watch = () => {
    if (!alive()) return;
    const t = el.currentTime || 0;
    if (t > lastTime + 0.05) {
      lastTime = t;
      stalledSecs = 0;
    } else {
      stalledSecs += 1;
      const nearEnd = el.duration && el.currentTime >= el.duration - 0.4;
      if (el.paused && !el.ended && !nearEnd) safePlay();
      if (nearEnd && stalledSecs >= 2) { done(); return; }
    }
    if (stalledSecs >= STALL_LIMIT) { done(); return; }
    addMediaTimer(watch, 1000);
  };
  addMediaTimer(watch, 1000);
  addMediaTimer(() => { if (alive()) done(); }, ABSOLUTE_MAX_MS);
  safePlay();
}

function playVideoNow(media, done) {
  if (!media?.url) { done?.(); return; }
  clearMediaTimers();
  videoLayer.innerHTML = '';
  const url = media.url;
  const isImg = /\.(gif|png|jpe?g|webp)(\?|$)/i.test(url);
  let el;
  if (isImg) {
    el = document.createElement('img');
    el.src = url;
    const finish = () => { try { el.remove(); } catch {} done?.(); };
    el.onload = () => { addMediaTimer(finish, 6000); };
    el.onerror = finish;
  } else {
    el = document.createElement('video');
    const finish = () => { try { el.remove(); } catch {} done?.(); };
    bindLocalVideo(el, media, finish);
  }
  el.className = 'media';
  videoLayer.appendChild(el);
}

function stopVideoLayer() {
  cancelOverlaySpeech();
  clearMediaTimers();
  videoLayer.querySelectorAll('video').forEach((vid) => {
    try { vid.dataset.stopped = '1'; vid.pause(); vid.muted = true; vid.removeAttribute('src'); vid.load(); } catch {}
  });
  videoLayer.innerHTML = '';
}

/* ----- Alertas sonoras ----- */
const playingSounds = new Set();

function playSoundNow(s, done) {
  if (!s?.sound) { done?.(); return; }
  const audio = makeSoundAudio(s.sound);
  applyMediaVolume(audio, s.volume);
  playingSounds.add(audio);
  let finished = false;
  const finish = () => { if (finished) return; finished = true; playingSounds.delete(audio); done?.(); };
  audio.onended = finish;
  audio.onerror = finish;
  audio.play().catch(() => {});
  // Límite de seguridad por si el audio nunca dispara 'ended'
  activeDoneTimer = setTimeout(finish, 20000);
  // Con la duración real: los sonidos de >20 s ya no avanzan la cola antes de tiempo.
  audio.onloadedmetadata = () => {
    const d = Number(audio.duration);
    if (Number.isFinite(d) && d > 0) {
      clearTimeout(activeDoneTimer);
      activeDoneTimer = setTimeout(finish, d * 1000 + 2000);
    }
  };

  if (s.image) {
    const el = document.createElement('img');
    el.src = s.image;
    el.className = 'media';
    videoLayer.innerHTML = '';
    videoLayer.appendChild(el);
    setTimeout(() => el.remove(), 5000);
  }
}

function stopAllSounds() {
  playingSounds.forEach((a) => { try { a.pause(); a.currentTime = 0; } catch {} });
  playingSounds.clear();
  videoLayer.innerHTML = '';
}

function avatar(u) {
  if (u.photo) return `<img class="av" src="${esc(u.photo)}" />`;
  return `<div class="ph">${(u.nickname || '?').charAt(0).toUpperCase()}</div>`;
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

connectWS();
