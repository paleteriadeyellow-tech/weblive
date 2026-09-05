// HOKEY LIVE — servidor multiusuario.
// Cada usuario registrado tiene su propia "room": conexión a TikTok, ajustes, estado,
// batalla y overlays totalmente aislados (ver room.js). Aquí solo va lo compartido:
// catálogo de regalos, archivos estáticos, autenticación y el enrutado de WebSockets.
import { eulerStartupLine } from './euler-config.js';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { TikTokLiveConnection } from 'tiktok-live-connector';
import { createRoom } from './room.js';
import { createLiveLockStore } from './live-lock.js';
import { ensureViewerAvatar, sendCachedAvatar, findCachedAvatar, persistViewerAvatar } from './tt-avatar-cache.js';
import { isEdgeTtsVoice, ttsSynthEdge, EDGE_EN_FALLBACK } from './edge-tts-synth.js';
import { elevenLabsCloneVoice, elevenLabsListVoices, elevenLabsSpeak } from './elevenlabs-tts.js';
import { createStreamerRankings } from './streamer-rankings.js';
import {
  registerUser, verifyLogin, createSession, destroySession,
  userFromRequest, getUserByRoomKey, getUserById, getUserByUsername, listUsers, listUsersDetailed,
  isUserActive, setUserActive, touchLogin,
  getUserPlan, setUserPlan, grantPremiumDays, setUserGamesEnabled, isUserGamesEnabled, getUserAllowedGames, setUserAllowedGames, setUserGameAllowed, setUserSpotifyEnabled, isUserSpotifyEnabled, setUserBaileOverlayEnabled, isUserBaileOverlayEnabled,
  getUserBadgesPayload, recordBadgeLive, markBadgeDirectory, markBadgeDesktop, markBadgeGame, markBadgeDailyTop1, setUserManualBadge,
  deleteUser, upsertMirrorUser, updateMirrorPlan, updateMirrorCloudRoomKey,
  setUserPassword, destroySessionsForUser,
  sessionCookie, clearCookie, parseCookies, SESSION_COOKIE,
  remapSessionUserIds, importSessionsFromRecord, pruneInvalidSessions, hasAnyValidSession,
  saveDesktopLastLogin, clearDesktopLastLogin, bootstrapDesktopSessionToken, ensureSessionForUser,
  inferDesktopLastLoginFromUsers, getSessionUser, getDesktopLastLoginUser,
  publicEmailFields, setUserVerifiedEmail, syncMirrorVerifiedEmail,
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
import { mountPaypalRoutes } from './paypal.js';
import { testRcon, testObs, testStreamerbot, testServertap } from './integrations.js';
import { bootstrapUserMedia, registerUserUpload, userUploadKind, migrateUserMediaDir } from './scripts/user-media-guard.mjs';
import { createMcPresetShare, fetchMcPresetShare } from './mc-preset-share.js';

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
const liveLock = createLiveLockStore(path.join(DATA_DIR, 'live-locks.json'));
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
  // Conservar claves globales (Spotify / overlays / TTS / …) si existían.
  const sharedKeys = [
    'spotify', 'tts', 'timer', 'points', 'webhook', 'shared',
    'perrito', 'jarron', 'vaquita', 'marranito', 'corazonLava', 'pelotas',
    'topDonor', 'giftVs', 'batallaVs', 'batallaMeta', 'batallaMvp', 'batallaTop3',
    'flowMeter', 'giftSeq', 'giftShowcase',
    'winsCounter', 'winsCounterGamer', 'winsCounterMinecraft', 'winsCounterMario', 'winsCounterPro',
    'top1', 'top1fire', 'habibiTop', 'topGift', 'giftGoals', 'giftCounter', 'topStreak',
    'batallaGifts', 'batallaLikes', 'coinMatch', 'sorteosOverlay', 'topKills',
    'toplikesRank', 'topdiamRank', 'toplikesList', 'topdiamList', 'topcommentsRank',
    'topAltRank', 'topAltRankNeon', 'topPointsRank', 'topMultiRank', 'pointsLookup',
    'cameraFrame',
    'hypeBar', 'alertaGift', 'alertaLikes', 'alertaFollow', 'fuegos', 'chatGamer', 'giftRoulette',
    'followerCounter', 'followerCounterMc', 'liveTimer',
    'streamJoin', 'streamJoinMc', 'streamJoinDbz', 'streamJoinMario',
  ];
  for (const key of sharedKeys) {
    const cv = current?.[key];
    const lv = legacy?.[key];
    if (cv != null) merged[key] = cv;
    else if (lv != null) merged[key] = lv;
  }
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
    const musicNameRe = /music|song|melody|mic|guitar|piano|dj|beat|concert|album|drum|karaoke|band|singer|violin|trumpet|spotify|nota|canci[oó]n/i;
    for (const g of (Array.isArray(gifts) ? gifts : [])) {
      if (!g || !g.name) continue;
      const id = String(g.id);
      const prev = merged.get(id) || {};
      const bannerKey = g?.gift_panel_banner?.display_text?.key || '';
      const audio = !!(prev.audio || /audio/i.test(bannerKey) || musicNameRe.test(String(g.name)));
      merged.set(id, {
        id: g.id,
        name: g.name,
        diamonds: g.diamond_count ?? g.diamondCount ?? 0,
        image: g.image?.url_list?.[0] || g.icon?.url_list?.[0] || (typeof g.image === 'string' ? g.image : '') || prev.image || '',
        ...(audio ? { audio: true } : {}),
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
  for (const g of [...(extra || []), ...(base || [])]) {
    const id = String(g?.id ?? '');
    if (!id) continue;
    byId.set(id, { ...byId.get(id), ...g });
  }
  return [...byId.values()].sort((a, b) =>
    (Number(a.diamonds) || 0) - (Number(b.diamonds) || 0) || String(a.name || '').localeCompare(String(b.name || ''))
  );
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
  { key: 'tab_spotify', label: 'Spotify Client ID / conexión (.exe)' },
];
// Minijuegos: exclusivos del .exe (pestaña "Juegos"). Se bloquean como los overlays.
const LOCAL_ONLY_GAMES = [
  { key: 'game_minecraft', label: 'Juego: Minecraft' },
  { key: 'game_mcservidor', label: 'Juego: Servidor Minecraft' },
  { key: 'game_mcparkour', label: 'Juego: Minecraft Parkour' },
  { key: 'game_mckoth', label: 'Juego: Minecraft KOTH' },
  { key: 'game_mcfarm', label: 'Juego: Minecraft Farm' },
  { key: 'game_mcshooter', label: 'Juego: Minecraft Shooters' },
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
  { key: 'game_gtavkoth', label: 'Juego: GTA V King of the Hill' },
  { key: 'game_gtavchaos', label: 'Juego: GTA V Mod Chaos' },
  { key: 'game_gtavchiliad', label: 'Juego: GTA V Chiliad' },
  { key: 'game_unturned', label: 'Juego: Unturned' },
  { key: 'game_crashctr', label: 'Juego: Crash Team Racing (CTR)' },
  { key: 'game_smw', label: 'Juego: Super Mario World' },
  { key: 'game_metalslug', label: 'Juego: Metal Slug by Livecoins' },
  { key: 'game_geometrydash', label: 'Juego: Geometry Dash' },
  { key: 'game_clashroyale', label: 'Juego: Clash Royale' },
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
      if (String(k).startsWith('game_')) {
        delete localCaps[plan][k];
        continue;
      }
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
        const cloud = data.config[plan].features[k];
        const local = localCaps[plan] && localCaps[plan][k];
        if (String(k).startsWith('game_')) {
          if (cloud !== undefined) data.config[plan].features[k] = !!cloud;
          else data.config[plan].features[k] = plan === 'premium';
          continue;
        }
        data.config[plan].features[k] = local !== undefined ? local : (cloud !== false);
      }
    }
  }
  return data;
}

function capsForUser(user) {
  if (!user) {
    const caps = applyLocalCaps(effectiveCaps('free'), 'free');
    caps.spotify = false;
    caps.baileOverlay = false;
    if (caps.features) caps.features.tab_ov_baile = false;
    return caps;
  }
  if (user.isAdmin) {
    const caps = adminCaps();
    caps.spotify = true;
    caps.baileOverlay = true;
    if (caps.features) caps.features.tab_ov_baile = true;
    return caps;
  }
  const raw = getUserPlan(user);
  const plan = (raw === 'premium' || raw === 'founder') ? 'premium' : 'free';
  const caps = applyLocalCaps(effectiveCaps(plan), plan);
  // Override por usuario: off total, o allowlist de juegos concretos.
  if (!isUserGamesEnabled(user)) {
    for (const k of Object.keys(caps.features || {})) {
      if (k.startsWith('game_')) caps.features[k] = false;
    }
  } else {
    const allowed = getUserAllowedGames(user);
    if (Array.isArray(allowed)) {
      // Allowlist solo recorta: no puede abrir un juego que el plan tenga en off.
      for (const k of Object.keys(caps.features || {})) {
        if (k.startsWith('game_')) caps.features[k] = caps.features[k] === true && allowed.includes(k);
      }
    }
  }
  caps.spotify = !!(user.isAdmin || caps.features?.tab_spotify);
  caps.baileOverlay = isUserBaileOverlayEnabled(user);
  if (!caps.features) caps.features = {};
  caps.features.tab_ov_baile = !!caps.baileOverlay;
  return caps;
}

// Sobrescribe las features locales (.exe) según el plan del usuario.
function applyLocalCaps(caps, planName) {
  if (!caps.features) caps.features = {};
  for (const k of LOCAL_ONLY_KEYS) {
    if (String(k).startsWith('game_')) {
      if (caps.features[k] === undefined) caps.features[k] = planName === 'premium';
      continue;
    }
    let v = localCaps[planName] && localCaps[planName][k];
    if (v === undefined && (k === 'tab_spotify' || k === 'tab_youtube')) v = planName === 'premium';
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
let lastPlansSyncAt = 0;
async function syncPlansFromRemote() {
  if (!AUTH_REMOTE) return;
  if (Date.now() - lastPlansSyncAt < 8000) return;
  for (const u of listUsers()) {
    const cookie = remoteCookies.get(u.id);
    if (!cookie) continue;
    try {
      const r = await fetch(`${AUTH_REMOTE}/api/plans`, { headers: { Cookie: cookie } });
      if (!r.ok) continue;
      const data = await r.json();
      if (data.config) {
        applyPlansMirror(data.config);
        lastPlansSyncAt = Date.now();
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

/* Sesión única desactivada: bloqueaba a usuarios que no estaban en otra PC.
   Se corta aquí, que es por donde pasan claim/heartbeat/release y el 409 de la nube. */
const LIVE_LOCK_ENFORCED = false;

async function runLiveLock(userId, action, payload = {}) {
  if (!LIVE_LOCK_ENFORCED) return { ok: true, skipped: true };
  const act = String(action || '');
  const body = {
    deviceId: payload?.deviceId || '',
    username: payload?.username || '',
    force: !!payload?.force,
  };
  if (AUTH_REMOTE) {
    const cookie = remoteCookies.get(userId);
    const key = (getUserById(userId) || {}).cloudRoomKey || '';
    try {
      const headers = { 'Content-Type': 'application/json' };
      let url = `${AUTH_REMOTE}/api/live-lock/${act}`;
      const sendBody = { ...body };
      if (cookie) headers.Cookie = cookie;
      else if (key) {
        url = `${AUTH_REMOTE}/api/live-lock/${act}-key`;
        sendBody.roomKey = key;
      } else {
        return { ok: true, skipped: true };
      }
      const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(sendBody) });
      const data = await r.json().catch(() => ({}));
      if (r.status === 409 || data.code === 'live_in_use') return { ok: false, code: 'live_in_use', message: data.message || liveLock.message };
      if (!r.ok) return { ok: true, skipped: true };
      return data && typeof data === 'object' ? data : { ok: true };
    } catch {
      return { ok: true, skipped: true };
    }
  }
  if (act === 'claim') return liveLock.claim(userId, body.deviceId, body.username);
  if (act === 'heartbeat') return liveLock.heartbeat(userId, body.deviceId);
  if (act === 'release') return liveLock.release(userId, body.deviceId, { force: !!payload?.force });
  return { ok: true };
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
      onStreamerRank: (AUTH_REMOTE && process.env.HOKEY_RELAY === '1') ? undefined : (p) => {
        streamerRankings.record(p);
        try {
          const topId = streamerRankings.getDayTopUserId?.();
          if (topId) markBadgeDailyTop1(topId);
        } catch { /* ignore */ }
      },
      onLiveSessionEnd: ({ userId, durationMs, peakViewers }) => {
        try {
          const recorded = recordBadgeLive(userId, { durationMs, peakViewers });
          const topId = streamerRankings.getDayTopUserId?.();
          if (topId) markBadgeDailyTop1(topId);
          const u = getUserById(userId);
          const room = rooms.get(userId);
          if (u && room?.pushBadges) {
            room.pushBadges(getUserBadgesPayload(u));
          }
          if (recorded && room?.broadcastLog) {
            room.broadcastLog('ok', '🏅 Live válida registrada (+1 a tus insignias).');
          }
        } catch { /* ignore */ }
      },
      onClaimLiveLock: (p) => runLiveLock(user.id, 'claim', p),
      onHeartbeatLiveLock: (p) => runLiveLock(user.id, 'heartbeat', p),
      onReleaseLiveLock: (p) => runLiveLock(user.id, 'release', p),
      onGameExec: (tipo) => {
        try {
          if (markBadgeGame(user.id, tipo)) {
            const r = rooms.get(user.id);
            if (r?.pushBadges) r.pushBadges(getUserBadgesPayload(getUserById(user.id) || user));
          }
        } catch { /* ignore */ }
      },
    });
    room._createdAt = Date.now();
    rooms.set(user.id, room);
  }
  return room;
}

/** En Render: expulsar rooms sin clientes para no acumular TikTok + settings en RAM. */
function reapIdleCloudRooms() {
  if (!IS_RENDER) return;
  const now = Date.now();
  let evicted = 0;
  for (const [id, room] of [...rooms.entries()]) {
    const st = room.getStatus?.() || {};
    if ((st.clients || 0) > 0) continue;
    const lastSeen = Number(st.lastSeen) || Number(room._createdAt) || 0;
    const idleMs = lastSeen ? (now - lastSeen) : (now - (room._createdAt || now));
    // Sin clientes: 5 min. Si nunca hubo WS (solo API): 2 min.
    const limit = lastSeen ? 5 * 60 * 1000 : 2 * 60 * 1000;
    if (idleMs < limit) continue;
    try { room.shutdown?.(); } catch {}
    rooms.delete(id);
    evicted += 1;
  }
  if (evicted) {
    const mem = process.memoryUsage();
    console.log(`[cloud] rooms idle evicted=${evicted} left=${rooms.size} rss=${Math.round(mem.rss / 1024 / 1024)}MB`);
  }
}

// Usuarios conectados al panel y EN VIVO en TikTok (directorio para el panel).
// Criterio: conexión TikTok activa (live). Antes se exigía viewers>0 tras 90s y
// se ocultaban lives reales cuando TikTok no mandaba user_count a tiempo.
function isActivePanelLiveEntry(stOrLive) {
  if (!stOrLive) return false;
  if (stOrLive.live && (stOrLive.account || stOrLive.tiktok)) return true;
  const viewers = Number(stOrLive.viewers) || 0;
  if (viewers > 0 && (stOrLive.account || stOrLive.tiktok)) return true;
  const since = Number(stOrLive.liveSince) || 0;
  return since > 0 && (Date.now() - since) < 15 * 60 * 1000 && !!(stOrLive.account || stOrLive.tiktok);
}

function filterActivePanelLives(lives) {
  return (Array.isArray(lives) ? lives : []).filter(isActivePanelLiveEntry);
}

function mergePanelLivesLists(...lists) {
  const map = new Map();
  for (const list of lists) {
    for (const l of Array.isArray(list) ? list : []) {
      const key = String(l?.tiktok || l?.account || '').replace(/^@+/, '').trim().toLowerCase();
      if (!key) continue;
      const prev = map.get(key);
      if (!prev || (Number(l.viewers) || 0) >= (Number(prev.viewers) || 0)) map.set(key, { ...l, tiktok: key });
    }
  }
  const out = [...map.values()];
  out.sort((a, b) => (Number(b.viewers) || 0) - (Number(a.viewers) || 0) || String(a.tiktok).localeCompare(String(b.tiktok)));
  return out;
}

/** Avisos de live desde el .exe (JSON chico). No son rooms de TikTok en Render. */
const PANEL_LIVES_FILE = path.join(DATA_DIR, 'panel-lives-reports.json');
const desktopLiveReports = new Map();
const DESKTOP_LIVE_TTL_MS = 10 * 60 * 1000;
try {
  const raw = JSON.parse(fs.readFileSync(PANEL_LIVES_FILE, 'utf8'));
  if (raw && typeof raw === 'object') {
    for (const [id, rec] of Object.entries(raw)) {
      if (rec && rec.account) desktopLiveReports.set(id, rec);
    }
  }
} catch { /* sin archivo */ }
let panelLivesSaveTimer = null;
function persistDesktopLiveReports() {
  clearTimeout(panelLivesSaveTimer);
  panelLivesSaveTimer = setTimeout(() => {
    try { fs.writeFile(PANEL_LIVES_FILE, JSON.stringify(Object.fromEntries(desktopLiveReports)), () => {}); } catch {}
  }, 250);
}
function pruneDesktopLiveReports() {
  const now = Date.now();
  let changed = false;
  for (const [id, rec] of desktopLiveReports) {
    if (!rec || (now - Number(rec.at || 0)) > DESKTOP_LIVE_TTL_MS) {
      desktopLiveReports.delete(id);
      changed = true;
    }
  }
  if (changed) persistDesktopLiveReports();
}
function buildPanelLiveItem(userId, st) {
  if (!st?.live || !st?.account) return null;
  if (!isActivePanelLiveEntry(st)) return null;
  const u = getUserById(userId) || getUserByUsername(st.account) || null;
  const tiktok = String(st.account).replace(/^@+/, '');
  if (!tiktok) return null;
  const plan = getUserPlan(u);
  if (u?.id) {
    try { markBadgeDirectory(u.id); } catch { /* ignore */ }
  }
  const badgePayload = u ? getUserBadgesPayload(u) : null;
  return {
    panelUser: u?.username || st.account || '',
    tiktok,
    nickname: st.nickname || tiktok,
    photo: st.photo || '',
    viewers: Number(st.viewers) || 0,
    liveSince: st.liveSince || null,
    live: true,
    plan,
    n: Number(u?.n) || 0,
    url: `https://www.tiktok.com/@${encodeURIComponent(tiktok)}/live`,
    badges: badgePayload?.cardBadges || [],
    allBadges: (badgePayload?.badges || []).map((b) => ({
      id: b.id,
      name: b.name,
      short: b.short,
      img: b.img || `/img/badges/${b.id}.png`,
      earned: !!b.earned,
    })),
  };
}
function applyDesktopLiveReport(user, body) {
  const live = !!body?.live;
  const account = String(body?.account || body?.tiktok || '').replace(/^@+/, '').trim();
  if (!live || !account) {
    if (desktopLiveReports.delete(user.id)) persistDesktopLiveReports();
    return { ok: true, live: false };
  }
  desktopLiveReports.set(user.id, {
    at: Date.now(),
    account,
    nickname: String(body?.nickname || account).slice(0, 80),
    photo: String(body?.photo || '').slice(0, 500),
    viewers: Math.max(0, Number(body?.viewers) || 0),
    liveSince: Number(body?.liveSince) || Date.now(),
  });
  persistDesktopLiveReports();
  return { ok: true, live: true };
}

function listPanelLives() {
  pruneDesktopLiveReports();
  const out = [];
  const seenTiktok = new Set();
  const add = (item) => {
    if (!item) return;
    const key = String(item.tiktok || '').toLowerCase();
    if (!key || seenTiktok.has(key)) return;
    seenTiktok.add(key);
    out.push(item);
  };
  for (const [userId, room] of rooms) {
    add(buildPanelLiveItem(userId, room.getStatus()));
  }
  for (const [userId, rec] of desktopLiveReports) {
    add(buildPanelLiveItem(userId, {
      live: true,
      account: rec.account,
      nickname: rec.nickname,
      photo: rec.photo,
      viewers: rec.viewers,
      liveSince: rec.liveSince,
    }));
  }
  out.sort((a, b) => b.viewers - a.viewers || a.tiktok.localeCompare(b.tiktok));
  return out;
}

/** Cuando el .exe trae lives de Render sin `plan` (API vieja), completa con usuarios locales. */
function enrichPanelLivesPlans(lives) {
  return (Array.isArray(lives) ? lives : []).map((l) => {
    const remote = String(l?.plan || '').toLowerCase();
    if (remote === 'founder') return { ...l, plan: 'founder' };
    if (remote === 'premium' || remote === 'admin') return { ...l, plan: 'premium' };
    const u = (l?.panelUser && getUserByUsername(String(l.panelUser))) || null;
    const local = getUserPlan(u);
    if (local === 'founder') return { ...l, plan: 'founder' };
    return { ...l, plan: local === 'premium' ? 'premium' : (remote || 'free') };
  });
}

// ---- Sincronización de ajustes con el servidor remoto (solo .exe / AUTH_REMOTE) ----
// Filosofía: Render es la fuente compartida. Al abrir el panel traemos (pull) los
// ajustes del usuario desde Render; al guardar, los enviamos (push) a Render.
const pendingSettingsPush = new Map(); // userId -> timeout (debounce)
const activeSettingsPush = new Set();  // userId con POST a Render EN CURSO

function scheduleRemoteSettingsPush(userId) {
  if (!AUTH_REMOTE) return;
  clearTimeout(pendingSettingsPush.get(userId));
  pendingSettingsPush.set(userId, setTimeout(() => {
    pendingSettingsPush.delete(userId);
    // Mantener el candado hasta que el POST termine: un pull concurrente podría
    // bajar perfiles viejos de la nube y pisar lo que se está guardando.
    activeSettingsPush.add(userId);
    pushRemoteProfilesFull(userId)
      .catch(() => {})
      .finally(() => activeSettingsPush.delete(userId));
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
  // Fallback: solo llega el perfil ACTIVO a la nube (los demás quedan pendientes).
  // Avisar en log y en el panel para que no pase inadvertido.
  console.warn(`[sync] push de perfiles a la nube falló (${r ? `HTTP ${r.status}` : 'sin conexión'}); enviando solo el perfil activo (user ${userId}).`);
  try {
    room.broadcastLog?.('warn', '⚠️ No se pudieron sincronizar TODOS los perfiles con la nube; solo se guardó el perfil activo. Se reintentará al próximo cambio.');
  } catch {}
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
  // No importar de la nube mientras hay un guardado local en camino: lo pisaría.
  if (pendingSettingsPush.has(user.id) || activeSettingsPush.has(user.id)) return;
  const remoteProfiles = await fetchRemoteProfilesFull(user.id);
  if (pendingSettingsPush.has(user.id) || activeSettingsPush.has(user.id)) return;
  if (remoteProfiles) {
    const localProfiles = room.getProfilesFull();
    const remoteC = typeof room.profilesFullContentScore === 'function'
      ? room.profilesFullContentScore(remoteProfiles) : 0;
    const localC = typeof room.profilesFullContentScore === 'function'
      ? room.profilesFullContentScore(localProfiles) : 0;
    // Unión si ambos tienen contenido; si no, el lado con datos.
    if (remoteC > 0 && localC > 0) {
      room.importProfilesFull(remoteProfiles, { silent: true, mergeKeepRicher: true });
      scheduleRemoteSettingsPush(user.id);
    } else if (remoteC > localC) {
      room.importProfilesFull(remoteProfiles, { silent: true, mergeKeepRicher: true });
      scheduleRemoteSettingsPush(user.id);
    } else if (localC > 0) {
      scheduleRemoteSettingsPush(user.id);
    }
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
  if (pendingSettingsPush.has(user.id) || activeSettingsPush.has(user.id)) return;
  try {
    const room = getRoomForUser(user);
    const [settingsRes, remoteProfiles] = await Promise.all([
      fetch(`${AUTH_REMOTE}/api/my-settings`, { headers: { Cookie: cookie } }),
      fetchRemoteProfilesFull(user.id),
    ]);
    // Re-chequear el candado DESPUÉS del fetch: si el usuario guardó mientras
    // bajábamos datos de la nube, esos datos ya están viejos y no deben importar.
    if (pendingSettingsPush.has(user.id) || activeSettingsPush.has(user.id)) return;
    const settingsData = settingsRes.ok ? await settingsRes.json().catch(() => ({})) : {};
    const localProfiles = room.getProfilesFull();
    const remoteContent = typeof room.profilesFullContentScore === 'function'
      ? room.profilesFullContentScore(remoteProfiles || {}) : 0;
    const localContent = typeof room.profilesFullContentScore === 'function'
      ? room.profilesFullContentScore(localProfiles) : 0;
    const hasLocal = IS_DESKTOP && desktopHasLocalConfig(user.id);

    // Si hay datos en ambos lados → unir (mergeKeepRicher). Si solo nube → importar.
    // Si solo local → subir a la nube. Nunca reemplazar a ciegas.
    if (remoteProfiles && remoteContent > 0 && localContent > 0) {
      room.importProfilesFull(remoteProfiles, { silent: true, mergeKeepRicher: true });
      scheduleRemoteSettingsPush(user.id);
      return;
    }
    if (remoteProfiles && remoteContent > localContent) {
      room.importProfilesFull(remoteProfiles, { silent: true, mergeKeepRicher: true });
      scheduleRemoteSettingsPush(user.id);
      return;
    }
    if (hasLocal) {
      if (localContent > 0 || !settingsData?.exists) {
        scheduleRemoteSettingsPush(user.id);
      } else if (settingsData?.exists && settingsData.settings) {
        room.applySettings(settingsData.settings);
      }
      return;
    }
    if (remoteProfiles) {
      room.importProfilesFull(remoteProfiles, { silent: true, mergeKeepRicher: true });
      scheduleRemoteSettingsPush(user.id);
    } else if (settingsData?.exists && settingsData.settings) room.applySettings(settingsData.settings);
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
      allowedGames: Object.prototype.hasOwnProperty.call(me, 'allowedGames') ? me.allowedGames : undefined,
      spotifyEnabled: me.spotifyEnabled,
      baileOverlayEnabled: me.baileOverlayEnabled,
      manualBadges: Array.isArray(me.manualBadges) ? me.manualBadges : undefined,
      badgeStats: me.stats && typeof me.stats === 'object' ? me.stats : undefined,
    });
    if (changed) {
      const room = rooms.get(user.id);
      if (room) room.broadcastCaps?.(capsForUser(getUserById(user.id) || user));
    }
    if (me.roomKey) updateMirrorCloudRoomKey(user.id, me.roomKey);
    // Email verificado en la nube → espejo local (si no, el .exe vuelve a pedir verificar).
    if (me.emailVerified && me.email) {
      try { syncMirrorVerifiedEmail(user.id, me.email, true); } catch {}
    }
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
  migrateUserMediaDir(dest, legacyDirs, label);
}

function migrateDesktopMediaToPersistentDirs() {
  const legacyData = String(process.env.LEGACY_DATA_DIR || '').trim();
  bootstrapUserMedia({
    uploadsDir: UPLOADS_DIR,
    audiosDir: AUDIOS_DIR,
    dataDir: DATA_DIR,
    isDesktop: IS_DESKTOP,
    legacyUploads: [
      path.join(__dirname, 'public', 'uploads'),
      path.join(DATA_DIR, 'uploads'),
      legacyData ? path.join(legacyData, 'uploads') : '',
      ...desktopLegacyUserDataSubdirs('uploads'),
    ].filter(Boolean),
    legacyAudios: [
      path.join(__dirname, 'public', 'audios'),
      path.join(DATA_DIR, 'audios'),
      legacyData ? path.join(legacyData, 'audios') : '',
      ...desktopLegacyUserDataSubdirs('audios'),
    ].filter(Boolean),
  });
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
// En el .exe (AUTH_REMOTE): si no hay sesión con la nube, NO mutamos el espejo local en
// silencio (crearía divergencia con las cuentas reales de la web). Avisamos claro.
function adminCloudUnavailable(res) {
  return res.status(503).json({
    error: 'Sin sesión con la nube: no se pueden modificar cuentas ahora. Cierra sesión y vuelve a entrar con internet.',
    cloudDown: true,
  });
}

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
    let cookie = getSetCookies(r.headers).map((c) => c.split(';')[0]).join('; ');
    if (!cookie) {
      const login = await remoteLogin(username, password);
      if (login.ok && login.cookie) cookie = login.cookie;
    }
    return { ok: true, email: data.email || email || null, emailVerified: !!data.emailVerified, cookie };
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
    if (rr.cookie) { remoteCookies.set(user.id, rr.cookie); saveRemoteCookies(); }
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
      syncPlansFromRemote().catch(() => {});
      if (remote.isAdmin) {
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
  if (user) {
    const token = ensureSessionForUser(user.id);
    if (token) res.setHeader('Set-Cookie', sessionCookie(token));
    return res.json({ ok: true, username: user.username, token: token || null });
  }
  const token = bootstrapDesktopSessionToken();
  if (!token) return res.status(401).json({ ok: false });
  res.setHeader('Set-Cookie', sessionCookie(token));
  const u = getSessionUser(token);
  res.json({ ok: true, username: u?.username || '', token });
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
    await syncPlansFromRemote().catch(() => {});
  }
  const caps = capsForUser(getUserById(user.id) || user);
  const fullUser = getUserById(user.id) || user;
  const hasRemoteCookie = !!(AUTH_REMOTE && remoteCookies.get(user.id));
  const cloudRoomKey = (remoteMe && remoteMe.roomKey) || fullUser.cloudRoomKey || null;
  const badgePayload = getUserBadgesPayload(fullUser);
  if (remoteMe && Array.isArray(remoteMe.manualBadges)) {
    badgePayload.manualBadges = remoteMe.manualBadges;
  }
  res.json({
    id: fullUser.id || user.id,
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
    allowedGames: fullUser.isAdmin ? null : (Array.isArray(fullUser.allowedGames) ? fullUser.allowedGames : null),
    spotifyEnabled: isUserSpotifyEnabled(fullUser),
    baileOverlayEnabled: isUserBaileOverlayEnabled(fullUser),
    ...badgePayload,
    gameStatus: readGameStatus(),
    caps: { plan: caps.plan, limits: caps.limits, features: caps.features, spotify: !!caps.spotify, baileOverlay: !!caps.baileOverlay },
    email: (remoteMe && remoteMe.email) || publicEmailFields(fullUser).email,
    // Preferir true si la nube O el espejo local ya tienen el correo verificado.
    emailVerified: !!(remoteMe && remoteMe.emailVerified)
      || publicEmailFields(fullUser).emailVerified
      || !!(fullUser && fullUser.emailVerified && fullUser.email),
    mailConfigured: (remoteMe && typeof remoteMe.mailConfigured === 'boolean')
      ? remoteMe.mailConfigured
      : mailStatus().configured,
  });
});

mountPaypalRoutes(app, {
  userFromRequest,
  grantPremiumDays,
  AUTH_REMOTE,
  getRemoteCookie: (id) => remoteCookies.get(id),
  onGranted: (userId) => {
    const room = rooms.get(userId);
    if (room) room.broadcastCaps?.(capsForUser(getUserById(userId)));
  },
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
    const cookie = remoteCookies.get(user.id);
    if (!cookie) {
      return res.status(503).json({ error: 'Sin sesión con la nube. Cierra sesión y vuelve a entrar.' });
    }
    try {
      const r = await fetch(`${AUTH_REMOTE}/api/account/email/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify(req.body || {}),
      });
      if (r.status === 401 || r.status === 403) {
        remoteCookies.delete(user.id);
        saveRemoteCookies();
        return res.status(503).json({ error: 'Sin sesión con la nube. Cierra sesión y vuelve a entrar.' });
      }
      const data = await r.json().catch(() => ({}));
      // Persistir también en el espejo local para que el aviso no reaparezca sin cookie remota.
      if (r.ok && data.email) {
        try { setUserVerifiedEmail(user.id, data.email); } catch {}
      }
      return res.status(r.status).json(data);
    } catch {
      return res.status(503).json({ error: 'Sin sesión con la nube. Cierra sesión y vuelve a entrar.' });
    }
  }
  const r = verifyLinkEmailCode(user.id, req.body?.code);
  if (r.error) return res.status(400).json({ error: r.error });
  res.json({ ok: true, email: r.email, message: r.message, emailVerified: true });
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

app.post('/api/panel-lives/report', express.json({ limit: '8kb' }), async (req, res) => {
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ error: 'no auth' });
  if (AUTH_REMOTE) {
    const cookie = remoteCookies.get(user.id);
    if (!cookie) return res.status(503).json({ error: 'Sin sesión con la nube.' });
    try {
      const r = await fetch(`${AUTH_REMOTE}/api/panel-lives/report`, {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify(req.body || {}),
      });
      const data = await r.json().catch(() => ({}));
      return res.status(r.status).json(data);
    } catch {
      return res.status(503).json({ error: 'Sin conexión con la nube.' });
    }
  }
  res.json(applyDesktopLiveReport(user, req.body || {}));
});

app.post('/api/mc-preset-share', express.json({ limit: '700kb' }), async (req, res) => {
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ error: 'Inicia sesión para compartir presets.' });
  const out = createMcPresetShare(DATA_DIR, req.body, { by: user.username || user.id || '' });
  if (out.error) return res.status(400).json({ error: out.error });
  res.json(out);
});

app.get('/api/mc-preset-share/:code', async (req, res) => {
  const out = fetchMcPresetShare(DATA_DIR, req.params.code);
  if (out.error) return res.status(404).json({ error: out.error });
  res.json(out);
});

app.post('/api/panel-lives/report-key', express.json({ limit: '8kb' }), async (req, res) => {
  const key = String(req.body?.roomKey || '').trim();
  if (!key) return res.status(400).json({ error: 'falta roomKey' });
  if (AUTH_REMOTE) {
    try {
      const r = await fetch(`${AUTH_REMOTE}/api/panel-lives/report-key`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req.body || {}),
      });
      const data = await r.json().catch(() => ({}));
      return res.status(r.status).json(data);
    } catch {
      return res.status(503).json({ error: 'Sin conexión con la nube.' });
    }
  }
  const user = getUserByRoomKey(key);
  if (!user) return res.status(401).json({ error: 'bad key' });
  if (!isUserActive(user)) return res.status(403).json({ error: 'pending' });
  res.json(applyDesktopLiveReport(user, req.body || {}));
});

function liveLockHttpResult(res, r) {
  if (r && r.ok === false && r.code === 'live_in_use') return res.status(409).json(r);
  if (r && r.ok === false && r.code === 'bad_device') return res.status(400).json(r);
  return res.json(r || { ok: true });
}
async function handleLiveLockAuthed(req, res, action) {
  if (AUTH_REMOTE) {
    const user = userFromRequest(req);
    if (!user) return res.status(401).json({ error: 'no auth' });
    const r = await runLiveLock(user.id, action, req.body || {});
    return liveLockHttpResult(res, r);
  }
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ error: 'no auth' });
  if (!isUserActive(user)) return res.status(403).json({ error: 'pending' });
  const r = await runLiveLock(user.id, action, req.body || {});
  return liveLockHttpResult(res, r);
}
async function handleLiveLockByKey(req, res, action) {
  const key = String(req.body?.roomKey || '').trim();
  if (!key) return res.status(400).json({ error: 'falta roomKey' });
  if (AUTH_REMOTE) {
    try {
      const r = await fetch(`${AUTH_REMOTE}/api/live-lock/${action}-key`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req.body || {}),
      });
      const data = await r.json().catch(() => ({}));
      return res.status(r.status).json(data);
    } catch {
      return res.status(503).json({ error: 'Sin conexión con la nube.' });
    }
  }
  const user = getUserByRoomKey(key);
  if (!user) return res.status(401).json({ error: 'bad key' });
  if (!isUserActive(user)) return res.status(403).json({ error: 'pending' });
  const r = await runLiveLock(user.id, action, req.body || {});
  return liveLockHttpResult(res, r);
}
app.post('/api/live-lock/claim', express.json({ limit: '8kb' }), (req, res) => handleLiveLockAuthed(req, res, 'claim'));
app.post('/api/live-lock/heartbeat', express.json({ limit: '8kb' }), (req, res) => handleLiveLockAuthed(req, res, 'heartbeat'));
app.post('/api/live-lock/release', express.json({ limit: '8kb' }), (req, res) => handleLiveLockAuthed(req, res, 'release'));
app.post('/api/live-lock/claim-key', express.json({ limit: '8kb' }), (req, res) => handleLiveLockByKey(req, res, 'claim'));
app.post('/api/live-lock/heartbeat-key', express.json({ limit: '8kb' }), (req, res) => handleLiveLockByKey(req, res, 'heartbeat'));
app.post('/api/live-lock/release-key', express.json({ limit: '8kb' }), (req, res) => handleLiveLockByKey(req, res, 'release'));

app.get('/api/panel-lives', async (req, res) => {
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ error: 'no auth' });
  const localLives = listPanelLives();
  // En .exe (relay) los lives reales están en Render: hay que pedirlos a la nube.
  // Se fusionan con los locales para no perder a quien esté live solo en esta PC.
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
        const merged = mergePanelLivesLists(filterActivePanelLives(data.lives), localLives);
        return res.json({ lives: enrichPanelLivesPlans(merged) });
      } catch { /* siguiente intento */ }
    }
  }
  res.json({ lives: localLives });
});

/** Directorio público (sin cookie): el .exe lo usa si falla la sesión remota. */
app.get('/api/panel-lives-public', (_req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
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

function avatarDataDirForUser(userId) {
  return userId ? path.join(DATA_DIR, userId) : null;
}

function avatarDataDirFromRequest(req) {
  const authUser = userFromRequest(req);
  if (authUser) return avatarDataDirForUser(authUser.id);
  const key = String(req.query.room || req.query.roomKey || '').trim();
  if (key) {
    const u = getUserByRoomKey(key);
    if (u) return avatarDataDirForUser(u.id);
  }
  if (IS_DESKTOP && rooms.size === 1) {
    const [uid] = rooms.keys();
    return avatarDataDirForUser(uid);
  }
  return null;
}

function ttAvatarPublicUrl(username) {
  const u = String(username || '').replace(/^@/, '').trim();
  if (!u) return '';
  return `/api/tt-avatar?user=${encodeURIComponent(u)}`;
}

let tkAvatarActive = 0;
const tkAvatarWait = [];
async function fetchTikTokAvatarByUsername(username) {
  const unique = parseTikTokUsernameInput(username);
  if (!unique) return '';
  await new Promise((resolve) => {
    const run = () => { tkAvatarActive++; resolve(); };
    if (tkAvatarActive < 2) run();
    else tkAvatarWait.push(run);
  });
  try {
    const conn = new TikTokLiveConnection(unique, { fetchRoomInfoOnConnect: false });
    let user = {};
    let avatar = '';
    try {
      const info = await conn.webClient.fetchRoomInfoFromApiLive({ uniqueId: unique });
      user = info?.data?.user || info?.user || {};
      avatar = extractTikTokUserAvatar(user);
    } catch { /* fallback HTML */ }
    if (!avatar) {
      try {
        const info = await conn.webClient.fetchRoomInfoFromHtml({ uniqueId: unique });
        user = info?.user || info?.liveRoomUserInfo?.user || user;
        avatar = extractTikTokUserAvatar(user);
      } catch { /* ignore */ }
    }
    return String(avatar || '').trim();
  } catch {
    return '';
  } finally {
    tkAvatarActive--;
    const next = tkAvatarWait.shift();
    if (next) next();
  }
}

app.get('/api/tiktok-profile', async (req, res) => {
  const username = parseTikTokUsernameInput(req.query.url || req.query.user || '');
  if (!username) return res.status(400).json({ error: 'Usuario TikTok inválido' });
  try {
    const conn = new TikTokLiveConnection(username, { fetchRoomInfoOnConnect: false });
    let user = {};
    let avatar = '';
    let nickname = '';

    try {
      const info = await conn.webClient.fetchRoomInfoFromApiLive({ uniqueId: username });
      user = info?.data?.user || info?.user || {};
      avatar = extractTikTokUserAvatar(user);
      nickname = String(user.nickname || user.nickName || user.display_name || user.displayName || '').trim();
    } catch { /* fallback HTML */ }

    if (!avatar) {
      try {
        const info = await conn.webClient.fetchRoomInfoFromHtml({ uniqueId: username });
        user = info?.user || info?.liveRoomUserInfo?.user || user;
        avatar = extractTikTokUserAvatar(user);
        if (!nickname) {
          nickname = String(user.nickname || user.nickName || user.display_name || user.displayName || '').trim();
        }
      } catch { /* ignore */ }
    }

    if (!avatar) avatar = await fetchTikTokAvatarByUsername(username);

    const unique = String(user.uniqueId || username).replace(/^@/, '');
    const dataDir = avatarDataDirFromRequest(req);

    if (!avatar && dataDir) {
      const hit = findCachedAvatar(dataDir, unique);
      if (hit) {
        return res.json({
          username: unique,
          nickname: nickname || unique,
          profileUrl: `https://www.tiktok.com/@${unique}`,
          avatar: ttAvatarPublicUrl(unique),
          userId: String(user.id || user.userId || user.user_id || '').trim(),
        });
      }
    }

    if (!avatar) return res.status(404).json({ error: 'No se encontró foto de perfil' });
    if (dataDir) {
      try { await persistViewerAvatar(dataDir, unique, avatar); } catch { /* ignore */ }
    }
    res.json({
      username: unique,
      nickname: nickname || unique,
      profileUrl: `https://www.tiktok.com/@${unique}`,
      avatar: dataDir ? ttAvatarPublicUrl(unique) : avatar,
      userId: String(user.id || user.userId || user.user_id || '').trim(),
    });
  } catch (e) {
    res.status(502).json({ error: e?.message || 'No se pudo obtener el perfil' });
  }
});

app.get('/api/tt-avatar', async (req, res) => {
  const username = parseTikTokUsernameInput(req.query.user || req.query.url || '');
  if (!username) return res.status(400).end('bad user');
  const dataDir = avatarDataDirFromRequest(req);
  if (!dataDir) return res.status(404).end('no avatar');
  res.set('Access-Control-Allow-Origin', '*');
  const refresh = String(req.query.refresh || '') === '1';
  try {
    let cached = !refresh ? findCachedAvatar(dataDir, username) : null;
    if (!cached) {
      cached = await ensureViewerAvatar(dataDir, username, {
        refresh,
        lookupTikTok: fetchTikTokAvatarByUsername,
      });
    }
    if (cached && sendCachedAvatar(res, cached)) return;
  } catch { /* fall through */ }
  res.status(404).end('no avatar');
});

app.get('/api/user-avatar', async (req, res) => {
  const username = parseTikTokUsernameInput(req.query.user || req.query.url || '');
  if (!username) return res.status(400).end('bad user');
  const authUser = userFromRequest(req);
  if (!authUser) return res.status(401).end('no auth');
  const room = getRoomForUser(authUser);
  const hint = String(room?.getViewerPhoto?.(username) || '').trim();
  try {
    const cached = await ensureViewerAvatar(room.dataDir, username, {
      hintUrl: hint,
      refresh: String(req.query.refresh || '') === '1',
      lookupTikTok: fetchTikTokAvatarByUsername,
    });
    if (cached && sendCachedAvatar(res, cached)) return;
  } catch { /* fall through */ }
  res.status(404).end('no avatar');
});

app.post('/api/my-settings', express.json({ limit: '8mb' }), (req, res) => {
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ error: 'no auth' });
  const room = getRoomForUser(user);
  room.applySettings(req.body?.settings || {});
  res.json({ ok: true });
});

/* Editor Pro — estado live + plantillas en disco (DATA_DIR / userData, sobreviven a updates) */
const editorRapidoLiveByRoom = new Map();
const ER_DIR = path.join(DATA_DIR, 'editor-rapido');
const ER_TPL_DIR = path.join(ER_DIR, 'templates');
const ER_MEDIA_DIR = path.join(ER_DIR, 'media');
const ER_INDEX_FILE = path.join(ER_DIR, 'index.json');

function ensureEditorRapidoDirs() {
  try { fs.mkdirSync(ER_TPL_DIR, { recursive: true }); } catch {}
  try { fs.mkdirSync(ER_MEDIA_DIR, { recursive: true }); } catch {}
}

function erSafeId(id) {
  const s = String(id || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
  return s || '';
}

function erReadIndex() {
  try {
    const raw = JSON.parse(fs.readFileSync(ER_INDEX_FILE, 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function erWriteIndex(list) {
  ensureEditorRapidoDirs();
  fs.writeFileSync(ER_INDEX_FILE, JSON.stringify(list, null, 2), 'utf8');
}

function erPersistDataUrl(dataUrl) {
  const s = String(dataUrl || '');
  if (!s) return '';
  if (!s.startsWith('data:')) return s;
  const m = /^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(s);
  if (!m) return '';
  ensureEditorRapidoDirs();
  const mime = String(m[1] || '').toLowerCase();
  let ext = 'bin';
  if (mime.includes('png')) ext = 'png';
  else if (mime.includes('gif')) ext = 'gif';
  else if (mime.includes('webp')) ext = 'webp';
  else if (mime.includes('jpeg') || mime.includes('jpg')) ext = 'jpg';
  else if (mime.includes('svg')) ext = 'svg';
  const buf = Buffer.from(m[2].replace(/\s+/g, ''), 'base64');
  if (!buf.length || buf.length > 28 * 1024 * 1024) return '';
  const hash = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 20);
  const name = `${hash}.${ext}`;
  const fp = path.join(ER_MEDIA_DIR, name);
  if (!fs.existsSync(fp)) fs.writeFileSync(fp, buf);
  return `/api/editor-rapido/media/${name}`;
}

function erNormalizeItemSrc(item) {
  if (!item || typeof item !== 'object' || !item.src) return item;
  const src = String(item.src);
  if (src.startsWith('data:')) {
    const saved = erPersistDataUrl(src);
    return saved ? { ...item, src: saved } : item;
  }
  return item;
}

function erSanitizeTemplatePayload(tpl) {
  const id = erSafeId(tpl?.id);
  if (!id) return null;
  const data = tpl?.data && typeof tpl.data === 'object' ? { ...tpl.data } : {};
  if (Array.isArray(data.overlays)) data.overlays = data.overlays.map(erNormalizeItemSrc);
  if (Array.isArray(data.gifts)) data.gifts = data.gifts.map(erNormalizeItemSrc);
  if (typeof data.fondoCustomSrc === 'string' && data.fondoCustomSrc.startsWith('data:')) {
    data.fondoCustomSrc = erPersistDataUrl(data.fondoCustomSrc) || '';
  }
  return {
    id,
    name: String(tpl?.name || 'Plantilla').slice(0, 80),
    protected: true,
    savedAt: Number(tpl?.savedAt) || Date.now(),
    data,
  };
}

function erListTemplates() {
  ensureEditorRapidoDirs();
  const index = erReadIndex();
  const out = [];
  const seen = new Set();
  for (const meta of index) {
    const id = erSafeId(meta?.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const fp = path.join(ER_TPL_DIR, `${id}.json`);
    try {
      const full = JSON.parse(fs.readFileSync(fp, 'utf8'));
      if (full?.id && full?.data) {
        out.push({
          id: full.id,
          name: String(full.name || meta.name || 'Plantilla').slice(0, 80),
          protected: true,
          savedAt: Number(full.savedAt || meta.savedAt) || Date.now(),
          data: full.data,
        });
        continue;
      }
    } catch {}
  }
  try {
    for (const name of fs.readdirSync(ER_TPL_DIR)) {
      if (!name.endsWith('.json')) continue;
      const id = erSafeId(name.slice(0, -5));
      if (!id || seen.has(id)) continue;
      try {
        const full = JSON.parse(fs.readFileSync(path.join(ER_TPL_DIR, name), 'utf8'));
        if (full?.id && full?.data) {
          seen.add(id);
          out.push({
            id: full.id,
            name: String(full.name || 'Plantilla').slice(0, 80),
            protected: true,
            savedAt: Number(full.savedAt) || Date.now(),
            data: full.data,
          });
        }
      } catch {}
    }
  } catch {}
  out.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
  return out;
}

function erSanitizeLivePayload(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const data = { ...raw };
  if (Array.isArray(data.overlays)) data.overlays = data.overlays.map(erNormalizeItemSrc);
  if (Array.isArray(data.gifts)) data.gifts = data.gifts.map(erNormalizeItemSrc);
  if (typeof data.fondoCustomSrc === 'string' && data.fondoCustomSrc.startsWith('data:')) {
    data.fondoCustomSrc = erPersistDataUrl(data.fondoCustomSrc) || '';
  }
  if (data.fondo === 'custom' && !data.fondoCustomSrc) {
    data.fondoCustomSrc = '';
  }
  return data;
}

function erLiveFile(room) {
  const key = erSafeId(room) || 'local';
  return path.join(ER_DIR, `live_${key}.json`);
}

function erReadLive(room) {
  const mem = editorRapidoLiveByRoom.get(room);
  if (mem?.payload) return mem;
  try {
    ensureEditorRapidoDirs();
    const raw = JSON.parse(fs.readFileSync(erLiveFile(room), 'utf8'));
    if (raw?.payload) {
      editorRapidoLiveByRoom.set(room, raw);
      return raw;
    }
  } catch {}
  return null;
}

function erWriteLive(room, payload) {
  const cleaned = erSanitizeLivePayload(payload);
  if (!cleaned) return null;
  const entry = { updatedAt: Date.now(), payload: cleaned };
  editorRapidoLiveByRoom.set(room, entry);
  try {
    ensureEditorRapidoDirs();
    fs.writeFileSync(erLiveFile(room), JSON.stringify(entry), 'utf8');
    if (room !== 'local') {
      editorRapidoLiveByRoom.set('local', entry);
      fs.writeFileSync(erLiveFile('local'), JSON.stringify(entry), 'utf8');
    }
  } catch {}
  return entry;
}

function erWarmLiveFromDisk() {
  try {
    ensureEditorRapidoDirs();
    for (const name of fs.readdirSync(ER_DIR)) {
      if (!/^live_[a-zA-Z0-9_-]+\.json$/i.test(name)) continue;
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(ER_DIR, name), 'utf8'));
        if (!raw?.payload) continue;
        const room = name.slice(5, -5) || 'local';
        editorRapidoLiveByRoom.set(room, raw);
      } catch {}
    }
  } catch {}
}
erWarmLiveFromDisk();

app.get('/api/editor-rapido/live', (req, res) => {
  const room = String(req.query.room || req.query.key || 'local').trim() || 'local';
  const data = erReadLive(room);
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, live: data });
});
app.post('/api/editor-rapido/live', express.json({ limit: '32mb' }), (req, res) => {
  const room = String(req.body?.room || req.query.room || 'local').trim() || 'local';
  const payload = req.body?.payload;
  if (!payload || typeof payload !== 'object') {
    return res.status(400).json({ ok: false, error: 'payload required' });
  }
  try {
    const entry = erWriteLive(room, payload);
    if (!entry) return res.status(400).json({ ok: false, error: 'payload inválido' });
    res.json({ ok: true, live: entry });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || 'error' });
  }
});

app.get('/api/editor-rapido/templates', (_req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, templates: erListTemplates() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || 'error' });
  }
});

app.post('/api/editor-rapido/templates', express.json({ limit: '32mb' }), (req, res) => {
  try {
    const cleaned = erSanitizeTemplatePayload(req.body?.template || req.body);
    if (!cleaned) return res.status(400).json({ ok: false, error: 'template inválida' });
    ensureEditorRapidoDirs();
    const fp = path.join(ER_TPL_DIR, `${cleaned.id}.json`);
    fs.writeFileSync(fp, JSON.stringify(cleaned), 'utf8');
    const index = erReadIndex().filter((x) => erSafeId(x?.id) !== cleaned.id);
    index.unshift({ id: cleaned.id, name: cleaned.name, savedAt: cleaned.savedAt, protected: true });
    erWriteIndex(index);
    res.json({ ok: true, template: cleaned });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || 'no se pudo guardar' });
  }
});

app.delete('/api/editor-rapido/templates/:id', (req, res) => {
  try {
    const id = erSafeId(req.params.id);
    if (!id) return res.status(400).json({ ok: false, error: 'id inválido' });
    ensureEditorRapidoDirs();
    const fp = path.join(ER_TPL_DIR, `${id}.json`);
    try { fs.unlinkSync(fp); } catch {}
    erWriteIndex(erReadIndex().filter((x) => erSafeId(x?.id) !== id));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || 'no se pudo borrar' });
  }
});

app.get('/api/editor-rapido/media/:name', (req, res) => {
  const name = String(req.params.name || '');
  if (!/^[a-f0-9]{8,40}\.(png|gif|jpg|jpeg|webp|svg|bin)$/i.test(name)) {
    return res.status(400).end();
  }
  const fp = path.join(ER_MEDIA_DIR, name);
  if (!fs.existsSync(fp)) return res.status(404).end();
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  res.sendFile(fp);
});

app.post('/api/editor-rapido/media', express.json({ limit: '40mb' }), (req, res) => {
  try {
    const dataUrl = req.body?.dataUrl;
    if (!dataUrl || typeof dataUrl !== 'string') {
      return res.status(400).json({ ok: false, error: 'dataUrl required' });
    }
    const url = erPersistDataUrl(dataUrl);
    if (!url || url.startsWith('data:')) {
      return res.status(400).json({ ok: false, error: 'No se pudo guardar (archivo inválido o > 25 MB)' });
    }
    res.json({ ok: true, url });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || 'error' });
  }
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
    // Relay sin cookie de la nube: devolvemos los perfiles locales pero marcados,
    // para que el panel avise que no son los de la nube.
    const room = getRoomForUser(user);
    return res.json({ ok: true, profiles: room.getProfilesInfo(), localOnly: true });
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
    const data = await relayRoomActionToRemote(user.id, 'connect', {
      username,
      deviceId: String(req.body?.deviceId || ''),
    });
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
    const data = await relayRoomActionToRemote(user.id, 'disconnect', {
      deviceId: String(req.body?.deviceId || ''),
      force: req.body?.force !== false,
    });
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: e.message || 'sin conexión con la nube' });
  }
});
app.post('/api/room/connect', express.json(), (req, res) => {
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ error: 'no auth' });
  const username = String(req.body?.username || '').trim().replace(/^@/, '');
  if (!username) return res.status(400).json({ error: 'falta usuario' });
  const room = getRoomForUser(user);
  room.handleMessage(null, {
    action: 'connect',
    username,
    deviceId: String(req.body?.deviceId || ''),
  });
  res.json({ ok: true });
});
app.post('/api/room/disconnect', express.json(), (req, res) => {
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ error: 'no auth' });
  const room = getRoomForUser(user);
  if (req.body?.deviceId) {
    room.handleMessage(null, { action: 'ping', deviceId: String(req.body.deviceId) });
  }
  if (req.body?.force !== false) {
    runLiveLock(user.id, 'release', { deviceId: req.body?.deviceId || '', force: true }).catch(() => {});
  }
  room.handleMessage(null, { action: 'disconnect' });
  res.json({ ok: true });
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
  const noteGameBadge = () => {
    try { markBadgeGame(user.id, body.tipo, body.url || ''); } catch { /* ignore */ }
  };
  if (body.tipo === 'WEBHOOK') {
    let result;
    if (isMari0EnemySpawnWebhook(body.url)) {
      result = await runWebhookExec(body);
    } else if (isMslug7760WebhookUrl(body.url)) {
      result = await runMslug7760WebhookExec(body);
    } else {
      result = await runWebhookExec(body);
    }
    if (result && result.ok !== false) noteGameBadge();
    return res.json(result);
  }
  const result = await runGameExec(body);
  if (result && result.ok !== false) noteGameBadge();
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
  // Sin sesión con la nube en el .exe: mostramos el espejo local pero lo marcamos
  // para que el panel avise (estas NO son necesariamente las cuentas reales de la web).
  const localOnly = !!AUTH_REMOTE;
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
      allowedGames: full?.isAdmin ? null : (Array.isArray(full?.allowedGames) ? full.allowedGames : null),
      spotifyEnabled: full ? isUserSpotifyEnabled(full) : false,
      baileOverlayEnabled: full ? isUserBaileOverlayEnabled(full) : false,
      live: !!(st && st.live),
      connecting: !!(st && st.connecting),
      liveSince: st ? st.liveSince : null,
      account: st ? st.account : null,
      online: !!(st && st.online),
      lastSeen: st ? st.lastSeen : 0,
    };
  });
  res.json({ users: out, localOnly });
});

// Activar / desactivar una cuenta.
app.post('/api/admin/activate', express.json(), requireAdmin, async (req, res) => {
  if (AUTH_REMOTE) {
    if (await proxyAdminToRemote(req, res, '/api/admin/activate', 'POST')) return;
    return adminCloudUnavailable(res);
  }
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
  if (AUTH_REMOTE) {
    if (await proxyAdminToRemote(req, res, '/api/admin/userplan', 'POST')) return;
    return adminCloudUnavailable(res);
  }
  const { id, plan, days } = req.body || {};
  if (!id) return res.status(400).json({ error: 'falta id' });
  const ok = setUserPlan(id, plan, days);
  if (!ok) return res.status(404).json({ error: 'cuenta no encontrada' });
  // Avisamos al panel del usuario (si está conectado) para que aplique sus nuevos límites.
  const room = rooms.get(id);
  if (room) room.broadcastCaps?.(capsForUser(getUserById(id)));
  res.json({ ok: true });
});

// Activar / desactivar minijuegos de una cuenta (todos, lista, o un juego).
app.post('/api/admin/usergames', express.json(), requireAdmin, async (req, res) => {
  if (AUTH_REMOTE) {
    if (await proxyAdminToRemote(req, res, '/api/admin/usergames', 'POST')) return;
    return adminCloudUnavailable(res);
  }
  const { id, enabled, allowedGames, game, gameEnabled } = req.body || {};
  if (!id) return res.status(400).json({ error: 'falta id' });
  let ok = false;
  if (game !== undefined) {
    ok = setUserGameAllowed(id, String(game), !!gameEnabled);
  } else if (Object.prototype.hasOwnProperty.call(req.body || {}, 'allowedGames')) {
    ok = setUserAllowedGames(id, allowedGames === null || allowedGames === 'all' ? null : allowedGames);
  } else {
    ok = setUserGamesEnabled(id, !!enabled);
  }
  if (!ok) return res.status(404).json({ error: 'cuenta no encontrada' });
  const full = getUserById(id);
  const room = rooms.get(id);
  if (room) room.broadcastCaps?.(capsForUser(full));
  res.json({
    ok: true,
    gamesEnabled: isUserGamesEnabled(full),
    allowedGames: getUserAllowedGames(full),
  });
});

// Eliminar una cuenta (excepto admin). Cierra su room, sesiones y datos locales.

// Activar / desactivar pestaña Spotify para una cuenta (independiente del plan).
app.post('/api/admin/userspotify', express.json(), requireAdmin, async (req, res) => {
  if (AUTH_REMOTE) {
    if (await proxyAdminToRemote(req, res, '/api/admin/userspotify', 'POST')) return;
    return adminCloudUnavailable(res);
  }
  const { id, enabled } = req.body || {};
  if (!id) return res.status(400).json({ error: 'falta id' });
  const ok = setUserSpotifyEnabled(id, !!enabled);
  if (!ok) return res.status(404).json({ error: 'cuenta no encontrada' });
  const room = rooms.get(id);
  if (room) room.broadcastCaps?.(capsForUser(getUserById(id)));
  res.json({ ok: true, spotifyEnabled: isUserSpotifyEnabled(getUserById(id)) });
});

// Activar / desactivar Overlay baile para una cuenta (lista concreta, no por plan).
app.post('/api/admin/userbaile', express.json(), requireAdmin, async (req, res) => {
  if (AUTH_REMOTE) {
    if (await proxyAdminToRemote(req, res, '/api/admin/userbaile', 'POST')) return;
    return adminCloudUnavailable(res);
  }
  const { id, enabled } = req.body || {};
  if (!id) return res.status(400).json({ error: 'falta id' });
  const ok = setUserBaileOverlayEnabled(id, !!enabled);
  if (!ok) return res.status(404).json({ error: 'cuenta no encontrada' });
  const room = rooms.get(id);
  if (room) room.broadcastCaps?.(capsForUser(getUserById(id)));
  res.json({ ok: true, baileOverlayEnabled: isUserBaileOverlayEnabled(getUserById(id)) });
});

// Insignias especiales (Partner / Beta / Staff).
app.post('/api/admin/userbadges', express.json(), requireAdmin, async (req, res) => {
  const { id, badge, enabled } = req.body || {};
  if (!id || !badge) return res.status(400).json({ error: 'falta id o badge' });
  if (AUTH_REMOTE) {
    const cookie = req.user && remoteCookies.get(req.user.id);
    if (!cookie) return adminCloudUnavailable(res);
    try {
      const r = await fetch(`${AUTH_REMOTE}/api/admin/userbadges`, {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, badge, enabled: !!enabled }),
      });
      const data = await r.json().catch(() => ({}));
      if (r.status === 401 || r.status === 403) {
        if (remoteCookies.delete(req.user.id)) saveRemoteCookies();
        return adminCloudUnavailable(res);
      }
      if (r.ok) {
        try { setUserManualBadge(id, badge, !!enabled); } catch { /* ignore */ }
        if (Array.isArray(data.manualBadges) || Array.isArray(data.badges)) {
          const manual = Array.isArray(data.manualBadges)
            ? data.manualBadges
            : (data.badges || []).filter((b) => b.manual && b.earned).map((b) => b.id);
          try { updateMirrorPlan(id, { manualBadges: manual }); } catch { /* ignore */ }
        }
      }
      return res.status(r.status).json(data);
    } catch {
      return adminCloudUnavailable(res);
    }
  }
  const ok = setUserManualBadge(id, badge, !!enabled);
  if (!ok) return res.status(404).json({ error: 'cuenta o insignia no válida' });
  res.json({ ok: true, ...getUserBadgesPayload(getUserById(id)) });
});

app.post('/api/admin/delete-user', express.json(), requireAdmin, async (req, res) => {
  if (AUTH_REMOTE) {
    if (await proxyAdminToRemote(req, res, '/api/admin/delete-user', 'POST')) return;
    return adminCloudUnavailable(res);
  }
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

// Restablecer contraseña de un usuario. La actual NO se puede ver (hash scrypt);
// el admin define una nueva (o se genera) y se devuelve en claro SOLO en esta respuesta.
app.post('/api/admin/set-password', express.json(), requireAdmin, async (req, res) => {
  if (AUTH_REMOTE) {
    if (await proxyAdminToRemote(req, res, '/api/admin/set-password', 'POST')) return;
    return adminCloudUnavailable(res);
  }
  const { id, password } = req.body || {};
  if (!id) return res.status(400).json({ error: 'falta id' });
  const user = getUserById(id);
  if (!user) return res.status(404).json({ error: 'cuenta no encontrada' });
  let pwd = String(password || '').trim();
  if (!pwd) {
    const alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let out = '';
    const bytes = crypto.randomBytes(10);
    for (let i = 0; i < 10; i++) out += alphabet[bytes[i] % alphabet.length];
    pwd = out;
  }
  if (pwd.length < 4) return res.status(400).json({ error: 'mínimo 4 caracteres' });
  if (pwd.length > 128) return res.status(400).json({ error: 'contraseña demasiado larga' });
  if (!setUserPassword(id, pwd)) return res.status(500).json({ error: 'no se pudo guardar' });
  destroySessionsForUser(id);
  const room = rooms.get(id);
  if (room) room.kickAll?.();
  res.json({ ok: true, username: user.username, password: pwd });
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

  const lastCloudLive = new Set();
  async function pushLocalLivesToCloud() {
    const seen = new Set();
    for (const [userId, room] of rooms) {
      const cookie = remoteCookies.get(userId);
      if (!cookie) continue;
      const st = room.getStatus() || {};
      const live = !!(st.live && st.account);
      if (!live && !lastCloudLive.has(userId)) continue;
      seen.add(userId);
      try {
        const r = await fetch(`${AUTH_REMOTE}/api/panel-lives/report`, {
          method: 'POST',
          headers: { Cookie: cookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            live,
            account: st.account || '',
            nickname: st.nickname || '',
            photo: String(st.photo || '').slice(0, 500),
            viewers: Number(st.viewers) || 0,
            liveSince: st.liveSince || 0,
          }),
        });
        if (r.ok) {
          if (live) lastCloudLive.add(userId);
          else lastCloudLive.delete(userId);
        } else if (r.status === 401 || r.status === 403) {
          remoteCookies.delete(userId); saveRemoteCookies();
          lastCloudLive.delete(userId);
        }
      } catch { /* sin nube */ }
    }
    for (const userId of [...lastCloudLive]) {
      if (seen.has(userId)) continue;
      const cookie = remoteCookies.get(userId);
      if (!cookie) { lastCloudLive.delete(userId); continue; }
      try {
        await fetch(`${AUTH_REMOTE}/api/panel-lives/report`, {
          method: 'POST',
          headers: { Cookie: cookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({ live: false }),
        });
      } catch { /* ignore */ }
      lastCloudLive.delete(userId);
    }
  }
  pushLocalLivesToCloud().catch(() => {});
  setInterval(() => { pushLocalLivesToCloud().catch(() => {}); }, 20 * 1000).unref?.();
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
  // Con remoto configurado, llegar aquí significa que NO se guardó en la nube
  // (sin cookie o sesión caducada): avisar en vez de fingir éxito total.
  res.json(injectLocalCaps({ ok: true, localOnly: !!AUTH_REMOTE, config }));
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

const MAINT_FILE = path.join(DATA_DIR, 'maintenance.json');
function readMaintenance() {
  try {
    const j = JSON.parse(fs.readFileSync(MAINT_FILE, 'utf8'));
    if (j && typeof j === 'object') {
      return { enabled: !!j.enabled, message: String(j.message || '') };
    }
  } catch {}
  // Render sin config: panel web cerrado (el .exe no usa estas páginas).
  if (IS_RENDER) {
    return {
      enabled: true,
      message: 'Livecoins ahora es app de PC. Descarga el .exe e inicia sesión ahí.',
    };
  }
  return { enabled: false, message: '' };
}
function writeMaintenance({ enabled, message }) {
  const data = {
    enabled: !!enabled,
    message: String(message || ''),
    updatedAt: Date.now(),
  };
  const tmp = MAINT_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, MAINT_FILE);
  return data;
}
/** Cierra panel/overlays en el navegador. El .exe (API + localhost) no se toca. */
function webPanelClosed() {
  if (IS_DESKTOP) return false;
  if (AUTH_REMOTE) return false;
  if (process.env.WEB_PANEL === '1') return false;
  if (process.env.WEB_PANEL === '0') return true;
  return !!readMaintenance().enabled;
}
function isAdminRequest(req) {
  const user = userFromRequest(req);
  return !!(user && user.isAdmin);
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
app.get('/api/desktop-build', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!IS_DESKTOP) return res.json({ pc: false });
  const user = userFromRequest(req);
  if (user) {
    try { markBadgeDesktop(user.id); } catch { /* ignore */ }
  }
  let stamp = null;
  try {
    stamp = JSON.parse(fs.readFileSync(path.join(PUBLIC_DIR, '.desktop-build.json'), 'utf8'));
  } catch {}
  res.json({ pc: true, version: stamp?.version || '', builtAt: stamp?.builtAt || 0 });
});

app.post('/api/badges/desktop', express.json(), (req, res) => {
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ error: 'no auth' });
  markBadgeDesktop(user.id);
  res.json({ ok: true, ...getUserBadgesPayload(getUserById(user.id) || user) });
});

/** Marca un juego usado (insignia Gamer). El .exe lo llama tras Probar / IPC. */
app.post('/api/badges/game', express.json({ limit: '8kb' }), (req, res) => {
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ error: 'no auth' });
  const tipo = req.body?.tipo || req.body?.game || '';
  const url = req.body?.url || '';
  try { markBadgeGame(user.id, tipo, url); } catch { /* ignore */ }
  const payload = getUserBadgesPayload(getUserById(user.id) || user);
  try {
    const room = rooms.get(user.id);
    if (room?.pushBadges) room.pushBadges(payload);
  } catch { /* ignore */ }
  res.json({ ok: true, ...payload });
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

/* ----------- Modo mantenimiento (cierra panel WEB; el .exe sigue) ----------- */
app.get('/api/maintenance', (_req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  const m = readMaintenance();
  res.json({
    enabled: webPanelClosed(),
    message: m.message || '',
    desktopOk: true,
  });
});
app.post('/api/admin/maintenance', express.json(), requireAdmin, (req, res) => {
  const body = req.body || {};
  const data = writeMaintenance({
    enabled: !!body.enabled,
    message: body.message,
  });
  res.json({ ok: true, ...data });
});

const GAME_STATUS_FILE = path.join(DATA_DIR, 'game-status.json');
const GAME_STATUS_OK = new Set(['maintenance', 'suspended']);
function readGameStatus() {
  try {
    const j = JSON.parse(fs.readFileSync(GAME_STATUS_FILE, 'utf8'));
    const raw = j && typeof j === 'object' ? (j.statuses && typeof j.statuses === 'object' ? j.statuses : j) : {};
    const out = {};
    for (const [k, v] of Object.entries(raw)) {
      const id = String(k || '').trim();
      const st = String(v || '').trim();
      if (id && GAME_STATUS_OK.has(st)) out[id] = st;
    }
    return out;
  } catch {
    return {};
  }
}
function writeGameStatus(map) {
  const statuses = {};
  for (const [k, v] of Object.entries(map || {})) {
    const id = String(k || '').trim();
    const st = String(v || '').trim();
    if (id && GAME_STATUS_OK.has(st)) statuses[id] = st;
  }
  const data = { statuses, updatedAt: Date.now() };
  const tmp = GAME_STATUS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, GAME_STATUS_FILE);
  return statuses;
}
app.get('/api/game-status', (_req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.json({ statuses: readGameStatus() });
});
app.post('/api/admin/game-status', express.json(), requireAdmin, (req, res) => {
  const body = req.body || {};
  const cur = readGameStatus();
  if (body.game != null) {
    const id = String(body.game || '').trim();
    const st = String(body.status || 'ok').trim();
    if (id) {
      if (st === 'ok' || !GAME_STATUS_OK.has(st)) delete cur[id];
      else cur[id] = st;
    }
  }
  if (body.statuses && typeof body.statuses === 'object') {
    for (const [k, v] of Object.entries(body.statuses)) {
      const id = String(k || '').trim();
      const st = String(v || 'ok').trim();
      if (!id) continue;
      if (st === 'ok' || !GAME_STATUS_OK.has(st)) delete cur[id];
      else cur[id] = st;
    }
  }
  res.json({ ok: true, statuses: writeGameStatus(cur) });
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
function sendUsaPc(res, status = 200) {
  sendHtmlFile(res, path.join(PUBLIC_DIR, 'usa-pc.html'), status);
}

/* ----------------------------- Panel protegido ----------------------------- */
// El panel (index.html) requiere sesión iniciada y cuenta ACTIVADA por el admin.
app.get(['/', '/index.html'], (req, res) => {
  const user = userFromRequest(req);
  if (!user) return res.redirect('/login.html');
  if (!isUserActive(user)) return sendHtmlFile(res, path.join(PUBLIC_DIR, 'pending.html'));
  if (webPanelClosed() && !user.isAdmin) return sendUsaPc(res);
  sendHtmlFile(res, path.join(PUBLIC_DIR, 'index.html'));
});

// Archivos pesados (videos subidos y audios): caché larga en el navegador. Sus nombres
// son únicos, así que se pueden cachear sin problema y al ACTUALIZAR la página el
// navegador los reutiliza al instante en vez de descargarlos otra vez.
const heavyCache = { maxAge: '30d', immutable: true };
function blockHeavyIfWebClosed(req, res, next) {
  if (!webPanelClosed() || isAdminRequest(req)) return next();
  return res.status(404).end();
}
app.use('/uploads', blockHeavyIfWebClosed, express.static(UPLOADS_DIR, heavyCache));
app.use('/audios', blockHeavyIfWebClosed, express.static(AUDIOS_DIR, heavyCache));
app.use('/video', blockHeavyIfWebClosed, express.static(VIDEOS_DIR, heavyCache));
app.use('/niveles', blockHeavyIfWebClosed, express.static(NIVELES_VIDEOS_DIR, heavyCache));

// Cualquier otra página HTML (login, overlays, pending…) se sirve con el script
// de protección inyectado. Debe ir ANTES del estático general.
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  if (!req.path.endsWith('.html')) return next();
  const base = path.basename(req.path).toLowerCase();
  if (base === 'login.html' || base === 'usa-pc.html') return next();
  if (webPanelClosed() && !isAdminRequest(req)) return sendUsaPc(res);
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
app.get('/api/overlay-ping', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, t: Date.now() });
});

app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const raw = String(req.path || '');
  if (!/\.html$/i.test(raw)) return next();
  const base = path.basename(raw).toLowerCase();
  if (base === 'index.html' || base === 'login.html' || base === 'register.html') return next();
  if (raw.toLowerCase().includes('/intro/')) return next();
  const file = path.normalize(path.join(__dirname, 'public', decodeURIComponent(raw)));
  const root = path.normalize(path.join(__dirname, 'public'));
  if (!file.startsWith(root + path.sep) && file !== root) return next();
  fs.readFile(file, 'utf8', (err, html) => {
    if (err || typeof html !== 'string') return next();
    if (html.includes('overlay-keepalive.js')) {
      res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
      return res.type('html').send(html);
    }
    const tag = '<script src="/js/overlay-keepalive.js?v=ka3" defer></script>';
    const out = /<\/head>/i.test(html)
      ? html.replace(/<\/head>/i, `${tag}\n</head>`)
      : `${tag}\n${html}`;
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.type('html').send(out);
  });
});

app.use(express.static(path.join(__dirname, 'public'), {
  index: false,
  setHeaders(res, filePath) {
    if (/\.(png|jpe?g|webp|gif|svg|ico|woff2?)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=604800');
    }
  },
}));

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

const VIDEO_PREVIEW_DIR = path.join(VIDEOS_DIR, '.libpreview');
try { fs.mkdirSync(VIDEO_PREVIEW_DIR, { recursive: true }); } catch {}
const libPreviewJobs = new Map();

function runLibPreviewFfmpeg(args, outPath) {
  return new Promise((resolve) => {
    if (!ffmpegPath) return resolve(null);
    let done = false;
    const finish = (ok) => { if (done) return; done = true; resolve(ok ? outPath : null); };
    let proc;
    try { proc = spawn(ffmpegPath, args, { windowsHide: true }); }
    catch { return finish(false); }
    const t = setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 25000);
    proc.on('error', () => { clearTimeout(t); finish(false); });
    proc.on('close', (code) => {
      clearTimeout(t);
      if (code === 0 && fs.existsSync(outPath)) finish(true);
      else { fs.unlink(outPath, () => {}); finish(false); }
    });
  });
}

function resolveLibVideoPath(srcUrl) {
  let u = String(srcUrl || '').split('?')[0];
  try { u = decodeURIComponent(u); } catch {}
  u = u.replace(/\\/g, '/');
  if (!u.startsWith('/')) return null;
  const rel = u.replace(/^\/+/, '');
  let base = '';
  let rest = '';
  if (rel.startsWith('video/batalla/')) {
    base = BATALLA_VIDEOS_DIR;
    rest = rel.slice('video/batalla/'.length);
  } else if (rel.startsWith('video/')) {
    base = VIDEOS_DIR;
    rest = rel.slice('video/'.length);
  } else if (rel.startsWith('niveles/')) {
    base = NIVELES_VIDEOS_DIR;
    rest = rel.slice('niveles/'.length);
  } else if (rel.startsWith('uploads/')) {
    base = UPLOADS_DIR;
    rest = rel.slice('uploads/'.length);
  } else return null;
  if (!rest || rest.includes('..') || rest.includes('/') || rest.includes('\\')) return null;
  const full = path.resolve(base, rest);
  const root = path.resolve(base);
  if (full !== root && !full.startsWith(root + path.sep)) return null;
  return full;
}

function libPreviewKey(srcPath, st, kind) {
  return crypto.createHash('sha1').update(srcPath + '|' + st.mtimeMs + '|' + st.size + '|v4vp9|' + kind).digest('hex').slice(0, 20);
}

function makeLibPreviewFile(srcPath, kind) {
  let st;
  try { st = fs.statSync(srcPath); } catch { return Promise.resolve(null); }
  const ext = kind === 'poster' ? '.png' : '.webm';
  const outPath = path.join(VIDEO_PREVIEW_DIR, libPreviewKey(srcPath, st, kind) + ext);
  try {
    if (fs.existsSync(outPath) && fs.statSync(outPath).size > 80) return Promise.resolve(outPath);
  } catch {}
  if (libPreviewJobs.has(outPath)) return libPreviewJobs.get(outPath);
  const job = (async () => {
    const scale = 'scale=240:-2:flags=fast_bilinear';
    const vfPoster = scale + ',format=rgba';
    const vfVideo = scale + ',fps=24,format=yuva420p';
    const decoders = [['-c:v', 'libvpx-vp9'], ['-c:v', 'libvpx'], []];
    const tries = [];
    for (const dec of decoders) {
      if (kind === 'poster') {
        tries.push(['-y', ...dec, '-i', srcPath, '-ss', '1', '-an', '-vf', vfPoster, '-frames:v', '1', '-pix_fmt', 'rgba', '-c:v', 'png', outPath]);
        tries.push(['-y', ...dec, '-i', srcPath, '-an', '-vf', vfPoster, '-frames:v', '1', '-pix_fmt', 'rgba', '-c:v', 'png', outPath]);
      } else {
        tries.push(['-y', ...dec, '-i', srcPath, '-an', '-vf', vfVideo, '-r', '24', '-c:v', 'libvpx', '-pix_fmt', 'yuva420p',
          '-auto-alt-ref', '0', '-deadline', 'realtime', '-cpu-used', '8', '-crf', '30', '-b:v', '450k', outPath]);
        tries.push(['-y', ...dec, '-i', srcPath, '-an', '-vf', vfVideo, '-r', '24', '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p',
          '-auto-alt-ref', '0', '-deadline', 'realtime', '-cpu-used', '8', '-row-mt', '1', '-crf', '34', '-b:v', '0', outPath]);
      }
    }
    for (const args of tries) {
      const ok = await runLibPreviewFfmpeg(args, outPath);
      if (ok) return ok;
    }
    return null;
  })().finally(() => libPreviewJobs.delete(outPath));
  libPreviewJobs.set(outPath, job);
  return job;
}

app.get('/api/video-lib-preview', async (req, res) => {
  const srcPath = resolveLibVideoPath(req.query.src);
  if (!srcPath || !fs.existsSync(srcPath)) return res.status(404).end();
  const ext = path.extname(srcPath).toLowerCase();
  if (['.gif', '.png', '.jpg', '.jpeg', '.webp'].includes(ext)) return res.sendFile(srcPath);
  const kind = String(req.query.poster || '') === '1' ? 'poster' : 'video';
  try {
    const preview = await makeLibPreviewFile(srcPath, kind);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    return res.sendFile(preview || srcPath);
  } catch {
    return res.sendFile(srcPath);
  }
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

// Proxy de imágenes externas (CDN TikTok / regalos) para servirlas desde el mismo
// origen. Lo usa el generador de "imagen de regalos" (canvas) y avatares del panel.
app.get('/api/img-proxy', async (req, res) => {
  try {
    let url = String(req.query.url || '').trim();
    if (url.startsWith('//')) url = 'https:' + url;
    if (!/^https?:\/\//i.test(url)) return res.status(400).end('bad url');
    const r = await fetch(url, {
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        'Referer': 'https://www.tiktok.com/',
      },
    });
    if (!r.ok) return res.status(502).end('upstream error');
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length) return res.status(502).end('empty');
    let ct = String(r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const sniff = (() => {
      if (buf[0] === 0xFF && buf[1] === 0xD8) return 'image/jpeg';
      if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image/png';
      if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
      if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
        && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp';
      return '';
    })();
    // TikTok CDN a menudo responde application/octet-stream aunque sea imagen.
    if (!/^image\//i.test(ct)) {
      if (!sniff) return res.status(415).end('not an image');
      ct = sniff;
    } else if (sniff) {
      ct = sniff;
    }
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
    registerUserUpload(DATA_DIR, {
      url: '/uploads/' + finalName,
      name: finalName,
      kind: userUploadKind(finalName),
      dir: 'uploads',
      bytes,
    });
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
let ttsAudioCacheBytes = 0;
const TTS_AUDIO_CACHE_MAX_ENTRIES = IS_RENDER ? 40 : 400;
const TTS_AUDIO_CACHE_MAX_BYTES = IS_RENDER ? 8 * 1024 * 1024 : 48 * 1024 * 1024;
function ttsAudioCacheGet(key) { return ttsAudioCache.get(key) || ''; }
function ttsAudioCacheSet(key, val) {
  if (!val) return;
  if (ttsAudioCache.has(key)) {
    const prev = ttsAudioCache.get(key) || '';
    ttsAudioCacheBytes = Math.max(0, ttsAudioCacheBytes - prev.length);
  }
  ttsAudioCache.set(key, val);
  ttsAudioCacheBytes += val.length;
  while (
    ttsAudioCache.size > TTS_AUDIO_CACHE_MAX_ENTRIES
    || ttsAudioCacheBytes > TTS_AUDIO_CACHE_MAX_BYTES
  ) {
    const first = ttsAudioCache.keys().next().value;
    if (first === undefined) break;
    const gone = ttsAudioCache.get(first) || '';
    ttsAudioCache.delete(first);
    ttsAudioCacheBytes = Math.max(0, ttsAudioCacheBytes - gone.length);
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

function ttsLooksSpanish(text) {
  const s = String(text || '').trim();
  if (!s) return false;
  if (/[áéíóúñ¿¡ü]/i.test(s)) return true;
  return /\b(hola|ola|gracias|qué|que|por|para|una|unos|unas|los|las|como|pero|muy|este|esta|bueno|buenos|buenas|dias|días|noches|bien|también|tambien|ahora|sí|si|favor|amigo|canción|cancion|jaja|jajaja|xd|ok|vale|genial|bro|wey|gente|saludos|noche|dia|calor|invierno|verano|pepino|conejo|zombie|ni|una|mas|más|eso|esa|son|estoy|estas|dice|dijo|bot|live|stream)\b/i.test(s);
}
function ttsLooksEnglish(text) {
  const s = String(text || '').trim();
  if (!s || ttsLooksSpanish(s)) return false;
  const words = s.split(/\s+/).filter((w) => /[a-z]/i.test(w));
  if (words.length < 2) return false;
  if (/^(good\s+(morning|night|bye)|thank\s+you|how\s+are\s+you|see\s+you|i\s+love\s+you)/i.test(s)) return true;
  if (/\b(the|and|you|this|that|have|hello|thanks|please|what|with|from|just|like|love|good|because|don't|respond|why)\b/i.test(s)) {
    const enHits = words.filter((w) => /^[a-z'-]+$/i.test(w) && !ttsLooksSpanish(w)).length;
    return enHits >= Math.ceil(words.length * 0.75);
  }
  return false;
}
function ttsTranslationSanity(original, translated) {
  const o = String(original || '').trim();
  const t = String(translated || '').trim();
  if (!t || t.toLowerCase() === o.toLowerCase()) return false;
  if (/^MYMEMORY WARNING/i.test(t) || /QUERY LENGTH LIMIT/i.test(t)) return false;
  if (o.length <= 12 && t.length > o.length * 2.5) return false;
  if (o.length <= 4 && t.split(/\s+/).length > 2) return false;
  return true;
}
async function ttsTranslateCached(text, source, target) {
  const src = String(text || '').trim();
  if (!src) return '';
  const key = 'v2|' + source + '|' + target + '|' + src.toLowerCase();
  const hit = ttsTranslateCacheGet(key);
  if (hit && ttsTranslationSanity(src, hit)) return hit;
  const out = await ttsWithTimeout(ttsTranslateMyMemory(src, source, target), 2800).catch(() => '');
  if (ttsTranslationSanity(src, out)) {
    ttsTranslateCacheSet(key, out);
    return out;
  }
  return '';
}
function ttsEdgeFallbackVoice(tiktokVoice) {
  const v = String(tiktokVoice || '').toLowerCase();
  if (v.startsWith('es_') || v.startsWith('es-')) {
    return /female|f6|f08/.test(v) ? 'es-MX-DaliaNeural' : 'es-MX-JorgeNeural';
  }
  const female = /female|leota|betty|grandma|richgirl|makeup|samc|emotional|pansino|stitch|_001|_002/.test(v);
  return female ? EDGE_EN_FALLBACK.f : EDGE_EN_FALLBACK.m;
}

/** Respaldo Edge ES si TikTok/Disney no responde y hay que leer en español. */
function ttsSpanishEdgeForEnVoice(tiktokVoice) {
  const v = String(tiktokVoice || '').toLowerCase();
  const female = /female|leota|betty|grandma|richgirl|makeup|samc|emotional|pansino/.test(v);
  return female ? 'es-MX-DaliaNeural' : 'es-MX-JorgeNeural';
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
    const to = ttsFetchTimeout(3500);
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
    tryProxy('https://tiktok-tts.weilbyte.dev/api/generation', (j) => (j && j.data && !j.error ? String(j.data) : '')),
    tryProxy('https://tiktok-tts.weilnet.workers.dev/api/generation', (j) => (j && j.data && !j.error ? String(j.data) : '')),
    tryProxy('https://gesserit.co/api/tts', (j) => (j && (j.base64 || j.data) ? String(j.base64 || j.data) : '')),
  ];
  try {
    return await Promise.any(tasks.map(async (p) => {
      const v = await p;
      if (!v) throw new Error('empty');
      return v;
    }));
  } catch {
    return '';
  }
}

app.post('/api/tts/speak', express.json(), async (req, res) => {
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ ok: false, error: 'no_auth' });
  let text = String((req.body && req.body.text) || '').trim();
  const voice = String((req.body && req.body.voice) || '').trim();
  const speakEs = req.body && req.body.speakEs === true;
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
  const isEnVoice = !isEdge && /^en[_-]/i.test(voice);
  try {
    if (speakEs) {
      // «Leer en español»: leer el comentario tal cual (sin traducir ES→ES ni alucinar con MyMemory).
    } else if (isEnVoice && ttsLooksSpanish(text)) {
      const en = await ttsTranslateCached(text, 'es', 'en');
      if (en) { text = en; translated = true; }
    }
  } catch { /* si falla, hablamos el original */ }

  const audioKey = voice + '|' + text.toLowerCase();
  const cachedAudio = ttsAudioCacheGet(audioKey);
  if (cachedAudio) {
    return res.json({ ok: true, audio: cachedAudio, mime: 'audio/mpeg', text, original, translated, cached: true });
  }

  try {
    let usedFallback = false;
    let audio = isEdge
      ? await ttsWithTimeout(ttsSynthEdge(text, voice, 7000), 7500).catch(() => '')
      : await ttsWithTimeout(ttsSynthTikTok(text, voice), 4500).catch(() => '');
    if (!audio && !isEdge) {
      const fb = speakEs ? ttsSpanishEdgeForEnVoice(voice) : ttsEdgeFallbackVoice(voice);
      audio = await ttsWithTimeout(ttsSynthEdge(text, fb, 7000), 7500).catch(() => '');
      usedFallback = !!audio;
    }
    if (!audio) return res.status(502).json({ ok: false, error: 'synth_failed' });
    ttsAudioCacheSet(audioKey, audio);
    res.json({ ok: true, audio, mime: 'audio/mpeg', text, original, translated, fallback: usedFallback ? 'edge' : undefined });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

/* ---- ElevenLabs (API key del creador; no afecta Edge/TikTok/sistema) ---- */
app.post('/api/tts/elevenlabs/voices', express.json({ limit: '32kb' }), async (req, res) => {
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ ok: false, error: 'no_auth' });
  let apiKey = String((req.body && req.body.apiKey) || '').trim();
  if (!apiKey) {
    try {
      const room = getRoomForUser(user);
      apiKey = String(room?.getSettings?.()?.tts?.elevenlabs?.apiKey || '').trim();
    } catch { /* ignore */ }
  }
  if (!apiKey) return res.status(400).json({ ok: false, error: 'missing_api_key' });
  try {
    const out = await elevenLabsListVoices(apiKey);
    if (!out.ok) return res.status(out.status && out.status >= 400 ? out.status : 502).json(out);
    res.json(out);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.post('/api/tts/elevenlabs/speak', express.json({ limit: '64kb' }), async (req, res) => {
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ ok: false, error: 'no_auth' });
  let apiKey = String((req.body && req.body.apiKey) || '').trim();
  // Preferir key guardada en el room (no hace falta mandarla en cada speak).
  if (!apiKey) {
    try {
      const room = getRoomForUser(user);
      apiKey = String(room?.getSettings?.()?.tts?.elevenlabs?.apiKey || '').trim();
    } catch { /* ignore */ }
  }
  const voiceId = String((req.body && req.body.voiceId) || '').trim();
  const modelId = String((req.body && req.body.modelId) || '').trim();
  let text = String((req.body && req.body.text) || '').trim();
  if (!apiKey) return res.status(400).json({ ok: false, error: 'missing_api_key' });
  if (!voiceId) return res.status(400).json({ ok: false, error: 'missing_voice_id' });
  if (!text) return res.status(400).json({ ok: false, error: 'missing_text' });
  if (text.length > 280) text = text.slice(0, 280);

  const cacheKey = `el|${user.id || 'u'}|${voiceId}|${text.toLowerCase()}`;
  const cachedAudio = ttsAudioCacheGet(cacheKey);
  if (cachedAudio) {
    return res.json({ ok: true, audio: cachedAudio, mime: 'audio/mpeg', text, cached: true, engine: 'elevenlabs' });
  }

  try {
    const out = await elevenLabsSpeak(apiKey, voiceId, text, { modelId: modelId || undefined, timeoutMs: 14000 });
    if (!out.ok || !out.audio) {
      return res.status(out.status && out.status >= 400 ? out.status : 502).json({
        ok: false,
        error: out.error || 'synth_failed',
        engine: 'elevenlabs',
      });
    }
    ttsAudioCacheSet(cacheKey, out.audio);
    res.json({ ok: true, audio: out.audio, mime: out.mime || 'audio/mpeg', text, engine: 'elevenlabs' });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.post('/api/tts/elevenlabs/clone', express.json({ limit: '14mb' }), async (req, res) => {
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ ok: false, error: 'no_auth' });
  const apiKey = String((req.body && req.body.apiKey) || '').trim();
  const name = String((req.body && req.body.name) || '').trim() || 'Livecoins';
  const filename = String((req.body && req.body.filename) || 'sample.mp3').trim();
  const b64 = String((req.body && req.body.audioBase64) || '').replace(/^data:[^;]+;base64,/, '').trim();
  if (!apiKey) return res.status(400).json({ ok: false, error: 'missing_api_key' });
  if (!b64) return res.status(400).json({ ok: false, error: 'missing_audio' });
  let buf;
  try { buf = Buffer.from(b64, 'base64'); } catch { return res.status(400).json({ ok: false, error: 'bad_audio' }); }
  if (!buf.length) return res.status(400).json({ ok: false, error: 'empty_audio' });
  try {
    const out = await elevenLabsCloneVoice(apiKey, name, buf, filename);
    if (!out.ok) return res.status(out.status && out.status >= 400 ? out.status : 502).json(out);
    res.json(out);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

/* ----------------------------------------------------------------------------
 * Spotify Song Requests (solo .exe · Premium via tab_spotify / admin).
 * OAuth con PKCE: el callback llega a un listener fijo en SPOTIFY_CALLBACK_PORT.
 * --------------------------------------------------------------------------*/
function spotifyUser(req) {
  const user = userFromRequest(req);
  if (!user) return null;
  if (user.isAdmin) return user;
  const caps = capsForUser(user);
  if (caps?.features?.tab_spotify) return user;
  return null;
}

function spotifyClientIdFromReq(req, user) {
  const fromQ = typeof spotify.normalizeClientId === 'function'
    ? spotify.normalizeClientId(req.query?.clientId || req.body?.clientId)
    : String(req.query?.clientId || req.body?.clientId || '').trim();
  if (fromQ) return fromQ;
  try {
    if (user) {
      const raw = getRoomForUser(user)?.getSettings?.()?.spotify?.clientId;
      const fromSettings = typeof spotify.normalizeClientId === 'function'
        ? spotify.normalizeClientId(raw)
        : String(raw || '').trim();
      if (fromSettings) return fromSettings;
    }
  } catch {}
  return typeof spotify.normalizeClientId === 'function'
    ? spotify.normalizeClientId(spotify.SPOTIFY_CLIENT_ID)
    : String(spotify.SPOTIFY_CLIENT_ID || '').trim();
}

app.get('/api/spotify/auth-url', (req, res) => {
  const user = spotifyUser(req);
  if (!user) return res.status(403).json({ error: 'No autorizado.' });
  try {
    const origin = req.headers.origin || (req.headers.referer ? new URL(req.headers.referer).origin : '');
    if (origin) spotify.rememberPanelOrigin(origin);
    const clientId = spotifyClientIdFromReq(req, user);
    if (!clientId) {
      return res.status(400).json({ error: 'Pega el Client ID de tu app de Spotify (Dashboard → Settings).' });
    }
    res.json({ url: spotify.buildAuthUrl(user.id, clientId) });
  } catch (e) {
    res.status(500).json({ error: 'Error iniciando sesión con Spotify: ' + e.message });
  }
});

app.get('/api/spotify/login', (req, res) => {
  const user = spotifyUser(req);
  if (!user) return res.status(403).send('No autorizado.');
  try {
    const clientId = spotifyClientIdFromReq(req, user);
    if (!clientId) return res.status(400).send('Pega el Client ID de tu app de Spotify en Livecoins.');
    const url = spotify.buildAuthUrl(user.id, clientId);
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

    if (webPanelClosed() && !user.isAdmin) {
      const role = String(url.searchParams.get('role') || '');
      const fromExe = role === 'relay' || role === 'local';
      if (!fromExe) {
        try { ws.close(4003, 'use-desktop'); } catch {}
        return;
      }
    }

    const room = getRoomForUser(user);
    // role=relay|local desde el .exe (modo relay); sin esto emitLocalExec (WEBHOOK, etc.) no llega a la PC.
    room.addClient(ws, url.searchParams.get('role'), {
      ov: url.searchParams.get('ov'),
      referer: req.headers.referer || req.headers.referrer || '',
    });

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
    setInterval(() => {
      reapIdleCloudRooms();
      const m = process.memoryUsage();
      if (rooms.size > 0 || m.rss > 200 * 1024 * 1024) {
        console.log(`[cloud] mem rss=${Math.round(m.rss / 1024 / 1024)}MB heap=${Math.round(m.heapUsed / 1024 / 1024)}MB rooms=${rooms.size}`);
      }
    }, 60 * 1000).unref?.();
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
process.on('SIGTERM', () => {
  try { process.emit('SIGINT'); } catch {
    for (const room of rooms.values()) {
      try { room.shutdown(); } catch {}
    }
    process.exit(0);
  }
});
