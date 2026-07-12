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
import ffmpegPath from 'ffmpeg-static';
import { WebSocketServer } from 'ws';
import { TikTokLiveConnection } from 'tiktok-live-connector';
import { createRoom } from './room.js';
import { createStreamerRankings } from './streamer-rankings.js';
import {
  registerUser, verifyLogin, createSession, destroySession,
  userFromRequest, getUserByRoomKey, getUserById, getUserByUsername, listUsers, listUsersDetailed,
  isUserActive, setUserActive, touchLogin,
  getUserPlan, setUserPlan, deleteUser,
  getAuthDataInfo, restoreUsersFromBackup, findBestUsersBackup, restoreUsersFromBestBackup,
  sessionCookie, clearCookie, parseCookies, SESSION_COOKIE,
} from './auth.js';
import {
  CAPABILITIES, getPlanConfig, savePlanConfig, effectiveCaps, adminCaps,
} from './plans.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
// En hosting (Render) usamos un DISCO PERSISTENTE montado en la ruta de DATA_DIR
// (ej. /var/data) para que usuarios y configuraciones NO se borren al redesplegar.
// En local, si no existe la variable, se usa la carpeta "data" del proyecto.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const streamerRankings = createStreamerRankings(DATA_DIR);
const DEFAULT_DATA_DIR = path.join(__dirname, 'data');
const ON_RENDER = !!process.env.RENDER;
const USING_EPHEMERAL_DATA = ON_RENDER && path.resolve(DATA_DIR) === path.resolve(DEFAULT_DATA_DIR);

function scanDataDirUserFolders() {
  const known = new Set(listUsers().map((u) => u.id));
  const folders = [];
  const orphans = [];
  try {
    for (const name of fs.readdirSync(DATA_DIR)) {
      if (!/^[0-9a-f-]{36}$/i.test(name)) continue;
      const full = path.join(DATA_DIR, name);
      if (!fs.statSync(full).isDirectory()) continue;
      folders.push(name);
      if (!known.has(name)) orphans.push(name);
    }
  } catch {}
  return { folders, orphans };
}

function listUserBackupFiles() {
  const out = [];
  try {
    for (const name of fs.readdirSync(DATA_DIR)) {
      if (!name.startsWith('users.json')) continue;
      if (name === 'users.json') continue;
      const full = path.join(DATA_DIR, name);
      let count = 0;
      try {
        const parsed = JSON.parse(fs.readFileSync(full, 'utf8'));
        if (Array.isArray(parsed)) count = parsed.length;
      } catch {}
      out.push({ name, bytes: fs.statSync(full).size, userCount: count });
    }
  } catch {}
  out.sort((a, b) => b.userCount - a.userCount || b.bytes - a.bytes);
  return out;
}

function dirSizeBytesRecursive(dir) {
  let total = 0;
  try {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) total += dirSizeBytesRecursive(p);
      else if (ent.isFile()) total += fs.statSync(p).size;
    }
  } catch {}
  return total;
}

function pruneDiskJunk() {
  let removed = 0;
  let freed = 0;
  function rm(p) {
    try {
      const st = fs.statSync(p);
      freed += st.size;
      fs.unlinkSync(p);
      removed++;
    } catch {}
  }
  try {
    for (const name of fs.readdirSync(DATA_DIR)) {
      const full = path.join(DATA_DIR, name);
      if (name.endsWith('.tmp')) { rm(full); continue; }
      if (name.startsWith('users.json.bak-')) continue; // auth.js gestiona las copias
      if (name.startsWith('users.json.pre-restore-')) { rm(full); continue; }
    }
    // .corrupt-* y .tmp dentro de carpetas de usuario
    for (const name of fs.readdirSync(DATA_DIR)) {
      const full = path.join(DATA_DIR, name);
      if (!fs.statSync(full).isDirectory()) continue;
      for (const f of fs.readdirSync(full)) {
        if (f.endsWith('.tmp') || f.includes('.corrupt-')) rm(path.join(full, f));
      }
    }
    // Copias users.json.bak-* antiguas (mantener 3 más recientes)
    const baks = fs.readdirSync(DATA_DIR)
      .filter((n) => n.startsWith('users.json.bak-'))
      .map((n) => ({ n, t: fs.statSync(path.join(DATA_DIR, n)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const b of baks.slice(3)) rm(path.join(DATA_DIR, b.n));
  } catch {}
  if (removed) console.log(`  [data] Limpieza disco: ${removed} archivo(s), ~${Math.round(freed / 1024)} KB`);
  return { removed, freed };
}

function getDiskUsageSummary() {
  const totalBytes = dirSizeBytesRecursive(DATA_DIR);
  const uploadsBytes = fs.existsSync(UPLOADS_DIR) ? dirSizeBytesRecursive(UPLOADS_DIR) : 0;
  return { totalBytes, uploadsBytes, totalMb: Math.round(totalBytes / 1024 / 1024) };
}

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

// Catálogo FIJO de respaldo (gifts.json), generado desde una PC con catálogo completo.
// TikTok devuelve regalos distintos según la región/IP del servidor: en Render (datacenter)
// suelen faltar varios. Por eso usamos este archivo como BASE y lo fusionamos con lo que
// devuelva el fetch en vivo, para no perder ningún regalo.
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
function capsForUser(user) {
  if (!user) return effectiveCaps('free');
  if (user.isAdmin) return adminCaps();
  return effectiveCaps(getUserPlan(user));
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
      onStreamerRank: (p) => streamerRankings.record(p),
    });
    rooms.set(user.id, room);
  }
  return room;
}

// Usuarios conectados al panel y EN VIVO en TikTok (directorio público para el panel).
// Solo lives reales: conexión activa + audiencia > 0 (o live recién iniciado).
// Con viewers=0 suele ser conexión fantasma / live ya cerrado sin STREAM_END.
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
// Subidas del usuario en disco persistente (DATA_DIR), no en public/ (se borra al redesplegar).
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

(function migrateUploadsToPersistentDir() {
  const dest = path.resolve(UPLOADS_DIR);
  const legacy = path.resolve(path.join(__dirname, 'public', 'uploads'));
  if (legacy === dest || !fs.existsSync(legacy)) return;
  let copied = 0;
  try {
    for (const f of fs.readdirSync(legacy)) {
      const from = path.join(legacy, f);
      const to = path.join(dest, f);
      if (fs.statSync(from).isFile() && !fs.existsSync(to)) {
        fs.copyFileSync(from, to);
        copied++;
      }
    }
  } catch {}
  if (copied) console.log(`  [migrate] ${copied} archivo(s) de uploads → ${dest}`);
})();

// Límites de almacenamiento web (Render). Evita llenar el disco persistente.
const UPLOAD_MAX_FILE_BYTES = Math.max(1, Number(process.env.UPLOAD_MAX_FILE_MB) || 80) * 1024 * 1024;
const UPLOAD_MAX_USER_BYTES = Math.max(UPLOAD_MAX_FILE_BYTES, Number(process.env.UPLOAD_MAX_USER_MB) || 150) * 1024 * 1024;
const UPLOAD_PRUNE_MAX_AGE_MS = Math.max(1, Number(process.env.UPLOAD_PRUNE_DAYS) || 30) * 86400000;

function userUploadDir(userId) {
  const dir = path.join(UPLOADS_DIR, String(userId));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function dirSizeBytes(dir) {
  try {
    let n = 0;
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      if (fs.statSync(p).isFile()) n += fs.statSync(p).size;
    }
    return n;
  } catch { return 0; }
}

function normalizeUploadRef(u) {
  if (!u || typeof u !== 'string') return '';
  if (u.startsWith('/uploads/')) return u.split('?')[0];
  try {
    const p = new URL(u);
    if (p.pathname.startsWith('/uploads/')) return p.pathname.split('?')[0];
  } catch {}
  return '';
}

function scanSettingsForUploadRefs(obj, refs) {
  if (!obj || typeof obj !== 'object') return;
  if (Array.isArray(obj)) { for (const x of obj) scanSettingsForUploadRefs(x, refs); return; }
  for (const [k, v] of Object.entries(obj)) {
    if ((k === 'url' || k === 'sound') && typeof v === 'string') {
      const r = normalizeUploadRef(v);
      if (r) refs.add(r);
    } else if (typeof v === 'string' && v.includes('/uploads/')) {
      const r = normalizeUploadRef(v);
      if (r) refs.add(r);
    } else if (v && typeof v === 'object') scanSettingsForUploadRefs(v, refs);
  }
}

function collectReferencedUploads() {
  const refs = new Set();
  for (const u of listUsers()) {
    const dir = path.join(DATA_DIR, u.id);
    for (const file of ['profiles.json', 'settings.json']) {
      try {
        scanSettingsForUploadRefs(JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')), refs);
      } catch {}
    }
    const room = rooms.get(u.id);
    if (room) {
      try { scanSettingsForUploadRefs(room.getSettings(), refs); } catch {}
    }
  }
  return refs;
}

function pruneOrphanUploads() {
  const refs = collectReferencedUploads();
  const cutoff = Date.now() - UPLOAD_PRUNE_MAX_AGE_MS;
  let removed = 0;
  function walk(absDir, urlPrefix) {
    let entries;
    try { entries = fs.readdirSync(absDir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const abs = path.join(absDir, ent.name);
      if (ent.isDirectory()) {
        walk(abs, urlPrefix ? `${urlPrefix}${ent.name}/` : `${ent.name}/`);
        continue;
      }
      if (!ent.isFile()) continue;
      const rel = urlPrefix ? `${urlPrefix}${ent.name}` : ent.name;
      const urlPath = (`/uploads/${rel}`).replace(/\/+/g, '/');
      const legacyPath = `/uploads/${ent.name}`;
      let st;
      try { st = fs.statSync(abs); } catch { continue; }
      const referenced = refs.has(urlPath) || (!urlPrefix && refs.has(legacyPath));
      if (!referenced && st.mtimeMs < cutoff) {
        try { fs.unlinkSync(abs); removed++; } catch {}
      }
    }
  }
  walk(UPLOADS_DIR, '');
  if (removed) console.log(`  [uploads] Limpieza: ${removed} archivo(s) huérfanos (>${UPLOAD_PRUNE_MAX_AGE_MS / 86400000} días)`);
}

const PERSISTENT_VIDEO_EXT = new Set([
  '.mp4', '.webm', '.mov', '.mkv', '.avi', '.m4v', '.mpeg', '.mpg', '.wmv', '.flv', '.3gp',
]);

// Borra todos los videos subidos al disco persistente (/var/data/uploads).
function clearPersistentUploadVideos() {
  let removed = 0;
  let freed = 0;
  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) { walk(abs); continue; }
      if (!ent.isFile()) continue;
      const ext = path.extname(ent.name).toLowerCase();
      if (!PERSISTENT_VIDEO_EXT.has(ext)) continue;
      try {
        const st = fs.statSync(abs);
        fs.unlinkSync(abs);
        removed++;
        freed += st.size;
      } catch {}
    }
  }
  if (fs.existsSync(UPLOADS_DIR)) walk(UPLOADS_DIR);
  return { removed, freed };
}

// Borra todo el contenido de uploads (videos, audios, imágenes subidas).
function clearAllPersistentUploads() {
  let removed = 0;
  let freed = 0;
  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) { walk(abs); continue; }
      if (!ent.isFile()) continue;
      try {
        const st = fs.statSync(abs);
        fs.unlinkSync(abs);
        removed++;
        freed += st.size;
      } catch {}
    }
  }
  if (fs.existsSync(UPLOADS_DIR)) walk(UPLOADS_DIR);
  return { removed, freed };
}

const BLOATED_USER_FILES = [
  'session-overlays.json', 'weekly.json', 'top1fire.json', 'habibi-top.json',
];
const BLOATED_JSON_MAX_BYTES = 1.5 * 1024 * 1024;

function pruneBloatedUserDataFiles() {
  let removed = 0;
  let freed = 0;
  try {
    for (const name of fs.readdirSync(DATA_DIR)) {
      if (!/^[0-9a-f-]{36}$/i.test(name)) continue;
      const userDir = path.join(DATA_DIR, name);
      if (!fs.statSync(userDir).isDirectory()) continue;
      for (const fname of BLOATED_USER_FILES) {
        const f = path.join(userDir, fname);
        if (!fs.existsSync(f)) continue;
        let st;
        try { st = fs.statSync(f); } catch { continue; }
        if (st.size < BLOATED_JSON_MAX_BYTES) continue;
        try {
          fs.unlinkSync(f);
          removed++;
          freed += st.size;
        } catch {}
      }
    }
  } catch {}
  return { removed, freed };
}

function getDiskFreeBytes(dir = DATA_DIR) {
  try {
    const s = fs.statfsSync(dir);
    return Number(s.bfree) * Number(s.bsize);
  } catch { return null; }
}

function emergencyFreeDiskSpace() {
  if (!ON_RENDER) return null;
  const freeBefore = getDiskFreeBytes();
  const videos = clearPersistentUploadVideos();
  const uploads = clearAllPersistentUploads();
  const junk = pruneDiskJunk();
  const bloated = pruneBloatedUserDataFiles();
  const freeAfter = getDiskFreeBytes();
  const totalFreed = videos.freed + uploads.freed + junk.freed + bloated.freed;
  const mb = (n) => (n == null ? '?' : Math.round(n / 1024 / 1024));
  console.log(`  [data] Disco libre: ${mb(freeBefore)} MB → ${mb(freeAfter)} MB (liberados ~${Math.round(totalFreed / 1024 / 1024)} MB)`);
  if (videos.removed) console.log(`  [uploads] Videos eliminados: ${videos.removed}`);
  if (uploads.removed) console.log(`  [uploads] Archivos en uploads eliminados: ${uploads.removed}`);
  if (bloated.removed) console.log(`  [data] JSON pesados eliminados: ${bloated.removed}`);
  if ((freeAfter ?? 0) < 50 * 1024 * 1024) {
    console.error('  [!] DISCO CASI LLENO: amplía el disco en Render o borra datos manualmente en Shell.');
  }
  return { freeBefore, freeAfter, totalFreed, videos, uploads, junk, bloated };
}

// Antes de rutas/rooms: libera espacio para que profiles.json pueda guardarse.
emergencyFreeDiskSpace();

function trimUserUploadQuota(userId) {
  const dir = path.join(UPLOADS_DIR, String(userId));
  if (!fs.existsSync(dir)) return;
  let used = dirSizeBytes(dir);
  if (used <= UPLOAD_MAX_USER_BYTES) return;
  const refs = collectReferencedUploads();
  const files = fs.readdirSync(dir).map((f) => {
    const p = path.join(dir, f);
    const st = fs.statSync(p);
    return { p, mtime: st.mtimeMs, size: st.size, url: `/uploads/${userId}/${f}` };
  }).sort((a, b) => a.mtime - b.mtime);
  for (const f of files) {
    if (used <= UPLOAD_MAX_USER_BYTES) break;
    if (refs.has(f.url)) continue;
    try { fs.unlinkSync(f.p); used -= f.size; } catch {}
  }
}

setInterval(() => { try { pruneOrphanUploads(); } catch {} }, 24 * 3600 * 1000);

const AUDIOS_DIR = path.join(__dirname, 'public', 'audios');
fs.mkdirSync(AUDIOS_DIR, { recursive: true });
const VIDEOS_DIR = path.join(__dirname, 'public', 'video');
fs.mkdirSync(VIDEOS_DIR, { recursive: true });
// Carpeta dedicada para los videos de la pestaña Batallas (videos AI de batalla).
const BATALLA_VIDEOS_DIR = path.join(VIDEOS_DIR, 'batalla');
fs.mkdirSync(BATALLA_VIDEOS_DIR, { recursive: true });
// Carpeta fija: public/video/niveles (nivel1.webm, nivel2.webm…).
const NIVELES_VIDEOS_DIR = path.join(VIDEOS_DIR, 'niveles');
fs.mkdirSync(NIVELES_VIDEOS_DIR, { recursive: true });

function nivelesSources() {
  return [{ dir: NIVELES_VIDEOS_DIR, urlBase: '/video/niveles/' }];
}

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

/* --------------------------- Modo mantenimiento (web) --------------------------- */
const MAINTENANCE_FILE = path.join(DATA_DIR, 'maintenance.json');
function readMaintenance() {
  try { return JSON.parse(fs.readFileSync(MAINTENANCE_FILE, 'utf8')); }
  catch { return { enabled: false, message: '', updatedAt: 0 }; }
}
function writeMaintenance(data) {
  const tmp = MAINTENANCE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, MAINTENANCE_FILE);
}
function isMaintenanceOn() {
  if (process.env.MAINTENANCE === '1' || process.env.MAINTENANCE === 'true') return true;
  return !!readMaintenance().enabled;
}

/* ------------------------------- Autenticación ------------------------------- */
app.get('/api/maintenance', (_req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  const m = readMaintenance();
  res.json({ enabled: !!m.enabled, message: String(m.message || '') });
});

app.post('/api/register', express.json(), (req, res) => {
  if (isMaintenanceOn()) {
    return res.status(503).json({ error: 'Sitio en mantenimiento. Solo el administrador puede acceder.' });
  }
  const { username, password } = req.body || {};
  const { user, error } = registerUser(username, password);
  if (error) return res.status(400).json({ error });
  maybeMigrateLegacy(user);
  const token = createSession(user.id);
  res.setHeader('Set-Cookie', sessionCookie(token));
  res.json({ ok: true, username: user.username });
});

app.post('/api/login', express.json(), (req, res) => {
  const { username, password } = req.body || {};
  const { user, error } = verifyLogin(username, password);
  if (error) return res.status(400).json({ error });
  if (isMaintenanceOn() && !user.isAdmin) {
    return res.status(503).json({ error: 'Sitio en mantenimiento. Solo el administrador puede acceder.' });
  }
  touchLogin(user.id);
  const token = createSession(user.id);
  res.setHeader('Set-Cookie', sessionCookie(token));
  res.json({ ok: true, username: user.username });
});

app.post('/api/logout', (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  destroySession(cookies[SESSION_COOKIE]);
  res.setHeader('Set-Cookie', clearCookie());
  res.json({ ok: true });
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

app.get('/api/me', (req, res) => {
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ error: 'no auth' });
  const caps = capsForUser(user);
  res.json({
    username: user.username,
    roomKey: user.roomKey,
    isAdmin: !!user.isAdmin,
    active: isUserActive(user),
    plan: caps.plan,
    premiumUntil: user.premiumUntil || 0,
    caps: { limits: caps.limits, features: caps.features },
  });
});

// El .exe en modo relay puede pedir la roomKey de la nube por usuario (sin cookie de sesión).
app.post('/api/relay/mirror-room-key', express.json(), (req, res) => {
  const username = String(req.body?.username || '').trim().toLowerCase();
  if (!username) return res.status(400).json({ error: 'falta usuario' });
  const user = getUserByUsername(username);
  if (!user) return res.status(404).json({ error: 'no existe' });
  res.json({ roomKey: user.roomKey });
});

app.get('/api/panel-lives', (req, res) => {
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ error: 'no auth' });
  res.json({ lives: listPanelLives() });
});

// Directorio de lives para el .exe (relay): sin cookie de sesión, con CORS.
app.get('/api/panel-lives-public', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  res.json({ lives: listPanelLives() });
});

app.get('/api/streamer-rankings', (req, res) => {
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ error: 'no auth' });
  const type = req.query.type === 'diamonds' ? 'diamonds' : 'likes';
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 10));
  res.json(streamerRankings.getRankings({ type, limit }));
});

// Ajustes completos del usuario autenticado (para sincronizar entre la web y el .exe).
app.get('/api/my-settings', (req, res) => {
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ error: 'no auth' });
  const room = getRoomForUser(user);
  res.json({ settings: room.getSettings(), exists: room.hasSavedSettings() });
});
app.post('/api/my-settings', express.json({ limit: '8mb' }), (req, res) => {
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ error: 'no auth' });
  getRoomForUser(user).applySettings(req.body?.settings || {});
  res.json({ ok: true });
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

// Perfiles: lectura y cambio por HTTP (más fiable que solo WebSocket).
app.get('/api/profiles', (req, res) => {
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ error: 'no auth' });
  const room = getRoomForUser(user);
  res.json({ ok: true, profiles: room.getProfilesInfo() });
});
app.post('/api/profiles/switch-general', (req, res) => {
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ error: 'no auth' });
  const room = getRoomForUser(user);
  room.handleMessage(null, { action: 'switchGeneralProfile' });
  res.json({ ok: true, settings: room.getSettings(), profiles: room.getProfilesInfo() });
});
app.post('/api/profiles/switch', express.json(), (req, res) => {
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ error: 'no auth' });
  const idx = Number(req.body?.index);
  if (!Number.isInteger(idx)) return res.status(400).json({ error: 'index inválido' });
  const room = getRoomForUser(user);
  room.handleMessage(null, { action: 'switchProfile', index: idx });
  res.json({ ok: true, settings: room.getSettings(), profiles: room.getProfilesInfo() });
});

// Conectar/desconectar TikTok vía HTTP (usado por el .exe en modo relay como respaldo).
app.post('/api/room/connect', express.json(), (req, res) => {
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ error: 'no auth' });
  const username = String(req.body?.username || '').trim().replace(/^@/, '');
  if (!username) return res.status(400).json({ error: 'falta usuario' });
  getRoomForUser(user).handleMessage(null, { action: 'connect', username });
  res.json({ ok: true });
});
app.post('/api/room/disconnect', express.json(), (req, res) => {
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ error: 'no auth' });
  getRoomForUser(user).handleMessage(null, { action: 'disconnect' });
  res.json({ ok: true });
});

// Cobro de puntos para Spotify (modo relay del .exe): Spotify corre en la PC del
// streamer, pero los puntos son la fuente de verdad en la nube. El .exe llama aquí
// para comprobar saldo y descontar antes de añadir/saltar canciones.
app.post('/api/room/spotify-charge', express.json({ limit: '16kb' }), (req, res) => {
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ ok: false, error: 'no auth' });
  const b = req.body || {};
  const result = getRoomForUser(user).spotifyCharge({
    uniqueId: String(b.uniqueId || ''),
    nickname: String(b.nickname || ''),
    photo: String(b.photo || ''),
    cost: b.cost,
    desc: String(b.desc || 'Spotify'),
  });
  res.json(result || { ok: false });
});

// Prueba de videos por nivel (web en Render: reproduce en la nube; el overlay usa video.html de Render).
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
  room.handleMessage(null, { action: 'testLevelVideo', level });
  res.json({ ok: true, level, url, screen: Number(cfg.screen) || 1 });
});

// Catálogo + configuración de planes para CUALQUIER usuario autenticado (solo lectura).
// Lo usa la pestaña "Planes" para mostrar la comparación Gratis vs Premium.
app.get('/api/plans', (req, res) => {
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ error: 'no auth' });
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
app.get('/api/admin/users', requireAdmin, (_req, res) => {
  const out = listUsersDetailed().map((u) => {
    const full = getUserById(u.id);
    const plan = getUserPlan(full); // recalcula y baja a 'free' si el Premium caducó
    const room = rooms.get(u.id);
    const st = room ? room.getStatus() : null;
    return {
      ...u,
      plan,
      premiumUntil: full?.premiumUntil || 0,
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

// Diagnóstico del disco: comprueba si Render lee el volumen persistente correcto.
app.get('/api/admin/data-diag', requireAdmin, (_req, res) => {
  const info = getAuthDataInfo();
  const { folders, orphans } = scanDataDirUserFolders();
  const backups = listUserBackupFiles();
  const bestBackup = findBestUsersBackup();
  let usersFileCount = 0;
  try {
    const parsed = JSON.parse(fs.readFileSync(info.usersFile, 'utf8'));
    if (Array.isArray(parsed)) usersFileCount = parsed.length;
  } catch {}
  res.json({
    dataDir: info.dataDir,
    usersFile: info.usersFile,
    onRender: ON_RENDER,
    usingEphemeralData: USING_EPHEMERAL_DATA,
    dataDirEnv: process.env.DATA_DIR || null,
    usersInMemory: info.userCount,
    usersInFile: usersFileCount,
    userDataFolders: folders.length,
    orphanFolders: orphans,
    backups,
    bestBackup,
    disk: getDiskUsageSummary(),
    diskFreeMb: Math.round((getDiskFreeBytes() ?? 0) / 1024 / 1024),
    hint: USING_EPHEMERAL_DATA
      ? 'Falta DATA_DIR en Render. Añade DATA_DIR=/var/data (o la ruta de tu disco) y redespliega.'
      : (orphans.length && usersFileCount <= 1)
        ? 'Hay carpetas de usuarios huérfanas: pulsa «Restaurar cuentas desde copia» o restaura users.json.bak en Shell.'
        : (bestBackup.canRestore)
          ? `Copia ${bestBackup.name} tiene ${bestBackup.userCount} cuentas (${bestBackup.usernames.join(', ')}). Restáurala.`
          : null,
  });
});

app.post('/api/admin/restore-users-best-backup', requireAdmin, (_req, res) => {
  const result = restoreUsersFromBestBackup();
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

// Libera espacio: basura temporal + subidas huérfanas.
app.post('/api/admin/prune-disk', requireAdmin, (_req, res) => {
  const junk = pruneDiskJunk();
  let uploadsRemoved = 0;
  try {
    const before = getDiskUsageSummary().uploadsBytes;
    pruneOrphanUploads();
    uploadsRemoved = Math.max(0, before - getDiskUsageSummary().uploadsBytes);
  } catch {}
  res.json({ ok: true, junk, uploadsFreedBytes: uploadsRemoved, disk: getDiskUsageSummary() });
});

// Borra todos los videos en DATA_DIR/uploads (libera espacio en Render).
app.post('/api/admin/clear-upload-videos', requireAdmin, (_req, res) => {
  const before = getDiskUsageSummary();
  const result = clearPersistentUploadVideos();
  res.json({
    ok: true,
    removed: result.removed,
    freedMb: Math.round(result.freed / 1024 / 1024),
    diskBeforeMb: before.totalMb,
    diskAfterMb: getDiskUsageSummary().totalMb,
    diskFreeMb: Math.round((getDiskFreeBytes() ?? 0) / 1024 / 1024),
  });
});

// Liberación agresiva (uploads + JSON pesados + basura).
app.post('/api/admin/emergency-free-disk', requireAdmin, (_req, res) => {
  const result = emergencyFreeDiskSpace();
  res.json({ ok: true, ...result, diskFreeMb: Math.round((getDiskFreeBytes() ?? 0) / 1024 / 1024) });
});

// Restaura users.json desde una copia de seguridad en DATA_DIR.
app.post('/api/admin/restore-users-backup', express.json(), requireAdmin, (req, res) => {
  const { backupName } = req.body || {};
  const result = restoreUsersFromBackup(backupName);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

// Activar / desactivar una cuenta.
app.post('/api/admin/activate', express.json(), requireAdmin, (req, res) => {
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
app.post('/api/admin/userplan', express.json(), requireAdmin, (req, res) => {
  const { id, plan, days } = req.body || {};
  if (!id) return res.status(400).json({ error: 'falta id' });
  const ok = setUserPlan(id, plan, days);
  if (!ok) return res.status(404).json({ error: 'cuenta no encontrada' });
  // Avisamos al panel del usuario (si está conectado) para que aplique sus nuevos límites.
  const room = rooms.get(id);
  if (room) room.broadcastCaps?.(capsForUser(getUserById(id)));
  res.json({ ok: true });
});

// Eliminar una cuenta (excepto admin). Cierra su room, sesiones y datos locales.
app.post('/api/admin/delete-user', express.json(), requireAdmin, (req, res) => {
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

// Configuración de planes: catálogo de capacidades + límites/features por plan.
app.get('/api/admin/plans', requireAdmin, (_req, res) => {
  res.json({ catalog: CAPABILITIES, config: getPlanConfig() });
});
app.post('/api/admin/plans', express.json(), requireAdmin, (req, res) => {
  const config = savePlanConfig(req.body || {});
  // Reenviamos a todos los rooms conectados sus nuevas capacidades.
  for (const [id, room] of rooms) {
    const u = getUserById(id);
    if (u) room.broadcastCaps?.(capsForUser(u));
  }
  res.json({ ok: true, config });
});

/* ----------- Versión publicada de la app de escritorio (.exe) ----------- */
// El admin publica aquí la versión más reciente + enlace de descarga. La app .exe
// consulta GET /api/app-version al arrancar; si hay una versión mayor, avisa al
// usuario y (al aceptar) descarga e instala el nuevo instalador.
const APP_VERSION_FILE = path.join(DATA_DIR, 'appversion.json');
function readAppVersion() {
  try { return JSON.parse(fs.readFileSync(APP_VERSION_FILE, 'utf8')); }
  catch { return { version: '', url: '', notes: '', mandatory: false, updatedAt: 0 }; }
}
app.get('/api/app-version', (_req, res) => {
  // Nunca cachear: la app .exe debe ver SIEMPRE la última versión publicada, no una
  // respuesta vieja guardada por un proxy/CDN.
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

/* ----------- Enlace para "Instalar versión PC" (.exe — lo fija el admin) ----------- */
// El admin guarda aquí la URL del instalador de escritorio. El panel web muestra
// un botón "Instalar versión PC" que apunta a esta URL; al cambiarla aquí, el
// botón se actualiza para todos.
const WEB_INSTALL_FILE = path.join(DATA_DIR, 'webinstall.json');
function readWebInstall() {
  try { return JSON.parse(fs.readFileSync(WEB_INSTALL_FILE, 'utf8')); }
  catch { return { url: '', updatedAt: 0 }; }
}
app.get('/api/web-install', (_req, res) => {
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

app.post('/api/admin/maintenance', express.json(), requireAdmin, (req, res) => {
  const b = req.body || {};
  const data = {
    enabled: !!b.enabled,
    message: String(b.message || '').trim(),
    updatedAt: Date.now(),
  };
  try { writeMaintenance(data); }
  catch { return res.status(500).json({ error: 'No se pudo guardar.' }); }
  res.json({ ok: true, ...data });
});

/* --------------------------- Anuncios (panel) --------------------------- */
const ANNOUNCEMENTS_FILE = path.join(DATA_DIR, 'announcements.json');
const ANNOUNCEMENTS_MAX = 50;

function readAnnouncements() {
  try {
    const raw = JSON.parse(fs.readFileSync(ANNOUNCEMENTS_FILE, 'utf8'));
    return Array.isArray(raw) ? raw : (raw.announcements || []);
  } catch { return []; }
}
function writeAnnouncements(list) {
  const tmp = ANNOUNCEMENTS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
  fs.renameSync(tmp, ANNOUNCEMENTS_FILE);
}

app.get('/api/announcements', (req, res) => {
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ error: 'no auth' });
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  const list = readAnnouncements()
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  res.json({ announcements: list });
});

app.post('/api/admin/announcements', express.json(), requireAdmin, (req, res) => {
  const title = String((req.body || {}).title || '').trim();
  const message = String((req.body || {}).message || '').trim();
  if (!title) return res.status(400).json({ error: 'Escribe un título.' });
  if (!message) return res.status(400).json({ error: 'Escribe el mensaje.' });
  const item = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    title,
    message,
    createdAt: Date.now(),
  };
  const list = [item, ...readAnnouncements()].slice(0, ANNOUNCEMENTS_MAX);
  try { writeAnnouncements(list); }
  catch { return res.status(500).json({ error: 'No se pudo guardar.' }); }
  res.json({ ok: true, announcement: item });
});

app.post('/api/admin/announcements/delete', express.json(), requireAdmin, (req, res) => {
  const id = String((req.body || {}).id || '').trim();
  if (!id) return res.status(400).json({ error: 'falta id' });
  const list = readAnnouncements().filter((a) => a.id !== id);
  try { writeAnnouncements(list); }
  catch { return res.status(500).json({ error: 'No se pudo eliminar.' }); }
  res.json({ ok: true });
});

/* ------------------- Protección básica (disuasión copia) ------------------- */
// Inyecta protect.js en todo HTML servido (panel + overlays). NO es seguridad
// real: solo dificulta la copia casual (clic derecho, F12, ver fuente…).
const PUBLIC_DIR = path.join(__dirname, 'public');
const GUARD_TAG = '<script src="/js/protect.js" defer></script>';
function injectGuard(html) {
  if (html.includes('/js/protect.js')) return html;
  if (html.includes('</head>')) return html.replace('</head>', GUARD_TAG + '</head>');
  if (html.includes('</body>')) return html.replace('</body>', GUARD_TAG + '</body>');
  return html + GUARD_TAG;
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
  if (isMaintenanceOn() && !user.isAdmin) {
    return sendHtmlFile(res, path.join(PUBLIC_DIR, 'maintenance.html'));
  }
  if (!isUserActive(user)) return sendHtmlFile(res, path.join(PUBLIC_DIR, 'pending.html'));
  sendHtmlFile(res, path.join(PUBLIC_DIR, 'index.html'));
});


// Archivos pesados (videos subidos y audios): caché larga en el navegador. Sus nombres
// son únicos, así que se pueden cachear sin problema y al ACTUALIZAR la página el
// navegador los reutiliza al instante en vez de descargarlos otra vez.
const heavyCache = { maxAge: '30d', immutable: true };
app.use('/uploads', express.static(UPLOADS_DIR, heavyCache));
app.use('/audios', express.static(path.join(__dirname, 'public', 'audios'), heavyCache));
// Videos de AI: caché larga en el navegador para que al recargar el panel no se
// vuelvan a descargar (antes esto era lo que hacía lenta la carga).
app.use('/video', express.static(VIDEOS_DIR, heavyCache));
app.use('/niveles', express.static(NIVELES_VIDEOS_DIR, heavyCache));

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

// Proxy de imágenes externas (CDN de regalos TikTok) para descargar PNG sin CORS.
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

// Stickers/emotes vistos en el live del usuario (por room).
app.get('/api/emotes', (req, res) => {
  const user = userFromRequest(req);
  if (!user) return res.json({ results: [] });
  res.json({ results: getRoomForUser(user).getEmotes() });
});

// Formatos que el navegador reproduce tal cual; el resto se transcodifica a MP4 H.264.
const WEB_FRIENDLY_EXT = new Set([
  '.mp4', '.webm', '.ogg', '.ogv', '.m4v',
  '.gif', '.png', '.jpg', '.jpeg', '.webp', '.apng', '.bmp', '.svg',
  '.mp3', '.wav', '.aac', '.m4a', '.oga',
]);

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

// Subida por streaming. Requiere sesión; cada usuario tiene su carpeta y cuota en disco.
app.post('/api/upload', (req, res) => {
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ error: 'Inicia sesión para subir archivos.' });

  const userDir = userUploadDir(user.id);
  trimUserUploadQuota(user.id);
  const usedBefore = dirSizeBytes(userDir);
  if (usedBefore >= UPLOAD_MAX_USER_BYTES) {
    return res.status(507).json({
      error: `Almacenamiento lleno (máx. ${Math.round(UPLOAD_MAX_USER_BYTES / 1024 / 1024)} MB por cuenta). Borra alertas con videos viejos o usa la app PC.`,
    });
  }

  const safe = String(req.query.name || 'file').replace(/[^\w.\-]+/g, '_').slice(-60);
  const fname = `${Date.now()}_${safe}`;
  const dest = path.join(userDir, fname);
  const out = fs.createWriteStream(dest);
  let bytes = 0;
  let failed = false;
  const fail = (msg, code = 500) => {
    if (failed) return;
    failed = true;
    out.destroy();
    fs.unlink(dest, () => {});
    if (!res.headersSent) res.status(code).json({ error: msg || 'no se pudo guardar' });
  };
  req.on('data', (chunk) => {
    bytes += chunk.length;
    if (bytes > UPLOAD_MAX_FILE_BYTES) {
      fail(`Archivo muy grande (máx. ${Math.round(UPLOAD_MAX_FILE_BYTES / 1024 / 1024)} MB por video).`, 413);
    }
    if (usedBefore + bytes > UPLOAD_MAX_USER_BYTES) {
      fail(`Superarías tu cuota de ${Math.round(UPLOAD_MAX_USER_BYTES / 1024 / 1024)} MB. Borra videos antiguos.`, 507);
    }
  });
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
    res.json({
      url: `/uploads/${user.id}/${finalName}`,
      converted: finalPath !== dest,
    });
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

// Traducción gratuita con MyMemory (sin API key).
async function ttsTranslateMyMemory(text, source, target) {
  const url = 'https://api.mymemory.translated.net/get?q=' +
    encodeURIComponent(text) + '&langpair=' + encodeURIComponent(source + '|' + target);
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) return '';
  const j = await r.json();
  const out = j && j.responseData && j.responseData.translatedText ? String(j.responseData.translatedText).trim() : '';
  // MyMemory a veces devuelve avisos en mayúsculas cuando falla; los descartamos.
  if (!out || /^MYMEMORY WARNING/i.test(out) || /QUERY LENGTH LIMIT/i.test(out)) return '';
  return out;
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

// Sintetiza voz TikTok probando varios proxys públicos. Devuelve base64 (mp3) o ''.
async function ttsSynthTikTok(text, voice) {
  const body = JSON.stringify({ text, voice });
  const headers = { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' };
  // 1) Worker de Weilbyte (el más usado/estable).
  try {
    const r = await fetch('https://tiktok-tts.weilnet.workers.dev/api/generation', { method: 'POST', headers, body });
    if (r.ok) {
      const j = await r.json();
      if (j && j.data && !j.error) return String(j.data);
    }
  } catch { /* probamos el siguiente */ }
  // 2) Gesserit (fallback).
  try {
    const r = await fetch('https://gesserit.co/api/tts', { method: 'POST', headers, body });
    if (r.ok) {
      const j = await r.json();
      if (j && (j.base64 || j.data)) return String(j.base64 || j.data);
    }
  } catch { /* sin más fallbacks */ }
  return '';
}

app.post('/api/tts/speak', express.json(), async (req, res) => {
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ ok: false, error: 'no_auth' });
  // Las voces TikTok/Disney pueden estar reservadas a ciertos planes.
  if (!capsForUser(user).features.tts_tiktok) {
    return res.status(403).json({ ok: false, error: 'plan_locked' });
  }
  let text = String((req.body && req.body.text) || '').trim();
  const voice = String((req.body && req.body.voice) || '').trim();
  const translate = (req.body && req.body.translate) !== false;
  if (!text) return res.status(400).json({ ok: false, error: 'missing_text' });
  if (!TIKTOK_VOICES.has(voice)) return res.status(400).json({ ok: false, error: 'bad_voice' });
  if (text.length > 280) text = text.slice(0, 280);

  let translated = false;
  let original = text;
  // Traduce ES→EN solo para voces en inglés y si el texto parece español.
  if (translate && voice.startsWith('en_') && /[áéíóúñ¿¡üA-Za-z]/.test(text)) {
    try {
      const key = 'es|en|' + text.toLowerCase();
      let en = ttsTranslateCacheGet(key);
      if (!en) { en = await ttsTranslateMyMemory(text, 'es', 'en'); if (en) ttsTranslateCacheSet(key, en); }
      if (en) { text = en; translated = true; }
    } catch { /* si falla, hablamos el original */ }
  }

  try {
    const audio = await ttsSynthTikTok(text, voice);
    if (!audio) return res.status(502).json({ ok: false, error: 'synth_failed' });
    res.json({ ok: true, audio, mime: 'audio/mpeg', text, original, translated });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

const server = http.createServer(app);

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
    const roleRaw = String(url.searchParams.get('role') || 'panel').toLowerCase();
    const role = (roleRaw === 'local' || roleRaw === 'relay') ? roleRaw : 'panel';
    room.addClient(ws, role);

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

server.listen(PORT, () => {
  const info = getAuthDataInfo();
  console.log('\n  ┌───────────────────────────────────────────┐');
  console.log('  │   Livecoins  —  panel estilo TikFinity       │');
  console.log('  ├───────────────────────────────────────────┤');
  console.log(`  │   ${eulerStartupLine().padEnd(42)}│`);
  console.log(`  │   Panel:   http://localhost:${PORT}/`.padEnd(46) + '│');
  console.log(`  │   Login:   http://localhost:${PORT}/login.html`.padEnd(46) + '│');
  console.log('  └───────────────────────────────────────────┘');
  console.log(`  [data] DATA_DIR=${info.dataDir}`);
  console.log(`  [data] Cuentas cargadas: ${info.userCount}`);
  const disk = getDiskUsageSummary();
  console.log(`  [data] Uso disco: ~${disk.totalMb} MB (uploads ~${Math.round(disk.uploadsBytes / 1024 / 1024)} MB)`);
  if (USING_EPHEMERAL_DATA) {
    console.error('\n  [!] RENDER sin DATA_DIR: las cuentas NO usan el disco persistente.');
    console.error('      En Environment añade:  DATA_DIR=/var/data  (ruta de tu disco)\n');
  }
  console.log('');
});

process.on('SIGINT', () => {
  for (const room of rooms.values()) {
    try { room.shutdown(); } catch {}
  }
  try { streamerRankings.flush(); } catch {}
  process.exit(0);
});
