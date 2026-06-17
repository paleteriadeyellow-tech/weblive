// Una "room" = un usuario. Encapsula TODO su estado, ajustes, conexión a TikTok,
// puntajes de batalla, ranking semanal y sus clientes WebSocket (panel + overlays).
// Los broadcasts solo llegan a los clientes de ESTA room, por lo que las alertas y
// datos de distintos usuarios nunca se mezclan.
import './euler-config.js';
import fs from 'node:fs';
import path from 'node:path';
import { TikTokLiveConnection, WebcastEvent, ControlEvent } from 'tiktok-live-connector';
import { DEFAULT_SETTINGS, deepMerge } from './default-settings.js';
import { createActionBridge } from './cloud-actions.js';

/* ----------------------- Helpers sin estado (compartidos) ----------------------- */
function getPhoto(user) {
  if (!user) return null;
  return (
    user.profilePictureUrl ||
    user.profilePicture?.url?.[0] ||
    user.profilePicture?.urls?.[0] ||
    user.userDetails?.profilePictureUrls?.[0] ||
    null
  );
}
function getGiftImage(data) {
  return (
    data?.giftDetails?.giftImage?.giftPictureUrl ||
    data?.giftDetails?.image?.url?.[0] ||
    data?.giftPictureUrl ||
    null
  );
}
function baseUser(user) {
  return {
    uniqueId: user?.uniqueId || '',
    nickname: user?.nickname || user?.uniqueId || 'Anónimo',
    photo: getPhoto(user),
  };
}
function numMemberLevel(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && n <= 50 ? n : 0;
}
function badgeScene(b) {
  return Number(b?.badgeSceneType ?? b?.badgeScene ?? b?.sceneType ?? 0);
}
function levelFromBadge(b) {
  if (!b) return 0;
  const candidates = [
    b.level,
    b.privilegeLogExtra?.level,
    b.logExtra?.level,
    b.combine?.profileCardPanel?.profileContent?.numberConfig?.number,
    b.combine?.str,
    b.str?.str,
  ];
  for (const v of candidates) {
    const n = numMemberLevel(v);
    if (n) return n;
  }
  return 0;
}
function flattenBadges(raw) {
  const out = [];
  for (const b of [].concat(raw || [])) {
    if (!b || typeof b !== 'object') continue;
    out.push(b);
    const scene = badgeScene(b);
    if (Array.isArray(b.badges)) {
      for (const inner of b.badges) {
        out.push({
          ...inner,
          badgeSceneType: inner?.badgeSceneType ?? scene,
          badgeScene: inner?.badgeScene ?? scene,
        });
      }
    }
    if (Array.isArray(b.imageBadges)) {
      for (const ib of b.imageBadges) {
        if (ib) {
          out.push({
            ...ib,
            badgeSceneType: scene,
            badgeScene: scene,
            type: 'image',
            url: ib.image?.url,
          });
        }
      }
    }
    const privLevel = b.privilegeLogExtra?.level || b.logExtra?.level;
    if (privLevel && privLevel !== '0') {
      out.push({
        type: 'privilege',
        level: parseInt(String(privLevel), 10),
        badgeSceneType: scene,
        badgeScene: scene,
        privilegeLogExtra: b.privilegeLogExtra,
        logExtra: b.logExtra,
      });
    }
  }
  return out;
}
function memberLevelFromUser(u) {
  const levels = [
    numMemberLevel(u?.fansClub?.data?.level),
    numMemberLevel(u?.fansClubInfo?.fansLevel),
    numMemberLevel(u?.teamMemberLevel),
  ];
  if (u?.fansClub?.preferData && typeof u.fansClub.preferData === 'object') {
    for (const entry of Object.values(u.fansClub.preferData)) {
      levels.push(numMemberLevel(entry?.level));
    }
  }
  const badges = flattenBadges([
    ...(u.badges || []),
    ...(u.userBadges || []),
    ...(u.newUserBadges || []),
    ...(u.badgeImageList || []),
  ]);
  for (const b of badges) {
    if (badgeScene(b) === 10) levels.push(levelFromBadge(b));
  }
  return Math.max(0, ...levels);
}
function chatUserRoles(data) {
  // Formato moderno: data.user. Legacy (connector antiguo): campos aplanados en data.
  const u = data?.user || data || {};
  const ui = data?.userIdentity || {};
  const badges = flattenBadges([].concat(u.badges || [], u.userBadges || [], u.newUserBadges || [], u.badgeImageList || []));
  const scene = badgeScene;
  const badgeUrl = (b) => String(b?.url || b?.image?.url?.[0] || b?.image?.uri || '').toLowerCase();
  const badgeType = (b) => String(b?.type || b?.displayType || '').toLowerCase();

  const isMod = !!(
    ui.isModeratorOfAnchor ||
    badges.some((b) => scene(b) === 1 || badgeType(b).includes('moderator'))
  );
  const isSub = !!(
    ui.isSubscriberOfAnchor ||
    numMemberLevel(u?.fansClub?.data?.level) > 0 ||
    numMemberLevel(u?.fansClubInfo?.fansLevel) > 0 ||
    badges.some((b) => scene(b) === 4 || scene(b) === 7 || badgeUrl(b).includes('/sub_'))
  );
  const followStatus = Number(u?.followInfo?.followStatus ?? u?.followStatus ?? 0);
  const isFollower = !!(ui.isFollowerOfAnchor || ui.isMutualFollowingWithAnchor || followStatus >= 1);
  const teamBadge = badges.find((b) => scene(b) === 10);
  const memberLevel = memberLevelFromUser(u);
  const isTeam = !!(levelFromBadge(teamBadge) > 0 || memberLevel > 0);

  return { isMod, isSub, isFollower, isTeam, memberLevel };
}
function matchesCommand(command, comment) {
  const cmd = String(command || '').trim().toLowerCase();
  if (!cmd) return false;
  const text = String(comment || '').trim().toLowerCase();
  if (!text) return false;
  return text === cmd || text.split(/\s+/)[0] === cmd;
}
function emoteImageUrl(img) {
  if (!img) return '';
  if (typeof img === 'string') return img;
  return img.url_list?.[0] || img.urlList?.[0] || img.imageUrl || img.url?.[0] || '';
}
function currentWeekRange(now = Date.now()) {
  const d = new Date(now);
  const day = (d.getDay() + 6) % 7; // 0 = lunes
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate() - day, 0, 0, 0, 0).getTime();
  const end = start + 7 * 86400000;
  return [start, end];
}
// Busca el multiplicador del golpe crítico (x2/x3) en cualquier parte de un mensaje PK.
function scanMultiplier(obj, depth, acc) {
  if (!obj || typeof obj !== 'object' || depth > 6) return;
  for (const k in obj) {
    const v = obj[k];
    if (v && typeof v === 'object') { scanMultiplier(v, depth + 1, acc); continue; }
    const key = k.toLowerCase();
    if (key === 'triggercriticalstrike' && (v === true || v === 1 || v === '1')) {
      acc.crit = true; acc.hits.push(`${k}=${v}`);
    } else if (key === 'multipliertype' && Number(v) === 1) {
      acc.crit = true; acc.hits.push(`${k}=${v}`);
    } else if (key === 'multipliervalue' || key === 'multiplier') {
      const n = Math.round(Number(v));
      if (n >= 2 && n <= 50) { acc.value = Math.max(acc.value, n); acc.crit = true; }
      if (n >= 1) acc.hits.push(`${k}=${v}`);
    } else if (key === 'critical') {
      if (Number(v) >= 1) { acc.crit = true; acc.hits.push(`${k}=${v}`); }
    }
  }
}

const MAX_CONNECT_ATTEMPTS = 4;

/* ----------------------- Persistencia segura (sin pérdidas) ----------------------- */
// Escritura ATÓMICA: escribe a un archivo temporal y luego lo renombra encima del
// definitivo. Si se corta la luz o el proceso muere a mitad de la escritura, el
// archivo original queda intacto (nunca a medio escribir). Así las alertas, sonidos
// y videos guardados no se pueden corromper ni perder por un guardado interrumpido.
function writeJsonAtomic(file, obj) {
  try {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, file);
  } catch (e) {
    console.error('  [!] No se pudo guardar', file, '-', e.message);
  }
}

// Lectura SEGURA de un JSON. Devuelve:
//   { data }        -> leído correctamente
//   { data: null }  -> el archivo no existe todavía (usuario nuevo)
//   { corrupt:true} -> existe pero está dañado; se guarda una copia .corrupt-<ts>
//                      para poder recuperarlo y NUNCA se pierde la información.
function readJsonSafe(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { data: null }; // no existe -> arrancamos con valores por defecto
  }
  try {
    return { data: JSON.parse(raw) };
  } catch (e) {
    try { fs.copyFileSync(file, file + '.corrupt-' + Date.now()); } catch {}
    console.error('  [!] Archivo dañado, se respaldó como .corrupt y se conserva:', file, '-', e.message);
    return { corrupt: true };
  }
}

/* --------------------------------- La room --------------------------------- */
export function createRoom({ id, username: account, roomKey, dataDir, giftsById, getCaps, onUserSave, getLevelVideo }) {
  fs.mkdirSync(dataDir, { recursive: true });
  const SETTINGS_FILE = path.join(dataDir, 'settings.json');
  const PROFILES_FILE = path.join(dataDir, 'profiles.json');
  const WEEKLY_FILE = path.join(dataDir, 'weekly.json');
  const POINTS_FILE = path.join(dataDir, 'points.json');
  const SESSION_FILE = path.join(dataDir, 'session.json');
  // Perfiles: 10 ranuras, cada una guarda una configuración COMPLETA. El perfil activo
  // es el que se edita/guarda. Nunca se borran: una ranura vacía arranca con defaults.
  const PROFILE_COUNT = 10;

  const state = {
    username: null,
    connected: false,
    connecting: false,
    inBattle: false,
    criticalTimer: null,
    pendingMult: 0,
    pendingSrc: '',
    roomId: null,
    startedAt: null,
    stats: { viewers: 0, likes: 0, diamonds: 0, comments: 0, gifts: 0, follows: 0, shares: 0, joins: 0 },
    gifters: new Map(),
  };

  const battle = { scoreA: 0, scoreB: 0 };
  const giftCounter = { count: 0 }; // contador de meta (cuenta de la sesión)
  const timer = { remaining: 0, running: false };
  let timerInterval = null;
  const weekly = { start: 0, end: 0, donors: new Map() };
  // Usuario y Puntos: balance acumulado (de por vida) por usuario + historial de transacciones.
  const points = new Map();          // uniqueId -> { uniqueId, nickname, photo, total, levelPoints, firstAt, lastAt }
  let pointsTx = [];                 // transacciones recientes (las más nuevas primero), acotadas
  const POINTS_MAX_USERS = 2500;
  const POINTS_MAX_TX = 500;
  const clients = new Set();         // panel + overlays (no incluye el cliente local)
  const localClients = new Set();    // ejecutor local (.exe ligero) en la PC del streamer
  const relayClients = new Set();    // app de escritorio completa (.exe) en modo relay:
                                     // recibe datos para mostrar Y órdenes para ejecutar
  const videoScreens = new Map();    // ws -> número de pantalla
  const chatSeenUsers = new Set();
  const emoteCatalog = new Map();
  // Pelotas de fans: acumulado por usuario (con sobrante) para soltar pelotas.
  const fanCoinAcc = new Map();      // uniqueId -> monedas pendientes
  const fanLikeAcc = new Map();      // uniqueId -> likes pendientes
  const recentSubs = new Map();      // dedupe suscripciones (subscribe/subNotify)
  const recentSuperFans = new Map(); // dedupe super fans (superFan/superFanJoin)
  const memberLevels = new Map();    // uniqueId -> último nivel de miembro visto (para detectar subidas)
  const joinVideoCooldown = new Map(); // uniqueId -> última vez que se lanzó su video de entrada
  // Ruleta / sorteo: participantes recogidos durante la recolección.
  const roulette = { collecting: false, entries: new Map(), giftImage: '' }; // uid -> { uniqueId, nickname, photo }
  const ROULETTE_MAX = 300;

  let connection = null;
  let saveTimer = null;
  let weeklySaveTimer = null;
  let statsTimer = null;
  let lastTotalLikes = 0;
  let lastLikeSound = 0;
  let lastSeen = 0; // última vez que hubo una conexión (panel u overlay) activa

  // Sesión de live en curso (persiste en disco para sobrevivir reinicios de Render).
  // La auto-conexión la usa para NO vaciar overlays al reconectar el mismo live.
  let liveSession = { roomId: null, username: null, active: false, startedAt: null };
  (function loadLiveSession() {
    const r = readJsonSafe(SESSION_FILE);
    if (r.data && typeof r.data === 'object') {
      liveSession = {
        roomId: r.data.roomId ?? null,
        username: r.data.username ?? null,
        active: !!r.data.active,
        startedAt: r.data.startedAt ?? null,
      };
    }
  })();
  function saveLiveSession() {
    writeJsonAtomic(SESSION_FILE, liveSession);
  }
  function liveUserMatch(a, b) {
    return !!(a && b && String(a).toLowerCase() === String(b).toLowerCase());
  }
  function isSameLiveSession(roomId, username) {
    return !!(liveSession.roomId && roomId &&
      String(liveSession.roomId) === String(roomId) &&
      liveUserMatch(liveSession.username, username));
  }
  function markLiveSessionEnded() {
    liveSession.active = false;
    liveSession.roomId = null;
    saveLiveSession();
  }
  function resetSessionState() {
    lastTotalLikes = 0;
    resetStats();
    resetSessionOverlays();
  }
  // Auto-conexión / reinicio Render: resetea solo si es un live distinto (otro roomId).
  function applyAutoLiveConnected(newRoomId, username) {
    if (isSameLiveSession(newRoomId, username)) {
      liveSession.username = username;
      liveSession.active = true;
      saveLiveSession();
      state.startedAt = liveSession.startedAt || Date.now();
      return 'reconnect';
    }
    const prevRoomId = liveSession.roomId;
    const isNewLive = !!(newRoomId && prevRoomId && String(newRoomId) !== String(prevRoomId));
    const isFirstLive = !prevRoomId;
    if (isNewLive || isFirstLive) resetSessionState();
    liveSession = { roomId: newRoomId, username, active: true, startedAt: Date.now() };
    saveLiveSession();
    state.startedAt = liveSession.startedAt;
    return isNewLive || isFirstLive ? 'new' : 'auto';
  }

  let profiles = loadProfiles();
  let settings = loadSettings();
  loadWeekly();
  loadPoints();
  timer.remaining = Math.max(0, Math.floor(settings.timer?.defaultInitialSec || 0));
  // Recuerda el último @usuario de TikTok conectado (queda guardado en los ajustes, así
  // sobrevive a reinicios) para prerellenar el campo y poder auto-conectar al iniciar el live.
  state.username = settings.tiktokUser || null;

  /* ----------------------------- Persistencia ----------------------------- */
  // Intenta recuperar profiles.json desde copias de seguridad (.bak / .corrupt).
  function recoverProfilesFromBackups() {
    try {
      const dir = path.dirname(PROFILES_FILE);
      const base = path.basename(PROFILES_FILE);
      const candidates = fs.readdirSync(dir)
        .filter((f) => f.startsWith(base + '.bak') || f.startsWith(base + '.corrupt'))
        .map((f) => path.join(dir, f))
        .sort((a, b) => (fs.statSync(b).mtimeMs || 0) - (fs.statSync(a).mtimeMs || 0));
      for (const file of candidates) {
        const r = readJsonSafe(file);
        if (r.data && Array.isArray(r.data.slots) && r.data.slots.some((s) => s != null)) return r.data;
      }
    } catch {}
    return null;
  }
  // Carga (o crea/migra) el archivo de perfiles. Migración: si ya había un settings.json
  // suelto, se convierte en el "Perfil 1". NUNCA se borran ranuras con datos.
  function loadProfiles() {
    const r = readJsonSafe(PROFILES_FILE);
    let p = r.data;
    let created = false;
    if (r.corrupt) p = recoverProfilesFromBackups();
    if (!p || !Array.isArray(p.slots)) {
      const legacy = readJsonSafe(SETTINGS_FILE).data || null;
      p = { active: 0, names: [], slots: [] };
      p.slots[0] = legacy; // Perfil 1 hereda lo que ya había (o null = defaults)
      created = true;
    }
    p.slots = Array.isArray(p.slots) ? p.slots.slice(0, PROFILE_COUNT) : [];
    while (p.slots.length < PROFILE_COUNT) p.slots.push(null);
    p.names = Array.isArray(p.names) ? p.names.slice(0, PROFILE_COUNT) : [];
    for (let i = 0; i < PROFILE_COUNT; i++) {
      if (!p.names[i]) p.names[i] = `Perfil ${i + 1}`;
    }
    p.active = Number.isInteger(p.active) && p.active >= 0 && p.active < PROFILE_COUNT ? p.active : 0;
    if (created || r.corrupt || !fs.existsSync(PROFILES_FILE)) {
      try { writeJsonAtomic(PROFILES_FILE, p); } catch {}
    }
    return p;
  }
  function saveProfilesNow() {
    try {
      if (fs.existsSync(PROFILES_FILE)) {
        try { fs.copyFileSync(PROFILES_FILE, PROFILES_FILE + '.bak'); } catch {}
      }
      writeJsonAtomic(PROFILES_FILE, profiles);
    } catch {}
  }
  function loadSettings() {
    const slot = profiles.slots[profiles.active];
    if (slot) return deepMerge(structuredClone(DEFAULT_SETTINGS), slot);
    return structuredClone(DEFAULT_SETTINGS);
  }
  function saveSettings() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      // El perfil activo SIEMPRE guarda la configuración actual (auto-guardado).
      profiles.slots[profiles.active] = settings;
      saveProfilesNow();
      // Mantenemos settings.json como espejo del perfil activo (compatibilidad).
      writeJsonAtomic(SETTINGS_FILE, settings);
    }, 300);
  }

  /* ------------------------------- Perfiles ------------------------------- */
  // Cuántos perfiles permite el plan actual (acotado al total de ranuras).
  function profileLimit() {
    const caps = currentCaps();
    const n = Number(caps && caps.limits && caps.limits.profiles);
    if (!Number.isFinite(n) || n <= 0) return 1;
    return Math.min(PROFILE_COUNT, Math.max(1, Math.floor(n)));
  }
  function profilesInfo() {
    return {
      active: profiles.active,
      count: PROFILE_COUNT,
      max: profileLimit(),
      names: profiles.names.slice(),
      used: profiles.slots.map((s) => !!s),
    };
  }
  function broadcastProfiles() { broadcast('profiles', profilesInfo()); }
  // Cambia de perfil: primero asegura que lo actual quede guardado, luego carga el
  // perfil destino y difunde sus ajustes a panel/overlays.
  function switchProfile(i) {
    const idx = Number(i);
    if (!Number.isInteger(idx) || idx < 0 || idx >= PROFILE_COUNT || idx === profiles.active) return;
    if (idx >= profileLimit()) return; // perfil bloqueado por el plan
    clearTimeout(saveTimer);
    profiles.slots[profiles.active] = settings; // guarda el actual sin debounce
    profiles.active = idx;
    saveProfilesNow();
    settings = loadSettings();
    writeJsonAtomic(SETTINGS_FILE, settings);
    enforceLimits();
    broadcast('settings', settings);
    broadcastProfiles();
    clampTimer();
    broadcastTimer();
    if (typeof onUserSave === 'function') { try { onUserSave(settings); } catch {} }
  }
  function renameProfile(i, name) {
    const idx = Number(i);
    if (!Number.isInteger(idx) || idx < 0 || idx >= PROFILE_COUNT) return;
    const clean = String(name || '').trim().slice(0, 40);
    profiles.names[idx] = clean || `Perfil ${idx + 1}`;
    saveProfilesNow();
    broadcastProfiles();
  }
  // Devuelve TODOS los perfiles (con sus ajustes completos) para exportar. El perfil
  // activo usa los ajustes en memoria (por si hay cambios sin guardar todavía).
  function getProfilesFull() {
    const slots = profiles.slots.map((s, i) => (i === profiles.active ? settings : s));
    return { active: profiles.active, names: profiles.names.slice(), slots };
  }
  // Importa una lista de perfiles { name, settings } en las ranuras 0..N-1. En modo
  // 'replace' cada perfil sustituye al de su ranura; en 'merge' se fusiona encima.
  function importProfiles(list, mode) {
    if (!Array.isArray(list) || !list.length) return;
    clearTimeout(saveTimer);
    profiles.slots[profiles.active] = settings; // guarda el activo antes de tocar nada
    const n = Math.min(list.length, PROFILE_COUNT);
    for (let i = 0; i < n; i++) {
      const entry = list[i] || {};
      const incoming = entry.settings || entry.data;
      if (incoming && typeof incoming === 'object' && !Array.isArray(incoming)) {
        const base = (mode === 'merge' && profiles.slots[i]) ? profiles.slots[i] : structuredClone(DEFAULT_SETTINGS);
        profiles.slots[i] = deepMerge(base, incoming);
      }
      const nm = String(entry.name || '').trim().slice(0, 40);
      if (nm) profiles.names[i] = nm;
    }
    saveProfilesNow();
    settings = loadSettings(); // recarga el perfil activo desde su ranura ya actualizada
    enforceLimits();
    writeJsonAtomic(SETTINGS_FILE, settings);
    broadcast('settings', settings);
    broadcastProfiles();
    clampTimer();
    broadcastTimer();
    if (typeof onUserSave === 'function') { try { onUserSave(settings); } catch {} }
  }
  // Aplica un bloque de ajustes (fusión profunda), persiste y difunde. Si el cambio
  // viene del panel del usuario (fromUser), avisa para sincronizarlo con el remoto.
  function applyIncomingSettings(obj, fromUser) {
    if (!obj) return;
    settings = deepMerge(settings, obj);
    enforceLimits();
    saveSettings();
    broadcast('settings', settings);
    clampTimer();
    broadcastTimer();
    if (fromUser && typeof onUserSave === 'function') {
      try { onUserSave(settings); } catch {}
    }
  }

  /* ------------------------------- Broadcast ------------------------------ */
  function broadcast(type, payload) {
    const msg = JSON.stringify({ type, payload });
    for (const client of clients) {
      if (client.readyState === 1) client.send(msg);
    }
    // El relay (.exe completo) también necesita los datos para mostrarlos en su ventana.
    for (const client of relayClients) {
      if (client.readyState === 1) client.send(msg);
    }
  }
  function broadcastToLocal(type, payload) {
    const msg = JSON.stringify({ type, payload });
    for (const client of localClients) {
      if (client.readyState === 1) client.send(msg);
    }
    // El relay también ejecuta teclas/RCON/juegos en la PC del streamer.
    for (const client of relayClients) {
      if (client.readyState === 1) client.send(msg);
    }
  }
  function broadcastLocalStatus() {
    const online = localClients.size > 0 || relayClients.size > 0;
    broadcast('localClient', { online, count: localClients.size + relayClients.size });
  }
  const actions = createActionBridge({
    getSettings: () => settings,
    broadcast,
    broadcastToLocal,
    isCloud: process.env.DESKTOP !== '1',
  });
  function broadcastScreens() {
    broadcast('screens', { connected: [...new Set(videoScreens.values())] });
  }
  /* --------------------- Contador de meta (gift counter) -------------------- */
  function serializeGiftCounter() {
    const goal = Math.max(1, Number(settings.giftCounter?.goal) || 50);
    return { count: giftCounter.count, goal };
  }
  function broadcastGiftCounter() { broadcast('giftCounter', serializeGiftCounter()); }
  function setGiftCounter(n) {
    giftCounter.count = Math.max(0, Math.floor(Number(n) || 0));
    broadcastGiftCounter();
  }
  function resetGiftCounter() { giftCounter.count = 0; broadcastGiftCounter(); }
  // Suma al contador si el regalo coincide con el configurado (o cualquiera si no hay filtro).
  function countGiftForGoal(giftId, giftName, repeatCount) {
    const c = settings.giftCounter || {};
    const wantId = String(c.giftId || '').trim();
    const wantName = String(c.giftName || '').trim().toLowerCase();
    if (wantId) { if (String(giftId) !== wantId) return; }
    else if (wantName) { if ((giftName || '').toLowerCase() !== wantName) return; }
    // sin filtro => cuenta cualquier regalo
    giftCounter.count += Math.max(1, Number(repeatCount) || 1);
    broadcastGiftCounter();
  }
  // Capacidades del plan (límites + features). El panel las usa para ocultar
  // pestañas/overlays y bloquear el añadir más alertas de las permitidas.
  function currentCaps() {
    try { return getCaps ? getCaps() : null; } catch { return null; }
  }
  function broadcastCaps(caps) {
    broadcast('caps', caps || currentCaps() || {});
  }
  // Recorta los arrays guardados para no exceder los límites del plan. Solo actúa
  // si el límite es un número válido y el array lo supera (caso de degradar plan).
  function enforceLimits() {
    const caps = currentCaps();
    const lim = caps && caps.limits;
    if (!lim) return;
    const cap = (arr, n) => (Array.isArray(arr) && Number.isFinite(n) && arr.length > n ? arr.slice(0, n) : arr);
    settings.soundAlerts = cap(settings.soundAlerts, lim.soundAlerts);
    settings.videos = cap(settings.videos, lim.videos);
    settings.battleAlerts = cap(settings.battleAlerts, lim.battleAlerts);
    settings.actions = cap(settings.actions, lim.actions);
  }
  function screenSize(n) {
    return settings.screens?.[(Number(n) || 1) - 1]?.size ?? 100;
  }

  /* ----------------------------- Temporizador ----------------------------- */
  // El temporizador es AUTORITATIVO en el servidor: aquí corre la cuenta atrás y
  // se difunde cada segundo a todos los overlays/paneles de la room. Así se mantiene
  // sincronizado aunque un overlay se reconecte o el navegador esté en segundo plano.
  function clampTimer() {
    if (timer.remaining < 0) timer.remaining = 0;
    const t = settings.timer || {};
    if (t.maxEnabled && Number(t.maxCapSec) > 0) {
      timer.remaining = Math.min(timer.remaining, Number(t.maxCapSec));
    }
  }
  function serializeTimer() {
    return { remaining: Math.max(0, Math.round(timer.remaining)), running: !!timer.running };
  }
  function broadcastTimer() { broadcast('timer', serializeTimer()); }
  function stopTimerInterval() {
    if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  }
  function addTimerSeconds(delta) {
    const d = Number(delta);
    if (!d || !Number.isFinite(d)) return;
    timer.remaining += d;
    clampTimer();
    broadcastTimer();
  }
  function timerReachZero() {
    stopTimerInterval();
    timer.running = false;
    const act = String(settings.timer?.actionOnFinish || 'pause');
    if (act === 'reset') {
      timer.remaining = Math.max(0, Math.floor(settings.timer?.defaultInitialSec || 0));
      clampTimer();
    } else if (act === 'beep') {
      broadcast('timerBeep', {});
    }
    broadcastTimer();
  }
  function startTimer(seconds) {
    if (seconds != null) { timer.remaining = Math.max(0, Math.floor(Number(seconds))); clampTimer(); }
    if (timer.remaining <= 0) { timer.running = false; broadcastTimer(); return; }
    stopTimerInterval();
    timer.running = true;
    broadcastTimer();
    timerInterval = setInterval(() => {
      timer.remaining -= 1;
      if (timer.remaining <= 0) { timer.remaining = 0; timerReachZero(); return; }
      broadcastTimer();
    }, 1000);
  }
  function pauseTimer() { stopTimerInterval(); timer.running = false; broadcastTimer(); }
  function setTimer(seconds) {
    if (seconds != null) timer.remaining = Math.max(0, Math.floor(Number(seconds)));
    clampTimer();
    broadcastTimer();
  }
  function resetTimer() {
    stopTimerInterval();
    timer.running = false;
    timer.remaining = Math.max(0, Math.floor(settings.timer?.defaultInitialSec || 0));
    clampTimer();
    broadcastTimer();
  }
  // Evita contar dos veces el mismo evento (algunos eventos de TikTok llegan por dos
  // canales: p. ej. SOCIAL y FOLLOW). Coalesce por tipo+usuario en una ventana corta.
  const recentTimerEvents = new Map();
  function timerEventOnce(kind, uid) {
    const key = kind + ':' + (uid || '');
    const now = Date.now();
    const last = recentTimerEvents.get(key) || 0;
    if (now - last < 1500) return false;
    recentTimerEvents.set(key, now);
    if (recentTimerEvents.size > 300) {
      for (const [k, t] of recentTimerEvents) if (now - t > 5000) recentTimerEvents.delete(k);
    }
    return true;
  }

  // Reinicia TODOS los overlays de la sesión EXCEPTO los acumulados semanales/mensuales
  // (top donador semanal). Se usa al pulsar Conectar (manual), al detectar un live
  // NUEVO vía auto-conexión, y al finalizar el live (stream end).
  // NO se reinicia en auto-reconexión al mismo live ni al reconectar overlays WS.
  function resetSessionOverlays() {
    // Botes / contadores acumulados de la sesión
    broadcast('jarronReset', {});
    broadcast('vaquitaReset', {});
    broadcast('marranitoReset', {});
    broadcast('perritoReset', {});
    broadcast('pelotasReset', {});
    broadcast('rouletteReset', {});
    // Versus y secuencias
    broadcast('giftVsReset', {});
    broadcast('giftSeqReset', {});
    // Mejor regalo / mejor racha de la sesión
    broadcast('topGiftReset', {});
    broadcast('topStreakReset', {});
    // Top 1 donador (MVP de la sesión)
    broadcast('top1Reset', {});
    // Contador de meta (gift counter) vuelve a 0
    resetGiftCounter();
    // Batallas de ranking (regalos / likes)
    broadcast('batallaGiftsReset', {});
    broadcast('batallaLikesReset', {});
    broadcast('winsReset', {});
    broadcast('winsGamerReset', {});
    // Barra de meta (hype)
    broadcast('hypeReset', {});
    // Coin match (partido cronometrado)
    broadcast('coinMatchControl', { action: 'reset' });
    // Rankings de likes / diamantes (bandas y listas) de la sesión
    for (const rank of ['toplikes', 'topdiam', 'toplikeslist', 'topdiamlist']) {
      broadcast('rankReset', { rank });
    }
    // Animaciones momentáneas (corta cualquier alerta en curso)
    broadcast('alertaGiftReset', {});
    broadcast('alertaLikesReset', {});
    broadcast('alertaFollowReset', {});
    broadcast('streamJoinReset', {});
    // Temporizador: vuelve al tiempo inicial y en pausa al iniciar/terminar el live.
    resetTimer();
    // OJO: NO se reinicia el top donador semanal (weeklyTop / topDonor): es acumulado semanal.
  }

  /* ------------------------------- Batalla ------------------------------- */
  function handleBattleAction(data) {
    switch (data.op) {
      case 'add':
        if (data.team === 'A') battle.scoreA += Number(data.amount) || 0;
        if (data.team === 'B') battle.scoreB += Number(data.amount) || 0;
        break;
      case 'set':
        if (data.team === 'A') battle.scoreA = Math.max(0, Number(data.amount) || 0);
        if (data.team === 'B') battle.scoreB = Math.max(0, Number(data.amount) || 0);
        break;
      case 'reset':
        battle.scoreA = 0;
        battle.scoreB = 0;
        break;
      case 'receiving':
        settings.battle.receiving = data.value; // 'A' | 'B' | 'off'
        saveSettings();
        broadcast('settings', settings);
        break;
    }
    if (battle.scoreA < 0) battle.scoreA = 0;
    if (battle.scoreB < 0) battle.scoreB = 0;
    broadcast('battle', serializeBattle());
  }
  function serializeBattle() {
    return {
      enabled: settings.battle.enabled,
      teamA: settings.battle.teamA,
      teamB: settings.battle.teamB,
      goal: settings.battle.goal,
      receiving: settings.battle.receiving,
      scoreA: battle.scoreA,
      scoreB: battle.scoreB,
    };
  }

  /* ------------------------- Conexión a TikTok LIVE ------------------------- */
  /* --------------------------- Auto-conexión ---------------------------- */
  // Recuerda el último @usuario y se reconecta solo (reintentando cada cierto tiempo)
  // hasta que el creador inicie su live. Se enciende al conectar manualmente y se apaga
  // al pulsar "Desconectar". Así no hace falta darle a "Conectar" cada vez.
  const AUTO_CONNECT_POLL_MS = 45000;
  let autoConnectTimer = null;
  let lastAutoWaitLog = 0;

  function autoConnectOn() {
    return settings.autoConnect !== false && !!settings.tiktokUser;
  }
  function startAutoConnectLoop() {
    if (autoConnectTimer) return;
    autoConnectTimer = setInterval(() => {
      if (autoConnectOn() && !state.connected && !state.connecting) {
        connectTo(settings.tiktokUser, { auto: true });
      }
    }, AUTO_CONNECT_POLL_MS);
    if (autoConnectTimer.unref) autoConnectTimer.unref();
    // Primer intento rápido al arrancar (por si ya estás en vivo).
    setTimeout(() => {
      if (autoConnectOn() && !state.connected && !state.connecting) {
        connectTo(settings.tiktokUser, { auto: true });
      }
    }, 3000);
  }

  // Guarda el último usuario (y reactiva el auto si fue una conexión manual).
  function rememberTikTokUser(username, manual) {
    let changed = false;
    if (settings.tiktokUser !== username) { settings.tiktokUser = username; changed = true; }
    if (manual && settings.autoConnect === false) { settings.autoConnect = true; changed = true; }
    if (changed) {
      saveSettings();
      if (manual && typeof onUserSave === 'function') { try { onUserSave(settings); } catch {} }
    }
  }

  function connectTo(username, opts = {}) {
    if (!username) return;
    if (state.connecting || (state.connected && state.username === username)) return;

    disconnect();

    rememberTikTokUser(username, !opts.auto);

    state.username = username;
    state.connecting = true;
    if (!opts.auto) {
      // Conectar manual: el usuario pide empezar limpio.
      resetSessionState();
      liveSession = { roomId: null, username: null, active: false, startedAt: null };
      saveLiveSession();
    }
    // Auto-conexión: no resetear aquí; se evalúa al conectar según roomId guardado.
    pushState();
    if (!opts.auto) broadcast('log', { level: 'info', text: `Conectando a @${username}...` });

    connection = new TikTokLiveConnection(username, {
      processInitialData: false,
      fetchRoomInfoOnConnect: true,
      requestPollingIntervalMs: 2000,
    });

    bindEvents(connection);
    tryConnect(connection, username, 1, !!opts.auto);
  }

  function tryConnect(conn, username, attempt, auto) {
    if (conn !== connection) return;
    conn
      .connect()
      .then((connState) => {
        state.connected = true;
        state.connecting = false;
        const newRoomId = connState?.roomId ?? null;
        state.roomId = newRoomId;
        if (auto) {
          const mode = applyAutoLiveConnected(newRoomId, username);
          seedStatsFromRoomInfo();
          pushState();
          if (mode === 'reconnect') {
            broadcast('log', { level: 'ok', text: `Reconectado al live (sala ${newRoomId ?? ''}) — overlays conservados` });
          } else {
            broadcast('log', { level: 'ok', text: `Conectado automáticamente a la sala ${newRoomId ?? ''}` });
          }
        } else {
          liveSession = { roomId: newRoomId, username, active: true, startedAt: Date.now() };
          saveLiveSession();
          state.startedAt = liveSession.startedAt;
          seedStatsFromRoomInfo();
          pushState();
          broadcast('log', { level: 'ok', text: `Conectado a la sala ${newRoomId ?? ''}` });
        }
      })
      .catch((err) => {
        if (conn !== connection) return;
        const msg = err?.message || String(err);
        // En modo manual reintentamos varias veces seguidas (por saturación del servicio).
        if (!auto && attempt < MAX_CONNECT_ATTEMPTS) {
          const delay = attempt * 2500;
          broadcast('log', {
            level: 'info',
            text: `Intento ${attempt} fallido. Reintentando en ${delay / 1000}s... (el servicio gratuito de TikTok a veces está saturado)`,
          });
          setTimeout(() => tryConnect(conn, username, attempt + 1, auto), delay);
          return;
        }
        state.connecting = false;
        state.connected = false;
        pushState();
        if (auto) {
          // Auto-conexión: seguramente aún no estás en vivo. Esperamos en silencio; el bucle
          // lo volverá a intentar y avisamos como mucho cada pocos minutos para no llenar el log.
          const now = Date.now();
          if (now - lastAutoWaitLog > 180000) {
            lastAutoWaitLog = now;
            broadcast('log', { level: 'info', text: `Esperando a que @${username} inicie el live para conectar automáticamente…` });
          }
        } else {
          broadcast('log', {
            level: 'error',
            text: `No se pudo conectar tras ${MAX_CONNECT_ATTEMPTS} intentos: ${msg}. Verifica que @${username} esté EN VIVO y vuelve a intentar en un minuto.`,
          });
        }
      });
  }

  function disconnect() {
    if (connection) {
      try { connection.disconnect(); } catch { /* ignore */ }
      connection = null;
    }
    state.connected = false;
    state.connecting = false;
    state.roomId = null;
  }

  // Desconexión MANUAL (botón "Desconectar"): además de cortar, apaga la auto-conexión
  // para que NO se vuelva a conectar solo hasta que el usuario lo pida de nuevo.
  function disconnectManual() {
    if (settings.autoConnect !== false) {
      settings.autoConnect = false;
      saveSettings();
      if (typeof onUserSave === 'function') { try { onUserSave(settings); } catch {} }
    }
    disconnect();
    pushState();
  }

  startAutoConnectLoop();

  /* ----------------------------- Disparadores ----------------------------- */
  // "Racha = 1": coalesce de disparos del mismo usuario+regalo en una ventana corta.
  // Devuelve true si hay que SALTAR el disparo (porque ya sonó hace muy poco).
  const recentGiftTriggers = new Map(); // "uid:giftId" -> timestamp del último disparo
  const COMBO_WINDOW_MS = 5000;
  function comboShouldSkip(uniqueId, giftId) {
    if (!settings.playback?.comboOnce) return false;
    const key = `${uniqueId || ''}:${giftId || ''}`;
    const now = Date.now();
    const last = recentGiftTriggers.get(key) || 0;
    // Limpieza ligera para que el mapa no crezca sin límite.
    if (recentGiftTriggers.size > 200) {
      for (const [k, t] of recentGiftTriggers) if (now - t > COMBO_WINDOW_MS) recentGiftTriggers.delete(k);
    }
    if (now - last < COMBO_WINDOW_MS) return true;
    recentGiftTriggers.set(key, now);
    return false;
  }

  const giftStreakGameProgress = new Map();
  function giftStreakGameKey(uniqueId, giftId) {
    return `${uniqueId || ''}:${String(giftId || '')}`;
  }
  function triggerGiftGameActions(user, giftId, repeatCount, repeatEnd, giftType, giftInfo) {
    const key = giftStreakGameKey(user.uniqueId, giftId);
    const rep = Math.max(1, Number(repeatCount) || 1);
    const streakGift = giftType === 1;

    if (!streakGift) {
      giftStreakGameProgress.delete(key);
      actions.triggerMinecraftActions('gift', { ...giftInfo, repeatCount: rep }, user);
      return;
    }

    const prev = giftStreakGameProgress.get(key) || 0;
    const delta = Math.max(0, rep - prev);
    if (delta > 0) {
      giftStreakGameProgress.set(key, rep);
      actions.triggerMinecraftActions('gift', { ...giftInfo, repeatCount: delta }, user);
    }
    if (repeatEnd) giftStreakGameProgress.delete(key);
  }

  // Pelotas de fans: acumula la cantidad (monedas o likes) por usuario y, cada
  // vez que se completa el umbral configurado, manda caer una pelota con su foto.
  // El sobrante se guarda para el siguiente evento del mismo usuario.
  function processFanBalls(kind, user, amount) {
    const cfg = settings.pelotas;
    if (!cfg) return;
    const uid = user && user.uniqueId;
    if (!uid || !(amount > 0)) return;
    const enabled = kind === 'coins' ? cfg.coinsEnabled : cfg.likesEnabled;
    if (!enabled) return;
    const every = Math.max(1, Number(kind === 'coins' ? cfg.coinsEvery : cfg.likesEvery) || 1);
    const acc = kind === 'coins' ? fanCoinAcc : fanLikeAcc;
    const carry = (acc.get(uid) || 0) + amount;
    const drops = Math.floor(carry / every);
    acc.set(uid, carry - drops * every);
    if (acc.size > 5000) acc.clear();
    if (drops > 0) {
      const count = Math.min(200, drops);
      broadcast('fanBallDrop', { photo: user.photo || '', nickname: user.nickname || '', count });
      broadcast('log', { level: 'ok', text: `🏀 Pelotas: ${count} de ${user.nickname || uid} (${kind === 'coins' ? 'monedas' : 'likes'} +${amount}, cada ${every})` });
    }
  }

  // ---- Ruleta / sorteo en vivo ----
  // Cada participante tiene un "peso": en modo donación es la suma de diamantes
  // (quien dona más tiene un trozo más grande = más probabilidad). En modo
  // palabra todos pesan igual (1).
  function serializeRoulette() {
    const entries = [...roulette.entries.values()]
      .slice(0, ROULETTE_MAX)
      .map((u) => ({ uniqueId: u.uniqueId, nickname: u.nickname, photo: u.photo, weight: u.weight || 1 }));
    return { collecting: roulette.collecting, count: roulette.entries.size, entries, giftImage: roulette.giftImage || '' };
  }
  function broadcastRoulette() { broadcast('roulette', serializeRoulette()); }
  function addRouletteEntry(user, weight) {
    if (!roulette.collecting) return;
    const uid = user && user.uniqueId;
    if (!uid) return;
    const add = Math.max(0, Number(weight) || 0);
    const existing = roulette.entries.get(uid);
    if (existing) {
      // Mismo usuario que vuelve a participar: acumula su peso (más diamantes).
      existing.weight += add || 1;
      if (user.nickname) existing.nickname = user.nickname;
      if (user.photo) existing.photo = user.photo;
    } else {
      if (roulette.entries.size >= ROULETTE_MAX) return;
      roulette.entries.set(uid, { uniqueId: uid, nickname: user.nickname || uid, photo: user.photo || '', weight: add || 1 });
    }
    broadcastRoulette();
  }
  function rouletteFromGift(user, totalCoins, giftImage) {
    if (!roulette.collecting || settings.roulette?.mode !== 'donors') return;
    const min = Math.max(0, Number(settings.roulette?.minCoins) || 0);
    if (!(totalCoins > 0) || totalCoins < min) return;
    // Guardamos el icono del último regalo recibido para mostrarlo en el centro de la ruleta.
    if (giftImage) roulette.giftImage = giftImage;
    // El peso es la cantidad de diamantes: 5 diamantes pesa 5 veces más que 1.
    addRouletteEntry(user, totalCoins);
    // Anima el regalo entrando al centro de la ruleta.
    if (giftImage) broadcast('rouletteGift', { image: giftImage });
  }
  function rouletteFromChat(user, comment) {
    if (!roulette.collecting || settings.roulette?.mode !== 'keyword') return;
    const kw = String(settings.roulette?.keyword || '').trim().toLowerCase();
    if (!kw) return;
    const text = String(comment || '').trim().toLowerCase();
    // Coincide si el comentario es la palabra o la contiene como palabra suelta.
    if (text === kw || new RegExp('(^|\\s)' + kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|\\s)').test(text)) {
      addRouletteEntry(user, 1); // en modo palabra todos pesan igual
    }
  }
  function rouletteSpin() {
    const list = [...roulette.entries.values()];
    if (!list.length) {
      broadcast('log', { level: 'warn', text: '🎡 Ruleta: no hay participantes.' });
      return;
    }
    // Selección ponderada por peso (diamantes). A más peso, más probabilidad.
    const total = list.reduce((s, u) => s + (u.weight || 1), 0);
    let r = Math.random() * total;
    let winner = list[list.length - 1];
    for (const u of list) { r -= (u.weight || 1); if (r <= 0) { winner = u; break; } }
    roulette.collecting = false;
    broadcast('log', { level: 'ok', text: `🎡 Ruleta: ganador → ${winner.nickname}` });
    broadcast('rouletteSpin', {
      winner: { uniqueId: winner.uniqueId, nickname: winner.nickname, photo: winner.photo },
      entries: list.map((u) => ({ uniqueId: u.uniqueId, nickname: u.nickname, photo: u.photo, weight: u.weight || 1 })),
    });
  }

  function triggerSoundAlerts(eventType, info = {}) {
    for (const a of settings.soundAlerts) {
      if (!a.enabled || !a.sound) continue;
      const trig = a.trigger || 'gift';
      if (trig !== eventType) continue;
      if (eventType === 'gift') {
        const wantName = (a.giftName || '').trim().toLowerCase();
        if (wantName || a.giftId) {
          const idMatch = a.giftId && String(a.giftId) === String(info.giftId || '');
          const nameMatch = wantName && wantName === (info.giftName || '').toLowerCase();
          if (!idMatch && !nameMatch) continue;
          if ((a.minDiamonds || 0) > (info.diamonds || 0)) continue;
        } else {
          const total = info.totalDiamonds || 0;
          if ((a.rangeMin || 0) > total) continue;
          if ((a.rangeMax || 0) > 0 && total > a.rangeMax) continue;
        }
      }
      if (eventType === 'emote') {
        const wantId = (a.emoteId || '').trim();
        if (wantId && wantId !== String(info.emoteId || '')) continue;
      }
      if (eventType === 'like') {
        if ((a.likeMin || 1) > (info.likeCount || 0)) continue;
      }
      if (eventType === 'levelUp') {
        const wantLevel = Math.max(0, Number(a.level) || 0);
        if (wantLevel > 0 && wantLevel !== Number(info.level || 0)) continue;
      }
      if (eventType === 'chatCommand') {
        if (!matchesCommand(a.command, info.comment)) continue;
      }
      broadcast('log', { level: 'ok', text: `🔊 Alerta sonora: "${a.name}"` });
      broadcast('sound', { id: a.id, name: a.name, sound: a.sound, image: a.image, volume: a.volume });
    }
  }

  function triggerLikeGlobal(total) {
    if (!total || total <= lastTotalLikes) { lastTotalLikes = total || lastTotalLikes; return; }
    for (const a of settings.soundAlerts) {
      if (!a.enabled || !a.sound || (a.trigger || '') !== 'likeGlobal') continue;
      const goal = Math.max(1, a.likeGoal || 100);
      const before = Math.floor(lastTotalLikes / goal);
      const now = Math.floor(total / goal);
      if (now > before) {
        broadcast('sound', { id: a.id, name: a.name, sound: a.sound, image: a.image, volume: a.volume });
      }
    }
    if (settings.videosEnabled !== false) {
      for (const v of settings.videos) {
        if (!v.url || v.enabled === false || (v.trigger || '') !== 'likeGlobal') continue;
        const goal = Math.max(1, v.likeGoal || 100);
        if (Math.floor(total / goal) > Math.floor(lastTotalLikes / goal)) {
          const scr = Number(v.screen) || 1;
          broadcast('media', { id: v.id, name: v.name, url: v.url, screen: scr, volume: v.volume ?? 100, size: screenSize(scr) });
        }
      }
    }
    actions.triggerLikeGlobalExtras(total, lastTotalLikes);
    lastTotalLikes = total;
  }

  function triggerVideos(eventType, info = {}) {
    if (settings.videosEnabled === false) return;
    for (const v of settings.videos) {
      if (!v.url || v.enabled === false) continue;
      const trig = v.trigger || 'gift';
      if (trig !== eventType) continue;
      if (eventType === 'gift') {
        const wantName = (v.giftName || '').trim().toLowerCase();
        if (wantName || v.giftId) {
          const idMatch = v.giftId && String(v.giftId) === String(info.giftId || '');
          const nameMatch = wantName && wantName === (info.giftName || '').toLowerCase();
          if (!idMatch && !nameMatch) continue;
          if ((v.minDiamonds || 0) > (info.diamonds || 0)) continue;
        } else {
          const total = info.totalDiamonds || 0;
          if ((v.rangeMin || 0) > total) continue;
          if ((v.rangeMax || 0) > 0 && total > v.rangeMax) continue;
        }
      }
      if (eventType === 'emote') {
        const wantId = (v.emoteId || '').trim();
        if (wantId && wantId !== String(info.emoteId || '')) continue;
      }
      if (eventType === 'like') {
        if ((v.likeMin || 1) > (info.likeCount || 0)) continue;
      }
      // Subió de nivel de miembro: si se indica un nivel, solo se reproduce al
      // alcanzar EXACTAMENTE ese nivel (ej. nivel 5 → video de nivel 5). 0 = cualquiera.
      if (eventType === 'levelUp') {
        const wantLevel = Math.max(0, Number(v.level) || 0);
        if (wantLevel > 0 && wantLevel !== Number(info.level || 0)) continue;
      }
      if (eventType === 'chatCommand') {
        if (!matchesCommand(v.command, info.comment)) continue;
      }
      // Filtro por usuario para comandos de chat, primer mensaje y entrada de usuario.
      // En "userJoin" el usuario es OBLIGATORIO (si no, se reproduciría con cada
      // espectador que entra); en los demás casos es opcional.
      if (eventType === 'chatCommand' || eventType === 'firstMessage' || eventType === 'userJoin') {
        const want = String(v.user || '').replace(/^@/, '').trim().toLowerCase();
        if (eventType === 'userJoin' && !want) continue;
        if (want) {
          const u = String(info.username || '').toLowerCase();
          const n = String(info.nickname || '').toLowerCase();
          if (want !== u && want !== n) continue;
        }
      }
      // Anti-spam para "entró un usuario": espera N segundos antes de repetir el
      // mismo video (evita que entrando y saliendo lo disparen sin parar).
      if (eventType === 'userJoin') {
        const delaySec = (v.joinDelay == null) ? 30 : Math.max(0, Number(v.joinDelay) || 0);
        if (delaySec > 0) {
          const now = Date.now();
          const last = joinVideoCooldown.get(v.id) || 0;
          if (now - last < delaySec * 1000) continue;
          joinVideoCooldown.set(v.id, now);
        }
      }
      const scr = Number(v.screen) || 1;
      broadcast('media', { id: v.id, name: v.name, url: v.url, screen: scr, volume: v.volume ?? 100, size: screenSize(scr) });
    }
  }

  function emitMemberLevelUp(data, fromLevel, toLevel) {
    const user = baseUser(data?.user || data);
    const uid = user.uniqueId;
    if (!uid || toLevel <= fromLevel) return;
    broadcast('log', { level: 'ok', text: `⬆️ ${user.nickname} subió a nivel de miembro ${toLevel} (antes ${fromLevel})` });
    for (let lvl = fromLevel + 1; lvl <= toLevel; lvl++) {
      const info = { username: uid, nickname: user.nickname, level: lvl, fromLevel: lvl - 1, toLevel: lvl };
      triggerVideos('levelUp', info);
      triggerSoundAlerts('levelUp', info);
      actions.triggerActions('levelUp', info);
      actions.triggerMinecraftActions('levelUp', info, user);
      playLevelVideo(lvl);
    }
  }

  // Detecta cuándo un usuario SUBE su nivel de miembro (insignia junto al nombre).
  // TikTok no envía un evento propio, así que recordamos el último nivel visto de
  // cada usuario (al chatear, regalar o entrar) y, si en una interacción posterior
  // su nivel es mayor, disparamos el evento 'levelUp'. Solo se detecta dentro de la
  // sesión: necesitamos haber visto su nivel anterior al menos una vez.
  function checkMemberLevelUp(data) {
    const user = baseUser(data?.user || data);
    const uid = user.uniqueId;
    if (!uid) return;
    const level = Number(chatUserRoles(data).memberLevel || 0);
    if (!level) return; // sin insignia de nivel: nada que comparar
    const prev = memberLevels.get(uid);
    memberLevels.set(uid, level);
    if (prev == null || level <= prev) return; // primera vez o no subió
    emitMemberLevelUp(data, prev, level);
  }

  // Reproduce automáticamente el video de la carpeta «niveles» que coincida con el
  // nivel alcanzado (nivel5.mp4 → al subir al 5). Independiente de las alertas manuales.
  function playLevelVideo(level) {
    const cfg = settings.levelVideos || {};
    if (cfg.enabled === false) return;
    if (typeof getLevelVideo !== 'function') return;
    const url = getLevelVideo(level);
    if (!url) return;
    const scr = Number(cfg.screen) || 1;
    broadcast('log', { level: 'ok', text: `🎬 Video de nivel ${level} reproducido.` });
    broadcast('media', { id: 'level_' + level, name: `Nivel ${level}`, url, screen: scr, volume: cfg.volume ?? 100, size: screenSize(scr) });
  }

  // Animaciones de batalla PK: 'critical' (x2), 'critical3' (x3), 'battleGift',
  // 'battleGiftAny', 'battleStart', 'battleEnd'.
  function fireBattleAlerts(actionType, info = {}) {
    if (settings.battleAlertsEnabled === false) return;
    for (const b of (settings.battleAlerts || [])) {
      if (!b.url || b.enabled === false) continue;
      const trig = b.trigger || ((b.giftName || b.giftId) ? 'battleGift' : 'battleGiftAny');
      if (trig !== actionType) continue;
      if (actionType === 'battleGift') {
        const wantName = (b.giftName || '').trim().toLowerCase();
        const idMatch = b.giftId && String(b.giftId) === String(info.giftId || '');
        const nameMatch = wantName && wantName === (info.giftName || '').toLowerCase();
        if (!idMatch && !nameMatch) continue;
      }
      if (actionType === 'battleGift' || actionType === 'battleGiftAny') {
        const count = info.repeatCount || info.giftCount || 1;
        if ((b.minCount || 1) > count) continue;
      }
      const scr = Number(b.screen) || 1;
      broadcast('log', { level: 'ok', text: `⚔️ Animación de batalla [${actionType}]: "${b.name}"` });
      broadcast('media', { id: b.id, name: b.name, url: b.url, screen: scr, volume: b.volume ?? 100, size: screenSize(scr) });
    }
  }

  // Comandos personalizados del chat: si el comentario coincide con un comando
  // configurado (ej. !idwarzone), el bot responde por voz (TTS) y muestra la respuesta.
  // Cooldown por comando para que una racha de mensajes no spamee la respuesta.
  const commandCooldown = new Map(); // comando -> timestamp último disparo
  function handleChatCommands(comment, user) {
    const cmds = settings.tts?.commands;
    if (!Array.isArray(cmds) || !cmds.length) return;
    for (const c of cmds) {
      if (!c || c.enabled === false) continue;
      if (!c.command || !c.response) continue;
      if (!matchesCommand(c.command, comment)) continue;
      const key = String(c.command).toLowerCase();
      const now = Date.now();
      if (now - (commandCooldown.get(key) || 0) < 4000) return; // 4s anti-spam
      commandCooldown.set(key, now);
      const text = String(c.response).replace(/\{user\}/gi, user?.nickname || user?.uniqueId || '');
      // Mensaje de bot: el panel lo muestra en el chat y lo lee en voz alta.
      broadcast('botReply', { command: c.command, text });
      broadcast('log', { level: 'ok', text: `🤖 Comando ${c.command} → ${text}` });
      return; // solo un comando por mensaje
    }
  }

  function noteCritical(value = 0, src = '') {
    if (settings.battleAlertsEnabled === false) return;
    const v = Math.round(Number(value) || 0);
    if (v > state.pendingMult) state.pendingMult = v;
    if (src) state.pendingSrc = src;
    if (state.criticalTimer) return;
    state.criticalTimer = setTimeout(() => {
      state.criticalTimer = null;
      const m = state.pendingMult >= 2 ? state.pendingMult : 2; // crítico sin valor => x2
      const src2 = state.pendingSrc;
      state.pendingMult = 0;
      state.pendingSrc = '';
      broadcast('log', { level: 'ok', text: `⚡ Golpe crítico (x${m}) en la batalla → animación${src2 ? ' [' + src2 + ']' : ''}` });
      if (m >= 3) fireBattleAlerts('critical3', { multiplier: m });
      else fireBattleAlerts('critical', { multiplier: m });
    }, 600);
  }

  /* ------------------------------- Estado ------------------------------- */
  function topGifters(limit = 10) {
    return [...state.gifters.values()].sort((a, b) => b.diamonds - a.diamonds).slice(0, limit);
  }
  function serializeState() {
    return {
      username: state.username || settings.tiktokUser || null,
      connected: state.connected,
      connecting: state.connecting,
      autoConnect: settings.autoConnect !== false,
      roomId: state.roomId,
      startedAt: state.startedAt,
      stats: state.stats,
      topGifters: topGifters(),
    };
  }
  function pushState() {
    broadcast('state', serializeState());
  }

  // Al conectar, TikTok entrega la info de la sala con totales ACUMULADOS desde que
  // empezó el live: likes totales, espectadores actuales y total de entradas. Los
  // sembramos para no empezar en 0 aunque te conectes al panel a mitad del live.
  // NOTA: TikTok NO expone el histórico de diamantes/regalos/comentarios/follows/
  // shares; esos solo llegan como eventos en vivo, así que solo se cuentan desde
  // que el panel está conectado (no hay forma de recuperarlos hacia atrás).
  function seedStatsFromRoomInfo() {
    try {
      const ri = connection && connection.roomInfo;
      if (!ri) return;
      const d = ri.data || ri;
      const st = d.stats || {};
      const likes = Number(d.like_count ?? st.like_count ?? 0) || 0;
      const viewers = Number(d.user_count ?? st.user_count ?? d.viewerCount ?? 0) || 0;
      const entradas = Number(st.total_user ?? d.total_user ?? 0) || 0;
      if (likes > state.stats.likes) { state.stats.likes = likes; lastTotalLikes = Math.max(lastTotalLikes, likes); }
      if (viewers > 0) state.stats.viewers = viewers;
      if (entradas > state.stats.joins) state.stats.joins = entradas;
      pushState();
    } catch { /* roomInfo opcional: si falla, seguimos contando desde 0 */ }
  }
  function resetStats() {
    state.stats = { viewers: 0, likes: 0, diamonds: 0, comments: 0, gifts: 0, follows: 0, shares: 0, joins: 0 };
    state.gifters.clear();
    chatSeenUsers.clear();
    emoteCatalog.clear();
    fanCoinAcc.clear();
    fanLikeAcc.clear();
    recentSubs.clear();
    recentSuperFans.clear();
    roulette.entries.clear();
    roulette.collecting = false;
    roulette.giftImage = '';
  }
  let statsThrottle = false;
  function pushStatsThrottled() {
    if (statsThrottle) return;
    statsThrottle = true;
    statsTimer = setTimeout(() => { statsThrottle = false; pushState(); }, 500);
  }

  /* ------------------------- Top donador semanal ------------------------- */
  function loadWeekly() {
    const [start, end] = currentWeekRange();
    const r = readJsonSafe(WEEKLY_FILE);
    const raw = r.data;
    if (raw && raw.start === start) {
      weekly.start = start; weekly.end = end;
      weekly.donors = new Map((raw.donors || []).map((u) => [u.uniqueId, u]));
      return;
    }
    weekly.start = start; weekly.end = end; weekly.donors = new Map();
  }
  function saveWeekly() {
    clearTimeout(weeklySaveTimer);
    weeklySaveTimer = setTimeout(() => {
      const data = { start: weekly.start, end: weekly.end, donors: [...weekly.donors.values()] };
      writeJsonAtomic(WEEKLY_FILE, data);
    }, 400);
  }
  function ensureWeek() {
    const [start, end] = currentWeekRange();
    if (start !== weekly.start) {
      weekly.start = start; weekly.end = end; weekly.donors.clear();
      saveWeekly();
      broadcastWeeklyTop();
    }
  }
  function addWeeklyDonation(user, coins) {
    if (!user?.uniqueId || !(coins > 0)) return;
    ensureWeek();
    const u = weekly.donors.get(user.uniqueId) || { uniqueId: user.uniqueId, nickname: user.nickname, photo: user.photo, coins: 0 };
    u.coins += coins;
    u.nickname = user.nickname || u.nickname;
    if (user.photo) u.photo = user.photo;
    weekly.donors.set(user.uniqueId, u);
    saveWeekly();
    broadcastWeeklyTop();
  }
  function serializeWeeklyTop() {
    ensureWeek();
    const entries = [...weekly.donors.values()]
      .sort((a, b) => b.coins - a.coins)
      .slice(0, 3)
      .map((u) => ({ uniqueId: u.uniqueId, nickname: u.nickname, profilePictureUrl: u.photo, coins: u.coins }));
    return { top: entries[0] || null, entries, weekStart: weekly.start, weekEnd: weekly.end, now: Date.now() };
  }
  function broadcastWeeklyTop() {
    broadcast('weeklyTop', serializeWeeklyTop());
  }

  /* ------------------------- Usuario y Puntos ------------------------- */
  // El nivel se alcanza con una curva triangular: el nivel L se logra al acumular
  // STEP * L*(L-1)/2 puntos (cada nivel cuesta un poco más que el anterior).
  const POINTS_LEVEL_STEP = 7;
  function levelForPoints(p) {
    if (!(p > 0)) return 1;
    return Math.floor((Math.sqrt((8 * p) / POINTS_LEVEL_STEP + 1) - 1) / 2) + 1;
  }
  function pointsToReachLevel(level) {
    const L = Math.max(1, level);
    return Math.round((POINTS_LEVEL_STEP * L * (L - 1)) / 2);
  }

  let pointsSaveTimer = null;
  function loadPoints() {
    const r = readJsonSafe(POINTS_FILE);
    const raw = r.data;
    if (raw && Array.isArray(raw.users)) {
      for (const u of raw.users) {
        if (!u || !u.uniqueId) continue;
        points.set(u.uniqueId, {
          uniqueId: u.uniqueId,
          nickname: u.nickname || u.uniqueId,
          photo: u.photo || '',
          total: Math.max(0, Number(u.total) || 0),
          levelPoints: Math.max(0, Number(u.levelPoints != null ? u.levelPoints : u.total) || 0),
          firstAt: Number(u.firstAt) || Date.now(),
          lastAt: Number(u.lastAt) || Date.now(),
        });
      }
    }
    if (raw && Array.isArray(raw.tx)) pointsTx = raw.tx.slice(0, POINTS_MAX_TX);
  }
  function savePoints() {
    clearTimeout(pointsSaveTimer);
    pointsSaveTimer = setTimeout(() => {
      const data = { users: [...points.values()], tx: pointsTx.slice(0, POINTS_MAX_TX) };
      writeJsonAtomic(POINTS_FILE, data);
    }, 500);
  }

  function serializePointUser(u) {
    const level = levelForPoints(u.levelPoints);
    return {
      uniqueId: u.uniqueId, nickname: u.nickname, photo: u.photo,
      total: u.total, levelPoints: u.levelPoints, level,
      levelBase: pointsToReachLevel(level), nextLevel: pointsToReachLevel(level + 1),
      firstAt: u.firstAt, lastAt: u.lastAt,
    };
  }
  function serializePoints() {
    const users = [...points.values()]
      .sort((a, b) => b.total - a.total)
      .map(serializePointUser);
    return { users, count: users.length, max: POINTS_MAX_USERS, tx: pointsTx.slice(0, POINTS_MAX_TX) };
  }
  function pushPointUser(u) {
    broadcast('pointsUpdate', { user: serializePointUser(u), count: points.size });
  }

  // Si superamos el tope de usuarios, quitamos al de actividad más antigua.
  function enforcePointsCap() {
    while (points.size > POINTS_MAX_USERS) {
      let oldestKey = null; let oldestAt = Infinity;
      for (const [k, v] of points) { if (v.lastAt < oldestAt) { oldestAt = v.lastAt; oldestKey = k; } }
      if (oldestKey == null) break;
      points.delete(oldestKey);
    }
  }

  function logPointsTx(entry) {
    const tx = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      uniqueId: entry.uniqueId, nickname: entry.nickname,
      points: entry.points, description: entry.description || '',
      counted: entry.counted !== false, manual: !!entry.manual, at: Date.now(),
    };
    pointsTx.unshift(tx);
    if (pointsTx.length > POINTS_MAX_TX) pointsTx.length = POINTS_MAX_TX;
    broadcast('pointsTx', { tx });
    return tx;
  }

  // Añade (o resta) puntos a un usuario. counted=true => también cuentan para el nivel.
  function addUserPoints({ uniqueId, nickname, photo, amount, counted = true, description = '', manual = false }) {
    const key = String(uniqueId || '').trim().replace(/^@/, '').toLowerCase();
    if (!key || !Number.isFinite(amount) || amount === 0) return null;
    const now = Date.now();
    const u = points.get(key) || { uniqueId: key, nickname: nickname || key, photo: photo || '', total: 0, levelPoints: 0, firstAt: now, lastAt: now };
    u.total = Math.max(0, u.total + amount);
    if (counted) u.levelPoints = Math.max(0, u.levelPoints + amount);
    if (nickname) u.nickname = nickname;
    if (photo) u.photo = photo;
    u.lastAt = now;
    points.set(key, u);
    enforcePointsCap();
    logPointsTx({ uniqueId: key, nickname: u.nickname, points: amount, description, counted, manual });
    savePoints();
    pushPointUser(u);
    return u;
  }

  // Cobro de puntos para Spotify en modo relay (.exe): el .exe procesa el comando
  // localmente (tiene los tokens), pero los puntos viven aquí (fuente de verdad).
  // Comprobamos saldo y, si alcanza, descontamos. Devuelve { ok, balance }.
  function spotifyCharge({ uniqueId, nickname, photo, cost, desc } = {}) {
    const c = Math.max(0, parseInt(cost, 10) || 0);
    if (c <= 0) return { ok: true, balance: null };
    const key = String(uniqueId || '').trim().replace(/^@/, '').toLowerCase();
    const bal = points.get(key)?.total || 0;
    if (bal < c) return { ok: false, balance: bal };
    addUserPoints({ uniqueId, nickname, photo, amount: -c, counted: false, description: desc || 'Spotify' });
    return { ok: true, balance: bal - c };
  }

  function resetAllPoints() {
    points.clear();
    pointsTx = [];
    savePoints();
    broadcast('pointsList', serializePoints());
  }
  function resetOnePoints(uniqueId) {
    const key = String(uniqueId || '').trim().replace(/^@/, '').toLowerCase();
    if (points.delete(key)) { savePoints(); broadcast('pointsList', serializePoints()); }
  }

  /* ------------------------------- Emotes ------------------------------- */
  function rememberEmote(emoteId, image) {
    const eid = String(emoteId || '').trim();
    if (!eid) return;
    const url = emoteImageUrl(image);
    const prev = emoteCatalog.get(eid);
    if (!prev || (!prev.image && url)) {
      emoteCatalog.set(eid, { id: eid, image: url });
      broadcast('emoteCatalog', { results: [...emoteCatalog.values()] });
    }
  }

  // TikTok envía stickers en varios formatos según el conector / tipo de mensaje:
  // emoteList (EMOTE), emotes[].emote (CHAT protobuf) o emotes[].emoteId (legacy).
  function extractEmotes(data) {
    const out = [];
    const seen = new Set();
    const add = (emoteId, image) => {
      const eid = String(emoteId || '').trim();
      if (!eid || seen.has(eid)) return;
      seen.add(eid);
      out.push({ emoteId: eid, image: image || null });
    };
    if (Array.isArray(data?.emoteList)) {
      for (const e of data.emoteList) add(e?.emoteId, e?.image);
    }
    if (Array.isArray(data?.emotes)) {
      for (const se of data.emotes) {
        if (se?.emoteId) add(se.emoteId, se.emoteImageUrl || se.image);
        else if (se?.emote) add(se.emote.emoteId, se.emote.image);
      }
    }
    if (!out.length) add(data?.emoteId, data?.image);
    return out;
  }

  function fireEmoteTriggers(data) {
    const list = extractEmotes(data);
    if (!list.length) return;
    for (const e of list) rememberEmote(e.emoteId, e.image);
    for (const e of list) {
      const info = { emoteId: e.emoteId };
      triggerSoundAlerts('emote', info);
      triggerVideos('emote', info);
      actions.triggerActions('emote', info);
    }
  }

  /* --------------------------- Eventos del live --------------------------- */
  function bindEvents(conn) {
    conn.on(ControlEvent.DISCONNECTED, () => {
      state.connected = false;
      pushState();
      broadcast('log', { level: 'info', text: 'Desconectado del live.' });
    });

    conn.on(ControlEvent.ERROR, (e) => {
      broadcast('log', { level: 'error', text: `Error: ${e?.info || e?.exception?.message || e}` });
    });

    conn.on(WebcastEvent.CHAT, (data) => {
      state.stats.comments++;
      const comment = data.comment || '';
      broadcast('chat', { ...baseUser(data.user || data), comment, ...chatUserRoles(data) });
      pushStatsThrottled();
      checkMemberLevelUp(data);
      const chatUser = baseUser(data.user || data);
      fireEmoteTriggers(data);
      const chatInfo = { comment, username: chatUser.uniqueId, nickname: chatUser.nickname };
      triggerVideos('chatCommand', chatInfo);
      triggerSoundAlerts('chatCommand', chatInfo);
      handleChatCommands(comment, chatUser);
      rouletteFromChat(chatUser, comment);
      actions.triggerMinecraftActions('chat', chatInfo, chatUser);
      if (settings.timer?.chat) addTimerSeconds(settings.timer.chat);
      const uid = data.user?.uniqueId || data.user?.userId;
      if (uid && !chatSeenUsers.has(uid)) {
        chatSeenUsers.add(uid);
        triggerVideos('firstMessage', chatInfo);
        triggerSoundAlerts('firstMessage', chatInfo);
        actions.triggerMinecraftActions('firstMessage', chatInfo, chatUser);
      }
    });

    conn.on(WebcastEvent.GIFT, (data) => {
      const user = baseUser(data.user);
      const giftType = data.giftDetails?.giftType;
      const giftId = data.giftId ?? data.giftDetails?.id ?? '';
      const cat = giftsById.get(String(giftId));
      const diamondsEach = data.giftDetails?.diamondCount || cat?.diamonds || 0;
      const giftName = data.giftDetails?.giftName || cat?.name || 'Regalo';
      const repeatCount = data.repeatCount || 1;
      const image = getGiftImage(data) || cat?.image || null;
      const giftInfo = { giftName, giftId, diamonds: diamondsEach, totalDiamonds: diamondsEach * repeatCount, repeatCount };

      const isStreak = giftType === 1 && !data.repeatEnd;
      if (!isStreak) {
        const total = diamondsEach * repeatCount;
        state.stats.gifts++;
        state.stats.diamonds += total;

        if (user.uniqueId) {
          const g = state.gifters.get(user.uniqueId) || { ...user, diamonds: 0 };
          g.diamonds += total;
          g.nickname = user.nickname;
          g.photo = user.photo || g.photo;
          state.gifters.set(user.uniqueId, g);
        }
        addWeeklyDonation(user, total);
        // Usuario y Puntos: acumula los puntos donados de por vida (configurable: puntos por moneda).
        if (user.uniqueId && total > 0) {
          const perCoin = Number(settings.points?.perCoin);
          const award = Math.round(total * (Number.isFinite(perCoin) && perCoin > 0 ? perCoin : 1));
          if (award > 0) addUserPoints({ uniqueId: user.uniqueId, nickname: user.nickname, photo: user.photo, amount: award, counted: true, description: `Regalo: ${giftName}`, manual: false });
        }
        pushState();

        if (settings.battle.enabled && total > 0) {
          if (settings.battle.receiving === 'A') battle.scoreA += total;
          else if (settings.battle.receiving === 'B') battle.scoreB += total;
          if (settings.battle.receiving !== 'off') broadcast('battle', serializeBattle());
        }

        addTimerSeconds(total * (settings.timer?.giftMult || 0));

        broadcast('log', { level: 'info', text: `🎁 Regalo: ${giftName} (id ${giftId}) ×${repeatCount} · 💎${diamondsEach}` });
        if (!comboShouldSkip(user.uniqueId, giftId)) {
          triggerVideos('gift', { ...giftInfo, giftName: giftName.toLowerCase() });
          triggerSoundAlerts('gift', giftInfo);
        }
        countGiftForGoal(giftId, giftName, repeatCount);
        processFanBalls('coins', user, total);
        rouletteFromGift(user, total, image);
        actions.triggerActions('gift', giftInfo);
      }

      triggerGiftGameActions(user, giftId, repeatCount, !!data.repeatEnd, giftType, giftInfo);

      broadcast('gift', { ...user, giftName, giftId, repeatCount, diamonds: diamondsEach, image, streak: isStreak });
      checkMemberLevelUp(data);
    });

    conn.on(WebcastEvent.LIKE, (data) => {
      state.stats.likes = data.totalLikeCount ?? state.stats.likes + (data.likeCount || 0);
      addTimerSeconds(((data.likeCount || 0) / 100) * (settings.timer?.like || 0));
      processFanBalls('likes', baseUser(data.user), data.likeCount || 0);
      broadcast('like', { ...baseUser(data.user), count: data.likeCount || 0, total: state.stats.likes });
      actions.triggerActions('like', { likeCount: data.likeCount || 0 });
      actions.triggerMinecraftActions('like', { likeCount: data.likeCount || 0 }, baseUser(data.user));
      if (Date.now() - lastLikeSound > 3000) {
        lastLikeSound = Date.now();
        triggerSoundAlerts('like', { likeCount: data.likeCount || 0 });
        triggerVideos('like', { likeCount: data.likeCount || 0 });
      }
      if (typeof data.totalLikeCount === 'number') triggerLikeGlobal(data.totalLikeCount);
      pushStatsThrottled();
    });

    conn.on(WebcastEvent.MEMBER, (data) => {
      state.stats.joins++;
      if (data.memberCount) state.stats.viewers = data.memberCount;
      const member = baseUser(data.user);
      broadcast('member', member);
      checkMemberLevelUp(data);
      // Video al entrar un usuario específico (el anti-spam por tiempo se aplica en
      // triggerVideos, con el delay configurado en cada video).
      if (member.uniqueId) {
        triggerVideos('userJoin', { username: member.uniqueId, nickname: member.nickname });
      }
      pushStatsThrottled();
    });

    conn.on(WebcastEvent.ROOM_USER, (data) => {
      if (typeof data.viewerCount === 'number') {
        state.stats.viewers = data.viewerCount;
        pushStatsThrottled();
      }
    });

    conn.on(WebcastEvent.SOCIAL, (data) => {
      const user = baseUser(data.user);
      const action = (data.action || '').toLowerCase();
      if (action.includes('follow')) {
        state.stats.follows++;
        broadcast('follow', user);
        triggerVideos('follow');
        triggerSoundAlerts('follow');
        actions.triggerActions('follow');
        actions.triggerMinecraftActions('follow', {}, user);
        if (timerEventOnce('follow', user.uniqueId)) addTimerSeconds(settings.timer?.follow || 0);
      } else if (action.includes('share')) {
        state.stats.shares++;
        broadcast('share', user);
        triggerVideos('share');
        triggerSoundAlerts('share');
        actions.triggerActions('share');
        actions.triggerMinecraftActions('share', {}, user);
        if (timerEventOnce('share', user.uniqueId)) addTimerSeconds(settings.timer?.share || 0);
      }
      pushStatsThrottled();
    });

    conn.on(WebcastEvent.FOLLOW, (data) => {
      const user = baseUser(data.user);
      state.stats.follows++;
      broadcast('follow', user);
      triggerSoundAlerts('follow');
      actions.triggerActions('follow');
      actions.triggerMinecraftActions('follow', {}, user);
      if (timerEventOnce('follow', user.uniqueId)) addTimerSeconds(settings.timer?.follow || 0);
      pushStatsThrottled();
    });

    conn.on(WebcastEvent.SHARE, (data) => {
      const user = baseUser(data.user);
      state.stats.shares++;
      broadcast('share', user);
      triggerSoundAlerts('share');
      actions.triggerActions('share');
      actions.triggerMinecraftActions('share', {}, user);
      if (timerEventOnce('share', user.uniqueId)) addTimerSeconds(settings.timer?.share || 0);
      pushStatsThrottled();
    });

    conn.on(WebcastEvent.EMOTE, (data) => {
      fireEmoteTriggers(data);
    });

    // ===== Suscripciones (con nivel / meses) =====
    function handleSubscribe(data) {
      const user = baseUser(data?.user || data);
      const months = Number(data?.subMonth ?? data?.totalSubMonth ?? data?.months ?? data?.cumulativeMonths ?? 0) || 0;
      const level = Number(data?.subscribeLevel ?? data?.level ?? 0) || 0;
      const uid = user.uniqueId || 'anon';
      const now = Date.now();
      if (now - (recentSubs.get(uid) || 0) < 4000) return; // evita doble disparo (subscribe + subNotify)
      recentSubs.set(uid, now);
      if (recentSubs.size > 500) recentSubs.clear();
      const monthsTxt = months > 0 ? ` · ${months} ${months === 1 ? 'mes' : 'meses'}` : '';
      broadcast('log', { level: 'ok', text: `⭐ Suscriptor: ${user.nickname}${monthsTxt}${level ? ` · nivel ${level}` : ''}` });
      const info = { ...user, months, level };
      broadcast('subscribe', info);
      triggerSoundAlerts('subscribe', info);
      triggerVideos('subscribe', info);
      actions.triggerActions('subscribe', info);
      actions.triggerMinecraftActions('subscribe', info, user);
      addTimerSeconds(settings.timer?.subscribe || 0);
      const subBonus = Math.round(Number(settings.points?.subBonus) || 0);
      if (user.uniqueId && subBonus > 0) {
        addUserPoints({ uniqueId: user.uniqueId, nickname: user.nickname, photo: user.photo, amount: subBonus, counted: true, description: months > 0 ? `Suscripción (${months} m)` : 'Suscripción', manual: false });
      }
    }
    conn.on('subscribe', handleSubscribe);
    conn.on(WebcastEvent.SUB_NOTIFY, handleSubscribe);

    // ===== Super fans =====
    function handleSuperFan(data) {
      const user = baseUser(data?.user || data);
      const level = Number(data?.superFanLevel ?? data?.fanLevel ?? data?.level ?? 0) || 0;
      const uid = user.uniqueId || 'anon';
      const now = Date.now();
      if (now - (recentSuperFans.get(uid) || 0) < 5000) return; // dedupe superFan + superFanJoin
      recentSuperFans.set(uid, now);
      if (recentSuperFans.size > 500) recentSuperFans.clear();
      broadcast('log', { level: 'ok', text: `🌟 Super fan: ${user.nickname}${level ? ` · nivel ${level}` : ''}` });
      const info = { ...user, level };
      broadcast('superfan', info);
      triggerSoundAlerts('superFan', info);
      triggerVideos('superFan', info);
      actions.triggerActions('superFan', info);
      actions.triggerMinecraftActions('superFan', info, user);
      // Pelota dorada con la foto del super fan (overlay de pelotas).
      broadcast('goldenBall', { photo: user.photo || '', nickname: user.nickname || '', count: 1 });
      const bonus = Math.round(Number(settings.points?.superFanBonus) || 0);
      if (user.uniqueId && bonus > 0) {
        addUserPoints({ uniqueId: user.uniqueId, nickname: user.nickname, photo: user.photo, amount: bonus, counted: true, description: 'Super fan', manual: false });
      }
    }
    conn.on(WebcastEvent.SUPER_FAN, handleSuperFan);
    conn.on(WebcastEvent.SUPER_FAN_JOIN, handleSuperFan);

    // ===== Batallas PK de TikTok =====
    // Catch-all: escanea todos los mensajes en busca del golpe crítico (x2/x3).
    conn.on(ControlEvent.DECODED_DATA, (type, decoded) => {
      try {
        const t = String(type || '');
        if (!/gift|linkmic|battle/i.test(t)) return;
        const isBattleMsg = /linkmic|battle/i.test(t);
        if (!isBattleMsg && !state.inBattle) return;
        const data = decoded?.data ?? decoded;
        if (!data || typeof data !== 'object') return;
        const acc = { crit: false, value: 0, hits: [] };
        scanMultiplier(data, 0, acc);
        if (acc.crit || acc.value >= 2) {
          state.inBattle = true;
          const src = `${t.replace(/^Webcast/, '')}${acc.hits.length ? ' ' + acc.hits.join(' ') : ''}`;
          noteCritical(acc.value, src);
        }
      } catch {}
    });

    conn.on(WebcastEvent.LINK_MIC_BATTLE, (data) => {
      try {
        const a = data?.action;
        const isStart = a === 4 || a === 'BATTLE_ACTION_OPEN';
        const isEnd = a === 5 || a === 6 || a === 'BATTLE_ACTION_FINISH' || a === 'BATTLE_ACTION_CUT_SHORT';
        if (isStart) {
          state.inBattle = true;
          broadcast('log', { level: 'ok', text: '⚔️ Batalla PK iniciada' });
          fireBattleAlerts('battleStart', {});
        } else if (isEnd) {
          state.inBattle = false;
          broadcast('log', { level: 'info', text: '⚔️ Batalla PK finalizada' });
          fireBattleAlerts('battleEnd', {});
        }
      } catch {}
    });

    conn.on(WebcastEvent.LINK_MIC_ARMIES, (data) => {
      try {
        state.inBattle = true;
        const giftId = String(data?.giftId || '');
        const giftCount = Number(data?.giftCount || 0);
        const repeatCount = Number(data?.repeatCount || 0);
        const fromUserId = String(data?.fromUserId || '');
        const cat = giftsById.get(giftId);
        const giftName = (cat?.name || '').toLowerCase();
        const info = { giftId, giftName, giftCount, repeatCount: repeatCount || giftCount, fromUserId };
        if (giftId && giftId !== '0') {
          broadcast('log', { level: 'info', text: `⚔️ Regalo de batalla: ${cat?.name || ('id ' + giftId)} ×${info.repeatCount || 1}` });
          fireBattleAlerts('battleGiftAny', info);
          fireBattleAlerts('battleGift', info);
        }
      } catch {}
    });

    conn.on(WebcastEvent.STREAM_END, () => {
      state.inBattle = false;
      state.connected = false;
      markLiveSessionEnded();
      pushState();
      broadcast('log', { level: 'info', text: 'El live terminó.' });
      resetSessionOverlays(); // al finalizar el live, limpia overlays (menos los semanales)
    });
  }

  /* ---------------------- Mensajes WS desde el navegador ---------------------- */
  function handleMessage(ws, data) {
    switch (data.action) {
      case 'ping':
        // Keepalive desde el navegador: respondemos al instante para confirmar vida.
        try { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'pong' })); } catch {}
        break;
      case 'connect':
        if (data.username) connectTo(String(data.username).trim().replace(/^@/, ''));
        break;
      case 'disconnect':
        disconnectManual();
        break;
      case 'saveSettings':
        if (data.settings) applyIncomingSettings(data.settings, true);
        break;
      case 'getProfiles':
        try { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'profiles', payload: profilesInfo() })); } catch {}
        break;
      case 'switchProfile':
        switchProfile(data.index);
        break;
      case 'renameProfile':
        renameProfile(data.index, data.name);
        break;
      case 'getProfilesFull':
        try { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'profilesFull', payload: getProfilesFull() })); } catch {}
        break;
      case 'importProfiles':
        importProfiles(data.profiles, data.mode);
        break;
      case 'testAlert': {
        const demoUser = { uniqueId: 'demo', nickname: 'Usuario de prueba', photo: null };
        broadcast(data.kind || 'gift', {
          ...demoUser, giftName: 'Rosa', repeatCount: 1, diamonds: 5, image: null, streak: false, test: true,
        });
        // El regalo simulado también alimenta las pelotas de fans (modo prueba).
        if (!data.kind || data.kind === 'gift') processFanBalls('coins', demoUser, 5);
        break;
      }
      case 'testAction': {
        const a = (settings.actions || []).find((x) => x.id === data.id);
        if (a && actions.actionDoesSomething(a)) actions.fireAction(a);
        break;
      }
      case 'testMcAction': {
        const a = (settings.mcActions || []).find((x) => x.uid === data.uid)
          || (settings.bedrockActions || []).find((x) => x.uid === data.uid)
          || (settings.sandboxActions || []).find((x) => x.uid === data.uid);
        if (a && (a.cmd || (Array.isArray(a.cmds) && a.cmds.length))) {
          actions.runMcAction(a, actions.buildMcVars(
            { giftName: 'Rose', giftId: '5655', diamonds: 1, repeatCount: 1, comment: 'Prueba' },
            { nickname: 'Prueba', uniqueId: 'prueba' },
          ));
        }
        break;
      }
      case 'runMcRaw': {
        // Comando "crudo" para configuraciones de Bedrock (solo "Probar").
        const cmd = String(data.command || '').trim();
        if (cmd) actions.runMcAction({ cmd, name: String(data.name || 'Comando') }, actions.buildMcVars(
          { nickname: 'Streamer', uniqueId: 'streamer' },
          { nickname: 'Streamer', uniqueId: 'streamer' },
        ));
        break;
      }
      case 'runActionOutputs':
        actions.runActionOutputs({ webhookCmd: data.webhookCmd, obsCmd: data.obsCmd, sbCmd: data.sbCmd });
        break;
      case 'getPoints':
        try { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'pointsList', payload: serializePoints() })); } catch {}
        break;
      case 'addPointsTx': {
        // Transacción manual: suma o resta puntos a un usuario. amount negativo = retirar.
        const amount = Math.round(Number(data.points) || 0);
        if (data.user && amount !== 0) {
          addUserPoints({
            uniqueId: data.user, nickname: data.nickname || data.user,
            amount, counted: data.counted !== false,
            description: String(data.description || '').slice(0, 120), manual: true,
          });
        }
        break;
      }
      case 'resetPoints':
        resetAllPoints();
        break;
      case 'resetUserPoints':
        if (data.user) resetOnePoints(data.user);
        break;
      case 'hello':
        if (data.role === 'videoScreen') {
          videoScreens.set(ws, Number(data.screen) || 1);
          broadcastScreens();
        }
        break;
      case 'testVideo':
        if (data.video) {
          const scr = Number(data.video.screen) || 1;
          broadcast('media', { ...data.video, screen: scr, size: screenSize(scr), test: true });
        }
        break;
      case 'testLevelUp': {
        const level = Math.max(1, Number(data.level) || 1);
        const fromLevel = Math.max(0, Number(data.fromLevel) ?? (level - 1));
        emitMemberLevelUp(
          { user: { uniqueId: 'test_user', nickname: data.nickname || 'Prueba' } },
          fromLevel,
          level,
        );
        break;
      }
      case 'stopVideo': {
        const scr = Number(data.screen) || 1;
        broadcast('stopMedia', { screen: scr });
        break;
      }
      case 'testScreen': {
        const scr = Number(data.screen) || 1;
        broadcast('media', { test: true, screenTest: true, name: 'Pantalla ' + scr, screen: scr, size: screenSize(scr) });
        break;
      }
      // Pruebas manuales de juegos: la nube delega la ejecución al .exe (relay) vía localExec.
      case 'marioSpawn':
        actions.spawnMarioThing(String(data.thing || ''), data.name, data.times);
        break;
      case 'marioEffect':
        actions.applyMarioEffect(String(data.type || ''), data.seconds, data.factor);
        break;
      case 'pvzSpawn':
        actions.spawnPvzThing(String(data.thing || ''), data.name, data.times);
        break;
      case 'pvzSun':
        actions.givePvzSun(data.amount);
        break;
      case 'pvzCmd':
        actions.pvzCommand(String(data.path || ''));
        break;
      case 'testSound':
        if (data.alert) broadcast('sound', { ...data.alert, test: true });
        break;
      case 'panic':
        broadcast('panic', {});
        for (let scr = 1; scr <= 5; scr++) broadcast('stopMedia', { screen: scr });
        break;
      case 'testPerrito':
        broadcast('perritoTest', { count: Number(data.count) || 200 });
        break;
      case 'resetPerrito':
        broadcast('perritoReset', {});
        break;
      case 'testJarron':
        broadcast('jarronTest', { count: Number(data.count) || 200 });
        break;
      case 'resetJarron':
        broadcast('jarronReset', {});
        break;
      case 'testVaquita':
        broadcast('vaquitaTest', { count: Number(data.count) || 200 });
        break;
      case 'resetVaquita':
        broadcast('vaquitaReset', {});
        break;
      case 'testMarranito':
        broadcast('marranitoTest', { count: Number(data.count) || 200 });
        break;
      case 'resetMarranito':
        broadcast('marranitoReset', {});
        break;
      case 'testPelotas':
        broadcast('pelotasTest', { count: Number(data.count) || 16 });
        break;
      case 'resetPelotas':
        broadcast('pelotasReset', {});
        break;
      case 'getRoulette':
        try { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'roulette', payload: serializeRoulette() })); } catch {}
        break;
      case 'rouletteCollect':
        roulette.collecting = !!data.on;
        broadcast('log', { level: 'info', text: roulette.collecting ? '🎡 Ruleta: recolectando participantes…' : '🎡 Ruleta: recolección detenida.' });
        broadcastRoulette();
        break;
      case 'rouletteClear':
        roulette.entries.clear();
        roulette.collecting = false;
        roulette.giftImage = '';
        broadcastRoulette();
        broadcast('rouletteReset', {});
        break;
      case 'rouletteSpin':
        rouletteSpin();
        break;
      case 'testRoulette': {
        const names = ['@ana', '@luis', '@pepito', '@maria', '@chuy', '@sofia', '@dani', '@kevin'];
        broadcast('rouletteTest', {
          entries: names.map((n) => ({ uniqueId: n, nickname: n, photo: '', weight: 1 + Math.floor(Math.random() * 20) })),
          giftImage: roulette.giftImage || '',
        });
        break;
      }
      case 'testTopDonor':
        broadcast('topDonorTest', {});
        break;
      case 'stopTopDonor':
        broadcast('topDonorTestEnd', {});
        break;
      case 'resetWeeklyTop':
        weekly.donors.clear();
        saveWeekly();
        broadcastWeeklyTop();
        break;
      case 'testGiftVs':
        broadcast('giftVsTest', {});
        break;
      case 'resetGiftVs':
        broadcast('giftVsReset', {});
        break;
      case 'testGiftSeq':
        broadcast('giftSeqTest', {});
        break;
      case 'resetGiftSeq':
        broadcast('giftSeqReset', {});
        break;
      case 'testTopGift':
        broadcast('topGiftTest', { gift: data.gift || null });
        break;
      case 'resetTopGift':
        broadcast('topGiftReset', {});
        break;
      case 'testTop1':
        broadcast('top1Test', {});
        break;
      case 'resetTop1':
        broadcast('top1Reset', {});
        break;
      case 'testWins':
        broadcast('winsTest', {});
        break;
      case 'resetWins':
        broadcast('winsReset', {});
        break;
      case 'testWinsGamer':
        broadcast('winsGamerTest', {});
        break;
      case 'resetWinsGamer':
        broadcast('winsGamerReset', {});
        break;
      case 'testGiftCounter':
        broadcast('giftCounterTest', {});
        break;
      case 'resetGiftCounter':
        resetGiftCounter();
        break;
      case 'setGiftCounter':
        setGiftCounter(data.value);
        break;
      case 'testTopStreak':
        broadcast('topStreakTest', { gift: data.gift || null });
        break;
      case 'resetTopStreak':
        broadcast('topStreakReset', {});
        break;
      case 'testBatallaGifts':
        broadcast('batallaGiftsTest', {});
        break;
      case 'resetBatallaGifts':
        broadcast('batallaGiftsReset', {});
        break;
      case 'testBatallaLikes':
        broadcast('batallaLikesTest', {});
        break;
      case 'resetBatallaLikes':
        broadcast('batallaLikesReset', {});
        break;
      case 'testCoinMatch':
        broadcast('coinMatchTest', {});
        break;
      case 'testRank':
        broadcast('rankTest', { rank: data.rank });
        break;
      case 'resetRank':
        broadcast('rankReset', { rank: data.rank });
        break;
      case 'testHype':
        broadcast('hypeTest', {});
        break;
      case 'resetHype':
        broadcast('hypeReset', {});
        break;
      case 'testAlertaGift':
        broadcast('alertaGiftTest', {});
        break;
      case 'resetAlertaGift':
        broadcast('alertaGiftReset', {});
        break;
      case 'testAlertaLikes':
        broadcast('alertaLikesTest', {});
        break;
      case 'resetAlertaLikes':
        broadcast('alertaLikesReset', {});
        break;
      case 'testAlertaFollow':
        broadcast('alertaFollowTest', {});
        break;
      case 'resetAlertaFollow':
        broadcast('alertaFollowReset', {});
        break;
      case 'testStreamJoin':
        broadcast('streamJoinTest', {});
        break;
      case 'resetStreamJoin':
        broadcast('streamJoinReset', {});
        break;
      case 'coinMatch':
        broadcast('coinMatchControl', { action: data.coinAction, durationSec: data.durationSec });
        break;
      case 'timerControl': {
        const op = data.op;
        if (op === 'set') setTimer(data.totalSeconds);
        else if (op === 'start') startTimer(data.totalSeconds);
        else if (op === 'pause') pauseTimer();
        else if (op === 'reset') resetTimer();
        else if (op === 'add') addTimerSeconds(data.delta);
        break;
      }
      case 'battle':
        handleBattleAction(data);
        break;
    }
  }

  /* ------------------------ Gestión de clientes WS ------------------------ */
  function sendInitialBurst(ws) {
    ws.send(JSON.stringify({ type: 'state', payload: serializeState() }));
    ws.send(JSON.stringify({ type: 'settings', payload: settings }));
    ws.send(JSON.stringify({ type: 'profiles', payload: profilesInfo() }));
    ws.send(JSON.stringify({ type: 'battle', payload: serializeBattle() }));
    ws.send(JSON.stringify({ type: 'screens', payload: { connected: [...new Set(videoScreens.values())] } }));
    ws.send(JSON.stringify({ type: 'weeklyTop', payload: serializeWeeklyTop() }));
    ws.send(JSON.stringify({ type: 'pointsList', payload: serializePoints() }));
    ws.send(JSON.stringify({ type: 'timer', payload: serializeTimer() }));
    ws.send(JSON.stringify({ type: 'giftCounter', payload: serializeGiftCounter() }));
    ws.send(JSON.stringify({ type: 'emoteCatalog', payload: { results: [...emoteCatalog.values()] } }));
    const caps = currentCaps();
    if (caps) ws.send(JSON.stringify({ type: 'caps', payload: caps }));
  }
  function addClient(ws, role = 'panel') {
    ws.clientRole = role;
    if (role === 'local') {
      localClients.add(ws);
      lastSeen = Date.now();
      try { ws.send(JSON.stringify({ type: 'localReady', payload: { ok: true } })); } catch {}
      broadcastLocalStatus();
      return;
    }
    if (role === 'relay') {
      // App de escritorio completa: recibe la ráfaga inicial (para pintar la ventana)
      // y queda suscrita a datos + órdenes de ejecución.
      relayClients.add(ws);
      lastSeen = Date.now();
      try { ws.send(JSON.stringify({ type: 'localReady', payload: { ok: true, relay: true } })); } catch {}
      try { sendInitialBurst(ws); } catch {}
      broadcastLocalStatus();
      return;
    }
    clients.add(ws);
    lastSeen = Date.now();
    sendInitialBurst(ws);
  }
  function removeClient(ws) {
    clients.delete(ws);
    let wasLocal = localClients.delete(ws);
    if (relayClients.delete(ws)) wasLocal = true;
    if (wasLocal) broadcastLocalStatus();
    lastSeen = Date.now();
    if (videoScreens.has(ws)) {
      videoScreens.delete(ws);
      broadcastScreens();
    }
  }

  function getEmotes() {
    return [...emoteCatalog.values()];
  }
  function shutdown() {
    disconnect();
    if (autoConnectTimer) { clearInterval(autoConnectTimer); autoConnectTimer = null; }
    stopTimerInterval();
    clearTimeout(saveTimer);
    clearTimeout(weeklySaveTimer);
    clearTimeout(statsTimer);
    // Vaciar a disco el estado actual antes de cerrar, por si quedó un guardado
    // pendiente en la ventana de debounce: así nunca se pierde el último cambio.
    try { writeJsonAtomic(SETTINGS_FILE, settings); } catch {}
    try {
      const data = { start: weekly.start, end: weekly.end, donors: [...weekly.donors.values()] };
      writeJsonAtomic(WEEKLY_FILE, data);
    } catch {}
    clearTimeout(pointsSaveTimer);
    try { writeJsonAtomic(POINTS_FILE, { users: [...points.values()], tx: pointsTx.slice(0, POINTS_MAX_TX) }); } catch {}
    try { saveLiveSession(); } catch {}
  }

  // Chequeo de cambio de semana por room.
  const weekInterval = setInterval(ensureWeek, 60000);
  weekInterval.unref?.();

  function getStatus() {
    return {
      live: !!state.connected,
      connecting: !!state.connecting,
      liveSince: state.startedAt || null,
      account: state.username || null,
      clients: clients.size,
      localClients: localClients.size + relayClients.size,
      online: clients.size > 0 || localClients.size > 0 || relayClients.size > 0,
      lastSeen: lastSeen || 0,
    };
  }

  function kickAll() {
    for (const ws of [...clients, ...localClients, ...relayClients]) {
      try { ws.send(JSON.stringify({ type: 'accountPending' })); } catch {}
      try { ws.close(4003, 'pending'); } catch {}
    }
    clients.clear();
    localClients.clear();
    relayClients.clear();
  }

  return {
    id, account, roomKey,
    addClient, removeClient, handleMessage,
    getEmotes, shutdown, getStatus, kickAll, broadcastCaps,
    getSettings: () => settings,
    applySettings: (obj) => applyIncomingSettings(obj, false),
    hasSavedSettings: () => fs.existsSync(SETTINGS_FILE),
    getProfilesInfo: profilesInfo,
    getProfilesFull,
    switchProfile,
    renameProfile,
    importProfiles,
    spotifyCharge,
    get clientCount() { return clients.size; },
  };
}
