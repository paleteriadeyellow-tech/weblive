const INVIDIOUS_HOSTS = [
  'https://inv.nadeko.net',
  'https://vid.puffyan.us',
  'https://invidious.jing.rocks',
];

const PIPED_HOSTS = [
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.administrator.de',
  'https://api.piped.yt',
];

const YT_URL_RE = /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|v\/)|youtu\.be\/)([\w-]{11})/i;
const SHORTS_RE = /youtube\.com\/shorts\//i;
const TIMEOUT_MS = 4000;
const cache = new Map();

function parseVideoId(input) {
  const s = String(input || '').trim();
  const m = s.match(YT_URL_RE);
  if (m) return m[1];
  if (/^[\w-]{11}$/.test(s)) return s;
  return null;
}

async function fetchJson(url, ms = TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { Accept: 'application/json', 'User-Agent': 'LiveCoins-Music/1.0' },
    });
    if (!r.ok) throw new Error(String(r.status));
    return await r.json();
  } finally { clearTimeout(t); }
}

function buildVideo({ videoId, title, duration, thumbnail, channel }) {
  return {
    ok: true,
    video: {
      videoId,
      title: title || 'Sin título',
      duration: Math.max(0, Math.floor(Number(duration) || 0)),
      thumbnail: thumbnail || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      channel: channel || '',
      url: `https://www.youtube.com/watch?v=${videoId}`,
    },
  };
}

async function oembedMeta(videoId) {
  const watch = `https://www.youtube.com/watch?v=${videoId}`;
  const data = await fetchJson(`https://www.youtube.com/oembed?url=${encodeURIComponent(watch)}&format=json`, 3000);
  return {
    title: String(data.title || '').slice(0, 200),
    channel: String(data.author_name || '').slice(0, 120),
    thumbnail: data.thumbnail_url || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
  };
}

function fromInvidious(v) {
  const videoId = v.videoId || v.id;
  if (!videoId) throw new Error('inválido');
  if (v.isLive || v.liveNow) throw new Error('live');
  const thumbs = v.videoThumbnails || v.thumbnail || [];
  const thumb = Array.isArray(thumbs)
    ? (thumbs.find((t) => t.quality === 'medium')?.url || thumbs[0]?.url || '')
    : String(thumbs || '');
  return buildVideo({
    videoId,
    title: v.title,
    duration: v.lengthSeconds ?? v.duration,
    thumbnail: thumb,
    channel: v.author || v.channel || v.uploader,
  });
}

function fromPipedStream(data, videoId) {
  return buildVideo({
    videoId,
    title: data.title,
    duration: data.duration,
    thumbnail: data.thumbnailUrl || data.thumbnail,
    channel: data.uploader || data.uploaderName,
  });
}

async function fetchById(videoId) {
  if (cache.has(videoId)) return cache.get(videoId);

  const metaTasks = [
    ...PIPED_HOSTS.map((h) => () => fetchJson(`${h}/streams/${videoId}`).then((d) => fromPipedStream(d, videoId))),
    ...INVIDIOUS_HOSTS.map((h) => () => fetchJson(`${h}/api/v1/videos/${videoId}`).then(fromInvidious)),
  ];

  let result;
  try {
    result = await Promise.any(metaTasks.map((fn) => fn()));
  } catch {
    try {
      const m = await oembedMeta(videoId);
      result = buildVideo({ videoId, ...m, duration: 0 });
    } catch {
      result = buildVideo({
        videoId,
        title: `Video ${videoId}`,
        duration: 0,
        thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      });
    }
  }

  cache.set(videoId, result);
  return result;
}

async function searchQuery(query) {
  const searchTasks = [
    ...PIPED_HOSTS.slice(0, 2).map((h) => async () => {
      const data = await fetchJson(`${h}/search?q=${encodeURIComponent(query)}&filter=videos`);
      const items = data?.items || [];
      const first = items.find((v) => v.url || v.id);
      if (!first) throw new Error('empty');
      const id = parseVideoId(first.url || '') || first.id;
      return buildVideo({
        videoId: id,
        title: first.title,
        duration: first.duration,
        thumbnail: first.thumbnail,
        channel: first.uploaderName || first.uploader,
      });
    }),
    ...INVIDIOUS_HOSTS.slice(0, 2).map((h) => async () => {
      const results = await fetchJson(`${h}/api/v1/search?q=${encodeURIComponent(query)}&type=video`);
      const first = Array.isArray(results) ? results.find((v) => v.videoId) : null;
      if (!first) throw new Error('empty');
      return fromInvidious(first);
    }),
  ];

  try {
    const r = await Promise.any(searchTasks.map((fn) => fn()));
    if (r?.video?.videoId) cache.set(r.video.videoId, r);
    return r;
  } catch {
    return { ok: false, error: 'No se encontró. Pega la URL de YouTube directamente.' };
  }
}

export async function resolveVideo(query) {
  const raw = String(query || '').trim();
  if (!raw) return { ok: false, error: 'Consulta vacía' };
  if (SHORTS_RE.test(raw)) return { ok: false, error: 'YouTube Shorts no permitidos' };

  const idFromUrl = parseVideoId(raw);
  if (idFromUrl) return fetchById(idFromUrl);
  return searchQuery(raw);
}

export function validateVideo(video, cfg) {
  const max = Math.max(60, Number(cfg?.maxDuration) || 600);
  if (video.duration > 0 && video.duration > max) {
    return { ok: false, error: `Video muy largo (máx. ${Math.round(max / 60)} min)` };
  }
  return { ok: true };
}
