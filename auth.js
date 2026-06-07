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
    if (u.active === undefined) { u.active = false; changed = true; }
    if (u.lastLogin === undefined) { u.lastLogin = 0; changed = true; }
    if (u.plan === undefined) { u.plan = u.isAdmin ? 'premium' : 'free'; changed = true; }
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
// Plan efectivo del usuario ('premium' para el admin).
export function getUserPlan(user) {
  if (!user) return 'free';
  if (user.isAdmin) return 'premium';
  return user.plan === 'premium' ? 'premium' : 'free';
}
export function setUserPlan(id, plan) {
  const u = users.find((x) => x.id === id);
  if (!u) return false;
  u.plan = plan === 'premium' ? 'premium' : 'free';
  saveUsers();
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
    active: isAdmin, // el admin queda activo; el resto espera activación
    plan: isAdmin ? 'premium' : 'free', // las cuentas nuevas empiezan en gratis
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
