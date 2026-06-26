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
function pickImageUrl(img) {
  if (!img) return null;
  if (typeof img === 'string') return img;
  if (img.giftPictureUrl) return img.giftPictureUrl;
  if (Array.isArray(img.url) && img.url[0]) return img.url[0];
  if (Array.isArray(img.urlList) && img.urlList[0]) return img.urlList[0];
  if (Array.isArray(img.url_list) && img.url_list[0]) return img.url_list[0];
  return null;
}
function getGiftImage(data) {
  if (!data) return null;
  return (
    pickImageUrl(data.giftDetails?.giftImage) ||
    pickImageUrl(data.giftImage) ||
    pickImageUrl(data.giftDetails?.image) ||
    pickImageUrl(data.image) ||
    data.giftPictureUrl ||
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
function gifterLevelFromUser(u) {
  if (!u) return 0;
  const levels = [
    numMemberLevel(u?.userHonor?.level),
    numMemberLevel(u?.payGrade?.level),
    numMemberLevel(u?.gifterLevel),
  ];
  const badges = flattenBadges([].concat(u.badges || [], u.userBadges || [], u.newUserBadges || [], u.badgeImageList || []));
  for (const b of badges) {
    if (badgeScene(b) === 8) levels.push(levelFromBadge(b));
    if (String(b?.type || '').toLowerCase() === 'privilege') levels.push(levelFromBadge(b));
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
  const gifterLevel = gifterLevelFromUser(u);

  return { isMod, isSub, isFollower, isTeam, memberLevel, gifterLevel };
}
function matchesCommand(command, comment) {
  const cmd = String(command || '').trim().toLowerCase();
  if (!cmd) return false;
  const text = String(comment || '').trim().toLowerCase();
  if (!text) return false;
  return text === cmd || text.split(/\s+/)[0] === cmd;
}
function emoteIdFrom(obj) {
  if (!obj || typeof obj !== 'object') return '';
  return String(obj.emoteId ?? obj.emote_id ?? obj.uuid ?? obj.packageId ?? obj.id ?? '').trim();
}
function emoteImageUrl(img) {
  if (!img) return '';
  if (typeof img === 'string') return img;
  return img.url_list?.[0] || img.urlList?.[0] || img.imageUrl || img.url?.[0] || img.uri || '';
}
function currentWeekRange(now = Date.now()) {
  const d = new Date(now);
  const day = (d.getDay() + 6) % 7; // 0 = lunes
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate() - day, 0, 0, 0, 0).getTime();
  const end = start + 7 * 86400000;
  return [start, end];
}
function currentMonthRange(now = Date.now()) {
  const d = new Date(now);
  const start = new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0).getTime();
  const end = new Date(d.getFullYear(), d.getMonth() + 1, 1, 0, 0, 0, 0).getTime();
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
  const tmp = file + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    if (e.code !== 'ENOSPC') console.error('  [!] No se pudo guardar', file, '-', e.message);
    else console.error('  [!] Disco lleno, no se pudo guardar', path.basename(file));
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

function relativizeMediaUrl(u) {
  if (!u || typeof u !== 'string') return u;
  if (u.startsWith('/')) return u;
  try {
    const p = new URL(u);
    if (/^\/(uploads|audios|video)\//.test(p.pathname)) return p.pathname + (p.search || '');
  } catch {}
  return u;
}
function normalizeSettingsMediaUrls(s) {
  if (!s || typeof s !== 'object') return;
  const rel = relativizeMediaUrl;
  for (const a of (s.soundAlerts || [])) if (a.sound) a.sound = rel(a.sound);
  for (const v of (s.videos || [])) if (v.url) v.url = rel(v.url);
  for (const b of (s.battleAlerts || [])) if (b.url) b.url = rel(b.url);
  for (const a of (s.actions || [])) if (a.sound) a.sound = rel(a.sound);
  for (const a of (s.mcActions || [])) if (a.sound) a.sound = rel(a.sound);
}
function normalizeProfilesMediaUrls(p) {
  if (!p) return;
  for (const slot of (p.slots || [])) normalizeSettingsMediaUrls(slot);
  normalizeSettingsMediaUrls(p.general);
}

/* --------------------------------- La room --------------------------------- */
export function createRoom({ id, username: account, roomKey, dataDir, giftsById, getCaps, onUserSave, getLevelVideo, onStreamerRank }) {
  fs.mkdirSync(dataDir, { recursive: true });
  const SETTINGS_FILE = path.join(dataDir, 'settings.json');
  const PROFILES_FILE = path.join(dataDir, 'profiles.json');
  const WEEKLY_FILE = path.join(dataDir, 'weekly.json');
  const TOP1FIRE_FILE = path.join(dataDir, 'top1fire.json');
  const HABIBI_TOP_FILE = path.join(dataDir, 'habibi-top.json');
  const RANKS_FILE = path.join(dataDir, 'rank-overlays.json');
  const RANK_IDS = ['toplikes', 'topdiam', 'toplikeslist', 'topdiamlist'];
  const RANK_SETTINGS_KEY = { toplikes: 'toplikesRank', topdiam: 'topdiamRank', toplikeslist: 'toplikesList', topdiamlist: 'topdiamList' };
  const POINTS_FILE = path.join(dataDir, 'points.json');
  const SESSION_FILE = path.join(dataDir, 'session.json');
  const SESSION_OVERLAYS_FILE = path.join(dataDir, 'session-overlays.json');
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
  const top1fire = { start: 0, end: 0, period: 'live', donors: new Map() };
  const top1fireSession = new Map();
  let top1fireSaveTimer = null;
  let lastTop1FirePeriod = null;
  const habibiTop = { start: 0, end: 0, period: 'live', donors: new Map() };
  const habibiTopSession = new Map();
  let habibiTopSaveTimer = null;
  let lastHabibiTopPeriod = null;
  let habibiTopSnapshot = null;
  const rankSession = Object.fromEntries(RANK_IDS.map((id) => [id, new Map()]));
  const rankPersist = Object.fromEntries(RANK_IDS.map((id) => [id, { period: 'live', start: 0, end: 0, users: new Map() }]));
  let rankSaveTimer = null;
  const lastRankPeriods = {};
  const followerCounter = { count: 0, nickname: '', uniqueId: '', photo: '', ready: false };

  let rankSnap = { likes: 0, diamonds: 0 };
  let rankLastTick = 0;
  let rankStreamerTimer = null;
  function resetRankSnap() {
    rankSnap = { likes: state.stats.likes || 0, diamonds: state.stats.diamonds || 0 };
    rankLastTick = Date.now();
  }
  function flushStreamerRank(extraStreamMs = 0) {
    if (!onStreamerRank || !state.connected) return;
    const now = Date.now();
    let streamMsDelta = extraStreamMs;
    if (!streamMsDelta && rankLastTick && state.startedAt) {
      streamMsDelta = Math.min(now - rankLastTick, 120000);
    }
    const likesDelta = Math.max(0, (state.stats.likes || 0) - rankSnap.likes);
    const diamondsDelta = Math.max(0, (state.stats.diamonds || 0) - rankSnap.diamonds);
    if (likesDelta) rankSnap.likes = state.stats.likes;
    if (diamondsDelta) rankSnap.diamonds = state.stats.diamonds;
    rankLastTick = now;
    if (!(likesDelta || diamondsDelta || streamMsDelta)) return;
    try {
      onStreamerRank({
        userId: id,
        username: account,
        tiktok: state.username || '',
        nickname: followerCounter.nickname || state.username || account,
        photo: followerCounter.photo || '',
        likesDelta,
        diamondsDelta,
        streamMsDelta,
      });
    } catch { /* ignore */ }
  }
  function startRankStreamerTimer() {
    if (!onStreamerRank) return;
    clearInterval(rankStreamerTimer);
    rankStreamerTimer = setInterval(() => flushStreamerRank(), 60000);
    rankStreamerTimer.unref?.();
  }
  function stopRankStreamerTimer() {
    clearInterval(rankStreamerTimer);
    rankStreamerTimer = null;
  }
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
  const recentChatKeys = new Set();
  const recentChatOrder = [];
  function chatEventKey(data, comment) {
    const msgId = data?.common?.msgId || data?.msgId;
    if (msgId && String(msgId) !== '0') return 'id:' + msgId;
    const uid = data?.user?.uniqueId || data?.user?.userId || '';
    const ct = data?.common?.createTime || '';
    return `f:${uid}|${comment}|${ct}`;
  }
  function consumeChatOnce(key) {
    if (recentChatKeys.has(key)) return false;
    recentChatKeys.add(key);
    recentChatOrder.push(key);
    if (recentChatOrder.length > 500) recentChatKeys.delete(recentChatOrder.shift());
    return true;
  }
  const emoteCatalog = new Map();
  const EMOTES_FILE = path.join(dataDir, 'emotes.json');
  let emotesSaveTimer = null;

  function loadEmotesCatalog() {
    const r = readJsonSafe(EMOTES_FILE);
    const list = Array.isArray(r.data) ? r.data : (Array.isArray(r.data?.results) ? r.data.results : []);
    for (const e of list) {
      const eid = String(e?.id || '').trim();
      if (!eid) continue;
      const img = emoteImageUrl(e.image) || String(e.image || '').trim();
      emoteCatalog.set(eid, { id: eid, image: img });
    }
  }
  loadEmotesCatalog();

  function saveEmotesCatalogNow() {
    writeJsonAtomic(EMOTES_FILE, [...emoteCatalog.values()]);
  }
  function scheduleSaveEmotesCatalog() {
    clearTimeout(emotesSaveTimer);
    emotesSaveTimer = setTimeout(saveEmotesCatalogNow, 400);
  }
  function mergeEmotes(list) {
    if (!Array.isArray(list) || !list.length) return false;
    let changed = false;
    for (const e of list) {
      const eid = String(e?.id || '').trim();
      if (!eid) continue;
      const url = emoteImageUrl(e.image);
      const prev = emoteCatalog.get(eid);
      if (!prev || (!prev.image && url)) {
        emoteCatalog.set(eid, { id: eid, image: url || prev?.image || '' });
        changed = true;
      }
    }
    if (changed) {
      scheduleSaveEmotesCatalog();
      broadcast('emoteCatalog', { results: [...emoteCatalog.values()] });
    }
    return changed;
  }
  // Pelotas de fans: acumulado por usuario (con sobrante) para soltar pelotas.
  const fanCoinAcc = new Map();      // uniqueId -> monedas pendientes
  const fanLikeAcc = new Map();      // uniqueId -> likes pendientes
  // Overlays de sesión (top1, mejor regalo/racha, batallas, hype…) persistidos en disco.
  const sessionOv = {
    top1: {},
    topGift: null,
    topStreak: null,
    batallaGifts: {},
    batallaLikes: {},
    hype: { score: 0, target: 100, coinTotal: 0 },
  };
  let sessionOverlaysSaveTimer = null;
  const recentSubs = new Map();      // dedupe suscripciones (subscribe/subNotify)
  const recentSuperFans = new Map(); // dedupe super fans (superFan/superFanJoin)
  const memberLevels = new Map();    // uniqueId -> último nivel de miembro visto (para detectar subidas)
  const joinVideoCooldown = new Map(); // uniqueId -> última vez que se lanzó su video de entrada

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
  const profilesMediaBefore = JSON.stringify(profiles);
  normalizeProfilesMediaUrls(profiles);
  if (JSON.stringify(profiles) !== profilesMediaBefore) {
    try { writeJsonAtomic(PROFILES_FILE, profiles); } catch {}
  }
  function resolveProfileSettings(slot) {
    if (slot && typeof slot === 'object' && !Array.isArray(slot)) return deepMerge(structuredClone(DEFAULT_SETTINGS), slot);
    return structuredClone(DEFAULT_SETTINGS);
  }
  function cloneSettings(obj) {
    if (!obj || typeof obj !== 'object') return structuredClone(DEFAULT_SETTINGS);
    try { return structuredClone(obj); } catch { return JSON.parse(JSON.stringify(obj)); }
  }
  (function dedupeProfileSlotReferences() {
    let changed = false;
    const seen = new Map();
    for (let i = 0; i < (profiles.slots || []).length; i++) {
      const s = profiles.slots[i];
      if (!s || typeof s !== 'object') continue;
      if (seen.has(s)) { profiles.slots[i] = cloneSettings(s); changed = true; }
      else seen.set(s, i);
    }
    if (profiles.general && typeof profiles.general === 'object' && seen.has(profiles.general)) {
      profiles.general = cloneSettings(profiles.general);
      changed = true;
    }
    if (changed) {
      try { writeJsonAtomic(PROFILES_FILE, profiles); } catch {}
      console.log('  [profiles] Ranuras duplicadas separadas (acciones/videos por perfil).');
    }
  })();
  function loadSettings() {
    return resolveProfileSettings(profiles.slots[profiles.active]);
  }
  function loadGeneralSettings() {
    return resolveProfileSettings(profiles.general);
  }
  let settings = profiles.editMode === 'general' ? loadGeneralSettings() : loadSettings();
  loadWeekly();
  loadTop1Fire();
  loadHabibiTop();
  loadRankOverlays();
  loadSessionOverlays();
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
    if (p.general != null && (typeof p.general !== 'object' || Array.isArray(p.general))) p.general = null;
    if (p.editMode !== 'general') p.editMode = 'profile';
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
  function persistCurrentEdit() {
    clearTimeout(saveTimer);
    const snap = cloneSettings(settings);
    if (profiles.editMode === 'general') profiles.general = snap;
    else profiles.slots[profiles.active] = snap;
  }
  function getActiveProfileSettings() {
    if (profiles.editMode === 'profile') return resolveProfileSettings(settings);
    return loadSettings();
  }
  function getGeneralProfileSettings() {
    if (profiles.editMode === 'general') return resolveProfileSettings(settings);
    if (!profiles.general) return null;
    return resolveProfileSettings(profiles.general);
  }
  function forEachTriggerProfile(run) {
    run(getActiveProfileSettings(), false);
    const g = getGeneralProfileSettings();
    if (g) run(g, true);
  }
  function saveSettings() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      normalizeSettingsMediaUrls(settings);
      const snap = cloneSettings(settings);
      if (profiles.editMode === 'general') profiles.general = snap;
      else profiles.slots[profiles.active] = snap;
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
      editingGeneral: profiles.editMode === 'general',
      generalUsed: !!profiles.general,
    };
  }
  function broadcastProfiles() { broadcast('profiles', profilesInfo()); }
  function switchProfile(i) {
    const idx = Number(i);
    if (!Number.isInteger(idx) || idx < 0 || idx >= PROFILE_COUNT) return;
    if (idx >= profileLimit()) return;
    if (profiles.editMode === 'profile' && idx === profiles.active) return;
    persistCurrentEdit();
    profiles.editMode = 'profile';
    profiles.active = idx;
    saveProfilesNow();
    settings = loadSettings();
    writeJsonAtomic(SETTINGS_FILE, settings);
    enforceLimits();
    loadTop1Fire();
    broadcastTop1Fire();
    loadHabibiTop();
    broadcastHabibiTop();
    loadRankOverlays();
    broadcastAllRankStates();
    broadcast('settings', settings);
    broadcastProfiles();
    clampTimer();
    broadcastTimer();
    if (typeof onUserSave === 'function') { try { onUserSave(settings); } catch {} }
  }
  function switchToGeneralEdit() {
    if (profiles.editMode === 'general') return;
    persistCurrentEdit();
    profiles.editMode = 'general';
    saveProfilesNow();
    settings = loadGeneralSettings();
    writeJsonAtomic(SETTINGS_FILE, settings);
    enforceLimits();
    broadcast('settings', settings);
    broadcastProfiles();
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
    const slots = profiles.slots.map((s, i) => {
      if (profiles.editMode === 'general') return s;
      return i === profiles.active ? settings : s;
    });
    return {
      active: profiles.active,
      names: profiles.names.slice(),
      slots,
      general: profiles.editMode === 'general' ? settings : profiles.general,
      editingGeneral: profiles.editMode === 'general',
    };
  }
  function importProfiles(list, mode) {
    if (!Array.isArray(list) || !list.length) return;
    persistCurrentEdit();
    profiles.editMode = 'profile';
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
    const prevTop1FirePeriod = settings.top1fire?.resetPeriod;
    const prevHabibiTopPeriod = settings.habibiTop?.resetPeriod;
    const prevRankPeriods = {};
    for (const rankId of RANK_IDS) prevRankPeriods[rankId] = settings[RANK_SETTINGS_KEY[rankId]]?.resetPeriod;
    settings = deepMerge(settings, obj);
    if (obj.top1fire && obj.top1fire.resetPeriod != null && obj.top1fire.resetPeriod !== prevTop1FirePeriod) onTop1FireSettingsChange();
    if (obj.habibiTop && obj.habibiTop.resetPeriod != null && obj.habibiTop.resetPeriod !== prevHabibiTopPeriod) onHabibiTopSettingsChange();
    for (const rankId of RANK_IDS) {
      const key = RANK_SETTINGS_KEY[rankId];
      if (obj[key] && obj[key].resetPeriod != null && obj[key].resetPeriod !== prevRankPeriods[rankId]) onRankPeriodChange(rankId);
    }
    if (obj.topAltRank) {
      const alt = settings.topAltRank;
      if (alt.resetPeriodLikes != null) {
        if (!settings.toplikesRank) settings.toplikesRank = {};
        if (alt.resetPeriodLikes !== prevRankPeriods.toplikes) {
          settings.toplikesRank.resetPeriod = alt.resetPeriodLikes;
          onRankPeriodChange('toplikes');
        }
      }
      if (alt.resetPeriodDiam != null) {
        if (!settings.topdiamRank) settings.topdiamRank = {};
        if (alt.resetPeriodDiam !== prevRankPeriods.topdiam) {
          settings.topdiamRank.resetPeriod = alt.resetPeriodDiam;
          onRankPeriodChange('topdiam');
        }
      }
    }
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
    forEachTriggerSettings: (fn) => forEachTriggerProfile((cfg) => fn(cfg)),
    broadcast,
    broadcastToLocal,
    isCloud: process.env.DESKTOP !== '1',
  });
  function broadcastScreens() {
    broadcast('screens', { connected: [...new Set(videoScreens.values())] });
  }
  const isCloudHost = process.env.DESKTOP !== '1';
  function hasLocalRelay() { return localClients.size > 0 || relayClients.size > 0; }
  // En relay (.exe): los archivos de video viven en la PC del streamer; delegamos
  // reproducción/parada a la app local (Browser Source en 127.0.0.1), no en Render.
  function emitMedia(payload) {
    if (isCloudHost && hasLocalRelay()) broadcastToLocal('playMedia', payload);
    else broadcast('media', payload);
  }
  function emitStopMedia(payload) {
    if (isCloudHost && hasLocalRelay()) broadcastToLocal('stopMediaLocal', payload);
    else broadcast('stopMedia', payload);
  }
  function emitPanicMedia() {
    if (isCloudHost && hasLocalRelay()) broadcastToLocal('panicLocal', {});
    else broadcast('panic', {});
    for (let scr = 1; scr <= 5; scr++) emitStopMedia({ screen: scr });
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
    saveSessionOverlays();
  }
  function resetGiftCounter() { giftCounter.count = 0; broadcastGiftCounter(); saveSessionOverlays(); }
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
    saveSessionOverlays();
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
  function screenSizeForCfg(cfg, n) {
    return cfg?.screens?.[(Number(n) || 1) - 1]?.size ?? 100;
  }
  function emitProfileMedia(cfg, v, scr, isGeneral) {
    emitMedia({
      id: v.id,
      name: v.name,
      url: v.url,
      screen: scr,
      volume: v.volume ?? 100,
      size: screenSizeForCfg(cfg, scr),
      general: !!isGeneral,
      playQueue: cfg.playback?.playQueue !== false,
    });
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
  function canRestoreSessionOverlays(saved) {
    if (!saved) return false;
    if (saved.roomId && liveSession.roomId) {
      return String(saved.roomId) === String(liveSession.roomId);
    }
    if (saved.username && liveSession.username && liveSession.active) {
      return liveUserMatch(saved.username, liveSession.username);
    }
    return false;
  }
  function clearSessionOverlayState() {
    giftCounter.count = 0;
    top1fireSession.clear();
    habibiTopSession.clear();
    if (getHabibiTopPeriod() === 'live') habibiTopSnapshot = null;
    fanCoinAcc.clear();
    fanLikeAcc.clear();
    sessionOv.top1 = {};
    sessionOv.topGift = null;
    sessionOv.topStreak = null;
    sessionOv.batallaGifts = {};
    sessionOv.batallaLikes = {};
    sessionOv.hype = { score: 0, target: 100, coinTotal: 0 };
  }
  function loadSessionOverlays() {
    const raw = readJsonSafe(SESSION_OVERLAYS_FILE).data;
    if (!canRestoreSessionOverlays(raw)) return;
    giftCounter.count = Math.max(0, Number(raw.giftCounter?.count) || 0);
    if (getTop1FirePeriod() === 'live' && Array.isArray(raw.top1fireLive)) {
      top1fireSession.clear();
      for (const u of raw.top1fireLive) {
        if (u?.uniqueId) top1fireSession.set(u.uniqueId, u);
      }
    }
    if (getHabibiTopPeriod() === 'live' && Array.isArray(raw.habibiTopLive)) {
      habibiTopSession.clear();
      if (raw.habibiTopSnapshot && typeof raw.habibiTopSnapshot === 'object') {
        habibiTopSnapshot = raw.habibiTopSnapshot;
      }
      for (const u of raw.habibiTopLive) {
        if (u?.uniqueId) habibiTopSession.set(u.uniqueId, restoreHabibiDonor(u));
      }
    }
    fanCoinAcc.clear();
    fanLikeAcc.clear();
    for (const row of raw.fanCoinAcc || []) {
      if (Array.isArray(row) && row[0]) fanCoinAcc.set(row[0], Number(row[1]) || 0);
    }
    for (const row of raw.fanLikeAcc || []) {
      if (Array.isArray(row) && row[0]) fanLikeAcc.set(row[0], Number(row[1]) || 0);
    }
    sessionOv.top1 = (raw.top1 && typeof raw.top1 === 'object') ? raw.top1 : {};
    sessionOv.topGift = raw.topGift || null;
    sessionOv.topStreak = raw.topStreak || null;
    sessionOv.batallaGifts = (raw.batallaGifts && typeof raw.batallaGifts === 'object') ? raw.batallaGifts : {};
    sessionOv.batallaLikes = (raw.batallaLikes && typeof raw.batallaLikes === 'object') ? raw.batallaLikes : {};
    sessionOv.hype = raw.hype || { score: 0, target: 100, coinTotal: 0 };
  }
  function serializeSessionOverlaysPayload() {
    return {
      top1: sessionOv.top1,
      topGift: sessionOv.topGift,
      topStreak: sessionOv.topStreak,
      batallaGifts: sessionOv.batallaGifts,
      batallaLikes: sessionOv.batallaLikes,
      hype: sessionOv.hype,
    };
  }
  function saveSessionOverlaysNow() {
    clearTimeout(sessionOverlaysSaveTimer);
    sessionOverlaysSaveTimer = null;
    const data = {
      roomId: liveSession.roomId || null,
      username: liveSession.username || null,
      giftCounter: { count: giftCounter.count },
      top1fireLive: getTop1FirePeriod() === 'live' ? [...top1fireSession.values()] : [],
      habibiTopLive: getHabibiTopPeriod() === 'live' ? [...habibiTopSession.values()] : [],
      habibiTopSnapshot: habibiTopSnapshot || null,
      fanCoinAcc: [...fanCoinAcc.entries()],
      fanLikeAcc: [...fanLikeAcc.entries()],
      top1: sessionOv.top1,
      topGift: sessionOv.topGift,
      topStreak: sessionOv.topStreak,
      batallaGifts: sessionOv.batallaGifts,
      batallaLikes: sessionOv.batallaLikes,
      hype: sessionOv.hype,
    };
    writeJsonAtomic(SESSION_OVERLAYS_FILE, data);
  }
  function saveSessionOverlays() {
    clearTimeout(sessionOverlaysSaveTimer);
    sessionOverlaysSaveTimer = setTimeout(saveSessionOverlaysNow, 400);
  }
  function trackSessionHypeEvent(kind, amount) {
    const c = settings.hypeBar || {};
    const goalKind = String(c.goalKind || 'hype').toLowerCase();
    if (goalKind === 'viewers') return;
    const onReach = String(c.whenReach || 'increase');
    const allow = goalKind === 'hype'
      ? { like: true, follow: true, gift: true, share: true, member: false }
      : {
        like: goalKind === 'likes',
        follow: goalKind === 'follow',
        gift: goalKind === 'gift',
        share: goalKind === 'share',
        member: goalKind === 'member',
      };
    if (kind === 'like' && !allow.like) return;
    if (kind === 'follow' && !allow.follow) return;
    if (kind === 'share' && !allow.share) return;
    if (kind === 'member' && !allow.member) return;
    if (kind === 'gift' && !allow.gift && goalKind !== 'hype') return;
    const delta = Math.max(0, Number(amount) || 0);
    if (delta <= 0) return;
    let target = Math.max(1, parseInt(c.meta, 10) || 100);
    let { score, coinTotal } = sessionOv.hype;
    const giftMult = Math.max(1, parseInt(c.pointsGift, 10) || 1);
    if (kind === 'gift' && (goalKind === 'gift' || goalKind === 'regalos')) {
      coinTotal += delta;
      score = coinTotal;
    } else {
      score += kind === 'gift' ? delta * giftMult : delta;
    }
    if (onReach === 'increase') { while (score >= target) target += 50; }
    else if (onReach === 'reset' && score >= target) score = 0;
    else if (onReach === 'keep') {
      score = Math.min(score, target);
      if (goalKind === 'gift' || goalKind === 'regalos') coinTotal = score;
    }
    sessionOv.hype = { score, target, coinTotal };
    saveSessionOverlays();
  }
  function trackSessionGift(user, giftName, repeatCount, diamondsEach, image) {
    const total = diamondsEach * repeatCount;
    if (total <= 0) return;
    const uid = user?.uniqueId || user?.nickname;
    if (uid) {
      if (!sessionOv.top1[uid]) {
        sessionOv.top1[uid] = { name: user.nickname || uid, coins: 0, pic: user.photo || '' };
      }
      sessionOv.top1[uid].coins += total;
      if (user.photo) sessionOv.top1[uid].pic = user.photo;
      if (!sessionOv.batallaGifts[uid]) {
        sessionOv.batallaGifts[uid] = { name: user.nickname || uid, monedas: 0, pic: user.photo || '' };
      }
      sessionOv.batallaGifts[uid].monedas += total;
      if (user.photo) sessionOv.batallaGifts[uid].pic = user.photo;
    }
    if (diamondsEach > 0 && (!sessionOv.topGift || diamondsEach > sessionOv.topGift.coins)) {
      sessionOv.topGift = {
        coins: diamondsEach,
        nickname: user.nickname || uid || 'Usuario',
        image: image || '',
        uniqueId: uid || '',
      };
    }
    const rc = Math.max(0, Number(repeatCount) || 0);
    if (rc > 0 && (!sessionOv.topStreak || rc > sessionOv.topStreak.streak)) {
      sessionOv.topStreak = {
        streak: rc,
        nickname: user.nickname || uid || 'Usuario',
        giftName: giftName || '',
        image: image || '',
        uniqueId: uid || '',
      };
    }
    trackSessionHypeEvent('gift', total);
    saveSessionOverlays();
  }
  function trackSessionLike(user, count) {
    const n = Math.max(0, Number(count) || 0);
    if (n <= 0) return;
    const uid = user?.uniqueId || user?.nickname;
    if (uid) {
      if (!sessionOv.batallaLikes[uid]) {
        sessionOv.batallaLikes[uid] = { name: user.nickname || uid, likes: 0, pic: user.photo || '' };
      }
      sessionOv.batallaLikes[uid].likes += n;
      if (user.photo) sessionOv.batallaLikes[uid].pic = user.photo;
    }
    const c = settings.hypeBar || {};
    const pts = Math.max(1, parseInt(c.pointsLike, 10) || 1);
    trackSessionHypeEvent('like', n * pts);
    saveSessionOverlays();
  }
  function resetSessionOverlays() {
    clearSessionOverlayState();
    try { fs.unlinkSync(SESSION_OVERLAYS_FILE); } catch {}
    // Botes / contadores acumulados de la sesión
    broadcast('jarronReset', {});
    broadcast('vaquitaReset', {});
    broadcast('marranitoReset', {});
    broadcast('perritoReset', {});
    broadcast('pelotasReset', {});
    // Versus y secuencias
    broadcast('giftVsReset', {});
    broadcast('giftSeqReset', {});
    // Mejor regalo / mejor racha de la sesión
    broadcast('topGiftReset', {});
    broadcast('topStreakReset', {});
    // Top 1 donador (MVP de la sesión)
    broadcast('top1Reset', {});
    resetTop1FireSession();
    resetHabibiTopSession();
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
    for (const rank of RANK_IDS) resetRankSession(rank);
    for (const rankId of RANK_IDS) {
      if (getRankPeriod(rankId) !== 'live') broadcastRankState(rankId);
    }
    if (getTop1FirePeriod() !== 'live') broadcastTop1Fire();
    if (getHabibiTopPeriod() !== 'live') broadcastHabibiTop();
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
          resetRankSnap();
          startRankStreamerTimer();
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
          resetRankSnap();
          startRankStreamerTimer();
          pushState();
          broadcastAllRankStates();
          if (getTop1FirePeriod() !== 'live') broadcastTop1Fire();
    if (getHabibiTopPeriod() !== 'live') broadcastHabibiTop();
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
    if (state.connected) flushStreamerRank();
    stopRankStreamerTimer();
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
      actions.triggerActions('gift', { ...giftInfo, repeatCount: rep });
      return;
    }

    const prev = giftStreakGameProgress.get(key) || 0;
    const delta = Math.max(0, rep - prev);
    if (delta > 0) giftStreakGameProgress.set(key, rep);

    if (delta > 0) {
      actions.triggerMinecraftActions('gift', { ...giftInfo, repeatCount: delta, comboStreak: 'delta' }, user);
      actions.triggerActions('gift', { ...giftInfo, repeatCount: delta, comboStreak: 'delta' });
    }
    if (repeatEnd) {
      giftStreakGameProgress.delete(key);
      actions.triggerMinecraftActions('gift', { ...giftInfo, repeatCount: rep, comboStreak: 'end' }, user);
      actions.triggerActions('gift', { ...giftInfo, repeatCount: rep, comboStreak: 'end' });
    }
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
    saveSessionOverlays();
    if (drops > 0) {
      const count = Math.min(200, drops);
      broadcast('fanBallDrop', { photo: user.photo || '', nickname: user.nickname || '', count });
      broadcast('log', { level: 'ok', text: `🏀 Pelotas: ${count} de ${user.nickname || uid} (${kind === 'coins' ? 'monedas' : 'likes'} +${amount}, cada ${every})` });
    }
  }

  function triggerSoundAlerts(eventType, info = {}) {
    forEachTriggerProfile((cfg) => {
      for (const a of cfg.soundAlerts) {
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
    });
  }

  function triggerLikeGlobal(total) {
    if (!total || total <= lastTotalLikes) { lastTotalLikes = total || lastTotalLikes; return; }
    forEachTriggerProfile((cfg, isGeneral) => {
      for (const a of cfg.soundAlerts) {
        if (!a.enabled || !a.sound || (a.trigger || '') !== 'likeGlobal') continue;
        const goal = Math.max(1, a.likeGoal || 100);
        const before = Math.floor(lastTotalLikes / goal);
        const now = Math.floor(total / goal);
        if (now > before) {
          broadcast('sound', { id: a.id, name: a.name, sound: a.sound, image: a.image, volume: a.volume });
        }
      }
      if (cfg.videosEnabled !== false) {
        for (const v of cfg.videos) {
          if (!v.url || v.enabled === false || (v.trigger || '') !== 'likeGlobal') continue;
          const goal = Math.max(1, v.likeGoal || 100);
          if (Math.floor(total / goal) > Math.floor(lastTotalLikes / goal)) {
            emitProfileMedia(cfg, v, Number(v.screen) || 1, isGeneral);
          }
        }
      }
    });
    actions.triggerLikeGlobalExtras(total, lastTotalLikes);
    lastTotalLikes = total;
  }

  function triggerVideos(eventType, info = {}) {
    forEachTriggerProfile((cfg, isGeneral) => {
      if (cfg.videosEnabled === false) return;
      for (const v of cfg.videos) {
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
        if (eventType === 'levelUp') {
          const wantLevel = Math.max(0, Number(v.level) || 0);
          if (wantLevel > 0 && wantLevel !== Number(info.level || 0)) continue;
        }
        if (eventType === 'chatCommand') {
          if (!matchesCommand(v.command, info.comment)) continue;
        }
        if (eventType === 'chatCommand' || eventType === 'firstMessage' || eventType === 'userJoin') {
          const want = String(v.user || '').replace(/^@/, '').trim().toLowerCase();
          if (eventType === 'userJoin' && !want) continue;
          if (want) {
            const u = String(info.username || '').toLowerCase();
            const n = String(info.nickname || '').toLowerCase();
            if (want !== u && want !== n) continue;
          }
        }
        if (eventType === 'userJoin') {
          const delaySec = (v.joinDelay == null) ? 30 : Math.max(0, Number(v.joinDelay) || 0);
          if (delaySec > 0) {
            const now = Date.now();
            const cdKey = `${v.id}|${isGeneral ? 'g' : 'a'}`;
            const last = joinVideoCooldown.get(cdKey) || 0;
            if (now - last < delaySec * 1000) continue;
            joinVideoCooldown.set(cdKey, now);
          }
        }
        const scr = Number(v.screen) || 1;
        emitProfileMedia(cfg, v, scr, isGeneral);
      }
    });
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

  // Reproduce automáticamente el video de public/video/niveles (nivelN.webm).
  function playLevelVideo(level, opts = {}) {
    const cfg = settings.levelVideos || {};
    if (cfg.enabled === false) return;
    const n = Math.max(1, Number(level) || 1);
    const scr = Number(cfg.screen) || 1;
    const vol = cfg.volume ?? 100;
    const isCloud = process.env.DESKTOP !== '1';
    const hasLocal = localClients.size > 0 || relayClients.size > 0;
    // Subida real con relay: archivos en la PC del streamer → delegar al .exe local.
    if (isCloud && hasLocal && !opts.test) {
      broadcastToLocal('playLevelVideo', { level: n, screen: scr, volume: vol });
      return;
    }
    if (typeof getLevelVideo !== 'function') return;
    const url = getLevelVideo(n);
    if (!url) {
      broadcast('log', { level: 'warn', text: `⚠️ No hay video para nivel ${n} (nivel${n}.webm en public/video/niveles).` });
      return;
    }
    broadcast('log', { level: 'ok', text: `🎬 Video de nivel ${n} reproducido.` });
    emitMedia({ id: 'level_' + n, name: `Nivel ${n}`, url, screen: scr, volume: vol, size: screenSize(scr) });
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
      emitMedia({ id: b.id, name: b.name, url: b.url, screen: scr, volume: b.volume ?? 100, size: screenSize(scr) });
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
      nickname: followerCounter.nickname || state.username || null,
      photo: followerCounter.photo || '',
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
  function pickAvatarUrl(u) {
    if (!u || typeof u !== 'object') return '';
    return u.profilePictureUrl || u.profile_picture_url
      || (Array.isArray(u.avatarThumb?.urlList) && u.avatarThumb.urlList[0])
      || (Array.isArray(u.avatar_thumb?.url_list) && u.avatar_thumb.url_list[0])
      || '';
  }
  function extractFollowerFromRoomInfo(ri, username) {
    const out = { count: null, nickname: '', uniqueId: username || '', photo: '' };
    if (!ri) return out;
    const d = ri.data || ri;
    const users = [d?.owner, d?.user, d?.anchor, d?.liveRoom?.owner, ri?.user, ri?.liveRoomUserInfo?.user].filter(Boolean);
    for (const u of users) {
      if (!out.nickname && u.nickname) out.nickname = u.nickname;
      if (!out.uniqueId && (u.uniqueId || u.display_id || u.displayId)) out.uniqueId = u.uniqueId || u.display_id || u.displayId;
      if (!out.photo) out.photo = pickAvatarUrl(u);
      const fc = Number(
        u?.follow_info?.follower_count ?? u?.followInfo?.followerCount
        ?? u?.stats?.followerCount ?? u?.follower_count ?? u?.followerCount,
      );
      if (Number.isFinite(fc) && fc >= 0) { out.count = Math.floor(fc); break; }
    }
    if (out.count == null) {
      const fc = Number(d?.stats?.followerCount ?? d?.follower_count ?? d?.followerCount);
      if (Number.isFinite(fc) && fc >= 0) out.count = Math.floor(fc);
    }
    return out;
  }
  function serializeFollowerCounter() {
    return { count: followerCounter.count, nickname: followerCounter.nickname, uniqueId: followerCounter.uniqueId, photo: followerCounter.photo, ready: followerCounter.ready };
  }
  function broadcastFollowerCounter() {
    broadcast('followerCounter', serializeFollowerCounter());
  }
  function bumpFollowerCounter(delta, raw) {
    const abs = Number(raw?.followCount);
    if (Number.isFinite(abs) && abs > 0) followerCounter.count = Math.floor(abs);
    else followerCounter.count = Math.max(0, (followerCounter.count || 0) + (delta || 0));
    followerCounter.ready = true;
    broadcastFollowerCounter();
  }
  function seedFollowerCounterFromRoomInfo() {
    const parsed = extractFollowerFromRoomInfo(connection?.roomInfo, state.username);
    if (parsed.count != null) followerCounter.count = parsed.count;
    if (parsed.nickname) followerCounter.nickname = parsed.nickname;
    if (parsed.uniqueId) followerCounter.uniqueId = parsed.uniqueId;
    if (parsed.photo) followerCounter.photo = parsed.photo;
    followerCounter.ready = parsed.count != null;
    if (!followerCounter.uniqueId && state.username) followerCounter.uniqueId = state.username;
    broadcastFollowerCounter();
  }
  function resetFollowerCounterFromRoom() {
    if (connection?.roomInfo) seedFollowerCounterFromRoomInfo();
    else {
      followerCounter.count = 0;
      followerCounter.ready = false;
      broadcastFollowerCounter();
    }
  }
  function socialDisplayType(data) {
    return String(data?.common?.displayText?.displayType || data?.displayType || '').toLowerCase();
  }
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
      seedFollowerCounterFromRoomInfo();
      pushState();
    } catch { /* roomInfo opcional: si falla, seguimos contando desde 0 */ }
  }
  function resetStats() {
    state.stats = { viewers: 0, likes: 0, diamonds: 0, comments: 0, gifts: 0, follows: 0, shares: 0, joins: 0 };
    state.gifters.clear();
    chatSeenUsers.clear();
    recentChatKeys.clear();
    recentChatOrder.length = 0;
    fanCoinAcc.clear();
    fanLikeAcc.clear();
    recentSubs.clear();
    recentSuperFans.clear();
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

  /* ------------------------- Top 1 Donador Fuego ------------------------- */
  function getTop1FirePeriod() {
    const p = settings.top1fire?.resetPeriod;
    return p === 'week' || p === 'month' ? p : 'live';
  }
  function loadTop1Fire() {
    const period = getTop1FirePeriod();
    lastTop1FirePeriod = period;
    if (period === 'live') {
      top1fireSession.clear();
      return;
    }
    const [start, end] = period === 'month' ? currentMonthRange() : currentWeekRange();
    const r = readJsonSafe(TOP1FIRE_FILE);
    const raw = r.data;
    if (raw && raw.period === period && raw.start === start) {
      top1fire.period = period;
      top1fire.start = start;
      top1fire.end = end;
      top1fire.donors = new Map((raw.donors || []).map((u) => [u.uniqueId, u]));
      return;
    }
    top1fire.period = period;
    top1fire.start = start;
    top1fire.end = end;
    top1fire.donors = new Map();
  }
  function saveTop1Fire() {
    if (getTop1FirePeriod() === 'live') return;
    clearTimeout(top1fireSaveTimer);
    top1fireSaveTimer = setTimeout(() => {
      const data = {
        period: top1fire.period,
        start: top1fire.start,
        end: top1fire.end,
        donors: [...top1fire.donors.values()],
      };
      writeJsonAtomic(TOP1FIRE_FILE, data);
    }, 400);
  }
  function ensureTop1FirePeriod() {
    const period = getTop1FirePeriod();
    if (period === 'live') return;
    const [start, end] = period === 'month' ? currentMonthRange() : currentWeekRange();
    if (period !== top1fire.period || start !== top1fire.start) {
      top1fire.period = period;
      top1fire.start = start;
      top1fire.end = end;
      top1fire.donors.clear();
      saveTop1Fire();
      broadcastTop1Fire();
    }
  }
  function onTop1FireSettingsChange() {
    const period = getTop1FirePeriod();
    if (period === lastTop1FirePeriod) return;
    lastTop1FirePeriod = period;
    top1fireSession.clear();
    loadTop1Fire();
    broadcastTop1Fire();
  }
  function addTop1FireDonation(user, coins) {
    if (!user?.uniqueId || !(coins > 0)) return;
    const period = getTop1FirePeriod();
    if (period === 'live') {
      const u = top1fireSession.get(user.uniqueId) || { uniqueId: user.uniqueId, nickname: user.nickname, photo: user.photo, coins: 0 };
      u.coins += coins;
      u.nickname = user.nickname || u.nickname;
      if (user.photo) u.photo = user.photo;
      top1fireSession.set(user.uniqueId, u);
      broadcastTop1Fire();
      saveSessionOverlays();
      return;
    }
    ensureTop1FirePeriod();
    const u = top1fire.donors.get(user.uniqueId) || { uniqueId: user.uniqueId, nickname: user.nickname, photo: user.photo, coins: 0 };
    u.coins += coins;
    u.nickname = user.nickname || u.nickname;
    if (user.photo) u.photo = user.photo;
    top1fire.donors.set(user.uniqueId, u);
    saveTop1Fire();
    broadcastTop1Fire();
  }
  function serializeTop1Fire() {
    const period = getTop1FirePeriod();
    let donors;
    if (period === 'live') {
      donors = [...top1fireSession.values()];
    } else {
      ensureTop1FirePeriod();
      donors = [...top1fire.donors.values()];
    }
    const sorted = donors.sort((a, b) => b.coins - a.coins);
    const top = sorted[0] || null;
    return {
      top: top ? { uniqueId: top.uniqueId, nickname: top.nickname, profilePictureUrl: top.photo, coins: top.coins } : null,
      period,
      periodStart: period === 'live' ? 0 : top1fire.start,
      periodEnd: period === 'live' ? 0 : top1fire.end,
      now: Date.now(),
    };
  }
  function broadcastTop1Fire() {
    broadcast('top1fire', serializeTop1Fire());
  }
  function resetTop1FireSession() {
    if (getTop1FirePeriod() !== 'live') return;
    top1fireSession.clear();
    broadcast('top1fireReset', {});
    broadcastTop1Fire();
  }
  function resetTop1FireAll() {
    top1fireSession.clear();
    top1fire.donors.clear();
    if (getTop1FirePeriod() !== 'live') saveTop1Fire();
    broadcast('top1fireReset', {});
    broadcastTop1Fire();
  }

  /* ------------------------- Habibi Top Donador ------------------------- */
  function getHabibiTopPeriod() {
    const p = settings.habibiTop?.resetPeriod;
    return p === 'week' || p === 'month' ? p : 'live';
  }
  function habibiDonorPhoto(u) {
    if (!u) return '';
    return String(u.photo || u.profilePictureUrl || '').trim();
  }
  function restoreHabibiDonor(u) {
    const entry = { ...u };
    const snapPhoto = habibiTopSnapshot && entry.uniqueId === habibiTopSnapshot.uniqueId
      ? habibiDonorPhoto(habibiTopSnapshot) : '';
    const photo = habibiDonorPhoto(entry) || snapPhoto;
    if (photo) entry.photo = photo;
    return entry;
  }
  function updateHabibiTopSnapshot(top) {
    if (!top?.uniqueId) return;
    const photo = habibiDonorPhoto(top) || habibiDonorPhoto(habibiTopSnapshot);
    habibiTopSnapshot = {
      uniqueId: top.uniqueId,
      nickname: top.nickname || top.uniqueId,
      photo,
      profilePictureUrl: photo,
      coins: Number(top.coins) || 0,
    };
  }
  function buildHabibiTopPayload(top) {
    if (!top) return null;
    let photo = habibiDonorPhoto(top);
    if (!photo && habibiTopSnapshot && top.uniqueId === habibiTopSnapshot.uniqueId) {
      photo = habibiDonorPhoto(habibiTopSnapshot);
    }
    return {
      uniqueId: top.uniqueId,
      nickname: top.nickname || top.uniqueId,
      profilePictureUrl: photo,
      photo,
      coins: top.coins || 0,
    };
  }
  function loadHabibiTop() {
    const period = getHabibiTopPeriod();
    lastHabibiTopPeriod = period;
    if (period === 'live') {
      habibiTopSession.clear();
      return;
    }
    const [start, end] = period === 'month' ? currentMonthRange() : currentWeekRange();
    const r = readJsonSafe(HABIBI_TOP_FILE);
    const raw = r.data;
    habibiTopSnapshot = raw?.topSnapshot && typeof raw.topSnapshot === 'object' ? raw.topSnapshot : null;
    if (raw && raw.period === period && raw.start === start) {
      habibiTop.period = period;
      habibiTop.start = start;
      habibiTop.end = end;
      habibiTop.donors = new Map((raw.donors || []).map((u) => [u.uniqueId, restoreHabibiDonor(u)]));
      return;
    }
    habibiTop.period = period;
    habibiTop.start = start;
    habibiTop.end = end;
    habibiTop.donors = new Map();
    habibiTopSnapshot = null;
  }
  function saveHabibiTop() {
    if (getHabibiTopPeriod() === 'live') return;
    clearTimeout(habibiTopSaveTimer);
    habibiTopSaveTimer = setTimeout(() => {
      const data = {
        period: habibiTop.period,
        start: habibiTop.start,
        end: habibiTop.end,
        donors: [...habibiTop.donors.values()],
        topSnapshot: habibiTopSnapshot,
      };
      writeJsonAtomic(HABIBI_TOP_FILE, data);
    }, 400);
  }
  function ensureHabibiTopPeriod() {
    const period = getHabibiTopPeriod();
    if (period === 'live') return;
    const [start, end] = period === 'month' ? currentMonthRange() : currentWeekRange();
    if (period !== habibiTop.period || start !== habibiTop.start) {
      habibiTop.period = period;
      habibiTop.start = start;
      habibiTop.end = end;
      habibiTop.donors.clear();
      habibiTopSnapshot = null;
      saveHabibiTop();
      broadcastHabibiTop();
    }
  }
  function onHabibiTopSettingsChange() {
    const period = getHabibiTopPeriod();
    if (period === lastHabibiTopPeriod) return;
    lastHabibiTopPeriod = period;
    habibiTopSession.clear();
    habibiTopSnapshot = null;
    loadHabibiTop();
    broadcastHabibiTop();
  }
  function addHabibiTopDonation(user, coins) {
    if (!user?.uniqueId || !(coins > 0)) return;
    const period = getHabibiTopPeriod();
    const incomingPhoto = habibiDonorPhoto(user);
    if (period === 'live') {
      const u = habibiTopSession.get(user.uniqueId) || { uniqueId: user.uniqueId, nickname: user.nickname, photo: '', coins: 0 };
      u.coins += coins;
      u.nickname = user.nickname || u.nickname;
      if (incomingPhoto) u.photo = incomingPhoto;
      habibiTopSession.set(user.uniqueId, u);
      broadcastHabibiTop();
      saveSessionOverlays();
      return;
    }
    ensureHabibiTopPeriod();
    const u = habibiTop.donors.get(user.uniqueId) || { uniqueId: user.uniqueId, nickname: user.nickname, photo: '', coins: 0 };
    u.coins += coins;
    u.nickname = user.nickname || u.nickname;
    if (incomingPhoto) u.photo = incomingPhoto;
    habibiTop.donors.set(user.uniqueId, u);
    broadcastHabibiTop();
    saveHabibiTop();
  }
  function serializeHabibiTop() {
    const period = getHabibiTopPeriod();
    let donors;
    if (period === 'live') {
      donors = [...habibiTopSession.values()];
    } else {
      ensureHabibiTopPeriod();
      donors = [...habibiTop.donors.values()];
    }
    const sorted = donors.sort((a, b) => b.coins - a.coins);
    const rawTop = sorted[0] || null;
    const top = buildHabibiTopPayload(rawTop);
    if (top) updateHabibiTopSnapshot(top);
    return {
      top,
      period,
      periodStart: period === 'live' ? 0 : habibiTop.start,
      periodEnd: period === 'live' ? 0 : habibiTop.end,
      now: Date.now(),
    };
  }
  function broadcastHabibiTop() {
    broadcast('habibiTop', serializeHabibiTop());
  }
  function resetHabibiTopSession() {
    if (getHabibiTopPeriod() !== 'live') return;
    habibiTopSession.clear();
    habibiTopSnapshot = null;
    broadcast('habibiTopReset', {});
    broadcastHabibiTop();
  }
  function resetHabibiTopAll() {
    habibiTopSession.clear();
    habibiTop.donors.clear();
    habibiTopSnapshot = null;
    if (getHabibiTopPeriod() !== 'live') saveHabibiTop();
    else saveSessionOverlays();
    broadcast('habibiTopReset', {});
    broadcastHabibiTop();
  }

  /* -------------------- Rankings likes / diamantes (overlays) -------------------- */
  function getRankPeriod(rankId) {
    const p = settings[RANK_SETTINGS_KEY[rankId]]?.resetPeriod;
    return p === 'week' || p === 'month' ? p : 'live';
  }
  // Restaura rankings de sesión (periodo «live») tras reinicio de Render si es el mismo live.
  function canRestoreLiveRank(saved) {
    if (!saved || saved.period !== 'live' || !Array.isArray(saved.users) || !saved.users.length) return false;
    if (saved.roomId && liveSession.roomId) {
      return String(saved.roomId) === String(liveSession.roomId);
    }
    if (saved.username && liveSession.username && liveSession.active) {
      return liveUserMatch(saved.username, liveSession.username);
    }
    return false;
  }
  function restoreLiveRankSession(rankId, saved) {
    rankSession[rankId].clear();
    if (!canRestoreLiveRank(saved)) return;
    for (const u of saved.users) {
      if (u?.uniqueId) rankSession[rankId].set(u.uniqueId, u);
    }
  }
  function loadRankOverlays() {
    const r = readJsonSafe(RANKS_FILE);
    const raw = r.data || {};
    for (const rankId of RANK_IDS) {
      const period = getRankPeriod(rankId);
      lastRankPeriods[rankId] = period;
      rankSession[rankId].clear();
      const saved = raw[rankId];
      if (period === 'live') {
        restoreLiveRankSession(rankId, saved);
        continue;
      }
      const [start, end] = period === 'month' ? currentMonthRange() : currentWeekRange();
      if (saved && saved.period === period && saved.start === start) {
        rankPersist[rankId].period = period;
        rankPersist[rankId].start = start;
        rankPersist[rankId].end = end;
        rankPersist[rankId].users = new Map((saved.users || []).map((u) => [u.uniqueId, u]));
      } else {
        rankPersist[rankId].period = period;
        rankPersist[rankId].start = start;
        rankPersist[rankId].end = end;
        rankPersist[rankId].users = new Map();
      }
    }
  }
  function saveRankOverlays() {
    clearTimeout(rankSaveTimer);
    rankSaveTimer = setTimeout(() => {
      const data = {};
      for (const rankId of RANK_IDS) {
        const period = getRankPeriod(rankId);
        if (period === 'live') {
          data[rankId] = {
            period: 'live',
            roomId: liveSession.roomId || null,
            username: liveSession.username || null,
            users: [...rankSession[rankId].values()],
          };
          continue;
        }
        const p = rankPersist[rankId];
        data[rankId] = { period: p.period, start: p.start, end: p.end, users: [...p.users.values()] };
      }
      writeJsonAtomic(RANKS_FILE, data);
    }, 400);
  }
  function ensureRankPeriod(rankId) {
    const period = getRankPeriod(rankId);
    if (period === 'live') return;
    const [start, end] = period === 'month' ? currentMonthRange() : currentWeekRange();
    const p = rankPersist[rankId];
    if (p.period !== period || p.start !== start) {
      p.period = period;
      p.start = start;
      p.end = end;
      p.users.clear();
      saveRankOverlays();
      broadcastRankState(rankId);
    }
  }
  function onRankPeriodChange(rankId) {
    rankSession[rankId].clear();
    const period = getRankPeriod(rankId);
    lastRankPeriods[rankId] = period;
    if (period === 'live') {
      rankPersist[rankId].users.clear();
      const saved = (readJsonSafe(RANKS_FILE).data || {})[rankId];
      restoreLiveRankSession(rankId, saved);
    } else {
      const [start, end] = period === 'month' ? currentMonthRange() : currentWeekRange();
      rankPersist[rankId].period = period;
      rankPersist[rankId].start = start;
      rankPersist[rankId].end = end;
      rankPersist[rankId].users.clear();
      saveRankOverlays();
    }
    broadcastRankState(rankId);
  }
  function getRankUsers(rankId) {
    if (getRankPeriod(rankId) === 'live') return rankSession[rankId];
    ensureRankPeriod(rankId);
    return rankPersist[rankId].users;
  }
  function addRankValue(rankId, user, delta) {
    if (!user?.uniqueId || !(delta > 0)) return;
    const users = getRankUsers(rankId);
    const u = users.get(user.uniqueId) || { uniqueId: user.uniqueId, nickname: user.nickname, photo: user.photo, val: 0 };
    u.val += delta;
    u.nickname = user.nickname || u.nickname;
    if (user.photo) u.photo = user.photo;
    users.set(user.uniqueId, u);
    saveRankOverlays();
    broadcastRankState(rankId);
  }
  function addRankLikes(user, count) {
    if (!user?.uniqueId || !(count > 0)) return;
    addRankValue('toplikes', user, count);
    addRankValue('toplikeslist', user, count);
  }
  function addRankDiamonds(user, coins) {
    if (!user?.uniqueId || !(coins > 0)) return;
    addRankValue('topdiam', user, coins);
    addRankValue('topdiamlist', user, coins);
  }
  function serializeRankState(rankId) {
    const period = getRankPeriod(rankId);
    const users = getRankUsers(rankId);
    const p = rankPersist[rankId];
    return {
      rank: rankId,
      users: [...users.values()].map((u) => ({ uniqueId: u.uniqueId, nickname: u.nickname, photo: u.photo, val: u.val })),
      period,
      periodStart: period === 'live' ? 0 : p.start,
      periodEnd: period === 'live' ? 0 : p.end,
      now: Date.now(),
    };
  }
  function broadcastRankState(rankId) {
    broadcast('rankState', serializeRankState(rankId));
  }
  function broadcastAllRankStates() {
    for (const rankId of RANK_IDS) broadcastRankState(rankId);
  }
  function resetRankSession(rankId) {
    if (!RANK_IDS.includes(rankId) || getRankPeriod(rankId) !== 'live') return;
    rankSession[rankId].clear();
    saveRankOverlays();
    broadcast('rankReset', { rank: rankId });
    broadcastRankState(rankId);
  }
  function resetRankAll(rankId) {
    if (!RANK_IDS.includes(rankId)) return;
    rankSession[rankId].clear();
    if (getRankPeriod(rankId) !== 'live') {
      rankPersist[rankId].users.clear();
    }
    saveRankOverlays();
    broadcast('rankReset', { rank: rankId });
    broadcastRankState(rankId);
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
  function donorLevelForUid(uid) {
    const key = String(uid || '').trim().replace(/^@/, '').toLowerCase();
    if (!key) return 0;
    const u = points.get(key);
    if (!u) return 0;
    return levelForPoints(u.levelPoints);
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
      scheduleSaveEmotesCatalog();
      broadcast('emoteCatalog', { results: [...emoteCatalog.values()] });
      if (!prev) broadcast('log', { level: 'info', text: `🙂 Sticker guardado (#${eid.slice(-6)})` });
    }
  }

  // TikTok envía stickers en varios formatos según el conector / tipo de mensaje:
  // emoteList (EMOTE), emotes[].emote (CHAT protobuf), emotes[].emoteId (legacy/simplificado).
  function extractEmotes(data) {
    const out = [];
    const seen = new Set();
    const addRaw = (item) => {
      if (!item || typeof item !== 'object') return;
      const eid = emoteIdFrom(item);
      if (!eid || seen.has(eid)) return;
      seen.add(eid);
      out.push({ emoteId: eid, image: item.emoteImageUrl || item.image || null });
    };
    if (Array.isArray(data?.emoteList)) {
      for (const e of data.emoteList) addRaw(e);
    }
    if (Array.isArray(data?.emotes)) {
      for (const se of data.emotes) {
        if (se?.emote) addRaw(se.emote);
        else addRaw(se);
      }
    }
    if (!out.length) addRaw(data);
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
      const comment = data.comment || '';
      const chatKey = chatEventKey(data, comment);
      if (!consumeChatOnce(chatKey)) return;
      state.stats.comments++;
      const msgId = data?.common?.msgId || '';
      const chatUser = baseUser(data.user || data);
      const roles = chatUserRoles(data);
      const ptsDonor = donorLevelForUid(chatUser.uniqueId);
      const donorLevel = roles.gifterLevel > 0 ? roles.gifterLevel : ptsDonor;
      const donorSource = roles.gifterLevel > 0 ? 'tiktok' : (ptsDonor > 0 ? 'points' : '');
      broadcast('chat', { ...chatUser, comment, msgId: msgId && String(msgId) !== '0' ? String(msgId) : chatKey, ...roles, donorLevel, donorSource });
      pushStatsThrottled();
      checkMemberLevelUp(data);
      fireEmoteTriggers(data);
      const chatInfo = { comment, username: chatUser.uniqueId, nickname: chatUser.nickname };
      triggerVideos('chatCommand', chatInfo);
      triggerSoundAlerts('chatCommand', chatInfo);
      actions.triggerActions('chatCommand', chatInfo);
      handleChatCommands(comment, chatUser);
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
      if (image && giftId) {
        const sid = String(giftId);
        const prev = giftsById.get(sid);
        giftsById.set(sid, {
          id: sid,
          name: giftName || prev?.name || 'Regalo',
          diamonds: diamondsEach || prev?.diamonds || 0,
          image,
        });
      }
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
        addTop1FireDonation(user, total);
        addHabibiTopDonation(user, total);
        addRankDiamonds(user, total);
        // Usuario y Puntos: acumula los puntos donados de por vida (configurable: puntos por moneda).
        if (user.uniqueId && total > 0) {
          const perCoin = Number(settings.points?.perCoin);
          const award = Math.round(total * (Number.isFinite(perCoin) && perCoin > 0 ? perCoin : 1));
          if (award > 0) addUserPoints({ uniqueId: user.uniqueId, nickname: user.nickname, photo: user.photo, amount: award, counted: true, description: `Regalo: ${giftName}`, manual: false });
        }
        pushState();
        flushStreamerRank();

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
        trackSessionGift(user, giftName, repeatCount, diamondsEach, image);
      }

      triggerGiftGameActions(user, giftId, repeatCount, !!data.repeatEnd, giftType, giftInfo);

      broadcast('gift', { ...user, giftName, giftId, repeatCount, diamonds: diamondsEach, image, streak: isStreak });
      checkMemberLevelUp(data);
    });

    conn.on(WebcastEvent.LIKE, (data) => {
      state.stats.likes = data.totalLikeCount ?? state.stats.likes + (data.likeCount || 0);
      addTimerSeconds(((data.likeCount || 0) / 100) * (settings.timer?.like || 0));
      processFanBalls('likes', baseUser(data.user), data.likeCount || 0);
      addRankLikes(baseUser(data.user), data.likeCount || 0);
      trackSessionLike(baseUser(data.user), data.likeCount || 0);
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
      flushStreamerRank();
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
      const dt = socialDisplayType(data);
      if (dt.includes('unfollow') || action.includes('unfollow')) bumpFollowerCounter(-1, data);
      if (action.includes('follow')) {
        state.stats.follows++;
        broadcast('follow', user);
        triggerVideos('follow');
        triggerSoundAlerts('follow');
        actions.triggerActions('follow');
        actions.triggerMinecraftActions('follow', {}, user);
        if (timerEventOnce('follow', user.uniqueId)) addTimerSeconds(settings.timer?.follow || 0);
        const c = settings.hypeBar || {};
        trackSessionHypeEvent('follow', Math.max(1, parseInt(c.pointsFollow, 10) || 1));
      } else if (action.includes('share')) {
        state.stats.shares++;
        broadcast('share', user);
        triggerVideos('share');
        triggerSoundAlerts('share');
        actions.triggerActions('share');
        actions.triggerMinecraftActions('share', {}, user);
        if (timerEventOnce('share', user.uniqueId)) addTimerSeconds(settings.timer?.share || 0);
        const c = settings.hypeBar || {};
        trackSessionHypeEvent('share', Math.max(1, parseInt(c.pointsShare, 10) || 1));
      }
      pushStatsThrottled();
    });

    conn.on(WebcastEvent.FOLLOW, (data) => {
      const user = baseUser(data.user);
      bumpFollowerCounter(1, data);
      state.stats.follows++;
      broadcast('follow', user);
      triggerSoundAlerts('follow');
      actions.triggerActions('follow');
      actions.triggerMinecraftActions('follow', {}, user);
      if (timerEventOnce('follow', user.uniqueId)) addTimerSeconds(settings.timer?.follow || 0);
      const c = settings.hypeBar || {};
      trackSessionHypeEvent('follow', Math.max(1, parseInt(c.pointsFollow, 10) || 1));
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
      case 'switchGeneralProfile':
        switchToGeneralEdit();
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
      case 'testMcDraft': {
        const entry = data.entry;
        if (!entry || !actions.mcCmdText(entry)) break;
        const draft = {
          name: 'Prueba modal',
          custom: true,
          cmdsExtra: !!data.cmdsExtra,
          cmds: [entry],
          repeat: 1,
          random: false,
          radius: data.radius != null ? data.radius : 3,
        };
        if (data.giftMult === false) draft.giftMult = false;
        actions.runMcAction(draft, actions.buildMcVars(
          { giftName: 'Prueba', giftId: '5655', diamonds: 1, repeatCount: 1, comment: 'Prueba' },
          { nickname: 'Prueba', uniqueId: 'prueba' },
        ));
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
          emitMedia({ ...data.video, screen: scr, size: screenSize(scr), test: true });
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
      case 'testLevelVideo':
        playLevelVideo(Math.max(1, Number(data.level) || 1), { test: true });
        break;
      case 'stopVideo': {
        const scr = Number(data.screen) || 1;
        emitStopMedia({ screen: scr });
        break;
      }
      case 'testScreen': {
        const scr = Number(data.screen) || 1;
        emitMedia({ test: true, screenTest: true, name: 'Pantalla ' + scr, screen: scr, size: screenSize(scr) });
        break;
      }
      // Pruebas manuales de juegos: la nube delega la ejecución al .exe (relay) vía localExec.
      case 'marioSpawn':
        actions.spawnMarioThing(String(data.thing || ''), data.name, data.times);
        break;
      case 'marioEffect':
        actions.applyMarioEffect(String(data.type || ''), data.seconds, data.factor);
        break;
      case 'smb3Spawn':
        actions.spawnSmb3Thing(data.thing, data.spawnId ?? data.spawn, data.npcId, data.name ?? data.viewer, data.times ?? data.count);
        break;
      case 'smb3Effect':
        actions.applySmb3Effect(String(data.effect || data.type || ''), data.name ?? data.viewer, data.seconds);
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
        emitPanicMedia();
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
      case 'testTop1Fire':
        broadcast('top1fireTest', {});
        break;
      case 'resetTop1Fire':
        resetTop1FireAll();
        break;
      case 'testTopHabibi':
        broadcast('habibiTopTest', {});
        break;
      case 'resetTopHabibi':
        resetHabibiTopAll();
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
        resetRankAll(data.rank);
        break;
      case 'testRankAlt':
        broadcast('rankAltTest', {});
        break;
      case 'resetRankAlt':
        resetRankAll('toplikes');
        resetRankAll('topdiam');
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
      case 'testFollowerCounter':
        broadcast('followerCounter', { count: 1234, nickname: 'PreviewFan', uniqueId: 'previewfan', photo: '', ready: true });
        break;
      case 'resetFollowerCounter':
        resetFollowerCounterFromRoom();
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
    try { ws.send(JSON.stringify({ type: 'profiles', payload: profilesInfo() })); } catch (e) { console.error('[profiles]', e); }
    ws.send(JSON.stringify({ type: 'battle', payload: serializeBattle() }));
    ws.send(JSON.stringify({ type: 'screens', payload: { connected: [...new Set(videoScreens.values())] } }));
    ws.send(JSON.stringify({ type: 'weeklyTop', payload: serializeWeeklyTop() }));
    ws.send(JSON.stringify({ type: 'top1fire', payload: serializeTop1Fire() }));
    ws.send(JSON.stringify({ type: 'habibiTop', payload: serializeHabibiTop() }));
    for (const rankId of RANK_IDS) {
      ws.send(JSON.stringify({ type: 'rankState', payload: serializeRankState(rankId) }));
    }
    ws.send(JSON.stringify({ type: 'pointsList', payload: serializePoints() }));
    ws.send(JSON.stringify({ type: 'timer', payload: serializeTimer() }));
    ws.send(JSON.stringify({ type: 'giftCounter', payload: serializeGiftCounter() }));
    ws.send(JSON.stringify({ type: 'sessionOverlays', payload: serializeSessionOverlaysPayload() }));
    ws.send(JSON.stringify({ type: 'followerCounter', payload: serializeFollowerCounter() }));
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
    flushStreamerRank();
    stopRankStreamerTimer();
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
    try { saveSessionOverlaysNow(); } catch {}
    clearTimeout(emotesSaveTimer);
    try { saveEmotesCatalogNow(); } catch {}
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
      nickname: followerCounter.nickname || state.username || null,
      photo: followerCounter.photo || '',
      viewers: Number(state.stats?.viewers) || 0,
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
    getEmotes, mergeEmotes, shutdown, getStatus, kickAll, broadcastCaps,
    getSettings: () => settings,
    applySettings: (obj) => applyIncomingSettings(obj, false),
    hasSavedSettings: () => fs.existsSync(SETTINGS_FILE),
    getProfilesInfo: profilesInfo,
    getProfilesFull,
    switchProfile,
    switchToGeneralEdit,
    renameProfile,
    importProfiles,
    spotifyCharge,
    get clientCount() { return clients.size; },
  };
}
