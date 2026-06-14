// Inicio de sesión con Google (OAuth 2.0, "Authorization Code").
// Igual estilo que spotify.js: sin librerías extra, todo con fetch.
//
// El flujo vive SIEMPRE en el servidor "fuente de la verdad" (Render). La app .exe
// no usa este módulo directamente: delega el login a Render (ver server.js).
//
// Queda INACTIVO si no hay GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET configurados,
// así no afecta al login normal de usuario/contraseña.
import crypto from 'node:crypto';

// Credenciales de Google (se pueden sobrescribir por variables de entorno).
export const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID
  || '197493231955-e6tqhfe1llknkmhoguc1vjadlsum01s2.apps.googleusercontent.com';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET
  || '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';
// Si se define, debe coincidir EXACTAMENTE con el "URI de redirección autorizado"
// configurado en Google Cloud Console. Si se deja vacío, se deriva de la petición
// entrante (útil si weblive corre en otro dominio: añade ese dominio en Google Cloud).
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || '';

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

export function isConfigured() {
  return !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);
}

function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// state -> { createdAt, desktopCb, redirectUri }
const pending = new Map();
// codeDesktop -> { createdAt, payload }  (un solo uso, para el login del .exe)
const desktopCodes = new Map();

function cleanup() {
  const now = Date.now();
  for (const [k, v] of pending) if (now - v.createdAt > 600000) pending.delete(k);       // 10 min
  for (const [k, v] of desktopCodes) if (now - v.createdAt > 120000) desktopCodes.delete(k); // 2 min
}

// Calcula el redirect_uri a registrar/usar. Prioriza la variable de entorno.
export function redirectUriFor(req) {
  if (GOOGLE_REDIRECT_URI) return GOOGLE_REDIRECT_URI;
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}/api/auth/google/callback`;
}

// Construye la URL de consentimiento de Google y registra el state pendiente.
export function buildAuthUrl(redirectUri, desktopCb) {
  const state = b64url(crypto.randomBytes(16));
  pending.set(state, { createdAt: Date.now(), desktopCb: desktopCb || '', redirectUri });
  cleanup();
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    access_type: 'online',
    prompt: 'select_account',
  });
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

// Recupera (y consume) el state. Devuelve { desktopCb, redirectUri } o null.
export function consumeState(state) {
  const p = pending.get(state);
  if (!p) return null;
  pending.delete(state);
  if (Date.now() - p.createdAt > 600000) return null;
  return p;
}

// Decodifica el cuerpo de un id_token de Google SIN verificar la firma. Es seguro
// porque el token lo recibimos directamente de Google por TLS en el intercambio.
function decodeIdToken(idToken) {
  try {
    const part = String(idToken || '').split('.')[1];
    if (!part) return null;
    const json = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return JSON.parse(json);
  } catch { return null; }
}

// Intercambia el "code" por el token y devuelve { email, name } del usuario.
export async function exchangeCode(code, redirectUri) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
  });
  const r = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.id_token) {
    throw new Error('No se pudo obtener el token de Google: ' + (data.error_description || data.error || r.status));
  }
  const claims = decodeIdToken(data.id_token) || {};
  const email = String(claims.email || '').trim().toLowerCase();
  if (!email) throw new Error('Google no devolvió un correo.');
  if (claims.email_verified === false) throw new Error('El correo de Google no está verificado.');
  return { email, name: claims.name || '', sub: claims.sub || '' };
}

// ---- Códigos de un solo uso para el login del .exe (delegado) ----
export function makeDesktopCode(payload) {
  const code = b64url(crypto.randomBytes(24));
  desktopCodes.set(code, { createdAt: Date.now(), payload });
  cleanup();
  return code;
}
export function consumeDesktopCode(code) {
  const c = desktopCodes.get(code);
  if (!c) return null;
  desktopCodes.delete(code);
  if (Date.now() - c.createdAt > 120000) return null;
  return c.payload;
}
