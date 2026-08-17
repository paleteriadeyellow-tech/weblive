// PayPal Checkout: Premium 1 mes (pago único, no suscripción).
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

function publicBase() {
  return String(process.env.PAYPAL_PUBLIC_BASE || process.env.RENDER_EXTERNAL_URL || 'https://livecoins.onrender.com')
    .replace(/\/+$/, '');
}

export function isConfigured() {
  return !!(CLIENT_ID && CLIENT_SECRET);
}

export function publicStatus() {
  return {
    enabled: isConfigured(),
    amount: AMOUNT,
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
  try {
    const j = JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf8'));
    if (j && typeof j === 'object') return j;
  } catch {}
  return { captures: {} };
}
function saveLedger(j) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(LEDGER_FILE, JSON.stringify(j, null, 2), 'utf8');
}

function amountOk(value, currency) {
  const got = Number(value);
  const want = Number(AMOUNT);
  if (!Number.isFinite(got) || Math.abs(got - want) > 0.05) return false;
  return String(currency || '').toUpperCase() === CURRENCY;
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
  };
}

async function fulfillCapture(info, grantPremiumDays, onGranted) {
  if (!info.captureId && !info.orderId) return { ok: false, error: 'pago incompleto' };
  if (info.status && info.status !== 'COMPLETED') return { ok: false, error: 'pago no completado' };
  if (!amountOk(info.value, info.currency)) return { ok: false, error: 'monto no válido' };
  if (!info.userId) return { ok: false, error: 'pago sin cuenta' };

  const ledger = loadLedger();
  const key = info.captureId || info.orderId;
  if (ledger.captures[key]) {
    return { ok: true, already: true, premiumUntil: ledger.captures[key].premiumUntil || 0 };
  }

  const granted = grantPremiumDays(info.userId, DAYS);
  if (!granted || granted.ok === false) {
    return { ok: false, error: (granted && granted.error) || 'no se pudo activar el plan' };
  }
  ledger.captures[key] = {
    userId: info.userId,
    orderId: info.orderId,
    captureId: info.captureId,
    at: new Date().toISOString(),
    premiumUntil: granted.premiumUntil || 0,
    skipped: !!granted.skipped,
  };
  saveLedger(ledger);
  try { onGranted && onGranted(info.userId, granted); } catch {}
  return { ok: true, granted };
}

export async function createPremiumOrder(userId) {
  if (!isConfigured()) throw new Error('PayPal no configurado');
  const base = publicBase();
  const { ok, status, data } = await paypalFetch('/v2/checkout/orders', {
    method: 'POST',
    body: {
      intent: 'CAPTURE',
      purchase_units: [{
        custom_id: String(userId),
        description: `Livecoins Premium ${DAYS} días`,
        amount: { currency_code: CURRENCY, value: AMOUNT },
      }],
      application_context: {
        brand_name: 'Livecoins',
        locale: 'es-MX',
        landing_page: 'LOGIN',
        user_action: 'PAY_NOW',
        return_url: `${base}/api/paypal/return`,
        cancel_url: `${base}/api/paypal/cancel`,
      },
    },
  });
  if (!ok || !data.id) {
    const msg = data.message || data.error_description || data.error || `PayPal ${status}`;
    throw new Error(msg);
  }
  const approveUrl = approveUrlFromOrder(data);
  if (!approveUrl) throw new Error('PayPal no devolvió enlace de pago');
  return { orderId: data.id, approveUrl };
}

export async function captureAndGrant(orderId, grantPremiumDays, onGranted) {
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
  return fulfillCapture(info, grantPremiumDays, onGranted);
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
  AUTH_REMOTE,
  getRemoteCookie,
  onGranted,
} = {}) {
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
    res.json(publicStatus());
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
      const out = await createPremiumOrder(user.id);
      res.json({ ok: true, ...out, amount: AMOUNT, currency: CURRENCY, days: DAYS });
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
      const result = await captureAndGrant(token, grantPremiumDays, onGranted);
      if (!result.ok) {
        return res.status(400).send(resultPage('Pago', `<h1>No se activó</h1><p>${result.error || 'Error al confirmar.'}</p><p><a href="/#planes">Volver a Planes</a></p>`));
      }
      res.send(resultPage('Premium', `
        <h1>Premium activado</h1>
        <p>Tu plan Premium quedó activo <b>${DAYS} días</b>.</p>
        <p>Si usas el .exe, vuelve a Livecoins y recarga el panel.</p>
        <p><a href="/#planes">Ir a Planes</a></p>
      `));
    } catch (e) {
      console.error('[paypal] return:', e && e.message);
      res.status(502).send(resultPage('Pago', `<h1>No se pudo confirmar</h1><p>${(e && e.message) || 'Error de PayPal.'}</p><p><a href="/#planes">Volver a Planes</a></p>`));
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
        await fulfillCapture(info, grantPremiumDays, onGranted);
      } else if (type === 'CHECKOUT.ORDER.APPROVED') {
        const orderId = event.resource && event.resource.id;
        if (orderId) await captureAndGrant(orderId, grantPremiumDays, onGranted);
      }
      res.json({ ok: true });
    } catch (e) {
      console.error('[paypal] webhook:', e && e.message);
      res.status(500).json({ error: 'webhook' });
    }
  });
}
