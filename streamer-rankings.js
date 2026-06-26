// Ranking semanal de streamers (plataforma): likes, diamantes y horas en vivo.
// Se reinicia cada domingo a las 00:00 (hora local del servidor).
import fs from 'node:fs';
import path from 'node:path';

function dayKey(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function sundayWeekRange(now = Date.now()) {
  const d = new Date(now);
  const day = d.getDay();
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate() - day, 0, 0, 0, 0).getTime();
  return [start, start + 7 * 86400000];
}

export function createStreamerRankings(dataDir) {
  const FILE = path.join(dataDir, 'streamer-rankings.json');
  let saveTimer = null;
  let data = loadFile();

  function loadFile() {
    const [ws, we] = sundayWeekRange();
    try {
      const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      if (raw.weekStart === ws) {
        return { weekStart: ws, weekEnd: we, streamers: raw.streamers || {} };
      }
    } catch { /* nuevo periodo */ }
    return { weekStart: ws, weekEnd: we, streamers: {} };
  }

  function ensureWeek() {
    const [ws, we] = sundayWeekRange();
    if (data.weekStart !== ws) {
      data = { weekStart: ws, weekEnd: we, streamers: {} };
      scheduleSave(true);
    }
  }

  function scheduleSave(immediate = false) {
    clearTimeout(saveTimer);
    const run = () => {
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

  const weekIv = setInterval(ensureWeek, 60000);
  weekIv.unref?.();

  return { record, getRankings, ensureWeek };
}
