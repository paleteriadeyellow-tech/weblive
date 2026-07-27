// Ranking semanal de streamers (plataforma): likes, diamantes y horas en vivo.

// Semana lun → dom; se reinicia cada lunes a las 00:00 (hora local del servidor).

import fs from 'node:fs';

import path from 'node:path';



function dayKey(ts = Date.now()) {

  const d = new Date(ts);

  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

}



function dayKeyToTs(dk) {

  const [y, mo, d] = String(dk).split('-').map(Number);

  return new Date(y, mo - 1, d, 0, 0, 0, 0).getTime();

}



/** Semana calendario lunes 00:00 → siguiente lunes 00:00 (alineado con la línea de tiempo lun→dom). */

export function mondayWeekRange(now = Date.now()) {

  const d = new Date(now);

  const day = d.getDay();

  const mondayOffset = day === 0 ? -6 : 1 - day;

  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate() + mondayOffset, 0, 0, 0, 0).getTime();

  return [start, start + 7 * 86400000];

}



/** @deprecated Usar mondayWeekRange */

export function sundayWeekRange(now = Date.now()) {

  return mondayWeekRange(now);

}



export function createStreamerRankings(dataDir) {

  const FILE = path.join(dataDir, 'streamer-rankings.json');

  let saveTimer = null;

  let data = loadFile();



  function pruneStreamerDays(s, ws, we) {

    const days = {};

    for (const [dk, dv] of Object.entries(s.days || {})) {

      const t = dayKeyToTs(dk);

      if (t >= ws && t < we) days[dk] = dv;

    }

    let likesWeek = 0;

    let diamondsWeek = 0;

    let streamMsWeek = 0;

    for (const dv of Object.values(days)) {

      likesWeek += dv.likes || 0;

      diamondsWeek += dv.diamonds || 0;

      streamMsWeek += dv.streamMs || 0;

    }

    if (!likesWeek && !diamondsWeek && !streamMsWeek) return null;

    return { ...s, likesWeek, diamondsWeek, streamMsWeek, days };

  }



  function loadFile() {

    const [ws, we] = mondayWeekRange();

    try {

      const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));

      if (raw.weekStart === ws) {

        return { weekStart: ws, weekEnd: we, streamers: raw.streamers || {} };

      }

      // Migración: conservar días que caigan en la semana actual (p. ej. tras cambiar dom→lun).

      if (raw.streamers && Object.keys(raw.streamers).length) {

        const streamers = {};

        for (const [key, s] of Object.entries(raw.streamers)) {

          const kept = pruneStreamerDays(s, ws, we);

          if (kept) streamers[key] = kept;

        }

        if (Object.keys(streamers).length) {

          return { weekStart: ws, weekEnd: we, streamers };

        }

      }

    } catch { /* nuevo periodo */ }

    return { weekStart: ws, weekEnd: we, streamers: {} };

  }



  function ensureWeek() {

    const [ws, we] = mondayWeekRange();

    if (data.weekStart === ws) return;

    const streamers = {};

    for (const [key, s] of Object.entries(data.streamers || {})) {

      const kept = pruneStreamerDays(s, ws, we);

      if (kept) streamers[key] = kept;

    }

    data = { weekStart: ws, weekEnd: we, streamers };

    scheduleSave(true);

  }



  function scheduleSave(immediate = false) {

    clearTimeout(saveTimer);

    const run = () => {

      saveTimer = null;

      try {

        fs.mkdirSync(dataDir, { recursive: true });

        fs.writeFileSync(FILE, JSON.stringify(data, null, 2));

      } catch (e) {

        console.error('[streamer-rankings] save:', e.message);

      }

    };

    if (immediate) run();

    else saveTimer = setTimeout(run, 400);

  }



  function flush() {

    clearTimeout(saveTimer);

    saveTimer = null;

    try {

      fs.mkdirSync(dataDir, { recursive: true });

      fs.writeFileSync(FILE, JSON.stringify(data, null, 2));

    } catch (e) {

      console.error('[streamer-rankings] flush:', e.message);

    }

  }



  function record(payload) {

    const {

      userId, username, tiktok, nickname, photo,

      likesDelta = 0, diamondsDelta = 0, streamMsDelta = 0,

    } = payload || {};

    if (!userId) return;

    if (!(likesDelta > 0 || diamondsDelta > 0 || streamMsDelta > 0)) return;

    ensureWeek();

    const key = String(userId);

    const s = data.streamers[key] || {

      userId: key, username: '', tiktok: '', nickname: '', photo: '',

      likesWeek: 0, diamondsWeek: 0, streamMsWeek: 0, days: {},

    };

    if (username) s.username = username;

    if (tiktok) s.tiktok = tiktok;

    if (nickname) s.nickname = nickname;

    if (photo) s.photo = photo;

    const dk = dayKey();

    if (!s.days[dk]) s.days[dk] = { likes: 0, diamonds: 0, streamMs: 0 };

    if (likesDelta > 0) { s.likesWeek += likesDelta; s.days[dk].likes += likesDelta; }

    if (diamondsDelta > 0) { s.diamondsWeek += diamondsDelta; s.days[dk].diamonds += diamondsDelta; }

    if (streamMsDelta > 0) { s.streamMsWeek += streamMsDelta; s.days[dk].streamMs += streamMsDelta; }

    data.streamers[key] = s;

    scheduleSave();

  }



  function getRankings({ type = 'likes', limit = 10 } = {}) {

    ensureWeek();

    const field = type === 'diamonds' ? 'diamondsWeek' : 'likesWeek';

    const arr = Object.values(data.streamers);

    arr.sort((a, b) => (b[field] - a[field]) || (b.streamMsWeek - a.streamMsWeek) || a.username.localeCompare(b.username));

    const lim = Math.max(1, Math.min(100, Number(limit) || 10));

    return {

      weekStart: data.weekStart,

      weekEnd: data.weekEnd,

      resetAt: data.weekEnd,

      now: Date.now(),

      type,

      entries: arr.slice(0, lim).map((s, i) => ({

        rank: i + 1,

        userId: s.userId,

        username: s.username,

        tiktok: s.tiktok,

        nickname: s.nickname || s.tiktok || s.username,

        photo: s.photo,

        likesWeek: s.likesWeek || 0,

        diamondsWeek: s.diamondsWeek || 0,

        streamHours: Math.round((s.streamMsWeek || 0) / 36000) / 100,

        days: s.days || {},

      })),

    };

  }



  function getDayTopUserId(dk = dayKey()) {
    ensureWeek();
    let bestId = null;
    let bestMs = 0;
    for (const s of Object.values(data.streamers || {})) {
      const ms = Number(s?.days?.[dk]?.streamMs) || 0;
      if (ms > bestMs) {
        bestMs = ms;
        bestId = s.userId || null;
      }
    }
    // Al menos 30 min de live ese día para contar como #1.
    if (bestMs < 30 * 60 * 1000) return null;
    return bestId ? String(bestId) : null;
  }

  const weekIv = setInterval(ensureWeek, 60000);

  weekIv.unref?.();



  return { record, getRankings, ensureWeek, flush, getDayTopUserId };

}

