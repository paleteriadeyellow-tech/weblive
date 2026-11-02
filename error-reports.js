// Reporte de errores automático: el panel (PC y web) y el servidor de la app de PC mandan sus errores a Render.
// Se agrupan por mensaje + archivo + línea (contador, usuarios, versiones) para verlos en Admin › Errores.
import fs from 'node:fs';
import crypto from 'node:crypto';

const MAX_GROUPS = 300;
const clip = (v, n) => String(v == null ? '' : v).slice(0, n);

export function createErrorStore(file) {
  let data = { groups: {} };
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (j && j.groups) data = j;
  } catch {}
  let timer = null;
  const save = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      try { fs.writeFileSync(file, JSON.stringify(data), 'utf8'); } catch (e) { console.warn('[errores] guardar:', e && e.message); }
    }, 3000);
  };

  function add(rep, who = {}) {
    const message = clip(rep && rep.message, 400).trim();
    if (!message) return { ok: false };
    const source = clip(rep.source, 200).replace(/[?#].*$/, '').replace(/^https?:\/\/[^/]+/, '');
    const line = Number(rep.line) || 0;
    const kind = rep.kind === 'server' ? 'server' : 'panel';
    const app = rep.app === 'web' ? 'web' : 'pc';
    const id = crypto.createHash('sha1').update(`${kind}|${message}|${source}|${line}`).digest('hex').slice(0, 12);
    const now = Date.now();
    let g = data.groups[id];
    if (!g) {
      g = data.groups[id] = { id, kind, message, source, line, stack: '', count: 0, firstAt: now, lastAt: now, users: [], versions: [], apps: [], view: '' };
    }
    g.count += 1;
    g.lastAt = now;
    if (rep.stack) g.stack = clip(rep.stack, 2000);
    if (rep.view) g.view = clip(rep.view, 60);
    const user = clip(who.username, 60);
    if (user && !g.users.includes(user)) { g.users.unshift(user); g.users.length = Math.min(g.users.length, 15); }
    const ver = clip(rep.version, 20);
    if (ver && !g.versions.includes(ver)) { g.versions.unshift(ver); g.versions.length = Math.min(g.versions.length, 6); }
    if (!g.apps.includes(app)) g.apps.push(app);
    // Tope: se quitan los grupos que hace más tiempo no pasan.
    const ids = Object.keys(data.groups);
    if (ids.length > MAX_GROUPS) {
      ids.sort((a, b) => data.groups[a].lastAt - data.groups[b].lastAt)
        .slice(0, ids.length - MAX_GROUPS).forEach((k) => { delete data.groups[k]; });
    }
    save();
    return { ok: true };
  }

  function list() {
    return Object.values(data.groups).sort((a, b) => b.lastAt - a.lastAt);
  }
  function clear(id) {
    if (id) delete data.groups[id];
    else data.groups = {};
    save();
    return { ok: true };
  }
  return { add, list, clear };
}

/** Límite simple por IP: N reportes por minuto (evita que un bucle llene el archivo). */
export function createRateLimit(perMinute = 30) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    const h = hits.get(key);
    if (!h || now - h.t > 60000) { hits.set(key, { t: now, n: 1 }); return true; }
    h.n += 1;
    if (hits.size > 5000) hits.clear();
    return h.n <= perMinute;
  };
}
