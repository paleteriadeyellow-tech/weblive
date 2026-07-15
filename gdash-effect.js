/** Geometry Dash — webhook GET http://127.0.0.1:5721/effect */

export const GDASH_WEBHOOK_BASE = 'http://127.0.0.1:5721';

export function isGdash5721EffectUrl(url) {
  const s = String(url || '');
  return /(?:localhost|127\.0\.0\.1):5721\b/i.test(s) && /\/effect\b/i.test(s);
}

export function buildGdashEffectUrl(code, name, seconds, seq) {
  const u = new URL(`${GDASH_WEBHOOK_BASE}/effect`);
  u.searchParams.set('code', String(code || '').trim());
  const sec = Math.max(0, parseInt(seconds, 10));
  u.searchParams.set('seconds', String(Number.isFinite(sec) ? sec : 10));
  u.searchParams.set('name', String(name || 'Viewer').trim() || 'Viewer');
  u.searchParams.set('seq', String(seq != null ? seq : Date.now()));
  return u.href;
}

/** Pulso 1s + efecto real: reinicia mods que ignoran el mismo code mientras sigue activo. */
export async function fireGdashEffectRequest(code, name, seconds) {
  if (!code) return { ok: false, error: 'sin_code' };
  const sec = Math.max(1, parseInt(seconds, 10) || 10);
  const seq = Date.now();
  const opts = { cache: 'no-store', method: 'GET' };
  try {
    await fetch(buildGdashEffectUrl(code, name, 1, seq), opts);
    await new Promise((r) => setTimeout(r, 120));
    const r = await fetch(buildGdashEffectUrl(code, name, sec, seq + 1), opts);
    if (r.ok) return { ok: true };
    return { ok: false, error: `http_${r.status}` };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}
