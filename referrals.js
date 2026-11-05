// Invita y gana: cada cuenta tiene un código; el amigo que entra con él tiene descuento en
// su primer pago y quien lo invitó gana Coins, que se canjean por días de PRO o VIP.
// Vive en la nube (Render), igual que los pagos. El .exe reenvía todo con la cookie de la nube.
//
// Anti-abuso:
// - Los Coins solo salen de un pago REAL del amigo (una vez por amigo, una vez por orden).
// - Esos Coins quedan «en espera» HOLD_DAYS días antes de poder canjearse (reembolsos / contracargos).
// - No se puede usar el propio código (misma cuenta, mismo correo aunque sea alias, o el que pagó
//   es el mismo correo de quien invita).
// - El código solo se acepta si esa cuenta (y ese correo) nunca ha pagado, también antes de este sistema.
// - El canje cobra primero los Coins y luego da los días (si falla, los devuelve).
// - Una sola cuenta con código por red (IP), y nunca desde la misma red de quien invita.
//   Las redes con muchas cuentas (datos móviles, servidores puente) no se usan para bloquear.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'referrals.json');
const PAY_LEDGERS = [
  { file: path.join(DATA_DIR, 'mercadopago-payments.json'), key: 'orders' },
  { file: path.join(DATA_DIR, 'paypal-payments.json'), key: 'captures' },
];

const num = (v, def) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : def;
};
// Lo que gana quien invita cuando su amigo paga por primera vez (por plan comprado).
export const REWARDS = {
  pro: num(process.env.REF_COINS_PRO, 200),
  premium: num(process.env.REF_COINS_VIP, 300),
  founder: num(process.env.REF_COINS_FOUNDER, 300),
};
// % de descuento del amigo en su primer pago mensual de PRO o VIP.
export const DISCOUNT_PCT = Math.min(90, num(process.env.REF_DISCOUNT_PCT, 10));
// Coins por 1 día de cada plan.
export const DAY_COST = {
  pro: num(process.env.REF_DAY_PRO, 100) || 100,
  premium: num(process.env.REF_DAY_VIP, 200) || 200,
};
// Días que los Coins de un amigo quedan en espera antes de poder canjearse.
export const HOLD_DAYS = num(process.env.REF_HOLD_DAYS, 14);
const DAY_MS = 24 * 3600 * 1000;
// Una red con más cuentas que esto se trata como compartida (datos móviles / CGNAT) y no bloquea.
const SHARED_IP_USERS = num(process.env.REF_SHARED_IP_USERS, 8) || 8;
// IPs de servidores puente (VPS) que reenvían la IP real del usuario en X-LC-Client-IP.
const RELAY_IPS = new Set(String(process.env.REF_RELAY_IPS || '').split(',').map((x) => x.trim()).filter(Boolean));
const IP_SALT = String(process.env.REF_IP_SALT || 'lc-ref');
const MAX_REDEEM_DAYS = 60;
const COOKIE = 'lc_ref';
const CODE_ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sin 0/O ni 1/I
const CODE_RE = /^[A-Z0-9]{4,16}$/;
const BAD_WORDS = ['PUTA', 'PUTO', 'VERGA', 'PENDEJ', 'MIERDA', 'CULO', 'NAZI', 'ADMIN', 'LIVECOINS', 'SOPORTE', 'STAFF', 'OFICIAL'];

let db = null;
// Puesto por mountReferralRoutes (para revisar correos al dar Coins).
let lookupUser = null;

function load() {
  if (db) return db;
  let raw = null;
  try { raw = fs.readFileSync(FILE, 'utf8'); } catch {}
  if (raw != null) {
    try {
      const j = JSON.parse(raw);
      if (j && typeof j === 'object' && j.users && j.codes) db = j;
    } catch {}
    // Archivo dañado: se aparta (nunca se pisa con uno vacío) y se avisa en el log.
    if (!db) {
      const aside = `${FILE}.danado-${Date.now()}`;
      try { fs.copyFileSync(FILE, aside); } catch {}
      console.error('[referrals] referrals.json no se pudo leer; copia en', aside);
    }
  }
  if (!db) db = { users: {}, codes: {}, orders: {}, paidEmails: {}, ips: {} };
  if (!db.orders) db.orders = {};
  if (!db.paidEmails) db.paidEmails = {};
  if (!db.ips) db.ips = {};
  return db;
}
function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(tmp, FILE);
}

/** Correo comparable: minúsculas, sin «+etiqueta» y, en Gmail, sin puntos. */
function normEmail(raw) {
  const s = String(raw || '').trim().toLowerCase();
  const at = s.lastIndexOf('@');
  if (at <= 0) return '';
  let user = s.slice(0, at).split('+')[0];
  let domain = s.slice(at + 1);
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') user = user.replace(/\./g, '');
  return user ? `${user}@${domain}` : '';
}
const emailKey = (raw) => {
  const e = normEmail(raw);
  return e ? crypto.createHash('sha256').update(e).digest('hex').slice(0, 32) : '';
};

function randomCode() {
  const bytes = crypto.randomBytes(8);
  let s = '';
  for (const b of bytes) s += CODE_ABC[b % CODE_ABC.length];
  return s;
}
export function normalizeCode(raw) {
  return String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16);
}
function entry(userId) {
  const d = load();
  const id = String(userId);
  let e = d.users[id];
  if (!e) {
    let code = randomCode();
    while (d.codes[code]) code = randomCode();
    e = { code, coins: 0, pending: [], referredBy: '', referredAt: 0, firstPaidAt: 0, rewarded: false, log: [] };
    d.users[id] = e;
    d.codes[code] = id;
    save();
  }
  if (!Array.isArray(e.pending)) e.pending = [];
  return e;
}
function addLog(e, delta, reason) {
  e.log = [{ at: Date.now(), delta: Math.round(delta), reason: String(reason || '').slice(0, 120) }, ...(e.log || [])].slice(0, 50);
}
function addCoins(userId, delta, reason) {
  const e = entry(userId);
  const before = Number(e.coins) || 0;
  e.coins = Math.max(0, Math.round(before + delta));
  addLog(e, e.coins - before, reason);
  save();
  return e.coins;
}
/** Pasa a disponibles los Coins en espera que ya cumplieron HOLD_DAYS. */
function release(e) {
  const now = Date.now();
  const ready = e.pending.filter((p) => p.until <= now);
  if (!ready.length) return;
  e.pending = e.pending.filter((p) => p.until > now);
  for (const p of ready) {
    e.coins = Math.round((Number(e.coins) || 0) + (Number(p.coins) || 0));
    addLog(e, p.coins, `liberado:${p.from || ''}`);
  }
  save();
}

/** ¿Esta cuenta o este correo ya pagaron alguna vez? (también pagos de antes de Invita y gana). */
function hasPaidBefore(userId, email) {
  const d = load();
  const e = d.users[String(userId)];
  if (e && e.firstPaidAt) return true;
  const k = emailKey(email);
  if (k && d.paidEmails[k]) return true;
  for (const { file, key } of PAY_LEDGERS) {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      const rows = j && j[key] ? Object.values(j[key]) : [];
      if (rows.some((r) => r && String(r.userId) === String(userId))) return true;
    } catch {}
  }
  return false;
}

const cleanIp = (v) => String(v || '').trim().replace(/^::ffff:/i, '');
const isPrivateIp = (ip) => !ip || /^(10\.|127\.|0\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|::1$|f[cd][0-9a-f]{2}:|fe80:)/i.test(ip);
/** IP pública del usuario (detrás de Cloudflare / proxy de Render). Vacía si no se sabe. */
export function clientIp(req) {
  const h = (req && req.headers) || {};
  let ip = '';
  // Solo CF-Connecting-IP: Cloudflare (delante de Render) lo pisa siempre con la IP real.
  // True-Client-IP no se usa porque un cliente lo puede inventar para saltarse el bloqueo por red.
  const cf = cleanIp(h['cf-connecting-ip']);
  if (!isPrivateIp(cf)) ip = cf;
  if (!ip) {
    const xff = String(h['x-forwarded-for'] || '').split(',').map(cleanIp).filter(Boolean);
    for (let i = xff.length - 1; i >= 0; i--) if (!isPrivateIp(xff[i])) { ip = xff[i]; break; }
  }
  if (!ip) {
    const v = cleanIp(req && req.socket && req.socket.remoteAddress);
    if (!isPrivateIp(v)) ip = v;
  }
  // Servidor puente conocido: usa la IP real que reenvía.
  if (ip && RELAY_IPS.has(ip)) {
    const fwd = cleanIp(h['x-lc-client-ip']);
    return isPrivateIp(fwd) ? '' : fwd;
  }
  return ip;
}
const ipKey = (ip) => (ip ? crypto.createHash('sha256').update(`${IP_SALT}|${ip}`).digest('hex').slice(0, 24) : '');

/** Anota desde qué red entra la cuenta (solo un resumen cifrado de la IP, no la IP). */
export function noteIp(userId, req) {
  const k = ipKey(clientIp(req));
  if (!userId || !k) return;
  const d = load();
  const id = String(userId);
  const row = d.ips[k] || (d.ips[k] = { users: {} });
  const isNew = !row.users[id];
  row.users[id] = Date.now();
  const ids = Object.keys(row.users);
  if (ids.length > 50) delete row.users[ids.sort((a, b) => row.users[a] - row.users[b])[0]];
  const e = entry(id);
  const list = Array.isArray(e.ips) ? e.ips : [];
  const had = list.includes(k);
  if (!had) e.ips = [k, ...list].slice(0, 20);
  if (isNew || !had) save();
}
const sharedNet = (k) => Object.keys((load().ips[k] || { users: {} }).users).length > SHARED_IP_USERS;

/** ¿Esta cuenta comparte red con quien la invitó, o con otra cuenta que ya usó un código antes? */
function netConflict(userId, ownerId) {
  const d = load();
  const e = d.users[String(userId)];
  if (!e) return '';
  const owner = String(ownerId || e.referredBy || '');
  for (const k of e.ips || []) {
    if (sharedNet(k)) continue;
    for (const other of Object.keys((d.ips[k] || { users: {} }).users)) {
      if (other === String(userId)) continue;
      if (other === owner) return 'owner';
      const o = d.users[other];
      if (o && o.referredBy && (!e.referredAt || (o.referredAt || 0) < e.referredAt)) return 'used';
    }
  }
  return '';
}

/** % que se le aplica a un pago NUEVO: solo si lo invitaron, nunca ha pagado y no comparte red. */
export function discountFor(userId) {
  const e = userId && load().users[String(userId)];
  return e && e.referredBy && !e.firstPaidAt && !netConflict(userId) ? DISCOUNT_PCT : 0;
}
/** % que se acepta al confirmar un pago (una orden con descuento puede llegar tarde). Si ya no
    le tocaba, el proveedor le da los días en proporción a lo que pagó (ver daysForPaid). */
export function acceptedDiscountFor(userId) {
  const e = userId && load().users[String(userId)];
  return e && e.referredBy ? DISCOUNT_PCT : 0;
}

/** ¿Es su primer pago con código de invitación? (para dar los 30 días completos aunque luego
    haya entrado desde otra red: la orden con descuento se creó cuando sí le tocaba). */
export function isFirstReferredPayment(userId) {
  const e = userId && load().users[String(userId)];
  return !!(e && e.referredBy && !e.firstPaidAt);
}

/** Une una cuenta con quien la invitó. Solo una vez y solo si esa cuenta/correo nunca ha pagado. */
export function attachReferrer(userId, rawCode, { getUserById } = {}, req = null) {
  const code = normalizeCode(rawCode);
  if (!userId || !code) return { ok: false, error: 'Escribe un código.' };
  const d = load();
  const ownerId = d.codes[code];
  if (!ownerId) return { ok: false, error: 'Ese código no existe.' };
  if (String(ownerId) === String(userId)) return { ok: false, error: 'No puedes usar tu propio código.' };
  const getUser = getUserById || lookupUser;
  const me = getUser ? getUser(userId) : null;
  const owner = getUser ? getUser(ownerId) : null;
  if (getUser && !owner) return { ok: false, error: 'Ese código no existe.' };
  const e = entry(userId);
  if (e.referredBy) return { ok: false, error: 'Tu cuenta ya tiene un código de invitación.' };
  if (hasPaidBefore(userId, me && me.email)) return { ok: false, error: 'El código solo se puede poner antes de tu primer pago.' };
  // Un amigo no puede invitar a quien lo invitó a él (evita cadenas de ida y vuelta).
  if (String(entry(ownerId).referredBy) === String(userId)) return { ok: false, error: 'Ese código no se puede usar en tu cuenta.' };
  const myMail = normEmail(me && me.email);
  if (myMail && myMail === normEmail(owner && owner.email)) return { ok: false, error: 'No puedes usar tu propio código.' };
  if (req) noteIp(userId, req);
  const net = netConflict(userId, ownerId);
  if (net === 'owner') return { ok: false, error: 'No puedes usar el código de alguien que se conecta desde tu misma red.' };
  if (net === 'used') return { ok: false, error: 'Desde tu red ya se usó un código de invitación (solo una cuenta por red).' };
  e.referredBy = String(ownerId);
  e.referredAt = Date.now();
  save();
  return { ok: true, discountPct: DISCOUNT_PCT };
}

/** Pago confirmado (onGranted de PayPal / Mercado Pago). Da los Coins al que invitó una sola vez. */
export function recordPaid(userId, meta = {}) {
  if (!userId) return;
  const d = load();
  const ref = String(meta.ref || '');
  if (ref && d.orders[ref]) return;
  const e = entry(userId);
  if (ref) d.orders[ref] = { userId: String(userId), at: Date.now() };
  const me = lookupUser ? lookupUser(userId) : null;
  for (const k of [emailKey(me && me.email), emailKey(meta.payerEmail)]) if (k) d.paidEmails[k] = 1;
  const first = !e.firstPaidAt;
  if (first) e.firstPaidAt = Date.now();
  save();
  if (!first || !e.referredBy || e.rewarded) return;
  e.rewarded = true;
  const owner = lookupUser ? lookupUser(e.referredBy) : null;
  // Pagó con la cuenta de PayPal/MP del mismo correo de quien invita: es la misma persona.
  const ownerMail = normEmail(owner && owner.email);
  const sameMail = ownerMail && (ownerMail === normEmail(meta.payerEmail) || ownerMail === normEmail(me && me.email));
  const net = sameMail ? '' : netConflict(userId);
  if (sameMail || net) {
    e.rewardCoins = 0;
    e.rewardBlocked = sameMail ? 'mismo correo' : (net === 'owner' ? 'misma red' : 'red ya usada');
    save();
    return;
  }
  const plan = String(meta.plan || 'premium');
  const coins = REWARDS[plan] ?? REWARDS.premium;
  e.rewardCoins = coins;
  save();
  if (coins <= 0) return;
  const o = entry(e.referredBy);
  o.pending.push({ coins, from: String(userId), ref, at: Date.now(), until: Date.now() + HOLD_DAYS * DAY_MS });
  addLog(o, 0, `en-espera:${coins}:${userId}:${plan}`);
  save();
}

/** Qué plan puede canjear: el que ya tiene (no se le baja ni se le pisan días), o PRO/VIP si es Gratis. */
function redeemOptions(user, getUserPlan) {
  if (!user || user.isAdmin) return [];
  const plan = getUserPlan ? getUserPlan(user) : String(user.plan || 'free');
  const until = Number(user.premiumUntil) || 0;
  if (plan === 'free') return ['pro', 'premium'];
  if (!until) return []; // plan fijo: no tiene días que sumar
  if (plan === 'pro') return ['pro'];
  return ['premium']; // VIP o Founder por días: se suman como VIP
}

function summary(user, deps) {
  const e = entry(user.id);
  release(e);
  const d = load();
  const friends = Object.entries(d.users)
    .filter(([, x]) => String(x.referredBy) === String(user.id))
    .map(([id, x]) => {
      const u = deps.getUserById ? deps.getUserById(id) : null;
      const wait = e.pending.find((p) => String(p.from) === id);
      return {
        username: (u && u.username) || 'cuenta borrada',
        at: x.referredAt || 0,
        status: x.rewardBlocked ? 'blocked' : x.rewarded ? (wait ? 'pending' : 'paid') : 'joined',
        coins: x.rewarded ? (Number(x.rewardCoins) || 0) : 0,
        until: wait ? wait.until : 0,
      };
    })
    .sort((a, b) => b.at - a.at);
  const refUser = e.referredBy && deps.getUserById ? deps.getUserById(e.referredBy) : null;
  return {
    ok: true,
    code: e.code,
    coins: Number(e.coins) || 0,
    pendingCoins: e.pending.reduce((n, p) => n + (Number(p.coins) || 0), 0),
    nextRelease: e.pending.reduce((m, p) => (!m || p.until < m ? p.until : m), 0),
    holdDays: HOLD_DAYS,
    link: `${publicBase()}/i/${e.code}`,
    rewards: REWARDS,
    dayCost: DAY_COST,
    discountPct: DISCOUNT_PCT,
    referredBy: e.referredBy ? ((refUser && refUser.username) || 'una cuenta') : '',
    myDiscountPct: discountFor(user.id),
    discountBlocked: !!(e.referredBy && !e.firstPaidAt && netConflict(user.id)),
    canEnterCode: !e.referredBy && !hasPaidBefore(user.id, user.email),
    redeem: redeemOptions(user, deps.getUserPlan),
    friends,
  };
}

function publicBase() {
  // El enlace /i/ vive en este servidor (Render): no usar PAYPAL_PUBLIC_BASE, que puede ser otro dominio.
  return String(process.env.REF_PUBLIC_BASE || process.env.RENDER_EXTERNAL_URL || 'https://livecoins.onrender.com')
    .replace(/\/+$/, '');
}

const escHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/** Enlace de descarga del .exe que el admin pone en «App (.exe)» (webinstall.json). */
function downloadUrl() {
  try {
    const u = String(JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'webinstall.json'), 'utf8')).url || '');
    if (/^https:\/\//i.test(u)) return u;
  } catch {}
  return '';
}
/** Página del enlace /i/CÓDIGO. */
function invitePage(code) {
  const ownerId = code ? load().codes[code] : '';
  const owner = ownerId && lookupUser ? lookupUser(ownerId) : null;
  const valid = !!ownerId && (!lookupUser || !!owner);
  const dl = downloadUrl();
  const who = owner && owner.username ? `<b>@${escHtml(owner.username)}</b> te invitó a` : 'Te invitaron a';
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Invitación a Livecoins</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 20px; box-sizing: border-box; background: radial-gradient(800px 500px at 20% 0%, rgba(155, 92, 255, .18), transparent 60%), #0d0d10; color: #f2f3f5; font-family: Inter, "Segoe UI", system-ui, sans-serif; }
  .box { width: 100%; max-width: 460px; padding: 28px; border: 1px solid #2c2c33; border-radius: 18px; background: #17171b; text-align: center; }
  h1 { margin: 6px 0 4px; font-size: 24px; } p { color: #9a9ca5; line-height: 1.5; }
  .code { margin: 18px 0; padding: 14px; border: 2px dashed rgba(155, 92, 255, .6); border-radius: 12px; font: 800 28px/1 Consolas, monospace; letter-spacing: .18em; cursor: pointer; }
  .gift { display: inline-block; padding: 5px 12px; border-radius: 99px; background: rgba(74, 222, 128, .13); color: #4ade80; font-weight: 800; font-size: 14px; }
  ol { text-align: left; color: #c9cad1; line-height: 1.7; padding-left: 22px; }
  a.btn { display: block; margin-top: 18px; padding: 14px; border-radius: 12px; background: #9b5cff; color: #fff; font-weight: 800; text-decoration: none; }
  .bad { color: #ff7a8a; }
</style></head><body><main class="box">
${valid ? `<p>${who}</p><h1>Livecoins</h1>
  <span class="gift">🎟️ ${DISCOUNT_PCT}% de descuento en tu primer mes</span>
  <div class="code" title="Copiar" onclick="navigator.clipboard&&navigator.clipboard.writeText('${escHtml(code)}');this.textContent='¡Copiado!';setTimeout(()=>this.textContent='${escHtml(code)}',1200)">${escHtml(code)}</div>
  <ol><li>Descarga e instala <b>Livecoins para PC</b>.</li><li>Abre la app y pulsa <b>Crear cuenta</b>.</li><li>En <b>Código de invitación</b> escribe <b>${escHtml(code)}</b>.</li></ol>`
    : `<h1>Livecoins</h1><p class="bad">Este código de invitación no existe.</p><p>Puedes descargar la app igual y pedirle a tu amigo su código.</p>`}
  ${dl ? `<a class="btn" href="${escHtml(dl)}">Descargar Livecoins para PC</a>` : ''}
</main></body></html>`;
}

/** Código guardado por el enlace /i/CÓDIGO (para el registro). */
export function refFromRequest(req) {
  const m = String((req && req.headers && req.headers.cookie) || '').match(/(?:^|;\s*)lc_ref=([A-Za-z0-9]+)/);
  return m ? normalizeCode(m[1]) : '';
}

export function mountReferralRoutes(app, {
  userFromRequest,
  getUserById,
  getUserPlan,
  grantProDays,
  grantPremiumDays,
  requireAdmin,
  AUTH_REMOTE,
  getRemoteCookie,
  afterRemoteChange,
  onPlanChanged,
} = {}) {
  const deps = { getUserById, getUserPlan };
  if (getUserById) lookupUser = getUserById;
  const base = String(AUTH_REMOTE || '').replace(/\/+$/, '');

  // .exe / web con nube: todo se hace en Render con la cookie de esa cuenta.
  async function proxy(req, res, pathname, method = 'GET') {
    const user = userFromRequest(req);
    if (!user) { res.status(401).json({ error: 'Inicia sesión.' }); return; }
    const cookie = getRemoteCookie ? getRemoteCookie(user.id) : '';
    if (!cookie) { res.status(503).json({ error: 'Sin sesión con la nube. Cierra sesión y vuelve a entrar.' }); return; }
    const headers = { Accept: 'application/json', Cookie: cookie };
    const ip = clientIp(req);
    if (ip) headers['X-LC-Client-IP'] = ip;
    if (method !== 'GET') headers['Content-Type'] = 'application/json';
    try {
      const r = await fetch(`${base}${pathname}`, {
        method, headers, body: method === 'GET' ? undefined : JSON.stringify(req.body || {}),
      });
      const data = await r.json().catch(() => ({}));
      if (r.ok && method !== 'GET' && afterRemoteChange) {
        try { await afterRemoteChange(user); } catch {}
      }
      res.status(r.status).json(data);
    } catch {
      res.status(503).json({ error: 'Sin conexión con el servidor. Revisa tu internet.' });
    }
  }
  const me = (req, res) => {
    const user = userFromRequest(req);
    if (!user) { res.status(401).json({ error: 'Inicia sesión.' }); return null; }
    noteIp(user.id, req);
    return user;
  };
  // Freno simple contra adivinar códigos a lo bruto (por cuenta).
  const tries = new Map();
  const tooMany = (id, max, windowMs) => {
    const now = Date.now();
    const list = (tries.get(id) || []).filter((t) => now - t < windowMs);
    list.push(now);
    tries.set(id, list);
    return list.length > max;
  };

  // Enlace para compartir. Livecoins es app de PC: la página explica cómo descargarla y
  // dónde poner el código al crear la cuenta (el registro web está cerrado).
  app.get('/i/:code', (req, res) => {
    const code = normalizeCode(req.params.code);
    if (code) {
      res.setHeader('Set-Cookie', `${COOKIE}=${code}; Path=/; Max-Age=${30 * 24 * 3600}; SameSite=Lax`);
    }
    if (base) return res.redirect(302, `/login.html?ref=${encodeURIComponent(code)}#registro`);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(invitePage(code));
  });

  app.get('/api/referrals/me', async (req, res) => {
    if (base) return proxy(req, res, '/api/referrals/me');
    const user = me(req, res);
    if (user) res.json(summary(user, deps));
  });

  app.post('/api/referrals/apply', express.json(), async (req, res) => {
    if (base) return proxy(req, res, '/api/referrals/apply', 'POST');
    const user = me(req, res);
    if (!user) return;
    if (tooMany(`apply:${user.id}`, 10, 60 * 60 * 1000)) return res.status(429).json({ error: 'Demasiados intentos. Prueba en una hora.' });
    const r = attachReferrer(user.id, req.body && req.body.code, deps, req);
    if (!r.ok) return res.status(400).json(r);
    res.json({ ...summary(user, deps), applied: true });
  });

  app.post('/api/referrals/code', express.json(), async (req, res) => {
    if (base) return proxy(req, res, '/api/referrals/code', 'POST');
    const user = me(req, res);
    if (!user) return;
    const code = normalizeCode(req.body && req.body.code);
    if (!CODE_RE.test(code)) return res.status(400).json({ error: 'Usa de 4 a 16 letras o números.' });
    if (BAD_WORDS.some((w) => code.includes(w))) return res.status(400).json({ error: 'Ese código no está permitido.' });
    const d = load();
    const e = entry(user.id);
    if (code === e.code) return res.json(summary(user, deps));
    if (d.codes[code] && String(d.codes[code]) !== String(user.id)) return res.status(400).json({ error: 'Ese código ya lo usa otra cuenta.' });
    if (e.codeChangedAt && Date.now() - e.codeChangedAt < 7 * DAY_MS) {
      return res.status(400).json({ error: 'Solo puedes cambiar tu código una vez por semana.' });
    }
    // El código viejo sigue llevando a esta cuenta (por si ya lo compartió).
    d.codes[code] = String(user.id);
    e.code = code;
    e.codeChangedAt = Date.now();
    save();
    res.json(summary(user, deps));
  });

  // Un canje a la vez por cuenta (dos clics seguidos no cobran ni dan doble).
  const redeeming = new Set();
  app.post('/api/referrals/redeem', express.json(), async (req, res) => {
    if (base) return proxy(req, res, '/api/referrals/redeem', 'POST');
    const user = me(req, res);
    if (!user) return;
    const plan = String((req.body && req.body.plan) || '') === 'pro' ? 'pro' : 'premium';
    const days = Number(req.body && req.body.days);
    if (!Number.isInteger(days) || days < 1 || days > MAX_REDEEM_DAYS) return res.status(400).json({ error: `Elige de 1 a ${MAX_REDEEM_DAYS} días.` });
    if (!redeemOptions(user, getUserPlan).includes(plan)) {
      return res.status(400).json({ error: plan === 'pro' ? 'Con tu plan actual canjeas días de VIP.' : 'Con tu plan actual no puedes canjear días de VIP.' });
    }
    const grant = plan === 'pro' ? grantProDays : grantPremiumDays;
    if (!grant) return res.status(503).json({ error: 'Canje no disponible.' });
    if (redeeming.has(user.id)) return res.status(429).json({ error: 'Espera, ya se está canjeando.' });
    redeeming.add(user.id);
    try {
      const e = entry(user.id);
      release(e);
      const cost = DAY_COST[plan] * days;
      if ((Number(e.coins) || 0) < cost) return res.status(400).json({ error: `Te faltan ${cost - (Number(e.coins) || 0)} Coins.` });
      // Primero se cobran los Coins; si dar los días falla, se devuelven.
      addCoins(user.id, -cost, `canje:${plan}:${days}d`);
      let granted = null;
      try { granted = grant(user.id, days); } catch (err) { granted = { ok: false, error: err && err.message }; }
      if (!granted || granted.ok === false || granted.skipped) {
        addCoins(user.id, cost, 'canje-devuelto');
        return res.status(400).json({ error: (granted && granted.error) || 'Tu plan actual no admite sumar días.' });
      }
      try { if (onPlanChanged) onPlanChanged(user.id); } catch {}
      res.json({ ...summary(getUserById ? (getUserById(user.id) || user) : user, deps), granted });
    } finally {
      redeeming.delete(user.id);
    }
  });

  // Admin: ver quién invitó a quién y ajustar Coins a mano.
  const admin = requireAdmin || ((req, res) => res.status(403).json({ error: 'Solo admin.' }));
  app.get('/api/admin/referrals/ip-check', admin, (req, res) => {
    if (base) return proxy(req, res, '/api/admin/referrals/ip-check');
    const h = req.headers || {};
    res.json({ ok: true, detected: clientIp(req), cf: h['cf-connecting-ip'] || '', trueClient: h['true-client-ip'] || '', xff: h['x-forwarded-for'] || '', socket: (req.socket && req.socket.remoteAddress) || '' });
  });

  app.get('/api/admin/referrals', admin, async (req, res) => {
    if (base) return proxy(req, res, '/api/admin/referrals');
    const d = load();
    const name = (id) => { const u = getUserById ? getUserById(id) : null; return (u && u.username) || id; };
    const rows = Object.entries(d.users).map(([id, x]) => ({
      userId: id,
      username: name(id),
      code: x.code,
      coins: Number(x.coins) || 0,
      pendingCoins: (x.pending || []).reduce((n, p) => n + (Number(p.coins) || 0), 0),
      referredBy: x.referredBy ? name(x.referredBy) : '',
      paid: !!x.firstPaidAt,
      blocked: x.rewardBlocked || '',
      friends: Object.values(d.users).filter((y) => String(y.referredBy) === id).length,
      log: (x.log || []).slice(0, 10),
    })).filter((r) => r.coins || r.pendingCoins || r.referredBy || r.friends);
    res.json({ ok: true, rows });
  });
  // Ajuste manual (p. ej. quitar Coins de un amigo que pidió reembolso). Quita primero de los en espera.
  app.post('/api/admin/referrals/adjust', express.json(), admin, async (req, res) => {
    if (base) return proxy(req, res, '/api/admin/referrals/adjust', 'POST');
    const id = String((req.body && req.body.userId) || '');
    const delta = Math.round(Number(req.body && req.body.delta) || 0);
    if (!id || !delta || Math.abs(delta) > 100000 || (getUserById && !getUserById(id))) return res.status(400).json({ error: 'Datos no válidos.' });
    const e = entry(id);
    let rest = delta;
    while (rest < 0 && e.pending.length) {
      const p = e.pending[e.pending.length - 1];
      const take = Math.min(p.coins, -rest);
      p.coins -= take;
      rest += take;
      if (p.coins <= 0) e.pending.pop();
    }
    if (rest !== delta) { addLog(e, delta - rest, 'admin-en-espera'); save(); }
    const coins = rest ? addCoins(id, rest, 'admin') : e.coins;
    res.json({ ok: true, coins, pendingCoins: e.pending.reduce((n, p) => n + p.coins, 0) });
  });
}
