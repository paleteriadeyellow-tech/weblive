// HOKEY LIVE — servidor multiusuario.
// Cada usuario registrado tiene su propia "room": conexión a TikTok, ajustes, estado,
// batalla y overlays totalmente aislados (ver room.js). Aquí solo va lo compartido:
// catálogo de regalos, archivos estáticos, autenticación y el enrutado de WebSockets.
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
  userFromRequest, getUserByRoomKey, listUsers, listUsersDetailed,
  isUserActive, setUserActive, touchLogin,
  sessionCookie, clearCookie, parseCookies, SESSION_COOKIE,
} from './auth.js';

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

async function loadGiftCatalog(force = false) {
  if (!force && giftsCache && Date.now() - giftsCacheAt < 6 * 60 * 60 * 1000) {
    return giftsCache;
  }
  const tmp = new TikTokLiveConnection('tv_asahi_news');
  const gifts = await tmp.fetchAvailableGifts();
  const results = (Array.isArray(gifts) ? gifts : [])
    .map((g) => ({
      id: g.id,
      name: g.name,
      diamonds: g.diamond_count ?? g.diamondCount ?? 0,
      image: g.image?.url_list?.[0] || g.icon?.url_list?.[0] || (typeof g.image === 'string' ? g.image : ''),
    }))
    .filter((g) => g.name)
    .sort((a, b) => a.diamonds - b.diamonds);
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

function getRoomForUser(user) {
  let room = rooms.get(user.id);
  if (!room) {
    room = createRoom({
      id: user.id,
      username: user.username,
      roomKey: user.roomKey,
      dataDir: path.join(DATA_DIR, user.id),
      giftsById,
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

app.get('/api/me', (req, res) => {
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ error: 'no auth' });
  res.json({
    username: user.username,
    roomKey: user.roomKey,
    isAdmin: !!user.isAdmin,
    active: isUserActive(user),
  });
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
    const room = rooms.get(u.id);
    const st = room ? room.getStatus() : null;
    return {
      ...u,
      live: !!(st && st.live),
      connecting: !!(st && st.connecting),
      liveSince: st ? st.liveSince : null,
      account: st ? st.account : null,
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

/* ----------------------------- Panel protegido ----------------------------- */
// El panel (index.html) requiere sesión iniciada y cuenta ACTIVADA por el admin.
app.get(['/', '/index.html'], (req, res) => {
  const user = userFromRequest(req);
  if (!user) return res.redirect('/login.html');
  if (!isUserActive(user)) return res.sendFile(path.join(__dirname, 'public', 'pending.html'));
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Archivos pesados (videos subidos y audios): caché larga en el navegador. Sus nombres
// son únicos, así que se pueden cachear sin problema y al ACTUALIZAR la página el
// navegador los reutiliza al instante en vez de descargarlos otra vez.
const heavyCache = { maxAge: '30d', immutable: true };
app.use('/uploads', express.static(path.join(__dirname, 'public', 'uploads'), heavyCache));
app.use('/audios', express.static(path.join(__dirname, 'public', 'audios'), heavyCache));

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
  fs.readdir(VIDEOS_DIR, (err, files) => {
    if (err) return res.json({ results: [] });
    const exts = ['.mp4', '.webm', '.mov', '.mkv', '.gif', '.png', '.jpg', '.jpeg'];
    const results = files
      .filter((f) => exts.includes(path.extname(f).toLowerCase()))
      .sort((a, b) => a.localeCompare(b))
      .map((f) => ({ name: f, url: '/video/' + encodeURIComponent(f) }));
    res.json({ results });
  });
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

// Subida de archivos (compartida).
app.post('/api/upload', express.raw({ type: '*/*', limit: '30mb' }), (req, res) => {
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
  // Narrador / estilos (inglés)
  'en_male_narration', 'en_male_funny', 'en_female_emotional', 'en_male_cody', 'en_female_samc',
  // Inglés estándar
  'en_us_001', 'en_us_002', 'en_us_006', 'en_us_007', 'en_us_009', 'en_us_010', 'en_uk_001', 'en_uk_003', 'en_au_001', 'en_au_002',
  // Español
  'es_002', 'es_mx_002', 'es_male_m3', 'es_female_f6',
  // Otros idiomas
  'fr_001', 'de_001', 'pt_br_005', 'it_male_m18', 'jp_001', 'kr_002',
  // Canto
  'en_female_f08_salut_damour', 'en_male_m03_lobby', 'en_female_f08_warmy_breeze',
  'en_male_m03_sunshine_soon', 'en_female_ht_f08_glorious', 'en_male_sing_funny_it_goes_up',
  'en_male_m2_xhxs_m03_silly', 'en_female_ht_f08_wonderful_world',
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
    room.addClient(ws);

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
