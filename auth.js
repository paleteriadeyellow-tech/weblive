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
  fs.writeFile(USERS_FILE, JSON.stringify(users, null, 2), () => {});
}
function saveSessions() {
  fs.writeFile(SESSIONS_FILE, JSON.stringify(Object.fromEntries(sessions)), () => {});
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

// Crea un usuario. Devuelve { user } o { error }.
export function registerUser(username, password) {
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
  };
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
  };
  users.push(user);
  saveUsers();
  return { user };
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

export { SESSION_COOKIE };
