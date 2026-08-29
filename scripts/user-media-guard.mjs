/**
 * Protección de medios del usuario (audios, videos subidos, imágenes).
 * Vive en userData — nunca dentro del instalador — y solo se copia, nunca se borra en migraciones.
 */
import fs from 'node:fs';
import path from 'node:path';

export const USER_AUDIO_EXT = new Set([
  '.mp3', '.wav', '.opus', '.m4a', '.aac', '.flac', '.weba', '.wma', '.aiff', '.aif',
]);

/** .ogg puede ser audio; nunca cifrar/borrar como video. */
export const USER_VIDEO_EXT = new Set([
  '.mp4', '.webm', '.mov', '.mkv', '.m4v', '.ogv', '.avi', '.wmv', '.flv', '.ts',
]);

export const USER_IMAGE_EXT = new Set([
  '.gif', '.png', '.jpg', '.jpeg', '.webp', '.bmp', '.svg',
]);

export const VAULT_SUFFIX = '.lcv';

export const USER_MEDIA_MARKER = '.livecoins-user-media';

export function isUserAudioFile(nameOrExt) {
  const ext = String(nameOrExt || '').includes('.')
    ? path.extname(nameOrExt).toLowerCase()
    : String(nameOrExt || '').toLowerCase();
  return USER_AUDIO_EXT.has(ext) || ext === '.ogg';
}

export function isUserVideoFile(nameOrExt) {
  const ext = String(nameOrExt || '').includes('.')
    ? path.extname(nameOrExt).toLowerCase()
    : String(nameOrExt || '').toLowerCase();
  return USER_VIDEO_EXT.has(ext);
}

export function isUserImageFile(nameOrExt) {
  const ext = String(nameOrExt || '').includes('.')
    ? path.extname(nameOrExt).toLowerCase()
    : String(nameOrExt || '').toLowerCase();
  return USER_IMAGE_EXT.has(ext);
}

export function userUploadKind(nameOrExt) {
  if (isUserAudioFile(nameOrExt)) return 'audio';
  if (isUserVideoFile(nameOrExt)) return 'video';
  if (isUserImageFile(nameOrExt)) return 'image';
  return 'file';
}

export function userMediaIndexPath(dataDir) {
  return path.join(String(dataDir || ''), 'user-media-index.json');
}

function isTransientUploadName(name) {
  return String(name || '').endsWith('.tmp');
}

/** Marca la carpeta como persistente (referencia para soporte / diagnóstico). */
export function ensureUserMediaMarker(dir) {
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  const marker = path.join(dir, USER_MEDIA_MARKER);
  try {
    if (!fs.existsSync(marker)) {
      fs.writeFileSync(marker, [
        'Livecoins — medios del usuario (persistentes).',
        'Incluye audios, videos e imágenes subidos.',
        'NO borrar al actualizar o reinstalar la app.',
        `Ruta: ${path.resolve(dir)}`,
        `Creado: ${new Date().toISOString()}`,
      ].join('\n'), 'utf8');
    }
  } catch { /* ignore */ }
}

function needsCopyToDest(from, to) {
  try {
    if (!fs.existsSync(to)) return true;
    const st = fs.statSync(to);
    if (!st.isFile() || st.size === 0) return true;
    const src = fs.statSync(from);
    if (src.isFile() && src.size > st.size) return true;
    return false;
  } catch {
    return true;
  }
}

/**
 * Copia archivos desde rutas legacy → destino persistente.
 * Incluye sidecars .lcv (cifrado). Nunca borra el origen.
 */
export function migrateUserMediaDir(dest, legacyDirs, label, { log = console.log } = {}) {
  const destResolved = path.resolve(dest);
  fs.mkdirSync(destResolved, { recursive: true });
  let copied = 0;
  for (const legacyRaw of legacyDirs) {
    const legacy = path.resolve(String(legacyRaw || ''));
    if (!legacy || legacy === destResolved || !fs.existsSync(legacy)) continue;
    let entries;
    try { entries = fs.readdirSync(legacy, { withFileTypes: true }); } catch { continue; }
    for (const ent of entries) {
      if (!ent.isFile()) continue;
      if (ent.name === USER_MEDIA_MARKER) continue;
      if (isTransientUploadName(ent.name)) continue;
      const from = path.join(legacy, ent.name);
      const to = path.join(destResolved, ent.name);
      try {
        if (needsCopyToDest(from, to)) {
          fs.copyFileSync(from, to);
          copied += 1;
        }
      } catch { /* nunca borrar origen */ }
    }
  }
  if (copied) log(`  [user-media] ${copied} archivo(s) ${label} → ${destResolved}`);
  return copied;
}

/** Cuenta archivos lógicos (plain o .lcv, sin duplicar parejas). */
export function countUserMediaFiles(dir) {
  try {
    const names = fs.readdirSync(dir);
    const set = new Set(names);
    const seen = new Set();
    let n = 0;
    for (const f of names) {
      if (f === USER_MEDIA_MARKER || isTransientUploadName(f)) continue;
      let logical = f;
      if (f.endsWith(VAULT_SUFFIX)) logical = f.slice(0, -VAULT_SUFFIX.length);
      if (seen.has(logical)) continue;
      seen.add(logical);
      if (set.has(logical) || set.has(logical + VAULT_SUFFIX)) {
        try {
          const plain = path.join(dir, logical);
          const vault = path.join(dir, logical + VAULT_SUFFIX);
          const okPlain = set.has(logical) && fs.statSync(plain).isFile() && fs.statSync(plain).size > 0;
          const okVault = set.has(logical + VAULT_SUFFIX) && fs.statSync(vault).isFile() && fs.statSync(vault).size > 0;
          if (okPlain || okVault) n += 1;
        } catch { /* skip */ }
      }
    }
    return n;
  } catch { return 0; }
}

export function countUserUploadsByKind(dir) {
  const out = { audio: 0, video: 0, image: 0, other: 0 };
  try {
    const names = fs.readdirSync(dir);
    const set = new Set(names);
    const seen = new Set();
    for (const f of names) {
      if (f === USER_MEDIA_MARKER || isTransientUploadName(f)) continue;
      const logical = f.endsWith(VAULT_SUFFIX) ? f.slice(0, -VAULT_SUFFIX.length) : f;
      if (seen.has(logical)) continue;
      if (!set.has(logical) && !set.has(logical + VAULT_SUFFIX)) continue;
      seen.add(logical);
      const kind = userUploadKind(logical);
      if (kind === 'audio') out.audio += 1;
      else if (kind === 'video') out.video += 1;
      else if (kind === 'image') out.image += 1;
      else out.other += 1;
    }
  } catch { /* ignore */ }
  return out;
}

/** Índice local de subidas (referencia; no borra archivos si falta una entrada). */
export function registerUserUpload(dataDir, entry) {
  if (!dataDir || !entry?.url) return;
  const idxPath = userMediaIndexPath(dataDir);
  let idx = { version: 1, uploads: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(idxPath, 'utf8'));
    if (raw && Array.isArray(raw.uploads)) idx = raw;
  } catch { /* nuevo */ }
  const name = String(entry.name || path.basename(entry.url || ''));
  idx.uploads.push({
    url: String(entry.url),
    name,
    kind: entry.kind || userUploadKind(name),
    dir: entry.dir || 'uploads',
    at: entry.at || new Date().toISOString(),
    bytes: Math.max(0, Number(entry.bytes) || 0),
  });
  if (idx.uploads.length > 5000) idx.uploads = idx.uploads.slice(-5000);
  try {
    const tmp = idxPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(idx, null, 2));
    fs.renameSync(tmp, idxPath);
  } catch { /* ignore */ }
}

export function bootstrapUserMedia(opts) {
  const {
    uploadsDir,
    audiosDir,
    dataDir,
    legacyUploads = [],
    legacyAudios = [],
    isDesktop = false,
    log = console.log,
  } = opts || {};

  ensureUserMediaMarker(uploadsDir);
  ensureUserMediaMarker(audiosDir);
  migrateUserMediaDir(uploadsDir, legacyUploads, 'uploads', { log });
  migrateUserMediaDir(audiosDir, legacyAudios, 'audios', { log });

  if (isDesktop && (uploadsDir || audiosDir)) {
    const kinds = uploadsDir ? countUserUploadsByKind(uploadsDir) : { audio: 0, video: 0, image: 0, other: 0 };
    const a = audiosDir ? countUserMediaFiles(audiosDir) : 0;
    const parts = [];
    if (kinds.video) parts.push(`${kinds.video} video(s)`);
    if (kinds.audio) parts.push(`${kinds.audio} audio(s)`);
    if (kinds.image) parts.push(`${kinds.image} imagen(es)`);
    if (kinds.other) parts.push(`${kinds.other} otro(s)`);
    const up = parts.length ? parts.join(', ') : '0 subidas';
    log(`  [user-media] Persistente: ${up} · ${a} en biblioteca /audios`);
  }

  return { uploads: uploadsDir, audios: audiosDir, index: dataDir ? userMediaIndexPath(dataDir) : '' };
}
