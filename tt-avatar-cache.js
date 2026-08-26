// Copia local permanente de avatares TikTok (por @usuario).
// Las URLs del CDN caducan; el archivo en disco no se borra nunca.
import fs from 'node:fs';
import path from 'node:path';

const IMG_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
  Referer: 'https://www.tiktok.com/',
};

const inflightByDir = new Map();

export function avatarUserKey(raw) {
  return String(raw || '').replace(/^@/, '').toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 64);
}

function mimeForExt(ext) {
  if (ext === 'png') return 'image/png';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'gif') return 'image/gif';
  return 'image/jpeg';
}

function extFromCt(ct) {
  const s = String(ct || '').toLowerCase();
  if (s.includes('png')) return 'png';
  if (s.includes('webp')) return 'webp';
  if (s.includes('gif')) return 'gif';
  return 'jpg';
}

function sniffCt(buf) {
  if (!buf || buf.length < 12) return '';
  if (buf[0] === 0xFF && buf[1] === 0xD8) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
    && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp';
  return '';
}

function avatarDir(dataDir) {
  const dir = path.join(String(dataDir || ''), 'tt-avatars');
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  return dir;
}

export function findCachedAvatar(dataDir, user) {
  const key = avatarUserKey(user);
  if (!key || !dataDir) return null;
  const dir = avatarDir(dataDir);
  for (const ext of ['jpg', 'jpeg', 'png', 'webp', 'gif']) {
    const fp = path.join(dir, `${key}.${ext}`);
    try {
      if (fs.existsSync(fp) && fs.statSync(fp).size > 32) {
        return { fp, ext, ct: mimeForExt(ext === 'jpeg' ? 'jpg' : ext) };
      }
    } catch { /* ignore */ }
  }
  return null;
}

export async function downloadAvatarBuffer(url) {
  let u = String(url || '').trim();
  if (u.startsWith('//')) u = 'https:' + u;
  if (!/^https?:\/\//i.test(u)) return null;
  const r = await fetch(u, { redirect: 'follow', headers: IMG_HEADERS });
  if (!r.ok) return null;
  const buf = Buffer.from(await r.arrayBuffer());
  if (!buf.length || buf.length > 4 * 1024 * 1024) return null;
  let ct = String(r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const sniff = sniffCt(buf);
  if (!/^image\//i.test(ct)) {
    if (!sniff) return null;
    ct = sniff;
  } else if (sniff) {
    ct = sniff;
  }
  return { buf, ct };
}

export async function persistViewerAvatar(dataDir, user, url) {
  const key = avatarUserKey(user);
  if (!key || !dataDir || !url) return false;
  try {
    const img = await downloadAvatarBuffer(url);
    if (!img) return false;
    const ext = extFromCt(img.ct);
    const dest = path.join(avatarDir(dataDir), `${key}.${ext}`);
    fs.writeFileSync(dest, img.buf);
    return true;
  } catch {
    return false;
  }
}

function inflightMap(dataDir) {
  const k = String(dataDir || '');
  if (!inflightByDir.has(k)) inflightByDir.set(k, new Map());
  return inflightByDir.get(k);
}

export async function ensureViewerAvatar(dataDir, user, { hintUrl, refresh, lookupTikTok } = {}) {
  const key = avatarUserKey(user);
  if (!key || !dataDir) return null;
  if (!refresh) {
    const hit = findCachedAvatar(dataDir, key);
    if (hit) return hit;
  }
  const pending = inflightMap(dataDir);
  if (pending.has(key)) return pending.get(key);
  const job = (async () => {
    if (hintUrl) {
      const ok = await persistViewerAvatar(dataDir, key, hintUrl);
      if (ok) return findCachedAvatar(dataDir, key);
    }
    if (typeof lookupTikTok === 'function') {
      let url = '';
      try { url = await lookupTikTok(key); } catch { url = ''; }
      if (url) {
        const ok = await persistViewerAvatar(dataDir, key, url);
        if (ok) return findCachedAvatar(dataDir, key);
      }
    }
    return findCachedAvatar(dataDir, key);
  })().finally(() => pending.delete(key));
  pending.set(key, job);
  return job;
}

export function sendCachedAvatar(res, cached) {
  if (!cached?.fp) return false;
  res.set('Content-Type', cached.ct || 'image/jpeg');
  res.set('Cache-Control', 'public, max-age=604800');
  res.set('Access-Control-Allow-Origin', '*');
  fs.createReadStream(cached.fp).pipe(res);
  return true;
}
