/**
 * Búsqueda YouTube: solo vídeos incrustables (OBS / iframe).
 * La API key viene del entorno (YOUTUBE_API_KEY), nunca del usuario final.
 */

function isVevoChannel(channel) {
  const c = String(channel || '');
  return /\bvevo\b/i.test(c) || /VEVO$/.test(c.trim());
}

function isCoverOrKaraoke(title) {
  return /\b(cover|karaoke|piano\s*cover|guitar\s*cover|drum\s*cover|tribute|nightcore|slowed|reverb|8d\s*audio)\b/i
    .test(String(title || ''));
}

/** Penaliza VEVO / covers; premia lyrics/audio/visualizer de otros canales. */
function youtubeScoreCandidate(track, opts = {}) {
  if (!track) return -999;
  const title = String(track.title || '');
  const channel = String(track.channel || '');
  let score = 10;
  if (isVevoChannel(channel)) score -= 100;
  if (opts.preferNonVevo && isVevoChannel(channel)) score -= 50;
  if (isCoverOrKaraoke(title)) score -= 80;
  if (/\b(lyrics?|letra|official\s*audio|audio|visualizer|lyric\s*video)\b/i.test(title)) score += 25;
  if (/\b(super\s*bowl|halftime|live\s+at|vevo)\b/i.test(title)) score -= 30;
  if (/ - Topic$/i.test(channel)) score += 5; // Topic suele ir mejor en embed que VEVO
  return score;
}

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

  const searchUrl = 'https://www.googleapis.com/youtube/v3/search'
    + '?part=snippet&type=video&videoEmbeddable=true&maxResults=15&q='
    + encodeURIComponent(q) + '&key=' + encodeURIComponent(key);
  const r = await fetch(searchUrl);
  if (!r.ok) throw new Error('youtube_http_' + r.status);
  const d = await r.json();
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

  const candidates = [];
  const vUrl = 'https://www.googleapis.com/youtube/v3/videos?part=status,snippet&id='
    + ids.map(encodeURIComponent).join(',') + '&key=' + encodeURIComponent(key);
  const vr = await fetch(vUrl);
  if (vr.ok) {
    const vd = await vr.json();
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
      if (preferNonVevo && isVevoChannel(track.channel)) continue;
      candidates.push(track);
    }
  } else {
    for (const id of ids) {
      const hit = metaById.get(id);
      if (!hit) continue;
      if (preferNonVevo && isVevoChannel(hit.channel)) continue;
      candidates.push(hit);
    }
  }

  // Si filtrar VEVO dejó vacío, reintentar permitiendo VEVO (mejor algo que nada).
  if (!candidates.length && preferNonVevo) {
    return youtubeSearchEmbeddable(query, apiKey, { ...opts, preferNonVevo: false });
  }

  candidates.sort((a, b) => youtubeScoreCandidate(b, { preferNonVevo }) - youtubeScoreCandidate(a, { preferNonVevo }));
  return candidates[0] || null;
}

export async function youtubeCheckEmbeddable(videoId, apiKey) {
  const key = String(apiKey || '').trim();
  const id = String(videoId || '').trim();
  if (!key || !id) return false;
  try {
    const url = 'https://www.googleapis.com/youtube/v3/videos?part=status&id='
      + encodeURIComponent(id) + '&key=' + encodeURIComponent(key);
    const r = await fetch(url);
    if (!r.ok) return true;
    const d = await r.json();
    const it = Array.isArray(d.items) && d.items[0];
    if (!it) return false;
    return it.status?.embeddable === true;
  } catch {
    return true;
  }
}

/** Limpia títulos tipo "Artist - Song (Audio) / Official Video" para rebuscar. */
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

export { isVevoChannel, isCoverOrKaraoke };
