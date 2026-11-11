// Recargas (RecargasAmerica API de revendedor). Solo vive en la nube (Render), nunca en el .exe.
//
// Variables de entorno en Render:
//   RECARGAS_API_KEY   clave ra_... (producción) o ra_test_... (sandbox). Nunca va en el código.
//   RECARGAS_API_BASE  opcional; por defecto https://panel.recargasamerica.com/api/v1
//
// Por ahora todo es solo para el admin: saldo, catálogo, validar ID, comprar y ver órdenes.
// Cada compra lleva su Idempotency-Key y queda guardada (la API no tiene historial propio).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'recargas-orders.json');
const MAX_ORDERS = 5000;
const CATALOG_TTL_MS = 5 * 60 * 1000;
const TIMEOUT_MS = 30000;
const FINAL = new Set(['COMPLETED', 'REFUNDED_API_ERROR', 'REFUNDED', 'PARTIAL']);

function apiKey() { return String(process.env.RECARGAS_API_KEY || '').trim(); }
function apiBase() {
  return String(process.env.RECARGAS_API_BASE || 'https://panel.recargasamerica.com/api/v1').replace(/\/+$/, '');
}
export function isRecargasConfigured() { return !!apiKey(); }
function isSandboxKey() { return apiKey().startsWith('ra_test_'); }

/* ------------------------------ registro de compras ------------------------------ */
let db = null;
function load() {
  if (db) return db;
  let raw = null;
  try { raw = fs.readFileSync(FILE, 'utf8'); } catch (err) {
    if (err && err.code !== 'ENOENT') throw new Error('El registro de recargas no está disponible. Intenta en un rato.');
  }
  if (raw != null) {
    let j = null;
    try { j = JSON.parse(raw); } catch {}
    if (!j || !Array.isArray(j.orders)) {
      // Dañado: no se pisa (se perderían compras). Se aparta una copia y se avisa.
      try { fs.copyFileSync(FILE, `${FILE}.danado-${Date.now()}`); } catch {}
      throw new Error('El registro de recargas está dañado. Avisa al administrador.');
    }
    db = j;
  }
  if (!db) db = { orders: [] };
  return db;
}
function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(tmp, FILE);
}
function findOrder(id) {
  return load().orders.find((o) => o.idempotencyKey === id || (o.orderId && o.orderId === id)) || null;
}

/* ---------------------------------- cliente HTTP --------------------------------- */
// Devuelve { status, body, timeout }. Nunca lanza por errores HTTP.
async function call(method, pathname, { body, idempotencyKey } = {}) {
  const headers = {
    Authorization: `Bearer ${apiKey()}`,
    Accept: 'application/json',
    'Accept-Language': 'es',
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(apiBase() + pathname, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await r.text();
    let j = null;
    try { j = JSON.parse(text); } catch {}
    const warn = r.headers.get('x-ra-warning');
    if (warn) console.warn('[recargas] aviso de la API:', warn);
    return { status: r.status, body: j || { success: false, code: 'BAD_RESPONSE', error: 'Respuesta inválida del proveedor.' }, retryAfter: r.headers.get('retry-after') };
  } catch (err) {
    return { status: 0, timeout: true, body: { success: false, code: 'NETWORK', error: err && err.name === 'AbortError' ? 'El proveedor no respondió a tiempo.' : 'No se pudo conectar con el proveedor.' } };
  } finally {
    clearTimeout(t);
  }
}

let catalogCache = { at: 0, key: '', data: null };
async function getCatalog(category = '') {
  const key = String(category || '');
  if (catalogCache.data && catalogCache.key === key && Date.now() - catalogCache.at < CATALOG_TTL_MS) {
    return { status: 200, body: { success: true, data: catalogCache.data, cached: true } };
  }
  const q = key ? `?category=${encodeURIComponent(key)}` : '';
  const r = await call('GET', `/products/catalog${q}`);
  if (r.status === 200 && r.body && r.body.success && Array.isArray(r.body.data)) {
    catalogCache = { at: Date.now(), key, data: r.body.data };
  }
  return r;
}

/* ------------------------------------ compra ------------------------------------- */
function cleanStr(v, max = 100) {
  return String(v == null ? '' : v).trim().slice(0, max);
}

function applyResult(rec, r) {
  const d = (r.body && r.body.data) || {};
  rec.httpStatus = r.status;
  rec.code = r.body && r.body.code ? String(r.body.code) : (r.body && r.body.success ? 'OK' : rec.code || '');
  if (d.order_id) rec.orderId = String(d.order_id);
  if (d.transaction_id != null) rec.transactionId = d.transaction_id;
  if (d.status) rec.status = String(d.status);
  if (typeof d.needs_review === 'boolean') rec.needsReview = d.needs_review;
  if (d.amount_charged != null) rec.amountCharged = Number(d.amount_charged);
  if (d.item) rec.item = String(d.item);
  if (Array.isArray(d.delivery)) rec.delivery = d.delivery;
  else if (d.username || d.password) rec.delivery = [{ username: d.username, password: d.password }];
  if (r.body && r.body.sandbox) rec.sandbox = true;
  rec.lastResponse = r.body;
  rec.updatedAt = Date.now();
}

// Compra con reintento seguro: si se corta la red, se repite con la MISMA Idempotency-Key
// (la API responde 409 si la primera ya entró, sin cobrar dos veces).
async function buy({ productId, playerId, zoneId, serverId, quantity, clientName, by, shopOrderId, idempotencyKey }) {
  const d = load();
  // Reintento de una compra ya registrada (misma clave): se reusa el registro, nunca se duplica.
  const prev = idempotencyKey ? d.orders.find((o) => o.idempotencyKey === idempotencyKey) : null;
  const rec = prev || {
    idempotencyKey: idempotencyKey || crypto.randomUUID(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    by: by || null,
    shopOrderId: shopOrderId || undefined,
    productId,
    playerId: playerId || '',
    zoneId: zoneId || '',
    quantity,
    status: 'SENDING',
    sandbox: isSandboxKey(),
  };
  if (!prev) {
    d.orders.unshift(rec);
    if (d.orders.length > MAX_ORDERS) d.orders.length = MAX_ORDERS;
  }
  save(); // se guarda ANTES de mandar: si el servidor se cae, la clave no se pierde

  const body = { product_id: productId, quantity };
  if (playerId) body.player_id = playerId;
  if (zoneId) body.zone_id = zoneId;
  if (serverId) body.server_id = serverId;
  if (clientName) body.client_name = clientName;

  let r = null;
  for (let i = 0; i < 3; i++) {
    r = await call('POST', '/buy/catalog', { body, idempotencyKey: rec.idempotencyKey });
    const retry = r.timeout || r.status === 500 || (r.status === 503 && r.body?.code === 'TEMPORARY_ERROR');
    if (!retry) break;
    await new Promise((ok) => setTimeout(ok, 1500 * (i + 1)));
  }
  applyResult(rec, r);
  if (r.status === 409 && r.body?.code === 'DUPLICATE_REQUEST') {
    // La primera ya había entrado: ahora seguimos esa orden.
    rec.status = (r.body.data && r.body.data.status) || 'PROCESSING_API';
  } else if (r.timeout || r.status >= 500) {
    // No sabemos si se cobró: queda pendiente de revisar (nunca se reintenta con otra clave).
    if (!rec.orderId) rec.status = rec.status === 'SENDING' ? 'UNKNOWN' : rec.status;
  } else if (!r.body?.success) {
    rec.status = 'FAILED';
  }
  save();
  return { rec, r };
}

async function refreshOrder(rec) {
  if (!rec.orderId) return null;
  const r = await call('GET', `/catalog/orders/${encodeURIComponent(rec.orderId)}`);
  if (r.status === 200 && r.body?.success) {
    applyResult(rec, r);
    save();
  }
  return r;
}

// Muestra la orden sin la respuesta cruda completa (los códigos sí, son lo que se vende).
function publicOrder(o) {
  if (!o) return null;
  const { lastResponse, ...rest } = o;
  return { ...rest, final: FINAL.has(o.status) };
}

function errOut(res, r) {
  const status = r.status && r.status >= 400 ? r.status : 502;
  if (r.retryAfter) res.set('Retry-After', r.retryAfter);
  res.status(status).json({
    error: (r.body && (r.body.error || r.body.message)) || 'Error del proveedor.',
    code: (r.body && r.body.code) || 'ERROR',
    data: r.body && r.body.data,
  });
}

/* ------------------------- para la tienda (tienda.js) --------------------------- */
export const recargasApi = {
  isSandbox: isSandboxKey,
  wallet: () => call('GET', '/wallet'),
  catalog: getCatalog,
  validate: (body) => call('POST', '/catalog/validate', { body }),
  buy,
  refresh: refreshOrder,
  find: findOrder,
  isFinal: (status) => FINAL.has(status),
};

/* ------------------------------------- rutas ------------------------------------- */
export function mountRecargasRoutes(app, { requireAdmin } = {}) {
  const admin = requireAdmin || ((req, res) => res.status(403).json({ error: 'forbidden' }));
  const safe = (fn) => async (req, res, next) => {
    try { await fn(req, res, next); } catch (err) {
      console.error('[recargas]', req.method, req.path, err && err.message);
      if (!res.headersSent) res.status(500).json({ error: (err && err.message) || 'No se pudo completar.' });
    }
  };
  const needKey = (req, res, next) => {
    if (!isRecargasConfigured()) return res.status(503).json({ error: 'Falta RECARGAS_API_KEY en Render.', code: 'NOT_CONFIGURED' });
    next();
  };

  app.get('/api/admin/recargas/status', admin, safe(async (_req, res) => {
    if (!isRecargasConfigured()) return res.json({ configured: false });
    const r = await call('GET', '/wallet');
    res.json({
      configured: true,
      sandbox: isSandboxKey(),
      ok: r.status === 200 && !!r.body?.success,
      balance: r.body?.data?.balance ?? null,
      currency: r.body?.data?.currency ?? null,
      error: r.body?.success ? null : (r.body?.error || r.body?.message || null),
      code: r.body?.success ? null : (r.body?.code || null),
    });
  }));

  app.get('/api/admin/recargas/catalog', admin, needKey, safe(async (req, res) => {
    const r = await getCatalog(cleanStr(req.query.category, 200));
    if (r.status !== 200 || !r.body?.success) return errOut(res, r);
    res.json({ products: r.body.data });
  }));

  app.post('/api/admin/recargas/validate', admin, needKey, express.json(), safe(async (req, res) => {
    const productId = Number(req.body?.productId);
    const playerId = cleanStr(req.body?.playerId);
    if (!Number.isInteger(productId) || productId <= 0 || !playerId) return res.status(400).json({ error: 'Falta el producto o el ID.' });
    const body = { product_id: productId, service_user_id: playerId };
    const zone = cleanStr(req.body?.zoneId, 20);
    if (zone) body.zone_id = zone;
    const r = await call('POST', '/catalog/validate', { body });
    if (r.status !== 200 || !r.body?.success) return errOut(res, r);
    res.json(r.body.data);
  }));

  app.post('/api/admin/recargas/buy', admin, needKey, express.json(), safe(async (req, res) => {
    const productId = Number(req.body?.productId);
    const quantity = Math.max(1, Math.min(100, Number(req.body?.quantity) || 1));
    if (!Number.isInteger(productId) || productId <= 0) return res.status(400).json({ error: 'Producto inválido.' });
    const { rec, r } = await buy({
      productId,
      quantity,
      playerId: cleanStr(req.body?.playerId),
      zoneId: cleanStr(req.body?.zoneId, 20),
      clientName: cleanStr(req.body?.clientName),
      by: req.user ? { id: req.user.id, username: req.user.username } : null,
    });
    const ok = r.body?.success || (r.status === 409 && r.body?.code === 'DUPLICATE_REQUEST');
    if (!ok) {
      return res.status(r.status && r.status >= 400 ? r.status : 502).json({
        error: r.body?.error || r.body?.message || 'No se pudo comprar.',
        code: r.body?.code || 'ERROR',
        order: publicOrder(rec),
      });
    }
    res.json({ order: publicOrder(rec) });
  }));

  // Consulta una orden (por order_id o por la Idempotency-Key guardada) y la actualiza.
  app.get('/api/admin/recargas/orders/:id', admin, needKey, safe(async (req, res) => {
    const rec = findOrder(cleanStr(req.params.id, 255));
    if (!rec) return res.status(404).json({ error: 'No está en el registro.' });
    if (!FINAL.has(rec.status)) await refreshOrder(rec);
    res.json({ order: publicOrder(rec) });
  }));

  app.get('/api/admin/recargas/orders', admin, safe(async (req, res) => {
    const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 100));
    res.json({ orders: load().orders.slice(0, limit).map(publicOrder) });
  }));
}
