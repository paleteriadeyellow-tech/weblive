const $ = (id) => document.getElementById(id);
const MAX_ROWS = 120;
// App de escritorio (.exe): preload de Electron + sello que inyecta el servidor local (DESKTOP=1).
function detectDesktopPanel() {
  if (window.desktopAPI?.isDesktop) return true;
  if (window.__LIVECOINS_DESKTOP__ || window.__LIVECOINS_PC_BUILD__) return true;
  if (document.querySelector('meta[name="livecoins-app"][content="desktop"]')) return true;
  // El .exe siempre sirve el panel desde 127.0.0.1; la versión web usa el dominio remoto.
  if (/^127\.|^localhost$/i.test(location.hostname || '')) return true;
  return false;
}
let IS_DESKTOP = detectDesktopPanel();
const IS_LOCALHOST = /^127\.|^localhost$/i.test(location.hostname || '');

function syncDesktopPanelMode() {
  IS_DESKTOP = detectDesktopPanel();
  if (IS_DESKTOP) {
    document.documentElement.classList.add('is-desktop');
    const btn = document.getElementById('pc-install-btn');
    if (btn) btn.hidden = true;
    const navAcc = document.getElementById('navAcciones');
    if (navAcc) navAcc.style.display = '';
    try { revealJuegosTab(); } catch {}
    try { revealWebhookTab(); } catch {}
    try { revealConfigTab(); } catch {}
    try { syncNavSections(); } catch {}
  }
}

async function confirmDesktopPanelFromServer() {
  if (!IS_LOCALHOST) return;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const r = await fetch('/api/desktop-build');
      if (r.ok) {
        const d = await r.json();
        if (d && d.pc) {
          window.__LIVECOINS_DESKTOP__ = true;
          if (d.version) window.INSTALLED_APP_VERSION = String(d.version).trim();
          syncDesktopPanelMode();
          try { setupAccionesUI(); } catch {}
          try { setupProfiles(); } catch {}
          try { setupJuegosUI(); } catch {}
          try { setupWebhookUI(); } catch {}
          return;
        }
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 400));
  }
}
function isPcBuildMarkup() {
  return !!(window.__LIVECOINS_PC_BUILD__ || document.querySelector('meta[name="livecoins-app"][content="desktop"]'));
}
function setupPanelModeWarning() {
  if (document.getElementById('panel-mode-banner')) return;
  if (IS_DESKTOP) return;
  const brokenLocal = isPcBuildMarkup() || IS_LOCALHOST;
  if (!brokenLocal) return;
  const banner = document.createElement('div');
  banner.id = 'panel-mode-banner';
  banner.style.cssText = 'margin:0 14px 10px;padding:10px 12px;border-radius:10px;font:600 11.5px/1.45 system-ui;color:#ffe8f0;background:linear-gradient(135deg,rgba(255,43,214,.22),rgba(255,80,120,.12));border:1px solid rgba(255,43,214,.45)';
  banner.innerHTML = '<b>App PC sin módulo de escritorio.</b><br>Cierra Livecoins por completo y ábrelo otra vez desde el menú Inicio. Si sigue igual, reinstala el .exe más reciente.';
  const side = document.querySelector('.sidebar');
  const nav = side?.querySelector('.nav');
  if (nav) side.insertBefore(banner, nav);
  else document.body.prepend(banner);
}

let ws;
let reconnectTimer;
let settings = null;       // copia local de los ajustes del servidor
let applyingSettings = false; // evita loops al rellenar los controles

/* ====================== WebSocket ====================== */
let localWs, localReconnectTimer;

async function postLocalMedia(action, body = {}) {
  try {
    await fetch('/api/desktop/local-media', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...body }),
    });
  } catch {}
}

function connectLocalWS() {
  if (!relayActive()) {
    if (localWs) { try { localWs.close(); } catch {} localWs = null; }
    return;
  }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  let url = `${proto}://${location.host}/ws`;
  const k = window.ROOM_KEY || '';
  if (k) url += `?room=${encodeURIComponent(k)}`;
  if (localWs) {
    if (wsUrlsMatch(localWs.url, url) && (localWs.readyState === WebSocket.OPEN || localWs.readyState === WebSocket.CONNECTING)) return;
    try { localWs.close(); } catch {}
    localWs = null;
  }
  const sock = new WebSocket(url);
  localWs = sock;
  sock.onclose = () => {
    if (localWs !== sock) return;
    clearTimeout(localReconnectTimer);
    localReconnectTimer = setTimeout(connectLocalWS, 1500);
  };
  sock.onmessage = (ev) => {
    if (localWs !== sock) return;
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'screens') onScreens(msg.payload);
  };
}
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

// ¿El .exe debe conectar el panel directo a la nube (modo relay)? Solo en escritorio,
// con cloudBase definido y la opción activada por el proceso principal.
function relayActive() {
  return IS_DESKTOP && !!(window.desktopAPI && window.desktopAPI.relayMode && window.desktopAPI.cloudBase);
}

// En modo relay, uploads/audios viven en esta PC (userData). Solo rutas /uploads locales.
function mediaUrl(u) {
  if (!u || typeof u !== 'string') return u || '';
  if (/^https?:\/\//i.test(u)) {
    try {
      const p = new URL(u);
      if (/^\/(uploads|audios|video)\//.test(p.pathname)) return p.pathname + (p.search || '');
    } catch {}
    return u;
  }
  return u;
}

function normalizeRelayMedia(s) {
  if (!s || !relayActive()) return;
  const fix = (u) => mediaUrl(u);
  for (const a of (s.soundAlerts || [])) if (a.sound) a.sound = fix(a.sound);
  for (const v of (s.videos || [])) if (v.url) v.url = fix(v.url);
  for (const b of (s.battleAlerts || [])) if (b.url) b.url = fix(b.url);
  for (const a of (s.actions || [])) if (a.sound) a.sound = fix(a.sound);
  for (const a of (s.mcActions || [])) if (a.sound) a.sound = fix(a.sound);
}

function relativizeMediaUrlForSave(u) {
  if (!u || typeof u !== 'string') return u;
  if (u.startsWith('/')) return u;
  try {
    const p = new URL(u);
    if (/^\/(uploads|audios|video)\//.test(p.pathname)) return p.pathname + (p.search || '');
  } catch {}
  return u;
}
function stripSettingsMediaForSave(s) {
  if (!s) return;
  const rel = relativizeMediaUrlForSave;
  for (const a of (s.soundAlerts || [])) if (a.sound) a.sound = rel(a.sound);
  for (const v of (s.videos || [])) if (v.url) v.url = rel(v.url);
  for (const b of (s.battleAlerts || [])) if (b.url) b.url = rel(b.url);
  for (const a of (s.actions || [])) if (a.sound) a.sound = rel(a.sound);
  for (const a of (s.mcActions || [])) if (a.sound) a.sound = rel(a.sound);
}

function buildWsUrl() {
  if (relayActive()) {
    if (!window.CLOUD_ROOM_KEY) return null;
    const base = String(window.desktopAPI.cloudBase).replace(/\/+$/, '').replace(/^http/i, 'ws');
    return `${base}/ws?room=${encodeURIComponent(window.CLOUD_ROOM_KEY)}&role=relay`;
  }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  let url = `${proto}://${location.host}/ws`;
  const k = window.ROOM_KEY || '';
  if (k) url += `?room=${encodeURIComponent(k)}`;
  return url;
}

function wsUrlsMatch(a, b) {
  if (!a || !b) return false;
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.origin === ub.origin && ua.pathname === ub.pathname && ua.search === ub.search;
  } catch {
    return a === b;
  }
}

function connectWS() {
  const url = buildWsUrl();
  if (!url) {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectWS, 600);
    return;
  }
  if (ws) {
    if (wsUrlsMatch(ws.url, url) && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    try { ws.close(); } catch {}
    ws = null;
  }
  const sock = new WebSocket(url);
  ws = sock;
  sock.onopen = () => {
    if (ws !== sock) return;
    clearTimeout(reconnectTimer);
    setConnBadge(true);
    buildKeepAliveWorker();
    connectLocalWS();
    if (relayActive()) {
      try { sock.send(JSON.stringify({ action: 'relayHello', localOrigin: location.origin })); } catch {}
    }
    try { requestProfiles(); } catch {}
  };
  sock.onclose = () => {
    if (ws !== sock) return;
    setConnBadge(false);
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectWS, 1500);
  };
  sock.onerror = () => { if (ws === sock) try { sock.close(); } catch {} };
  sock.onmessage = (ev) => {
    if (ws !== sock) return;
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    const { type, payload } = msg;
    if (type === 'pong') return;
    if (type === 'accountPending') { location.href = '/'; return; }
    handle(type, payload);
  };
}

function waitForWsOpen(maxMs = 8000) {
  return new Promise((resolve) => {
    if (ws?.readyState === WebSocket.OPEN) return resolve(true);
    const deadline = Date.now() + maxMs;
    const tick = () => {
      if (ws?.readyState === WebSocket.OPEN) return resolve(true);
      if (Date.now() >= deadline) return resolve(false);
      if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) connectWS();
      setTimeout(tick, 250);
    };
    connectWS();
    tick();
  });
}

// Reconexión al volver a la pestaña (solo si el WS no está abierto).
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && ws?.readyState !== WebSocket.OPEN) connectWS();
});
window.addEventListener('focus', () => { if (ws?.readyState !== WebSocket.OPEN) connectWS(); });
window.addEventListener('online', () => { if (ws?.readyState !== WebSocket.OPEN) connectWS(); });
window.addEventListener('pageshow', () => { if (ws?.readyState !== WebSocket.OPEN) connectWS(); });

function setConnBadge(on) {
  ['jar-conn', 'vaq-conn', 'mar-conn', 'pel-conn', 'top-conn', 'top1-conn', 'top1f-conn', 'habi-conn', 'gvs-conn', 'flw-conn', 'gsq-conn', 'gsh-conn', 'tgf-conn', 'tst-conn', 'bgf-conn', 'bli-conn', 'cm-conn', 'taln-conn', 'tal-conn', 'tlk-conn', 'tdm-conn', 'tll-conn', 'tdl-conn', 'hyp-conn', 'hypmc-conn', 'hypmr-conn', 'hypdbz-conn', 'tlv-conn', 'foc-conn', 'focmc-conn', 'agf-conn', 'alk-conn', 'afl-conn', 'sjn-conn', 'sjnmc-conn', 'sjndbz-conn', 'sjnmr-conn', 'wc-conn', 'wcg-conn', 'wcm-conn', 'wmr-conn', 'tp3-conn'].forEach((id) => {
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
window.INSTALLED_APP_VERSION = '';

async function resolveInstalledAppVersion() {
  if (window.INSTALLED_APP_VERSION) return window.INSTALLED_APP_VERSION;
  if (IS_DESKTOP && window.desktopAPI?.getVersion) {
    try {
      const v = await window.desktopAPI.getVersion();
      if (v) {
        window.INSTALLED_APP_VERSION = String(v).trim();
        return window.INSTALLED_APP_VERSION;
      }
    } catch {}
  }
  try {
    const r = await fetch('/api/desktop-build');
    if (r.ok) {
      const d = await r.json();
      if (d?.version) {
        window.INSTALLED_APP_VERSION = String(d.version).trim();
        return window.INSTALLED_APP_VERSION;
      }
    }
  } catch {}
  return '';
}

async function applyInstalledAppVersionBadge() {
  const verEl = document.getElementById('user-chip-ver');
  if (!verEl) return;
  const v = await resolveInstalledAppVersion();
  if (v) verEl.textContent = `v${v.replace(/^v/i, '')}`;
  else verEl.hidden = true;
}

async function loadMe() {
  try {
    const r = await fetch('/api/me');
    if (!r.ok) { location.href = '/login.html'; return; }
    const d = await r.json();
    window.ROOM_KEY = d.roomKey || '';
    // roomKey de la nube (Render): en el .exe en modo relay, el panel y los overlays
    // se conectan a la room remota con esta clave (el trabajo pesado corre allí).
    window.CLOUD_ROOM_KEY = d.cloudRoomKey || '';
    window.CLOUD_SESSION_OK = d.cloudSessionOk !== false;
    window.MY_USER = d.username || '';
    window.IS_ADMIN = !!d.isAdmin;
    window.MY_PLAN = d.plan || 'free';
    if (d.caps) setCaps(d.caps);
    // Si la cuenta dejó de estar activa, vuelve a la pantalla de espera.
    if (!d.active) { location.href = '/'; return; }
    if (window.IS_ADMIN) {
      const nav = document.getElementById('navAdmin');
      if (nav) nav.style.display = '';
      try { syncNavSections(); } catch {}
    }
    // En el .exe sin relay, si el WS tarda, cargamos ajustes locales para no bloquear el panel.
    if (IS_DESKTOP && !settings && !relayActive()) {
      try {
        const sr = await fetch('/api/my-settings');
        if (sr.ok) {
          const sd = await sr.json();
          if (sd && sd.settings) onSettings(sd.settings);
        }
      } catch {}
    }
    connectWS();
    if (relayActive()) connectLocalWS();
    startCloudSessionPoll();
  } catch {
    toast('No se pudo cargar la sesión. Recarga o vuelve a iniciar sesión.', 'warn');
  }
}

/* ====================== Planes / capacidades ====================== */
// Mapa overlay path -> clave de capacidad (debe coincidir con plans.js).
const OVERLAY_CAP = {
  '/join-live.html': 'ov_joinlive', '/join-live-minecraft.html': 'ov_joinlivemc',
  '/join-live-dragonball.html': 'ov_joinlivedbz', '/join-live-mario.html': 'ov_joinlivemario',
  '/overlay.html': 'ov_alertvideo',
  '/perrito.html': 'ov_perrito',
  '/jarron.html': 'ov_jarron', '/vaquita.html': 'ov_vaquita', '/marranito.html': 'ov_marranito',
  '/pelotas.html': 'ov_pelotas',
  '/habibi-top.html': 'ov_habibitop', '/topdonor.html': 'ov_topdonor', '/gcounter.html': 'ov_gcounter', '/giftvs.html': 'ov_giftvs', '/medidor-flow.html': 'ov_flowmeter', '/giftseq.html': 'ov_giftseq', '/gift-banda.html': 'ov_giftshowcase',
  '/contador-wins.html': 'ov_winscounter', '/contador-wins-gamer.html': 'ov_winscountergamer',
  '/contador-wins-minecraft.html': 'ov_winscounterminecraft',
  '/contador-wins-mario.html': 'ov_winscountermario',
  '/mejorregalo.html': 'ov_mejorregalo', '/mejorracha.html': 'ov_mejorracha',
  '/batallaregalos.html': 'ov_batallaregalos', '/batallalikes.html': 'ov_batallalikes',
  '/coinmatch.html': 'ov_coinmatch', '/meta.html': 'ov_meta',
  '/meta-minecraft.html': 'ov_metamc', '/meta-mario.html': 'ov_metamario', '/meta-dragonball.html': 'ov_metadbz',
  '/topalt-rank-neon.html': 'ov_topaltrankneon',
  '/topalt-rank.html': 'ov_topaltrank',
  '/toplikes.html': 'ov_toplikes', '/topdiamantes.html': 'ov_topdiamantes',
  '/toplikes-lista.html': 'ov_toplikeslista', '/topdiamantes-lista.html': 'ov_topdiamanteslista',
  '/contador-seguidores.html': 'ov_contadorseguidores',
  '/contador-seguidores-minecraft.html': 'ov_contadorseguidoresmc',
  '/tiempo-live-neon.html': 'ov_tiempolive',
  '/alerta-regalo.html': 'ov_alertaregalo',
  '/alerta-likes.html': 'ov_alertalikes',
  '/alerta-seguidor.html': 'ov_alertaseguidor', '/timer.html': 'ov_timer',
  '/top1fire.html': 'ov_top1fire',
  '/toppoints.html': 'ov_toppoints',
};
// Mapa pestaña (data-view) -> clave de capacidad.
const TAB_CAP = {
  alertas: 'tab_alertas', videos: 'tab_videos', batallas: 'tab_batallas',
  'ov-streams': 'tab_overlays', 'ov-gifts': 'tab_overlays', 'ov-metas': 'tab_overlays',
  'ov-rankings': 'tab_overlays', 'ov-diseno': 'tab_overlays', 'ov-contador': 'tab_overlays',
  tts: 'tab_tts', timer: 'tab_timer',
};
// Mapa minijuego (data-game) -> clave de capacidad (para bloquear "Solo Premium").
const GAME_CAP = { minecraft: 'game_minecraft', mcparkour: 'game_mcparkour', mckoth: 'game_mckoth', mcfarm: 'game_mcfarm', bedrock: 'game_bedrock', sandbox: 'game_sandbox', roblox: 'game_roblox', roblox3: 'game_roblox3', mariobros: 'game_mariobros', smb3: 'game_smb3', mari0: 'game_mari0', plantasvszombies: 'game_plantasvszombies', pvzhybrid: 'game_pvzhybrid', repo: 'game_repo', l4d: 'game_l4d', crashctr: 'game_crashctr', metalslug: 'game_metalslug', geometrydash: 'game_geometrydash' };
// Minijuegos visibles pero aún no disponibles (solo el admin puede entrar).
const GAME_COMING_SOON = {};

window.CAPS = { plan: 'free', limits: {}, features: {} };
function setCaps(c) {
  if (!c) return;
  window.CAPS = {
    plan: c.plan || window.MY_PLAN || 'free',
    limits: c.limits || {},
    features: c.features || {},
  };
  applyCaps();
  try { revealWebhookTab(); } catch {}
  try { revealConfigTab(); } catch {}
  try { revealJuegosTab(); } catch {}
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

function syncNavSections() {
  const nav = document.querySelector('.nav');
  if (!nav) return;
  nav.querySelectorAll('.nav-section').forEach((sec) => {
    const visible = [...sec.querySelectorAll('.nav-item')].some(navItemVisible);
    sec.hidden = !visible;
  });
  nav.querySelectorAll('.nav-divider').forEach((div) => {
    const prev = div.previousElementSibling;
    const next = div.nextElementSibling;
    const prevOk = prev?.classList.contains('nav-section') && !prev.hidden;
    const nextOk = next?.classList.contains('nav-section') && !next.hidden;
    div.hidden = !(prevOk && nextOk);
  });
}

function navItemVisible(btn) {
  if (!btn) return false;
  return getComputedStyle(btn).display !== 'none';
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
  try { syncNavSections(); } catch {}
  // Overlays individuales: si no están en el plan, NO se ocultan; se muestran con
  // un bloqueo "Solo Premium" por encima (la tarjeta sigue visible pero no usable).
  document.querySelectorAll('.ov-url[data-path]').forEach((code) => {
    const base = String(code.dataset.path).split('?')[0];
    const cap = OVERLAY_CAP[base];
    if (!cap) return;
    const card = code.closest('.ovpro-card') || code.closest('.overlay-item') || code.closest('.ov-card');
    if (card) setOverlayLock(card, !capFeature(cap));
  });
  // Minijuegos (pestaña Juegos): bloqueo por plan o "Próximamente".
  document.querySelectorAll('#view-juegos .juego-card[data-game]').forEach((card) => {
    updateGameCardLock(card);
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
  tab_webhook: 'Webhook y Configuración',
  // overlays
  ov_joinlive: 'Join al live', ov_joinlivemc: 'Join al live (Minecraft)', ov_joinlivedbz: 'Join al live (Dragon Ball Z)', ov_joinlivemario: 'Join al live (Mario Bros)',
  ov_alertvideo: 'Alertas + Videos', ov_perrito: 'Perrito', ov_jarron: 'Jarrón',
  ov_vaquita: 'Vaquita', ov_marranito: 'Marranito', ov_pelotas: 'Pelotas de fans', ov_topdonor: 'Top donador semanal',
  ov_habibitop: 'Habibi Top Donador', ov_gcounter: 'Contador de meta', ov_winscounter: 'Contador de victorias', ov_winscountergamer: 'Contador de victorias (Gamer HUD)', ov_winscounterminecraft: 'Contador de victorias (Minecraft)', ov_winscountermario: 'Contador de victorias (Mario Bros)',
  ov_giftvs: 'Gift VS', ov_flowmeter: 'Medidor de Flow', ov_giftseq: 'Gift Sequence', ov_giftshowcase: 'Banda de regalos', ov_mejorregalo: 'Mejor regalo',
  ov_mejorracha: 'Mejor racha', ov_batallaregalos: 'Batalla de regalos', ov_batallalikes: 'Batalla de likes',
  ov_coinmatch: 'Coin Match', ov_meta: 'Barra de meta (Hype)', ov_topaltrankneon: 'Top Likes / Diamantes (neón)', ov_topaltrank: 'Top Likes / Diamantes (alternado)',
  ov_toplikes: 'Top likes',
  ov_topdiamantes: 'Top diamantes', ov_toplikeslista: 'Ranking likes (lista)',
  ov_topdiamanteslista: 'Ranking diamantes (lista)', ov_contadorseguidores: 'Contador de seguidores',
  ov_contadorseguidoresmc: 'Contador de seguidores (Minecraft)',
  ov_alertaregalo: 'Alerta de regalo',
  ov_alertalikes: 'Alerta de likes', ov_alertaseguidor: 'Alerta de nuevo seguidor', ov_timer: 'Temporizador (overlay)',
  ov_top1fire: 'Top 1 Donador Fuego', ov_toppoints: 'Top 3 puntos',
  // juegos
  game_minecraft: 'Juego: Minecraft', game_mcparkour: 'Juego: Minecraft Parkour', game_mckoth: 'Juego: Minecraft KOTH', game_mcfarm: 'Juego: Minecraft Farm', game_bedrock: 'Juego: Bedrock (Cubo TNT)', game_sandbox: 'Juego: Sandbox',
  game_roblox: 'Juego: Roblox', game_roblox3: 'Juego: Roblox parkour',
  game_mariobros: 'Juego: Mario Bros', game_smb3: 'Juego: Super Mario Bros. 3', game_mari0: 'Juego: Mari0', game_plantasvszombies: 'Juego: Plants vs Zombies', game_pvzhybrid: 'Plants vs Zombies Pack', game_repo: 'Juego: R.E.P.O.', game_l4d: 'Juego: Left 4 Dead 2', game_crashctr: 'Juego: Crash Team Racing (CTR)', game_metalslug: 'Juego: Metal Slug', game_geometrydash: 'Juego: Geometry Dash',
  // extras
  tts_tiktok: 'Voces TikTok / Disney',
};
const PLAN_FEATURE_ORDER = [
  'tab_alertas', 'tab_videos', 'tab_batallas', 'tab_overlays', 'tab_tts', 'tab_timer', 'tab_webhook',
  'tts_tiktok', 'game_minecraft', 'game_mcparkour', 'game_mckoth', 'game_mcfarm', 'game_bedrock', 'game_sandbox', 'game_roblox', 'game_roblox3', 'game_mariobros', 'game_smb3', 'game_mari0', 'game_plantasvszombies', 'game_pvzhybrid', 'game_repo', 'game_l4d', 'game_crashctr', 'game_metalslug', 'game_geometrydash',
  'ov_joinlive', 'ov_joinlivemc', 'ov_joinlivedbz', 'ov_joinlivemario', 'ov_alertvideo', 'ov_perrito', 'ov_jarron', 'ov_vaquita', 'ov_marranito', 'ov_pelotas', 'ov_topdonor',
  'ov_habibitop', 'ov_gcounter', 'ov_winscounter', 'ov_winscountergamer', 'ov_winscounterminecraft', 'ov_winscountermario', 'ov_giftvs', 'ov_flowmeter', 'ov_giftseq', 'ov_giftshowcase', 'ov_mejorregalo', 'ov_mejorracha', 'ov_batallaregalos', 'ov_batallalikes',
  'ov_coinmatch', 'ov_meta', 'ov_topaltrankneon', 'ov_topaltrank', 'ov_toplikes', 'ov_topdiamantes', 'ov_toplikeslista', 'ov_topdiamanteslista',
  'ov_contadorseguidores', 'ov_contadorseguidoresmc', 'ov_alertaregalo', 'ov_alertalikes', 'ov_alertaseguidor', 'ov_timer', 'ov_top1fire', 'ov_toppoints',
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
    if (IS_DESKTOP || (settings?.actions || []).length) {
      rows.push({ kind: 'actions', key: 'actions', noun: 'Acciones' });
    }
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
  if (catalog.games && catalog.games.length) html += group('Juegos', catalog.games);
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
        <div class="pp-price">$12 USD<small>/ mes · todo desbloqueado</small></div>
      </div>
      <p class="pp-tagline">Sin límites y con todos los overlays y funciones.</p>
      <ul class="pp-list">${buildList('premium')}</ul>
      ${premBtn}
      ${IS_DESKTOP ? '<p class="pp-note">Una vez que te activen el plan, cierra sesión e inicia de nuevo.</p>' : ''}
    </div>
  `;

  const buyBtn = document.getElementById('pp-buy');
  if (buyBtn) buyBtn.onclick = () => {
    const msg = `Hola, quiero comprar el Plan Premium ($12 USD/mes) de Livecoins. Mi usuario es: ${window.MY_USER || ''}`;
    const url = 'https://wa.me/522202079074?text=' + encodeURIComponent(msg);
    window.open(url, '_blank', 'noopener');
  };
}

// Texto que se muestra en lugar de la URL cuando el overlay no está en el plan.
const OV_URL_MASK = '🔒 Disponible solo en Premium';

// ¿La URL de este overlay está bloqueada para el plan actual? El admin nunca se bloquea.
function isOverlayUrlLocked(code) {
  if (window.IS_ADMIN) return false;
  const base = String(code?.dataset?.path || '').split('?')[0];
  const cap = OVERLAY_CAP[base];
  return cap ? !capFeature(cap) : false;
}

// Pone (o quita) el bloqueo "Solo Premium" en una tarjeta de overlay. Cuando está
// bloqueado: todo se ve en gris y NO se puede usar (ni copiar, ni configurar, ni ver
// la URL); SOLO el botón "Testear" sigue activo para ver la demo.
function setOverlayLock(card, locked) {
  const target = card.querySelector('.ovpro-preview') || card;
  target.classList.toggle('ov-locked', locked);
  card.classList.toggle('ov-locked-card', locked);
  // Enmascara / restaura la URL de la tarjeta.
  const code = card.querySelector('.ov-url');
  if (code && code.dataset.path) {
    code.textContent = locked ? OV_URL_MASK : roomUrl(code.dataset.path);
  }
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

// ¿La tarjeta de este minijuego está bloqueada para el plan actual? El admin nunca se bloquea.
function isGameComingSoon(gameId) {
  return !!GAME_COMING_SOON[gameId] && !window.IS_ADMIN;
}

function isGameLocked(gameId) {
  if (window.IS_ADMIN) return false;
  if (isGameComingSoon(gameId)) return true;
  const cap = GAME_CAP[gameId];
  return cap ? !capFeature(cap) : false;
}

function clearGameCardLocks(card) {
  card.classList.remove('game-locked-card', 'game-soon-card');
  card.querySelectorAll('.game-lock-overlay, .game-soon-overlay').forEach((el) => el.remove());
}

function updateGameCardLock(card) {
  const gameId = card.dataset.game;
  if (!gameId) return;
  clearGameCardLocks(card);
  if (window.IS_ADMIN) return;
  if (GAME_COMING_SOON[gameId]) {
    setGameComingSoon(card);
    return;
  }
  const cap = GAME_CAP[gameId];
  if (cap) setGameLock(card, !capFeature(cap));
}

// Pone el aviso "Próximamente" en gris (nadie entra salvo admin).
function setGameComingSoon(card) {
  card.classList.add('game-soon-card');
  let ov = card.querySelector('.game-soon-overlay');
  if (ov) return;
  ov = document.createElement('div');
  ov.className = 'game-soon-overlay';
  ov.innerHTML = `<div class="ov-lock-box">
    <div class="ov-lock-ico">⏳</div>
    <div class="ov-lock-title">Próximamente</div>
    <div class="ov-lock-sub">Estamos preparando este juego</div>
  </div>`;
  ov.addEventListener('click', (e) => {
    e.stopPropagation();
    toast('Este juego estará disponible próximamente.', 'warn');
  });
  card.appendChild(ov);
}

// Pone (o quita) el bloqueo "Solo Premium" en una tarjeta de minijuego.
function setGameLock(card, locked) {
  if (!locked) {
    card.classList.remove('game-locked-card');
    card.querySelector('.game-lock-overlay')?.remove();
    return;
  }
  card.classList.add('game-locked-card');
  let ov = card.querySelector('.game-lock-overlay');
  if (ov) return;
  ov = document.createElement('div');
  ov.className = 'game-lock-overlay';
  ov.innerHTML = `<div class="ov-lock-box">
    <div class="ov-lock-ico">🔒</div>
    <div class="ov-lock-title">⭐ Solo Premium</div>
    <div class="ov-lock-sub">Mejora tu plan para desbloquear este juego</div>
  </div>`;
  ov.addEventListener('click', (e) => {
    e.stopPropagation();
    toast('Este juego es Solo Premium. Mejora tu plan para usarlo ⭐', 'warn');
  });
  card.appendChild(ov);
}

function applyLimitUI() {
  const defs = [
    { kind: 'soundAlerts', key: 'soundAlerts', btn: 'sa-create', view: 'view-alertas', noun: 'alertas sonoras' },
    { kind: 'videos', key: 'videos', btn: 'vid-create', view: 'view-videos', noun: 'videos' },
    { kind: 'battleAlerts', key: 'battleAlerts', btn: 'ba-create', view: 'view-batallas', noun: 'animaciones de batalla' },
    { kind: 'actions', key: 'actions', btn: 'acc-new', view: 'view-acciones', noun: 'acciones' },
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

// Modo relay (.exe): el chat de TikTok llega desde la nube. Spotify, en cambio, corre
// LOCAL (tokens + cola en esta PC). Por eso reenviamos los comandos de Spotify del chat
// al servidor local para que los procese y actualice la cola/overlay locales.
function maybeForwardSpotifyChat(p) {
  try {
    if (!relayActive()) return;
    const comment = String(p?.comment || '').trim();
    if (!/^!(play|skip|revoke)\b/i.test(comment)) return;
    if (!p?.uniqueId) return;
    fetch('/api/desktop/spotify-chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        comment,
        user: { uniqueId: p.uniqueId, nickname: p.nickname || p.uniqueId, photo: p.photo || '' },
        roles: { isMod: !!p.isMod, isSub: !!p.isSub, memberLevel: Number(p.memberLevel) || 0 },
      }),
    }).catch(() => {});
  } catch {}
}

function maybeForwardMusicChat(p) {
  try {
    if (!relayActive()) return;
    const comment = String(p?.comment || '').trim();
    const cmd = String(settings?.musicRequests?.command || '!sr').trim().toLowerCase();
    const re = new RegExp(`^(${cmd}|!queue|!current|!credits|!skip|!clearqueue|!remove)\\b`, 'i');
    if (!re.test(comment)) return;
    if (!p?.uniqueId) return;
    fetch('/api/desktop/music-chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        comment,
        user: { uniqueId: p.uniqueId, nickname: p.nickname || p.uniqueId, photo: p.photo || '' },
        roles: {
          isMod: !!p.isMod, isSub: !!p.isSub, isFollower: !!p.isFollower,
          memberLevel: Number(p.memberLevel) || 0,
        },
      }),
    }).catch(() => {});
  } catch {}
}

// En modo relay (.exe), TikTok va por la nube pero las 5 pantallas de video van
// SIEMPRE al servidor local (127.0.0.1) — archivos en userData/uploads.
function roomUrl(path) {
  const p = String(path || '');
  const isLocalOnly = /^\/spotify-/.test(p) || (relayActive() && /^\/video\.html/.test(p));
  const useCloud = relayActive() && !isLocalOnly;
  const base = useCloud ? String(window.desktopAPI.cloudBase).replace(/\/+$/, '') : location.origin;
  const k = useCloud ? (window.CLOUD_ROOM_KEY || '') : window.ROOM_KEY;
  let url = base + p;
  if (k) url += (p.includes('?') ? '&' : '?') + 'room=' + encodeURIComponent(k);
  if (/\/habibi-top\.html/.test(p)) url += (url.includes('?') ? '&' : '?') + 'v=7';
  return url;
}

// Browser Source para pantallas 1–5 y videos de nivel: local en .exe relay.
function videoScreenUrl(screenId) {
  const id = Math.max(1, Number(screenId) || 1);
  let u = `${location.origin}/video.html?screen=${id}`;
  const k = window.ROOM_KEY || '';
  if (k) u += `&room=${encodeURIComponent(k)}`;
  return u;
}

// Alias histórico (niveles de miembro)
function levelVideoScreenUrl(screenId) { return videoScreenUrl(screenId); }

function refreshLevelVideoScreenLink() {
  const cfg = settings?.levelVideos || {};
  const scr = Number(cfg.screen) || 1;
  const urlEl = $('levelvid-screen-url');
  if (urlEl) urlEl.textContent = levelVideoScreenUrl(scr);
  const st = $('levelvid-screen-status');
  if (st) {
    const on = connectedScreens.has(scr);
    st.textContent = on ? '● Fuente conectada' : '○ Pega el link en Live Studio y recarga la fuente';
    st.className = 'levelvid-url-status ' + (on ? 'on' : 'off');
  }
}

// Refresca el texto y enlaces de todas las URLs de overlay ya pintadas.
function refreshOverlayUrls() {
  document.querySelectorAll('.ov-url').forEach((code) => {
    if (!code.dataset.path) return;
    code.textContent = isOverlayUrlLocked(code) ? OV_URL_MASK : roomUrl(code.dataset.path);
  });
  document.querySelectorAll('.overlay-item').forEach((item) => {
    const code = item.querySelector('.ov-url');
    const a = item.querySelector('a');
    if (code && a && code.dataset.path) a.href = isOverlayUrlLocked(code) ? '#' : roomUrl(code.dataset.path);
  });
}

// Chip de usuario con botón de cerrar sesión (barra lateral).
function mountUserChip() {
  const chip = document.getElementById('user-chip');
  const nameEl = document.getElementById('user-chip-name');
  if (!chip || !nameEl) return;
  nameEl.textContent = `👤 ${window.MY_USER || 'usuario'}`;
  const verEl = document.getElementById('user-chip-ver');
  if (verEl) verEl.hidden = !IS_DESKTOP;
  const logout = document.getElementById('logout-btn');
  if (logout && !logout.dataset.wired) {
    logout.dataset.wired = '1';
    logout.onclick = async () => {
      try { await fetch('/api/logout', { method: 'POST' }); } catch {}
      location.href = '/login.html';
    };
  }
  applyPcInstallButton();
  if (IS_DESKTOP) applyInstalledAppVersionBadge();
}

let pcInstallUrl = '';
async function applyPcInstallButton() {
  const btn = document.getElementById('pc-install-btn');
  if (!btn) return;
  if (IS_DESKTOP || IS_LOCALHOST) { btn.hidden = true; return; }
  try {
    const r = await fetch('/api/web-install');
    if (!r.ok) { btn.hidden = true; return; }
    const d = await r.json();
    pcInstallUrl = String(d.url || '').trim();
    btn.hidden = !pcInstallUrl;
    btn.onclick = () => {
      if (IS_DESKTOP && window.desktopAPI?.openExternal) window.desktopAPI.openExternal(pcInstallUrl);
      else window.open(pcInstallUrl, '_blank', 'noopener');
    };
  } catch {
    btn.hidden = true;
  }
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
    case 'followerCounter':
      updateConnectAvatar({ photo: p.photo, nickname: p.nickname, username: p.uniqueId });
      break;
    case 'settings': onSettings(p); break;
    case 'screens':
      if (!relayActive()) onScreens(p);
      refreshLevelVideoScreenLink();
      break;
    case 'chat': addChat(p); ttsSpeak(p); maybeForwardSpotifyChat(p); maybeForwardMusicChat(p); break;
    case 'botReply': handleBotReply(p); break;
    case 'gift': addGift(p); ttsOnGift(p); break;
    case 'like': ttsOnLike(p); break;
    case 'member': addEvent(`🙋 ${p.nickname} entró`, ''); break;
    case 'follow': addEvent(`➕ ${p.nickname} te siguió`, 'ok'); ttsOnFollow(p); break;
    case 'share': addEvent(`🔁 ${p.nickname} compartió el live`, 'ok'); ttsOnShare(p); break;
    case 'subscribe': break;
    case 'superfan': break;
    case 'log': addEvent(p.text, p.level === 'ok' ? 'ok' : p.level === 'error' ? 'error' : ''); break;
    case 'sound': playPanelSound(p); break;
    case 'media':
      if (relayActive() || desktopRelayOn()) postLocalMedia('media', { media: p });
      break;
    case 'stopMedia':
      if (relayActive() || desktopRelayOn()) postLocalMedia('stop', { screen: Number(p?.screen) || 1 });
      break;
    case 'panic':
      stopPanelSounds();
      if (typeof ttsHardStop === 'function') ttsHardStop();
      if (IS_DESKTOP && window.desktopAPI?.bumpMcPanic) {
        window.desktopAPI.bumpMcPanic().catch(() => {});
      }
      if (relayActive() || desktopRelayOn()) postLocalMedia('panic');
      break;
    case 'timer': renderTimerState(p); break;
    case 'timerBeep': break;
    case 'pointsList': onPointsList(p); break;
    case 'pointsUpdate': onPointsUpdate(p); break;
    case 'pointsTx': onPointsTx(p); break;
    case 'spotifyHistory': if (typeof renderSpotifyHistory === 'function') renderSpotifyHistory(p.history || []); break;
    case 'spotifyQueue': break;
    case 'spotifyNowPlaying': break;
    case 'spotifyCommand': break;
    case 'musicState': if (typeof handleMusicWs === 'function') handleMusicWs('musicState', p); break;
    case 'queueUpdated': if (typeof handleMusicWs === 'function') handleMusicWs('queueUpdated', p); break;
    case 'currentSongUpdated': if (typeof handleMusicWs === 'function') handleMusicWs('currentSongUpdated', p); break;
    case 'creditsUpdated': if (typeof handleMusicWs === 'function') handleMusicWs('creditsUpdated', p); break;
    case 'songAdded': case 'songStarted': case 'songFinished': case 'songSkipped':
    case 'queueCleared': case 'playerPaused': case 'playerResumed': case 'playerStopped':
    case 'musicAlert':
      if (typeof handleMusicWs === 'function') handleMusicWs(m.type, p);
      break;
    case 'caps': setCaps(p); loadPlanComparison(true); break;
    case 'keyAction': onKeyAction(p); break;
    case 'localExec': onLocalExec(p); break;
    case 'playLevelVideo':
      if (IS_DESKTOP) testLevelVideoLocal(Number(p?.level) || 1, { quiet: true });
      break;
    case 'playMedia':
      if (IS_DESKTOP && (relayActive() || desktopRelayOn())) postLocalMedia('media', { media: p });
      break;
    case 'stopMediaLocal':
      if (IS_DESKTOP && (relayActive() || desktopRelayOn())) postLocalMedia('stop', { screen: Number(p?.screen) || 1 });
      break;
    case 'panicLocal':
      if (IS_DESKTOP && (relayActive() || desktopRelayOn())) postLocalMedia('panic');
      break;
    case 'localReady': break; // canal relay listo (no requiere acción en la UI)
    case 'profiles': onProfiles(p); break;
    case 'profilesFull': onProfilesFull(p); break;
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
  const audio = new Audio(mediaUrl(s.sound));
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

/** Detiene videos en cola (OBS), sonidos del panel y TTS de inmediato. */
function triggerAlertPanic() {
  try { previewAudio?.pause(); } catch {}
  stopPanelSounds();
  if (typeof ttsHardStop === 'function') ttsHardStop();
  if (IS_DESKTOP && window.desktopAPI?.bumpMcPanic) {
    window.desktopAPI.bumpMcPanic().catch(() => {});
  }
  send({ action: 'panic' });
  toast('⛔ Pánico: Minecraft, videos, sonidos y TTS detenidos', 'warn');
}

/* ====================== Navegación lateral ====================== */
document.querySelectorAll('.nav-item').forEach((btn) => {
  btn.onclick = () => {
    document.querySelectorAll('.nav-item').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
    btn.classList.add('active');
    const view = document.getElementById(`view-${btn.dataset.view}`);
    if (!view) { console.error('Vista no encontrada:', btn.dataset.view); return; }
    view.classList.add('active');
    if (btn.dataset.view === 'admin') { loadAdminUsers(); loadPlans(); loadAnnouncementsAdmin(); loadMaintenanceAdmin(); loadAppVersion(); loadPcInstallLink(); }
    if (btn.dataset.view === 'planes') { renderPlanView(); loadPlanComparison(true); }
    if (btn.dataset.view === 'regalos') { try { initGiftCatalogView(); } catch (e) { console.error('Catálogo regalos:', e); } }
    if (btn.dataset.view === 'points') { send({ action: 'getPoints' }); renderPointsTable(); }
    if (btn.dataset.view === 'spotify') { try { setupSpotifyUI(); refreshSpotifyStatus(); } catch (e) { console.error('Spotify UI:', e); } }
    if (btn.dataset.view === 'music-requests') { try { setupMusicRequestsUI(); } catch (e) { console.error('Music UI:', e); } }
    if (btn.dataset.view === 'webhook') { try { setupWebhookUI(); } catch (e) { console.error('Webhook UI:', e); } }
    if (btn.dataset.view === 'configuracion') { try { setupWebhookUI(); applyWebhookUI(); } catch (e) { console.error('Configuración UI:', e); } }
    if (btn.dataset.view === 'acciones') {
      try { setupAccionesUI(); if (typeof renderAcciones === 'function') renderAcciones(); } catch (e) { console.error('Acciones UI:', e); }
    }
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
            <div class="admin-actions-row">
            ${u.active
              ? `<button class="btn tiny deactivate" data-id="${u.id}" data-active="0">Desactivar</button>`
              : `<button class="btn tiny activate" data-id="${u.id}" data-active="1">Activar</button>`}
            <div class="prem-ctl">
              <input type="number" class="prem-days" min="1" max="3650" placeholder="días" data-id="${u.id}">
              <button class="btn tiny prem-give" data-id="${u.id}">Dar Premium</button>
              <button class="btn tiny prem-fixed" data-id="${u.id}">Fijo</button>
              ${u.plan === 'premium' ? `<button class="btn tiny prem-remove" data-id="${u.id}">Quitar</button>` : ''}
            </div>
            </div>
            <button class="btn tiny admin-delete" data-id="${u.id}" data-username="${u.username.replace(/"/g, '&quot;')}">Eliminar cuenta</button>
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
    tbody.querySelectorAll('.admin-delete').forEach((b) => {
      b.onclick = () => deleteUserReq(b.dataset.id, b.dataset.username || '');
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

async function deleteUserReq(id, username) {
  const ok = await askConfirm({
    title: 'Eliminar cuenta',
    message: `Se borrará la cuenta «${username || 'usuario'}» y todos sus datos. Esta acción no se puede deshacer.`,
    confirmText: 'Eliminar',
  });
  if (!ok) return;
  try {
    const r = await fetch('/api/admin/delete-user', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    const data = await r.json().catch(() => ({}));
    if (r.ok) toast(`Cuenta «${data.username || username}» eliminada.`);
    else toast(data.error || 'No se pudo eliminar la cuenta.', 'warn');
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

/* ---- Modo mantenimiento (panel web) ---- */
async function loadMaintenanceAdmin() {
  const en = document.getElementById('maint-enabled');
  if (!en) return;
  try {
    const r = await fetch('/api/maintenance');
    if (!r.ok) return;
    const d = await r.json();
    en.checked = !!d.enabled;
    const msg = document.getElementById('maint-message');
    if (msg) msg.value = d.message || '';
  } catch {}
}

(function setupMaintenanceAdmin() {
  const btn = document.getElementById('maint-save');
  if (!btn) return;
  btn.onclick = async () => {
    const status = document.getElementById('maint-status');
    const body = {
      enabled: !!document.getElementById('maint-enabled')?.checked,
      message: (document.getElementById('maint-message')?.value || '').trim(),
    };
    btn.disabled = true;
    if (status) status.textContent = 'Guardando…';
    try {
      const r = await fetch('/api/admin/maintenance', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const d = await r.json().catch(() => ({}));
      if (status) {
        status.textContent = r.ok
          ? (body.enabled ? 'Mantenimiento activado.' : 'Mantenimiento desactivado.')
          : (d.error || 'No se pudo guardar.');
      }
    } catch {
      if (status) status.textContent = 'Error de conexión.';
    } finally {
      btn.disabled = false;
    }
  };
})();

/* ---- Anuncios (campana + admin) ---- */
let annCache = [];

function annSeenKey() { return `livecoins_ann_seen_${window.MY_USER || 'default'}`; }
function annSeenAt() { return Number(localStorage.getItem(annSeenKey()) || 0); }

function annEsc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatAnnDate(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleDateString('es', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function updateAnnDot() {
  const dot = document.getElementById('annDot');
  if (!dot) return;
  const seen = annSeenAt();
  dot.hidden = !annCache.some((a) => (a.createdAt || 0) > seen);
}

function markAnnSeen() {
  const latest = annCache.reduce((m, a) => Math.max(m, a.createdAt || 0), 0);
  if (latest > 0) localStorage.setItem(annSeenKey(), String(latest));
  updateAnnDot();
  renderAnnList();
}

function renderAnnList() {
  const list = document.getElementById('annPopList');
  if (!list) return;
  if (!annCache.length) {
    list.innerHTML = '<p class="ann-empty">No hay anuncios por ahora.</p>';
    return;
  }
  const seen = annSeenAt();
  list.innerHTML = annCache.map((a) => `
    <article class="ann-item${(a.createdAt || 0) > seen ? ' unread' : ''}">
      <div class="ann-item-title">${annEsc(a.title || 'Anuncio')}</div>
      <div class="ann-item-msg">${annEsc(a.message || '')}</div>
      <div class="ann-item-date">${formatAnnDate(a.createdAt)}</div>
    </article>
  `).join('');
}

async function loadAnnouncements() {
  try {
    const r = await fetch('/api/announcements', { credentials: 'same-origin', cache: 'no-store' });
    if (!r.ok) return;
    const d = await r.json();
    annCache = Array.isArray(d.announcements) ? d.announcements : [];
    updateAnnDot();
    if (document.getElementById('annPop') && !document.getElementById('annPop').hidden) renderAnnList();
  } catch {}
}

function toggleAnnPop(open) {
  const pop = document.getElementById('annPop');
  if (!pop) return;
  const show = open ?? pop.hidden;
  pop.hidden = !show;
  if (show) {
    renderAnnList();
    markAnnSeen();
  }
}

(function setupAnnouncements() {
  const btn = document.getElementById('annBellBtn');
  const close = document.getElementById('annPopClose');
  const wrap = document.getElementById('annWrap');
  if (!btn) return;
  btn.onclick = (e) => { e.stopPropagation(); toggleAnnPop(); };
  if (close) close.onclick = () => toggleAnnPop(false);
  document.addEventListener('click', (e) => {
    if (wrap && !wrap.contains(e.target)) toggleAnnPop(false);
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) loadAnnouncements();
  });
  loadAnnouncements();
  setInterval(loadAnnouncements, 60000);
})();

async function loadAnnouncementsAdmin() {
  const list = document.getElementById('ann-admin-list');
  if (!list) return;
  try {
    const r = await fetch('/api/announcements', { credentials: 'same-origin', cache: 'no-store' });
    if (!r.ok) { list.innerHTML = '<p class="tts-sub">Sin acceso.</p>'; return; }
    const d = await r.json();
    const items = Array.isArray(d.announcements) ? d.announcements : [];
    if (!items.length) { list.innerHTML = '<p class="tts-sub">Aún no hay anuncios publicados.</p>'; return; }
    list.innerHTML = items.map((a) => `
      <div class="ann-admin-item">
        <div class="ann-admin-item-body">
          <div class="ann-admin-item-title">${annEsc(a.title)}</div>
          <div class="ann-admin-item-msg">${annEsc(a.message)}</div>
          <div class="ann-admin-item-date">${formatAnnDate(a.createdAt)}</div>
        </div>
        <button type="button" class="btn tiny ghost ann-admin-del" data-id="${annEsc(a.id)}">Eliminar</button>
      </div>
    `).join('');
    list.querySelectorAll('.ann-admin-del').forEach((b) => {
      b.onclick = async () => {
        if (!confirm('¿Eliminar este anuncio?')) return;
        b.disabled = true;
        try {
          const dr = await fetch('/api/admin/announcements/delete', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: b.dataset.id }),
          });
          if (dr.ok) { loadAnnouncementsAdmin(); loadAnnouncements(); }
        } catch {} finally { b.disabled = false; }
      };
    });
  } catch {
    list.innerHTML = '<p class="tts-sub">Error al cargar.</p>';
  }
}

(function setupAnnouncementsAdmin() {
  const btn = document.getElementById('ann-admin-send');
  if (!btn) return;
  btn.onclick = async () => {
    const status = document.getElementById('ann-admin-status');
    const title = (document.getElementById('ann-admin-title')?.value || '').trim();
    const message = (document.getElementById('ann-admin-message')?.value || '').trim();
    if (!title) { if (status) status.textContent = 'Escribe un título.'; return; }
    if (!message) { if (status) status.textContent = 'Escribe el mensaje.'; return; }
    btn.disabled = true;
    if (status) status.textContent = 'Publicando…';
    try {
      const r = await fetch('/api/admin/announcements', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, message }),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok) {
        if (status) status.textContent = 'Anuncio publicado.';
        const t = document.getElementById('ann-admin-title'); if (t) t.value = '';
        const m = document.getElementById('ann-admin-message'); if (m) m.value = '';
        loadAnnouncementsAdmin();
        loadAnnouncements();
      } else if (status) {
        status.textContent = d.error || 'No se pudo publicar.';
      }
    } catch {
      if (status) status.textContent = 'Error de conexión.';
    } finally {
      btn.disabled = false;
    }
  };
})();

/* ---- Publicar versión de la app de escritorio (.exe) ---- */
async function loadAppVersion() {
  const verEl = document.getElementById('appver-version');
  if (!verEl) return;
  try {
    const r = await fetch('/api/app-version');
    if (!r.ok) return;
    const d = await r.json();
    verEl.value = d.version || '';
    const u = document.getElementById('appver-url'); if (u) u.value = d.url || '';
    const n = document.getElementById('appver-notes'); if (n) n.value = d.notes || '';
    const m = document.getElementById('appver-mandatory'); if (m) m.checked = !!d.mandatory;
  } catch {}
}

(function setupAppVersionPublish() {
  const btn = document.getElementById('appver-save');
  if (!btn) return;
  btn.onclick = async () => {
    const status = document.getElementById('appver-status');
    const body = {
      version: (document.getElementById('appver-version')?.value || '').trim(),
      url: (document.getElementById('appver-url')?.value || '').trim(),
      notes: (document.getElementById('appver-notes')?.value || '').trim(),
      mandatory: !!document.getElementById('appver-mandatory')?.checked,
    };
    if (!body.version) { if (status) status.textContent = 'Escribe la versión.'; return; }
    if (!body.url) { if (status) status.textContent = 'Escribe el enlace de descarga.'; return; }
    btn.disabled = true;
    if (status) status.textContent = 'Publicando…';
    try {
      const r = await fetch('/api/admin/app-version', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok && body.url) {
        try {
          await fetch('/api/admin/web-install', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: body.url }),
          });
          const wi = document.getElementById('webinstall-url');
          if (wi) wi.value = body.url;
        } catch {}
      }
      if (status) status.textContent = r.ok ? `Publicada la versión ${d.version} (enlace de instalación sincronizado).` : (d.error || 'No se pudo publicar.');
    } catch {
      if (status) status.textContent = 'Error de conexión.';
    } finally {
      btn.disabled = false;
    }
  };
})();

/* ---- Enlace del botón "Instalar versión PC" (.exe) ---- */
async function loadPcInstallLink() {
  const el = document.getElementById('webinstall-url');
  if (!el) return;
  try {
    const r = await fetch('/api/web-install');
    if (!r.ok) return;
    const d = await r.json();
    el.value = d.url || '';
  } catch {}
}

(function setupPcInstallSave() {
  const btn = document.getElementById('webinstall-save');
  if (!btn) return;
  btn.onclick = async () => {
    const status = document.getElementById('webinstall-status');
    const url = (document.getElementById('webinstall-url')?.value || '').trim();
    btn.disabled = true;
    if (status) status.textContent = 'Guardando…';
    try {
      const r = await fetch('/api/admin/web-install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'Error');
      if (status) status.textContent = '✓ Enlace guardado.';
      applyPcInstallButton();
    } catch (e) {
      if (status) status.textContent = '⚠️ ' + (e.message || 'No se pudo guardar.');
    } finally {
      btn.disabled = false;
    }
  };
})();

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
    ${plansCatalog.games && plansCatalog.games.length ? groupHtml('Juegos', plansCatalog.games) : ''}
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

let connectStreamerPhoto = '';

function connectAvatarUrl(photo) {
  if (!photo) return '';
  if (/^https?:\/\//i.test(photo) && !photo.startsWith(location.origin)) {
    return '/api/img-proxy?url=' + encodeURIComponent(photo);
  }
  return photo;
}

function updateConnectAvatar({ photo, nickname, username, live } = {}) {
  const wrap = document.getElementById('connectAv');
  const img = document.getElementById('connectAvImg');
  const ph = document.getElementById('connectAvPh');
  if (!wrap || !img || !ph) return;
  if (photo) connectStreamerPhoto = photo;
  const name = nickname || username || $('username')?.value || '';
  const url = connectAvatarUrl(photo || connectStreamerPhoto);
  wrap.classList.toggle('live', !!live);
  if (url) {
    img.referrerPolicy = 'no-referrer';
    img.src = url;
    img.hidden = false;
    ph.hidden = true;
    img.onerror = () => {
      img.hidden = true;
      ph.hidden = false;
      ph.textContent = initial(name);
    };
  } else {
    img.hidden = true;
    ph.hidden = false;
    ph.textContent = initial(name || '?');
  }
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
    dot.className = 'dot off';
    if (s.autoConnect && s.username) {
      // Auto-conexión activa: aún no estás en vivo, el servidor reintenta solo.
      st.textContent = `Esperando tu live · @${s.username}`;
      badge.className = 'live-badge off'; badge.textContent = '● Esperando tu live';
    } else {
      st.textContent = 'Desconectado';
      badge.className = 'live-badge off'; badge.textContent = '● Desconectado';
    }
    $('btnConnect').hidden = false; $('btnDisconnect').hidden = true;
  }
  if (s.username && !$('username').value) $('username').value = s.username;
  if (s.username) { try { localStorage.setItem('lastTikTokUser', s.username); } catch {} }
  updateConnectAvatar({
    photo: s.photo,
    nickname: s.nickname,
    username: s.username,
    live: !!s.connected,
  });
  renderLeaderboard(s.topGifters || []);
  try { updateHomeWelcome(s); } catch {}
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
function addChat(p) {
  ttsTrackChatUser(p);
  const lvl = Number(p.memberLevel) || 0;
  const lvlTag = lvl > 0 ? `<span class="chat-lvl" title="Nivel miembro club de fans">Nv.${lvl}</span>` : '';
  const dLvl = Number(p.donorLevel) || 0;
  const donorTitle = p.donorSource === 'tiktok' ? 'Nivel donador TikTok (regalos globales)' : 'Nivel donador (puntos en tu canal)';
  const donorTag = dLvl > 0 ? `<span class="chat-donlvl" title="${donorTitle}">⭐${dLvl}</span>` : '';
  pushRow('chat', `${avatar(p)}<div><span class="name">${esc(p.nickname)}</span>${lvlTag}${donorTag}<span class="text">${esc(p.comment)}</span></div>`);
}

// Respuesta automática de un comando personalizado: se muestra en el chat del panel
// y se lee en voz alta (respetando la voz/idioma configurados en Chat TTS).
function handleBotReply(p) {
  const text = String(p?.text || '').trim();
  if (!text) return;
  pushRow('chat', `<div class="ph bot-ava">🤖</div><div><span class="name bot-name">Bot · ${esc(p.command || '')}</span><span class="text">${esc(text)}</span></div>`, 'bot');
  ttsSpeakText(text); // la respuesta del comando siempre se lee en voz alta
}
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
function desktopRelayOn() {
  return IS_DESKTOP && !!(window.desktopAPI && window.desktopAPI.relayMode);
}

async function relayConnectHttp(username) {
  const r = await fetch('/api/desktop/connect-live', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'No se pudo conectar');
  return d;
}

async function relayDisconnectHttp() {
  const r = await fetch('/api/desktop/disconnect-live', { method: 'POST' });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'No se pudo desconectar');
  return d;
}

async function refreshCloudSession() {
  try {
    let r = await fetch('/api/desktop/refresh-cloud-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (r.status === 404) r = await fetch('/api/me');
    if (!r.ok) return false;
    const d = await r.json();
    const prev = window.CLOUD_ROOM_KEY || '';
    window.CLOUD_ROOM_KEY = d.cloudRoomKey || '';
    window.CLOUD_SESSION_OK = d.cloudSessionOk !== false;
    if (window.CLOUD_ROOM_KEY && window.CLOUD_ROOM_KEY !== prev) {
      connectWS();
      if (typeof refreshOverlayUrls === 'function') refreshOverlayUrls();
    }
    return !!window.CLOUD_ROOM_KEY;
  } catch {
    return false;
  }
}

let cloudSessionPollTimer = null;
function startCloudSessionPoll() {
  if (!(relayActive() || desktopRelayOn())) return;
  if (cloudSessionPollTimer) return;
  cloudSessionPollTimer = setInterval(() => { refreshCloudSession().catch(() => {}); }, 45000);
}

let connectBusy = false;

async function doConnect() {
  const u = $('username').value.trim().replace(/^@/, '');
  if (!u) { $('username').focus(); return; }
  if (connectBusy) return;
  connectBusy = true;
  try {
    flushSaveSettings();
    try { localStorage.setItem('lastTikTokUser', u); } catch {}

    const relay = relayActive() || desktopRelayOn();

    if (relay && !window.CLOUD_ROOM_KEY) {
      await refreshCloudSession();
    }

    if (relay && !window.CLOUD_ROOM_KEY) {
      if (!window.CLOUD_SESSION_OK) {
        toast('Sin sesión con la nube. Cierra sesión y vuelve a entrar con internet.', 'warn');
        return;
      }
      try {
        await relayConnectHttp(u);
        toast('Conectando a @' + u + '…', 'ok');
      } catch (e) {
        toast(e.message || 'Sin sesión con la nube. Cierra sesión y vuelve a entrar.', 'warn');
      }
      return;
    }

    if (ws?.readyState === 1) {
      send({ action: 'connect', username: u });
      return;
    }

    connectWS();
    const ok = await waitForWsOpen(relay ? 12000 : 8000);
    if (ok) {
      send({ action: 'connect', username: u });
      return;
    }
    if (relay) {
      if (!window.CLOUD_SESSION_OK) {
        toast('Sin sesión con la nube. Cierra sesión y vuelve a entrar con internet.', 'warn');
        return;
      }
      try {
        await relayConnectHttp(u);
        toast('Conectando a @' + u + '…', 'ok');
        return;
      } catch (e) {
        toast(e.message || 'Render no responde. Espera 1 min y vuelve a intentar.', 'warn');
        return;
      }
    }

    toast('Sin conexión al servidor. Si usas Render, espera que despierte (~1 min) y recarga.', 'warn');
  } finally {
    connectBusy = false;
  }
}
async function doDisconnect() {
  if (ws?.readyState === 1) {
    send({ action: 'disconnect' });
    return;
  }
  if (desktopRelayOn()) {
    try {
      await relayDisconnectHttp();
      toast('Desconectado', 'ok');
    } catch (e) {
      toast(e.message || 'No se pudo desconectar', 'warn');
    }
    return;
  }
  send({ action: 'disconnect' });
}
$('btnConnect').onclick = doConnect;
$('btnDisconnect').onclick = doDisconnect;
$('username').addEventListener('keydown', (e) => { if (e.key === 'Enter') doConnect(); });
$('username').addEventListener('input', () => updateConnectAvatar({ username: $('username').value.trim() }));
// Prerellena el último usuario guardado al abrir el panel (antes incluso de que llegue
// el estado del servidor), para que el campo nunca aparezca vacío.
try {
  const lastU = localStorage.getItem('lastTikTokUser');
  if (lastU && !$('username').value) $('username').value = lastU;
  if (lastU) updateConnectAvatar({ username: lastU });
} catch {}
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
let localSaveDebounce = null;

function saveSettingsToLocalMirror() {
  if (!relayActive() || !settings || applyingSettings) return;
  clearTimeout(localSaveDebounce);
  localSaveDebounce = setTimeout(() => {
    fetch('/api/my-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings }),
    }).catch(() => {});
  }, 250);
}

function saveSettings() {
  if (applyingSettings) return;
  clearTimeout(saveDebounce);
  saveDebounce = setTimeout(() => {
    stripSettingsMediaForSave(settings);
    send({ action: 'saveSettings', settings });
    saveSettingsToLocalMirror();
  }, 200);
}
function flushSaveSettings() {
  if (applyingSettings || !settings) return;
  clearTimeout(saveDebounce);
  saveDebounce = null;
  stripSettingsMediaForSave(settings);
  send({ action: 'saveSettings', settings });
  saveSettingsToLocalMirror();
}
function sendTestMcAction(uid) {
  flushSaveSettings();
  if (ws?.readyState !== WebSocket.OPEN) {
    toast && toast('Sin conexión al servidor. Espera a que el panel conecte.', 'warn');
    return;
  }
  send({ action: 'testMcAction', uid });
  toast && toast('Enviando comando al servidor de Minecraft…', 'ok');
}

function mcCmdReady(a) {
  return !!(a && a.enabled !== false && (a.cmd || (Array.isArray(a.cmds) && a.cmds.length)));
}

function onSettings(s) {
  settings = preserveLocalGameActionsOnSettingsEcho(s);
  if (migrateAccionesSpawnWebhooks(settings.actions)) saveSettings();
  normalizeRelayMedia(settings);
  ['toplikesRank', 'topdiamRank', 'toplikesList', 'topdiamList', 'top1fire', 'habibiTop'].forEach((k) => {
    if (settings[k] && settings[k].resetPeriod == null) settings[k].resetPeriod = 'live';
  });
  if (settings.topAltRank) {
    if (settings.topAltRank.resetPeriodLikes == null) settings.topAltRank.resetPeriodLikes = 'live';
    if (settings.topAltRank.resetPeriodDiam == null) settings.topAltRank.resetPeriodDiam = 'live';
  }
  if (settings.topAltRankNeon) {
    if (settings.topAltRankNeon.resetPeriodLikes == null) settings.topAltRankNeon.resetPeriodLikes = 'live';
    if (settings.topAltRankNeon.resetPeriodDiam == null) settings.topAltRankNeon.resetPeriodDiam = 'live';
  }
  applyingSettings = true;
  applySettingsToUI();
  applyingSettings = false;
  if (typeof onMusicSettingsLoaded === 'function') onMusicSettingsLoaded();
  applyLimitUI();
  renderPlanView();
  if (typeof renderMyMcActions === 'function') renderMyMcActions();
  if (typeof renderMyBedrockActions === 'function') renderMyBedrockActions();
  if (typeof renderMySandboxActions === 'function') renderMySandboxActions();
  // Al abrir el panel, las acciones de Roblox SIEMPRE arrancan apagadas (una sola vez
  // por sesión). Solo funcionan cuando el usuario las enciende con el botón verde.
  if (typeof renderRobloxActions === 'function') {
    if (!window._rbxResetDone) {
      window._rbxResetDone = true;
      const rl = ensureRobloxSlots();
      if (rl.length && rl.some((a) => a.enabled !== false)) {
        rl.forEach((a) => { a.enabled = false; });
        saveSettings();
      }
    }
    renderRobloxActions();
  }
  // Igual que Roblox: las acciones de Roblox 3 arrancan apagadas al abrir el panel.
  if (typeof renderRoblox3Actions === 'function') {
    if (!window._rbx3ResetDone) {
      window._rbx3ResetDone = true;
      const rl = ensureRoblox3Slots();
      if (rl.length && rl.some((a) => a.enabled !== false)) {
        rl.forEach((a) => { a.enabled = false; });
        saveSettings();
      }
    }
    renderRoblox3Actions();
  }
  // Igual que Roblox: las acciones de Mario Bros arrancan apagadas al abrir el panel.
  if (typeof renderMarioActions === 'function') {
    if (!window._marioResetDone) {
      window._marioResetDone = true;
      const ml = ensureMarioActions();
      if (ml.length && ml.some((a) => a.enabled !== false)) {
        ml.forEach((a) => { a.enabled = false; });
        saveSettings();
      }
    }
    renderMarioActions();
  }
  // Igual que Mario: las acciones de Plants vs Zombies arrancan apagadas al abrir el panel.
  if (typeof renderPvzActions === 'function') {
    if (!window._pvzResetDone) {
      window._pvzResetDone = true;
      const pl = ensurePvzActions();
      if (pl.length && pl.some((a) => a.enabled !== false)) {
        pl.forEach((a) => { a.enabled = false; });
        saveSettings();
      }
    }
    renderPvzActions();
  }
  if (typeof renderSmb3Actions === 'function') renderSmb3Actions();
  if (typeof renderMari0Actions === 'function') renderMari0Actions();
  if (typeof renderPvzHybridActions === 'function') renderPvzHybridActions();
  
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
  if (typeof refreshGiftCounterCardUI === 'function') refreshGiftCounterCardUI();
  if (typeof pushGiftVsPreview === 'function') setTimeout(() => pushGiftVsPreview(), 300);
  if (typeof pushFlowMeterPreview === 'function') setTimeout(() => pushFlowMeterPreview(), 300);
  if (typeof pushGiftSeqPreview === 'function') setTimeout(() => pushGiftSeqPreview(), 300);
  if (typeof pushGiftShowcasePreview === 'function') setTimeout(() => pushGiftShowcasePreview(), 300);
  if (typeof pushStyleOverlayPreviews === 'function') setTimeout(() => pushStyleOverlayPreviews(), 300);
  if (typeof refreshWinsCounters === 'function') setTimeout(() => refreshWinsCounters(), 300);
  if (typeof window.pushHypePreview === 'function') setTimeout(() => window.pushHypePreview(), 300);
  renderScreens();
  renderVideos();
  applyLevelVideosUI();
  renderSoundAlerts();
  if (typeof applyPointsSettingsUI === 'function') applyPointsSettingsUI();
  if (typeof applySpotifyUI === 'function') applySpotifyUI();
  if (typeof applyWebhookUI === 'function') applyWebhookUI();
  if (typeof renderAcciones === 'function') renderAcciones();
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
  const lv = settings.levelVideos || {};
  const lvOn = lv.enabled !== false;
  const lvScr = Number(lv.screen) || 1;
  el.innerHTML = screens.map((s) => {
    const count = (settings.videos || []).filter((v) => (Number(v.screen) || 1) === s.id).length
      + (lvOn && lvScr === s.id ? 1 : 0);
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
      navigator.clipboard?.writeText(relayActive() ? videoScreenUrl(id) : roomUrl(`/video.html?screen=${id}`));
      e.target.textContent = '¡copiado!';
      setTimeout(() => (e.target.textContent = 'Copiar link'), 1200);
    };
    card.querySelector('.test').onclick = () => send({ action: 'testScreen', screen: id });
    const range = card.querySelector('input');
    range.oninput = () => { s.size = +range.value; card.querySelector('.screen-size b').textContent = s.size + '%'; saveSettings(); };
  });
}

function videoCardThumbLabel(item, icon = '🎬') {
  if (!item?.url) return icon;
  const name = esc(item.fileName || item.name || 'video');
  return `<div class="vthumb-label" title="${name}"><span class="vthumb-ico">${icon}</span><span class="vthumb-name">${name}</span></div>`;
}

function renderVideos() {
  const el = $('videoCards');
  const list = settings.videos || [];
  if (!list.length) { el.innerHTML = '<div class="empty">No hay videos. Pulsa “Añadir video”.</div>'; return; }
  el.innerHTML = list.map((v) => {
    const thumb = videoCardThumbLabel(v);
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

/* ----- Videos automáticos por nivel de miembro (carpeta «niveles») ----- */
async function testLevelVideoLocal(level, { quiet = false } = {}) {
  const n = Math.max(1, parseInt(level, 10) || 1);
  try {
    const r = await fetch('/api/test-level-video', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level: n }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.ok) {
      if (d.error === 'no_file') {
        toast && toast(`No hay nivel${n}.webm en public/video/niveles`, 'warn');
      } else if (d.error === 'disabled') {
        toast && toast('Activa «Subió de nivel de miembro» (ON) para probar.', 'warn');
      } else {
        toast && toast(d.error || 'No se pudo reproducir el video de prueba.', 'err');
      }
      return false;
    }
    if (!quiet) {
      const scr = Number(d.screen) || Number(settings?.levelVideos?.screen) || 1;
      if (connectedScreens.has(scr)) toast && toast(`Reproduciendo nivel ${n}…`, 'ok');
      else toast && toast(`Video enviado. Abre el link local en Live Studio (Pantalla ${scr}).`, 'warn');
    }
    refreshLevelVideoScreenLink();
    return true;
  } catch {
    toast && toast('No se pudo contactar al servidor local.', 'err');
    return false;
  }
}
function applyLevelVideosUI() {
  const cfg = settings.levelVideos || (settings.levelVideos = { enabled: true, screen: 1, volume: 100 });
  const en = $('levelvid-enabled');
  if (!en) return;
  if (!cfg.screen) cfg.screen = 1;
  en.checked = cfg.enabled !== false;
  const st = en.closest('.levelvid-toggle')?.querySelector('.state');
  if (st) st.textContent = en.checked ? 'ON' : 'OFF';
  refreshLevelVideoScreenLink();
}
if ($('levelvid-copy-url')) {
  $('levelvid-copy-url').addEventListener('click', () => {
    const cfg = settings.levelVideos || {};
    const url = levelVideoScreenUrl(Number(cfg.screen) || 1);
    navigator.clipboard?.writeText(url);
    toast && toast('Link copiado — pégalo en Live Studio', 'ok');
  });
}
if ($('levelvid-enabled')) {
  $('levelvid-enabled').addEventListener('change', () => {
    if (!settings.levelVideos) settings.levelVideos = {};
    settings.levelVideos.enabled = $('levelvid-enabled').checked;
    const st = $('levelvid-enabled').closest('.levelvid-toggle')?.querySelector('.state');
    if (st) st.textContent = $('levelvid-enabled').checked ? 'ON' : 'OFF';
    saveSettings();
    renderScreens();
  });
}
if ($('levelvid-test')) {
  $('levelvid-test').addEventListener('click', () => {
    const level = Math.max(1, parseInt($('levelvid-test-level')?.value, 10) || 1);
    testLevelVideoLocal(level);
  });
}

/* ----- Modal video ----- */
function setVidEventUI(value) {
  $('vid-event').value = value;
  $('vid-giftanyextra').hidden = value !== 'gift-any';
  $('vid-giftextra').hidden = value !== 'gift-name';
  $('vid-likeuserextra').hidden = value !== 'like';
  $('vid-likeextra').hidden = value !== 'likeGlobal';
  $('vid-emoteextra').hidden = value !== 'emote';
  $('vid-cmdextra').hidden = value !== 'chatCommand';
  $('vid-userextra').hidden = value !== 'chatCommand' && value !== 'firstMessage' && value !== 'userJoin';
  $('vid-joindelayextra').hidden = value !== 'userJoin';
  const userInput = $('vid-user');
  if (userInput) userInput.placeholder = value === 'userJoin'
    ? 'Usuario que al entrar reproduce el video (sin @)'
    : 'Solo este usuario (sin @) — opcional';
}

function openVidModal(v = null) {
  vidEditingId = v?.id || null;
  vidPending = v?.url ? { url: v.url, name: v.fileName } : null;
  $('vid-modal-title').textContent = v ? 'Configurar alerta de video' : 'Configurar alerta de video';
  $('vid-name').value = v?.name || '';
  let ev = 'gift-any';
  const trig = v?.trigger || 'gift';
  if (trig === 'gift') ev = v?.giftName ? 'gift-name' : 'gift-any';
  else if (trig === 'levelUp') {
    ev = 'gift-any';
    $('vid-status').textContent = 'Los videos de «Subió de nivel» ahora usan la barra azul de arriba y la carpeta niveles.';
  } else ev = trig;
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
  $('vid-user').value = v?.user || '';
  $('vid-joindelay').value = v?.joinDelay ?? 30;
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

// Tras subir, el servidor puede convertir (MOV, MP4 HEVC/H.265, etc.).
function uploadNeedsVideoConvert(file) {
  if (!file) return false;
  if (/^image\//i.test(file.type) || /^audio\//i.test(file.type)) return false;
  const name = file.name || '';
  if (/\.(gif|png|jpe?g|webp|apng|bmp|svg|mp3|wav|aac|m4a|oga)(\?|$)/i.test(name)) return false;
  return /^video\//i.test(file.type) || /\.(mp4|webm|m4v|mov|avi|mkv|wmv|flv|hevc|ts|mts|3gp|mpeg|mpg|ogv|ogg)(\?|$)/i.test(name);
}
// Sube un archivo mostrando progreso; si hace falta conversión, avisa al terminar la subida.
function uploadMediaWithProgress(file, setStatus) {
  return new Promise((resolve, reject) => {
    const needsConvert = uploadNeedsVideoConvert(file);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload?name=' + encodeURIComponent(file.name));
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) { setStatus('Subiendo video…'); return; }
      setStatus(`Subiendo video… ${Math.round((e.loaded / e.total) * 100)}%`);
    };
    xhr.upload.onload = () => {
      if (needsConvert) setStatus('Convirtiendo video… puede tardar un poco');
    };
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText || '{}'); } catch {}
      if (xhr.status >= 400 || !data.url) {
        reject(new Error(data.error || `Error al subir (${xhr.status || 'red'})`));
        return;
      }
      resolve(data);
    };
    xhr.onerror = () => reject(new Error('Error de red al subir el archivo'));
    xhr.send(file);
  });
}

function uploadErrLabel(err) {
  const msg = String(err?.message || err || '').trim();
  if (!msg || msg === 'error') return 'Error al subir';
  return msg.length > 120 ? msg.slice(0, 117) + '…' : msg;
}

$('vid-upbtn').onclick = () => $('vid-file').click();
$('vid-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const label = $('vid-fname');
  try {
    const data = await uploadMediaWithProgress(file, (msg) => { label.textContent = msg; });
    vidPending = { url: data.url, name: file.name };
    label.textContent = file.name;
  } catch (err) { label.textContent = uploadErrLabel(err); }
  e.target.value = '';
});

/* "Videos AI" = elegir un video de la carpeta public/video (ventana aparte) */
let localVideos = [];

let libTarget = 'vid'; // 'vid' | 'ba' — a qué modal vuelve el video elegido de la librería
$('vid-libbtn').onclick = () => { libTarget = 'vid'; openVideoLib(); };
$('vidlib-close').onclick = closeVideoLib;
$('vidlib-cancel').onclick = closeVideoLib;
$('videoLibModal').addEventListener('click', (e) => { if (e.target.id === 'videoLibModal') closeVideoLib(); });
$('vid-librefresh').onclick = () => loadLocalVideos();
if ($('vidlib-openniveles')) {
  $('vidlib-openniveles').onclick = async () => {
    try { if (window.desktopAPI && window.desktopAPI.openNivelesFolder) await window.desktopAPI.openNivelesFolder(); } catch {}
  };
}
$('vid-libq').addEventListener('input', () => renderLocalVideos($('vid-libq').value.trim()));

// ¿La biblioteca debe mostrar la carpeta «niveles»? Solo en Videos y cuando el
// evento elegido es "Subió de nivel de miembro".
function libIsNiveles() {
  return false;
}

function openVideoLib() {
  // Ajusta los textos del modal según la carpeta (Videos / Batallas / Niveles).
  const niveles = libIsNiveles();
  const folder = libTarget === 'ba' ? 'public/video/batalla' : (niveles ? 'public/video/niveles' : 'public/video');
  const sub = document.querySelector('#videoLibModal .vidlib-sub');
  if (sub) sub.textContent = libTarget === 'ba'
    ? 'Selecciona un video de la carpeta de batallas (vista previa vertical)'
    : niveles
      ? 'Selecciona el video del nivel (carpeta niveles)'
      : 'Selecciona un video de la carpeta (vista previa vertical)';
  const credit = document.querySelector('#videoLibModal .modal-foot .credit');
  if (credit) credit.innerHTML = `Videos de la carpeta <code>${folder}</code>.`;
  // El botón "Abrir carpeta" solo aplica a la carpeta de niveles y solo en la app .exe
  // (donde la carpeta vive en los datos del usuario, no en el proyecto).
  const openBtn = $('vidlib-openniveles');
  if (openBtn) openBtn.style.display = (niveles && window.desktopAPI && window.desktopAPI.openNivelesFolder) ? '' : 'none';
  $('videoLibModal').classList.remove('hidden');
  loadLocalVideos();
}
function closeVideoLib() {
  $('videoLibModal').classList.add('hidden');
  // Libera los videos de la biblioteca para no seguir consumiendo CPU/memoria.
  if (window._vidLibIO) { try { window._vidLibIO.disconnect(); } catch {} window._vidLibIO = null; }
  document.querySelectorAll('#vid-libgrid video').forEach((v) => {
    try { v.pause(); v.removeAttribute('src'); v.load(); } catch {}
  });
}

const isImageFile = (u) => /\.(gif|png|jpe?g|webp)(\?|$)/i.test(u || '');

async function loadLocalVideos() {
  const box = $('vid-libgrid');
  box.innerHTML = '<div class="empty">Cargando…</div>';
  // Batallas → «video/batalla»; Videos con evento "subió de nivel" → «niveles»; resto → «video».
  const endpoint = libTarget === 'ba'
    ? '/api/local-videos-batalla'
    : (libIsNiveles() ? '/api/local-videos-niveles' : '/api/local-videos');
  try {
    const res = await fetch(endpoint);
    const data = await res.json();
    localVideos = data.results || [];
    renderLocalVideos($('vid-libq').value.trim());
  } catch {
    box.innerHTML = '<div class="empty">No se pudo leer la carpeta de videos</div>';
  }
}

function renderLocalVideos(filter) {
  const box = $('vid-libgrid');
  const f = (filter || '').toLowerCase();
  const list = f ? localVideos.filter((v) => v.name.toLowerCase().includes(f)) : localVideos;
  if (!list.length) {
    const folder = libTarget === 'ba' ? 'video/batalla' : (libIsNiveles() ? 'video/niveles' : 'video');
    box.innerHTML = localVideos.length
      ? '<div class="empty">Ningún video coincide</div>'
      : `<div class="empty">No hay videos en la carpeta «${folder}».<br>Copia tus .mp4 ahí y pulsa ↻</div>`;
    return;
  }
  const niceName = (n) => n.replace(/\.[^.]+$/, '');
  // Importante: NO ponemos autoplay ni preload="auto" en todos. Si la carpeta tiene
  // muchos videos, descargar y decodificar todos a la vez traba el navegador. En su
  // lugar, cargamos solo metadata y reproducimos únicamente los que están a la vista.
  box.innerHTML = list.map((v) => {
    const media = isImageFile(v.url)
      ? `<img src="${esc(v.url)}" loading="lazy" decoding="async">`
      : `<video data-src="${esc(v.url)}" muted loop playsinline preload="none"></video>`;
    return `
    <div class="vid-cell" data-url="${esc(v.url)}" data-name="${esc(v.name)}" title="${esc(v.name)}">
      <div class="vid-prev">${media}</div>
      <div class="vid-cell-name">${esc(niceName(v.name))}</div>
    </div>`;
  }).join('');

  // Reproductor perezoso: solo se cargan/reproducen los videos visibles dentro del
  // modal; al salir de la vista se pausan para liberar memoria y CPU.
  if (window._vidLibIO) { try { window._vidLibIO.disconnect(); } catch {} }
  const io = new IntersectionObserver((entries) => {
    for (const en of entries) {
      const vid = en.target;
      if (en.isIntersecting) {
        if (!vid.src && vid.dataset.src) vid.src = vid.dataset.src;
        vid.play().catch(() => {});
      } else {
        try { vid.pause(); } catch {}
      }
    }
  }, { root: box, rootMargin: '120px', threshold: 0.1 });
  window._vidLibIO = io;
  box.querySelectorAll('video').forEach((vid) => io.observe(vid));

  box.querySelectorAll('.vid-cell').forEach((cell) => {
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
    user: (ev === 'chatCommand' || ev === 'firstMessage' || ev === 'userJoin') ? $('vid-user').value.trim().replace(/^@/, '') : '',
    joinDelay: ev === 'userJoin' ? Math.max(0, parseInt($('vid-joindelay').value, 10) || 0) : 0,
    level: 0,
    url: vidPending.url,
    fileName: vidPending.name || 'video',
    volume: +$('vid-vol').value,
    screen: +$('vid-screen').value || 1,
  };
  if (ev === 'chatCommand' && !data.command) { $('vid-status').textContent = '⚠️ Escribe el comando (ej. !video).'; return; }
  if (ev === 'userJoin' && !data.user) { $('vid-status').textContent = '⚠️ Escribe el usuario que al entrar reproduce el video.'; return; }
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
    const thumb = videoCardThumbLabel(b, '🥊');
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
  const label = $('ba-fname');
  try {
    const data = await uploadMediaWithProgress(file, (msg) => { label.textContent = msg; });
    baPending = { url: data.url, name: file.name };
    label.textContent = file.name;
  } catch (err) { label.textContent = uploadErrLabel(err); }
  e.target.value = '';
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
  superFan: '🌟 Super fan',
  follow: '➕ Nuevo seguidor',
  levelUp: '⬆️ Subió de nivel de miembro',
  userJoin: '🚪 Entró un usuario',
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
  if (trig === 'userJoin') return `🚪 Entra ${esc(a.user || 'usuario')}`;
  if (trig === 'levelUp' && a.level) return `⬆️ Nivel ${esc(a.level)}`;
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

let giftCatalogLoading = false;
async function preloadGiftCatalog(attempt = 0) {
  if (giftCatalog.length) return;
  if (giftCatalogLoading) return;
  giftCatalogLoading = true;
  try {
    const res = await fetch('/api/gifts');
    const data = await res.json();
    giftCatalog = data.results || [];
    indexGiftCatalog();
    giftCatalogLoading = false;
    // Una vez cargado el catálogo, volvemos a dibujar TODAS las secciones que muestran
    // iconos de regalo, por si sus fichas se dibujaron antes (entonces salía el emoji).
    if (giftCatalog.length) refreshGiftCards();
  } catch {
    giftCatalogLoading = false;
    // Reintenta: la primera carga puede fallar si el servidor está "despertando" o la
    // red parpadea. Así las fichas SIEMPRE terminan mostrando el regalo configurado.
    if (attempt < 6) setTimeout(() => preloadGiftCatalog(attempt + 1), 2000);
  }
}

// Re-dibuja las secciones con iconos de regalo (cuando ya hay catálogo y ajustes).
function refreshGiftCards() {
  if (!settings) return;
  if (typeof renderSoundAlerts === 'function') { try { renderSoundAlerts(); } catch {} }
  if (typeof renderVideos === 'function') { try { renderVideos(); } catch {} }
  if (typeof renderBattleAlerts === 'function') { try { renderBattleAlerts(); } catch {} }
  if (typeof renderAcciones === 'function') { try { renderAcciones(); } catch {} }
  if (typeof pushGiftShowcasePreview === 'function') { try { pushGiftShowcasePreview(settings?.giftShowcase); } catch {} }
}

const EVENT_EMOJI = {
  like: '❤️', likeGlobal: '❤️', follow: '➕', share: '🔁',
  subscribe: '⭐', superFan: '🌟', levelUp: '⬆️', emote: '😀', gift: '🎁',
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
  const cached = emoteCatalog.slice();
  try {
    // En modo relay la conexión TikTok vive en Render: pedir catálogo a la nube.
    const apiUrl = (relayActive() || desktopRelayOn()) ? '/api/desktop/emotes' : '/api/emotes';
    const res = await fetch(apiUrl);
    const data = await res.json();
    const fresh = data.results || [];
    emoteCatalog = fresh.length ? fresh : cached;
  } catch {
    emoteCatalog = cached;
  }
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

// Contenido del botón "Elegir regalo": muestra el icono real del regalo (no el emoji)
// cuando hay uno seleccionado. Se usa en alertas, videos y acciones.
function giftBtnHTML(name, id, fallback = '🎁 Elegir regalo…') {
  if (!name && !id) return fallback;
  const g = id ? giftCatalogById.get(String(id))
    : giftCatalog.find((x) => x.name.toLowerCase() === String(name).toLowerCase());
  const label = name || g?.name || '';
  const icon = g?.image ? `<img class="gift-pick-ic" src="${esc(g.image)}" onerror="this.outerHTML='🎁'">` : '🎁';
  return `${icon} ${esc(label)}`;
}

function updateGiftPickBtn() {
  $('sa-giftpick').innerHTML = giftBtnHTML($('sa-gift').value, $('sa-giftid').value);
}

function updateGiftPickBtnV() {
  $('vid-giftpick').innerHTML = giftBtnHTML($('vid-gift').value, $('vid-giftid').value);
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
          name: g?.name || cell.dataset.name || '',
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
    label.textContent = uploadErrLabel(err);
  }
}

/* Biblioteca de sonidos: lee la carpeta local /audios */
let libAudio = null;
let localSounds = [];
// A dónde va el sonido elegido: 'alert', 'action' o 'mc' (tarjeta Minecraft).
let soundPickTarget = 'alert';
let mcSoundPickUid = null;
let mcAudioUploadUid = null;

function openSoundLib() {
  $('soundLibModal').classList.remove('hidden');
  loadLocalSounds();
}
function closeSoundLib() {
  $('soundLibModal').classList.add('hidden');
  try { libAudio?.pause(); } catch {}
}
$('sa-libbtn').onclick = () => { soundPickTarget = 'alert'; openSoundLib(); };
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
    if (soundPickTarget === 'action') {
      accPendingSound = { url: b.dataset.url, name: b.dataset.name };
      const el = $('acc-soundname'); if (el) el.textContent = b.dataset.name;
      const vr = $('acc-volrow'); if (vr) vr.hidden = false;
    } else if (soundPickTarget === 'mc' && mcSoundPickUid) {
      const a = (settings.mcActions || []).find((x) => x.uid === mcSoundPickUid);
      if (a) {
        a.sound = b.dataset.url;
        a.soundName = b.dataset.name;
        if (!a.audioOn) a.audioOn = true;
        flushSaveSettings();
        renderMyMcActions();
      }
    } else {
      pendingSound = { url: b.dataset.url, name: b.dataset.name };
      $('sa-soundname').textContent = b.dataset.name;
    }
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

$('sa-panic').onclick = () => triggerAlertPanic();

/* ====================== Overlays ====================== */
document.querySelectorAll('.subtab').forEach((btn) => {
  btn.onclick = () => {
    const host = btn.closest('.view');
    if (!host) return;
    host.querySelectorAll('.subtab').forEach((b) => b.classList.remove('active'));
    host.querySelectorAll('.subview').forEach((v) => v.classList.remove('active'));
    btn.classList.add('active');
    const targetId = btn.dataset.subView || ('sub-' + btn.dataset.sub);
    const target = host.querySelector('#' + targetId);
    if (target) target.classList.add('active');
  };
});

document.querySelectorAll('.overlay-item').forEach((item) => {
  const code = item.querySelector('.ov-url');
  code.textContent = roomUrl(code.dataset.path);
  const link = item.querySelector('a');
  if (link && !link.href) link.href = roomUrl(code.dataset.path);
  item.querySelector('.ov-copy').onclick = (e) => {
    if (isOverlayUrlLocked(code)) { toast('Disponible solo en Premium ⭐', 'warn'); return; }
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
  perrito: { previewId: 'perr-preview', testAction: 'testPerrito', resetAction: 'resetPerrito',
             btnTest: 'perr-test', btnReset: 'perr-reset', btnConfig: 'perr-config', copyBtnIdx: 0 },
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
      if (isOverlayUrlLocked(code)) { toast('Disponible solo en Premium ⭐', 'warn'); return; }
      navigator.clipboard?.writeText(roomUrl(code.dataset.path));
      const t = e.target; t.textContent = '¡Copiado!';
      setTimeout(() => (t.textContent = 'Copiar enlace'), 1200);
    };
  });

  for (const [key, cfg] of Object.entries(POT_OVERLAYS)) {
    const test = $(cfg.btnTest), reset = $(cfg.btnReset), config = $(cfg.btnConfig);
    if (!test) continue;
    const toPreview = (msg) => $(cfg.previewId)?.contentWindow?.postMessage({ kind: key, ...msg }, '*');
    test.onclick = () => {
      toPreview({ type: 'test', count: 200 });
      if (key === 'jarron') toPreview({ type: 'topDemo' });
      send({ action: cfg.testAction, count: 200 });
    };
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
    perrito: '🐶 Configurar — Perrito (bote regalos)',
    vaquita: '🐮 Configurar — Vaquita (bote regalos)',
    marranito: '🐷 Configurar — Marranito (bote regalos)',
    jarron: '⚙️ Configurar — Jarrón (bote regalos)',
  };
  $('jarcfg-title').textContent = titles[target] || titles.jarron;
  const topWrap = $('jarcfg-topbar-wrap');
  if (topWrap) topWrap.style.display = target === 'jarron' ? '' : 'none';
  if (target === 'jarron') {
    $('jarcfg-topbar-on').checked = data.topBarEnabled !== false;
    $('jarcfg-topbar-limit').value = Math.max(1, Math.min(10, Number(data.topBarLimit) || 3));
  }
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
  if (cfgTarget === 'jarron') {
    settings.jarron.topBarEnabled = $('jarcfg-topbar-on').checked;
    settings.jarron.topBarLimit = Math.max(1, Math.min(10, parseInt($('jarcfg-topbar-limit').value, 10) || 3));
  }
  saveSettings();
  closeJarConfig();
};

function pushJarTopBarPreview() {
  if (cfgTarget !== 'jarron') return;
  cfgToPreview({
    type: 'config',
    topBarEnabled: $('jarcfg-topbar-on').checked,
    topBarLimit: Math.max(1, Math.min(10, parseInt($('jarcfg-topbar-limit').value, 10) || 3)),
  });
}
const jarcfgTopOn = $('jarcfg-topbar-on');
const jarcfgTopLim = $('jarcfg-topbar-limit');
if (jarcfgTopOn) jarcfgTopOn.onchange = pushJarTopBarPreview;
if (jarcfgTopLim) jarcfgTopLim.oninput = pushJarTopBarPreview;

// Refleja el color guardado en el selector del modal (si está abierto)
function applyJarronUI() {
  const t = $('jarcfg-tint');
  const data = settings?.[cfgTarget];
  if (t && data?.tint && /^#/.test(data.tint)) t.value = data.tint;
}

/* ---- Pelotas de fans: tarjeta + modal de configuración ---- */
(function setupPelotas() {
  if (!$('pel-test')) return;
  const toPreview = (msg) => $('pel-preview')?.contentWindow?.postMessage({ kind: 'pelotas', ...msg }, '*');

  function currentCfg() {
    return {
      tint: $('pelcfg-tint').dataset.cleared === '1' ? '' : $('pelcfg-tint').value,
      ballSize: Math.max(20, Math.min(160, parseInt($('pelcfg-size').value, 10) || 64)),
      coinsEnabled: $('pelcfg-coins-on').checked,
      coinsEvery: Math.max(1, parseInt($('pelcfg-coins-every').value, 10) || 100),
      likesEnabled: $('pelcfg-likes-on').checked,
      likesEvery: Math.max(1, parseInt($('pelcfg-likes-every').value, 10) || 100),
    };
  }
  function pushPreview() { const c = currentCfg(); toPreview({ type: 'config', tint: c.tint, ballSize: c.ballSize }); }
  function openPelConfig() {
    if (!settings.pelotas) settings.pelotas = {};
    const c = settings.pelotas;
    const tint = c.tint || '';
    $('pelcfg-tint').value = /^#/.test(tint) ? tint : '#7cc8ff';
    $('pelcfg-tint').dataset.cleared = tint ? '' : '1';
    $('pelcfg-size').value = c.ballSize || 64;
    $('pelcfg-coins-on').checked = c.coinsEnabled !== false;
    $('pelcfg-coins-every').value = c.coinsEvery || 100;
    $('pelcfg-likes-on').checked = !!c.likesEnabled;
    $('pelcfg-likes-every').value = c.likesEvery || 100;
    $('pelConfigModal').classList.remove('hidden');
  }
  function closePelConfig() { $('pelConfigModal').classList.add('hidden'); }

  $('pel-test').onclick = () => { toPreview({ type: 'test', count: 16 }); send({ action: 'testPelotas', count: 16 }); };
  $('pel-reset').onclick = () => { toPreview({ type: 'reset' }); send({ action: 'resetPelotas' }); };
  $('pel-config').onclick = openPelConfig;
  $('pelcfg-close').onclick = closePelConfig;
  $('pelConfigModal').addEventListener('click', (e) => { if (e.target.id === 'pelConfigModal') closePelConfig(); });
  $('pelcfg-tintclear').onclick = () => { $('pelcfg-tint').value = '#7cc8ff'; $('pelcfg-tint').dataset.cleared = '1'; toPreview({ type: 'config', tint: '' }); };
  $('pelcfg-tint').oninput = () => { $('pelcfg-tint').dataset.cleared = ''; pushPreview(); };
  $('pelcfg-size').oninput = pushPreview;
  $('pelcfg-save').onclick = () => { settings.pelotas = currentCfg(); saveSettings(); closePelConfig(); };
})();

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

/* ---- Medidor de Flow ---- */
function flwPreviewWin() { return $('flw-preview')?.contentWindow; }
function flwToPreview(msg) { flwPreviewWin()?.postMessage({ kind: 'flowmeter', ...msg }, '*'); }

const FLW_COLORS = ['#ff4b91', '#40e0d0', '#9370db', '#fbbf24', '#f97316'];
let flwPartsDraft = [];

function defaultFlowMeterCfg() {
  return {
    title: 'MEDIDOR DE FLOW', textColor: '#f4f8ff', fontSize: 13, barHeight: 28, scale: 78, maxParticipants: 5,
    font: 'inter', showPercent: true, roundByTime: false, timerWins: false, roundSec: 60, participants: [], wins: [],
  };
}

function emptyFlwParticipant(i) {
  return { name: 'test' + (i + 1), tiktokUrl: '', avatar: '', color: FLW_COLORS[i % FLW_COLORS.length] || '#5eead4', giftId: '', giftName: '', giftImage: '' };
}

function exampleFlwParticipants() {
  const gifts = ['Rose', 'GG', 'Heart Me', 'TikTok', 'Finger Heart'];
  return [1, 2, 3].map((n, i) => ({
    name: 'test' + n,
    tiktokUrl: '',
    avatar: '',
    color: FLW_COLORS[i % FLW_COLORS.length],
    giftId: '',
    giftName: gifts[i] || 'Rose',
    giftImage: '',
  }));
}

function currentFlowMeterCfg() {
  return {
    title: ($('flwcfg-title')?.value || 'MEDIDOR DE FLOW').trim(),
    textColor: $('flwcfg-textcolor')?.value || '#f4f8ff',
    fontSize: Math.max(10, parseInt($('flwcfg-fontsize')?.value, 10) || 13),
    barHeight: Math.max(16, parseInt($('flwcfg-barheight')?.value, 10) || 28),
    scale: Math.max(50, Math.min(100, parseInt($('flwcfg-scale')?.value, 10) || 78)),
    maxParticipants: Math.max(1, Math.min(5, parseInt($('flwcfg-max')?.value, 10) || 5)),
    font: $('flwcfg-font')?.value || 'inter',
    showPercent: !!$('flwcfg-showpct')?.checked,
    roundByTime: !!$('flwcfg-timerwins')?.checked,
    timerWins: !!$('flwcfg-timerwins')?.checked,
    roundSec: Math.max(5, parseInt($('flwcfg-roundsec')?.value, 10) || 60),
    participants: flwPartsDraft.map((p) => ({ ...p })),
    wins: (settings?.flowMeter?.wins || []).slice(),
  };
}

function pushFlowMeterPreview(cfg) {
  flwToPreview({ type: 'config', config: flowMeterCfgForPreview(cfg) });
}

function flowMeterCfgForPreview(cfg) {
  const c = { ...(cfg || settings?.flowMeter || defaultFlowMeterCfg()) };
  if (!Array.isArray(c.participants) || !c.participants.length) {
    c.participants = exampleFlwParticipants();
  }
  return c;
}

async function resolveFlwTiktokProfile(url) {
  const u = String(url || '').trim();
  if (!u) return null;
  try {
    const r = await fetch('/api/tiktok-profile?' + new URLSearchParams({ url: u }));
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return { error: data.error || 'No se pudo obtener el perfil' };
    return data;
  } catch {
    return { error: 'Error de conexión al buscar el perfil' };
  }
}

function flwGiftBtn(i, p) {
  if (p.giftId) {
    return `<button type="button" class="gvs-giftbtn picked flw-giftpick" data-i="${i}">${p.giftImage ? `<img src="${esc(p.giftImage)}">` : ''}<span>${esc(p.giftName || ('#' + p.giftId))}</span></button>`;
  }
  return `<button type="button" class="gvs-giftbtn flw-giftpick" data-i="${i}">＋ Elegir regalo</button>`;
}

async function uploadFlwAvatar(i, file) {
  if (!file) return;
  const card = document.querySelector(`.flw-part-card[data-i="${i}"]`);
  const btn = card?.querySelector('.flw-av-upload');
  if (btn) { btn.disabled = true; btn.textContent = 'Subiendo…'; }
  try {
    const res = await fetch('/api/upload?name=' + encodeURIComponent(file.name), { method: 'POST', body: file });
    const data = await res.json();
    if (!data.url) throw new Error(data.error || 'error');
    flwPartsDraft[i].avatar = data.url;
    flwPartsDraft[i].avatarLocal = true;
    renderFlwParticipants();
    pushFlowMeterPreview(currentFlowMeterCfg());
  } catch (err) {
    if (btn) { btn.disabled = false; btn.textContent = 'Subir foto'; }
    toast && toast(uploadErrLabel(err) || 'No se pudo subir la imagen', 'warn');
  }
}

function renderFlwParticipants() {
  const wrap = $('flwcfg-rows');
  if (!wrap) return;
  const max = Math.max(1, Math.min(5, parseInt($('flwcfg-max')?.value, 10) || 5));
  while (flwPartsDraft.length > max) flwPartsDraft.pop();
  wrap.innerHTML = flwPartsDraft.map((p, i) => `
    <div class="flw-part-card" data-i="${i}" style="--flw-part-color:${esc(p.color || FLW_COLORS[i % FLW_COLORS.length])}">
      <button type="button" class="jarcfg-del flw-del" title="Quitar">✕</button>
      <div class="flw-part-card-head">PARTICIPANTE ${i + 1}</div>
      <div class="flw-part-top">
        <div class="flw-part-avcol">
          ${p.avatar ? `<img class="flw-part-av" src="${esc(p.avatar)}" alt="" referrerpolicy="no-referrer">` : '<div class="flw-part-av-ph">👤</div>'}
          <input type="file" class="flw-av-file" accept="image/*" hidden>
          <button type="button" class="btn ghost sm flw-av-upload">Subir foto</button>
        </div>
        <div class="flw-part-fields">
          <div>
            <label class="ml">Nombre</label>
            <input type="text" class="flw-name" value="${esc(p.name || '')}" placeholder="Nombre">
          </div>
          <div>
            <label class="ml">Perfil TikTok (URL)</label>
            <input type="text" class="flw-tiktok" value="${esc(p.tiktokUrl || '')}" placeholder="https://www.tiktok.com/@usuario">
          </div>
          <div>
            <label class="ml">Color</label>
            <input type="color" class="flw-color" value="${esc(p.color || FLW_COLORS[i % FLW_COLORS.length])}">
          </div>
        </div>
      </div>
      <div class="flw-part-gift">
        ${flwGiftBtn(i, p)}
        <div class="flw-part-gift-meta"><small>Gift asignado</small><strong>${esc(p.giftName || 'Sin regalo')}</strong></div>
      </div>
    </div>`).join('');

  wrap.querySelectorAll('.flw-part-card').forEach((card) => {
    const i = Number(card.dataset.i);
    card.querySelector('.flw-del').onclick = () => {
      flwPartsDraft.splice(i, 1);
      if (!flwPartsDraft.length) flwPartsDraft.push(emptyFlwParticipant(0));
      renderFlwParticipants();
    };
    card.querySelector('.flw-name').oninput = (e) => { flwPartsDraft[i].name = e.target.value; pushFlowMeterPreview(currentFlowMeterCfg()); };
    card.querySelector('.flw-color').oninput = (e) => {
      flwPartsDraft[i].color = e.target.value;
      card.style.setProperty('--flw-part-color', e.target.value);
      pushFlowMeterPreview(currentFlowMeterCfg());
    };
    const tikInp = card.querySelector('.flw-tiktok');
    const onTiktok = async () => {
      flwPartsDraft[i].tiktokUrl = tikInp.value.trim();
      if (!flwPartsDraft[i].tiktokUrl) {
        if (!flwPartsDraft[i].avatarLocal) flwPartsDraft[i].avatar = '';
        renderFlwParticipants();
        pushFlowMeterPreview(currentFlowMeterCfg());
        return;
      }
      tikInp.style.opacity = '0.55';
      const prof = await resolveFlwTiktokProfile(flwPartsDraft[i].tiktokUrl);
      tikInp.style.opacity = '';
      if (prof?.error) {
        tikInp.title = prof.error;
        return;
      }
      if (prof) {
        flwPartsDraft[i].tiktokUrl = prof.profileUrl || flwPartsDraft[i].tiktokUrl;
        if (!flwPartsDraft[i].avatarLocal) {
          flwPartsDraft[i].avatar = prof.avatar || '';
          if (!prof.avatar) tikInp.title = 'Perfil encontrado pero sin foto';
          else tikInp.title = '';
        }
      }
      renderFlwParticipants();
      pushFlowMeterPreview(currentFlowMeterCfg());
    };
    tikInp.onchange = onTiktok;
    tikInp.onblur = onTiktok;
    const avFile = card.querySelector('.flw-av-file');
    const avBtn = card.querySelector('.flw-av-upload');
    if (avBtn && avFile) {
      avBtn.onclick = () => avFile.click();
      avFile.onchange = (e) => {
        const file = e.target.files && e.target.files[0];
        e.target.value = '';
        if (file) uploadFlwAvatar(i, file);
      };
    }
    card.querySelector('.flw-giftpick').onclick = () => {
      openGiftModalCb((g) => {
        flwPartsDraft[i].giftId = g.id;
        flwPartsDraft[i].giftName = g.name;
        flwPartsDraft[i].giftImage = g.image;
        renderFlwParticipants();
        pushFlowMeterPreview(currentFlowMeterCfg());
      });
    };
  });
  pushFlowMeterPreview(currentFlowMeterCfg());
}

function openFlwConfig() {
  const c = settings?.flowMeter || defaultFlowMeterCfg();
  $('flwcfg-title').value = c.title || 'MEDIDOR DE FLOW';
  $('flwcfg-textcolor').value = c.textColor || '#f4f8ff';
  $('flwcfg-fontsize').value = c.fontSize || 13;
  $('flwcfg-barheight').value = c.barHeight || 28;
  $('flwcfg-scale').value = c.scale || 78;
  $('flwcfg-max').value = c.maxParticipants || 5;
  $('flwcfg-font').value = c.font || 'inter';
  $('flwcfg-showpct').checked = c.showPercent !== false;
  $('flwcfg-timerwins').checked = !!(c.roundByTime || c.timerWins);
  $('flwcfg-roundsec').value = c.roundSec || 60;
  const timedFields = $('flwcfg-timed-fields');
  if (timedFields) timedFields.style.opacity = $('flwcfg-timerwins').checked ? '1' : '.45';
  flwPartsDraft = (c.participants || []).map((p, i) => ({
    name: p.name || '', tiktokUrl: p.tiktokUrl || '', avatar: p.avatar || '',
    avatarLocal: !!p.avatarLocal || (p.avatar && String(p.avatar).startsWith('/uploads/')),
    color: p.color || FLW_COLORS[i % FLW_COLORS.length],
    giftId: p.giftId || '', giftName: p.giftName || '', giftImage: p.giftImage || '',
  }));
  if (!flwPartsDraft.length) flwPartsDraft = exampleFlwParticipants();
  renderFlwParticipants();
  $('flwConfigModal').classList.remove('hidden');
}
function closeFlwConfig() { $('flwConfigModal')?.classList.add('hidden'); }

function flwRoundAction(action) {
  flwToPreview({ type: 'action', action });
  send({ action: 'flowMeterControl', flwAction: action });
}

if ($('flw-test')) {
  $('flw-test').onclick = () => {
    pushFlowMeterPreview();
    setTimeout(() => {
      flwToPreview({ type: 'test' });
      send({ action: 'testFlowMeter' });
    }, 80);
  };
  if ($('flw-start')) $('flw-start').onclick = () => flwRoundAction('start');
  if ($('flw-stop')) $('flw-stop').onclick = () => flwRoundAction('stop');
  if ($('flw-restart')) $('flw-restart').onclick = () => flwRoundAction('restart');
  $('flw-reset').onclick = () => { flwToPreview({ type: 'reset' }); send({ action: 'resetFlowMeter' }); };
  $('flw-config').onclick = openFlwConfig;
}
if ($('flwcfg-add')) {
  $('flwcfg-add').onclick = () => {
    const max = Math.max(1, Math.min(5, parseInt($('flwcfg-max')?.value, 10) || 5));
    if (flwPartsDraft.length >= max) return;
    flwPartsDraft.push(emptyFlwParticipant(flwPartsDraft.length));
    renderFlwParticipants();
  };
}
if ($('flwcfg-example')) {
  $('flwcfg-example').onclick = () => {
    flwPartsDraft = exampleFlwParticipants();
    renderFlwParticipants();
  };
}
['flwcfg-title', 'flwcfg-textcolor', 'flwcfg-fontsize', 'flwcfg-barheight', 'flwcfg-scale', 'flwcfg-max', 'flwcfg-font', 'flwcfg-showpct', 'flwcfg-timerwins', 'flwcfg-roundsec'].forEach((id) => {
  const el = $(id);
  if (el) {
    el.oninput = () => {
      if (id === 'flwcfg-max') renderFlwParticipants();
      else if (id === 'flwcfg-timerwins') {
        const tf = $('flwcfg-timed-fields');
        if (tf) tf.style.opacity = el.checked ? '1' : '.45';
        pushFlowMeterPreview(currentFlowMeterCfg());
      } else pushFlowMeterPreview(currentFlowMeterCfg());
    };
    el.onchange = () => {
      if (id === 'flwcfg-max') renderFlwParticipants();
      else if (id === 'flwcfg-timerwins') {
        const tf = $('flwcfg-timed-fields');
        if (tf) tf.style.opacity = el.checked ? '1' : '.45';
        pushFlowMeterPreview(currentFlowMeterCfg());
      } else pushFlowMeterPreview(currentFlowMeterCfg());
    };
  }
});
if ($('flwcfg-close')) $('flwcfg-close').onclick = closeFlwConfig;
if ($('flwConfigModal')) $('flwConfigModal').addEventListener('click', (e) => { if (e.target.id === 'flwConfigModal') closeFlwConfig(); });
if ($('flwcfg-save')) {
  $('flwcfg-save').onclick = async () => {
    const cfg = currentFlowMeterCfg();
    for (let i = 0; i < cfg.participants.length; i++) {
      const p = cfg.participants[i];
      if (p.tiktokUrl && !p.avatar && !p.avatarLocal) {
        const prof = await resolveFlwTiktokProfile(p.tiktokUrl);
        if (prof) {
          p.tiktokUrl = prof.profileUrl || p.tiktokUrl;
          p.avatar = prof.avatar || '';
        }
      }
    }
    settings.flowMeter = cfg;
    saveSettings();
    pushFlowMeterPreview(settings.flowMeter);
    closeFlwConfig();
  };
}

/* ---- Gift Sequence (secuencia de regalos) ---- */
function gsqPreviewWin() { return $('gsq-preview')?.contentWindow; }
function gsqToPreview(msg) { gsqPreviewWin()?.postMessage({ kind: 'giftseq', ...msg }, '*'); }

let gsqSeqDraft = [];

function defaultGiftSeqCfg() {
  return { text: '#f4f7ff', accent: '#8df7d8', size: 28, font: 'system', anim: 'gift-pop', rowSpeed: 7.6, textRainbow: false, stepSec: 2, sequence: [] };
}

function currentGsqCfg() {
  return {
    text: $('gsqcfg-text').value || '#f4f7ff',
    accent: '#8df7d8',
    size: Math.max(10, Math.min(80, parseInt($('gsqcfg-size').value, 10) || 28)),
    font: $('gsqcfg-font').value || 'system',
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
  $('gsqcfg-font').value = CFG_FONTS.some(([v]) => v === c.font) ? c.font : 'system';
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

['gsqcfg-step', 'gsqcfg-anim', 'gsqcfg-size', 'gsqcfg-rowspeed', 'gsqcfg-text', 'gsqcfg-font', 'gsqcfg-rainbow'].forEach((id) => {
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

/* ---- Banda de regalos (fila horizontal) ---- */
function gshPreviewWin() { return $('gsh-preview')?.contentWindow; }
function gshToPreview(msg) { gshPreviewWin()?.postMessage({ kind: 'giftshowcase', ...msg }, '*'); }

let gshItemsDraft = [];

function defaultGiftShowcaseCfg() {
  return {
    displayMode: 'rotate', visibleCount: 3, intervalSec: 2, marqueeSec: 18,
    iconSize: 88, gap: 24, font: 'bangers', fontSize: 22, textColor: '#ffffff', textStroke: 2,
    colorMode: 'solid', scale: 100, items: [],
  };
}

function currentGshCfg() {
  return {
    displayMode: $('gshcfg-mode')?.value || 'rotate',
    visibleCount: Math.max(1, Math.min(8, parseInt($('gshcfg-visible')?.value, 10) || 3)),
    intervalSec: Math.max(1, Math.min(15, parseInt($('gshcfg-interval')?.value, 10) || 2)),
    marqueeSec: Math.max(6, Math.min(120, parseInt($('gshcfg-marquee')?.value, 10) || 18)),
    iconSize: Math.max(48, Math.min(160, parseInt($('gshcfg-iconsize')?.value, 10) || 88)),
    gap: Math.max(8, Math.min(64, parseInt($('gshcfg-gap')?.value, 10) || 24)),
    fontSize: Math.max(10, Math.min(48, parseInt($('gshcfg-fontsize')?.value, 10) || 22)),
    textStroke: Math.max(0, Math.min(6, parseInt($('gshcfg-stroke')?.value, 10) || 2)),
    textColor: $('gshcfg-color')?.value || '#ffffff',
    colorMode: $('gshcfg-colormode')?.value || 'solid',
    font: $('gshcfg-font')?.value || 'bangers',
    scale: Math.max(60, Math.min(140, parseInt($('gshcfg-scale')?.value, 10) || 100)),
    items: gshItemsDraft.map((r) => ({ ...r })),
  };
}

function enrichGshItems(items) {
  return (items || []).map((r) => {
    const img = (r.giftImage && String(r.giftImage).trim())
      || giftImageOf({ giftId: r.giftId, giftName: r.giftName, image: r.giftImage });
    return { ...r, giftImage: img || '' };
  });
}

function pushGiftShowcasePreview(cfg) {
  const base = cfg || settings?.giftShowcase || defaultGiftShowcaseCfg();
  const send = () => {
    gshToPreview({
      type: 'config',
      config: {
        ...base,
        _preview: true,
        items: enrichGshItems(base.items),
      },
    });
  };
  send();
  preloadGiftCatalog().then(send);
}

function emptyGshItem() { return { giftId: '', giftName: '', giftImage: '', customText: '' }; }

function refreshGshNotice() {
  const vis = Math.max(1, Math.min(8, parseInt($('gshcfg-visible')?.value, 10) || 3));
  if ($('gshcfg-notice-vis')) $('gshcfg-notice-vis').textContent = String(vis);
  if ($('gshcfg-notice-min')) $('gshcfg-notice-min').textContent = String(vis + 1);
}

function openGshConfig() {
  const c = settings?.giftShowcase || defaultGiftShowcaseCfg();
  if ($('gshcfg-mode')) $('gshcfg-mode').value = c.displayMode || 'rotate';
  if ($('gshcfg-visible')) $('gshcfg-visible').value = c.visibleCount || 3;
  if ($('gshcfg-interval')) $('gshcfg-interval').value = c.intervalSec || 2;
  if ($('gshcfg-marquee')) $('gshcfg-marquee').value = c.marqueeSec || 18;
  if ($('gshcfg-iconsize')) $('gshcfg-iconsize').value = c.iconSize || 88;
  if ($('gshcfg-gap')) $('gshcfg-gap').value = c.gap || 24;
  if ($('gshcfg-fontsize')) $('gshcfg-fontsize').value = c.fontSize || 22;
  if ($('gshcfg-stroke')) $('gshcfg-stroke').value = c.textStroke != null ? c.textStroke : 2;
  if ($('gshcfg-color')) $('gshcfg-color').value = /^#/.test(c.textColor || '') ? c.textColor : '#ffffff';
  if ($('gshcfg-colormode')) $('gshcfg-colormode').value = c.colorMode || 'solid';
  if ($('gshcfg-font')) $('gshcfg-font').value = CFG_FONTS.some(([v]) => v === c.font) ? c.font : 'bangers';
  if ($('gshcfg-scale')) $('gshcfg-scale').value = c.scale || 100;
  gshItemsDraft = enrichGshItems(c.items || []).map((r) => ({
    giftId: r.giftId || '', giftName: r.giftName || '', giftImage: r.giftImage || '', customText: r.customText || '',
  }));
  if (!gshItemsDraft.length) gshItemsDraft.push(emptyGshItem());
  renderGshRows();
  refreshGshNotice();
  $('gshConfigModal')?.classList.remove('hidden');
}
function closeGshConfig() { $('gshConfigModal')?.classList.add('hidden'); }

function renderGshRows() {
  const wrap = $('gshcfg-rows');
  if (!wrap) return;
  wrap.innerHTML = gshItemsDraft.map((r, i) => {
    const giftBtn = r.giftName
      ? `<button type="button" class="gvs-giftbtn picked gsh-giftpick" data-i="${i}">${r.giftImage ? `<img src="${esc(r.giftImage)}">` : ''}<span>${esc(r.giftName)}</span></button>`
      : `<button type="button" class="gvs-giftbtn gsh-giftpick" data-i="${i}">＋ Elegir regalo</button>`;
    return `<div class="jarcfg-row gsh-row" data-i="${i}">
      <button type="button" class="jarcfg-del gsh-del" title="Quitar">✕</button>
      <div class="jarcfg-row-head">REGALO ${i + 1}</div>
      <div class="gsq-row-grid">
        <div>${giftBtn}</div>
        <div><label class="ml">TEXTO DEBAJO</label><input type="text" class="gsh-text" maxlength="80" placeholder="Ej.: PINCHE PELON" value="${esc(r.customText)}"></div>
      </div>
    </div>`;
  }).join('');

  wrap.querySelectorAll('.gsh-row').forEach((row) => {
    const i = Number(row.dataset.i);
    row.querySelector('.gsh-del')?.addEventListener('click', () => {
      gshItemsDraft.splice(i, 1);
      if (!gshItemsDraft.length) gshItemsDraft.push(emptyGshItem());
      renderGshRows();
    });
    row.querySelector('.gsh-text')?.addEventListener('input', (e) => {
      gshItemsDraft[i].customText = e.target.value;
      pushGiftShowcasePreview(currentGshCfg());
    });
    row.querySelectorAll('.gsh-giftpick').forEach((btn) => {
      btn.addEventListener('click', () => {
        openGiftModalCb((g) => {
          gshItemsDraft[i].giftId = String(g.id || '');
          gshItemsDraft[i].giftName = g.name || '';
          gshItemsDraft[i].giftImage = g.image || '';
          if (!gshItemsDraft[i].customText) gshItemsDraft[i].customText = g.name || '';
          renderGshRows();
          pushGiftShowcasePreview(currentGshCfg());
        });
      });
    });
  });
  pushGiftShowcasePreview(currentGshCfg());
}

['gshcfg-mode', 'gshcfg-visible', 'gshcfg-interval', 'gshcfg-marquee', 'gshcfg-iconsize', 'gshcfg-gap',
  'gshcfg-fontsize', 'gshcfg-stroke', 'gshcfg-color', 'gshcfg-colormode', 'gshcfg-font', 'gshcfg-scale'].forEach((id) => {
  const el = $(id);
  if (el) {
    el.oninput = () => {
      if (id === 'gshcfg-visible') refreshGshNotice();
      pushGiftShowcasePreview(currentGshCfg());
    };
    el.onchange = () => {
      if (id === 'gshcfg-visible') refreshGshNotice();
      pushGiftShowcasePreview(currentGshCfg());
    };
  }
});
if ($('gshcfg-add')) $('gshcfg-add').onclick = () => { gshItemsDraft.push(emptyGshItem()); renderGshRows(); };
if ($('gshcfg-close')) $('gshcfg-close').onclick = closeGshConfig;
if ($('gshConfigModal')) $('gshConfigModal').addEventListener('click', (e) => { if (e.target.id === 'gshConfigModal') closeGshConfig(); });
if ($('gshcfg-save')) $('gshcfg-save').onclick = () => {
  const cfg = currentGshCfg();
  cfg.items = enrichGshItems(cfg.items);
  settings.giftShowcase = cfg;
  saveSettings();
  pushGiftShowcasePreview(settings.giftShowcase);
  closeGshConfig();
};
if ($('gsh-test')) {
  $('gsh-test').onclick = () => {
    pushGiftShowcasePreview(settings?.giftShowcase);
    requestAnimationFrame(() => gshToPreview({ type: 'test' }));
  };
  $('gsh-reset').onclick = () => { gshToPreview({ type: 'reset' }); pushGiftShowcasePreview(settings?.giftShowcase); };
  $('gsh-config').onclick = openGshConfig;
}
if ($('gsh-preview')) {
  $('gsh-preview').addEventListener('load', () => pushGiftShowcasePreview(settings?.giftShowcase));
}

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
  ['pressstart', 'Press Start 2P ⛏'], ['exo2', 'Exo 2'], ['luckiest', 'Luckiest Guy ⭐'], ['bangers', 'Bangers ⭐'], ['lilita', 'Lilita One ⭐'],
  ['titan', 'Titan One ⭐'], ['fredoka', 'Fredoka ⭐'], ['bungee', 'Bungee ⭐'],
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

  const bumpPreviewFrame = () => new Promise((resolve) => {
    const fr = $(o.previewId);
    if (!fr || !o.ovBuild) { resolve(); return; }
    const u = new URL(fr.src, location.origin);
    u.searchParams.set('v', o.ovBuild);
    u.searchParams.set('_', String(Date.now()));
    const done = () => {
      fr.removeEventListener('load', done);
      pushPreview();
      setTimeout(resolve, 120);
    };
    fr.addEventListener('load', done);
    fr.src = u.pathname + u.search;
  });

  if ($(o.btnTest)) $(o.btnTest).onclick = async () => {
    const extra = o.randomGift ? { gift: randomGiftSample() } : {};
    if (o.rank) extra.rank = o.rank;
    if (o.bumpPreview) await bumpPreviewFrame();
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
  if ($(o.saveId)) $(o.saveId).onclick = () => {
    const cfg = { ...(settings[o.settingsKey] || {}), ...buildCfg() };
    settings[o.settingsKey] = cfg;
    if (o.onSave) o.onSave(cfg);
    saveSettings();
    pushPreview(settings[o.settingsKey]);
    close();
  };
  o._push = () => pushPreview();
  return o;
}

const STYLE_OVERLAYS = [
  setupStyleOverlay({
    kind: 'livetimer', settingsKey: 'liveTimer', previewId: 'tlv-preview',
    btnTest: 'tlv-test', btnReset: 'tlv-reset', btnConfig: 'tlv-config',
    modalId: 'tlvConfigModal', closeId: 'tlvcfg-close', saveId: 'tlvcfg-save',
    testAction: 'testLiveTimer', resetAction: 'resetLiveTimer',
    map: { 'tlvcfg-title': 'title', 'tlvcfg-onliveend': 'onLiveEnd', 'tlvcfg-neon': 'neon', 'tlvcfg-accent': 'accent',
      'tlvcfg-livecolor': 'liveColor', 'tlvcfg-textcolor': 'textColor', 'tlvcfg-font': 'font', 'tlvcfg-colormode': 'colorMode',
      'tlvcfg-titlesize': 'titleSize', 'tlvcfg-timesize': 'timeSize', 'tlvcfg-dotsize': 'dotSize',
      'tlvcfg-letterspace': 'letterSpacing', 'tlvcfg-scale': 'scale', 'tlvcfg-bgop': 'bgOpacity',
      'tlvcfg-showtitle': 'showTitle', 'tlvcfg-showdot': 'showLiveDot' },
    types: { titleSize: 'int', timeSize: 'int', dotSize: 'int', letterSpacing: 'int', scale: 'int', bgOpacity: 'int' },
  }),
  setupStyleOverlay({
    kind: 'habibitop', settingsKey: 'habibiTop', previewId: 'habi-preview',
    btnTest: 'habi-test', btnReset: 'habi-reset', btnConfig: 'habi-config',
    modalId: 'habiConfigModal', closeId: 'habicfg-close', saveId: 'habicfg-save',
    testAction: 'testTopHabibi', resetAction: 'resetTopHabibi',
    map: { 'habicfg-period': 'resetPeriod', 'habicfg-title': 'headerTitle', 'habicfg-coinlabel': 'coinLabel',
      'habicfg-font': 'font', 'habicfg-rainbow': 'rainbowMode', 'habicfg-scale': 'scale',
      'habicfg-tc1': 'tc1', 'habicfg-tc2': 'tc2', 'habicfg-tc3': 'tc3',
      'habicfg-ng1': 'ng1', 'habicfg-ng2': 'ng2', 'habicfg-ng3': 'ng3',
      'habicfg-valuecolor': 'valueColor', 'habicfg-valuestroke': 'valueStroke', 'habicfg-coincolor': 'coinColor' },
    types: { scale: 'int' },
  }),
  setupStyleOverlay({
    kind: 'topgift', settingsKey: 'topGift', previewId: 'tgf-preview',
    btnTest: 'tgf-test', btnReset: 'tgf-reset', btnConfig: 'tgf-config',
    modalId: 'tgfConfigModal', closeId: 'tgfcfg-close', saveId: 'tgfcfg-save',
    testAction: 'testTopGift', resetAction: 'resetTopGift', randomGift: true,
    map: { 'tgfcfg-title': 'title', 'tgfcfg-coinlabel': 'coinLabel', 'tgfcfg-font': 'font', 'tgfcfg-rainbow': 'titleRainbow',
      'tgfcfg-tc1': 'tc1', 'tgfcfg-tc2': 'tc2', 'tgfcfg-tc3': 'tc3', 'tgfcfg-namecolor': 'nameColor', 'tgfcfg-valuecolor': 'valueColor', 'tgfcfg-namestroke': 'nameStroke', 'tgfcfg-valuestroke': 'valueStroke' },
  }),
  setupStyleOverlay({
    kind: 'top1', settingsKey: 'top1', previewId: 'top1-preview',
    btnTest: 'top1-test', btnReset: 'top1-reset', btnConfig: 'top1-config',
    modalId: 'top1ConfigModal', closeId: 'top1cfg-close', saveId: 'top1cfg-save',
    testAction: 'testTop1', resetAction: 'resetTop1',
    map: { 'top1cfg-title': 'headerTitle', 'top1cfg-coinlabel': 'coinLabel', 'top1cfg-font': 'font', 'top1cfg-rainbow': 'headerRainbow',
      'top1cfg-showheader': 'showHeader', 'top1cfg-showcrown': 'showCrown', 'top1cfg-showfx': 'showFx',
      'top1cfg-hc1': 'hc1', 'top1cfg-hc2': 'hc2', 'top1cfg-hc3': 'hc3',
      'top1cfg-ng1': 'ng1', 'top1cfg-ng2': 'ng2', 'top1cfg-ng3': 'ng3',
      'top1cfg-valuecolor': 'valueColor', 'top1cfg-valuestroke': 'valueStroke', 'top1cfg-coincolor': 'coinColor' },
  }),
  setupStyleOverlay({
    kind: 'top1fire', settingsKey: 'top1fire', previewId: 'top1fire-preview',
    btnTest: 'top1fire-test', btnReset: 'top1fire-reset', btnConfig: 'top1fire-config',
    modalId: 'top1fireConfigModal', closeId: 'top1fcfg-close', saveId: 'top1fcfg-save',
    testAction: 'testTop1Fire', resetAction: 'resetTop1Fire',
    map: { 'top1fcfg-period': 'resetPeriod', 'top1fcfg-title': 'headerTitle', 'top1fcfg-coinlabel': 'coinLabel', 'top1fcfg-font': 'font', 'top1fcfg-rainbow': 'headerRainbow',
      'top1fcfg-showheader': 'showHeader', 'top1fcfg-showcrown': 'showCrown', 'top1fcfg-showfx': 'showFx',
      'top1fcfg-hc1': 'hc1', 'top1fcfg-hc2': 'hc2', 'top1fcfg-hc3': 'hc3',
      'top1fcfg-ng1': 'ng1', 'top1fcfg-ng2': 'ng2', 'top1fcfg-ng3': 'ng3',
      'top1fcfg-valuecolor': 'valueColor', 'top1fcfg-valuestroke': 'valueStroke', 'top1fcfg-coincolor': 'coinColor',
      'top1fcfg-fc1': 'fc1', 'top1fcfg-fc2': 'fc2', 'top1fcfg-fc3': 'fc3', 'top1fcfg-rc1': 'rc1', 'top1fcfg-rc2': 'rc2' },
  }),
  setupStyleOverlay({
    kind: 'gcounter', settingsKey: 'giftCounter', previewId: 'gct-preview',
    btnTest: 'gct-test', btnReset: 'gct-reset', btnConfig: 'gct-config',
    modalId: 'gctConfigModal', closeId: 'gctcfg-close', saveId: 'gctcfg-save',
    testAction: 'testGiftCounter', resetAction: 'resetGiftCounter',
    map: { 'gctcfg-title': 'title', 'gctcfg-font': 'font', 'gctcfg-rainbow': 'titleRainbow',
      'gctcfg-tc1': 'tc1', 'gctcfg-tc2': 'tc2', 'gctcfg-tc3': 'tc3',
      'gctcfg-titlecolor': 'titleColor', 'gctcfg-countercolor': 'counterColor',
      'gctcfg-titlestroke': 'titleStroke', 'gctcfg-counterstroke': 'counterStroke' },
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
      'cmcfg-reveal': 'revealSec', 'cmcfg-slowfrom': 'slowRevealFromSec', 'cmcfg-slowsec': 'slowRevealSec',
      'cmcfg-minbid': 'minBid', 'cmcfg-maxp': 'maxParticipants', 'cmcfg-winmode': 'winMode',
      'cmcfg-accent': 'accent', 'cmcfg-font': 'font', 'cmcfg-showtitle': 'showTitle', 'cmcfg-showcount': 'showCount',
      'cmcfg-scroll': 'scroll', 'cmcfg-sniper': 'sniper', 'cmcfg-slowcd': 'slowReveal' },
    types: { durationSec: 'int', topN: 'int', startDelaySec: 'int', revealSec: 'int', slowRevealFromSec: 'int', slowRevealSec: 'int', minBid: 'int', maxParticipants: 'int' },
  }),
  setupStyleOverlay({
    kind: 'topaltneon', settingsKey: 'topAltRankNeon', previewId: 'taln-preview',
    btnTest: 'taln-test', btnReset: 'taln-reset', btnConfig: 'taln-config',
    modalId: 'talnConfigModal', closeId: 'talnfg-close', saveId: 'talnfg-save',
    testAction: 'testRankAlt', resetAction: 'resetRankAlt',
    map: { 'talnfg-interval': 'intervalSec', 'talnfg-period-likes': 'resetPeriodLikes', 'talnfg-period-diam': 'resetPeriodDiam',
      'talnfg-rows': 'rows', 'talnfg-scale': 'scale', 'talnfg-likes-accent': 'likesAccent', 'talnfg-diam-accent': 'diamAccent',
      'talnfg-neon-border': 'neonBorder', 'talnfg-neon-glow': 'neonGlow', 'talnfg-pillbg': 'pillBg',
      'talnfg-font': 'font', 'talnfg-transparent': 'transparent', 'talnfg-rainbow': 'nameRainbow',
      'talnfg-shadows': 'shadows', 'talnfg-bounce': 'bounce', 'talnfg-mirror': 'mirror' },
    types: { rows: 'int', scale: 'int', intervalSec: 'int' },
    onSave: (cfg) => {
      if (!settings.toplikesRank) settings.toplikesRank = {};
      if (!settings.topdiamRank) settings.topdiamRank = {};
      if (cfg.resetPeriodLikes != null) settings.toplikesRank.resetPeriod = cfg.resetPeriodLikes;
      if (cfg.resetPeriodDiam != null) settings.topdiamRank.resetPeriod = cfg.resetPeriodDiam;
    },
  }),
  setupStyleOverlay({
    kind: 'topalt', settingsKey: 'topAltRank', previewId: 'tal-preview',
    btnTest: 'tal-test', btnReset: 'tal-reset', btnConfig: 'tal-config',
    modalId: 'talConfigModal', closeId: 'talfg-close', saveId: 'talfg-save',
    testAction: 'testRankAlt', resetAction: 'resetRankAlt',
    map: { 'talfg-interval': 'intervalSec', 'talfg-period-likes': 'resetPeriodLikes', 'talfg-period-diam': 'resetPeriodDiam',
      'talfg-rows': 'rows', 'talfg-scale': 'scale', 'talfg-likes-accent': 'likesAccent', 'talfg-diam-accent': 'diamAccent',
      'talfg-rowbg': 'rowBg', 'talfg-font': 'font', 'talfg-transparent': 'transparent', 'talfg-rainbow': 'nameRainbow',
      'talfg-lines': 'lines', 'talfg-shadows': 'shadows', 'talfg-mirror': 'mirror' },
    types: { rows: 'int', scale: 'int', intervalSec: 'int' },
    onSave: (cfg) => {
      if (!settings.toplikesRank) settings.toplikesRank = {};
      if (!settings.topdiamRank) settings.topdiamRank = {};
      if (cfg.resetPeriodLikes != null) settings.toplikesRank.resetPeriod = cfg.resetPeriodLikes;
      if (cfg.resetPeriodDiam != null) settings.topdiamRank.resetPeriod = cfg.resetPeriodDiam;
    },
  }),
  setupStyleOverlay({
    kind: 'toplikes', settingsKey: 'toplikesRank', previewId: 'tlk-preview', rank: 'toplikes',
    btnTest: 'tlk-test', btnReset: 'tlk-reset', btnConfig: 'tlk-config',
    modalId: 'tlkConfigModal', closeId: 'tlkcfg-close', saveId: 'tlkcfg-save',
    testAction: 'testRank', resetAction: 'resetRank',
    map: { 'tlkcfg-period': 'resetPeriod', 'tlkcfg-rows': 'rows', 'tlkcfg-scale': 'scale', 'tlkcfg-accent': 'accent', 'tlkcfg-rowbg': 'rowBg', 'tlkcfg-font': 'font',
      'tlkcfg-transparent': 'transparent', 'tlkcfg-rainbow': 'nameRainbow', 'tlkcfg-lines': 'lines', 'tlkcfg-shadows': 'shadows', 'tlkcfg-mirror': 'mirror' },
    types: { rows: 'int', scale: 'int' },
  }),
  setupStyleOverlay({
    kind: 'topdiam', settingsKey: 'topdiamRank', previewId: 'tdm-preview', rank: 'topdiam',
    btnTest: 'tdm-test', btnReset: 'tdm-reset', btnConfig: 'tdm-config',
    modalId: 'tdmConfigModal', closeId: 'tdmcfg-close', saveId: 'tdmcfg-save',
    testAction: 'testRank', resetAction: 'resetRank',
    map: { 'tdmcfg-period': 'resetPeriod', 'tdmcfg-rows': 'rows', 'tdmcfg-scale': 'scale', 'tdmcfg-accent': 'accent', 'tdmcfg-rowbg': 'rowBg', 'tdmcfg-font': 'font',
      'tdmcfg-transparent': 'transparent', 'tdmcfg-rainbow': 'nameRainbow', 'tdmcfg-lines': 'lines', 'tdmcfg-shadows': 'shadows', 'tdmcfg-mirror': 'mirror' },
    types: { rows: 'int', scale: 'int' },
  }),
  setupStyleOverlay({
    kind: 'toplikeslist', settingsKey: 'toplikesList', previewId: 'tll-preview', rank: 'toplikeslist',
    btnTest: 'tll-test', btnReset: 'tll-reset', btnConfig: 'tll-config',
    modalId: 'tllConfigModal', closeId: 'tllcfg-close', saveId: 'tllcfg-save',
    testAction: 'testRank', resetAction: 'resetRank',
    map: { 'tllcfg-period': 'resetPeriod', 'tllcfg-rows': 'rows', 'tllcfg-scale': 'scale', 'tllcfg-accent': 'accent', 'tllcfg-font': 'font',
      'tllcfg-transparent': 'transparent', 'tllcfg-rainbow': 'nameRainbow', 'tllcfg-lines': 'lines', 'tllcfg-shadows': 'shadows', 'tllcfg-mirror': 'mirror' },
    types: { rows: 'int', scale: 'int' },
  }),
  setupStyleOverlay({
    kind: 'topdiamlist', settingsKey: 'topdiamList', previewId: 'tdl-preview', rank: 'topdiamlist',
    btnTest: 'tdl-test', btnReset: 'tdl-reset', btnConfig: 'tdl-config',
    modalId: 'tdlConfigModal', closeId: 'tdlcfg-close', saveId: 'tdlcfg-save',
    testAction: 'testRank', resetAction: 'resetRank',
    map: { 'tdlcfg-period': 'resetPeriod', 'tdlcfg-rows': 'rows', 'tdlcfg-scale': 'scale', 'tdlcfg-accent': 'accent', 'tdlcfg-font': 'font',
      'tdlcfg-transparent': 'transparent', 'tdlcfg-rainbow': 'nameRainbow', 'tdlcfg-lines': 'lines', 'tdlcfg-shadows': 'shadows', 'tdlcfg-mirror': 'mirror' },
    types: { rows: 'int', scale: 'int' },
  }),
  setupStyleOverlay({
    kind: 'toppoints', settingsKey: 'topPointsRank', previewId: 'tp3-preview',
    btnTest: 'tp3-test', btnReset: '', btnConfig: 'tp3-config',
    modalId: 'tp3ConfigModal', closeId: 'tp3cfg-close', saveId: 'tp3cfg-save',
    testAction: 'getPoints',
    map: { 'tp3cfg-title': 'title', 'tp3cfg-scale': 'scale', 'tp3cfg-accent': 'accent', 'tp3cfg-rowbg': 'rowBg', 'tp3cfg-font': 'font',
      'tp3cfg-showtitle': 'showTitle', 'tp3cfg-transparent': 'transparent',
      'tp3cfg-rainbow': 'nameRainbow', 'tp3cfg-titlerainbow': 'titleRainbow', 'tp3cfg-glitter': 'glitter',
      'tp3cfg-lines': 'lines', 'tp3cfg-shadows': 'shadows' },
    types: { scale: 'int' },
  }),
  setupStyleOverlay({
    kind: 'followercounter', settingsKey: 'followerCounter', previewId: 'foc-preview',
    btnTest: 'foc-test', btnReset: 'foc-reset', btnConfig: 'foc-config',
    modalId: 'focConfigModal', closeId: 'foccfg-close', saveId: 'foccfg-save',
    testAction: 'testFollowerCounter', resetAction: 'resetFollowerCounter',
    map: { 'foccfg-variation': 'variation', 'foccfg-font': 'font', 'foccfg-fontsize': 'fontSize',
      'foccfg-linespace': 'lineSpacing', 'foccfg-letterspace': 'letterSpacing', 'foccfg-color': 'fontColor',
      'foccfg-colormode': 'colorMode', 'foccfg-scale': 'scale', 'foccfg-goal': 'goalFollowers', 'foccfg-showtext': 'showFollowersText',
      'foccfg-showprofile': 'showProfile', 'foccfg-showbar': 'showProgressBar', 'foccfg-confetti': 'showConfetti' },
    types: { fontSize: 'int', lineSpacing: 'int', letterSpacing: 'int', scale: 'int', goalFollowers: 'int' },
  }),
  setupStyleOverlay({
    kind: 'followercounter_mc', settingsKey: 'followerCounterMc', previewId: 'focmc-preview',
    btnTest: 'focmc-test', btnReset: 'focmc-reset', btnConfig: 'focmc-config',
    modalId: 'focmcConfigModal', closeId: 'focmccfg-close', saveId: 'focmccfg-save',
    testAction: 'testFollowerCounter', resetAction: 'resetFollowerCounter',
    map: { 'focmccfg-variation': 'variation', 'focmccfg-font': 'font', 'focmccfg-fontsize': 'fontSize',
      'focmccfg-linespace': 'lineSpacing', 'focmccfg-letterspace': 'letterSpacing', 'focmccfg-color': 'fontColor',
      'focmccfg-colormode': 'colorMode', 'focmccfg-scale': 'scale', 'focmccfg-goal': 'goalFollowers', 'focmccfg-showtext': 'showFollowersText',
      'focmccfg-showprofile': 'showProfile', 'focmccfg-showbar': 'showProgressBar', 'focmccfg-confetti': 'showConfetti' },
    types: { fontSize: 'int', lineSpacing: 'int', letterSpacing: 'int', scale: 'int', goalFollowers: 'int' },
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
  setupStyleOverlay({
    kind: 'streamjoinmc', settingsKey: 'streamJoinMc', previewId: 'sjnmc-preview',
    btnTest: 'sjnmc-test', btnReset: 'sjnmc-reset', btnConfig: 'sjnmc-config',
    modalId: 'sjnmcConfigModal', closeId: 'sjnmcfg-close', saveId: 'sjnmcfg-save',
    testAction: 'testStreamJoin', resetAction: 'resetStreamJoin',
    map: { 'sjnmcfg-neon': 'neon', 'sjnmcfg-accent': 'accent', 'sjnmcfg-dur': 'durationSec', 'sjnmcfg-scale': 'scale', 'sjnmcfg-laser': 'laserSpeed',
      'sjnmcfg-top': 'posTop', 'sjnmcfg-left': 'posLeft', 'sjnmcfg-bgop': 'bgOpacity', 'sjnmcfg-tagsz': 'tagSize',
      'sjnmcfg-stsz': 'statusSize', 'sjnmcfg-pmode': 'phraseMode', 'sjnmcfg-phrase': 'phrase', 'sjnmcfg-phrases': 'phrases' },
    types: { scale: 'int', posTop: 'int', posLeft: 'int', bgOpacity: 'int' },
  }),
  setupStyleOverlay({
    kind: 'streamjoindbz', settingsKey: 'streamJoinDbz', previewId: 'sjndbz-preview',
    btnTest: 'sjndbz-test', btnReset: 'sjndbz-reset', btnConfig: 'sjndbz-config',
    modalId: 'sjndbzConfigModal', closeId: 'sjndbzcfg-close', saveId: 'sjndbzcfg-save',
    testAction: 'testStreamJoin', resetAction: 'resetStreamJoin',
    map: { 'sjndbzcfg-neon': 'neon', 'sjndbzcfg-accent': 'accent', 'sjndbzcfg-dur': 'durationSec', 'sjndbzcfg-scale': 'scale', 'sjndbzcfg-laser': 'laserSpeed',
      'sjndbzcfg-top': 'posTop', 'sjndbzcfg-left': 'posLeft', 'sjndbzcfg-bgop': 'bgOpacity', 'sjndbzcfg-tagsz': 'tagSize',
      'sjndbzcfg-stsz': 'statusSize', 'sjndbzcfg-pmode': 'phraseMode', 'sjndbzcfg-phrase': 'phrase', 'sjndbzcfg-phrases': 'phrases' },
    types: { scale: 'int', posTop: 'int', posLeft: 'int', bgOpacity: 'int' },
  }),
  setupStyleOverlay({
    kind: 'streamjoinmario', settingsKey: 'streamJoinMario', previewId: 'sjnmr-preview',
    btnTest: 'sjnmr-test', btnReset: 'sjnmr-reset', btnConfig: 'sjnmr-config',
    modalId: 'sjnmrConfigModal', closeId: 'sjnmrcfg-close', saveId: 'sjnmrcfg-save',
    testAction: 'testStreamJoin', resetAction: 'resetStreamJoin',
    map: { 'sjnmrcfg-neon': 'neon', 'sjnmrcfg-accent': 'accent', 'sjnmrcfg-dur': 'durationSec', 'sjnmrcfg-scale': 'scale', 'sjnmrcfg-laser': 'laserSpeed',
      'sjnmrcfg-top': 'posTop', 'sjnmrcfg-left': 'posLeft', 'sjnmrcfg-bgop': 'bgOpacity', 'sjnmrcfg-tagsz': 'tagSize',
      'sjnmrcfg-stsz': 'statusSize', 'sjnmrcfg-pmode': 'phraseMode', 'sjnmrcfg-phrase': 'phrase', 'sjnmrcfg-phrases': 'phrases' },
    types: { scale: 'int', posTop: 'int', posLeft: 'int', bgOpacity: 'int' },
  }),
];

// Contador de meta: controles propios de la tarjeta (regalo, meta, título, valor).
(function setupGiftCounterCard() {
  const prev = () => $('gct-preview')?.contentWindow;
  const toPrev = () => prev()?.postMessage({ kind: 'gcounter', type: 'config', config: settings?.giftCounter || {} }, '*');
  const ensure = () => { if (!settings.giftCounter) settings.giftCounter = {}; return settings.giftCounter; };

  if ($('gct-giftpick')) $('gct-giftpick').onclick = () => openGiftModal('sa', (g) => {
    const c = ensure();
    c.giftId = String(g.id || '');
    c.giftName = g.name || '';
    c.image = g.image || '';
    refreshGiftCounterCardUI();
    saveSettings(); toPrev();
  });
  if ($('gct-giftany')) $('gct-giftany').onclick = () => {
    const c = ensure();
    c.giftId = ''; c.giftName = ''; c.image = '';
    refreshGiftCounterCardUI();
    saveSettings(); toPrev();
  };
  if ($('gct-goal')) $('gct-goal').addEventListener('input', () => {
    const c = ensure(); c.goal = Math.max(1, parseInt($('gct-goal').value, 10) || 1);
    saveSettings(); toPrev();
  });
  if ($('gct-title2')) $('gct-title2').addEventListener('input', () => {
    const c = ensure(); c.title = $('gct-title2').value;
    saveSettings(); toPrev();
  });
  if ($('gct-set')) $('gct-set').onclick = () => {
    const v = Math.max(0, parseInt($('gct-value').value, 10) || 0);
    send({ action: 'setGiftCounter', value: v });
    toast('Contador puesto en ' + v + '.');
  };
})();

function refreshGiftCounterCardUI() {
  const c = settings?.giftCounter || {};
  const nameEl = $('gct-giftname');
  if (nameEl) nameEl.textContent = c.giftName ? c.giftName : 'Cualquier regalo';
  if ($('gct-goal')) $('gct-goal').value = c.goal ?? 50;
  if ($('gct-title2')) $('gct-title2').value = c.title ?? 'MY CHALLENGE';
}

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

/* ---- Contadores de victorias (manual): controles +/- y configuración ---- */
const HK_ACTIONS = [
  { id: 'inc1', label: '+1 WIN', amount: false, sign: 1 },
  { id: 'dec1', label: '-1 WIN', amount: false, sign: -1 },
  { id: 'incN', label: 'SUMAR VARIAS', amount: true, sign: 1 },
  { id: 'decN', label: 'RESTAR VARIAS', amount: true, sign: -1 },
];

function ensureHotkeys(key) {
  // Durante la carga del módulo, settings todavía es null (llega luego por WS).
  // Devolvemos atajos por defecto sin persistir para no romper el render inicial;
  // refreshWinsCounters() vuelve a pintar con los datos reales cuando llegan.
  if (!settings) {
    const def = {};
    HK_ACTIONS.forEach((a) => { def[a.id] = { on: false, key: '', amount: 5, giftId: '', giftName: '', image: '' }; });
    return def;
  }
  if (!settings[key]) settings[key] = {};
  if (!settings[key].hotkeys || typeof settings[key].hotkeys !== 'object') settings[key].hotkeys = {};
  const hk = settings[key].hotkeys;
  HK_ACTIONS.forEach((a) => { if (!hk[a.id] || typeof hk[a.id] !== 'object') hk[a.id] = { on: false, key: '', amount: 5, giftId: '', giftName: '', image: '' }; });
  return hk;
}

function formatCombo(e) {
  const parts = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  let k = e.key;
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(k)) return parts.join('+');
  if (k === ' ') k = 'Space';
  if (k.length === 1) k = k.toUpperCase();
  parts.push(k);
  return parts.join('+');
}

function captureHotkey(btn, onSet) {
  if (btn.classList.contains('capturing')) return;
  const prevText = btn.textContent;
  btn.classList.add('capturing');
  btn.textContent = 'Pulsa…';
  const handler = (e) => {
    e.preventDefault(); e.stopPropagation();
    if (e.key === 'Escape') { btn.textContent = prevText; cleanup(); return; }
    if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return;
    const combo = formatCombo(e);
    cleanup();
    if (combo) onSet(combo);
  };
  const cleanup = () => { document.removeEventListener('keydown', handler, true); btn.classList.remove('capturing'); };
  document.addEventListener('keydown', handler, true);
}

function buildWinsHotkeys(o) {
  const cont = $(o.hotkeysId); if (!cont) return;
  cont.innerHTML = '';
  o._hkRenderers = [];
  HK_ACTIONS.forEach((a) => {
    const row = document.createElement('div');
    row.className = 'wc-hk';
    const amountInput = a.amount ? '<input type="number" class="wc-hk-amount" min="1" max="999" value="5" title="Cantidad">' : '';
    row.innerHTML = `
      <div class="wc-hk-main">
        <label class="wc-hk-check"><input type="checkbox" class="wc-hk-on"><span>${a.label}</span></label>
        <div class="wc-hk-keys">${amountInput}<button type="button" class="btn ghost wc-hk-key">—</button></div>
      </div>
      <div class="wc-hk-gift"><button type="button" class="btn ghost wc-hk-giftbtn">🎁 Asignar regalo</button></div>`;
    cont.appendChild(row);
    const onEl = row.querySelector('.wc-hk-on');
    const keyBtn = row.querySelector('.wc-hk-key');
    const amountEl = row.querySelector('.wc-hk-amount');
    const giftBtn = row.querySelector('.wc-hk-giftbtn');
    const read = () => ensureHotkeys(o.key)[a.id];
    const renderGift = () => {
      const d = read();
      if (d.giftId) {
        giftBtn.innerHTML = `<img src="${esc(d.image || '')}" class="wc-hk-giftimg" onerror="this.style.display='none'"> ${esc(d.giftName || 'Regalo')} <span class="wc-hk-x">×</span>`;
        giftBtn.classList.add('has-gift');
      } else { giftBtn.textContent = '🎁 Asignar regalo'; giftBtn.classList.remove('has-gift'); }
    };
    const renderKey = () => { keyBtn.textContent = read().key || '—'; };
    const renderAll = () => { const d = read(); onEl.checked = !!d.on; if (amountEl) amountEl.value = d.amount || 5; renderKey(); renderGift(); };
    o._hkRenderers.push(renderAll);
    onEl.onchange = () => { read().on = onEl.checked; saveSettings(); };
    if (amountEl) amountEl.onchange = () => { read().amount = Math.max(1, parseInt(amountEl.value, 10) || 1); saveSettings(); };
    keyBtn.onclick = () => captureHotkey(keyBtn, (combo) => { read().key = combo; renderKey(); saveSettings(); });
    giftBtn.onclick = (e) => {
      const d = read();
      if (d.giftId && e.target.classList.contains('wc-hk-x')) { d.giftId = ''; d.giftName = ''; d.image = ''; renderGift(); saveSettings(); return; }
      openGiftModal('wins', (g) => { d.giftId = String(g.id); d.giftName = g.name; d.image = g.image || ''; renderGift(); saveSettings(); });
    };
    renderAll();
  });
}

function setupWinsCounter(o) {
  const prev = () => $(o.previewId)?.contentWindow;
  const toPrev = (msg) => prev()?.postMessage({ kind: o.kind, ...msg }, '*');
  const ensure = () => { if (!settings[o.key]) settings[o.key] = {}; return settings[o.key]; };
  const pushPrev = () => toPrev({ type: 'config', config: settings?.[o.key] || {} });
  // El número de wins es libre: puede pasar del máximo (sumar +100 sube a 100, no
  // se topa en 10) y bajar de 0 (restar deja negativos). winsMax es solo el
  // denominador que se muestra (wins/max), no un límite.
  const clampW = (v) => { const x = parseInt(v, 10); return Number.isFinite(x) ? Math.max(-999999, Math.min(999999, x)) : 0; };
  const syncWinsInputs = (val) => { if ($(o.inputWins)) $(o.inputWins).value = val; if ($(o.inputWinsModal)) $(o.inputWinsModal).value = val; };
  function setWins(v) { const c = ensure(); c.wins = clampW(v); syncWinsInputs(c.wins); saveSettings(); pushPrev(); }
  if ($(o.btnMinus)) $(o.btnMinus).onclick = () => setWins((settings?.[o.key]?.wins || 0) - 1);
  if ($(o.btnPlus)) $(o.btnPlus).onclick = () => setWins((settings?.[o.key]?.wins || 0) + 1);
  if ($(o.inputWins)) $(o.inputWins).addEventListener('change', () => setWins($(o.inputWins).value));
  if ($(o.btnReset)) $(o.btnReset).onclick = () => { setWins(0); toPrev({ type: 'reset' }); };
  if ($(o.btnTest)) $(o.btnTest).onclick = () => { toPrev({ type: 'test' }); send({ action: o.testAction }); };
  const syncFontSizeVal = () => { if ($(o.fontSizeValId)) $(o.fontSizeValId).textContent = (settings?.[o.key]?.fontSize) ?? 28; };
  if ($(o.btnConfig)) $(o.btnConfig).onclick = () => {
    fillForm(o.map, settings?.[o.key] || {});
    syncFontSizeVal();
    if (o._hkRenderers) o._hkRenderers.forEach((fn) => fn());
    pushPrev();
    $(o.modalId).classList.remove('hidden');
  };
  const close = () => $(o.modalId).classList.add('hidden');
  if ($(o.closeId)) $(o.closeId).onclick = close;
  if ($(o.modalId)) $(o.modalId).addEventListener('click', (e) => { if (e.target.id === o.modalId) close(); });
  const apply = () => { settings[o.key] = { ...ensure(), ...readForm(o.map, o.types) }; pushPrev(); };
  Object.keys(o.map).forEach((id) => { const el = $(id); if (el) { el.oninput = apply; el.onchange = apply; } });
  if ($(o.saveId)) $(o.saveId).onclick = () => {
    settings[o.key] = { ...ensure(), ...readForm(o.map, o.types) };
    const c = ensure(); c.wins = clampW(c.wins);
    syncWinsInputs(c.wins); syncFontSizeVal();
    saveSettings(); pushPrev(); close();
  };
  buildWinsHotkeys(o);
  o._adjust = (delta) => setWins((settings?.[o.key]?.wins || 0) + delta);
  o._refresh = () => {
    const c = settings?.[o.key] || {};
    syncWinsInputs(c.wins ?? 0);
    if ($(o.fontSizeValId)) $(o.fontSizeValId).textContent = c.fontSize ?? 28;
    if (o._hkRenderers) o._hkRenderers.forEach((fn) => fn());
  };
  o._push = pushPrev;
  return o;
}

const WINS_COUNTERS = [
  {
    kind: 'wins_counter', key: 'winsCounter', previewId: 'wc-preview',
    btnReset: 'wc-reset', btnTest: 'wc-test', btnConfig: 'wc-config',
    btnMinus: 'wc-minus', btnPlus: 'wc-plus', inputWins: 'wc-wins',
    modalId: 'wcConfigModal', closeId: 'wccfg-close', saveId: 'wccfg-save',
    testAction: 'testWins',
    hotkeysId: 'wccfg-hotkeys', fontSizeValId: 'wccfg-fontsize-val', inputWinsModal: 'wccfg-wins',
    map: { 'wccfg-label': 'label', 'wccfg-font': 'font', 'wccfg-wins': 'wins', 'wccfg-max': 'winsMax', 'wccfg-fontsize': 'fontSize',
      'wccfg-textcolor': 'textColor', 'wccfg-accentcolor': 'accentColor', 'wccfg-bgcolor': 'bgColor', 'wccfg-bordercolor': 'borderColor', 'wccfg-rainbow': 'rainbow' },
    types: { wins: 'int', winsMax: 'int', fontSize: 'int' },
  },
  {
    kind: 'wins_counter_gamer', key: 'winsCounterGamer', previewId: 'wcg-preview',
    btnReset: 'wcg-reset', btnTest: 'wcg-test', btnConfig: 'wcg-config',
    btnMinus: 'wcg-minus', btnPlus: 'wcg-plus', inputWins: 'wcg-wins',
    modalId: 'wcgConfigModal', closeId: 'wcgcfg-close', saveId: 'wcgcfg-save',
    testAction: 'testWinsGamer',
    hotkeysId: 'wcgcfg-hotkeys', fontSizeValId: 'wcgcfg-fontsize-val', inputWinsModal: 'wcgcfg-wins',
    map: { 'wcgcfg-label': 'label', 'wcgcfg-font': 'font', 'wcgcfg-wins': 'wins', 'wcgcfg-max': 'winsMax', 'wcgcfg-fontsize': 'fontSize',
      'wcgcfg-textcolor': 'textColor', 'wcgcfg-accentcolor': 'accentColor', 'wcgcfg-bgcolor': 'bgColor', 'wcgcfg-bordercolor': 'borderColor', 'wcgcfg-rainbow': 'rainbow', 'wcgcfg-scoreglow': 'scoreGlow' },
    types: { wins: 'int', winsMax: 'int', fontSize: 'int' },
  },
  {
    kind: 'wins_counter_minecraft', key: 'winsCounterMinecraft', previewId: 'wcm-preview',
    btnReset: 'wcm-reset', btnTest: 'wcm-test', btnConfig: 'wcm-config',
    btnMinus: 'wcm-minus', btnPlus: 'wcm-plus', inputWins: 'wcm-wins',
    modalId: 'wcmConfigModal', closeId: 'wcmcfg-close', saveId: 'wcmcfg-save',
    testAction: 'testWinsMinecraft',
    hotkeysId: 'wcmcfg-hotkeys', fontSizeValId: 'wcmcfg-fontsize-val', inputWinsModal: 'wcmcfg-wins',
    map: { 'wcmcfg-label': 'label', 'wcmcfg-font': 'font', 'wcmcfg-wins': 'wins', 'wcmcfg-max': 'winsMax', 'wcmcfg-fontsize': 'fontSize',
      'wcmcfg-textcolor': 'textColor', 'wcmcfg-accentcolor': 'accentColor', 'wcmcfg-bgcolor': 'bgColor', 'wcmcfg-bordercolor': 'borderColor', 'wcmcfg-rainbow': 'rainbow', 'wcmcfg-scoreglow': 'scoreGlow' },
    types: { wins: 'int', winsMax: 'int', fontSize: 'int' },
  },
  {
    kind: 'wins_counter_mario', key: 'winsCounterMario', previewId: 'wmr-preview',
    btnReset: 'wmr-reset', btnTest: 'wmr-test', btnConfig: 'wmr-config',
    btnMinus: 'wmr-minus', btnPlus: 'wmr-plus', inputWins: 'wmr-wins',
    modalId: 'wmrConfigModal', closeId: 'wmrcfg-close', saveId: 'wmrcfg-save',
    testAction: 'testWinsMario',
    hotkeysId: 'wmrcfg-hotkeys', fontSizeValId: 'wmrcfg-fontsize-val', inputWinsModal: 'wmrcfg-wins',
    map: { 'wmrcfg-label': 'label', 'wmrcfg-font': 'font', 'wmrcfg-wins': 'wins', 'wmrcfg-max': 'winsMax', 'wmrcfg-fontsize': 'fontSize',
      'wmrcfg-textcolor': 'textColor', 'wmrcfg-accentcolor': 'accentColor', 'wmrcfg-bgcolor': 'bgColor', 'wmrcfg-bordercolor': 'borderColor', 'wmrcfg-rainbow': 'rainbow', 'wmrcfg-scoreglow': 'scoreGlow' },
    types: { wins: 'int', winsMax: 'int', fontSize: 'int' },
  },
].map(setupWinsCounter);

function refreshWinsCounters() {
  WINS_COUNTERS.forEach((o) => { if (o._refresh) o._refresh(); if (o._push) o._push(); });
}

// Atajos de teclado de los contadores (funciona con el panel enfocado).
document.addEventListener('keydown', (e) => {
  const t = e.target;
  if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
  if (document.querySelector('.wc-hk-key.capturing')) return;
  const combo = formatCombo(e);
  if (!combo) return;
  let acted = false;
  WINS_COUNTERS.forEach((o) => {
    const hk = settings?.[o.key]?.hotkeys; if (!hk) return;
    HK_ACTIONS.forEach((a) => {
      const d = hk[a.id];
      if (!d || !d.on || !d.key) return;
      if (d.key.toLowerCase() !== combo.toLowerCase()) return;
      const amt = a.amount ? Math.max(1, parseInt(d.amount, 10) || 1) : 1;
      o._adjust(a.sign * amt);
      acted = true;
    });
  });
  if (acted) e.preventDefault();
});

/* ---- Barra de meta (Hype) — config con selector de diseño (skin) ---- */
(function setupHypeOverlay() {
  const HYPE_CARDS = [
    { previewId: 'hyp-preview', basePath: '/meta.html', cardId: 'hyp-card' },
    { previewId: 'hypmc-preview', basePath: '/meta-minecraft.html', cardId: 'hypmc-card' },
    { previewId: 'hypmr-preview', basePath: '/meta-mario.html', cardId: 'hypmr-card' },
    { previewId: 'hypdbz-preview', basePath: '/meta-dragonball.html', cardId: 'hypdbz-card' },
  ];
  const MAP = {
    'hypcfg-skin': 'skin', 'hypcfg-kind': 'goalKind', 'hypcfg-title': 'title', 'hypcfg-meta': 'meta',
    'hypcfg-reach': 'whenReach', 'hypcfg-scale': 'scale', 'hypcfg-plike': 'pointsLike', 'hypcfg-pfollow': 'pointsFollow',
    'hypcfg-pshare': 'pointsShare', 'hypcfg-pgift': 'pointsGift', 'hypcfg-pmember': 'pointsMember',
  };
  const TYPES = { meta: 'int', scale: 'int', pointsLike: 'int', pointsFollow: 'int', pointsShare: 'int', pointsGift: 'int', pointsMember: 'int' };
  const build = () => readForm(MAP, TYPES);

  function toAllPreviews(msg) {
    HYPE_CARDS.forEach(({ previewId }) => {
      $(previewId)?.contentWindow?.postMessage({ kind: 'hype', ...msg }, '*');
    });
  }
  function applySkin(skin) {
    const skinQ = skin && skin !== 'default' ? '?skin=' + skin : '';
    const skinAmp = skin && skin !== 'default' ? '&skin=' + skin : '';
    HYPE_CARDS.forEach(({ previewId, basePath, cardId }) => {
      const f = $(previewId);
      const want = basePath + '?embed=1' + skinAmp;
      if (f && f.getAttribute('src') !== want) {
        f.onload = () => toAllPreviews({ type: 'config', config: build() });
        f.src = want;
      }
      const path = basePath + skinQ;
      const code = document.querySelector('#' + cardId + ' .ov-url');
      if (code) { code.dataset.path = path; code.textContent = roomUrl(path); }
    });
  }
  function pushPreview(cfg) { toAllPreviews({ type: 'config', config: cfg || settings?.hypeBar || {} }); }
  function openConfig() {
    fillForm(MAP, settings?.hypeBar || {});
    applySkin((settings?.hypeBar || {}).skin || 'default');
    pushPreview(build());
    $('hypConfigModal').classList.remove('hidden');
  }

  if ($('hyp-test')) $('hyp-test').onclick = () => { toAllPreviews({ type: 'test' }); send({ action: 'testHype' }); };
  if ($('hyp-reset')) $('hyp-reset').onclick = () => { toAllPreviews({ type: 'reset' }); send({ action: 'resetHype' }); };
  if ($('hyp-config')) $('hyp-config').onclick = openConfig;
  ['hypmc-test', 'hypmr-test', 'hypdbz-test'].forEach((id) => { if ($(id)) $(id).onclick = () => { toAllPreviews({ type: 'test' }); send({ action: 'testHype' }); }; });
  ['hypmc-reset', 'hypmr-reset', 'hypdbz-reset'].forEach((id) => { if ($(id)) $(id).onclick = () => { toAllPreviews({ type: 'reset' }); send({ action: 'resetHype' }); }; });
  ['hypmc-config', 'hypmr-config', 'hypdbz-config'].forEach((id) => { if ($(id)) $(id).onclick = openConfig; });

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
const ttsChatUsers = new Map();          // usuarios vistos en el chat (para asignar voces)

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
  fillTtsUvLangOptions();
  fillTtsUvVoiceOptions();
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
  set('tts-name-emojis', t.nameEmojis !== false);
  syncTtsNameEmojisUI();
  val('tts-tiktok-voice', t.tiktokVoice || '');
  set('tts-tiktok-translate', t.tiktokTranslateEs !== false);
  val('tts-rate', t.rate ?? 1.2); const rv = $('tts-rate-val'); if (rv) rv.textContent = (+(t.rate ?? 1.2)).toFixed(1);
  val('tts-pitch', t.pitch ?? 1); const pv = $('tts-pitch-val'); if (pv) pv.textContent = (+(t.pitch ?? 1)).toFixed(1);
  val('tts-vol', t.volume ?? 1); const vv = $('tts-vol-val'); if (vv) vv.textContent = Math.round((t.volume ?? 1) * 100);
  loadVoices();
  fillTtsUvLangOptions();
  fillTtsUvVoiceOptions();
  // permitidos
  set('tts-allow-all', t.allowAll !== false);
  set('tts-allow-followers', t.allowFollowers);
  set('tts-allow-subs', t.allowSubs);
  set('tts-allow-mods', t.allowMods);
  set('tts-allow-team', t.allowTeam);
  val('tts-min-level', t.minMemberLevel ?? 0);
  // Compatibilidad: si no existe el flag, se considera activo cuando ya había un nivel > 0.
  const requireLvl = (t.requireMinLevel ?? (Number(t.minMemberLevel || 0) > 0));
  set('tts-require-level', requireLvl);
  syncTtsMinLevelUI();
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
  renderTtsCommands();
  renderTtsUserVoices();
  refreshTtsUvUserSelect();
  updateTtsSummary();
}

/* ---- Comandos personalizados (respuestas automáticas por voz) ---- */
function renderTtsCommands() {
  const box = $('tts-cmd-list');
  if (!box) return;
  const cmds = (settings?.tts?.commands) || [];
  if (!cmds.length) {
    box.innerHTML = '<div class="cmd-empty">Aún no hay comandos. Añade uno abajo.</div>';
    return;
  }
  box.innerHTML = cmds.map((c) => `
    <div class="cmd-item ${c.enabled === false ? 'off' : ''}" data-id="${esc(c.id)}">
      <label class="cmd-toggle"><input type="checkbox" ${c.enabled === false ? '' : 'checked'} data-act="toggle"> </label>
      <span class="cmd-trigger">${esc(c.command)}</span>
      <span class="cmd-arrow">→</span>
      <span class="cmd-response" title="${esc(c.response)}">${esc(c.response)}</span>
      <button class="cmd-del" data-act="del" title="Eliminar">✕</button>
    </div>`).join('');
  box.querySelectorAll('.cmd-item').forEach((row) => {
    const id = row.dataset.id;
    row.querySelector('[data-act="toggle"]').onchange = (e) => {
      const c = (settings.tts.commands || []).find((x) => String(x.id) === String(id));
      if (c) { c.enabled = e.target.checked; saveTtsCommands(); }
    };
    row.querySelector('[data-act="del"]').onclick = async () => {
      const ok = await askConfirm({ title: 'Eliminar comando', message: '¿Seguro que quieres borrar este comando?', confirmText: 'Eliminar' });
      if (!ok) return;
      settings.tts.commands = (settings.tts.commands || []).filter((x) => String(x.id) !== String(id));
      saveTtsCommands();
      renderTtsCommands();
    };
  });
}

function saveTtsCommands() {
  if (!settings.tts) settings.tts = {};
  saveSettings(); // envía settings completo (incluye tts.commands)
}

/* ---- Voces personalizadas por usuario ---- */
const TTS_UV_LANGS = {
  tiktok: [
    { code: 'es', label: 'Español' },
    { code: 'en', label: 'Inglés' },
    { code: 'fr', label: 'Francés' },
    { code: 'de', label: 'Alemán' },
    { code: 'pt', label: 'Portugués' },
    { code: 'it', label: 'Italiano' },
    { code: 'id', label: 'Indonesio' },
    { code: 'jp', label: 'Japonés' },
    { code: 'kr', label: 'Coreano' },
  ],
  disney: [
    { code: 'en', label: 'Inglés (traduce desde español)' },
  ],
};

function ttsTrackChatUser(p) {
  const uid = String(p?.uniqueId || '').trim();
  if (!uid) return;
  ttsChatUsers.set(uid.toLowerCase(), { uniqueId: uid, nickname: p.nickname || uid });
  refreshTtsUvUserSelect();
}

function ttsUvNormId(id) {
  return String(id || '').trim().toLowerCase().replace(/^@/, '');
}

function getTikTokVoiceCatalog() {
  const sel = $('tts-tiktok-voice');
  if (!sel) return [];
  const out = [];
  sel.querySelectorAll('option[value]').forEach((opt) => {
    const id = String(opt.value || '').trim();
    if (!id) return;
    out.push({ id, label: (opt.textContent || id).trim() });
  });
  return out;
}

function getDisneyVoiceCatalog() {
  const sel = $('tts-tiktok-voice');
  if (!sel) return [];
  const out = [];
  sel.querySelectorAll('optgroup').forEach((og) => {
    const label = String(og.label || '').toLowerCase();
    if (!label.includes('disney')) return;
    og.querySelectorAll('option[value]').forEach((opt) => {
      const id = String(opt.value || '').trim();
      if (id) out.push({ id, label: (opt.textContent || id).trim() });
    });
  });
  return out;
}

function ttsVoiceLangFromId(voiceId) {
  const v = String(voiceId || '').toLowerCase();
  if (!v) return 'en';
  if (v.startsWith('es_') || v.startsWith('es-')) return 'es';
  if (v.startsWith('fr_')) return 'fr';
  if (v.startsWith('de_')) return 'de';
  if (v.startsWith('it_')) return 'it';
  if (v.startsWith('id_')) return 'id';
  if (v.startsWith('jp_')) return 'jp';
  if (v.startsWith('kr_')) return 'kr';
  if (v.startsWith('pt_') || v.startsWith('br_')) return 'pt';
  return 'en';
}

function ttsVoiceLabel(engine, voice, lang) {
  if (!voice) return '—';
  if (engine === 'tiktok' || engine === 'disney') {
    const catalog = engine === 'disney' ? getDisneyVoiceCatalog() : getTikTokVoiceCatalog();
    const hit = catalog.find((x) => x.id === voice) || getTikTokVoiceCatalog().find((x) => x.id === voice);
    return hit ? hit.label : voice;
  }
  const hit = ttsVoices.find((v) => v.name === voice);
  return hit ? `${hit.name}` : voice;
}

function ttsEngineLabel(engine) {
  if (engine === 'disney') return 'Disney';
  return engine === 'tiktok' ? 'TikTok (Server)' : 'Sistema';
}

function ttsUvLangLabel(code) {
  const c = String(code || '').toLowerCase();
  const hit = (TTS_UV_LANGS.tiktok || []).find((x) => x.code === c)
    || (TTS_UV_LANGS.disney || []).find((x) => x.code === c);
  if (hit) return hit.label;
  return langLabel(c);
}

function ttsFindUserVoice(userId) {
  const key = ttsUvNormId(userId);
  if (!key) return null;
  const list = settings?.tts?.userVoices || [];
  return list.find((x) => ttsUvNormId(x.userId) === key) || null;
}

function refreshTtsUvUserSelect() {
  const sel = $('tts-uv-user-sel');
  if (!sel) return;
  const assigned = new Set((settings?.tts?.userVoices || []).map((x) => ttsUvNormId(x.userId)));
  const users = Array.from(ttsChatUsers.values()).filter((u) => !assigned.has(ttsUvNormId(u.uniqueId)));
  users.sort((a, b) => (a.nickname || '').localeCompare(b.nickname || '', 'es'));
  if (!users.length) {
    sel.innerHTML = `<option value="">${assigned.size ? 'Todos asignados' : '— Sin usuarios en el chat —'}</option>`;
    return;
  }
  sel.innerHTML = '<option value="">— Elegir usuario —</option>' +
    users.map((u) => `<option value="${esc(u.uniqueId)}">${esc(u.nickname || u.uniqueId)} (@${esc(u.uniqueId)})</option>`).join('');
}

function fillTtsUvLangOptions() {
  const sel = $('tts-uv-lang');
  const engine = $('tts-uv-engine')?.value || 'tiktok';
  if (!sel) return;
  if (engine === 'disney') {
    sel.innerHTML = TTS_UV_LANGS.disney.map((l) => `<option value="${esc(l.code)}">${esc(l.label)}</option>`).join('');
    sel.value = 'en';
    return;
  }
  if (engine === 'tiktok') {
    const langs = TTS_UV_LANGS.tiktok;
    const cur = sel.value || 'es';
    sel.innerHTML = langs.map((l) => `<option value="${esc(l.code)}" ${l.code === cur ? 'selected' : ''}>${esc(l.label)}</option>`).join('');
    if (!langs.some((l) => l.code === cur)) sel.value = 'es';
    return;
  }
  const seen = new Map();
  ttsVoices.forEach((v) => {
    const code = (v.lang || '').split('-')[0].toLowerCase();
    if (code && !seen.has(code)) seen.set(code, v.lang);
  });
  const langs = Array.from(seen.entries()).sort((a, b) => a[0].localeCompare(b[0], 'es'));
  const cur = (sel.value || 'es').split('-')[0].toLowerCase();
  sel.innerHTML = langs.length
    ? langs.map(([code, full]) => `<option value="${esc(full)}" ${code === cur ? 'selected' : ''}>${esc(langLabel(full))}</option>`).join('')
    : '<option value="es">Español</option>';
}

function fillTtsUvVoiceOptions() {
  const sel = $('tts-uv-voice');
  const engine = $('tts-uv-engine')?.value || 'tiktok';
  const langSel = $('tts-uv-lang');
  if (!sel || !langSel) return;
  const lang = String(langSel.value || 'es').toLowerCase();
  const langBase = lang.split('-')[0];

  if (engine === 'disney') {
    const voices = getDisneyVoiceCatalog();
    const cur = sel.value;
    sel.innerHTML = voices.length
      ? voices.map((v) => `<option value="${esc(v.id)}" ${v.id === cur ? 'selected' : ''}>${esc(v.label)}</option>`).join('')
      : '<option value="">— Sin voces Disney —</option>';
    if (!voices.some((v) => v.id === cur) && voices[0]) sel.value = voices[0].id;
    return;
  }

  if (engine === 'tiktok') {
    const voices = getTikTokVoiceCatalog().filter((v) => ttsVoiceLangFromId(v.id) === langBase);
    const cur = sel.value;
    sel.innerHTML = voices.length
      ? voices.map((v) => `<option value="${esc(v.id)}" ${v.id === cur ? 'selected' : ''}>${esc(v.label)}</option>`).join('')
      : '<option value="">— Sin voces para este idioma —</option>';
    if (!voices.some((v) => v.id === cur) && voices[0]) sel.value = voices[0].id;
    return;
  }

  const list = ttsVoices.filter((v) => (v.lang || '').toLowerCase().startsWith(langBase));
  const voices = list.length ? list : ttsVoices;
  const cur = sel.value;
  sel.innerHTML = voices.length
    ? voices.map((v) => `<option value="${esc(v.name)}" ${v.name === cur ? 'selected' : ''}>${esc(v.name)}</option>`).join('')
    : '<option value="">— Sin voces —</option>';
  if (!voices.some((v) => v.name === cur) && voices[0]) sel.value = voices[0].name;
}

function renderTtsUserVoices() {
  const body = $('tts-uv-tbody');
  if (!body) return;
  const list = settings?.tts?.userVoices || [];
  if (!list.length) {
    body.innerHTML = '<tr class="tts-uv-empty"><td colspan="5">Sin asignaciones</td></tr>';
    return;
  }
  body.innerHTML = list.map((uv) => `
    <tr data-id="${esc(uv.id)}">
      <td><div class="tts-uv-user">${esc(uv.nickname || uv.userId)}<small>@${esc(uv.userId)}</small></div></td>
      <td>${esc(ttsEngineLabel(uv.engine))}</td>
      <td>${esc(ttsUvLangLabel(uv.lang))}</td>
      <td>${esc(ttsVoiceLabel(uv.engine, uv.voice, uv.lang))}</td>
      <td><button type="button" class="tts-uv-del" data-act="del" title="Quitar asignación">✕</button></td>
    </tr>`).join('');
  body.querySelectorAll('[data-act="del"]').forEach((btn) => {
    btn.onclick = async () => {
      const row = btn.closest('tr');
      const id = row?.dataset?.id;
      if (!id) return;
      const ok = await askConfirm({ title: 'Quitar voz', message: '¿Eliminar esta asignación de voz?', confirmText: 'Eliminar' });
      if (!ok) return;
      settings.tts.userVoices = (settings.tts.userVoices || []).filter((x) => String(x.id) !== String(id));
      saveSettings();
      renderTtsUserVoices();
      refreshTtsUvUserSelect();
    };
  });
}

function addTtsUserVoice() {
  const manual = $('tts-uv-user-manual');
  const userSel = $('tts-uv-user-sel');
  const engineEl = $('tts-uv-engine');
  const langEl = $('tts-uv-lang');
  const voiceEl = $('tts-uv-voice');
  if (!engineEl || !langEl || !voiceEl) return;

  let userId = String(manual?.value || '').trim().replace(/^@/, '');
  let nickname = userId;
  if (!userId && userSel?.value) {
    userId = userSel.value;
    const u = ttsChatUsers.get(ttsUvNormId(userId));
    nickname = u?.nickname || userId;
  }
  userId = userId.replace(/^@/, '');
  if (!userId) {
    toast('Escribe el ID del usuario o elígelo del chat', 'warn');
    return;
  }

  const engineRaw = engineEl.value;
  const engine = engineRaw === 'system' ? 'system' : engineRaw;
  if ((engine === 'tiktok' || engine === 'disney') && !capFeature('tts_tiktok')) {
    toast('Las voces TikTok / Disney no están disponibles en tu plan', 'warn');
    return;
  }

  const voice = String(voiceEl.value || '').trim();
  if (!voice) {
    toast('Elige una voz', 'warn');
    return;
  }

  const lang = engine === 'disney' ? 'en' : String(langEl.value || 'es');
  const translate = engine === 'disney' || (engine === 'tiktok' && ttsVoiceLangFromId(voice) === 'en');

  if (!settings.tts) settings.tts = {};
  if (!Array.isArray(settings.tts.userVoices)) settings.tts.userVoices = [];

  const key = ttsUvNormId(userId);
  const existing = settings.tts.userVoices.find((x) => ttsUvNormId(x.userId) === key);
  const entry = {
    id: existing?.id || Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    userId,
    nickname: nickname || userId,
    engine,
    lang: lang.split('-')[0],
    voice,
    translate,
  };

  if (existing) {
    Object.assign(existing, entry);
    toast(`Voz actualizada para @${userId}`, 'ok');
  } else {
    settings.tts.userVoices.push(entry);
    toast(`Voz asignada a @${userId}`, 'ok');
  }

  if (manual) manual.value = '';
  if (userSel) userSel.value = '';
  saveSettings();
  renderTtsUserVoices();
  refreshTtsUvUserSelect();
}

function ttsConfigForUser(userId) {
  const base = settings?.tts || {};
  const uv = ttsFindUserVoice(userId);
  if (!uv) return base;
  if (uv.engine === 'tiktok' || uv.engine === 'disney') {
    return {
      ...base,
      tiktokVoice: uv.voice,
      tiktokTranslateEs: uv.engine === 'disney' ? true : (uv.translate !== false),
      voice: '',
    };
  }
  return {
    ...base,
    lang: uv.lang || base.lang,
    voice: uv.voice || '',
    tiktokVoice: '',
  };
}

function ttsSpeakTextForUser(text, userId) {
  const phrase = String(text || '').trim();
  if (!phrase) return;
  const cfg = ttsConfigForUser(userId);
  const now = Date.now();
  if (phrase === ttsLastPhrase && now - ttsLastPhraseAt < 8000) return;
  ttsLastPhrase = phrase;
  ttsLastPhraseAt = now;
  if (cfg.tiktokVoice) { ttsSpeakTikTok(phrase, cfg); return; }
  ttsSpeakSystem(phrase, cfg);
}

function addTtsCommand() {
  const tEl = $('tts-cmd-trigger'); const rEl = $('tts-cmd-response');
  let cmd = (tEl?.value || '').trim();
  const resp = (rEl?.value || '').trim();
  if (!cmd || !resp) { toast('Escribe el comando y la respuesta.', 'warn'); return; }
  if (!cmd.startsWith('!') && !cmd.startsWith('/') && !cmd.startsWith('.')) cmd = '!' + cmd;
  if (!settings.tts) settings.tts = {};
  if (!Array.isArray(settings.tts.commands)) settings.tts.commands = [];
  settings.tts.commands.push({ id: Date.now().toString(36), command: cmd, response: resp, enabled: true });
  saveTtsCommands();
  renderTtsCommands();
  if (tEl) tEl.value = ''; if (rEl) rEl.value = '';
  toast('Comando añadido.');
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
  const requireLvl = !!(t.requireMinLevel ?? (Number(t.minMemberLevel || 0) > 0));
  const minLvl = Number(t.minMemberLevel || 0);
  if (requireLvl && minLvl > 0) {
    el.textContent = `Se leerá ${trig} solo de miembros del club de fans nivel ${minLvl} o más (Nv.${minLvl}+). ${money}`;
    return;
  }
  el.textContent = `Se leerá ${trig} ${who}. ${money}`;
}

/* ---- Filtros de moderación ---- */
const PROFANITY = ['puta', 'puto', 'mierda', 'pendejo', 'cabron', 'cabrón', 'verga', 'coño', 'joto', 'culero', 'chinga', 'perra', 'zorra', 'maricon', 'maricón', 'pinche', 'fuck', 'shit', 'bitch', 'asshole'];
// Detecta CUALQUIER emoji/pictograma para poder quitarlos del nombre y leer solo el texto.
// Usa \p{Extended_Pictographic} (cubre ⭐ ⌚ ➡️ ❤ ☀ y casi todos los símbolos), más los
// modificadores de tono de piel, banderas (regional indicators), el combinador de teclas
// (1️⃣), el selector de variación (FE0F) y el "zero width joiner" (200D) de emojis combinados.
const EMOJI_RE = /[\p{Extended_Pictographic}\p{Emoji_Modifier}\u{1F1E6}-\u{1F1FF}\u{20E3}\u{FE0F}\u{200D}]/gu;

// Emojis que el TTS nunca lee (ni como palabra ni en voz): se quitan siempre.
const TTS_SILENT_EMOJIS = ['👹'];

function stripSilentEmojis(text) {
  let s = String(text || '');
  for (const emo of TTS_SILENT_EMOJIS) s = s.split(emo).join('');
  return s;
}

// Diccionario de emojis comunes → palabra hablada en español. Sirve para que el
// TTS "lea" los emojis del nombre del usuario (que normalmente la voz omite).
const EMOJI_SPEAK = {
  '😀':'cara feliz','😃':'cara feliz','😄':'cara feliz','😁':'cara sonriente','😆':'risa','😅':'risa nerviosa',
  '🤣':'muerto de risa','😂':'llorando de risa','🙂':'cara feliz','🙃':'cara al revés','😉':'guiño',
  '😊':'cara tierna','😇':'angelito','🥰':'enamorado','😍':'ojos de corazón','🤩':'estrellas en los ojos',
  '😘':'beso','😗':'beso','😚':'beso','😙':'beso','😋':'rico','😛':'lengua','😝':'lengua','😜':'guiño con lengua',
  '🤪':'cara loca','🤨':'ceja alzada','🧐':'monóculo','🤓':'nerd','😎':'cara con lentes','🥸':'disfraz',
  '🥳':'fiesta','😏':'cara pícara','😒':'fastidio','😞':'decepción','😔':'triste','😟':'preocupado','😕':'confundido',
  '🙁':'triste','☹':'triste','😣':'aguantando','😖':'frustrado','😫':'cansado','😩':'agotado','🥺':'ojitos',
  '😢':'llorando','😭':'llanto','😤':'enojado','😠':'molesto','😡':'furioso','🤬':'groserías','🤯':'mente explotada',
  '😳':'sonrojado','🥵':'acalorado','🥶':'congelado','😱':'grito','😨':'asustado','😰':'angustia',
  '😓':'sudando','🤗':'abrazo','🤔':'pensando','🤭':'risita','🤫':'silencio','🥱':'bostezo','😴':'dormido','😪':'sueño',
  '😬':'incómodo','🙄':'ojos en blanco','😶':'sin palabras','😐':'cara neutral','😑':'inexpresivo',
  '🤤':'baba','🤑':'dinero','🤠':'vaquero','😈':'diablito','👿':'demonio','💀':'calavera','☠':'calavera',
  '👻':'fantasma','👽':'extraterrestre','🤖':'robot','💩':'popó','🤡':'payaso','👺':'duende',
  '❤':'corazón rojo','🧡':'corazón naranja','💛':'corazón amarillo','💚':'corazón verde','💙':'corazón azul',
  '💜':'corazón morado','🖤':'corazón negro','🤍':'corazón blanco','🤎':'corazón café','💔':'corazón roto',
  '❣':'corazón','💕':'dos corazones','💞':'corazones girando','💓':'corazón latiendo','💗':'corazón creciendo',
  '💖':'corazón brillante','💘':'corazón con flecha','💝':'corazón con moño','💟':'corazón',
  '⭐':'estrella','🌟':'estrella brillante','✨':'destellos','💫':'estrella fugaz','⚡':'rayo','🔥':'fuego',
  '💥':'explosión','💯':'cien','✅':'palomita','❌':'tache','⛔':'prohibido','🚫':'prohibido',
  '🎉':'fiesta','🎊':'confeti','🎈':'globo','🎁':'regalo','🏆':'trofeo','🥇':'medalla de oro','👑':'corona',
  '💎':'diamante','🌈':'arcoíris','☀':'sol','🌙':'luna','⛅':'nublado','🌧':'lluvia','❄':'copo de nieve',
  '👍':'pulgar arriba','👎':'pulgar abajo','👌':'okay','✌':'paz','🤞':'dedos cruzados','🤙':'llámame',
  '🙏':'manos juntas','👏':'aplausos','🙌':'manos arriba','👋':'saludo','💪':'músculo','🤝':'apretón de manos',
  '🤟':'te quiero','🤘':'rock','✊':'puño','👊':'puño','🫶':'corazón con manos',
  '🌸':'flor de cerezo','🌹':'rosa','🌺':'flor','🌻':'girasol','🌷':'tulipán','🌼':'margarita','🌿':'hierba',
  '🍀':'trébol','🌴':'palmera','🌵':'cactus','🍓':'fresa','🍎':'manzana','🍌':'plátano','🍉':'sandía','🍇':'uvas',
  '🍕':'pizza','🍔':'hamburguesa','🍟':'papas fritas','🍦':'helado','🍩':'dona','🍪':'galleta','🎂':'pastel',
  '🍰':'pastel','☕':'café','🍺':'cerveza','🍷':'vino','🥂':'brindis',
  '🐶':'perrito','🐱':'gatito','🦁':'león','🐯':'tigre','🐰':'conejo','🐻':'oso','🐼':'panda','🐨':'koala',
  '🦊':'zorro','🐷':'cerdito','🐸':'rana','🐵':'mono','🦄':'unicornio','🐢':'tortuga','🦋':'mariposa','🐝':'abeja',
  '🐉':'dragón','🦅':'águila','🦈':'tiburón','🐬':'delfín',
  '⚽':'fútbol','🏀':'baloncesto','🎮':'videojuego','🎵':'nota musical','🎶':'música','🎤':'micrófono','🎧':'audífonos',
  '💰':'dinero','💸':'dinero volando','💵':'billete','🚀':'cohete','🌎':'mundo','🕊':'paloma',
};
const EMOJI_SPEAK_ENTRIES = Object.entries(EMOJI_SPEAK);

// Convierte los emojis de un texto (p. ej. el nombre del usuario) a palabras para
// que el TTS los lea en voz alta; los emojis que no estén en el diccionario se quitan.
function speakEmojis(text) {
  let s = stripSilentEmojis(text);
  if (!s) return s;
  for (const [emo, word] of EMOJI_SPEAK_ENTRIES) {
    if (s.includes(emo)) s = s.split(emo).join(` ${word} `);
  }
  s = s.replace(EMOJI_RE, ' ');           // limpia emojis desconocidos restantes
  return s.replace(/\s+/g, ' ').trim();
}

function ttsModerate(text) {
  const t = settings?.tts || {};
  let s = stripSilentEmojis(text);
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
    // Alfabetos no latinos: árabe (+ presentación), cirílico, hebreo, griego,
    // japonés, chino, coreano, tailandés, devanagari (hindi), etc.
    const otherScript = (s.match(/[\u0370-\u03FF\u0400-\u04FF\u0530-\u058F\u0590-\u05FF\u0600-\u06FF\u0750-\u077F\u0900-\u097F\u0E00-\u0E7F\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uFB50-\uFDFF\uFE70-\uFEFF]/g) || []).length;
    // Si hay cualquier cantidad apreciable de otro alfabeto y predomina (o no hay
    // letras latinas que lo respalden), no se lee el mensaje.
    if (otherScript >= 2 && otherScript >= latin) return null;
  }
  return s;
}

function ttsAllowedUser(p) {
  const t = settings?.tts || {};
  const requireLvl = !!(t.requireMinLevel ?? (Number(t.minMemberLevel || 0) > 0));
  const minLvl = Number(t.minMemberLevel || 0);
  const memberLevel = Number(p.memberLevel || 0);

  // Modo "nivel mínimo de miembro": si está activo, solo importa el Nv. del chat.
  if (requireLvl && minLvl > 0) return memberLevel >= minLvl;

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

// El campo de nivel solo está habilitado cuando el interruptor está activado.
function syncTtsMinLevelUI() {
  const reqEl = $('tts-require-level');
  const on = !!(reqEl && reqEl.checked);
  const num = $('tts-min-level');
  if (!num) return;
  num.disabled = !on;
  num.closest('.field')?.classList.toggle('is-disabled', !on);
}

// La opción "leer los emojis del nombre" solo tiene sentido si se lee el nombre.
function syncTtsNameEmojisUI() {
  const readEl = $('tts-readname');
  const wrap = $('tts-name-emojis-wrap');
  if (wrap) wrap.style.display = (readEl && readEl.checked) ? '' : 'none';
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
  const now = Date.now();
  if (phrase === ttsLastPhrase && now - ttsLastPhraseAt < 8000) return;
  ttsLastPhrase = phrase;
  ttsLastPhraseAt = now;
  // Si hay una voz TikTok elegida, la síntesis va por el servidor (voces Disney, etc.).
  if (t.tiktokVoice) { ttsSpeakTikTok(phrase, t); return; }
  ttsSpeakSystem(phrase, t);
}

/* ---- Voz del sistema (navegador) con cola propia anti-cuelgues ----
   Chromium/Electron tiene 2 bugs conocidos en speechSynthesis:
   1) se "congela" tras ~15 s hablando y deja de leer;
   2) si llega mucho chat, la cola nativa se atora y `speaking` queda pegado en
      true, por lo que los mensajes siguientes NUNCA se leen.
   Para evitarlo gestionamos nosotros la cola: 1 frase a la vez, con onend/onerror
   para avanzar y un watchdog que destraba si el motor se cuelga. */
let ttsSysQueue = [];
let ttsSysBusy = false;
let ttsSysWatchdog = null;
const ttsSpokenKeys = new Map();
const TTS_DEDUP_MS = 90000;
const TTS_DEDUP_MAX = 400;
let ttsLastPhrase = '';
let ttsLastPhraseAt = 0;

function ttsAlreadySpoken(key) {
  if (!key) return false;
  const now = Date.now();
  const prev = ttsSpokenKeys.get(key);
  if (prev != null && now - prev < TTS_DEDUP_MS) return true;
  ttsSpokenKeys.set(key, now);
  if (ttsSpokenKeys.size > TTS_DEDUP_MAX) {
    for (const [k, t] of ttsSpokenKeys) {
      if (now - t >= TTS_DEDUP_MS) ttsSpokenKeys.delete(k);
    }
  }
  return false;
}

function ttsStopSystem() {
  ttsSysQueue = [];
  ttsSysBusy = false;
  if (ttsSysWatchdog) { clearTimeout(ttsSysWatchdog); ttsSysWatchdog = null; }
  if (TTS_HAS) { try { speechSynthesis.cancel(); } catch {} }
}

function ttsSpeakSystem(phrase, t) {
  if (!TTS_HAS) return;
  ttsSysQueue.push({ phrase: String(phrase || ''), t: { ...(t || {}) } });
  if (ttsSysQueue.length > 25) ttsSysQueue.shift(); // no acumular si llega mucho chat
  ttsSysPump();
}

function ttsSysPump() {
  if (!TTS_HAS || ttsSysBusy) return;
  const item = ttsSysQueue.shift();
  if (!item) return;
  ttsSysBusy = true;
  const t = item.t || {};
  const u = new SpeechSynthesisUtterance(item.phrase);
  u.rate = t.rate || 1;
  u.pitch = t.pitch ?? 1;
  u.volume = t.volume ?? 1;
  const voice = ttsVoices.find((v) => v.name === t.voice);
  if (voice) u.voice = voice;
  else if (t.lang) { const byLang = ttsVoices.find((v) => (v.lang || '').toLowerCase().startsWith(t.lang.toLowerCase())); if (byLang) u.voice = byLang; }
  let advanced = false;
  const advance = () => {
    if (advanced) return;
    advanced = true;
    if (ttsSysWatchdog) { clearTimeout(ttsSysWatchdog); ttsSysWatchdog = null; }
    ttsSysBusy = false;
    ttsSysPump();
  };
  u.onend = advance;
  u.onerror = advance;
  // Watchdog: si onend nunca llega (motor congelado), cancelamos y seguimos con el
  // siguiente mensaje en lugar de quedarnos mudos para siempre.
  const estMs = Math.min(20000, 2000 + item.phrase.length * 90);
  ttsSysWatchdog = setTimeout(() => {
    try { speechSynthesis.cancel(); } catch {}
    advance();
  }, estMs);
  try { speechSynthesis.speak(u); }
  catch { advance(); }
}

// Keep-alive: cada pocos segundos reactiva el motor para evitar el congelamiento
// de Chromium tras ~15 s de lectura continua.
if (TTS_HAS) {
  setInterval(() => {
    try { if (speechSynthesis.speaking || speechSynthesis.pending) speechSynthesis.resume(); } catch {}
  }, 8000);
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

// Corta TODO lo que se está leyendo ahora mismo (voz del sistema y cola TikTok).
function ttsHardStop() {
  ttsStopSystem();
  ttsStopTikTok();
}

// Activa/desactiva el chat de voz y corta lo que se estaba leyendo. Lo usa la
// tecla rápida F9 del .exe (ver desktop/main.js → evento 'toggle-tts').
function toggleTtsHotkey() {
  if (!settings.tts) settings.tts = {};
  const next = !settings.tts.enabled;
  settings.tts.enabled = next;
  ttsHardStop(); // siempre corta la lectura en curso al pulsar F9
  const en = $('tts-enabled'); if (en) en.checked = next;
  try { saveSettings(); } catch {}
  try { updateTtsSummary(); } catch {}
  if (typeof toast === 'function') toast(next ? '🔊 Chat de voz activado (F9)' : '🔇 Chat de voz desactivado (F9)');
}

// La tecla F9 (global) viene del proceso principal de Electron solo en el .exe.
if (window.desktopAPI && typeof window.desktopAPI.onToggleTts === 'function') {
  window.desktopAPI.onToggleTts(() => toggleTtsHotkey());
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
  if (force) { ttsSpeakText(`${speakEmojis(p.nickname)} dice: ${p.comment || ''}`); return; }
  if (!t.enabled) return;
  if (!ttsAllowedUser(p)) return;

  let body = ttsTriggerMatch(p.comment);
  if (body == null) return;
  body = ttsModerate(body);
  if (!body) return;
  if (body.length < (t.minLen || 0)) return;
  if (t.maxLen && body.length > t.maxLen) body = body.slice(0, t.maxLen);
  if (!body) return;

  const dedupKey = p.msgId ? ('m:' + p.msgId) : ('c:' + (p.uniqueId || p.nickname || '') + '|' + (p.comment || ''));
  if (ttsAlreadySpoken(dedupKey)) return;

  // Monetización: cobra monedas acumuladas por regalos
  if (t.charge) {
    const uid = p.uniqueId || p.nickname;
    const cost = Math.max(1, +t.cost || 1);
    if ((ttsPoints[uid] || 0) < cost) return;
    ttsPoints[uid] -= cost;
  }
  let prefix = '';
  if (t.readName) {
    // Con emojis: los convierte a palabras (Ej.: "🔥" → "fuego"). Sin emojis: los quita.
    let name = t.nameEmojis === false
      ? String(p.nickname || '').replace(EMOJI_RE, '').replace(/\s+/g, ' ').trim()
      : speakEmojis(p.nickname);
    if (!name) name = 'Alguien';
    prefix = `${name} dice: `;
  }
  ttsSpeakTextForUser(prefix + body, p.uniqueId || p.nickname);
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
  if (en) en.addEventListener('change', () => { settings.tts.enabled = en.checked; if (!settings.tts.enabled) ttsHardStop(); save(); });
  const readName = $('tts-readname');
  if (readName) readName.addEventListener('change', () => { settings.tts.readName = readName.checked; syncTtsNameEmojisUI(); save(); });
  bindChk('tts-name-emojis', 'nameEmojis');
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
  const reqLvl = $('tts-require-level');
  if (reqLvl) reqLvl.addEventListener('change', () => {
    settings.tts.requireMinLevel = reqLvl.checked;
    // Al activar, si el nivel está en 0 lo subimos a 1 para que el filtro tenga efecto.
    if (reqLvl.checked && Number(settings.tts.minMemberLevel || 0) < 1) {
      settings.tts.minMemberLevel = 1;
      const num = $('tts-min-level'); if (num) num.value = 1;
    }
    syncTtsMinLevelUI();
    save();
    updateTtsSummary();
  });
  const minLvl = $('tts-min-level');
  if (minLvl) minLvl.addEventListener('change', () => { settings.tts.minMemberLevel = Math.max(0, parseInt(minLvl.value, 10) || 0); save(); updateTtsSummary(); });

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

  // comandos personalizados
  const cmdAdd = $('tts-cmd-add');
  if (cmdAdd) cmdAdd.onclick = addTtsCommand;
  ['tts-cmd-trigger', 'tts-cmd-response'].forEach((id) => {
    const el = $(id);
    if (el) el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addTtsCommand(); } });
  });

  // voces personalizadas por usuario
  const uvEngine = $('tts-uv-engine');
  if (uvEngine) {
    if (!capFeature('tts_tiktok')) {
      uvEngine.value = 'system';
      uvEngine.querySelector('option[value="tiktok"]')?.remove();
      uvEngine.querySelector('option[value="disney"]')?.remove();
    }
    uvEngine.addEventListener('change', () => { fillTtsUvLangOptions(); fillTtsUvVoiceOptions(); });
  }
  const uvLang = $('tts-uv-lang');
  if (uvLang) uvLang.addEventListener('change', fillTtsUvVoiceOptions);
  const uvAdd = $('tts-uv-add');
  if (uvAdd) uvAdd.onclick = addTtsUserVoice;
  fillTtsUvLangOptions();
  fillTtsUvVoiceOptions();
  renderTtsUserVoices();
  refreshTtsUvUserSelect();

  const test = $('tts-test');
  if (test) test.onclick = () => ttsSpeakText('Hola, así se escucha el chat por voz');
  const stop = $('tts-stop');
  if (stop) stop.onclick = () => { ttsHardStop(); };
})();

/* ====================== Usuario y Puntos ====================== */
const ptsState = { users: new Map(), tx: [], count: 0, max: 2500 };
let ptsRenderTimer = null;

function applyPointsSettingsUI() {
  const el = $('pts-percoin');
  if (el && !applyingSettings) return; // no pisar lo que el usuario escribe
  if (el) el.value = settings?.points?.perCoin ?? 1;
  const sf = $('pts-superfan'); if (sf) sf.value = settings?.points?.superFanBonus ?? 500;
  const sb = $('pts-subbonus'); if (sb) sb.value = settings?.points?.subBonus ?? 100;
}

function fmtPointsDate(ts) {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleString('es', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch { return '—'; }
}
function fmtPts(n) {
  const v = Number(n) || 0;
  return v.toLocaleString('es', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function onPointsList(p) {
  ptsState.users = new Map((p.users || []).map((u) => [u.uniqueId, u]));
  ptsState.tx = p.tx || [];
  ptsState.count = p.count || ptsState.users.size;
  ptsState.max = p.max || 2500;
  renderPointsTable();
  renderPointsTx();
}
function onPointsUpdate(p) {
  if (!p || !p.user) return;
  ptsState.users.set(p.user.uniqueId, p.user);
  ptsState.count = p.count || ptsState.users.size;
  schedulePointsRender();
}
function onPointsTx(p) {
  if (!p || !p.tx) return;
  ptsState.tx.unshift(p.tx);
  if (ptsState.tx.length > 500) ptsState.tx.length = 500;
  // Solo re-render de transacciones si la sub-vista está visible (es barato igual).
  renderPointsTx();
}
function schedulePointsRender() {
  if (ptsRenderTimer) return;
  ptsRenderTimer = setTimeout(() => { ptsRenderTimer = null; renderPointsTable(); }, 400);
}

function renderPointsTable() {
  const tbody = $('pts-tbody');
  if (!tbody) return;
  const countEl = $('pts-count');
  if (countEl) countEl.textContent = `Tienes ${fmtPts(ptsState.count)} de un máximo de ${fmtPts(ptsState.max)} usuarios en tu base de datos.`;

  const q = ($('pts-search')?.value || '').trim().toLowerCase().replace(/^@/, '');
  let list = [...ptsState.users.values()].sort((a, b) => b.total - a.total);
  if (q) list = list.filter((u) => (u.uniqueId || '').toLowerCase().includes(q) || (u.nickname || '').toLowerCase().includes(q));
  list = list.slice(0, 300); // no pintamos más de 300 filas por rendimiento

  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="admin-empty">${q ? 'Ningún usuario coincide con la búsqueda.' : 'Aún no hay usuarios con puntos. Cuando alguien done en tu live, aparecerá aquí.'}</td></tr>`;
    return;
  }
  tbody.innerHTML = list.map((u) => {
    const img = u.photo ? `<img src="${esc(u.photo)}" onerror="this.style.visibility='hidden'">` : '<img>';
    return `<tr>
      <td><div class="pu">${img}<div><div class="pu-name">${esc(u.nickname || u.uniqueId)}</div><div class="pu-id">@${esc(u.uniqueId)}</div></div></div></td>
      <td><span class="pts-lvl">${u.level}</span></td>
      <td class="pts-total">${fmtPts(u.total)}</td>
      <td>${fmtPts(u.levelPoints)}</td>
      <td>${fmtPointsDate(u.firstAt)}</td>
      <td>${fmtPointsDate(u.lastAt)}</td>
      <td><button class="btn tiny prem-remove pts-del" data-id="${esc(u.uniqueId)}" title="Quitar de la lista">✕</button></td>
    </tr>`;
  }).join('');

  tbody.querySelectorAll('.pts-del').forEach((b) => {
    b.onclick = async () => {
      const id = b.dataset.id;
      if (await askConfirm({ title: 'Borrar puntos', message: `Se borrarán todos los puntos de @${id}.`, confirmText: 'Borrar' })) {
        send({ action: 'resetUserPoints', user: id });
      }
    };
  });
}

function renderPointsTx() {
  const tbody = $('pts-tx-tbody');
  if (!tbody) return;
  if (!ptsState.tx.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="admin-empty">Sin transacciones todavía.</td></tr>';
    return;
  }
  tbody.innerHTML = ptsState.tx.slice(0, 200).map((t) => {
    const cls = t.points >= 0 ? 'pts-pos' : 'pts-neg';
    const sign = t.points >= 0 ? '+' : '';
    return `<tr>
      <td><div class="pu"><div><div class="pu-name">${esc(t.nickname || t.uniqueId)}</div><div class="pu-id">@${esc(t.uniqueId)}</div></div></div></td>
      <td class="${cls}">${sign}${fmtPts(t.points)}</td>
      <td>${esc(t.description || '—')}</td>
      <td>${t.counted ? 'Sí' : 'No'}</td>
      <td>${t.manual ? 'Manual' : 'Regalo'}</td>
      <td>${fmtPointsDate(t.at)}</td>
    </tr>`;
  }).join('');
}

(function setupPointsControls() {
  // Sub-pestañas (Usuario y Puntos / Transacciones), acotadas a esta vista.
  document.querySelectorAll('#view-points .ptab').forEach((btn) => {
    btn.onclick = () => {
      document.querySelectorAll('#view-points .ptab').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('#view-points .pview').forEach((v) => v.classList.remove('active'));
      btn.classList.add('active');
      const v = $(`pview-${btn.dataset.ptab}`);
      if (v) v.classList.add('active');
    };
  });

  const search = $('pts-search');
  if (search) search.addEventListener('input', () => renderPointsTable());

  const perCoin = $('pts-percoin');
  if (perCoin) perCoin.addEventListener('change', () => {
    if (!settings.points) settings.points = {};
    settings.points.perCoin = Math.max(0, Number(perCoin.value) || 0);
    saveSettings();
  });

  const superFan = $('pts-superfan');
  if (superFan) superFan.addEventListener('change', () => {
    if (!settings.points) settings.points = {};
    settings.points.superFanBonus = Math.max(0, Math.round(Number(superFan.value) || 0));
    saveSettings();
  });

  const subBonus = $('pts-subbonus');
  if (subBonus) subBonus.addEventListener('change', () => {
    if (!settings.points) settings.points = {};
    settings.points.subBonus = Math.max(0, Math.round(Number(subBonus.value) || 0));
    saveSettings();
  });

  const reset = $('pts-reset');
  if (reset) reset.onclick = async () => {
    if (await askConfirm({ title: 'Restablecer puntos', message: 'Se pondrán a CERO los puntos de TODOS los usuarios. Esta acción no se puede deshacer.', confirmText: 'Restablecer' })) {
      send({ action: 'resetPoints' });
    }
  };

  const txSend = $('pts-tx-send');
  if (txSend) txSend.onclick = () => {
    const user = ($('pts-tx-user')?.value || '').trim().replace(/^@/, '');
    const pointsVal = Math.round(Number($('pts-tx-points')?.value) || 0);
    if (!user) { $('pts-tx-user')?.focus(); return; }
    if (!pointsVal) { $('pts-tx-points')?.focus(); return; }
    send({
      action: 'addPointsTx',
      user,
      nickname: user,
      points: pointsVal,
      description: ($('pts-tx-desc')?.value || '').trim(),
      counted: $('pts-tx-counted')?.checked !== false,
    });
    $('pts-tx-points').value = 0;
    $('pts-tx-desc').value = '';
  };

  const txCancel = $('pts-tx-cancel');
  if (txCancel) txCancel.onclick = () => {
    $('pts-tx-user').value = '';
    $('pts-tx-points').value = 0;
    $('pts-tx-desc').value = '';
    if ($('pts-tx-counted')) $('pts-tx-counted').checked = true;
  };
})();

// Service Worker: útil en la web; en localhost (.exe) NUNCA — cachea dashboard.js como versión web.
if (!IS_DESKTOP && !IS_LOCALHOST && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
  });
}
if (IS_LOCALHOST && 'serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then((rs) => rs.forEach((r) => r.unregister())).catch(() => {});
}

/* ====================== Acciones (solo en la app .exe) ====================== */
const accSelected = new Set();
let accEditingId = null;
let accPendingImage = null;   // { url, name }
let accPendingGameCompat = false;

// La pestaña Acciones y su UI se inicializan al final del arranque (ver IIFE),
// para que un fallo puntual no rompa el resto del panel (login, WS, logout…).

// Retraso (segundos) antes de ejecutar una prueba, para que dé tiempo a cambiar a la
// ventana del juego/programa donde quieres que se pulse la tecla.
const ACC_TEST_DELAY = 2;
function scheduleActionTest(a) {
  const hasOutput = (a && a.webhookCmd && a.webhookCmd.on && a.webhookCmd.url)
    || (a && a.obsCmd && a.obsCmd.on)
    || (a && a.sbCmd && a.sbCmd.on && a.sbCmd.action);
  if (!a || (!a.keys && !hasOutput)) { toast('Elige una tecla o activa una salida primero.', 'warn'); return; }
  const times = (a.keyRepeatOn && a.keys) ? Math.max(1, parseInt(a.keyRepeat, 10) || 1) : 1;
  toast(`La acción se ejecutará en ${ACC_TEST_DELAY} segundos…`);
  setTimeout(() => {
    if (a.keys && IS_DESKTOP && window.desktopAPI?.pressKeys) {
      window.desktopAPI.pressKeys(a.keys, { gameCompat: !!a.gameCompat, times });
    }
    if (a.sound) { try { const au = new Audio(a.sound); au.volume = a.soundVolume != null ? a.soundVolume : 1; au.play().catch(() => {}); } catch {} }
    // Las salidas (OBS / WebHook / Streamer.bot) las ejecuta el servidor.
    if (hasOutput) send({ action: 'runActionOutputs', webhookCmd: a.webhookCmd, obsCmd: a.obsCmd, sbCmd: a.sbCmd });
    addEvent(`⚡ Prueba: ${esc(a.name || a.keys || 'acción')}${a.keys ? ' → ' + esc(a.keys) + (times > 1 ? ` ×${times}` : '') : ''}`, 'ok');
  }, ACC_TEST_DELAY * 1000);
}

const ACC_EVENT_LABELS = {
  'gift-any': '💎 Cantidad diamantes',
  gift: '🎁 Regalo específico',
  like: '❤️ Likes (por usuario)',
  likeGlobal: '❤️ Likes globales',
  share: '🔁 Compartida',
  subscribe: '⭐ Nuevo suscriptor',
  superFan: '🌟 Super fan',
  follow: '➕ Nuevo seguidor',
  levelUp: '⬆️ Subió de nivel de miembro',
  emote: '😀 Sticker / emote',
};
// Miniatura de la tarjeta: imagen subida si la hay; si no, el icono del regalo (para
// eventos de regalo) o un emoji acorde al evento (likes, seguidor, super fan…).
const ACC_THUMB_EMOJI = {
  'gift-any': '🎁', gift: '🎁', like: '❤️', likeGlobal: '❤️',
  share: '🔁', subscribe: '⭐', superFan: '🌟', follow: '➕', levelUp: '⬆️', emote: '😀',
};
function accThumbHTML(a) {
  if (a.image) return `<div class="acc-thumb" style="background-image:url('${esc(a.image)}')"></div>`;
  const ev = a.event || 'gift-any';
  if (ev === 'gift' && (a.giftId || a.giftName)) {
    const g = a.giftId ? giftCatalogById.get(String(a.giftId))
      : giftCatalog.find((x) => x.name.toLowerCase() === String(a.giftName).toLowerCase());
    const img = g?.image || a.giftImage || '';
    if (img) return `<div class="acc-thumb"><img class="acc-thumb-img" src="${esc(img)}" onerror="this.parentElement.textContent='🎁'"></div>`;
  }
  return `<div class="acc-thumb">${ACC_THUMB_EMOJI[ev] || '⚡'}</div>`;
}

function accEventLabel(a) {
  const ev = a.event || 'gift-any';
  if (ev === 'gift' && (a.giftName || a.giftId)) {
    const g = a.giftId ? giftCatalogById.get(String(a.giftId))
      : giftCatalog.find((x) => x.name.toLowerCase() === String(a.giftName).toLowerCase());
    const img = g?.image || a.giftImage || '';
    const icon = img ? `<img class="gift-pick-ic" src="${esc(img)}" onerror="this.outerHTML='🎁'">` : '🎁';
    return `${icon} ${esc(a.giftName || g?.name || '')}`;
  }
  if (ev === 'gift-any' && (a.rangeMin || a.rangeMax)) return `💎 ${a.rangeMin || 0}${a.rangeMax ? ' – ' + a.rangeMax : '+'}`;
  if (ev === 'like' && a.likeMin > 1) return `❤️ Desde ${a.likeMin} likes`;
  if (ev === 'likeGlobal' && a.likeGoal) return `❤️ Cada ${a.likeGoal} likes`;
  if (ev === 'emote' && a.emoteId) return `😀 Sticker ${esc(a.emoteId)}`;
  return ACC_EVENT_LABELS[ev] || ev;
}

function renderAcciones() {
  const grid = $('acc-grid');
  if (!grid) return;
  const list = (settings && settings.actions) || [];
  for (const id of [...accSelected]) if (!list.find((a) => a.id === id)) accSelected.delete(id);
  updateAccSelCount();

  if (!list.length) {
    grid.innerHTML = '<div class="acc-empty" id="acc-empty">Aún no tienes acciones. Pulsa <b>Crear nueva acción</b> para empezar.</div>';
    return;
  }
  grid.innerHTML = list.map((a) => `
    <div class="acc-card ${a.enabled !== false ? 'on' : ''}" data-id="${a.id}">
      <div class="acc-top">
        <label class="toggle">
          <input type="checkbox" class="acc-toggle" ${a.enabled !== false ? 'checked' : ''}>
          <span class="track"></span>
          <span class="state">${a.enabled !== false ? 'ON' : 'OFF'}</span>
        </label>
        <input type="checkbox" class="sa-sel" ${accSelected.has(a.id) ? 'checked' : ''} title="Seleccionar">
      </div>
      ${accThumbHTML(a)}
      <div class="acc-name">${esc(a.name || 'Acción')}</div>
      <div class="acc-meta">
        <span class="acc-chip">${accEventLabel(a)}</span>
        <span class="acc-chip key">${a.keys
    ? `⌨️ ${esc(a.keys)}${a.keyRepeatOn && (parseInt(a.keyRepeat, 10) || 1) > 1 ? ` ×${parseInt(a.keyRepeat, 10) || 1}` : ''}`
    : (a.marioSpawn?.npcId != null ? `🍄 Mario #${a.marioSpawn.npcId}` : (a.webhookCmd?.on && a.webhookCmd?.url ? '🪝 WebHook' : '⌨️ —'))}</span>
      </div>
      <div class="acc-card-btns">
        <button class="btn ghost acc-edit">✏️ Editar</button>
        <button class="btn ghost acc-try">▶ Probar</button>
      </div>
    </div>`).join('');

  grid.querySelectorAll('.acc-card').forEach((card) => {
    const id = card.dataset.id;
    const a = list.find((x) => x.id === id);
    if (!a) return;
    card.querySelector('.acc-toggle').onchange = (e) => { a.enabled = e.target.checked; saveSettings(); renderAcciones(); };
    card.querySelector('.sa-sel').onchange = (e) => { e.target.checked ? accSelected.add(id) : accSelected.delete(id); updateAccSelCount(); };
    card.querySelector('.acc-edit').onclick = () => openAccModal(a);
    card.querySelector('.acc-try').onclick = () => scheduleActionTest(a);
  });
}

function updateAccSelCount() {
  const c = $('acc-selcount');
  if (c) c.textContent = accSelected.size;
  const del = $('acc-del');
  if (del) del.disabled = accSelected.size === 0;
}

function accBind(id, fn, ev = 'onclick') {
  const el = $(id);
  if (!el) return false;
  if (ev === 'onchange') el.onchange = fn;
  else el.onclick = fn;
  return true;
}

function syncAccKeyRepeatUI() {
  const keysOn = $('acc-keys-on') && $('acc-keys-on').checked;
  if ($('acc-keyrepeat-on-row')) $('acc-keyrepeat-on-row').hidden = !keysOn;
  const repeatOn = keysOn && $('acc-keyrepeat-on') && $('acc-keyrepeat-on').checked;
  if ($('acc-keyrepeat-wrap')) $('acc-keyrepeat-wrap').hidden = !repeatOn;
}

function parseTikfinitySpawnUrlMeta(url) {
  const u = String(url || '');
  if (!/\/spawn\b/i.test(u)) return null;
  const idM = u.match(/[?&](?:id|npcId)=(\d+)/i);
  if (!idM) return null;
  const qM = u.match(/[?&](?:quantity|count)=(\d+)/i);
  return { npcId: Number(idM[1]), quantity: qM ? Math.max(1, parseInt(qM[1], 10) || 1) : 1 };
}

function migrateAccionesSpawnWebhooks(actions) {
  if (!Array.isArray(actions)) return false;
  let changed = false;
  for (const a of actions) {
    if (a._spawnWebhookMigrated) continue;
    const meta = parseTikfinitySpawnUrlMeta(a?.webhookCmd?.url);
    if (a.marioSpawn?.npcId == null && meta && !a.webhookCmd?.on) {
      a.marioSpawn = meta;
      changed = true;
    }
    a._spawnWebhookMigrated = true;
  }
  return changed;
}

function tikfinityTypeToEvent(type) {
  if (type === 'gift') return 'gift';
  if (type === 'likes-person') return 'like';
  if (type === 'likes-total' || type === 'likes-global') return 'likeGlobal';
  if (type === 'follow') return 'follow';
  if (type === 'share') return 'share';
  if (type === 'subscribe') return 'subscribe';
  return null;
}

function tikfinityWebhookActionName(trig) {
  const gift = String(trig?.giftName || '').trim().toLowerCase();
  const clean = (s) => String(s || '').trim().replace(/^Gift\s+/i, '').trim();
  const candidates = [trig?.functionName, trig?.name, trig?.webhook?.name]
    .map(clean)
    .filter(Boolean);
  for (const c of candidates) {
    if (!gift || c.toLowerCase() !== gift) return c;
  }
  return candidates[0] || 'Acción TikFinity';
}

function setupAccionesUI() {
  if (window._accionesWired) return;
  if (!accBind('acc-new', () => {
    if (!ensureCanAdd('actions', 'actions', 'acciones')) return;
    openAccModal(null);
  })) return;
  window._accionesWired = true;
  accBind('acc-del', async () => {
    if (!accSelected.size) return;
    const ok = await askConfirm({ title: 'Eliminar acciones', message: `Se eliminarán ${accSelected.size} acción(es).` });
    if (!ok) return;
    settings.actions = (settings.actions || []).filter((a) => !accSelected.has(a.id));
    accSelected.clear();
    saveSettings(); renderAcciones();
  });
  accBind('acc-cancel', closeAccModal);
  accBind('acc-cancel2', closeAccModal);
  const accModal = $('accModal');
  if (accModal) accModal.addEventListener('click', (e) => { if (e.target.id === 'accModal') closeAccModal(); });
  accBind('acc-event', applyAccEventExtras, 'onchange');
  accBind('acc-giftpick', () => openGiftModalCb((g) => {
    $('acc-giftid').value = g.id || '';
    $('acc-giftname').value = g.name || '';
    accPendingGiftImage = g.image || '';
    $('acc-giftpick').innerHTML = giftBtnHTML(g.name, g.id);
  }));
  accBind('acc-emotepick', () => openEmoteModal('acc'));
  accBind('acc-keys-on', () => {
    const on = $('acc-keys-on').checked;
    $('acc-keys-box').hidden = !on;
    if (!on && $('acc-keyrepeat-on')) $('acc-keyrepeat-on').checked = false;
    syncAccKeyRepeatUI();
    if (on && !$('acc-keys').value.trim()) openKeyboardModal();
  });
  accBind('acc-keyrepeat-on', syncAccKeyRepeatUI);
  accBind('acc-keypick', openKeyboardModal);
  accBind('acc-keyclear', () => { $('acc-keys').value = ''; accPendingGameCompat = false; });
  accBind('acc-imgbtn', () => $('acc-imgfile')?.click());
  const imgFile = $('acc-imgfile');
  if (imgFile) imgFile.addEventListener('change', (e) => uploadAccImage(e.target.files[0]));
  accBind('acc-soundon', () => {
    const on = $('acc-soundon').checked;
    $('acc-soundbox').hidden = !on;
    $('acc-volrow').hidden = !(on && accPendingSound);
    if (on && !accPendingSound) { soundPickTarget = 'action'; openSoundLib(); }
  });
  accBind('acc-soundpick', () => { soundPickTarget = 'action'; openSoundLib(); });
  accBind('acc-soundclear', () => {
    accPendingSound = null;
    $('acc-soundname').textContent = 'Ningún audio…';
    $('acc-volrow').hidden = true;
  });
  const volEl = $('acc-soundvol');
  if (volEl) volEl.addEventListener('input', () => { $('acc-soundvolval').textContent = volEl.value + '%'; });
  // Salidas extra: WebHook / OBS / Streamer.bot.
  accBind('acc-wh-on', () => { $('acc-wh-box').hidden = !$('acc-wh-on').checked; });
  accBind('acc-obs-on', () => { $('acc-obs-box').hidden = !$('acc-obs-on').checked; });
  accBind('acc-sb-on', () => { $('acc-sb-box').hidden = !$('acc-sb-on').checked; });
  accBind('acc-obs-type', applyObsCmdExtras, 'onchange');
  accBind('acc-test', () => scheduleActionTest({
    name: $('acc-name').value.trim() || 'Prueba',
    keys: $('acc-keys-on').checked ? $('acc-keys').value.trim() : '',
    gameCompat: accPendingGameCompat,
    keyRepeatOn: $('acc-keyrepeat-on')?.checked,
    keyRepeat: Math.max(1, parseInt($('acc-keyrepeat')?.value, 10) || 1),
    sound: $('acc-soundon').checked && accPendingSound ? accPendingSound.url : '',
    soundVolume: Math.max(0, Math.min(1, (+$('acc-soundvol').value || 100) / 100)),
    webhookCmd: readAccWebhookCmd(),
    obsCmd: readAccObsCmd(),
    sbCmd: readAccSbCmd(),
  }));
  accBind('acc-save', saveAccModal);
  setupKeyboardModal();
}

let accPendingGiftImage = '';
let accPendingSound = null;   // { url, name }

function applyAccEventExtras() {
  const ev = $('acc-event').value;
  $('acc-giftanyextra').hidden = ev !== 'gift-any';
  $('acc-giftextra').hidden = ev !== 'gift';
  $('acc-likeextra').hidden = ev !== 'like';
  $('acc-likeglobalextra').hidden = ev !== 'likeGlobal';
  $('acc-emoteextra').hidden = ev !== 'emote';
  if ($('acc-combo-row')) $('acc-combo-row').hidden = ev !== 'gift';
}

// Muestra los campos de escena/fuente según el tipo de comando de OBS elegido.
function applyObsCmdExtras() {
  const t = $('acc-obs-type') ? $('acc-obs-type').value : 'scene';
  const needsScene = t === 'scene';
  const needsSource = t === 'toggleSource' || t === 'showSource' || t === 'hideSource';
  if ($('acc-obs-scenewrap')) $('acc-obs-scenewrap').hidden = !needsScene;
  if ($('acc-obs-sourcewrap')) $('acc-obs-sourcewrap').hidden = !needsSource;
}

function readAccWebhookCmd() {
  return {
    on: $('acc-wh-on').checked,
    method: $('acc-wh-method').value || 'GET',
    url: $('acc-wh-url').value.trim(),
    body: $('acc-wh-body').value,
  };
}
function readAccObsCmd() {
  return {
    on: $('acc-obs-on').checked,
    type: $('acc-obs-type').value || 'scene',
    scene: $('acc-obs-scene').value.trim(),
    source: $('acc-obs-source').value.trim(),
  };
}
function readAccSbCmd() {
  return { on: $('acc-sb-on').checked, action: $('acc-sb-action').value.trim() };
}

function openAccModal(a) {
  accEditingId = a ? a.id : null;
  accPendingImage = a && a.image ? { url: a.image, name: 'imagen' } : null;
  accPendingGiftImage = a ? (a.giftImage || '') : '';
  accPendingGameCompat = a ? !!a.gameCompat : false;
  $('acc-modal-title').textContent = a ? 'Editar acción' : 'Nueva acción';
  $('acc-name').value = a ? (a.name || '') : '';
  $('acc-event').value = a ? (a.event || 'gift-any') : 'gift-any';
  $('acc-rangemin').value = a ? (a.rangeMin || 0) : 0;
  $('acc-rangemax').value = a ? (a.rangeMax || 0) : 0;
  $('acc-giftid').value = a ? (a.giftId || '') : '';
  $('acc-giftname').value = a ? (a.giftName || '') : '';
  $('acc-mindia').value = a ? (a.minDiamonds || 0) : 0;
  $('acc-likemin').value = a ? (a.likeMin || 1) : 1;
  $('acc-likegoal').value = a ? (a.likeGoal || 100) : 100;
  $('acc-emoteid').value = a ? (a.emoteId || '') : '';
  if ($('acc-comboinstant')) $('acc-comboinstant').checked = !!(a && a.comboInstant);
  $('acc-keys').value = a ? (a.keys || '') : '';
  $('acc-keys-on').checked = !!(a && a.keys);
  $('acc-keys-box').hidden = !(a && a.keys);
  if ($('acc-keyrepeat-on')) $('acc-keyrepeat-on').checked = !!(a && a.keyRepeatOn);
  if ($('acc-keyrepeat')) $('acc-keyrepeat').value = a && a.keyRepeat ? Math.max(1, parseInt(a.keyRepeat, 10) || 1) : 1;
  syncAccKeyRepeatUI();
  $('acc-active').checked = a ? a.enabled !== false : true;
  $('acc-giftpick').innerHTML = giftBtnHTML(a ? a.giftName : '', a ? a.giftId : '');
  if (typeof updateEmotePickBtn === 'function') updateEmotePickBtn('acc');
  $('acc-imgname').textContent = a && a.image ? 'Imagen actual' : 'Ninguna imagen…';
  accPendingSound = a && a.sound ? { url: a.sound, name: a.soundName || 'audio' } : null;
  $('acc-soundon').checked = !!(a && a.sound);
  $('acc-soundbox').hidden = !(a && a.sound);
  $('acc-soundname').textContent = a && a.sound ? (a.soundName || 'Audio actual') : 'Ningún audio…';
  const vol = a && a.soundVolume != null ? Math.round(a.soundVolume * 100) : 100;
  $('acc-soundvol').value = vol;
  $('acc-soundvolval').textContent = vol + '%';
  $('acc-volrow').hidden = !(a && a.sound);
  // Salidas extra: WebHook / OBS / Streamer.bot.
  const wh = (a && a.webhookCmd) || {};
  $('acc-wh-on').checked = !!wh.on;
  $('acc-wh-method').value = wh.method || 'GET';
  $('acc-wh-url').value = wh.url || '';
  $('acc-wh-body').value = wh.body || '';
  $('acc-wh-box').hidden = !wh.on;
  const ob = (a && a.obsCmd) || {};
  $('acc-obs-on').checked = !!ob.on;
  $('acc-obs-type').value = ob.type || 'scene';
  $('acc-obs-scene').value = ob.scene || '';
  $('acc-obs-source').value = ob.source || '';
  $('acc-obs-box').hidden = !ob.on;
  const sb = (a && a.sbCmd) || {};
  $('acc-sb-on').checked = !!sb.on;
  $('acc-sb-action').value = sb.action || '';
  $('acc-sb-box').hidden = !sb.on;
  applyObsCmdExtras();
  $('acc-status').textContent = '';
  applyAccEventExtras();
  $('accModal').classList.remove('hidden');
}

function closeAccModal() {
  $('accModal').classList.add('hidden');
}

function saveAccModal() {
  const keys = $('acc-keys-on').checked ? $('acc-keys').value.trim() : '';
  const webhookCmd = readAccWebhookCmd();
  const obsCmd = readAccObsCmd();
  const sbCmd = readAccSbCmd();
  const hasOutput = (webhookCmd.on && webhookCmd.url) || obsCmd.on || (sbCmd.on && sbCmd.action);
  if (!keys && !hasOutput) {
    $('acc-status').textContent = 'Elige una tecla/clic o activa una salida (WebHook, OBS o Streamer.bot).';
    return;
  }
  let marioSpawn = null;
  if (webhookCmd.on) {
    marioSpawn = null;
  } else {
    const spawnMeta = parseTikfinitySpawnUrlMeta(webhookCmd.url);
    if (spawnMeta) marioSpawn = spawnMeta;
    else if (accEditingId) {
      const prev = settings.actions.find((x) => x.id === accEditingId);
      if (prev?.marioSpawn?.npcId != null) marioSpawn = prev.marioSpawn;
    }
  }
  const data = {
    name: $('acc-name').value.trim() || 'Acción',
    event: $('acc-event').value,
    rangeMin: +$('acc-rangemin').value || 0,
    rangeMax: +$('acc-rangemax').value || 0,
    giftId: $('acc-giftid').value || '',
    giftName: $('acc-giftname').value || '',
    giftImage: accPendingGiftImage || '',
    minDiamonds: +$('acc-mindia').value || 0,
    likeMin: +$('acc-likemin').value || 1,
    likeGoal: +$('acc-likegoal').value || 100,
    emoteId: $('acc-emoteid').value || '',
    comboInstant: $('acc-event').value === 'gift' && $('acc-comboinstant')?.checked,
    keys,
    keyRepeatOn: $('acc-keys-on').checked && $('acc-keyrepeat-on')?.checked,
    keyRepeat: Math.max(1, Math.min(50, parseInt($('acc-keyrepeat')?.value, 10) || 1)),
    gameCompat: !!accPendingGameCompat,
    image: accPendingImage ? accPendingImage.url : '',
    sound: $('acc-soundon').checked && accPendingSound ? accPendingSound.url : '',
    soundName: $('acc-soundon').checked && accPendingSound ? accPendingSound.name : '',
    soundVolume: Math.max(0, Math.min(1, (+$('acc-soundvol').value || 100) / 100)),
    enabled: $('acc-active').checked,
    marioSpawn,
    webhookCmd, obsCmd, sbCmd,
  };
  if (!settings.actions) settings.actions = [];
  if (accEditingId) {
    const a = settings.actions.find((x) => x.id === accEditingId);
    if (a) Object.assign(a, data);
  } else {
    settings.actions.push({ id: 'act' + Date.now(), ...data });
  }
  saveSettings();
  renderAcciones();
  closeAccModal();
}

/* ============ Teclado en pantalla (modal kbModal) ============ */
// Distribución del teclado. Cada tecla: [etiqueta, código, tipo?]
// tipo: 'mod' (modificador) | undefined (tecla normal). El código es el token que
// entiende la app .exe (ver toNutKey en desktop/main.js).
const KB_LAYOUT = [
  ['Esc:Escape', 'F1:F1', 'F2:F2', 'F3:F3', 'F4:F4', 'F5:F5', 'F6:F6', 'F7:F7', 'F8:F8', 'F9:F9', 'F10:F10', 'F11:F11', 'F12:F12'],
  ['|:Backslash', '1:1', '2:2', '3:3', '4:4', '5:5', '6:6', '7:7', '8:8', '9:9', '0:0', '-:Minus', '+:Equal', 'Backspace:Backspace@w2'],
  ['Tab:Tab@w15', 'Q:Q', 'W:W', 'E:E', 'R:R', 'T:T', 'Y:Y', 'U:U', 'I:I', 'O:O', 'P:P', '{:LeftBracket', '}:RightBracket'],
  ['Mayus:CapsLock@mod', 'A:A', 'S:S', 'D:D', 'F:F', 'G:G', 'H:H', 'J:J', 'K:K', 'L:L', ':;:Semicolon', "':Quote", 'Enter:Return@w15'],
  ['Shift:Shift@mod', 'Z:Z', 'X:X', 'C:C', 'V:V', 'B:B', 'N:N', 'M:M', ',:Comma', '.:Period', '/:Slash'],
  ['Ctrl:Ctrl@mod', 'Win:Win@mod', 'Alt:Alt@mod', 'SPACE:Space@space', 'Ctrl:Ctrl@mod'],
];
// Bloque de navegación + flechas (se muestra a la derecha).
const KB_NAV = [
  ['Insert:Insert', 'Home:Home', 'Pg Up:PageUp'],
  ['Delete:Delete', 'End:End', 'Pg Dn:PageDown'],
  ['↑:Up'],
  ['←:Left', '↓:Down', '→:Right'],
];
// Teclado numérico (numpad) a la derecha del bloque de navegación.
const KB_NUMPAD = [
  ['Num:NumLock@dim', '/:Divide', '*:Multiply', '-:Subtract'],
  ['7:NumPad7', '8:NumPad8', '9:NumPad9', '+:Add'],
  ['4:NumPad4', '5:NumPad5', '6:NumPad6'],
  ['1:NumPad1', '2:NumPad2', '3:NumPad3', 'Enter:NumEnter'],
  ['0:NumPad0@w2', '.:Decimal'],
];

// Estado de selección del teclado.
let kbMods = [];      // modificadores activos en orden
let kbMain = '';      // tecla principal o clic/texto (código)
let kbMainLabel = ''; // etiqueta legible
let kbText = '';      // texto literal (si tipo texto)
let kbManualCapturing = false;
let kbManualHandler = null;

const KEY_EVENT_TO_KB = {
  ' ': 'Space', Enter: 'Return', Escape: 'Escape', Tab: 'Tab', Backspace: 'Backspace',
  Delete: 'Delete', Insert: 'Insert', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', CapsLock: 'CapsLock',
  ';': 'Semicolon', "'": 'Quote', ',': 'Comma', '.': 'Period', '/': 'Slash', '\\': 'Backslash',
  '[': 'LeftBracket', ']': 'RightBracket', '-': 'Minus', '=': 'Equal', '`': 'Grave',
};
for (let i = 1; i <= 12; i++) KEY_EVENT_TO_KB['F' + i] = 'F' + i;

const KB_CHAR_PALETTE = [
  '!', '@', '#', '$', '%', '&', '*', '(', ')', '-', '_', '=', '+',
  '[', ']', '{', '}', '|', ';', ':', "'", '"', ',', '.', '<', '>', '/', '?', '\\', '`', '~',
  'ñ', 'á', 'é', 'í', 'ó', 'ú', 'ü', '¿', '¡', 'Ñ', 'Á', 'É', 'Í', 'Ó', 'Ú', 'Ü',
];

function syncKbTextInput() {
  const ti = $('kb-textinput');
  if (ti) ti.value = kbText || '';
  kbMainLabel = `Texto: ${kbText}`;
}
function appendKbChar(ch) {
  stopKbManualCapture();
  if (kbMain !== 'TEXT') {
    kbMods = [];
    kbMain = 'TEXT';
    toggleKbTextMode(true);
  }
  kbText = (kbText || '') + ch;
  syncKbTextInput();
  refreshKeyboardUI();
}
function startKbCharsMode() {
  stopKbManualCapture();
  kbMods = [];
  kbMain = 'TEXT';
  kbMainLabel = `Texto: ${kbText}`;
  toggleKbTextMode(true);
  refreshKeyboardUI();
  $('kb-chars')?.classList.add('active');
  setTimeout(() => $('kb-textinput')?.focus(), 0);
}
function renderKbCharpad() {
  const pad = $('kb-charpad');
  if (!pad || pad.dataset.built) return;
  KB_CHAR_PALETTE.forEach((ch) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'kb-char';
    b.textContent = ch;
    b.title = `Añadir "${ch}"`;
    b.onclick = () => appendKbChar(ch);
    pad.appendChild(b);
  });
  pad.dataset.built = '1';
}

function keyEventToKbCode(e) {
  const c = e.code || '';
  if (/^Numpad[0-9]$/.test(c)) return 'NumPad' + c.slice(6);
  if (c === 'NumpadAdd') return 'Add';
  if (c === 'NumpadSubtract') return 'Subtract';
  if (c === 'NumpadMultiply') return 'Multiply';
  if (c === 'NumpadDivide') return 'Divide';
  if (c === 'NumpadDecimal') return 'Decimal';
  if (c === 'NumpadEnter') return 'NumEnter';
  if (c === 'NumLock') return 'NumLock';
  if (KEY_EVENT_TO_KB[e.key]) return KEY_EVENT_TO_KB[e.key];
  if (e.key.length === 1 && /[a-zA-Z]/.test(e.key)) return e.key.toUpperCase();
  if (e.key.length === 1 && /[0-9]/.test(e.key)) return e.key;
  return e.key;
}
function keyEventToKbLabel(e, code) {
  if (code === 'Return') return 'Enter';
  if (code === 'NumEnter') return 'Enter';
  if (code === 'CapsLock') return 'Mayus';
  if (/^NumPad[0-9]$/.test(code)) return code.slice(6);
  if (code === 'Decimal') return '.';
  if (code === 'Divide') return '/';
  if (code === 'Multiply') return '*';
  if (code === 'Subtract') return '-';
  if (code === 'Add') return '+';
  if (code === 'NumLock') return 'Num';
  if (e.key.length === 1 && /[a-zA-Z0-9]/.test(e.key)) return e.key.toUpperCase();
  return code;
}
function stopKbManualCapture() {
  kbManualCapturing = false;
  if (kbManualHandler) {
    document.removeEventListener('keydown', kbManualHandler, true);
    kbManualHandler = null;
  }
  $('kb-manual')?.classList.remove('capturing');
  $('kbModal')?.classList.remove('kb-listening');
  $('kb-keyboard')?.classList.remove('kb-listening');
}
function startKbManualCapture() {
  if (kbManualCapturing) return;
  kbManualCapturing = true;
  $('kb-manual')?.classList.add('capturing');
  $('kbModal')?.classList.add('kb-listening');
  $('kb-keyboard')?.classList.add('kb-listening');
  const prev = $('kb-preview');
  if (prev) prev.innerHTML = '<span class="kb-listening-msg">⌨️ Pulsa una tecla… (Esc para cancelar)</span>';
  kbManualHandler = (e) => {
    e.preventDefault(); e.stopPropagation();
    if (e.key === 'Escape') { stopKbManualCapture(); refreshKeyboardUI(); return; }
    if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return;
    kbMods = [];
    if (e.ctrlKey) kbMods.push('Ctrl');
    if (e.shiftKey) kbMods.push('Shift');
    if (e.altKey) kbMods.push('Alt');
    if (e.metaKey) kbMods.push('Win');
    const code = keyEventToKbCode(e);
    kbMain = code;
    kbMainLabel = keyEventToKbLabel(e, code);
    kbText = '';
    toggleKbTextMode(false);
    stopKbManualCapture();
    refreshKeyboardUI();
  };
  document.addEventListener('keydown', kbManualHandler, true);
}

function setupKeyboardModal() {
  if (!$('kbModal') || !$('kb-keyboard')) return;
  renderKeyboard();
  renderKbCharpad();
  accBind('kb-close', () => { stopKbManualCapture(); $('kbModal').classList.add('hidden'); });
  accBind('kb-discard', () => { stopKbManualCapture(); $('kbModal').classList.add('hidden'); });
  accBind('kb-manual', startKbManualCapture);
  accBind('kb-chars', startKbCharsMode);
  accBind('kb-char-space', () => appendKbChar(' '));
  accBind('kb-char-back', () => {
    if (kbMain !== 'TEXT') return;
    kbText = (kbText || '').slice(0, -1);
    syncKbTextInput();
    refreshKeyboardUI();
  });
  accBind('kb-char-clear', () => {
    if (kbMain !== 'TEXT') return;
    kbText = '';
    syncKbTextInput();
    refreshKeyboardUI();
  });
  const kbModal = $('kbModal');
  if (kbModal) kbModal.addEventListener('click', (e) => { if (e.target.id === 'kbModal') $('kbModal').classList.add('hidden'); });
  accBind('kb-apply', () => {
    stopKbManualCapture();
    const combo = kbCombo();
    if (!combo) { toast('Elige una tecla o clic.', 'warn'); return; }
    $('acc-keys').value = combo;
    if ($('acc-keys-on')) { $('acc-keys-on').checked = true; if ($('acc-keys-box')) $('acc-keys-box').hidden = false; }
    syncAccKeyRepeatUI();
    accPendingGameCompat = $('kb-gamecompat').checked;
    $('kbModal').classList.add('hidden');
  });
  accBind('kb-test', () => scheduleActionTest({ name: 'Prueba', keys: kbCombo(), gameCompat: $('kb-gamecompat').checked }));

  // Botones de mouse y texto.
  document.querySelectorAll('#kbModal .kb-action').forEach((btn) => {
    btn.onclick = () => {
      const kind = btn.dataset.kind;
      if (kind === 'text') {
        if (kbMain === 'TEXT') {
          kbMain = ''; kbMainLabel = ''; kbText = '';
          toggleKbTextMode(false);
        } else {
          startKbCharsMode();
        }
      } else if (kbMain === btn.dataset.code) {
        // Clic de nuevo sobre el mismo: lo deselecciona.
        kbMain = ''; kbMainLabel = '';
        toggleKbTextMode(false);
      } else {
        kbMods = []; kbMain = btn.dataset.code; kbMainLabel = btn.textContent;
        toggleKbTextMode(false);
      }
      refreshKeyboardUI();
    };
  });

  // Campo de texto: al escribir, actualiza la combinación y la vista previa.
  const ti = $('kb-textinput');
  if (ti) ti.addEventListener('input', () => {
    kbText = ti.value;
    if (kbMain === 'TEXT') kbMainLabel = `Texto: ${kbText}`;
    refreshKeyboardUI();
  });
}

function toggleKbTextMode(show) {
  const row = $('kb-textrow');
  const crows = $('kb-charsrow');
  if (row) row.hidden = !show;
  if (crows) crows.hidden = !show;
  if (show) {
    const ti = $('kb-textinput');
    if (ti) { ti.value = kbText || ''; setTimeout(() => ti.focus(), 0); }
  } else {
    $('kb-chars')?.classList.remove('active');
  }
}

function renderKeyboard() {
  const root = $('kb-keyboard');
  if (!root || root.dataset.built) return;
  const main = document.createElement('div');
  main.className = 'kb-main';
  main.style.cssText = 'display:flex;gap:10px;align-items:flex-start;min-width:0';
  const left = document.createElement('div');
  left.style.cssText = 'flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:5px';
  left.append(...KB_LAYOUT.map(buildKbRow));
  const right = document.createElement('div');
  right.style.cssText = 'flex:0 0 auto;display:flex;gap:8px;align-items:flex-start';
  const nav = document.createElement('div');
  nav.className = 'kb-nav';
  nav.style.cssText = 'flex:0 0 118px;display:flex;flex-direction:column;gap:5px';
  nav.append(...KB_NAV.map(buildKbRow));
  const numpad = document.createElement('div');
  numpad.className = 'kb-numpad';
  numpad.style.cssText = 'flex:0 0 132px;display:flex;flex-direction:column;gap:5px';
  numpad.append(...KB_NUMPAD.map(buildKbRow));
  right.append(nav, numpad);
  main.append(left, right);
  root.appendChild(main);
  root.dataset.built = '1';
}

function buildKbRow(keys) {
  const row = document.createElement('div');
  row.className = 'kb-row';
  for (const spec of keys) {
    const [label, rest] = spec.split(':');
    const [code, flag] = (rest || '').split('@');
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'kb-key';
    if (flag === 'mod') b.classList.add('mod');
    else if (flag === 'dim') b.classList.add('dim');
    else if (flag === 'space') b.classList.add('kb-space');
    else if (flag === 'w2') b.classList.add('kb-w2');
    else if (flag === 'w15') b.classList.add('kb-w15');
    b.textContent = label;
    b.dataset.code = code;
    b.dataset.mod = flag === 'mod' ? '1' : '';
    b.onclick = () => onKbKey(code, label, flag === 'mod');
    row.appendChild(b);
  }
  return row;
}

function onKbKey(code, label, isMod) {
  if (isMod) {
    // Normaliza Ctrl/Shift/Alt/Win (puede haber dos Ctrl).
    const i = kbMods.indexOf(code);
    if (i >= 0) kbMods.splice(i, 1); else kbMods.push(code);
  } else if (kbMain === code) {
    // Clic de nuevo sobre la tecla ya elegida: la deselecciona.
    kbMain = ''; kbMainLabel = ''; kbText = '';
  } else {
    kbMain = code; kbMainLabel = label; kbText = '';
  }
  toggleKbTextMode(false);
  $('kb-chars')?.classList.remove('active');
  refreshKeyboardUI();
}

// Construye la cadena final: "Ctrl + Shift + A", "LeftClick" o "Texto: hola".
function kbCombo() {
  if (kbMain === 'TEXT') return `Texto: ${kbText}`;
  if (!kbMain) return kbMods.join(' + '); // solo modificadores (raro, pero válido)
  if (['LeftClick', 'MiddleClick', 'RightClick'].includes(kbMain)) return kbMain;
  return [...kbMods, kbMain].filter(Boolean).join(' + ');
}

function refreshKeyboardUI() {
  document.querySelectorAll('#kb-keyboard .kb-key').forEach((b) => {
    const code = b.dataset.code;
    b.classList.toggle('active', b.dataset.mod === '1' && kbMods.includes(code));
    b.classList.toggle('sel', b.dataset.mod !== '1' && code === kbMain);
  });
  document.querySelectorAll('#kbModal .kb-action').forEach((b) => {
    b.classList.toggle('sel', b.dataset.code === kbMain || (b.dataset.kind === 'text' && kbMain === 'TEXT'));
  });
  const prev = $('kb-preview');
  if (!prev) return;
  const combo = kbCombo();
  if (!combo) { prev.innerHTML = '<span class="kb-empty">Toca una tecla, combinación o clic…</span>'; return; }
  const parts = kbMain === 'TEXT' ? [kbMainLabel] : combo.split(' + ');
  prev.innerHTML = parts.map((p, i) => `${i ? '<span class="kb-plus">+</span>' : ''}<span class="kb-chip">${esc(p)}</span>`).join('');
}

function openKeyboardModal() {
  stopKbManualCapture();
  // Prefill desde la combinación actual del campo acc-keys.
  kbMods = []; kbMain = ''; kbMainLabel = ''; kbText = '';
  const cur = ($('acc-keys').value || '').trim();
  if (cur) {
    const tm = cur.match(/^Texto:\s*([\s\S]*)$/i);
    if (tm) { kbMain = 'TEXT'; kbText = tm[1]; kbMainLabel = `Texto: ${tm[1]}`; }
    else if (['LeftClick', 'MiddleClick', 'RightClick'].includes(cur)) { kbMain = cur; kbMainLabel = cur; }
    else {
      const toks = cur.split('+').map((t) => t.trim()).filter(Boolean);
      const MODS = ['Ctrl', 'Shift', 'Alt', 'Win', 'Meta'];
      kbMods = toks.filter((t) => MODS.includes(t));
      const m = toks.find((t) => !MODS.includes(t));
      if (m) { kbMain = m; kbMainLabel = m; }
    }
  }
  $('kb-gamecompat').checked = !!accPendingGameCompat;
  toggleKbTextMode(kbMain === 'TEXT');
  if (kbMain === 'TEXT') $('kb-chars')?.classList.add('active');
  else $('kb-chars')?.classList.remove('active');
  refreshKeyboardUI();
  $('kbModal').classList.remove('hidden');
}

async function uploadAccImage(file) {
  if (!file) return;
  const label = $('acc-imgname');
  label.textContent = 'Subiendo…';
  try {
    const res = await fetch('/api/upload?name=' + encodeURIComponent(file.name), { method: 'POST', body: file });
    const data = await res.json();
    if (!data.url) throw new Error(data.error || 'error');
    accPendingImage = { url: data.url, name: file.name };
    label.textContent = file.name;
  } catch (err) {
    label.textContent = uploadErrLabel(err);
  }
}

// Llega del servidor cuando un evento del live dispara una acción (o al pulsar "Probar").
function onKeyAction(p) {
  if (!p) return;
  const hasKeys = !!(p.keys && String(p.keys).trim());
  if (!hasKeys && !p.sound) return;
  const times = Math.max(1, Number(p.times) || 1);
  if (hasKeys && IS_DESKTOP && window.desktopAPI?.pressKeys) {
    // Si mandan varios regalos, pulsamos la tecla una vez por cada uno (el proceso
    // nativo las ejecuta en serie para que no se solapen).
    window.desktopAPI.pressKeys(p.keys, { gameCompat: !!p.gameCompat, times });
  }
  if (p.sound) {
    try {
      const au = new Audio(mediaUrl(p.sound));
      au.volume = p.soundVolume != null ? p.soundVolume : 1;
      au.play().catch(() => {});
    } catch {}
  }
  if (hasKeys) addEvent(`⚡ Acción: ${esc(p.name || p.keys)} → ${esc(p.keys)}${times > 1 ? ` ×${times}` : ''}`, 'ok');
  else if (p.sound) addEvent(`🔊 Acción: ${esc(p.name || 'sonido')}`, 'ok');
}

// En modo relay, la nube manda órdenes locales. Mario/PvZ van al módulo de juegos;
// el resto (RCON, OBS, teclas…) al proceso principal de Electron.

function onLocalExec(exec) {
  if (!exec || !exec.tipo) return;
  if (/^(MARIO_|MARI0_|SMB3_|PVZ_HYBRID_|PVZ_|REPO_)/.test(exec.tipo)) {
    execGameLocal(exec);
    return;
  }
  if (IS_DESKTOP && window.desktopAPI?.localExec) {
    window.desktopAPI.localExec(exec);
  }
}

/* ====================== Importar / Exportar (pestaña Panel) ====================== */
function setupSettingsTransfer() {
  const expBtn = $('transfer-export');
  const impBtn = $('transfer-import');
  const fileIn = $('transfer-file');
  const statusEl = $('transfer-status');
  const exportModal = $('transfer-export-modal');
  const exportGroups = $('transfer-export-groups');
  const exportAllCb = $('transfer-export-all');
  const exportProfilesWrap = $('transfer-export-profiles-wrap');
  const exportProfilesCb = $('transfer-export-profiles');
  if (!expBtn || !impBtn || !fileIn || !window.SettingsTransfer) return;
  const isDesktop = !!(window.desktopAPI && window.desktopAPI.isDesktop);

  function setStatus(msg, kind) {
    if (!statusEl) return;
    statusEl.textContent = msg || '';
    statusEl.className = 'transfer-status' + (kind ? ' ' + kind : '');
  }

  function downloadBackup(out) {
    const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `livecoins-backup-${window.MY_USER || 'panel'}-${Date.now()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 500);
  }

  function exportItemCheckboxes() {
    return exportGroups ? [...exportGroups.querySelectorAll('.transfer-export-item input[type="checkbox"]')] : [];
  }

  function syncExportAllCheckbox() {
    if (!exportAllCb) return;
    const boxes = exportItemCheckboxes();
    const checked = boxes.filter((b) => b.checked).length;
    exportAllCb.checked = boxes.length > 0 && checked === boxes.length;
    exportAllCb.indeterminate = checked > 0 && checked < boxes.length;
  }

  function loadSavedExportKeys() {
    try {
      const raw = localStorage.getItem('livecoins-export-keys');
      if (!raw) return null;
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : null;
    } catch { return null; }
  }

  function saveExportKeys(keys) {
    try { localStorage.setItem('livecoins-export-keys', JSON.stringify(keys)); } catch {}
  }

  function buildExportPicker() {
    if (!exportGroups) return;
    const catalog = window.SettingsTransfer.getExportCatalog(isDesktop);
    const defaults = new Set(window.SettingsTransfer.defaultExportKeys(isDesktop));
    const saved = loadSavedExportKeys();
    const selected = saved ? new Set(saved.filter((k) => defaults.has(k))) : defaults;
    exportGroups.innerHTML = catalog.map((g) => {
      const items = g.items.map((item) => {
        const on = selected.has(item.key);
        return `<label class="transfer-export-item"><input type="checkbox" data-export-key="${item.key}"${on ? ' checked' : ''}> ${item.label}</label>`;
      }).join('');
      return `<section class="transfer-export-group" data-group="${g.id}">
        <div class="transfer-export-group-head">
          <span>${g.label}</span>
          <button type="button" class="transfer-export-group-toggle" data-group-toggle="${g.id}">Todo</button>
        </div>
        <div class="transfer-export-items">${items}</div>
      </section>`;
    }).join('');
    exportGroups.querySelectorAll('.transfer-export-item input').forEach((cb) => {
      cb.addEventListener('change', syncExportAllCheckbox);
    });
    exportGroups.querySelectorAll('[data-group-toggle]').forEach((btn) => {
      const syncBtn = () => {
        const gid = btn.dataset.groupToggle;
        const group = exportGroups.querySelector(`[data-group="${gid}"]`);
        const boxes = group ? [...group.querySelectorAll('input[type="checkbox"]')] : [];
        btn.textContent = boxes.length && boxes.every((b) => b.checked) ? 'Ninguno' : 'Todo';
      };
      syncBtn();
      btn.onclick = () => {
        const gid = btn.dataset.groupToggle;
        const group = exportGroups.querySelector(`[data-group="${gid}"]`);
        const boxes = group ? [...group.querySelectorAll('input[type="checkbox"]')] : [];
        const allOn = boxes.every((b) => b.checked);
        boxes.forEach((b) => { b.checked = !allOn; });
        syncExportAllCheckbox();
        syncBtn();
      };
    });
    syncExportAllCheckbox();
  }

  function openExportModal() {
    if (!exportModal) return;
    buildExportPicker();
    if (exportProfilesWrap) exportProfilesWrap.hidden = !isDesktop;
    exportModal.classList.remove('hidden');
    exportModal.setAttribute('aria-hidden', 'false');
  }

  function closeExportModal() {
    if (!exportModal) return;
    exportModal.classList.add('hidden');
    exportModal.setAttribute('aria-hidden', 'true');
  }

  function getSelectedExportKeys() {
    return exportItemCheckboxes().filter((b) => b.checked).map((b) => b.dataset.exportKey);
  }

  async function runExport() {
    if (!settings) { setStatus('Aún no hay ajustes cargados.', 'err'); return; }
    const keys = getSelectedExportKeys();
    if (!keys.length) {
      setStatus('Marca al menos un elemento para exportar.', 'err');
      toast('Marca al menos un elemento para exportar.', 'warn');
      return;
    }
    try {
      saveExportKeys(keys);
      const out = window.SettingsTransfer.exportSettings(settings, { keys });
      if (isDesktop && exportProfilesCb?.checked) {
        try {
          const full = await requestProfilesFull(2500);
          if (full && Array.isArray(full.slots)) {
            out.profiles = full.slots.map((s, i) => ({
              name: (full.names && full.names[i]) || `Perfil ${i + 1}`,
              data: s ? window.SettingsTransfer.exportSettings(s, { keys }).data : null,
            }));
          }
        } catch {}
      }
      downloadBackup(out);
      closeExportModal();
      setStatus(`Exportación descargada (${keys.length} sección${keys.length === 1 ? '' : 'es'}).`, 'ok');
      toast('Configuración exportada.', 'ok');
    } catch (e) {
      setStatus('Error al exportar: ' + (e.message || e), 'err');
    }
  }

  expBtn.onclick = openExportModal;
  $('transfer-export-close')?.addEventListener('click', closeExportModal);
  $('transfer-export-cancel')?.addEventListener('click', closeExportModal);
  $('transfer-export-confirm')?.addEventListener('click', runExport);
  exportModal?.addEventListener('click', (e) => { if (e.target === exportModal) closeExportModal(); });
  if (exportAllCb) {
    exportAllCb.onchange = () => {
      const on = exportAllCb.checked;
      exportItemCheckboxes().forEach((b) => { b.checked = on; });
      exportAllCb.indeterminate = false;
    };
  }

  impBtn.onclick = () => fileIn.click();

  fileIn.addEventListener('change', async () => {
    const file = fileIn.files?.[0];
    fileIn.value = '';
    if (!file) return;
    setStatus('Importando…');
    try {
      const text = await file.text();
      const result = window.SettingsTransfer.parseFile(text);
      const { counts, format } = result;
      const replace = !!$('transfer-replace')?.checked;
      const mode = replace ? 'replace' : 'merge';

      // Archivo con varios perfiles (solo .exe): se restauran TODOS en sus ranuras.
      if (result.multi && Array.isArray(result.profiles)) {
        if (!isDesktop) {
          setStatus('Este archivo tiene varios perfiles; impórtalo desde la app de escritorio.', 'err');
          return;
        }
        const profiles = result.profiles.map((p) => ({
          name: p.name || '',
          settings: p.settings || null,
        }));
        importProfilesReq(profiles, mode);
        const summary = window.SettingsTransfer.summarize(counts);
        setStatus(`Importado (${mode === 'replace' ? 'reemplazo' : 'añadir'}): ${summary}.`, 'ok');
        toast(`Importado: ${summary}`, 'ok');
        return;
      }

      const patch = result.patch;
      if (replace && !isDesktop && patch.actions) delete patch.actions;

      const merged = window.SettingsTransfer.applyPatch(settings || {}, patch, mode);
      settings = merged;
      saveSettings();
      applySettingsToUI();
      applyLimitUI();

      const summary = window.SettingsTransfer.summarize(counts);
      const fmtLabel = format === 'legacy-v1' ? 'TikFinity legacy' : 'Livecoins';
      setStatus(`Importado (${fmtLabel}, ${mode === 'replace' ? 'reemplazo' : 'añadir'}): ${summary}.`, 'ok');
      toast(`Importado: ${summary}`, 'ok');
    } catch (e) {
      setStatus('Error: ' + (e.message || e), 'err');
      toast(String(e.message || e), 'warn');
    }
  });
}

/* ====================== Perfiles del panel (solo .exe) ====================== */
let profilesState = null;
let profilesFullWaiters = [];

function onProfiles(p) {
  profilesState = p || null;
  renderProfilesList();
  updateProfileEditBadge();
}

async function fetchProfilesHttp() {
  try {
    const r = await fetch('/api/profiles', { credentials: 'same-origin' });
    if (!r.ok) return null;
    const data = await r.json();
    return data.profiles || null;
  } catch {
    return null;
  }
}

async function ensureProfilesLoaded() {
  if (profilesState) return profilesState;
  const p = await fetchProfilesHttp();
  if (p) onProfiles(p);
  return profilesState;
}

function updateProfileEditBadge() {
  const btn = $('brandBtn');
  if (!btn) return;
  const editing = !!(profilesState && profilesState.editingGeneral);
  btn.classList.toggle('editing-general', editing);
  btn.title = editing
    ? 'Editando Perfil General (siempre activo). Cambia a otro perfil para volver al panel normal.'
    : '';
}

function onProfilesFull(p) {
  const waiters = profilesFullWaiters;
  profilesFullWaiters = [];
  waiters.forEach((w) => { clearTimeout(w.timer); w.resolve(p); });
}

// Los perfiles los gestiona el servidor (local en modo clásico, o la nube en modo
// relay). Se piden por WebSocket y, si hace falta, por HTTP como respaldo.
function requestProfiles() {
  send({ action: 'getProfiles' });
  fetchProfilesHttp().then((p) => { if (p) onProfiles(p); });
}

// Pide al servidor TODOS los perfiles con sus ajustes (para exportarlos completos).
function requestProfilesFull(timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      profilesFullWaiters = profilesFullWaiters.filter((w) => w.timer !== timer);
      reject(new Error('timeout'));
    }, timeoutMs || 2500);
    profilesFullWaiters.push({ resolve, timer });
    send({ action: 'getProfilesFull' });
  });
}

async function applyProfileSwitchResponse(data) {
  if (!data) return false;
  if (data.settings) onSettings(data.settings);
  if (data.profiles) onProfiles(data.profiles);
  return true;
}

async function switchProfileReq(index) {
  try {
    const r = await fetch('/api/profiles/switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ index }),
    });
    if (r.ok) {
      await applyProfileSwitchResponse(await r.json());
      return;
    }
  } catch {}
  send({ action: 'switchProfile', index });
}

async function switchGeneralProfileReq() {
  try {
    const r = await fetch('/api/profiles/switch-general', { method: 'POST' });
    if (r.ok) {
      await applyProfileSwitchResponse(await r.json());
      toast && toast('Editando Perfil General (siempre activo en segundo plano)', 'ok');
      return;
    }
  } catch {}
  send({ action: 'switchGeneralProfile' });
}

function renameProfileReq(index, name) { send({ action: 'renameProfile', index, name }); }
function importProfilesReq(profiles, mode) { send({ action: 'importProfiles', profiles, mode }); }

function renderProfilesList() {
  const list = $('profilesList');
  if (!list) return;
  if (!profilesState) {
    list.innerHTML = '<div class="profiles-loading">Cargando perfiles…</div>';
    return;
  }
  const escAttr = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const { active, count, names, used, editingGeneral, generalUsed } = profilesState;
  const max = Number(profilesState.max) > 0 ? Number(profilesState.max) : count;
  list.innerHTML = '';

  const generalRow = document.createElement('button');
  generalRow.type = 'button';
  generalRow.className = 'profile-row general' + (editingGeneral ? ' active' : '');
  generalRow.dataset.general = '1';
  const genEmpty = !generalUsed && !editingGeneral ? ' <span class="pr-empty">(vacío)</span>' : '';
  generalRow.innerHTML = `<span class="pr-check">${editingGeneral ? '✓' : '∞'}</span>`
    + `<span class="pr-name">Perfil General${genEmpty}</span>`
    + `<span class="pr-always" aria-hidden="true">siempre activo</span>`
    + `<span class="pr-info" tabindex="0" aria-label="Información del Perfil General">?</span>`
    + `<span class="pr-tip" role="tooltip">`
    + `<strong>Perfil General — siempre activo</strong>`
    + `Configura aquí alertas, acciones, videos y juegos que deben ejecutarse `
    + `<em>en segundo plano</em> aunque uses otro perfil (Perfil 1, 2, etc.). `
    + `Haz clic para editarlo. Al volver a tu perfil normal, lo del General sigue sonando.`
    + `</span>`;
  generalRow.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (ev.target.closest('.pr-info') || ev.target.closest('.pr-tip')) return;
    if (!editingGeneral) switchGeneralProfileReq();
    closeProfilesPop();
  });
  list.appendChild(generalRow);

  const sep = document.createElement('div');
  sep.className = 'profiles-sep';
  sep.textContent = 'Perfiles del panel';
  list.appendChild(sep);

  for (let i = 0; i < count; i++) {
    const isActive = !editingGeneral && i === active;
    const hasData = !!(used && used[i]);
    const locked = i >= max;
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'profile-row' + (isActive ? ' active' : '') + (locked ? ' locked' : '');
    row.dataset.index = String(i);
    const name = (names && names[i]) || `Perfil ${i + 1}`;
    const empty = !hasData && !isActive ? ' <span class="pr-empty">(vacío)</span>' : '';
    if (locked) {
      row.innerHTML = `<span class="pr-check">🔒</span>`
        + `<span class="pr-name">${escAttr(name)} <span class="pr-empty">(premium)</span></span>`;
    } else {
      row.innerHTML = `<span class="pr-check">${isActive ? '✓' : ''}</span>`
        + `<span class="pr-name">${escAttr(name)}${empty}</span>`
        + `<span class="pr-edit" title="Renombrar">✎</span>`;
    }
    row.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (locked) { toast && toast('Mejora a Premium para usar más perfiles'); return; }
      if (ev.target.closest('.pr-edit')) {
        ev.stopPropagation();
        ev.preventDefault();
        startRenameProfile(i, name, row);
        return;
      }
      if (ev.target.closest('.pr-rename-input')) return;
      if (editingGeneral || i !== active) switchProfileReq(i);
      closeProfilesPop();
    });
    list.appendChild(row);
  }
}

// Edición del nombre EN LÍNEA (window.prompt no funciona en Electron). Convierte el
// nombre del perfil en un campo de texto; guarda con Enter o al perder el foco.
function startRenameProfile(i, current, row) {
  const nameEl = row.querySelector('.pr-name');
  if (!nameEl) return;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'pr-rename-input';
  input.value = current || `Perfil ${i + 1}`;
  input.maxLength = 40;
  let committed = false;
  const commit = (save) => {
    if (committed) return;
    committed = true;
    if (save) renameProfileReq(i, input.value.trim());
    renderProfilesList();
  };
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); commit(true); }
    else if (e.key === 'Escape') { e.preventDefault(); commit(false); }
  });
  input.addEventListener('blur', () => commit(true));
  nameEl.replaceWith(input);
  const edit = row.querySelector('.pr-edit');
  if (edit) edit.style.visibility = 'hidden';
  setTimeout(() => { input.focus(); input.select(); }, 0);
}

function openProfilesPop() {
  const pop = $('profilesPop');
  const wrap = pop && pop.closest('.brand-wrap');
  const list = $('profilesList');
  if (!pop || !wrap) return;
  pop.hidden = false;
  wrap.classList.add('open');
  requestProfiles();
  if (!profilesState && list) {
    list.innerHTML = '<div class="profiles-loading">Cargando perfiles…</div>';
    ensureProfilesLoaded().then(() => {
      if (!profilesState && list) {
        list.innerHTML = '<div class="profiles-loading">No se pudieron cargar. Cierra y vuelve a abrir.</div>';
      }
    });
  }
}
function closeProfilesPop() {
  const pop = $('profilesPop');
  const wrap = pop && pop.closest('.brand-wrap');
  if (!pop || !wrap) return;
  pop.hidden = true;
  wrap.classList.remove('open');
}

function setupProfiles() {
  if (!document.documentElement.classList.contains('is-desktop')) return;
  const btn = $('brandBtn');
  const pop = $('profilesPop');
  if (!btn || !pop) return;
  if (btn.dataset.profilesWired === '1') return;
  btn.dataset.profilesWired = '1';
  btn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (pop.hidden) openProfilesPop(); else closeProfilesPop();
  });
  document.addEventListener('click', (ev) => {
    if (pop.hidden) return;
    if (!ev.target.closest('.brand-wrap')) closeProfilesPop();
  });
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') closeProfilesPop(); });
  requestProfiles();
}

/* ====================== Spotify (solo .exe · admin / albertoyt / alee367 / albertoreyesyt) ====================== */
const SPOTIFY_ALLOWED_USERS = ['albertoyt', 'alee367', 'albertoreyesyt'];
const SPOTIFY_DEFAULTS = {
  playOn: true, playCost: 0, skipOn: true, skipCost: 0,
  skipRequested: true, explicit: true, queueTotal: 2, queueUser: 2,
  overlayPermanent: true, permAll: false, permSubs: true, permMods: true,
  permUsersOn: false,
  permUsers: [],
};
const SPOTIFY_MAP = {
  'sp-play-on': 'playOn', 'sp-play-cost': 'playCost', 'sp-skip-on': 'skipOn',
  'sp-skip-cost': 'skipCost', 'sp-skip-requested': 'skipRequested', 'sp-explicit': 'explicit',
  'sp-queue-total': 'queueTotal', 'sp-queue-user': 'queueUser', 'sp-overlay-perm': 'overlayPermanent',
  'sp-perm-all': 'permAll', 'sp-perm-subs': 'permSubs', 'sp-perm-mods': 'permMods',
  'sp-perm-users-on': 'permUsersOn',
};
const SPOTIFY_INT_KEYS = ['playCost', 'skipCost', 'queueTotal', 'queueUser'];

function spotifyAllowed() {
  const u = (window.MY_USER || '').toLowerCase();
  return IS_DESKTOP && (window.IS_ADMIN || SPOTIFY_ALLOWED_USERS.includes(u));
}
function revealSpotifyTab() {
  const nav = document.getElementById('navSpotify');
  if (nav) nav.style.display = spotifyAllowed() ? '' : 'none';
  try { syncNavSections(); } catch {}
}

// Vuelca settings.spotify -> formulario.
function applySpotifyUI() {
  if (!settings) return;
  const cfg = { ...SPOTIFY_DEFAULTS, ...(settings.spotify || {}) };
  if (!Array.isArray(cfg.permUsers)) cfg.permUsers = [];
  settings.spotify = { ...cfg };
  for (const [id, key] of Object.entries(SPOTIFY_MAP)) {
    const el = document.getElementById(id);
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = !!cfg[key];
    else el.value = cfg[key];
  }
  renderSpotifyPermUsers();
  syncSpotifyPermUsersUI();
}
// Lee el formulario -> settings.spotify y guarda.
function saveSpotifySettings() {
  if (!settings) return;
  const cfg = { ...SPOTIFY_DEFAULTS, ...(settings.spotify || {}) };
  for (const [id, key] of Object.entries(SPOTIFY_MAP)) {
    const el = document.getElementById(id);
    if (!el) continue;
    if (el.type === 'checkbox') cfg[key] = el.checked;
    else if (SPOTIFY_INT_KEYS.includes(key)) cfg[key] = Math.max(0, parseInt(el.value, 10) || 0);
    else cfg[key] = el.value;
  }
  if (!Array.isArray(cfg.permUsers)) cfg.permUsers = [];
  settings.spotify = cfg;
  saveSettings();
}

function spNormUserId(id) {
  return String(id || '').trim().toLowerCase().replace(/^@/, '');
}

function syncSpotifyPermUsersUI() {
  const on = !!document.getElementById('sp-perm-users-on')?.checked;
  const wrap = document.querySelector('.sp-perm-users');
  if (wrap) wrap.classList.toggle('is-disabled', !on);
  const inp = document.getElementById('sp-perm-user-in');
  const btn = document.getElementById('sp-perm-user-add');
  if (inp) inp.disabled = !on;
  if (btn) btn.disabled = !on;
}

function renderSpotifyPermUsers() {
  const box = document.getElementById('sp-perm-user-list');
  if (!box) return;
  const list = settings?.spotify?.permUsers || [];
  if (!list.length) {
    box.innerHTML = '<div class="sp-perm-users-empty">Ningún usuario añadido</div>';
    return;
  }
  box.innerHTML = list.map((uid) => `
    <span class="sp-perm-user-chip" data-id="${esc(uid)}">@${esc(uid)}<button type="button" data-act="del" title="Quitar">✕</button></span>
  `).join('');
  box.querySelectorAll('[data-act="del"]').forEach((btn) => {
    btn.onclick = () => {
      const chip = btn.closest('.sp-perm-user-chip');
      const id = chip?.dataset?.id;
      if (!id || !settings.spotify) return;
      settings.spotify.permUsers = (settings.spotify.permUsers || []).filter((x) => spNormUserId(x) !== spNormUserId(id));
      saveSpotifySettings();
      renderSpotifyPermUsers();
    };
  });
}

function addSpotifyPermUser() {
  const inp = document.getElementById('sp-perm-user-in');
  if (!inp) return;
  if (!document.getElementById('sp-perm-users-on')?.checked) {
    toast && toast('Activa la casilla de usuarios específicos primero', 'warn');
    return;
  }
  const raw = String(inp.value || '').trim().replace(/^@/, '');
  if (!raw) {
    toast && toast('Escribe el @ del usuario', 'warn');
    return;
  }
  if (!settings.spotify) settings.spotify = { ...SPOTIFY_DEFAULTS };
  if (!Array.isArray(settings.spotify.permUsers)) settings.spotify.permUsers = [];
  const key = spNormUserId(raw);
  if (settings.spotify.permUsers.some((x) => spNormUserId(x) === key)) {
    toast && toast('Ese usuario ya está en la lista', 'warn');
    return;
  }
  settings.spotify.permUsers.push(raw);
  inp.value = '';
  saveSpotifySettings();
  renderSpotifyPermUsers();
  toast && toast(`@${raw} puede usar los comandos de Spotify`, 'ok');
}

async function refreshSpotifyStatus() {
  const disc = document.getElementById('sp-disconnected');
  const conn = document.getElementById('sp-connected');
  const estado = document.getElementById('sp-estado');
  try {
    const r = await fetch('/api/spotify/status', { credentials: 'same-origin' });
    if (!r.ok) throw new Error('no-status');
    const d = await r.json();
    if (d.connected) {
      if (disc) disc.hidden = true;
      if (conn) conn.hidden = false;
      const acc = document.getElementById('sp-account');
      if (acc) acc.textContent = d.account || 'Spotify';
      if (estado) {
        estado.textContent = d.playing ? ('Reproduciendo: ' + (d.track || '—')) : 'Inicia Spotify y reproduce una playlist';
        estado.className = 'sp-estado ' + (d.playing ? 'ok' : 'warn');
      }
      return true;
    }
    if (disc) disc.hidden = false;
    if (conn) conn.hidden = true;
    if (estado) { estado.textContent = 'Conecta tu cuenta de Spotify'; estado.className = 'sp-estado warn'; }
    return false;
  } catch {
    if (disc) disc.hidden = false;
    if (conn) conn.hidden = true;
    if (estado) { estado.textContent = 'Conecta tu cuenta de Spotify'; estado.className = 'sp-estado warn'; }
    return false;
  }
}

function renderSpotifyHistory(history) {
  const body = document.getElementById('sp-history');
  if (!body) return;
  if (!Array.isArray(history) || !history.length) {
    body.innerHTML = '<tr><td colspan="4" class="sp-nodata">Sin datos todavía</td></tr>';
    return;
  }
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  body.innerHTML = history.map((h) => {
    const d = new Date(h.at || Date.now());
    const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return `<tr><td>${time}</td><td>${esc(h.user)}</td><td>${esc(h.track)}</td><td>${esc(h.status)}</td></tr>`;
  }).join('');
}

// Sondeo de respaldo tras pulsar "Iniciar sesión": comprueba el estado cada 1.2s
// hasta que se conecte (o se agote). El aviso por postMessage suele llegar antes.
let spotifyPollTimer = null;
function stopSpotifyPolling() { if (spotifyPollTimer) { clearInterval(spotifyPollTimer); spotifyPollTimer = null; } }
function startSpotifyPolling() {
  stopSpotifyPolling();
  let tries = 0;
  spotifyPollTimer = setInterval(async () => {
    tries++;
    const ok = await refreshSpotifyStatus();
    if (ok || tries > 150) stopSpotifyPolling();
  }, 1200);
}

function openSpotifyViewAfterConnect() {
  const nav = document.querySelector('.nav-item[data-view="spotify"]');
  if (nav) nav.click();
  refreshSpotifyStatus();
  try {
    const u = new URL(location.href);
    if (u.searchParams.has('spotify')) {
      u.searchParams.delete('spotify');
      history.replaceState(null, '', u.pathname + (u.search || '') + u.hash);
    }
  } catch {}
}

async function startSpotifyLogin() {
  try {
    const r = await fetch('/api/spotify/auth-url', { credentials: 'same-origin' });
    if (!r.ok) {
      toast && toast('No autorizado para conectar Spotify.', 'err');
      return;
    }
    const d = await r.json();
    if (!d.url) throw new Error('sin url');
    if (IS_DESKTOP && window.desktopAPI?.openSpotifyLogin) {
      await window.desktopAPI.openSpotifyLogin(d.url);
      toast && toast('Completa el login en la ventana de Spotify.', 'ok');
    } else {
      window.open(d.url, 'spotify_login', 'width=520,height=720');
    }
    startSpotifyPolling();
  } catch (e) {
    toast && toast('No se pudo abrir Spotify. Inténtalo de nuevo.', 'err');
    console.error('Spotify login:', e);
  }
}

let spotifyWired = false;
function setupSpotifyUI() {
  if (spotifyWired) return;
  spotifyWired = true;
  const flashSaved = () => {
    const msg = document.getElementById('sp-save-msg');
    if (msg) { msg.textContent = '✓ Guardado'; clearTimeout(flashSaved._t); flashSaved._t = setTimeout(() => { msg.textContent = ''; }, 1500); }
  };
  // Guardado automático: cada campo guarda al modificarse.
  let spSaveTimer = null;
  const autoSave = () => { clearTimeout(spSaveTimer); spSaveTimer = setTimeout(() => { saveSpotifySettings(); flashSaved(); }, 300); };
  for (const id of Object.keys(SPOTIFY_MAP)) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.addEventListener(el.type === 'checkbox' ? 'change' : 'input', autoSave);
  }
  const spPermAdd = document.getElementById('sp-perm-user-add');
  const spPermIn = document.getElementById('sp-perm-user-in');
  const spPermOn = document.getElementById('sp-perm-users-on');
  if (spPermOn) spPermOn.addEventListener('change', () => { syncSpotifyPermUsersUI(); autoSave(); });
  if (spPermAdd) spPermAdd.onclick = addSpotifyPermUser;
  if (spPermIn) spPermIn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addSpotifyPermUser(); }
  });
  const login = document.getElementById('sp-login');
  if (login) login.onclick = () => startSpotifyLogin();
  // La ventana del callback (puerto 8888) avisa aquí en cuanto termina el login,
  // así la conexión se detecta al instante sin esperar al sondeo.
  window.addEventListener('message', (e) => {
    if (e.data === 'spotify-connected') { stopSpotifyPolling(); refreshSpotifyStatus(); }
  });
  if (IS_DESKTOP && window.desktopAPI?.onSpotifyConnected) {
    window.desktopAPI.onSpotifyConnected((data) => {
      if (data && data.ok === false) return;
      stopSpotifyPolling();
      refreshSpotifyStatus();
      toast && toast('Spotify conectado.', 'ok');
    });
  }
  if (!window._spotifyVisWired) {
    window._spotifyVisWired = true;
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) refreshSpotifyStatus();
    });
    window.addEventListener('focus', () => refreshSpotifyStatus());
  }
  const logout = document.getElementById('sp-logout');
  if (logout) logout.onclick = async () => {
    try {
      const r = await fetch('/api/spotify/logout', { method: 'POST', credentials: 'same-origin' });
      if (!r.ok) throw new Error('logout');
    } catch {
      if (typeof toast === 'function') toast('No se pudo desconectar Spotify', 'warn');
    }
    refreshSpotifyStatus();
  };
  // Botones "Copiar enlace" de las superposiciones (no están en .ovpro-card, así que
  // no los cablea setupPotCards: los conectamos aquí).
  document.querySelectorAll('#view-spotify .ovpro-urlrow').forEach((row) => {
    const code = row.querySelector('.ov-url');
    const btn = row.querySelector('.ovpro-copy, .ov-copy');
    if (code && code.dataset.path) code.textContent = roomUrl(code.dataset.path);
    if (btn && code) btn.onclick = () => {
      const url = roomUrl(code.dataset.path);
      const done = () => { btn.textContent = '¡Copiado!'; setTimeout(() => { btn.textContent = 'Copiar enlace'; }, 1200); };
      if (navigator.clipboard?.writeText) navigator.clipboard.writeText(url).then(done).catch(() => fallbackCopy(url, done));
      else fallbackCopy(url, done);
    };
  });
  applySpotifyUI();
  refreshSpotifyStatus();
}

// Copia de respaldo si el portapapeles del navegador no está disponible (foco, http, etc.).
function fallbackCopy(text, done) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.focus(); ta.select();
    document.execCommand('copy'); document.body.removeChild(ta);
    if (done) done();
  } catch {}
}

/* ====================== Webhook y Configuración (solo .exe) ====================== */
// Mapa de campos de Configuración -> ruta en settings.webhook.
const WEBHOOK_MAP = {
  'wh-rcon-host': ['rcon', 'host'], 'wh-rcon-port': ['rcon', 'port'], 'wh-rcon-pass': ['rcon', 'password'],
  'wh-obs-ip': ['obs', 'ip'], 'wh-obs-port': ['obs', 'port'], 'wh-obs-pass': ['obs', 'password'],
  'wh-sb-address': ['streamerbot', 'address'], 'wh-sb-port': ['streamerbot', 'port'],
  'wh-sb-endpoint': ['streamerbot', 'endpoint'], 'wh-sb-pass': ['streamerbot', 'password'],
  'wh-stap-enabled': ['servertap', 'enabled'], 'wh-stap-player': ['servertap', 'playername'],
  'wh-stap-ip': ['servertap', 'ip'], 'wh-stap-port': ['servertap', 'port'], 'wh-stap-key': ['servertap', 'key'],
};
const WEBHOOK_DEFAULTS = {
  rcon: { host: '127.0.0.1', port: 25575, password: '' },
  obs: { ip: '127.0.0.1', port: 4455, password: '' },
  streamerbot: { address: '127.0.0.1', port: 8080, endpoint: '/', password: '' },
  servertap: { ip: 'localhost', port: 4567, key: 'change_me', playername: '', enabled: false },
};

// La pestaña se MUESTRA en la app .exe a todos; el contenido se bloquea con un aviso
// "Solo Premium" si el plan no la incluye (el admin siempre la tiene desbloqueada).
function webhookAllowed() { return IS_DESKTOP; }
function webhookUnlocked() { return window.IS_ADMIN || capFeature('tab_webhook'); }
function revealWebhookTab() {
  const nav = document.getElementById('navWebhook');
  if (nav) nav.style.display = IS_DESKTOP ? '' : 'none';
  applyWebhookLock();
  try { syncNavSections(); } catch {}
}
function revealConfigTab() {
  const nav = document.getElementById('navConfiguracion');
  if (nav) nav.style.display = IS_DESKTOP ? '' : 'none';
  try { syncNavSections(); } catch {}
}
// Pestaña Juegos: visible para todos en la app .exe (sin bloqueo por plan).
function revealJuegosTab() {
  const nav = document.getElementById('navJuegos');
  if (nav) nav.style.display = IS_DESKTOP ? '' : 'none';
  try { syncNavSections(); } catch {}
}
// Cambia a una vista por su id completo (sin pasar por los botones del menú).
function showViewById(viewId) {
  const gameMatch = viewId.match(/^view-juego-(.+)$/);
  if (gameMatch && isGameComingSoon(gameMatch[1])) {
    toast('Este juego estará disponible próximamente.', 'warn');
    return;
  }
  document.querySelectorAll('.nav-item').forEach((b) => b.classList.remove('active'));
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
  const view = document.getElementById(viewId);
  if (view) view.classList.add('active');
  const navSlug = viewId.replace(/^view-/, '');
  const navBtn = document.querySelector(`.nav-item[data-view="${navSlug}"]`);
  if (navBtn && getComputedStyle(navBtn).display !== 'none') navBtn.classList.add('active');
  if (viewId === 'view-juego-pvzhybrid' && typeof renderPvzHybridActions === 'function') renderPvzHybridActions();
}
// Conecta las tarjetas de juego: al pulsar abren su pestaña; el botón "Volver" regresa.
function setupJuegosUI() {
  document.querySelectorAll('#view-juegos .juego-card').forEach((card) => {
    card.onclick = () => {
      if (isGameComingSoon(card.dataset.game)) {
        toast('Este juego estará disponible próximamente.', 'warn');
        return;
      }
      if (isGameLocked(card.dataset.game)) {
        toast('Este juego es Solo Premium. Mejora tu plan para usarlo ⭐', 'warn');
        return;
      }
      showViewById('view-juego-' + card.dataset.game);
    };
  });
  document.querySelectorAll('.juego-back').forEach((back) => {
    back.onclick = () => showViewById('view-juegos');
  });
  document.querySelectorAll('#view-juego-minecraft .juego-dl-btn').forEach((btn) => {
    btn.onclick = () => downloadMinecraftServer(btn.dataset.url);
  });
  const run = document.getElementById('mc-run');
  if (run) run.onclick = () => runMinecraftServer();
  const robloxPlay = document.getElementById('roblox-play');
  if (robloxPlay) robloxPlay.onclick = () => openGameLink(robloxPlay.dataset.url);
  const roblox3Play = document.getElementById('roblox3-play');
  if (roblox3Play) roblox3Play.onclick = () => openGameLink(roblox3Play.dataset.url);
  document.querySelectorAll('#view-juegos .juego-card[data-game]').forEach((card) => {
    updateGameCardLock(card);
  });
  setupRobloxActionsUI();
  setupRoblox3ActionsUI();
  setupMarioActionsUI();
  setupMarioLaunchBtn();
  setupSmb3ActionsUI();
  setupSmb3LaunchBtn();
  setupSmb3StatusPoll();
  setupMari0ActionsUI();
  setupMari0LaunchBtn();
  setupMari0StatusPoll();
  setupPvzActionsUI();
  setupPvzLaunchBtn();
  setupPvzHybridActionsUI();
  setupPvzHybridLaunchBtn();
  setupPvzHybridStatusPoll();
  setupPvzHybridDownloads();
  const change = document.getElementById('mc-change-bat');
  if (change) change.onclick = async (e) => { e.preventDefault(); await chooseMinecraftBat(true); };
  setupMcActionsUI();
  setupBedrockActionsUI();
  setupSandboxActionsUI();
  ['mc-panic', 'bedrock-panic', 'sandbox-panic'].forEach((id) => {
    const btn = document.getElementById(id);
    if (btn) btn.onclick = () => triggerAlertPanic();
  });
}

/* ================= Acciones de Minecraft (RCON) ================= */
// Catálogo de acciones predeterminadas. {playername} se sustituye por el nombre
// del usuario que activa la acción (regalo/evento); @p apunta a tu personaje.
const MC_CATALOG = [
  { id: 'mc_yunque_caida', name: 'Yunque Aplastador', desc: 'Cae para romper techos', cmd: 'execute at @p run setblock ~ ~10 ~ minecraft:anvil' },
  { id: 'mc_spawn_zombie', name: 'Invocación Zombie', desc: 'A tu lado derecho', cmd: "execute at @p run summon zombie ^1 ^ ^ {CustomName:'\"{playername}\"',CustomNameVisible:1b}" },
  { id: 'mc_spawn_skeleton', name: 'Esqueleto Arquero', desc: 'Frente a ti', cmd: "execute at @p run summon skeleton ~ ~ ~1 {CustomName:'\"El Tirador de {playername}\"',CustomNameVisible:1b}" },
  { id: 'mc_spider', name: 'Araña', desc: 'Rápida y trepadora', cmd: "execute at @p run summon spider ~1 ~ ~ {CustomName:'\"{playername}\"',CustomNameVisible:1b}" },
  { id: 'mc_cave_spider', name: 'Araña de Cueva', desc: 'Pequeña y venenosa', cmd: "execute at @p run summon cave_spider ~1 ~ ~ {CustomName:'\"{playername}\"',CustomNameVisible:1b}" },
  { id: 'mc_enderman', name: 'Enderman', desc: 'Se teletransporta', cmd: "execute at @p run summon enderman ~2 ~ ~ {CustomName:'\"{playername}\"',CustomNameVisible:1b}" },
  { id: 'mc_witch', name: 'Bruja', desc: 'Te lanza pociones', cmd: "execute at @p run summon witch ~2 ~ ~ {CustomName:'\"{playername}\"',CustomNameVisible:1b}" },
  { id: 'mc_slime', name: 'Slime Gigante', desc: 'Se divide al morir', cmd: "execute at @p run summon slime ~1 ~ ~ {Size:3, CustomName:'\"{playername}\"',CustomNameVisible:1b}" },
  { id: 'mc_phantom', name: 'Phantom', desc: 'Ataque desde el cielo', cmd: "execute at @p run summon phantom ~ ~5 ~ {CustomName:'\"{playername}\"',CustomNameVisible:1b}" },
  { id: 'mc_spawn_creeper_charged', name: 'Creeper Cargado', desc: 'Detrás de ti', cmd: "execute at @p run summon creeper ~ ~ ~-1 {powered:1b,CustomName:'\"Regalito de {playername}\"',CustomNameVisible:1b}" },
  { id: 'mc_pillager', name: 'Saqueador', desc: 'Con ballesta', cmd: "execute at @p run summon pillager ~2 ~ ~ {CustomName:'\"{playername}\"',CustomNameVisible:1b}" },
  { id: 'mc_vindicator', name: 'Vindicador', desc: 'Hachazos letales', cmd: "execute at @p run summon vindicator ~1 ~ ~ {CustomName:'\"{playername}\"',CustomNameVisible:1b}" },
  { id: 'mc_evoker', name: 'Invocador', desc: 'Magia oscura', cmd: "execute at @p run summon evoker ~3 ~ ~ {CustomName:'\"{playername}\"',CustomNameVisible:1b}" },
  { id: 'mc_ravager', name: 'Devastador', desc: 'Toro gigante letal', cmd: "execute at @p run summon ravager ~2 ~ ~ {CustomName:'\"{playername}\"',CustomNameVisible:1b}" },
  { id: 'mc_warden', name: 'El Warden', desc: 'MUERTE INSTANTÁNEA', cmd: "execute at @p run summon warden ~3 ~ ~ {CustomName:'\"{playername}\"',CustomNameVisible:1b}" },
  { id: 'mc_wither', name: 'Jefe: Wither', desc: 'Destruirá tu mundo', cmd: "execute at @p run summon wither ~ ~2 ~ {CustomName:'\"{playername}\"',CustomNameVisible:1b}" },
  { id: 'mc_blaze', name: 'Blaze', desc: 'Dispara fuego', cmd: "execute at @p run summon blaze ~2 ~ ~ {CustomName:'\"{playername}\"',CustomNameVisible:1b}" },
  { id: 'mc_ghast', name: 'Ghast', desc: 'Bolas de fuego gigantes', cmd: "execute at @p run summon ghast ~ ~5 ~ {CustomName:'\"{playername}\"',CustomNameVisible:1b}" },
  { id: 'mc_wither_skeleton', name: 'Esqueleto Wither', desc: 'Te da efecto Wither', cmd: "execute at @p run summon wither_skeleton ~1 ~ ~ {CustomName:'\"{playername}\"',CustomNameVisible:1b}" },
  { id: 'mc_piglin_brute', name: 'Piglin Bruto', desc: 'Daño masivo con hacha', cmd: "execute at @p run summon piglin_brute ~1 ~ ~ {CustomName:'\"{playername}\"',CustomNameVisible:1b}" },
  { id: 'mc_hoglin', name: 'Hoglin', desc: 'Jabalí agresivo', cmd: "execute at @p run summon hoglin ~2 ~ ~ {CustomName:'\"{playername}\"',CustomNameVisible:1b}" },
  { id: 'mc_magma_cube', name: 'Cubo de Magma', desc: 'Slime de fuego', cmd: "execute at @p run summon magma_cube ~1 ~ ~ {Size:3, CustomName:'\"{playername}\"',CustomNameVisible:1b}" },
  { id: 'mc_pig', name: 'Cerdito', desc: 'Oink oink', cmd: "execute at @p run summon pig ~1 ~ ~ {CustomName:'\"{playername}\"',CustomNameVisible:1b}" },
  { id: 'mc_cow', name: 'Vaca', desc: 'Muuu', cmd: "execute at @p run summon cow ~1 ~ ~ {CustomName:'\"{playername}\"',CustomNameVisible:1b}" },
  { id: 'mc_chicken', name: 'Pollo', desc: 'Pone huevos', cmd: "execute at @p run summon chicken ~1 ~ ~ {CustomName:'\"{playername}\"',CustomNameVisible:1b}" },
  { id: 'mc_wolf', name: 'Lobo Enojado', desc: 'Te atacará al instante', cmd: "execute at @p run summon wolf ~1 ~ ~ {AngryAt:[I;0,0,0,0], CustomName:'\"{playername}\"',CustomNameVisible:1b}" },
  { id: 'mc_iron_golem', name: 'Golem de Hierro', desc: 'El guardaespaldas', cmd: "execute at @p run summon iron_golem ~2 ~ ~ {CustomName:'\"{playername}\"',CustomNameVisible:1b}" },
  { id: 'mc_axolotl', name: 'Ajolote', desc: 'Lindo y amigable', cmd: "execute at @p run summon axolotl ~1 ~ ~ {CustomName:'\"{playername}\"',CustomNameVisible:1b}" },
  { id: 'mc_villager', name: 'Aldeano', desc: 'Hmm...', cmd: "execute at @p run summon villager ~1 ~ ~ {CustomName:'\"{playername}\"',CustomNameVisible:1b}" },
  { id: 'mc_spawn_tnt', name: 'TNT Encendida', desc: 'A tu lado', cmd: 'execute at @p run summon tnt ~1 ~ ~ {Fuse:60}' },
  { id: 'mc_lava_drop', name: 'Cubo de Lava', desc: 'Bloque en el suelo', cmd: 'execute at @p run setblock ~ ~ ~ minecraft:lava' },
  { id: 'mc_lightning', name: 'Rayo Mortal', desc: 'En tu posición', cmd: 'execute at @p run summon lightning_bolt ~ ~ ~' },
  { id: 'mc_prison', name: 'Cárcel de Cristal', desc: 'Te encierra', cmd: 'execute at @p run fill ~-1 ~ ~-1 ~1 ~2 ~1 minecraft:glass outline' },
  { id: 'mc_golden_apple', name: 'Manzana Dorada Encantada', desc: 'Se añade a tu inventario', cmd: 'give @p minecraft:enchanted_golden_apple 1' },
  { id: 'mc_totem', name: 'Tótem de Inmortalidad', desc: 'Te da una segunda oportunidad', cmd: 'give @p minecraft:totem_of_undying 1' },
  { id: 'mc_apple', name: 'Manzanas', desc: 'Van a tu inventario', cmd: 'give @p minecraft:apple 5' },
  { id: 'mc_diamond_kit', name: 'Kit Diamante', desc: 'Full Armadura + Espada', cmd: 'item replace entity @p armor.head with minecraft:diamond_helmet ;; item replace entity @p armor.chest with minecraft:diamond_chestplate ;; item replace entity @p armor.legs with minecraft:diamond_leggings ;; item replace entity @p armor.feet with minecraft:diamond_boots ;; give @p minecraft:diamond_sword 1' },
  { id: 'mc_diamond_helmet', name: 'Armadura Diamante', desc: 'Se equipa automáticamente', cmd: 'item replace entity @p armor.head with minecraft:diamond_helmet' },
];

// Etiquetas de los disparadores (eventos del live).
const MC_TRIGGERS = [
  { v: 'gift', label: 'Regalo específico' },
  { v: 'gift-any', label: 'Cualquier regalo' },
  { v: 'like', label: 'Likes (por usuario)' },
  { v: 'likeGlobal', label: 'Likes globales' },
  { v: 'follow', label: 'Nuevo seguidor' },
  { v: 'share', label: 'Compartida' },
  { v: 'subscribe', label: 'Nuevo suscriptor' },
  { v: 'superFan', label: 'Super fan' },
  { v: 'levelUp', label: 'Subió de nivel de miembro' },
  { v: 'chatUser', label: 'Mensaje de un usuario' },
  { v: 'chatCommand', label: 'Comando de chat' },
  { v: 'firstMessage', label: 'Primer mensaje en el chat' },
];
// Icono por tipo de evento (para mostrarlo en la tarjeta agregada).
const MC_TRIG_ICON = {
  'gift-any': { ic: '🎁', label: 'Cualquier regalo' },
  like: { ic: '❤️', label: 'Likes' },
  likeGlobal: { ic: '💗', label: 'Likes globales' },
  follow: { ic: '➕', label: 'Seguidor' },
  share: { ic: '🔁', label: 'Compartida' },
  subscribe: { ic: '⭐', label: 'Suscriptor' },
  superFan: { ic: '🌟', label: 'Super fan' },
  levelUp: { ic: '⬆️', label: 'Subió de nivel' },
  chatUser: { ic: '🙋', label: 'Mensaje de usuario' },
  chatCommand: { ic: '💬', label: 'Comando de chat' },
  firstMessage: { ic: '🆕', label: 'Primer mensaje' },
};

const GAME_ACTION_SETTINGS_KEYS = ['marioActions', 'smb3Actions', 'mari0Actions', 'pvzActions', 'pvzHybridActions'];
let lastGameActionEditAt = 0;

function gameActionGiftUi(a, giftClass) {
  const t = a.trigger || 'gift';
  const uid = esc(a.uid);
  if (t === 'gift') {
    const ic = a.giftImage ? `<img class="mc-gift-ic" src="${esc(a.giftImage)}" onerror="this.outerHTML='🎁'">` : '🎁';
    return `<button type="button" class="mc-gift-btn ${giftClass}" data-uid="${uid}">${ic}<span class="mc-gift-name">${a.giftName ? esc(a.giftName) : 'Elegir regalo'}</span></button>`;
  }
  const ev = MC_TRIG_ICON[t] || { ic: '⚡', label: t };
  const lbl = (MC_TRIGGERS.find((x) => x.v === t) || {}).label || ev.label;
  return `<div class="mc-ev-badge"><span class="mc-ev-ic">${ev.ic}</span><span class="mc-gift-name">${esc(lbl)}</span></div>`;
}
function gameActionExtraRow(a, likeClass, textClass) {
  const uid = esc(a.uid);
  if (a.trigger === 'like' || a.trigger === 'likeGlobal') {
    const defN = a.trigger === 'likeGlobal' ? 100 : 1;
    const val = a.likeN != null ? a.likeN : defN;
    const txt = a.trigger === 'likeGlobal' ? 'Cada cuántos likes globales' : 'Mínimo de likes (por tanda)';
    return `<label class="mc-like-row">${txt}<input type="number" min="1" class="${likeClass}" data-uid="${uid}" value="${esc(String(val))}"></label>`;
  }
  if (a.trigger === 'chatUser' || a.trigger === 'chatCommand') {
    const txt = a.trigger === 'chatUser' ? 'Nombre de usuario (sin @)' : 'Palabra o comando (ej. !goomba)';
    const ph = a.trigger === 'chatUser' ? 'usuario123' : '!goomba';
    return `<label class="mc-like-row">${txt}<input type="text" class="${textClass}" data-uid="${uid}" value="${esc(a.text || '')}" placeholder="${ph}"></label>`;
  }
  return '';
}
function setGameActionTrigger(settingsKey, uid, value, renderFn) {
  if (!settings || !uid || !settingsKey) return;
  const a = (settings[settingsKey] || []).find((x) => x && x.uid === uid);
  if (!a) return;
  a.trigger = value;
  if (value !== 'gift') {
    a.giftId = '';
    a.giftName = '';
    a.giftImage = '';
    a.comboInstant = false;
  }
  if (value === 'like') a.likeN = Math.max(1, parseInt(a.likeN, 10) || 1);
  else if (value === 'likeGlobal') a.likeN = Math.max(1, parseInt(a.likeN, 10) || 100);
  else if (value !== 'chatUser' && value !== 'chatCommand') a.text = '';
  lastGameActionEditAt = Date.now();
  flushSaveSettings();
  if (renderFn) renderFn();
}
function bindGameTriggerSelects(wrap, selClass, settingsKey, renderFn) {
  wrap.querySelectorAll('.' + selClass).forEach((s) => {
    const handler = () => {
      const uid = (s.closest('.mc-act-card') && s.closest('.mc-act-card').dataset.uid) || s.dataset.uid;
      setGameActionTrigger(settingsKey, uid, s.value, renderFn);
    };
    s.onchange = handler;
  });
}
function preserveLocalGameActionsOnSettingsEcho(incoming) {
  if (!incoming || Date.now() - lastGameActionEditAt > 1200 || !settings) return incoming;
  const out = { ...incoming };
  for (const k of GAME_ACTION_SETTINGS_KEYS) {
    if (Array.isArray(settings[k]) && settings[k].length) out[k] = settings[k];
  }
  return out;
}
function applyGameActionGift(settingsKey, uid, g, renderFn) {
  const act = (settings?.[settingsKey] || []).find((x) => x && x.uid === uid);
  if (!act || !g) return;
  act.giftId = String(g.id || '');
  act.giftName = String(g.name || '').trim();
  act.giftImage = g.image || '';
  lastGameActionEditAt = Date.now();
  flushSaveSettings();
  if (renderFn) renderFn();
}
function bindGameActionGiftButtons(wrap, btnClass, settingsKey, renderFn) {
  wrap.querySelectorAll('.' + btnClass).forEach((b) => {
    b.onclick = () => {
      const uid = b.dataset.uid;
      if (!uid || !(settings?.[settingsKey] || []).some((x) => x && x.uid === uid)) return;
      openGiftModalCb((g) => applyGameActionGift(settingsKey, uid, g, renderFn));
    };
  });
}

// Exporta las tarjetas de acciones de Minecraft (mcActions) a un archivo de presets.
function exportMcPresets() {
  const list = (settings && Array.isArray(settings.mcActions)) ? settings.mcActions : [];
  if (!list.length) { toast && toast('No hay acciones de Minecraft para exportar.', 'warn'); return; }
  const out = { type: 'livecoins-mc-presets', version: 1, exportedAt: Date.now(), mcActions: list };
  const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `minecraft-presets-${window.MY_USER || 'panel'}-${Date.now()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => { try { URL.revokeObjectURL(a.href); } catch {} }, 1000);
  toast && toast(`Exportadas ${list.length} acciones de Minecraft.`, 'ok');
}

// Diálogo: ¿añadir a las actuales o reemplazar todas? Devuelve 'merge' | 'replace' | null.
function askGameImportMode(count, subjectLabel) {
  const subject = subjectLabel || 'las acciones';
  return new Promise((resolve) => {
    const back = document.createElement('div');
    back.className = 'modal confirm-modal';
    back.innerHTML = `
      <div class="confirm-box">
        <div class="confirm-ico">📦</div>
        <h3>Importar ${count} ${count === 1 ? 'acción' : 'acciones'}</h3>
        <p>¿Cómo quieres importar ${subject}?</p>
        <div class="confirm-btns">
          <button class="btn ghost c-cancel">Cancelar</button>
          <button class="btn c-merge">Añadir a las actuales</button>
          <button class="btn danger c-replace">Borrar y reemplazar</button>
        </div>
      </div>`;
    document.body.appendChild(back);
    const close = (val) => { back.remove(); resolve(val); };
    back.querySelector('.c-cancel').onclick = () => close(null);
    back.querySelector('.c-merge').onclick = () => close('merge');
    back.querySelector('.c-replace').onclick = () => close('replace');
    back.addEventListener('click', (e) => { if (e.target === back) close(null); });
    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape') { document.removeEventListener('keydown', esc); close(null); }
    });
  });
}
function askMcImportMode(count) {
  return askGameImportMode(count, 'los presets de Minecraft');
}

// Importa acciones de Minecraft desde un archivo de presets, fusionando o reemplazando.
async function importMcPresets(file) {
  if (!settings) { toast && toast('Espera a que cargue el panel…', 'warn'); return; }
  let parsed;
  try { parsed = JSON.parse(await file.text()); }
  catch { toast && toast('El archivo no es un preset válido.', 'warn'); return; }
  const incoming = Array.isArray(parsed)
    ? parsed
    : (parsed && Array.isArray(parsed.mcActions) ? parsed.mcActions : null);
  if (!incoming || !incoming.length) { toast && toast('El archivo no contiene acciones de Minecraft.', 'warn'); return; }
  const mode = await askMcImportMode(incoming.length);
  if (!mode) return;
  // Regeneramos el uid de cada tarjeta para que no choque con las existentes.
  const clean = incoming
    .filter((a) => a && typeof a === 'object')
    .map((a, i) => ({ ...a, uid: 'mca_' + Date.now() + '_' + i + '_' + Math.random().toString(36).slice(2, 7) }));
  if (!Array.isArray(settings.mcActions)) settings.mcActions = [];
  settings.mcActions = (mode === 'replace') ? clean : settings.mcActions.concat(clean);
  saveSettings();
  renderMyMcActions();
  toast && toast(`Importadas ${clean.length} acciones (${mode === 'replace' ? 'reemplazo' : 'añadidas'}).`, 'ok');
}

function setupMcActionsUI() {
  const search = document.getElementById('mc-cat-search');
  if (search && !search._wired) {
    search._wired = true;
    search.oninput = () => renderMcCatalog(search.value);
  }
  const createBtn = document.getElementById('mc-create-cmd');
  if (createBtn && !createBtn._wired) {
    createBtn._wired = true;
    createBtn.onclick = () => { if (!settings) { toast && toast('Espera a que cargue el panel…', 'warn'); return; } openMcCmdModal(null); };
  }
  const genImgBtn = document.getElementById('mc-gen-img');
  if (genImgBtn && !genImgBtn._wired) {
    genImgBtn._wired = true;
    genImgBtn.onclick = () => generateMcMenuImage();
  }
  const expBtn = document.getElementById('mc-export-preset');
  if (expBtn && !expBtn._wired) { expBtn._wired = true; expBtn.onclick = exportMcPresets; }
  const impBtn = document.getElementById('mc-import-preset');
  const impFile = document.getElementById('mc-import-file');
  if (impBtn && impFile && !impBtn._wired) {
    impBtn._wired = true;
    impBtn.onclick = () => { if (!settings) { toast && toast('Espera a que cargue el panel…', 'warn'); return; } impFile.click(); };
    impFile.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (file) await importMcPresets(file);
    });
  }
  const mAdd = document.getElementById('mcc-add');
  if (mAdd && !mAdd._wired) {
    mAdd._wired = true;
    mAdd.onclick = () => {
      const cur = collectMccEntries();
      if (cur.length >= MCC_MAX_CMDS) { toast && toast(`Máximo ${MCC_MAX_CMDS} comandos.`, 'warn'); return; }
      if (isMccExtraMode()) cur.push(mccDefaultEntry());
      else cur.push('');
      renderMccLines(cur);
    };
  }
  const mVarsBtn = document.getElementById('mcc-vars-btn');
  if (mVarsBtn && !mVarsBtn._wired) {
    mVarsBtn._wired = true;
    mVarsBtn.onclick = (e) => { e.stopPropagation(); openMccVarsPop(); };
  }
  const mVarsClose = document.getElementById('mcc-vars-close');
  if (mVarsClose && !mVarsClose._wired) {
    mVarsClose._wired = true;
    mVarsClose.onclick = (e) => { e.stopPropagation(); closeMccVarsPop(); };
  }
  const mVarsOverlay = document.getElementById('mcc-vars-overlay');
  if (mVarsOverlay && !mVarsOverlay._wired) {
    mVarsOverlay._wired = true;
    mVarsOverlay.addEventListener('click', (e) => { if (e.target === mVarsOverlay) closeMccVarsPop(); });
    mVarsOverlay.querySelector('.mcc-vars-pop')?.addEventListener('click', (e) => e.stopPropagation());
  }
  const mExtra = document.getElementById('mcc-extra');
  if (mExtra && !mExtra._wired) {
    mExtra._wired = true;
    mExtra.onchange = () => {
      syncMccExtraUI();
      renderMccLines(collectMccEntries());
    };
  }
  const mSave = document.getElementById('mcc-save');
  if (mSave && !mSave._wired) { mSave._wired = true; mSave.onclick = saveMcCmd; }
  const mCancel = document.getElementById('mcc-cancel');
  if (mCancel && !mCancel._wired) { mCancel._wired = true; mCancel.onclick = closeMcCmdModal; }
  const mModal = document.getElementById('mcCmdModal');
  if (mModal && !mModal._wired) { mModal._wired = true; mModal.addEventListener('click', (e) => { if (e.target.id === 'mcCmdModal') closeMcCmdModal(); }); }
  const imgBtn = document.getElementById('mcc-img-btn');
  if (imgBtn && !imgBtn._wired) { imgBtn._wired = true; imgBtn.onclick = () => document.getElementById('mcc-img-file').click(); }
  const imgClear = document.getElementById('mcc-img-clear');
  if (imgClear && !imgClear._wired) { imgClear._wired = true; imgClear.onclick = () => setMccImage(''); }
  const imgFile = document.getElementById('mcc-img-file');
  if (imgFile && !imgFile._wired) {
    imgFile._wired = true;
    imgFile.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      document.getElementById('mcc-status').textContent = 'Subiendo imagen…';
      try {
        const res = await fetch('/api/upload?name=' + encodeURIComponent(file.name), { method: 'POST', body: file });
        const data = await res.json();
        if (!data.url) throw new Error();
        setMccImage(data.url);
        document.getElementById('mcc-status').textContent = '';
      } catch { document.getElementById('mcc-status').textContent = '⚠️ No se pudo subir la imagen.'; }
    });
  }
  renderMcCatalog(search ? search.value : '');
  renderMyMcActions();
}

let mccImage = '';
function setMccImage(url) {
  mccImage = url || '';
  const prev = document.getElementById('mcc-img-prev');
  const ph = document.getElementById('mcc-img-ph');
  const clear = document.getElementById('mcc-img-clear');
  if (mccImage) {
    prev.src = mccImage; prev.style.display = '';
    ph.style.display = 'none';
    clear.style.display = '';
  } else {
    prev.removeAttribute('src'); prev.style.display = 'none';
    ph.style.display = '';
    clear.style.display = 'none';
  }
}

// Mapa de juegos que usan el sistema de tarjetas tipo Minecraft (comando + disparador).
const MC_GAME_MAP = {
  minecraft: { key: 'mcActions', label: 'Minecraft', render: () => renderMyMcActions() },
  bedrock: { key: 'bedrockActions', label: 'Bedrock', render: () => renderMyBedrockActions() },
  sandbox: { key: 'sandboxActions', label: 'Sandbox', render: () => renderMySandboxActions() },
};

let mccEditingUid = null;
let mccGame = 'minecraft'; // a qué pestaña pertenece el comando que se edita/crea
const MCC_MAX_CMDS = 15;

function updateMccCmdCount(n) {
  const el = document.getElementById('mcc-cmd-count');
  if (el) el.textContent = `${Math.min(MCC_MAX_CMDS, n || 0)}/${MCC_MAX_CMDS}`;
}
function openMccVarsPop() {
  const o = document.getElementById('mcc-vars-overlay');
  if (o) { o.classList.remove('hidden'); o.setAttribute('aria-hidden', 'false'); }
}
function closeMccVarsPop() {
  const o = document.getElementById('mcc-vars-overlay');
  if (o) { o.classList.add('hidden'); o.setAttribute('aria-hidden', 'true'); }
}
function openMcCmdModal(a, game) {
  closeMccVarsPop();
  mccGame = game || (a && a.game) || 'minecraft';
  mccEditingUid = a && a.uid ? a.uid : null;
  const gameLabel = (MC_GAME_MAP[mccGame] || MC_GAME_MAP.minecraft).label;
  document.getElementById('mcc-title').textContent = a ? 'Editar comando personalizado' : ('Comando personalizado de ' + gameLabel);
  document.getElementById('mcc-name').value = a?.name || '';
  document.getElementById('mcc-desc').value = a?.desc || '';
  document.getElementById('mcc-repeat').value = a?.repeat || 1;
  document.getElementById('mcc-delayeach').value = a?.delayEach || 0;
  document.getElementById('mcc-delaygroup').value = a?.delayGroup || 0;
  document.getElementById('mcc-radius').value = a?.radius != null ? a.radius : 3;
  const multEl = document.getElementById('mcc-mult');
  if (multEl) multEl.checked = a ? a.giftMult !== false : true;
  document.getElementById('mcc-random').checked = !!a?.random;
  const extraOn = a
    ? !!(a.cmdsExtra || (Array.isArray(a.cmds) && a.cmds.some((x) => x && typeof x === 'object')))
    : true;
  document.getElementById('mcc-extra').checked = extraOn;
  document.getElementById('mcc-status').textContent = '';
  setMccImage(a?.image || '');
  syncMccExtraUI();
  renderMccLines(normalizeMccEntries(a?.cmds, a));
  document.getElementById('mcCmdModal').classList.remove('hidden');
}
function closeMcCmdModal() {
  closeMccVarsPop();
  document.getElementById('mcCmdModal').classList.add('hidden');
}

function isMccExtraMode() { return !!document.getElementById('mcc-extra')?.checked; }
function mccDefaultEntry() {
  return {
    cmd: '',
    repeat: 1,
    delayEach: 100,
    delayBefore: 0,
    radius: Math.max(0, parseInt(document.getElementById('mcc-radius')?.value, 10) || 3),
  };
}
function normalizeMccEntries(raw, action) {
  const extra = action?.cmdsExtra || isMccExtraMode();
  const defs = {
    repeat: action?.repeat ?? (Math.max(1, parseInt(document.getElementById('mcc-repeat')?.value, 10) || 1)),
    radius: action?.radius ?? (Math.max(0, parseInt(document.getElementById('mcc-radius')?.value, 10) || 3)),
  };
  if (!Array.isArray(raw) || !raw.length) return extra ? [mccDefaultEntry()] : [''];
  if (!extra) return raw.map((e) => (typeof e === 'string' ? e : (e?.cmd || e?.text || '')));
  return raw.map((e) => {
    const o = (e && typeof e === 'object') ? e : { cmd: String(e || '') };
    return {
      cmd: o.cmd || o.text || '',
      repeat: o.repeat != null ? o.repeat : defs.repeat,
      delayEach: o.delayEach != null ? o.delayEach : 100,
      delayBefore: o.delayBefore != null ? o.delayBefore : (o.delayGroup != null ? o.delayGroup : 0),
      radius: o.radius != null ? o.radius : defs.radius,
    };
  });
}
function syncMccExtraUI() {
  const on = isMccExtraMode();
  const radiusRow = document.getElementById('mcc-radius-row');
  if (radiusRow) radiusRow.style.display = on ? '' : 'none';
}
function renderMccLines(lines) {
  const box = document.getElementById('mcc-cmds');
  if (!box) return;
  const extra = isMccExtraMode();
  const list = extra
    ? (lines.length ? lines : [mccDefaultEntry()])
    : (lines.length ? lines.map((l) => (typeof l === 'string' ? l : (l?.cmd || ''))) : ['']);
  updateMccCmdCount(list.length);
  box.innerHTML = list.map((l, i) => {
    const cmd = extra ? (l.cmd || '') : l;
    const extraFields = extra ? `
      <div class="mcc-line-times">
        <label class="mcc-time-field"><span class="mcc-time-lbl">Repetición</span><input type="number" class="mcc-x-repeat" min="1" value="${Math.max(1, parseInt(l.repeat, 10) || 1)}"></label>
        <label class="mcc-time-field"><span class="mcc-time-lbl">Retraso (ms)</span><input type="number" class="mcc-x-delaybefore" min="0" value="${Math.max(0, parseInt(l.delayBefore, 10) || 0)}" title="Milisegundos desde el inicio de la acción hasta el primer spawn de este comando"></label>
        <label class="mcc-time-field"><span class="mcc-time-lbl">Intervalo (ms)</span><input type="number" class="mcc-x-delayeach" min="0" value="${Math.max(0, parseInt(l.delayEach, 10) || 100)}" title="Pausa entre cada repetición del mismo comando (sumada al retraso)"></label>
      </div>` : '';
    return `
    <div class="mcc-line">
      <div class="mcc-line-head">
        <span class="mcc-line-num">#${i + 1} Comando</span>
        <div class="mcc-line-btns">
          <button type="button" class="mcc-play" data-i="${i}" title="Probar en el juego">▶</button>
          <button type="button" class="mcc-line-del" data-i="${i}" title="Quitar">✕</button>
        </div>
      </div>
      ${extraFields}
      <textarea class="mcc-line-ta" rows="2" placeholder="Comando sin / inicial (ej. survival villager {nickname})">${esc(cmd)}</textarea>
    </div>`;
  }).join('');
  box.querySelectorAll('.mcc-line-del').forEach((b) => b.onclick = () => {
    const cur = collectMccEntries();
    cur.splice(+b.dataset.i, 1);
    renderMccLines(cur.length ? cur : (extra ? [mccDefaultEntry()] : ['']));
  });
  box.querySelectorAll('.mcc-play').forEach((b) => b.onclick = () => testMccLine(+b.dataset.i));
}
function testMccLine(i) {
  if (ws?.readyState !== WebSocket.OPEN) {
    toast && toast('Sin conexión al servidor. Espera a que el panel conecte.', 'warn');
    return;
  }
  const extra = isMccExtraMode();
  const entries = collectMccEntries();
  const raw = entries[i];
  const cmd = extra ? (raw?.cmd || '').trim() : String(raw || '').trim();
  if (!cmd) { toast && toast('Escribe un comando antes de probar.', 'warn'); return; }
  const entry = extra ? {
    cmd,
    repeat: Math.max(1, parseInt(raw.repeat, 10) || 1),
    delayEach: Math.max(0, parseInt(raw.delayEach, 10) || 0),
    delayBefore: Math.max(0, parseInt(raw.delayBefore, 10) || 0),
    radius: Math.max(0, parseInt(document.getElementById('mcc-radius')?.value, 10) || 3),
  } : { cmd };
  send({
    action: 'testMcDraft',
    entry,
    radius: Math.max(0, parseInt(document.getElementById('mcc-radius')?.value, 10) || 3),
    cmdsExtra: extra,
    giftMult: document.getElementById('mcc-mult')?.checked !== false,
  });
  toast && toast('Enviando comando de prueba al juego…', 'ok');
}
function collectMccEntries() {
  const extra = isMccExtraMode();
  const lines = [...document.querySelectorAll('#mcc-cmds .mcc-line')];
  if (!extra) return lines.map((row) => row.querySelector('.mcc-line-ta')?.value || '');
  return lines.map((row) => ({
    cmd: row.querySelector('.mcc-line-ta')?.value || '',
    repeat: Math.max(1, parseInt(row.querySelector('.mcc-x-repeat')?.value, 10) || 1),
    delayEach: Math.max(0, parseInt(row.querySelector('.mcc-x-delayeach')?.value, 10) || 0),
    delayBefore: Math.max(0, parseInt(row.querySelector('.mcc-x-delaybefore')?.value, 10) || 0),
    radius: Math.max(0, parseInt(document.getElementById('mcc-radius')?.value, 10) || 3),
  }));
}
function saveMcCmd() {
  if (!settings) return;
  const name = document.getElementById('mcc-name').value.trim();
  if (!name) { document.getElementById('mcc-status').textContent = '⚠️ Escribe un nombre.'; return; }
  const extra = isMccExtraMode();
  const entries = collectMccEntries();
  let cmds;
  if (extra) {
    cmds = entries
      .filter((e) => (e.cmd || '').trim())
      .map((e) => ({
        cmd: e.cmd.trim(),
        repeat: e.repeat,
        delayEach: e.delayEach,
        delayBefore: e.delayBefore,
        radius: e.radius,
      }));
  } else {
    cmds = entries.map((s) => String(s).trim()).filter(Boolean);
  }
  if (!cmds.length) { document.getElementById('mcc-status').textContent = '⚠️ Escribe al menos un comando.'; return; }
  const payload = {
    name, desc: document.getElementById('mcc-desc').value.trim(),
    cmds,
    cmdsExtra: extra,
    repeat: Math.max(1, parseInt(document.getElementById('mcc-repeat').value, 10) || 1),
    delayEach: Math.max(0, parseInt(document.getElementById('mcc-delayeach').value, 10) || 0),
    delayGroup: Math.max(0, parseInt(document.getElementById('mcc-delaygroup').value, 10) || 0),
    radius: Math.max(0, parseInt(document.getElementById('mcc-radius').value, 10) || 0),
    random: document.getElementById('mcc-random').checked,
    image: mccImage || '',
    custom: true,
  };
  if (document.getElementById('mcc-mult')?.checked === false) payload.giftMult = false;
  const g = MC_GAME_MAP[mccGame] || MC_GAME_MAP.minecraft;
  const key = g.key;
  if (!Array.isArray(settings[key])) settings[key] = [];
  if (mccEditingUid) {
    const a = settings[key].find((x) => x.uid === mccEditingUid);
    if (a) {
      Object.assign(a, payload);
      if (document.getElementById('mcc-mult')?.checked === false) a.giftMult = false;
      else delete a.giftMult;
    }
  } else {
    settings[key].push({
      uid: 'mca_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      catId: '', game: mccGame,
      trigger: 'gift', giftId: '', giftName: '', giftImage: '', enabled: true, ...payload,
    });
  }
  saveSettings();
  g.render();
  closeMcCmdModal();
  toast && toast('Comando personalizado guardado.', 'ok');
}

function renderMcCatalog(filter) {
  const grid = document.getElementById('mc-catalog');
  if (!grid) return;
  const f = (filter || '').trim().toLowerCase();
  const list = f ? MC_CATALOG.filter((c) => c.name.toLowerCase().includes(f) || c.desc.toLowerCase().includes(f)) : MC_CATALOG;
  if (!list.length) { grid.innerHTML = '<div class="empty">Sin resultados</div>'; return; }
  grid.innerHTML = list.map((c) => `
    <div class="mc-cat-card" data-id="${esc(c.id)}" title="${esc(c.cmd)}">
      <div class="mc-cat-head-row">
        <img class="mc-cat-ic" src="/img/minecraft/${esc(c.id)}.png" alt="" onerror="this.style.display='none'">
        <div class="mc-cat-texts">
          <div class="mc-cat-name">${esc(c.name)}</div>
          <div class="mc-cat-desc">${esc(c.desc)}</div>
        </div>
      </div>
      <button type="button" class="mc-cat-add">+ Agregar</button>
    </div>`).join('');
  grid.querySelectorAll('.mc-cat-card').forEach((card) => {
    card.querySelector('.mc-cat-add').onclick = () => addMcAction(card.dataset.id);
  });
}

function addMcAction(catId) {
  const c = MC_CATALOG.find((x) => x.id === catId);
  if (!c) return;
  if (!settings) { toast && toast('Espera a que cargue el panel…', 'warn'); return; }
  if (!Array.isArray(settings.mcActions)) settings.mcActions = [];
  settings.mcActions.push({
    uid: 'mca_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
    catId: c.id, name: c.name, desc: c.desc, cmd: c.cmd,
    trigger: 'gift', giftId: '', giftName: '', giftImage: '', enabled: true, count: 1,
  });
  saveSettings();
  renderMyMcActions();
  toast && toast(`Acción "${c.name}" agregada. Elige el regalo o evento.`, 'ok');
}

function mcCardQtyHtml(a) {
  if (a.custom) return '';
  return `<label class="mc-qty-row" title="Cuántos spawns/comandos por cada unidad del regalo. Si envían 2 rosas y pones 30, salen 60.">Cantidad a enviar
          <input type="number" min="1" max="100" class="mc-qty-n" data-uid="${esc(a.uid)}" value="${esc(String(Math.max(1, parseInt(a.count, 10) || 1)))}"></label>`;
}
function mcCardComboInstantHtml(a) {
  if (a.trigger !== 'gift' && a.trigger !== 'gift-any') return '';
  const on = a.comboInstant !== false;
  return `<label class="mc-combo-instant mcc-check">
        <input type="checkbox" class="mc-combo-instant-en" data-uid="${esc(a.uid)}" ${on ? 'checked' : ''}>
        <span><b class="mc-combo-instant-lbl">Llamada instantánea</b> <span class="mc-combo-instant-sub">(cada rosa en racha; si desmarcas, al final de la racha)</span></span>
      </label>`;
}
function bindMcActionCardCommon(wrap, find, render) {
  wrap.querySelectorAll('.mc-combo-instant-en').forEach((c) => c.onchange = () => {
    const a = find(c.dataset.uid); if (!a) return;
    a.comboInstant = c.checked;
    saveSettings();
  });
}

function renderMyMcActions() {
  const wrap = document.getElementById('mc-my-actions');
  if (!wrap) return;
  const list = (settings && Array.isArray(settings.mcActions)) ? settings.mcActions : [];
  if (!list.length) {
    wrap.innerHTML = '<div class="mc-empty">Aún no agregaste acciones. Elige una del catálogo de abajo.</div>';
    return;
  }
  wrap.innerHTML = list.map((a) => {
    const opts = MC_TRIGGERS.map((t) => `<option value="${t.v}" ${a.trigger === t.v ? 'selected' : ''}>${t.label}</option>`).join('');
    let giftBtn = '';
    if (a.trigger === 'gift') {
      const ic = a.giftImage
        ? `<img class="mc-gift-ic" src="${esc(a.giftImage)}" onerror="this.outerHTML='🎁'">`
        : '🎁';
      giftBtn = `<button type="button" class="mc-gift-btn" data-uid="${esc(a.uid)}">${ic}<span class="mc-gift-name">${a.giftName ? esc(a.giftName) : 'Elegir regalo'}</span></button>`;
    } else {
      const ev = MC_TRIG_ICON[a.trigger] || { ic: '⚡', label: a.trigger };
      const lbl = (MC_TRIGGERS.find((t) => t.v === a.trigger) || {}).label || ev.label;
      giftBtn = `<div class="mc-ev-badge"><span class="mc-ev-ic">${ev.ic}</span><span class="mc-gift-name">${esc(lbl)}</span></div>`;
    }
    let likeRow = '';
    if (a.trigger === 'like' || a.trigger === 'likeGlobal') {
      const defN = a.trigger === 'likeGlobal' ? 100 : 1;
      const val = a.likeN != null ? a.likeN : defN;
      const txt = a.trigger === 'likeGlobal' ? 'Cada cuántos likes globales' : 'Mínimo de likes (por tanda)';
      likeRow = `<label class="mc-like-row">${txt}
        <input type="number" min="1" class="mc-like-n" data-uid="${esc(a.uid)}" value="${esc(String(val))}"></label>`;
    } else if (a.trigger === 'chatUser' || a.trigger === 'chatCommand') {
      const txt = a.trigger === 'chatUser' ? 'Nombre de usuario (sin @)' : 'Palabra o comando (ej. !zombie)';
      const ph = a.trigger === 'chatUser' ? 'usuario123' : '!zombie';
      likeRow = `<label class="mc-like-row">${txt}
        <input type="text" class="mc-text-n" data-uid="${esc(a.uid)}" value="${esc(a.text || '')}" placeholder="${ph}"></label>`;
    }
    const audioOn = !!a.audioOn;
    const vol = a.soundVolume != null ? Math.max(0, Math.min(100, parseInt(a.soundVolume, 10) || 0)) : 100;
    const hasSound = !!(a.sound);
    const audioBlock = `
      <div class="mc-audio-wrap">
        <label class="mc-audio-on"><input type="checkbox" class="mc-audio-en" data-uid="${esc(a.uid)}" ${audioOn ? 'checked' : ''}> Audio</label>
        <div class="mc-audio-box"${audioOn ? '' : ' hidden'}>
          <div class="mc-audio-picks">
            <button type="button" class="btn ghost sm mc-audio-lib" data-uid="${esc(a.uid)}">Biblioteca</button>
            <button type="button" class="btn ghost sm mc-audio-up" data-uid="${esc(a.uid)}">Subir</button>
          </div>
          <div class="mc-audio-chosen">
            <span class="mc-audio-name">${hasSound ? esc(a.soundName || 'Audio') : 'Sin audio…'}</span>
            ${hasSound ? `<button type="button" class="mc-audio-clear" data-uid="${esc(a.uid)}" title="Quitar">✕</button>` : ''}
          </div>
          <div class="mc-audio-volrow"${hasSound ? '' : ' hidden'}>
            <label class="mc-audio-vol-lbl">Volumen</label>
            <div class="mc-audio-volctl">
              <input type="range" class="mc-audio-vol" data-uid="${esc(a.uid)}" min="0" max="100" value="${vol}">
              <span class="mc-audio-vol-val">${vol}%</span>
            </div>
          </div>
        </div>
      </div>`;
    return `
    <div class="mc-act-card ${a.enabled === false ? 'mc-off' : ''}" data-uid="${esc(a.uid)}">
      <div class="mc-act-top">
        <span class="mc-act-name"><img class="mc-act-ic" src="${a.image ? esc(a.image) : '/img/minecraft/' + esc(a.catId) + '.png'}" alt="" onerror="this.style.display='none'">${esc(a.name)}</span>
        <button type="button" class="mc-act-del" data-uid="${esc(a.uid)}" title="Quitar">✕</button>
      </div>
      <div class="mc-act-desc">${esc(a.desc || '')}</div>
      <div class="mc-act-row">
        <select class="mc-trig-sel" data-uid="${esc(a.uid)}">${opts}</select>
        ${giftBtn}
        ${likeRow}
        ${mcCardQtyHtml(a)}
        ${mcCardComboInstantHtml(a)}
        ${audioBlock}
      </div>
      <div class="mc-act-actions">
        <label class="mc-act-toggle"><input type="checkbox" class="mc-act-en" data-uid="${esc(a.uid)}" ${a.enabled === false ? '' : 'checked'}> Activa</label>
        <div class="mc-act-btns">
          ${a.custom ? `<button type="button" class="mc-act-edit" data-uid="${esc(a.uid)}">Editar</button>` : ''}
          <button type="button" class="mc-act-test" data-uid="${esc(a.uid)}">Probar</button>
        </div>
      </div>
    </div>`;
  }).join('');

  const find = (uid) => (settings.mcActions || []).find((x) => x.uid === uid);
  wrap.querySelectorAll('.mc-act-del').forEach((b) => b.onclick = () => {
    settings.mcActions = (settings.mcActions || []).filter((x) => x.uid !== b.dataset.uid);
    saveSettings(); renderMyMcActions();
  });
  wrap.querySelectorAll('.mc-trig-sel').forEach((s) => s.onchange = () => {
    const a = find(s.dataset.uid); if (!a) return;
    a.trigger = s.value;
    saveSettings(); renderMyMcActions();
  });
  wrap.querySelectorAll('.mc-act-en').forEach((c) => c.onchange = () => {
    const a = find(c.dataset.uid); if (!a) return;
    a.enabled = c.checked;
    saveSettings(); renderMyMcActions();
  });
  wrap.querySelectorAll('.mc-like-n').forEach((inp) => inp.onchange = () => {
    const a = find(inp.dataset.uid); if (!a) return;
    a.likeN = Math.max(1, parseInt(inp.value, 10) || 1);
    saveSettings();
  });
  wrap.querySelectorAll('.mc-text-n').forEach((inp) => inp.onchange = () => {
    const a = find(inp.dataset.uid); if (!a) return;
    a.text = inp.value.trim();
    saveSettings();
  });
  wrap.querySelectorAll('.mc-qty-n').forEach((inp) => inp.onchange = () => {
    const a = find(inp.dataset.uid); if (!a) return;
    a.count = Math.max(1, Math.min(100, parseInt(inp.value, 10) || 1));
    inp.value = String(a.count);
    saveSettings();
  });
  wrap.querySelectorAll('.mc-gift-btn').forEach((b) => b.onclick = () => {
    const a = find(b.dataset.uid); if (!a) return;
    openGiftModalCb((g) => {
      a.giftId = String(g.id); a.giftName = g.name; a.giftImage = g.image || '';
      saveSettings(); renderMyMcActions();
    });
  });
  wrap.querySelectorAll('.mc-act-edit').forEach((b) => b.onclick = () => {
    const a = find(b.dataset.uid); if (a) openMcCmdModal(a);
  });
  wrap.querySelectorAll('.mc-act-test').forEach((b) => b.onclick = () => sendTestMcAction(b.dataset.uid));
  wrap.querySelectorAll('.mc-audio-en').forEach((c) => c.onchange = () => {
    const a = find(c.dataset.uid); if (!a) return;
    a.audioOn = c.checked;
    flushSaveSettings();
    renderMyMcActions();
  });
  wrap.querySelectorAll('.mc-audio-lib').forEach((b) => b.onclick = () => {
    mcSoundPickUid = b.dataset.uid;
    soundPickTarget = 'mc';
    openSoundLib();
  });
  wrap.querySelectorAll('.mc-audio-up').forEach((b) => b.onclick = () => {
    mcAudioUploadUid = b.dataset.uid;
    ensureMcAudioUpload().click();
  });
  wrap.querySelectorAll('.mc-audio-clear').forEach((b) => b.onclick = () => {
    const a = find(b.dataset.uid); if (!a) return;
    a.sound = '';
    a.soundName = '';
    flushSaveSettings();
    renderMyMcActions();
  });
  wrap.querySelectorAll('.mc-audio-vol').forEach((inp) => inp.oninput = () => {
    const a = find(inp.dataset.uid); if (!a) return;
    a.soundVolume = Math.max(0, Math.min(100, parseInt(inp.value, 10) || 0));
    const card = inp.closest('.mc-act-card');
    const val = card?.querySelector('.mc-audio-vol-val');
    if (val) val.textContent = a.soundVolume + '%';
    flushSaveSettings();
  });
  bindMcActionCardCommon(wrap, find, renderMyMcActions);
}

function ensureMcAudioUpload() {
  let inp = document.getElementById('mc-audio-upload-file');
  if (!inp) {
    inp = document.createElement('input');
    inp.type = 'file';
    inp.id = 'mc-audio-upload-file';
    inp.accept = 'audio/*';
    inp.hidden = true;
    inp.addEventListener('change', async (e) => {
      const uid = mcAudioUploadUid;
      mcAudioUploadUid = null;
      const file = e.target.files[0];
      e.target.value = '';
      if (!file || !uid || !settings?.mcActions) return;
      const a = settings.mcActions.find((x) => x.uid === uid);
      if (!a) return;
      try {
        const res = await fetch('/api/upload?name=' + encodeURIComponent(file.name), { method: 'POST', body: file });
        const data = await res.json();
        if (!data.url) throw new Error(data.error || 'error');
        a.sound = data.url;
        a.soundName = file.name;
        if (!a.audioOn) a.audioOn = true;
        flushSaveSettings();
        renderMyMcActions();
        toast && toast('Audio subido.', 'ok');
      } catch {
        toast && toast('No se pudo subir el audio.', 'error');
      }
    });
    document.body.appendChild(inp);
  }
  return inp;
}

// Genera una imagen tipo "menú de regalos" con las acciones agregadas:
// para cada acción muestra el regalo/evento que la activa, la cantidad a enviar
// y la acción de Minecraft (zombie, tnt, etc.). Se descarga como PNG.
async function generateMcMenuImage(srcList, iconDir, fileName) {
  const all = Array.isArray(srcList) ? srcList : ((settings && Array.isArray(settings.mcActions)) ? settings.mcActions : []);
  const ICON_DIR = iconDir || '/img/minecraft/';
  const OUT_NAME = fileName || 'menu-regalos-minecraft.png';
  const list = all.filter((a) => a && a.enabled !== false);
  if (!list.length) { toast && toast('Agrega acciones primero (con su regalo o evento).', 'warn'); return; }
  toast && toast('Generando imagen…', 'ok');

  const sameOrigin = (u) => { try { return new URL(u, location.href).origin === location.origin; } catch { return false; } };
  const proxied = (u) => (!u ? '' : (sameOrigin(u) ? u : ('/api/img-proxy?url=' + encodeURIComponent(u))));
  const loadImg = (src) => new Promise((resolve) => {
    if (!src) return resolve(null);
    const im = new Image();
    im.crossOrigin = 'anonymous';
    im.onload = () => resolve(im);
    im.onerror = () => resolve(null);
    im.src = src;
  });

  const rows = [];
  for (const a of list) {
    const trig = a.trigger || 'gift';
    let leftImg = null, leftEmoji = '', leftLabel = '';
    if (trig === 'gift') {
      leftImg = await loadImg(proxied(a.giftImage));
      leftLabel = a.giftName || 'Regalo';
    } else {
      const ev = MC_TRIG_ICON[trig] || { ic: '⚡', label: trig };
      leftEmoji = ev.ic; leftLabel = ev.label;
      if (trig === 'like' || trig === 'likeGlobal') leftLabel = (a.likeN || (trig === 'likeGlobal' ? 100 : 1)) + ' likes';
      else if (trig === 'chatCommand' || trig === 'chatUser') leftLabel = a.text || ev.label;
    }
    const actIcon = await loadImg(ICON_DIR + (a.catId || '') + '.png');
    rows.push({ a, leftImg, leftEmoji, leftLabel, actIcon, qty: Math.max(1, parseInt(a.count, 10) || 1) });
  }

  // Cuadrícula con fondo TRANSPARENTE: cada celda muestra solo el icono de la
  // acción, el icono del regalo (insignia) y el número de repeticiones arriba.
  const cols = Math.max(1, Math.min(5, rows.length));
  const gridRows = Math.ceil(rows.length / cols);
  const margin = 10, gap = 14, cellW = 200, numH = 44, iconS = 156, giftS = 52;
  const cellH = numH + iconS + 30;
  const W = margin * 2 + cols * cellW + (cols - 1) * gap;
  const H = margin * 2 + gridRows * cellH + (gridRows - 1) * gap;
  const dpr = 2;
  const cv = document.createElement('canvas');
  cv.width = W * dpr; cv.height = H * dpr;
  const ctx = cv.getContext('2d');
  ctx.scale(dpr, dpr);

  const rr = (x, y, w, h, r) => {
    const rad = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rad, y);
    ctx.arcTo(x + w, y, x + w, y + h, rad);
    ctx.arcTo(x + w, y + h, x, y + h, rad);
    ctx.arcTo(x, y + h, x, y, rad);
    ctx.arcTo(x, y, x + w, y, rad);
    ctx.closePath();
  };

  ctx.textBaseline = 'middle';
  rows.forEach((row, i) => {
    const c = i % cols, r = Math.floor(i / cols);
    const cellX = margin + c * (cellW + gap);
    const cellY = margin + r * (cellH + gap);
    const iconX = cellX + (cellW - iconS) / 2;
    const iconY = cellY + numH;

    // Icono de la acción de Minecraft
    if (row.actIcon) {
      ctx.save(); rr(iconX, iconY, iconS, iconS, 16); ctx.clip();
      ctx.drawImage(row.actIcon, iconX, iconY, iconS, iconS);
      ctx.restore();
    } else {
      rr(iconX, iconY, iconS, iconS, 16);
      ctx.fillStyle = 'rgba(124,58,237,.25)'; ctx.fill();
      ctx.font = '70px serif'; ctx.textAlign = 'center'; ctx.fillStyle = '#fff';
      ctx.fillText('🎮', iconX + iconS / 2, iconY + iconS / 2);
    }

    // Número de repeticiones (arriba del icono) SOLO si es 2 o más.
    if (row.qty >= 2) {
      const label = 'x' + row.qty;
      ctx.font = '800 26px Rubik, system-ui, sans-serif';
      const tw = ctx.measureText(label).width;
      const pw = tw + 30, ph = 34;
      const px = cellX + (cellW - pw) / 2, py = cellY + (numH - ph) / 2;
      const gb = ctx.createLinearGradient(px, py, px + pw, py);
      gb.addColorStop(0, '#f43f5e'); gb.addColorStop(1, '#ec4899');
      rr(px, py, pw, ph, 17); ctx.fillStyle = gb; ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(0,0,0,.35)'; ctx.stroke();
      ctx.textAlign = 'center'; ctx.fillStyle = '#fff';
      ctx.fillText(label, px + pw / 2, py + ph / 2 + 1);
    }

    // Icono del regalo/evento en pequeño, casi en los pies del icono de la acción
    // (superpuesto a la parte baja).
    const gx = cellX + (cellW - giftS) / 2, gy = iconY + iconS - Math.round(giftS * 0.5);
    ctx.save(); rr(gx, gy, giftS, giftS, 12); ctx.clip();
    if (row.leftImg) ctx.drawImage(row.leftImg, gx, gy, giftS, giftS);
    else { ctx.font = '34px serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#fff'; ctx.fillText(row.leftEmoji || '🎁', gx + giftS / 2, gy + giftS / 2 + 1); }
    ctx.restore();
  });

  try {
    const data = cv.toDataURL('image/png');
    const link = document.createElement('a');
    link.href = data; link.download = OUT_NAME;
    document.body.appendChild(link); link.click(); link.remove();
    toast && toast('Imagen generada y descargada.', 'ok');
  } catch {
    toast && toast('No se pudo exportar la imagen. Revisa tu conexión e inténtalo de nuevo.', 'err');
  }
}

/* ================= Acciones de Bedrock (Cubo TNT · comandos /bedrock) =================
   Misma mecánica que Minecraft (tarjetas con disparador + Probar), pero con los
   comandos del minijuego "Bedrock". Se guardan en settings.bedrockActions y se
   ejecutan por el MISMO RCON/ServerTap del servidor de Minecraft. Los comandos se
   guardan SIN la barra inicial. */

// Acciones que SÍ se pueden agregar a tarjetas (imágenes 7, 8 y 9).
const BEDROCK_CATALOG = [
  { id: 'bd_fill', name: 'Rellenar caja', desc: 'Llena la caja con los bloques requeridos', cmd: 'bedrock fill' },
  { id: 'bd_longhands', name: 'Manos largas', desc: 'Colocar/romper a distancia (segundos)', cmd: 'bedrock longhands 15' },
  { id: 'bd_reset1', name: 'Reset con rayo', desc: 'Limpia la caja con un rayo', cmd: 'bedrock reset 1' },
  { id: 'bd_reset2', name: 'Reset con dragón', desc: 'Limpia la caja con un dragón', cmd: 'bedrock reset 2' },
  { id: 'bd_tntrocket', name: 'Cohete TNT', desc: 'Lanza al jugador hacia arriba con fuegos', cmd: 'bedrock tntrocket 10' },
  { id: 'bd_tntstep', name: 'TNT perseguidora', desc: 'Genera dinamita que sigue al jugador', cmd: 'bedrock tntstep 10' },
  { id: 'bd_win1', name: 'Ganar (teletransporte)', desc: 'Llena la caja y teletransporta al jugador', cmd: 'bedrock win 1' },
  { id: 'bd_win2', name: 'Ganar (aldeano)', desc: 'Llena la caja con un aldeano constructor', cmd: 'bedrock win 2' },
  { id: 'bd_fillrows', name: 'Rellenar por filas', desc: 'Llena la caja por filas (número)', cmd: 'bedrock fill 6' },
  { id: 'bd_clear', name: 'Vaciar caja', desc: 'Libera la caja de todos los bloques', cmd: 'bedrock clear' },
  { id: 'bd_tnt', name: 'TNT', desc: 'Invoca una TNT con nombre sobre la caja', cmd: 'bedrock tnt 1 {nickname}' },
  { id: 'bd_randomtnt', name: 'TNT aleatoria', desc: 'TNT con fuerza aleatoria', cmd: 'bedrock randomtnt 1 {nickname}' },
  { id: 'bd_supertnt', name: 'Super TNT', desc: 'TNT de poder personalizado (cantidad poder)', cmd: 'bedrock supertnt 1 1 {nickname}' },
  { id: 'bd_glassprison', name: 'Cárcel de cristal', desc: 'Encierra al jugador sobre la caja (segundos)', cmd: 'bedrock glass_prison 10' },
  { id: 'bd_faketnt', name: 'TNT falsa', desc: 'Genera TNT falsa', cmd: 'bedrock faketnt 1 {nickname}' },
  { id: 'bd_weaktnt', name: 'TNT débil', desc: 'TNT que destruye solo 1 bloque', cmd: 'bedrock weaktnt 1 {nickname}' },
  { id: 'bd_fillblock', name: 'Añadir bloque', desc: 'Añade 1 (o más) bloque a la caja', cmd: 'bedrock fillblock 1' },
  { id: 'bd_enderman', name: 'Enderman ladrón', desc: 'Genera un Enderman que roba un bloque', cmd: 'bedrock enderman 5 {nickname}' },
];

// Configuraciones: SOLO "Probar" (no se agregan a tarjetas) — imágenes 3, 4, 5 y 6.
const BEDROCK_CONFIGS = [
  { name: 'Crear caja', desc: 'Crea una caja Bedrock. Inicia un timer cuando se llena.', cmd: 'bedrock create' },
  { name: 'Eliminar caja', desc: 'Elimina la caja y detiene el timer.', cmd: 'bedrock delete' },
  { name: 'Crear caja (tamaño y altura)', desc: 'Tamaño mín 3 (3=3×3, 5=5×5…). Altura mín 9, máx 21.', cmd: 'bedrock create 11 9' },
  { name: 'Detener timer', desc: 'Detiene el timer.', cmd: 'bedrock stop' },
  { name: 'Cambiar capa', desc: 'Cambia una capa de la caja (capa, material).', cmd: 'bedrock layer 1 amethyst_block' },
  { name: 'Bloquear arriba', desc: 'Bloquea el espacio sobre la caja para no colocar bloques.', cmd: 'bedrock toplock' },
  { name: 'Color del texto', desc: 'Cambia el color del texto (cancel/win + color).', cmd: 'bedrock color cancel red' },
  { name: 'Paredes de cristal', desc: 'Reemplaza paredes y suelo por cristal.', cmd: 'bedrock glass' },
  { name: 'Paredes de madera', desc: 'Reemplaza paredes y suelo por madera.', cmd: 'bedrock wood' },
  { name: 'Tiempo del timer', desc: 'Define el tiempo del timer para ganar.', cmd: 'bedrock timer 10' },
  { name: 'Bloquear edición a mano', desc: 'Bloquea romper la caja a mano (ejecútalo otra vez para desbloquear).', cmd: 'bedrock edit' },
  { name: 'Auto-reemplazo', desc: 'Activa/desactiva rellenar la caja con cualquier bloque.', cmd: 'bedrock autoreplace' },
  { name: 'Fuegos artificiales', desc: 'Activa/desactiva fuegos al explotar la TNT.', cmd: 'bedrock fireworks' },
  { name: 'Teletransportarte', desc: 'Te teletransporta encima de la caja.', cmd: 'bedrock tp' },
  { name: 'Paredes de bedrock', desc: 'Pone bloques de bedrock en paredes y suelo.', cmd: 'bedrock rock' },
  { name: 'Rango de interacción', desc: 'Distancia que el jugador alcanza con la mano.', cmd: 'bedrock set_block_interaction_range 10' },
  { name: 'Desactivar knockback', desc: 'Activa/desactiva el empuje de la TNT al jugador.', cmd: 'bedrock disableknockback' },
  { name: 'Rayo', desc: 'Destruye una capa de bloques con un rayo.', cmd: 'bedrock lightning' },
  { name: 'Subir altura', desc: 'Aumenta la altura de la caja.', cmd: 'bedrock heightup 1' },
  { name: 'Bajar altura', desc: 'Disminuye la altura de la caja.', cmd: 'bedrock heightdown 1' },
  { name: 'Subir radio', desc: 'Aumenta el radio de la caja.', cmd: 'bedrock radiusup 1' },
  { name: 'Bajar radio', desc: 'Disminuye el radio de la caja.', cmd: 'bedrock radiusdown 1' },
  { name: 'Restablecer tamaño', desc: 'Devuelve la caja a su tamaño original.', cmd: 'bedrock size_reset' },
  { name: 'Mostrar tamaño', desc: 'Activa/desactiva mostrar radio y altura de la caja.', cmd: 'bedrock show_size' },
  { name: 'Asignar usuario principal', desc: 'Asigna al jugador para quien se ejecutan los comandos (servidor público).', cmd: 'bedrock set_main_user {username}' },
  { name: 'Quitar usuario principal', desc: 'Quita al jugador de la lista (servidor público).', cmd: 'bedrock remove_main_user' },
];

function exportBedrockPresets() {
  const list = (settings && Array.isArray(settings.bedrockActions)) ? settings.bedrockActions : [];
  if (!list.length) { toast && toast('No hay acciones de Bedrock para exportar.', 'warn'); return; }
  const out = { type: 'livecoins-bedrock-presets', version: 1, exportedAt: Date.now(), bedrockActions: list };
  const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `bedrock-presets-${window.MY_USER || 'panel'}-${Date.now()}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => { try { URL.revokeObjectURL(a.href); } catch {} }, 1000);
  toast && toast(`Exportadas ${list.length} acciones de Bedrock.`, 'ok');
}

async function importBedrockPresets(file) {
  if (!settings) { toast && toast('Espera a que cargue el panel…', 'warn'); return; }
  let parsed;
  try { parsed = JSON.parse(await file.text()); }
  catch { toast && toast('El archivo no es un preset válido.', 'warn'); return; }
  const incoming = Array.isArray(parsed)
    ? parsed
    : (parsed && Array.isArray(parsed.bedrockActions) ? parsed.bedrockActions : (parsed && Array.isArray(parsed.mcActions) ? parsed.mcActions : null));
  if (!incoming || !incoming.length) { toast && toast('El archivo no contiene acciones de Bedrock.', 'warn'); return; }
  const mode = await askMcImportMode(incoming.length);
  if (!mode) return;
  const clean = incoming
    .filter((a) => a && typeof a === 'object')
    .map((a, i) => ({ ...a, game: 'bedrock', uid: 'mca_' + Date.now() + '_' + i + '_' + Math.random().toString(36).slice(2, 7) }));
  if (!Array.isArray(settings.bedrockActions)) settings.bedrockActions = [];
  settings.bedrockActions = (mode === 'replace') ? clean : settings.bedrockActions.concat(clean);
  saveSettings();
  renderMyBedrockActions();
  toast && toast(`Importadas ${clean.length} acciones (${mode === 'replace' ? 'reemplazo' : 'añadidas'}).`, 'ok');
}

function setupBedrockActionsUI() {
  document.querySelectorAll('#view-juego-bedrock .juego-dl-btn').forEach((btn) => {
    if (btn._wired) return;
    btn._wired = true;
    btn.onclick = () => {
      const url = btn.dataset.url;
      if (!url) { toast && toast('Aún no hay enlace de descarga configurado.', 'warn'); return; }
      downloadMinecraftServer(url);
    };
  });
  const bdRun = document.getElementById('bedrock-run');
  if (bdRun && !bdRun._wired) { bdRun._wired = true; bdRun.onclick = () => runBedrockServer(); }
  const bdChange = document.getElementById('bedrock-change-bat');
  if (bdChange && !bdChange._wired) { bdChange._wired = true; bdChange.onclick = async (e) => { e.preventDefault(); await chooseBedrockBat(true); }; }
  const search = document.getElementById('bedrock-cat-search');
  if (search && !search._wired) { search._wired = true; search.oninput = () => renderBedrockCatalog(search.value); }
  const createBtn = document.getElementById('bedrock-create-cmd');
  if (createBtn && !createBtn._wired) {
    createBtn._wired = true;
    createBtn.onclick = () => { if (!settings) { toast && toast('Espera a que cargue el panel…', 'warn'); return; } openMcCmdModal(null, 'bedrock'); };
  }
  const genImgBtn = document.getElementById('bedrock-gen-img');
  if (genImgBtn && !genImgBtn._wired) {
    genImgBtn._wired = true;
    genImgBtn.onclick = () => generateMcMenuImage(settings && settings.bedrockActions, '/img/bedrock/', 'menu-regalos-bedrock.png');
  }
  const expBtn = document.getElementById('bedrock-export-preset');
  if (expBtn && !expBtn._wired) { expBtn._wired = true; expBtn.onclick = exportBedrockPresets; }
  const impBtn = document.getElementById('bedrock-import-preset');
  const impFile = document.getElementById('bedrock-import-file');
  if (impBtn && impFile && !impBtn._wired) {
    impBtn._wired = true;
    impBtn.onclick = () => { if (!settings) { toast && toast('Espera a que cargue el panel…', 'warn'); return; } impFile.click(); };
    impFile.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (file) await importBedrockPresets(file);
    });
  }
  renderBedrockCatalog(search ? search.value : '');
  renderMyBedrockActions();
  renderBedrockConfigs();
}

function renderBedrockCatalog(filter) {
  const grid = document.getElementById('bedrock-catalog');
  if (!grid) return;
  const f = (filter || '').trim().toLowerCase();
  const list = f ? BEDROCK_CATALOG.filter((c) => c.name.toLowerCase().includes(f) || c.desc.toLowerCase().includes(f) || c.cmd.toLowerCase().includes(f)) : BEDROCK_CATALOG;
  if (!list.length) { grid.innerHTML = '<div class="empty">Sin resultados</div>'; return; }
  grid.innerHTML = list.map((c) => `
    <div class="mc-cat-card" data-id="${esc(c.id)}" title="/${esc(c.cmd)}">
      <div class="mc-cat-head-row">
        <img class="mc-cat-ic" src="/img/bedrock/${esc(c.id)}.png" alt="" onerror="this.style.display='none'">
        <div class="mc-cat-texts">
          <div class="mc-cat-name">${esc(c.name)}</div>
          <div class="mc-cat-desc">${esc(c.desc)}</div>
        </div>
      </div>
      <button type="button" class="mc-cat-add">+ Agregar</button>
    </div>`).join('');
  grid.querySelectorAll('.mc-cat-card').forEach((card) => {
    card.querySelector('.mc-cat-add').onclick = () => addBedrockAction(card.dataset.id);
  });
}

function addBedrockAction(catId) {
  const c = BEDROCK_CATALOG.find((x) => x.id === catId);
  if (!c) return;
  if (!settings) { toast && toast('Espera a que cargue el panel…', 'warn'); return; }
  if (!Array.isArray(settings.bedrockActions)) settings.bedrockActions = [];
  settings.bedrockActions.push({
    uid: 'mca_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
    catId: c.id, game: 'bedrock', name: c.name, desc: c.desc, cmd: c.cmd,
    trigger: 'gift', giftId: '', giftName: '', giftImage: '', enabled: true, count: 1,
  });
  saveSettings();
  renderMyBedrockActions();
  toast && toast(`Acción "${c.name}" agregada. Elige el regalo o evento.`, 'ok');
}

function renderMyBedrockActions() {
  const wrap = document.getElementById('bedrock-my-actions');
  if (!wrap) return;
  const list = (settings && Array.isArray(settings.bedrockActions)) ? settings.bedrockActions : [];
  if (!list.length) {
    wrap.innerHTML = '<div class="mc-empty">Aún no agregaste acciones. Elige una del catálogo de abajo.</div>';
    return;
  }
  wrap.innerHTML = list.map((a) => {
    const opts = MC_TRIGGERS.map((t) => `<option value="${t.v}" ${a.trigger === t.v ? 'selected' : ''}>${t.label}</option>`).join('');
    let giftBtn = '';
    if (a.trigger === 'gift') {
      const ic = a.giftImage
        ? `<img class="mc-gift-ic" src="${esc(a.giftImage)}" onerror="this.outerHTML='🎁'">`
        : '🎁';
      giftBtn = `<button type="button" class="mc-gift-btn" data-uid="${esc(a.uid)}">${ic}<span class="mc-gift-name">${a.giftName ? esc(a.giftName) : 'Elegir regalo'}</span></button>`;
    } else {
      const ev = MC_TRIG_ICON[a.trigger] || { ic: '⚡', label: a.trigger };
      const lbl = (MC_TRIGGERS.find((t) => t.v === a.trigger) || {}).label || ev.label;
      giftBtn = `<div class="mc-ev-badge"><span class="mc-ev-ic">${ev.ic}</span><span class="mc-gift-name">${esc(lbl)}</span></div>`;
    }
    let likeRow = '';
    if (a.trigger === 'like' || a.trigger === 'likeGlobal') {
      const defN = a.trigger === 'likeGlobal' ? 100 : 1;
      const val = a.likeN != null ? a.likeN : defN;
      const txt = a.trigger === 'likeGlobal' ? 'Cada cuántos likes globales' : 'Mínimo de likes (por tanda)';
      likeRow = `<label class="mc-like-row">${txt}
        <input type="number" min="1" class="mc-like-n" data-uid="${esc(a.uid)}" value="${esc(String(val))}"></label>`;
    } else if (a.trigger === 'chatUser' || a.trigger === 'chatCommand') {
      const txt = a.trigger === 'chatUser' ? 'Nombre de usuario (sin @)' : 'Palabra o comando (ej. !tnt)';
      const ph = a.trigger === 'chatUser' ? 'usuario123' : '!tnt';
      likeRow = `<label class="mc-like-row">${txt}
        <input type="text" class="mc-text-n" data-uid="${esc(a.uid)}" value="${esc(a.text || '')}" placeholder="${ph}"></label>`;
    }
    return `
    <div class="mc-act-card ${a.enabled === false ? 'mc-off' : ''}" data-uid="${esc(a.uid)}">
      <div class="mc-act-top">
        <span class="mc-act-name"><img class="mc-act-ic" src="${a.image ? esc(a.image) : '/img/bedrock/' + esc(a.catId) + '.png'}" alt="" onerror="this.style.display='none'">${esc(a.name)}</span>
        <button type="button" class="mc-act-del" data-uid="${esc(a.uid)}" title="Quitar">✕</button>
      </div>
      <div class="mc-act-desc">${esc(a.desc || '')}</div>
      <div class="mc-act-row">
        <select class="mc-trig-sel" data-uid="${esc(a.uid)}">${opts}</select>
        ${giftBtn}
        ${likeRow}
        ${mcCardQtyHtml(a)}
        ${mcCardComboInstantHtml(a)}
      </div>
      <div class="mc-act-actions">
        <label class="mc-act-toggle"><input type="checkbox" class="mc-act-en" data-uid="${esc(a.uid)}" ${a.enabled === false ? '' : 'checked'}> Activa</label>
        <div class="mc-act-btns">
          ${a.custom ? `<button type="button" class="mc-act-edit" data-uid="${esc(a.uid)}">Editar</button>` : ''}
          <button type="button" class="mc-act-test" data-uid="${esc(a.uid)}">Probar</button>
        </div>
      </div>
    </div>`;
  }).join('');

  const find = (uid) => (settings.bedrockActions || []).find((x) => x.uid === uid);
  wrap.querySelectorAll('.mc-act-del').forEach((b) => b.onclick = () => {
    settings.bedrockActions = (settings.bedrockActions || []).filter((x) => x.uid !== b.dataset.uid);
    saveSettings(); renderMyBedrockActions();
  });
  wrap.querySelectorAll('.mc-trig-sel').forEach((s) => s.onchange = () => {
    const a = find(s.dataset.uid); if (!a) return;
    a.trigger = s.value;
    saveSettings(); renderMyBedrockActions();
  });
  wrap.querySelectorAll('.mc-act-en').forEach((c) => c.onchange = () => {
    const a = find(c.dataset.uid); if (!a) return;
    a.enabled = c.checked;
    saveSettings(); renderMyBedrockActions();
  });
  wrap.querySelectorAll('.mc-like-n').forEach((inp) => inp.onchange = () => {
    const a = find(inp.dataset.uid); if (!a) return;
    a.likeN = Math.max(1, parseInt(inp.value, 10) || 1);
    saveSettings();
  });
  wrap.querySelectorAll('.mc-text-n').forEach((inp) => inp.onchange = () => {
    const a = find(inp.dataset.uid); if (!a) return;
    a.text = inp.value.trim();
    saveSettings();
  });
  wrap.querySelectorAll('.mc-qty-n').forEach((inp) => inp.onchange = () => {
    const a = find(inp.dataset.uid); if (!a) return;
    a.count = Math.max(1, Math.min(100, parseInt(inp.value, 10) || 1));
    inp.value = String(a.count);
    saveSettings();
  });
  wrap.querySelectorAll('.mc-gift-btn').forEach((b) => b.onclick = () => {
    const a = find(b.dataset.uid); if (!a) return;
    openGiftModalCb((g) => {
      a.giftId = String(g.id); a.giftName = g.name; a.giftImage = g.image || '';
      saveSettings(); renderMyBedrockActions();
    });
  });
  wrap.querySelectorAll('.mc-act-edit').forEach((b) => b.onclick = () => {
    const a = find(b.dataset.uid); if (a) openMcCmdModal(a, 'bedrock');
  });
  wrap.querySelectorAll('.mc-act-test').forEach((b) => b.onclick = () => sendTestMcAction(b.dataset.uid));
  bindMcActionCardCommon(wrap, find, renderMyBedrockActions);
}

// Configuraciones de Bedrock: estos comandos se ejecutan DENTRO del juego (no por
// RCON/ServerTap, porque dependen de tu personaje). El botón "Copiar" copia el comando
// para que lo pegues en el chat del juego.
function renderBedrockConfigs() {
  const grid = document.getElementById('bedrock-configs');
  if (!grid) return;
  grid.innerHTML = BEDROCK_CONFIGS.map((c, i) => `
    <div class="bd-cfg-card">
      <div class="bd-cfg-texts">
        <div class="mc-cat-name">${esc(c.name)}</div>
        <div class="mc-cat-desc">${esc(c.desc)}</div>
      </div>
      <div class="bd-cfg-run">
        <span class="bd-cfg-slash">/</span>
        <input type="text" class="bd-cfg-input" data-i="${i}" value="${esc(c.cmd)}">
        <button type="button" class="bd-cfg-copy" data-i="${i}">Copiar</button>
      </div>
    </div>`).join('');
  grid.querySelectorAll('.bd-cfg-copy').forEach((b) => b.onclick = async () => {
    const input = grid.querySelector('.bd-cfg-input[data-i="' + b.dataset.i + '"]');
    let command = (input && input.value || '').trim();
    if (!command) { toast && toast('Escribe un comando.', 'warn'); return; }
    if (!command.startsWith('/')) command = '/' + command; // se pega tal cual en el chat del juego
    let ok = false;
    try { await navigator.clipboard.writeText(command); ok = true; }
    catch {
      try { input.focus(); input.select(); ok = document.execCommand('copy'); input.setSelectionRange(input.value.length, input.value.length); } catch {}
    }
    toast && toast(ok ? `Copiado: ${command}` : 'No se pudo copiar.', ok ? 'ok' : 'warn');
  });
}

/* ================= Acciones de Sandbox (comandos /sandbox) =================
   Misma mecánica que Bedrock (tarjetas con disparador + Probar), pero con los
   comandos /sandbox. Se guardan en settings.sandboxActions y se ejecutan por el
   MISMO RCON/ServerTap del servidor de Minecraft. */

// Acciones que SÍ se pueden agregar a tarjetas (con icono).
const SANDBOX_CATALOG = [
  { id: 'sb_tntnear', name: 'TNT cercana', desc: 'Genera TNT cerca del jugador (cantidad)', cmd: 'sandbox tntnear 3' },
  { id: 'sb_sand', name: 'Arena de color', desc: 'Crea bloques de arena de un color (color cantidad)', cmd: 'sandbox sand red 1' },
  { id: 'sb_sandrow', name: 'Fila de arena', desc: 'Crea arena cubriendo toda la plataforma (color filas)', cmd: 'sandbox sandrow blue 2' },
  { id: 'sb_tnt', name: 'TNT', desc: 'Invoca una TNT con nombre que cae y explota', cmd: 'sandbox tnt 10 {nickname}' },
  { id: 'sb_randomrow', name: 'Filas aleatorias', desc: 'Filas de bloques de colores distintos (número)', cmd: 'sandbox randomrow 1' },
  { id: 'sb_fillrow', name: 'Rellenar filas de color', desc: 'Vacía la plataforma y añade filas de arena de un color', cmd: 'sandbox fillrow magenta 5' },
  { id: 'sb_prison', name: 'Cárcel', desc: 'Encierra al jugador sobre la plataforma (segundos)', cmd: 'sandbox prison 10' },
];

// Configuraciones: SOLO "Copiar" (se ejecutan dentro del juego).
const SANDBOX_CONFIGS = [
  { name: 'Crear plataforma', desc: 'Crea una plataforma. Inicia un timer cuando queda limpia.', cmd: 'sandbox create' },
  { name: 'Crear plataforma (tamaño y altura)', desc: 'Tamaño mín 3 (3=3×3, 5=5×5…). Altura mín 1 (arena de victoria/inicio).', cmd: 'sandbox create 5 5' },
  { name: 'Eliminar plataforma', desc: 'Elimina la plataforma y detiene el timer.', cmd: 'sandbox delete' },
  { name: 'Tablas de clasificación', desc: 'Activa/desactiva la visibilidad del leaderboard.', cmd: 'sandbox leaderboards' },
  { name: 'Rayo', desc: 'Un rayo en un lugar aleatorio crea una explosión como TNT.', cmd: 'sandbox lightning 1' },
  { name: 'Suelo de cristal', desc: 'Reemplaza el suelo por bloques de cristal.', cmd: 'sandbox glass' },
  { name: 'Suelo de madera', desc: 'Reemplaza el suelo por bloques de madera.', cmd: 'sandbox wood' },
  { name: 'Detener timer', desc: 'Detiene el timer.', cmd: 'sandbox stop' },
  { name: 'Teletransportarte', desc: 'Teletransporta al jugador al sandbox.', cmd: 'sandbox tp' },
  { name: 'Pala', desc: 'Te da una pala de obsidiana encantada (útil en survival).', cmd: 'sandbox shovel' },
  { name: 'Editar', desc: '1ª vez: cambiar bloques de la plataforma. 2ª vez: vuelve a protegerla.', cmd: 'sandbox edit' },
  { name: 'Rellenar', desc: 'Llena la plataforma con arena.', cmd: 'sandbox fill' },
  { name: 'Vaciar', desc: 'Libera la plataforma de toda la arena.', cmd: 'sandbox clear' },
  { name: 'Tiempo del timer', desc: 'Define el tiempo del timer para ganar.', cmd: 'sandbox timer 15' },
  { name: 'Eliminar filas', desc: 'Quita el número de filas de arena empezando por abajo.', cmd: 'sandbox deleterow 10' },
  { name: 'Bedrock central', desc: 'Cambia el centro de la plataforma a bedrock.', cmd: 'sandbox rock' },
  { name: 'Color de arena por defecto', desc: 'Color inicial de toda la arena tras la victoria.', cmd: 'sandbox setdefaultsand lime' },
  { name: 'Velocidad de minado', desc: 'Define la velocidad de minado de la arena.', cmd: 'sandbox speed 30' },
  { name: 'Rango de interacción', desc: 'Cambia permanentemente el rango de minado de arena.', cmd: 'sandbox set block_interaction_range 10' },
  { name: 'Velocidad de ruptura', desc: 'Cambia permanentemente la velocidad de minado de arena.', cmd: 'sandbox set block_break_speed 10' },
  { name: 'Protección de daño', desc: 'Desactiva la protección de mobs (pueden dañarte). Otra vez para reactivarla.', cmd: 'sandbox damage_protection' },
  { name: 'Scoreboard', desc: 'Activa/desactiva el scoreboard.', cmd: 'sandbox scoreboard' },
];

function exportSandboxPresets() {
  const list = (settings && Array.isArray(settings.sandboxActions)) ? settings.sandboxActions : [];
  if (!list.length) { toast && toast('No hay acciones de Sandbox para exportar.', 'warn'); return; }
  const out = { type: 'livecoins-sandbox-presets', version: 1, exportedAt: Date.now(), sandboxActions: list };
  const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `sandbox-presets-${window.MY_USER || 'panel'}-${Date.now()}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => { try { URL.revokeObjectURL(a.href); } catch {} }, 1000);
  toast && toast(`Exportadas ${list.length} acciones de Sandbox.`, 'ok');
}

async function importSandboxPresets(file) {
  if (!settings) { toast && toast('Espera a que cargue el panel…', 'warn'); return; }
  let parsed;
  try { parsed = JSON.parse(await file.text()); }
  catch { toast && toast('El archivo no es un preset válido.', 'warn'); return; }
  const incoming = Array.isArray(parsed)
    ? parsed
    : (parsed && Array.isArray(parsed.sandboxActions) ? parsed.sandboxActions : null);
  if (!incoming || !incoming.length) { toast && toast('El archivo no contiene acciones de Sandbox.', 'warn'); return; }
  const mode = await askMcImportMode(incoming.length);
  if (!mode) return;
  const clean = incoming
    .filter((a) => a && typeof a === 'object')
    .map((a, i) => ({ ...a, game: 'sandbox', uid: 'mca_' + Date.now() + '_' + i + '_' + Math.random().toString(36).slice(2, 7) }));
  if (!Array.isArray(settings.sandboxActions)) settings.sandboxActions = [];
  settings.sandboxActions = (mode === 'replace') ? clean : settings.sandboxActions.concat(clean);
  saveSettings();
  renderMySandboxActions();
  toast && toast(`Importadas ${clean.length} acciones (${mode === 'replace' ? 'reemplazo' : 'añadidas'}).`, 'ok');
}

function setupSandboxActionsUI() {
  document.querySelectorAll('#view-juego-sandbox .juego-dl-btn').forEach((btn) => {
    if (btn._wired) return;
    btn._wired = true;
    btn.onclick = () => {
      const url = btn.dataset.url;
      if (!url) { toast && toast('Aún no hay enlace de descarga configurado.', 'warn'); return; }
      downloadMinecraftServer(url);
    };
  });
  const sbRun = document.getElementById('sandbox-run');
  if (sbRun && !sbRun._wired) { sbRun._wired = true; sbRun.onclick = () => runSandboxServer(); }
  const sbChange = document.getElementById('sandbox-change-bat');
  if (sbChange && !sbChange._wired) { sbChange._wired = true; sbChange.onclick = async (e) => { e.preventDefault(); await chooseSandboxBat(true); }; }
  const search = document.getElementById('sandbox-cat-search');
  if (search && !search._wired) { search._wired = true; search.oninput = () => renderSandboxCatalog(search.value); }
  const createBtn = document.getElementById('sandbox-create-cmd');
  if (createBtn && !createBtn._wired) {
    createBtn._wired = true;
    createBtn.onclick = () => { if (!settings) { toast && toast('Espera a que cargue el panel…', 'warn'); return; } openMcCmdModal(null, 'sandbox'); };
  }
  const genImgBtn = document.getElementById('sandbox-gen-img');
  if (genImgBtn && !genImgBtn._wired) {
    genImgBtn._wired = true;
    genImgBtn.onclick = () => generateMcMenuImage(settings && settings.sandboxActions, '/img/sandbox/', 'menu-regalos-sandbox.png');
  }
  const expBtn = document.getElementById('sandbox-export-preset');
  if (expBtn && !expBtn._wired) { expBtn._wired = true; expBtn.onclick = exportSandboxPresets; }
  const impBtn = document.getElementById('sandbox-import-preset');
  const impFile = document.getElementById('sandbox-import-file');
  if (impBtn && impFile && !impBtn._wired) {
    impBtn._wired = true;
    impBtn.onclick = () => { if (!settings) { toast && toast('Espera a que cargue el panel…', 'warn'); return; } impFile.click(); };
    impFile.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (file) await importSandboxPresets(file);
    });
  }
  renderSandboxCatalog(search ? search.value : '');
  renderMySandboxActions();
  renderSandboxConfigs();
}

const SANDBOX_BAT_KEY = 'sandboxServerBatPath';
async function chooseSandboxBat(announce) {
  if (!IS_DESKTOP || !window.desktopAPI?.pickServerBat) {
    toast && toast('Esto solo funciona en la app de escritorio (.exe).', 'warn');
    return '';
  }
  const picked = await window.desktopAPI.pickServerBat();
  if (!picked) return '';
  try { localStorage.setItem(SANDBOX_BAT_KEY, picked); } catch {}
  if (announce) toast && toast('Servidor seleccionado. Pulsa Ejecutar servidor para iniciarlo.', 'ok');
  return picked;
}
async function runSandboxServer() {
  if (!IS_DESKTOP || !window.desktopAPI?.runServerBat) {
    toast && toast('Para iniciar el servidor abre la app de escritorio (.exe).', 'warn');
    return;
  }
  let path = '';
  try { path = localStorage.getItem(SANDBOX_BAT_KEY) || ''; } catch {}
  if (!path) { path = await chooseSandboxBat(false); if (!path) return; }
  const r = await window.desktopAPI.runServerBat(path);
  if (r && r.ok) {
    toast && toast('Iniciando el servidor de Sandbox…', 'ok');
  } else if (r && r.error === 'no_existe') {
    try { localStorage.removeItem(SANDBOX_BAT_KEY); } catch {}
    toast && toast('No se encontró el archivo. Elígelo de nuevo.', 'warn');
    const np = await chooseSandboxBat(false);
    if (np) { const r2 = await window.desktopAPI.runServerBat(np); if (r2 && r2.ok) toast && toast('Iniciando el servidor de Sandbox…', 'ok'); }
  } else {
    toast && toast('No se pudo iniciar el servidor.', 'err');
  }
}

function renderSandboxCatalog(filter) {
  const grid = document.getElementById('sandbox-catalog');
  if (!grid) return;
  const f = (filter || '').trim().toLowerCase();
  const list = f ? SANDBOX_CATALOG.filter((c) => c.name.toLowerCase().includes(f) || c.desc.toLowerCase().includes(f) || c.cmd.toLowerCase().includes(f)) : SANDBOX_CATALOG;
  if (!list.length) { grid.innerHTML = '<div class="empty">Sin resultados</div>'; return; }
  grid.innerHTML = list.map((c) => `
    <div class="mc-cat-card" data-id="${esc(c.id)}" title="/${esc(c.cmd)}">
      <div class="mc-cat-head-row">
        <img class="mc-cat-ic" src="/img/sandbox/${esc(c.id)}.png" alt="" onerror="this.style.display='none'">
        <div class="mc-cat-texts">
          <div class="mc-cat-name">${esc(c.name)}</div>
          <div class="mc-cat-desc">${esc(c.desc)}</div>
        </div>
      </div>
      <button type="button" class="mc-cat-add">+ Agregar</button>
    </div>`).join('');
  grid.querySelectorAll('.mc-cat-card').forEach((card) => {
    card.querySelector('.mc-cat-add').onclick = () => addSandboxAction(card.dataset.id);
  });
}

function addSandboxAction(catId) {
  const c = SANDBOX_CATALOG.find((x) => x.id === catId);
  if (!c) return;
  if (!settings) { toast && toast('Espera a que cargue el panel…', 'warn'); return; }
  if (!Array.isArray(settings.sandboxActions)) settings.sandboxActions = [];
  settings.sandboxActions.push({
    uid: 'mca_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
    catId: c.id, game: 'sandbox', name: c.name, desc: c.desc, cmd: c.cmd,
    trigger: 'gift', giftId: '', giftName: '', giftImage: '', enabled: true, count: 1,
  });
  saveSettings();
  renderMySandboxActions();
  toast && toast(`Acción "${c.name}" agregada. Elige el regalo o evento.`, 'ok');
}

function renderMySandboxActions() {
  const wrap = document.getElementById('sandbox-my-actions');
  if (!wrap) return;
  const list = (settings && Array.isArray(settings.sandboxActions)) ? settings.sandboxActions : [];
  if (!list.length) {
    wrap.innerHTML = '<div class="mc-empty">Aún no agregaste acciones. Elige una del catálogo de abajo.</div>';
    return;
  }
  wrap.innerHTML = list.map((a) => {
    const opts = MC_TRIGGERS.map((t) => `<option value="${t.v}" ${a.trigger === t.v ? 'selected' : ''}>${t.label}</option>`).join('');
    let giftBtn = '';
    if (a.trigger === 'gift') {
      const ic = a.giftImage
        ? `<img class="mc-gift-ic" src="${esc(a.giftImage)}" onerror="this.outerHTML='🎁'">`
        : '🎁';
      giftBtn = `<button type="button" class="mc-gift-btn" data-uid="${esc(a.uid)}">${ic}<span class="mc-gift-name">${a.giftName ? esc(a.giftName) : 'Elegir regalo'}</span></button>`;
    } else {
      const ev = MC_TRIG_ICON[a.trigger] || { ic: '⚡', label: a.trigger };
      const lbl = (MC_TRIGGERS.find((t) => t.v === a.trigger) || {}).label || ev.label;
      giftBtn = `<div class="mc-ev-badge"><span class="mc-ev-ic">${ev.ic}</span><span class="mc-gift-name">${esc(lbl)}</span></div>`;
    }
    let likeRow = '';
    if (a.trigger === 'like' || a.trigger === 'likeGlobal') {
      const defN = a.trigger === 'likeGlobal' ? 100 : 1;
      const val = a.likeN != null ? a.likeN : defN;
      const txt = a.trigger === 'likeGlobal' ? 'Cada cuántos likes globales' : 'Mínimo de likes (por tanda)';
      likeRow = `<label class="mc-like-row">${txt}
        <input type="number" min="1" class="mc-like-n" data-uid="${esc(a.uid)}" value="${esc(String(val))}"></label>`;
    } else if (a.trigger === 'chatUser' || a.trigger === 'chatCommand') {
      const txt = a.trigger === 'chatUser' ? 'Nombre de usuario (sin @)' : 'Palabra o comando (ej. !tnt)';
      const ph = a.trigger === 'chatUser' ? 'usuario123' : '!tnt';
      likeRow = `<label class="mc-like-row">${txt}
        <input type="text" class="mc-text-n" data-uid="${esc(a.uid)}" value="${esc(a.text || '')}" placeholder="${ph}"></label>`;
    }
    return `
    <div class="mc-act-card ${a.enabled === false ? 'mc-off' : ''}" data-uid="${esc(a.uid)}">
      <div class="mc-act-top">
        <span class="mc-act-name"><img class="mc-act-ic" src="${a.image ? esc(a.image) : '/img/sandbox/' + esc(a.catId) + '.png'}" alt="" onerror="this.style.display='none'">${esc(a.name)}</span>
        <button type="button" class="mc-act-del" data-uid="${esc(a.uid)}" title="Quitar">✕</button>
      </div>
      <div class="mc-act-desc">${esc(a.desc || '')}</div>
      <div class="mc-act-row">
        <select class="mc-trig-sel" data-uid="${esc(a.uid)}">${opts}</select>
        ${giftBtn}
        ${likeRow}
        ${mcCardQtyHtml(a)}
        ${mcCardComboInstantHtml(a)}
      </div>
      <div class="mc-act-actions">
        <label class="mc-act-toggle"><input type="checkbox" class="mc-act-en" data-uid="${esc(a.uid)}" ${a.enabled === false ? '' : 'checked'}> Activa</label>
        <div class="mc-act-btns">
          ${a.custom ? `<button type="button" class="mc-act-edit" data-uid="${esc(a.uid)}">Editar</button>` : ''}
          <button type="button" class="mc-act-test" data-uid="${esc(a.uid)}">Probar</button>
        </div>
      </div>
    </div>`;
  }).join('');

  const find = (uid) => (settings.sandboxActions || []).find((x) => x.uid === uid);
  wrap.querySelectorAll('.mc-act-del').forEach((b) => b.onclick = () => {
    settings.sandboxActions = (settings.sandboxActions || []).filter((x) => x.uid !== b.dataset.uid);
    saveSettings(); renderMySandboxActions();
  });
  wrap.querySelectorAll('.mc-trig-sel').forEach((s) => s.onchange = () => {
    const a = find(s.dataset.uid); if (!a) return;
    a.trigger = s.value;
    saveSettings(); renderMySandboxActions();
  });
  wrap.querySelectorAll('.mc-act-en').forEach((c) => c.onchange = () => {
    const a = find(c.dataset.uid); if (!a) return;
    a.enabled = c.checked;
    saveSettings(); renderMySandboxActions();
  });
  wrap.querySelectorAll('.mc-like-n').forEach((inp) => inp.onchange = () => {
    const a = find(inp.dataset.uid); if (!a) return;
    a.likeN = Math.max(1, parseInt(inp.value, 10) || 1);
    saveSettings();
  });
  wrap.querySelectorAll('.mc-text-n').forEach((inp) => inp.onchange = () => {
    const a = find(inp.dataset.uid); if (!a) return;
    a.text = inp.value.trim();
    saveSettings();
  });
  wrap.querySelectorAll('.mc-qty-n').forEach((inp) => inp.onchange = () => {
    const a = find(inp.dataset.uid); if (!a) return;
    a.count = Math.max(1, Math.min(100, parseInt(inp.value, 10) || 1));
    inp.value = String(a.count);
    saveSettings();
  });
  wrap.querySelectorAll('.mc-gift-btn').forEach((b) => b.onclick = () => {
    const a = find(b.dataset.uid); if (!a) return;
    openGiftModalCb((g) => {
      a.giftId = String(g.id); a.giftName = g.name; a.giftImage = g.image || '';
      saveSettings(); renderMySandboxActions();
    });
  });
  wrap.querySelectorAll('.mc-act-edit').forEach((b) => b.onclick = () => {
    const a = find(b.dataset.uid); if (a) openMcCmdModal(a, 'sandbox');
  });
  wrap.querySelectorAll('.mc-act-test').forEach((b) => b.onclick = () => sendTestMcAction(b.dataset.uid));
  bindMcActionCardCommon(wrap, find, renderMySandboxActions);
}

// Configuraciones de Sandbox: se ejecutan DENTRO del juego. El botón "Copiar" copia el comando.
function renderSandboxConfigs() {
  const grid = document.getElementById('sandbox-configs');
  if (!grid) return;
  grid.innerHTML = SANDBOX_CONFIGS.map((c, i) => `
    <div class="bd-cfg-card">
      <div class="bd-cfg-texts">
        <div class="mc-cat-name">${esc(c.name)}</div>
        <div class="mc-cat-desc">${esc(c.desc)}</div>
      </div>
      <div class="bd-cfg-run">
        <span class="bd-cfg-slash">/</span>
        <input type="text" class="bd-cfg-input" data-i="${i}" value="${esc(c.cmd)}">
        <button type="button" class="bd-cfg-copy" data-i="${i}">Copiar</button>
      </div>
    </div>`).join('');
  grid.querySelectorAll('.bd-cfg-copy').forEach((b) => b.onclick = async () => {
    const input = grid.querySelector('.bd-cfg-input[data-i="' + b.dataset.i + '"]');
    let command = (input && input.value || '').trim();
    if (!command) { toast && toast('Escribe un comando.', 'warn'); return; }
    if (!command.startsWith('/')) command = '/' + command;
    let ok = false;
    try { await navigator.clipboard.writeText(command); ok = true; }
    catch {
      try { input.focus(); input.select(); ok = document.execCommand('copy'); input.setSelectionRange(input.value.length, input.value.length); } catch {}
    }
    toast && toast(ok ? `Copiado: ${command}` : 'No se pudo copiar.', ok ? 'ok' : 'warn');
  });
}

// Abre un enlace de juego en el navegador del sistema (para que el protocolo del
// juego, p. ej. roblox://, lance la app instalada). En .exe usa shell.openExternal.
function openGameLink(url) {
  if (!url) return;
  if (IS_DESKTOP && window.desktopAPI?.openExternal) {
    window.desktopAPI.openExternal(url);
  } else {
    window.open(url, '_blank', 'noopener');
  }
  toast && toast('Abriendo el juego en tu navegador…', 'ok');
}

/* ================= Acciones de Roblox (simulación de teclas) ================= */
// Acciones FIJAS del juego: nombre, emoji y tecla por defecto (no se pueden cambiar).
const RBX_PRESETS = [
  { id: 'pollo', name: 'Transfórmate en un pollo', emoji: '🐔', keys: 'J' },
  { id: 'lento', name: 'Súper lento', emoji: '🐢', keys: 'L' },
  { id: 'platano', name: 'Resbalón de plátano', emoji: '🍌', keys: 'H' },
  { id: 'prision', name: 'Prisión', emoji: '⛓️', keys: 'Y' },
  { id: 'explosion', name: 'Explosión', emoji: '💥', keys: 'U' },
  { id: 'pequeno', name: 'Pequeño', emoji: '👶', keys: 'M' },
  { id: 'invisible', name: 'Invisible', emoji: '👻', keys: 'N' },
  { id: 'discoteca', name: 'Discoteca', emoji: '💃', keys: 'F' },
  { id: 'desenfoque', name: 'Desenfoque', emoji: '🌥️', keys: 'R' },
  { id: 'terremoto', name: 'Terremoto', emoji: '⚡', keys: 'X' },
];
const RBX_SLOTS = RBX_PRESETS.length;

// Asegura que existan las ranuras de acción de Roblox en settings, con nombre y tecla
// FIJOS según el preset (el usuario solo configura el regalo/evento, la cantidad y si está activa).
function ensureRobloxSlots() {
  if (!settings) return [];
  if (!Array.isArray(settings.robloxActions)) settings.robloxActions = [];
  for (let i = 0; i < RBX_SLOTS; i++) {
    const p = RBX_PRESETS[i];
    if (!settings.robloxActions[i]) {
      settings.robloxActions[i] = { slot: i, trigger: 'gift', giftId: '', giftName: '', giftImage: '', count: 1, enabled: false };
    }
    const a = settings.robloxActions[i];
    a.slot = i;
    a.id = p.id; a.name = p.name; a.emoji = p.emoji; a.keys = p.keys; // siempre forzados (no editables)
  }
  settings.robloxActions.length = RBX_SLOTS;
  return settings.robloxActions;
}

function setupRobloxActionsUI() {
  const toggleAll = document.getElementById('rbx-toggle-all');
  if (toggleAll && !toggleAll._wired) {
    toggleAll._wired = true;
    toggleAll.onclick = () => {
      const list = ensureRobloxSlots();
      const anyOff = list.some((a) => a.enabled === false);
      list.forEach((a) => { a.enabled = anyOff; }); // si alguna está apagada → encender todas; si no → apagar todas
      saveSettings(); renderRobloxActions();
      toast && toast(anyOff ? 'Todas las acciones encendidas.' : 'Todas las acciones apagadas.', 'ok');
    };
  }
  const genImgV = document.getElementById('rbx-gen-img-v');
  if (genImgV && !genImgV._wired) { genImgV._wired = true; genImgV.onclick = () => generateRobloxMenuImage('vertical'); }
  const genImgH = document.getElementById('rbx-gen-img-h');
  if (genImgH && !genImgH._wired) { genImgH._wired = true; genImgH.onclick = () => generateRobloxMenuImage('horizontal'); }
  renderRobloxActions();
}

function testRobloxAction(a) {
  if (!a || !a.keys) { toast && toast('Elige primero las teclas a simular.', 'warn'); return; }
  if (!IS_DESKTOP || !window.desktopAPI?.pressKeys) { toast && toast('La simulación de teclas solo funciona en la app de escritorio (.exe).', 'warn'); return; }
  const times = Math.max(1, parseInt(a.count, 10) || 1);
  toast && toast(`Se simularán las teclas en ${ACC_TEST_DELAY} s… cambia a Roblox.`, 'ok');
  setTimeout(() => {
    window.desktopAPI.pressKeys(a.keys, { gameCompat: true, times });
    addEvent(`⚡ Prueba Roblox: ${esc(a.keys)}${times > 1 ? ` ×${times}` : ''}`, 'ok');
  }, ACC_TEST_DELAY * 1000);
}

function renderRobloxActions() {
  const wrap = document.getElementById('rbx-actions');
  if (!wrap || !settings) return;
  const list = ensureRobloxSlots();
  wrap.innerHTML = list.map((a, i) => {
    const opts = MC_TRIGGERS.map((t) => `<option value="${t.v}" ${a.trigger === t.v ? 'selected' : ''}>${t.label}</option>`).join('');
    let giftBtn = '';
    if ((a.trigger || 'gift') === 'gift') {
      const ic = a.giftImage ? `<img class="mc-gift-ic" src="${esc(a.giftImage)}" onerror="this.outerHTML='🎁'">` : '🎁';
      giftBtn = `<button type="button" class="mc-gift-btn rbx-gift" data-slot="${i}">${ic}<span class="mc-gift-name">${a.giftName ? esc(a.giftName) : 'Elegir regalo'}</span></button>`;
    } else {
      const ev = MC_TRIG_ICON[a.trigger] || { ic: '⚡', label: a.trigger };
      const lbl = (MC_TRIGGERS.find((t) => t.v === a.trigger) || {}).label || ev.label;
      giftBtn = `<div class="mc-ev-badge"><span class="mc-ev-ic">${ev.ic}</span><span class="mc-gift-name">${esc(lbl)}</span></div>`;
    }
    let likeRow = '';
    if (a.trigger === 'like' || a.trigger === 'likeGlobal') {
      const defN = a.trigger === 'likeGlobal' ? 100 : 1;
      const val = a.likeN != null ? a.likeN : defN;
      const txt = a.trigger === 'likeGlobal' ? 'Cada cuántos likes globales' : 'Mínimo de likes (por tanda)';
      likeRow = `<label class="mc-like-row">${txt}<input type="number" min="1" class="rbx-like-n" data-slot="${i}" value="${esc(String(val))}"></label>`;
    } else if (a.trigger === 'chatUser' || a.trigger === 'chatCommand') {
      const txt = a.trigger === 'chatUser' ? 'Nombre de usuario (sin @)' : 'Palabra o comando (ej. !salta)';
      const ph = a.trigger === 'chatUser' ? 'usuario123' : '!salta';
      likeRow = `<label class="mc-like-row">${txt}<input type="text" class="rbx-text-n" data-slot="${i}" value="${esc(a.text || '')}" placeholder="${ph}"></label>`;
    }
    return `
    <div class="mc-act-card ${a.enabled === false ? 'mc-off' : ''}" data-slot="${i}">
      <div class="mc-act-top">
        <span class="mc-act-name"><img class="mc-act-ic" src="/img/roblox/${esc(a.id)}.png" alt="" onerror="this.outerHTML='${a.emoji || '⌨️'} '">${esc(a.name || ('Acción ' + (i + 1)))}</span>
        <span class="rbx-keycap" title="Tecla fija de esta acción">${esc(a.keys)}</span>
      </div>
      <div class="mc-act-row">
        <select class="rbx-trig-sel" data-slot="${i}">${opts}</select>
        ${giftBtn}
        ${likeRow}
      </div>
      <div class="mc-act-actions">
        <label class="mc-act-toggle"><input type="checkbox" class="rbx-en" data-slot="${i}" ${a.enabled === false ? '' : 'checked'}> Activa</label>
        <div class="mc-act-btns">
          <button type="button" class="mc-act-test rbx-test" data-slot="${i}">Probar</button>
        </div>
      </div>
    </div>`;
  }).join('');

  const at = (el) => list[parseInt(el.dataset.slot, 10)];
  wrap.querySelectorAll('.rbx-trig-sel').forEach((s) => s.onchange = () => { const a = at(s); if (!a) return; a.trigger = s.value; saveSettings(); renderRobloxActions(); });
  wrap.querySelectorAll('.rbx-en').forEach((c) => c.onchange = () => { const a = at(c); if (!a) return; a.enabled = c.checked; saveSettings(); renderRobloxActions(); });
  wrap.querySelectorAll('.rbx-like-n').forEach((inp) => inp.onchange = () => { const a = at(inp); if (!a) return; a.likeN = Math.max(1, parseInt(inp.value, 10) || 1); saveSettings(); });
  wrap.querySelectorAll('.rbx-text-n').forEach((inp) => inp.onchange = () => { const a = at(inp); if (!a) return; a.text = inp.value.trim(); saveSettings(); });
  wrap.querySelectorAll('.rbx-gift').forEach((b) => b.onclick = () => {
    const a = at(b); if (!a) return;
    openGiftModalCb((g) => { a.giftId = String(g.id); a.giftName = g.name; a.giftImage = g.image || ''; saveSettings(); renderRobloxActions(); });
  });
  wrap.querySelectorAll('.rbx-test').forEach((b) => b.onclick = () => { const a = at(b); if (a) testRobloxAction(a); });
}

/* ================= Acciones de Roblox 3 (simulación de teclas) ================= */
// Acciones FIJAS del juego: nombre, emoji y tecla por defecto. Las teclas se ajustan
// editando este arreglo (pendiente de asignar por el usuario).
const RBX3_PRESETS = [
  { id: 'rbx3_mas5', name: 'Mover +5 casillas', emoji: '⬆️', keys: '1' },
  { id: 'rbx3_menos5', name: 'Mover -5 casillas', emoji: '⬇️', keys: '2' },
  { id: 'rbx3_mas50', name: 'Mover +50 casillas', emoji: '⬆️', keys: '3' },
  { id: 'rbx3_menos50', name: 'Mover -50 casillas', emoji: '⬇️', keys: '4' },
  { id: 'rbx3_mas100', name: 'Mover +100 casillas', emoji: '⬆️', keys: '5' },
  { id: 'rbx3_menos100', name: 'Mover -100 casillas', emoji: '⬇️', keys: '6' },
  { id: 'rbx3_mas500', name: 'Mover +500 casillas', emoji: '⬆️', keys: '7' },
  { id: 'rbx3_menos500', name: 'Mover -500 casillas', emoji: '⬇️', keys: '8' },
  { id: 'rbx3_win_mas', name: 'Sumar 1 win (+1)', emoji: '🏆', keys: 'P' },
  { id: 'rbx3_win_menos', name: 'Restar 1 win (-1)', emoji: '🏆', keys: 'L' },
  { id: 'rbx3_11', name: 'Acción 11', emoji: '🎮', keys: '', editable: true },
  { id: 'rbx3_12', name: 'Acción 12', emoji: '🎮', keys: '', editable: true },
];
const RBX3_SLOTS = RBX3_PRESETS.length;

// Asegura que existan las ranuras de acción de Roblox 3 en settings, con nombre y tecla
// FIJOS según el preset (el usuario solo configura el regalo/evento, la cantidad y si está activa).
function ensureRoblox3Slots() {
  if (!settings) return [];
  if (!Array.isArray(settings.roblox3Actions)) settings.roblox3Actions = [];
  for (let i = 0; i < RBX3_SLOTS; i++) {
    const p = RBX3_PRESETS[i];
    if (!settings.roblox3Actions[i]) {
      settings.roblox3Actions[i] = { slot: i, trigger: 'gift', giftId: '', giftName: '', giftImage: '', count: 1, enabled: false };
    }
    const a = settings.roblox3Actions[i];
    a.slot = i;
    a.id = p.id; a.name = p.name; a.emoji = p.emoji;
    if (p.editable) { if (typeof a.keys !== 'string') a.keys = ''; } // el usuario elige la tecla
    else a.keys = p.keys; // tecla fija (no editable)
  }
  settings.roblox3Actions.length = RBX3_SLOTS;
  return settings.roblox3Actions;
}

function setupRoblox3ActionsUI() {
  const toggleAll = document.getElementById('rbx3-toggle-all');
  if (toggleAll && !toggleAll._wired) {
    toggleAll._wired = true;
    toggleAll.onclick = () => {
      const list = ensureRoblox3Slots();
      const anyOff = list.some((a) => a.enabled === false);
      list.forEach((a) => { a.enabled = anyOff; });
      saveSettings(); renderRoblox3Actions();
      toast && toast(anyOff ? 'Todas las acciones encendidas.' : 'Todas las acciones apagadas.', 'ok');
    };
  }
  renderRoblox3Actions();
}

function testRoblox3Action(a) {
  if (!a || !a.keys) { toast && toast('Esta acción aún no tiene tecla asignada.', 'warn'); return; }
  if (!IS_DESKTOP || !window.desktopAPI?.pressKeys) { toast && toast('La simulación de teclas solo funciona en la app de escritorio (.exe).', 'warn'); return; }
  const times = Math.max(1, parseInt(a.count, 10) || 1);
  toast && toast(`Se simularán las teclas en ${ACC_TEST_DELAY} s… cambia a Roblox.`, 'ok');
  setTimeout(() => {
    window.desktopAPI.pressKeys(a.keys, { gameCompat: true, times });
    addEvent(`⚡ Prueba Roblox 3: ${esc(a.keys)}${times > 1 ? ` ×${times}` : ''}`, 'ok');
  }, ACC_TEST_DELAY * 1000);
}

function renderRoblox3Actions() {
  const wrap = document.getElementById('rbx3-actions');
  if (!wrap || !settings) return;
  const list = ensureRoblox3Slots();
  wrap.innerHTML = list.map((a, i) => {
    const opts = MC_TRIGGERS.map((t) => `<option value="${t.v}" ${a.trigger === t.v ? 'selected' : ''}>${t.label}</option>`).join('');
    let giftBtn = '';
    if ((a.trigger || 'gift') === 'gift') {
      const ic = a.giftImage ? `<img class="mc-gift-ic" src="${esc(a.giftImage)}" onerror="this.outerHTML='🎁'">` : '🎁';
      giftBtn = `<button type="button" class="mc-gift-btn rbx3-gift" data-slot="${i}">${ic}<span class="mc-gift-name">${a.giftName ? esc(a.giftName) : 'Elegir regalo'}</span></button>`;
    } else {
      const ev = MC_TRIG_ICON[a.trigger] || { ic: '⚡', label: a.trigger };
      const lbl = (MC_TRIGGERS.find((t) => t.v === a.trigger) || {}).label || ev.label;
      giftBtn = `<div class="mc-ev-badge"><span class="mc-ev-ic">${ev.ic}</span><span class="mc-gift-name">${esc(lbl)}</span></div>`;
    }
    let likeRow = '';
    if (a.trigger === 'like' || a.trigger === 'likeGlobal') {
      const defN = a.trigger === 'likeGlobal' ? 100 : 1;
      const val = a.likeN != null ? a.likeN : defN;
      const txt = a.trigger === 'likeGlobal' ? 'Cada cuántos likes globales' : 'Mínimo de likes (por tanda)';
      likeRow = `<label class="mc-like-row">${txt}<input type="number" min="1" class="rbx3-like-n" data-slot="${i}" value="${esc(String(val))}"></label>`;
    } else if (a.trigger === 'chatUser' || a.trigger === 'chatCommand') {
      const txt = a.trigger === 'chatUser' ? 'Nombre de usuario (sin @)' : 'Palabra o comando (ej. !salta)';
      const ph = a.trigger === 'chatUser' ? 'usuario123' : '!salta';
      likeRow = `<label class="mc-like-row">${txt}<input type="text" class="rbx3-text-n" data-slot="${i}" value="${esc(a.text || '')}" placeholder="${ph}"></label>`;
    }
    const editable = !!(RBX3_PRESETS[i] && RBX3_PRESETS[i].editable);
    const keyEl = editable
      ? `<button type="button" class="rbx-keycap rbx3-keyset" data-slot="${i}" title="Pulsa para elegir la tecla">${a.keys ? esc(a.keys) : '⌨️ Elegir tecla'}</button>`
      : `<span class="rbx-keycap" title="Tecla fija de esta acción">${a.keys ? esc(a.keys) : '—'}</span>`;
    return `
    <div class="mc-act-card ${a.enabled === false ? 'mc-off' : ''}" data-slot="${i}">
      <div class="mc-act-top">
        <span class="mc-act-name"><img class="mc-act-ic" src="/img/roblox3/${esc(a.id)}.png" alt="" onerror="this.outerHTML='${a.emoji || '⌨️'} '">${esc(a.name || ('Acción ' + (i + 1)))}</span>
        ${keyEl}
      </div>
      <div class="mc-act-row">
        <select class="rbx3-trig-sel" data-slot="${i}">${opts}</select>
        ${giftBtn}
        ${likeRow}
      </div>
      <div class="mc-act-actions">
        <label class="mc-act-toggle"><input type="checkbox" class="rbx3-en" data-slot="${i}" ${a.enabled === false ? '' : 'checked'}> Activa</label>
        <div class="mc-act-btns">
          <button type="button" class="mc-act-test rbx3-test" data-slot="${i}">Probar</button>
        </div>
      </div>
    </div>`;
  }).join('');

  const at = (el) => list[parseInt(el.dataset.slot, 10)];
  wrap.querySelectorAll('.rbx3-trig-sel').forEach((s) => s.onchange = () => { const a = at(s); if (!a) return; a.trigger = s.value; saveSettings(); renderRoblox3Actions(); });
  wrap.querySelectorAll('.rbx3-en').forEach((c) => c.onchange = () => { const a = at(c); if (!a) return; a.enabled = c.checked; saveSettings(); renderRoblox3Actions(); });
  wrap.querySelectorAll('.rbx3-like-n').forEach((inp) => inp.onchange = () => { const a = at(inp); if (!a) return; a.likeN = Math.max(1, parseInt(inp.value, 10) || 1); saveSettings(); });
  wrap.querySelectorAll('.rbx3-text-n').forEach((inp) => inp.onchange = () => { const a = at(inp); if (!a) return; a.text = inp.value.trim(); saveSettings(); });
  wrap.querySelectorAll('.rbx3-gift').forEach((b) => b.onclick = () => {
    const a = at(b); if (!a) return;
    openGiftModalCb((g) => { a.giftId = String(g.id); a.giftName = g.name; a.giftImage = g.image || ''; saveSettings(); renderRoblox3Actions(); });
  });
  wrap.querySelectorAll('.rbx3-test').forEach((b) => b.onclick = () => { const a = at(b); if (a) testRoblox3Action(a); });
  wrap.querySelectorAll('.rbx3-keyset').forEach((b) => b.onclick = () => {
    const a = at(b); if (!a) return;
    captureHotkey(b, (combo) => { a.keys = combo; saveSettings(); renderRoblox3Actions(); });
  });
}

/* ================= Acciones de Mario Bros (SMBX2 + bridge :8765) ================= */
// Catálogo de cosas que se pueden generar. "npcId" es el ID SMBX2; "id"/"thing" mantiene
// compatibilidad con acciones guardadas (Goomba, SuperMushroom, etc.).
const MARIO_ITEMS = [
  { id: 'SuperMushroom', npcId: 90, nombre: 'Hongo (crecer)' },
  { id: 'FireFlower', npcId: 91, nombre: 'Flor de Fuego' },
  { id: 'SuperStar', npcId: 95, nombre: 'Estrella (invencible)' },
  { id: 'OneUp', npcId: 96, nombre: 'Vida 1UP' },
  { id: 'WingItem', npcId: 94, nombre: 'Alas (volar)' },
  { id: 'PoisonMushroom', npcId: 90, nombre: 'Hongo Venenoso' },
];
const MARIO_ENEMIES = [
  { id: 'Goomba', npcId: 1, nombre: 'Goomba' },
  { id: 'Goombrat', npcId: 1, nombre: 'Goombrat' },
  { id: 'GreenKoopaTroopa', npcId: 23, nombre: 'Koopa Verde' },
  { id: 'RedKoopaTroopa', npcId: 22, nombre: 'Koopa Roja' },
  { id: 'GreenKoopaParaTroopa', npcId: 23, nombre: 'Koopa Voladora Verde' },
  { id: 'GreenParaKoopaHori', npcId: 23, nombre: 'Koopa Voladora (horizontal)' },
  { id: 'Spiny', npcId: 24, nombre: 'Spiny' },
  { id: 'Lakitu', npcId: 39, nombre: 'Lakitu' },
  { id: 'PiranhaPlant', npcId: 31, nombre: 'Planta Piraña' },
  { id: 'RedPiranhaPlant', npcId: 31, nombre: 'Planta Piraña Roja' },
  { id: 'Muncher', npcId: 31, nombre: 'Muncher (planta negra)' },
  { id: 'BulletBill', npcId: 153, nombre: 'Bill Bala' },
  { id: 'BobOmb', npcId: 154, nombre: 'Bob-omb' },
  { id: 'LitBobOmb', npcId: 154, nombre: 'Bob-omb encendido' },
  { id: 'BuzzyBeetle', npcId: 35, nombre: 'Buzzy Beetle' },
  { id: 'DryBones', npcId: 89, nombre: 'Dry Bones (huesitos)' },
  { id: 'Boo', npcId: 84, nombre: 'Boo (fantasma)' },
  { id: 'BooBuddies', npcId: 84, nombre: 'Boos en grupo' },
  { id: 'HammerBro', npcId: 56, nombre: 'Hermano Martillo' },
  { id: 'BowsersBro', npcId: 56, nombre: 'Hermano de Bowser' },
  { id: 'Blooper', npcId: 231, nombre: 'Blooper (calamar)' },
  { id: 'GreenCheepCheep', npcId: 229, nombre: 'Cheep Cheep Verde' },
  { id: 'RedCheepCheep', npcId: 28, nombre: 'Cheep Cheep Rojo' },
  { id: 'LeapingCheepCheep', npcId: 229, nombre: 'Cheep Cheep Saltarín' },
  { id: 'Pokey', npcId: 247, nombre: 'Pokey (cactus)' },
  { id: 'MontyMole', npcId: 309, nombre: 'Topo Monty' },
  { id: 'RockyWrench', npcId: 395, nombre: 'Rocky Wrench' },
  { id: 'FighterFly', npcId: 54, nombre: 'Mosca' },
  { id: 'Sigebou', npcId: 1, nombre: 'Sigebou' },
  { id: 'Spike', npcId: 365, nombre: 'Spike' },
  { id: 'Thwomp', npcId: 119, nombre: 'Thwomp' },
  { id: 'Bowser', npcId: 197, nombre: 'Bowser' },
];
// Efectos temporales sobre Mario (endpoint /effect). seconds = duración, factor =
// tamaño exacto (0 = automático).
const MARIO_EFFECTS = [
  { id: 'giant', nombre: 'Mario Enorme', seconds: 5, factor: 0 },
  { id: 'tiny', nombre: 'Mario Mini', seconds: 5, factor: 0 },
];
const MARIO_CATALOG = [
  ...MARIO_ITEMS.map((x) => ({ ...x, tipo: 'item', kind: 'spawn' })),
  ...MARIO_ENEMIES.map((x) => ({ ...x, tipo: 'enemy', kind: 'spawn' })),
  ...MARIO_EFFECTS.map((x) => ({ ...x, tipo: 'effect', kind: 'effect' })),
];

// Iconos y etiquetas del catálogo de Mario (para las tarjetas "+ Agregar").
const MARIO_CAT_ICON = { item: '🍄', enemy: '👾', effect: '✨' };
const MARIO_TIPO_LABEL = { item: 'Objeto / Power-up', enemy: 'Enemigo', effect: 'Efecto sobre Mario' };
const MARIO_ICON_DIR = '/img/mario-interactivo/';

/** Slug para iconos: mismo nombre del catálogo → minúsculas, espacios=_ , sin acentos (homgo → homgo.png, flor de fuego → flor_de_fuego.png). */
function marioIconSlug(name) {
  return String(name || '').trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/ñ/g, 'n')
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '');
}

function marioCatalogIconUrl(entry) {
  let nombre = entry?.nombre || entry?.label;
  if (!nombre && entry?.catalogId) {
    const c = MARIO_CATALOG.find((x) => x.id === entry.catalogId);
    nombre = c?.nombre;
  }
  const slug = marioIconSlug(nombre);
  if (!slug) return '';
  return `${MARIO_ICON_DIR}${slug}.png`;
}

function marioCatalogIconHtml(entry) {
  const emoji = MARIO_CAT_ICON[entry?.tipo] || '🎮';
  const src = marioCatalogIconUrl(entry);
  if (!src) return `<span class="mc-cat-emoji">${emoji}</span>`;
  return `<img class="mc-cat-ic" src="${esc(src)}" alt="" onerror="this.outerHTML='<span class=\\'mc-cat-emoji\\'>${emoji}</span>'">`;
}

// settings.marioActions es la lista de acciones AGREGADAS por el usuario (como en
// Minecraft): cada una tiene un uid propio. Empieza vacía.
function ensureMarioActions() {
  if (!settings) return [];
  if (!Array.isArray(settings.marioActions)) settings.marioActions = [];
  settings.marioActions = migrateGameActions(settings.marioActions, 'mar');
  for (const a of settings.marioActions) {
    if (!a?.webhookCmd?.url) continue;
    if (a.count == null || a.count < 1) a.count = 1;
    if (a.comboInstant == null && (a.trigger === 'gift' || a.trigger === 'gift-any')) a.comboInstant = true;
    a.webhookCmd.url = applyMarioWebhookQuantity(a.webhookCmd.url, a.count);
  }
  return settings.marioActions;
}

// Migra del formato viejo (todas las casillas del catálogo por 'slot', sin uid) al
// nuevo (solo las que el usuario agregó, con uid). Conserva las que tenían regalo o
// evento configurado y les pone un uid; descarta las casillas vacías del catálogo.
function migrateGameActions(arr, prefix) {
  if (!Array.isArray(arr) || !arr.length) return arr || [];
  if (arr.every((a) => a && a.uid)) return arr;
  const out = [];
  for (const a of arr) {
    if (!a) continue;
    if (a.uid) { out.push(a); continue; }
    const configured = a.giftId || a.giftName || (a.trigger && a.trigger !== 'gift') || a.text;
    if (!configured) continue; // casilla vacía del catálogo viejo: se descarta
    a.uid = prefix + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    delete a.slot;
    out.push(a);
  }
  return out;
}

// Botones de descarga Mario (juego + activador webhook).
function setupMarioLaunchBtn() {
  function wireMarioDownload(id, label) {
    const btn = document.getElementById(id);
    if (!btn || btn._wired) return;
    btn._wired = true;
    btn.onclick = () => {
      const url = (btn.dataset.url || '').trim();
      if (!url) { toast && toast('Enlace de descarga no disponible.', 'warn'); return; }
      downloadMinecraftServer(url);
      toast && toast(`Descargando ${label}…`, 'ok');
    };
  }
  wireMarioDownload('mario-play', 'juego');
  wireMarioDownload('mario-room', 'activador');
  wireMarioDownload('mario-worlds', 'Worlds');
}

// Convierte URL de webhook TikFinity (puerto 5720 u otro) → npcId + cantidad.
function parseTikfinitySpawnWebhook(trig) {
  const wh = trig?.webhook;
  if (!wh || trig.actionType !== 'webhook') return null;
  const url = String(wh.url || '');
  if (!url) return null;
  let npcId = null;
  let count = 1;
  try {
    const u = new URL(url.replace(/\{[^}]+\}/g, 'x'));
    const id = u.searchParams.get('id') ?? u.searchParams.get('npcId');
    if (id != null && id !== '') {
      const n = Number(id);
      npcId = Number.isFinite(n) ? n : id;
    }
    const qty = u.searchParams.get('quantity') ?? u.searchParams.get('count') ?? u.searchParams.get('times');
    if (qty) count = Math.max(1, parseInt(qty, 10) || 1);
  } catch {
    const idM = url.match(/[?&](?:id|npcId)=([^&]+)/i);
    const qtyM = url.match(/[?&](?:quantity|count|times)=([^&]+)/i);
    if (idM) {
      const id = decodeURIComponent(idM[1]);
      const n = Number(id);
      npcId = Number.isFinite(n) ? n : id;
    }
    if (qtyM) count = Math.max(1, parseInt(qtyM[1], 10) || 1);
  }
  if (npcId == null || npcId === '') return null;
  return { npcId, count };
}

function tikfinityTypeToMarioTrigger(type) {
  return tikfinityTypeToEvent(type);
}

function tikfinityTriggerToMarioAction(trig, i) {
  const wh = trig?.webhook;
  const spawn = parseTikfinitySpawnWebhook(trig);
  if (!spawn || !wh || !String(wh.url || '').trim()) return null;
  const trigger = tikfinityTypeToMarioTrigger(trig.type);
  if (!trigger) return null;
  const { npcId, count } = spawn;
  const whUrl = String(wh.url || '').trim();
  const catalogEntry = MARIO_CATALOG.find((x) => x.webhookCmd?.url === whUrl)
    || MARIO_CATALOG.find((x) => x.npcId != null && String(x.npcId) === String(npcId));
  const thing = catalogEntry?.id || String(npcId);
  const label = catalogEntry?.nombre || `NPC ${npcId}`;
  const actionName = tikfinityWebhookActionName(trig);
  const a = {
    uid: 'mar_' + Date.now() + '_' + i + '_' + Math.random().toString(36).slice(2, 7),
    thing,
    npcId: typeof npcId === 'number' ? npcId : null,
    label,
    actionName: actionName && actionName.toLowerCase() !== label.toLowerCase() ? actionName : '',
    tipo: catalogEntry?.tipo || 'enemy',
    kind: catalogEntry?.kind || 'spawn',
    trigger,
    giftId: '',
    giftName: '',
    giftImage: '',
    count: 1,
    seconds: catalogEntry?.seconds != null ? catalogEntry.seconds : 5,
    factor: catalogEntry?.factor != null ? catalogEntry.factor : 0,
    text: '',
    enabled: true,
    webhookCmd: {
      on: true,
      method: String(wh.method || 'GET').toUpperCase(),
      url: applyMarioWebhookQuantity(String(wh.url || '').trim(), 1),
      body: wh.body || '',
    },
    comboInstant: !!wh.giftMultiplier,
  };
  if (trigger === 'gift') {
    a.giftId = trig.giftId ? String(trig.giftId) : '';
    a.giftName = trig.giftName || '';
    a.giftImage = trig.giftImageUrl || '';
  } else if (trigger === 'like' || trigger === 'likeGlobal') {
    a.likeN = Math.max(1, parseInt(trig.likeThreshold, 10) || (trigger === 'likeGlobal' ? 100 : 1));
  }
  return a;
}

async function importMarioInteractivoProfile(triggers, modeLabel) {
  const incoming = [];
  let skipped = 0;
  triggers.forEach((trig, i) => {
    const a = tikfinityTriggerToMarioAction(trig, i);
    if (a) incoming.push(a);
    else skipped += 1;
  });
  if (!incoming.length) {
    toast && toast('Ningún trigger se pudo convertir. ¿Tienen URL /spawn?id=…?', 'warn');
    return false;
  }
  const mode = await askGameImportMode(incoming.length, modeLabel || 'Mario Interactivo (WebHook)');
  if (!mode) return false;
  if (!Array.isArray(settings.marioActions)) settings.marioActions = [];
  settings.marioActions = mode === 'replace' ? incoming : settings.marioActions.concat(incoming);
  saveSettings();
  renderMarioActions();
  const base = `Importadas ${incoming.length} acciones Mario con WebHook activo`;
  toast && toast(skipped ? `${base} (${skipped} omitidas).` : `${base}.`, 'ok');
  return true;
}

async function ensureMarioInteractivoWebhooks() {
  /* El usuario agrega acciones manualmente desde el catálogo Mario Interactivo. */
}

async function importTikfinityMarioProfile(file) {
  if (!settings) { toast && toast('Espera a que cargue el panel…', 'warn'); return; }
  let parsed;
  try { parsed = JSON.parse(await file.text()); }
  catch { toast && toast('El archivo no es JSON válido.', 'warn'); return; }
  const triggers = Array.isArray(parsed?.triggers) ? parsed.triggers : null;
  if (!triggers?.length) {
    toast && toast('No se encontraron triggers (perfil TikFinity / TikTok Webhook).', 'warn');
    return;
  }
  await importMarioInteractivoProfile(triggers, 'Mario desde perfil TikFinity');
}

async function reloadMarioInteractivoProfile() {
  if (!settings) { toast && toast('Espera a que cargue el panel…', 'warn'); return; }
  try {
    const r = await fetch('/mario-interactivo-profile.json', { cache: 'no-store' });
    if (!r.ok) { toast && toast('No se encontró el perfil Mario Interactivo.', 'warn'); return; }
    const parsed = await r.json();
    const triggers = Array.isArray(parsed?.triggers) ? parsed.triggers : [];
    if (!triggers.length) { toast && toast('El perfil no tiene triggers.', 'warn'); return; }
    await importMarioInteractivoProfile(triggers, 'perfil Mario Interactivo');
  } catch {
    toast && toast('No se pudo cargar el perfil Mario Interactivo.', 'warn');
  }
}

function setupMarioActionsUI() {
  const search = document.getElementById('mario-cat-search');
  if (search && !search._wired) { search._wired = true; search.oninput = () => renderMarioCatalog(search.value); }
  const toggleAll = document.getElementById('mario-toggle-all');
  if (toggleAll && !toggleAll._wired) {
    toggleAll._wired = true;
    toggleAll.onclick = () => {
      const list = ensureMarioActions();
      if (!list.length) { toast && toast('Primero agrega acciones del catálogo.', 'warn'); return; }
      const anyOff = list.some((a) => a.enabled === false);
      list.forEach((a) => { a.enabled = anyOff; });
      saveSettings(); renderMarioActions();
      toast && toast(anyOff ? 'Todas las acciones encendidas.' : 'Todas las acciones apagadas.', 'ok');
    };
  }
  const genOverlayBtn = document.getElementById('mario-gen-overlay');
  if (genOverlayBtn && !genOverlayBtn._wired) {
    genOverlayBtn._wired = true;
    genOverlayBtn.onclick = () => generateMarioOverlayImage();
  }
  loadMarioBridgePresets().finally(async () => {
    await ensureMarioInteractivoWebhooks();
    renderMarioCatalog(search ? search.value : '');
    renderMarioActions();
  });
}

async function loadMarioBridgePresets() {
  const applyPresets = (presets, { includeEffects = true } = {}) => {
    if (!Array.isArray(presets) || !presets.length) return false;
    const bridgeSpawns = presets.map((p) => ({
      id: p.id || String(p.npcId),
      npcId: p.npcId,
      thing: p.id || String(p.npcId),
      nombre: p.nombre || p.label || p.name,
      tipo: p.tipo || (p.category === 'powerup' ? 'item' : 'enemy'),
      kind: p.kind || (p.tipo === 'effect' ? 'effect' : 'spawn'),
      count: p.count != null ? p.count : 1,
      trigger: p.trigger,
      giftId: p.giftId,
      giftName: p.giftName,
      giftImage: p.giftImage,
      likeN: p.likeN,
      comboInstant: p.comboInstant,
      webhookCmd: p.webhookCmd,
    }));
    MARIO_CATALOG.length = 0;
    MARIO_CATALOG.push(...bridgeSpawns);
    if (includeEffects) {
      MARIO_CATALOG.push(...MARIO_EFFECTS.map((x) => ({ ...x, tipo: 'effect', kind: 'effect' })));
    }
    return true;
  };
  try {
    const r = await fetch('/mario-interactivo-catalog.json', { cache: 'no-store' });
    if (r.ok && applyPresets(await r.json(), { includeEffects: false })) return;
  } catch { /* sin catálogo interactivo */ }
  try {
    const r = await fetch('/api/desktop/bridge-health', { credentials: 'same-origin' });
    if (r.ok) { /* bridge accesible */ }
  } catch { /* ignore */ }
  try {
    const r = await fetch('http://127.0.0.1:7755/presets');
    const d = await r.json();
    if (d.ok && applyPresets(d.presets)) return;
  } catch { /* bridge apagado */ }
  try {
    const r = await fetch(`/mario-presets.json?t=${Date.now()}`, { cache: 'no-store' });
    if (r.ok && applyPresets(await r.json())) return;
  } catch { /* sin archivo estático */ }
}

// Catálogo de Mario: tarjetas con "+ Agregar" (puede repetirse: regalo, likes, etc.).
function marioCatalogUseCount(c) {
  return (settings?.marioActions || []).filter(
    (a) => a && (a.catalogId === c.id || (!a.catalogId && a.thing === c.id)),
  ).length;
}

function renderMarioCatalog(filter) {
  const grid = document.getElementById('mario-catalog');
  if (!grid) return;
  const f = (filter || '').trim().toLowerCase();
  const list = f ? MARIO_CATALOG.filter((c) => c.nombre.toLowerCase().includes(f)) : MARIO_CATALOG;
  if (!list.length) { grid.innerHTML = '<div class="empty">Sin resultados</div>'; return; }
  grid.innerHTML = list.map((c) => {
    const n = marioCatalogUseCount(c);
    return `
    <div class="mc-cat-card ${n ? 'mc-cat-in-use' : ''}" data-id="${esc(c.id)}" title="${esc(c.nombre)}">
      <div class="mc-cat-head-row">
        ${marioCatalogIconHtml(c)}
        <div class="mc-cat-texts">
          <div class="mc-cat-name">${esc(c.nombre)}${n ? ` <span class="mc-cat-use-n">×${n}</span>` : ''}</div>
          <div class="mc-cat-desc">${esc(MARIO_TIPO_LABEL[c.tipo] || '')}</div>
        </div>
      </div>
      <button type="button" class="mc-cat-add">+ Agregar</button>
    </div>`;
  }).join('');
  grid.querySelectorAll('.mc-cat-card').forEach((card) => {
    card.querySelector('.mc-cat-add').onclick = () => addMarioAction(card.dataset.id);
  });
}

function applyMarioWebhookQuantity(url, quantity) {
  const q = Math.max(1, Math.min(999, parseInt(quantity, 10) || 1));
  const s = String(url || '');
  if (!/\/spawn\b/i.test(s)) return s;
  if (/[?&]quantity=\d+/i.test(s)) return s.replace(/([?&]quantity=)\d+/i, `$1${q}`);
  if (/[?&]count=\d+/i.test(s)) return s.replace(/([?&]count=)\d+/i, `$1${q}`);
  return `${s}${s.includes('?') ? '&' : '?'}quantity=${q}`;
}

// Agrega una acción del catálogo a "Mis acciones agregadas".
function addMarioAction(thing) {
  const c = MARIO_CATALOG.find((x) => x.id === thing);
  if (!c) return;
  if (!settings) { toast && toast('Espera a que cargue el panel…', 'warn'); return; }
  const list = ensureMarioActions();
  const a = {
    uid: 'mar_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
    catalogId: c.id,
    thing: c.id,
    npcId: c.npcId != null ? c.npcId : null,
    label: c.nombre,
    tipo: c.tipo,
    kind: c.kind || 'spawn',
    trigger: c.trigger || 'gift',
    giftId: c.giftId || '',
    giftName: c.giftName || '',
    giftImage: c.giftImage || '',
    count: 1,
    seconds: c.seconds != null ? c.seconds : 5,
    factor: c.factor != null ? c.factor : 0,
    text: '',
    enabled: true,
  };
  if (c.likeN != null) a.likeN = c.likeN;
  if (c.webhookCmd?.on && c.webhookCmd?.url) {
    a.webhookCmd = {
      on: true,
      method: c.webhookCmd.method || 'GET',
      url: applyMarioWebhookQuantity(c.webhookCmd.url, 1),
      body: c.webhookCmd.body || '',
    };
    a.comboInstant = c.comboInstant !== false;
  }
  list.push(a);
  saveSettings();
  renderMarioActions();
  renderMarioCatalog(document.getElementById('mario-cat-search')?.value || '');
  toast && toast(
    a.webhookCmd ? `"${c.nombre}" agregada con WebHook activo.` : `"${c.nombre}" agregada. Elige el regalo o evento.`,
    'ok',
  );
}

// Mario / PvZ: SIEMPRE en esta PC. Preferimos el servidor local (.exe) donde vive el bridge;
// IPC de Electron es fallback (mismo game-local pero otro proceso).
async function execGameLocal(exec) {
  if (!IS_DESKTOP || !exec) return false;
  try {
    const r = await fetch('/api/desktop/game-exec', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(exec),
    });
    const d = await r.json().catch(() => ({}));
    if (r.ok && d.ok !== false) return d;
  } catch { /* fallback IPC */ }
  if (window.desktopAPI?.localExec) {
    try {
      const r = await window.desktopAPI.localExec(exec);
      if (r && r.ok !== false) return r;
    } catch {}
  }
  return { ok: false };
}

async function ensureGameBridgeApi(mode) {
  try {
    const r = await fetch('/api/desktop/ensure-bridge', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode }),
    });
    return await r.json().catch(() => ({ ok: false }));
  } catch {
    return { ok: false };
  }
}

function bridgeHealthMatchesMode(h, mode) {
  if (!h?.ok || h.api !== 'livecoins') return false;
  if (mode === 'mari0') {
    return !!(h.mari0?.enabled && (h.mari0?.only || (h.targets || []).includes('mari0')));
  }
  if (h.mari0?.only) return false;
  const targets = h.targets || [];
  if (targets.includes('smbx2') || targets.includes('smb3-poll')) return true;
  const sq = String(h.spawnQueue || '').toLowerCase();
  if (sq.includes('_livecoins')) return true;
  return true;
}

async function gameBridgeHealth() {
  try {
    const r = await fetch('/api/desktop/bridge-health', { credentials: 'same-origin' });
    const d = await r.json().catch(() => ({}));
    if (d.health) return d.health;
  } catch { /* fallback directo */ }
  try {
    const r = await fetch('http://127.0.0.1:7755/health');
    return await r.json();
  } catch { return null; }
}

async function waitGameBridge(mode, maxMs = 12000) {
  const t0 = Date.now();
  let boot = await ensureGameBridgeApi(mode);
  if (boot.ok && bridgeHealthMatchesMode(boot.health, mode)) return boot.health;
  while (Date.now() - t0 < maxMs) {
    await new Promise((r) => setTimeout(r, 300));
    const h = await gameBridgeHealth();
    if (bridgeHealthMatchesMode(h, mode)) return h;
  }
  return null;
}

function warnMari0NotConnected(h) {
  if (h?.mari0?.connected) return;
  const pending = Number(h?.mari0?.pending) || 0;
  if (pending > 0) {
    toast && toast(
      `Comando en cola (${pending}). El mod aún no enlaza con el bridge — usa el Mari0 de Livecoins y «Iniciar bridge» antes de «Jugar».`,
      'warn',
    );
  } else {
    toast && toast(
      'Mod Crowd Control sin enlazar (puerto 28379). ¿Es el Mari0 de Livecoins? Bridge primero, luego Jugar.',
      'warn',
    );
  }
}

let mari0StatusTimer = null;

function renderMari0Status(h) {
  const el = document.getElementById('mari0-status');
  if (!el) return;
  if (!IS_DESKTOP) { el.innerHTML = ''; return; }
  if (!h?.ok || h.api !== 'livecoins' || !h.mari0?.enabled) {
    el.innerHTML = '<span class="mari0-st off">Bridge :7755 — apagado</span>';
    return;
  }
  const bridgeOk = !!(h.mari0.only || (h.targets || []).includes('mari0'));
  const gameOk = !!h.mari0.connected;
  const pending = Number(h.mari0.pending) || 0;
  const parts = [
    `<span class="mari0-st ${bridgeOk ? 'on' : 'off'}">Bridge :7755</span>`,
    `<span class="mari0-st ${gameOk ? 'on' : 'warn'}">Juego CC: ${gameOk ? 'conectado' : 'sin enlazar'}</span>`,
  ];
  if (pending > 0) parts.push(`<span class="mari0-st warn">${pending} en cola</span>`);
  el.innerHTML = parts.join('');
}

async function refreshMari0Status() {
  if (!IS_DESKTOP) return null;
  const h = await gameBridgeHealth();
  renderMari0Status(h);
  return h;
}

async function waitMari0GameLink(maxMs = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const h = await refreshMari0Status();
    if (h?.mari0?.connected) return h;
    await new Promise((r) => setTimeout(r, 500));
  }
  return refreshMari0Status();
}

function setupMari0StatusPoll() {
  if (!IS_DESKTOP || mari0StatusTimer) return;
  refreshMari0Status();
  mari0StatusTimer = setInterval(() => {
    const view = document.getElementById('view-juego-mari0');
    if (view?.classList.contains('active')) refreshMari0Status();
  }, 2000);
}

function warnMarioQueuePending(h) {
  if (!h || !h.ok) {
    toast && toast('Bridge Mario no responde. Pulsa «Iniciar bridge».', 'warn');
    return;
  }
  const pending = Number(h.queuePending) || 0;
  if (pending > 0) {
    toast && toast(
      pending === 1
        ? 'Spawn en cola. Entra a SMBX2 → cliche → nivel marios_pad con Mario en pantalla.'
        : `Hay ${pending} spawns en cola. Entra a un nivel en SMBX2 (marios_pad).`,
      'warn',
    );
  }
}

async function testMarioAction(a) {
  if (!a) return;
  const label = a.label || a.thing || 'acción';
  if (!IS_DESKTOP) {
    toast && toast('Mario Bros solo funciona en la app de escritorio (.exe).', 'warn');
    return;
  }

  if (a.webhookCmd?.on && a.webhookCmd?.url) {
    const times = Math.max(1, parseInt(a.count, 10) || 1);
    toast && toast(`🪝 WebHook «${label}» ×${times}…`, 'ok');
    send({
      action: 'runActionOutputs',
      webhookCmd: a.webhookCmd,
      times,
    });
    addEvent(`🪝 Prueba Mario WebHook: ${esc(label)}${times > 1 ? ` ×${times}` : ''}`, 'ok');
    return;
  }

  if (a.kind !== 'effect' && !a.thing && a.npcId == null) {
    toast && toast('Acción sin enemigo/objeto. Quítala y agrégala de nuevo del catálogo.', 'warn');
    return;
  }

  toast && toast(`🍄 «${label}» en 2 s… (SMBX2 → marios_pad)`, 'ok');
  await new Promise((r) => setTimeout(r, 2000));

  const bridgeH = await waitGameBridge('smbx');
  if (!bridgeH) {
    toast && toast('Bridge Mario no arrancó. Pulsa «Iniciar bridge».', 'warn');
    return;
  }

  if (a.kind === 'effect') {
    const seconds = Math.max(1, parseInt(a.seconds, 10) || 5);
    const factor = Math.max(0, parseInt(a.factor, 10) || 0);
    const r = await execGameLocal({ tipo: 'MARIO_EFFECT', type: a.thing, seconds, factor });
    if (r && r.ok !== false) addEvent(`🍄 Prueba Mario: efecto ${esc(label)}`, 'ok');
    else toast && toast('Efecto no enviado. Pulsa «Iniciar bridge».', 'warn');
    return;
  }

  const times = Math.max(1, parseInt(a.count, 10) || 1);
  const spawnThing = a.thing || String(a.npcId);
  const r = await execGameLocal({ tipo: 'MARIO_SPAWN', thing: spawnThing, npcId: a.npcId, name: 'Prueba', times });
  if (r && r.ok !== false) {
    addEvent(`🍄 Prueba Mario: ${esc(label)}${times > 1 ? ` ×${times}` : ''}`, 'ok');
    setTimeout(async () => warnMarioQueuePending((await gameBridgeHealth()) || bridgeH), 400);
  } else {
    toast && toast(`Spawn falló («${label}»). Inicia bridge y entra a marios_pad en SMBX2.`, 'warn');
  }
}

function marioCardHtml(a) {
  const uid = esc(a.uid);
  const webhookOn = !!(a.webhookCmd && a.webhookCmd.on && a.webhookCmd.url);
  const emoji = a.kind === 'effect' ? '✨' : (a.tipo === 'enemy' ? '👾' : '🍄');
  const iconSrc = marioCatalogIconUrl(a);
  const nameHtml = iconSrc
    ? `<span class="mc-act-name"><img class="mc-act-ic" src="${esc(iconSrc)}" alt="" onerror="this.outerHTML='${emoji} '">${esc(a.label || a.thing)}</span>`
    : `<span class="mc-act-name">${emoji} ${esc(a.label || a.thing)}</span>`;
  const opts = MC_TRIGGERS.map((t) => `<option value="${t.v}" ${a.trigger === t.v ? 'selected' : ''}>${t.label}</option>`).join('');
  const giftBtn = gameActionGiftUi(a, 'mario-gift');
  const likeRow = gameActionExtraRow(a, 'mario-like-n', 'mario-text-n');
  const whChip = webhookOn ? '<span class="acc-chip key mc-wh-chip">🪝 WebHook</span>' : '';
  let qtyRow;
  if (a.kind === 'effect') {
    qtyRow = `
      <label class="mc-like-row" style="max-width:120px">Segundos<input type="number" min="1" max="60" class="mario-seconds" data-uid="${uid}" value="${esc(String(a.seconds || 5))}"></label>
      <label class="mc-like-row" style="max-width:160px">Tamaño (x, 0=auto)<input type="number" min="0" max="10" class="mario-factor" data-uid="${uid}" value="${esc(String(a.factor || 0))}"></label>`;
  } else {
    qtyRow = `<label class="mc-like-row" style="max-width:130px">Cantidad<input type="number" min="1" max="999" class="mario-count" data-uid="${uid}" value="${esc(String(a.count || 1))}"></label>`;
  }

  const actionSub = a.actionName
    ? `<div class="mc-act-sub">${esc(a.actionName)}</div>`
    : '';

  return `
  <div class="mc-act-card ${a.enabled === false ? 'mc-off' : ''} ${webhookOn ? 'mc-wh-card' : ''}" data-uid="${uid}">
    <div class="mc-act-top">
      <div class="mc-act-title-wrap">
        ${nameHtml}
        ${actionSub}
      </div>
      <button type="button" class="mc-act-del mario-del" data-uid="${uid}" title="Quitar">✕</button>
    </div>
    <div class="mc-act-row mc-act-trigger-row">
      <select class="mario-trig-sel mc-trig-sel" data-uid="${uid}">${opts}</select>
      ${giftBtn}
      ${likeRow}
      ${whChip}
    </div>
    <div class="mc-act-row">
      ${qtyRow}
    </div>
    ${((a.trigger || 'gift') === 'gift' || a.trigger === 'gift-any') ? `<div class="mc-act-row">${mcCardComboInstantHtml(a).replace('mc-combo-instant-en', 'mario-combo-instant-en')}</div>` : ''}
    <div class="mc-act-actions">
      <label class="mc-act-toggle"><input type="checkbox" class="mario-en" data-uid="${uid}" ${a.enabled === false ? '' : 'checked'}> Activa</label>
      <div class="mc-act-btns">
        <button type="button" class="mc-act-test mario-test" data-uid="${uid}">Probar</button>
      </div>
    </div>
  </div>`;
}

function renderMarioActions() {
  const wrap = document.getElementById('mario-my-actions');
  if (!wrap || !settings) return;
  const list = ensureMarioActions();
  if (!list.length) {
    wrap.innerHTML = '<div class="mc-empty">Aún no agregaste acciones. Pulsa <b>+ Agregar</b> en el catálogo de abajo.</div>';
    return;
  }
  wrap.innerHTML = list.map((a) => marioCardHtml(a)).join('');

  const find = (uid) => list.find((x) => x.uid === uid);
  wrap.querySelectorAll('.mario-del').forEach((b) => b.onclick = () => {
    settings.marioActions = list.filter((x) => x.uid !== b.dataset.uid);
    saveSettings();
    renderMarioActions();
    renderMarioCatalog(document.getElementById('mario-cat-search')?.value || '');
  });
  bindGameTriggerSelects(wrap, 'mario-trig-sel', 'marioActions', renderMarioActions);
  wrap.querySelectorAll('.mario-en').forEach((c) => c.onchange = () => { const a = find(c.dataset.uid); if (!a) return; a.enabled = c.checked; saveSettings(); renderMarioActions(); });
  wrap.querySelectorAll('.mario-like-n').forEach((inp) => inp.onchange = () => { const a = find(inp.dataset.uid); if (!a) return; a.likeN = Math.max(1, parseInt(inp.value, 10) || 1); saveSettings(); });
  wrap.querySelectorAll('.mario-text-n').forEach((inp) => inp.onchange = () => { const a = find(inp.dataset.uid); if (!a) return; a.text = inp.value.trim(); saveSettings(); });
  wrap.querySelectorAll('.mario-count').forEach((inp) => inp.onchange = () => {
    const a = find(inp.dataset.uid);
    if (!a) return;
    a.count = Math.max(1, Math.min(999, parseInt(inp.value, 10) || 1));
    if (a.webhookCmd?.url) a.webhookCmd.url = applyMarioWebhookQuantity(a.webhookCmd.url, a.count);
    saveSettings();
  });
  wrap.querySelectorAll('.mario-seconds').forEach((inp) => inp.onchange = () => { const a = find(inp.dataset.uid); if (!a) return; a.seconds = Math.max(1, Math.min(60, parseInt(inp.value, 10) || 5)); saveSettings(); });
  wrap.querySelectorAll('.mario-factor').forEach((inp) => inp.onchange = () => { const a = find(inp.dataset.uid); if (!a) return; a.factor = Math.max(0, Math.min(10, parseInt(inp.value, 10) || 0)); saveSettings(); });
  wrap.querySelectorAll('.mario-combo-instant-en').forEach((c) => c.onchange = () => { const a = find(c.dataset.uid); if (!a) return; a.comboInstant = c.checked; saveSettings(); });
  bindGameActionGiftButtons(wrap, 'mario-gift', 'marioActions', renderMarioActions);
  wrap.querySelectorAll('.mario-test').forEach((b) => b.onclick = () => { const a = find(b.dataset.uid); if (a) testMarioAction(a); });
}

// PNG tipo carta Mario Interactivo: icono + regalo + x{cantidad} (fondo transparente).
async function generateMarioOverlayImage() {
  const all = ensureMarioActions();
  let list = all.filter((a) => a && a.enabled !== false);
  if (!list.length) list = all.slice();
  if (!list.length) { toast && toast('Agrega acciones del catálogo con su regalo primero.', 'warn'); return; }
  toast && toast('Generando overlay…', 'ok');

  const sameOrigin = (u) => { try { return new URL(u, location.href).origin === location.origin; } catch { return false; } };
  const proxied = (u) => (!u ? '' : (sameOrigin(u) ? u : (`/api/img-proxy?url=${encodeURIComponent(u)}`)));
  const loadImg = (src) => new Promise((resolve) => {
    if (!src) return resolve(null);
    const im = new Image();
    im.crossOrigin = 'anonymous';
    im.onload = () => resolve(im);
    im.onerror = () => resolve(null);
    im.src = src;
  });

  const rows = [];
  for (const a of list) {
    const marioImg = await loadImg(proxied(marioCatalogIconUrl(a)));
    const trig = a.trigger || 'gift';
    let giftImg = null;
    let giftEmoji = '';
    if (trig === 'gift' || trig === 'gift-any') {
      const gUrl = (a.giftImage && String(a.giftImage).trim()) || giftImageOf(a);
      giftImg = await loadImg(proxied(gUrl));
    } else {
      giftEmoji = (MC_TRIG_ICON[trig] || { ic: '⚡' }).ic;
    }
    rows.push({ marioImg, giftImg, giftEmoji, qty: Math.max(1, parseInt(a.count, 10) || 1) });
  }

  const cols = Math.min(7, Math.max(1, rows.length));
  const gridRows = Math.ceil(rows.length / cols);
  const margin = 12;
  const gap = 8;
  const cellW = 118;
  const iconS = 108;
  const giftS = 44;
  const cellH = iconS + 6;
  const W = margin * 2 + cols * cellW + (cols - 1) * gap;
  const H = margin * 2 + gridRows * cellH + (gridRows - 1) * gap;
  const dpr = 2;
  const cv = document.createElement('canvas');
  cv.width = W * dpr;
  cv.height = H * dpr;
  const ctx = cv.getContext('2d');
  ctx.scale(dpr, dpr);

  const rr = (x, y, w, h, r) => {
    const rad = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rad, y);
    ctx.arcTo(x + w, y, x + w, y + h, rad);
    ctx.arcTo(x + w, y + h, x, y + h, rad);
    ctx.arcTo(x, y + h, x, y, rad);
    ctx.arcTo(x, y, x + w, y, rad);
    ctx.closePath();
  };

  const drawCloud = (x, y, w, h) => {
    ctx.save();
    ctx.fillStyle = '#c5e4f8';
    const blobs = [
      [0.28, 0.48, 0.34, 0.3], [0.52, 0.4, 0.38, 0.34], [0.74, 0.5, 0.3, 0.28],
      [0.38, 0.62, 0.28, 0.24], [0.62, 0.64, 0.26, 0.22],
    ];
    blobs.forEach(([bx, by, rw, rh]) => {
      ctx.beginPath();
      ctx.ellipse(x + w * bx, y + h * by, w * rw, h * rh, 0, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.restore();
  };

  const drawMultBadge = (label, x, y) => {
    ctx.font = '800 22px Rubik, Montserrat, system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.lineWidth = 5;
    ctx.strokeStyle = '#0a0a0a';
    ctx.strokeText(label, x, y);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(label, x, y);
  };

  const drawContain = (img, x, y, size) => {
    const scale = Math.min(size / img.width, size / img.height);
    const dw = img.width * scale;
    const dh = img.height * scale;
    ctx.drawImage(img, x + (size - dw) / 2, y + (size - dh) / 2, dw, dh);
  };

  rows.forEach((row, i) => {
    const c = i % cols;
    const r = Math.floor(i / cols);
    const cellX = margin + c * (cellW + gap);
    const cellY = margin + r * (cellH + gap);
    const iconX = cellX + (cellW - iconS) / 2;
    const iconY = cellY;

    if (row.marioImg) drawContain(row.marioImg, iconX, iconY, iconS);
    else drawCloud(iconX, iconY, iconS, iconS);

    const gx = iconX + iconS - giftS + 2;
    const gy = iconY + iconS - giftS + 2;
    if (row.giftImg) {
      ctx.save();
      rr(gx, gy, giftS, giftS, 10);
      ctx.clip();
      ctx.drawImage(row.giftImg, gx, gy, giftS, giftS);
      ctx.restore();
    } else if (row.giftEmoji) {
      ctx.font = '30px serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#fff';
      ctx.fillText(row.giftEmoji, gx + giftS / 2, gy + giftS / 2);
    }

    if (row.qty >= 2) drawMultBadge(`x${row.qty}`, iconX + iconS - 2, iconY + 1);
  });

  try {
    const data = cv.toDataURL('image/png');
    const link = document.createElement('a');
    link.href = data;
    link.download = 'mario-bros-overlay.png';
    document.body.appendChild(link);
    link.click();
    link.remove();
    toast && toast('Overlay generado y descargado.', 'ok');
  } catch {
    toast && toast('No se pudo exportar. Revisa tu conexión e inténtalo de nuevo.', 'err');
  }
}

/* ================= Acciones de Mari0 (bridge :7755 MARI0_ONLY) ================= */
/** Efectos CC del jugador (no spawn de entidad). */
const MARI0_POWERUPS = [
  { id: 'SuperMushroom', nombre: 'Hongo (power-up aleatorio)' },
  { id: 'FireFlower', nombre: 'Flor de fuego (power-up aleatorio)' },
  { id: 'SuperStar', nombre: 'Estrella invencible' },
  { id: 'OneUp', nombre: '+1 vida' },
  { id: 'SuperLeaf', nombre: 'Hoja (power-up aleatorio)' },
  { id: 'Coin', nombre: 'Monedas' },
  { id: 'PoisonMushroom', nombre: 'Hongo malo (spawn)' },
  { id: 'SpawnMushroom', nombre: 'Hongo (spawn)' },
  { id: 'SpawnStar', nombre: 'Estrella (spawn)' },
  { id: 'KillPlayer', nombre: 'Mata a Mario' },
  { id: 'TakeLife', nombre: 'Quita vida' },
];
/** spawn_* enemigos del mod Mari0 AE Crowd Control (59 códigos). */
const MARI0_ENEMIES = [
  { id: 'Goomba', nombre: 'Goomba' },
  { id: 'GreenKoopaTroopa', nombre: 'Koopa verde' },
  { id: 'RedKoopaTroopa', nombre: 'Koopa roja' },
  { id: 'Magikoopa', nombre: 'Magikoopa' },
  { id: 'Thwomp', nombre: 'Thwomp' },
  { id: 'HammerBro', nombre: 'Hammer Bro' },
  { id: 'Lakitu', nombre: 'Lakitu' },
  { id: 'BulletBill', nombre: 'Bullet Bill' },
  { id: 'KingBill', nombre: 'King Bill' },
  { id: 'BigBill', nombre: 'Big Bill' },
  { id: 'Boo', nombre: 'Boo' },
  { id: 'DryBones', nombre: 'Dry Bones' },
  { id: 'PiranhaPlant', nombre: 'Planta Piraña' },
  { id: 'PlantCreeper', nombre: 'Planta trepadora' },
  { id: 'PlantFire', nombre: 'Planta de fuego' },
  { id: 'Muncher', nombre: 'Muncher' },
  { id: 'ChainChomp', nombre: 'Chain Chomp' },
  { id: 'BobOmb', nombre: 'Bob-omb' },
  { id: 'CheepCheep', nombre: 'Cheep Cheep' },
  { id: 'Fishbone', nombre: 'Fishbone' },
  { id: 'FlyingFish', nombre: 'Pez volador' },
  { id: 'Squid', nombre: 'Calamar' },
  { id: 'Pokey', nombre: 'Pokey' },
  { id: 'Spike', nombre: 'Spike' },
  { id: 'Ninji', nombre: 'Ninji' },
  { id: 'Sidestepper', nombre: 'Sidestepper' },
  { id: 'TorpedoTed', nombre: 'Torpedo Ted' },
  { id: 'Fuzzy', nombre: 'Fuzzy' },
  { id: 'Amp', nombre: 'Amp' },
  { id: 'Mole', nombre: 'Topo' },
  { id: 'BigMole', nombre: 'Topo gigante' },
  { id: 'ParaBeetle', nombre: 'Parabeetle' },
  { id: 'RockyWrench', nombre: 'Rocky Wrench' },
  { id: 'Grinder', nombre: 'Grinder' },
  { id: 'Icicle', nombre: 'Carámbano' },
  { id: 'Fire', nombre: 'Fuego (enemigo)' },
  { id: 'CastleFire', nombre: 'Fuego de castillo' },
  { id: 'UpFire', nombre: 'Up Fire' },
  { id: 'Cannonball', nombre: 'Bala de cañón' },
  { id: 'Turret', nombre: 'Torreta' },
  { id: 'RocketTurret', nombre: 'Torreta cohete' },
  { id: 'Skewer', nombre: 'Skewer' },
  { id: 'Barrel', nombre: 'Barril' },
  { id: 'Glados', nombre: 'GLaDOS' },
  { id: 'Meteor', nombre: 'Meteoro' },
  { id: 'AngrySun', nombre: 'Sol furioso' },
];
const MARI0_BOSSES = [
  { id: 'Bowser', nombre: 'Bowser' },
  { id: 'BoomBoom', nombre: 'Boom Boom' },
  { id: 'BowserFire', nombre: 'Fuego de Bowser' },
];
const MARI0_PROJECTILES = [
  { id: 'Fireball', nombre: 'Bolas de fuego (ráfaga)' },
  { id: 'BroFireball', nombre: 'Bolas Hammer Bro' },
];
const MARI0_MECHANICS = [
  { id: 'Box', nombre: 'Caja Portal' },
  { id: 'Donut', nombre: 'Donut' },
  { id: 'FlipBlock', nombre: 'Bloque flip' },
  { id: 'Miniblock', nombre: 'Minibloque' },
  { id: 'PowBlock', nombre: 'Pow Block' },
  { id: 'Spring', nombre: 'Resorte' },
  { id: 'SmallSpring', nombre: 'Resorte pequeño' },
];
const MARI0_CHAOS = [
  { id: 'GoombaAttack', nombre: 'Goombas al caminar' },
  { id: 'MeteorShower', nombre: 'Lluvia de meteoros' },
  { id: 'BulletBillStorm', nombre: 'Tormenta Bullet Bill' },
  { id: 'FlyingFishStorm', nombre: 'Peces voladores (caos)' },
  { id: 'Wind', nombre: 'Viento' },
];
const MARI0_EFFECTS = [
  { id: 'giant', nombre: 'Enemigos gigantes', seconds: 5, factor: 0 },
  { id: 'tiny', nombre: 'Juego más lento', seconds: 5, factor: 0 },
];
const MARI0_CATALOG = [
  ...MARI0_POWERUPS.map((x) => ({ ...x, tipo: 'item', kind: 'spawn' })),
  ...MARI0_ENEMIES.map((x) => ({ ...x, tipo: 'enemy', kind: 'spawn' })),
  ...MARI0_BOSSES.map((x) => ({ ...x, tipo: 'boss', kind: 'spawn' })),
  ...MARI0_PROJECTILES.map((x) => ({ ...x, tipo: 'projectile', kind: 'spawn' })),
  ...MARI0_MECHANICS.map((x) => ({ ...x, tipo: 'mechanic', kind: 'spawn' })),
  ...MARI0_CHAOS.map((x) => ({ ...x, tipo: 'chaos', kind: 'spawn' })),
  ...MARI0_EFFECTS.map((x) => ({ ...x, tipo: 'effect', kind: 'effect' })),
];
const MARI0_CAT_ICON = { item: '🍄', enemy: '👾', boss: '👑', projectile: '💥', mechanic: '🔧', chaos: '🌪️', effect: '✨' };
const MARI0_ICON_DIR = '/img/mari0/';

function mari0CatalogIconUrl(entry) {
  const id = entry?.id || entry?.thing;
  if (!id) return '';
  return `${MARI0_ICON_DIR}${id}.png`;
}

function mari0CatalogIconHtml(entry) {
  const emoji = MARI0_CAT_ICON[entry?.tipo] || (entry?.kind === 'effect' ? '✨' : '🎮');
  const src = mari0CatalogIconUrl(entry);
  if (!src) return `<span class="mc-cat-emoji">${emoji}</span>`;
  return `<img class="mc-cat-ic" src="${esc(src)}" alt="" onerror="this.outerHTML='<span class=\\'mc-cat-emoji\\'>${emoji}</span>'">`;
}

const MARI0_TIPO_LABEL = {
  item: 'Power-up', enemy: 'Enemigo', boss: 'Jefe', projectile: 'Proyectil',
  mechanic: 'Mecánica', chaos: 'Caos de nivel', effect: 'Efecto visual',
};

function ensureMari0Actions() {
  if (!settings) return [];
  if (!Array.isArray(settings.mari0Actions)) settings.mari0Actions = [];
  settings.mari0Actions = migrateGameActions(settings.mari0Actions, 'm0');
  return settings.mari0Actions;
}

function setupSmb3LaunchBtn() {
  const dlBtns = [
    { id: 'smb3-dl-mod', label: 'mod' },
    { id: 'smb3-dl-rom', label: 'ROM' },
    { id: 'smb3-dl-emulator', label: 'emulador' },
  ];
  for (const { id, label } of dlBtns) {
    const btn = document.getElementById(id);
    if (!btn || btn._wired) continue;
    btn._wired = true;
    btn.onclick = () => {
      const url = (btn.dataset.url || '').trim();
      if (!url) { toast && toast(`Enlace de descarga no disponible (${label}).`, 'warn'); return; }
      downloadMinecraftServer(url);
      toast && toast(`Descargando ${label}…`, 'ok');
    };
  }
  const testBtn = document.getElementById('smb3-test');
  if (testBtn && !testBtn._wired) {
    testBtn._wired = true;
    if (!IS_DESKTOP) testBtn.style.display = 'none';
    else {
      testBtn.onclick = async () => {
        testBtn.disabled = true;
        const prev = testBtn.textContent;
        testBtn.textContent = '⏳ Probando…';
        try {
          const h = await refreshSmb3Status();
          if (smb3HealthOk(h)) toast && toast('SMB3 Livecoins conectado (bridge :7755).', 'ok');
          else toast && toast('Sin bridge SMB3. Abre SMB3 Livecoins desde el escritorio y entra a un nivel.', 'warn');
        } finally {
          testBtn.disabled = false;
          testBtn.textContent = prev;
        }
      };
    }
  }
}

/* ================= Acciones de Super Mario Bros. 3 (FCEUX + smb3-bridge :7755) ================= */
const SMB3_SPAWN_ID_TO_THING = {
  11: 'OneUp', 12: 'SuperStar', 13: 'SuperMushroom', 25: 'FireFlower', 30: 'Leaf',
  47: 'Boo', 63: 'DryBones', 108: 'GreenKoopaTroopa', 109: 'RedKoopaTroopa', 112: 'BuzzyBeetle',
  113: 'Spiny', 114: 'Goomba', 115: 'ParaGoomba', 119: 'CheepCheep', 124: 'GiantGoomba',
  129: 'HammerBro', 130: 'BoomerangBro', 131: 'Lakitu', 134: 'SledgeBro', 135: 'FireBro',
  137: 'ChainChomp', 138: 'Thwomp', 152: 'TanookiSuit', 153: 'FrogSuit', 154: 'HammerSuit',
  160: 'PiranhaPlant', 188: 'BulletBill',
};
const SMB3_NPC_MAP = {
  1: 'Goomba', 4: 'GreenKoopaTroopa', 6: 'RedKoopaTroopa', 9: 'SuperMushroom', 14: 'FireFlower',
  17: 'BulletBill', 29: 'HammerBro', 37: 'Thwomp', 43: 'Boo', 90: 'OneUp', 189: 'DryBones', 293: 'SuperStar', 512: 'PiranhaPlant',
};
const SMB3_CAT_ORDER = ['enemy', 'powerup', 'boss', 'projectile', 'item'];
const SMB3_CAT_ICON = {
  enemy: '👾', powerup: '🍄', boss: '👑', projectile: '💥', item: '🎁',
};
const SMB3_CAT_LABEL = {
  enemy: 'Enemigos', powerup: 'Power-ups', boss: 'Bosses', projectile: 'Proyectiles', item: 'Objetos',
};
const SMB3_SKIP_CATEGORIES = new Set(['nothing', 'unsafe', 'platform', 'special', 'meta', 'effect']);
/** Power-ups con `thing` exacto del bridge (POST /spawn). Aparecen primero en la sección Power-ups. */
const SMB3_POWERUP_PRESETS = [
  { id: 'powerup_SuperMushroom', thing: 'SuperMushroom', spawnId: 13, hex: '0x0D', npcId: 9, nombre: 'Super Mushroom', category: 'powerup', tipo: 'powerup', kind: 'spawn', preset: true },
  { id: 'powerup_FireFlower', thing: 'FireFlower', spawnId: 25, hex: '0x19', npcId: 14, nombre: 'Flor de fuego', category: 'powerup', tipo: 'powerup', kind: 'spawn', preset: true },
  { id: 'powerup_Leaf', thing: 'Leaf', spawnId: 30, hex: '0x1E', npcId: 34, nombre: 'Super Leaf', category: 'powerup', tipo: 'powerup', kind: 'spawn', preset: true },
  { id: 'powerup_FrogSuit', thing: 'FrogSuit', spawnId: 153, hex: '0x99', nombre: 'Traje rana', category: 'powerup', tipo: 'powerup', kind: 'spawn', preset: true },
  { id: 'powerup_TanookiSuit', thing: 'TanookiSuit', spawnId: 152, hex: '0x98', nombre: 'Traje tanuki', category: 'powerup', tipo: 'powerup', kind: 'spawn', preset: true },
  { id: 'powerup_HammerSuit', thing: 'HammerSuit', spawnId: 154, hex: '0x9A', nombre: 'Traje martillo', category: 'powerup', tipo: 'powerup', kind: 'spawn', preset: true },
  { id: 'powerup_SuperStar', thing: 'SuperStar', spawnId: 12, hex: '0x0C', npcId: 293, nombre: 'Super Star', category: 'powerup', tipo: 'powerup', kind: 'spawn', preset: true },
  { id: 'powerup_OneUp', thing: 'OneUp', spawnId: 11, hex: '0x0B', npcId: 90, nombre: '1-Up', category: 'powerup', tipo: 'powerup', kind: 'spawn', preset: true },
];
const SMB3_CATALOG = [];

function extractSmb3Entities(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw?.entities && Array.isArray(raw.entities)) return raw.entities;
  return raw?.items || raw?.catalog || [];
}

function smb3HealthOk(h) {
  if (!h || !h.ok) return false;
  return h.bridge === 'smb3-livecoins' || h.game === 'smb3';
}


function bridgeGameLabel(h) {
  if (!h) return '';
  if (h.bridge === 'smb3-livecoins' || h.game === 'smb3') return 'SMB3';
  return h.bridge || h.game || '';
}

function ensureSmb3Actions() {
  if (!settings) return [];
  if (!Array.isArray(settings.smb3Actions)) settings.smb3Actions = [];
  settings.smb3Actions = migrateGameActions(settings.smb3Actions, 's3');
  return settings.smb3Actions;
}

function catalogEntryToSmb3(c) {
  const spawnId = Number(c.id);
  const cat = String(c.category || 'enemy').toLowerCase();
  const thing = c.thing || SMB3_SPAWN_ID_TO_THING[spawnId] || undefined;
  const npcEntry = thing ? Object.entries(SMB3_NPC_MAP).find(([, v]) => v === thing) : null;
  return {
    id: `spawn_${spawnId}`,
    thing,
    spawnId,
    hex: c.hex,
    npcId: npcEntry ? Number(npcEntry[0]) : undefined,
    nombre: c.name || thing || `ID ${spawnId}`,
    category: cat,
    tipo: cat,
    kind: 'spawn',
  };
}

function applySmb3PowerupPresets() {
  const presetSpawnIds = new Set(SMB3_POWERUP_PRESETS.map((p) => p.spawnId));
  const rest = SMB3_CATALOG.filter((c) => !(c.tipo === 'powerup' && presetSpawnIds.has(c.spawnId)));
  const firstPu = rest.findIndex((c) => c.tipo === 'powerup');
  if (firstPu < 0) rest.push(...SMB3_POWERUP_PRESETS);
  else rest.splice(firstPu, 0, ...SMB3_POWERUP_PRESETS);
  SMB3_CATALOG.length = 0;
  SMB3_CATALOG.push(...rest);
}

async function loadSmb3Catalog() {
  const applyList = (list) => {
    if (!Array.isArray(list) || !list.length) return false;
    SMB3_CATALOG.length = 0;
    for (const c of list) {
      if (c.safe === false) continue;
      const spawnId = Number(c.id);
      if (!Number.isFinite(spawnId) || spawnId > 214) continue;
      const cat = String(c.category || '').toLowerCase();
      if (SMB3_SKIP_CATEGORIES.has(cat)) continue;
      SMB3_CATALOG.push(catalogEntryToSmb3(c));
    }
    applySmb3PowerupPresets();
    return SMB3_CATALOG.length > 0;
  };
  const applyRaw = (raw) => applyList(extractSmb3Entities(raw));
  try {
    const r = await fetch('/api/desktop/smb3-catalog', { credentials: 'same-origin' });
    const d = await r.json().catch(() => ({}));
    if (d.ok && applyList(d.catalog)) return;
  } catch { /* ignore */ }
  try {
    const r = await fetch(`/smb3-catalog.json?t=${Date.now()}`, { cache: 'no-store' });
    if (r.ok && applyRaw(await r.json())) return;
  } catch { /* ignore */ }
}

let smb3StatusTimer = null;

function renderSmb3Status(h) {
  const el = document.getElementById('smb3-status');
  if (!el) return;
  if (!IS_DESKTOP) { el.innerHTML = ''; return; }
  if (!h || !h.ok) {
    el.innerHTML = '<span class="mari0-st off">SMB3 bridge :7755 — sin conexión</span>';
    return;
  }
  if (!smb3HealthOk(h)) {
    const other = bridgeGameLabel(h);
    const msg = other ? `Bridge «${esc(other)}» en :7755 — abre SMB3` : 'SMB3 bridge :7755 — sin conexión';
    el.innerHTML = `<span class="mari0-st off">${msg}</span>`;
    return;
  }
  el.innerHTML = '<span class="mari0-st on">SMB3 Livecoins conectado</span><span class="mari0-st on">127.0.0.1:7755</span>';
}

async function refreshSmb3Status() {
  if (!IS_DESKTOP) return null;
  try {
    const r = await fetch('/api/desktop/smb3-health', { credentials: 'same-origin' });
    const d = await r.json().catch(() => ({}));
    if (d.health) {
      renderSmb3Status(d.health);
      return d.health;
    }
  } catch { /* fallback */ }
  try {
    const r = await fetch('http://127.0.0.1:7755/health');
    const h = await r.json();
    renderSmb3Status(h);
    return h;
  } catch {
    renderSmb3Status(null);
    return null;
  }
}

function setupSmb3StatusPoll() {
  if (!IS_DESKTOP || smb3StatusTimer) return;
  refreshSmb3Status();
  smb3StatusTimer = setInterval(() => {
    const view = document.getElementById('view-juego-smb3');
    if (view?.classList.contains('active')) refreshSmb3Status();
  }, 2500);
}

function setupSmb3ActionsUI() {
  const search = document.getElementById('smb3-cat-search');
  if (search && !search._wired) { search._wired = true; search.oninput = () => renderSmb3Catalog(search.value); }
  const toggleAll = document.getElementById('smb3-toggle-all');
  if (toggleAll && !toggleAll._wired) {
    toggleAll._wired = true;
    toggleAll.onclick = () => {
      const list = ensureSmb3Actions();
      if (!list.length) { toast && toast('Primero agrega acciones del catálogo.', 'warn'); return; }
      const anyOff = list.some((a) => a.enabled === false);
      list.forEach((a) => { a.enabled = anyOff; });
      saveSettings(); renderSmb3Actions();
      toast && toast(anyOff ? 'Todas las acciones encendidas.' : 'Todas las acciones apagadas.', 'ok');
    };
  }
  loadSmb3Catalog().finally(() => {
    renderSmb3Catalog(search ? search.value : '');
    renderSmb3Actions();
  });
}

function smb3CatCardHtml(c) {
  return `
    <div class="mc-cat-card" data-id="${esc(c.id)}">
      <div class="mc-cat-head-row">
        <span class="mc-cat-emoji">${SMB3_CAT_ICON[c.tipo] || '🎮'}</span>
        <div class="mc-cat-texts">
          <div class="mc-cat-name">${esc(c.nombre)}</div>
          <div class="mc-cat-desc">${c.spawnId != null ? `ID ${c.spawnId}${c.hex ? ` · ${esc(c.hex)}` : ''}` : esc(SMB3_CAT_LABEL[c.tipo] || '')}</div>
        </div>
      </div>
      <button type="button" class="mc-cat-add">+ Agregar</button>
    </div>`;
}

function renderSmb3Catalog(filter) {
  const grid = document.getElementById('smb3-catalog');
  if (!grid) return;
  const f = (filter || '').trim().toLowerCase();
  const list = f
    ? SMB3_CATALOG.filter((c) =>
      c.nombre.toLowerCase().includes(f)
      || String(c.id).toLowerCase().includes(f)
      || String(c.spawnId || '').includes(f)
      || String(c.hex || '').toLowerCase().includes(f)
      || (c.thing || '').toLowerCase().includes(f))
    : SMB3_CATALOG;
  if (!list.length) {
    grid.innerHTML = '<div class="empty">Sin resultados. Comprueba que exista smb3-catalog.json.</div>';
    return;
  }

  const byCat = new Map();
  for (const c of list) {
    const cat = c.tipo || c.category || 'other';
    if (!byCat.has(cat)) byCat.set(cat, []);
    byCat.get(cat).push(c);
  }

  const order = f
    ? [...byCat.keys()].sort((a, b) => SMB3_CAT_ORDER.indexOf(a) - SMB3_CAT_ORDER.indexOf(b))
    : SMB3_CAT_ORDER.filter((cat) => byCat.has(cat));

  grid.innerHTML = order.map((cat) => {
    const items = byCat.get(cat) || [];
    const presetOrder = cat === 'powerup' ? SMB3_POWERUP_PRESETS.map((p) => p.id) : [];
    items.sort((a, b) => {
      if (presetOrder.length) {
        const ai = presetOrder.indexOf(a.id);
        const bi = presetOrder.indexOf(b.id);
        if (ai >= 0 && bi >= 0) return ai - bi;
        if (ai >= 0) return -1;
        if (bi >= 0) return 1;
      }
      return (Number(a.spawnId) || 0) - (Number(b.spawnId) || 0);
    });
    return `
      <div class="smb3-cat-section">
        <h4 class="mc-sub-title smb3-cat-title">${SMB3_CAT_ICON[cat] || '🎮'} ${esc(SMB3_CAT_LABEL[cat] || cat)} <span class="smb3-cat-count">(${items.length})</span></h4>
        <div class="mc-catalog smb3-cat-grid">${items.map((c) => smb3CatCardHtml(c)).join('')}</div>
      </div>`;
  }).join('');

  grid.querySelectorAll('.mc-cat-card').forEach((card) => {
    card.querySelector('.mc-cat-add').onclick = () => addSmb3Action(card.dataset.id);
  });
}

function addSmb3Action(id) {
  const c = SMB3_CATALOG.find((x) => x.id === id);
  if (!c) return;
  const list = ensureSmb3Actions();
  list.push({
    uid: 's3_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
    thing: c.thing || c.id,
    spawnId: c.spawnId,
    hex: c.hex,
    npcId: c.npcId,
    label: c.nombre,
    tipo: c.tipo,
    category: c.category,
    kind: c.kind || 'spawn',
    seconds: c.seconds,
    trigger: 'gift',
    enabled: true,
    count: 1,
  });
  saveSettings();
  renderSmb3Actions();
  toast && toast(`Acción «${c.nombre}» agregada.`, 'ok');
}

async function testSmb3Action(a) {
  if (!a) return;
  const label = a.label || a.thing || 'acción';
  if (!IS_DESKTOP) { toast && toast('SMB3 solo funciona en la app de escritorio (.exe).', 'warn'); return; }

  toast && toast(`🎮 «${label}» en 2 s… (entra a un nivel en FCEUX)`, 'ok');
  await new Promise((r) => setTimeout(r, 2000));

  const h = await refreshSmb3Status();
  if (!smb3HealthOk(h)) {
    toast && toast('Bridge SMB3 no detectado. Abre SMB3 Livecoins desde el escritorio.', 'warn');
    return;
  }

  if (a.kind === 'effect') {
    const seconds = Math.max(1, parseInt(a.seconds, 10) || 5);
    const r = await execGameLocal({ tipo: 'SMB3_EFFECT', effect: a.thing, name: 'Prueba', seconds });
    if (r && r.ok !== false) addEvent(`🎮 Prueba SMB3: efecto ${esc(label)}`, 'ok');
    else toast && toast(r?.error === 'no_handled' ? 'El juego no procesó el efecto (¿estás en un nivel?).' : 'Efecto no enviado.', 'warn');
    return;
  }

  const times = Math.max(1, Math.min(200, parseInt(a.count, 10) || 1));
  const r = await execGameLocal({
    tipo: 'SMB3_SPAWN',
    thing: a.thing,
    spawnId: a.spawnId,
    npcId: a.npcId,
    name: 'Prueba',
    times,
  });
  if (r && r.ok !== false) {
    addEvent(`🎮 Prueba SMB3: ${esc(label)}${times > 1 ? ` ×${times}` : ''}`, 'ok');
  } else {
    toast && toast(r?.error === 'no_handled' ? 'Spawn no procesado (¿FCEUX dentro de un nivel?).' : `Spawn falló («${label}»).`, 'warn');
  }
}

function smb3CardHtml(a) {
  const opts = MC_TRIGGERS.map((t) => `<option value="${t.v}" ${a.trigger === t.v ? 'selected' : ''}>${t.label}</option>`).join('');
  const uid = esc(a.uid);
  const giftBtn = gameActionGiftUi(a, 'smb3-gift');
  const likeRow = gameActionExtraRow(a, 'smb3-like-n', 'smb3-text-n');
  const emoji = a.kind === 'effect' ? '✨' : (SMB3_CAT_ICON[a.tipo] || '👾');
  let qtyRow;
  if (a.kind === 'effect') {
    qtyRow = `<label class="mc-like-row" style="max-width:120px">Segundos<input type="number" min="1" max="60" class="smb3-seconds" data-uid="${uid}" value="${esc(String(a.seconds || 5))}"></label>`;
  } else {
    qtyRow = `<label class="mc-like-row" style="max-width:130px">Cantidad<input type="number" min="1" max="200" class="smb3-count" data-uid="${uid}" value="${esc(String(a.count || 1))}"></label>`;
  }
  return `
  <div class="mc-act-card ${a.enabled === false ? 'mc-off' : ''}" data-uid="${uid}">
    <div class="mc-act-top">
      <span class="mc-act-name">${emoji} ${esc(a.label || a.thing)}</span>
      <button type="button" class="mc-act-del smb3-del" data-uid="${uid}" title="Quitar">✕</button>
    </div>
    <div class="mc-act-row">
      <select class="smb3-trig-sel" data-uid="${uid}">${opts}</select>
      ${giftBtn}
      ${likeRow}
    </div>
    <div class="mc-act-row">${qtyRow}</div>
    ${((a.trigger || 'gift') === 'gift' || a.trigger === 'gift-any') ? `<div class="mc-act-row">${mcCardComboInstantHtml(a).replace('mc-combo-instant-en', 'smb3-combo-instant-en')}</div>` : ''}
    <div class="mc-act-actions">
      <label class="mc-act-toggle"><input type="checkbox" class="smb3-en" data-uid="${uid}" ${a.enabled === false ? '' : 'checked'}> Activa</label>
      <div class="mc-act-btns">
        <button type="button" class="mc-act-test smb3-test" data-uid="${uid}">Probar</button>
      </div>
    </div>
  </div>`;
}

function renderSmb3Actions() {
  const wrap = document.getElementById('smb3-my-actions');
  if (!wrap || !settings) return;
  const list = ensureSmb3Actions();
  if (!list.length) {
    wrap.innerHTML = '<div class="mc-empty">Aún no agregaste acciones. Elige una del catálogo de abajo.</div>';
    return;
  }
  wrap.innerHTML = list.map((a) => smb3CardHtml(a)).join('');
  const find = (uid) => list.find((x) => x.uid === uid);
  wrap.querySelectorAll('.smb3-del').forEach((b) => b.onclick = () => { settings.smb3Actions = list.filter((x) => x.uid !== b.dataset.uid); saveSettings(); renderSmb3Actions(); });
  bindGameTriggerSelects(wrap, 'smb3-trig-sel', 'smb3Actions', renderSmb3Actions);
  wrap.querySelectorAll('.smb3-en').forEach((c) => c.onchange = () => { const a = find(c.dataset.uid); if (!a) return; a.enabled = c.checked; saveSettings(); renderSmb3Actions(); });
  wrap.querySelectorAll('.smb3-like-n').forEach((inp) => inp.onchange = () => { const a = find(inp.dataset.uid); if (!a) return; a.likeN = Math.max(1, parseInt(inp.value, 10) || 1); saveSettings(); });
  wrap.querySelectorAll('.smb3-text-n').forEach((inp) => inp.onchange = () => { const a = find(inp.dataset.uid); if (!a) return; a.text = inp.value.trim(); saveSettings(); });
  wrap.querySelectorAll('.smb3-count').forEach((inp) => inp.onchange = () => { const a = find(inp.dataset.uid); if (!a) return; a.count = Math.max(1, Math.min(200, parseInt(inp.value, 10) || 1)); saveSettings(); });
  wrap.querySelectorAll('.smb3-seconds').forEach((inp) => inp.onchange = () => { const a = find(inp.dataset.uid); if (!a) return; a.seconds = Math.max(1, Math.min(60, parseInt(inp.value, 10) || 5)); saveSettings(); });
  wrap.querySelectorAll('.smb3-combo-instant-en').forEach((c) => c.onchange = () => { const a = find(c.dataset.uid); if (!a) return; a.comboInstant = c.checked; saveSettings(); });
  wrap.querySelectorAll('.smb3-test').forEach((b) => b.onclick = () => testSmb3Action(find(b.dataset.uid)));
  bindGameActionGiftButtons(wrap, 'smb3-gift', 'smb3Actions', renderSmb3Actions);
}

function setupMari0LaunchBtn() {
  const room = document.getElementById('mari0-room');
  if (room && !room._wired) {
    room._wired = true;
    room.onclick = () => {
      const url = (room.dataset.url || '').trim();
      if (!url) { toast && toast('Enlace de descarga no disponible.', 'warn'); return; }
      downloadMinecraftServer(url);
      toast && toast('Descargando Mari0…', 'ok');
    };
  }
  const bridgeBtn = document.getElementById('mari0-bridge');
  if (bridgeBtn && !bridgeBtn._wired) {
    bridgeBtn._wired = true;
    if (!IS_DESKTOP) bridgeBtn.style.display = 'none';
    else {
      bridgeBtn.onclick = async () => {
        bridgeBtn.disabled = true;
        const prev = bridgeBtn.textContent;
        bridgeBtn.textContent = '⏳ Bridge…';
        try {
          const r = await ensureGameBridgeApi('mari0');
          if (r.ok && bridgeHealthMatchesMode(r.health, 'mari0')) {
            toast && toast('Bridge Mari0 activo en :7755', 'ok');
            refreshMari0Status();
          } else if (!r.status?.script) {
            toast && toast('No se encontró livecoins-bridge-server.js. Reinstala Livecoins.', 'warn');
          } else {
            toast && toast('No se pudo iniciar el bridge Mari0.', 'warn');
          }
        } finally {
          bridgeBtn.disabled = false;
          bridgeBtn.textContent = prev;
        }
      };
    }
  }
}

function setupMari0ActionsUI() {
  const search = document.getElementById('mari0-cat-search');
  if (search && !search._wired) { search._wired = true; search.oninput = () => renderMari0Catalog(search.value); }
  const toggleAll = document.getElementById('mari0-toggle-all');
  if (toggleAll && !toggleAll._wired) {
    toggleAll._wired = true;
    toggleAll.onclick = () => {
      const list = ensureMari0Actions();
      if (!list.length) { toast && toast('Primero agrega acciones del catálogo.', 'warn'); return; }
      const anyOff = list.some((a) => a.enabled === false);
      list.forEach((a) => { a.enabled = anyOff; });
      saveSettings(); renderMari0Actions();
      toast && toast(anyOff ? 'Todas las acciones encendidas.' : 'Todas las acciones apagadas.', 'ok');
    };
  }
  renderMari0Catalog(search ? search.value : '');
  renderMari0Actions();
}

function renderMari0Catalog(filter) {
  const grid = document.getElementById('mari0-catalog');
  if (!grid) return;
  const f = (filter || '').trim().toLowerCase();
  const list = f ? MARI0_CATALOG.filter((c) => c.nombre.toLowerCase().includes(f) || c.id.toLowerCase().includes(f)) : MARI0_CATALOG;
  if (!list.length) { grid.innerHTML = '<div class="empty">Sin resultados</div>'; return; }
  grid.innerHTML = list.map((c) => `
    <div class="mc-cat-card" data-id="${esc(c.id)}">
      <div class="mc-cat-head-row">
        ${mari0CatalogIconHtml(c)}
        <div class="mc-cat-texts">
          <div class="mc-cat-name">${esc(c.nombre)}</div>
          <div class="mc-cat-desc">${esc(MARI0_TIPO_LABEL[c.tipo] || '')}</div>
        </div>
      </div>
      <button type="button" class="mc-cat-add">+ Agregar</button>
    </div>`).join('');
  grid.querySelectorAll('.mc-cat-card').forEach((card) => {
    card.querySelector('.mc-cat-add').onclick = () => addMari0Action(card.dataset.id);
  });
}

function addMari0Action(thing) {
  const c = MARI0_CATALOG.find((x) => x.id === thing);
  if (!c) return;
  if (!settings) { toast && toast('Espera a que cargue el panel…', 'warn'); return; }
  const list = ensureMari0Actions();
  list.push({
    uid: 'm0_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
    thing: c.id,
    label: c.nombre, tipo: c.tipo, kind: c.kind || 'spawn',
    trigger: 'gift', giftId: '', giftName: '', giftImage: '',
    count: 1, seconds: c.seconds != null ? c.seconds : 5, factor: c.factor != null ? c.factor : 0,
    text: '', enabled: true,
  });
  saveSettings(); renderMari0Actions();
  toast && toast(`Acción "${c.nombre}" agregada. Elige el regalo o evento.`, 'ok');
}

async function testMari0Action(a) {
  if (!a || !a.thing) return;
  const label = a.label || a.thing;
  if (!IS_DESKTOP) { toast && toast('Mari0 solo funciona en la app de escritorio (.exe).', 'warn'); return; }

  toast && toast(`Probando «${label}»… Abre Mari0, entra a un nivel y espera 2 s.`, 'ok');
  await new Promise((r) => setTimeout(r, 2000));

  const bridgeH = await waitGameBridge('mari0');
  if (!bridgeH) {
    toast && toast('Bridge Mari0 no arrancó. Pulsa «Iniciar bridge».', 'warn');
    return;
  }

  if (a.kind === 'effect') {
    const seconds = Math.max(1, parseInt(a.seconds, 10) || 5);
    const factor = Math.max(0, parseInt(a.factor, 10) || 0);
    const r = await execGameLocal({ tipo: 'MARI0_EFFECT', type: a.thing, seconds, factor });
    if (r && r.ok !== false) {
      addEvent(`🌀 Prueba Mari0: efecto ${esc(label)}`, 'ok');
      const h2 = await waitMari0GameLink(4000);
      warnMari0NotConnected(h2 || bridgeH);
    } else toast && toast('Efecto no enviado. Pulsa «Iniciar bridge».', 'warn');
    return;
  }
  const times = Math.max(1, Math.min(200, parseInt(a.count, 10) || 1));
  const r = await execGameLocal({
    tipo: 'MARI0_SPAWN',
    thing: a.thing,
    name: 'Prueba',
    times,
  });
  if (r && r.ok !== false) {
    addEvent(`🌀 Prueba Mari0: ${esc(label)}${times > 1 ? ` ×${times}` : ''}`, 'ok');
    const h2 = await waitMari0GameLink(4000);
    warnMari0NotConnected(h2 || bridgeH);
  } else {
    toast && toast(`Spawn falló («${label}»). Inicia bridge, abre Mari0 y entra a un nivel.`, 'warn');
  }
}

function mari0CardHtml(a) {
  const opts = MC_TRIGGERS.map((t) => `<option value="${t.v}" ${a.trigger === t.v ? 'selected' : ''}>${t.label}</option>`).join('');
  const uid = esc(a.uid);
  let giftBtn = '';
  if ((a.trigger || 'gift') === 'gift') {
    const ic = a.giftImage ? `<img class="mc-gift-ic" src="${esc(a.giftImage)}" onerror="this.outerHTML='🎁'">` : '🎁';
    giftBtn = `<button type="button" class="mc-gift-btn mari0-gift" data-uid="${uid}">${ic}<span class="mc-gift-name">${a.giftName ? esc(a.giftName) : 'Elegir regalo'}</span></button>`;
  } else {
    const ev = MC_TRIG_ICON[a.trigger] || { ic: '⚡', label: a.trigger };
    const lbl = (MC_TRIGGERS.find((t) => t.v === a.trigger) || {}).label || ev.label;
    giftBtn = `<div class="mc-ev-badge"><span class="mc-ev-ic">${ev.ic}</span><span class="mc-gift-name">${esc(lbl)}</span></div>`;
  }
  let likeRow = '';
  if (a.trigger === 'like' || a.trigger === 'likeGlobal') {
    const defN = a.trigger === 'likeGlobal' ? 100 : 1;
    const val = a.likeN != null ? a.likeN : defN;
    const txt = a.trigger === 'likeGlobal' ? 'Cada cuántos likes globales' : 'Mínimo de likes (por tanda)';
    likeRow = `<label class="mc-like-row">${txt}<input type="number" min="1" class="mari0-like-n" data-uid="${uid}" value="${esc(String(val))}"></label>`;
  } else if (a.trigger === 'chatUser' || a.trigger === 'chatCommand') {
    const txt = a.trigger === 'chatUser' ? 'Nombre de usuario (sin @)' : 'Palabra o comando (ej. !goomba)';
    const ph = a.trigger === 'chatUser' ? 'usuario123' : '!goomba';
    likeRow = `<label class="mc-like-row">${txt}<input type="text" class="mari0-text-n" data-uid="${uid}" value="${esc(a.text || '')}" placeholder="${ph}"></label>`;
  }
  const emoji = MARI0_CAT_ICON[a.tipo] || (a.kind === 'effect' ? '✨' : '🎮');
  const iconSrc = mari0CatalogIconUrl(a);
  const nameHtml = iconSrc
    ? `<span class="mc-act-name"><img class="mc-act-ic" src="${esc(iconSrc)}" alt="" onerror="this.outerHTML='${emoji} '">${esc(a.label || a.thing)}</span>`
    : `<span class="mc-act-name">${emoji} ${esc(a.label || a.thing)}</span>`;
  let qtyRow;
  if (a.kind === 'effect') {
    qtyRow = `
      <label class="mc-like-row" style="max-width:120px">Segundos<input type="number" min="1" max="60" class="mari0-seconds" data-uid="${uid}" value="${esc(String(a.seconds || 5))}"></label>
      <label class="mc-like-row" style="max-width:160px">Tamaño (x, 0=auto)<input type="number" min="0" max="10" class="mari0-factor" data-uid="${uid}" value="${esc(String(a.factor || 0))}"></label>`;
  } else {
    const mari0MaxCount = (a.tipo === 'chaos' || (a.tipo === 'item' && !/^Spawn/i.test(a.thing || ''))) ? 1 : 200;
    const qtyHint = mari0MaxCount === 1 ? ' (máx. 1)' : '';
    qtyRow = `<label class="mc-like-row" style="max-width:130px">Cantidad${qtyHint}<input type="number" min="1" max="${mari0MaxCount}" class="mari0-count" data-uid="${uid}" value="${esc(String(Math.min(mari0MaxCount, parseInt(a.count, 10) || 1)))}"></label>`;
  }
  return `
  <div class="mc-act-card ${a.enabled === false ? 'mc-off' : ''}" data-uid="${uid}">
    <div class="mc-act-top">
      ${nameHtml}
      <button type="button" class="mc-act-del mari0-del" data-uid="${uid}" title="Quitar">✕</button>
    </div>
    <div class="mc-act-row">
      <select class="mari0-trig-sel" data-uid="${uid}">${opts}</select>
      ${giftBtn}
      ${likeRow}
    </div>
    <div class="mc-act-row">
      ${qtyRow}
    </div>
    ${((a.trigger || 'gift') === 'gift' || a.trigger === 'gift-any') ? `<div class="mc-act-row">${mcCardComboInstantHtml(a).replace('mc-combo-instant-en', 'mari0-combo-instant-en')}</div>` : ''}
    <div class="mc-act-actions">
      <label class="mc-act-toggle"><input type="checkbox" class="mari0-en" data-uid="${uid}" ${a.enabled === false ? '' : 'checked'}> Activa</label>
      <div class="mc-act-btns">
        <button type="button" class="mc-act-test mari0-test" data-uid="${uid}">Probar</button>
      </div>
    </div>
  </div>`;
}

function renderMari0Actions() {
  const wrap = document.getElementById('mari0-my-actions');
  if (!wrap || !settings) return;
  const list = ensureMari0Actions();
  if (!list.length) {
    wrap.innerHTML = '<div class="mc-empty">Aún no agregaste acciones. Elige una del catálogo de abajo.</div>';
    return;
  }
  wrap.innerHTML = list.map((a) => mari0CardHtml(a)).join('');

  const find = (uid) => list.find((x) => x.uid === uid);
  wrap.querySelectorAll('.mari0-del').forEach((b) => b.onclick = () => { settings.mari0Actions = list.filter((x) => x.uid !== b.dataset.uid); saveSettings(); renderMari0Actions(); });
  bindGameTriggerSelects(wrap, 'mari0-trig-sel', 'mari0Actions', renderMari0Actions);
  wrap.querySelectorAll('.mari0-en').forEach((c) => c.onchange = () => { const a = find(c.dataset.uid); if (!a) return; a.enabled = c.checked; saveSettings(); renderMari0Actions(); });
  wrap.querySelectorAll('.mari0-like-n').forEach((inp) => inp.onchange = () => { const a = find(inp.dataset.uid); if (!a) return; a.likeN = Math.max(1, parseInt(inp.value, 10) || 1); saveSettings(); });
  wrap.querySelectorAll('.mari0-text-n').forEach((inp) => inp.onchange = () => { const a = find(inp.dataset.uid); if (!a) return; a.text = inp.value.trim(); saveSettings(); });
  wrap.querySelectorAll('.mari0-count').forEach((inp) => inp.onchange = () => { const a = find(inp.dataset.uid); if (!a) return; const max = Math.max(1, parseInt(inp.max, 10) || 200); a.count = Math.max(1, Math.min(max, parseInt(inp.value, 10) || 1)); inp.value = String(a.count); saveSettings(); });
  wrap.querySelectorAll('.mari0-seconds').forEach((inp) => inp.onchange = () => { const a = find(inp.dataset.uid); if (!a) return; a.seconds = Math.max(1, Math.min(60, parseInt(inp.value, 10) || 5)); saveSettings(); });
  wrap.querySelectorAll('.mari0-factor').forEach((inp) => inp.onchange = () => { const a = find(inp.dataset.uid); if (!a) return; a.factor = Math.max(0, Math.min(10, parseInt(inp.value, 10) || 0)); saveSettings(); });
  wrap.querySelectorAll('.mari0-combo-instant-en').forEach((c) => c.onchange = () => { const a = find(c.dataset.uid); if (!a) return; a.comboInstant = c.checked; saveSettings(); });
  bindGameActionGiftButtons(wrap, 'mari0-gift', 'mari0Actions', renderMari0Actions);
  wrap.querySelectorAll('.mari0-test').forEach((b) => b.onclick = () => { const a = find(b.dataset.uid); if (a) testMari0Action(a); });
}

/* ============ Acciones de Plants vs Zombies (generar zombies / dar soles) ============ */
// Catálogo. Los zombies se generan vía http://localhost:7755/spawn (kind 'spawn').
// El recurso "Dar soles" llama a http://localhost:7755/sun?amount=N (kind 'sun').
const PVZ_ZOMBIES = [
  { id: 'norm', nombre: 'Zombie básico' },
  { id: 'cone', nombre: 'Zombie con cono' },
  { id: 'bucket', nombre: 'Zombie con cubeta' },
  { id: 'pole', nombre: 'Saltador con pértiga' },
  { id: 'newspaper', nombre: 'Zombie del periódico' },
  { id: 'screendoor', nombre: 'Zombie con puerta' },
  { id: 'football', nombre: 'Zombie americano' },
  { id: 'dancer', nombre: 'Zombie bailarín (rey)' },
  { id: 'balloon', nombre: 'Zombie con globo' },
  { id: 'digger', nombre: 'Zombie minero' },
  { id: 'pogo', nombre: 'Zombie saltarín' },
  { id: 'yeti', nombre: 'Yeti' },
  { id: 'jack', nombre: 'Zombie payaso' },
  { id: 'ladder', nombre: 'Zombie con escalera' },
  { id: 'catapult', nombre: 'Zombie catapulta' },
  { id: 'gargantuar', nombre: 'Gigante (Gargantuar)' },
  { id: 'imp', nombre: 'Diablillo (Imp)' },
  { id: 'random', nombre: 'Zombie al azar' },
];
const PVZ_RESOURCES = [
  { id: 'sun', nombre: 'Dar Soles', amount: 50 },
];
// Efectos sobre las plantas. Son comandos GET sin parámetros (kind 'cmd'): cada uno
// llama a http://localhost:7755{path}.
const PVZ_PLANTS = [
  { id: 'nocooldown', nombre: 'Plantas sin recarga', path: '/nocooldown' },
  { id: 'cooldown', nombre: 'Recarga normal', path: '/cooldown' },
  { id: 'freeplants', nombre: 'Plantas gratis', path: '/freeplants' },
  { id: 'paidplants', nombre: 'Plantas con costo normal', path: '/paidplants' },
  { id: 'godmode', nombre: 'God mode (sin recarga + gratis)', path: '/godmode' },
  { id: 'godmodeoff', nombre: 'Quitar god mode', path: '/godmodeoff' },
];
// Comandos de partida (también GET, kind 'cmd').
const PVZ_COMMANDS = [
  { id: 'killzombies', nombre: 'Matar todos los zombis', path: '/killzombies' },
  { id: 'clearplants', nombre: 'Quitar todas las plantas del campo', path: '/clearplants' },
  { id: 'unlockplants', nombre: 'Desbloquear plantas y niveles', path: '/unlockplants' },
];
const PVZ_CATALOG = [
  ...PVZ_ZOMBIES.map((x) => ({ ...x, tipo: 'zombie', kind: 'spawn' })),
  ...PVZ_RESOURCES.map((x) => ({ ...x, tipo: 'resource', kind: 'sun' })),
  ...PVZ_PLANTS.map((x) => ({ ...x, tipo: 'plant', kind: 'cmd' })),
  ...PVZ_COMMANDS.map((x) => ({ ...x, tipo: 'command', kind: 'cmd' })),
];

// Iconos y etiquetas del catálogo de PvZ (para las tarjetas "+ Agregar").
const PVZ_CAT_ICON = { zombie: '🧟', resource: '☀️', plant: '🌱', command: '⚙️' };
const PVZ_TIPO_LABEL = { zombie: 'Zombie', resource: 'Recurso / Soles', plant: 'Planta (efecto)', command: 'Comando' };

// settings.pvzActions es la lista de acciones AGREGADAS por el usuario (como en
// Minecraft): cada una tiene un uid propio. Empieza vacía.
function ensurePvzActions() {
  if (!settings) return [];
  if (!Array.isArray(settings.pvzActions)) settings.pvzActions = [];
  settings.pvzActions = migrateGameActions(settings.pvzActions, 'pvz');
  return settings.pvzActions;
}

// Botón "Descargar" del juego de Plants vs Zombies.
function setupPvzLaunchBtn() {
  const btn = document.getElementById('pvz-play');
  if (!btn || btn._wired) return;
  btn._wired = true;
  btn.onclick = () => {
    const url = btn.dataset.url;
    if (!url) { toast && toast('No hay enlace de descarga configurado.', 'warn'); return; }
    downloadMinecraftServer(url);
  };
}

function setupPvzActionsUI() {
  const search = document.getElementById('pvz-cat-search');
  if (search && !search._wired) { search._wired = true; search.oninput = () => renderPvzCatalog(search.value); }
  const toggleAll = document.getElementById('pvz-toggle-all');
  if (toggleAll && !toggleAll._wired) {
    toggleAll._wired = true;
    toggleAll.onclick = () => {
      const list = ensurePvzActions();
      if (!list.length) { toast && toast('Primero agrega acciones del catálogo.', 'warn'); return; }
      const anyOff = list.some((a) => a.enabled === false);
      list.forEach((a) => { a.enabled = anyOff; });
      saveSettings(); renderPvzActions();
      toast && toast(anyOff ? 'Todas las acciones encendidas.' : 'Todas las acciones apagadas.', 'ok');
    };
  }
  const genImgV = document.getElementById('pvz-gen-img-v');
  if (genImgV && !genImgV._wired) { genImgV._wired = true; genImgV.onclick = () => generatePvzMenuImage('vertical'); }
  const genImgH = document.getElementById('pvz-gen-img-h');
  if (genImgH && !genImgH._wired) { genImgH._wired = true; genImgH.onclick = () => generatePvzMenuImage('horizontal'); }
  renderPvzCatalog(search ? search.value : '');
  renderPvzActions();
}

// Catálogo de PvZ: tarjetas con "+ Agregar" (igual que Minecraft).
function renderPvzCatalog(filter) {
  const grid = document.getElementById('pvz-catalog');
  if (!grid) return;
  const f = (filter || '').trim().toLowerCase();
  const list = f ? PVZ_CATALOG.filter((c) => c.nombre.toLowerCase().includes(f)) : PVZ_CATALOG;
  if (!list.length) { grid.innerHTML = '<div class="empty">Sin resultados</div>'; return; }
  grid.innerHTML = list.map((c) => `
    <div class="mc-cat-card" data-id="${esc(c.id)}">
      <div class="mc-cat-head-row">
        <img class="mc-cat-ic" src="/img/pvz/${esc(c.id)}.png" alt="" onerror="this.outerHTML='<span class=\\'mc-cat-emoji\\'>${PVZ_CAT_ICON[c.tipo] || '🎮'}</span>'">
        <div class="mc-cat-texts">
          <div class="mc-cat-name">${esc(c.nombre)}</div>
          <div class="mc-cat-desc">${esc(PVZ_TIPO_LABEL[c.tipo] || '')}</div>
        </div>
      </div>
      <button type="button" class="mc-cat-add">+ Agregar</button>
    </div>`).join('');
  grid.querySelectorAll('.mc-cat-card').forEach((card) => {
    card.querySelector('.mc-cat-add').onclick = () => addPvzAction(card.dataset.id);
  });
}

// Agrega una acción del catálogo a "Mis acciones agregadas".
function addPvzAction(thing) {
  const c = PVZ_CATALOG.find((x) => x.id === thing);
  if (!c) return;
  if (!settings) { toast && toast('Espera a que cargue el panel…', 'warn'); return; }
  const list = ensurePvzActions();
  list.push({
    uid: 'pvz_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
    thing: c.id, label: c.nombre, tipo: c.tipo, kind: c.kind || 'spawn', path: c.path || '',
    trigger: 'gift', giftId: '', giftName: '', giftImage: '',
    count: 1, amount: c.amount != null ? c.amount : 50,
    text: '', enabled: true,
  });
  saveSettings(); renderPvzActions();
  toast && toast(`Acción "${c.nombre}" agregada. Elige el regalo o evento.`, 'ok');
}

// Prueba: siempre en esta PC (sin pasar por la nube).
async function testPvzAction(a) {
  if (!a || !a.thing) return;
  if (!IS_DESKTOP) { toast && toast('Plants vs Zombies solo funciona en la app de escritorio (.exe).', 'warn'); return; }
  let ok = false;
  if (a.kind === 'sun') {
    const amount = Math.max(1, parseInt(a.amount, 10) || 50);
    const r = await execGameLocal({ tipo: 'PVZ_SUN', amount });
    ok = r && r.ok !== false;
    if (ok) addEvent(`🧟 Prueba PvZ: dar ${esc(String(amount))} soles`, 'ok');
  } else if (a.kind === 'cmd') {
    const r = await execGameLocal({ tipo: 'PVZ_CMD', path: a.path });
    ok = r && r.ok !== false;
    if (ok) addEvent(`🧟 Prueba PvZ: ${esc(a.label || a.thing)}`, 'ok');
  } else {
    const times = Math.max(1, parseInt(a.count, 10) || 1);
    const r = await execGameLocal({ tipo: 'PVZ_SPAWN', thing: a.thing, name: 'Prueba', times });
    ok = r && r.ok !== false;
    if (ok) addEvent(`🧟 Prueba PvZ: generar ${esc(a.label || a.thing)}`, 'ok');
  }
  if (!ok) toast && toast('No se pudo ejecutar. ¿El juego está abierto en una partida?', 'warn');
}

function pvzCardHtml(a, cardOpts = {}) {
  const maxSpawn = cardOpts.maxSpawn != null ? cardOpts.maxSpawn : 20;
  const opts = MC_TRIGGERS.map((t) => `<option value="${t.v}" ${a.trigger === t.v ? 'selected' : ''}>${t.label}</option>`).join('');
  const uid = esc(a.uid);
  let giftBtn = '';
  if ((a.trigger || 'gift') === 'gift') {
    const ic = a.giftImage ? `<img class="mc-gift-ic" src="${esc(a.giftImage)}" onerror="this.outerHTML='🎁'">` : '🎁';
    giftBtn = `<button type="button" class="mc-gift-btn pvz-gift" data-uid="${uid}">${ic}<span class="mc-gift-name">${a.giftName ? esc(a.giftName) : 'Elegir regalo'}</span></button>`;
  } else {
    const ev = MC_TRIG_ICON[a.trigger] || { ic: '⚡', label: a.trigger };
    const lbl = (MC_TRIGGERS.find((t) => t.v === a.trigger) || {}).label || ev.label;
    giftBtn = `<div class="mc-ev-badge"><span class="mc-ev-ic">${ev.ic}</span><span class="mc-gift-name">${esc(lbl)}</span></div>`;
  }
  let likeRow = '';
  if (a.trigger === 'like' || a.trigger === 'likeGlobal') {
    const defN = a.trigger === 'likeGlobal' ? 100 : 1;
    const val = a.likeN != null ? a.likeN : defN;
    const txt = a.trigger === 'likeGlobal' ? 'Cada cuántos likes globales' : 'Mínimo de likes (por tanda)';
    likeRow = `<label class="mc-like-row">${txt}<input type="number" min="1" class="pvz-like-n" data-uid="${uid}" value="${esc(String(val))}"></label>`;
  } else if (a.trigger === 'chatUser' || a.trigger === 'chatCommand') {
    const txt = a.trigger === 'chatUser' ? 'Nombre de usuario (sin @)' : 'Palabra o comando (ej. !zombie)';
    const ph = a.trigger === 'chatUser' ? 'usuario123' : '!zombie';
    likeRow = `<label class="mc-like-row">${txt}<input type="text" class="pvz-text-n" data-uid="${uid}" value="${esc(a.text || '')}" placeholder="${ph}"></label>`;
  }
  const emoji = a.kind === 'sun' ? '☀️' : (a.tipo === 'plant' ? '🌱' : (a.tipo === 'command' ? '⚙️' : '🧟'));
  let qtyRow = '';
  if (a.kind === 'sun') {
    qtyRow = `<label class="mc-like-row" style="max-width:150px">Cantidad de soles<input type="number" min="1" max="9990" step="25" class="pvz-amount" data-uid="${uid}" value="${esc(String(a.amount || 50))}"></label>`;
  } else if (a.kind !== 'cmd') {
    const qtyLbl = cardOpts.qtyLabel || 'Cantidad';
    const qtyTitle = cardOpts.qtyTitle || '';
    const qtyClass = cardOpts.qtyClass || 'pvz-count';
    const qtyW = cardOpts.qtyWidth || '130px';
    qtyRow = `<label class="mc-like-row" style="max-width:${qtyW}"${qtyTitle ? ` title="${esc(qtyTitle)}"` : ''}>${qtyLbl}<input type="number" min="1" max="${maxSpawn}" class="${qtyClass}" data-uid="${uid}" value="${esc(String(a.count != null ? a.count : 1))}"></label>`;
  }
  const qtyBlock = qtyRow ? `<div class="mc-act-row">${qtyRow}</div>` : '';
  return `
  <div class="mc-act-card ${a.enabled === false ? 'mc-off' : ''}" data-uid="${uid}">
    <div class="mc-act-top">
      <span class="mc-act-name"><img class="mc-act-ic" src="/img/pvz/${esc(a.thing)}.png" alt="" onerror="this.outerHTML='${emoji} '">${esc(a.label || a.thing)}</span>
      <button type="button" class="mc-act-del pvz-del" data-uid="${uid}" title="Quitar">✕</button>
    </div>
    <div class="mc-act-row">
      <select class="pvz-trig-sel" data-uid="${uid}">${opts}</select>
      ${giftBtn}
      ${likeRow}
    </div>
    ${qtyBlock}
    <div class="mc-act-actions">
      <label class="mc-act-toggle"><input type="checkbox" class="pvz-en" data-uid="${uid}" ${a.enabled === false ? '' : 'checked'}> Activa</label>
      <div class="mc-act-btns">
        <button type="button" class="mc-act-test pvz-test" data-uid="${uid}">Probar</button>
      </div>
    </div>
  </div>`;
}

function renderPvzActions() {
  const wrap = document.getElementById('pvz-my-actions');
  if (!wrap || !settings) return;
  const list = ensurePvzActions();
  if (!list.length) {
    wrap.innerHTML = '<div class="mc-empty">Aún no agregaste acciones. Elige una del catálogo de abajo.</div>';
    return;
  }
  wrap.innerHTML = list.map((a) => pvzCardHtml(a)).join('');

  const find = (uid) => list.find((x) => x.uid === uid);
  wrap.querySelectorAll('.pvz-del').forEach((b) => b.onclick = () => { settings.pvzActions = list.filter((x) => x.uid !== b.dataset.uid); saveSettings(); renderPvzActions(); });
  bindGameTriggerSelects(wrap, 'pvz-trig-sel', 'pvzActions', renderPvzActions);
  wrap.querySelectorAll('.pvz-en').forEach((c) => c.onchange = () => { const a = find(c.dataset.uid); if (!a) return; a.enabled = c.checked; saveSettings(); renderPvzActions(); });
  wrap.querySelectorAll('.pvz-like-n').forEach((inp) => inp.onchange = () => { const a = find(inp.dataset.uid); if (!a) return; a.likeN = Math.max(1, parseInt(inp.value, 10) || 1); saveSettings(); });
  wrap.querySelectorAll('.pvz-text-n').forEach((inp) => inp.onchange = () => { const a = find(inp.dataset.uid); if (!a) return; a.text = inp.value.trim(); saveSettings(); });
  wrap.querySelectorAll('.pvz-count').forEach((inp) => inp.onchange = () => { const a = find(inp.dataset.uid); if (!a) return; a.count = Math.max(1, Math.min(20, parseInt(inp.value, 10) || 1)); saveSettings(); });
  wrap.querySelectorAll('.pvz-amount').forEach((inp) => inp.onchange = () => { const a = find(inp.dataset.uid); if (!a) return; a.amount = Math.max(1, Math.min(9990, parseInt(inp.value, 10) || 50)); saveSettings(); });
  bindGameActionGiftButtons(wrap, 'pvz-gift', 'pvzActions', renderPvzActions);
  wrap.querySelectorAll('.pvz-test').forEach((b) => b.onclick = () => { const a = find(b.dataset.uid); if (a) testPvzAction(a); });
}

/* ============ PvZ Hybrid (PvZ Tools + bridge :7757 / WS :3132) ============ */
// Enemigos exclusivos de PvZ Hybrid v3.6 (wiki pvzhe.wiki — sin clásicos del PvZ original).
const PVZHYBRID_ZOMBIES = [
  { id: 'periodico_hielo', nombre: 'Zombie periódico ice car' },
  { id: 'puerta_rejas', nombre: 'Zombie con puerta metálica' },
  { id: 'futbol_oscuro', nombre: 'Zombie fútbol americano oscuro' },
  { id: 'bailarin_armado', nombre: 'Bailarín armado (rey)' },
  { id: 'gigante_hielo', nombre: 'Gigante ice car' },
  { id: 'delfin_guisante', nombre: 'Caballero delfín guisante' },
  { id: 'caja_loteria', nombre: 'Zombie caja lotería' },
  { id: 'globo_rey', nombre: 'Rey bailarín globo' },
  { id: 'imp_globo', nombre: 'Diablillo globo' },
  { id: 'dirigible', nombre: 'Dirigible gigante' },
  { id: 'minero_oscuro', nombre: 'Minero oliva negra' },
  { id: 'yeti_hielo', nombre: 'Yeti ice car' },
  { id: 'catapulta_armada', nombre: 'Catapulta armada' },
  { id: 'garg_armado', nombre: 'Gargantuar armado' },
  { id: 'garg_regalo', nombre: 'Gargantuar regalo' },
  { id: 'imp_regalo', nombre: 'Diablillo regalo' },
  { id: 'guisante_z', nombre: 'Zombie guisante' },
  { id: 'nuez_z', nombre: 'Zombie nuez' },
  { id: 'cereza_z', nombre: 'Zombie cereza picante' },
  { id: 'ametralladora_z', nombre: 'Zombie ametralladora' },
  { id: 'calabaza_hielo_z', nombre: 'Zombie calabaza helada' },
  { id: 'hielonuez_z', nombre: 'Zombie alta nuez hielo' },
  { id: 'hielonuez_imp', nombre: 'Diablillo alta nuez hielo' },
  { id: 'garg_rojo', nombre: 'Gargantuar ojo rojo armado' },
  { id: 'disco_z', nombre: 'Zombie disco' },
  { id: 'bailarin_z', nombre: 'Bailarín' },
  { id: 'esqueleto_z', nombre: 'Esqueleto' },
  { id: 'esqueleto_imp', nombre: 'Diablillo esqueleto' },
  { id: 'esqueleto_garg', nombre: 'Gargantuar esqueleto' },
  { id: 'nigromante', nombre: 'Nigromante' },
  { id: 'disco_fuego', nombre: 'Disco flamígero' },
  { id: 'bailarin_fuego', nombre: 'Bailarín flamígero' },
  { id: 'patito', nombre: 'Patito amarillo' },
  { id: 'cama_carro', nombre: 'Zombie cama-carro' },
  { id: 'luchador', nombre: 'Pequeño luchador' },
  { id: 'garg_oliva_carga', nombre: 'Gargantuar oliva cargador' },
  { id: 'imp_oliva_carga', nombre: 'Diablillo oliva cargador' },
  { id: 'yeti_minero', nombre: 'Yeti minero' },
  { id: 'ametralladora_salvaje', nombre: 'Ametralladora salvaje' },
  { id: 'garg_salvaje', nombre: 'Gargantuar salvaje' },
  { id: 'gigante_hielo_salvaje', nombre: 'Gigante ice car salvaje' },
  { id: 'nuez_antorcha_z', nombre: 'Zombie nuez antorcha' },
  { id: 'pole_ametralladora', nombre: 'Saltador ametralladora' },
  { id: 'delfin_ametralladora', nombre: 'Delfín ametralladora' },
  { id: 'garg_nuez_z', nombre: 'Gargantuar nuez-zombie' },
  { id: 'imp_guisante_z', nombre: 'Diablillo guisante-zombie' },
  { id: 'tiburon_z', nombre: 'Tiburón zombie' },
  { id: 'tirador_hielo_z', nombre: 'Zombie tirador hielo' },
  { id: 'kraken_z', nombre: 'Kraken zombie' },
  { id: 'buceador_enredadera', nombre: 'Buceador enredadera' },
  { id: 'diamante_z', nombre: 'Diamante zombie' },
  { id: 'puerta_antibombas', nombre: 'Puerta antibombas' },
  { id: 'jinete_pato', nombre: 'Jinete pato' },
  { id: 'imp_carrito', nombre: 'Diablillo carrito' },
  { id: 'jarron_z', nombre: 'Zombie jarrón' },
  { id: 'hipnotizador', nombre: 'Hipnotizador' },
  { id: 'jardinero_z', nombre: 'Jardinero zombie' },
  { id: 'carro_jardinero', nombre: 'Carro jardinero' },
  { id: 'garg_bailarin_furioso', nombre: 'Gargantuar bailarín furioso' },
  { id: 'garg_secuaz', nombre: 'Gargantuar bailarín secuaz' },
  { id: 'sombra_z', nombre: 'Zombie sombra' },
  { id: 'imp_minero_puas', nombre: 'Diablillo minero púas' },
  { id: 'garg_ojorojo_oliva', nombre: 'Gargantuar ojo rojo oliva negro' },
  { id: 'imp_ojorojo_oliva', nombre: 'Diablillo ojo rojo oliva negro' },
  { id: 'gigante_ojorojo_hielo', nombre: 'Gigante ojo rojo ice car' },
  { id: 'cactus_doble', nombre: 'Cactus doble disparo' },
  { id: 'nuez_caja', nombre: 'Nuez caja regalo' },
  { id: 'nuez_vip', nombre: 'Nuez VIP suprema' },
  { id: 'lanzamaiz_triple', nombre: 'Lanzamaíz triple' },
  { id: 'gigante_escarcha', nombre: 'Gigante escarcha' },
  { id: 'edgar_ii', nombre: 'Edgar II' },
  { id: 'hielo_ametralladora', nombre: 'Ice car ametralladora' },
  { id: 'carro_interferencia', nombre: 'Carro interferencia' },
  { id: 'girasol_z', nombre: 'Girasol zombie' },
  { id: 'granjero_z', nombre: 'Granjero zombie' },
  { id: 'magnate_z', nombre: 'Magnate rico' },
  { id: 'rey_saltarin_disco', nombre: 'Rey saltarín disco' },
  { id: 'secuaz_saltarin', nombre: 'Secuaz saltarín' },
  { id: 'hielo_lanzador', nombre: 'Ice car lanzador' },
  { id: 'fantasma_z', nombre: 'Fantasma zombie' },
  { id: 'imitador_z', nombre: 'Imitador zombie' },
  { id: 'arbol_z', nombre: 'Zombie árbol' },
  { id: 'insecto_z', nombre: 'Insecto zombie' },
  { id: 'pole_oliva', nombre: 'Saltador oliva' },
  { id: 'gigante_minero', nombre: 'Gigante minero' },
  { id: 'imp_minero', nombre: 'Diablillo minero' },
  { id: 'capitan_pirata', nombre: 'Capitán pirata' },
  { id: 'marinero_pirata', nombre: 'Marinero pirata' },
  { id: 'magnetico_z', nombre: 'Zombie magnético' },
  { id: 'imp_caracol', nombre: 'Diablillo caracol' },
  { id: 'guerrero_gato', nombre: 'Guerrero gato' },
  { id: 'carro_globo', nombre: 'Carro globo' },
  { id: 'yeti_futbol', nombre: 'Yeti fútbol americano' },
  { id: 'mago_renacido', nombre: 'Mago renacido' },
  { id: 'trineo_yeti', nombre: 'Escuadrón trineo yeti' },
  { id: 'trineo_armado', nombre: 'Trineo armado' },
  { id: 'vampiro_z', nombre: 'Vampiro' },
  { id: 'damas_z', nombre: 'Damas zombie' },
  { id: 'mono_z', nombre: 'Mono zombie' },
  { id: 'mercado_z', nombre: 'Mercado zombie' },
  { id: 'angel_z', nombre: 'Ángel zombie' },
  { id: 'disco_periodico', nombre: 'Disco periódico' },
  { id: 'bailarin_furioso', nombre: 'Bailarín furioso' },
  { id: 'delfin_buzo', nombre: 'Delfín buzo' },
  { id: 'rey_delfin', nombre: 'Rey delfín bailarín' },
  { id: 'secuaz_delfin', nombre: 'Secuaz delfín' },
  { id: 'pole_jack', nombre: 'Saltador caja sorpresa' },
  { id: 'humo_z', nombre: 'Máquina humo' },
  { id: 'imp_catapulta', nombre: 'Diablillo catapulta' },
  { id: 'regalo_navidad', nombre: 'Regalo navideño' },
  { id: 'escalera_globo', nombre: 'Escalera globo' },
  { id: 'arbol_navidad', nombre: 'Árbol navideño' },
  { id: 'garg_diamante', nombre: 'Gargantuar diamante' },
  { id: 'imp_diamante', nombre: 'Diablillo diamante' },
  { id: 'cisne_z', nombre: 'Cisne blanco' },
  { id: 'maquina_regalo', nombre: 'Máquina regalo' },
  { id: 'super_ametralladora', nombre: 'Super ametralladora' },
  { id: 'random', nombre: 'Zombie al azar (Hybrid)' },
];
// Zombies 0–32 del desplegable oficial de PvZ Tools (clásicos).
const PVZ_TOOLS_CLASSIC_ZOMBIES = [
  { id: '0', nombre: '[0] Zombie' },
  { id: '1', nombre: '[1] Bandera' },
  { id: '2', nombre: '[2] Cono' },
  { id: '3', nombre: '[3] Pertiga' },
  { id: '4', nombre: '[4] Cubeta' },
  { id: '5', nombre: '[5] Periódico' },
  { id: '6', nombre: '[6] Puerta' },
  { id: '7', nombre: '[7] Fútbol americano' },
  { id: '8', nombre: '[8] Bailarín' },
  { id: '14', nombre: '[14] Delfín' },
  { id: '15', nombre: '[15] Caja sorpresa' },
  { id: '16', nombre: '[16] Globo' },
  { id: '17', nombre: '[17] Minero' },
  { id: '18', nombre: '[18] Saltarín' },
  { id: '23', nombre: '[23] Gargantuar' },
  { id: '24', nombre: '[24] Diablillo' },
  { id: '32', nombre: '[32] Giga-Gargantuar' },
];
// PvZ Tools v2.6 Interactive tiene toggles (Stay in Place, etc.) que CRASHEAN PvZ Hybrid
// porque parchean memoria de la versión 1.0.0.1051 y Hybrid usa otra build (1.1.0.1056 zh).
// Solo exponer lo que el usuario confirmó estable: soles y spawn.
const PVZHYBRID_TIPO_LABEL = { zombie: 'Enemigo Hybrid', classic: 'Zombie PvZ Tools (0–32)', resource: 'Recurso / Soles' };
const PVZHYBRID_CATALOG = [
  ...PVZ_RESOURCES.map((x) => ({ ...x, tipo: 'resource', kind: 'sun' })),
  ...PVZ_TOOLS_CLASSIC_ZOMBIES.map((x) => ({ ...x, tipo: 'classic', kind: 'spawn' })),
  ...PVZHYBRID_ZOMBIES.map((x) => ({ ...x, tipo: 'zombie', kind: 'spawn' })),
];

function ensurePvzHybridActions() {
  if (!settings) return [];
  if (!Array.isArray(settings.pvzHybridActions)) settings.pvzHybridActions = [];
  settings.pvzHybridActions = migrateGameActions(settings.pvzHybridActions, 'pvzhybrid');
  return settings.pvzHybridActions;
}

async function ensurePvzHybridBridgeApi() {
  try {
    const r = await fetch('/api/desktop/ensure-pvz-hybrid-bridge', { method: 'POST', credentials: 'same-origin' });
    return await r.json().catch(() => ({ ok: false }));
  } catch { return { ok: false }; }
}

async function pvzHybridBridgeHealth() {
  try {
    const r = await fetch('/api/desktop/pvz-hybrid-health', { credentials: 'same-origin' });
    return await r.json().catch(() => ({}));
  } catch { return {}; }
}

function renderPvzHybridStatus(payload) {
  const el = document.getElementById('pvzhybrid-status');
  if (!el) return;
  if (!IS_DESKTOP) { el.innerHTML = ''; return; }
  const h = payload?.health;
  if (!h?.ok || h.api !== 'livecoins-pvz-hybrid') {
    el.innerHTML = '<span class="mari0-st off">Bridge PvZ Hybrid — apagado</span>';
    return;
  }
  const toolsOk = !!h.toolkitConnected;
  const pending = Number(h.pending) || 0;
  const parts = [
    '<span class="mari0-st on">HTTP :7757</span>',
    '<span class="mari0-st on">WS :3132</span>',
    `<span class="mari0-st ${toolsOk ? 'on' : 'warn'}">PvZ Tools: ${toolsOk ? 'conectado' : 'sin conectar'}</span>`,
  ];
  if (pending > 0) parts.push(`<span class="mari0-st warn">${pending} en cola</span>`);
  el.innerHTML = parts.join('');
}

async function refreshPvzHybridStatus() {
  if (!IS_DESKTOP) return null;
  const d = await pvzHybridBridgeHealth();
  renderPvzHybridStatus(d);
  return d;
}

let pvzHybridStatusTimer = null;
function setupPvzHybridStatusPoll() {
  if (!IS_DESKTOP || pvzHybridStatusTimer) return;
  refreshPvzHybridStatus();
  pvzHybridStatusTimer = setInterval(() => {
    const view = document.getElementById('view-juego-pvzhybrid');
    if (view?.classList.contains('active')) refreshPvzHybridStatus();
  }, 2000);
}

const PVZ_DL_BASE = 'https://github.com/riusaki1995/.exe/releases/download/pvz/';
const PVZ_HYBRID_DOWNLOADS = [
  { head: 'Descargar PvZ Tools', name: 'PvZ Tools', file: 'PvZ.Tools.v2.6.1.exe', size: '1.3 MB', icon: '⚙️' },
  { head: 'Descargar activador Livecoins (PvZ Hybrid Server)', name: 'PvZ Hybrid Server', file: 'PvZ-Hybrid-Server.exe', size: '90.02 MB', icon: '🔌' },
  { head: 'Descargar Plantas vs Zombies 1', name: 'PvZ 1', file: 'PVZ.1.ESP-ENG.zip', size: '132.78 MB', img: '/img/PvZ_1.png' },
  { head: 'Descargar Plantas vs Zombies Hybrid v3.6', name: 'PvZ Hybrid v3.6', file: 'PVZ.HYBRID.v3.6.zip', size: '269.61 MB', img: '/img/pvzhybrid.jpg' },
  { head: 'Descargar Plantas vs Zombies Naruto v1.20', name: 'PvZ Naruto v1.20', file: 'PVZ.Naruto.zip', size: '83.47 MB', img: '/img/PvZ_Naruto.png' },
  { head: 'Descargar Plantas vs Zombies Parasyte v1.0', name: 'PvZ Parasyte v1.0', file: 'PVZ_Parasyte_en.zip', size: '50.8 MB', img: '/img/PvZ_Parasyte.png' },
  { head: 'Descargar Plantas vs Zombies Cute', name: 'PvZ Cute', file: 'PVZ.CUTE.zip', size: '271.97 MB', img: '/img/PvZ_Cute.png' },
  { head: 'Descargar Plantas vs Zombies AmongUs', name: 'PvZ AmongUs', file: 'PVZ.AmongUs.zip', size: '230.79 MB', img: '/img/PvZ_AmongUs.png' },
  { head: 'Descargar Plantas vs Zombies Fusion v3.7', name: 'PvZ Fusion v3.7', file: 'PvZ.Fusion.-.Interactive.v3.7.-.MelonLoader.zip', size: '695 MB', img: '/img/PvZ_Fusion.png' },
  { head: 'Descargar Plantas vs Zombies Future', name: 'PvZ Future', file: 'PVZ.Future.zip', size: '630.94 MB', img: '/img/PvZ_Future.png' },
  { head: 'Descargar Plantas vs Zombies Avengers', name: 'PvZ Avengers', file: 'PVZ.Avengers.zip', size: '266.66 MB', img: '/img/PvZ_Avengers.png' },
];

function renderPvzHybridDownloads() {
  const wrap = document.getElementById('pvzhybrid-downloads');
  if (!wrap) return;
  wrap.innerHTML = PVZ_HYBRID_DOWNLOADS.map((d) => {
    const url = PVZ_DL_BASE + d.file;
    const thumb = d.img ? `<img src="${esc(d.img)}" alt="">` : esc(d.icon || '🎮');
    return `<div class="pvz-dl-group">
      <div class="pvz-dl-group-head"><span class="pvz-dl-plus">+</span> ${esc(d.head)}</div>
      <div class="pvz-dl-card">
        <div class="pvz-dl-thumb">${thumb}</div>
        <div class="pvz-dl-info">
          <div class="pvz-dl-name">${esc(d.name)}</div>
          <div class="pvz-dl-size">${esc(d.size)}</div>
        </div>
        <button type="button" class="pvz-dl-btn" data-url="${esc(url)}">⬇ Descargar</button>
      </div>
    </div>`;
  }).join('');
  wrap.querySelectorAll('.pvz-dl-btn').forEach((btn) => {
    btn.onclick = () => downloadMinecraftServer(btn.dataset.url);
  });
}

function setupPvzHybridDownloads() {
  renderPvzHybridDownloads();
}

function setupPvzHybridLaunchBtn() {
  if (!IS_DESKTOP) return;
  const wire = (id, fn) => {
    const btn = document.getElementById(id);
    if (!btn || btn._wired) return;
    btn._wired = true;
    btn.onclick = fn;
  };
  wire('pvzhybrid-bridge', async () => {
    const r = await ensurePvzHybridBridgeApi();
    if (r.ok) {
      window.desktopAPI?.showPvzHybridOverlay?.();
      toast && toast('Bridge PvZ Hybrid activo.', 'ok');
      refreshPvzHybridStatus();
    } else toast && toast('No se pudo iniciar el bridge.', 'warn');
  });
  wire('pvzhybrid-tools', async () => {
    await ensurePvzHybridBridgeApi();
    const r = window.desktopAPI?.launchPvzTools ? await window.desktopAPI.launchPvzTools() : { ok: false };
    if (r?.ok) { toast && toast('PvZ Tools abierto.', 'ok'); refreshPvzHybridStatus(); }
    else toast && toast('No se encontró PvZ.Tools.exe', 'warn');
  });
  wire('pvzhybrid-stack', async () => {
    const r = window.desktopAPI?.launchPvzHybridStack ? await window.desktopAPI.launchPvzHybridStack() : { ok: false };
    if (r?.ok) { toast && toast('Bridge + Tools + Hybrid iniciados.', 'ok'); refreshPvzHybridStatus(); }
    else toast && toast(r?.error === 'no_instalado' ? 'Coloca PvZ Hybrid en desktop/pvz-hybrid-game/' : 'Falló el arranque.', 'warn');
  });
}

function setupPvzHybridActionsUI() {
  const search = document.getElementById('pvzhybrid-cat-search');
  if (search && !search._wired) { search._wired = true; search.oninput = () => renderPvzHybridCatalog(search.value); }
  const toggleAll = document.getElementById('pvzhybrid-toggle-all');
  if (toggleAll && !toggleAll._wired) {
    toggleAll._wired = true;
    toggleAll.onclick = () => {
      const list = ensurePvzHybridActions();
      if (!list.length) { toast && toast('Agrega acciones del catálogo.', 'warn'); return; }
      const anyOff = list.some((a) => a.enabled === false);
      list.forEach((a) => { a.enabled = anyOff; });
      saveSettings(); renderPvzHybridActions();
    };
  }
  renderPvzHybridCatalog(search ? search.value : '');
  renderPvzHybridActions();
}

function renderPvzHybridCatalog(filter) {
  const grid = document.getElementById('pvzhybrid-catalog');
  if (!grid) return;
  const f = (filter || '').trim().toLowerCase();
  const list = f ? PVZHYBRID_CATALOG.filter((c) => c.nombre.toLowerCase().includes(f)) : PVZHYBRID_CATALOG;
  grid.innerHTML = list.map((c) => `
    <div class="mc-cat-card" data-id="${esc(c.id)}">
      <div class="mc-cat-head-row">
        <span class="mc-cat-emoji">${c.tipo === 'zombie' ? '🧬' : c.tipo === 'classic' ? '🧟' : (PVZ_CAT_ICON[c.tipo] || '⚙️')}</span>
        <div class="mc-cat-texts"><div class="mc-cat-name">${esc(c.nombre)}</div><div class="mc-cat-desc">${esc(PVZHYBRID_TIPO_LABEL[c.tipo] || PVZ_TIPO_LABEL[c.tipo] || '')}</div></div>
      </div>
      <button type="button" class="mc-cat-add">+ Agregar</button>
    </div>`).join('');
  grid.querySelectorAll('.mc-cat-card').forEach((card) => {
    card.querySelector('.mc-cat-add').onclick = () => addPvzHybridAction(card.dataset.id);
  });
}

function addPvzHybridAction(thing) {
  const c = PVZHYBRID_CATALOG.find((x) => x.id === thing);
  if (!c || !settings) return;
  ensurePvzHybridActions().push({
    uid: 'pvzh_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
    thing: c.id, label: c.nombre, tipo: c.tipo, kind: c.kind || 'spawn', path: c.path || '',
    trigger: 'gift', giftId: '', giftName: '', giftImage: '',
    count: 1, amount: c.amount != null ? c.amount : 50, text: '', enabled: true,
  });
  saveSettings(); renderPvzHybridActions();
}

const PVZ_HYBRID_SPAWN_MAX = 999;

async function testPvzHybridAction(a) {
  if (!a?.thing || !IS_DESKTOP) { toast && toast('Solo en la app .exe', 'warn'); return; }
  const bridge = await ensurePvzHybridBridgeApi();
  if (!bridge?.ok) {
    toast && toast('Bridge PvZ Hybrid apagado. Pulsa Bridge en PvZ Hybrid o Iniciar bridge.', 'warn');
    return;
  }
  let ok = false;
  let detail = '';
  if (a.kind === 'sun') {
    const r = await execGameLocal({ tipo: 'PVZ_HYBRID_SUN', amount: a.amount, name: 'Prueba', label: a.label });
    ok = r && r.ok !== false;
    detail = r?.error || '';
  } else if (a.kind === 'cmd') {
    const r = await execGameLocal({ tipo: 'PVZ_HYBRID_CMD', path: a.path, name: 'Prueba', label: a.label });
    ok = r && r.ok !== false;
    detail = r?.error || '';
  } else {
    const times = Math.max(1, Math.min(PVZ_HYBRID_SPAWN_MAX, parseInt(a.count, 10) || 1));
    const r = await execGameLocal({ tipo: 'PVZ_HYBRID_SPAWN', thing: a.thing, name: 'Prueba', times, label: a.label });
    ok = r && r.ok !== false;
    detail = r?.error || '';
  }
  if (ok) addEvent(`🧬 Prueba Hybrid: ${esc(a.label || a.thing)}`, 'ok');
  else toast && toast(detail === 'cmd_desconocido' ? 'Comando no soportado por el bridge' : '¿Bridge, PvZ Tools admin e Hybrid en partida?', 'warn');
}

function renderPvzHybridActions() {
  const wrap = document.getElementById('pvzhybrid-my-actions');
  if (!wrap || !settings) return;
  const list = ensurePvzHybridActions();
  if (!list.length) { wrap.innerHTML = '<div class="mc-empty">Aún no agregaste acciones.</div>'; return; }
  wrap.innerHTML = list.map((a) => pvzCardHtml(a, { maxSpawn: PVZ_HYBRID_SPAWN_MAX }).replace(/pvz-/g, 'pvzhybrid-')).join('');
  const find = (uid) => list.find((x) => x.uid === uid);
  wrap.querySelectorAll('.pvzhybrid-del').forEach((b) => b.onclick = () => { settings.pvzHybridActions = list.filter((x) => x.uid !== b.dataset.uid); saveSettings(); renderPvzHybridActions(); });
  bindGameTriggerSelects(wrap, 'pvzhybrid-trig-sel', 'pvzHybridActions', renderPvzHybridActions);
  wrap.querySelectorAll('.pvzhybrid-en').forEach((c) => c.onchange = () => { const a = find(c.dataset.uid); if (a) { a.enabled = c.checked; saveSettings(); renderPvzHybridActions(); } });
  wrap.querySelectorAll('.pvzhybrid-like-n, .pvzhybrid-text-n, .pvzhybrid-count, .pvzhybrid-amount').forEach((inp) => {
    inp.onchange = () => {
      const a = find(inp.dataset.uid); if (!a) return;
      if (inp.classList.contains('pvzhybrid-like-n')) a.likeN = Math.max(1, parseInt(inp.value, 10) || 1);
      else if (inp.classList.contains('pvzhybrid-text-n')) a.text = inp.value.trim();
      else if (inp.classList.contains('pvzhybrid-count')) a.count = Math.max(1, Math.min(PVZ_HYBRID_SPAWN_MAX, parseInt(inp.value, 10) || 1));
      else if (inp.classList.contains('pvzhybrid-amount')) a.amount = Math.max(1, Math.min(9990, parseInt(inp.value, 10) || 50));
      saveSettings();
    };
  });
  bindGameActionGiftButtons(wrap, 'pvzhybrid-gift', 'pvzHybridActions', renderPvzHybridActions);
  wrap.querySelectorAll('.pvzhybrid-test').forEach((b) => b.onclick = () => { const a = find(b.dataset.uid); if (a) testPvzHybridAction(a); });
}

// Genera una imagen tipo "menú de regalos" para PvZ: regalo/evento + acción + cantidad.
async function generatePvzMenuImage(orientation) {
  if (!settings) { toast && toast('Espera a que cargue el panel…', 'warn'); return; }
  const all = ensurePvzActions();
  let list = all.filter((a) => a && a.enabled !== false);
  if (!list.length) list = all.slice();
  if (!list.length) { toast && toast('Agrega acciones del catálogo con su regalo primero.', 'warn'); return; }
  toast && toast('Generando imagen…', 'ok');

  const sameOrigin = (u) => { try { return new URL(u, location.href).origin === location.origin; } catch { return false; } };
  const proxied = (u) => (!u ? '' : (sameOrigin(u) ? u : (`/api/img-proxy?url=${encodeURIComponent(u)}`)));
  const loadImg = (src) => new Promise((resolve) => {
    if (!src) return resolve(null);
    const im = new Image();
    im.crossOrigin = 'anonymous';
    im.onload = () => resolve(im);
    im.onerror = () => resolve(null);
    im.src = src;
  });

  const rows = [];
  for (const a of list) {
    const trig = a.trigger || 'gift';
    let giftImg = null;
    let giftEmoji = '';
    if (trig === 'gift' || trig === 'gift-any') {
      const gUrl = (a.giftImage && String(a.giftImage).trim()) || giftImageOf(a);
      giftImg = await loadImg(proxied(gUrl));
    } else {
      giftEmoji = (MC_TRIG_ICON[trig] || { ic: '⚡' }).ic;
    }
    const actIcon = await loadImg(proxied(`/img/pvz/${encodeURIComponent(a.thing || '')}.png`));
    const actEmoji = a.kind === 'sun' ? '☀️' : (PVZ_CAT_ICON[a.tipo] || '🧟');
    const qty = a.kind === 'sun'
      ? Math.max(1, parseInt(a.amount, 10) || 50)
      : (a.kind === 'cmd' ? 0 : Math.max(1, parseInt(a.count, 10) || 1));
    rows.push({ giftImg, giftEmoji, actIcon, actEmoji, qty });
  }

  let cols;
  if (orientation === 'vertical') cols = 1;
  else if (orientation === 'horizontal') cols = rows.length;
  else cols = Math.max(1, Math.min(5, rows.length));
  cols = Math.max(1, cols);
  const gridRows = Math.ceil(rows.length / cols);
  const margin = 10;
  const gap = 14;
  const cellW = 200;
  const numH = 14;
  const iconS = 156;
  const giftS = 52;
  const cellH = numH + iconS + 30;
  const W = margin * 2 + cols * cellW + (cols - 1) * gap;
  const H = margin * 2 + gridRows * cellH + (gridRows - 1) * gap;
  const dpr = 2;
  const cv = document.createElement('canvas');
  cv.width = W * dpr;
  cv.height = H * dpr;
  const ctx = cv.getContext('2d');
  ctx.scale(dpr, dpr);

  const rr = (x, y, w, h, r) => {
    const rad = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rad, y);
    ctx.arcTo(x + w, y, x + w, y + h, rad);
    ctx.arcTo(x + w, y + h, x, y + h, rad);
    ctx.arcTo(x, y + h, x, y, rad);
    ctx.arcTo(x, y, x + w, y, rad);
    ctx.closePath();
  };

  const drawMultBadge = (label, x, y) => {
    ctx.font = '800 20px Rubik, Montserrat, system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.lineWidth = 4;
    ctx.strokeStyle = '#0a0a0a';
    ctx.strokeText(label, x, y);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(label, x, y);
  };

  ctx.textBaseline = 'middle';
  rows.forEach((row, i) => {
    const c = i % cols;
    const r = Math.floor(i / cols);
    const cellX = margin + c * (cellW + gap);
    const cellY = margin + r * (cellH + gap);
    const iconX = cellX + (cellW - iconS) / 2;
    const iconY = cellY + numH;

    if (row.actIcon) {
      ctx.save();
      rr(iconX, iconY, iconS, iconS, 16);
      ctx.clip();
      ctx.drawImage(row.actIcon, iconX, iconY, iconS, iconS);
      ctx.restore();
    } else {
      ctx.font = '96px serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = '#fff';
      ctx.fillText(row.actEmoji, iconX + iconS / 2, iconY + iconS / 2);
    }

    const gx = cellX + (cellW - giftS) / 2;
    const gy = iconY + iconS - Math.round(giftS * 0.5);
    ctx.save();
    rr(gx, gy, giftS, giftS, 12);
    ctx.clip();
    if (row.giftImg) ctx.drawImage(row.giftImg, gx, gy, giftS, giftS);
    else {
      ctx.font = '34px serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#fff';
      ctx.fillText(row.giftEmoji || '🎁', gx + giftS / 2, gy + giftS / 2 + 1);
    }
    ctx.restore();

    if (row.qty > 1) drawMultBadge(`x${row.qty}`, iconX + iconS - 4, iconY + 2);
  });

  try {
    const data = cv.toDataURL('image/png');
    const suffix = orientation === 'vertical' ? '-vertical' : orientation === 'horizontal' ? '-horizontal' : '';
    const link = document.createElement('a');
    link.href = data;
    link.download = 'menu-regalos-pvz' + suffix + '.png';
    document.body.appendChild(link);
    link.click();
    link.remove();
    toast && toast('Imagen generada y descargada.', 'ok');
  } catch {
    toast && toast('No se pudo exportar la imagen. Revisa tu conexión e inténtalo de nuevo.', 'err');
  }
}

// Genera una imagen tipo "menú de regalos" para Roblox: para cada acción muestra el
// regalo/evento que la activa, la acción (imagen/emoji) y la tecla. Se descarga como PNG.
async function generateRobloxMenuImage(orientation) {
  if (!settings) { toast && toast('Espera a que cargue el panel…', 'warn'); return; }
  const all = ensureRobloxSlots();
  let list = all.filter((a) => a && a.enabled !== false);
  if (!list.length) list = all.slice(); // si no hay ninguna encendida, muestra todas
  toast && toast('Generando imagen…', 'ok');

  const sameOrigin = (u) => { try { return new URL(u, location.href).origin === location.origin; } catch { return false; } };
  const proxied = (u) => (!u ? '' : (sameOrigin(u) ? u : ('/api/img-proxy?url=' + encodeURIComponent(u))));
  const loadImg = (src) => new Promise((resolve) => {
    if (!src) return resolve(null);
    const im = new Image();
    im.crossOrigin = 'anonymous';
    im.onload = () => resolve(im);
    im.onerror = () => resolve(null);
    im.src = src;
  });

  const rows = [];
  for (const a of list) {
    const trig = a.trigger || 'gift';
    let leftImg = null, leftEmoji = '';
    if (trig === 'gift') leftImg = await loadImg(proxied(a.giftImage));
    else { const ev = MC_TRIG_ICON[trig] || { ic: '⚡' }; leftEmoji = ev.ic; }
    const actIcon = await loadImg('/img/roblox/' + (a.id || '') + '.png');
    rows.push({ a, leftImg, leftEmoji, actIcon, actEmoji: a.emoji || '🎮' });
  }

  // Orientación: vertical = 1 columna; horizontal = 1 fila; por defecto cuadrícula.
  let cols;
  if (orientation === 'vertical') cols = 1;
  else if (orientation === 'horizontal') cols = rows.length;
  else cols = Math.max(1, Math.min(5, rows.length));
  cols = Math.max(1, cols);
  const gridRows = Math.ceil(rows.length / cols);
  const margin = 10, gap = 14, cellW = 200, numH = 14, iconS = 156, giftS = 52;
  const cellH = numH + iconS + 30;
  const W = margin * 2 + cols * cellW + (cols - 1) * gap;
  const H = margin * 2 + gridRows * cellH + (gridRows - 1) * gap;
  const dpr = 2;
  const cv = document.createElement('canvas');
  cv.width = W * dpr; cv.height = H * dpr;
  const ctx = cv.getContext('2d');
  ctx.scale(dpr, dpr);

  const rr = (x, y, w, h, r) => {
    const rad = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rad, y);
    ctx.arcTo(x + w, y, x + w, y + h, rad);
    ctx.arcTo(x + w, y + h, x, y + h, rad);
    ctx.arcTo(x, y + h, x, y, rad);
    ctx.arcTo(x, y, x + w, y, rad);
    ctx.closePath();
  };

  ctx.textBaseline = 'middle';
  rows.forEach((row, i) => {
    const c = i % cols, r = Math.floor(i / cols);
    const cellX = margin + c * (cellW + gap);
    const cellY = margin + r * (cellH + gap);
    const iconX = cellX + (cellW - iconS) / 2;
    const iconY = cellY + numH;

    // Icono de la acción (imagen o emoji)
    if (row.actIcon) {
      ctx.save(); rr(iconX, iconY, iconS, iconS, 16); ctx.clip();
      ctx.drawImage(row.actIcon, iconX, iconY, iconS, iconS);
      ctx.restore();
    } else {
      ctx.font = '96px serif'; ctx.textAlign = 'center'; ctx.fillStyle = '#fff';
      ctx.fillText(row.actEmoji, iconX + iconS / 2, iconY + iconS / 2);
    }

    // Regalo/evento pequeño, casi en los pies del icono.
    const gx = cellX + (cellW - giftS) / 2, gy = iconY + iconS - Math.round(giftS * 0.5);
    ctx.save(); rr(gx, gy, giftS, giftS, 12); ctx.clip();
    if (row.leftImg) ctx.drawImage(row.leftImg, gx, gy, giftS, giftS);
    else { ctx.font = '34px serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#fff'; ctx.fillText(row.leftEmoji || '🎁', gx + giftS / 2, gy + giftS / 2 + 1); }
    ctx.restore();
  });

  try {
    const data = cv.toDataURL('image/png');
    const suffix = orientation === 'vertical' ? '-vertical' : orientation === 'horizontal' ? '-horizontal' : '';
    const link = document.createElement('a');
    link.href = data; link.download = 'menu-regalos-roblox' + suffix + '.png';
    document.body.appendChild(link); link.click(); link.remove();
    toast && toast('Imagen generada y descargada.', 'ok');
  } catch {
    toast && toast('No se pudo exportar la imagen. Revisa tu conexión e inténtalo de nuevo.', 'err');
  }
}

// Descarga el archivo del servidor (botón sobre la imagen).
let gameDlProgressOff = null;

function fmtDlBytes(b) {
  if (!b) return '0 B';
  const mb = b / (1024 * 1024);
  return mb >= 1 ? mb.toFixed(1) + ' MB' : (b / 1024).toFixed(0) + ' KB';
}

function ensureGameDownloadModal() {
  let el = document.getElementById('game-dl-modal');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'game-dl-modal';
  el.className = 'modal game-dl-modal hidden';
  el.innerHTML = `
    <div class="game-dl-box" role="dialog" aria-live="polite" aria-label="Descargando juego">
      <h3 class="game-dl-title"><span class="game-dl-dot"></span> Descargando juego…</h3>
      <p class="game-dl-name" id="game-dl-name"></p>
      <p class="game-dl-status" id="game-dl-status">Preparando descarga…</p>
      <div class="game-dl-barwrap"><div class="game-dl-bar" id="game-dl-bar"></div></div>
      <div class="game-dl-stats">
        <span id="game-dl-size">—</span>
        <span class="game-dl-pct" id="game-dl-pct">0%</span>
      </div>
    </div>`;
  document.body.appendChild(el);
  return el;
}

function updateGameDownloadProgress(d) {
  const modal = document.getElementById('game-dl-modal');
  if (!modal || modal.classList.contains('hidden')) return;
  const bar = modal.querySelector('#game-dl-bar');
  const pctEl = modal.querySelector('#game-dl-pct');
  const sizeEl = modal.querySelector('#game-dl-size');
  const statusEl = modal.querySelector('#game-dl-status');
  if (!bar || !pctEl || !sizeEl || !statusEl) return;
  if (d.error) {
    statusEl.textContent = 'Error: ' + d.error;
    statusEl.classList.add('err');
    bar.classList.remove('indeterminate');
    return;
  }
  statusEl.classList.remove('err');
  if (d.filename) {
    const nameEl = modal.querySelector('#game-dl-name');
    if (nameEl) nameEl.textContent = d.filename;
  }
  const total = Number(d.total) || 0;
  const done = Number(d.done) || 0;
  if (total > 0) {
    bar.classList.remove('indeterminate');
    const p = Math.max(0, Math.min(100, d.pct != null ? d.pct : Math.round((done / total) * 100)));
    bar.style.width = p + '%';
    pctEl.textContent = p + '%';
    sizeEl.textContent = fmtDlBytes(done) + ' / ' + fmtDlBytes(total);
  } else if (done > 0) {
    bar.classList.add('indeterminate');
    pctEl.textContent = '…';
    sizeEl.textContent = fmtDlBytes(done) + ' descargados';
  }
  if (d.complete) {
    bar.classList.remove('indeterminate');
    bar.style.width = '100%';
    pctEl.textContent = '100%';
    statusEl.textContent = 'Descarga completa. Abriendo carpeta…';
  } else if (d.started) {
    statusEl.textContent = 'Descargando… no cierres Livecoins (puede tardar varios minutos).';
  }
}

function showGameDownloadProgress(filename) {
  const modal = ensureGameDownloadModal();
  modal.classList.remove('hidden');
  updateGameDownloadProgress({ filename, done: 0, total: 0, pct: 0, started: true });
  if (gameDlProgressOff) gameDlProgressOff();
  if (window.desktopAPI?.onGameDownloadProgress) {
    gameDlProgressOff = window.desktopAPI.onGameDownloadProgress((d) => updateGameDownloadProgress(d));
  }
}

function hideGameDownloadProgress(delayMs) {
  const close = () => {
    const modal = document.getElementById('game-dl-modal');
    if (modal) modal.classList.add('hidden');
    if (gameDlProgressOff) { gameDlProgressOff(); gameDlProgressOff = null; }
  };
  if (delayMs > 0) setTimeout(close, delayMs);
  else close();
}

async function downloadMinecraftServer(url) {
  if (!url) return;
  const filename = decodeURIComponent(String(url).split('/').pop()?.split('?')[0] || 'archivo');
  if (IS_DESKTOP && window.desktopAPI?.downloadGameAsset) {
    showGameDownloadProgress(filename);
    try {
      const r = await window.desktopAPI.downloadGameAsset(url);
      if (r?.ok) {
        updateGameDownloadProgress({ filename: r.filename || filename, complete: true, pct: 100 });
        hideGameDownloadProgress(1200);
        toast && toast(`Listo: ${r.filename || filename} en Descargas/Livecoins`, 'ok');
        return;
      }
      updateGameDownloadProgress({ error: r?.error || 'No se pudo descargar' });
      hideGameDownloadProgress(2500);
      if (r?.openedBrowser) toast && toast('No se pudo descargar dentro de la app. Se abrió en tu navegador.', 'warn');
      else if (r?.error) toast && toast('Descarga falló: ' + r.error, 'err');
    } catch (e) {
      updateGameDownloadProgress({ error: String(e?.message || e) });
      hideGameDownloadProgress(2500);
      toast && toast('Descarga falló: ' + (e?.message || e), 'err');
    }
    return;
  }
  if (IS_DESKTOP && window.desktopAPI?.openExternal) {
    window.desktopAPI.openExternal(url);
    toast && toast('Abriendo la descarga en tu navegador…', 'ok');
    return;
  }
  window.open(url, '_blank', 'noopener');
  toast && toast('Abriendo la descarga en tu navegador…', 'ok');
}

const MC_BAT_KEY = 'mcServerBatPath';
// El servidor del Cubo TNT (Bedrock) guarda su .bat por separado del de Minecraft.
const BEDROCK_BAT_KEY = 'bedrockServerBatPath';

// Pide el .bat del servidor del Cubo TNT y guarda la ruta. Devuelve la ruta o ''.
async function chooseBedrockBat(announce) {
  if (!IS_DESKTOP || !window.desktopAPI?.pickServerBat) {
    toast && toast('Esto solo funciona en la app de escritorio (.exe).', 'warn');
    return '';
  }
  const picked = await window.desktopAPI.pickServerBat();
  if (!picked) return '';
  try { localStorage.setItem(BEDROCK_BAT_KEY, picked); } catch {}
  if (announce) toast && toast('Servidor seleccionado. Pulsa Ejecutar servidor para iniciarlo.', 'ok');
  return picked;
}

// Ejecuta el servidor del Cubo TNT: si no hay .bat guardado, primero lo pide.
async function runBedrockServer() {
  if (!IS_DESKTOP || !window.desktopAPI?.runServerBat) {
    toast && toast('Para iniciar el servidor abre la app de escritorio (.exe).', 'warn');
    return;
  }
  let path = '';
  try { path = localStorage.getItem(BEDROCK_BAT_KEY) || ''; } catch {}
  if (!path) { path = await chooseBedrockBat(false); if (!path) return; }
  const r = await window.desktopAPI.runServerBat(path);
  if (r && r.ok) {
    toast && toast('Iniciando el servidor del Cubo TNT…', 'ok');
  } else if (r && r.error === 'no_existe') {
    try { localStorage.removeItem(BEDROCK_BAT_KEY); } catch {}
    toast && toast('No se encontró el archivo. Elígelo de nuevo.', 'warn');
    const np = await chooseBedrockBat(false);
    if (np) { const r2 = await window.desktopAPI.runServerBat(np); if (r2 && r2.ok) toast && toast('Iniciando el servidor del Cubo TNT…', 'ok'); }
  } else {
    toast && toast('No se pudo iniciar el servidor.', 'err');
  }
}

// Pide al usuario el archivo .bat del servidor y guarda la ruta. Devuelve la ruta o ''.
async function chooseMinecraftBat(announce) {
  if (!IS_DESKTOP || !window.desktopAPI?.pickServerBat) {
    toast && toast('Esto solo funciona en la app de escritorio (.exe).', 'warn');
    return '';
  }
  const picked = await window.desktopAPI.pickServerBat();
  if (!picked) return '';
  try { localStorage.setItem(MC_BAT_KEY, picked); } catch {}
  if (announce) toast && toast('Servidor seleccionado. Pulsa CLICK AQUÍ para iniciarlo.', 'ok');
  return picked;
}

// Ejecuta el servidor: si no hay .bat guardado, primero lo pide.
async function runMinecraftServer() {
  if (!IS_DESKTOP || !window.desktopAPI?.runServerBat) {
    toast && toast('Para iniciar el servidor abre la app de escritorio (.exe).', 'warn');
    return;
  }
  let path = '';
  try { path = localStorage.getItem(MC_BAT_KEY) || ''; } catch {}
  if (!path) { path = await chooseMinecraftBat(false); if (!path) return; }
  const r = await window.desktopAPI.runServerBat(path);
  if (r && r.ok) {
    toast && toast('Iniciando el servidor de Minecraft…', 'ok');
  } else if (r && r.error === 'no_existe') {
    try { localStorage.removeItem(MC_BAT_KEY); } catch {}
    toast && toast('No se encontró el archivo. Elígelo de nuevo.', 'warn');
    const np = await chooseMinecraftBat(false);
    if (np) { const r2 = await window.desktopAPI.runServerBat(np); if (r2 && r2.ok) toast && toast('Iniciando el servidor de Minecraft…', 'ok'); }
  } else {
    toast && toast('No se pudo iniciar el servidor.', 'err');
  }
}
// Bloquea la pestaña Webhook con aviso Premium; Configuración queda en su propia pestaña.
function applyWebhookLock() {
  const banner = document.getElementById('wh-premium');
  const webhookPanel = document.getElementById('wtab-webhook');
  const locked = IS_DESKTOP && !webhookUnlocked();
  if (webhookPanel) webhookPanel.classList.toggle('wh-locked', locked);
  if (banner) banner.hidden = !locked;
}

function webhookCfg() {
  const c = settings && settings.webhook ? settings.webhook : {};
  return {
    rcon: { ...WEBHOOK_DEFAULTS.rcon, ...(c.rcon || {}) },
    obs: { ...WEBHOOK_DEFAULTS.obs, ...(c.obs || {}) },
    streamerbot: { ...WEBHOOK_DEFAULTS.streamerbot, ...(c.streamerbot || {}) },
    servertap: { ...WEBHOOK_DEFAULTS.servertap, ...(c.servertap || {}) },
  };
}

// settings.webhook -> formulario.
function applyWebhookUI() {
  if (!settings) return;
  const cfg = webhookCfg();
  for (const [id, [grp, key]] of Object.entries(WEBHOOK_MAP)) {
    const el = document.getElementById(id);
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = !!cfg[grp][key];
    else el.value = cfg[grp][key];
  }
}
// Formulario -> settings.webhook y guarda.
function saveWebhookSettings() {
  if (!settings) return;
  const cfg = webhookCfg();
  for (const [id, [grp, key]] of Object.entries(WEBHOOK_MAP)) {
    const el = document.getElementById(id);
    if (!el) continue;
    if (el.type === 'checkbox') cfg[grp][key] = el.checked;
    else if (el.type === 'number') cfg[grp][key] = parseInt(el.value, 10) || 0;
    else cfg[grp][key] = el.value;
  }
  settings.webhook = cfg;
  saveSettings();
}

let webhookWired = false;
function setupWebhookUI() {
  if (webhookWired) return;
  webhookWired = true;

  // Botones de copiar de los bloques de endpoints.
  document.querySelectorAll('#view-webhook .wh-endpoint .wh-copy').forEach((btn) => {
    btn.onclick = () => {
      const code = btn.parentElement.querySelector('.wh-url');
      if (!code) return;
      const text = code.textContent;
      const done = () => { btn.classList.add('ok'); setTimeout(() => btn.classList.remove('ok'), 1200); };
      if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
      else fallbackCopy(text, done);
    };
  });

  // Guardado automático de la configuración.
  const flashSaved = () => {
    const msg = document.getElementById('wh-save-msg');
    if (msg) { msg.textContent = '✓ Guardado'; clearTimeout(flashSaved._t); flashSaved._t = setTimeout(() => { msg.textContent = ''; }, 1500); }
  };
  let whTimer = null;
  const autoSave = () => { clearTimeout(whTimer); whTimer = setTimeout(() => { saveWebhookSettings(); flashSaved(); }, 350); };
  for (const id of Object.keys(WEBHOOK_MAP)) {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', autoSave);
  }

  // Botones "Probar Conexión" (pestaña Configuración).
  document.querySelectorAll('#view-configuracion .wh-test').forEach((btn) => {
    btn.onclick = () => testWebhookConnection(btn.dataset.test, btn);
  });

  applyWebhookUI();
  applyWebhookLock();
}

async function testWebhookConnection(kind, btn) {
  saveWebhookSettings();
  const cfg = webhookCfg();
  const msgId = kind === 'rcon' ? 'wh-rcon-msg' : kind === 'obs' ? 'wh-obs-msg' : kind === 'servertap' ? 'wh-stap-msg' : 'wh-sb-msg';
  const msg = document.getElementById(msgId);
  const setMsg = (t, cls) => { if (msg) { msg.textContent = t; msg.className = 'wh-test-msg ' + cls; } };
  let body, url;
  if (kind === 'rcon') { url = '/api/webhook/test-rcon'; body = cfg.rcon; }
  else if (kind === 'obs') { url = '/api/webhook/test-obs'; body = cfg.obs; }
  else if (kind === 'servertap') { url = '/api/webhook/test-servertap'; body = cfg.servertap; }
  else { url = '/api/webhook/test-streamerbot'; body = cfg.streamerbot; }
  setMsg('Probando…', 'run');
  if (btn) btn.disabled = true;
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json();
    if (d.ok) setMsg('✓ Conexión correcta', 'ok');
    else setMsg('✗ ' + (d.error || 'No se pudo conectar'), 'err');
  } catch {
    setMsg('✗ Error de red', 'err');
  } finally {
    if (btn) btn.disabled = false;
  }
}

/* ===== Pantalla de inicio: bienvenida + consejos ===== */
function homeGreetingText() {
  const h = new Date().getHours();
  if (h < 6) return '🌙 Buenas noches';
  if (h < 12) return '☀️ Buenos días';
  if (h < 19) return '🌤️ Buenas tardes';
  return '🌙 Buenas noches';
}
function homeLastUser() {
  let u = '';
  try { u = ($('username') && $('username').value || '').trim(); } catch {}
  if (!u) { try { u = (localStorage.getItem('lastTikTokUser') || '').trim(); } catch {} }
  return u.replace(/^@/, '');
}

let panelLivesTimer = null;

/* ====================== Ranking semanal streamers ====================== */
let srkType = 'likes';
let srkTimer = null;
let srkWired = false;

function srkLimit() {
  const el = document.getElementById('srk-limit');
  const n = el ? Number(el.value) : 10;
  return Math.min(100, Math.max(3, Number.isFinite(n) ? n : 10));
}

function fmtSrkReset(resetAt) {
  const ms = Math.max(0, (resetAt || 0) - Date.now());
  const d = Math.floor(ms / 86400000);
  const h = Math.floor((ms % 86400000) / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function fmtSrkWeekRange(start, end) {
  try {
    const a = new Date(start).toLocaleDateString('es', { day: 'numeric', month: 'short' });
    const b = new Date(end - 1).toLocaleDateString('es', { day: 'numeric', month: 'short' });
    return `${a} – ${b}`;
  } catch { return ''; }
}

function fmtSrkDayLabel(key) {
  try {
    const [y, mo, d] = key.split('-').map(Number);
    const dt = new Date(y, mo - 1, d);
    return dt.toLocaleDateString('es', { weekday: 'short', day: 'numeric' });
  } catch { return key; }
}

const SRK_DOW_SHORT = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

function srkDayKeyFromDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function srkWeekTimeline(weekStart) {
  const todayKey = srkDayKeyFromDate(new Date());
  const start = new Date(weekStart);
  const cells = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const key = srkDayKeyFromDate(d);
    const dow = d.getDay();
    cells.push({
      key,
      dow,
      sort: dow === 0 ? 7 : dow,
      label: SRK_DOW_SHORT[dow],
      num: d.getDate(),
      isToday: key === todayKey,
      isFuture: key > todayKey,
    });
  }
  return cells.sort((a, b) => a.sort - b.sort);
}

function renderSrkTimeline(daysMap, weekStart, isLikes, valLabel) {
  const timeline = srkWeekTimeline(weekStart);
  const cells = timeline.map((day) => {
    const dv = daysMap[day.key] || {};
    const v = isLikes ? (dv.likes || 0) : (dv.diamonds || 0);
    const h = Math.round((dv.streamMs || 0) / 36000) / 100;
    const has = v > 0 || h > 0;
    const cls = ['srk-tl-cell', day.isToday && 'today', has && 'has-data', day.isFuture && !has && 'future'].filter(Boolean).join(' ');
    const tip = `${day.label} ${day.num}: ${has ? `${fmt(v)} ${valLabel}` : 'sin actividad'}${h > 0 ? ` · ${h}h` : ''}`;
    return `<div class="${cls}" title="${esc(tip)}">
      <span class="srk-tl-dow">${day.label}</span>
      <span class="srk-tl-num">${day.num}</span>
      <span class="srk-tl-val">${has ? fmt(v) : '—'}</span>
      <span class="srk-tl-h">${h > 0 ? `${h}h` : '·'}</span>
    </div>`;
  }).join('');
  return `<div class="srk-timeline"><div class="srk-tl-grid">${cells}</div></div>`;
}

function renderStreamerRanking(data) {
  const list = document.getElementById('srk-list');
  const resetEl = document.getElementById('srk-reset');
  if (!list) return;
  if (!data) {
    list.innerHTML = '<p class="srk-empty">No se pudo cargar el ranking.</p>';
    return;
  }
  const isLikes = data.type === 'likes';
  const valKey = isLikes ? 'likesWeek' : 'diamondsWeek';
  const valLabel = isLikes ? 'likes' : 'diamantes';
  if (resetEl) {
    resetEl.textContent = `Semana ${fmtSrkWeekRange(data.weekStart, data.weekEnd)} · Reinicio en ${fmtSrkReset(data.resetAt)} (lunes 00:00)`;
  }
  const entries = data.entries || [];
  if (!entries.length) {
    list.innerHTML = '<p class="srk-empty">Aún no hay datos esta semana. Conecta tu live para sumar al ranking.</p>';
    return;
  }
  list.innerHTML = entries.map((e) => {
    const name = esc(e.nickname || e.tiktok || e.username || 'Streamer');
    const handle = e.tiktok ? `@${esc(e.tiktok)}` : (e.username ? `@${esc(e.username)}` : '');
    const photoUrl = e.photo ? panelLiveImgUrl(e.photo) : '';
    const av = photoUrl
      ? `<img class="srk-av" src="${esc(photoUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'srk-ph',textContent:'${initial(e.nickname || e.tiktok || '?')}' }))">`
      : `<div class="srk-ph">${initial(e.nickname || e.tiktok || '?')}</div>`;
    const timeline = renderSrkTimeline(e.days || {}, data.weekStart, isLikes, valLabel);
    return `<article class="srk-row${e.rank === 1 ? ' top1' : ''}">
      <div class="srk-rank">#${e.rank}</div>
      ${av}
      <div><div class="srk-name">${name}</div>${handle ? `<div class="srk-handle">${handle}</div>` : ''}</div>
      <div class="srk-meta">
        <div class="srk-val">${fmt(e[valKey] || 0)}</div>
        <div class="srk-hours">${e.streamHours || 0}h en vivo</div>
      </div>
      ${timeline}
    </article>`;
  }).join('');
}

async function refreshStreamerRanking() {
  const view = document.getElementById('view-ranking');
  if (!view || !view.classList.contains('active')) return;
  try {
    const r = await fetch(`/api/streamer-rankings?type=${encodeURIComponent(srkType)}&limit=${srkLimit()}`);
    if (!r.ok) throw new Error('http');
    renderStreamerRanking(await r.json());
  } catch {
    renderStreamerRanking(null);
  }
}

function setupStreamerRanking() {
  if (srkWired) return;
  srkWired = true;
  try {
    const saved = localStorage.getItem('livecoins-srk-limit');
    const lim = document.getElementById('srk-limit');
    if (lim && saved) lim.value = saved;
  } catch {}
  document.querySelectorAll('.srk-tab').forEach((btn) => {
    btn.onclick = () => {
      document.querySelectorAll('.srk-tab').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      srkType = btn.dataset.srk === 'diamonds' ? 'diamonds' : 'likes';
      refreshStreamerRanking();
    };
  });
  const lim = document.getElementById('srk-limit');
  if (lim) {
    lim.onchange = () => {
      try { localStorage.setItem('livecoins-srk-limit', String(srkLimit())); } catch {}
      refreshStreamerRanking();
    };
  }
  if (srkTimer) clearInterval(srkTimer);
  srkTimer = setInterval(refreshStreamerRanking, 25000);
}

function panelLiveImgUrl(u) {
  if (!u) return '';
  const s = String(u).trim();
  if (!s) return '';
  if (s.startsWith('/api/img-proxy')) return s;
  if (/^https?:\/\//i.test(s)) {
    if (s.startsWith(location.origin)) return s;
    return '/api/img-proxy?url=' + encodeURIComponent(s);
  }
  if (s.startsWith('//')) return '/api/img-proxy?url=' + encodeURIComponent('https:' + s);
  return s;
}

function openPanelLiveUrl(url) {
  const u = String(url || '').trim();
  if (!u) return;
  if (IS_DESKTOP && window.desktopAPI?.openExternal) {
    window.desktopAPI.openExternal(u);
    return;
  }
  window.open(u, '_blank', 'noopener,noreferrer');
}

function panelLiveFallbackChar(name) {
  const ch = String(name || '?').trim()[0];
  return ch ? ch.toUpperCase() : '?';
}

function renderPanelLives(lives) {
  const sec = $('panel-lives');
  const track = $('panel-lives-track');
  if (!sec || !track) return;
  if (!lives.length) { sec.hidden = true; track.innerHTML = ''; return; }
  sec.hidden = false;
  track.innerHTML = lives.map((l) => {
    const tiktok = String(l.tiktok || l.account || '').replace(/^@+/, '');
    const name = esc(l.nickname || tiktok || l.panelUser || 'Live');
    const viewers = fmt(Number(l.viewers) || 0);
    const liveUrl = l.url || (`https://www.tiktok.com/@${encodeURIComponent(tiktok)}/live`);
    const url = esc(liveUrl);
    const fallback = esc(panelLiveFallbackChar(l.nickname || tiktok || name));
    const photo = panelLiveImgUrl(l.photo || '');
    const av = photo
      ? `<img class="panel-live-av" src="${esc(photo)}" alt="" loading="eager" decoding="async" referrerpolicy="no-referrer" data-fallback="${fallback}">`
      : `<span class="panel-live-av panel-live-av-ph">${fallback}</span>`;
    return `<a class="panel-live-card" href="${url}" data-live-url="${url}" target="_blank" rel="noopener noreferrer" title="Ver live de @${esc(tiktok)}">
      ${av}
      <span class="panel-live-badge">EN LIVE</span>
      <span class="panel-live-name">${name}</span>
      <span class="panel-live-user">@${esc(tiktok)}</span>
      <span class="panel-live-viewers">👀 ${viewers}</span>
    </a>`;
  }).join('');
  track.querySelectorAll('.panel-live-av').forEach((el) => {
    if (el.tagName !== 'IMG') return;
    el.onerror = () => {
      const ph = document.createElement('span');
      ph.className = 'panel-live-av panel-live-av-ph';
      ph.textContent = el.dataset.fallback || '?';
      el.replaceWith(ph);
    };
  });
}
async function refreshPanelLives() {
  try {
    const r = await fetch('/api/panel-lives');
    if (!r.ok) return;
    const d = await r.json();
    renderPanelLives(d.lives || []);
  } catch { /* sin red */ }
}
function setupPanelLives() {
  const track = $('panel-lives-track');
  if (track && !track._panelLiveClick) {
    track._panelLiveClick = true;
    track.addEventListener('click', (e) => {
      const card = e.target.closest('.panel-live-card');
      if (!card) return;
      e.preventDefault();
      openPanelLiveUrl(card.dataset.liveUrl || card.getAttribute('href'));
    });
  }
  refreshPanelLives();
  if (panelLivesTimer) clearInterval(panelLivesTimer);
  panelLivesTimer = setInterval(refreshPanelLives, 25000);
}

function updateHomeWelcome(s) {
  const greet = document.getElementById('home-welcome-greet');
  const sub = document.getElementById('home-welcome-sub');
  const btn = document.getElementById('home-welcome-btn');
  if (!greet) return;
  const user = (s && s.username) ? String(s.username).replace(/^@/, '') : homeLastUser();
  greet.textContent = user ? `${homeGreetingText()}, @${user}` : `${homeGreetingText()} 👋`;
  if (sub) {
    if (s && s.connected) sub.textContent = `🔴 En vivo · @${user}`;
    else if (s && s.autoConnect && user) sub.textContent = `⏳ Esperando que @${user} inicie el live…`;
    else if (user) sub.textContent = '¡Listo para volver al directo! Pulsa Conectar.';
    else sub.textContent = 'Conecta tu cuenta de TikTok para empezar.';
  }
  if (btn) btn.style.display = (s && s.connected) ? 'none' : '';
}
function initHomeWelcome() {
  updateHomeWelcome(null);
  const btn = document.getElementById('home-welcome-btn');
  if (btn) {
    btn.onclick = () => {
      const inp = $('username');
      if (inp && !inp.value.trim()) { const u = homeLastUser(); if (u) inp.value = u; }
      if (typeof doConnect === 'function') doConnect();
    };
  }
  const tips = Array.from(document.querySelectorAll('#home-tips .home-tip'));
  const dotsWrap = document.getElementById('home-tips-dots');
  if (!tips.length) return;
  let idx = Math.max(0, tips.findIndex((t) => t.classList.contains('is-active')));
  if (dotsWrap) dotsWrap.innerHTML = tips.map((_, i) => `<span data-i="${i}"></span>`).join('');
  const dots = dotsWrap ? Array.from(dotsWrap.children) : [];
  const show = (n) => {
    idx = (n + tips.length) % tips.length;
    tips.forEach((t, i) => t.classList.toggle('is-active', i === idx));
    dots.forEach((d, i) => d.classList.toggle('on', i === idx));
  };
  dots.forEach((d) => { d.onclick = () => show(+d.dataset.i); });
  show(idx);
  setInterval(() => show(idx + 1), 6000);
}

(async () => {
  // Primero sesión (roomKey / cloudRoomKey); luego WebSocket con la URL correcta.
  preloadGiftCatalog();
  await confirmDesktopPanelFromServer();
  setupPanelModeWarning();
  try { syncNavSections(); } catch {}
  try { mountUserChip(); } catch {}
  try { setupProfiles(); } catch (e) { console.error('Perfiles UI:', e); }
  try { initHomeWelcome(); } catch (e) { console.error('Home welcome:', e); }
  try { setupPanelLives(); } catch (e) { console.error('Panel lives:', e); }
  try { setupSettingsTransfer(); } catch (e) { console.error('Settings transfer:', e); }
  if (IS_DESKTOP) {
    document.documentElement.classList.add('is-desktop');
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.getRegistrations().then((rs) => rs.forEach((r) => r.unregister())).catch(() => {});
    }
    const navAcc = document.getElementById('navAcciones');
    if (navAcc) navAcc.style.display = '';
    try { syncNavSections(); } catch {}
    try { setupAccionesUI(); }
    catch (e) { console.error('Acciones UI:', e); }
    try { setupProfiles(); }
    catch (e) { console.error('Perfiles UI:', e); }
  }
  await loadMe();
  mountUserChip();
    refreshOverlayUrls();
    refreshLevelVideoScreenLink();
    try { loadAnnouncements(); } catch (e) { console.error('Anuncios:', e); }
    try { revealSpotifyTab(); } catch (e) { console.error('Spotify tab:', e); }
    if (spotifyAllowed()) {
      try { setupSpotifyUI(); } catch (e) { console.error('Spotify UI:', e); }
      if (new URLSearchParams(location.search).get('spotify') === 'connected') openSpotifyViewAfterConnect();
    }
    try { revealWebhookTab(); } catch (e) { console.error('Webhook tab:', e); }
    try { revealConfigTab(); } catch (e) { console.error('Config tab:', e); }
    if (IS_DESKTOP) { try { setupWebhookUI(); } catch (e) { console.error('Webhook UI:', e); } }
    try { revealJuegosTab(); setupJuegosUI(); } catch (e) { console.error('Juegos tab:', e); }
})();
