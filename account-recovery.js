// Recuperación de contraseña y vinculación de email (códigos de 6 dígitos).
// No modifica cuentas existentes hasta verificar un código correctamente.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getUserById,
  getUserByUsername,
  getUserByVerifiedEmail,
  isEmailTaken,
  normalizeEmail,
  setUserVerifiedEmail,
  setUserPassword,
  destroySessionsForUser,
} from './auth.js';
import { isMailConfigured, sendMail } from './mail.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const CODES_FILE = path.join(DATA_DIR, 'email-codes.json');
const CODE_TTL_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_MAX = 5;

fs.mkdirSync(DATA_DIR, { recursive: true });

let codes = loadCodes();
const rateBuckets = new Map(); // key -> { count, resetAt }

function loadCodes() {
  try {
    const raw = JSON.parse(fs.readFileSync(CODES_FILE, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}
function saveCodes() {
  fs.writeFile(CODES_FILE, JSON.stringify(codes, null, 2), () => {});
}

function hashCode(code, salt) {
  return crypto.scryptSync(String(code), salt, 32).toString('hex');
}

function genCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

function rateOk(key) {
  const now = Date.now();
  let b = rateBuckets.get(key);
  if (!b || now > b.resetAt) {
    b = { count: 0, resetAt: now + RATE_WINDOW_MS };
    rateBuckets.set(key, b);
  }
  if (b.count >= RATE_MAX) return false;
  b.count += 1;
  return true;
}

function putCode(kind, userId, email) {
  const code = genCode();
  const salt = crypto.randomBytes(8).toString('hex');
  const key = `${kind}:${userId}`;
  codes[key] = {
    email: normalizeEmail(email),
    salt,
    hash: hashCode(code, salt),
    expires: Date.now() + CODE_TTL_MS,
    attempts: 0,
  };
  saveCodes();
  return code;
}

function consumeCode(kind, userId, code) {
  const key = `${kind}:${userId}`;
  const entry = codes[key];
  if (!entry) return { error: 'Código inválido o caducado. Pide uno nuevo.' };
  if (Date.now() > entry.expires) {
    delete codes[key];
    saveCodes();
    return { error: 'El código caducó. Pide uno nuevo.' };
  }
  entry.attempts = (entry.attempts || 0) + 1;
  if (entry.attempts > MAX_ATTEMPTS) {
    delete codes[key];
    saveCodes();
    return { error: 'Demasiados intentos. Pide un código nuevo.' };
  }
  const ok = hashCode(code, entry.salt) === entry.hash;
  if (!ok) {
    saveCodes();
    return { error: 'Código incorrecto.' };
  }
  const email = entry.email;
  delete codes[key];
  saveCodes();
  return { ok: true, email };
}

function mailBody(code, purpose) {
  const title = purpose === 'reset'
    ? 'Restablecer contraseña — Livecoins'
    : 'Verificar email — Livecoins';
  const line = purpose === 'reset'
    ? 'Usa este código para restablecer tu contraseña:'
    : 'Usa este código para verificar tu correo en Livecoins:';
  const text = [
    line,
    '',
    `  ${code}`,
    '',
    'Caduca en 15 minutos.',
    'Si no pediste esto, ignora este mensaje.',
  ].join('\n');
  return { subject: title, text };
}

export function mailStatus() {
  return { configured: isMailConfigured() };
}

/** Registro: enviar código antes de crear la cuenta (aún no hay userId). */
export async function requestRegisterEmailCode(rawEmail, rateKey) {
  if (!isMailConfigured()) {
    return { error: 'El envío de correo no está configurado en el servidor.' };
  }
  const email = normalizeEmail(rawEmail);
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { error: 'Escribe un correo válido.' };
  }
  if (isEmailTaken(email)) {
    return { error: 'Ese correo ya está vinculado a otra cuenta.' };
  }
  if (!rateOk(`reg:${rateKey || email}`)) {
    return { error: 'Demasiadas solicitudes. Espera unos minutos.' };
  }
  const code = putCode('reg', email, email);
  const { subject, text } = mailBody(code, 'link');
  const sent = await sendMail({ to: email, subject, text });
  if (!sent.ok) {
    delete codes[`reg:${email}`];
    saveCodes();
    return { error: sent.error || 'No se pudo enviar el correo.' };
  }
  return { ok: true, message: 'Te enviamos un código a tu correo. Caduca en 15 minutos.' };
}

/** Consume el código de registro. Si OK, el email queda listo para guardar verificado. */
export function consumeRegisterEmailCode(rawEmail, code) {
  const email = normalizeEmail(rawEmail);
  if (!email) return { error: 'Escribe un correo válido.' };
  return consumeCode('reg', email, String(code || '').trim());
}

/** Cuenta logueada: enviar código para vincular/cambiar email. */
export async function requestLinkEmailCode(userId, rawEmail, rateKey) {
  if (!isMailConfigured()) {
    return { error: 'El envío de correo no está configurado en el servidor.' };
  }
  const user = getUserById(userId);
  if (!user) return { error: 'Sesión inválida.' };
  const email = normalizeEmail(rawEmail);
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { error: 'Escribe un correo válido.' };
  }
  if (isEmailTaken(email, user.id)) {
    return { error: 'Ese correo ya está vinculado a otra cuenta.' };
  }
  if (!rateOk(`link:${rateKey || userId}`)) {
    return { error: 'Demasiadas solicitudes. Espera unos minutos.' };
  }
  const code = putCode('link', user.id, email);
  const { subject, text } = mailBody(code, 'link');
  const sent = await sendMail({ to: email, subject, text });
  if (!sent.ok) {
    delete codes[`link:${user.id}`];
    saveCodes();
    return { error: sent.error || 'No se pudo enviar el correo.' };
  }
  return { ok: true, message: 'Te enviamos un código a tu correo. Caduca en 15 minutos.' };
}

export function verifyLinkEmailCode(userId, code) {
  const user = getUserById(userId);
  if (!user) return { error: 'Sesión inválida.' };
  const r = consumeCode('link', user.id, String(code || '').trim());
  if (r.error) return r;
  if (isEmailTaken(r.email, user.id)) {
    return { error: 'Ese correo ya está vinculado a otra cuenta.' };
  }
  if (!setUserVerifiedEmail(user.id, r.email)) {
    return { error: 'No se pudo guardar el correo.' };
  }
  return { ok: true, email: r.email, message: 'Correo verificado y vinculado a tu cuenta.' };
}

/**
 * Olvidé mi contraseña. No revela si el usuario existe.
 * Solo envía si la cuenta tiene email verificado.
 */
export async function requestPasswordReset(identifier, rateKey) {
  const generic = {
    ok: true,
    message: 'Si la cuenta existe y tiene un correo verificado, enviamos un código.',
  };
  if (!isMailConfigured()) {
    return { error: 'El envío de correo no está configurado en el servidor.' };
  }
  if (!rateOk(`reset:${rateKey || String(identifier || '').toLowerCase()}`)) {
    return { error: 'Demasiadas solicitudes. Espera unos minutos.' };
  }
  const raw = String(identifier || '').trim();
  if (!raw) return generic;
  let user = null;
  if (raw.includes('@')) user = getUserByVerifiedEmail(raw);
  else user = getUserByUsername(raw);
  if (!user || !user.email || !user.emailVerified) return generic;
  const code = putCode('reset', user.id, user.email);
  const { subject, text } = mailBody(code, 'reset');
  const sent = await sendMail({ to: user.email, subject, text });
  if (!sent.ok) {
    delete codes[`reset:${user.id}`];
    saveCodes();
    if (!isMailConfigured()) return { error: sent.error };
    return generic;
  }
  return generic;
}

export function resetPasswordWithCode(identifier, code, newPassword) {
  const raw = String(identifier || '').trim();
  if (!raw) return { error: 'Indica tu usuario o correo.' };
  if (String(newPassword || '').length < 4) {
    return { error: 'La contraseña debe tener al menos 4 caracteres.' };
  }
  let user = null;
  if (raw.includes('@')) user = getUserByVerifiedEmail(raw);
  else user = getUserByUsername(raw);
  if (!user) return { error: 'Código inválido o cuenta no encontrada.' };
  const r = consumeCode('reset', user.id, String(code || '').trim());
  if (r.error) return r;
  if (!setUserPassword(user.id, newPassword)) {
    return { error: 'No se pudo actualizar la contraseña.' };
  }
  destroySessionsForUser(user.id);
  return { ok: true, message: 'Contraseña actualizada. Ya puedes iniciar sesión.' };
}
