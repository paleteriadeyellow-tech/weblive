// Agencias: directorio de agencias de TikTok LIVE con las que trabaja Livecoins.
// Vive en la nube (Render), igual que referidos y códigos. El .exe y la web reenvían todo con la cookie de la nube.
//
// - Usuarios: ven el mapa y el directorio, abren el perfil de cada agencia, mandan su agencia
//   para aparecer («¿Tu agencia no aparece?») y al pulsar «Unirme»/«Contactar» queda un lead.
// - Admin: crea/edita agencias, sube logo y portada, las destaca/oculta y revisa solicitudes y leads.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'agencies.json');
const IMG_DIR = path.join(DATA_DIR, 'agencies-img');
const DAY_MS = 24 * 3600 * 1000;
const MAX_LOG = 1000;
const MAX_RECENT_LEADS = 300;
const MAX_IMG_BYTES = 3 * 1024 * 1024;
const IMG_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
const IMG_FILE_RX = /^[a-f0-9]{24}\.(png|jpg|webp|gif)$/;
const ID_RX = /^[a-z0-9]{4,40}$/;
export const AGENCY_CATEGORIES = ['Batallas', 'Gaming', 'Música', 'Charla', 'Baile', 'ASMR', 'Educación', 'Comedia', 'Belleza', 'Deportes', 'Cocina', 'Arte', 'Ventas', 'Otro'];
export const AGENCY_BENEFIT_ICONS = ['trophy', 'gift', 'school', 'support', 'chart', 'game', 'star', 'money', 'users', 'rocket', 'mic', 'shield'];

let db = null;
let corruptCopied = false;

function load() {
  if (db) return db;
  let raw = null;
  try { raw = fs.readFileSync(FILE, 'utf8'); } catch (err) {
    if (err && err.code !== 'ENOENT') {
      console.error('[agencies] no se pudo leer agencies.json:', err.message);
      throw new Error('Las agencias no están disponibles en este momento. Intenta en un rato.');
    }
  }
  if (raw != null) {
    let j = null;
    try { j = JSON.parse(raw); } catch {}
    if (j && typeof j === 'object' && j.agencies && typeof j.agencies === 'object') {
      db = j;
    } else {
      // Dañado: se aparta UNA copia y no se pisa hasta revisarlo.
      if (!corruptCopied) {
        corruptCopied = true;
        const aside = `${FILE}.danado-${Date.now()}`;
        try { fs.copyFileSync(FILE, aside); } catch {}
        console.error('[agencies] agencies.json dañado; copia en', aside);
      }
      throw new Error('Las agencias no están disponibles en este momento. Avisa al administrador.');
    }
  }
  if (!db) db = { agencies: {}, applications: {}, leads: {}, log: [] };
  if (!db.applications || typeof db.applications !== 'object') db.applications = {};
  if (!db.leads || typeof db.leads !== 'object') db.leads = {};
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
const newId = (p) => `${p}${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;

/* ------------------------------- Limpieza de datos ------------------------------- */
const str = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max);
const int = (v, min, max) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= min && n <= max ? n : 0; };
const country = (v) => { const s = String(v || '').toUpperCase(); return /^[A-Z]{2}$/.test(s) ? s : ''; };
function url(v) {
  let s = str(v, 400);
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = `https://${s.replace(/^\/+/, '')}`;
  try { const u = new URL(s); return /^https?:$/.test(u.protocol) && u.hostname.includes('.') ? u.toString() : ''; } catch { return ''; }
}
const handle = (v) => str(v, 60).replace(/^https?:\/\/(www\.)?(tiktok|instagram)\.com\/@?/i, '').replace(/^@+/, '').replace(/[/?#].*$/, '').replace(/[^A-Za-z0-9._]/g, '').slice(0, 40);
const phone = (v) => { const d = String(v || '').replace(/[^\d+]/g, '').replace(/(?!^)\+/g, ''); return d.replace(/\D/g, '').length >= 7 ? d.slice(0, 20) : ''; };
const email = (v) => { const s = str(v, 120).toLowerCase(); return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s) ? s : ''; };
const img = (v) => (IMG_FILE_RX.test(String(v || '')) ? String(v) : '');

function cleanAgency(b, prev = {}) {
  const cats = Array.isArray(b.categories) ? b.categories.map((c) => str(c, 30)).filter(Boolean) : [];
  const benefits = Array.isArray(b.benefits) ? b.benefits.map((x) => ({
    icon: AGENCY_BENEFIT_ICONS.includes(x && x.icon) ? x.icon : 'star',
    label: str(x && x.label, 60),
  })).filter((x) => x.label) : [];
  const milestones = Array.isArray(b.milestones) ? b.milestones.map((x) => ({
    title: str(x && x.title, 70),
    sub: str(x && x.sub, 90),
    year: int(x && x.year, 1990, 2100) || 0,
  })).filter((x) => x.title) : [];
  return {
    name: str(b.name, 60),
    country: country(b.country),
    tagline: str(b.tagline, 220),
    about: str(b.about, 4000),
    creators: int(b.creators, 0, 10000000),
    founded: int(b.founded, 1990, 2100) || 0,
    categories: [...new Set(cats)].slice(0, 8),
    benefits: benefits.slice(0, 8),
    milestones: milestones.slice(0, 6),
    tiktok: handle(b.tiktok),
    instagram: handle(b.instagram),
    whatsapp: phone(b.whatsapp),
    email: email(b.email),
    web: url(b.web),
    joinUrl: url(b.joinUrl),
    videoUrl: url(b.videoUrl),
    logo: img(b.logo),
    banner: img(b.banner),
    featured: !!b.featured,
    status: b.status === 'active' ? 'active' : 'hidden',
    joinedAt: Number(prev.joinedAt) || 0,
  };
}

// Vista pública (lo que ve cualquier usuario).
function publicCard(a, leads) {
  return {
    id: a.id, name: a.name, country: a.country, tagline: a.tagline, creators: a.creators, founded: a.founded,
    categories: a.categories, logo: a.logo, banner: a.banner, featured: !!a.featured, joinedAt: a.joinedAt || a.createdAt,
    milestonesCount: (a.milestones || []).length,
    ...(leads ? { leads } : {}),
  };
}
function publicFull(a) {
  return {
    ...publicCard(a),
    about: a.about, benefits: a.benefits || [], milestones: a.milestones || [],
    tiktok: a.tiktok, instagram: a.instagram, whatsapp: a.whatsapp, email: a.email, web: a.web,
    joinUrl: a.joinUrl, videoUrl: a.videoUrl,
    canJoin: !!(a.joinUrl || a.whatsapp || a.tiktok || a.email || a.web),
  };
}
const sortAgencies = (list) => list.sort((x, y) => (Number(!!y.featured) - Number(!!x.featured)) || ((y.creators || 0) - (x.creators || 0)) || String(x.name).localeCompare(String(y.name)));

/* ----------------------------------- Rutas ----------------------------------- */
export function mountAgencyRoutes(app, {
  userFromRequest,
  getUserById,
  requireAdmin,
  AUTH_REMOTE,
  getRemoteCookie,
  clientIp,
} = {}) {
  const base = String(AUTH_REMOTE || '').replace(/\/+$/, '');
  const admin = requireAdmin || ((req, res) => res.status(403).json({ error: 'Solo admin.' }));
  const bigJson = express.json({ limit: '6mb' });
  const smallJson = express.json({ limit: '64kb' });
  const safe = (fn) => async (req, res, next) => {
    try { await fn(req, res, next); } catch (err) {
      console.error('[agencies]', req.method, req.path, err && err.message);
      if (!res.headersSent) {
        const msg = err && err.message && /agencias/i.test(err.message) ? err.message : 'No se pudo completar. Intenta de nuevo.';
        res.status(500).json({ error: msg });
      }
    }
  };

  // .exe / web: todo se hace en la nube con la cookie de esa cuenta. Las imágenes se sirven desde la nube.
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
      // La nube aún no tiene Agencias (versión vieja en el servidor): aviso claro en vez de un error genérico.
      if (r.status === 404 && !(data && data.error)) {
        res.status(503).json({ error: 'Agencias todavía no está disponible en el servidor. Intenta más tarde.' });
        return;
      }
      if (data && typeof data === 'object' && !Array.isArray(data)) data.imgBase = base;
      res.status(r.status).json(data);
    } catch {
      res.status(503).json({ error: 'Sin conexión con el servidor. Revisa tu internet.' });
    }
  }
  const authed = (req, res) => {
    const user = userFromRequest(req);
    if (!user) { res.status(401).json({ error: 'Inicia sesión.' }); return null; }
    return user;
  };
  const adminName = (req) => (req.user && req.user.username) || 'admin';

  // Frenos simples (en memoria) para solicitudes y leads.
  const hits = new Map();
  const recent = (key, windowMs) => {
    const now = Date.now();
    const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (list.length) hits.set(key, list); else hits.delete(key);
    return list;
  };
  const hit = (key) => {
    const now = Date.now();
    const list = hits.get(key) || [];
    list.push(now);
    hits.set(key, list);
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => now - t < DAY_MS)) hits.delete(k);
  };
  // true = ya llegó al tope (no cuenta este intento); false = se cuenta y sigue.
  const tooMany = (key, max, windowMs) => {
    if (recent(key, windowMs).length >= max) return true;
    hit(key);
    return false;
  };

  /* -------------------------------- Imágenes (públicas) -------------------------------- */
  app.get('/api/agencies/img/:file', (req, res) => {
    const file = String(req.params.file || '');
    if (!IMG_FILE_RX.test(file)) return res.status(404).end();
    if (base) return res.redirect(302, `${base}/api/agencies/img/${file}`);
    const p = path.join(IMG_DIR, file);
    if (!fs.existsSync(p)) return res.status(404).end();
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.sendFile(p);
  });

  /* ---------------------------------- Usuarios ---------------------------------- */
  app.get('/api/agencies', safe(async (req, res) => {
    if (base) return proxy(req, res, '/api/agencies');
    if (!authed(req, res)) return;
    const d = load();
    const list = sortAgencies(Object.values(d.agencies).filter((a) => a.status === 'active' && a.country).map((a) => publicCard(a)));
    const byCountry = {};
    for (const a of list) byCountry[a.country] = (byCountry[a.country] || 0) + 1;
    res.json({ ok: true, agencies: list, byCountry, categories: AGENCY_CATEGORIES, imgBase: '' });
  }));

  app.get('/api/agencies/:id', safe(async (req, res) => {
    const id = String(req.params.id || '');
    if (!ID_RX.test(id)) return res.status(404).json({ error: 'No encontramos esa agencia.' });
    if (base) return proxy(req, res, `/api/agencies/${id}`);
    const user = authed(req, res);
    if (!user) return;
    const a = load().agencies[id];
    const full = getUserById ? getUserById(user.id) : user;
    if (!a || (a.status !== 'active' && !(full && full.isAdmin))) return res.status(404).json({ error: 'No encontramos esa agencia.' });
    res.json({ ok: true, agency: publicFull(a), imgBase: '' });
  }));

  // «¿Tu agencia no aparece?»: llega a Admin › Agencias › Solicitudes.
  app.post('/api/agencies/apply', smallJson, safe(async (req, res) => {
    if (base) return proxy(req, res, '/api/agencies/apply', 'POST');
    const user = authed(req, res);
    if (!user) return;
    const ip = clientIp ? clientIp(req) : '';
    const uKey = `apply:u:${user.id}`, ipKey = ip ? `apply:ip:${ip}` : '';
    // Solo cuentan las solicitudes que sí se guardan (un correo mal escrito no gasta intentos).
    if (recent(uKey, DAY_MS).length >= 3 || (ipKey && recent(ipKey, DAY_MS).length >= 8)) {
      return res.status(429).json({ error: 'Ya enviaste varias solicitudes hoy. Te contactaremos pronto.' });
    }
    const b = req.body || {};
    const app_ = {
      country: country(b.country),
      name: str(b.name, 60),
      tiktok: handle(b.tiktok),
      email: email(b.email),
      whatsapp: phone(b.whatsapp),
      web: url(b.web),
      note: str(b.note, 600),
    };
    if (!app_.country) return res.status(400).json({ error: 'Elige el país de la agencia.' });
    if (!app_.name) return res.status(400).json({ error: 'Escribe el nombre de la agencia.' });
    if (!app_.tiktok) return res.status(400).json({ error: 'Escribe el @ de TikTok de la agencia.' });
    if (!app_.email) return res.status(400).json({ error: 'Escribe un correo de contacto válido.' });
    const d = load();
    const full = (getUserById && getUserById(user.id)) || user;
    const id = newId('s');
    d.applications[id] = { id, ...app_, userId: String(user.id), username: full.username || '', at: Date.now(), status: 'new' };
    // Se guardan las 500 más recientes.
    const ids = Object.values(d.applications).sort((x, y) => y.at - x.at).map((x) => x.id);
    for (const old of ids.slice(500)) delete d.applications[old];
    save();
    hit(uKey);
    if (ipKey) hit(ipKey);
    res.json({ ok: true, message: '¡Recibido! Revisaremos tu agencia y te escribiremos al correo que dejaste.' });
  }));

  // «Unirme» / «Contactar»: cuenta 1 por usuario, agencia y tipo al día.
  app.post('/api/agencies/lead', smallJson, safe(async (req, res) => {
    if (base) return proxy(req, res, '/api/agencies/lead', 'POST');
    const user = authed(req, res);
    if (!user) return;
    const b = req.body || {};
    const id = String(b.id || '');
    const kind = b.kind === 'contact' ? 'contact' : 'join';
    const d = load();
    const a = ID_RX.test(id) ? d.agencies[id] : null;
    if (!a || a.status !== 'active') return res.status(404).json({ error: 'No encontramos esa agencia.' });
    const L = d.leads[id] || (d.leads[id] = { join: 0, contact: 0, recent: [] });
    if (!Array.isArray(L.recent)) L.recent = [];
    const day = Math.floor(Date.now() / DAY_MS);
    const dup = L.recent.some((x) => x.userId === String(user.id) && x.kind === kind && Math.floor(x.at / DAY_MS) === day);
    if (!dup && !tooMany(`lead:u:${user.id}`, 60, DAY_MS)) {
      const full = (getUserById && getUserById(user.id)) || user;
      L[kind] = (Number(L[kind]) || 0) + 1;
      L.recent.unshift({ userId: String(user.id), username: full.username || '', kind, at: Date.now() });
      if (L.recent.length > MAX_RECENT_LEADS) L.recent.length = MAX_RECENT_LEADS;
      save();
    }
    res.json({ ok: true });
  }));

  /* ----------------------------------- Admin ----------------------------------- */
  app.get('/api/admin/agencies', admin, safe(async (req, res) => {
    if (base) return proxy(req, res, '/api/admin/agencies');
    const d = load();
    const agencies = sortAgencies(Object.values(d.agencies).map((a) => {
      const L = d.leads[a.id] || {};
      return { ...a, leads: { join: Number(L.join) || 0, contact: Number(L.contact) || 0, recent: (L.recent || []).slice(0, 30) } };
    }));
    const applications = Object.values(d.applications).sort((x, y) => y.at - x.at);
    res.json({ ok: true, agencies, applications, log: d.log.slice(0, 200), categories: AGENCY_CATEGORIES, icons: AGENCY_BENEFIT_ICONS, imgBase: '' });
  }));

  // Crear (sin id) o editar (con id).
  app.post('/api/admin/agencies/save', smallJson, admin, safe(async (req, res) => {
    if (base) return proxy(req, res, '/api/admin/agencies/save', 'POST');
    const b = (req.body && req.body.agency) || {};
    const d = load();
    const id = b.id ? String(b.id) : '';
    const prev = id ? d.agencies[id] : null;
    if (id && !prev) return res.status(404).json({ error: 'Esa agencia ya no existe.' });
    const clean = cleanAgency(b, prev || {});
    if (!clean.name) return res.status(400).json({ error: 'Escribe el nombre de la agencia.' });
    if (!clean.country) return res.status(400).json({ error: 'Elige el país.' });
    const now = Date.now();
    let a;
    if (prev) {
      a = Object.assign(prev, clean, { updatedAt: now });
    } else {
      const nid = newId('a');
      a = d.agencies[nid] = { id: nid, ...clean, createdAt: now, updatedAt: now, createdBy: adminName(req) };
    }
    if (a.status === 'active' && !a.joinedAt) a.joinedAt = now; // «Se unió a Livecoins»: la 1.ª vez que se publica
    addLog({ by: adminName(req), action: prev ? 'editar' : 'crear', agencyId: a.id, detail: `${a.name} (${a.status === 'active' ? 'publicada' : 'oculta'})` });
    save();
    res.json({ ok: true, agency: a });
  }));

  app.post('/api/admin/agencies/delete', smallJson, admin, safe(async (req, res) => {
    if (base) return proxy(req, res, '/api/admin/agencies/delete', 'POST');
    const id = String((req.body && req.body.id) || '');
    const d = load();
    const a = d.agencies[id];
    if (!a) return res.status(404).json({ error: 'Esa agencia ya no existe.' });
    delete d.agencies[id];
    addLog({ by: adminName(req), action: 'borrar', agencyId: id, detail: a.name });
    save();
    res.json({ ok: true });
  }));

  // Solicitudes: marcar revisada / descartada, o aprobar (crea la agencia oculta para completarla).
  app.post('/api/admin/agencies/application', smallJson, admin, safe(async (req, res) => {
    if (base) return proxy(req, res, '/api/admin/agencies/application', 'POST');
    const b = req.body || {};
    const d = load();
    const s = d.applications[String(b.id || '')];
    if (!s) return res.status(404).json({ error: 'Esa solicitud ya no existe.' });
    const status = ['new', 'approved', 'rejected'].includes(b.status) ? b.status : '';
    if (!status) return res.status(400).json({ error: 'Acción no válida.' });
    let agency = null;
    if (status === 'approved' && !s.agencyId) {
      const nid = newId('a');
      const now = Date.now();
      agency = d.agencies[nid] = {
        id: nid,
        ...cleanAgency({ name: s.name, country: s.country, tiktok: s.tiktok, email: s.email, whatsapp: s.whatsapp, web: s.web, status: 'hidden' }),
        createdAt: now, updatedAt: now, createdBy: adminName(req), fromApplication: s.id,
      };
      s.agencyId = nid;
    }
    s.status = status;
    s.reviewedAt = Date.now();
    s.reviewedBy = adminName(req);
    addLog({ by: adminName(req), action: `solicitud ${status}`, detail: s.name });
    save();
    res.json({ ok: true, application: s, agency });
  }));

  // Subir logo/portada (data URL). Devuelve el nombre del archivo para guardarlo en la agencia.
  app.post('/api/admin/agencies/image', bigJson, admin, safe(async (req, res) => {
    if (base) return proxy(req, res, '/api/admin/agencies/image', 'POST');
    const m = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/.exec(String((req.body && req.body.dataUrl) || ''));
    if (!m) return res.status(400).json({ error: 'Sube una imagen PNG, JPG, WEBP o GIF.' });
    const buf = Buffer.from(m[2], 'base64');
    if (!buf.length || buf.length > MAX_IMG_BYTES) return res.status(400).json({ error: 'La imagen debe pesar menos de 3 MB.' });
    const sig = buf.subarray(0, 12).toString('hex');
    const okSig = /^89504e47/.test(sig) || /^ffd8ff/.test(sig) || /^47494638/.test(sig) || (/^52494646/.test(sig) && buf.subarray(8, 12).toString() === 'WEBP');
    if (!okSig) return res.status(400).json({ error: 'Ese archivo no es una imagen válida.' });
    fs.mkdirSync(IMG_DIR, { recursive: true });
    const file = `${crypto.randomBytes(12).toString('hex')}.${IMG_TYPES[m[1]]}`;
    fs.writeFileSync(path.join(IMG_DIR, file), buf);
    res.json({ ok: true, file });
  }));
}
