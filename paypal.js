// PayPal Checkout: Premium o PRO 1 mes (pago único, no suscripción).
// El cobro y la activación viven en Render (fuente de cuentas). El .exe reenvía
// create-order con la cookie de la nube. Sin CLIENT_ID/SECRET queda inactivo.
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const LEDGER_FILE = path.join(DATA_DIR, 'paypal-payments.json');

const CLIENT_ID = String(process.env.PAYPAL_CLIENT_ID || '').trim();
const CLIENT_SECRET = String(process.env.PAYPAL_CLIENT_SECRET || '').trim();
const WEBHOOK_ID = String(process.env.PAYPAL_WEBHOOK_ID || '').trim();
const MODE = String(process.env.PAYPAL_MODE || 'live').toLowerCase() === 'sandbox' ? 'sandbox' : 'live';
const API = MODE === 'sandbox' ? 'https://api-m.sandbox.paypal.com' : 'https://api-m.paypal.com';
const CURRENCY = String(process.env.PAYPAL_CURRENCY || 'USD').toUpperCase();
const AMOUNT = Number(process.env.PAYPAL_PREMIUM_AMOUNT || 17).toFixed(2);
const DAYS = Math.max(1, Math.round(Number(process.env.PAYPAL_PREMIUM_DAYS || 30) || 30));
// Plan PRO: todo lo de Premium menos los juegos interactivos.
const PRO_AMOUNT = Number(process.env.PAYPAL_PRO_AMOUNT || 12).toFixed(2);
// Founder: $50 el primer mes y luego $12/mes para siempre (quien ya fue Founder).
const FOUNDER_FIRST = Number(process.env.PAYPAL_FOUNDER_FIRST || 50).toFixed(2);
const FOUNDER_MONTHLY = Number(process.env.PAYPAL_FOUNDER_MONTHLY || 12).toFixed(2);
const PLAN_AMOUNT = { premium: AMOUNT, pro: PRO_AMOUNT };
function planOf(p) {
  const s = String(p || '').toLowerCase();
  return s === 'pro' || s === 'founder' ? s : 'premium';
}
/** Lo que paga ESTE usuario por el plan (el Founder depende de si ya fue Founder). */
// Descuento por invitación (referrals.js): % en el primer pago mensual de PRO/VIP. Lo pone mountPaypalRoutes.
let referralDiscount = () => 0;
let referralAccepted = () => 0;
let referralFirstPayment = () => false;
const withDiscount = (value, pct) => (pct > 0 ? (Number(value) * (100 - pct) / 100).toFixed(2) : value);

/** Días a dar por un pago mensual. Si pagó con descuento de invitado pero ya había pagado antes
    (otra orden con descuento ya se usó), recibe los días en proporción a lo que pagó. */
function daysForPaid(userId, plan, paid) {
  if (plan === 'founder') return DAYS;
  const full = Number(PLAN_AMOUNT[plan]);
  if (!(Number(paid) < full - 0.01) || referralFirstPayment(userId)) return DAYS;
  return Math.max(1, Math.floor(DAYS * Number(paid) / full));
}
function amountFor(plan, userId, isFounderMember) {
  if (plan === 'founder') return isFounderMember && isFounderMember(userId) ? FOUNDER_MONTHLY : FOUNDER_FIRST;
  return withDiscount(PLAN_AMOUNT[plan], Number(referralDiscount(userId)) || 0);
}
// Paquetes: pago único que suma esos días al plan. Al terminar, se renueva al precio normal
// (VIP $17/mes; Founder $12/mes, porque con el paquete ya cuenta como Founder).
const PACKS = {
  'vip-3': { plan: 'premium', days: 90, amount: '45.00', label: 'VIP 3 meses' },
  'vip-6': { plan: 'premium', days: 180, amount: '85.00', label: 'VIP 6 meses' },
  'vip-12': { plan: 'premium', days: 365, amount: '160.00', label: 'VIP 1 año' },
  'founder-6': { plan: 'founder', days: 180, amount: '100.00', label: 'Founder 6 meses' },
  'founder-12': { plan: 'founder', days: 365, amount: '165.00', label: 'Founder 1 año' },
};
// custom_id = «userId» (Premium, pedidos viejos), «userId|pro», «userId|founder» o «userId|pack:vip-3».
function splitCustomId(raw) {
  const s = String(raw || '');
  const i = s.lastIndexOf('|');
  if (i <= 0) return { userId: s, plan: 'premium', pack: null };
  const tail = s.slice(i + 1);
  const packId = tail.startsWith('pack:') ? tail.slice(5) : '';
  const pack = packId && PACKS[packId] ? { id: packId, ...PACKS[packId] } : null;
  return { userId: s.slice(0, i), plan: pack ? pack.plan : planOf(tail), pack };
}

function publicBase() {
  return String(process.env.PAYPAL_PUBLIC_BASE || process.env.RENDER_EXTERNAL_URL || 'https://livecoins.onrender.com')
    .replace(/\/+$/, '');
}

export function isConfigured() {
  return !!(CLIENT_ID && CLIENT_SECRET);
}

export function publicStatus(userId, isFounderMember) {
  const member = !!(userId && isFounderMember && isFounderMember(userId));
  return {
    enabled: isConfigured(),
    amount: AMOUNT,
    proAmount: PRO_AMOUNT,
    founderFirst: FOUNDER_FIRST,
    founderMonthly: FOUNDER_MONTHLY,
    // precio Founder para quien pregunta: mensualidad si ya fue Founder, si no el primer pago
    founderAmount: member ? FOUNDER_MONTHLY : FOUNDER_FIRST,
    founderMember: member,
    // % de descuento por invitación en su primer pago de PRO/VIP (0 = sin descuento).
    referralDiscountPct: userId ? Number(referralDiscount(userId)) || 0 : 0,
    packs: Object.entries(PACKS).map(([id, p]) => ({ id, plan: p.plan, days: p.days, amount: p.amount })),
    currency: CURRENCY,
    days: DAYS,
    mode: MODE,
  };
}

let tokenCache = { access: '', exp: 0 };

async function paypalToken() {
  if (tokenCache.access && Date.now() < tokenCache.exp) return tokenCache.access;
  const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const r = await fetch(`${API}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || 'PayPal token falló');
  }
  tokenCache = {
    access: data.access_token,
    exp: Date.now() + Math.max(30, Number(data.expires_in || 300) - 60) * 1000,
  };
  return tokenCache.access;
}

async function paypalFetch(pathname, { method = 'GET', body } = {}) {
  const token = await paypalToken();
  const r = await fetch(`${API}${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}

function loadLedger() {
  let raw = null;
  try { raw = fs.readFileSync(LEDGER_FILE, 'utf8'); } catch (err) {
    // Existe pero no se pudo leer: no seguir con uno vacío (daría días dobles y borraría el historial).
    if (err && err.code !== 'ENOENT') throw new Error('No se pudo leer el registro de pagos. Intenta en un momento.');
  }
  if (raw != null) {
    try {
      const j = JSON.parse(raw);
      if (j && typeof j === 'object') {
        if (!j.captures || typeof j.captures !== 'object') j.captures = {};
        return j;
      }
    } catch {}
    // Dañado: se aparta una copia (nunca se pierde) y se sigue.
    try { fs.copyFileSync(LEDGER_FILE, `${LEDGER_FILE}.danado-${Date.now()}`); } catch {}
    console.error('[paypal] paypal-payments.json dañado; se guardó una copia aparte');
  }
  return { captures: {} };
}
/** ¿Esta cuenta pagó Founder alguna vez? (registro de pagos) */
export function hasFounderPayment(userId) {
  const caps = loadLedger().captures || {};
  return Object.values(caps).some((e) => e && String(e.userId) === String(userId) && e.plan === 'founder');
}
function saveLedger(j) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // Escribir aparte y luego reemplazar: si el servidor se apaga a la mitad, el archivo no queda roto.
  const tmp = `${LEDGER_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(j, null, 2), 'utf8');
  fs.renameSync(tmp, LEDGER_FILE);
}

function amountOk(value, currency, plan = 'premium', userId = '', isFounderMember = null) {
  const got = Number(value);
  if (String(currency || '').toUpperCase() !== CURRENCY || !Number.isFinite(got)) return false;
  const p = planOf(plan);
  const near = (want) => Math.abs(got - Number(want)) <= 0.05;
  // Founder: el primer pago siempre vale; la mensualidad solo si ya era Founder.
  if (p === 'founder') return near(FOUNDER_FIRST) || (near(FOUNDER_MONTHLY) && !!(isFounderMember && isFounderMember(userId)));
  const pct = Number(referralAccepted(userId)) || 0;
  return near(PLAN_AMOUNT[p]) || (pct > 0 && near(withDiscount(PLAN_AMOUNT[p], pct)));
}

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function resultPage(title, inner) {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    font-family:Segoe UI,system-ui,sans-serif;background:#070b14;color:#e2e8f0}
  .box{max-width:440px;padding:28px 24px;border-radius:18px;background:#121826;
    border:1px solid #334155;text-align:center;box-shadow:0 18px 50px rgba(0,0,0,.45)}
  h1{font-size:22px;margin:0 0 10px}
  p{opacity:.88;line-height:1.5;margin:0 0 10px}
  a{color:#38bdf8}
</style></head><body><div class="box">${inner}</div></body></html>`;
}

function approveUrlFromOrder(order) {
  const links = order && Array.isArray(order.links) ? order.links : [];
  const ap = links.find((l) => l && (l.rel === 'approve' || l.rel === 'payer-action'));
  return ap && ap.href ? ap.href : '';
}

function captureFromOrder(order) {
  const pu = order && Array.isArray(order.purchase_units) ? order.purchase_units[0] : null;
  const cap = pu && pu.payments && Array.isArray(pu.payments.captures) ? pu.payments.captures[0] : null;
  return {
    orderId: order && order.id ? String(order.id) : '',
    captureId: cap && cap.id ? String(cap.id) : '',
    status: String((cap && cap.status) || order?.status || ''),
    userId: String((pu && pu.custom_id) || (cap && cap.custom_id) || ''),
    value: cap && cap.amount ? cap.amount.value : (pu && pu.amount ? pu.amount.value : ''),
    currency: cap && cap.amount ? cap.amount.currency_code : (pu && pu.amount ? pu.amount.currency_code : ''),
    payerEmail: String((order && order.payer && order.payer.email_address) || ''),
  };
}

async function fulfillCapture(info, grants, onGranted) {
  if (!info.captureId && !info.orderId) return { ok: false, error: 'pago incompleto' };
  if (info.status && info.status !== 'COMPLETED') {
    // PENDING = PayPal lo está revisando: se activa solo cuando llegue el aviso PAYMENT.CAPTURE.COMPLETED.
    const pending = /^(PENDING|APPROVED|SAVED|CREATED)$/i.test(info.status);
    if (pending) console.warn('[paypal] pago en revisión, se activará con el aviso de PayPal:', info.orderId, info.captureId);
    return { ok: false, pending, error: 'pago no completado' };
  }
  const { userId, plan, pack } = splitCustomId(info.userId);
  info.userId = userId;
  if (pack) {
    if (String(info.currency || '').toUpperCase() !== CURRENCY || Math.abs(Number(info.value) - Number(pack.amount)) > 0.05) {
      return { ok: false, error: 'monto no válido' };
    }
  } else if (!amountOk(info.value, info.currency, plan, info.userId, grants.isFounderMember)) {
    console.error('[paypal] PAGO COBRADO SIN ACTIVAR (monto no válido):', info.orderId, info.captureId, info.userId, info.value, info.currency);
    return { ok: false, error: 'monto no válido' };
  }
  if (!info.userId) {
    console.error('[paypal] PAGO COBRADO SIN ACTIVAR (sin cuenta):', info.orderId, info.captureId, info.value);
    return { ok: false, error: 'pago sin cuenta' };
  }

  const ledger = loadLedger();
  const key = info.captureId || info.orderId;
  if (ledger.captures[key]) {
    return { ok: true, already: true, premiumUntil: ledger.captures[key].premiumUntil || 0 };
  }

  const grant = plan === 'pro' && grants.grantProDays ? grants.grantProDays
    : plan === 'founder' && grants.grantFounderDays ? grants.grantFounderDays
      : grants.grantPremiumDays;
  const days = pack ? pack.days : daysForPaid(info.userId, plan, info.value);
  const granted = grant(info.userId, days);
  if (!granted || granted.ok === false) {
    console.error('[paypal] PAGO COBRADO SIN ACTIVAR (plan):', info.orderId, info.captureId, info.userId, plan, granted && granted.error);
    return { ok: false, error: (granted && granted.error) || 'no se pudo activar el plan' };
  }
  ledger.captures[key] = {
    userId: info.userId,
    orderId: info.orderId,
    captureId: info.captureId,
    at: new Date().toISOString(),
    premiumUntil: granted.premiumUntil || 0,
    plan,
    pack: pack ? pack.id : undefined,
    skipped: !!granted.skipped,
  };
  saveLedger(ledger);
  // meta: para el recibo por correo.
  try {
    onGranted && onGranted(info.userId, granted, {
      provider: 'PayPal', plan, pack: pack ? pack.id : '', days,
      amount: info.value, currency: info.currency || CURRENCY, ref: key, payerEmail: info.payerEmail || '',
    });
  } catch {}
  return { ok: true, granted };
}

export async function createPremiumOrder(userId, planRaw, isFounderMember, packId, method) {
  const pack = packId && PACKS[packId] ? { id: packId, ...PACKS[packId] } : null;
  if (packId && !pack) throw new Error('Paquete no válido');
  // Quien ya es Founder renueva mes a mes a $12: el paquete Founder (que incluye el primer mes de $50) no le conviene.
  if (pack && pack.plan === 'founder' && isFounderMember && isFounderMember(userId)) {
    throw new Error('Ya eres Founder: renuevas cada mes a tu precio Founder.');
  }
  const plan = pack ? pack.plan : planOf(planRaw);
  const value = pack ? pack.amount : amountFor(plan, userId, isFounderMember);
  const planName = pack ? pack.label : plan === 'pro' ? 'PRO' : plan === 'founder' ? 'Founder' : 'Premium';
  if (!isConfigured()) throw new Error('PayPal no configurado');
  const base = publicBase();
  const { ok, status, data } = await paypalFetch('/v2/checkout/orders', {
    method: 'POST',
    body: {
      intent: 'CAPTURE',
      purchase_units: [{
        custom_id: pack ? `${userId}|pack:${pack.id}` : plan === 'premium' ? String(userId) : `${userId}|${plan}`,
        description: `Livecoins ${planName} ${pack ? pack.days : DAYS} días`,
        amount: { currency_code: CURRENCY, value },
      }],
      application_context: {
        brand_name: 'Livecoins',
        locale: 'es-MX',
        // «card» = abre el formulario de tarjeta (sin cuenta PayPal); si no, la pantalla para entrar a PayPal.
        // En application_context PayPal solo acepta LOGIN / BILLING / NO_PREFERENCE (GUEST_CHECKOUT da INVALID_REQUEST).
        landing_page: method === 'card' ? 'BILLING' : 'LOGIN',
        user_action: 'PAY_NOW',
        // Producto digital: sin dirección de envío (el formulario de tarjeta pide menos datos).
        shipping_preference: 'NO_SHIPPING',
        return_url: `${base}/api/paypal/return`,
        cancel_url: `${base}/api/paypal/cancel`,
      },
    },
  });
  if (!ok || !data.id) {
    // PayPal manda el motivo concreto en details[] (campo e «issue»): se agrega para poder diagnosticar.
    const det = Array.isArray(data.details) ? data.details.map((x) => [x.field, x.issue, x.description].filter(Boolean).join(' ')).join('; ') : '';
    const msg = (data.message || data.error_description || data.error || `PayPal ${status}`) + (det ? ` (${det})` : '');
    console.error('[paypal] create-order rechazado:', status, JSON.stringify(data).slice(0, 800));
    throw new Error(msg);
  }
  const approveUrl = approveUrlFromOrder(data);
  if (!approveUrl) throw new Error('PayPal no devolvió enlace de pago');
  return { orderId: data.id, approveUrl, amount: value };
}

export async function captureAndGrant(orderId, grants, onGranted) {
  // Antes de cobrar: revisar que la orden sea válida (cuenta y monto). Así nunca se cobra
  // una orden que después no activaría el plan. Si ya estaba cobrada, no se cobra otra vez.
  const pre = await paypalFetch(`/v2/checkout/orders/${encodeURIComponent(orderId)}`);
  if (pre.ok && pre.data && pre.data.id) {
    const i = captureFromOrder(pre.data);
    const { userId, plan, pack } = splitCustomId(i.userId);
    const amountValid = pack
      ? String(i.currency || '').toUpperCase() === CURRENCY && Math.abs(Number(i.value) - Number(pack.amount)) <= 0.05
      : amountOk(i.value, i.currency, plan, userId, grants.isFounderMember);
    if (!userId || !amountValid) {
      console.error('[paypal] orden no válida, NO se cobra:', orderId, i.userId, i.value, i.currency);
      return { ok: false, error: 'Esta orden de pago no es válida. No se te cobró nada; vuelve a Planes e inténtalo otra vez.' };
    }
    if (String(pre.data.status || '').toUpperCase() === 'COMPLETED') {
      const info = captureFromOrder(pre.data);
      if (!info.orderId) info.orderId = String(orderId);
      return fulfillCapture(info, grants, onGranted);
    }
  }
  const captured = await paypalFetch(`/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, { method: 'POST' });
  let order = captured.data;
  if (!captured.ok) {
    // Ya capturada (doble clic / webhook primero): leer la orden.
    const got = await paypalFetch(`/v2/checkout/orders/${encodeURIComponent(orderId)}`);
    if (!got.ok) {
      const msg = order.details?.[0]?.description || order.message || 'No se pudo confirmar el pago';
      throw new Error(msg);
    }
    order = got.data;
  }
  const info = captureFromOrder(order);
  if (!info.orderId) info.orderId = String(orderId);
  return fulfillCapture(info, grants, onGranted);
}

async function verifyWebhook(headers, rawBody) {
  if (!WEBHOOK_ID) return false;
  const { ok, data } = await paypalFetch('/v1/notifications/verify-webhook-signature', {
    method: 'POST',
    body: {
      auth_algo: headers['paypal-auth-algo'],
      cert_url: headers['paypal-cert-url'],
      transmission_id: headers['paypal-transmission-id'],
      transmission_sig: headers['paypal-transmission-sig'],
      transmission_time: headers['paypal-transmission-time'],
      webhook_id: WEBHOOK_ID,
      webhook_event: JSON.parse(rawBody.toString('utf8') || '{}'),
    },
  });
  return !!(ok && data && data.verification_status === 'SUCCESS');
}

export function mountPaypalRoutes(app, {
  userFromRequest,
  grantPremiumDays,
  grantProDays,
  grantFounderDays,
  isFounderMember,
  AUTH_REMOTE,
  getRemoteCookie,
  onGranted,
  referralDiscountFor,
  referralAcceptedDiscountFor,
  referralFirstPaymentFor,
} = {}) {
  const grants = { grantPremiumDays, grantProDays, grantFounderDays, isFounderMember };
  if (referralDiscountFor) referralDiscount = referralDiscountFor;
  if (referralAcceptedDiscountFor) referralAccepted = referralAcceptedDiscountFor;
  if (referralFirstPaymentFor) referralFirstPayment = referralFirstPaymentFor;
  async function proxyToRemote(req, res, pathname, method = 'GET') {
    const base = String(AUTH_REMOTE || '').replace(/\/+$/, '');
    if (!base) return false;
    const user = userFromRequest(req);
    const cookie = user && getRemoteCookie ? getRemoteCookie(user.id) : '';
    const headers = { Accept: 'application/json' };
    if (cookie) headers.Cookie = cookie;
    if (method !== 'GET') headers['Content-Type'] = 'application/json';
    try {
      const r = await fetch(`${base}${pathname}`, {
        method,
        headers,
        body: method === 'GET' ? undefined : JSON.stringify(req.body || {}),
      });
      const data = await r.json().catch(() => ({}));
      res.status(r.status).json(data);
      return true;
    } catch {
      return false;
    }
  }

  app.get('/api/paypal/status', async (req, res) => {
    if (AUTH_REMOTE) {
      if (await proxyToRemote(req, res, '/api/paypal/status')) return;
    }
    const me = userFromRequest(req);
    res.json(publicStatus(me && me.id, isFounderMember));
  });

  app.post('/api/paypal/create-order', express.json(), async (req, res) => {
    const user = userFromRequest(req);
    if (!user) return res.status(401).json({ error: 'Inicia sesión para pagar Premium.' });
    if (AUTH_REMOTE) {
      const cookie = getRemoteCookie && getRemoteCookie(user.id);
      if (!cookie) {
        return res.status(503).json({ error: 'Sin sesión con la nube. Cierra sesión y vuelve a entrar.' });
      }
      if (await proxyToRemote(req, res, '/api/paypal/create-order', 'POST')) return;
      return res.status(503).json({ error: 'Sin sesión con la nube. Cierra sesión y vuelve a entrar.' });
    }
    if (!isConfigured()) {
      return res.status(503).json({ error: 'PayPal no está configurado todavía.', whatsapp: true });
    }
    try {
      const packId = String((req.body && req.body.pack) || '').trim();
      const plan = packId && PACKS[packId] ? PACKS[packId].plan : planOf(req.body && req.body.plan);
      const method = req.body && req.body.method === 'card' ? 'card' : 'paypal';
      const out = await createPremiumOrder(user.id, plan, isFounderMember, packId, method);
      res.json({ ok: true, ...out, plan, currency: CURRENCY, days: packId && PACKS[packId] ? PACKS[packId].days : DAYS });
    } catch (e) {
      console.error('[paypal] create-order:', e && e.message);
      res.status(502).json({ error: (e && e.message) || 'No se pudo crear el pago PayPal.' });
    }
  });

  app.get('/api/paypal/return', async (req, res) => {
    const token = String(req.query.token || req.query.orderID || '').trim();
    if (!token) {
      return res.status(400).send(resultPage('Pago', '<h1>Falta el pago</h1><p>Vuelve a Planes e inténtalo otra vez.</p><p><a href="/#planes">Ir a Planes</a></p>'));
    }
    if (!isConfigured()) {
      return res.status(503).send(resultPage('PayPal', '<h1>PayPal no configurado</h1><p>Avisa al administrador.</p>'));
    }
    try {
      const result = await captureAndGrant(token, grants, onGranted);
      if (!result.ok && result.pending) {
        return res.send(resultPage('Pago en revisión', `<h1>Pago en revisión</h1>
          <p>PayPal está revisando tu pago. Tu plan se activa <b>solo</b> en cuanto PayPal lo confirme (normalmente minutos).</p>
          <p>Si en unas horas no se activa, escríbenos con el correo de tu pago.</p><p><a href="/#planes">Volver a Planes</a></p>`));
      }
      const back = '<p><a href="/#planes">Volver a Planes</a></p>';
      const safeId = token.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
      if (!result.ok) {
        // Revisado ANTES de cobrar: no se cobró.
        if (/No se te cobró/.test(result.error || '')) {
          return res.status(400).send(resultPage('Pago', `<h1>No se activó</h1><p>${esc(result.error)}</p>${back}`));
        }
        // PayPal rechazó la tarjeta / el pago no se completó.
        if (result.error === 'pago no completado') {
          return res.status(400).send(resultPage('Pago', `<h1>No se completó el pago</h1><p>PayPal no aprobó el cobro. Puedes intentarlo otra vez.</p>${back}`));
        }
        // Cobrado pero no se pudo activar: nunca decir que no se cobró.
        return res.status(400).send(resultPage('Pago recibido', `<h1>Recibimos tu pago</h1>
          <p>Pero no se pudo activar tu plan automáticamente. Escríbenos con este número y lo activamos a mano:</p><p><b>${safeId}</b></p>${back}`));
      }
      // Ya estaba activado (el aviso de PayPal llegó primero o recargaron esta página).
      if (result.already) {
        const until = result.premiumUntil;
        return res.send(resultPage('Pago ya registrado', `<h1>Pago ya registrado</h1>
          <p>Tu plan ya está activo${until ? ` hasta el <b>${new Date(until).toLocaleDateString('es-MX')}</b>` : ''}.</p>
          <p>Si usas el .exe, vuelve a Livecoins y recarga el panel.</p>${back}`));
      }
      const gp = result.granted && result.granted.plan;
      const planName = gp === 'pro' ? 'PRO' : gp === 'founder' ? 'Founder' : 'Premium';
      const until = result.granted && result.granted.premiumUntil;
      res.send(resultPage(planName, `
        <h1>${planName} activado</h1>
        ${until ? `<p>Tu plan ${planName} quedó activo hasta el <b>${new Date(until).toLocaleDateString('es-MX')}</b>.</p>` : `<p>Tu plan ${planName} quedó activo.</p>`}
        <p>Si usas el .exe, vuelve a Livecoins y recarga el panel.</p>
        <p><a href="/#planes">Ir a Planes</a></p>
      `));
    } catch (e) {
      console.error('[paypal] return:', token, e && e.message);
      const safeId = token.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
      res.status(502).send(resultPage('Pago', `<h1>No se pudo confirmar todavía</h1>
        <p>${esc((e && e.message) || 'Error de PayPal.')}</p>
        <p>Si PayPal ya te cobró, tu plan se activa solo en unos minutos. Si no se activa, escríbenos con este número: <b>${safeId}</b></p>
        <p><a href="/#planes">Volver a Planes</a></p>`));
    }
  });

  app.get('/api/paypal/cancel', (_req, res) => {
    res.send(resultPage('Cancelado', `
      <h1>Pago cancelado</h1>
      <p>No se cobró nada. Puedes intentarlo otra vez cuando quieras.</p>
      <p><a href="/#planes">Volver a Planes</a></p>
    `));
  });

  app.post('/api/paypal/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    if (!isConfigured()) return res.status(503).json({ error: 'off' });
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body || ''), 'utf8');
    try {
      const verified = await verifyWebhook(req.headers, raw);
      if (!verified) {
        console.warn('[paypal] webhook sin verificar (falta PAYPAL_WEBHOOK_ID o firma inválida)');
        return res.status(400).json({ error: 'invalid' });
      }
      const event = JSON.parse(raw.toString('utf8') || '{}');
      const type = String(event.event_type || '');
      if (type === 'PAYMENT.CAPTURE.COMPLETED') {
        const resu = event.resource || {};
        const info = {
          captureId: String(resu.id || ''),
          orderId: String(resu.supplementary_data?.related_ids?.order_id || ''),
          status: String(resu.status || ''),
          userId: String(resu.custom_id || ''),
          value: resu.amount && resu.amount.value,
          currency: resu.amount && resu.amount.currency_code,
        };
        if (!info.userId && info.orderId) {
          const got = await paypalFetch(`/v2/checkout/orders/${encodeURIComponent(info.orderId)}`);
          const fromOrder = captureFromOrder(got.data || {});
          if (!info.userId) info.userId = fromOrder.userId;
          if (!info.value) info.value = fromOrder.value;
          if (!info.currency) info.currency = fromOrder.currency;
        }
        await fulfillCapture(info, grants, onGranted);
      } else if (type === 'CHECKOUT.ORDER.APPROVED') {
        const orderId = event.resource && event.resource.id;
        if (orderId) await captureAndGrant(orderId, grants, onGranted);
      }
      res.json({ ok: true });
    } catch (e) {
      console.error('[paypal] webhook:', e && e.message);
      res.status(500).json({ error: 'webhook' });
    }
  });
}
