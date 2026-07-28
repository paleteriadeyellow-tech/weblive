/**
 * Búsqueda YouTube: solo vídeos incrustables (OBS / iframe).
 * La API key viene del entorno (YOUTUBE_API_KEY), nunca del usuario final.
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

  const searchUrl = 'https://www.googleapis.com/youtube/v3/search'
    + '?part=snippet&type=video&videoEmbeddable=true&maxResults=10&q='
    + encodeURIComponent(q) + '&key=' + encodeURIComponent(key);
  const r = await fetch(searchUrl);
  if (!r.ok) throw new Error('youtube_http_' + r.status);
  const d = await r.json();
  const items = Array.isArray(d.items) ? d.items : [];
  const ids = items.map((it) => it?.id?.videoId).filter(Boolean).map(String)
    .filter((id) => !exclude.has(id));
  if (!ids.length) return null;

  const metaById = new Map();
  for (const it of items) {
    const id = it?.id?.videoId;
    if (!id || exclude.has(String(id))) continue;
    const sn = it.snippet || {};
    const thumbs = sn.thumbnails || {};
    metaById.set(String(id), {
      videoId: String(id),
      title: String(sn.title || q),
      channel: String(sn.channelTitle || ''),
      thumb: thumbs.medium?.url || thumbs.default?.url || thumbs.high?.url || '',
    });
  }

  // Confirmar status.embeddable (algunos search “embeddable” aún fallan en el player).
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
      return {
        videoId: id,
        title: String(sn.title || metaById.get(id)?.title || q),
        channel: String(sn.channelTitle || metaById.get(id)?.channel || ''),
        thumb: thumbs.medium?.url || thumbs.default?.url || thumbs.high?.url
          || metaById.get(id)?.thumb || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
      };
    }
    return null;
  }

  for (const id of ids) {
    const hit = metaById.get(id);
    if (hit) return hit;
  }
  return null;
}

export async function youtubeCheckEmbeddable(videoId, apiKey) {
  const key = String(apiKey || '').trim();
  const id = String(videoId || '').trim();
  if (!key || !id) return false;
  try {
    const url = 'https://www.googleapis.com/youtube/v3/videos?part=status&id='
      + encodeURIComponent(id) + '&key=' + encodeURIComponent(key);
    const r = await fetch(url);
    if (!r.ok) return true; // no bloquear si la API falla
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
    .replace(/\b(official\s*(music\s*)?video|official\s*audio|lyric\s*video|lyrics|audio|hd|4k|vevo)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return q;
}
