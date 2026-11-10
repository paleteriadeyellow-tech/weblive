// Tienda de diamantes Free Fire. Solo vive en la nube (Render), nunca en el .exe.
//
// Flujo: el usuario elige paquete + ID → se verifica el ID y el saldo del proveedor → paga con
// Mercado Pago o PayPal → al confirmarse el pago se compra en RecargasAmerica y se entrega.
// El precio de venta lo pone el admin (en pesos); el costo real del proveedor nunca se muestra.
//
// Seguridad del dinero:
// - El pago se lee siempre en Mercado Pago / PayPal con nuestras claves (no se confía en el navegador).
// - Cada unidad que se compra al proveedor tiene su Idempotency-Key guardada ANTES de enviarla:
//   si el servidor se reinicia a la mitad, se reintenta con la misma clave (nunca se compra doble).
// - Si algo falla después de cobrar, el pedido queda «REVIEW» para que el admin lo resuelva.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { recargasApi, isRecargasConfigured } from './recargas.js';
import { mpFetch, setMpShopHandler, isConfigured as mpConfigured } from './mercadopago.js';
import {
  paypalFetch, setPaypalShopHandler, approveUrlFromOrder, captureFromOrder, isConfigured as ppConfigured,
} from './paypal.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'tienda.json');
const CURRENCY = 'MXN';
const PP_CURRENCY = String(process.env.SHOP_PAYPAL_CURRENCY || 'MXN').toUpperCase();
const POLL_MS = 60 * 1000;
const PENDING_GIVE_UP_MS = 24 * 3600 * 1000;
const UNPAID_EXPIRE_MS = 3 * 24 * 3600 * 1000;
const MAX_ORDERS = 20000;
const FF_ID_RE = /^\d{6,13}$/;
// Paquetes «contact»: no se compran aquí, se muestran con botón para escribir en Discord.
const DISCORD_URL = String(process.env.SHOP_DISCORD_URL || 'https://discord.gg/EdZCWK7Gxz').trim();

// Precios iniciales (los del flyer). Los productos del proveedor se asignan en el admin.
const DEFAULT_PACKAGES = [
  ['ff-1160', '1,160 diamantes', 160], ['ff-2320', '2,320 diamantes', 300], ['ff-3080', '3,080 diamantes', 430],
  ['ff-3564', '3,564 diamantes', 470], ['ff-5368', '5,368 diamantes', 690], ['ff-6160', '6,160 diamantes', 730],
  ['ff-7326', '7,326 diamantes', 890], ['ff-8008', '8,008 diamantes', 980], ['ff-10065', '10,065 diamantes', 1290],
  ['ff-12320', '12,320 diamantes', 1510], ['ff-18k', '18,000 diamantes', 2200], ['ff-20k', '20,000 diamantes', 2490],
  ['ff-25k', '25,000 diamantes', 3250], ['ff-30k', '30,000 diamantes', 3770], ['ff-35k', '35,000 diamantes', 4400],
  ['ff-booyah', 'Pase Booyah premium', 45, 'extra'], ['ff-semanal-basica', 'Tarjeta semanal básica', 8, 'extra'],
  ['ff-semanal', 'Tarjeta semanal', 35, 'extra'], ['ff-mensual', 'Tarjeta mensual', 150, 'extra'],
].map(([id, label, price, kind]) => ({ id, label, price, kind: kind || 'diamonds', items: [], active: false }));

/* ------------------------------------ datos ------------------------------------ */
let db = null;
function load() {
  if (db) return db;
  let raw = null;
  try { raw = fs.readFileSync(FILE, 'utf8'); } catch (err) {
    if (err && err.code !== 'ENOENT') throw new Error('La tienda no está disponible en este momento.');
  }
  if (raw != null) {
    let j = null;
    try { j = JSON.parse(raw); } catch {}
    if (!j || typeof j !== 'object' || !j.config || !j.orders) {
      try { fs.copyFileSync(FILE, `${FILE}.danado-${Date.now()}`); } catch {}
      throw new Error('La tienda no está disponible. Avisa al administrador.');
    }
    db = j;
  }
  if (!db) db = { config: { enabled: false, fx: 18.5, packages: DEFAULT_PACKAGES }, orders: {} };
  return db;
}
function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const ids = Object.keys(db.orders);
  if (ids.length > MAX_ORDERS) {
    // Solo se descartan los más viejos ya terminados.
    ids.map((id) => db.orders[id]).filter((o) => isClosed(o)).sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, ids.length - MAX_ORDERS).forEach((o) => { delete db.orders[o.id]; });
  }
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(tmp, FILE);
}
const isClosed = (o) => ['DELIVERED', 'REFUNDED_TO_CUSTOMER', 'CANCELED', 'EXPIRED'].includes(o.status);
const pkgById = (id) => load().config.packages.find((p) => p.id === id) || null;
const money = (n) => Math.round(Number(n) * 100) / 100;

/* ------------------------------ costo y disponibilidad ------------------------------ */
function productCost(p) {
  const v = Number(p && (p.price ?? p.cost ?? p.amount));
  return Number.isFinite(v) ? v : null;
}
async function catalogMap() {
  const r = await recargasApi.catalog('');
  if (r.status !== 200 || !r.body?.success || !Array.isArray(r.body.data)) throw new Error('catálogo no disponible');
  return new Map(r.body.data.map((p) => [Number(p.id), p]));
}
// Costo total en USD del paquete; null si algún producto ya no existe o está inactivo.
function packageCost(pkg, cat) {
  if (!pkg.items || !pkg.items.length) return null;
  let sum = 0;
  for (const it of pkg.items) {
    const p = cat.get(Number(it.productId));
    if (!p || p.active === false || p.status === 'inactive') return null;
    const c = productCost(p);
    if (c == null) return null;
    sum += c * it.qty;
  }
  return money(sum);
}

/* ------------------------------------ entrega ------------------------------------ */
const locks = new Map();
function withLock(id, fn) {
  const prev = locks.get(id) || Promise.resolve();
  const p = prev.then(fn, fn).finally(() => { if (locks.get(id) === p) locks.delete(id); });
  locks.set(id, p);
  return p;
}

function unitState(rec) {
  if (!rec) return 'NOT_SENT';
  if (rec.status === 'COMPLETED') return 'DONE';
  if (rec.status === 'REFUNDED_API_ERROR' || rec.status === 'REFUNDED' || rec.status === 'FAILED') return 'FAILED';
  return 'PENDING'; // SENDING, UNKNOWN, PROCESSING_*, needs_review
}

function recompute(o) {
  if (!['PAID', 'DELIVERING', 'REVIEW'].includes(o.status)) return;
  const states = o.units.map((u) => u.state);
  if (states.every((s) => s === 'DONE')) {
    o.status = 'DELIVERED';
    o.deliveredAt = o.deliveredAt || Date.now();
  } else if (states.some((s) => s === 'FAILED')) {
    o.status = 'REVIEW';
  } else if (states.some((s) => s === 'PENDING')) {
    o.status = Date.now() - (o.paidAt || o.createdAt) > PENDING_GIVE_UP_MS ? 'REVIEW' : 'DELIVERING';
  }
}

// Compra cada unidad en orden. Se detiene en la primera que falle (el admin decide).
async function deliver(orderId) {
  return withLock(orderId, async () => {
    const d = load();
    const o = d.orders[orderId];
    if (!o || !['PAID', 'DELIVERING'].includes(o.status)) return o;
    o.status = 'DELIVERING';
    save();
    for (const u of o.units) {
      if (u.state === 'DONE' || u.state === 'FAILED') continue;
      if (!u.key) { u.key = crypto.randomUUID(); save(); }
      const existing = recargasApi.find(u.key);
      if (existing && existing.orderId && unitState(existing) === 'PENDING') {
        await recargasApi.refresh(existing);
      } else if (!existing || (existing.status === 'SENDING' || existing.status === 'UNKNOWN')) {
        // Nunca enviada, o el servidor se cayó al enviarla: misma clave → la API no cobra doble.
        await recargasApi.buy({
          productId: u.productId, quantity: 1, playerId: o.playerId,
          idempotencyKey: u.key, shopOrderId: o.id, clientName: o.username || '',
          by: { id: o.userId, username: o.username },
        });
      }
      const rec = recargasApi.find(u.key);
      u.state = unitState(rec);
      u.providerOrderId = rec?.orderId || u.providerOrderId || '';
      u.providerStatus = rec?.status || '';
      u.providerCode = rec?.code || '';
      u.needsReview = !!rec?.needsReview;
      if (rec?.amountCharged != null) u.cost = rec.amountCharged;
      save();
      if (u.state !== 'DONE') break; // pendiente o fallida: no seguir hasta resolverla
    }
    recompute(o);
    if (o.status === 'REVIEW') console.error('[tienda] PEDIDO PAGADO EN REVISIÓN:', o.id, o.label, o.playerId, o.units.map((u) => u.providerCode || u.providerStatus).join(','));
    save();
    return o;
  });
}

async function markPaid(orderId, { amount, currency, ref, provider, payerEmail }) {
  return withLock(orderId, async () => {
    const d = load();
    const o = d.orders[orderId];
    if (!o) {
      console.error('[tienda] PAGO SIN PEDIDO:', orderId, provider, ref, amount, currency);
      return { ok: false, error: 'pedido no encontrado' };
    }
    if (o.status !== 'AWAITING_PAYMENT' && o.status !== 'EXPIRED') return { ok: true, already: true, order: o };
    const want = o.payCurrency === currency ? Number(o.payAmount) : NaN;
    if (!Number.isFinite(Number(amount)) || !(Number(amount) + 0.05 >= want)) {
      console.error('[tienda] PAGO CON MONTO NO VÁLIDO:', orderId, provider, ref, amount, currency, 'esperado', o.payAmount, o.payCurrency);
      o.status = 'REVIEW';
      o.note = `Monto pagado ${amount} ${currency} no coincide (esperado ${o.payAmount} ${o.payCurrency}).`;
      save();
      return { ok: false, error: 'monto no válido' };
    }
    o.status = 'PAID';
    o.paidAt = Date.now();
    o.paidAmount = String(amount);
    o.payRef = ref || o.payRef;
    o.payerEmail = payerEmail || '';
    o.payPending = false;
    save();
    return { ok: true, order: o };
  }).then((r) => {
    if (r.ok && !r.already) deliver(orderId).catch((e) => console.error('[tienda] entrega:', orderId, e && e.message));
    return r;
  });
}

function markPayPending(orderId) {
  const o = load().orders[orderId];
  if (o && o.status === 'AWAITING_PAYMENT' && !o.payPending) { o.payPending = true; save(); }
}

/* ----------------------------------- Mercado Pago ----------------------------------- */
async function onMpOrder(order) {
  const orderId = String(order.external_reference || '').slice(5);
  const status = String(order.status || '').toLowerCase();
  const detail = String(order.status_detail || '').toLowerCase();
  if (status !== 'processed' || (detail && detail !== 'accredited')) {
    const pending = status !== 'failed' && status !== 'canceled' && status !== 'expired';
    if (pending) markPayPending(orderId);
    return { ok: false, pending, error: 'pago no completado', shopOrderId: orderId };
  }
  const methodType = String(order.transactions?.payments?.[0]?.payment_method?.type || '');
  const r = await markPaid(orderId, {
    amount: Number(order.total_paid_amount || order.total_amount),
    currency: String(order.currency || CURRENCY).toUpperCase(),
    ref: String(order.id),
    provider: methodType === 'ticket' ? 'mp-oxxo' : 'mp',
    payerEmail: String(order.payer?.email || ''),
  });
  return { ...r, shopOrderId: orderId };
}

async function createMpPayment(o, base) {
  const back = `${base}/api/tienda/mp/return`;
  const { ok, status, data } = await mpFetch('/v1/orders', {
    method: 'POST',
    idempotency: crypto.randomUUID(),
    body: {
      type: 'online',
      processing_mode: 'manual',
      total_amount: Number(o.payAmount).toFixed(2),
      external_reference: `shop-${o.id}`,
      description: `Livecoins ${o.label}`,
      items: [{ title: `Free Fire ${o.label} (ID ${o.playerId})`, unit_price: Number(o.payAmount).toFixed(2), quantity: 1 }],
      config: { online: { success_url: back, failure_url: back, pending_url: back, auto_return: 'all' } },
    },
  });
  const url = data && (data.checkout_url || data.init_point || data.checkout_pro?.init_point);
  if (!ok || !data.id || !url) {
    console.error('[tienda] MP create-order rechazado:', status, JSON.stringify(data).slice(0, 600));
    throw new Error('Mercado Pago no pudo crear el pago. Intenta de nuevo.');
  }
  return { ref: String(data.id), url };
}

/* -------------------------------------- PayPal -------------------------------------- */
async function onPaypalCaptured(info) {
  const orderId = String(info.userId || '').slice(5);
  if (info.status && info.status !== 'COMPLETED') {
    const pending = /^(PENDING|APPROVED|SAVED|CREATED)$/i.test(info.status);
    if (pending) markPayPending(orderId);
    return { ok: false, pending, error: 'pago no completado', shopOrderId: orderId };
  }
  const r = await markPaid(orderId, {
    amount: Number(info.value), currency: String(info.currency || '').toUpperCase(),
    ref: info.captureId || info.orderId, provider: 'paypal', payerEmail: info.payerEmail || '',
  });
  return { ...r, shopOrderId: orderId };
}

// Antes de cobrar se revisa que la orden de PayPal coincida con el pedido (monto y moneda).
async function onPaypalApproved(ppOrderId, preData) {
  const pre = captureFromOrder(preData);
  const shopId = String(pre.userId || '').slice(5);
  const o = load().orders[shopId];
  if (!o || String(pre.currency || '').toUpperCase() !== o.payCurrency || Math.abs(Number(pre.value) - Number(o.payAmount)) > 0.05) {
    console.error('[tienda] orden PayPal no coincide, NO se cobra:', ppOrderId, pre.userId, pre.value, pre.currency);
    return { ok: false, error: 'Esta orden de pago no es válida. No se te cobró nada.', shopOrderId: shopId };
  }
  if (String(preData.status || '').toUpperCase() === 'COMPLETED') {
    const info = captureFromOrder(preData);
    if (!info.orderId) info.orderId = ppOrderId;
    return onPaypalCaptured(info);
  }
  const cap = await paypalFetch(`/v2/checkout/orders/${encodeURIComponent(ppOrderId)}/capture`, { method: 'POST' });
  let order = cap.data;
  if (!cap.ok) {
    const got = await paypalFetch(`/v2/checkout/orders/${encodeURIComponent(ppOrderId)}`);
    if (!got.ok) return { ok: false, error: 'No se pudo confirmar el pago con PayPal.', shopOrderId: shopId };
    order = got.data;
  }
  const info = captureFromOrder(order);
  if (!info.orderId) info.orderId = ppOrderId;
  return onPaypalCaptured(info);
}

async function createPaypalPayment(o, base, method) {
  const { ok, status, data } = await paypalFetch('/v2/checkout/orders', {
    method: 'POST',
    body: {
      intent: 'CAPTURE',
      purchase_units: [{
        custom_id: `shop:${o.id}`,
        description: `Free Fire ${o.label} (ID ${o.playerId})`.slice(0, 127),
        amount: { currency_code: o.payCurrency, value: Number(o.payAmount).toFixed(2) },
      }],
      application_context: {
        brand_name: 'Livecoins',
        locale: 'es-MX',
        landing_page: method === 'card' ? 'BILLING' : 'LOGIN',
        user_action: 'PAY_NOW',
        shipping_preference: 'NO_SHIPPING',
        return_url: `${base}/api/tienda/paypal/return`,
        cancel_url: `${base}/tienda.html?cancelado=1`,
      },
    },
  });
  const url = ok && data.id ? approveUrlFromOrder(data) : '';
  if (!url) {
    console.error('[tienda] PayPal create-order rechazado:', status, JSON.stringify(data).slice(0, 600));
    throw new Error('PayPal no pudo crear el pago. Intenta de nuevo.');
  }
  return { ref: String(data.id), url };
}

/* --------------------------------- vista pública --------------------------------- */
function publicOrder(o) {
  return {
    id: o.id, label: o.label, playerId: o.playerId, nickname: o.nickname || '', price: o.price,
    payAmount: o.payAmount, payCurrency: o.payCurrency, method: o.method,
    status: o.status, payPending: !!o.payPending, createdAt: o.createdAt, paidAt: o.paidAt || 0,
    deliveredAt: o.deliveredAt || 0, payUrl: o.status === 'AWAITING_PAYMENT' ? o.payUrl : '',
  };
}
function adminOrder(o) {
  return { ...publicOrder(o), userId: o.userId, username: o.username, payRef: o.payRef, paidAmount: o.paidAmount,
    payerEmail: o.payerEmail, note: o.note || '', units: o.units, sandbox: !!o.sandbox };
}

function publicBase() {
  return String(process.env.SHOP_PUBLIC_BASE || process.env.MP_PUBLIC_BASE || process.env.PAYPAL_PUBLIC_BASE
    || process.env.RENDER_EXTERNAL_URL || 'https://livecoins.onrender.com').replace(/\/+$/, '');
}

function resultRedirect(res, orderId, extra = '') {
  const q = orderId ? `?pedido=${encodeURIComponent(orderId)}${extra}` : (extra ? `?${extra.slice(1)}` : '');
  res.redirect(302, `/tienda.html${q}`);
}

/* -------------------------------------- rutas -------------------------------------- */
export function mountTiendaRoutes(app, { userFromRequest, requireAdmin } = {}) {
  setMpShopHandler(onMpOrder);
  setPaypalShopHandler({ approved: onPaypalApproved, captured: onPaypalCaptured });

  const admin = requireAdmin || ((req, res) => res.status(403).json({ error: 'forbidden' }));
  const safe = (fn) => async (req, res, next) => {
    try { await fn(req, res, next); } catch (err) {
      console.error('[tienda]', req.method, req.path, err && err.message);
      if (!res.headersSent) res.status(500).json({ error: (err && err.message) || 'No se pudo completar.' });
    }
  };
  const needUser = (req, res, next) => {
    const u = userFromRequest(req);
    if (!u) return res.status(401).json({ error: 'Inicia sesión en Livecoins para comprar.' });
    req.user = u;
    next();
  };
  // Abierta solo si el admin la activó y la clave es de producción (con sandbox, solo el admin prueba).
  const openFor = (user) => {
    const c = load().config;
    if (user && user.isAdmin) return { ok: true };
    if (!c.enabled) return { ok: false, error: 'La tienda está cerrada por ahora.' };
    if (!isRecargasConfigured() || recargasApi.isSandbox()) return { ok: false, error: 'La tienda está en pruebas. Vuelve pronto.' };
    return { ok: true };
  };
  const recent = new Map(); // límite de pedidos por usuario
  const rateOk = (userId) => {
    const now = Date.now();
    const list = (recent.get(userId) || []).filter((t) => now - t < 3600 * 1000);
    if (list.length >= 10) return false;
    list.push(now);
    recent.set(userId, list);
    return true;
  };

  async function checkPlayer(pkg, playerId) {
    const first = pkg.items[0];
    const r = await recargasApi.validate({ product_id: Number(first.productId), service_user_id: playerId });
    if (r.status === 200 && r.body?.success) {
      const v = r.body.data || {};
      if (v.supported && v.status === false) return { ok: false, error: v.message || 'Ese ID de Free Fire no existe. Revísalo.' };
      return { ok: true, nickname: v.supported && v.status ? String(v.account_name || '') : '' };
    }
    const code = r.body?.code;
    if (code === 'INVALID_PLAYER_ID_FORMAT' || code === 'PLAYER_ID_BLOCKED' || r.status === 422) {
      return { ok: false, error: r.body?.error || r.body?.message || 'Ese ID de Free Fire no es válido.' };
    }
    return { ok: true, nickname: '' }; // el proveedor no pudo validar ahora: se sigue sin nombre
  }

  app.get('/api/tienda/config', safe(async (req, res) => {
    const u = userFromRequest(req);
    const c = load().config;
    const open = openFor(u);
    res.json({
      open: open.ok, reason: open.ok ? '' : open.error, loggedIn: !!u,
      sandbox: recargasApi.isSandbox(),
      currency: CURRENCY,
      methods: { mp: mpConfigured(), paypal: ppConfigured() },
      discord: DISCORD_URL,
      packages: c.packages.filter((p) => p.active && (p.kind === 'contact' || (p.items && p.items.length)))
        .map((p) => ({ id: p.id, label: p.label, price: p.price, kind: p.kind })),
    });
  }));

  app.post('/api/tienda/check-id', needUser, express.json(), safe(async (req, res) => {
    const pkg = pkgById(String(req.body?.packageId || ''));
    const playerId = String(req.body?.playerId || '').trim();
    if (!pkg || pkg.kind === 'contact' || !pkg.items.length) return res.status(400).json({ error: 'Elige un paquete.' });
    if (!FF_ID_RE.test(playerId)) return res.status(400).json({ error: 'El ID de Free Fire son solo números (8 a 12).' });
    if (!isRecargasConfigured()) return res.status(503).json({ error: 'La tienda no está disponible.' });
    const v = await checkPlayer(pkg, playerId);
    if (!v.ok) return res.status(422).json({ error: v.error });
    res.json({ nickname: v.nickname });
  }));

  app.post('/api/tienda/order', needUser, express.json(), safe(async (req, res) => {
    const user = req.user;
    const open = openFor(user);
    if (!open.ok) return res.status(403).json({ error: open.error });
    const pkg = pkgById(String(req.body?.packageId || ''));
    const playerId = String(req.body?.playerId || '').trim();
    const method = ['mp', 'paypal', 'card'].includes(req.body?.method) ? req.body.method : '';
    if (!pkg || !pkg.active || pkg.kind === 'contact' || !pkg.items.length) return res.status(400).json({ error: 'Ese paquete no está disponible.' });
    if (!FF_ID_RE.test(playerId)) return res.status(400).json({ error: 'El ID de Free Fire son solo números (8 a 12).' });
    if (!method) return res.status(400).json({ error: 'Elige cómo pagar.' });
    if (method === 'mp' && !mpConfigured()) return res.status(503).json({ error: 'Mercado Pago no está disponible.' });
    if (method !== 'mp' && !ppConfigured()) return res.status(503).json({ error: 'PayPal no está disponible.' });
    if (!rateOk(user.id)) return res.status(429).json({ error: 'Demasiados pedidos seguidos. Espera un rato.' });

    // 1) ¿Lo tiene el proveedor y alcanza el saldo? (para nunca cobrar algo que no se puede entregar)
    let cost = null;
    try { cost = packageCost(pkg, await catalogMap()); } catch {}
    if (cost == null) return res.status(503).json({ error: 'Este paquete no está disponible ahora. Intenta más tarde.' });
    const w = await recargasApi.wallet();
    const balance = Number(w.body?.data?.balance);
    if (!(w.status === 200 && Number.isFinite(balance))) return res.status(503).json({ error: 'La tienda no responde ahora. Intenta en unos minutos.' });
    if (balance < cost) {
      console.warn('[tienda] saldo insuficiente para vender', pkg.id, 'costo', cost, 'saldo', balance);
      return res.status(503).json({ error: 'Este paquete está agotado por ahora. Intenta más tarde.' });
    }
    // 2) ¿Existe el ID?
    const v = await checkPlayer(pkg, playerId);
    if (!v.ok) return res.status(422).json({ error: v.error });

    // 3) Pedido + pago
    const d = load();
    const id = crypto.randomBytes(8).toString('hex');
    const ppUsd = method !== 'mp' && PP_CURRENCY !== CURRENCY;
    const o = {
      id,
      userId: user.id,
      username: user.username || '',
      packageId: pkg.id,
      label: pkg.label,
      price: Number(pkg.price),
      payCurrency: method === 'mp' ? CURRENCY : PP_CURRENCY,
      payAmount: ppUsd ? Math.ceil((Number(pkg.price) / Number(d.config.fx || 18.5)) * 100) / 100 : Number(pkg.price),
      playerId,
      nickname: v.nickname,
      method,
      status: 'AWAITING_PAYMENT',
      createdAt: Date.now(),
      costUsd: cost,
      sandbox: recargasApi.isSandbox(),
      units: pkg.items.flatMap((it) => Array.from({ length: it.qty }, () => ({ productId: Number(it.productId), state: 'NOT_SENT' }))),
    };
    d.orders[id] = o;
    save();
    try {
      const base = publicBase();
      const pay = method === 'mp' ? await createMpPayment(o, base) : await createPaypalPayment(o, base, method);
      o.payRef = pay.ref;
      o.payUrl = pay.url;
      save();
      res.json({ ok: true, orderId: id, approveUrl: pay.url });
    } catch (e) {
      o.status = 'CANCELED';
      o.note = 'No se pudo crear el pago.';
      save();
      res.status(502).json({ error: e.message });
    }
  }));

  app.get('/api/tienda/my-orders', needUser, safe(async (req, res) => {
    const list = Object.values(load().orders).filter((o) => o.userId === req.user.id && o.status !== 'CANCELED')
      .sort((a, b) => b.createdAt - a.createdAt).slice(0, 50).map(publicOrder);
    res.json({ orders: list });
  }));

  // Regreso desde Mercado Pago.
  app.get('/api/tienda/mp/return', safe(async (req, res) => {
    const mpId = String(req.query.order_id || '').trim();
    if (!mpId || !mpConfigured()) return resultRedirect(res, '', '&pago=desconocido');
    const got = await mpFetch(`/v1/orders/${encodeURIComponent(mpId)}`);
    const order = got.ok ? got.data : null;
    if (!order || !String(order.external_reference || '').startsWith('shop-')) return resultRedirect(res, '', '&pago=desconocido');
    const r = await onMpOrder(order);
    resultRedirect(res, r.shopOrderId, r.ok ? '' : r.pending ? '&pago=pendiente' : '&pago=fallido');
  }));

  // Regreso desde PayPal: aquí se cobra (después de revisar el monto).
  app.get('/api/tienda/paypal/return', safe(async (req, res) => {
    const token = String(req.query.token || '').trim();
    if (!token || !ppConfigured()) return resultRedirect(res, '', '&pago=desconocido');
    const pre = await paypalFetch(`/v2/checkout/orders/${encodeURIComponent(token)}`);
    if (!pre.ok || !String(captureFromOrder(pre.data).userId || '').startsWith('shop:')) return resultRedirect(res, '', '&pago=desconocido');
    const r = await onPaypalApproved(token, pre.data);
    resultRedirect(res, r.shopOrderId, r.ok ? '' : r.pending ? '&pago=pendiente' : '&pago=fallido');
  }));

  /* ------------------------------- admin ------------------------------- */
  app.get('/api/admin/tienda', admin, safe(async (_req, res) => {
    const d = load();
    let cat = null;
    try { cat = await catalogMap(); } catch {}
    const packages = d.config.packages.map((p) => ({ ...p, costUsd: cat ? packageCost(p, cat) : null }));
    const orders = Object.values(d.orders).sort((a, b) => b.createdAt - a.createdAt).slice(0, 300).map(adminOrder);
    res.json({
      config: { ...d.config, packages },
      sandbox: recargasApi.isSandbox(),
      methods: { mp: mpConfigured(), paypal: ppConfigured() },
      paypalCurrency: PP_CURRENCY,
      orders,
    });
  }));

  app.post('/api/admin/tienda/config', admin, express.json({ limit: '200kb' }), safe(async (req, res) => {
    const d = load();
    const b = req.body || {};
    const fx = Number(b.fx);
    if (b.fx != null && !(fx > 1 && fx < 1000)) return res.status(400).json({ error: 'Tipo de cambio no válido.' });
    let packages = d.config.packages;
    if (Array.isArray(b.packages)) {
      const seen = new Set();
      packages = [];
      for (const p of b.packages) {
        const id = String(p.id || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40);
        const label = String(p.label || '').trim().slice(0, 80);
        const price = money(p.price);
        if (!id || seen.has(id) || !label || !(price > 0)) return res.status(400).json({ error: `Paquete inválido: ${label || id || '(vacío)'}` });
        seen.add(id);
        const items = (Array.isArray(p.items) ? p.items : []).map((it) => ({
          productId: Math.trunc(Number(it.productId)), qty: Math.max(1, Math.min(20, Math.trunc(Number(it.qty) || 1))),
        })).filter((it) => it.productId > 0).slice(0, 10);
        const kind = ['extra', 'contact'].includes(p.kind) ? p.kind : 'diamonds';
        packages.push({ id, label, price, kind, items, active: !!p.active && (kind === 'contact' || items.length > 0) });
      }
    }
    d.config = { ...d.config, enabled: b.enabled != null ? !!b.enabled : d.config.enabled, fx: b.fx != null ? fx : d.config.fx, packages };
    save();
    res.json({ ok: true });
  }));

  // Reintentar las unidades fallidas (con clave nueva: la anterior ya no entregó nada).
  app.post('/api/admin/tienda/orders/:id/retry', admin, safe(async (req, res) => {
    const d = load();
    const o = d.orders[req.params.id];
    if (!o || !['REVIEW', 'DELIVERING', 'PAID'].includes(o.status) || !o.paidAt) return res.status(400).json({ error: 'Este pedido no se puede reintentar.' });
    for (const u of o.units) {
      if (u.state === 'FAILED') { (u.oldKeys = u.oldKeys || []).push(u.key); u.key = ''; u.state = 'NOT_SENT'; u.providerCode = ''; }
    }
    o.status = 'PAID';
    o.paidAt = Date.now(); // reinicia el plazo de espera
    save();
    const out = await deliver(o.id);
    res.json({ order: adminOrder(out) });
  }));

  app.post('/api/admin/tienda/orders/:id/mark', admin, express.json(), safe(async (req, res) => {
    const d = load();
    const o = d.orders[req.params.id];
    const st = String(req.body?.status || '');
    if (!o || !['REFUNDED_TO_CUSTOMER', 'DELIVERED', 'CANCELED'].includes(st)) return res.status(400).json({ error: 'No válido.' });
    o.status = st;
    o.note = String(req.body?.note || o.note || '').slice(0, 300);
    o.closedBy = req.user ? req.user.username : '';
    o.closedAt = Date.now();
    save();
    res.json({ order: adminOrder(o) });
  }));

  // Seguimiento: entregas pendientes y pedidos sin pagar viejos.
  const tick = async () => {
    let d;
    try { d = load(); } catch { return; }
    const now = Date.now();
    for (const o of Object.values(d.orders)) {
      if (o.status === 'AWAITING_PAYMENT' && now - o.createdAt > UNPAID_EXPIRE_MS) { o.status = 'EXPIRED'; save(); continue; }
      if (o.status === 'PAID' || o.status === 'DELIVERING') {
        try { await deliver(o.id); } catch (e) { console.error('[tienda] seguimiento:', o.id, e && e.message); }
      }
    }
  };
  setTimeout(() => tick().catch(() => {}), 15000).unref?.();
  setInterval(() => tick().catch(() => {}), POLL_MS).unref?.();
}
