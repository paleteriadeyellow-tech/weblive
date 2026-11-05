// Invita y gana: cada cuenta tiene un código; el amigo que entra con él tiene descuento en
// su primer pago y quien lo invitó gana Coins, que se canjean por días de PRO o VIP.
// Vive en la nube (Render), igual que los pagos. El .exe reenvía todo con la cookie de la nube.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'referrals.json');

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
export const DISCOUNT_PCT = Math.min(90, num(process.env.REF_DISCOUNT_PCT, 15));
// Coins por 1 día de cada plan.
export const DAY_COST = {
  pro: num(process.env.REF_DAY_PRO, 100) || 100,
  premium: num(process.env.REF_DAY_VIP, 200) || 200,
};
const MAX_REDEEM_DAYS = 60;
const COOKIE = 'lc_ref';
const CODE_ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sin 0/O ni 1/I
const CODE_RE = /^[A-Z0-9]{4,16}$/;
const BAD_WORDS = ['PUTA', 'PUTO', 'VERGA', 'PENDEJ', 'MIERDA', 'CULO', 'NAZI', 'ADMIN', 'LIVECOINS', 'SOPORTE'];

let db = null;
function load() {
  if (db) return db;
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (j && typeof j === 'object' && j.users && j.codes) db = j;
  } catch {}
  if (!db) db = { users: {}, codes: {}, orders: {} };
  if (!db.orders) db.orders = {};
  return db;
}
function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(tmp, FILE);
}

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
    e = { code, coins: 0, referredBy: '', referredAt: 0, firstPaidAt: 0, rewarded: false, log: [] };
    d.users[id] = e;
    d.codes[code] = id;
    save();
  }
  return e;
}
function addCoins(userId, delta, reason) {
  const e = entry(userId);
  e.coins = Math.max(0, Math.round((Number(e.coins) || 0) + delta));
  e.log = [{ at: Date.now(), delta: Math.round(delta), reason: String(reason || '').slice(0, 120) }, ...(e.log || [])].slice(0, 50);
  save();
  return e.coins;
}

/** % que se le aplica a un pago NUEVO: solo si lo invitaron y todavía no ha pagado nunca. */
export function discountFor(userId) {
  const e = userId && load().users[String(userId)];
  return e && e.referredBy && !e.firstPaidAt ? DISCOUNT_PCT : 0;
}
/** % que se acepta al confirmar un pago (una orden con descuento puede llegar tarde). */
export function acceptedDiscountFor(userId) {
  const e = userId && load().users[String(userId)];
  return e && e.referredBy ? DISCOUNT_PCT : 0;
}

/** Une una cuenta con quien la invitó. Solo una vez y solo antes de su primer pago. */
export function attachReferrer(userId, rawCode, { getUserById } = {}) {
  const code = normalizeCode(rawCode);
  if (!userId || !code) return { ok: false, error: 'Escribe un código.' };
  const d = load();
  const ownerId = d.codes[code];
  if (!ownerId) return { ok: false, error: 'Ese código no existe.' };
  if (String(ownerId) === String(userId)) return { ok: false, error: 'No puedes usar tu propio código.' };
  const e = entry(userId);
  if (e.referredBy) return { ok: false, error: 'Tu cuenta ya tiene un código de invitación.' };
  if (e.firstPaidAt) return { ok: false, error: 'El código solo se puede poner antes de tu primer pago.' };
  // Un amigo no puede invitar a quien lo invitó a él (evita cadenas de ida y vuelta).
  if (String(entry(ownerId).referredBy) === String(userId)) return { ok: false, error: 'Ese código no se puede usar en tu cuenta.' };
  if (getUserById) {
    const me = getUserById(userId);
    const owner = getUserById(ownerId);
    if (!owner) return { ok: false, error: 'Ese código no existe.' };
    const mail = (u) => String((u && u.email) || '').trim().toLowerCase();
    if (mail(me) && mail(me) === mail(owner)) return { ok: false, error: 'No puedes usar tu propio código.' };
  }
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
  const first = !e.firstPaidAt;
  if (first) e.firstPaidAt = Date.now();
  save();
  if (!first || !e.referredBy || e.rewarded) return;
  const plan = String(meta.plan || 'premium');
  const coins = REWARDS[plan] ?? REWARDS.premium;
  e.rewarded = true;
  e.rewardCoins = coins;
  save();
  if (coins > 0) addCoins(e.referredBy, coins, `amigo-pago:${userId}:${plan}`);
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
  const d = load();
  const friends = Object.entries(d.users)
    .filter(([, x]) => String(x.referredBy) === String(user.id))
    .map(([id, x]) => {
      const u = deps.getUserById ? deps.getUserById(id) : null;
      return {
        username: (u && u.username) || 'cuenta borrada',
        at: x.referredAt || 0,
        status: x.rewarded ? 'paid' : 'joined',
        coins: x.rewarded ? (Number(x.rewardCoins) || 0) : 0,
      };
    })
    .sort((a, b) => b.at - a.at);
  const refUser = e.referredBy && deps.getUserById ? deps.getUserById(e.referredBy) : null;
  return {
    ok: true,
    code: e.code,
    coins: Number(e.coins) || 0,
    link: `${publicBase()}/i/${e.code}`,
    rewards: REWARDS,
    dayCost: DAY_COST,
    discountPct: DISCOUNT_PCT,
    referredBy: e.referredBy ? ((refUser && refUser.username) || 'una cuenta') : '',
    myDiscountPct: discountFor(user.id),
    canEnterCode: !e.referredBy && !e.firstPaidAt,
    redeem: redeemOptions(user, deps.getUserPlan),
    friends,
    log: (e.log || []).slice(0, 20),
  };
}

function publicBase() {
  return String(process.env.REF_PUBLIC_BASE || process.env.PAYPAL_PUBLIC_BASE || process.env.RENDER_EXTERNAL_URL || 'https://livecoins.onrender.com')
    .replace(/\/+$/, '');
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
  const base = String(AUTH_REMOTE || '').replace(/\/+$/, '');

  // .exe / web con nube: todo se hace en Render con la cookie de esa cuenta.
  async function proxy(req, res, pathname, method = 'GET') {
    const user = userFromRequest(req);
    if (!user) { res.status(401).json({ error: 'Inicia sesión.' }); return; }
    const cookie = getRemoteCookie ? getRemoteCookie(user.id) : '';
    if (!cookie) { res.status(503).json({ error: 'Sin sesión con la nube. Cierra sesión y vuelve a entrar.' }); return; }
    const headers = { Accept: 'application/json', Cookie: cookie };
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
    return user;
  };

  // Enlace para compartir: guarda el código 30 días y abre «Crear cuenta».
  app.get('/i/:code', (req, res) => {
    const code = normalizeCode(req.params.code);
    if (code) {
      res.setHeader('Set-Cookie', `${COOKIE}=${code}; Path=/; Max-Age=${30 * 24 * 3600}; SameSite=Lax`);
    }
    res.redirect(302, `/login.html?ref=${encodeURIComponent(code)}#registro`);
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
    const r = attachReferrer(user.id, req.body && req.body.code, deps);
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
    if (d.codes[code]) return res.status(400).json({ error: 'Ese código ya lo usa otra cuenta.' });
    const week = 7 * 24 * 3600 * 1000;
    if (e.codeChangedAt && Date.now() - e.codeChangedAt < week) {
      return res.status(400).json({ error: 'Solo puedes cambiar tu código una vez por semana.' });
    }
    // El código viejo sigue llevando a esta cuenta (por si ya lo compartió).
    d.codes[code] = String(user.id);
    e.code = code;
    e.codeChangedAt = Date.now();
    save();
    res.json(summary(user, deps));
  });

  app.post('/api/referrals/redeem', express.json(), async (req, res) => {
    if (base) return proxy(req, res, '/api/referrals/redeem', 'POST');
    const user = me(req, res);
    if (!user) return;
    const plan = String((req.body && req.body.plan) || '') === 'pro' ? 'pro' : 'premium';
    const days = Math.round(Number(req.body && req.body.days) || 0);
    if (days < 1 || days > MAX_REDEEM_DAYS) return res.status(400).json({ error: `Elige de 1 a ${MAX_REDEEM_DAYS} días.` });
    if (!redeemOptions(user, getUserPlan).includes(plan)) {
      return res.status(400).json({ error: plan === 'pro' ? 'Con tu plan actual canjeas días de VIP.' : 'Con tu plan actual no puedes canjear días de VIP.' });
    }
    const cost = DAY_COST[plan] * days;
    const e = entry(user.id);
    if ((Number(e.coins) || 0) < cost) return res.status(400).json({ error: `Te faltan ${cost - (Number(e.coins) || 0)} Coins.` });
    const grant = plan === 'pro' ? grantProDays : grantPremiumDays;
    const granted = grant ? grant(user.id, days) : null;
    if (!granted || granted.ok === false || granted.skipped) {
      return res.status(400).json({ error: (granted && granted.error) || 'Tu plan actual no admite sumar días.' });
    }
    addCoins(user.id, -cost, `canje:${plan}:${days}d`);
    try { if (onPlanChanged) onPlanChanged(user.id); } catch {}
    res.json({ ...summary(getUserById ? (getUserById(user.id) || user) : user, deps), granted });
  });

  // Admin: ver quién invitó a quién y ajustar Coins a mano.
  const admin = requireAdmin || ((req, res) => res.status(403).json({ error: 'Solo admin.' }));
  app.get('/api/admin/referrals', admin, async (req, res) => {
    if (base) return proxy(req, res, '/api/admin/referrals');
    const d = load();
    const name = (id) => { const u = getUserById ? getUserById(id) : null; return (u && u.username) || id; };
    const rows = Object.entries(d.users).map(([id, x]) => ({
      userId: id,
      username: name(id),
      code: x.code,
      coins: Number(x.coins) || 0,
      referredBy: x.referredBy ? name(x.referredBy) : '',
      paid: !!x.firstPaidAt,
      friends: Object.values(d.users).filter((y) => String(y.referredBy) === id).length,
    })).filter((r) => r.coins || r.referredBy || r.friends);
    res.json({ ok: true, rows });
  });
  app.post('/api/admin/referrals/adjust', express.json(), admin, async (req, res) => {
    if (base) return proxy(req, res, '/api/admin/referrals/adjust', 'POST');
    const id = String((req.body && req.body.userId) || '');
    const delta = Math.round(Number(req.body && req.body.delta) || 0);
    if (!id || !delta || (getUserById && !getUserById(id))) return res.status(400).json({ error: 'Datos no válidos.' });
    res.json({ ok: true, coins: addCoins(id, delta, 'admin') });
  });
}
