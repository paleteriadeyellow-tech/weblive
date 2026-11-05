// Mercado Pago (Checkout Pro con la API de Orders): tarjeta sin cuenta y OXXO, en pesos.
// Igual que PayPal: el cobro y la activación viven en Render; el .exe reenvía con la cookie de la nube.
// Sin MP_ACCESS_TOKEN queda inactivo. OXXO: el plan se activa cuando Mercado Pago avisa que ya pagaron.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const LEDGER_FILE = path.join(DATA_DIR, 'mercadopago-payments.json');

const ACCESS_TOKEN = String(process.env.MP_ACCESS_TOKEN || '').trim();
const PUBLIC_KEY = String(process.env.MP_PUBLIC_KEY || '').trim();
// Clave secreta de Webhooks (opcional): si está, se valida la firma x-signature.
const WEBHOOK_SECRET = String(process.env.MP_WEBHOOK_SECRET || '').trim();
const API = 'https://api.mercadopago.com';
const CURRENCY = 'MXN';
const DAYS = 30;
const money = (v, def) => Number(v || def).toFixed(2);
// Precios en pesos (los mismos planes y paquetes que PayPal).
const PRICES = {
  pro: money(process.env.MP_PRO_AMOUNT, 220),
  premium: money(process.env.MP_PREMIUM_AMOUNT, 320),
  founderFirst: money(process.env.MP_FOUNDER_FIRST, 920),
  founderMonthly: money(process.env.MP_FOUNDER_MONTHLY, 220),
};
const PACKS = {
  'vip-3': { plan: 'premium', days: 90, amount: money(process.env.MP_PACK_VIP3, 830), label: 'VIP 3 meses' },
  'vip-6': { plan: 'premium', days: 180, amount: money(process.env.MP_PACK_VIP6, 1570), label: 'VIP 6 meses' },
  'vip-12': { plan: 'premium', days: 365, amount: money(process.env.MP_PACK_VIP12, 2950), label: 'VIP 1 año' },
  'founder-6': { plan: 'founder', days: 180, amount: money(process.env.MP_PACK_FOUNDER6, 1850), label: 'Founder 6 meses' },
  'founder-12': { plan: 'founder', days: 365, amount: money(process.env.MP_PACK_FOUNDER12, 3050), label: 'Founder 1 año' },
};

function planOf(p) {
  const s = String(p || '').toLowerCase();
  return s === 'pro' || s === 'founder' ? s : 'premium';
}
// Descuento por invitación (referrals.js): % en el primer pago mensual de PRO/VIP. Lo pone mountMercadoPagoRoutes.
let referralDiscount = () => 0;
let referralAccepted = () => 0;
let referralFirstPayment = () => false;
const withDiscount = (value, pct) => (pct > 0 ? (Number(value) * (100 - pct) / 100).toFixed(2) : value);

/** Días a dar por un pago mensual. Si pagó con descuento de invitado pero ya había pagado antes
    (otra orden con descuento ya se usó), recibe los días en proporción a lo que pagó. */
function daysForPaid(userId, plan, paid) {
  if (plan === 'founder') return DAYS;
  const full = Number(PRICES[plan]);
  if (!(Number(paid) < full - 0.01) || referralFirstPayment(userId)) return DAYS;
  return Math.max(1, Math.floor(DAYS * Number(paid) / full));
}
function amountFor(plan, userId, isFounderMember) {
  if (plan === 'founder') return isFounderMember && isFounderMember(userId) ? PRICES.founderMonthly : PRICES.founderFirst;
  return withDiscount(PRICES[plan], Number(referralDiscount(userId)) || 0);
}
// external_reference: Mercado Pago solo acepta letras, números, «-» y «_» (máx. 64).
// Formato «userId_pro», «userId_premium», «userId_founder» o «userId_pk-vip-3» (el id es un UUID, sin «_»).
function makeRef(userId, plan, pack) {
  return `${userId}_${pack ? `pk-${pack.id}` : plan}`;
}
function splitRef(raw) {
  const s = String(raw || '');
  const i = s.lastIndexOf('_');
  if (i <= 0) return { userId: '', plan: 'premium', pack: null };
  const tail = s.slice(i + 1);
  const packId = tail.startsWith('pk-') ? tail.slice(3) : '';
  const pack = packId && PACKS[packId] ? { id: packId, ...PACKS[packId] } : null;
  return { userId: s.slice(0, i), plan: pack ? pack.plan : planOf(tail), pack };
}

function publicBase() {
  return String(process.env.MP_PUBLIC_BASE || process.env.PAYPAL_PUBLIC_BASE || process.env.RENDER_EXTERNAL_URL || 'https://livecoins.onrender.com')
    .replace(/\/+$/, '');
}

export function isConfigured() {
  return !!ACCESS_TOKEN;
}

export function publicStatus(userId, isFounderMember) {
  const member = !!(userId && isFounderMember && isFounderMember(userId));
  return {
    enabled: isConfigured(),
    publicKey: PUBLIC_KEY,
    currency: CURRENCY,
    proAmount: PRICES.pro,
    amount: PRICES.premium,
    founderFirst: PRICES.founderFirst,
    founderMonthly: PRICES.founderMonthly,
    founderAmount: member ? PRICES.founderMonthly : PRICES.founderFirst,
    founderMember: member,
    // % de descuento por invitación en su primer pago de PRO/VIP (0 = sin descuento).
    referralDiscountPct: userId ? Number(referralDiscount(userId)) || 0 : 0,
    packs: Object.entries(PACKS).map(([id, p]) => ({ id, plan: p.plan, days: p.days, amount: p.amount })),
    days: DAYS,
  };
}

async function mpFetch(pathname, { method = 'GET', body, idempotency } = {}) {
  const headers = {
    Authorization: `Bearer ${ACCESS_TOKEN}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
  if (idempotency) headers['X-Idempotency-Key'] = idempotency;
  const r = await fetch(`${API}${pathname}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
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
        if (!j.orders || typeof j.orders !== 'object') j.orders = {};
        return j;
      }
    } catch {}
    // Dañado: se aparta una copia (nunca se pierde) y se sigue.
    try { fs.copyFileSync(LEDGER_FILE, `${LEDGER_FILE}.danado-${Date.now()}`); } catch {}
    console.error('[mercadopago] mercadopago-payments.json dañado; se guardó una copia aparte');
  }
  return { orders: {} };
}
/** ¿Esta cuenta pagó Founder alguna vez? (registro de pagos) */
export function hasFounderPayment(userId) {
  const orders = loadLedger().orders || {};
  return Object.values(orders).some((e) => e && String(e.userId) === String(userId) && e.plan === 'founder');
}
function saveLedger(j) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // Escribir aparte y luego reemplazar: si el servidor se apaga a la mitad, el archivo no queda roto.
  const tmp = `${LEDGER_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(j, null, 2), 'utf8');
  fs.renameSync(tmp, LEDGER_FILE);
}

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

// El regreso del comprador y el webhook pueden llegar a la vez: una sola activación por orden.
const inflight = new Map();
export function fulfillOrder(orderId, grants, onGranted) {
  const id = String(orderId || '').trim();
  if (inflight.has(id)) return inflight.get(id);
  const p = fulfillOrderOnce(id, grants, onGranted).finally(() => inflight.delete(id));
  inflight.set(id, p);
  return p;
}

/** Lee la orden en Mercado Pago (con nuestro token: no se puede falsificar) y, si ya está pagada, activa el plan. */
async function fulfillOrderOnce(orderId, grants, onGranted) {
  const id = String(orderId || '').trim();
  if (!id) return { ok: false, error: 'pago incompleto' };
  const got = await mpFetch(`/v1/orders/${encodeURIComponent(id)}`);
  if (!got.ok || !got.data || !got.data.id) return { ok: false, error: 'No se encontró el pago' };
  const order = got.data;
  const status = String(order.status || '').toLowerCase();
  const detail = String(order.status_detail || '').toLowerCase();
  // OXXO: la orden queda esperando («action_required»/«pending») hasta que pagan en la tienda.
  if (status !== 'processed' || (detail && detail !== 'accredited')) {
    return { ok: false, pending: status !== 'failed' && status !== 'canceled' && status !== 'expired', status, error: 'pago no completado' };
  }
  const { userId, plan, pack } = splitRef(order.external_reference);
  const lost = (why) => console.error(`[mercadopago] PAGO COBRADO SIN ACTIVAR (${why}):`, order.id, order.external_reference, order.total_paid_amount || order.total_amount, order.currency);
  if (!userId) { lost('sin cuenta'); return { ok: false, error: 'pago sin cuenta' }; }
  if (String(order.currency || CURRENCY).toUpperCase() !== CURRENCY) { lost('moneda'); return { ok: false, error: 'moneda no válida' }; }
  const paid = Number(order.total_paid_amount || order.total_amount);
  const want = pack ? Number(pack.amount)
    : plan === 'founder' ? Number(PRICES.founderMonthly) // mínimo válido; el primer pago es mayor
      : Number(withDiscount(PRICES[plan], Number(referralAccepted(userId)) || 0));
  if (!Number.isFinite(paid) || paid + 0.5 < want) { lost('monto'); return { ok: false, error: 'monto no válido' }; }
  // Founder a precio de mensualidad solo si ya era Founder.
  if (!pack && plan === 'founder' && paid + 0.5 < Number(PRICES.founderFirst)
    && !(grants.isFounderMember && grants.isFounderMember(userId))) {
    lost('founder');
    return { ok: false, error: 'monto no válido' };
  }

  const ledger = loadLedger();
  if (ledger.orders[order.id]) return { ok: true, already: true, premiumUntil: ledger.orders[order.id].premiumUntil || 0 };
  const grant = plan === 'pro' && grants.grantProDays ? grants.grantProDays
    : plan === 'founder' && grants.grantFounderDays ? grants.grantFounderDays
      : grants.grantPremiumDays;
  const days = pack ? pack.days : daysForPaid(userId, plan, paid);
  const granted = grant(userId, days);
  if (!granted || granted.ok === false) { lost(`plan: ${granted && granted.error}`); return { ok: false, error: (granted && granted.error) || 'no se pudo activar el plan' }; }
  ledger.orders[order.id] = {
    userId,
    at: new Date().toISOString(),
    amount: String(paid),
    plan,
    pack: pack ? pack.id : undefined,
    premiumUntil: granted.premiumUntil || 0,
    skipped: !!granted.skipped,
  };
  saveLedger(ledger);
  // meta: para el recibo por correo.
  const methodType = String((order.transactions && order.transactions.payments && order.transactions.payments[0]
    && order.transactions.payments[0].payment_method && order.transactions.payments[0].payment_method.type) || '');
  try {
    onGranted && onGranted(userId, granted, {
      provider: methodType === 'ticket' ? 'Mercado Pago (OXXO)' : 'Mercado Pago', plan, pack: pack ? pack.id : '',
      days, amount: String(paid), currency: CURRENCY, ref: order.id,
      payerEmail: String((order.payer && order.payer.email) || ''),
    });
  } catch {}
  return { ok: true, granted };
}

export async function createMpOrder(userId, planRaw, isFounderMember, packId) {
  const pack = packId && PACKS[packId] ? { id: packId, ...PACKS[packId] } : null;
  if (packId && !pack) throw new Error('Paquete no válido');
  if (pack && pack.plan === 'founder' && isFounderMember && isFounderMember(userId)) {
    throw new Error('Ya eres Founder: renuevas cada mes a tu precio Founder.');
  }
  if (!isConfigured()) throw new Error('Mercado Pago no configurado');
  const plan = pack ? pack.plan : planOf(planRaw);
  const value = pack ? pack.amount : amountFor(plan, userId, isFounderMember);
  const planName = pack ? pack.label : plan === 'pro' ? 'PRO' : plan === 'founder' ? 'Founder' : 'VIP';
  const base = publicBase();
  const back = `${base}/api/mp/return`;
  const { ok, status, data } = await mpFetch('/v1/orders', {
    method: 'POST',
    idempotency: crypto.randomUUID(),
    body: {
      type: 'online',
      processing_mode: 'manual',
      total_amount: value,
      external_reference: makeRef(userId, plan, pack),
      description: `Livecoins ${planName}`,
      items: [{ title: `Livecoins ${planName} (${pack ? pack.days : DAYS} días)`, unit_price: value, quantity: 1 }],
      config: { online: { success_url: back, failure_url: back, pending_url: back, auto_return: 'all' } },
    },
  });
  const url = data && (data.checkout_url || data.init_point || (data.checkout_pro && data.checkout_pro.init_point));
  if (!ok || !data.id || !url) {
    console.error('[mercadopago] create-order rechazado:', status, JSON.stringify(data).slice(0, 800));
    // El motivo concreto viene en errors[] (code, message, details): se muestra para poder diagnosticar.
    const det = Array.isArray(data && data.errors)
      ? data.errors.map((x) => [x.code, x.message, Array.isArray(x.details) ? x.details.join(', ') : x.details].filter(Boolean).join(' ')).join('; ')
      : '';
    throw new Error(`Mercado Pago ${status}${det ? ` (${det})` : (data && data.message ? ` (${data.message})` : '')}`);
  }
  return { orderId: data.id, approveUrl: url, amount: value };
}

/** Firma x-signature: «id:[data.id];request-id:[x-request-id];ts:[ts];» con HMAC-SHA256. */
function signatureOk(req, dataId) {
  if (!WEBHOOK_SECRET) return true; // sin clave: igual es seguro, porque la orden se vuelve a leer en Mercado Pago
  const sig = String(req.headers['x-signature'] || '');
  const parts = Object.fromEntries(sig.split(',').map((p) => p.split('=').map((x) => x.trim())).filter((p) => p.length === 2));
  if (!parts.ts || !parts.v1) return false;
  const reqId = String(req.headers['x-request-id'] || '');
  let manifest = '';
  if (dataId) manifest += `id:${String(dataId).toLowerCase()};`;
  if (reqId) manifest += `request-id:${reqId};`;
  manifest += `ts:${parts.ts};`;
  const h = crypto.createHmac('sha256', WEBHOOK_SECRET).update(manifest).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(h), Buffer.from(parts.v1)); } catch { return false; }
}

export function mountMercadoPagoRoutes(app, {
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

  app.get('/api/mp/status', async (req, res) => {
    if (AUTH_REMOTE) {
      if (await proxyToRemote(req, res, '/api/mp/status')) return;
    }
    const me = userFromRequest(req);
    res.json(publicStatus(me && me.id, isFounderMember));
  });

  app.post('/api/mp/create-order', express.json(), async (req, res) => {
    const user = userFromRequest(req);
    if (!user) return res.status(401).json({ error: 'Inicia sesión para pagar.' });
    if (AUTH_REMOTE) {
      const cookie = getRemoteCookie && getRemoteCookie(user.id);
      if (cookie && await proxyToRemote(req, res, '/api/mp/create-order', 'POST')) return;
      return res.status(503).json({ error: 'Sin sesión con la nube. Cierra sesión y vuelve a entrar.' });
    }
    if (!isConfigured()) return res.status(503).json({ error: 'Mercado Pago no está configurado todavía.' });
    try {
      const packId = String((req.body && req.body.pack) || '').trim();
      const plan = packId && PACKS[packId] ? PACKS[packId].plan : planOf(req.body && req.body.plan);
      const out = await createMpOrder(user.id, plan, isFounderMember, packId);
      res.json({ ok: true, ...out, plan, currency: CURRENCY, days: packId && PACKS[packId] ? PACKS[packId].days : DAYS });
    } catch (e) {
      console.error('[mercadopago] create-order:', e && e.message);
      res.status(502).json({ error: (e && e.message) || 'No se pudo crear el pago con Mercado Pago.' });
    }
  });

  // Regreso del comprador (aprobado, pendiente/OXXO o rechazado).
  app.get('/api/mp/return', async (req, res) => {
    const orderId = String(req.query.order_id || '').trim();
    const st = String(req.query.status || req.query.collection_status || '').toLowerCase();
    const back = '<p><a href="/#planes">Volver a Planes</a></p>';
    if (orderId && isConfigured()) {
      try {
        const result = await fulfillOrder(orderId, grants, onGranted);
        if (result.ok) {
          const gp = result.granted ? result.granted.plan : '';
          const planName = gp === 'pro' ? 'PRO' : gp === 'founder' ? 'Founder' : 'VIP';
          const until = result.granted ? result.granted.premiumUntil : result.premiumUntil;
          return res.send(resultPage('Pago listo', `<h1>${result.already ? 'Pago ya registrado' : `${planName} activado`}</h1>
            ${until ? `<p>Tu plan quedó activo hasta el <b>${new Date(until).toLocaleDateString('es-MX')}</b>.</p>` : ''}
            <p>Si usas el .exe, vuelve a Livecoins y recarga el panel.</p>${back}`));
        }
        if (result.pending) {
          return res.send(resultPage('Pago pendiente', `<h1>Pago pendiente</h1>
            <p>Si elegiste <b>OXXO</b>, paga con tu ficha en la tienda. Tu plan se activa solo cuando Mercado Pago confirme el pago (puede tardar unas horas).</p>${back}`));
        }
        // Cobrado pero no se pudo activar: nunca decir «no se cobró nada».
        if (result.error && result.error !== 'pago no completado' && result.error !== 'No se encontró el pago') {
          const safeId = orderId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
          return res.send(resultPage('Pago recibido', `<h1>Recibimos tu pago</h1>
            <p>Pero no se pudo activar tu plan automáticamente. Escríbenos con este número y lo activamos a mano:</p>
            <p><b>${safeId}</b></p>${back}`));
        }
      } catch (e) {
        console.error('[mercadopago] return:', e && e.message);
      }
    }
    if (st === 'pending' || st === 'in_process') {
      return res.send(resultPage('Pago pendiente', `<h1>Pago pendiente</h1>
        <p>Si elegiste <b>OXXO</b>, paga con tu ficha en la tienda. Tu plan se activa solo cuando se confirme el pago.</p>${back}`));
    }
    if (st === 'approved') {
      return res.send(resultPage('Pago recibido', `<h1>Pago recibido</h1><p>Tu plan se activa en unos momentos.</p>${back}`));
    }
    res.send(resultPage('Pago', `<h1>No se completó el pago</h1><p>No se cobró nada. Puedes intentarlo otra vez.</p>${back}`));
  });

  // Webhook «Order (Mercado Pago)»: llega al aprobar tarjeta y cuando pagan en OXXO.
  app.post('/api/mp/webhook', express.json({ type: '*/*' }), async (req, res) => {
    if (!isConfigured()) return res.status(503).json({ error: 'off' });
    const body = req.body || {};
    const type = String(body.type || req.query.type || '').toLowerCase();
    const dataId = String((body.data && body.data.id) || req.query['data.id'] || '').trim();
    if (!signatureOk(req, req.query['data.id'] || dataId)) {
      console.warn('[mercadopago] webhook con firma inválida');
      return res.status(400).json({ error: 'invalid' });
    }
    try {
      if (dataId && (type === 'order' || String(body.action || '').startsWith('order.'))) {
        const r = await fulfillOrder(dataId, grants, onGranted);
        if (!r.ok && !r.pending) console.warn('[mercadopago] webhook sin activar:', dataId, r.error);
      }
      res.json({ ok: true });
    } catch (e) {
      console.error('[mercadopago] webhook:', e && e.message);
      res.status(500).json({ error: 'webhook' });
    }
  });
}
