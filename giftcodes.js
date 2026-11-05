// Códigos de activación de 1 solo uso (los genera el admin; los reparten sus trabajadores).
// Vive en la nube (Render), igual que cuentas y pagos. El .exe reenvía todo con la cookie de la nube.
//
// Reglas:
// - Cada código sirve UNA vez, para UNA cuenta (el primero que lo canjea). Nadie puede reusarlo.
// - Un código puede vencer (si no se usa antes de su fecha ya no sirve).
// - Una cuenta puede canjear varios códigos: los días se suman como un pago.
// - Nunca baja de plan a nadie: si ya tiene un plan fijo (o uno mejor fijo), el código NO se gasta.
// - Solo el admin genera, anula y modifica. Todo queda en el historial (quién, cuándo, antes/después).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'giftcodes.json');
const PAY_LEDGERS = [
  { file: path.join(DATA_DIR, 'mercadopago-payments.json'), key: 'orders' },
  { file: path.join(DATA_DIR, 'paypal-payments.json'), key: 'captures' },
];
const DAY_MS = 24 * 3600 * 1000;
const CODE_ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sin 0/O ni 1/I
const CODE_LEN = 8;
const PLANS = { pro: 'PRO', premium: 'VIP', founder: 'Founder' };
const RANK = { free: 0, pro: 1, premium: 2, founder: 3 };
const MAX_LOG = 3000;
// Founder por código: da el plan mientras dure, pero NO la mensualidad Founder de por vida
// (esa es solo para quien pagó Founder). Las funciones de PRO/VIP ignoran este 3.er parámetro.
const NO_MEMBER = { noMembership: true };

let db = null;
let corruptCopied = false;

function load() {
  if (db) return db;
  let raw = null;
  try { raw = fs.readFileSync(FILE, 'utf8'); } catch (err) {
    // Existe pero no se pudo leer: NO empezar vacío (el siguiente guardado borraría los códigos).
    if (err && err.code !== 'ENOENT') {
      console.error('[giftcodes] no se pudo leer giftcodes.json:', err.message);
      throw new Error('Los códigos no están disponibles en este momento. Intenta en un rato.');
    }
  }
  if (raw != null) {
    let j = null;
    try { j = JSON.parse(raw); } catch {}
    if (j && typeof j === 'object' && j.codes && j.batches) {
      db = j;
    } else {
      // Dañado: se aparta UNA copia (nunca se pierde) y no se toca ni se pisa hasta revisarlo.
      if (!corruptCopied) {
        corruptCopied = true;
        const aside = `${FILE}.danado-${Date.now()}`;
        try { fs.copyFileSync(FILE, aside); } catch {}
        console.error('[giftcodes] giftcodes.json dañado; copia en', aside);
      }
      throw new Error('Los códigos no están disponibles en este momento. Avisa al administrador.');
    }
  }
  if (!db) db = { batches: {}, codes: {}, log: [] };
  if (!Array.isArray(db.log)) db.log = [];
  return db;
}
function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(tmp, FILE);
}
function addLog(entry) {
  const d = load();
  d.log.unshift({ at: Date.now(), ...entry });
  if (d.log.length > MAX_LOG) d.log.length = MAX_LOG;
}

/** «lc-7kq4-m9xp», «LC7KQ4M9XP» o «7KQ4M9XP» → «7KQ4M9XP». */
export function normalizeGiftCode(raw) {
  let s = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (s.length === CODE_LEN + 2 && s.startsWith('LC')) s = s.slice(2);
  return s.length === CODE_LEN ? s : '';
}
const pretty = (k) => `LC-${k.slice(0, 4)}-${k.slice(4)}`;
function randomKey() {
  const bytes = crypto.randomBytes(CODE_LEN);
  let s = '';
  for (const b of bytes) s += CODE_ABC[b % CODE_ABC.length];
  return s;
}

function codeStatus(c, batch) {
  if (!c) return 'none';
  if (c.status === 'used' || c.status === 'void') return c.status;
  if (batch && batch.expiresAt && Date.now() > batch.expiresAt) return 'expired';
  return 'free';
}
const planWord = (plan, days) => `${PLANS[plan] || plan} ${days > 0 ? `${days} día${days === 1 ? '' : 's'}` : 'fijo'}`;
const snap = (u) => ({ plan: String((u && u.plan) || 'free'), premiumUntil: Number(u && u.premiumUntil) || 0 });

/** Cuentas con pagos reales (para avisar al admin antes de quitarle días). Se lee UNA vez por consulta. */
function payingUserIds() {
  const ids = new Set();
  for (const { file, key } of PAY_LEDGERS) {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const r of (j && j[key] ? Object.values(j[key]) : [])) if (r && r.userId != null) ids.add(String(r.userId));
    } catch {}
  }
  return ids;
}

export function mountGiftCodeRoutes(app, {
  userFromRequest,
  getUserById,
  getUserPlan,
  grantProDays,
  grantPremiumDays,
  grantFounderDays,
  setUserPlan,
  shiftUserPlanDays,
  requireAdmin,
  AUTH_REMOTE,
  getRemoteCookie,
  afterRemoteChange,
  onPlanChanged,
  clientIp,
} = {}) {
  const base = String(AUTH_REMOTE || '').replace(/\/+$/, '');
  const admin = requireAdmin || ((req, res) => res.status(403).json({ error: 'Solo admin.' }));
  // Un error nunca deja la petición colgada.
  const safe = (fn) => async (req, res, next) => {
    try { await fn(req, res, next); } catch (err) {
      console.error('[giftcodes]', req.method, req.path, err && err.message);
      if (!res.headersSent) {
        const msg = err && err.message && /códigos/i.test(err.message) ? err.message : 'No se pudo completar. Intenta de nuevo.';
        res.status(500).json({ error: msg });
      }
    }
  };

  // .exe: todo se hace en la nube con la cookie de esa cuenta.
  async function proxy(req, res, pathname, method = 'GET') {
    const user = userFromRequest(req);
    if (!user) { res.status(401).json({ error: 'Inicia sesión.' }); return; }
    const cookie = getRemoteCookie ? getRemoteCookie(user.id) : '';
    if (!cookie) { res.status(503).json({ error: 'Sin sesión con la nube. Cierra sesión y vuelve a entrar.' }); return; }
    const headers = { Accept: 'application/json', Cookie: cookie };
    const ip = clientIp ? clientIp(req) : '';
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
  const planChanged = (userId) => { try { if (onPlanChanged) onPlanChanged(userId); } catch {} };

  // Freno contra adivinar códigos a lo bruto (por cuenta y por red). Solo cuentan los intentos
  // FALLIDOS: canjear bien muchos códigos (o muchos clientes en la misma red de celular) no se frena.
  const FAIL_WINDOW = 60 * 60 * 1000;
  const fails = new Map();
  const recentFails = (key) => {
    const now = Date.now();
    const list = (fails.get(key) || []).filter((t) => now - t < FAIL_WINDOW);
    if (list.length) fails.set(key, list); else fails.delete(key);
    return list.length;
  };
  const addFail = (...keys) => {
    const now = Date.now();
    for (const key of keys) {
      if (!key) continue;
      const list = (fails.get(key) || []).filter((t) => now - t < FAIL_WINDOW);
      list.push(now);
      fails.set(key, list);
    }
    if (fails.size > 5000) for (const [k, v] of fails) if (!v.some((t) => now - t < FAIL_WINDOW)) fails.delete(k);
  };

  /* ------------------------------ Canjear (usuario) ------------------------------ */
  app.post('/api/codes/redeem', express.json(), safe(async (req, res) => {
    if (base) return proxy(req, res, '/api/codes/redeem', 'POST');
    const user = userFromRequest(req);
    if (!user) return res.status(401).json({ error: 'Inicia sesión.' });
    const ip = clientIp ? clientIp(req) : '';
    const uKey = `u:${user.id}`;
    const ipKey = ip ? `ip:${ip}` : '';
    if (recentFails(uKey) >= 10 || (ipKey && recentFails(ipKey) >= 30)) {
      return res.status(429).json({ error: 'Demasiados intentos fallidos. Prueba en una hora.' });
    }
    const key = normalizeGiftCode(req.body && req.body.code);
    if (!key) {
      addFail(uKey, ipKey);
      return res.status(400).json({ error: 'Escribe el código completo (ejemplo: LC-7KQ4-M9XP).' });
    }

    // Todo lo que sigue es síncrono: nadie más puede canjear el mismo código en medio.
    const d = load();
    const c = d.codes[key];
    const batch = c ? d.batches[c.batchId] : null;
    const st = codeStatus(c, batch);
    if (st === 'none' || !batch) { addFail(uKey, ipKey); return res.status(400).json({ error: 'Ese código no existe. Revísalo.' }); }
    if (st === 'used') { addFail(uKey, ipKey); return res.status(400).json({ error: 'Este código ya fue usado.' }); }
    if (st === 'void') { addFail(uKey, ipKey); return res.status(400).json({ error: 'Este código fue anulado.' }); }
    if (st === 'expired') { addFail(uKey, ipKey); return res.status(400).json({ error: 'Este código ya venció.' }); }

    const full = (getUserById && getUserById(user.id)) || user;
    if (full.isAdmin) return res.status(400).json({ error: 'Las cuentas admin no necesitan códigos.' });
    const cur = getUserPlan ? getUserPlan(full) : String(full.plan || 'free'); // baja a Gratis si ya venció
    const curUntil = Number(full.premiumUntil) || 0;
    const curFixed = cur !== 'free' && !(curUntil > 0);
    const plan = batch.plan;
    const days = Number(batch.days) || 0;
    if (curFixed) {
      // Plan fijo: no se le suman días; un fijo solo si es MEJOR que el que tiene.
      if (days > 0 || (RANK[plan] || 0) <= (RANK[cur] || 0)) {
        return res.status(400).json({ error: 'Tu plan ya es fijo (sin vencimiento): este código no te da nada. Guárdalo, no se gastó.' });
      }
    }
    if (days === 0 && !curFixed && (RANK[cur] || 0) > (RANK[plan] || 0)) {
      return res.status(400).json({ error: `Tu plan actual es mejor que ${PLANS[plan]} fijo. El código no se gastó.` });
    }

    const before = snap(full);
    // 1) Primero se marca como USADO y se guarda en disco: aunque algo falle después, el código
    //    jamás queda libre para otra persona (si no se pudo activar el plan, se devuelve abajo).
    c.status = 'used';
    c.usedAt = Date.now();
    c.usedBy = { userId: String(user.id), username: full.username || '', email: full.email || '' };
    try { save(); } catch (err) {
      c.status = 'free'; delete c.usedAt; delete c.usedBy;
      throw err;
    }
    const undo = (msg) => {
      c.status = 'free'; delete c.usedAt; delete c.usedBy;
      try { save(); } catch {}
      return res.status(400).json({ error: msg });
    };
    // 2) Activar el plan.
    let granted;
    try {
      if (days > 0) {
        const fn = plan === 'pro' ? grantProDays : plan === 'founder' ? grantFounderDays : grantPremiumDays;
        granted = fn ? fn(user.id, days, NO_MEMBER) : { ok: false, error: 'no disponible' };
        if (!granted || granted.ok === false || granted.skipped) {
          return undo((granted && granted.error) ? `${granted.error}. El código no se gastó.` : 'No se pudo activar con tu plan actual. El código no se gastó.');
        }
      } else if (!(setUserPlan && setUserPlan(user.id, plan, 0, NO_MEMBER))) {
        return undo('No se pudo activar. El código no se gastó.');
      }
    } catch (err) {
      console.error('[giftcodes] error al activar el plan:', err && err.message);
      return undo('No se pudo activar. El código no se gastó; intenta de nuevo.');
    }
    // 3) Registro.
    const after = snap(getUserById ? getUserById(user.id) : full);
    c.grant = { plan, days, before, after };
    addLog({ by: full.username || String(user.id), action: 'canjear', code: key, batchId: c.batchId, userId: String(user.id), username: full.username || '', detail: planWord(plan, days) });
    try { save(); } catch (err) { console.error('[giftcodes] canje aplicado pero no se guardó el detalle:', key, err && err.message); }
    planChanged(user.id);
    // Si ya tenía un plan mejor, los días se sumaron a ESE plan: decirlo tal cual.
    const gotPlan = String(after.plan || plan);
    const message = days > 0 && gotPlan !== plan && PLANS[gotPlan]
      ? `¡Listo! Se sumaron ${days} día${days === 1 ? '' : 's'} a tu plan ${PLANS[gotPlan]}.`
      : `¡Listo! Se activó ${planWord(plan, days)}.`;
    res.json({ ok: true, plan, days, planName: PLANS[plan], premiumUntil: after.premiumUntil, message });
  }));

  /* --------------------------------- Admin --------------------------------- */
  // Lista completa: lotes con conteos, códigos y el historial.
  app.get('/api/admin/codes', admin, safe(async (req, res) => {
    if (base) return proxy(req, res, '/api/admin/codes');
    const d = load();
    const paying = payingUserIds();
    const paid = (id) => paying.has(String(id));
    const counts = {};
    const codes = Object.entries(d.codes).map(([key, c]) => {
      const b = d.batches[c.batchId];
      const st = codeStatus(c, b);
      const k = counts[c.batchId] || (counts[c.batchId] = { free: 0, used: 0, void: 0, expired: 0 });
      k[st] = (k[st] || 0) + 1;
      let user = null;
      if (c.usedBy && c.usedBy.userId) {
        const u = getUserById ? getUserById(c.usedBy.userId) : null;
        user = {
          ...c.usedBy,
          username: (u && u.username) || c.usedBy.username || '',
          plan: u ? String(u.plan || 'free') : '',
          premiumUntil: u ? Number(u.premiumUntil) || 0 : 0,
          exists: !!u,
          hasPayments: paid(c.usedBy.userId),
        };
      }
      return { code: pretty(key), key, batchId: c.batchId, status: st, usedAt: c.usedAt || 0, user, grant: c.grant || null };
    });
    const batches = Object.values(d.batches)
      .map((b) => ({ ...b, counts: counts[b.id] || { free: 0, used: 0, void: 0, expired: 0 } }))
      .sort((a, b) => b.createdAt - a.createdAt);
    res.json({ ok: true, batches, codes, log: d.log.slice(0, 400), plans: PLANS });
  }));

  // Generar un lote.
  app.post('/api/admin/codes/batch', express.json(), admin, safe(async (req, res) => {
    if (base) return proxy(req, res, '/api/admin/codes/batch', 'POST');
    const b = req.body || {};
    const plan = Object.prototype.hasOwnProperty.call(PLANS, b.plan) ? b.plan : '';
    const days = b.fixed ? 0 : Math.round(Number(b.days));
    const qty = Math.round(Number(b.qty));
    const validDays = Math.round(Number(b.validDays) || 0);
    const recipient = String(b.recipient || '').trim().slice(0, 60);
    const note = String(b.note || '').trim().slice(0, 140);
    if (!plan) return res.status(400).json({ error: 'Elige el plan.' });
    if (!b.fixed && !(days >= 1 && days <= 3650)) return res.status(400).json({ error: 'Días: de 1 a 3650 (o marca «Fijo»).' });
    if (!(qty >= 1 && qty <= 500)) return res.status(400).json({ error: 'Cantidad: de 1 a 500 códigos.' });
    if (!(validDays >= 0 && validDays <= 3650)) return res.status(400).json({ error: 'Vence en: de 0 (no vence) a 3650 días.' });
    if (!recipient) return res.status(400).json({ error: 'Escribe para quién son (el nombre de quien los reparte).' });
    const d = load();
    const id = `b${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
    const now = Date.now();
    const adminName = (req.user && req.user.username) || 'admin';
    d.batches[id] = { id, plan, days, qty, recipient, note, createdAt: now, createdBy: adminName, expiresAt: validDays > 0 ? now + validDays * DAY_MS : 0 };
    const out = [];
    for (let i = 0; i < qty; i++) {
      let k = randomKey();
      while (d.codes[k]) k = randomKey();
      d.codes[k] = { batchId: id, status: 'free', createdAt: now };
      out.push(pretty(k));
    }
    addLog({ by: adminName, action: 'crear', batchId: id, detail: `${qty} × ${planWord(plan, days)} · para ${recipient}${validDays ? ` · vencen en ${validDays} días` : ''}` });
    save();
    res.json({ ok: true, batch: d.batches[id], codes: out });
  }));

  // Anular códigos SIN usar (uno, varios o todos los libres de un lote).
  app.post('/api/admin/codes/void', express.json(), admin, safe(async (req, res) => {
    if (base) return proxy(req, res, '/api/admin/codes/void', 'POST');
    const d = load();
    const b = req.body || {};
    let keys = [];
    if (b.batchId && d.batches[b.batchId]) {
      keys = Object.keys(d.codes).filter((k) => d.codes[k].batchId === b.batchId);
    } else if (Array.isArray(b.codes)) {
      keys = b.codes.map(normalizeGiftCode).filter(Boolean);
    }
    const adminName = (req.user && req.user.username) || 'admin';
    let n = 0;
    for (const k of keys) {
      const c = d.codes[k];
      if (!c || codeStatus(c, d.batches[c.batchId]) !== 'free') continue; // usados / vencidos / anulados: no se tocan
      c.status = 'void';
      c.voidAt = Date.now();
      c.voidBy = adminName;
      n++;
      addLog({ by: adminName, action: 'anular', code: k, batchId: c.batchId, detail: 'código sin usar anulado' });
    }
    if (n) save();
    res.json({ ok: true, voided: n });
  }));

  // Modificar el plan de quien canjeó un código: +días, −días, fijo o quitar.
  app.post('/api/admin/codes/adjust', express.json(), admin, safe(async (req, res) => {
    if (base) return proxy(req, res, '/api/admin/codes/adjust', 'POST');
    const d = load();
    const b = req.body || {};
    const key = normalizeGiftCode(b.code);
    const c = key ? d.codes[key] : null;
    if (!c || c.status !== 'used' || !c.usedBy) return res.status(400).json({ error: 'Ese código no ha sido canjeado.' });
    const userId = c.usedBy.userId;
    const u = getUserById ? getUserById(userId) : null;
    if (!u) return res.status(400).json({ error: 'La cuenta que lo canjeó ya no existe.' });
    if (u.isAdmin) return res.status(400).json({ error: 'No se modifican cuentas admin desde aquí.' });
    const action = String(b.action || '');
    const plan = (c.grant && c.grant.plan) || (d.batches[c.batchId] && d.batches[c.batchId].plan) || 'premium';
    const before = snap(u);
    let r;
    let detail = '';
    if (action === 'add' || action === 'sub') {
      const n = Math.round(Number(b.days));
      if (!(n >= 1 && n <= 3650)) return res.status(400).json({ error: 'Días: de 1 a 3650.' });
      if (action === 'add') {
        if (getUserPlan) getUserPlan(u); // si ya venció, queda en Gratis y se le da el plan del código
        const curUntil = Number(u.premiumUntil) || 0;
        if (String(u.plan) !== 'free' && curUntil > 0 && shiftUserPlanDays) {
          r = shiftUserPlanDays(userId, n);
        } else if (String(u.plan) !== 'free' && !(curUntil > 0)) {
          return res.status(400).json({ error: 'Su plan es fijo: no necesita días.' });
        } else {
          const fn = plan === 'pro' ? grantProDays : plan === 'founder' ? grantFounderDays : grantPremiumDays;
          r = fn ? fn(userId, n, NO_MEMBER) : { ok: false };
        }
        detail = `+${n} días`;
      } else {
        r = shiftUserPlanDays ? shiftUserPlanDays(userId, -n) : { ok: false, error: 'no disponible' };
        detail = `−${n} días`;
      }
    } else if (action === 'fixed') {
      const target = Object.prototype.hasOwnProperty.call(PLANS, b.plan) ? b.plan : plan;
      r = { ok: setUserPlan ? setUserPlan(userId, target, 0, NO_MEMBER) : false };
      detail = `${PLANS[target]} fijo`;
    } else if (action === 'remove') {
      r = { ok: setUserPlan ? setUserPlan(userId, 'free', 0) : false };
      detail = 'plan quitado (Gratis)';
    } else {
      return res.status(400).json({ error: 'Acción no válida.' });
    }
    if (!r || r.ok === false || r.skipped) return res.status(400).json({ error: (r && r.error) || 'No se pudo aplicar.' });
    const after = snap(getUserById(userId));
    const adminName = (req.user && req.user.username) || 'admin';
    addLog({ by: adminName, action, code: key, batchId: c.batchId, userId: String(userId), username: u.username || '', detail, before, after });
    save();
    planChanged(userId);
    res.json({ ok: true, before, after });
  }));
}
