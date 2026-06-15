// HOKEY LIVE — servidor multiusuario.
// Cada usuario registrado tiene su propia "room": conexión a TikTok, ajustes, estado,
// batalla y overlays totalmente aislados (ver room.js). Aquí solo va lo compartido:
// catálogo de regalos, archivos estáticos, autenticación y el enrutado de WebSockets.
import { eulerStartupLine } from './euler-config.js';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { TikTokLiveConnection } from 'tiktok-live-connector';
import { createRoom } from './room.js';
import {
  registerUser, verifyLogin, createSession, destroySession,
  userFromRequest, getUserByRoomKey, getUserById, listUsers, listUsersDetailed,
  isUserActive, setUserActive, touchLogin,
  getUserPlan, setUserPlan, findOrCreateGoogleUser,
  sessionCookie, clearCookie, parseCookies, SESSION_COOKIE,
} from './auth.js';
import * as google from './google.js';
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

/* ----------------------------------------------------------------------------
 * Catálogo de regalos de TikTok (compartido por todos los usuarios). Cacheado.
 * --------------------------------------------------------------------------*/
let giftsCache = null;
let giftsCacheAt = 0;
const giftsById = new Map(); // id -> { id, name, diamonds, image }

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

async function loadGiftCatalog(force = false) {
  if (!force && giftsCache && Date.now() - giftsCacheAt < 6 * 60 * 60 * 1000) {
    return giftsCache;
  }
  // Base: catálogo fijo del archivo (el mismo que ve el .exe).
  const merged = new Map();
  for (const g of loadGiftBaseFile()) {
    if (g && g.name) merged.set(String(g.id), g);
  }
  // Fusiona con el catálogo en vivo (añade/actualiza los que TikTok devuelva ahora).
  try {
    const tmp = new TikTokLiveConnection('tv_asahi_news');
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
  giftsCache = results;
  giftsCacheAt = Date.now();
  giftsById.clear();
  for (const g of results) giftsById.set(String(g.id), g);
  return results;
}

loadGiftCatalog().then((r) => {
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
    });
    rooms.set(user.id, room);
  }
  return room;
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
const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
const AUDIOS_DIR = path.join(__dirname, 'public', 'audios');
fs.mkdirSync(AUDIOS_DIR, { recursive: true });
const VIDEOS_DIR = path.join(__dirname, 'public', 'video');
fs.mkdirSync(VIDEOS_DIR, { recursive: true });
// Carpeta dedicada para los videos de la pestaña Batallas (videos AI de batalla).
const BATALLA_VIDEOS_DIR = path.join(VIDEOS_DIR, 'batalla');
fs.mkdirSync(BATALLA_VIDEOS_DIR, { recursive: true });
// Carpeta de videos por NIVEL de miembro: nivel1.mp4, nivel2.mp4… Al subir alguien de
// nivel se reproduce automáticamente el que coincida.
const NIVELES_VIDEOS_DIR = process.env.NIVELES_DIR || path.join(VIDEOS_DIR, 'niveles');
fs.mkdirSync(NIVELES_VIDEOS_DIR, { recursive: true });
const PROJECT_NIVELES_DIR = path.join(VIDEOS_DIR, 'niveles');

// Carpetas donde buscar videos de nivel, con su URL base servible.
function nivelesSources() {
  const out = [{ dir: NIVELES_VIDEOS_DIR, urlBase: '/niveles/' }];
  if (path.resolve(PROJECT_NIVELES_DIR) !== path.resolve(NIVELES_VIDEOS_DIR)) {
    out.push({ dir: PROJECT_NIVELES_DIR, urlBase: '/video/niveles/' });
  }
  return out;
}

const NIVEL_EXTS = ['.mp4', '.webm', '.gif', '.webp', '.png', '.jpg', '.jpeg', '.mov', '.mkv'];
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
app.post('/api/register', express.json(), (req, res) => {
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
 * Inicio de sesión con Google (OAuth 2.0). Queda inactivo si Google no está
 * configurado (no rompe el login normal de usuario/contraseña).
 * --------------------------------------------------------------------------*/
app.get('/api/auth/config', (req, res) => {
  res.json({ google: google.isConfigured() });
});

app.get('/api/auth/google', (req, res) => {
  if (!google.isConfigured()) return res.redirect('/login.html?err=google_off');
  const url = google.buildAuthUrl(google.redirectUriFor(req), '');
  res.redirect(url);
});

app.get('/api/auth/google/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.redirect('/login.html?err=google_cancel');
  const p = code && state ? google.consumeState(String(state)) : null;
  if (!p) return res.redirect('/login.html?err=google_state');
  try {
    const { email, name } = await google.exchangeCode(String(code), p.redirectUri);
    const { user, error: uErr } = findOrCreateGoogleUser({ email, name });
    if (uErr || !user) return res.redirect('/login.html?err=google_user');
    touchLogin(user.id);
    const token = createSession(user.id);
    res.setHeader('Set-Cookie', sessionCookie(token));
    res.redirect('/');
  } catch (e) {
    console.error('  [google] callback:', e.message);
    res.redirect('/login.html?err=google_fail');
  }
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
  } catch (e) {
    return res.status(500).json({ error: 'No se pudo guardar.' });
  }
  res.json({ ok: true, ...data });
});

/* ----------- Enlace para "Instalar versión web" (lo fija el admin) ----------- */
// El admin guarda aquí la URL de instalación de la versión web. El panel muestra
// un botón "Instalar versión web" que apunta a esta URL; al cambiarla aquí, el
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
app.use('/uploads', express.static(path.join(__dirname, 'public', 'uploads'), heavyCache));
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

app.get('/api/gifts', async (_req, res) => {
  try {
    const results = await loadGiftCatalog();
    res.json({ results });
  } catch (e) {
    res.status(502).json({ results: giftsCache || [], error: 'No se pudo cargar el catálogo de regalos.' });
  }
});

// Stickers/emotes vistos en el live del usuario (por room).
app.get('/api/emotes', (req, res) => {
  const user = userFromRequest(req);
  if (!user) return res.json({ results: [] });
  res.json({ results: getRoomForUser(user).getEmotes() });
});

// Subida de archivos (compartida). Límite 100 MB para videos cortos de alertas/overlays.
app.post('/api/upload', express.raw({ type: '*/*', limit: '100mb' }), (req, res) => {
  if (!req.body || !req.body.length) return res.status(400).json({ error: 'archivo vacío' });
  const safe = String(req.query.name || 'file').replace(/[^\w.\-]+/g, '_').slice(-60);
  const fname = `${Date.now()}_${safe}`;
  fs.writeFile(path.join(UPLOADS_DIR, fname), req.body, (err) => {
    if (err) return res.status(500).json({ error: 'no se pudo guardar' });
    res.json({ url: '/uploads/' + fname });
  });
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
    else user = userFromRequest(req);

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
  console.log('\n  ┌───────────────────────────────────────────┐');
  console.log('  │   Livecoins  —  panel estilo TikFinity       │');
  console.log('  ├───────────────────────────────────────────┤');
  console.log(`  │   ${eulerStartupLine().padEnd(42)}│`);
  console.log(`  │   Panel:   http://localhost:${PORT}/`.padEnd(46) + '│');
  console.log(`  │   Login:   http://localhost:${PORT}/login.html`.padEnd(46) + '│');
  console.log('  └───────────────────────────────────────────┘\n');
});

process.on('SIGINT', () => {
  for (const room of rooms.values()) {
    try { room.shutdown(); } catch {}
  }
  process.exit(0);
});
