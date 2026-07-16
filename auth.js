// Autenticación sin base de datos: usuarios y sesiones en archivos JSON.
// Contraseñas con scrypt (node:crypto). Cada usuario tiene una "roomKey" pública
// que usan los overlays de OBS para conectarse a SU room (sin iniciar sesión).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Mismo criterio que server.js: en hosting usamos el disco persistente (DATA_DIR),
// en local la carpeta "data" del proyecto. Así las cuentas no se pierden online.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const DESKTOP_LAST_SESSION_FILE = path.join(DATA_DIR, 'desktop-last-session.json');

fs.mkdirSync(DATA_DIR, { recursive: true });

const SESSION_COOKIE = 'hokey_sid';
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000; // 30 días
const ADMIN_USERNAME = 'jesus'; // este usuario es el administrador

let users = load(USERS_FILE, []);
let sessions = new Map(Object.entries(load(SESSIONS_FILE, {})));

// Normaliza usuarios existentes: marca al admin y asegura el campo `active`.
// Las cuentas nuevas quedan inactivas hasta que el admin las active.
(function normalizeUsers() {
  let changed = false;
  for (const u of users) {
    if (u.username === ADMIN_USERNAME) {
      if (!u.isAdmin) { u.isAdmin = true; changed = true; }
      if (u.active !== true) { u.active = true; changed = true; }
    }
    if (u.active === undefined) { u.active = true; changed = true; }
    if (u.lastLogin === undefined) { u.lastLogin = 0; changed = true; }
    if (u.plan === undefined) { u.plan = u.isAdmin ? 'premium' : 'free'; changed = true; }
    if (u.premiumUntil === undefined) { u.premiumUntil = 0; changed = true; } // 0 = sin caducidad (fijo)
    // Juegos activos por defecto; el admin puede desactivarlos a un usuario concreto.
    if (u.gamesEnabled === undefined) { u.gamesEnabled = true; changed = true; }
    // Migración: ya no se requiere activación. Activamos UNA sola vez a las cuentas
    // antiguas que quedaron pendientes; después el admin puede desactivar y persiste.
    if (!u.activatedByDefault) { u.active = true; u.activatedByDefault = true; changed = true; }
  }
  if (changed) saveUsers();
})();

function load(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function saveUsers() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf8');
  } catch (e) {
    try { console.error('[auth] No se pudo guardar users.json:', e && e.message); } catch {}
  }
}
function saveSessions() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(Object.fromEntries(sessions)), 'utf8');
  } catch (e) {
    try { console.error('[auth] No se pudo guardar sessions.json:', e && e.message); } catch {}
  }
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { salt, hash };
}
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function normalizeUsername(name) {
  return String(name || '').trim().toLowerCase();
}

export function listUsers() {
  return users.map((u) => ({ id: u.id, username: u.username, roomKey: u.roomKey }));
}
// Detalle para el panel de administración (sin exponer salt/hash).
export function listUsersDetailed() {
  return users.map((u) => ({
    id: u.id,
    username: u.username,
    roomKey: u.roomKey,
    active: !!u.active,
    isAdmin: !!u.isAdmin,
    plan: u.plan || 'free',
    premiumUntil: u.premiumUntil || 0,
    gamesEnabled: u.isAdmin ? true : u.gamesEnabled !== false,
    createdAt: u.createdAt || 0,
    lastLogin: u.lastLogin || 0,
  }));
}
export function isUserActive(user) {
  return !!(user && (user.isAdmin || user.active));
}
export function setUserActive(id, active) {
  const u = users.find((x) => x.id === id);
  if (!u) return false;
  if (u.isAdmin) { u.active = true; return true; } // el admin no se puede desactivar
  u.active = !!active;
  saveUsers();
  return true;
}
// Plan efectivo del usuario ('premium' para el admin). Si el Premium tenía fecha de
// caducidad y ya pasó, lo baja a 'free' de forma persistente (y devuelve 'free').
export function getUserPlan(user) {
  if (!user) return 'free';
  if (user.isAdmin) return 'premium';
  if (user.plan === 'premium') {
    if (user.premiumUntil && user.premiumUntil > 0 && Date.now() > user.premiumUntil) {
      user.plan = 'free';
      user.premiumUntil = 0;
      saveUsers();
      return 'free';
    }
    return 'premium';
  }
  return 'free';
}
// Cambia el plan. days > 0 => Premium temporal que caduca en N días.
// days = 0/null => si es premium, queda FIJO (sin caducidad).
export function setUserPlan(id, plan, days) {
  const u = users.find((x) => x.id === id);
  if (!u) return false;
  if (plan === 'premium') {
    u.plan = 'premium';
    const n = Number(days);
    u.premiumUntil = (Number.isFinite(n) && n > 0) ? Date.now() + n * 24 * 60 * 60 * 1000 : 0;
  } else {
    u.plan = 'free';
    u.premiumUntil = 0;
  }
  saveUsers();
  return true;
}
/** true salvo que el admin haya desactivado los juegos a ese usuario (admin siempre sí). */
export function isUserGamesEnabled(user) {
  if (!user) return true;
  if (user.isAdmin) return true;
  return user.gamesEnabled !== false;
}
/** Activa o desactiva todos los minijuegos para una cuenta (no afecta al admin). */
export function setUserGamesEnabled(id, enabled) {
  const u = users.find((x) => x.id === id);
  if (!u) return false;
  if (u.isAdmin) { u.gamesEnabled = true; saveUsers(); return true; }
  u.gamesEnabled = !!enabled;
  saveUsers();
  return true;
}
// Elimina una cuenta (no admin). Cierra sus sesiones en sessions.json.
export function deleteUser(id) {
  const idx = users.findIndex((x) => x.id === id);
  if (idx < 0) return false;
  if (users[idx].isAdmin) return false;
  users.splice(idx, 1);
  for (const [token, s] of sessions.entries()) {
    if (s.userId === id) sessions.delete(token);
  }
  saveUsers();
  saveSessions();
  return true;
}
export function touchLogin(id) {
  const u = users.find((x) => x.id === id);
  if (u) { u.lastLogin = Date.now(); saveUsers(); }
}
export function isFirstUser() {
  return users.length === 0;
}
export function getUserById(id) {
  return users.find((u) => u.id === id) || null;
}
export function getUserByRoomKey(roomKey) {
  return users.find((u) => u.roomKey === roomKey) || null;
}
export function getUserByUsername(username) {
  const uname = normalizeUsername(username);
  return users.find((u) => u.username === uname) || null;
}

export function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

/** Email verificado ligado a la cuenta (recuperación de contraseña). */
export function getUserByVerifiedEmail(email) {
  const mail = normalizeEmail(email);
  if (!mail) return null;
  return users.find((u) => u.emailVerified && normalizeEmail(u.email) === mail) || null;
}

export function isEmailTaken(email, exceptUserId) {
  const mail = normalizeEmail(email);
  if (!mail) return false;
  return users.some((u) =>
    u.id !== exceptUserId
    && u.emailVerified
    && normalizeEmail(u.email) === mail);
}

export function publicEmailFields(user) {
  if (!user) return { email: null, emailVerified: false };
  if (user.emailVerified && user.email) {
    return { email: normalizeEmail(user.email), emailVerified: true };
  }
  return { email: null, emailVerified: false };
}

/** Solo escribe email tras verificar el código. No toca contraseña ni roomKey. */
export function setUserVerifiedEmail(id, email) {
  const u = users.find((x) => x.id === id);
  if (!u) return false;
  const mail = normalizeEmail(email);
  if (!mail || !mail.includes('@')) return false;
  u.email = mail;
  u.emailVerified = true;
  saveUsers();
  return true;
}

export function setUserPassword(id, password) {
  const u = users.find((x) => x.id === id);
  if (!u) return false;
  if (String(password || '').length < 4) return false;
  const { salt, hash } = hashPassword(password);
  u.salt = salt;
  u.hash = hash;
  saveUsers();
  return true;
}

export function destroySessionsForUser(userId) {
  let changed = 0;
  for (const [token, s] of sessions.entries()) {
    if (s.userId === userId) {
      sessions.delete(token);
      changed++;
    }
  }
  if (changed) saveSessions();
  return changed;
}

// "Espejo" de una cuenta de la web (login delegado en la app .exe). Si la cuenta no
// existe localmente la crea; si existe, refresca su contraseña/plan/estado con lo que
// devolvió el servidor remoto. Así el mismo usuario/clave de la web funciona en el .exe
// y, una vez logueado, también puede entrar sin internet (queda cacheado en local).
export function upsertMirrorUser({ username, password, plan, isAdmin, active }) {
  const uname = normalizeUsername(username);
  let user = users.find((u) => u.username === uname);
  const { salt, hash } = hashPassword(password);
  if (!user) {
    user = {
      id: crypto.randomUUID(),
      username: uname,
      salt,
      hash,
      roomKey: crypto.randomBytes(9).toString('base64url'),
      createdAt: Date.now(),
      lastLogin: Date.now(),
      isAdmin: !!isAdmin || uname === ADMIN_USERNAME,
      active: active !== false,
      activatedByDefault: true,
      plan: plan === 'premium' ? 'premium' : 'free',
      premiumUntil: 0,
      gamesEnabled: true,
      mirror: true,
    };
    users.push(user);
  } else {
    // refresca credenciales (por si cambió la clave en la web) y datos de plan/estado
    user.salt = salt;
    user.hash = hash;
    user.isAdmin = !!isAdmin || uname === ADMIN_USERNAME;
    user.active = active !== false;
    user.plan = plan === 'premium' ? 'premium' : 'free';
    if (user.gamesEnabled === undefined) user.gamesEnabled = true;
    user.premiumUntil = 0;
    user.mirror = true;
  }
  saveUsers();
  return user;
}

// Actualiza SOLO el plan/estado de un usuario espejo (sin tocar la contraseña).
// Se usa en el .exe para refrescar el plan que el admin cambió en Render, sin
// necesidad de que el usuario vuelva a iniciar sesión. Devuelve true si cambió algo.
export function updateMirrorPlan(id, { plan, isAdmin, active, premiumUntil, gamesEnabled } = {}) {
  const u = users.find((x) => x.id === id);
  if (!u) return false;
  let changed = false;
  const newPlan = plan === 'premium' ? 'premium' : 'free';
  if (u.plan !== newPlan) { u.plan = newPlan; changed = true; }
  const pu = Number(premiumUntil);
  const newPu = Number.isFinite(pu) && pu > 0 ? pu : 0;
  if ((u.premiumUntil || 0) !== newPu) { u.premiumUntil = newPu; changed = true; }
  if (isAdmin !== undefined && !!u.isAdmin !== !!isAdmin) { u.isAdmin = !!isAdmin; changed = true; }
  if (active !== undefined && !!u.active !== (active !== false)) { u.active = active !== false; changed = true; }
  if (gamesEnabled !== undefined) {
    const next = u.isAdmin ? true : !!gamesEnabled;
    const prevOn = u.gamesEnabled !== false;
    if (prevOn !== next) { u.gamesEnabled = next; changed = true; }
  }
  if (changed) saveUsers();
  return changed;
}

// Guarda la roomKey de Render para que el .exe pueda reconectar al panel en la nube
// aunque caduque la cookie remota (el WebSocket usa esta clave, no la cookie).
export function updateMirrorCloudRoomKey(id, cloudRoomKey) {
  const u = users.find((x) => x.id === id);
  if (!u) return false;
  const key = String(cloudRoomKey || '').trim();
  if (!key || u.cloudRoomKey === key) return false;
  u.cloudRoomKey = key;
  saveUsers();
  return true;
}

// Crea un usuario. Devuelve { user } o { error }.
// opts.email: si viene ya verificado (código OK), se guarda como emailVerified.
export function registerUser(username, password, opts = {}) {
  const uname = normalizeUsername(username);
  if (!/^[a-z0-9_.]{3,20}$/.test(uname)) {
    return { error: 'El usuario debe tener 3-20 caracteres (letras, números, _ o .).' };
  }
  if (String(password || '').length < 4) {
    return { error: 'La contraseña debe tener al menos 4 caracteres.' };
  }
  if (users.some((u) => u.username === uname)) {
    return { error: 'Ese usuario ya existe.' };
  }
  const mail = normalizeEmail(opts.email);
  if (mail) {
    if (!mail.includes('@')) return { error: 'Correo inválido.' };
    if (isEmailTaken(mail)) return { error: 'Ese correo ya está vinculado a otra cuenta.' };
  }
  const { salt, hash } = hashPassword(password);
  const isAdmin = uname === ADMIN_USERNAME;
  const user = {
    id: crypto.randomUUID(),
    username: uname,
    salt,
    hash,
    roomKey: crypto.randomBytes(9).toString('base64url'),
    createdAt: Date.now(),
    lastLogin: Date.now(),
    isAdmin,
    active: true, // ya no hace falta activación: pueden entrar al crear la cuenta
    activatedByDefault: true,
    plan: isAdmin ? 'premium' : 'free', // las cuentas nuevas empiezan en gratis
    premiumUntil: 0,
    gamesEnabled: true,
  };
  if (mail) {
    user.email = mail;
    user.emailVerified = true;
  }
  users.push(user);
  saveUsers();
  return { user };
}

// Genera un nombre de usuario único a partir del correo (parte antes del @).
function uniqueUsernameFromEmail(email) {
  const raw = String(email || '').split('@')[0].toLowerCase().replace(/[^a-z0-9_.]/g, '');
  let base = raw.slice(0, 18) || 'user';
  if (base.length < 3) base = (base + 'user').slice(0, 18);
  let uname = base;
  let n = 1;
  while (users.some((u) => u.username === uname)) {
    n += 1;
    uname = (base.slice(0, 17) + n).slice(0, 20);
  }
  return uname;
}

// Inicio de sesión con Google. Las cuentas de Google se identifican SIEMPRE por el
// correo (campo googleEmail), nunca por el nombre de usuario, para que nadie pueda
// "robar" una cuenta de contraseña existente que tenga un nombre parecido al correo.
// Si el correo ya entró antes => devuelve esa misma cuenta. Si no => crea una nueva.
export function findOrCreateGoogleUser({ email, name } = {}) {
  const mail = normalizeUsername(email);
  if (!mail || !mail.includes('@')) return { error: 'Google no devolvió un correo válido.' };
  let user = users.find((u) => u.googleEmail === mail);
  if (user) {
    user.lastLogin = Date.now();
    saveUsers();
    return { user };
  }
  const uname = uniqueUsernameFromEmail(mail);
  const isAdmin = uname === ADMIN_USERNAME;
  // Contraseña aleatoria e inservible: estas cuentas solo entran con Google.
  const { salt, hash } = hashPassword(crypto.randomBytes(24).toString('hex'));
  user = {
    id: crypto.randomUUID(),
    username: uname,
    salt,
    hash,
    googleEmail: mail,
    displayName: name || '',
    roomKey: crypto.randomBytes(9).toString('base64url'),
    createdAt: Date.now(),
    lastLogin: Date.now(),
    isAdmin,
    active: true,
    activatedByDefault: true,
    plan: isAdmin ? 'premium' : 'free',
    premiumUntil: 0,
    gamesEnabled: true,
  };
  users.push(user);
  saveUsers();
  return { user };
}

// "Espejo" de una cuenta de Google de la web en la app .exe (login delegado). Como
// las cuentas de Google no tienen contraseña, este espejo no guarda credenciales
// usables: solo sirve para que el .exe tenga la sesión iniciada mientras hay internet.
export function upsertMirrorGoogleUser({ username, googleEmail, plan, isAdmin, active }) {
  const uname = normalizeUsername(username);
  const mail = normalizeUsername(googleEmail);
  let user = users.find((u) => (mail && u.googleEmail === mail) || u.username === uname);
  if (!user) {
    const { salt, hash } = hashPassword(crypto.randomBytes(24).toString('hex'));
    user = {
      id: crypto.randomUUID(),
      username: uname,
      salt,
      hash,
      googleEmail: mail,
      roomKey: crypto.randomBytes(9).toString('base64url'),
      createdAt: Date.now(),
      lastLogin: Date.now(),
      isAdmin: !!isAdmin || uname === ADMIN_USERNAME,
      active: active !== false,
      activatedByDefault: true,
      plan: plan === 'premium' ? 'premium' : 'free',
      premiumUntil: 0,
      gamesEnabled: true,
      mirror: true,
    };
    users.push(user);
  } else {
    if (mail) user.googleEmail = mail;
    user.isAdmin = !!isAdmin || uname === ADMIN_USERNAME;
    user.active = active !== false;
    user.plan = plan === 'premium' ? 'premium' : 'free';
    user.premiumUntil = 0;
    user.lastLogin = Date.now();
    user.mirror = true;
  }
  saveUsers();
  return user;
}

// Verifica credenciales. Devuelve { user } o { error }.
export function verifyLogin(username, password) {
  const uname = normalizeUsername(username);
  const user = users.find((u) => u.username === uname);
  if (!user) return { error: 'Usuario o contraseña incorrectos.' };
  const { hash } = hashPassword(password, user.salt);
  if (!safeEqual(hash, user.hash)) return { error: 'Usuario o contraseña incorrectos.' };
  return { user };
}

export function createSession(userId) {
  const token = crypto.randomBytes(24).toString('base64url');
  sessions.set(token, { userId, createdAt: Date.now() });
  saveSessions();
  return token;
}

function sessionStillValid(s) {
  return s && Date.now() - s.createdAt <= SESSION_TTL;
}

export function findValidSessionTokenForUser(userId) {
  if (!userId) return null;
  for (const [token, s] of sessions.entries()) {
    if (s.userId === userId && sessionStillValid(s)) return token;
  }
  return null;
}

export function ensureSessionForUser(userId) {
  if (!userId || !getUserById(userId)) return null;
  return findValidSessionTokenForUser(userId) || createSession(userId);
}

export function remapSessionUserIds(idMap) {
  if (!idMap || !idMap.size) return 0;
  let changed = 0;
  for (const [, s] of sessions.entries()) {
    const next = idMap.get(s.userId);
    if (next && next !== s.userId) { s.userId = next; changed++; }
  }
  if (changed) saveSessions();
  return changed;
}

export function importSessionsFromRecord(record) {
  let added = 0;
  for (const [token, s] of Object.entries(record || {})) {
    if (!token || !s?.userId || sessions.has(token)) continue;
    if (!sessionStillValid(s)) continue;
    if (!getUserById(s.userId)) continue;
    sessions.set(token, { userId: s.userId, createdAt: s.createdAt || Date.now() });
    added++;
  }
  if (added) saveSessions();
  return added;
}

export function pruneInvalidSessions() {
  let changed = 0;
  for (const [token, s] of sessions.entries()) {
    if (!sessionStillValid(s) || !getUserById(s.userId)) {
      sessions.delete(token);
      changed++;
    }
  }
  if (changed) saveSessions();
  return changed;
}

export function hasAnyValidSession() {
  for (const [, s] of sessions.entries()) {
    if (sessionStillValid(s) && getUserById(s.userId)) return true;
  }
  return false;
}

export function saveDesktopLastLogin(userId) {
  const user = getUserById(userId);
  if (!user) return;
  try {
    fs.writeFileSync(DESKTOP_LAST_SESSION_FILE, JSON.stringify({
      userId: user.id,
      username: user.username,
      at: Date.now(),
    }, null, 2));
  } catch {}
}

export function clearDesktopLastLogin() {
  try { fs.unlinkSync(DESKTOP_LAST_SESSION_FILE); } catch {}
}

/** Usuario del último login en el .exe (para webhook / Stream Deck). */
export function getDesktopLastLoginUser() {
  let data = null;
  try { data = JSON.parse(fs.readFileSync(DESKTOP_LAST_SESSION_FILE, 'utf8')); } catch {}
  let user = data?.userId ? getUserById(data.userId) : null;
  if (!user && data?.username) user = getUserByUsername(data.username);
  if (user && isUserActive(user)) return user;
  const recent = users
    .filter((u) => u && isUserActive(u) && (u.lastLogin > 0))
    .sort((a, b) => (b.lastLogin || 0) - (a.lastLogin || 0));
  return recent[0] || null;
}

export function inferDesktopLastLoginFromUsers() {
  try {
    if (fs.existsSync(DESKTOP_LAST_SESSION_FILE)) return;
  } catch {}
  const recent = users
    .filter((u) => u.lastLogin > 0)
    .sort((a, b) => (b.lastLogin || 0) - (a.lastLogin || 0));
  if (recent[0]) saveDesktopLastLogin(recent[0].id);
}

export function bootstrapDesktopSessionToken() {
  let data = null;
  try { data = JSON.parse(fs.readFileSync(DESKTOP_LAST_SESSION_FILE, 'utf8')); } catch {}
  let user = data?.userId ? getUserById(data.userId) : null;
  if (!user && data?.username) user = getUserByUsername(data.username);
  if (!user) {
    const recent = users
      .filter((u) => u && (u.lastLogin > 0))
      .sort((a, b) => (b.lastLogin || 0) - (a.lastLogin || 0));
    user = recent[0] || null;
  }
  if (!user) return null;
  return ensureSessionForUser(user.id);
}
export function destroySession(token) {
  if (token && sessions.has(token)) {
    sessions.delete(token);
    saveSessions();
  }
}
export function getSessionUser(token) {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() - s.createdAt > SESSION_TTL) {
    sessions.delete(token);
    saveSessions();
    return null;
  }
  return getUserById(s.userId);
}

export function parseCookies(cookieHeader) {
  const out = {};
  for (const part of String(cookieHeader || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

// Devuelve el usuario a partir de la cookie de sesión de una petición HTTP / upgrade WS.
export function userFromRequest(req) {
  const cookies = parseCookies(req.headers?.cookie);
  return getSessionUser(cookies[SESSION_COOKIE]);
}

export function sessionCookie(token) {
  const maxAge = Math.floor(SESSION_TTL / 1000);
  return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}
export function clearCookie() {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

/** Info del disco de cuentas (diagnóstico admin / arranque en Render). */
export function getAuthDataInfo() {
  return {
    dataDir: DATA_DIR,
    usersFile: USERS_FILE,
    userCount: users.length,
  };
}

/** Mejor copia users.json* en DATA_DIR (más cuentas que la actual). */
export function findBestUsersBackup() {
  const current = users.length;
  let best = { name: null, userCount: 0, usernames: [], canRestore: false };
  try {
    for (const name of fs.readdirSync(DATA_DIR)) {
      if (name === 'users.json' || !name.startsWith('users.json')) continue;
      const full = path.join(DATA_DIR, name);
      let parsed;
      try { parsed = JSON.parse(fs.readFileSync(full, 'utf8')); } catch { continue; }
      if (!Array.isArray(parsed)) continue;
      if (parsed.length > best.userCount) {
        best = {
          name,
          userCount: parsed.length,
          usernames: parsed.map((u) => u.username).filter(Boolean).slice(0, 30),
          canRestore: parsed.length > current,
        };
      }
    }
  } catch {}
  if (best.name) best.canRestore = best.userCount > current;
  return best;
}

/** Restaura users.json desde una copia en DATA_DIR (p. ej. users.json.bak). */
export function restoreUsersFromBackup(backupName) {
  const name = String(backupName || '').trim();
  if (!name || name === 'users.json' || name.includes('/') || name.includes('\\') || name.includes('..')) {
    return { error: 'nombre de copia inválido' };
  }
  if (!name.startsWith('users.json')) return { error: 'nombre de copia inválido' };
  const full = path.join(DATA_DIR, name);
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(full, 'utf8')); } catch {
    return { error: 'no se pudo leer la copia' };
  }
  if (!Array.isArray(parsed) || !parsed.length) return { error: 'copia vacía o inválida' };
  try {
    if (fs.existsSync(USERS_FILE)) {
      fs.copyFileSync(USERS_FILE, path.join(DATA_DIR, `users.json.bak-before-restore-${Date.now()}`));
    }
  } catch {}
  users = parsed;
  for (const u of users) {
    if (u.username === ADMIN_USERNAME) {
      u.isAdmin = true;
      u.active = true;
    }
    if (u.active === undefined) u.active = true;
    if (u.plan === undefined) u.plan = u.isAdmin ? 'premium' : 'free';
    if (u.premiumUntil === undefined) u.premiumUntil = 0;
    if (u.gamesEnabled === undefined) u.gamesEnabled = true;
  }
  try {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
  } catch (e) {
    return { error: 'no se pudo guardar users.json: ' + (e.message || e) };
  }
  return { ok: true, userCount: users.length, usernames: users.map((u) => u.username) };
}

export function restoreUsersFromBestBackup() {
  const best = findBestUsersBackup();
  if (!best.canRestore || !best.name) {
    return { error: 'No hay una copia con más cuentas que la actual.' };
  }
  return restoreUsersFromBackup(best.name);
}

export { SESSION_COOKIE };
