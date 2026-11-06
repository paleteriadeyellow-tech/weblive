// Subpestañas de Admin → Usuarios: grupos que crea el admin para clasificar cuentas (agencias, etc.).
// Aquí solo viven los nombres. Cada cuenta guarda a cuál pertenece (adminGroup); sin grupo = «General».
// No toca planes, permisos ni datos de la cuenta.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const MAX_GROUPS = 30;
const MAX_NAME = 30;

function cleanName(name) {
  return String(name || '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
}

// Emoji sugerido por el nombre; el admin lo puede cambiar o quitar con el botón «Emoji».
const NAME_EMOJI = { arbol: '🌳', sf: '🎮', angel: '⭐' };
function nameKey(name) {
  return String(name || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
}
function emojiFor(g) {
  if (typeof g.emoji === 'string') return g.emoji;
  return NAME_EMOJI[nameKey(g.name)] || '';
}
/** Solo emoji, sin letras, números ni HTML: se muestra en tarjetas que ven otras personas. */
function cleanEmoji(raw) {
  const e = String(raw || '').trim();
  if (!e) return '';
  if (e.length > 12 || /[\x00-\x7f]/.test(e) || !/\p{Extended_Pictographic}/u.test(e)) return null;
  return e;
}

export function createAdminGroups(dataDir) {
  const file = path.join(dataDir, 'admin-groups.json');
  let groups = [];
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(j.groups)) groups = j.groups.filter((g) => g && g.id && g.name);
  } catch (e) {
    // Sin archivo es lo normal la primera vez. Si está dañado se aparta una copia: nunca se pierde.
    if (e && e.code !== 'ENOENT') {
      try { fs.copyFileSync(file, `${file}.danado-${Date.now()}`); } catch {}
      console.error('[admin-groups] admin-groups.json dañado; se guardó una copia aparte');
    }
  }
  function save() {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ groups }, null, 2), 'utf8');
      fs.renameSync(tmp, file);
      return true;
    } catch (e) {
      console.error('[admin-groups] no se pudo guardar:', e && e.message);
      return false;
    }
  }
  const taken = (name, exceptId) => groups.some((g) => g.id !== exceptId && g.name.toLowerCase() === name.toLowerCase());
  return {
    list: () => groups.map((g) => ({ id: g.id, name: g.name, emoji: emojiFor(g) })),
    emojiOf(id) {
      const g = groups.find((x) => x.id === id);
      return g ? emojiFor(g) : '';
    },
    setEmoji(id, raw) {
      const g = groups.find((x) => x.id === id);
      if (!g) return { error: 'Esa subpestaña ya no existe.' };
      const emoji = cleanEmoji(raw);
      if (emoji === null) return { error: 'Escribe solo un emoji (o déjalo vacío para quitarlo).' };
      const prev = g.emoji;
      g.emoji = emoji;
      if (!save()) {
        if (prev === undefined) delete g.emoji; else g.emoji = prev;
        return { error: 'No se pudo guardar en el servidor.' };
      }
      return { group: g };
    },
    has: (id) => groups.some((g) => g.id === id),
    create(rawName) {
      const name = cleanName(rawName);
      if (!name) return { error: 'Escribe un nombre.' };
      if (['todas', 'general'].includes(name.toLowerCase())) return { error: 'Ese nombre ya lo usa una pestaña fija.' };
      if (taken(name)) return { error: 'Ya existe una subpestaña con ese nombre.' };
      if (groups.length >= MAX_GROUPS) return { error: `Máximo ${MAX_GROUPS} subpestañas.` };
      const group = { id: 'g' + crypto.randomBytes(6).toString('hex'), name };
      groups.push(group);
      if (!save()) { groups.pop(); return { error: 'No se pudo guardar en el servidor.' }; }
      return { group };
    },
    rename(id, rawName) {
      const g = groups.find((x) => x.id === id);
      if (!g) return { error: 'Esa subpestaña ya no existe.' };
      const name = cleanName(rawName);
      if (!name) return { error: 'Escribe un nombre.' };
      if (['todas', 'general'].includes(name.toLowerCase())) return { error: 'Ese nombre ya lo usa una pestaña fija.' };
      if (taken(name, id)) return { error: 'Ya existe una subpestaña con ese nombre.' };
      const prev = g.name;
      g.name = name;
      if (!save()) { g.name = prev; return { error: 'No se pudo guardar en el servidor.' }; }
      return { group: g };
    },
    remove(id) {
      const idx = groups.findIndex((x) => x.id === id);
      if (idx < 0) return { error: 'Esa subpestaña ya no existe.' };
      const [g] = groups.splice(idx, 1);
      if (!save()) { groups.splice(idx, 0, g); return { error: 'No se pudo guardar en el servidor.' }; }
      return { ok: true };
    },
  };
}
