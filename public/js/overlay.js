const alertsEl = document.getElementById('alerts');
const videoLayer = document.getElementById('videoLayer');
const MAX_ALERTS = 5;

let ws, reconnectTimer;
let settings = { alerts: { gift: true, follow: true, share: true, like: false, member: false, minDiamonds: 1, duration: 5 } };

function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws${location.search}`);
  ws.onopen = () => clearTimeout(reconnectTimer);
  ws.onclose = () => { reconnectTimer = setTimeout(connectWS, 1500); };
  ws.onmessage = (ev) => {
    const { type, payload } = JSON.parse(ev.data);
    if (type === 'settings') { settings = payload; return; }
    if (type === 'media') { if (!payload.screenTest) enqueue({ kind: 'video', payload }); return; }
    if (type === 'stopMedia') { clearQueue(); stopVideoLayer(); return; }
    if (type === 'sound') { enqueue({ kind: 'sound', payload }); return; }
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

function queueOn() { return settings?.playback?.playQueue !== false; }

function enqueue(item) {
  if (!queueOn()) {
    // Modo sin cola: comportamiento directo (puede solaparse / cortar como antes)
    if (item.kind === 'video') playVideoNow(item.payload, null);
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
  const done = () => {
    if (activeDoneTimer) { clearTimeout(activeDoneTimer); activeDoneTimer = null; }
    if (!queueBusy) return;
    queueBusy = false;
    pump();
  };
  if (item.kind === 'video') playVideoNow(item.payload, done);
  else playSoundNow(item.payload, done);
}

function clearQueue() {
  mediaQueue = [];
  queueBusy = false;
  if (activeDoneTimer) { clearTimeout(activeDoneTimer); activeDoneTimer = null; }
}

function playVideoNow(media, done) {
  if (!media?.url) { done?.(); return; }
  videoLayer.innerHTML = '';
  const url = media.url;
  const isImg = /\.(gif|png|jpe?g|webp)(\?|$)/i.test(url);
  let el;
  if (isImg) {
    el = document.createElement('img');
    el.src = url;
    const finish = () => { el.remove(); done?.(); };
    el.onload = () => { activeDoneTimer = setTimeout(finish, 6000); };
    el.onerror = finish;
  } else {
    el = document.createElement('video');
    el.src = url;
    el.autoplay = true;
    el.muted = false;
    const finish = () => { try { el.remove(); } catch {} done?.(); };
    el.onended = finish;
    el.onerror = finish;
    activeDoneTimer = setTimeout(finish, 30000); // límite de seguridad
  }
  el.className = 'media';
  videoLayer.appendChild(el);
}

function stopVideoLayer() {
  videoLayer.querySelectorAll('video').forEach((vid) => {
    try { vid.pause(); vid.muted = true; vid.removeAttribute('src'); vid.load(); } catch {}
  });
  videoLayer.innerHTML = '';
}

/* ----- Alertas sonoras ----- */
const playingSounds = new Set();

function playSoundNow(s, done) {
  if (!s?.sound) { done?.(); return; }
  const audio = new Audio(s.sound);
  audio.volume = (s.volume ?? 100) / 100;
  playingSounds.add(audio);
  let finished = false;
  const finish = () => { if (finished) return; finished = true; playingSounds.delete(audio); done?.(); };
  audio.onended = finish;
  audio.onerror = finish;
  audio.play().catch(() => {});
  // Límite de seguridad por si el audio nunca dispara 'ended'
  activeDoneTimer = setTimeout(finish, 20000);

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
