/**
 * Búsqueda YouTube: solo vídeos incrustables (OBS / iframe).
 * Prefiere letras (lyrics/letra), evita covers/karaoke y canales VEVO.
 * La API key viene del entorno (YOUTUBE_API_KEY).
 */

function isVevoChannel(channel) {
  const c = String(channel || '');
  return /\bvevo\b/i.test(c) || /VEVO$/i.test(c.trim());
}

function isCoverOrKaraoke(title) {
  return /\b(cover|karaoke|piano\s*cover|guitar\s*cover|drum\s*cover|tribute|nightcore|slowed|reverb|8d\s*audio)\b/i
    .test(String(title || ''));
}

function isLyricsTitle(title) {
  return /\b(lyrics?|letra|lyric\s*video|letra\s*oficial|con\s*letra)\b/i.test(String(title || ''));
}

function youtubeScoreCandidate(track, opts = {}) {
  if (!track) return -999;
  const title = String(track.title || '');
  const channel = String(track.channel || '');
  let score = 10;
  if (isCoverOrKaraoke(title)) score -= 200;
  if (isVevoChannel(channel)) score -= (opts.preferNonVevo !== false ? 80 : 20);
  if (isLyricsTitle(title)) score += 60;
  if (/\b(official\s*audio|audio\s*oficial|visualizer)\b/i.test(title)) score += 20;
  if (/\b(super\s*bowl|halftime|live\s+at|vevo|official\s*music\s*video)\b/i.test(title)) score -= 25;
  if (/ - Topic$/i.test(channel)) score += 8;
  return score;
}

async function youtubeApiJson(url) {
  const r = await fetch(url);
  const text = await r.text().catch(() => '');
  let d = null;
  try { d = text ? JSON.parse(text) : null; } catch {}
  if (!r.ok) {
    const reason = d?.error?.errors?.[0]?.reason || d?.error?.message || text.slice(0, 120);
    throw new Error('youtube_http_' + r.status + (reason ? ':' + reason : ''));
  }
  return d || {};
}

/**
 * @param {string} query
 * @param {string} apiKey
 * @param {{ excludeIds?: string[], preferNonVevo?: boolean, allowCover?: boolean, preferLyrics?: boolean }} opts
 */
export async function youtubeSearchEmbeddable(query, apiKey, opts = {}) {
  const key = String(apiKey || '').trim();
  if (!key) throw new Error('missing_api_key');
  const q = String(query || '').trim();
  if (!q) return null;
  const exclude = new Set(
    (Array.isArray(opts.excludeIds) ? opts.excludeIds : [])
      .map((x) => String(x || '').trim())
      .filter(Boolean)
  );
  const preferNonVevo = opts.preferNonVevo !== false;
  const allowCover = !!opts.allowCover;
  const preferLyrics = opts.preferLyrics !== false;

  const searchUrl = 'https://www.googleapis.com/youtube/v3/search'
    + '?part=snippet&type=video&videoEmbeddable=true&maxResults=15&q='
    + encodeURIComponent(q) + '&key=' + encodeURIComponent(key);
  const d = await youtubeApiJson(searchUrl);
  const items = Array.isArray(d.items) ? d.items : [];
  if (!items.length) return null;

  const metaById = new Map();
  for (const it of items) {
    const id = it?.id?.videoId;
    if (!id || exclude.has(String(id))) continue;
    const sn = it.snippet || {};
    const thumbs = sn.thumbnails || {};
    const track = {
      videoId: String(id),
      title: String(sn.title || q),
      channel: String(sn.channelTitle || ''),
      thumb: thumbs.medium?.url || thumbs.default?.url || thumbs.high?.url || '',
    };
    if (!allowCover && isCoverOrKaraoke(track.title)) continue;
    metaById.set(String(id), track);
  }
  const ids = [...metaById.keys()];
  if (!ids.length) return null;

  let candidates = [];
  try {
    const vUrl = 'https://www.googleapis.com/youtube/v3/videos?part=status,snippet&id='
      + ids.map(encodeURIComponent).join(',') + '&key=' + encodeURIComponent(key);
    const vd = await youtubeApiJson(vUrl);
    for (const it of (vd.items || [])) {
      if (it?.status?.embeddable !== true) continue;
      const id = String(it.id || '');
      if (exclude.has(id)) continue;
      const sn = it.snippet || {};
      const thumbs = sn.thumbnails || {};
      const track = {
        videoId: id,
        title: String(sn.title || metaById.get(id)?.title || q),
        channel: String(sn.channelTitle || metaById.get(id)?.channel || ''),
        thumb: thumbs.medium?.url || thumbs.default?.url || thumbs.high?.url
          || metaById.get(id)?.thumb || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
      };
      if (!allowCover && isCoverOrKaraoke(track.title)) continue;
      candidates.push(track);
    }
  } catch {
    candidates = [...metaById.values()];
  }

  if (!candidates.length) return null;

  // Preferir no-VEVO si hay alguno; si no, usar lo que haya.
  let pool = candidates;
  if (preferNonVevo) {
    const nonVevo = candidates.filter((t) => !isVevoChannel(t.channel));
    if (nonVevo.length) pool = nonVevo;
  }
  // Preferir letras si hay alguna en el pool.
  if (preferLyrics) {
    const lyrics = pool.filter((t) => isLyricsTitle(t.title));
    if (lyrics.length) pool = lyrics;
  }

  pool.sort((a, b) => youtubeScoreCandidate(b, { preferNonVevo }) - youtubeScoreCandidate(a, { preferNonVevo }));
  return pool[0] || null;
}

/** Búsqueda para !play: prioriza letras / letra, luego audio, luego genérico. */
export async function youtubeSearchForPlay(query, apiKey, opts = {}) {
  const base = String(query || '').trim();
  if (!base) return null;
  const tries = [];
  if (!/\b(lyrics?|letra)\b/i.test(base)) {
    tries.push(base + ' lyrics');
    tries.push(base + ' letra');
    tries.push(base + ' lyric video');
  }
  tries.push(base + ' official audio');
  tries.push(base);
  let lastErr = null;
  for (const q of tries) {
    try {
      const track = await youtubeSearchEmbeddable(q, apiKey, {
        ...opts,
        preferNonVevo: true,
        allowCover: false,
        preferLyrics: true,
      });
      if (track) return track;
    } catch (e) {
      lastErr = e;
      // Si la key/cuota falla, no seguir gastando cuota.
      const msg = String(e?.message || e);
      if (msg.includes('missing_api_key') || msg.includes('quota') || msg.includes('403') || msg.includes('400')) {
        throw e;
      }
    }
  }
  if (lastErr) throw lastErr;
  return null;
}

export async function youtubeCheckEmbeddable(videoId, apiKey) {
  const key = String(apiKey || '').trim();
  const id = String(videoId || '').trim();
  if (!key || !id) return false;
  try {
    const d = await youtubeApiJson(
      'https://www.googleapis.com/youtube/v3/videos?part=status&id='
      + encodeURIComponent(id) + '&key=' + encodeURIComponent(key)
    );
    const it = Array.isArray(d.items) && d.items[0];
    if (!it) return false;
    return it.status?.embeddable === true;
  } catch {
    return true;
  }
}

export function youtubeAltQueryFromTitle(title) {
  let q = String(title || '').trim();
  if (!q) return '';
  q = q
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\b(official\s*(music\s*)?video|official\s*audio|lyric\s*video|lyrics|letra|audio|hd|4k|vevo|visualizer|clean|hq)\b/gi, ' ')
    .replace(/\b(super\s*bowl|halftime|live\s+at)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return q;
}

export { isVevoChannel, isCoverOrKaraoke, isLyricsTitle };
