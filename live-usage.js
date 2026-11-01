/**
 * Tiempo en live por usuario y por mes (para el panel admin: «quién usó más Livecoins»).
 * Mientras alguien está conectado a su live, Livecoins manda un ping cada minuto; aquí se suma
 * el tiempo entre pings. Un hueco de más de 5 min cuenta como un live nuevo (no suma ese hueco).
 * Se guarda en un JSON: { "2026-11": { "<userId>": { ms, lives, lastAt, tiktok } } }. Se conservan 13 meses.
 */
import fs from 'node:fs';

const MAX_STEP_MS = 90 * 1000;     // lo máximo que suma un ping (si se atrasó, no se infla)
const NEW_LIVE_GAP_MS = 5 * 60 * 1000;
const KEEP_MONTHS = 13;

export function monthKey(t = Date.now()) {
  // Hora de México (UTC-6) para que el mes cambie a medianoche de allá, no a las 6 pm.
  const d = new Date(t - 6 * 3600 * 1000);
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
}

export function createLiveUsageStore(filePath) {
  let data = {};
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (raw && typeof raw === 'object') data = raw;
  } catch { /* sin archivo */ }

  let saveTimer = null;
  function persist() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      const months = Object.keys(data).sort();
      while (months.length > KEEP_MONTHS) delete data[months.shift()];
      try { fs.writeFile(filePath, JSON.stringify(data), () => {}); } catch { /* ignore */ }
    }, 5000);
  }

  function ping(userId, opts = {}) {
    const uid = String(userId || '').trim();
    if (!uid) return { ok: false };
    const now = Number(opts.now) || Date.now();
    const mk = monthKey(now);
    const month = data[mk] || (data[mk] = {});
    const rec = month[uid] || (month[uid] = { ms: 0, lives: 0, lastAt: 0, tiktok: '' });
    // El último ping pudo ser el mes pasado: ese hueco ya no cuenta aquí.
    let last = rec.lastAt;
    if (!last) {
      const prev = data[monthKey(now - NEW_LIVE_GAP_MS)]?.[uid];
      if (prev && now - prev.lastAt < NEW_LIVE_GAP_MS) last = prev.lastAt;
    }
    const gap = last ? now - last : Infinity;
    if (gap > NEW_LIVE_GAP_MS) rec.lives += 1;
    else if (gap > 0) rec.ms += Math.min(gap, MAX_STEP_MS);
    rec.lastAt = now;
    const tk = String(opts.tiktok || '').replace(/^@+/, '').trim().slice(0, 40);
    if (tk) rec.tiktok = tk;
    persist();
    return { ok: true };
  }

  /** Ranking de un mes (por defecto el actual), de más a menos minutos. */
  function ranking(mk = monthKey()) {
    const month = data[mk] || {};
    return Object.entries(month)
      .map(([userId, r]) => ({ userId, ms: r.ms || 0, lives: r.lives || 0, lastAt: r.lastAt || 0, tiktok: r.tiktok || '' }))
      .sort((a, b) => b.ms - a.ms);
  }

  function months() { return Object.keys(data).sort().reverse(); }

  return { ping, ranking, months };
}
