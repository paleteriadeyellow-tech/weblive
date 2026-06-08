const $ = (id) => document.getElementById(id);
const MAX_ROWS = 120;

let ws;
let reconnectTimer;
let settings = null;       // copia local de los ajustes del servidor
let applyingSettings = false; // evita loops al rellenar los controles

/* ====================== WebSocket ====================== */
// Mantiene la conexión SIEMPRE viva, incluso con la pestaña minimizada o en segundo
// plano. Los navegadores ralentizan setTimeout/setInterval en pestañas ocultas, así que
// usamos un Web Worker (no se ralentiza) como "latido" para reconectar al instante si la
// conexión se cae, y reconectamos también al volver a la pestaña o recuperar la red.
let keepWorker = null;

function buildKeepAliveWorker() {
  if (keepWorker) return keepWorker;
  try {
    const code = 'setInterval(function(){ postMessage(1); }, 5000);';
    const blob = new Blob([code], { type: 'application/javascript' });
    keepWorker = new Worker(URL.createObjectURL(blob));
    keepWorker.onmessage = () => {
      // El worker late aunque la pestaña esté oculta: si el WS está cerrado, reconecta ya.
      if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
        connectWS();
      } else if (ws.readyState === WebSocket.OPEN) {
        try { ws.send('{"action":"ping"}'); } catch {}
      }
    };
  } catch { keepWorker = null; }
  return keepWorker;
}

function connectWS() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => { clearTimeout(reconnectTimer); setConnBadge(true); buildKeepAliveWorker(); };
  ws.onclose = () => { setConnBadge(false); clearTimeout(reconnectTimer); reconnectTimer = setTimeout(connectWS, 1500); };
  ws.onerror = () => { try { ws.close(); } catch {} };
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    const { type, payload } = msg;
    if (type === 'pong') return; // respuesta al ping de keepalive
    if (type === 'accountPending') { location.href = '/'; return; } // cuenta desactivada por el admin
    handle(type, payload);
  };
}

// Reconexión inmediata al volver a la pestaña o al recuperar la conexión de red.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') connectWS();
});
window.addEventListener('focus', connectWS);
window.addEventListener('online', connectWS);
window.addEventListener('pageshow', connectWS);

function setConnBadge(on) {
  ['jar-conn', 'vaq-conn', 'mar-conn', 'top-conn', 'gvs-conn', 'gsq-conn', 'tgf-conn', 'tst-conn', 'bgf-conn', 'bli-conn', 'cm-conn', 'tlk-conn', 'tdm-conn', 'tll-conn', 'tdl-conn', 'hyp-conn', 'agf-conn', 'alk-conn', 'afl-conn', 'sjn-conn'].forEach((id) => {
    const el = $(id);
    if (!el) return;
    el.classList.toggle('off', !on);
    el.lastChild.textContent = on ? ' CONECTADO' : ' DESCONECTADO';
  });
}

function send(obj) { if (ws?.readyState === 1) ws.send(JSON.stringify(obj)); }

/* ====================== Sesión / room del usuario ====================== */
// Cada usuario tiene una "roomKey" que sus overlays de OBS deben llevar en la URL
// (?room=KEY) para conectarse a SU room. El panel se identifica por la cookie de sesión.
window.ROOM_KEY = '';
window.MY_USER = '';
window.IS_ADMIN = false;

async function loadMe() {
  try {
    const r = await fetch('/api/me');
    if (!r.ok) { location.href = '/login.html'; return; }
    const d = await r.json();
    window.ROOM_KEY = d.roomKey || '';
    window.MY_USER = d.username || '';
    window.IS_ADMIN = !!d.isAdmin;
    window.MY_PLAN = d.plan || 'free';
    if (d.caps) setCaps(d.caps);
    // Si la cuenta dejó de estar activa, vuelve a la pantalla de espera.
    if (!d.active) { location.href = '/'; return; }
    if (window.IS_ADMIN) {
      const nav = document.getElementById('navAdmin');
      if (nav) nav.style.display = '';
    }
  } catch {}
}

/* ====================== Planes / capacidades ====================== */
// Mapa overlay path -> clave de capacidad (debe coincidir con plans.js).
const OVERLAY_CAP = {
  '/join-live.html': 'ov_joinlive', '/overlay.html': 'ov_alertvideo',
  '/jarron.html': 'ov_jarron', '/vaquita.html': 'ov_vaquita', '/marranito.html': 'ov_marranito',
  '/topdonor.html': 'ov_topdonor', '/giftvs.html': 'ov_giftvs', '/giftseq.html': 'ov_giftseq',
  '/mejorregalo.html': 'ov_mejorregalo', '/mejorracha.html': 'ov_mejorracha',
  '/batallaregalos.html': 'ov_batallaregalos', '/batallalikes.html': 'ov_batallalikes',
  '/coinmatch.html': 'ov_coinmatch', '/meta.html': 'ov_meta',
  '/toplikes.html': 'ov_toplikes', '/topdiamantes.html': 'ov_topdiamantes',
  '/toplikes-lista.html': 'ov_toplikeslista', '/topdiamantes-lista.html': 'ov_topdiamanteslista',
  '/alerta-regalo.html': 'ov_alertaregalo', '/alerta-likes.html': 'ov_alertalikes',
  '/alerta-seguidor.html': 'ov_alertaseguidor', '/timer.html': 'ov_timer',
};
// Mapa pestaña (data-view) -> clave de capacidad.
const TAB_CAP = {
  alertas: 'tab_alertas', videos: 'tab_videos', batallas: 'tab_batallas',
  overlays: 'tab_overlays', tts: 'tab_tts', timer: 'tab_timer',
};

window.CAPS = { plan: 'free', limits: {}, features: {} };
function setCaps(c) {
  if (!c) return;
  window.CAPS = {
    plan: c.plan || window.MY_PLAN || 'free',
    limits: c.limits || {},
    features: c.features || {},
  };
  applyCaps();
}
function capLimit(key) {
  const n = window.CAPS?.limits?.[key];
  return Number.isFinite(n) ? n : Infinity;
}
function capFeature(key) {
  const f = window.CAPS?.features;
  if (!f) return true;            // sin info -> permitir (admin / aún cargando)
  return f[key] !== false;
}
function planCountOf(kind) {
  return (settings?.[kind] || []).length;
}
// Devuelve true si todavía se puede añadir; si no, avisa y devuelve false.
function ensureCanAdd(kind, limitKey, nounPlural) {
  const lim = capLimit(limitKey);
  if (planCountOf(kind) >= lim) {
    toast(`Tu plan ${window.CAPS.plan === 'premium' ? 'Premium' : 'Gratis'} permite hasta ${lim} ${nounPlural}.`, 'warn');
    return false;
  }
  return true;
}

// Aplica las capacidades a la interfaz: oculta pestañas/overlays bloqueados,
// muestra avisos de límite y desactiva botones de "crear" si se llegó al tope.
function applyCaps() {
  if (window.IS_ADMIN) return; // el admin lo ve todo
  // Pestañas del menú lateral
  document.querySelectorAll('.nav-item[data-view]').forEach((btn) => {
    const cap = TAB_CAP[btn.dataset.view];
    if (cap) btn.style.display = capFeature(cap) ? '' : 'none';
  });
  // Overlays individuales: si no están en el plan, NO se ocultan; se muestran con
  // un bloqueo "Solo Premium" por encima (la tarjeta sigue visible pero no usable).
  document.querySelectorAll('.ov-url[data-path]').forEach((code) => {
    const base = String(code.dataset.path).split('?')[0];
    const cap = OVERLAY_CAP[base];
    if (!cap) return;
    const card = code.closest('.ovpro-card') || code.closest('.overlay-item') || code.closest('.ov-card');
    if (card) setOverlayLock(card, !capFeature(cap));
  });
  // Voces TikTok/Disney en el TTS
  const tkRow = document.getElementById('tts-tiktok-voices-wrap');
  if (tkRow) tkRow.style.display = capFeature('tts_tiktok') ? '' : 'none';
  if (!capFeature('tts_tiktok')) {
    const sel = document.getElementById('tts-tiktok-voice');
    if (sel && sel.value) { sel.value = ''; }
  }
  // Avisos de límite + botones de crear
  applyLimitUI();
  renderPlanView();
}

/* ---- Vista "Planes" (lo que ve el usuario sobre su plan) ---- */
const CAP_LABELS = {
  // pestañas
  tab_alertas: 'Alertas sonoras', tab_videos: 'Videos', tab_batallas: 'Batallas PK',
  tab_overlays: 'Overlays', tab_tts: 'Chat TTS (voz)', tab_timer: 'Temporizador',
  // overlays
  ov_joinlive: 'Join al live', ov_alertvideo: 'Alertas + Videos', ov_jarron: 'Jarrón',
  ov_vaquita: 'Vaquita', ov_marranito: 'Marranito', ov_topdonor: 'Top donador semanal',
  ov_giftvs: 'Gift VS', ov_giftseq: 'Gift Sequence', ov_mejorregalo: 'Mejor regalo',
  ov_mejorracha: 'Mejor racha', ov_batallaregalos: 'Batalla de regalos', ov_batallalikes: 'Batalla de likes',
  ov_coinmatch: 'Coin Match', ov_meta: 'Barra de meta (Hype)', ov_toplikes: 'Top likes',
  ov_topdiamantes: 'Top diamantes', ov_toplikeslista: 'Ranking likes (lista)',
  ov_topdiamanteslista: 'Ranking diamantes (lista)', ov_alertaregalo: 'Alerta de regalo',
  ov_alertalikes: 'Alerta de likes', ov_alertaseguidor: 'Alerta de nuevo seguidor', ov_timer: 'Temporizador (overlay)',
  // extras
  tts_tiktok: 'Voces TikTok / Disney',
};
const PLAN_FEATURE_ORDER = [
  'tab_alertas', 'tab_videos', 'tab_batallas', 'tab_overlays', 'tab_tts', 'tab_timer',
  'tts_tiktok',
  'ov_joinlive', 'ov_alertvideo', 'ov_jarron', 'ov_vaquita', 'ov_marranito', 'ov_topdonor',
  'ov_giftvs', 'ov_giftseq', 'ov_mejorregalo', 'ov_mejorracha', 'ov_batallaregalos', 'ov_batallalikes',
  'ov_coinmatch', 'ov_meta', 'ov_toplikes', 'ov_topdiamantes', 'ov_toplikeslista', 'ov_topdiamanteslista',
  'ov_alertaregalo', 'ov_alertalikes', 'ov_alertaseguidor', 'ov_timer',
];

function renderPlanView() {
  const hero = document.getElementById('plan-hero');
  if (!hero) return;
  const isPremium = window.IS_ADMIN || window.CAPS.plan === 'premium';

  hero.classList.toggle('is-premium', isPremium);
  const badge = document.getElementById('plan-badge');
  if (badge) {
    badge.textContent = window.IS_ADMIN ? '★ Admin' : (isPremium ? '⭐ Premium' : 'Gratis');
    badge.className = 'plan-badge ' + (isPremium ? 'premium' : 'free');
  }
  const u = document.getElementById('plan-hero-user');
  if (u) u.textContent = '@' + (window.MY_USER || 'usuario');
  const name = document.getElementById('plan-hero-name');
  if (name) name.textContent = window.IS_ADMIN ? 'Administrador' : (isPremium ? 'Plan Premium' : 'Plan Gratis');
  const desc = document.getElementById('plan-hero-desc');
  if (desc) {
    desc.textContent = window.IS_ADMIN
      ? 'Tienes acceso total a todas las funciones y sin límites.'
      : (isPremium
          ? '¡Tienes todo desbloqueado! Disfruta de límites ampliados y todas las funciones.'
          : 'Estás en el plan gratuito. Mejora a Premium para desbloquear más alertas, overlays y funciones.');
  }
  const up = document.getElementById('plan-upgrade');
  if (up) up.style.display = (!isPremium && !window.IS_ADMIN) ? '' : 'none';

  // Medidores de límites
  const meters = document.getElementById('plan-meters');
  if (meters) {
    const rows = [
      { kind: 'soundAlerts', key: 'soundAlerts', noun: 'Alertas sonoras' },
      { kind: 'videos', key: 'videos', noun: 'Videos' },
      { kind: 'battleAlerts', key: 'battleAlerts', noun: 'Animaciones de batalla' },
    ];
    meters.innerHTML = rows.map((r) => {
      let lim = capLimit(r.key);
      const unlimited = window.IS_ADMIN || !Number.isFinite(lim) || lim >= 9999;
      const count = planCountOf(r.kind);
      const pct = unlimited ? Math.min(100, count ? 18 : 6) : Math.min(100, lim ? (count / lim) * 100 : 100);
      const full = !unlimited && count >= lim;
      const valTxt = unlimited ? `${count} · ilimitado` : `${count} / ${lim}`;
      const valCls = unlimited ? 'unlim' : (full ? 'full' : '');
      return `<div class="plan-meter">
        <div class="plan-meter-top">
          <span class="plan-meter-name">${r.noun}</span>
          <span class="plan-meter-val ${valCls}">${valTxt}</span>
        </div>
        <div class="plan-bar ${full ? 'full' : ''}"><i style="width:${pct}%"></i></div>
      </div>`;
    }).join('');
  }

  // Lista de características incluidas / no incluidas
  const list = document.getElementById('plan-feature-list');
  if (list) {
    list.innerHTML = PLAN_FEATURE_ORDER.map((key) => {
      const label = CAP_LABELS[key] || key;
      const on = window.IS_ADMIN || capFeature(key);
      return `<div class="plan-feat-item ${on ? 'on' : 'off'}">
        <span class="pf-ico">${on ? '✓' : '✕'}</span><span>${label}</span>
      </div>`;
    }).join('');
  }

  renderPlanCompare();
}

/* ---- Comparación Gratis vs Premium (qué incluye cada plan) ---- */
let planCompareData = null;
let planCompareLoading = false;

async function loadPlanComparison(force) {
  if (planCompareLoading) return;
  if (planCompareData && !force) { renderPlanCompare(); return; }
  planCompareLoading = true;
  try {
    const r = await fetch('/api/plans');
    if (r.ok) planCompareData = await r.json();
  } catch {}
  planCompareLoading = false;
  renderPlanCompare();
}

function renderPlanCompare() {
  const body = document.getElementById('plan-compare-body');
  if (!body) return;
  if (!planCompareData) { loadPlanComparison(); return; }
  const { catalog, config } = planCompareData;
  const free = config.free || { limits: {}, features: {} };
  const prem = config.premium || { limits: {}, features: {} };
  const mine = (window.IS_ADMIN || window.CAPS.plan === 'premium') ? 'premium' : 'free';

  // Marca la columna del plan del usuario
  const th = document.querySelectorAll('#plan-compare thead th');
  if (th[1]) th[1].classList.toggle('mine', mine === 'free');
  if (th[2]) th[2].classList.toggle('mine', mine === 'premium');

  const numCell = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n >= 9999) return '<span class="pc-yes">Ilimitado</span>';
    if (n <= 0) return '<span class="pc-no">—</span>';
    return `<span class="pc-num">${n}</span>`;
  };
  const boolCell = (v) => (v !== false ? '<span class="pc-yes">✓</span>' : '<span class="pc-no">✕</span>');

  let html = '';
  // Límites
  html += `<tr class="pc-group"><td colspan="3">Límites (cantidad)</td></tr>`;
  for (const c of catalog.limits) {
    html += `<tr><td>${c.label}</td>
      <td class="col-free">${numCell(free.limits?.[c.key])}</td>
      <td class="col-premium">${numCell(prem.limits?.[c.key])}</td></tr>`;
  }
  const group = (title, items) => {
    let h = `<tr class="pc-group"><td colspan="3">${title}</td></tr>`;
    for (const c of items) {
      h += `<tr><td>${c.label}</td>
        <td class="col-free">${boolCell(free.features?.[c.key])}</td>
        <td class="col-premium">${boolCell(prem.features?.[c.key])}</td></tr>`;
    }
    return h;
  };
  html += group('Pestañas del panel', catalog.tabs);
  html += group('Extras', catalog.extras);
  html += group('Overlays', catalog.overlays);
  body.innerHTML = html;

  renderPlanPricing();
}

/* ---- Tarjetas de precios: Gratis y Premium (con botón comprar) ---- */
function renderPlanPricing() {
  const wrap = document.getElementById('plan-pricing');
  if (!wrap || !planCompareData) return;
  const { catalog, config } = planCompareData;
  const mine = (window.IS_ADMIN || window.CAPS.plan === 'premium') ? 'premium' : 'free';

  const li = (on, text) =>
    `<li class="${on ? 'pp-on' : 'pp-off'}"><span class="pp-ck">${on ? '✓' : '✕'}</span><span>${text}</span></li>`;

  const buildList = (planKey) => {
    const p = config[planKey] || { limits: {}, features: {} };
    const items = [];
    // Límites (cantidades)
    for (const c of catalog.limits) {
      const n = Number(p.limits?.[c.key]);
      const unlimited = !Number.isFinite(n) || n >= 9999;
      const label = c.label.replace(/\s*\(.*?\)\s*/g, '');
      if (unlimited) items.push(li(true, `${label}: <b>ilimitadas</b>`));
      else if (n <= 0) items.push(li(false, `${label}: no incluido`));
      else items.push(li(true, `Hasta <b>${n}</b> · ${label.toLowerCase()}`));
    }
    // Pestañas
    const tabsOn = catalog.tabs.filter((c) => p.features?.[c.key] !== false).length;
    const tabsTotal = catalog.tabs.length;
    items.push(li(tabsOn > 0, tabsOn >= tabsTotal ? 'Todas las secciones del panel' : `${tabsOn} de ${tabsTotal} secciones del panel`));
    // Overlays
    const ovOn = catalog.overlays.filter((c) => p.features?.[c.key] !== false).length;
    const ovTotal = catalog.overlays.length;
    items.push(li(ovOn > 0, ovOn >= ovTotal ? `Los <b>${ovTotal}</b> overlays para OBS` : `<b>${ovOn}</b> de ${ovTotal} overlays para OBS`));
    // Extras
    for (const c of catalog.extras) {
      items.push(li(p.features?.[c.key] !== false, c.label));
    }
    return items.join('');
  };

  const freeCurrent = mine === 'free';
  const premCurrent = mine === 'premium';

  const freeBtn = freeCurrent
    ? '<button class="pp-btn current" disabled>Tu plan actual</button>'
    : '<button class="pp-btn ghost" disabled>Incluido</button>';
  const premBtn = premCurrent
    ? '<button class="pp-btn current" disabled>Tu plan actual</button>'
    : '<button class="pp-btn buy" id="pp-buy">Comprar Premium ⭐</button>';

  wrap.innerHTML = `
    <div class="pp-card free ${freeCurrent ? 'is-mine' : ''}">
      ${freeCurrent ? '<span class="pp-tag">TU PLAN</span>' : ''}
      <div class="pp-head">
        <div class="pp-name">🆓 Plan Gratis</div>
        <div class="pp-price">$0<small>/ siempre</small></div>
      </div>
      <p class="pp-tagline">Para empezar a transmitir con lo esencial.</p>
      <ul class="pp-list">${buildList('free')}</ul>
      ${freeBtn}
    </div>
    <div class="pp-card premium ${premCurrent ? 'is-mine' : ''}">
      <span class="pp-tag gold">⭐ RECOMENDADO</span>
      <div class="pp-head">
        <div class="pp-name">⭐ Plan Premium</div>
        <div class="pp-price">$20 USD<small>/ mes · todo desbloqueado</small></div>
      </div>
      <p class="pp-tagline">Sin límites y con todos los overlays y funciones.</p>
      <ul class="pp-list">${buildList('premium')}</ul>
      ${premBtn}
    </div>
  `;

  const buyBtn = document.getElementById('pp-buy');
  if (buyBtn) buyBtn.onclick = () => {
    const msg = `Hola, quiero comprar el Plan Premium ($20 USD/mes) de Livecoins. Mi usuario es: ${window.MY_USER || ''}`;
    const url = 'https://wa.me/522202079474?text=' + encodeURIComponent(msg);
    window.open(url, '_blank', 'noopener');
  };
}

// Pone (o quita) una capa de bloqueo "Solo Premium" sobre la vista previa del overlay.
// Los botones de arriba (Testear, Reset, etc.) siguen funcionando para que puedan ver la demo.
function setOverlayLock(card, locked) {
  const target = card.querySelector('.ovpro-preview') || card;
  target.classList.toggle('ov-locked', locked);
  card.classList.toggle('ov-locked-card', locked);
  let ov = target.querySelector('.ov-lock-overlay');
  if (locked) {
    if (!ov) {
      ov = document.createElement('div');
      ov.className = 'ov-lock-overlay';
      ov.innerHTML = `<div class="ov-lock-box">
        <div class="ov-lock-ico">🔒</div>
        <div class="ov-lock-title">⭐ Solo Premium</div>
        <div class="ov-lock-sub">Pulsa <strong>Testear</strong> para ver la demo · Mejora tu plan para usarlo en OBS</div>
      </div>`;
      ov.addEventListener('click', (e) => {
        e.stopPropagation();
        toast('Este overlay es Solo Premium. Pulsa Testear para ver la demo ⭐', 'warn');
      });
      target.appendChild(ov);
    }
  } else if (ov) {
    ov.remove();
  }
}

function applyLimitUI() {
  const defs = [
    { kind: 'soundAlerts', key: 'soundAlerts', btn: 'sa-create', view: 'view-alertas', noun: 'alertas sonoras' },
    { kind: 'videos', key: 'videos', btn: 'vid-create', view: 'view-videos', noun: 'videos' },
    { kind: 'battleAlerts', key: 'battleAlerts', btn: 'ba-create', view: 'view-batallas', noun: 'animaciones de batalla' },
  ];
  for (const d of defs) {
    let lim = capLimit(d.key);
    if (window.IS_ADMIN || lim >= 9999) lim = Infinity; // ilimitado: sin aviso ni bloqueo
    const count = planCountOf(d.kind);
    const reached = count >= lim;
    const btn = document.getElementById(d.btn);
    if (btn) {
      btn.disabled = reached;
      btn.style.opacity = reached ? '.5' : '';
      btn.style.cursor = reached ? 'not-allowed' : '';
    }
    const view = document.getElementById(d.view);
    if (view) {
      let note = view.querySelector('.limit-note');
      if (Number.isFinite(lim)) {
        if (!note) {
          note = document.createElement('div');
          note.className = 'limit-note';
          const host = view.querySelector('.view-sub') || view.firstElementChild;
          if (host && host.nextSibling) host.parentNode.insertBefore(note, host.nextSibling);
          else view.insertBefore(note, view.children[1] || null);
        }
        note.textContent = `Plan ${window.CAPS.plan === 'premium' ? 'Premium' : 'Gratis'}: ${count}/${lim} ${d.noun}.` +
          (reached ? ' Has llegado al límite.' : '');
        note.style.display = '';
      } else if (note) {
        note.style.display = 'none';
      }
    }
  }
}

/* ====================== Toast ====================== */
function toast(msg, kind) {
  let wrap = document.querySelector('.toast-wrap');
  if (!wrap) { wrap = document.createElement('div'); wrap.className = 'toast-wrap'; document.body.appendChild(wrap); }
  const el = document.createElement('div');
  el.className = 'toast' + (kind === 'warn' ? ' warn' : '');
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(() => { el.style.transition = 'opacity .3s'; el.style.opacity = '0'; setTimeout(() => el.remove(), 320); }, 3200);
}

// Construye la URL de un overlay con la roomKey del usuario añadida.
function roomUrl(path) {
  const k = window.ROOM_KEY;
  const p = String(path || '');
  if (!k) return location.origin + p;
  return location.origin + p + (p.includes('?') ? '&' : '?') + 'room=' + encodeURIComponent(k);
}

// Refresca el texto y enlaces de todas las URLs de overlay ya pintadas.
function refreshOverlayUrls() {
  document.querySelectorAll('.ov-url').forEach((code) => {
    if (code.dataset.path) code.textContent = roomUrl(code.dataset.path);
  });
  document.querySelectorAll('.overlay-item').forEach((item) => {
    const code = item.querySelector('.ov-url');
    const a = item.querySelector('a');
    if (code && a && code.dataset.path) a.href = roomUrl(code.dataset.path);
  });
}

// Chip de usuario con botón de cerrar sesión (se inyecta en la barra lateral).
function mountUserChip() {
  if (document.getElementById('user-chip')) return;
  const chip = document.createElement('div');
  chip.id = 'user-chip';
  chip.style.cssText = 'display:flex;align-items:center;gap:6px;padding:7px 14px;font:600 11px system-ui,sans-serif;color:#9aa3b8';
  chip.innerHTML = `<span style="opacity:.85;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">👤 ${window.MY_USER || 'usuario'}</span>
    <button id="logout-btn" style="margin-left:auto;border:0;border-radius:6px;cursor:pointer;padding:3px 9px;font-weight:700;font-size:10.5px;color:#04121a;background:linear-gradient(90deg,#00e5ff,#ff2bd6)">Salir</button>`;
  // Colócalo dentro de la barra lateral, justo encima de la franja de estado ("Desconectado").
  const sideStatus = document.querySelector('.side-status');
  if (sideStatus && sideStatus.parentElement) {
    sideStatus.parentElement.insertBefore(chip, sideStatus);
  } else {
    document.body.appendChild(chip);
  }
  document.getElementById('logout-btn').onclick = async () => {
    try { await fetch('/api/logout', { method: 'POST' }); } catch {}
    location.href = '/login.html';
  };
}

/* ====================== Confirmación de borrado ====================== */
function askConfirm({ title = '¿Estás seguro?', message = '', confirmText = 'Borrar', cancelText = 'Cancelar' } = {}) {
  return new Promise((resolve) => {
    const back = document.createElement('div');
    back.className = 'modal confirm-modal';
    back.innerHTML = `
      <div class="confirm-box">
        <div class="confirm-ico">🗑️</div>
        <h3>${title}</h3>
        ${message ? `<p>${message}</p>` : ''}
        <div class="confirm-btns">
          <button class="btn ghost c-cancel">${cancelText}</button>
          <button class="btn danger c-ok">${confirmText}</button>
        </div>
      </div>`;
    document.body.appendChild(back);
    const close = (val) => { back.remove(); resolve(val); };
    back.querySelector('.c-cancel').onclick = () => close(false);
    back.querySelector('.c-ok').onclick = () => close(true);
    back.addEventListener('click', (e) => { if (e.target === back) close(false); });
    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape') { document.removeEventListener('keydown', esc); close(false); }
    });
    setTimeout(() => back.querySelector('.c-ok').focus(), 30);
  });
}

function handle(type, p) {
  switch (type) {
    case 'state': renderState(p); break;
    case 'settings': onSettings(p); break;
    case 'screens': onScreens(p); break;
    case 'chat': addChat(p); ttsSpeak(p); break;
    case 'gift': addGift(p); ttsOnGift(p); break;
    case 'like': ttsOnLike(p); break;
    case 'member': addEvent(`🙋 ${p.nickname} entró`, ''); break;
    case 'follow': addEvent(`➕ ${p.nickname} te siguió`, 'ok'); ttsOnFollow(p); break;
    case 'share': addEvent(`🔁 ${p.nickname} compartió el live`, 'ok'); ttsOnShare(p); break;
    case 'log': addEvent(p.text, p.level === 'ok' ? 'ok' : p.level === 'error' ? 'error' : ''); break;
    case 'sound': playPanelSound(p); break;
    case 'panic': stopPanelSounds(); break;
    case 'timer': renderTimerState(p); break;
    case 'timerBeep': break;
    case 'caps': setCaps(p); loadPlanComparison(true); break;
    case 'emoteCatalog':
      emoteCatalog = p.results || [];
      if (!$('emoteModal').classList.contains('hidden')) renderEmoteGrid();
      // Refresca los iconos solo si hay alertas/videos con sticker (para que ahora
      // muestren la imagen del sticker en vez del emoji), sin re-render innecesario.
      if (settings) {
        if ((settings.soundAlerts || []).some((a) => a.trigger === 'emote' && !a.emoteImage)) renderSoundAlerts();
        if ((settings.videos || []).some((v) => v.trigger === 'emote' && !v.emoteImage)) renderVideos();
      }
      break;
  }
}

/* ====================== Sonido en el panel ====================== */
// Con la cola activada, los sonidos del panel se reproducen uno tras otro (no se solapan).
const panelSounds = new Set();
let panelSoundQueue = [];
let panelSoundBusy = false;

function playPanelSound(s) {
  if (!s?.sound) return;
  const queueOn = settings?.playback?.playQueue !== false;
  if (!queueOn) { startPanelSound(s, null); return; }
  panelSoundQueue.push(s);
  pumpPanelSound();
}
function pumpPanelSound() {
  if (panelSoundBusy) return;
  const s = panelSoundQueue.shift();
  if (!s) return;
  panelSoundBusy = true;
  startPanelSound(s, () => { panelSoundBusy = false; pumpPanelSound(); });
}
function startPanelSound(s, done) {
  const audio = new Audio(s.sound);
  audio.volume = (s.volume ?? 100) / 100;
  panelSounds.add(audio);
  let finished = false;
  const finish = () => { if (finished) return; finished = true; panelSounds.delete(audio); done?.(); };
  audio.onended = finish;
  audio.onerror = () => { addEvent(`⚠️ No se pudo reproducir: ${s.name || s.sound}`, 'error'); finish(); };
  const safety = setTimeout(finish, 20000);
  audio.addEventListener('ended', () => clearTimeout(safety));
  audio.play().catch(() => {
    addEvent('🔇 El navegador bloqueó el audio. Haz clic en cualquier parte del panel para activarlo.', 'error');
    finish();
  });
}
function stopPanelSounds() {
  panelSoundQueue = [];
  panelSoundBusy = false;
  panelSounds.forEach((a) => { try { a.pause(); a.currentTime = 0; } catch {} });
  panelSounds.clear();
}

/* ====================== Navegación lateral ====================== */
document.querySelectorAll('.nav-item').forEach((btn) => {
  btn.onclick = () => {
    document.querySelectorAll('.nav-item').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
    btn.classList.add('active');
    $(`view-${btn.dataset.view}`).classList.add('active');
    if (btn.dataset.view === 'admin') { loadAdminUsers(); loadPlans(); }
    if (btn.dataset.view === 'planes') { renderPlanView(); loadPlanComparison(true); }
  };
});

/* ====================== Administración ====================== */
function fmtDateTime(ts) {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleString('es', {
      day: '2-digit', month: '2-digit', year: '2-digit',
      hour: '2-digit', minute: '2-digit',
    });
  } catch { return '—'; }
}

async function loadAdminUsers() {
  const tbody = document.getElementById('admin-tbody');
  const count = document.getElementById('admin-count');
  if (!tbody) return;
  try {
    const r = await fetch('/api/admin/users');
    if (!r.ok) { tbody.innerHTML = '<tr><td colspan="9" class="admin-empty">Sin acceso.</td></tr>'; return; }
    const { users } = await r.json();
    if (count) count.textContent = `${users.length} cuenta${users.length === 1 ? '' : 's'} registrada${users.length === 1 ? '' : 's'}`;
    if (!users.length) { tbody.innerHTML = '<tr><td colspan="9" class="admin-empty">No hay cuentas.</td></tr>'; return; }
    tbody.innerHTML = users.map((u) => {
      const conn = u.live ? fmtDateTime(u.liveSince) : fmtDateTime(u.lastLogin);
      // EN LIVE: solo muestra "LIVE" cuando está en directo (o "Conectando…"); si no, nada.
      const live = u.live
        ? '<span class="badge live dot">LIVE</span>'
        : (u.connecting ? '<span class="badge off dot">Conectando…</span>' : '<span class="tts-sub">—</span>');
      // CUENTA EN LIVE: el @usuario de TikTok al que se conectaron.
      const liveAccount = u.account
        ? `<span class="admin-acc">@${u.account}</span>`
        : '<span class="tts-sub">—</span>';
      // EN LÍNEA: verde si tiene el panel/overlay abierto ahora; si no, hace cuánto.
      const onlineCell = u.online
        ? '<span class="badge on dot">En línea</span>'
        : `<span class="tts-sub">${u.lastSeen ? 'hace ' + timeAgo(u.lastSeen) : '—'}</span>`;
      const estado = u.active
        ? '<span class="badge on">Activa</span>'
        : '<span class="badge off">Pendiente</span>';
      const adminTag = u.isAdmin ? '<span class="u-admin">ADMIN</span>' : '';
      const plan = u.isAdmin ? '<span class="badge prem">⭐ Premium</span>' : planBadge(u);
      const action = u.isAdmin
        ? '<span class="tts-sub">—</span>'
        : `<div class="admin-actions">
            ${u.active
              ? `<button class="btn tiny deactivate" data-id="${u.id}" data-active="0">Desactivar</button>`
              : `<button class="btn tiny activate" data-id="${u.id}" data-active="1">Activar</button>`}
            <div class="prem-ctl">
              <input type="number" class="prem-days" min="1" max="3650" placeholder="días" data-id="${u.id}">
              <button class="btn tiny prem-give" data-id="${u.id}">Dar Premium</button>
              <button class="btn tiny prem-fixed" data-id="${u.id}">Fijo</button>
              ${u.plan === 'premium' ? `<button class="btn tiny prem-remove" data-id="${u.id}">Quitar</button>` : ''}
            </div>
          </div>`;
      return `<tr>
        <td><span class="u-name">${u.username}</span>${adminTag}</td>
        <td>${conn}</td>
        <td><span class="admin-key">${u.roomKey || '—'}</span></td>
        <td>${liveAccount}</td>
        <td>${live}</td>
        <td>${onlineCell}</td>
        <td>${estado}</td>
        <td>${plan}</td>
        <td>${action}</td>
      </tr>`;
    }).join('');
    tbody.querySelectorAll('button[data-id]').forEach((b) => {
      b.onclick = async () => {
        b.disabled = true;
        try {
          await fetch('/api/admin/activate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: b.dataset.id, active: b.dataset.active === '1' }),
          });
        } catch {}
        loadAdminUsers();
      };
    });
    // Dar Premium por N días
    tbody.querySelectorAll('.prem-give').forEach((b) => {
      b.onclick = () => {
        const inp = tbody.querySelector(`.prem-days[data-id="${b.dataset.id}"]`);
        const days = Number(inp && inp.value);
        if (!Number.isFinite(days) || days < 1) { toast('Escribe cuántos días de Premium.', 'warn'); inp?.focus(); return; }
        setUserPlanReq(b.dataset.id, 'premium', days, `Premium activado por ${days} día${days === 1 ? '' : 's'}.`);
      };
    });
    // Premium fijo (sin caducidad)
    tbody.querySelectorAll('.prem-fixed').forEach((b) => {
      b.onclick = () => setUserPlanReq(b.dataset.id, 'premium', 0, 'Premium fijo activado.');
    });
    // Quitar Premium (volver a Gratis)
    tbody.querySelectorAll('.prem-remove').forEach((b) => {
      b.onclick = () => setUserPlanReq(b.dataset.id, 'free', 0, 'Premium retirado. Ahora es Gratis.');
    });
  } catch {
    tbody.innerHTML = '<tr><td colspan="9" class="admin-empty">Error al cargar.</td></tr>';
  }
}

// "hace X" en español a partir de un timestamp.
function timeAgo(ts) {
  if (!ts) return '—';
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return s <= 5 ? 'unos segundos' : `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h`;
  const d = Math.floor(h / 24);
  return `${d} día${d === 1 ? '' : 's'}`;
}

// Insignia de plan para la tabla de admin (con días restantes o "fijo").
function planBadge(u) {
  if (u.plan !== 'premium') return '<span class="badge off">Gratis</span>';
  if (u.premiumUntil && u.premiumUntil > 0) {
    const days = Math.max(0, Math.ceil((u.premiumUntil - Date.now()) / 86400000));
    return `<span class="badge prem">⭐ Premium · ${days}d</span>`;
  }
  return '<span class="badge prem">⭐ Premium · fijo</span>';
}

// Llama al endpoint de cambio de plan y refresca la tabla.
async function setUserPlanReq(id, plan, days, okMsg) {
  try {
    const r = await fetch('/api/admin/userplan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, plan, days }),
    });
    if (r.ok) toast(okMsg || 'Plan actualizado.');
    else toast('No se pudo cambiar el plan.', 'warn');
  } catch { toast('Error de conexión.', 'warn'); }
  loadAdminUsers();
}

const adminRefreshBtn = document.getElementById('admin-refresh');
if (adminRefreshBtn) adminRefreshBtn.onclick = loadAdminUsers;

const planUpgradeBtn = document.getElementById('plan-upgrade');
if (planUpgradeBtn) planUpgradeBtn.onclick = () => {
  toast('Contacta con el administrador para activar tu plan Premium ⭐');
};

/* -------- Editor de planes (límites y características por plan) -------- */
let plansCatalog = null;
let plansConfig = null;
let plansActiveTab = 'free';

async function loadPlans() {
  const editor = document.getElementById('plans-editor');
  if (!editor) return;
  try {
    const r = await fetch('/api/admin/plans');
    if (!r.ok) { editor.innerHTML = '<p class="tts-sub">Sin acceso.</p>'; return; }
    const d = await r.json();
    plansCatalog = d.catalog;
    plansConfig = d.config;
    renderPlansEditor();
  } catch {
    editor.innerHTML = '<p class="tts-sub">Error al cargar planes.</p>';
  }
}

function renderPlansEditor() {
  const editor = document.getElementById('plans-editor');
  if (!editor || !plansCatalog || !plansConfig) return;
  const plan = plansConfig[plansActiveTab] || { limits: {}, features: {} };
  const esc = (s) => String(s).replace(/"/g, '&quot;');

  const limitsHtml = plansCatalog.limits.map((c) => `
    <div class="plan-limit">
      <label>${c.label}</label>
      <input type="number" min="0" max="9999" data-limit="${c.key}" value="${Number(plan.limits[c.key] ?? 0)}">
    </div>`).join('');

  const groupHtml = (title, items) => `
    <div class="plan-group">
      <h4>${title}</h4>
      <div class="plan-feats">
        ${items.map((c) => `
          <label class="plan-feat">
            <input type="checkbox" data-feat="${c.key}" ${plan.features[c.key] !== false ? 'checked' : ''}>
            <span>${esc(c.label)}</span>
          </label>`).join('')}
      </div>
    </div>`;

  editor.innerHTML = `
    <div class="plan-group">
      <h4>Límites (cantidad máxima)</h4>
      <div class="plan-limits">${limitsHtml}</div>
    </div>
    ${groupHtml('Pestañas del panel', plansCatalog.tabs)}
    ${groupHtml('Overlays', plansCatalog.overlays)}
    ${groupHtml('Extras', plansCatalog.extras)}
  `;
}

// Recoge los valores del editor hacia plansConfig[plansActiveTab].
function collectPlansEditor() {
  const editor = document.getElementById('plans-editor');
  if (!editor || !plansConfig) return;
  const plan = plansConfig[plansActiveTab] || (plansConfig[plansActiveTab] = { limits: {}, features: {} });
  editor.querySelectorAll('input[data-limit]').forEach((inp) => {
    let v = Number(inp.value);
    if (!Number.isFinite(v) || v < 0) v = 0;
    plan.limits[inp.dataset.limit] = v;
  });
  editor.querySelectorAll('input[data-feat]').forEach((inp) => {
    plan.features[inp.dataset.feat] = inp.checked;
  });
}

document.querySelectorAll('.plan-tab').forEach((tab) => {
  tab.onclick = () => {
    collectPlansEditor(); // guarda lo editado de la pestaña actual antes de cambiar
    document.querySelectorAll('.plan-tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    plansActiveTab = tab.dataset.plan;
    renderPlansEditor();
  };
});

const plansSaveBtn = document.getElementById('plans-save');
if (plansSaveBtn) plansSaveBtn.onclick = async () => {
  collectPlansEditor();
  const status = document.getElementById('plans-status');
  plansSaveBtn.disabled = true;
  if (status) status.textContent = 'Guardando…';
  try {
    const r = await fetch('/api/admin/plans', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(plansConfig),
    });
    if (r.ok) {
      const d = await r.json();
      if (d.config) plansConfig = d.config;
      // Refleja los cambios al instante en la pestaña "Planes" (tarjetas + comparación),
      // sin esperar al mensaje del WebSocket.
      if (d.config) {
        if (planCompareData) planCompareData.config = d.config;
        else planCompareData = { catalog: plansCatalog, config: d.config };
        renderPlanView();
      }
      if (status) status.textContent = 'Guardado ✓';
      toast('Planes guardados.');
    } else {
      if (status) status.textContent = 'Error al guardar';
    }
  } catch {
    if (status) status.textContent = 'Error al guardar';
  }
  plansSaveBtn.disabled = false;
  setTimeout(() => { if (status) status.textContent = ''; }, 2500);
};

/* ====================== Panel ====================== */
function fmt(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n ?? 0);
}

function renderState(s) {
  $('s-viewers').textContent = fmt(s.stats.viewers);
  $('s-likes').textContent = fmt(s.stats.likes);
  $('s-diamonds').textContent = fmt(s.stats.diamonds);
  $('s-gifts').textContent = fmt(s.stats.gifts);
  $('s-comments').textContent = fmt(s.stats.comments);
  $('s-follows').textContent = fmt(s.stats.follows);
  $('s-shares').textContent = fmt(s.stats.shares);
  $('s-joins').textContent = fmt(s.stats.joins);

  const dot = $('dot'), st = $('statusText'), badge = $('liveBadge');
  if (s.connected) {
    dot.className = 'dot live'; st.textContent = `En vivo · @${s.username}`;
    badge.className = 'live-badge live'; badge.textContent = `● En vivo · @${s.username}`;
    $('btnConnect').hidden = true; $('btnDisconnect').hidden = false;
  } else if (s.connecting) {
    dot.className = 'dot wait'; st.textContent = `Conectando...`;
    badge.className = 'live-badge wait'; badge.textContent = '● Conectando...';
  } else {
    dot.className = 'dot off'; st.textContent = 'Desconectado';
    badge.className = 'live-badge off'; badge.textContent = '● Desconectado';
    $('btnConnect').hidden = false; $('btnDisconnect').hidden = true;
  }
  if (s.username && !$('username').value) $('username').value = s.username;
  renderLeaderboard(s.topGifters || []);
}

function renderLeaderboard(list) {
  const el = $('leaderboard');
  if (!list.length) { el.innerHTML = '<div class="empty">Aún no hay regalos</div>'; return; }
  el.innerHTML = list.map((g, i) => `
    <div class="lb-row"><div class="rank">${i + 1}</div>${avatar(g)}
      <div class="nm">${esc(g.nickname)}</div><div class="dm">🪙 ${fmt(g.diamonds)}</div></div>`).join('');
}

function avatar(u) {
  if (u.photo) return `<img class="av" src="${esc(u.photo)}" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'ph',textContent:'${initial(u.nickname)}'}))" />`;
  return `<div class="ph">${initial(u.nickname)}</div>`;
}
function initial(n) { return (n || '?').trim().charAt(0).toUpperCase(); }

function pushRow(feedId, html, cls = '') {
  const feed = $(feedId);
  feed.querySelector('.empty')?.remove();
  const div = document.createElement('div');
  div.className = `row ${cls}`;
  div.innerHTML = html;
  feed.appendChild(div);
  while (feed.children.length > MAX_ROWS) feed.removeChild(feed.firstChild);
  feed.scrollTop = feed.scrollHeight;
}
function addChat(p) { pushRow('chat', `${avatar(p)}<div><span class="name">${esc(p.nickname)}</span><span class="text">${esc(p.comment)}</span></div>`); }
function giftImageOf(p) {
  if (p.image) return p.image;
  if (p.giftId) return giftCatalogById.get(String(p.giftId))?.image || '';
  if (p.giftName) return giftCatalog.find((x) => x.name.toLowerCase() === String(p.giftName).toLowerCase())?.image || '';
  return '';
}
function addGift(p) {
  const total = p.diamonds * (p.repeatCount || 1);
  const img = giftImageOf(p);
  const giftIcon = img ? `<img class="gift-ic" src="${esc(img)}">` : '🎁';
  pushRow('gifts', `${avatar(p)}<div><span class="name">${esc(p.nickname)}</span><span class="text">envió ${esc(p.giftName)} x${p.repeatCount || 1}</span></div>${giftIcon}<span class="badge">🪙 ${fmt(total)}</span>`, 'gift');
}
function addEvent(text, cls) { pushRow('events', `<span class="text">${esc(text)}</span>`, `evt ${cls}`); }

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ====================== Conexión TikTok ====================== */
function doConnect() {
  const u = $('username').value.trim().replace(/^@/, '');
  if (!u) { $('username').focus(); return; }
  send({ action: 'connect', username: u });
}
$('btnConnect').onclick = doConnect;
$('btnDisconnect').onclick = () => send({ action: 'disconnect' });
$('username').addEventListener('keydown', (e) => { if (e.key === 'Enter') doConnect(); });
$('clearChat').onclick = () => { $('chat').innerHTML = ''; };

/* ====================== Opciones de reproducción ====================== */
if ($('opt-queue')) $('opt-queue').addEventListener('change', () => {
  if (!settings.playback) settings.playback = {};
  settings.playback.playQueue = $('opt-queue').checked;
  saveSettings();
});
if ($('opt-combo-once')) $('opt-combo-once').addEventListener('change', () => {
  if (!settings.playback) settings.playback = {};
  settings.playback.comboOnce = $('opt-combo-once').checked;
  saveSettings();
});

/* ====================== Temporizador ====================== */
let tmrRemaining = 0, tmrRunning = false, tmrLocalTick = null;

function tmrFmt(sec) {
  const t = Math.max(0, Math.floor(sec));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  let str = '';
  if (h > 0) str += (h < 10 ? '0' : '') + h + ':';
  str += (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  return str;
}
function tmrPaint() {
  const d = $('tmr-display');
  if (d) d.textContent = tmrFmt(tmrRemaining);
  const st = $('tmr-state');
  if (st) {
    st.textContent = tmrRunning ? 'En marcha' : (tmrRemaining <= 0 ? 'En 00:00' : 'En pausa');
    st.classList.toggle('running', tmrRunning);
  }
}
function tmrStopLocal() { if (tmrLocalTick) { clearInterval(tmrLocalTick); tmrLocalTick = null; } }
function tmrStartLocal() {
  tmrStopLocal();
  if (!tmrRunning) return;
  tmrLocalTick = setInterval(() => { if (tmrRemaining > 0) { tmrRemaining -= 1; tmrPaint(); } }, 1000);
}
function renderTimerState(p) {
  if (!p) return;
  if (typeof p.remaining === 'number') tmrRemaining = p.remaining;
  tmrRunning = !!p.running;
  tmrPaint();
  tmrStartLocal();
}
function tmrSend(op, extra) { send({ action: 'timerControl', op, ...(extra || {}) }); }

(function setupTimerControls() {
  const setBtn = $('tmr-setbtn');
  if (setBtn) setBtn.onclick = () => {
    const min = Number($('tmr-min').value) || 0;
    const sec = Number($('tmr-sec').value) || 0;
    tmrSend('set', { totalSeconds: min * 60 + sec });
  };
  if ($('tmr-start')) $('tmr-start').onclick = () => {
    const min = Number($('tmr-min').value) || 0;
    const sec = Number($('tmr-sec').value) || 0;
    const total = min * 60 + sec;
    tmrSend('start', total > 0 ? { totalSeconds: total } : {});
  };
  if ($('tmr-pause')) $('tmr-pause').onclick = () => tmrSend('pause');
  if ($('tmr-reset')) $('tmr-reset').onclick = () => tmrSend('reset');
  document.querySelectorAll('.tmr-quick .chip').forEach((b) => {
    b.onclick = () => tmrSend('add', { delta: Number(b.dataset.add) || 0 });
  });

  // Ajustes (reglas + opciones): se guardan al cambiar.
  const bindNum = (id, key) => {
    const el = $(id);
    if (!el) return;
    el.addEventListener('change', () => {
      if (!settings.timer) settings.timer = {};
      settings.timer[key] = Number(el.value) || 0;
      saveSettings();
    });
  };
  bindNum('tmr-giftmult', 'giftMult');
  bindNum('tmr-like', 'like');
  bindNum('tmr-follow', 'follow');
  bindNum('tmr-share', 'share');
  bindNum('tmr-subscribe', 'subscribe');
  bindNum('tmr-chat', 'chat');

  // Tiempo inicial y tope se muestran en minutos pero se guardan en segundos.
  // Al escribir el tiempo inicial se refleja al instante en el temporizador
  // (sin pulsar Reiniciar), siempre que NO esté corriendo para no cortar una cuenta activa.
  if ($('tmr-default')) $('tmr-default').addEventListener('input', () => {
    if (!settings.timer) settings.timer = {};
    const secs = Math.max(0, Math.round((Number($('tmr-default').value) || 0) * 60));
    settings.timer.defaultInitialSec = secs;
    saveSettings();
    if (!tmrRunning) tmrSend('set', { totalSeconds: secs });
  });
  if ($('tmr-maxcap')) $('tmr-maxcap').addEventListener('change', () => {
    if (!settings.timer) settings.timer = {};
    settings.timer.maxCapSec = Math.max(0, Math.round((Number($('tmr-maxcap').value) || 0) * 60));
    saveSettings();
  });
  if ($('tmr-maxon')) $('tmr-maxon').addEventListener('change', () => {
    if (!settings.timer) settings.timer = {};
    settings.timer.maxEnabled = $('tmr-maxon').checked;
    saveSettings();
  });
  if ($('tmr-onfinish')) $('tmr-onfinish').addEventListener('change', () => {
    if (!settings.timer) settings.timer = {};
    settings.timer.actionOnFinish = $('tmr-onfinish').value;
    saveSettings();
  });
})();

function applyTimerSettingsUI() {
  const t = settings.timer || {};
  const setVal = (id, v) => { const el = $(id); if (el) el.value = v; };
  setVal('tmr-giftmult', t.giftMult ?? 5);
  setVal('tmr-like', t.like ?? 2);
  setVal('tmr-follow', t.follow ?? 10);
  setVal('tmr-share', t.share ?? 15);
  setVal('tmr-subscribe', t.subscribe ?? 60);
  setVal('tmr-chat', t.chat ?? 0);
  setVal('tmr-default', Math.round((t.defaultInitialSec ?? 300) / 60));
  setVal('tmr-maxcap', Math.round((t.maxCapSec ?? 18000) / 60));
  if ($('tmr-maxon')) $('tmr-maxon').checked = !!t.maxEnabled;
  if ($('tmr-onfinish')) $('tmr-onfinish').value = t.actionOnFinish || 'pause';
}

/* ====================== Ajustes (sync con servidor) ====================== */
let saveDebounce = null;
function saveSettings() {
  if (applyingSettings) return;
  clearTimeout(saveDebounce);
  saveDebounce = setTimeout(() => send({ action: 'saveSettings', settings }), 200);
}

function onSettings(s) {
  settings = s;
  applyingSettings = true;
  applySettingsToUI();
  applyingSettings = false;
  applyLimitUI();
  renderPlanView();
}

function applySettingsToUI() {
  applyTtsUI(settings.tts || {});

  if (!settings.playback) settings.playback = { playQueue: true, comboOnce: false };
  if ($('opt-queue')) $('opt-queue').checked = settings.playback.playQueue !== false;
  if ($('opt-combo-once')) $('opt-combo-once').checked = !!settings.playback.comboOnce;

  applyTimerSettingsUI();

  $('vid-master').checked = settings.videosEnabled !== false;
  $('vid-master').parentElement.querySelector('.state').textContent = settings.videosEnabled !== false ? 'ON' : 'OFF';

  if ($('ba-master')) {
    $('ba-master').checked = settings.battleAlertsEnabled !== false;
    $('ba-master').parentElement.querySelector('.state').textContent = settings.battleAlertsEnabled !== false ? 'ON' : 'OFF';
  }
  renderBattleAlerts();
  applyJarronUI();
  if (typeof pushGiftVsPreview === 'function') setTimeout(() => pushGiftVsPreview(), 300);
  if (typeof pushGiftSeqPreview === 'function') setTimeout(() => pushGiftSeqPreview(), 300);
  if (typeof pushStyleOverlayPreviews === 'function') setTimeout(() => pushStyleOverlayPreviews(), 300);
  if (typeof window.pushHypePreview === 'function') setTimeout(() => window.pushHypePreview(), 300);
  renderScreens();
  renderVideos();
  renderSoundAlerts();
}

/* ====================== Videos (pantallas múltiples) ====================== */
const TT_GIFTS = [
  { name: 'Rose', d: 1 }, { name: 'GG', d: 1 }, { name: 'TikTok', d: 1 },
  { name: 'Finger Heart', d: 5 }, { name: 'Mini Gamepad', d: 5 }, { name: 'Heart Me', d: 15 },
  { name: 'Perfume', d: 20 }, { name: 'Doughnut', d: 30 }, { name: 'Hand Hearts', d: 100 },
  { name: 'Sunglasses', d: 100 }, { name: 'Galaxy', d: 1000 }, { name: 'Whale diving', d: 2150 },
  { name: 'Drama Queen', d: 5000 }, { name: 'Lion', d: 29999 }, { name: 'Universe', d: 44999 },
];
let connectedScreens = new Set();
let vidEditingId = null;
let vidPending = null; // { url, name }

function onScreens(p) {
  connectedScreens = new Set(p.connected || []);
  renderScreens();
}

function renderScreens() {
  const el = $('screenList');
  const screens = settings.screens || [];
  el.innerHTML = screens.map((s) => {
    const count = (settings.videos || []).filter((v) => (Number(v.screen) || 1) === s.id).length;
    const on = connectedScreens.has(s.id);
    return `
    <div class="screen" data-id="${s.id}">
      <div class="screen-top">
        <span class="st-name">Pantalla ${s.id}</span>
        <span class="st-count">${count ? count + (count === 1 ? ' evento' : ' eventos') : 'Sin eventos'}</span>
      </div>
      <div class="screen-status ${on ? 'on' : 'off'}"><span class="sdot"></span>${on ? 'Browser Source conectado' : 'Sin Browser Source'}</div>
      <div class="screen-btns">
        <button class="copy">Copiar link</button>
        <button class="test">Probar</button>
      </div>
      <div class="screen-size">Tamaño: <b>${s.size}%</b><input type="range" min="10" max="100" value="${s.size}"></div>
    </div>`;
  }).join('');

  el.querySelectorAll('.screen').forEach((card) => {
    const id = +card.dataset.id;
    const s = screens.find((x) => x.id === id);
    card.querySelector('.copy').onclick = (e) => {
      navigator.clipboard?.writeText(roomUrl(`/video.html?screen=${id}`));
      e.target.textContent = '¡copiado!';
      setTimeout(() => (e.target.textContent = 'Copiar link'), 1200);
    };
    card.querySelector('.test').onclick = () => send({ action: 'testScreen', screen: id });
    const range = card.querySelector('input');
    range.oninput = () => { s.size = +range.value; card.querySelector('.screen-size b').textContent = s.size + '%'; saveSettings(); };
  });
}

function renderVideos() {
  const el = $('videoCards');
  const list = settings.videos || [];
  if (!list.length) { el.innerHTML = '<div class="empty">No hay videos. Pulsa “Añadir video”.</div>'; return; }
  el.innerHTML = list.map((v) => {
    const isImg = /\.(gif|png|jpe?g|webp)(\?|$)/i.test(v.url || '');
    const thumb = v.url
      ? (isImg ? `<img class="vthumb" src="${esc(v.url)}" loading="lazy" decoding="async">` : `<video class="vthumb hover-play" src="${esc(v.url)}#t=0.1" muted loop playsinline preload="metadata"></video>`)
      : '🎬';
    return `
    <div class="sa-card ${v.enabled !== false ? 'on' : ''}" data-id="${v.id}">
      <div class="sa-top">
        <label class="toggle">
          <input type="checkbox" class="v-toggle" ${v.enabled !== false ? 'checked' : ''}>
          <span class="track"></span>
          <span class="state">${v.enabled !== false ? 'ON' : 'OFF'}</span>
        </label>
        <span class="sa-corner" title="${esc(triggerLabelV(v))}">${alertIconSmall(v)}</span>
      </div>
      <div class="sa-thumb">${thumb}</div>
      <div class="sa-info">
        <div class="sa-name">${esc(v.name || 'Video')}</div>
        <div class="sa-file">${esc(v.fileName || 'video')} · 📺 P${v.screen || 1}</div>
      </div>
      <div class="sa-vol">
        <span>Volumen</span>
        <input type="range" class="v-volrange" min="0" max="100" value="${v.volume ?? 100}">
        <span class="pct">${v.volume ?? 100}%</span>
      </div>
      <div class="sa-btns">
        <button class="edit" title="Editar">✏️</button>
        <button class="play" title="Probar en pantalla">▶️</button>
        <button class="stop" title="Detener video">⏹️</button>
        <button class="del" title="Borrar">🗑️</button>
      </div>
    </div>`;
  }).join('');

  el.querySelectorAll('.sa-card').forEach((card) => {
    const id = card.dataset.id;
    const v = list.find((x) => x.id === id);
    card.querySelector('video.vthumb')?.play?.().catch(() => {});
    card.querySelector('.v-toggle').onchange = (e) => { v.enabled = e.target.checked; saveSettings(); renderVideos(); };
    const vr = card.querySelector('.v-volrange');
    vr.oninput = () => { card.querySelector('.pct').textContent = vr.value + '%'; v.volume = +vr.value; saveSettings(); };
    card.querySelector('.edit').onclick = () => openVidModal(v);
    card.querySelector('.play').onclick = () => send({ action: 'testVideo', video: { id: v.id, name: v.name, url: v.url, screen: v.screen || 1, volume: v.volume ?? 100 } });
    card.querySelector('.stop').onclick = () => send({ action: 'stopVideo', screen: v.screen || 1 });
    card.querySelector('.del').onclick = async () => {
      const ok = await askConfirm({ title: 'Borrar video', message: `Se eliminará la alerta de video «${esc(v.name || 'video')}».` });
      if (!ok) return;
      settings.videos = settings.videos.filter((x) => x.id !== id);
      saveSettings(); renderVideos(); renderScreens();
    };
  });
}

function triggerLabelV(v) {
  return triggerLabel(v);
}

/* master toggle TODAS */
$('vid-master').addEventListener('change', () => {
  settings.videosEnabled = $('vid-master').checked;
  $('vid-master').parentElement.querySelector('.state').textContent = settings.videosEnabled ? 'ON' : 'OFF';
  saveSettings();
});

/* ----- Modal video ----- */
function setVidEventUI(value) {
  $('vid-event').value = value;
  $('vid-giftanyextra').hidden = value !== 'gift-any';
  $('vid-giftextra').hidden = value !== 'gift-name';
  $('vid-likeuserextra').hidden = value !== 'like';
  $('vid-likeextra').hidden = value !== 'likeGlobal';
  $('vid-emoteextra').hidden = value !== 'emote';
  $('vid-cmdextra').hidden = value !== 'chatCommand';
}

function openVidModal(v = null) {
  vidEditingId = v?.id || null;
  vidPending = v?.url ? { url: v.url, name: v.fileName } : null;
  $('vid-modal-title').textContent = v ? 'Configurar alerta de video' : 'Configurar alerta de video';
  $('vid-name').value = v?.name || '';
  let ev = 'gift-any';
  const trig = v?.trigger || 'gift';
  if (trig === 'gift') ev = v?.giftName ? 'gift-name' : 'gift-any';
  else ev = trig;
  setVidEventUI(ev);
  $('vid-gift').value = v?.giftName || '';
  $('vid-giftid').value = v?.giftId || '';
  updateGiftPickBtnV();
  $('vid-rangemin').value = v?.rangeMin || 0;
  $('vid-rangemax').value = v?.rangeMax || 0;
  $('vid-likemin').value = v?.likeMin || 1;
  $('vid-likegoal').value = v?.likeGoal || 100;
  $('vid-emoteid').value = v?.emoteId || '';
  updateEmotePickBtn('vid');
  $('vid-command').value = v?.command || '';
  $('vid-vol').value = v?.volume ?? 100;
  $('vid-screen').value = v?.screen || 1;
  $('vid-fname').textContent = v?.fileName || 'Ningún archivo';
  $('vid-status').textContent = '';
  closeVideoLib();
  $('vidModal').classList.remove('hidden');
}
function closeVidModal() { $('vidModal').classList.add('hidden'); }

$('vid-create').onclick = () => { if (ensureCanAdd('videos', 'videos', 'videos')) openVidModal(null); };
$('vid-cancel').onclick = closeVidModal;
$('vidModal').addEventListener('click', (e) => { if (e.target.id === 'vidModal') closeVidModal(); });
$('vid-event').addEventListener('change', () => setVidEventUI($('vid-event').value));

$('vid-upbtn').onclick = () => $('vid-file').click();
$('vid-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  $('vid-fname').textContent = 'Subiendo…';
  try {
    const res = await fetch('/api/upload?name=' + encodeURIComponent(file.name), { method: 'POST', body: file });
    const data = await res.json();
    if (!data.url) throw new Error();
    vidPending = { url: data.url, name: file.name };
    $('vid-fname').textContent = file.name;
  } catch { $('vid-fname').textContent = 'Error al subir'; }
});

/* "Videos AI" = elegir un video de la carpeta public/video (ventana aparte) */
let localVideos = [];

let libTarget = 'vid'; // 'vid' | 'ba' — a qué modal vuelve el video elegido de la librería
$('vid-libbtn').onclick = () => { libTarget = 'vid'; openVideoLib(); };
$('vidlib-close').onclick = closeVideoLib;
$('vidlib-cancel').onclick = closeVideoLib;
$('videoLibModal').addEventListener('click', (e) => { if (e.target.id === 'videoLibModal') closeVideoLib(); });
$('vid-librefresh').onclick = () => loadLocalVideos();
$('vid-libq').addEventListener('input', () => renderLocalVideos($('vid-libq').value.trim()));

function openVideoLib() {
  $('videoLibModal').classList.remove('hidden');
  loadLocalVideos();
}
function closeVideoLib() {
  $('videoLibModal').classList.add('hidden');
}

const isImageFile = (u) => /\.(gif|png|jpe?g|webp)(\?|$)/i.test(u || '');

async function loadLocalVideos() {
  const box = $('vid-libgrid');
  box.innerHTML = '<div class="empty">Cargando…</div>';
  try {
    const res = await fetch('/api/local-videos');
    const data = await res.json();
    localVideos = data.results || [];
    renderLocalVideos($('vid-libq').value.trim());
  } catch {
    box.innerHTML = '<div class="empty">No se pudo leer la carpeta «video»</div>';
  }
}

function renderLocalVideos(filter) {
  const box = $('vid-libgrid');
  const f = (filter || '').toLowerCase();
  const list = f ? localVideos.filter((v) => v.name.toLowerCase().includes(f)) : localVideos;
  if (!list.length) {
    box.innerHTML = localVideos.length
      ? '<div class="empty">Ningún video coincide</div>'
      : '<div class="empty">No hay videos en la carpeta «video».<br>Copia tus .mp4 ahí y pulsa ↻</div>';
    return;
  }
  const niceName = (n) => n.replace(/\.[^.]+$/, '');
  box.innerHTML = list.map((v) => {
    const media = isImageFile(v.url)
      ? `<img src="${esc(v.url)}" loading="lazy">`
      : `<video src="${esc(v.url)}" muted loop autoplay preload="auto" playsinline></video>`;
    return `
    <div class="vid-cell" data-url="${esc(v.url)}" data-name="${esc(v.name)}" title="${esc(v.name)}">
      <div class="vid-prev">${media}</div>
      <div class="vid-cell-name">${esc(niceName(v.name))}</div>
    </div>`;
  }).join('');

  box.querySelectorAll('.vid-cell').forEach((cell) => {
    const vid = cell.querySelector('video');
    if (vid) vid.play().catch(() => {});
    cell.onclick = () => {
      const chosen = { url: cell.dataset.url, name: cell.dataset.name };
      if (libTarget === 'ba') {
        baPending = chosen;
        $('ba-fname').textContent = cell.dataset.name;
      } else {
        vidPending = chosen;
        $('vid-fname').textContent = cell.dataset.name;
      }
      closeVideoLib();
    };
  });
}

$('vid-save').onclick = () => {
  const name = $('vid-name').value.trim();
  if (!name) { $('vid-status').textContent = '⚠️ Escribe un nombre.'; return; }
  if (!vidPending?.url) { $('vid-status').textContent = '⚠️ Elige o sube un video.'; return; }
  const ev = $('vid-event').value;
  const data = {
    name,
    trigger: ev === 'gift-any' || ev === 'gift-name' ? 'gift' : ev,
    giftName: ev === 'gift-name' ? $('vid-gift').value.trim() : '',
    giftId: ev === 'gift-name' ? ($('vid-giftid').value || '') : '',
    minDiamonds: 0,
    rangeMin: ev === 'gift-any' ? (+$('vid-rangemin').value || 0) : 0,
    rangeMax: ev === 'gift-any' ? (+$('vid-rangemax').value || 0) : 0,
    likeMin: ev === 'like' ? Math.max(1, +$('vid-likemin').value || 1) : 0,
    likeGoal: ev === 'likeGlobal' ? Math.max(1, +$('vid-likegoal').value || 100) : 0,
    emoteId: ev === 'emote' ? $('vid-emoteid').value.trim() : '',
    emoteImage: ev === 'emote' ? emoteImgById($('vid-emoteid').value.trim()) : '',
    command: ev === 'chatCommand' ? $('vid-command').value.trim() : '',
    url: vidPending.url,
    fileName: vidPending.name || 'video',
    volume: +$('vid-vol').value,
    screen: +$('vid-screen').value || 1,
  };
  if (ev === 'chatCommand' && !data.command) { $('vid-status').textContent = '⚠️ Escribe el comando (ej. !video).'; return; }
  if (vidEditingId) {
    const v = settings.videos.find((x) => x.id === vidEditingId);
    if (v) Object.assign(v, data);
  } else {
    settings.videos.push({ id: 'v' + Date.now(), enabled: true, ...data });
  }
  saveSettings();
  renderVideos();
  renderScreens();
  closeVidModal();
};

/* ---- Animaciones de batalla PK (video por acción) ---- */
let baEditingId = null;
let baPending = null;

const BA_TRIGGER_LABELS = {
  critical: '⚡ Golpe crítico x2',
  critical3: '⚡ Golpe crítico x3',
  battleGiftAny: '🎁 Cualquier regalo',
  battleStart: '🟢 Inicio batalla',
  battleEnd: '🔴 Fin batalla',
};
function baTriggerLabel(b) {
  const t = b.trigger || ((b.giftName || b.giftId) ? 'battleGift' : 'battleGiftAny');
  if (t === 'battleGift') return `🥊 ${b.giftName || 'regalo'}${b.giftId ? ' (#' + b.giftId + ')' : ''}`;
  return BA_TRIGGER_LABELS[t] || t;
}

function renderBattleAlerts() {
  const el = $('battleCards');
  if (!el) return;
  const list = settings.battleAlerts || [];
  if (!list.length) { el.innerHTML = '<div class="empty">No hay animaciones. Pulsa “Añadir animación”.</div>'; return; }
  el.innerHTML = list.map((b) => {
    const isImg = /\.(gif|png|jpe?g|webp)(\?|$)/i.test(b.url || '');
    const thumb = b.url
      ? (isImg ? `<img class="vthumb" src="${esc(b.url)}" loading="lazy" decoding="async">` : `<video class="vthumb hover-play" src="${esc(b.url)}#t=0.1" muted loop playsinline preload="metadata"></video>`)
      : '🥊';
    const trig = esc(baTriggerLabel(b));
    const showCombo = (b.trigger === 'battleGift' || b.trigger === 'battleGiftAny' || (!b.trigger && (b.giftName || b.giftId)));
    const combo = showCombo && (b.minCount || 1) > 1 ? ` ×${b.minCount}+` : '';
    return `
    <div class="sa-card ${b.enabled !== false ? 'on' : ''}" data-id="${b.id}">
      <div class="sa-top">
        <label class="toggle">
          <input type="checkbox" class="b-toggle" ${b.enabled !== false ? 'checked' : ''}>
          <span class="track"></span>
          <span class="state">${b.enabled !== false ? 'ON' : 'OFF'}</span>
        </label>
        <span class="sa-corner" title="${trig}${combo}">🥊</span>
      </div>
      <div class="sa-thumb">${thumb}</div>
      <div class="sa-info">
        <div class="sa-name">${esc(b.name || 'Animación')}</div>
        <div class="sa-file">${trig}${combo} · 📺 P${b.screen || 1}</div>
      </div>
      <div class="sa-vol">
        <span>Volumen</span>
        <input type="range" class="b-volrange" min="0" max="100" value="${b.volume ?? 100}">
        <span class="pct">${b.volume ?? 100}%</span>
      </div>
      <div class="sa-btns">
        <button class="edit" title="Editar">✏️</button>
        <button class="play" title="Probar en pantalla">▶️</button>
        <button class="stop" title="Detener video">⏹️</button>
        <button class="del" title="Borrar">🗑️</button>
      </div>
    </div>`;
  }).join('');

  el.querySelectorAll('.sa-card').forEach((card) => {
    const id = card.dataset.id;
    const b = list.find((x) => x.id === id);
    card.querySelector('video.vthumb')?.play?.().catch(() => {});
    card.querySelector('.b-toggle').onchange = (e) => { b.enabled = e.target.checked; saveSettings(); renderBattleAlerts(); };
    const vr = card.querySelector('.b-volrange');
    vr.oninput = () => { card.querySelector('.pct').textContent = vr.value + '%'; b.volume = +vr.value; saveSettings(); };
    card.querySelector('.edit').onclick = () => openBaModal(b);
    card.querySelector('.play').onclick = () => send({ action: 'testVideo', video: { id: b.id, name: b.name, url: b.url, screen: b.screen || 1, volume: b.volume ?? 100 } });
    card.querySelector('.stop').onclick = () => send({ action: 'stopVideo', screen: b.screen || 1 });
    card.querySelector('.del').onclick = async () => {
      const ok = await askConfirm({ title: 'Borrar animación', message: `Se eliminará la animación de batalla «${esc(b.name || 'animación')}».` });
      if (!ok) return;
      settings.battleAlerts = settings.battleAlerts.filter((x) => x.id !== id);
      saveSettings(); renderBattleAlerts();
    };
  });
}

function updateBaGiftBtn() {
  const name = $('ba-gift').value;
  const id = $('ba-giftid').value;
  $('ba-giftpick').textContent = name ? `🎁 ${name}${id ? ' (#' + id + ')' : ''}` : '🎁 Elegir regalo…';
}

function setBaTriggerUI(value) {
  $('ba-trigger').value = value;
  $('ba-giftextra').hidden = value !== 'battleGift';
  $('ba-countextra').hidden = !(value === 'battleGift' || value === 'battleGiftAny');
}

function openBaModal(b = null) {
  baEditingId = b?.id || null;
  baPending = b?.url ? { url: b.url, name: b.fileName } : null;
  $('ba-name').value = b?.name || '';
  const trig = b?.trigger || ((b?.giftName || b?.giftId) ? 'battleGift' : 'critical');
  setBaTriggerUI(trig);
  $('ba-gift').value = b?.giftName || '';
  $('ba-giftid').value = b?.giftId || '';
  updateBaGiftBtn();
  $('ba-mincount').value = b?.minCount || 1;
  $('ba-vol').value = b?.volume ?? 100;
  $('ba-screen').value = b?.screen || 1;
  $('ba-fname').textContent = b?.fileName || 'Ningún archivo';
  $('ba-status').textContent = '';
  closeVideoLib();
  $('baModal').classList.remove('hidden');
}
function closeBaModal() { $('baModal').classList.add('hidden'); }
$('ba-trigger').addEventListener('change', () => setBaTriggerUI($('ba-trigger').value));

$('ba-create').onclick = () => { if (ensureCanAdd('battleAlerts', 'battleAlerts', 'animaciones de batalla')) openBaModal(null); };
$('ba-cancel').onclick = closeBaModal;
$('baModal').addEventListener('click', (e) => { if (e.target.id === 'baModal') closeBaModal(); });
$('ba-giftpick').onclick = () => openGiftModal('sa', (g) => {
  $('ba-gift').value = g.name || '';
  $('ba-giftid').value = g.id || '';
  updateBaGiftBtn();
});
$('ba-libbtn').onclick = () => { libTarget = 'ba'; openVideoLib(); };
$('ba-upbtn').onclick = () => $('ba-file').click();
$('ba-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  $('ba-fname').textContent = 'Subiendo…';
  try {
    const res = await fetch('/api/upload?name=' + encodeURIComponent(file.name), { method: 'POST', body: file });
    const data = await res.json();
    if (!data.url) throw new Error();
    baPending = { url: data.url, name: file.name };
    $('ba-fname').textContent = file.name;
  } catch { $('ba-fname').textContent = 'Error al subir'; }
});

$('ba-save').onclick = () => {
  const name = $('ba-name').value.trim();
  const trig = $('ba-trigger').value;
  if (!name) { $('ba-status').textContent = '⚠️ Escribe un nombre.'; return; }
  if (trig === 'battleGift' && !$('ba-giftid').value && !$('ba-gift').value.trim()) {
    $('ba-status').textContent = '⚠️ Elige el regalo de batalla (ej. guante).'; return;
  }
  if (!baPending?.url) { $('ba-status').textContent = '⚠️ Elige o sube un video.'; return; }
  const data = {
    name,
    trigger: trig,
    giftName: trig === 'battleGift' ? $('ba-gift').value.trim() : '',
    giftId: trig === 'battleGift' ? ($('ba-giftid').value || '') : '',
    minCount: (trig === 'battleGift' || trig === 'battleGiftAny') ? Math.max(1, +$('ba-mincount').value || 1) : 1,
    url: baPending.url,
    fileName: baPending.name || 'video',
    volume: +$('ba-vol').value,
    screen: +$('ba-screen').value || 1,
  };
  if (!settings.battleAlerts) settings.battleAlerts = [];
  if (baEditingId) {
    const b = settings.battleAlerts.find((x) => x.id === baEditingId);
    if (b) Object.assign(b, data);
  } else {
    settings.battleAlerts.push({ id: 'ba' + Date.now(), enabled: true, ...data });
  }
  saveSettings();
  renderBattleAlerts();
  closeBaModal();
};

$('ba-master').addEventListener('change', () => {
  settings.battleAlertsEnabled = $('ba-master').checked;
  $('ba-master').parentElement.querySelector('.state').textContent = settings.battleAlertsEnabled ? 'ON' : 'OFF';
  saveSettings();
});

/* ====================== Alertas sonoras ====================== */
const selected = new Set();
let editingId = null;
let pendingSound = null; // { url, name }
let previewAudio = null;

function renderSoundAlerts() {
  const el = $('saList');
  const list = settings.soundAlerts || [];
  // limpia selección de los que ya no existen
  for (const id of [...selected]) if (!list.find((a) => a.id === id)) selected.delete(id);
  updateSelCount();

  if (!list.length) {
    el.innerHTML = '<div class="empty">No hay alertas sonoras. Pulsa “Crear alerta sonora”.</div>';
    return;
  }
  el.innerHTML = list.map((a) => `
    <div class="sa-card ${a.enabled ? 'on' : ''}" data-id="${a.id}">
      <div class="sa-top">
        <label class="toggle">
          <input type="checkbox" class="sa-toggle" ${a.enabled ? 'checked' : ''}>
          <span class="track"></span>
          <span class="state">${a.enabled ? 'ON' : 'OFF'}</span>
        </label>
        <input type="checkbox" class="sa-sel" ${selected.has(a.id) ? 'checked' : ''} title="Seleccionar">
      </div>
      <div class="sa-thumb"><div class="sa-float">${alertIconHTML(a)}</div></div>
      <div class="sa-info">
        <div class="sa-name">${esc(a.name || 'Alerta')}</div>
        <div class="sa-file">${a.soundName ? esc(a.soundName) : 'Sin audio'} · ${triggerLabel(a)}</div>
      </div>
      <div class="sa-vol">
        <span>Volumen</span>
        <input type="range" class="sa-volrange" min="0" max="100" value="${a.volume ?? 100}">
        <span class="pct">${a.volume ?? 100}%</span>
      </div>
      <div class="sa-btns">
        <button class="edit" title="Editar">✏️</button>
        <button class="play" title="Escuchar aquí">▶️</button>
        <button class="stop" title="Detener sonido">⏹️</button>
        <button class="del" title="Borrar">🗑️</button>
      </div>
    </div>`).join('');

  el.querySelectorAll('.sa-card').forEach((card) => {
    const id = card.dataset.id;
    const a = list.find((x) => x.id === id);
    card.querySelector('.sa-toggle').onchange = (e) => { a.enabled = e.target.checked; saveSettings(); renderSoundAlerts(); };
    card.querySelector('.sa-sel').onchange = (e) => { e.target.checked ? selected.add(id) : selected.delete(id); updateSelCount(); };
    const vr = card.querySelector('.sa-volrange');
    vr.oninput = () => { card.querySelector('.pct').textContent = vr.value + '%'; a.volume = +vr.value; saveSettings(); };
    card.querySelector('.edit').onclick = () => openSaModal(a);
    card.querySelector('.play').onclick = () => playPreview(a);
    card.querySelector('.stop').onclick = () => {
      try { previewAudio?.pause(); } catch {}
      stopPanelSounds();
      send({ action: 'panic' });
    };
    card.querySelector('.del').onclick = async () => {
      const ok = await askConfirm({ title: 'Borrar alerta sonora', message: `Se eliminará la alerta «${esc(a.name || 'alerta')}».` });
      if (!ok) return;
      settings.soundAlerts = settings.soundAlerts.filter((x) => x.id !== id);
      saveSettings(); renderSoundAlerts();
    };
  });
}

function updateSelCount() { $('sa-selcount').textContent = selected.size; }

const EVENT_LABELS = {
  gift: '💎 Cantidad diamantes',
  like: '❤️ Likes (por usuario)',
  likeGlobal: '❤️ Likes globales',
  share: '🔁 Compartida',
  subscribe: '⭐ Nuevo suscriptor',
  follow: '➕ Nuevo seguidor',
  emote: '😀 Sticker / emote',
  chatCommand: '💬 Comando de chat',
  firstMessage: '🙋 Primer mensaje',
};
function triggerLabel(a) {
  const trig = a.trigger || 'gift';
  if (trig === 'gift') {
    if (a.giftName) return `🎁 ${esc(a.giftName)}`;
    if (a.rangeMin || a.rangeMax) return `💎 ${a.rangeMin || 0}${a.rangeMax ? ' – ' + a.rangeMax : '+'}`;
    return '💎 Cantidad diamantes';
  }
  if (trig === 'chatCommand') return `💬 ${esc(a.command || '!comando')}`;
  if (trig === 'like' && a.likeMin > 1) return `❤️ Desde ${a.likeMin} likes`;
  if (trig === 'likeGlobal' && a.likeGoal) return `❤️ Cada ${a.likeGoal} likes`;
  if (trig === 'emote' && a.emoteId) return `😀 Emote ${esc(a.emoteId)}`;
  return EVENT_LABELS[trig] || trig;
}

function playPreview(a) {
  if (!a.sound) return;
  try { previewAudio?.pause(); } catch {}
  previewAudio = new Audio(a.sound);
  previewAudio.volume = (a.volume ?? 100) / 100;
  previewAudio.play().catch(() => {});
}

/* ----- Modal crear/editar ----- */
function setEventUI(value) {
  $('sa-event').value = value;
  $('sa-giftanyextra').hidden = value !== 'gift-any';
  $('sa-giftextra').hidden = value !== 'gift-name';
  $('sa-likeuserextra').hidden = value !== 'like';
  $('sa-likeextra').hidden = value !== 'likeGlobal';
  $('sa-emoteextra').hidden = value !== 'emote';
}

function openSaModal(alert = null) {
  editingId = alert?.id || null;
  pendingSound = alert?.sound ? { url: alert.sound, name: alert.soundName } : null;

  $('sa-modal-title').textContent = alert ? 'Editar alerta sonora' : 'Nueva alerta sonora';
  $('sa-name').value = alert?.name || '';

  // evento -> dropdown
  let ev = 'gift-any';
  const trig = alert?.trigger || 'gift';
  if (trig === 'gift') ev = alert?.giftName ? 'gift-name' : 'gift-any';
  else ev = trig;
  setEventUI(ev);

  $('sa-gift').value = alert?.giftName || '';
  $('sa-giftid').value = alert?.giftId || '';
  $('sa-mindia').value = alert?.minDiamonds || 0;
  updateGiftPickBtn();
  $('sa-rangemin').value = alert?.rangeMin || 0;
  $('sa-rangemax').value = alert?.rangeMax || 0;
  $('sa-likemin').value = alert?.likeMin || 1;
  $('sa-likegoal').value = alert?.likeGoal || 100;
  $('sa-emoteid').value = alert?.emoteId || '';
  updateEmotePickBtn('sa');
  $('sa-vol').value = alert?.volume ?? 100;
  $('sa-soundname').textContent = alert?.soundName || 'Ningún archivo…';
  $('sa-active').checked = alert ? !!alert.enabled : true;
  $('sa-status').textContent = '';
  closeSoundLib();
  $('saModal').classList.remove('hidden');
}
function closeSaModal() { $('saModal').classList.add('hidden'); }

$('sa-create').onclick = () => { if (ensureCanAdd('soundAlerts', 'soundAlerts', 'alertas sonoras')) openSaModal(null); };
$('sa-cancel').onclick = closeSaModal;
$('sa-cancel2').onclick = closeSaModal;
$('saModal').addEventListener('click', (e) => { if (e.target.id === 'saModal') closeSaModal(); });
$('sa-event').addEventListener('change', () => setEventUI($('sa-event').value));

/* ----- Selector de regalos ----- */
let giftCatalog = [];
const giftCatalogById = new Map();

function indexGiftCatalog() {
  giftCatalogById.clear();
  for (const g of giftCatalog) giftCatalogById.set(String(g.id), g);
}

async function preloadGiftCatalog() {
  if (giftCatalog.length) return;
  try {
    const res = await fetch('/api/gifts');
    const data = await res.json();
    giftCatalog = data.results || [];
    indexGiftCatalog();
    if (settings) { renderSoundAlerts(); renderVideos(); }
  } catch {}
}

const EVENT_EMOJI = {
  like: '❤️', likeGlobal: '❤️', follow: '➕', share: '🔁',
  subscribe: '⭐', emote: '😀', gift: '🎁',
  chatCommand: '💬', firstMessage: '🙋',
};

// Busca la imagen de un sticker/emote por su id en el catálogo cargado.
function emoteImgById(id) {
  if (!id) return '';
  const e = emoteCatalog.find((x) => String(x.id) === String(id));
  return e?.image || '';
}

// Devuelve el HTML del icono de la alerta (regalo real, sticker, imagen propia o emoji)
function alertIconHTML(a) {
  if (a.image) return `<img class="sa-ic-img" src="${esc(a.image)}" loading="lazy" decoding="async">`;
  const trig = a.trigger || 'gift';
  if (trig === 'gift' && a.giftId) {
    const g = giftCatalogById.get(String(a.giftId));
    if (g?.image) return `<img class="sa-ic-img" src="${esc(g.image)}" loading="lazy" decoding="async">`;
  }
  if (trig === 'gift' && a.giftName) {
    const g = giftCatalog.find((x) => x.name.toLowerCase() === a.giftName.toLowerCase());
    if (g?.image) return `<img class="sa-ic-img" src="${esc(g.image)}" loading="lazy" decoding="async">`;
  }
  if (trig === 'emote') {
    const img = a.emoteImage || emoteImgById(a.emoteId);
    if (img) return `<img class="sa-ic-img" src="${esc(img)}" loading="lazy" decoding="async">`;
  }
  return `<span class="sa-ic-emoji">${EVENT_EMOJI[trig] || '🔔'}</span>`;
}

// Versión pequeña para la esquina de las tarjetas
function alertIconSmall(a) {
  const trig = a.trigger || 'gift';
  let img = '';
  if (a.image) img = a.image;
  else if (trig === 'gift' && a.giftId) img = giftCatalogById.get(String(a.giftId))?.image || '';
  else if (trig === 'gift' && a.giftName) img = giftCatalog.find((x) => x.name.toLowerCase() === a.giftName.toLowerCase())?.image || '';
  else if (trig === 'emote') img = a.emoteImage || emoteImgById(a.emoteId);
  if (img) return `<img class="sa-ic-mini" src="${esc(img)}" loading="lazy" decoding="async">`;
  return `<span class="sa-ic-mini-emoji">${EVENT_EMOJI[trig] || '🔔'}</span>`;
}

/* ----- Selector de stickers / emotes (compartido sa/vid) ----- */
let emoteCatalog = [];
let emoteTarget = 'vid';

function updateEmotePickBtn(target) {
  const t = target || emoteTarget;
  const btn = $(t + '-emotepick');
  if (!btn) return;
  const id = $(t + '-emoteid').value;
  const e = emoteCatalog.find((x) => String(x.id) === String(id));
  if (id && e?.image) btn.innerHTML = `<img class="sa-ic-mini" src="${esc(e.image)}"> Sticker elegido`;
  else if (id) btn.textContent = `🙂 Sticker #${id}`;
  else btn.textContent = '🙂 Elegir sticker…';
}

async function openEmoteModal(target = 'vid') {
  emoteTarget = target;
  $('emoteModal').classList.remove('hidden');
  const grid = $('emote-grid');
  grid.innerHTML = '<div class="empty">Cargando…</div>';
  try {
    const res = await fetch('/api/emotes');
    const data = await res.json();
    emoteCatalog = data.results || [];
  } catch {}
  renderEmoteGrid();
}
function closeEmoteModal() { $('emoteModal').classList.add('hidden'); }

function renderEmoteGrid() {
  const grid = $('emote-grid');
  if (!grid) return;
  if (!emoteCatalog.length) {
    grid.innerHTML = '<div class="empty">Aún no aparecen stickers.<br>Cuando alguien use un sticker en tu live aparecerá aquí.</div>';
    return;
  }
  const curId = $(emoteTarget + '-emoteid').value;
  grid.innerHTML = emoteCatalog.map((e) => `
    <div class="gift-cell ${String(e.id) === curId ? 'sel' : ''}" data-id="${esc(e.id)}" title="#${esc(e.id)}">
      <img src="${esc(e.image)}" loading="lazy" onerror="this.style.visibility='hidden'">
      <div class="g-name">#${esc(String(e.id).slice(-6))}</div>
    </div>`).join('');
  grid.querySelectorAll('.gift-cell').forEach((cell) => {
    cell.onclick = () => {
      $(emoteTarget + '-emoteid').value = cell.dataset.id;
      updateEmotePickBtn(emoteTarget);
      closeEmoteModal();
    };
  });
}

function updateGiftPickBtn() {
  const name = $('sa-gift').value;
  const id = $('sa-giftid').value;
  $('sa-giftpick').textContent = name ? `🎁 ${name}${id ? ' (#' + id + ')' : ''}` : '🎁 Elegir regalo…';
}

function updateGiftPickBtnV() {
  const name = $('vid-gift').value;
  const id = $('vid-giftid').value;
  $('vid-giftpick').textContent = name ? `🎁 ${name}${id ? ' (#' + id + ')' : ''}` : '🎁 Elegir regalo…';
}

let giftTarget = 'sa'; // 'sa' (sonido) o 'vid' (video)
let giftPickCallback = null; // si se define, recibe el regalo elegido en vez de rellenar inputs

$('sa-giftpick').onclick = () => openGiftModal('sa');
$('vid-giftpick').onclick = () => openGiftModal('vid');
$('vid-emotepick').onclick = () => openEmoteModal('vid');
$('sa-emotepick').onclick = () => openEmoteModal('sa');
$('emote-close').onclick = closeEmoteModal;
$('emoteModal').addEventListener('click', (e) => { if (e.target.id === 'emoteModal') closeEmoteModal(); });
$('gift-close').onclick = () => $('giftModal').classList.add('hidden');
$('giftModal').addEventListener('click', (e) => { if (e.target.id === 'giftModal') $('giftModal').classList.add('hidden'); });
$('gift-q').addEventListener('input', () => renderGiftGrid($('gift-q').value.trim()));

async function openGiftModalCb(cb) {
  await openGiftModal('sa', cb);
}

async function openGiftModal(target = 'sa', cb = null) {
  giftPickCallback = cb;
  giftTarget = target;
  $('giftModal').classList.remove('hidden');
  $('gift-q').value = '';
  const grid = $('gift-grid');
  if (!giftCatalog.length) {
    grid.innerHTML = '<div class="empty">Cargando regalos…</div>';
    try {
      const res = await fetch('/api/gifts');
      const data = await res.json();
      giftCatalog = data.results || [];
      indexGiftCatalog();
    } catch {
      grid.innerHTML = '<div class="empty">No se pudo cargar el catálogo (¿hay internet?)</div>';
      return;
    }
  }
  renderGiftGrid('');
}

function renderGiftGrid(filter) {
  const grid = $('gift-grid');
  const f = (filter || '').toLowerCase();
  const list = f
    ? giftCatalog.filter((g) => g.name.toLowerCase().includes(f) || String(g.id).includes(f) || String(g.diamonds).includes(f))
    : giftCatalog;
  if (!list.length) { grid.innerHTML = '<div class="empty">Sin resultados</div>'; return; }
  const curId = giftPickCallback ? '' : $(giftTarget + '-giftid').value;
  grid.innerHTML = list.map((g) => `
    <div class="gift-cell ${String(g.id) === curId ? 'sel' : ''}" data-id="${g.id}" data-name="${esc(g.name)}" title="${esc(g.name)} · #${g.id}">
      <img src="${esc(g.image)}" loading="lazy" onerror="this.style.visibility='hidden'">
      <div class="g-name">${esc(g.name)}</div>
      <div class="g-coin">🪙 ${g.diamonds}</div>
    </div>`).join('');
  grid.querySelectorAll('.gift-cell').forEach((cell) => {
    cell.onclick = () => {
      if (giftPickCallback) {
        const g = giftCatalogById.get(String(cell.dataset.id));
        giftPickCallback({
          id: cell.dataset.id,
          name: cell.dataset.name,
          image: g?.image || '',
          diamonds: g?.diamonds || 0,
        });
        giftPickCallback = null;
        $('giftModal').classList.add('hidden');
        return;
      }
      $(giftTarget + '-gift').value = cell.dataset.name;
      $(giftTarget + '-giftid').value = cell.dataset.id;
      if (giftTarget === 'vid') updateGiftPickBtnV(); else updateGiftPickBtn();
      $('giftModal').classList.add('hidden');
    };
  });
}

/* Subir propio */
$('sa-upbtn').onclick = () => $('sa-soundfile').click();
$('sa-soundfile').addEventListener('change', (e) => uploadFile(e.target.files[0], 'sound'));

async function uploadFile(file, kind) {
  if (!file) return;
  const label = $('sa-soundname');
  label.textContent = 'Subiendo…';
  try {
    const res = await fetch('/api/upload?name=' + encodeURIComponent(file.name), { method: 'POST', body: file });
    const data = await res.json();
    if (!data.url) throw new Error(data.error || 'error');
    pendingSound = { url: data.url, name: file.name }; label.textContent = file.name;
  } catch (err) {
    label.textContent = 'Error al subir';
  }
}

/* Biblioteca de sonidos: lee la carpeta local /audios */
let libAudio = null;
let localSounds = [];

function openSoundLib() {
  $('soundLibModal').classList.remove('hidden');
  loadLocalSounds();
}
function closeSoundLib() {
  $('soundLibModal').classList.add('hidden');
  try { libAudio?.pause(); } catch {}
}
$('sa-libbtn').onclick = openSoundLib;
$('lib-close').onclick = closeSoundLib;
$('soundLibModal').addEventListener('click', (e) => { if (e.target.id === 'soundLibModal') closeSoundLib(); });
$('sa-librefresh').onclick = () => loadLocalSounds();
$('sa-libq').addEventListener('input', () => renderLocalSounds($('sa-libq').value.trim()));

async function loadLocalSounds() {
  const box = $('sa-libresults');
  box.innerHTML = '<div class="empty">Cargando…</div>';
  try {
    const res = await fetch('/api/local-sounds');
    const data = await res.json();
    localSounds = data.results || [];
    renderLocalSounds($('sa-libq').value.trim());
  } catch {
    box.innerHTML = '<div class="empty">No se pudo leer la carpeta «audios»</div>';
  }
}

function renderLocalSounds(filter) {
  const box = $('sa-libresults');
  const f = (filter || '').toLowerCase();
  const list = f ? localSounds.filter((s) => s.name.toLowerCase().includes(f)) : localSounds;
  if (!list.length) {
    box.innerHTML = localSounds.length
      ? '<div class="empty">Ningún audio coincide</div>'
      : '<div class="empty">No hay audios en la carpeta «audios».<br>Copia tus .mp3 ahí y pulsa ↻</div>';
    return;
  }
  box.innerHTML = list.map((s) => `
    <div class="lib-row">
      <span class="lr-name">${esc(s.name)}</span>
      <button class="lr-play" data-url="${esc(s.url)}">▶️</button>
      <button class="lr-pick" data-url="${esc(s.url)}" data-name="${esc(s.name)}">Usar</button>
    </div>`).join('');
  box.querySelectorAll('.lr-play').forEach((b) => b.onclick = () => {
    try { libAudio?.pause(); } catch {}
    libAudio = new Audio(b.dataset.url); libAudio.play().catch(() => {});
  });
  box.querySelectorAll('.lr-pick').forEach((b) => b.onclick = () => {
    pendingSound = { url: b.dataset.url, name: b.dataset.name };
    $('sa-soundname').textContent = b.dataset.name;
    closeSoundLib();
  });
}

$('sa-save').onclick = () => {
  const name = $('sa-name').value.trim();
  if (!name) { $('sa-status').textContent = '⚠️ Escribe un nombre.'; return; }
  if (!pendingSound?.url) { $('sa-status').textContent = '⚠️ Elige un sonido (biblioteca o subir propio).'; return; }

  const ev = $('sa-event').value;
  const data = {
    name,
    trigger: ev === 'gift-any' || ev === 'gift-name' ? 'gift' : ev,
    giftName: ev === 'gift-name' ? $('sa-gift').value.trim() : '',
    giftId: ev === 'gift-name' ? ($('sa-giftid').value || '') : '',
    minDiamonds: ev === 'gift-name' ? (+$('sa-mindia').value || 0) : 0,
    rangeMin: ev === 'gift-any' ? (+$('sa-rangemin').value || 0) : 0,
    rangeMax: ev === 'gift-any' ? (+$('sa-rangemax').value || 0) : 0,
    likeMin: ev === 'like' ? Math.max(1, +$('sa-likemin').value || 1) : 0,
    likeGoal: ev === 'likeGlobal' ? Math.max(1, +$('sa-likegoal').value || 100) : 0,
    emoteId: ev === 'emote' ? $('sa-emoteid').value.trim() : '',
    emoteImage: ev === 'emote' ? emoteImgById($('sa-emoteid').value.trim()) : '',
    sound: pendingSound.url,
    soundName: pendingSound.name || 'audio',
    image: '',
    volume: +$('sa-vol').value,
    enabled: $('sa-active').checked,
  };
  if (editingId) {
    const a = settings.soundAlerts.find((x) => x.id === editingId);
    if (a) Object.assign(a, data);
  } else {
    settings.soundAlerts.push({ id: 'sa' + Date.now(), ...data });
  }
  saveSettings();
  renderSoundAlerts();
  closeSaModal();
};

$('sa-delsel').onclick = async () => {
  if (!selected.size) return;
  const ok = await askConfirm({ title: 'Borrar seleccionadas', message: `Se eliminarán ${selected.size} alerta(s) sonora(s).` });
  if (!ok) return;
  settings.soundAlerts = settings.soundAlerts.filter((a) => !selected.has(a.id));
  selected.clear();
  saveSettings();
  renderSoundAlerts();
};

$('sa-panic').onclick = () => {
  try { previewAudio?.pause(); } catch {}
  send({ action: 'panic' });
};

/* ====================== Overlays ====================== */
document.querySelectorAll('.subtab').forEach((btn) => {
  btn.onclick = () => {
    document.querySelectorAll('.subtab').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.subview').forEach((v) => v.classList.remove('active'));
    btn.classList.add('active');
    $(`sub-${btn.dataset.sub}`).classList.add('active');
  };
});

document.querySelectorAll('.overlay-item').forEach((item) => {
  const code = item.querySelector('.ov-url');
  code.textContent = roomUrl(code.dataset.path);
  const link = item.querySelector('a');
  if (link && !link.href) link.href = roomUrl(code.dataset.path);
  item.querySelector('.ov-copy').onclick = (e) => {
    navigator.clipboard?.writeText(roomUrl(code.dataset.path));
    e.target.textContent = '¡copiado!';
    setTimeout(() => (e.target.textContent = 'copiar'), 1200);
  };
});

/* ====================== Tarjetas PRO: Jarrón y Vaquita ====================== */
const DEFAULT_JAR_SIZES = [
  { t: 5000, sz: 88 }, { t: 1000, sz: 70 }, { t: 100, sz: 56 }, { t: 30, sz: 40 }, { t: 0, sz: 32 },
];

// Configuración de cada overlay tipo "bote" (mismo comportamiento, distinta tarjeta)
const POT_OVERLAYS = {
  jarron: { previewId: 'jar-preview', testAction: 'testJarron', resetAction: 'resetJarron',
            btnTest: 'jar-test', btnReset: 'jar-reset', btnConfig: 'jar-config', copyBtnIdx: 0 },
  vaquita: { previewId: 'vaq-preview', testAction: 'testVaquita', resetAction: 'resetVaquita',
             btnTest: 'vaq-test', btnReset: 'vaq-reset', btnConfig: 'vaq-config', copyBtnIdx: 1 },
  marranito: { previewId: 'mar-preview', testAction: 'testMarranito', resetAction: 'resetMarranito',
               btnTest: 'mar-test', btnReset: 'mar-reset', btnConfig: 'mar-config', copyBtnIdx: 2 },
};

(function setupPotCards() {
  document.querySelectorAll('.ovpro-card').forEach((card) => {
    const code = card.querySelector('.ov-url');
    code.textContent = roomUrl(code.dataset.path);
    card.querySelector('.ovpro-copy').onclick = (e) => {
      navigator.clipboard?.writeText(roomUrl(code.dataset.path));
      const t = e.target; t.textContent = '¡Copiado!';
      setTimeout(() => (t.textContent = 'Copiar enlace'), 1200);
    };
  });

  for (const [key, cfg] of Object.entries(POT_OVERLAYS)) {
    const test = $(cfg.btnTest), reset = $(cfg.btnReset), config = $(cfg.btnConfig);
    if (!test) continue;
    const toPreview = (msg) => $(cfg.previewId)?.contentWindow?.postMessage({ kind: key, ...msg }, '*');
    test.onclick = () => { toPreview({ type: 'test', count: 200 }); send({ action: cfg.testAction, count: 200 }); };
    reset.onclick = () => { toPreview({ type: 'reset' }); send({ action: cfg.resetAction }); };
    config.onclick = () => openPotConfig(key);
  }

  // Top donador (misma tarjeta PRO, pero con su propia config)
  const topPrev = () => $('top-preview')?.contentWindow;
  const toTopPreview = (msg) => topPrev()?.postMessage({ kind: 'topdonor', ...msg }, '*');
  if ($('top-test')) {
    $('top-test').onclick = () => { toTopPreview({ type: 'test' }); send({ action: 'testTopDonor' }); };
    $('top-reset').onclick = () => { toTopPreview({ type: 'reset' }); send({ action: 'stopTopDonor' }); };
    $('top-config').onclick = openTopConfig;
  }
})();

/* ---- Modal de configuración (compartido por jarrón y vaquita) ---- */
let cfgTarget = 'jarron';
let cfgSizesDraft = [];

function cfgPreviewWin() { return $(POT_OVERLAYS[cfgTarget].previewId)?.contentWindow; }
function cfgToPreview(msg) { cfgPreviewWin()?.postMessage({ kind: cfgTarget, ...msg }, '*'); }

function openPotConfig(target) {
  cfgTarget = target;
  if (!settings[target]) settings[target] = {};
  const data = settings[target];
  const tint = data.tint || '#7cc8ff';
  $('jarcfg-tint').value = /^#/.test(tint) ? tint : '#7cc8ff';
  $('jarcfg-tint').dataset.cleared = data.tint ? '' : '';
  cfgSizesDraft = (data.sizes && data.sizes.length)
    ? data.sizes.map((r) => ({ t: Number(r.t) || 0, sz: Number(r.sz) || 32 }))
    : DEFAULT_JAR_SIZES.map((r) => ({ ...r }));
  const titles = {
    vaquita: '🐮 Configurar — Vaquita (bote regalos)',
    marranito: '🐷 Configurar — Marranito (bote regalos)',
    jarron: '⚙️ Configurar — Jarrón (bote regalos)',
  };
  $('jarcfg-title').textContent = titles[target] || titles.jarron;
  renderJarRows();
  $('jarConfigModal').classList.remove('hidden');
}
function closeJarConfig() { $('jarConfigModal').classList.add('hidden'); }

function renderJarRows() {
  const sorted = [...cfgSizesDraft].sort((a, b) => b.t - a.t);
  cfgSizesDraft = sorted;
  const wrap = $('jarcfg-rows');
  wrap.innerHTML = sorted.map((r, i) => {
    const next = sorted[i - 1]; // umbral inmediatamente superior
    const range = next ? `${r.t} a ${next.t - 1} monedas` : `≥ ${r.t} monedas`;
    return `
      <div class="jarcfg-row" data-i="${i}">
        <button type="button" class="jarcfg-del" title="Quitar">✕</button>
        <div class="jarcfg-row-head">UMBRAL ${i + 1} <span class="rng">— ${range} · ${r.sz} px</span></div>
        <div class="jarcfg-row-grid">
          <div>
            <label>Si el regalo ≥ (monedas / diamantes)</label>
            <input type="number" min="0" class="jc-t" value="${r.t}">
          </div>
          <div>
            <label>Tamaño del icono (px)</label>
            <input type="number" min="8" max="200" class="jc-sz" value="${r.sz}">
          </div>
        </div>
      </div>`;
  }).join('');

  wrap.querySelectorAll('.jarcfg-row').forEach((row) => {
    const i = Number(row.dataset.i);
    row.querySelector('.jc-t').onchange = (e) => { cfgSizesDraft[i].t = Math.max(0, parseInt(e.target.value, 10) || 0); renderJarRows(); };
    row.querySelector('.jc-sz').onchange = (e) => { cfgSizesDraft[i].sz = Math.max(8, Math.min(200, parseInt(e.target.value, 10) || 32)); renderJarRows(); };
    row.querySelector('.jarcfg-del').onclick = () => { cfgSizesDraft.splice(i, 1); renderJarRows(); };
  });

  // Refleja los tamaños en la vista previa (efecto en el próximo Testear)
  cfgToPreview({ type: 'config', sizes: sorted });
}

$('jarcfg-close').onclick = closeJarConfig;
$('jarConfigModal').addEventListener('click', (e) => { if (e.target.id === 'jarConfigModal') closeJarConfig(); });
$('jarcfg-add').onclick = () => {
  const min = cfgSizesDraft.length ? Math.min(...cfgSizesDraft.map((r) => r.t)) : 0;
  cfgSizesDraft.push({ t: Math.max(0, min + 100), sz: 48 });
  renderJarRows();
};
$('jarcfg-tintclear').onclick = () => {
  $('jarcfg-tint').value = '#7cc8ff';
  cfgToPreview({ type: 'config', tint: '' });
  $('jarcfg-tint').dataset.cleared = '1';
};
$('jarcfg-tint').oninput = () => {
  $('jarcfg-tint').dataset.cleared = '';
  cfgToPreview({ type: 'config', tint: $('jarcfg-tint').value });
};
$('jarcfg-save').onclick = () => {
  if (!settings[cfgTarget]) settings[cfgTarget] = {};
  settings[cfgTarget].tint = $('jarcfg-tint').dataset.cleared === '1' ? '' : $('jarcfg-tint').value;
  settings[cfgTarget].sizes = [...cfgSizesDraft].sort((a, b) => b.t - a.t);
  saveSettings();
  closeJarConfig();
};

// Refleja el color guardado en el selector del modal (si está abierto)
function applyJarronUI() {
  const t = $('jarcfg-tint');
  const data = settings?.[cfgTarget];
  if (t && data?.tint && /^#/.test(data.tint)) t.value = data.tint;
}

/* ---- Modal: Configurar Top donador ---- */
function topPreviewWin() { return $('top-preview')?.contentWindow; }
function topToPreview(msg) { topPreviewWin()?.postMessage({ kind: 'topdonor', ...msg }, '*'); }

function currentTopCfg() {
  return {
    title: $('topcfg-title').value || 'TOP DONADOR SEMANAL',
    coinLabel: $('topcfg-coinlabel').value || 'diamantes',
    c1: $('topcfg-c1').value,
    c2: $('topcfg-c2').value,
    nameColor: $('topcfg-namecolor').value,
    scale: Number($('topcfg-scale').value) || 100,
    showCountdown: $('topcfg-countdown').checked,
    showRunners: $('topcfg-runners').checked,
  };
}
function pushTopPreview() { topToPreview({ type: 'config', config: currentTopCfg() }); }

function openTopConfig() {
  if (!settings.topDonor) settings.topDonor = {};
  const c = settings.topDonor;
  $('topcfg-title').value = c.title || 'TOP DONADOR SEMANAL';
  $('topcfg-coinlabel').value = c.coinLabel || 'diamantes';
  $('topcfg-c1').value = /^#/.test(c.c1 || '') ? c.c1 : '#00e5ff';
  $('topcfg-c2').value = /^#/.test(c.c2 || '') ? c.c2 : '#ff2bd6';
  $('topcfg-namecolor').value = /^#/.test(c.nameColor || '') ? c.nameColor : '#ffffff';
  $('topcfg-scale').value = c.scale || 100;
  $('topcfg-countdown').checked = c.showCountdown !== false;
  $('topcfg-runners').checked = c.showRunners !== false;
  $('topConfigModal').classList.remove('hidden');
}
function closeTopConfig() { $('topConfigModal').classList.add('hidden'); }

['topcfg-title', 'topcfg-coinlabel', 'topcfg-c1', 'topcfg-c2', 'topcfg-namecolor', 'topcfg-scale', 'topcfg-countdown', 'topcfg-runners'].forEach((id) => {
  const el = $(id);
  if (el) { el.oninput = pushTopPreview; el.onchange = pushTopPreview; }
});
$('topcfg-close').onclick = closeTopConfig;
$('topConfigModal').addEventListener('click', (e) => { if (e.target.id === 'topConfigModal') closeTopConfig(); });
$('topcfg-resetweek').onclick = async () => {
  const ok = await askConfirm({ title: '¿Reiniciar el ranking semanal?', message: 'Se pondrán a cero todos los diamantes acumulados de esta semana.', confirmText: 'Reiniciar' });
  if (ok) send({ action: 'resetWeeklyTop' });
};
$('topcfg-save').onclick = () => {
  settings.topDonor = currentTopCfg();
  saveSettings();
  closeTopConfig();
};

/* ---- Gift VS (versus de regalos) ---- */
function gvsPreviewWin() { return $('gvs-preview')?.contentWindow; }
function gvsToPreview(msg) { gvsPreviewWin()?.postMessage({ kind: 'giftvs', ...msg }, '*'); }

let gvsRowsDraft = [];

function defaultGiftVsCfg() {
  return { meta: 500, goalStep: 500, onGoal: 'increase', countdown: 0, cdWhen: 'goal', cdRestart: false, rows: [] };
}

function currentGvsCfg() {
  return {
    meta: Math.max(1, parseInt($('gvscfg-meta').value, 10) || 500),
    goalStep: Math.max(1, parseInt($('gvscfg-goalstep').value, 10) || 500),
    onGoal: $('gvscfg-ongoal').value || 'increase',
    countdown: Math.max(0, parseInt($('gvscfg-countdown').value, 10) || 0),
    cdWhen: $('gvscfg-cdwhen').value === 'start' ? 'start' : 'goal',
    cdRestart: $('gvscfg-cdrestart').checked,
    rows: gvsRowsDraft.map((r) => ({ ...r })),
  };
}

function pushGiftVsPreview(cfg) {
  gvsToPreview({ type: 'config', config: cfg || settings?.giftVs || defaultGiftVsCfg() });
}

if ($('gvs-test')) {
  $('gvs-test').onclick = () => { gvsToPreview({ type: 'test' }); send({ action: 'testGiftVs' }); };
  $('gvs-reset').onclick = () => { gvsToPreview({ type: 'reset' }); send({ action: 'resetGiftVs' }); };
  $('gvs-config').onclick = openGvsConfig;
}

function openGvsConfig() {
  const c = settings?.giftVs || defaultGiftVsCfg();
  $('gvscfg-meta').value = c.meta || 500;
  $('gvscfg-goalstep').value = c.goalStep || 500;
  $('gvscfg-ongoal').value = c.onGoal || 'increase';
  $('gvscfg-countdown').value = c.countdown || 0;
  $('gvscfg-cdwhen').value = c.cdWhen === 'start' ? 'start' : 'goal';
  $('gvscfg-cdrestart').checked = !!c.cdRestart;
  gvsRowsDraft = (c.rows || []).map((r) => ({
    leftId: r.leftId || '', leftName: r.leftName || '', leftImg: r.leftImg || '', leftDiamonds: r.leftDiamonds || 0,
    rightId: r.rightId || '', rightName: r.rightName || '', rightImg: r.rightImg || '', rightDiamonds: r.rightDiamonds || 0,
  }));
  if (!gvsRowsDraft.length) gvsRowsDraft.push(emptyGvsRow());
  renderGvsRows();
  $('gvsConfigModal').classList.remove('hidden');
}
function closeGvsConfig() { $('gvsConfigModal').classList.add('hidden'); }
function emptyGvsRow() { return { leftId: '', leftName: '', leftImg: '', leftDiamonds: 0, rightId: '', rightName: '', rightImg: '', rightDiamonds: 0 }; }

function gvsGiftBtn(side, i, r) {
  const id = r[side + 'Id'], name = r[side + 'Name'], img = r[side + 'Img'];
  if (id) {
    return `<button type="button" class="gvs-giftbtn picked" data-side="${side}" data-i="${i}">
      ${img ? `<img src="${esc(img)}">` : ''}<span>${esc(name || ('#' + id))}</span></button>`;
  }
  return `<button type="button" class="gvs-giftbtn" data-side="${side}" data-i="${i}">＋ Elegir regalo</button>`;
}

function renderGvsRows() {
  const wrap = $('gvscfg-rows');
  wrap.innerHTML = gvsRowsDraft.map((r, i) => `
    <div class="gvs-row" data-i="${i}">
      <button type="button" class="jarcfg-del gvs-del" title="Quitar">✕</button>
      <div class="gvs-row-head">PAREJA ${i + 1}</div>
      <div class="gvs-row-grid">
        <div class="gvs-side-box">
          <label>Bando izquierdo</label>
          ${gvsGiftBtn('left', i, r)}
          <input type="number" min="0" class="gvs-dl" placeholder="💎 auto" value="${r.leftDiamonds || ''}">
        </div>
        <div class="gvs-vs">VS</div>
        <div class="gvs-side-box">
          <label>Bando derecho</label>
          ${gvsGiftBtn('right', i, r)}
          <input type="number" min="0" class="gvs-dr" placeholder="💎 auto" value="${r.rightDiamonds || ''}">
        </div>
      </div>
    </div>`).join('');

  wrap.querySelectorAll('.gvs-row').forEach((row) => {
    const i = Number(row.dataset.i);
    row.querySelector('.gvs-del').onclick = () => { gvsRowsDraft.splice(i, 1); if (!gvsRowsDraft.length) gvsRowsDraft.push(emptyGvsRow()); renderGvsRows(); };
    row.querySelector('.gvs-dl').onchange = (e) => { gvsRowsDraft[i].leftDiamonds = Math.max(0, parseInt(e.target.value, 10) || 0); pushGiftVsPreview(currentGvsCfg()); };
    row.querySelector('.gvs-dr').onchange = (e) => { gvsRowsDraft[i].rightDiamonds = Math.max(0, parseInt(e.target.value, 10) || 0); pushGiftVsPreview(currentGvsCfg()); };
    row.querySelectorAll('.gvs-giftbtn').forEach((btn) => {
      btn.onclick = () => {
        const side = btn.dataset.side;
        openGiftModalCb((g) => {
          gvsRowsDraft[i][side + 'Id'] = g.id;
          gvsRowsDraft[i][side + 'Name'] = g.name;
          gvsRowsDraft[i][side + 'Img'] = g.image;
          renderGvsRows();
          pushGiftVsPreview(currentGvsCfg());
        });
      };
    });
  });
  pushGiftVsPreview(currentGvsCfg());
}

['gvscfg-meta', 'gvscfg-goalstep', 'gvscfg-ongoal', 'gvscfg-countdown', 'gvscfg-cdwhen', 'gvscfg-cdrestart'].forEach((id) => {
  const el = $(id);
  if (el) { el.oninput = () => pushGiftVsPreview(currentGvsCfg()); el.onchange = () => pushGiftVsPreview(currentGvsCfg()); }
});
if ($('gvscfg-add')) $('gvscfg-add').onclick = () => { gvsRowsDraft.push(emptyGvsRow()); renderGvsRows(); };
if ($('gvscfg-close')) $('gvscfg-close').onclick = closeGvsConfig;
if ($('gvsConfigModal')) $('gvsConfigModal').addEventListener('click', (e) => { if (e.target.id === 'gvsConfigModal') closeGvsConfig(); });
if ($('gvscfg-save')) $('gvscfg-save').onclick = () => {
  settings.giftVs = currentGvsCfg();
  saveSettings();
  pushGiftVsPreview(settings.giftVs);
  closeGvsConfig();
};

/* ---- Gift Sequence (secuencia de regalos) ---- */
function gsqPreviewWin() { return $('gsq-preview')?.contentWindow; }
function gsqToPreview(msg) { gsqPreviewWin()?.postMessage({ kind: 'giftseq', ...msg }, '*'); }

let gsqSeqDraft = [];

function defaultGiftSeqCfg() {
  return { text: '#f4f7ff', accent: '#8df7d8', size: 28, font: "'Arial Black', sans-serif", anim: 'gift-pop', rowSpeed: 7.6, textRainbow: false, stepSec: 2, sequence: [] };
}

function currentGsqCfg() {
  return {
    text: $('gsqcfg-text').value || '#f4f7ff',
    accent: '#8df7d8',
    size: Math.max(10, Math.min(80, parseInt($('gsqcfg-size').value, 10) || 28)),
    font: "'Arial Black', sans-serif",
    anim: $('gsqcfg-anim').value || 'gift-pop',
    rowSpeed: Math.max(3.2, Math.min(16, parseFloat($('gsqcfg-rowspeed').value) || 7.6)),
    textRainbow: $('gsqcfg-rainbow').checked,
    stepSec: Math.max(1, Math.min(15, parseInt($('gsqcfg-step').value, 10) || 2)),
    sequence: gsqSeqDraft.map((r) => ({ ...r })),
  };
}

function pushGiftSeqPreview(cfg) {
  gsqToPreview({ type: 'config', config: cfg || settings?.giftSeq || defaultGiftSeqCfg() });
}

if ($('gsq-test')) {
  $('gsq-test').onclick = () => { gsqToPreview({ type: 'test' }); send({ action: 'testGiftSeq' }); };
  $('gsq-reset').onclick = () => { gsqToPreview({ type: 'reset' }); send({ action: 'resetGiftSeq' }); };
  $('gsq-config').onclick = openGsqConfig;
}

const GSQ_SIDES = [['bottom', 'Abajo'], ['top', 'Arriba'], ['left', 'Izquierda'], ['right', 'Derecha']];
function emptyGsqItem() { return { giftName: '', giftImage: '', customText: '', textSide: 'bottom' }; }

function openGsqConfig() {
  const c = settings?.giftSeq || defaultGiftSeqCfg();
  $('gsqcfg-step').value = c.stepSec || 2;
  $('gsqcfg-anim').value = c.anim || 'gift-pop';
  $('gsqcfg-size').value = c.size || 28;
  $('gsqcfg-rowspeed').value = c.rowSpeed || 7.6;
  $('gsqcfg-text').value = /^#/.test(c.text || '') ? c.text : '#f4f7ff';
  $('gsqcfg-rainbow').checked = !!c.textRainbow;
  gsqSeqDraft = (c.sequence || []).map((r) => ({
    giftName: r.giftName || '', giftImage: r.giftImage || '', customText: r.customText || '', textSide: r.textSide || 'bottom',
  }));
  if (!gsqSeqDraft.length) gsqSeqDraft.push(emptyGsqItem());
  renderGsqRows();
  $('gsqConfigModal').classList.remove('hidden');
}
function closeGsqConfig() { $('gsqConfigModal').classList.add('hidden'); }

function renderGsqRows() {
  const wrap = $('gsqcfg-rows');
  wrap.innerHTML = gsqSeqDraft.map((r, i) => {
    const giftBtn = r.giftName
      ? `<button type="button" class="gvs-giftbtn picked" data-i="${i}">${r.giftImage ? `<img src="${esc(r.giftImage)}">` : ''}<span>${esc(r.giftName)}</span></button>`
      : `<button type="button" class="gvs-giftbtn" data-i="${i}">＋ Elegir regalo</button>`;
    const sideOpts = GSQ_SIDES.map(([v, lbl]) => `<option value="${v}" ${r.textSide === v ? 'selected' : ''}>${lbl}</option>`).join('');
    return `
      <div class="gvs-row" data-i="${i}">
        <button type="button" class="jarcfg-del gsq-del" title="Quitar">✕</button>
        <div class="gvs-row-head">REGALO ${i + 1}</div>
        <div class="gsq-row-grid">
          <div class="gvs-side-box">
            <label>Regalo</label>
            ${giftBtn}
          </div>
          <div class="gvs-side-box">
            <label>Texto a mostrar</label>
            <input type="text" class="gsq-text" maxlength="60" placeholder="Ej.: Bailo" value="${esc(r.customText)}">
          </div>
          <div class="gvs-side-box">
            <label>Posición del texto</label>
            <select class="gsq-side">${sideOpts}</select>
          </div>
        </div>
      </div>`;
  }).join('');

  wrap.querySelectorAll('.gvs-row').forEach((row) => {
    const i = Number(row.dataset.i);
    row.querySelector('.gsq-del').onclick = () => { gsqSeqDraft.splice(i, 1); if (!gsqSeqDraft.length) gsqSeqDraft.push(emptyGsqItem()); renderGsqRows(); };
    row.querySelector('.gsq-text').oninput = (e) => { gsqSeqDraft[i].customText = e.target.value; pushGiftSeqPreview(currentGsqCfg()); };
    row.querySelector('.gsq-side').onchange = (e) => { gsqSeqDraft[i].textSide = e.target.value; pushGiftSeqPreview(currentGsqCfg()); };
    row.querySelector('.gvs-giftbtn').onclick = () => {
      openGiftModalCb((g) => {
        gsqSeqDraft[i].giftName = g.name;
        gsqSeqDraft[i].giftImage = g.image;
        if (!gsqSeqDraft[i].customText) gsqSeqDraft[i].customText = g.name;
        renderGsqRows();
        pushGiftSeqPreview(currentGsqCfg());
      });
    };
  });
  pushGiftSeqPreview(currentGsqCfg());
}

['gsqcfg-step', 'gsqcfg-anim', 'gsqcfg-size', 'gsqcfg-rowspeed', 'gsqcfg-text', 'gsqcfg-rainbow'].forEach((id) => {
  const el = $(id);
  if (el) { el.oninput = () => pushGiftSeqPreview(currentGsqCfg()); el.onchange = () => pushGiftSeqPreview(currentGsqCfg()); }
});
if ($('gsqcfg-add')) $('gsqcfg-add').onclick = () => { gsqSeqDraft.push(emptyGsqItem()); renderGsqRows(); };
if ($('gsqcfg-close')) $('gsqcfg-close').onclick = closeGsqConfig;
if ($('gsqConfigModal')) $('gsqConfigModal').addEventListener('click', (e) => { if (e.target.id === 'gsqConfigModal') closeGsqConfig(); });
if ($('gsqcfg-save')) $('gsqcfg-save').onclick = () => {
  settings.giftSeq = currentGsqCfg();
  saveSettings();
  pushGiftSeqPreview(settings.giftSeq);
  closeGsqConfig();
};

/* ---- Overlays simples (mejor regalo, racha, batallas, coin match) ---- */
function randomGiftSample() {
  if (giftCatalog && giftCatalog.length) {
    const g = giftCatalog[Math.floor(Math.random() * giftCatalog.length)];
    return { name: g.name, image: g.image || '', diamonds: g.diamonds || 0 };
  }
  const fb = [['Rose', 1], ['Finger Heart', 5], ['GG', 1], ['TikTok', 1], ['Galaxy', 1000], ['Lion', 29999]];
  const x = fb[Math.floor(Math.random() * fb.length)];
  return { name: x[0], image: '', diamonds: x[1] };
}

const CFG_FONTS = [
  ['rubik', 'Rubik'], ['oswald', 'Oswald'], ['bebas', 'Bebas Neue'], ['montserrat', 'Montserrat'],
  ['poppins', 'Poppins'], ['orbitron', 'Orbitron'], ['inter', 'Inter'], ['system', 'Sistema'],
];
document.querySelectorAll('select.cfg-font').forEach((sel) => {
  sel.innerHTML = CFG_FONTS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
});

function fillForm(map, data) {
  for (const [id, key] of Object.entries(map)) {
    const el = $(id); if (!el) continue;
    const v = data[key];
    if (el.type === 'checkbox') el.checked = v !== false;
    else if (v != null) el.value = v;
  }
}
function readForm(map, types) {
  const out = {};
  for (const [id, key] of Object.entries(map)) {
    const el = $(id); if (!el) continue;
    if (el.type === 'checkbox') out[key] = el.checked;
    else if (types && types[key] === 'int') out[key] = parseInt(el.value, 10) || 0;
    else out[key] = el.value;
  }
  return out;
}

function setupStyleOverlay(o) {
  const prevWin = () => $(o.previewId)?.contentWindow;
  const toPreview = (msg) => prevWin()?.postMessage({ kind: o.kind, ...msg }, '*');
  const buildCfg = () => readForm(o.map, o.types);
  const pushPreview = (cfg) => toPreview({ type: 'config', config: cfg || settings?.[o.settingsKey] || {} });

  if ($(o.btnTest)) $(o.btnTest).onclick = () => {
    const extra = o.randomGift ? { gift: randomGiftSample() } : {};
    if (o.rank) extra.rank = o.rank;
    toPreview({ type: 'test', ...extra });
    send({ action: o.testAction, ...extra });
  };
  if ($(o.btnReset)) $(o.btnReset).onclick = () => { toPreview({ type: 'reset' }); send({ action: o.resetAction, ...(o.rank ? { rank: o.rank } : {}) }); };
  if ($(o.btnConfig)) $(o.btnConfig).onclick = () => {
    fillForm(o.map, settings?.[o.settingsKey] || {});
    pushPreview(buildCfg());
    $(o.modalId).classList.remove('hidden');
  };
  const close = () => $(o.modalId).classList.add('hidden');
  if ($(o.closeId)) $(o.closeId).onclick = close;
  if ($(o.modalId)) $(o.modalId).addEventListener('click', (e) => { if (e.target.id === o.modalId) close(); });
  Object.keys(o.map).forEach((id) => {
    const el = $(id);
    if (el) { el.oninput = () => pushPreview(buildCfg()); el.onchange = () => pushPreview(buildCfg()); }
  });
  if ($(o.saveId)) $(o.saveId).onclick = () => { settings[o.settingsKey] = buildCfg(); saveSettings(); pushPreview(settings[o.settingsKey]); close(); };
  o._push = () => pushPreview();
  return o;
}

const STYLE_OVERLAYS = [
  setupStyleOverlay({
    kind: 'topgift', settingsKey: 'topGift', previewId: 'tgf-preview',
    btnTest: 'tgf-test', btnReset: 'tgf-reset', btnConfig: 'tgf-config',
    modalId: 'tgfConfigModal', closeId: 'tgfcfg-close', saveId: 'tgfcfg-save',
    testAction: 'testTopGift', resetAction: 'resetTopGift', randomGift: true,
    map: { 'tgfcfg-title': 'title', 'tgfcfg-coinlabel': 'coinLabel', 'tgfcfg-font': 'font', 'tgfcfg-rainbow': 'titleRainbow',
      'tgfcfg-tc1': 'tc1', 'tgfcfg-tc2': 'tc2', 'tgfcfg-tc3': 'tc3', 'tgfcfg-namecolor': 'nameColor', 'tgfcfg-valuecolor': 'valueColor', 'tgfcfg-namestroke': 'nameStroke', 'tgfcfg-valuestroke': 'valueStroke' },
  }),
  setupStyleOverlay({
    kind: 'topstreak', settingsKey: 'topStreak', previewId: 'tst-preview',
    btnTest: 'tst-test', btnReset: 'tst-reset', btnConfig: 'tst-config',
    modalId: 'tstConfigModal', closeId: 'tstcfg-close', saveId: 'tstcfg-save',
    testAction: 'testTopStreak', resetAction: 'resetTopStreak', randomGift: true,
    map: { 'tstcfg-title': 'title', 'tstcfg-font': 'font', 'tstcfg-rainbow': 'titleRainbow',
      'tstcfg-tc1': 'tc1', 'tstcfg-tc2': 'tc2', 'tstcfg-tc3': 'tc3', 'tstcfg-namecolor': 'nameColor', 'tstcfg-valuecolor': 'valueColor', 'tstcfg-namestroke': 'nameStroke', 'tstcfg-valuestroke': 'valueStroke' },
  }),
  setupStyleOverlay({
    kind: 'batgifts', settingsKey: 'batallaGifts', previewId: 'bgf-preview',
    btnTest: 'bgf-test', btnReset: 'bgf-reset', btnConfig: 'bgf-config',
    modalId: 'bgfConfigModal', closeId: 'bgfcfg-close', saveId: 'bgfcfg-save',
    testAction: 'testBatallaGifts', resetAction: 'resetBatallaGifts',
    map: { 'bgfcfg-limit': 'limit', 'bgfcfg-rainbow': 'nameRainbow', 'bgfcfg-valuecolor': 'valueColor', 'bgfcfg-coincolor': 'coinColor', 'bgfcfg-placeholder': 'placeholder' },
    types: { limit: 'int' },
  }),
  setupStyleOverlay({
    kind: 'batlikes', settingsKey: 'batallaLikes', previewId: 'bli-preview',
    btnTest: 'bli-test', btnReset: 'bli-reset', btnConfig: 'bli-config',
    modalId: 'bliConfigModal', closeId: 'blicfg-close', saveId: 'blicfg-save',
    testAction: 'testBatallaLikes', resetAction: 'resetBatallaLikes',
    map: { 'blicfg-limit': 'limit', 'blicfg-rainbow': 'nameRainbow', 'blicfg-valuecolor': 'valueColor', 'blicfg-icon': 'likesIcon', 'blicfg-placeholder': 'placeholder' },
    types: { limit: 'int' },
  }),
  setupStyleOverlay({
    kind: 'coinmatch', settingsKey: 'coinMatch', previewId: 'cm-preview',
    btnTest: 'cm-test', btnReset: '', btnConfig: 'cm-config',
    modalId: 'cmConfigModal', closeId: 'cmcfg-close', saveId: 'cmcfg-save',
    testAction: 'testCoinMatch', resetAction: '',
    map: { 'cmcfg-title': 'title', 'cmcfg-dur': 'durationSec', 'cmcfg-top': 'topN', 'cmcfg-delay': 'startDelaySec',
      'cmcfg-reveal': 'revealSec', 'cmcfg-minbid': 'minBid', 'cmcfg-maxp': 'maxParticipants', 'cmcfg-winmode': 'winMode',
      'cmcfg-accent': 'accent', 'cmcfg-font': 'font', 'cmcfg-showtitle': 'showTitle', 'cmcfg-showcount': 'showCount',
      'cmcfg-scroll': 'scroll', 'cmcfg-sniper': 'sniper', 'cmcfg-slowcd': 'slowReveal' },
    types: { durationSec: 'int', topN: 'int', startDelaySec: 'int', revealSec: 'int', minBid: 'int', maxParticipants: 'int' },
  }),
  setupStyleOverlay({
    kind: 'toplikes', settingsKey: 'toplikesRank', previewId: 'tlk-preview', rank: 'toplikes',
    btnTest: 'tlk-test', btnReset: 'tlk-reset', btnConfig: 'tlk-config',
    modalId: 'tlkConfigModal', closeId: 'tlkcfg-close', saveId: 'tlkcfg-save',
    testAction: 'testRank', resetAction: 'resetRank',
    map: { 'tlkcfg-rows': 'rows', 'tlkcfg-scale': 'scale', 'tlkcfg-accent': 'accent', 'tlkcfg-rowbg': 'rowBg',
      'tlkcfg-transparent': 'transparent', 'tlkcfg-rainbow': 'nameRainbow', 'tlkcfg-lines': 'lines', 'tlkcfg-shadows': 'shadows' },
    types: { rows: 'int', scale: 'int' },
  }),
  setupStyleOverlay({
    kind: 'topdiam', settingsKey: 'topdiamRank', previewId: 'tdm-preview', rank: 'topdiam',
    btnTest: 'tdm-test', btnReset: 'tdm-reset', btnConfig: 'tdm-config',
    modalId: 'tdmConfigModal', closeId: 'tdmcfg-close', saveId: 'tdmcfg-save',
    testAction: 'testRank', resetAction: 'resetRank',
    map: { 'tdmcfg-rows': 'rows', 'tdmcfg-scale': 'scale', 'tdmcfg-accent': 'accent', 'tdmcfg-rowbg': 'rowBg',
      'tdmcfg-transparent': 'transparent', 'tdmcfg-rainbow': 'nameRainbow', 'tdmcfg-lines': 'lines', 'tdmcfg-shadows': 'shadows' },
    types: { rows: 'int', scale: 'int' },
  }),
  setupStyleOverlay({
    kind: 'toplikeslist', settingsKey: 'toplikesList', previewId: 'tll-preview', rank: 'toplikeslist',
    btnTest: 'tll-test', btnReset: 'tll-reset', btnConfig: 'tll-config',
    modalId: 'tllConfigModal', closeId: 'tllcfg-close', saveId: 'tllcfg-save',
    testAction: 'testRank', resetAction: 'resetRank',
    map: { 'tllcfg-rows': 'rows', 'tllcfg-scale': 'scale', 'tllcfg-accent': 'accent',
      'tllcfg-transparent': 'transparent', 'tllcfg-rainbow': 'nameRainbow', 'tllcfg-lines': 'lines', 'tllcfg-shadows': 'shadows' },
    types: { rows: 'int', scale: 'int' },
  }),
  setupStyleOverlay({
    kind: 'topdiamlist', settingsKey: 'topdiamList', previewId: 'tdl-preview', rank: 'topdiamlist',
    btnTest: 'tdl-test', btnReset: 'tdl-reset', btnConfig: 'tdl-config',
    modalId: 'tdlConfigModal', closeId: 'tdlcfg-close', saveId: 'tdlcfg-save',
    testAction: 'testRank', resetAction: 'resetRank',
    map: { 'tdlcfg-rows': 'rows', 'tdlcfg-scale': 'scale', 'tdlcfg-accent': 'accent',
      'tdlcfg-transparent': 'transparent', 'tdlcfg-rainbow': 'nameRainbow', 'tdlcfg-lines': 'lines', 'tdlcfg-shadows': 'shadows' },
    types: { rows: 'int', scale: 'int' },
  }),
  setupStyleOverlay({
    kind: 'alertagift', settingsKey: 'alertaGift', previewId: 'agf-preview',
    btnTest: 'agf-test', btnReset: 'agf-reset', btnConfig: 'agf-config',
    modalId: 'agfConfigModal', closeId: 'agfcfg-close', saveId: 'agfcfg-save',
    testAction: 'testAlertaGift', resetAction: 'resetAlertaGift',
    map: { 'agfcfg-headline': 'headline', 'agfcfg-dur': 'durationSec', 'agfcfg-scale': 'scale',
      'agfcfg-g1': 'g1', 'agfcfg-g2': 'g2', 'agfcfg-g3': 'g3', 'agfcfg-name': 'nameColor', 'agfcfg-sub': 'subColor' },
    types: { durationSec: 'int', scale: 'int' },
  }),
  setupStyleOverlay({
    kind: 'alertalikes', settingsKey: 'alertaLikes', previewId: 'alk-preview',
    btnTest: 'alk-test', btnReset: 'alk-reset', btnConfig: 'alk-config',
    modalId: 'alkConfigModal', closeId: 'alkcfg-close', saveId: 'alkcfg-save',
    testAction: 'testAlertaLikes', resetAction: 'resetAlertaLikes',
    map: { 'alkcfg-dur': 'durationSec', 'alkcfg-scale': 'scale', 'alkcfg-g1': 'g1', 'alkcfg-g2': 'g2', 'alkcfg-g3': 'g3' },
    types: { durationSec: 'int', scale: 'int' },
  }),
  setupStyleOverlay({
    kind: 'alertafollow', settingsKey: 'alertaFollow', previewId: 'afl-preview',
    btnTest: 'afl-test', btnReset: 'afl-reset', btnConfig: 'afl-config',
    modalId: 'aflConfigModal', closeId: 'aflcfg-close', saveId: 'aflcfg-save',
    testAction: 'testAlertaFollow', resetAction: 'resetAlertaFollow',
    map: { 'aflcfg-h1': 'headline1', 'aflcfg-h2': 'headline2', 'aflcfg-s1': 'sub1', 'aflcfg-s2': 'sub2',
      'aflcfg-enter': 'enterAnim', 'aflcfg-dur': 'durationSec', 'aflcfg-scale': 'scale',
      'aflcfg-g1': 'g1', 'aflcfg-g2': 'g2', 'aflcfg-g3': 'g3', 'aflcfg-name': 'nameColor', 'aflcfg-sub': 'subColor',
      'aflcfg-avatar': 'showAvatar', 'aflcfg-rays': 'showRays', 'aflcfg-dust': 'showDust', 'aflcfg-shards': 'showShards' },
    types: { durationSec: 'int', scale: 'int' },
  }),
  setupStyleOverlay({
    kind: 'streamjoin', settingsKey: 'streamJoin', previewId: 'sjn-preview',
    btnTest: 'sjn-test', btnReset: 'sjn-reset', btnConfig: 'sjn-config',
    modalId: 'sjnConfigModal', closeId: 'sjncfg-close', saveId: 'sjncfg-save',
    testAction: 'testStreamJoin', resetAction: 'resetStreamJoin',
    map: { 'sjncfg-neon': 'neon', 'sjncfg-dur': 'durationSec', 'sjncfg-scale': 'scale', 'sjncfg-laser': 'laserSpeed',
      'sjncfg-top': 'posTop', 'sjncfg-left': 'posLeft', 'sjncfg-bgop': 'bgOpacity', 'sjncfg-tagsz': 'tagSize',
      'sjncfg-stsz': 'statusSize', 'sjncfg-pmode': 'phraseMode', 'sjncfg-phrase': 'phrase', 'sjncfg-phrases': 'phrases' },
    types: { scale: 'int', posTop: 'int', posLeft: 'int', bgOpacity: 'int' },
  }),
];

// Coin Match: controles de partido (iniciar/terminar/ganadores) + reset propio
(function setupCoinMatchControls() {
  const cmPrev = () => $('cm-preview')?.contentWindow;
  const toPrev = (msg) => cmPrev()?.postMessage({ kind: 'coinmatch', ...msg }, '*');
  if ($('cm-start')) $('cm-start').onclick = () => { const dur = settings?.coinMatch?.durationSec; toPrev({ type: 'action', action: 'start', durationSec: dur }); send({ action: 'coinMatch', coinAction: 'start', durationSec: dur }); };
  if ($('cm-end')) $('cm-end').onclick = () => { toPrev({ type: 'action', action: 'end' }); send({ action: 'coinMatch', coinAction: 'end' }); };
  if ($('cm-winners')) $('cm-winners').onclick = () => { toPrev({ type: 'action', action: 'winners' }); send({ action: 'coinMatch', coinAction: 'winners' }); };
  if ($('cm-reset')) $('cm-reset').onclick = () => { toPrev({ type: 'action', action: 'reset' }); send({ action: 'coinMatch', coinAction: 'reset' }); };
})();

function pushStyleOverlayPreviews() {
  STYLE_OVERLAYS.forEach((o) => { if (o._push) o._push(); });
}

/* ---- Barra de meta (Hype) — config con selector de diseño (skin) ---- */
(function setupHypeOverlay() {
  const frame = () => $('hyp-preview');
  const toPrev = (msg) => frame()?.contentWindow?.postMessage({ kind: 'hype', ...msg }, '*');
  const MAP = {
    'hypcfg-skin': 'skin', 'hypcfg-kind': 'goalKind', 'hypcfg-title': 'title', 'hypcfg-meta': 'meta',
    'hypcfg-reach': 'whenReach', 'hypcfg-scale': 'scale', 'hypcfg-plike': 'pointsLike', 'hypcfg-pfollow': 'pointsFollow',
    'hypcfg-pshare': 'pointsShare', 'hypcfg-pgift': 'pointsGift', 'hypcfg-pmember': 'pointsMember',
  };
  const TYPES = { meta: 'int', scale: 'int', pointsLike: 'int', pointsFollow: 'int', pointsShare: 'int', pointsGift: 'int', pointsMember: 'int' };
  const build = () => readForm(MAP, TYPES);

  function applySkin(skin) {
    const f = frame();
    const skinQ = skin && skin !== 'default' ? '&skin=' + skin : '';
    const want = '/meta.html?embed=1' + skinQ;
    if (f && f.getAttribute('src') !== want) {
      f.onload = () => toPrev({ type: 'config', config: build() });
      f.src = want;
    }
    const path = '/meta.html' + (skin && skin !== 'default' ? '?skin=' + skin : '');
    const code = document.querySelector('#hyp-card .ov-url');
    if (code) { code.dataset.path = path; code.textContent = roomUrl(path); }
  }
  function pushPreview(cfg) { toPrev({ type: 'config', config: cfg || settings?.hypeBar || {} }); }

  if ($('hyp-test')) $('hyp-test').onclick = () => { toPrev({ type: 'test' }); send({ action: 'testHype' }); };
  if ($('hyp-reset')) $('hyp-reset').onclick = () => { toPrev({ type: 'reset' }); send({ action: 'resetHype' }); };
  if ($('hyp-config')) $('hyp-config').onclick = () => {
    fillForm(MAP, settings?.hypeBar || {});
    applySkin((settings?.hypeBar || {}).skin || 'default');
    pushPreview(build());
    $('hypConfigModal').classList.remove('hidden');
  };
  const close = () => $('hypConfigModal')?.classList.add('hidden');
  if ($('hypcfg-close')) $('hypcfg-close').onclick = close;
  if ($('hypConfigModal')) $('hypConfigModal').addEventListener('click', (e) => { if (e.target.id === 'hypConfigModal') close(); });
  Object.keys(MAP).forEach((id) => {
    const el = $(id);
    if (!el) return;
    el.oninput = () => { const c = build(); if (id === 'hypcfg-skin') applySkin(c.skin); else pushPreview(c); };
    el.onchange = el.oninput;
  });
  if ($('hypcfg-save')) $('hypcfg-save').onclick = () => { settings.hypeBar = build(); saveSettings(); applySkin(settings.hypeBar.skin); pushPreview(settings.hypeBar); close(); };

  window.pushHypePreview = () => { applySkin((settings?.hypeBar || {}).skin || 'default'); pushPreview(); };
})();

/* ====================== Chat TTS ====================== */
const TTS_HAS = 'speechSynthesis' in window;
let ttsVoices = [];
const ttsPoints = Object.create(null);   // monedas acumuladas por usuario (regalos)

const LANG_NAMES = {
  es: 'Español', en: 'Inglés', pt: 'Portugués', fr: 'Francés', it: 'Italiano',
  de: 'Alemán', ja: 'Japonés', ko: 'Coreano', zh: 'Chino', ru: 'Ruso',
  ar: 'Árabe', hi: 'Hindi', tr: 'Turco', nl: 'Neerlandés', pl: 'Polaco',
};
function langLabel(code) {
  const base = code.split('-')[0].toLowerCase();
  const name = LANG_NAMES[base] || base.toUpperCase();
  return code.includes('-') ? `${name} (${code})` : name;
}

function loadVoices() {
  if (!TTS_HAS) return;
  ttsVoices = speechSynthesis.getVoices() || [];
  const t = settings?.tts || {};
  // Idiomas únicos disponibles
  const langSel = $('tts-lang');
  if (langSel) {
    const seen = new Map();
    ttsVoices.forEach((v) => { if (v.lang && !seen.has(v.lang)) seen.set(v.lang, true); });
    const langs = Array.from(seen.keys()).sort();
    const cur = t.lang || 'es';
    langSel.innerHTML = '<option value="">Todos los idiomas</option>' +
      langs.map((l) => `<option value="${esc(l)}" ${l === cur || l.startsWith(cur) ? 'selected' : ''}>${esc(langLabel(l))}</option>`).join('');
  }
  fillVoiceOptions();
}
function fillVoiceOptions() {
  const sel = $('tts-voice');
  if (!sel) return;
  const t = settings?.tts || {};
  const langFilter = (t.lang || '').toLowerCase();
  const list = ttsVoices.filter((v) => !langFilter || (v.lang || '').toLowerCase().startsWith(langFilter));
  const voices = list.length ? list : ttsVoices;
  sel.innerHTML = '<option value="">(voz por defecto)</option>' +
    voices.map((v) => `<option value="${esc(v.name)}" ${v.name === t.voice ? 'selected' : ''}>${esc(v.name)} — ${esc(v.lang)}</option>`).join('');
}

function applyTtsUI(t) {
  const set = (id, v) => { const el = $(id); if (el) el.checked = !!v; };
  const val = (id, v) => { const el = $(id); if (el) el.value = v; };
  set('tts-enabled', t.enabled);
  set('tts-readname', t.readName);
  val('tts-tiktok-voice', t.tiktokVoice || '');
  set('tts-tiktok-translate', t.tiktokTranslateEs !== false);
  val('tts-rate', t.rate ?? 1.2); const rv = $('tts-rate-val'); if (rv) rv.textContent = (+(t.rate ?? 1.2)).toFixed(1);
  val('tts-pitch', t.pitch ?? 1); const pv = $('tts-pitch-val'); if (pv) pv.textContent = (+(t.pitch ?? 1)).toFixed(1);
  val('tts-vol', t.volume ?? 1); const vv = $('tts-vol-val'); if (vv) vv.textContent = Math.round((t.volume ?? 1) * 100);
  loadVoices();
  // permitidos
  set('tts-allow-all', t.allowAll !== false);
  set('tts-allow-followers', t.allowFollowers);
  set('tts-allow-subs', t.allowSubs);
  set('tts-allow-mods', t.allowMods);
  set('tts-allow-team', t.allowTeam);
  syncTtsAllowUI();
  // trigger
  const trig = t.trigger || 'all';
  document.querySelectorAll('input[name="tts-trigger"]').forEach((r) => { r.checked = r.value === trig; });
  val('tts-command', t.command || '!tts');
  // monetización
  document.querySelectorAll('input[name="tts-charge"]').forEach((r) => { r.checked = r.value === (t.charge ? '1' : '0'); });
  val('tts-cost', t.cost ?? 5);
  // moderación
  set('tts-block-spam', t.blockSpam);
  set('tts-block-alpha', t.blockAlpha);
  set('tts-block-prof', t.blockProfanity);
  set('tts-block-susp', t.blockSuspicious);
  set('tts-strip-emojis', t.stripEmojis);
  val('tts-blocked-words', t.blockedWords || '');
  // seguidores
  set('tts-read-follow', t.readFollow);
  val('tts-follow-msg', t.followMsg || 'Hola {user}, gracias por seguirme');
  // eventos
  set('tts-read-share', t.readShare);
  set('tts-read-taptap', t.readTaptap);
  val('tts-taptap-min', t.taptapMin ?? 100);
  set('tts-read-gifts', t.readGifts);
  updateTtsSummary();
}

function updateTtsSummary() {
  const t = settings?.tts || {};
  const el = $('tts-summary');
  if (!el) return;
  if (!t.enabled) { el.textContent = 'El Chat TTS está desactivado.'; return; }
  let who = 'de todos los usuarios';
  if (t.allowAll === false) {
    const roles = [];
    if (t.allowFollowers) roles.push('seguidores');
    if (t.allowSubs) roles.push('suscriptores');
    if (t.allowMods) roles.push('moderadores');
    if (t.allowTeam) roles.push('miembros del equipo');
    who = roles.length ? 'de ' + roles.join(', ') : 'de nadie (elige al menos un grupo)';
  }
  const trig = { all: 'cualquier comentario', dot: 'comentarios que empiezan con punto', slash: 'comentarios que empiezan con /', command: `comentarios con "${t.command || '!tts'}"` }[t.trigger || 'all'];
  const money = t.charge ? `Cobra ${t.cost} monedas por mensaje.` : 'El uso es gratuito.';
  el.textContent = `Se leerá ${trig} ${who}. ${money}`;
}

/* ---- Filtros de moderación ---- */
const PROFANITY = ['puta', 'puto', 'mierda', 'pendejo', 'cabron', 'cabrón', 'verga', 'coño', 'joto', 'culero', 'chinga', 'perra', 'zorra', 'maricon', 'maricón', 'pinche', 'fuck', 'shit', 'bitch', 'asshole'];
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{200D}]/gu;

function ttsModerate(text) {
  const t = settings?.tts || {};
  let s = String(text || '');
  if (t.stripEmojis) s = s.replace(EMOJI_RE, '');
  s = s.replace(/\s+/g, ' ').trim();
  if (!s) return null;
  const low = s.toLowerCase();

  // Palabras bloqueadas extra
  if (t.blockedWords) {
    const words = t.blockedWords.split(/[,\n]/).map((w) => w.trim().toLowerCase()).filter(Boolean);
    if (words.some((w) => low.includes(w))) return null;
  }
  if (t.blockProfanity && PROFANITY.some((w) => new RegExp('\\b' + w, 'i').test(low))) return null;
  if (t.blockSpam) {
    if (/(.)\1{5,}/.test(s)) return null;                 // mismo caracter repetido
    const toks = low.split(' ');
    if (toks.length >= 4 && new Set(toks).size <= 2) return null; // misma palabra repetida
  }
  if (t.blockSuspicious) {
    if (/(https?:\/\/|www\.|\.com|\.net|\.xyz)/i.test(low)) return null;
    const letters = (s.match(/[\p{L}\p{N}\s]/gu) || []).length;
    if (s.length >= 6 && letters / s.length < 0.5) return null; // demasiados símbolos raros
  }
  if (t.blockAlpha) {
    const latin = (s.match(/[a-zA-ZáéíóúüñÁÉÍÓÚÜÑ]/g) || []).length;
    const otherScript = (s.match(/[\u0400-\u04FF\u0600-\u06FF\u0590-\u05FF\u3040-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF]/g) || []).length;
    if (otherScript > latin && otherScript > 2) return null;
  }
  return s;
}

function ttsAllowedUser(p) {
  const t = settings?.tts || {};
  if (t.allowAll !== false) return true;
  const anyRole = t.allowFollowers || t.allowSubs || t.allowMods || t.allowTeam;
  if (!anyRole) return false;
  if (t.allowFollowers && !!p.isFollower) return true;
  if (t.allowSubs && !!p.isSub) return true;
  if (t.allowMods && !!p.isMod) return true;
  if (t.allowTeam && !!p.isTeam) return true;
  return false;
}

const TTS_ALLOW_SPECIFIC = [
  { id: 'tts-allow-followers', key: 'allowFollowers' },
  { id: 'tts-allow-subs', key: 'allowSubs' },
  { id: 'tts-allow-mods', key: 'allowMods' },
  { id: 'tts-allow-team', key: 'allowTeam' },
];

function syncTtsAllowUI() {
  const allEl = $('tts-allow-all');
  const allOn = !!(allEl && allEl.checked);
  TTS_ALLOW_SPECIFIC.forEach(({ id }) => {
    const el = $(id);
    if (!el) return;
    el.disabled = allOn;
    el.closest('.switch-row')?.classList.toggle('is-disabled', allOn);
  });
}

function ttsTriggerMatch(text) {
  const t = settings?.tts || {};
  const s = String(text || '').trim();
  switch (t.trigger) {
    case 'dot': return s.startsWith('.') ? s.slice(1).trim() : null;
    case 'slash': return s.startsWith('/') ? s.slice(1).trim() : null;
    case 'command': {
      const cmd = (t.command || '!tts').trim();
      if (cmd && s.toLowerCase().startsWith(cmd.toLowerCase())) return s.slice(cmd.length).trim();
      return null;
    }
    default: return s;
  }
}

function ttsSpeakText(text) {
  const t = settings?.tts || {};
  const phrase = String(text || '').trim();
  if (!phrase) return;
  // Si hay una voz TikTok elegida, la síntesis va por el servidor (voces Disney, etc.).
  if (t.tiktokVoice) { ttsSpeakTikTok(phrase, t); return; }
  ttsSpeakSystem(phrase, t);
}

// Voz del sistema (navegador), como siempre.
function ttsSpeakSystem(phrase, t) {
  if (!TTS_HAS) return;
  const u = new SpeechSynthesisUtterance(phrase);
  u.rate = t.rate || 1;
  u.pitch = t.pitch ?? 1;
  u.volume = t.volume ?? 1;
  const voice = ttsVoices.find((v) => v.name === t.voice);
  if (voice) u.voice = voice;
  else if (t.lang) { const byLang = ttsVoices.find((v) => (v.lang || '').toLowerCase().startsWith(t.lang.toLowerCase())); if (byLang) u.voice = byLang; }
  speechSynthesis.speak(u);
}

/* ---- Cola de audio para voces TikTok (no se solapan; van una tras otra) ---- */
let ttsTkQueue = [];
let ttsTkBusy = false;
let ttsTkAudio = null;

function ttsSpeakTikTok(phrase, t) {
  ttsTkQueue.push({ text: phrase, voice: t.tiktokVoice, translate: t.tiktokTranslateEs !== false, volume: t.volume ?? 1 });
  if (ttsTkQueue.length > 25) ttsTkQueue.shift(); // evita acumular si llega mucho chat
  ttsTkPump();
}

function ttsStopTikTok() {
  ttsTkQueue = [];
  if (ttsTkAudio) { try { ttsTkAudio.pause(); } catch {} ttsTkAudio = null; }
  ttsTkBusy = false;
}

async function ttsTkPump() {
  if (ttsTkBusy) return;
  ttsTkBusy = true;
  while (ttsTkQueue.length) {
    const item = ttsTkQueue.shift();
    try {
      const r = await fetch('/api/tts/speak', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ text: item.text, voice: item.voice, translate: item.translate }),
      });
      const j = r.ok ? await r.json() : null;
      if (j && j.ok && j.audio) {
        await ttsPlayBase64(j.audio, j.mime || 'audio/mpeg', item.volume);
        continue;
      }
    } catch { /* cae al respaldo */ }
    // Si la síntesis TikTok falla, no nos quedamos mudos: usamos la voz del sistema.
    ttsSpeakSystem(item.text, settings?.tts || {});
  }
  ttsTkBusy = false;
}

function ttsPlayBase64(b64, mime, volume) {
  return new Promise((resolve) => {
    try {
      const audio = new Audio('data:' + mime + ';base64,' + b64);
      audio.volume = Math.max(0, Math.min(1, Number(volume) ?? 1));
      ttsTkAudio = audio;
      const done = () => { if (ttsTkAudio === audio) ttsTkAudio = null; resolve(); };
      audio.onended = done;
      audio.onerror = done;
      audio.play().catch(done);
    } catch { resolve(); }
  });
}

/* Comentario del chat */
function ttsSpeak(p, force = false) {
  if (!TTS_HAS) return;
  const t = settings?.tts;
  if (!t) return;
  if (force) { ttsSpeakText(`${p.nickname} dice: ${p.comment || ''}`); return; }
  if (!t.enabled) return;
  if (!ttsAllowedUser(p)) return;

  let body = ttsTriggerMatch(p.comment);
  if (body == null) return;
  body = ttsModerate(body);
  if (!body) return;
  if (body.length < (t.minLen || 0)) return;
  if (t.maxLen && body.length > t.maxLen) body = body.slice(0, t.maxLen);
  if (!body) return;

  // Monetización: cobra monedas acumuladas por regalos
  if (t.charge) {
    const uid = p.uniqueId || p.nickname;
    const cost = Math.max(1, +t.cost || 1);
    if ((ttsPoints[uid] || 0) < cost) return;
    ttsPoints[uid] -= cost;
  }
  ttsSpeakText((t.readName ? `${p.nickname} dice: ` : '') + body);
}

/* Eventos */
function ttsOnFollow(p) {
  const t = settings?.tts; if (!t || !t.enabled || !t.readFollow) return;
  const msg = (t.followMsg || 'Hola {user}, gracias por seguirme').replace(/\{user\}/gi, p.nickname || 'amigo');
  ttsSpeakText(msg);
}
function ttsOnShare(p) {
  const t = settings?.tts; if (!t || !t.enabled || !t.readShare) return;
  ttsSpeakText(`${p.nickname || 'Alguien'} compartió el live`);
}
function ttsOnLike(p) {
  const t = settings?.tts; if (!t || !t.enabled || !t.readTaptap) return;
  const n = +p.count || 0;
  if (n < (+t.taptapMin || 100)) return;
  ttsSpeakText(`${p.nickname || 'Alguien'} envió ${n} Tap Tap`);
}
function ttsOnGift(p) {
  const t = settings?.tts; if (!t) return;
  // acumula monedas para la monetización
  const uid = p.uniqueId || p.nickname;
  const coins = (+p.diamonds || 0) * (+p.repeatCount || 1);
  if (uid && coins > 0 && !p.streak) ttsPoints[uid] = (ttsPoints[uid] || 0) + coins;
  // lee el regalo (agrupado por stack)
  if (t.enabled && t.readGifts && !p.streak) {
    const name = p.giftName || 'un regalo';
    const qty = +p.repeatCount || 1;
    ttsSpeakText(`${p.nickname || 'Alguien'} envió ${name}${qty > 1 ? ' x' + qty : ''}`);
  }
}

/* ---- Binds de controles ---- */
(function setupTtsControls() {
  if (TTS_HAS) speechSynthesis.onvoiceschanged = loadVoices;
  const save = () => { saveSettings(); updateTtsSummary(); };
  const bindChk = (id, key) => { const el = $(id); if (el) el.addEventListener('change', () => { settings.tts[key] = el.checked; save(); }); };
  const bindTxt = (id, key) => { const el = $(id); if (el) el.addEventListener('input', () => { settings.tts[key] = el.value; save(); }); };
  const bindNum = (id, key) => { const el = $(id); if (el) el.addEventListener('change', () => { settings.tts[key] = +el.value || 0; save(); }); };

  const en = $('tts-enabled');
  if (en) en.addEventListener('change', () => { settings.tts.enabled = en.checked; if (!settings.tts.enabled) speechSynthesis.cancel(); save(); });
  bindChk('tts-readname', 'readName');
  const lang = $('tts-lang');
  if (lang) lang.addEventListener('change', () => { settings.tts.lang = lang.value; settings.tts.voice = ''; fillVoiceOptions(); save(); });
  const voice = $('tts-voice');
  if (voice) voice.addEventListener('change', () => { settings.tts.voice = voice.value; save(); });
  const tkVoice = $('tts-tiktok-voice');
  if (tkVoice) tkVoice.addEventListener('change', () => { settings.tts.tiktokVoice = tkVoice.value; save(); });
  const tkTrans = $('tts-tiktok-translate');
  if (tkTrans) tkTrans.addEventListener('change', () => { settings.tts.tiktokTranslateEs = tkTrans.checked; save(); });
  const rate = $('tts-rate');
  if (rate) rate.addEventListener('input', () => { $('tts-rate-val').textContent = (+rate.value).toFixed(1); settings.tts.rate = +rate.value; save(); });
  const pitch = $('tts-pitch');
  if (pitch) pitch.addEventListener('input', () => { $('tts-pitch-val').textContent = (+pitch.value).toFixed(1); settings.tts.pitch = +pitch.value; save(); });
  const vol = $('tts-vol');
  if (vol) vol.addEventListener('input', () => { $('tts-vol-val').textContent = Math.round(vol.value * 100); settings.tts.volume = +vol.value; save(); });

  // permitidos — "Todos" excluye roles específicos; al marcar un rol se desactiva "Todos"
  const allAll = $('tts-allow-all');
  if (allAll) allAll.addEventListener('change', () => {
    settings.tts.allowAll = allAll.checked;
    if (allAll.checked) {
      TTS_ALLOW_SPECIFIC.forEach(({ key }) => { settings.tts[key] = false; });
      TTS_ALLOW_SPECIFIC.forEach(({ id }) => { const el = $(id); if (el) el.checked = false; });
    }
    syncTtsAllowUI();
    save();
  });
  TTS_ALLOW_SPECIFIC.forEach(({ id, key }) => {
    const el = $(id);
    if (!el) return;
    el.addEventListener('change', () => {
      if (el.checked && allAll) {
        allAll.checked = false;
        settings.tts.allowAll = false;
      }
      settings.tts[key] = el.checked;
      syncTtsAllowUI();
      save();
    });
  });

  // trigger
  document.querySelectorAll('input[name="tts-trigger"]').forEach((r) => r.addEventListener('change', () => { if (r.checked) { settings.tts.trigger = r.value; save(); } }));
  bindTxt('tts-command', 'command');

  // monetización
  document.querySelectorAll('input[name="tts-charge"]').forEach((r) => r.addEventListener('change', () => { if (r.checked) { settings.tts.charge = r.value === '1'; save(); } }));
  bindNum('tts-cost', 'cost');

  // moderación
  bindChk('tts-block-spam', 'blockSpam');
  bindChk('tts-block-alpha', 'blockAlpha');
  bindChk('tts-block-prof', 'blockProfanity');
  bindChk('tts-block-susp', 'blockSuspicious');
  bindChk('tts-strip-emojis', 'stripEmojis');
  bindTxt('tts-blocked-words', 'blockedWords');

  // seguidores
  bindChk('tts-read-follow', 'readFollow');
  bindTxt('tts-follow-msg', 'followMsg');

  // eventos
  bindChk('tts-read-share', 'readShare');
  bindChk('tts-read-taptap', 'readTaptap');
  bindNum('tts-taptap-min', 'taptapMin');
  bindChk('tts-read-gifts', 'readGifts');

  const test = $('tts-test');
  if (test) test.onclick = () => ttsSpeakText('Hola, así se escucha el chat por voz');
  const stop = $('tts-stop');
  if (stop) stop.onclick = () => { if (TTS_HAS) speechSynthesis.cancel(); ttsStopTikTok(); };
})();

// Las miniaturas de video ya no se autoreproducen (eso descargaba cada video completo
// al actualizar). Muestran el primer fotograma y se animan solo al pasar el cursor,
// así el panel carga al instante aunque tengas muchos videos.
document.addEventListener('mouseover', (e) => {
  const v = e.target.closest?.('video.hover-play');
  if (v) { try { v.play(); } catch {} }
}, true);
document.addEventListener('mouseout', (e) => {
  const v = e.target.closest?.('video.hover-play');
  if (v) { try { v.pause(); } catch {} }
}, true);

(async () => {
  // Arranque en paralelo: abrimos el WebSocket y pedimos el catálogo de regalos
  // de inmediato (no esperamos al /api/me). El WS es el que entrega ajustes, alertas
  // y videos, así que cuanto antes se abra, antes se pinta TODO el panel.
  connectWS();
  preloadGiftCatalog();
  // Datos de sesión (usuario / roomKey) en paralelo; solo afectan al chip y a las URLs
  // de overlays, que no bloquean el render principal.
  loadMe().then(() => {
    mountUserChip();
    refreshOverlayUrls();
  });
})();
