// Compartir presets de acciones Minecraft con código corto (MC-XXXXXX).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_PREFIX = 'MC-';
const CODE_LEN = 6;
const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_ACTIONS = 400;
const MAX_JSON_BYTES = 600 * 1024;
const MC_GAMES = new Set([
  'minecraft', 'mcparkour', 'mckoth', 'mcfarm', 'mcshooter', 'bedrock', 'sandbox',
]);

function sharesDir(dataDir) {
  return path.join(dataDir, 'mc-preset-shares');
}

export function normalizeMcPresetShareCode(raw) {
  const s = String(raw || '').trim().toUpperCase().replace(/\s+/g, '');
  if (!s) return '';
  const body = s.startsWith(CODE_PREFIX) ? s.slice(CODE_PREFIX.length) : s;
  if (!/^[A-Z2-9]{4,12}$/.test(body)) return '';
  return CODE_PREFIX + body;
}

function randomCode() {
  let out = CODE_PREFIX;
  for (let i = 0; i < CODE_LEN; i++) {
    out += CODE_ALPHABET[crypto.randomInt(0, CODE_ALPHABET.length)];
  }
  return out;
}

function sanitizeActions(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const a of list) {
    if (!a || typeof a !== 'object') continue;
    out.push({ ...a });
    if (out.length >= MAX_ACTIONS) break;
  }
  return out;
}

function validatePayload(body) {
  const game = String(body?.game || 'minecraft').trim();
  if (!MC_GAMES.has(game)) return { error: 'Juego no válido.' };
  const actions = sanitizeActions(body?.actions);
  if (!actions.length) return { error: 'El preset no tiene acciones.' };
  const name = String(body?.presetName || body?.name || 'Preset compartido').trim().slice(0, 80) || 'Preset compartido';
  const blob = JSON.stringify({ actions });
  if (blob.length > MAX_JSON_BYTES) return { error: 'El preset es demasiado grande para compartir.' };
  return { game, actions, name };
}

function fileForCode(dataDir, code) {
  const norm = normalizeMcPresetShareCode(code);
  if (!norm) return '';
  return path.join(sharesDir(dataDir), norm + '.json');
}

function writeShareAtomic(file, obj) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(obj), 'utf8');
  fs.renameSync(tmp, file);
}

export function createMcPresetShare(dataDir, body, { by = '', ttlMs = DEFAULT_TTL_MS } = {}) {
  const v = validatePayload(body);
  if (v.error) return v;
  fs.mkdirSync(sharesDir(dataDir), { recursive: true });
  const now = Date.now();
  const expiresAt = now + Math.max(60_000, Number(ttlMs) || DEFAULT_TTL_MS);
  const record = {
    type: 'livecoins-mc-preset-share',
    version: 1,
    game: v.game,
    name: v.name,
    actions: v.actions,
    sharedAt: now,
    expiresAt,
    by: String(by || '').slice(0, 64),
  };
  for (let attempt = 0; attempt < 12; attempt++) {
    const code = randomCode();
    const file = fileForCode(dataDir, code);
    if (file && !fs.existsSync(file)) {
      writeShareAtomic(file, record);
      return {
        ok: true,
        code,
        expiresAt,
        game: v.game,
        name: v.name,
        actionCount: v.actions.length,
      };
    }
  }
  return { error: 'No se pudo generar un código único. Intenta de nuevo.' };
}

export function fetchMcPresetShare(dataDir, code) {
  const norm = normalizeMcPresetShareCode(code);
  if (!norm) return { error: 'Código no válido.' };
  const file = fileForCode(dataDir, norm);
  if (!file || !fs.existsSync(file)) return { error: 'Código no encontrado o expirado.' };
  let data;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return { error: 'El código está dañado.' }; }
  if (!data || data.type !== 'livecoins-mc-preset-share') return { error: 'Código no válido.' };
  if (data.expiresAt && Date.now() > data.expiresAt) {
    try { fs.unlinkSync(file); } catch {}
    return { error: 'Este código ya expiró.' };
  }
  const actions = sanitizeActions(data.actions);
  if (!actions.length) return { error: 'El código no contiene acciones válidas.' };
  return {
    ok: true,
    code: norm,
    game: data.game,
    name: data.name,
    actions,
    sharedAt: data.sharedAt || null,
    expiresAt: data.expiresAt || null,
    by: data.by || '',
  };
}
