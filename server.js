// HOKEY LIVE — servidor multiusuario.
// Cada usuario registrado tiene su propia "room": conexión a TikTok, ajustes, estado,
// batalla y overlays totalmente aislados (ver room.js). Aquí solo va lo compartido:
// catálogo de regalos, archivos estáticos, autenticación y el enrutado de WebSockets.
import { eulerStartupLine } from './euler-config.js';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { TikTokLiveConnection } from 'tiktok-live-connector';
import { createRoom } from './room.js';
import { isEdgeTtsVoice, ttsSynthEdge } from './edge-tts-synth.js';
import { createStreamerRankings } from './streamer-rankings.js';
import {
  registerUser, verifyLogin, createSession, destroySession,
  userFromRequest, getUserByRoomKey, getUserById, getUserByUsername, listUsers, listUsersDetailed,
  isUserActive, setUserActive, touchLogin,
  getUserPlan, setUserPlan, setUserGamesEnabled, isUserGamesEnabled, deleteUser, upsertMirrorUser, updateMirrorPlan, updateMirrorCloudRoomKey,
  sessionCookie, clearCookie, parseCookies, SESSION_COOKIE,
  remapSessionUserIds, importSessionsFromRecord, pruneInvalidSessions, hasAnyValidSession,
  saveDesktopLastLogin, clearDesktopLastLogin, bootstrapDesktopSessionToken, ensureSessionForUser,
  inferDesktopLastLoginFromUsers, getSessionUser, getDesktopLastLoginUser,
  publicEmailFields, setUserVerifiedEmail,
} from './auth.js';
import {
  requestLinkEmailCode, verifyLinkEmailCode,
  requestPasswordReset, resetPasswordWithCode, mailStatus,
  requestRegisterEmailCode, consumeRegisterEmailCode,
} from './account-recovery.js';
import {
  CAPABILITIES, getPlanConfig, savePlanConfig, effectiveCaps, adminCaps,
} from './plans.js';
import * as spotify from './spotify.js';
import { testRcon, testObs, testStreamerbot, testServertap } from './integrations.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const IS_RENDER = !!(process.env.RENDER || process.env.RENDER_SERVICE_ID || process.env.RENDER_EXTERNAL_URL);

// En Render NO cargamos ffmpeg ni bridges de juegos (pesan y matan el plan de 512MB).
const desk = IS_RENDER
  ? await import('./cloud-desktop-stubs.js')
  : await import('./cloud-desktop-full.js');
const {
  ffmpegPath,
  stopMarioBridge,
  stopPvzHybridBridge,
  stopRepoBridge, ensureRepoBridge, repoBridgeHealth, repoBridgeHealthOk, repoBridgeStatus,
  getRepoGameDirConfig, setRepoGameDir, installRepoMod, uninstallRepoMod,
  stopL4dBridge, l4dBridgeHealth, l4dBridgeStatus, getL4dGameDirConfig, setL4dGameDir,
  discoverL4dGameDir, syncL4dGameDir, installL4dMod, uninstallL4dMod,
  stopUnturnedBridge, unturnedBridgeHealth, unturnedBridgeStatus,
  getUnturnedGameDirConfig, setUnturnedGameDir, discoverUnturnedSteamDir, syncUnturnedGameDir,
  installUnturnedMod, uninstallUnturnedMod,
  ensureMcCoreLicense, mcCoreLicenseStatus, stopMcCoreBridge,
  ctrBridgeHealth, ensureCtrBridge, ctrBridgeStatus,
  ensureSmwBridge, smwBridgeHealth, smwBridgeStatus, installSmwMod, uninstallSmwMod,
  mslugBridgeHealth, mslugBridgeStatus, getMslugGameDirConfig, setMslugGameDir,
  getMslugLastSpawn, MSLUG_BRIDGE_VERSION,
  installMslugMod, uninstallMslugMod, ensureMslugBridge,
  ensureMslugSpawnWebhook, isMslugSpawnWebhookUp, mslugSpawnWebhookStatus,
  isMslug7760WebhookUrl, runMslug7760WebhookExec,
  ensureSmbxTiktokWebhook, stopSmbxTiktokWebhook, runWebhookExec, smbxTiktokWebhookStatus,
  isMari0EnemySpawnWebhook,
  runGameExec, smb3HealthOk,
  ensureMarioBridge, ensureMari0Bridge, marioBridgeStatus, bridgeHealthOk,
  ensurePvzHybridBridge, pvzHybridBridgeStatus, pvzHybridBridgeHealth, pvzHybridBridgeHealthOk, findPvzToolsExe,
  ensurePvzToolkitBridge, pvzToolkitBridgeStatus, pvzToolkitBridgeHealth, pvzToolkitBridgeHealthOk, stopPvzToolkitBridge,
} = desk;
// En hosting (Render) usamos un DISCO PERSISTENTE montado en la ruta de DATA_DIR
// (ej. /var/data) para que usuarios y configuraciones NO se borren al redesplegar.
// En local, si no existe la variable, se usa la carpeta "data" del proyecto.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const streamerRankings = createStreamerRankings(DATA_DIR);
const IS_DESKTOP = process.env.DESKTOP === '1';

/* -------------------- Migración de datos legacy (.exe) -------------------- */
// Al renombrar la app (Hokey → Livecoins) cambió la carpeta de AppData y se
// generaron IDs de usuario nuevos. Los perfiles viejos quedaron en la carpeta
// anterior. Esta rutina los recupera por nombre de usuario SIN borrar nada.
const DESKTOP_LEGACY_DATA_ROOTS = IS_DESKTOP ? [
  path.join(process.env.APPDATA || '', 'hokey-desktop', 'data'),
  path.join(process.env.APPDATA || '', 'Hokey Live', 'data'),
  path.join(process.env.LOCALAPPDATA || '', 'hokey-desktop', 'data'),
  path.join(process.env.LOCALAPPDATA || '', 'Hokey Live', 'data'),
  path.join(__dirname, 'data'), // versión antigua que guardaba dentro del instalador
].filter((p, i, a) => p && a.indexOf(p) === i) : [];

function profileUsedCount(profilesPath) {
  try {
    const p = JSON.parse(fs.readFileSync(profilesPath, 'utf8'));
    return Array.isArray(p?.slots) ? p.slots.filter((s) => s != null).length : 0;
  } catch { return 0; }
}

function writeJsonAtomicSimple(file, obj) {
  try {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, file);
  } catch {}
}

function mergeProfilesData(legacy, current) {
  if (!legacy || !Array.isArray(legacy.slots)) return current;
  if (!current || !Array.isArray(current.slots)) return legacy;
  const merged = {
    active: Number.isInteger(current.active) ? current.active : (legacy.active || 0),
    names: [],
    slots: [],
    general: current?.general ?? legacy?.general ?? null,
    editMode: current?.editMode === 'general' ? 'general' : 'profile',
  };
  for (let i = 0; i < 10; i++) {
    const ls = legacy.slots[i];
    const cs = current.slots[i];
    const lSize = ls ? JSON.stringify(ls).length : 0;
    const cSize = cs ? JSON.stringify(cs).length : 0;
    merged.slots[i] = lSize >= cSize ? ls : cs;
    if (lSize > 0 && cSize > 0) merged.slots[i] = lSize >= cSize ? ls : cs;
    const ln = String(legacy.names?.[i] || '').trim();
    const cn = String(current.names?.[i] || '').trim();
    const def = `Perfil ${i + 1}`;
    merged.names[i] = (cn && cn !== def) ? cn : ((ln && ln !== def) ? ln : (cn || ln || def));
  }
  if (!Number.isInteger(merged.active) || merged.active < 0 || merged.active >= 10) merged.active = 0;
  return merged;
}

function migrateUserDataFromLegacyDir(legacyDir, currentDir) {
  if (!fs.existsSync(legacyDir)) return;
  fs.mkdirSync(currentDir, { recursive: true });
  const files = ['profiles.json', 'settings.json', 'weekly.json', 'points.json', 'emotes.json'];
  for (const name of files) {
    const from = path.join(legacyDir, name);
    const to = path.join(currentDir, name);
    if (!fs.existsSync(from)) continue;
    if (name === 'profiles.json') {
      let legacy = null;
      let current = null;
      try { legacy = JSON.parse(fs.readFileSync(from, 'utf8')); } catch {}
      if (fs.existsSync(to)) { try { current = JSON.parse(fs.readFileSync(to, 'utf8')); } catch {} }
      const merged = mergeProfilesData(legacy, current);
      const before = current ? profileUsedCount(to) : 0;
      const after = (merged.slots || []).filter((s) => s != null).length;
      if (after > before || !fs.existsSync(to)) {
        if (fs.existsSync(to)) {
          try { fs.copyFileSync(to, to + '.bak-' + Date.now()); } catch {}
        }
        writeJsonAtomicSimple(to, merged);
        console.log(`  [migrate] Perfiles fusionados: ${before} → ${after} ranuras (${path.basename(currentDir)})`);
      }
      continue;
    }
    if (!fs.existsSync(to)) {
      try { fs.copyFileSync(from, to); } catch {}
      continue;
    }
    if (name === 'settings.json') {
      try {
        const fromSize = fs.statSync(from).size;
        const toSize = fs.statSync(to).size;
        if (fromSize > toSize + 512) {
          try { fs.copyFileSync(to, to + '.bak-' + Date.now()); } catch {}
          fs.copyFileSync(from, to);
        }
      } catch {}
    }
  }
}

function migrateDesktopLegacyData() {
  if (!IS_DESKTOP || !DESKTOP_LEGACY_DATA_ROOTS.length) return;
  const currentRoot = path.resolve(DATA_DIR);
  let currentUsers = [];
  try { currentUsers = JSON.parse(fs.readFileSync(path.join(currentRoot, 'users.json'), 'utf8')); } catch {}
  if (!Array.isArray(currentUsers)) currentUsers = [];

  for (const legacyRootRaw of DESKTOP_LEGACY_DATA_ROOTS) {
    const legacyRoot = path.resolve(legacyRootRaw);
    if (legacyRoot === currentRoot || !fs.existsSync(legacyRoot)) continue;

    let legacyUsers = [];
    try { legacyUsers = JSON.parse(fs.readFileSync(path.join(legacyRoot, 'users.json'), 'utf8')); } catch {}
    if (!Array.isArray(legacyUsers)) legacyUsers = [];

    for (const cur of currentUsers) {
      const leg = legacyUsers.find((u) => u.username === cur.username);
      if (!leg) continue;
      migrateUserDataFromLegacyDir(path.join(legacyRoot, leg.id), path.join(currentRoot, cur.id));
    }

    // Si aún no hay users.json local pero sí legacy, copiamos cuentas y datos intactos.
    if (!currentUsers.length && legacyUsers.length) {
      for (const f of ['users.json', 'sessions.json', 'remote-cookies.json', 'plans.json', 'local-caps.json']) {
        const from = path.join(legacyRoot, f);
        const to = path.join(currentRoot, f);
        if (fs.existsSync(from) && !fs.existsSync(to)) {
          try { fs.copyFileSync(from, to); } catch {}
        }
      }
      for (const leg of legacyUsers) {
        migrateUserDataFromLegacyDir(path.join(legacyRoot, leg.id), path.join(currentRoot, leg.id));
      }
      console.log('  [migrate] Datos legacy importados desde', legacyRoot);
    }
  }
}

function migrateDesktopUserByUsername(username, userId) {
  if (!IS_DESKTOP || !username || !userId) return;
  const currentDir = path.join(DATA_DIR, userId);
  const profilesPath = path.join(currentDir, 'profiles.json');
  const before = profileUsedCount(profilesPath);
  for (const legacyRootRaw of DESKTOP_LEGACY_DATA_ROOTS) {
    const legacyRoot = path.resolve(legacyRootRaw);
    if (legacyRoot === path.resolve(DATA_DIR) || !fs.existsSync(legacyRoot)) continue;
    try {
      const list = JSON.parse(fs.readFileSync(path.join(legacyRoot, 'users.json'), 'utf8'));
      if (!Array.isArray(list)) continue;
      const leg = list.find((u) => u.username === username);
      if (leg) {
        migrateUserDataFromLegacyDir(path.join(legacyRoot, leg.id), currentDir);
        break;
      }
    } catch {}
  }
  const after = profileUsedCount(profilesPath);
  if (after > before) {
    // Si la room ya estaba en memoria, forzamos recarga desde disco.
    try { if (rooms?.has?.(userId)) rooms.delete(userId); } catch {}
  }
}

function reconcileDesktopSessions() {
  if (!IS_DESKTOP) return;
  const currentRoot = path.resolve(DATA_DIR);
  let currentUsers = [];
  try { currentUsers = JSON.parse(fs.readFileSync(path.join(currentRoot, 'users.json'), 'utf8')); } catch {}
  if (!Array.isArray(currentUsers)) currentUsers = [];

  for (const legacyRootRaw of DESKTOP_LEGACY_DATA_ROOTS) {
    const legacyRoot = path.resolve(legacyRootRaw);
    if (legacyRoot === currentRoot || !fs.existsSync(legacyRoot)) continue;

    let legacyUsers = [];
    let legacySessions = {};
    try { legacyUsers = JSON.parse(fs.readFileSync(path.join(legacyRoot, 'users.json'), 'utf8')); } catch {}
    try { legacySessions = JSON.parse(fs.readFileSync(path.join(legacyRoot, 'sessions.json'), 'utf8')); } catch {}
    if (!Array.isArray(legacyUsers)) legacyUsers = [];
    if (!legacySessions || typeof legacySessions !== 'object') legacySessions = {};

    const idMap = new Map();
    for (const leg of legacyUsers) {
      const cur = currentUsers.find((u) => u.username === leg.username);
      if (cur && cur.id !== leg.id) idMap.set(leg.id, cur.id);
    }
    if (idMap.size) remapSessionUserIds(idMap);

    if (!hasAnyValidSession() && Object.keys(legacySessions).length) {
      const remapped = {};
      for (const [token, s] of Object.entries(legacySessions)) {
        if (!s?.userId) continue;
        const uid = idMap.get(s.userId) || s.userId;
        remapped[token] = { ...s, userId: uid };
      }
      importSessionsFromRecord(remapped);
    }
  }

  pruneInvalidSessions();
  inferDesktopLastLoginFromUsers();
  const token = bootstrapDesktopSessionToken();
  if (token) console.log('  [auth] Sesión de escritorio restaurada tras actualización.');
}

if (IS_DESKTOP) {
  migrateDesktopLegacyData();
  reconcileDesktopSessions();
}

/* ----------------------------------------------------------------------------
 * Catálogo de regalos de TikTok (compartido por todos los usuarios). Cacheado.
 * --------------------------------------------------------------------------*/
let giftsCache = null;
let giftsCacheAt = 0;
const giftsById = new Map(); // id -> { id, name, diamonds, image }
const giftsCacheByRegion = new Map(); // region -> { results, at }

const GIFT_REGION_PARAMS = {
  auto: {},
  MX: { region: 'MX', priority_region: 'MX', app_language: 'es', browser_language: 'es-MX', webcast_language: 'es', tz_name: 'America/Mexico_City' },
  US: { region: 'US', priority_region: 'US', app_language: 'en', browser_language: 'en-US', webcast_language: 'en', tz_name: 'America/New_York' },
  ES: { region: 'ES', priority_region: 'ES', app_language: 'es', browser_language: 'es-ES', webcast_language: 'es', tz_name: 'Europe/Madrid' },
  AR: { region: 'AR', priority_region: 'AR', app_language: 'es', browser_language: 'es-AR', webcast_language: 'es', tz_name: 'America/Buenos_Aires' },
  CO: { region: 'CO', priority_region: 'CO', app_language: 'es', browser_language: 'es-CO', webcast_language: 'es', tz_name: 'America/Bogota' },
};

function normalizeGiftRegion(raw) {
  const r = String(raw || 'auto').trim();
  if (!r || r.toLowerCase() === 'auto') return 'auto';
  const up = r.toUpperCase();
  return GIFT_REGION_PARAMS[up] ? up : 'auto';
}

// Catálogo FIJO de respaldo (gifts.json). TikTok devuelve regalos distintos según la
// región/IP del servidor; usamos este archivo como BASE y lo fusionamos con el fetch
// en vivo para no perder ningún regalo (sobre todo en la web/Render).
function loadGiftBaseFile() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'gifts.json'), 'utf8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

async function loadGiftCatalog(force = false, region = 'auto') {
  const regionKey = normalizeGiftRegion(region);
  const cached = giftsCacheByRegion.get(regionKey);
  if (!force && cached && Date.now() - cached.at < 6 * 60 * 60 * 1000) {
    if (regionKey === 'auto') {
      giftsCache = cached.results;
      giftsCacheAt = cached.at;
    }
    return cached.results;
  }
  // Base: catálogo fijo del archivo (el mismo que ve el .exe).
  const merged = new Map();
  for (const g of loadGiftBaseFile()) {
    if (g && g.name) merged.set(String(g.id), g);
  }
  // Fusiona con el catálogo en vivo (añade/actualiza los que TikTok devuelva ahora).
  try {
    const webParams = GIFT_REGION_PARAMS[regionKey] || {};
    const tmp = new TikTokLiveConnection('tv_asahi_news', { webClientParams: webParams });
    const gifts = await tmp.fetchAvailableGifts();
    for (const g of (Array.isArray(gifts) ? gifts : [])) {
      if (!g || !g.name) continue;
      merged.set(String(g.id), {
        id: g.id,
        name: g.name,
        diamonds: g.diamond_count ?? g.diamondCount ?? 0,
        image: g.image?.url_list?.[0] || g.icon?.url_list?.[0] || (typeof g.image === 'string' ? g.image : ''),
      });
    }
  } catch (e) {
    // Si el fetch falla, nos quedamos solo con el catálogo fijo del archivo.
    if (!merged.size) throw e;
  }
  const results = [...merged.values()].sort((a, b) => a.diamonds - b.diamonds);
  const at = Date.now();
  giftsCacheByRegion.set(regionKey, { results, at });
  if (regionKey === 'auto') {
    giftsCache = results;
    giftsCacheAt = at;
    for (const g of results) giftsById.set(String(g.id), g);
  }
  return results;
}

function mergeGiftLists(base, extra) {
  const byId = new Map();
  const order = [];
  for (const g of extra || []) {
    const id = String(g.id);
    if (!id) continue;
    if (!byId.has(id)) order.push(id);
    byId.set(id, { ...byId.get(id), ...g });
  }
  const sortedBase = [...(base || [])].sort((a, b) => (a.diamonds - b.diamonds) || String(a.name).localeCompare(String(b.name)));
  for (const g of sortedBase) {
    const id = String(g.id);
    if (!id) continue;
    if (!byId.has(id)) order.push(id);
    byId.set(id, { ...byId.get(id), ...g });
  }
  return order.map((id) => byId.get(id));
}

loadGiftCatalog(false, 'auto').then((r) => {
  console.log(`Catálogo de regalos cargado: ${r.length} regalos.`);
}).catch(() => {
  console.log('Aviso: no se pudo precargar el catálogo de regalos (se reintenta al usarlo).');
});

/* ----------------------------------------------------------------------------
 * Registro de rooms (una por usuario)
 * --------------------------------------------------------------------------*/
const rooms = new Map(); // userId -> room

// Capacidades efectivas de un usuario (límites + features según su plan). El admin
// tiene todo abierto. Se recalcula siempre desde el plan actual del usuario.
// Capacidades EXCLUSIVAS del .exe (no existen en el servidor remoto/web). El admin
// las gestiona localmente: el catálogo remoto no las conoce, así que las inyectamos
// aquí para que aparezcan en el editor de planes y se puedan marcar premium/gratis.
const LOCAL_ONLY_TABS = [
  { key: 'tab_webhook', label: 'Pestaña Webhook y Configuración (.exe)' },
];
// Minijuegos: exclusivos del .exe (pestaña "Juegos"). Se bloquean como los overlays.
const LOCAL_ONLY_GAMES = [
  { key: 'game_minecraft', label: 'Juego: Minecraft' },
  { key: 'game_mcservidor', label: 'Juego: Servidor Minecraft' },
  { key: 'game_bedrock', label: 'Juego: Bedrock (Cubo TNT)' },
  { key: 'game_sandbox', label: 'Juego: Sandbox' },
  { key: 'game_roblox', label: 'Juego: Roblox' },
  { key: 'game_roblox3', label: 'Juego: Roblox parkour' },
  { key: 'game_mariobros', label: 'Juego: Mario Bros' },
  { key: 'game_smb3', label: 'Juego: Super Mario Bros. 3' },
  { key: 'game_mari0', label: 'Juego: Mari0' },
  { key: 'game_plantasvszombies', label: 'Juego: Plants vs Zombies' },
  { key: 'game_pvzhybrid', label: 'Juego: Plants vs Zombies Pack' },
  { key: 'game_repo', label: 'Juego: R.E.P.O.' },
  { key: 'game_l4d', label: 'Juego: Left 4 Dead' },
  { key: 'game_unturned', label: 'Juego: Unturned' },
  { key: 'game_crashctr', label: 'Juego: Crash Team Racing (CTR)' },
];
const LOCAL_ONLY_KEYS = [...LOCAL_ONLY_TABS, ...LOCAL_ONLY_GAMES].map((t) => t.key);
const LOCAL_CAPS_FILE = path.join(DATA_DIR, 'local-caps.json');

function loadLocalCaps() {
  try { return JSON.parse(fs.readFileSync(LOCAL_CAPS_FILE, 'utf8')); }
  catch { return { free: {}, premium: {} }; }
}
let localCaps = loadLocalCaps();

function saveLocalCapsFromBody(body) {
  for (const plan of ['free', 'premium']) {
    if (!localCaps[plan]) localCaps[plan] = {};
    const feats = body && body[plan] && body[plan].features;
    if (!feats) continue;
    for (const k of LOCAL_ONLY_KEYS) {
      if (feats[k] !== undefined) localCaps[plan][k] = !!feats[k];
    }
  }
  try { fs.writeFileSync(LOCAL_CAPS_FILE, JSON.stringify(localCaps, null, 2)); } catch {}
}

// Inyecta las capacidades locales en la respuesta de /api/admin/plans (catálogo + valores),
// para que el editor del admin las muestre aunque el remoto no las conozca.
function injectLocalCaps(data) {
  if (!data || typeof data !== 'object') return data;
  if (data.catalog && Array.isArray(data.catalog.tabs)) {
    for (const t of LOCAL_ONLY_TABS) {
      if (!data.catalog.tabs.some((x) => x.key === t.key)) data.catalog.tabs.push({ ...t });
    }
  }
  if (data.catalog) {
    if (!Array.isArray(data.catalog.games)) data.catalog.games = [];
    for (const g of LOCAL_ONLY_GAMES) {
      if (!data.catalog.games.some((x) => x.key === g.key)) data.catalog.games.push({ ...g });
    }
  }
  if (data.config) {
    for (const plan of ['free', 'premium']) {
      if (!data.config[plan]) data.config[plan] = { limits: {}, features: {} };
      if (!data.config[plan].features) data.config[plan].features = {};
      for (const k of LOCAL_ONLY_KEYS) {
        const local = localCaps[plan] && localCaps[plan][k];
        data.config[plan].features[k] = local !== undefined ? local : (data.config[plan].features[k] !== false);
      }
    }
  }
  return data;
}

function capsForUser(user) {
  if (!user) return applyLocalCaps(effectiveCaps('free'), 'free');
  if (user.isAdmin) return adminCaps();
  const plan = getUserPlan(user) === 'premium' ? 'premium' : 'free';
  const caps = applyLocalCaps(effectiveCaps(plan), plan);
  // Override por usuario: el admin puede quitarles todos los minijuegos.
  if (!isUserGamesEnabled(user)) {
    for (const k of Object.keys(caps.features || {})) {
      if (k.startsWith('game_')) caps.features[k] = false;
    }
  }
  return caps;
}

// Sobrescribe las features locales (.exe) según el plan del usuario.
function applyLocalCaps(caps, planName) {
  for (const k of LOCAL_ONLY_KEYS) {
    const v = localCaps[planName] && localCaps[planName][k];
    if (v !== undefined) caps.features[k] = v;
  }
  return caps;
}

// En el .exe con login delegado, el admin guarda planes en Render pero el runtime
// (límites, overlays bloqueados…) lee plans.json LOCAL. Esta función espeja la
// config remota aquí y avisa a los paneles conectados.
function applyPlansMirror(raw) {
  const config = savePlanConfig(raw || {});
  for (const [id, room] of rooms) {
    const u = getUserById(id);
    if (u) room.broadcastCaps?.(capsForUser(u));
  }
  return config;
}

// Al arrancar (o cuando un admin inicia sesión), trae la config de planes desde Render.
async function syncPlansFromRemote() {
  if (!AUTH_REMOTE) return;
  for (const u of listUsers()) {
    const full = getUserById(u.id);
    if (!full?.isAdmin) continue;
    const cookie = remoteCookies.get(u.id);
    if (!cookie) continue;
    try {
      const r = await fetch(`${AUTH_REMOTE}/api/plans`, { headers: { Cookie: cookie } });
      if (!r.ok) continue;
      const data = await r.json();
      if (data.config) {
        savePlanConfig(data.config);
        console.log('  Planes sincronizados desde Render.');
      }
      return;
    } catch {}
  }
}

async function relayRoomActionToRemote(userId, action, body = {}) {
  const cookie = remoteCookies.get(userId);
  if (!cookie || !AUTH_REMOTE) throw new Error('Sin sesión con la nube. Cierra sesión y vuelve a entrar.');
  const apiPath = action === 'disconnect' ? '/api/room/disconnect'
    : action === 'spotify-charge' ? '/api/room/spotify-charge'
    : '/api/room/connect';
  const r = await fetch(`${AUTH_REMOTE}${apiPath}`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (r.status === 401 || r.status === 403) {
    if (remoteCookies.delete(userId)) saveRemoteCookies();
    throw new Error('Sesión con la nube caducada. Cierra sesión y vuelve a entrar.');
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `Error al conectar con la nube (${r.status})`);
  return data;
}

async function relayEmotesFromRemote(userId) {
  const cookie = remoteCookies.get(userId);
  if (!cookie || !AUTH_REMOTE) return [];
  const r = await fetch(`${AUTH_REMOTE}/api/emotes`, { headers: { Cookie: cookie } });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) return [];
  return data.results || [];
}

async function relayCommunityGiftsFromRemote(userId) {
  const cookie = remoteCookies.get(userId);
  if (!cookie || !AUTH_REMOTE) return [];
  const r = await fetch(`${AUTH_REMOTE}/api/community-gifts`, { headers: { Cookie: cookie } });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) return [];
  return data.results || [];
}

function getRoomForUser(user) {
  let room = rooms.get(user.id);
  if (!room) {
    room = createRoom({
      id: user.id,
      username: user.username,
      roomKey: user.roomKey,
      dataDir: path.join(DATA_DIR, user.id),
      giftsById,
      // Resolver del video por nivel (carpeta «niveles»): el room lo usa para auto-reproducir.
      getLevelVideo: (lvl) => findLevelVideoUrl(lvl),
      // El room consulta esto al guardar para no exceder los límites del plan.
      getCaps: () => capsForUser(getUserById(user.id) || user),
      // En el .exe: cada vez que el usuario guarda, replicamos sus ajustes a Render
      // para que también aparezcan en la web (y en otros equipos).
      onUserSave: () => scheduleRemoteSettingsPush(user.id),
      // Modo relay: la conexión a TikTok la hace Render; reenviamos connect/disconnect.
      onRelayAction: (AUTH_REMOTE && process.env.HOKEY_RELAY === '1')
        ? (action, data) => { relayRoomActionToRemote(user.id, action, data).catch((e) => console.error('  [relay]', action, e.message)); }
        : undefined,
      // Modo relay: los puntos viven en la nube. Para !play/!skip con costo, cobramos
      // en Render (fuente de verdad) y solo seguimos si hay saldo suficiente.
      chargeSpotifyRemote: (AUTH_REMOTE && process.env.HOKEY_RELAY === '1')
        ? (payload) => relayRoomActionToRemote(user.id, 'spotify-charge', payload)
        : undefined,
      onStreamerRank: (AUTH_REMOTE && process.env.HOKEY_RELAY === '1') ? undefined : (p) => streamerRankings.record(p),
    });
    rooms.set(user.id, room);
  }
  return room;
}

// Usuarios conectados al panel y EN VIVO en TikTok (directorio para el panel).
// Solo se listan lives reales: conexión activa + audiencia > 0 (o live recién
// iniciado). Con viewers=0 suele ser conexión fantasma / live ya cerrado que
// aún no disparó STREAM_END.
function isActivePanelLiveEntry(stOrLive) {
  const viewers = Number(stOrLive?.viewers) || 0;
  if (viewers > 0) return true;
  const since = Number(stOrLive?.liveSince) || 0;
  return since > 0 && (Date.now() - since) < 90000;
}

function filterActivePanelLives(lives) {
  return (Array.isArray(lives) ? lives : []).filter(isActivePanelLiveEntry);
}

function listPanelLives() {
  const out = [];
  for (const [userId, room] of rooms) {
    const st = room.getStatus();
    if (!st?.live || !st?.account) continue;
    if (!isActivePanelLiveEntry(st)) continue;
    const u = getUserById(userId) || getUserByUsername(room.account) || null;
    const tiktok = String(st.account).replace(/^@+/, '');
    if (!tiktok) continue;
    // Plan efectivo (admin=premium; respeta caducidad). No usar solo u.plan crudo.
    const plan = getUserPlan(u);
    out.push({
      panelUser: u?.username || room.account || '',
      tiktok,
      nickname: st.nickname || tiktok,
      photo: st.photo || '',
      viewers: Number(st.viewers) || 0,
      liveSince: st.liveSince || null,
      plan,
      url: `https://www.tiktok.com/@${encodeURIComponent(tiktok)}/live`,
    });
  }
  out.sort((a, b) => b.viewers - a.viewers || a.tiktok.localeCompare(b.tiktok));
  return out;
}

/** Cuando el .exe trae lives de Render sin `plan` (API vieja), completa con usuarios locales. */
function enrichPanelLivesPlans(lives) {
  return (Array.isArray(lives) ? lives : []).map((l) => {
    const remote = String(l?.plan || '').toLowerCase();
    if (remote === 'premium' || remote === 'admin') return { ...l, plan: 'premium' };
    const u = (l?.panelUser && getUserByUsername(String(l.panelUser))) || null;
    const local = getUserPlan(u);
    return { ...l, plan: local === 'premium' ? 'premium' : (remote || 'free') };
  });
}

// ---- Sincronización de ajustes con el servidor remoto (solo .exe / AUTH_REMOTE) ----
// Filosofía: Render es la fuente compartida. Al abrir el panel traemos (pull) los
// ajustes del usuario desde Render; al guardar, los enviamos (push) a Render.
const pendingSettingsPush = new Map(); // userId -> timeout

function scheduleRemoteSettingsPush(userId) {
  if (!AUTH_REMOTE) return;
  clearTimeout(pendingSettingsPush.get(userId));
  pendingSettingsPush.set(userId, setTimeout(() => {
    pendingSettingsPush.delete(userId);
    pushRemoteProfilesFull(userId).catch(() => {});
  }, 700));
}

async function fetchRemoteProfilesFull(userId) {
  const cookie = remoteCookies.get(userId);
  if (!cookie || !AUTH_REMOTE) return null;
  try {
    const r = await fetch(`${AUTH_REMOTE}/api/profiles/full`, { headers: { Cookie: cookie } });
    if (!r.ok) return null;
    const data = await r.json().catch(() => ({}));
    return data?.profiles || null;
  } catch { return null; }
}

async function pushRemoteProfilesFull(userId) {
  const cookie = remoteCookies.get(userId);
  const room = rooms.get(userId);
  if (!cookie || !room || !AUTH_REMOTE) return;
  const profiles = room.getProfilesFull();
  const r = await fetch(`${AUTH_REMOTE}/api/profiles/full`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ profiles }),
  }).catch(() => null);
  if (r && r.ok) return;
  await fetch(`${AUTH_REMOTE}/api/my-settings`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ settings: room.getSettings() }),
  }).catch(() => {});
}

async function mirrorRelayProfileToLocal(user, data) {
  if (!IS_DESKTOP) return;
  const room = rooms.get(user.id);
  if (!room || typeof room.importProfilesFull !== 'function') return;
  const remoteProfiles = await fetchRemoteProfilesFull(user.id);
  if (remoteProfiles) {
    room.importProfilesFull(remoteProfiles, { silent: true });
    return;
  }
  if (data?.settings) room.applySettings(data.settings);
  const info = data?.profiles;
  if (info && Number.isInteger(info.active) && typeof room.handleMessage === 'function') {
    if (info.editingGeneral) room.handleMessage(null, { action: 'switchGeneralProfile' });
    else room.handleMessage(null, { action: 'switchProfile', index: info.active });
  }
}

async function pullRemoteSettings(user) {
  if (!AUTH_REMOTE) return;
  const cookie = remoteCookies.get(user.id);
  if (!cookie) return;
  if (pendingSettingsPush.has(user.id)) return;
  try {
    const room = getRoomForUser(user);
    const [settingsRes, remoteProfiles] = await Promise.all([
      fetch(`${AUTH_REMOTE}/api/my-settings`, { headers: { Cookie: cookie } }),
      fetchRemoteProfilesFull(user.id),
    ]);
    const settingsData = settingsRes.ok ? await settingsRes.json().catch(() => ({})) : {};
    const localProfiles = room.getProfilesFull();
    const remoteScore = room.profilesFullSyncScore(remoteProfiles || {});
    const localScore = room.profilesFullSyncScore(localProfiles);
    const hasLocal = IS_DESKTOP && desktopHasLocalConfig(user.id);

    if (remoteProfiles && remoteScore > localScore) {
      room.importProfilesFull(remoteProfiles, { silent: true });
      return;
    }
    if (hasLocal) {
      if (localScore > 0 || !settingsData?.exists) {
        scheduleRemoteSettingsPush(user.id);
      } else if (settingsData?.exists && settingsData.settings) {
        room.applySettings(settingsData.settings);
      }
      return;
    }
    if (remoteProfiles) room.importProfilesFull(remoteProfiles, { silent: true });
    else if (settingsData?.exists && settingsData.settings) room.applySettings(settingsData.settings);
    else if (room.hasSavedSettings()) scheduleRemoteSettingsPush(user.id);
  } catch {}
}

function desktopHasLocalConfig(userId) {
  const dir = path.join(DATA_DIR, userId);
  const pf = path.join(dir, 'profiles.json');
  if (fs.existsSync(pf) && profileUsedCount(pf) > 0) return true;
  return fs.existsSync(path.join(dir, 'settings.json'));
}

// Refresca el plan/estado del usuario desde Render (solo .exe). El admin puede
// activar premium en la web mientras el usuario ya está dentro del .exe: aquí
// detectamos el cambio y actualizamos el espejo local + avisamos a su panel para
// que apliquen los nuevos límites (y se desbloqueen los perfiles, etc.) al instante.
async function pullRemotePlan(user) {
  if (!AUTH_REMOTE || !user) return null;
  const cookie = remoteCookies.get(user.id);
  if (!cookie) return null;
  try {
    const r = await fetch(`${AUTH_REMOTE}/api/me`, { headers: { Cookie: cookie } });
    if (r.status === 401 || r.status === 403) {
      remoteCookies.delete(user.id);
      saveRemoteCookies();
      return null;
    }
    if (!r.ok) return null;
    const me = await r.json().catch(() => ({}));
    if (!me || me.plan === undefined) {
      if (me?.roomKey) updateMirrorCloudRoomKey(user.id, me.roomKey);
      return me || null;
    }
    const changed = updateMirrorPlan(user.id, {
      plan: me.plan, isAdmin: me.isAdmin, active: me.active, premiumUntil: me.premiumUntil,
      gamesEnabled: me.gamesEnabled,
    });
    if (changed) {
      const room = rooms.get(user.id);
      if (room) room.broadcastCaps?.(capsForUser(getUserById(user.id) || user));
    }
    if (me.roomKey) updateMirrorCloudRoomKey(user.id, me.roomKey);
    // Devolvemos el "me" remoto para que /api/me pueda exponer la roomKey de la NUBE,
    // que es la que el panel usa para conectar su WebSocket al servidor de Render.
    return me;
  } catch { return null; }
}

// Trae las roomKey de Render para TODOS los usuarios (por nombre) usando la cookie
// de un admin. Así el .exe puede reconectar sin que cada uno cierre sesión.
async function syncAllCloudRoomKeysFromRemote() {
  if (!AUTH_REMOTE) return { updated: 0 };
  let adminCookie = null;
  for (const u of listUsers()) {
    const full = getUserById(u.id);
    if (!full?.isAdmin) continue;
    const c = remoteCookies.get(u.id);
    if (c) { adminCookie = c; break; }
  }
  if (!adminCookie) return { updated: 0 };
  try {
    const r = await fetch(`${AUTH_REMOTE}/api/admin/users`, { headers: { Cookie: adminCookie } });
    if (r.status === 401 || r.status === 403) return { updated: 0 };
    if (!r.ok) return { updated: 0 };
    const data = await r.json().catch(() => ({}));
    let updated = 0;
    for (const remoteUser of data.users || []) {
      if (!remoteUser?.username || !remoteUser.roomKey) continue;
      const local = getUserByUsername(remoteUser.username);
      if (!local) continue;
      if (updateMirrorCloudRoomKey(local.id, remoteUser.roomKey)) updated++;
    }
    if (updated > 0) console.log(`  [cloud] ${updated} roomKey(s) de la nube sincronizadas.`);
    return { updated };
  } catch { return { updated: 0 }; }
}

let cloudKeySyncBusy = false;
async function fetchCloudRoomKeyByUsername(username) {
  if (!AUTH_REMOTE || !username) return null;
  try {
    const r = await fetch(`${AUTH_REMOTE}/api/relay/mirror-room-key`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username }),
    });
    if (!r.ok) return null;
    const data = await r.json().catch(() => ({}));
    return data.roomKey || null;
  } catch { return null; }
}

async function ensureCloudRoomKeyCached(user) {
  const full = getUserById(user.id);
  if (full?.cloudRoomKey || !AUTH_REMOTE) return;
  if (cloudKeySyncBusy) return;
  cloudKeySyncBusy = true;
  try {
    await syncAllCloudRoomKeysFromRemote();
    const again = getUserById(user.id);
    if (again?.cloudRoomKey) return;
    const key = await fetchCloudRoomKeyByUsername(user.username);
    if (key) updateMirrorCloudRoomKey(user.id, key);
  } finally { cloudKeySyncBusy = false; }
}

// El primer usuario que se registra hereda la configuración antigua (settings.json /
// weekly.json en la raíz), para no perder lo que ya tenías ajustado.
function maybeMigrateLegacy(user) {
  if (listUsers().length !== 1) return;
  const dir = path.join(DATA_DIR, user.id);
  fs.mkdirSync(dir, { recursive: true });
  const pairs = [
    [path.join(__dirname, 'settings.json'), path.join(dir, 'settings.json')],
    [path.join(__dirname, 'weekly.json'), path.join(dir, 'weekly.json')],
  ];
  for (const [from, to] of pairs) {
    try { if (fs.existsSync(from) && !fs.existsSync(to)) fs.copyFileSync(from, to); } catch {}
  }
}

/* ----------------------------------------------------------------------------
 * Servidor HTTP + estáticos
 * --------------------------------------------------------------------------*/
// Subidas y bibliotecas locales: disco persistente (userData en .exe). Las carpetas
// dentro del instalador (public/uploads, public/audios, public/video…) se borran al
// actualizar; solo se usan como origen legacy al migrar archivos viejos.
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(DATA_DIR, 'uploads');
const PROJECT_VIDEOS_DIR = path.join(__dirname, 'public', 'video');
const VIDEOS_DIR = process.env.LOCAL_VIDEOS_DIR || PROJECT_VIDEOS_DIR;
const AUDIOS_DIR = process.env.AUDIOS_DIR || path.join(__dirname, 'public', 'audios');
const BATALLA_VIDEOS_DIR = process.env.BATALLA_DIR || path.join(VIDEOS_DIR, 'batalla');
const NIVELES_VIDEOS_DIR = process.env.NIVELES_DIR || path.join(VIDEOS_DIR, 'niveles');
const PROJECT_NIVELES_DIR = path.join(PROJECT_VIDEOS_DIR, 'niveles');
const PROJECT_BATALLA_DIR = path.join(PROJECT_VIDEOS_DIR, 'batalla');
for (const d of [UPLOADS_DIR, AUDIOS_DIR, VIDEOS_DIR, BATALLA_VIDEOS_DIR, NIVELES_VIDEOS_DIR]) {
  fs.mkdirSync(d, { recursive: true });
}

function desktopLegacyUserDataSubdirs(sub) {
  const out = [];
  if (!IS_DESKTOP) return out;
  for (const root of [process.env.APPDATA, process.env.LOCALAPPDATA].filter(Boolean)) {
    for (const name of ['Livecoins', 'hokey-desktop', 'Hokey Live', 'livecoins', 'hokey']) {
      out.push(path.join(root, name, sub));
    }
  }
  return out;
}

function migrateFilesToPersistentDir(dest, legacyDirs, label) {
  const destResolved = path.resolve(dest);
  let copied = 0;
  for (const legacyRaw of legacyDirs) {
    const legacy = path.resolve(legacyRaw);
    if (legacy === destResolved || !fs.existsSync(legacy)) continue;
    let entries;
    try { entries = fs.readdirSync(legacy, { withFileTypes: true }); } catch { continue; }
    for (const ent of entries) {
      if (!ent.isFile()) continue;
      const from = path.join(legacy, ent.name);
      const to = path.join(destResolved, ent.name);
      try {
        if (!fs.existsSync(to)) {
          fs.copyFileSync(from, to);
          copied++;
        }
      } catch {}
    }
  }
  if (copied) console.log(`  [migrate] ${copied} archivo(s) de ${label} → ${destResolved}`);
}

function migrateDesktopMediaToPersistentDirs() {
  migrateFilesToPersistentDir(UPLOADS_DIR, [
    path.join(__dirname, 'public', 'uploads'),
    path.join(DATA_DIR, 'uploads'),
    ...desktopLegacyUserDataSubdirs('uploads'),
  ], 'uploads');
  migrateFilesToPersistentDir(AUDIOS_DIR, [
    path.join(__dirname, 'public', 'audios'),
    ...desktopLegacyUserDataSubdirs('audios'),
  ], 'audios');
  migrateFilesToPersistentDir(VIDEOS_DIR, [
    PROJECT_VIDEOS_DIR,
    ...desktopLegacyUserDataSubdirs('video'),
  ], 'video');
  migrateFilesToPersistentDir(BATALLA_VIDEOS_DIR, [
    PROJECT_BATALLA_DIR,
    path.join(PROJECT_VIDEOS_DIR, 'batalla'),
    ...desktopLegacyUserDataSubdirs('video-batalla'),
    ...desktopLegacyUserDataSubdirs(path.join('video', 'batalla')),
  ], 'video/batalla');
  migrateFilesToPersistentDir(NIVELES_VIDEOS_DIR, [
    PROJECT_NIVELES_DIR,
    ...desktopLegacyUserDataSubdirs('niveles'),
    ...desktopLegacyUserDataSubdirs(path.join('video', 'niveles')),
  ], 'niveles');
}
migrateDesktopMediaToPersistentDirs();

function nivelesSources() {
  const out = [{ dir: NIVELES_VIDEOS_DIR, urlBase: '/niveles/' }];
  if (path.resolve(PROJECT_NIVELES_DIR) !== path.resolve(NIVELES_VIDEOS_DIR)) {
    out.push({ dir: PROJECT_NIVELES_DIR, urlBase: '/video/niveles/' });
  }
  return out;
}

// Busca nivelN.webm (u otro formato compatible) para el nivel alcanzado.
const NIVEL_EXTS = ['.webm', '.mp4', '.gif', '.webp', '.png', '.jpg', '.jpeg', '.mov', '.mkv'];
function findLevelVideoUrl(level) {
  const n = Number(level) || 0;
  if (n <= 0) return '';
  for (const src of nivelesSources()) {
    let files = [];
    try { files = fs.readdirSync(src.dir); } catch { continue; }
    const matches = files.filter((f) => {
      const ext = path.extname(f).toLowerCase();
      if (!NIVEL_EXTS.includes(ext)) return false;
      const base = path.basename(f, path.extname(f)).toLowerCase().replace(/\s+/g, '');
      const m = base.match(/^nivel0*(\d+)$/);
      return m && Number(m[1]) === n;
    });
    if (!matches.length) continue;
    matches.sort((a, b) => NIVEL_EXTS.indexOf(path.extname(a).toLowerCase()) - NIVEL_EXTS.indexOf(path.extname(b).toLowerCase()));
    return src.urlBase + encodeURIComponent(matches[0]);
  }
  return '';
}

const app = express();

/* ------------------------------- Autenticación ------------------------------- */
// Login delegado (app .exe): si AUTH_REMOTE está definido, las cuentas son las de la
// web. Validamos usuario/clave contra el servidor remoto y, si es correcto, creamos
// un "espejo" local para que el mismo usuario funcione en el .exe (y luego offline).
const AUTH_REMOTE = (process.env.AUTH_REMOTE || '').replace(/\/+$/, '');

// Cookies de sesión remota (Render) por usuario local. Las usamos para que el panel
// de Administración del .exe gestione las cuentas reales de la web. Se persisten para
// que sobrevivan a reinicios de la app (caducan junto con la sesión remota).
const REMOTE_COOKIES_FILE = path.join(DATA_DIR, 'remote-cookies.json');
let remoteCookies = new Map();
try { remoteCookies = new Map(Object.entries(JSON.parse(fs.readFileSync(REMOTE_COOKIES_FILE, 'utf8')))); } catch {}
function saveRemoteCookies() {
  try { fs.writeFile(REMOTE_COOKIES_FILE, JSON.stringify(Object.fromEntries(remoteCookies)), () => {}); } catch {}
}

function getSetCookies(headers) {
  try { if (typeof headers.getSetCookie === 'function') return headers.getSetCookie(); } catch {}
  const c = headers.get('set-cookie');
  return c ? [c] : [];
}

// Devuelve { ok, plan, isAdmin, active, cookie } | { error } | { network:true } (fallo de red).
async function remoteLogin(username, password) {
  try {
    const r = await fetch(`${AUTH_REMOTE}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return { error: data.error || 'Usuario o contraseña incorrectos.' };
    // Recupera el plan/estado real con la cookie de sesión que nos dio el login.
    const cookie = getSetCookies(r.headers).map((c) => c.split(';')[0]).join('; ');
    let me = {};
    try {
      const rm = await fetch(`${AUTH_REMOTE}/api/me`, { headers: { Cookie: cookie } });
      if (rm.ok) me = await rm.json();
    } catch {}
    return {
      ok: true, plan: me.plan || 'free', isAdmin: !!me.isAdmin, active: me.active !== false,
      cookie, roomKey: me.roomKey || '',
    };
  } catch {
    return { network: true };
  }
}

// Reenvía una petición de administración al servidor remoto usando la cookie del admin.
// Devuelve true si la atendió (éxito o error del remoto) o false si no hay sesión remota
// (en ese caso el endpoint cae a la lógica local).
async function proxyAdminToRemote(req, res, apiPath, method = 'GET') {
  const cookie = req.user && remoteCookies.get(req.user.id);
  if (!cookie) return false;
  try {
    const init = { method, headers: { Cookie: cookie } };
    if (method !== 'GET') {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(req.body || {});
    }
    const r = await fetch(`${AUTH_REMOTE}${apiPath}`, init);
    // Sesión remota inválida/caducada: la olvidamos y dejamos que caiga a lo local.
    if (r.status === 401 || r.status === 403) {
      if (remoteCookies.delete(req.user.id)) saveRemoteCookies();
      return false;
    }
    const data = await r.json().catch(() => ({}));
    res.status(r.status).json(data);
    return true;
  } catch {
    // Sin conexión: caemos a la lógica local (no rompemos el panel).
    return false;
  }
}

async function remoteRegister(username, password, email, code) {
  try {
    const r = await fetch(`${AUTH_REMOTE}/api/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, email, code }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return { error: data.error || 'No se pudo crear la cuenta.' };
    return { ok: true, email: data.email || email || null, emailVerified: !!data.emailVerified };
  } catch {
    return { network: true };
  }
}

app.post('/api/register', express.json(), async (req, res) => {
  const { username, password, email, code } = req.body || {};
  // En el .exe la cuenta se crea en la web (fuente única); luego se replica en local.
  if (AUTH_REMOTE) {
    if (!email || !code) {
      return res.status(400).json({ error: 'Verifica tu correo con el código para crear la cuenta.' });
    }
    const rr = await remoteRegister(username, password, email, code);
    if (rr.network) return res.status(503).json({ error: 'Sin conexión con el servidor. Revisa tu internet.' });
    if (rr.error) return res.status(400).json({ error: rr.error });
    const user = upsertMirrorUser({ username, password, plan: 'free', isAdmin: false, active: true });
    if (rr.email) {
      try { setUserVerifiedEmail(user.id, rr.email); } catch {}
    }
    const token = createSession(user.id);
    if (IS_DESKTOP) saveDesktopLastLogin(user.id);
    res.setHeader('Set-Cookie', sessionCookie(token));
    return res.json({ ok: true, username: user.username, email: rr.email || null, emailVerified: !!rr.email });
  }
  if (!email || !code) {
    return res.status(400).json({ error: 'Verifica tu correo con el código para crear la cuenta.' });
  }
  const vr = consumeRegisterEmailCode(email, code);
  if (vr.error) return res.status(400).json({ error: vr.error });
  const { user, error } = registerUser(username, password, { email: vr.email || email });
  if (error) return res.status(400).json({ error });
  maybeMigrateLegacy(user);
  const token = createSession(user.id);
  if (IS_DESKTOP) saveDesktopLastLogin(user.id);
  res.setHeader('Set-Cookie', sessionCookie(token));
  res.json({ ok: true, username: user.username, email: user.email || null, emailVerified: !!user.emailVerified });
});

app.post('/api/login', express.json(), async (req, res) => {
  const { username, password } = req.body || {};
  if (AUTH_REMOTE) {
    const remote = await remoteLogin(username, password);
    if (remote.ok) {
      const user = upsertMirrorUser({ username, password, plan: remote.plan, isAdmin: remote.isAdmin, active: remote.active });
      migrateDesktopUserByUsername(user.username, user.id);
      touchLogin(user.id);
      // Guardamos la sesión remota para poder gestionar/listar las cuentas de la web
      // desde el panel de Administración del .exe.
      if (remote.cookie) { remoteCookies.set(user.id, remote.cookie); saveRemoteCookies(); }
      if (remote.roomKey) updateMirrorCloudRoomKey(user.id, remote.roomKey);
      pullRemoteSettings(user).catch(() => {});
      if (remote.isAdmin) {
        syncPlansFromRemote().catch(() => {});
        syncAllCloudRoomKeysFromRemote().catch(() => {});
      }
      const token = createSession(user.id);
      if (IS_DESKTOP) saveDesktopLastLogin(user.id);
      res.setHeader('Set-Cookie', sessionCookie(token));
      return res.json({ ok: true, username: user.username });
    }
    // Si el remoto rechazó las credenciales, no seguimos. Si fue un fallo de red,
    // permitimos el login local (cuenta ya cacheada de un inicio de sesión anterior).
    if (remote.error) return res.status(400).json({ error: remote.error });
  }
  const { user, error } = verifyLogin(username, password);
  if (error) {
    if (AUTH_REMOTE) return res.status(503).json({ error: 'Sin conexión con el servidor y la cuenta no está guardada en este equipo.' });
    return res.status(400).json({ error });
  }
  touchLogin(user.id);
  const token = createSession(user.id);
  if (IS_DESKTOP) saveDesktopLastLogin(user.id);
  res.setHeader('Set-Cookie', sessionCookie(token));
  res.json({ ok: true, username: user.username });
});

app.post('/api/logout', (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  const user = userFromRequest(req);
  if (user && remoteCookies.delete(user.id)) saveRemoteCookies();
  destroySession(cookies[SESSION_COOKIE]);
  if (IS_DESKTOP) clearDesktopLastLogin();
  res.setHeader('Set-Cookie', clearCookie());
  res.json({ ok: true });
});

// Restaura la cookie de sesión en Electron tras actualizar la app o cambiar de puerto.
app.get('/api/desktop/ensure-session', (req, res) => {
  if (!IS_DESKTOP) return res.status(404).json({ error: 'not found' });
  const user = userFromRequest(req);
  if (user) return res.json({ ok: true, username: user.username });
  const token = bootstrapDesktopSessionToken();
  if (!token) return res.status(401).json({ ok: false });
  res.setHeader('Set-Cookie', sessionCookie(token));
  const u = getSessionUser(token);
  res.json({ ok: true, username: u?.username || '' });
});

/* ----------------------------------------------------------------------------
 * Inicio de sesión con Google — desactivado (solo usuario/contraseña).
 * --------------------------------------------------------------------------*/
app.get('/api/auth/config', (_req, res) => {
  res.json({ google: false });
});

app.get('/api/auth/google', (_req, res) => {
  res.redirect('/login.html');
});

app.get('/api/auth/google/callback', (_req, res) => {
  res.redirect('/login.html');
});

app.post('/api/auth/google/desktop-exchange', express.json(), (_req, res) => {
  res.status(404).json({ error: 'No disponible.' });
});

app.get('/api/auth/google/desktop-finish', (_req, res) => {
  res.redirect('/login.html');
});

app.get('/api/me', async (req, res) => {
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ error: 'no auth' });
  // Al abrir el panel, traemos los ajustes guardados en Render (si los hay) para que
  // lo que se guardó en la web aparezca también aquí. No bloquea la respuesta.
  let remoteMe = null;
  if (AUTH_REMOTE) {
    migrateDesktopUserByUsername(user.username, user.id);
    pullRemoteSettings(user);
    // Refresca el plan (premium/free) desde Render ANTES de responder, para que el
    // panel muestre de inmediato los límites correctos si el admin lo cambió.
    remoteMe = await pullRemotePlan(user).catch(() => null);
    if (!(remoteMe && remoteMe.roomKey) && !(getUserById(user.id) || user).cloudRoomKey) {
      await ensureCloudRoomKeyCached(user);
    }
  }
  const caps = capsForUser(getUserById(user.id) || user);
  const fullUser = getUserById(user.id) || user;
  const hasRemoteCookie = !!(AUTH_REMOTE && remoteCookies.get(user.id));
  const cloudRoomKey = (remoteMe && remoteMe.roomKey) || fullUser.cloudRoomKey || null;
  res.json({
    username: user.username,
    roomKey: user.roomKey,
    // roomKey de la NUBE (Render): el .exe la usa para conectar su panel/overlays al
    // servidor remoto cuando el trabajo pesado (TikTok) corre en la nube (modo relay).
    cloudRoomKey,
    cloudSessionOk: hasRemoteCookie,
    isAdmin: !!user.isAdmin,
    active: isUserActive(user),
    plan: caps.plan,
    premiumUntil: fullUser.premiumUntil || 0,
    gamesEnabled: isUserGamesEnabled(fullUser),
    caps: { limits: caps.limits, features: caps.features },
    email: (remoteMe && remoteMe.email) || publicEmailFields(fullUser).email,
    emailVerified: !!(remoteMe && remoteMe.emailVerified) || publicEmailFields(fullUser).emailVerified,
    mailConfigured: (remoteMe && typeof remoteMe.mailConfigured === 'boolean')
      ? remoteMe.mailConfigured
      : mailStatus().configured,
  });
});

function clientRateKey(req) {
  return String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || req.ip || 'ip').split(',')[0].trim();
}

async function proxyAccountToRemote(req, res, apiPath, { auth = false } = {}) {
  if (!AUTH_REMOTE) return false;
  try {
    const init = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body || {}),
    };
    if (auth) {
      const cookie = req.user && remoteCookies.get(req.user.id);
      if (!cookie) return false;
      init.headers.Cookie = cookie;
    }
    const r = await fetch(`${AUTH_REMOTE}${apiPath}`, init);
    if (auth && (r.status === 401 || r.status === 403)) {
      if (req.user && remoteCookies.delete(req.user.id)) saveRemoteCookies();
      return false;
    }
    const data = await r.json().catch(() => ({}));
    res.status(r.status).json(data);
    return true;
  } catch {
    return false;
  }
}

app.get('/api/account/mail-status', async (req, res) => {
  if (AUTH_REMOTE) {
    try {
      const r = await fetch(`${AUTH_REMOTE}/api/account/mail-status`);
      const data = await r.json().catch(() => ({}));
      if (r.ok) return res.json(data);
    } catch {}
  }
  res.json(mailStatus());
});

app.post('/api/account/register/request-code', express.json(), async (req, res) => {
  if (AUTH_REMOTE) {
    if (await proxyAccountToRemote(req, res, '/api/account/register/request-code')) return;
    return res.status(503).json({ error: 'Sin conexión con el servidor. Revisa tu internet.' });
  }
  const r = await requestRegisterEmailCode(req.body?.email, clientRateKey(req));
  if (r.error) return res.status(400).json({ error: r.error });
  res.json({ ok: true, message: r.message });
});

app.post('/api/account/email/request-code', express.json(), async (req, res) => {
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ error: 'no auth' });
  req.user = user;
  if (AUTH_REMOTE) {
    if (await proxyAccountToRemote(req, res, '/api/account/email/request-code', { auth: true })) return;
    return res.status(503).json({ error: 'Sin sesión con la nube. Cierra sesión y vuelve a entrar.' });
  }
  const r = await requestLinkEmailCode(user.id, req.body?.email, clientRateKey(req));
  if (r.error) return res.status(400).json({ error: r.error });
  res.json({ ok: true, message: r.message });
});

app.post('/api/account/email/verify', express.json(), async (req, res) => {
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ error: 'no auth' });
  req.user = user;
  if (AUTH_REMOTE) {
    if (await proxyAccountToRemote(req, res, '/api/account/email/verify', { auth: true })) return;
    return res.status(503).json({ error: 'Sin sesión con la nube. Cierra sesión y vuelve a entrar.' });
  }
  const r = verifyLinkEmailCode(user.id, req.body?.code);
  if (r.error) return res.status(400).json({ error: r.error });
  res.json({ ok: true, email: r.email, message: r.message });
});

app.post('/api/account/password/forgot', express.json(), async (req, res) => {
  if (AUTH_REMOTE) {
    if (await proxyAccountToRemote(req, res, '/api/account/password/forgot')) return;
    return res.status(503).json({ error: 'Sin conexión con el servidor. Revisa tu internet.' });
  }
  const r = await requestPasswordReset(req.body?.username || req.body?.email || req.body?.identifier, clientRateKey(req));
  if (r.error) return res.status(400).json({ error: r.error });
  res.json({ ok: true, message: r.message });
});

app.post('/api/account/password/reset', express.json(), async (req, res) => {
  if (AUTH_REMOTE) {
    if (await proxyAccountToRemote(req, res, '/api/account/password/reset')) return;
    return res.status(503).json({ error: 'Sin conexión con el servidor. Revisa tu internet.' });
  }
  const r = resetPasswordWithCode(
    req.body?.username || req.body?.email || req.body?.identifier,
    req.body?.code,
    req.body?.password || req.body?.newPassword,
  );
  if (r.error) return res.status(400).json({ error: r.error });
  res.json({ ok: true, message: r.message });
});

app.get('/api/panel-lives', async (req, res) => {
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ error: 'no auth' });
  // En .exe (relay) los lives reales están en Render: hay que pedirlos a la nube.
  // No depender solo de HOKEY_RELAY ni de una cookie frágil: probar auth y público.
  if (AUTH_REMOTE) {
    const cookie = remoteCookies.get(user.id);
    const attempts = [];
    if (cookie) attempts.push({ url: `${AUTH_REMOTE}/api/panel-lives`, headers: { Cookie: cookie } });
    attempts.push({ url: `${AUTH_REMOTE}/api/panel-lives-public`, headers: {} });
    for (const a of attempts) {
      try {
        const r = await fetch(a.url, { headers: a.headers });
        if (!r.ok) continue;
        const data = await r.json().catch(() => ({}));
        if (!Array.isArray(data.lives)) continue;
        return res.json({ lives: enrichPanelLivesPlans(filterActivePanelLives(data.lives)) });
      } catch { /* siguiente intento */ }
    }
  }
  res.json({ lives: listPanelLives() });
});

app.get('/api/streamer-rankings', async (req, res) => {
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ error: 'no auth' });
  const type = req.query.type === 'diamonds' ? 'diamonds' : 'likes';
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 10));
  if (AUTH_REMOTE && process.env.HOKEY_RELAY === '1') {
    try {
      const cookie = remoteCookies.get(user.id);
      if (cookie) {
        const qs = new URLSearchParams({ type, limit: String(limit) });
        const r = await fetch(`${AUTH_REMOTE}/api/streamer-rankings?${qs}`, { headers: { Cookie: cookie } });
        if (r.ok) return res.json(await r.json());
      }
    } catch { /* fallback local */ }
  }
  res.json(streamerRankings.getRankings({ type, limit }));
});

// Ajustes completos del usuario autenticado (para sincronizar entre la web y el .exe).
app.get('/api/my-settings', (req, res) => {
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ error: 'no auth' });
  const room = getRoomForUser(user);
  res.json({ settings: room.getSettings(), exists: room.hasSavedSettings() });
});

function parseTikTokUsernameInput(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const m = s.match(/tiktok\.com\/@([^/?#]+)/i);
  if (m) return m[1];
  return s.replace(/^@/, '').split(/[/?#]/)[0].trim();
}

function pickTikTokImageUrl(img) {
  if (!img) return '';
  if (typeof img === 'string') return img.trim();
  if (Array.isArray(img)) return String(img[0] || '').trim();
  return String(img.url_list?.[0] || img.urlList?.[0] || img.uri?.[0] || '').trim();
}

function extractTikTokUserAvatar(user) {
  if (!user || typeof user !== 'object') return '';
  return pickTikTokImageUrl(user.avatarLarger)
    || pickTikTokImageUrl(user.avatarMedium)
    || pickTikTokImageUrl(user.avatarThumb)
    || pickTikTokImageUrl(user.avatar)
    || String(user.profilePictureUrl || user.profile_picture_url || '').trim();
}

app.get('/api/tiktok-profile', async (req, res) => {
  const username = parseTikTokUsernameInput(req.query.url || req.query.user || '');
  if (!username) return res.status(400).json({ error: 'Usuario TikTok inválido' });
  try {
    const conn = new TikTokLiveConnection(username, { fetchRoomInfoOnConnect: false });
    const info = await conn.webClient.fetchRoomInfoFromHtml({ uniqueId: username });
    const user = info?.user || info?.liveRoomUserInfo?.user || {};
    const avatar = extractTikTokUserAvatar(user);
    if (!avatar) return res.status(404).json({ error: 'No se encontró foto de perfil' });
    res.json({
      username,
      profileUrl: `https://www.tiktok.com/@${username}`,
      avatar,
    });
  } catch (e) {
    res.status(502).json({ error: e?.message || 'No se pudo obtener el perfil' });
  }
});

app.post('/api/my-settings', express.json({ limit: '8mb' }), (req, res) => {
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ error: 'no auth' });
  const room = getRoomForUser(user);
  room.applySettings(req.body?.settings || {});
  res.json({ ok: true });
});

app.get('/api/profiles/full', (req, res) => {
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ error: 'no auth' });
  const room = getRoomForUser(user);
  res.json({ ok: true, profiles: room.getProfilesFull() });
});
app.post('/api/profiles/full', express.json({ limit: '16mb' }), (req, res) => {
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ error: 'no auth' });
  const room = getRoomForUser(user);
  if (req.body?.profiles) room.importProfilesFull(req.body.profiles);
  res.json({ ok: true, settings: room.getSettings(), profiles: room.getProfilesInfo() });
});

async function relayProfileActionToRemote(userId, path, body) {
  const cookie = remoteCookies.get(userId);
  if (!cookie || !AUTH_REMOTE) throw new Error('Sin sesión con la nube. Cierra sesión y vuelve a entrar.');
  const r = await fetch(`${AUTH_REMOTE}${path}`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  if (r.status === 401 || r.status === 403) {
    if (remoteCookies.delete(userId)) saveRemoteCookies();
    throw new Error('Sesión con la nube caducada. Cierra sesión y vuelve a entrar.');
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `Error al cambiar perfil en la nube (${r.status})`);
  return data;
}

async function relayGetFromRemote(userId, path) {
  const cookie = remoteCookies.get(userId);
  if (!cookie || !AUTH_REMOTE) throw new Error('Sin sesión con la nube. Cierra sesión y vuelve a entrar.');
  const r = await fetch(`${AUTH_REMOTE}${path}`, { headers: { Cookie: cookie } });
  if (r.status === 401 || r.status === 403) {
    if (remoteCookies.delete(userId)) saveRemoteCookies();
    throw new Error('Sesión con la nube caducada. Cierra sesión y vuelve a entrar.');
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `Error al leer perfiles en la nube (${r.status})`);
  return data;
}

// Perfiles del panel (.exe): en modo relay la room activa está en Render.
app.get('/api/profiles', async (req, res) => {
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ error: 'no auth' });
  if (process.env.HOKEY_RELAY === '1' && AUTH_REMOTE) {
    const cookie = remoteCookies.get(user.id);
    if (cookie) {
      try {
        return res.json(await relayGetFromRemote(user.id, '/api/profiles'));
      } catch (e) {
        return res.status(502).json({ error: e.message || 'sin conexión con la nube' });
      }
    }
  }
  const room = getRoomForUser(user);
  res.json({ ok: true, profiles: room.getProfilesInfo() });
});
app.post('/api/profiles/switch-general', async (req, res) => {
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ error: 'no auth' });
  if (process.env.HOKEY_RELAY === '1' && AUTH_REMOTE) {
    try {
      const data = await relayProfileActionToRemote(user.id, '/api/profiles/switch-general');
      await mirrorRelayProfileToLocal(user, data);
      return res.json(data);
    } catch (e) {
      return res.status(502).json({ error: e.message || 'sin conexión con la nube' });
    }
  }
  const room = getRoomForUser(user);
  room.handleMessage(null, { action: 'switchGeneralProfile' });
  res.json({ ok: true, settings: room.getSettings(), profiles: room.getProfilesInfo() });
});
app.post('/api/profiles/switch', express.json(), async (req, res) => {
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ error: 'no auth' });
  const idx = Number(req.body?.index);
  if (!Number.isInteger(idx)) return res.status(400).json({ error: 'index inválido' });
  if (process.env.HOKEY_RELAY === '1' && AUTH_REMOTE) {
    try {
      const data = await relayProfileActionToRemote(user.id, '/api/profiles/switch', { index: idx });
      await mirrorRelayProfileToLocal(user, data);
      return res.json(data);
    } catch (e) {
      return res.status(502).json({ error: e.message || 'sin conexión con la nube' });
    }
  }
  const room = getRoomForUser(user);
  room.handleMessage(null, { action: 'switchProfile', index: idx });
  res.json({ ok: true, settings: room.getSettings(), profiles: room.getProfilesInfo() });
});

// Refresca la sesión con Render sin cerrar el panel local (opcional: contraseña en el body).
app.post('/api/desktop/refresh-cloud-session', express.json(), async (req, res) => {
  if (!AUTH_REMOTE) return res.status(404).json({ error: 'no relay' });
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ error: 'no auth' });
  const password = String(req.body?.password || '');
  if (password) {
    const remote = await remoteLogin(user.username, password);
    if (remote.ok && remote.cookie) {
      remoteCookies.set(user.id, remote.cookie);
      saveRemoteCookies();
      if (remote.roomKey) updateMirrorCloudRoomKey(user.id, remote.roomKey);
    } else if (remote.error) {
      return res.status(400).json({ error: remote.error });
    }
  } else {
    await ensureCloudRoomKeyCached(user);
  }
  const remoteMe = await pullRemotePlan(user).catch(() => null);
  const fullUser = getUserById(user.id) || user;
  res.json({
    cloudRoomKey: (remoteMe && remoteMe.roomKey) || fullUser.cloudRoomKey || null,
    cloudSessionOk: !!remoteCookies.get(user.id),
  });
});

// Modo relay (.exe): conectar/desconectar TikTok en la nube cuando el panel no tiene
// WebSocket abierto a Render (p. ej. exe antiguo o cloudRoomKey aún no cargada).
app.post('/api/desktop/connect-live', express.json(), async (req, res) => {
  if (process.env.HOKEY_RELAY !== '1' || !AUTH_REMOTE) return res.status(404).json({ error: 'no relay' });
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ error: 'no auth' });
  const username = String(req.body?.username || '').trim().replace(/^@/, '');
  if (!username) return res.status(400).json({ error: 'falta usuario' });
  try {
    const data = await relayRoomActionToRemote(user.id, 'connect', { username });
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: e.message || 'sin conexión con la nube' });
  }
});
app.post('/api/desktop/disconnect-live', express.json(), async (req, res) => {
  if (process.env.HOKEY_RELAY !== '1' || !AUTH_REMOTE) return res.status(404).json({ error: 'no relay' });
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ error: 'no auth' });
  try {
    const data = await relayRoomActionToRemote(user.id, 'disconnect', {});
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: e.message || 'sin conexión con la nube' });
  }
});
// Prueba / reproducción local de videos por nivel (public/video/niveles). Siempre usa el
// servidor de esta PC, no el WebSocket a la nube (los .webm están en disco local).
app.post('/api/test-level-video', express.json(), (req, res) => {
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ error: 'no auth' });
  const level = Math.max(1, Number(req.body?.level) || 1);
  const url = findLevelVideoUrl(level);
  if (!url) {
    return res.json({ ok: false, error: 'no_file', level, expected: `nivel${level}.webm` });
  }
  const room = getRoomForUser(user);
  const cfg = room.getSettings().levelVideos || {};
  if (cfg.enabled === false) return res.json({ ok: false, error: 'disabled', level });
  const screen = Math.max(1, Math.min(10, Number(req.body?.screen) || Number(cfg.screen) || 1));
  room.handleMessage(null, { action: 'testLevelVideo', level, screen });
  res.json({ ok: true, level, url, screen });
});
// Modo relay (.exe): la nube delega reproducción de videos a la PC local (5 pantallas).
app.post('/api/desktop/local-media', express.json({ limit: '256kb' }), (req, res) => {
  if (!IS_DESKTOP) return res.status(403).json({ error: 'solo_escritorio' });
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ error: 'no auth' });
  const room = getRoomForUser(user);
  const action = String(req.body?.action || '');
  if (action === 'media') {
    room.handleMessage(null, { action: 'playMediaRelay', media: req.body.media || {} });
  } else if (action === 'stop') {
    room.handleMessage(null, { action: 'stopVideo', screen: Number(req.body.screen) || 1 });
  } else if (action === 'panic') {
    room.handleMessage(null, { action: 'panicLocal' });
  } else {
    return res.status(400).json({ error: 'action inválida' });
  }
  res.json({ ok: true });
});

// Relay: el panel guarda en la nube, pero Stream Deck (:3199) lee la room local.
// Empuja videos/batallas al instante (sin esperar pull) y sin reenviar todo a Render.
app.post('/api/desktop/sync-webhook-media', express.json({ limit: '8mb' }), (req, res) => {
  if (!IS_DESKTOP) return res.status(403).json({ error: 'solo_escritorio' });
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ error: 'no auth' });
  const room = getRoomForUser(user);
  const body = req.body || {};
  const patch = {};
  if (Array.isArray(body.videos)) {
    patch.videos = body.videos;
    if (body.videosEnabled !== undefined) patch.videosEnabled = body.videosEnabled !== false;
  }
  if (Array.isArray(body.battleAlerts)) {
    patch.battleAlerts = body.battleAlerts;
    if (body.battleAlertsEnabled !== undefined) patch.battleAlertsEnabled = body.battleAlertsEnabled !== false;
  }
  if (Array.isArray(body.soundAlerts)) patch.soundAlerts = body.soundAlerts;
  if (Array.isArray(body.actions)) patch.actions = body.actions;
  if (!Object.keys(patch).length) {
    return res.status(400).json({ ok: false, error: 'empty' });
  }
  // applySettings(..., fromUser=false) → no dispara push remoto.
  room.applySettings(patch);
  const s = room.getSettings() || {};
  res.json({
    ok: true,
    videos: (s.videos || []).length,
    battleAlerts: (s.battleAlerts || []).length,
    soundAlerts: (s.soundAlerts || []).length,
    actions: (s.actions || []).length,
  });
});
// Modo relay (.exe): stickers vistos en el live se recogen en Render; los fusionamos
// con el catálogo local persistido en userData para que sobrevivan a actualizaciones.
app.get('/api/desktop/emotes', async (req, res) => {
  const user = userFromRequest(req);
  if (!user) return res.json({ results: [] });
  const room = getRoomForUser(user);
  if (process.env.HOKEY_RELAY === '1' && AUTH_REMOTE) {
    try {
      const remote = await relayEmotesFromRemote(user.id);
      if (remote.length) room.mergeEmotes(remote);
    } catch {}
  }
  res.json({ results: room.getEmotes() });
});

app.get('/api/desktop/community-gifts', async (req, res) => {
  const user = userFromRequest(req);
  if (!user) return res.json({ results: [] });
  const room = getRoomForUser(user);
  if (process.env.HOKEY_RELAY === '1' && AUTH_REMOTE) {
    try {
      const remote = await relayCommunityGiftsFromRemote(user.id);
      if (remote.length) room.mergeCommunityGifts(remote);
    } catch {}
  }
  res.json({ results: room.getCommunityGifts() });
});

app.post('/api/desktop/spotify-chat', express.json({ limit: '32kb' }), async (req, res) => {
  if (!IS_DESKTOP) return res.status(403).json({ ok: false, error: 'solo_escritorio' });
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ ok: false, error: 'no auth' });
  const comment = String(req.body?.comment || '').trim();
  const u = req.body?.user || {};
  const roles = req.body?.roles || {};
  if (!comment || !u.uniqueId) return res.json({ ok: false });
  try {
    await getRoomForUser(user).handleSpotifyChat(comment, {
      uniqueId: String(u.uniqueId || ''),
      nickname: String(u.nickname || u.uniqueId || ''),
      photo: String(u.photo || ''),
    }, {
      isMod: !!roles.isMod,
      isSub: !!roles.isSub,
      memberLevel: Number(roles.memberLevel) || 0,
    });
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, error: String(e && e.message || e) });
  }
});

// Prueba Minecraft en el servidor LOCAL (.exe): RCON solo llega al MC de esta PC.
app.post('/api/desktop/mc-test', express.json({ limit: '2mb' }), async (req, res) => {
  if (!IS_DESKTOP) return res.status(403).json({ ok: false, error: 'solo_escritorio' });
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ ok: false, error: 'no auth' });
  const room = getRoomForUser(user);
  if (req.body?.settings) room.applySettings(req.body.settings);
  const cfg = room.getSettings()?.webhook || {};
  const stap = cfg.servertap || {};
  const rcon = { host: '127.0.0.1', port: 25575, ...(cfg.rcon || {}) };
  if (stap.enabled) {
    const ping = await testServertap({ ip: stap.ip || 'localhost', port: stap.port || 4567, key: stap.key });
    if (!ping.ok) return res.json({ ok: false, error: ping.error || 'ServerTap no responde' });
  } else {
    if (!String(rcon.password || '').trim()) {
      return res.json({ ok: false, error: 'Configura RCON en Webhook (contraseña)' });
    }
    const ping = await testRcon(rcon);
    if (!ping.ok) return res.json({ ok: false, error: ping.error || 'RCON no responde' });
  }
  const uid = String(req.body?.uid || '');
  const settingsNow = room.getSettings();
  const a = (settingsNow.mcActions || []).find((x) => x.uid === uid)
    || (settingsNow.mcshooterActions || []).find((x) => x.uid === uid)
    || (settingsNow.bedrockActions || []).find((x) => x.uid === uid)
    || (settingsNow.parkourActions || []).find((x) => x.uid === uid)
    || (settingsNow.kothActions || []).find((x) => x.uid === uid)
    || (settingsNow.farmActions || []).find((x) => x.uid === uid)
    || (settingsNow.sandboxActions || []).find((x) => x.uid === uid);
  if (!a || !(a.cmd || (Array.isArray(a.cmds) && a.cmds.length))) {
    return res.json({ ok: false, error: 'Acción no encontrada o sin comando' });
  }
  room.handleMessage(null, { action: 'testMcAction', uid });
  res.json({ ok: true });
});

// Mario / PvZ: SIEMPRE se ejecutan en esta PC. El panel del .exe
// llama aquí para "Probar" y para acciones en vivo sin depender de la nube.
app.post('/api/desktop/game-exec', express.json({ limit: '64kb' }), async (req, res) => {
  if (!IS_DESKTOP) return res.status(403).json({ ok: false, error: 'solo_escritorio' });
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ ok: false, error: 'no auth' });
  const body = req.body || {};
  if (body.tipo === 'WEBHOOK') {
    if (isMari0EnemySpawnWebhook(body.url)) {
      return res.json(await runWebhookExec(body));
    }
    if (isMslug7760WebhookUrl(body.url)) {
      return res.json(await runMslug7760WebhookExec(body));
    }
    return res.json(await runWebhookExec(body));
  }
  const result = await runGameExec(body);
  res.json(result);
});

app.post('/api/desktop/ensure-smbx-webhook', async (req, res) => {
  if (!IS_DESKTOP) return res.status(403).json({ ok: false, error: 'solo_escritorio' });
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ ok: false, error: 'no auth' });
  const ok = await ensureSmbxTiktokWebhook();
  res.json({ ok, status: smbxTiktokWebhookStatus() });
});

// LiveCoinsCore (Minecraft Parkour/KOTH/Farm): valida licencia vía WebSocket :4043.
app.post('/api/desktop/ensure-mc-core-license', express.json({ limit: '8kb' }), async (req, res) => {
  if (!IS_DESKTOP) return res.status(403).json({ ok: false, error: 'solo_escritorio' });
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ ok: false, error: 'no auth' });
  const room = getRoomForUser(user);
  if (req.body?.settings) room.applySettings(req.body.settings);
  const rcon = room.getSettings()?.webhook?.rcon || {};
  const fullUser = getUserById(user.id) || user;
  const result = await ensureMcCoreLicense({
    user: fullUser,
    email: req.body?.email,
    rcon,
  });
  res.json(result);
});

app.get('/api/desktop/mc-core-license-status', (req, res) => {
  if (!IS_DESKTOP) return res.status(403).json({ ok: false, error: 'solo_escritorio' });
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ ok: false, error: 'no auth' });
  res.json({ ok: true, ...mcCoreLicenseStatus() });
});

async function fetchLocalBridgeHealth() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2000);
    const r = await fetch('http://127.0.0.1:7755/health', { signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

// Arranca el bridge Mario/Mari0 en esta PC y devuelve estado (el panel no puede
// hablar con :7755 directamente en algunos entornos Electron).
app.post('/api/desktop/ensure-bridge', express.json({ limit: '8kb' }), async (req, res) => {
  if (!IS_DESKTOP) return res.status(403).json({ ok: false, error: 'solo_escritorio' });
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ ok: false, error: 'no auth' });
  const mode = String(req.body?.mode || 'mari0').toLowerCase() === 'smbx' ? 'smbx' : 'mari0';
  await (mode === 'mari0' ? ensureMari0Bridge() : ensureMarioBridge());
  const health = await fetchLocalBridgeHealth();
  const matched = bridgeHealthOk(health, mode);
  res.json({ ok: matched, mode, health, status: marioBridgeStatus() });
});

app.get('/api/desktop/bridge-health', async (req, res) => {
  if (!IS_DESKTOP) return res.status(403).json({ ok: false, error: 'solo_escritorio' });
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ ok: false, error: 'no auth' });
  const health = await fetchLocalBridgeHealth();
  res.json({ ok: !!(health && health.ok), health });
});

function smb3CatalogPaths() {
  const out = [];
  out.push(path.join(process.env.LOCALAPPDATA || '', 'LivecoinsSMB3', 'catalog.json'));
  if (process.env.DESKTOP_RESOURCES) {
    out.push(path.join(process.env.DESKTOP_RESOURCES, 'smb3-bridge', 'catalog.json'));
  }
  out.push(path.join(__dirname, 'public', 'smb3-catalog.json'));
  return [...new Set(out.filter(Boolean))];
}

function extractSmb3Entities(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw?.entities && Array.isArray(raw.entities)) return raw.entities;
  return raw?.items || raw?.catalog || [];
}

const SMB3_UI_SKIP_CATEGORIES = new Set(['nothing', 'unsafe', 'platform', 'special', 'meta', 'effect']);

function normalizeSmb3Catalog(raw) {
  const list = extractSmb3Entities(raw);
  return list.filter((e) => {
    if (!e || e.safe === false) return false;
    const id = Number(e.id);
    if (Number.isFinite(id) && id > 214) return false;
    const cat = String(e.category || '').toLowerCase();
    if (SMB3_UI_SKIP_CATEGORIES.has(cat)) return false;
    return !!(e.name || e.thing);
  });
}

app.get('/api/desktop/smb3-catalog', async (req, res) => {
  if (!IS_DESKTOP) return res.status(403).json({ ok: false, error: 'solo_escritorio' });
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ ok: false, error: 'no auth' });
  for (const filePath of smb3CatalogPaths()) {
    try {
      if (!fs.existsSync(filePath)) continue;
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
      const catalog = normalizeSmb3Catalog(raw);
      if (catalog.length) return res.json({ ok: true, catalog, source: filePath });
    } catch { /* siguiente ruta */ }
  }
  res.json({ ok: false, error: 'catalog_no_encontrado' });
});

app.get('/api/desktop/smb3-health', async (req, res) => {
  if (!IS_DESKTOP) return res.status(403).json({ ok: false, error: 'solo_escritorio' });
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ ok: false, error: 'no auth' });
  const health = await fetchLocalBridgeHealth();
  const ok = smb3HealthOk(health);
  res.json({ ok, health });
});

app.post('/api/desktop/ensure-pvz-hybrid-bridge', express.json({ limit: '8kb' }), async (req, res) => {
  if (!IS_DESKTOP) return res.status(403).json({ ok: false, error: 'solo_escritorio' });
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ ok: false, error: 'no auth' });
  const ok = await ensurePvzHybridBridge();
  const health = await pvzHybridBridgeHealth();
  const status = pvzHybridBridgeStatus();
  res.json({
    ok: ok && pvzHybridBridgeHealthOk(health),
    error: ok ? null : (status.lastError || (status.script ? 'timeout' : 'sin_script')),
    health,
    status,
  });
});

app.get('/api/desktop/pvz-hybrid-health', async (req, res) => {
  if (!IS_DESKTOP) return res.status(403).json({ ok: false, error: 'solo_escritorio' });
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ ok: false, error: 'no auth' });
  const health = await pvzHybridBridgeHealth();
  res.json({
    ok: pvzHybridBridgeHealthOk(health),
    health,
    status: pvzHybridBridgeStatus(),
    toolsExe: findPvzToolsExe(),
  });
});

app.post('/api/desktop/ensure-pvz-toolkit-bridge', express.json({ limit: '8kb' }), async (req, res) => {
  if (!IS_DESKTOP) return res.status(403).json({ ok: false, error: 'solo_escritorio' });
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ ok: false, error: 'no auth' });
  const ok = await ensurePvzToolkitBridge();
  const health = await pvzToolkitBridgeHealth();
  const status = pvzToolkitBridgeStatus();
  res.json({
    ok: ok && pvzToolkitBridgeHealthOk(health),
    error: ok ? null : (status.lastError || (status.script ? 'timeout' : 'sin_script')),
    health,
    status,
  });
});

app.get('/api/desktop/pvz-toolkit-health', async (req, res) => {
  if (!IS_DESKTOP) return res.status(403).json({ ok: false, error: 'solo_escritorio' });
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ ok: false, error: 'no auth' });
  const health = await pvzToolkitBridgeHealth();
  res.json({
    ok: pvzToolkitBridgeHealthOk(health),
    health,
    status: pvzToolkitBridgeStatus(),
    toolsExe: findPvzToolsExe(),
  });
});

app.post('/api/desktop/ensure-repo-bridge', express.json({ limit: '8kb' }), async (req, res) => {
  if (!IS_DESKTOP) return res.status(403).json({ ok: false, error: 'solo_escritorio' });
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ ok: false, error: 'no auth' });
  const ok = await ensureRepoBridge();
  const health = await repoBridgeHealth();
  res.json({ ok: ok && repoBridgeHealthOk(health), health, status: repoBridgeStatus() });
});

app.get('/api/desktop/repo-health', async (req, res) => {
  if (!IS_DESKTOP) return res.status(403).json({ ok: false, error: 'solo_escritorio' });
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ ok: false, error: 'no auth' });
  const health = await repoBridgeHealth();
  res.json({
    ok: repoBridgeHealthOk(health),
    health,
    status: repoBridgeStatus(),
    gameDir: getRepoGameDirConfig() || health?.game_dir || null,
  });
});

app.get('/api/desktop/repo-game-dir', (req, res) => {
  if (!IS_DESKTOP) return res.status(403).json({ ok: false, error: 'solo_escritorio' });
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ ok: false, error: 'no auth' });
  const dir = getRepoGameDirConfig();
  const status = repoBridgeStatus();
  res.json({ ok: true, dir, active: status.gameDir || null });
});

app.post('/api/desktop/repo-game-dir', express.json({ limit: '8kb' }), (req, res) => {
  if (!IS_DESKTOP) return res.status(403).json({ ok: false, error: 'solo_escritorio' });
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ ok: false, error: 'no auth' });
  try {
    const dir = setRepoGameDir(req.body?.dir);
    res.json({ ok: true, dir, status: repoBridgeStatus() });
  } catch (e) {
    res.status(400).json({ ok: false, error: e && e.message ? e.message : 'invalido' });
  }
});

app.post('/api/desktop/repo-install-mod', express.json({ limit: '8kb' }), (req, res) => {
  if (!IS_DESKTOP) return res.status(403).json({ ok: false, error: 'solo_escritorio' });
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ ok: false, error: 'no auth' });
  try {
    const result = installRepoMod(req.body?.dir);
    res.json({ ok: true, ...result, status: repoBridgeStatus() });
  } catch (e) {
    res.status(400).json({ ok: false, error: e && e.message ? e.message : 'install_failed' });
  }
});

app.post('/api/desktop/repo-uninstall-mod', express.json({ limit: '8kb' }), (req, res) => {
  if (!IS_DESKTOP) return res.status(403).json({ ok: false, error: 'solo_escritorio' });
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ ok: false, error: 'no auth' });
  try {
    const result = uninstallRepoMod(req.body?.dir);
    res.json({ ok: true, ...result, status: repoBridgeStatus() });
  } catch (e) {
    res.status(400).json({ ok: false, error: e && e.message ? e.message : 'uninstall_failed' });
  }
});

app.get('/api/desktop/l4d-status', async (req, res) => {
  if (!IS_DESKTOP) return res.status(403).json({ ok: false, error: 'solo_escritorio' });
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ ok: false, error: 'no auth' });
  const health = await l4dBridgeHealth();
  res.json({
    ok: !!health?.mod_installed,
    health,
    status: l4dBridgeStatus(),
    gameDir: getL4dGameDirConfig() || health?.game_dir || null,
  });
});

app.get('/api/desktop/ctr-bridge-health', async (req, res) => {
  if (!IS_DESKTOP) return res.status(403).json({ ok: false, error: 'solo_escritorio' });
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ ok: false, error: 'no auth' });
  const health = await ctrBridgeHealth();
  res.json({ ok: !!health?.running, health, status: ctrBridgeStatus() });
});

app.post('/api/desktop/ensure-ctr-bridge', express.json({ limit: '4kb' }), async (req, res) => {
  if (!IS_DESKTOP) return res.status(403).json({ ok: false, error: 'solo_escritorio' });
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ ok: false, error: 'no auth' });
  const ok = await ensureCtrBridge();
  const health = await ctrBridgeHealth();
  res.json({
    ok: ok && !!health?.running,
    error: ok ? null : (ctrBridgeStatus().lastError || 'no_bridge'),
    health,
    status: ctrBridgeStatus(),
  });
});

app.get('/api/desktop/smw-bridge-health', async (req, res) => {
  if (!IS_DESKTOP) return res.status(403).json({ ok: false, error: 'solo_escritorio' });
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ ok: false, error: 'no auth' });
  const health = await smwBridgeHealth();
  res.json({ ok: !!health?.running, health, status: smwBridgeStatus() });
});

app.post('/api/desktop/ensure-smw-bridge', express.json({ limit: '4kb' }), async (req, res) => {
  if (!IS_DESKTOP) return res.status(403).json({ ok: false, error: 'solo_escritorio' });
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ ok: false, error: 'no auth' });
  const r = await ensureSmwBridge();
  const health = await smwBridgeHealth();
  res.json({
    ok: !!(r?.ok && health?.running),
    error: r?.ok ? null : (r?.error || smwBridgeStatus().last_error || 'no_bridge'),
    health,
    status: smwBridgeStatus(),
  });
});

app.post('/api/desktop/smw-install-mod', express.json({ limit: '4kb' }), async (req, res) => {
  if (!IS_DESKTOP) return res.status(403).json({ ok: false, error: 'solo_escritorio' });
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ ok: false, error: 'no auth' });
  try {
    const result = await installSmwMod({
      forceDownload: !!req.body?.forceDownload,
    });
    res.json({ ok: true, ...result, status: smwBridgeStatus() });
  } catch (e) {
    res.status(400).json({ ok: false, error: e && e.message ? e.message : 'install_failed' });
  }
});

app.post('/api/desktop/smw-uninstall-mod', express.json({ limit: '4kb' }), (req, res) => {
  if (!IS_DESKTOP) return res.status(403).json({ ok: false, error: 'solo_escritorio' });
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ ok: false, error: 'no auth' });
  try {
    const result = uninstallSmwMod();
    res.json({ ok: true, ...result, status: smwBridgeStatus() });
  } catch (e) {
    res.status(400).json({ ok: false, error: e && e.message ? e.message : 'uninstall_failed' });
  }
});

app.get('/api/desktop/l4d-game-dir', (req, res) => {
  if (!IS_DESKTOP) return res.status(403).json({ ok: false, error: 'solo_escritorio' });
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ ok: false, error: 'no auth' });
  const sync = syncL4dGameDir();
  const dir = getL4dGameDirConfig();
  const status = l4dBridgeStatus();
  const suggested = discoverL4dGameDir();
  res.json({ ok: true, dir, active: status.gameDir || null, suggested: suggested || null, synced: sync.synced || false });
});

app.post('/api/desktop/l4d-game-dir', express.json({ limit: '8kb' }), (req, res) => {
  if (!IS_DESKTOP) return res.status(403).json({ ok: false, error: 'solo_escritorio' });
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ ok: false, error: 'no auth' });
  try {
    const dir = setL4dGameDir(req.body?.dir);
    res.json({ ok: true, dir, status: l4dBridgeStatus() });
  } catch (e) {
    res.status(400).json({ ok: false, error: e && e.message ? e.message : 'invalido' });
  }
});

app.post('/api/desktop/l4d-install-mod', express.json({ limit: '8kb' }), async (req, res) => {
  if (!IS_DESKTOP) return res.status(403).json({ ok: false, error: 'solo_escritorio' });
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ ok: false, error: 'no auth' });
  try {
    const result = await installL4dMod(req.body?.dir, {
      forceDownload: !!req.body?.forceDownload,
    });
    res.json({ ok: true, ...result, status: l4dBridgeStatus() });
  } catch (e) {
    res.status(400).json({ ok: false, error: e && e.message ? e.message : 'install_failed' });
  }
});

app.post('/api/desktop/l4d-uninstall-mod', express.json({ limit: '8kb' }), (req, res) => {
  if (!IS_DESKTOP) return res.status(403).json({ ok: false, error: 'solo_escritorio' });
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ ok: false, error: 'no auth' });
  try {
    const result = uninstallL4dMod(req.body?.dir);
    res.json({ ok: true, ...result, status: l4dBridgeStatus() });
  } catch (e) {
    res.status(400).json({ ok: false, error: e && e.message ? e.message : 'uninstall_failed' });
  }
});

app.get('/api/desktop/unturned-status', async (req, res) => {
  if (!IS_DESKTOP) return res.status(403).json({ ok: false, error: 'solo_escritorio' });
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ ok: false, error: 'no auth' });
  const health = await unturnedBridgeHealth();
  res.json({
    ok: true,
    ...health,
    status: unturnedBridgeStatus(),
  });
});

app.get('/api/desktop/unturned-game-dir', (req, res) => {
  if (!IS_DESKTOP) return res.status(403).json({ ok: false, error: 'solo_escritorio' });
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ ok: false, error: 'no auth' });
  syncUnturnedGameDir();
  const dir = getUnturnedGameDirConfig() || discoverUnturnedSteamDir() || '';
  res.json({ ok: true, dir, status: unturnedBridgeStatus() });
});

app.post('/api/desktop/unturned-game-dir', express.json({ limit: '8kb' }), (req, res) => {
  if (!IS_DESKTOP) return res.status(403).json({ ok: false, error: 'solo_escritorio' });
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ ok: false, error: 'no auth' });
  try {
    const dir = setUnturnedGameDir(req.body?.dir);
    res.json({ ok: true, dir, status: unturnedBridgeStatus() });
  } catch (e) {
    res.status(400).json({ ok: false, error: e && e.message ? e.message : 'dir_failed' });
  }
});

app.post('/api/desktop/unturned-install-mod', express.json({ limit: '8kb' }), async (req, res) => {
  if (!IS_DESKTOP) return res.status(403).json({ ok: false, error: 'solo_escritorio' });
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ ok: false, error: 'no auth' });
  try {
    const result = await installUnturnedMod(req.body?.dir, {
      forceDownload: !!req.body?.forceDownload,
    });
    res.json({ ok: true, ...result, status: unturnedBridgeStatus() });
  } catch (e) {
    res.status(400).json({ ok: false, error: e && e.message ? e.message : 'install_failed' });
  }
});

app.post('/api/desktop/unturned-uninstall-mod', express.json({ limit: '8kb' }), (req, res) => {
  if (!IS_DESKTOP) return res.status(403).json({ ok: false, error: 'solo_escritorio' });
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ ok: false, error: 'no auth' });
  try {
    const result = uninstallUnturnedMod(req.body?.dir);
    res.json({ ok: true, ...result, status: unturnedBridgeStatus() });
  } catch (e) {
    res.status(400).json({ ok: false, error: e && e.message ? e.message : 'uninstall_failed' });
  }
});

app.post('/api/desktop/ensure-mslug-bridge', express.json({ limit: '4kb' }), async (req, res) => {
  if (!IS_DESKTOP) return res.status(403).json({ ok: false, error: 'solo_escritorio' });
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ ok: false, error: 'no auth' });
  const ok = ensureMslugBridge();
  const forceWindow = req.body?.forceWindow !== false;
  const webhook = await ensureMslugSpawnWebhook({ visible: false, forceWindow }).catch(() => false);
  res.json({ ok, webhook, status: mslugBridgeStatus(), webhookStatus: mslugSpawnWebhookStatus() });
});

app.post('/api/desktop/ensure-mslug-webhook', express.json({ limit: '4kb' }), async (req, res) => {
  if (!IS_DESKTOP) return res.status(403).json({ ok: false, error: 'solo_escritorio' });
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ ok: false, error: 'no auth' });
  const forceWindow = req.body?.forceWindow !== false;
  const gameDir = String(req.body?.dir || getMslugGameDirConfig() || '').trim();
  const ok = await ensureMslugSpawnWebhook({ visible: false, forceWindow, gameDir });
  res.json({ ok, webhook: mslugSpawnWebhookStatus(), up: await isMslugSpawnWebhookUp(), gameDir: gameDir || null });
});

app.get('/api/desktop/mslug-health', async (req, res) => {
  if (!IS_DESKTOP) return res.status(403).json({ ok: false, error: 'solo_escritorio' });
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ ok: false, error: 'no auth' });
  const health = await mslugBridgeHealth();
  const webhookUp = await isMslugSpawnWebhookUp();
  res.json({
    ok: !!health?.ok,
    health,
    status: mslugBridgeStatus(),
    gameDir: getMslugGameDirConfig() || health?.game_dir || null,
    bridge_version: MSLUG_BRIDGE_VERSION,
    last_spawn: getMslugLastSpawn(),
    webhook: mslugSpawnWebhookStatus(),
    webhook_up: webhookUp,
  });
});

app.get('/api/desktop/mslug-game-dir', (req, res) => {
  if (!IS_DESKTOP) return res.status(403).json({ ok: false, error: 'solo_escritorio' });
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ ok: false, error: 'no auth' });
  const dir = getMslugGameDirConfig();
  const status = mslugBridgeStatus();
  res.json({ ok: true, dir, active: status.gameDir || null });
});

app.post('/api/desktop/mslug-game-dir', express.json({ limit: '8kb' }), (req, res) => {
  if (!IS_DESKTOP) return res.status(403).json({ ok: false, error: 'solo_escritorio' });
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ ok: false, error: 'no auth' });
  try {
    const dir = setMslugGameDir(req.body?.dir);
    res.json({ ok: true, dir, status: mslugBridgeStatus() });
  } catch (e) {
    res.status(400).json({ ok: false, error: e && e.message ? e.message : 'invalido' });
  }
});

app.post('/api/desktop/mslug-install-mod', express.json({ limit: '8kb' }), (req, res) => {
  if (!IS_DESKTOP) return res.status(403).json({ ok: false, error: 'solo_escritorio' });
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ ok: false, error: 'no auth' });
  try {
    const result = installMslugMod(req.body?.dir);
    res.json({ ok: true, ...result, status: mslugBridgeStatus() });
  } catch (e) {
    res.status(400).json({ ok: false, error: e && e.message ? e.message : 'install_failed' });
  }
});

app.post('/api/desktop/mslug-uninstall-mod', express.json({ limit: '8kb' }), (req, res) => {
  if (!IS_DESKTOP) return res.status(403).json({ ok: false, error: 'solo_escritorio' });
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ ok: false, error: 'no auth' });
  try {
    const result = uninstallMslugMod(req.body?.dir);
    res.json({ ok: true, ...result, status: mslugBridgeStatus() });
  } catch (e) {
    res.status(400).json({ ok: false, error: e && e.message ? e.message : 'uninstall_failed' });
  }
});

// Catálogo + configuración de planes para CUALQUIER usuario autenticado (solo lectura).
// Lo usa la pestaña "Planes" para mostrar la comparación Gratis vs Premium.
app.get('/api/plans', async (req, res) => {
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ error: 'no auth' });
  // En el .exe, traemos la config real de Render y la espejamos en local.
  if (AUTH_REMOTE) {
    const cookie = remoteCookies.get(user.id);
    if (cookie) {
      try {
        const r = await fetch(`${AUTH_REMOTE}/api/plans`, { headers: { Cookie: cookie } });
        const data = await r.json().catch(() => ({}));
        if (r.ok) {
          if (data.config) applyPlansMirror(data.config);
          return res.json(data);
        }
      } catch {}
    }
  }
  res.json({ catalog: CAPABILITIES, config: getPlanConfig() });
});

/* ------------------------------- Administración ------------------------------- */
function requireAdmin(req, res, next) {
  const user = userFromRequest(req);
  if (!user || !user.isAdmin) return res.status(403).json({ error: 'forbidden' });
  req.user = user;
  next();
}

// Lista de todas las cuentas con su estado (live, activación, clave, conexión).
app.get('/api/admin/users', requireAdmin, async (req, res) => {
  // En el .exe (login delegado), el admin gestiona las cuentas REALES de la web.
  if (AUTH_REMOTE && await proxyAdminToRemote(req, res, '/api/admin/users')) {
    syncAllCloudRoomKeysFromRemote().catch(() => {});
    return;
  }
  const out = listUsersDetailed().map((u) => {
    const full = getUserById(u.id);
    const plan = getUserPlan(full); // recalcula y baja a 'free' si el Premium caducó
    const room = rooms.get(u.id);
    const st = room ? room.getStatus() : null;
    return {
      ...u,
      plan,
      premiumUntil: full?.premiumUntil || 0,
      gamesEnabled: full ? isUserGamesEnabled(full) : true,
      live: !!(st && st.live),
      connecting: !!(st && st.connecting),
      liveSince: st ? st.liveSince : null,
      account: st ? st.account : null,
      online: !!(st && st.online),
      lastSeen: st ? st.lastSeen : 0,
    };
  });
  res.json({ users: out });
});

// Activar / desactivar una cuenta.
app.post('/api/admin/activate', express.json(), requireAdmin, async (req, res) => {
  if (AUTH_REMOTE && await proxyAdminToRemote(req, res, '/api/admin/activate', 'POST')) return;
  const { id, active } = req.body || {};
  if (!id) return res.status(400).json({ error: 'falta id' });
  const ok = setUserActive(id, !!active);
  if (!ok) return res.status(404).json({ error: 'cuenta no encontrada' });
  // Si se desactiva, cerramos sus conexiones WS en curso (panel + overlays).
  if (!active) {
    const room = rooms.get(id);
    if (room) room.kickAll?.();
  }
  res.json({ ok: true });
});

// Cambiar el plan de una cuenta (gratis / premium). days>0 => Premium por N días;
// days=0/ausente => si es premium queda FIJO (sin caducidad).
app.post('/api/admin/userplan', express.json(), requireAdmin, async (req, res) => {
  if (AUTH_REMOTE && await proxyAdminToRemote(req, res, '/api/admin/userplan', 'POST')) return;
  const { id, plan, days } = req.body || {};
  if (!id) return res.status(400).json({ error: 'falta id' });
  const ok = setUserPlan(id, plan, days);
  if (!ok) return res.status(404).json({ error: 'cuenta no encontrada' });
  // Avisamos al panel del usuario (si está conectado) para que aplique sus nuevos límites.
  const room = rooms.get(id);
  if (room) room.broadcastCaps?.(capsForUser(getUserById(id)));
  res.json({ ok: true });
});

// Activar / desactivar todos los minijuegos de una cuenta (independiente del plan).
app.post('/api/admin/usergames', express.json(), requireAdmin, async (req, res) => {
  if (AUTH_REMOTE && await proxyAdminToRemote(req, res, '/api/admin/usergames', 'POST')) return;
  const { id, enabled } = req.body || {};
  if (!id) return res.status(400).json({ error: 'falta id' });
  const ok = setUserGamesEnabled(id, !!enabled);
  if (!ok) return res.status(404).json({ error: 'cuenta no encontrada' });
  const room = rooms.get(id);
  if (room) room.broadcastCaps?.(capsForUser(getUserById(id)));
  res.json({ ok: true });
});

// Eliminar una cuenta (excepto admin). Cierra su room, sesiones y datos locales.
app.post('/api/admin/delete-user', express.json(), requireAdmin, async (req, res) => {
  if (AUTH_REMOTE && await proxyAdminToRemote(req, res, '/api/admin/delete-user', 'POST')) return;
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ error: 'falta id' });
  const user = getUserById(id);
  if (!user) return res.status(404).json({ error: 'cuenta no encontrada' });
  if (user.isAdmin) return res.status(403).json({ error: 'no se puede eliminar al administrador' });
  const room = rooms.get(id);
  if (room) {
    try { room.shutdown?.(); } catch {}
    rooms.delete(id);
  }
  if (!deleteUser(id)) return res.status(404).json({ error: 'cuenta no encontrada' });
  if (remoteCookies.delete(id)) saveRemoteCookies();
  try { fs.rmSync(path.join(DATA_DIR, id), { recursive: true, force: true }); } catch {}
  res.json({ ok: true, username: user.username });
});

// Revisión periódica: baja a 'free' a los Premium temporales que ya caducaron y
// avisa en vivo al panel del usuario afectado (si está conectado).
setInterval(() => {
  for (const u of listUsersDetailed()) {
    const full = getUserById(u.id);
    if (!full || full.plan !== 'premium') continue;
    const before = full.plan;
    const eff = getUserPlan(full); // muta a 'free' si caducó
    if (before === 'premium' && eff === 'free') {
      const room = rooms.get(u.id);
      if (room) room.broadcastCaps?.(capsForUser(full));
    }
  }
}, 60 * 1000).unref?.();

// Solo .exe: refresca periódicamente el plan desde Render para los usuarios con el
// panel abierto. Así, si el admin activa premium en la web, el .exe lo aplica en
// ~30s sin que el usuario tenga que cerrar sesión ni reiniciar la app.
if (AUTH_REMOTE) {
  setInterval(() => {
    for (const [id, room] of rooms) {
      if (!room || !room.clientCount) continue;
      const u = getUserById(id);
      if (u) pullRemotePlan(u).catch(() => {});
    }
    syncAllCloudRoomKeysFromRemote().catch(() => {});
  }, 30 * 1000).unref?.();
}

// Configuración de planes: catálogo de capacidades + límites/features por plan.
app.get('/api/admin/plans', requireAdmin, async (req, res) => {
  if (AUTH_REMOTE) {
    const cookie = req.user && remoteCookies.get(req.user.id);
    if (cookie) {
      try {
        const r = await fetch(`${AUTH_REMOTE}/api/admin/plans`, { headers: { Cookie: cookie } });
        const data = await r.json().catch(() => ({}));
        if (r.ok) {
          if (data.config) applyPlansMirror(data.config);
          return res.json(injectLocalCaps(data));
        }
        if (r.status === 401 || r.status === 403) {
          remoteCookies.delete(req.user.id); saveRemoteCookies();
        } else {
          return res.status(r.status).json(data);
        }
      } catch {}
    }
  }
  res.json(injectLocalCaps({ catalog: CAPABILITIES, config: getPlanConfig() }));
});
app.post('/api/admin/plans', express.json(), requireAdmin, async (req, res) => {
  // Guarda primero las capacidades locales (.exe) que el remoto no conoce.
  saveLocalCapsFromBody(req.body || {});
  // Reaplica las caps a los paneles conectados (refleja el cambio local al instante).
  for (const [id, room] of rooms) { const u = getUserById(id); if (u) room.broadcastCaps?.(capsForUser(u)); }
  if (AUTH_REMOTE) {
    const cookie = req.user && remoteCookies.get(req.user.id);
    if (cookie) {
      try {
        const r = await fetch(`${AUTH_REMOTE}/api/admin/plans`, {
          method: 'POST',
          headers: { Cookie: cookie, 'Content-Type': 'application/json' },
          body: JSON.stringify(req.body || {}),
        });
        const data = await r.json().catch(() => ({}));
        if (r.ok) {
          applyPlansMirror(data.config || req.body);
          return res.json(injectLocalCaps(data));
        }
        if (r.status === 401 || r.status === 403) {
          remoteCookies.delete(req.user.id); saveRemoteCookies();
        } else {
          return res.status(r.status).json(data);
        }
      } catch {}
    }
  }
  const config = applyPlansMirror(req.body || {});
  res.json(injectLocalCaps({ ok: true, config }));
});

/* ----------- Versión publicada de la app (.exe) — guardado en Render ----------- */
// Fuente de verdad en DATA_DIR (disco persistente). El .exe consulta GET /api/app-version.
const APP_VERSION_FILE = path.join(DATA_DIR, 'appversion.json');
const WEB_INSTALL_FILE = path.join(DATA_DIR, 'webinstall.json');
function readAppVersion() {
  try { return JSON.parse(fs.readFileSync(APP_VERSION_FILE, 'utf8')); }
  catch { return { version: '', url: '', notes: '', mandatory: false, updatedAt: 0 }; }
}
function readWebInstall() {
  try { return JSON.parse(fs.readFileSync(WEB_INSTALL_FILE, 'utf8')); }
  catch { return { url: '', updatedAt: 0 }; }
}
app.get('/api/app-version', (_req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.json(readAppVersion());
});
app.post('/api/admin/app-version', express.json(), requireAdmin, (req, res) => {
  const b = req.body || {};
  const data = {
    version: String(b.version || '').trim(),
    url: String(b.url || '').trim(),
    notes: String(b.notes || '').trim(),
    mandatory: !!b.mandatory,
    updatedAt: Date.now(),
  };
  try {
    const tmp = APP_VERSION_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, APP_VERSION_FILE);
    // Mismo .exe para nuevos usuarios (web-install) y para auto-actualización.
    if (data.url) {
      const wi = { url: data.url, updatedAt: Date.now() };
      const wtmp = WEB_INSTALL_FILE + '.tmp';
      fs.writeFileSync(wtmp, JSON.stringify(wi, null, 2));
      fs.renameSync(wtmp, WEB_INSTALL_FILE);
    }
  } catch (e) {
    return res.status(500).json({ error: 'No se pudo guardar.' });
  }
  res.json({ ok: true, ...data });
});

/* ----------- Enlace del instalador PC (.exe) ----------- */
app.get('/api/desktop-build', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!IS_DESKTOP) return res.json({ pc: false });
  let stamp = null;
  try {
    stamp = JSON.parse(fs.readFileSync(path.join(PUBLIC_DIR, '.desktop-build.json'), 'utf8'));
  } catch {}
  res.json({ pc: true, version: stamp?.version || '', builtAt: stamp?.builtAt || 0 });
});

app.get('/api/web-install', (_req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.json(readWebInstall());
});
app.post('/api/admin/web-install', express.json(), requireAdmin, (req, res) => {
  const data = { url: String((req.body || {}).url || '').trim(), updatedAt: Date.now() };
  try {
    const tmp = WEB_INSTALL_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, WEB_INSTALL_FILE);
  } catch (e) {
    return res.status(500).json({ error: 'No se pudo guardar.' });
  }
  res.json({ ok: true, ...data });
});

/* ----------- Modo mantenimiento (web en Render) — espejo del remoto ----------- */
app.get('/api/maintenance', async (_req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  if (AUTH_REMOTE) {
    try {
      const r = await fetch(`${AUTH_REMOTE}/api/maintenance?_=${Date.now()}`);
      if (r.ok) return res.json(await r.json());
    } catch {}
  }
  res.json({ enabled: false, message: '' });
});
app.post('/api/admin/maintenance', express.json(), requireAdmin, async (req, res) => {
  if (AUTH_REMOTE && await proxyAdminToRemote(req, res, '/api/admin/maintenance', 'POST')) return;
  res.status(503).json({ error: 'Sin conexión con el servidor remoto.' });
});

/* ----------- Anuncios del panel — espejo del remoto ----------- */
async function fetchRemoteAnnouncements(user) {
  if (!AUTH_REMOTE || !user) return null;
  const remoteCookie = remoteCookies.get(user.id);
  if (!remoteCookie) return null;
  try {
    const r = await fetch(`${AUTH_REMOTE}/api/announcements?_=${Date.now()}`, {
      headers: { Cookie: remoteCookie },
    });
    if (r.ok) return await r.json();
  } catch {}
  return null;
}

app.get('/api/announcements', async (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ error: 'no auth' });
  if (AUTH_REMOTE) {
    const remote = await fetchRemoteAnnouncements(user);
    if (remote) return res.json(remote);
    // Fallback: misma cookie del navegador (panel web en Render, no .exe).
    try {
      const cookie = req.headers.cookie || '';
      if (cookie) {
        const r = await fetch(`${AUTH_REMOTE}/api/announcements?_=${Date.now()}`, { headers: { Cookie: cookie } });
        if (r.ok) return res.json(await r.json());
      }
    } catch {}
  }
  res.json({ announcements: [] });
});
app.post('/api/admin/announcements', express.json(), requireAdmin, async (req, res) => {
  if (AUTH_REMOTE && await proxyAdminToRemote(req, res, '/api/admin/announcements', 'POST')) return;
  res.status(503).json({ error: 'Sin conexión con el servidor remoto.' });
});
app.post('/api/admin/announcements/delete', express.json(), requireAdmin, async (req, res) => {
  if (AUTH_REMOTE && await proxyAdminToRemote(req, res, '/api/admin/announcements/delete', 'POST')) return;
  res.status(503).json({ error: 'Sin conexión con el servidor remoto.' });
});

/* ------------------- Protección básica (disuasión copia) ------------------- */
// Inyecta protect.js en todo HTML servido (panel + overlays). NO es seguridad
// real: solo dificulta la copia casual (clic derecho, F12, ver fuente…).
const PUBLIC_DIR = path.join(__dirname, 'public');
const GUARD_TAG = '<script src="/js/protect.js" defer></script>';
const DESKTOP_HEAD_TAG = '<meta name="livecoins-app" content="desktop"><script>window.__LIVECOINS_PC_BUILD__=true;window.__LIVECOINS_DESKTOP__=true;try{document.documentElement.classList.add("is-desktop");}catch(e){}</script>';
function injectGuard(html) {
  let out = html;
  if (IS_DESKTOP && !out.includes('livecoins-app')) {
    if (out.includes('</head>')) out = out.replace('</head>', DESKTOP_HEAD_TAG + '</head>');
    else if (out.includes('</body>')) out = out.replace('</body>', DESKTOP_HEAD_TAG + '</body>');
    else out += DESKTOP_HEAD_TAG;
  }
  if (out.includes('/js/protect.js')) return out;
  if (out.includes('</head>')) return out.replace('</head>', GUARD_TAG + '</head>');
  if (out.includes('</body>')) return out.replace('</body>', GUARD_TAG + '</body>');
  return out + GUARD_TAG;
}
function sendHtmlFile(res, filePath, status = 200) {
  fs.readFile(filePath, 'utf8', (err, html) => {
    if (err) { res.status(404).end(); return; }
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    res.status(status).type('html').send(injectGuard(html));
  });
}

/* ----------------------------- Panel protegido ----------------------------- */
// El panel (index.html) requiere sesión iniciada y cuenta ACTIVADA por el admin.
app.get(['/', '/index.html'], (req, res) => {
  const user = userFromRequest(req);
  if (!user) return res.redirect('/login.html');
  if (!isUserActive(user)) return sendHtmlFile(res, path.join(PUBLIC_DIR, 'pending.html'));
  sendHtmlFile(res, path.join(PUBLIC_DIR, 'index.html'));
});

// Archivos pesados (videos subidos y audios): caché larga en el navegador. Sus nombres
// son únicos, así que se pueden cachear sin problema y al ACTUALIZAR la página el
// navegador los reutiliza al instante en vez de descargarlos otra vez.
const heavyCache = { maxAge: '30d', immutable: true };
app.use('/uploads', express.static(UPLOADS_DIR, heavyCache));
app.use('/audios', express.static(AUDIOS_DIR, heavyCache));
// Videos de AI: caché larga en el navegador para que al recargar el panel no se
// vuelvan a descargar (antes esto era lo que hacía lenta la carga).
app.use('/video', express.static(VIDEOS_DIR, heavyCache));
app.use('/niveles', express.static(NIVELES_VIDEOS_DIR, heavyCache)); // alias legacy → public/video/niveles

// Cualquier otra página HTML (login, overlays, pending…) se sirve con el script
// de protección inyectado. Debe ir ANTES del estático general.
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  if (!req.path.endsWith('.html')) return next();
  const rel = decodeURIComponent(req.path).replace(/^\/+/, '');
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) return next(); // evita salir de /public
  fs.readFile(filePath, 'utf8', (err, html) => {
    if (err) return next();
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    res.type('html').send(injectGuard(html));
  });
});

// En el .exe evitamos caché agresiva del panel (Electron a veces conserva JS/HTML
// de versiones web anteriores y el usuario ve el panel web sin Juegos/Acciones).
if (IS_DESKTOP) {
  app.use((req, res, next) => {
    if (/\.(html|js|css)$/i.test(req.path) || /mario-presets\.json$/i.test(req.path)) {
      res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.set('Pragma', 'no-cache');
    }
    next();
  });
}

// Resto de estáticos: login, overlays, css, js… Con validación (ETag) para recargas
// rápidas: si el archivo no cambió, el navegador recibe "304 Not Modified" al instante.
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

/* ------------------------------- APIs compartidas ------------------------------- */
app.get('/api/local-sounds', (_req, res) => {
  fs.readdir(AUDIOS_DIR, (err, files) => {
    if (err) return res.json({ results: [] });
    const exts = ['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac', '.webm'];
    const results = files
      .filter((f) => exts.includes(path.extname(f).toLowerCase()))
      .sort((a, b) => a.localeCompare(b))
      .map((f) => ({ name: f, url: '/audios/' + encodeURIComponent(f) }));
    res.json({ results });
  });
});

app.get('/api/local-videos', (_req, res) => {
  fs.readdir(VIDEOS_DIR, { withFileTypes: true }, (err, entries) => {
    if (err) return res.json({ results: [] });
    const exts = ['.mp4', '.webm', '.mov', '.mkv', '.gif', '.png', '.jpg', '.jpeg'];
    const results = entries
      .filter((e) => e.isFile() && exts.includes(path.extname(e.name).toLowerCase()))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b))
      .map((f) => ({ name: f, url: '/video/' + encodeURIComponent(f) }));
    res.json({ results });
  });
});

// Videos de la carpeta «video/batalla» (para la pestaña Batallas).
app.get('/api/local-videos-batalla', (_req, res) => {
  fs.readdir(BATALLA_VIDEOS_DIR, (err, files) => {
    if (err) return res.json({ results: [] });
    const exts = ['.mp4', '.webm', '.mov', '.mkv', '.gif', '.png', '.jpg', '.jpeg'];
    const results = files
      .filter((f) => exts.includes(path.extname(f).toLowerCase()))
      .sort((a, b) => a.localeCompare(b))
      .map((f) => ({ name: f, url: '/video/batalla/' + encodeURIComponent(f) }));
    res.json({ results });
  });
});

// Videos de la carpeta «niveles» (nivel1.webm, nivel2.webm… en public/video/niveles).
app.get('/api/local-videos-niveles', (_req, res) => {
  const seen = new Set();
  const results = [];
  for (const src of nivelesSources()) {
    let files = [];
    try { files = fs.readdirSync(src.dir); } catch { continue; }
    for (const f of files) {
      if (!NIVEL_EXTS.includes(path.extname(f).toLowerCase())) continue;
      const key = f.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      results.push({ name: f, url: src.urlBase + encodeURIComponent(f) });
    }
  }
  results.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  res.json({ results });
});

app.get('/api/sounds', async (req, res) => {
  const q = String(req.query.q || '').trim();
  const url = q
    ? `https://www.myinstants.com/api/v1/instants/?name=${encodeURIComponent(q)}`
    : 'https://www.myinstants.com/api/v1/instants/?best_of=week';
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const data = await r.json();
    const results = (data.results || [])
      .filter((x) => x.sound)
      .slice(0, 30)
      .map((x) => ({ name: x.name, url: x.sound }));
    res.json({ results });
  } catch {
    res.status(502).json({ results: [], error: 'No se pudo cargar la biblioteca.' });
  }
});

app.get('/api/gifts', async (req, res) => {
  try {
    const force = req.query.force === '1' || req.query.force === 'true';
    const region = normalizeGiftRegion(req.query.region);
    let results = await loadGiftCatalog(force, region);
    const user = userFromRequest(req);
    if (user) {
      const community = getRoomForUser(user).getCommunityGifts();
      if (community.length) results = mergeGiftLists(results, community);
    }
    res.json({ results, region });
  } catch (e) {
    const region = normalizeGiftRegion(req.query.region);
    const fallback = giftsCacheByRegion.get(region)?.results || giftsCache || [];
    res.status(502).json({ results: fallback, region, error: 'No se pudo cargar el catálogo de regalos.' });
  }
});

// Regalos de comunidad vistos en el live del usuario (por room).
app.get('/api/community-gifts', (req, res) => {
  const user = userFromRequest(req);
  if (!user) return res.json({ results: [] });
  res.json({ results: getRoomForUser(user).getCommunityGifts() });
});

// Proxy de imágenes externas (CDN de regalos TikTok) para servirlas desde el mismo
// origen. Lo usa el generador de "imagen de regalos" (canvas) para poder exportar el
// PNG sin que el lienzo quede "tainted" por CORS.
app.get('/api/img-proxy', async (req, res) => {
  try {
    const url = String(req.query.url || '');
    if (!/^https?:\/\//i.test(url)) return res.status(400).end('bad url');
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.tiktok.com/' } });
    if (!r.ok) return res.status(502).end('upstream error');
    const ct = r.headers.get('content-type') || 'image/png';
    if (!/^image\//i.test(ct)) return res.status(415).end('not an image');
    const buf = Buffer.from(await r.arrayBuffer());
    res.set('Content-Type', ct);
    res.set('Cache-Control', 'public, max-age=86400');
    res.set('Access-Control-Allow-Origin', '*');
    res.end(buf);
  } catch {
    res.status(502).end('proxy error');
  }
});

// Descarga de packs ZIP (GitHub Releases) para el Editor → Catálogo local (no va en el instalador).
app.get('/api/pack-download', async (req, res) => {
  try {
    const url = String(req.query.url || '');
    if (!/^https:\/\/(github\.com|objects\.githubusercontent\.com)\//i.test(url)) {
      return res.status(400).end('bad url');
    }
    const r = await fetch(url, {
      redirect: 'follow',
      headers: { 'User-Agent': 'Livecoins-PackDownload/1.0' },
    });
    if (!r.ok) return res.status(502).end('upstream error');
    const buf = Buffer.from(await r.arrayBuffer());
    // Packs de juego (p. ej. mari0.zip ~84MB) pueden pasar de 80MB.
    if (buf.length > 150 * 1024 * 1024) return res.status(413).end('too large');
    const ct = r.headers.get('content-type') || 'application/zip';
    res.set('Content-Type', ct);
    res.set('Cache-Control', 'no-store');
    res.set('Access-Control-Allow-Origin', '*');
    res.end(buf);
  } catch {
    res.status(502).end('proxy error');
  }
});

// Stickers/emotes vistos en el live del usuario (por room).
app.get('/api/emotes', (req, res) => {
  const user = userFromRequest(req);
  if (!user) return res.json({ results: [] });
  res.json({ results: getRoomForUser(user).getEmotes() });
});

// Subida de archivos (compartida).
// En modo relay (.exe), sube el archivo final a Render para que los overlays en la
// nube puedan reproducir sonidos/videos/imágenes. Devuelve URL absoluta de la nube.
async function uploadFileToRemote(cookie, filePath, originalName) {
  const buf = await fs.promises.readFile(filePath);
  const r = await fetch(`${AUTH_REMOTE}/api/upload?name=${encodeURIComponent(originalName || 'file')}`, {
    method: 'POST',
    headers: {
      Cookie: cookie,
      'Content-Type': 'application/octet-stream',
    },
    body: buf,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `Error al subir a la nube (${r.status})`);
  if (data.url && String(data.url).startsWith('/')) {
    data.url = AUTH_REMOTE.replace(/\/+$/, '') + data.url;
  }
  return data;
}

function remoteUploadCookie(req) {
  if (!AUTH_REMOTE || process.env.HOKEY_RELAY !== '1') return '';
  const user = userFromRequest(req);
  return (user && remoteCookies.get(user.id)) || '';
}

// Formatos que el navegador (Chromium/Electron) reproduce de forma fiable tal cual.
// El resto (mov, avi, mkv, hevc, etc.) se transcodifica a MP4 H.264 con ffmpeg.
const WEB_FRIENDLY_EXT = new Set([
  '.mp4', '.webm', '.ogg', '.ogv', '.m4v', // video
  '.gif', '.png', '.jpg', '.jpeg', '.webp', '.apng', '.bmp', '.svg', // imagen
  '.mp3', '.wav', '.aac', '.m4a', '.oga', // audio
]);

// Transcodifica un archivo de video a MP4 (H.264/AAC) compatible con navegador.
// Devuelve la ruta del MP4 generado, o null si ffmpeg no está disponible o falla.
function transcodeToMp4(srcPath) {
  return new Promise((resolve) => {
    if (!ffmpegPath) return resolve(null);
    const outPath = srcPath.replace(/\.[^.]+$/, '') + '_web.mp4';
    const args = [
      '-y', '-i', srcPath,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '160k',
      '-movflags', '+faststart',
      outPath,
    ];
    let done = false;
    const finish = (ok) => { if (done) return; done = true; resolve(ok ? outPath : null); };
    let proc;
    try { proc = spawn(ffmpegPath, args, { windowsHide: true }); }
    catch { return finish(false); }
    proc.on('error', () => finish(false));
    proc.on('close', (code) => {
      if (code === 0 && fs.existsSync(outPath)) finish(true);
      else { fs.unlink(outPath, () => {}); finish(false); }
    });
  });
}

const BROWSER_VIDEO_CODEC = new Set(['h264', 'avc', 'avc1']);
const PROBE_VIDEO_EXT = new Set(['.mp4', '.m4v', '.mov', '.webm']);

function probeVideoCodec(srcPath) {
  return new Promise((resolve) => {
    if (!ffmpegPath) return resolve('');
    let proc;
    try { proc = spawn(ffmpegPath, ['-hide_banner', '-i', srcPath], { windowsHide: true }); }
    catch { return resolve(''); }
    let err = '';
    proc.stderr?.on('data', (d) => { err += d.toString(); });
    proc.on('close', () => {
      const m = err.match(/Stream #\d+:\d+(?:\([^)]*\))?: Video: (\w+)/i);
      resolve(m ? m[1].toLowerCase() : '');
    });
    proc.on('error', () => resolve(''));
  });
}

async function uploadNeedsTranscode(dest, ext, looksVideo) {
  if (!looksVideo) return false;
  if (!WEB_FRIENDLY_EXT.has(ext)) return true;
  if (!PROBE_VIDEO_EXT.has(ext)) return false;
  const codec = await probeVideoCodec(dest);
  if (!codec) return false;
  if (BROWSER_VIDEO_CODEC.has(codec)) return false;
  if (ext === '.webm' && (codec === 'vp8' || codec === 'vp9')) return false;
  return true;
}

const UPLOAD_INCOMPATIBLE_MSG =
  'Formato no compatible con Live Studio. Exporta el video como MP4 (H.264 + AAC) e inténtalo de nuevo.';

// Subida de archivos (videos, batallas, imágenes, audios). Se transmite directo a
// disco por streaming, así se aceptan archivos pesados (varios GB) sin límite de
// tamaño y sin cargar todo en memoria. Si el formato no es compatible con el
// navegador (p. ej. .mov), se convierte automáticamente a MP4 para que se reproduzca.
app.post('/api/upload', (req, res) => {
  const safe = String(req.query.name || 'file').replace(/[^\w.\-]+/g, '_').slice(-60);
  const fname = `${Date.now()}_${safe}`;
  const dest = path.join(UPLOADS_DIR, fname);
  const out = fs.createWriteStream(dest);
  let bytes = 0;
  let failed = false;
  const fail = (msg) => {
    if (failed) return;
    failed = true;
    out.destroy();
    fs.unlink(dest, () => {});
    if (!res.headersSent) res.status(500).json({ error: msg || 'no se pudo guardar' });
  };
  req.on('data', (chunk) => { bytes += chunk.length; });
  req.on('aborted', () => fail('subida cancelada'));
  req.on('error', () => fail());
  out.on('error', () => fail());
  out.on('finish', async () => {
    if (failed) return;
    if (!bytes) { fs.unlink(dest, () => {}); return res.status(400).json({ error: 'archivo vacío' }); }
    const ext = (path.extname(fname) || '').toLowerCase();
    const looksVideo = /^video\//i.test(req.headers['content-type'] || '') || !WEB_FRIENDLY_EXT.has(ext);
    let finalPath = dest;
    let finalName = path.basename(fname);
    if (await uploadNeedsTranscode(dest, ext, looksVideo)) {
      const mp4 = await transcodeToMp4(dest);
      if (mp4) {
        fs.unlink(dest, () => {});
        finalPath = mp4;
        finalName = path.basename(mp4);
      } else {
        fs.unlink(dest, () => {});
        return res.status(415).json({ error: UPLOAD_INCOMPATIBLE_MSG });
      }
    }
    const cloudCookie = remoteUploadCookie(req);
    // Modo relay: videos/audios solo en disco local (userData/uploads). Render no guarda copias.
    if (cloudCookie) {
      /* no-op: archivos locales + Browser Source en 127.0.0.1 */
    }
    res.json({ url: '/uploads/' + finalName, converted: finalPath !== dest, cloud: false });
  });
  req.pipe(out);
});

/* ----------------------------- TTS: voces TikTok ----------------------------- */
// Las voces "Disney/personaje" de TikTok no existen en el navegador: se sintetizan
// llamando a un servicio de TikTok TTS desde el servidor (evita CORS) y se devuelve
// el audio en base64. Además, opcionalmente traducimos ES→EN porque esas voces
// solo hablan inglés. Si todo falla, el cliente vuelve a la voz del sistema.

// Caché simple en memoria para traducciones (evita repetir llamadas para frases iguales).
const ttsTranslateCache = new Map();
function ttsTranslateCacheGet(key) { return ttsTranslateCache.get(key) || ''; }
function ttsTranslateCacheSet(key, val) {
  if (!val) return;
  ttsTranslateCache.set(key, val);
  if (ttsTranslateCache.size > 1000) {
    // Borra la entrada más antigua para no crecer sin límite.
    const first = ttsTranslateCache.keys().next().value;
    if (first !== undefined) ttsTranslateCache.delete(first);
  }
}

const ttsAudioCache = new Map();
function ttsAudioCacheGet(key) { return ttsAudioCache.get(key) || ''; }
function ttsAudioCacheSet(key, val) {
  if (!val) return;
  ttsAudioCache.set(key, val);
  if (ttsAudioCache.size > 400) {
    const first = ttsAudioCache.keys().next().value;
    if (first !== undefined) ttsAudioCache.delete(first);
  }
}

function ttsFetchTimeout(ms) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  return { signal: ac.signal, clear: () => clearTimeout(timer) };
}

async function ttsWithTimeout(promise, ms) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Traducción gratuita con MyMemory (sin API key).
async function ttsTranslateMyMemory(text, source, target) {
  const url = 'https://api.mymemory.translated.net/get?q=' +
    encodeURIComponent(text) + '&langpair=' + encodeURIComponent(source + '|' + target);
  const to = ttsFetchTimeout(2800);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: to.signal });
    if (!r.ok) return '';
    const j = await r.json();
    const out = j && j.responseData && j.responseData.translatedText ? String(j.responseData.translatedText).trim() : '';
    // MyMemory a veces devuelve avisos en mayúsculas cuando falla; los descartamos.
    if (!out || /^MYMEMORY WARNING/i.test(out) || /QUERY LENGTH LIMIT/i.test(out)) return '';
    return out;
  } catch {
    return '';
  } finally {
    to.clear();
  }
}

app.post('/api/tts/translate', express.json(), async (req, res) => {
  const text = String((req.body && req.body.text) || '').trim();
  const sourceLang = String((req.body && req.body.source) || 'es').trim().toLowerCase().slice(0, 5) || 'es';
  const targetLang = String((req.body && req.body.target) || 'en').trim().toLowerCase().slice(0, 5) || 'en';
  if (!text) return res.status(400).json({ ok: false, error: 'missing_text' });
  if (text.length > 300) return res.status(400).json({ ok: false, error: 'text_too_long' });
  if (sourceLang === targetLang) return res.json({ ok: true, text, cached: false, same_lang: true });
  const cacheKey = sourceLang + '|' + targetLang + '|' + text.toLowerCase();
  const cached = ttsTranslateCacheGet(cacheKey);
  if (cached) return res.json({ ok: true, text: cached, cached: true });
  try {
    const out = await ttsTranslateMyMemory(text, sourceLang, targetLang);
    if (!out) return res.status(502).json({ ok: false, error: 'translate_failed' });
    ttsTranslateCacheSet(cacheKey, out);
    res.json({ ok: true, text: out, cached: false });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
}); 

// Voces TikTok permitidas (lista blanca). Evita que se pidan voces inexistentes.
const TIKTOK_VOICES = new Set([
  // Disney / personajes
  'en_us_ghostface', 'en_us_chewbacca', 'en_us_c3po', 'en_us_stitch', 'en_us_stormtrooper', 'en_us_rocket',
  'en_female_madam_leota', 'en_male_ghosthost', 'en_male_pirate',
  // Personajes / estilos (inglés)
  'en_male_narration', 'en_male_funny', 'en_female_emotional', 'en_male_cody', 'en_female_samc',
  'en_male_jomboy', 'en_female_betty', 'en_male_cupid', 'en_female_grandma', 'en_male_wizard',
  'en_female_pansino', 'en_male_trevor', 'en_male_ukbutler', 'en_male_ukneighbor', 'en_male_olantekkers',
  'en_male_grinch', 'en_male_deadpool', 'en_male_jarvis', 'en_male_santa', 'en_male_santa_narration',
  'en_male_santa_effect', 'en_female_makeup', 'en_female_richgirl', 'en_male_petercullen',
  // Inglés estándar
  'en_us_001', 'en_us_002', 'en_us_006', 'en_us_007', 'en_us_009', 'en_us_010',
  'en_uk_001', 'en_uk_003', 'en_au_001', 'en_au_002',
  // Español
  'es_002', 'es_mx_002', 'es_male_m3', 'es_female_f6',
  // Otros idiomas
  'fr_001', 'fr_002', 'de_001', 'de_002', 'id_001',
  'pt_br_005', 'br_001', 'br_003', 'br_004', 'br_005',
  'it_male_m18', 'jp_001', 'jp_003', 'jp_005', 'jp_006',
  'kr_002', 'kr_003', 'kr_004',
  // Canto
  'en_female_f08_salut_damour', 'en_male_m03_lobby', 'en_female_f08_warmy_breeze',
  'en_male_m03_sunshine_soon', 'en_female_ht_f08_glorious', 'en_male_sing_funny_it_goes_up',
  'en_male_m2_xhxs_m03_silly', 'en_female_ht_f08_wonderful_world',
  'en_male_sing_deep_jingle', 'en_male_m03_classical', 'en_female_f08_twinkle',
]);

// Sintetiza voz TikTok probando varios proxys públicos en paralelo. Devuelve base64 (mp3) o ''.
async function ttsSynthTikTok(text, voice) {
  const body = JSON.stringify({ text, voice });
  const headers = { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' };
  const tryProxy = async (url, pick) => {
    const to = ttsFetchTimeout(7000);
    try {
      const r = await fetch(url, { method: 'POST', headers, body, signal: to.signal });
      if (!r.ok) return '';
      const j = await r.json().catch(() => null);
      return pick(j);
    } catch {
      return '';
    } finally {
      to.clear();
    }
  };
  const tasks = [
    tryProxy('https://tiktok-tts.weilnet.workers.dev/api/generation', (j) => (j && j.data && !j.error ? String(j.data) : '')),
    tryProxy('https://gesserit.co/api/tts', (j) => (j && (j.base64 || j.data) ? String(j.base64 || j.data) : '')),
  ];
  const results = await Promise.allSettled(tasks);
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value) return r.value;
  }
  return '';
}

app.post('/api/tts/speak', express.json(), async (req, res) => {
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ ok: false, error: 'no_auth' });
  let text = String((req.body && req.body.text) || '').trim();
  const voice = String((req.body && req.body.voice) || '').trim();
  const translate = (req.body && req.body.translate) !== false;
  if (!text) return res.status(400).json({ ok: false, error: 'missing_text' });
  const isEdge = isEdgeTtsVoice(voice);
  if (!isEdge && !TIKTOK_VOICES.has(voice)) return res.status(400).json({ ok: false, error: 'bad_voice' });
  // TikTok/Disney sí pueden estar por plan; Edge (español, todos los países) es libre.
  if (!isEdge && !capsForUser(user).features.tts_tiktok) {
    return res.status(403).json({ ok: false, error: 'plan_locked' });
  }
  if (text.length > 280) text = text.slice(0, 280);

  let translated = false;
  let original = text;
  // Traduce ES→EN solo para voces TikTok en inglés y si el texto parece español.
  if (!isEdge && translate && voice.startsWith('en_') && /[áéíóúñ¿¡üA-Za-z]/.test(text)) {
    try {
      const key = 'es|en|' + text.toLowerCase();
      let en = ttsTranslateCacheGet(key);
      if (!en) {
        en = await ttsWithTimeout(ttsTranslateMyMemory(text, 'es', 'en'), 2800).catch(() => '');
        if (en) ttsTranslateCacheSet(key, en);
      }
      if (en) { text = en; translated = true; }
    } catch { /* si falla o tarda, hablamos el original */ }
  }

  const audioKey = voice + '|' + text.toLowerCase();
  const cachedAudio = ttsAudioCacheGet(audioKey);
  if (cachedAudio) {
    return res.json({ ok: true, audio: cachedAudio, mime: 'audio/mpeg', text, original, translated, cached: true });
  }

  try {
    const audio = isEdge
      ? await ttsWithTimeout(ttsSynthEdge(text, voice, 7000), 7500).catch(() => '')
      : await ttsWithTimeout(ttsSynthTikTok(text, voice), 9000).catch(() => '');
    if (!audio) return res.status(502).json({ ok: false, error: 'synth_failed' });
    ttsAudioCacheSet(audioKey, audio);
    res.json({ ok: true, audio, mime: 'audio/mpeg', text, original, translated });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

/* ----------------------------------------------------------------------------
 * Spotify Song Requests (solo .exe · admin / albertoyt / alee367 / albertoreyesyt).
 * OAuth con PKCE: el callback llega a un listener fijo en SPOTIFY_CALLBACK_PORT.
 * --------------------------------------------------------------------------*/
const SPOTIFY_ALLOWED_USERS = new Set(['albertoyt', 'alee367', 'albertoreyesyt']);

function spotifyUser(req) {
  const user = userFromRequest(req);
  if (!user) return null;
  const uname = String(user.username || '').toLowerCase();
  if (user.isAdmin || SPOTIFY_ALLOWED_USERS.has(uname)) return user;
  return null;
}

app.get('/api/spotify/auth-url', (req, res) => {
  const user = spotifyUser(req);
  if (!user) return res.status(403).json({ error: 'No autorizado.' });
  try {
    const origin = req.headers.origin || (req.headers.referer ? new URL(req.headers.referer).origin : '');
    if (origin) spotify.rememberPanelOrigin(origin);
    res.json({ url: spotify.buildAuthUrl(user.id) });
  } catch (e) {
    res.status(500).json({ error: 'Error iniciando sesión con Spotify: ' + e.message });
  }
});

app.get('/api/spotify/login', (req, res) => {
  const user = spotifyUser(req);
  if (!user) return res.status(403).send('No autorizado.');
  try {
    const url = spotify.buildAuthUrl(user.id);
    res.redirect(url);
  } catch (e) {
    res.status(500).send('Error iniciando sesión con Spotify: ' + e.message);
  }
});

app.get('/api/spotify/status', async (req, res) => {
  const user = spotifyUser(req);
  if (!user) return res.status(403).json({ connected: false });
  try {
    const st = await spotify.getStatus(user.id);
    res.json(st);
  } catch {
    res.json({ connected: false });
  }
});

app.post('/api/spotify/logout', (req, res) => {
  const user = spotifyUser(req);
  if (!user) return res.status(403).json({ ok: false });
  spotify.logout(user.id);
  res.json({ ok: true });
});


/* ----------------------------------------------------------------------------
 * Webhook y Configuración (solo .exe). Pruebas de conexión RCON / OBS / Streamer.bot.
 * Los datos de conexión viven en settings.webhook y se guardan por WebSocket.
 * --------------------------------------------------------------------------*/
function desktopAuthedUser(req) {
  if (!IS_DESKTOP) return null;
  return userFromRequest(req) || null;
}

app.post('/api/webhook/test-rcon', express.json(), async (req, res) => {
  if (!desktopAuthedUser(req)) return res.status(403).json({ ok: false, error: 'No autorizado' });
  try { res.json(await testRcon(req.body || {})); }
  catch (e) { res.json({ ok: false, error: String(e.message || e) }); }
});
app.post('/api/webhook/test-obs', express.json(), async (req, res) => {
  if (!desktopAuthedUser(req)) return res.status(403).json({ ok: false, error: 'No autorizado' });
  try { res.json(await testObs(req.body || {})); }
  catch (e) { res.json({ ok: false, error: String(e.message || e) }); }
});
app.post('/api/webhook/test-streamerbot', express.json(), async (req, res) => {
  if (!desktopAuthedUser(req)) return res.status(403).json({ ok: false, error: 'No autorizado' });
  try { res.json(await testStreamerbot(req.body || {})); }
  catch (e) { res.json({ ok: false, error: String(e.message || e) }); }
});
app.post('/api/webhook/test-servertap', express.json(), async (req, res) => {
  if (!desktopAuthedUser(req)) return res.status(403).json({ ok: false, error: 'No autorizado' });
  try { res.json(await testServertap(req.body || {})); }
  catch (e) { res.json({ ok: false, error: String(e.message || e) }); }
});

const server = http.createServer(app);

/* ----------------------------------------------------------------------------
 * Servidor de Webhook HTTP (solo .exe) en un puerto fijo (3199 por defecto).
 * Permite ejecutar acciones desde herramientas externas (OBS, Stream Deck, scripts):
 *   GET  /get_actions
 *   GET/POST /execute_action?id=1   |  ?name=ACTION_TEST   (+ datos personalizados)
 *   GET/POST /execute_sound?id=sa123 |  ?name=Rosa
 *   GET  /get_videos          (Videos + animaciones Batallas)
 *   GET/POST /execute_video?id=v123 |  ?name=Multiplicador%20x2
 * En el .exe normalmente hay una sola cuenta; si no se indica ?room=, se usa esa.
 * --------------------------------------------------------------------------*/
const WEBHOOK_PORT = Number(process.env.WEBHOOK_PORT) || 3199;
let webhookServer = null;

function resolveWebhookUserByRoomParam(rk) {
  const key = String(rk || '').trim();
  if (!key) return null;
  // Clave local (users.roomKey)
  let usr = getUserByRoomKey(key);
  if (usr) return usr;
  // Solo para el servidor webhook (:3199): también acepta la roomKey de la nube
  // (la de los overlays en relay). No modifica getUserByRoomKey ni el enrutado WS.
  for (const u of listUsers()) {
    const full = getUserById(u.id);
    if (full && String(full.cloudRoomKey || '').trim() === key) return full;
  }
  return null;
}

function resolveWebhookRoom(u) {
  // 1) ?room=… explícito (clave local O clave de overlay/nube).
  const rk = u.searchParams.get('room');
  if (rk) {
    const usr = resolveWebhookUserByRoomParam(rk);
    if (usr) return getRoomForUser(usr);
  }
  // 2) Si solo hay una room activa, esa.
  if (rooms.size === 1) return [...rooms.values()][0];
  // 3) Si solo hay un usuario registrado, su room.
  const all = listUsers();
  if (all.length === 1) return getRoomForUser(all[0]);
  // 4) .exe: último usuario que inició sesión (Stream Deck sin ?room=).
  if (IS_DESKTOP) {
    const last = getDesktopLastLoginUser();
    if (last) return getRoomForUser(last);
  }
  // 5) Cualquier room ya cargada en memoria.
  for (const usr of all) {
    if (usr && rooms.has(usr.id)) return rooms.get(usr.id);
  }
  return null;
}

function startWebhookServer() {
  if (!IS_DESKTOP) return;

  // En relay los videos del panel viven en la nube; el webhook local los lee solo para
  // reproducir en OBS (emitMedia local). No modifica overlays ni settings persistidos.
  async function fetchCloudSettingsForWebhook(userId) {
    if (!AUTH_REMOTE || process.env.HOKEY_RELAY !== '1' || !userId) return null;
    const cookie = remoteCookies.get(userId);
    if (!cookie) return null;
    try {
      const r = await fetch(`${AUTH_REMOTE}/api/my-settings`, { headers: { Cookie: cookie } });
      if (!r.ok) return null;
      const data = await r.json().catch(() => ({}));
      return data?.settings || null;
    } catch {
      return null;
    }
  }

  webhookServer = http.createServer((req, res) => {
    const send = (code, obj) => {
      res.writeHead(code, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      res.end(JSON.stringify(obj));
    };
    if (req.method === 'OPTIONS') { send(204, {}); return; }

    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      (async () => {
        let u; try { u = new URL(req.url, `http://127.0.0.1:${WEBHOOK_PORT}`); } catch { return send(400, { ok: false, error: 'bad_url' }); }
        const data = {};
        for (const [k, v] of u.searchParams) data[k] = v;
        if (body) {
          try { Object.assign(data, JSON.parse(body)); }
          catch { try { for (const [k, v] of new URLSearchParams(body)) data[k] = v; } catch {} }
        }
        const room = resolveWebhookRoom(u);
        if (!room) {
          return send(503, {
            ok: false,
            error: 'no_room',
            message: 'Abre Livecoins, inicia sesión y vuelve a intentar. En la URL puedes usar room= (clave del panel Webhook o la de tus overlays).',
          });
        }

        if (u.pathname === '/get_actions' || u.pathname === '/execute_action' || u.pathname === '/execute_sound') {
          const localSettings = room.getSettings() || {};
          const cloud = await fetchCloudSettingsForWebhook(room.id);
          const mergeById = (localArr, cloudArr) => {
            const map = new Map();
            for (const x of localArr || []) {
              if (x && x.id != null) map.set(String(x.id), x);
            }
            for (const x of cloudArr || []) {
              if (x && x.id != null) map.set(String(x.id), x);
            }
            return [...map.values()];
          };
          let actionsOverride = null;
          let soundAlertsOverride = null;
          if (cloud) {
            const mergedAct = mergeById(localSettings.actions, cloud.actions);
            const mergedSa = mergeById(localSettings.soundAlerts, cloud.soundAlerts);
            if (mergedAct.length) actionsOverride = mergedAct;
            if (mergedSa.length) soundAlertsOverride = mergedSa;
          }
          if (u.pathname === '/get_actions') {
            const actions = Array.isArray(actionsOverride)
              ? actionsOverride.map((a) => ({ id: a.id, name: a.name || '', enabled: a.enabled !== false }))
              : room.listActions();
            return send(200, { ok: true, actions });
          }
          if (u.pathname === '/execute_sound') {
            const r = room.executeWebhookSound({
              id: data.id,
              name: data.name || data.nombre,
              soundAlertsOverride,
            });
            if (!r.ok) return send(r.error === 'not_found' ? 404 : 400, r);
            return send(200, r);
          }
          const r = room.executeWebhookAction({
            id: data.id,
            name: data.name || data.nombre,
            data,
            actionsOverride,
          });
          if (!r.ok) return send(r.error === 'not_found' ? 404 : 400, r);
          return send(200, r);
        }
        if (u.pathname === '/get_videos' || u.pathname === '/execute_video') {
          let videosOverride = null;
          let battleAlertsOverride = null;
          let videosEnabled = undefined;
          let battleAlertsEnabled = undefined;
          const localSettings = room.getSettings() || {};
          const localVids = Array.isArray(localSettings.videos) ? localSettings.videos : [];
          const localBas = Array.isArray(localSettings.battleAlerts) ? localSettings.battleAlerts : [];
          // En relay el panel guarda en la nube; el webhook lee la room local y se queda
          // desfasado si solo completa cuando falta TODA la categoría. Siempre fusionamos.
          const cloud = await fetchCloudSettingsForWebhook(room.id);
          const mergeById = (localArr, cloudArr) => {
            const map = new Map();
            for (const x of localArr || []) {
              if (x && x.id != null) map.set(String(x.id), x);
            }
            for (const x of cloudArr || []) {
              if (x && x.id != null) map.set(String(x.id), x); // nube gana (más reciente)
            }
            return [...map.values()];
          };
          if (cloud) {
            const mergedVids = mergeById(localVids, cloud.videos);
            const mergedBas = mergeById(localBas, cloud.battleAlerts);
            if (mergedVids.length) {
              videosOverride = mergedVids;
              if (cloud.videosEnabled !== undefined) videosEnabled = cloud.videosEnabled;
            }
            if (mergedBas.length) {
              battleAlertsOverride = mergedBas;
              if (cloud.battleAlertsEnabled !== undefined) battleAlertsEnabled = cloud.battleAlertsEnabled;
            }
          }
          if (u.pathname === '/get_videos') {
            return send(200, { ok: true, videos: room.listVideos(videosOverride, battleAlertsOverride) });
          }
          const r = room.executeWebhookVideo({
            id: data.id,
            name: data.name || data.nombre,
            kind: data.kind || data.tipo,
            videosOverride,
            battleAlertsOverride,
            videosEnabled,
            battleAlertsEnabled,
          });
          if (!r.ok) return send(r.error === 'not_found' ? 404 : 400, r);
          return send(200, r);
        }
        send(404, { ok: false, error: 'not_found', message: 'Usa /get_actions, /execute_action, /execute_sound, /get_videos o /execute_video' });
      })().catch((e) => {
        send(500, { ok: false, error: 'internal', message: String(e?.message || e) });
      });
    });
  });
  webhookServer.on('error', (e) => {
    console.error('  [webhook] No se pudo abrir el puerto ' + WEBHOOK_PORT + ':', e.message);
  });
  webhookServer.listen(WEBHOOK_PORT, '0.0.0.0', () => {
    console.log('  [webhook] Escuchando en http://localhost:' + WEBHOOK_PORT + '/');
  });
}

// Servidor dedicado SOLO para el callback de Spotify, en un puerto fijo registrado
// en el panel de Spotify (http://127.0.0.1:8888/spotify/callback).
let spotifyCallbackServer = null;
function startSpotifyCallbackServer() {
  if (spotifyCallbackServer) return;
  spotifyCallbackServer = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url, `http://127.0.0.1:${spotify.SPOTIFY_CALLBACK_PORT}`);
      if (u.pathname !== '/spotify/callback') { res.writeHead(404); res.end('Not found'); return; }
      const err = u.searchParams.get('error');
      const escHtml = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const page = (title, msg, ok) => `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8">
        <title>${escHtml(title)}</title><style>body{font-family:system-ui;background:#0f1320;color:#e8e8ff;
        display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center}
        .box{max-width:440px;padding:32px;border-radius:16px;background:#1a2030;border:1px solid #2a3550}
        h1{color:${ok ? '#22c55e' : '#ef4444'};margin:0 0 12px}p{color:#aab}</style></head>
        <body><div class="box"><h1>${escHtml(title)}</h1><p>${escHtml(msg)}</p></div>
        <script>(function(){
          var ok=${ok ? 'true' : 'false'};
          function done(){try{if(window.opener)window.opener.postMessage('spotify-connected','*');}catch(e){}
            setTimeout(function(){try{window.close();}catch(e){}}, ok?900:2500);}
          setTimeout(done,600);
        })();</script></body></html>`;
      if (err) { res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(page('Cancelado', 'No se autorizó el acceso a Spotify. Puedes cerrar esta ventana.', false)); return; }
      const code = u.searchParams.get('code');
      const state = u.searchParams.get('state');
      await spotify.handleCallback(code, state);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(page('¡Spotify conectado!', 'Ya puedes cerrar esta ventana y volver al panel.', true));
    } catch (e) {
      const escHtml = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><title>Error</title>
        <style>body{font-family:system-ui;background:#0f1320;color:#e8e8ff;display:flex;align-items:center;
        justify-content:center;height:100vh;margin:0;text-align:center}
        .box{max-width:440px;padding:32px;border-radius:16px;background:#1a2030;border:1px solid #2a3550}
        h1{color:#ef4444;margin:0 0 12px}p{color:#aab}</style></head>
        <body><div class="box"><h1>Error</h1><p>${escHtml(e.message || 'desconocido')}. Cierra esta ventana e intenta de nuevo.</p></div></body></html>`);
    }
  });
  spotifyCallbackServer.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.error('  [spotify] Puerto ' + spotify.SPOTIFY_CALLBACK_PORT + ' ocupado por otra instancia.');
      console.error('  [spotify] Cierra Livecoins duplicado o mata el proceso en ese puerto y reinicia.');
    } else {
      console.error('  [spotify] No se pudo abrir el puerto del callback (' + spotify.SPOTIFY_CALLBACK_PORT + '):', e.message);
    }
  });
  spotifyCallbackServer.listen(spotify.SPOTIFY_CALLBACK_PORT, '127.0.0.1', () => {
    console.log('  [spotify] Callback escuchando en ' + spotify.SPOTIFY_REDIRECT_URI + ' (OAuth v2)');
  });
}

/* ----------------------------------------------------------------------------
 * WebSocket: cada conexión se enruta a la room correcta.
 *  - Panel: identificado por la cookie de sesión.
 *  - Overlays de OBS: identificados por ?room=<roomKey> en la URL.
 * --------------------------------------------------------------------------*/
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('error', () => { /* el error del puerto lo maneja server.on('error') */ });

wss.on('connection', (ws, req) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const roomKey = url.searchParams.get('room');
    let user = null;
    if (roomKey) user = getUserByRoomKey(roomKey);
    if (!user) user = userFromRequest(req);
    // OBS Browser Source sin cookies: si solo hay un usuario activo, usar ese.
    if (!user) {
      const active = listUsers().filter((u) => isUserActive(u));
      if (active.length === 1) user = active[0];
    }
    if (!user && rooms.size === 1) {
      user = getUserById([...rooms.keys()][0]);
    }

    if (!user) {
      try { ws.close(4001, 'unauthorized'); } catch {}
      return;
    }

    // La cuenta debe estar activada por el admin para usar panel u overlays.
    if (!isUserActive(user)) {
      try { ws.send(JSON.stringify({ type: 'accountPending' })); } catch {}
      try { ws.close(4003, 'pending'); } catch {}
      return;
    }

    const room = getRoomForUser(user);
    // role=relay|local desde el .exe (modo relay); sin esto emitLocalExec (WEBHOOK, etc.) no llega a la PC.
    room.addClient(ws, url.searchParams.get('role'));

    // Heartbeat a nivel de protocolo: el navegador responde a los ping automáticamente,
    // incluso con la pestaña minimizada o en segundo plano (no depende de JS ni de timers
    // throttled). Así la conexión nunca se cae por inactividad ni por proxies.
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (raw) => {
      let data;
      try { data = JSON.parse(raw.toString()); } catch { return; }
      room.handleMessage(ws, data);
    });
    ws.on('close', () => room.removeClient(ws));
  } catch {
    try { ws.close(); } catch {}
  }
});

// Cada 25s mandamos ping a todos los clientes. Si uno no respondió al ciclo anterior,
// lo damos por muerto y lo cerramos (limpieza); los vivos siguen conectados sin cortes.
const wsHeartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { try { ws.terminate(); } catch {} continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, 25000);
wss.on('close', () => clearInterval(wsHeartbeat));

/* ----------------------------------------------------------------------------
 * Arranque
 * --------------------------------------------------------------------------*/
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error('\n  [!] El puerto ' + PORT + ' ya esta en uso.');
    console.error('      Seguramente Livecoins ya esta abierto en otra ventana.');
    console.error('');
    console.error('      Opcion 1: abre directamente  http://localhost:' + PORT);
    console.error('      Opcion 2: cierra las ventanas/servidores anteriores y vuelve a intentar.');
    console.error('      Opcion 3: usa otro puerto, por ejemplo:  set PORT=3000 && node server.js');
    console.error('');
  } else {
    console.error('\n  [!] Error al iniciar el servidor:', err.message, '\n');
  }
  process.exit(1);
});

// En Render hay que escuchar en 0.0.0.0 (si no, el health check falla y reinicia el servicio).
server.listen(PORT, '0.0.0.0', () => {
  console.log('\n  ┌───────────────────────────────────────────┐');
  console.log('  │   Livecoins  —  panel estilo TikFinity       │');
  console.log('  ├───────────────────────────────────────────┤');
  console.log(`  │   ${eulerStartupLine().padEnd(42)}│`);
  console.log(`  │   Panel:   http://localhost:${PORT}/`.padEnd(46) + '│');
  console.log(`  │   Login:   http://localhost:${PORT}/login.html`.padEnd(46) + '│');
  console.log('  └───────────────────────────────────────────┘\n');
  if (IS_RENDER) {
    const mem = process.memoryUsage();
    console.log(`  [cloud] Render OK — listen 0.0.0.0:${PORT} · rss=${Math.round(mem.rss / 1024 / 1024)}MB`);
  }
  if (AUTH_REMOTE) {
    syncPlansFromRemote().catch(() => {});
    syncAllCloudRoomKeysFromRemote().catch(() => {});
  }
  // Spotify :8888 y webhook :3199 son para PC local. En Render no aportan y
  // suman memoria/puertos; omitirlos evita reinicios innecesarios.
  if (!IS_RENDER) {
    startSpotifyCallbackServer();
    startWebhookServer();
  } else {
    console.log('  [cloud] Spotify callback y webhook :3199 omitidos (solo app PC)');
  }
  if (IS_DESKTOP) {
    console.log('  [bridges] bajo demanda — usa «Iniciar bridge» en cada juego del panel');
  }
});

process.on('uncaughtException', (err) => {
  console.error('[fatal] uncaughtException:', err && (err.stack || err.message || err));
});
process.on('unhandledRejection', (reason) => {
  console.error('[fatal] unhandledRejection:', reason && (reason.stack || reason.message || reason));
});

process.on('SIGINT', () => {
  stopMarioBridge();
  stopPvzToolkitBridge();
  stopPvzHybridBridge();
  stopRepoBridge();
  stopL4dBridge();
  stopUnturnedBridge();
  stopMcCoreBridge();
  stopSmbxTiktokWebhook();
  for (const room of rooms.values()) {
    try { room.shutdown(); } catch {}
  }
  try { streamerRankings.flush(); } catch {}
  process.exit(0);
});
