/**
 * Song requests YouTube (solo .exe).
 * Busca y extrae audio con InnerTube (youtubei.js): sin Data API v3 ni iframe.
 * El overlay de OBS usa <audio> apuntando a /api/youtube/stream.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import { Innertube } from 'youtubei.js';

const QUEUE_CAP = 40;
const queues = new Map();

let ytPromise = null;
function getYt() {
  if (!ytPromise) {
    ytPromise = Innertube.create().catch((err) => {
      ytPromise = null;
      throw err;
    });
  }
  return ytPromise;
}

function emptyState() {
  return { now: null, queue: [], history: [] };
}

export function getState(userId) {
  const key = String(userId || '');
  if (!queues.has(key)) queues.set(key, emptyState());
  const st = queues.get(key);
  if (st.now && !st.now.startedAt) st.now.startedAt = Date.now();
  return {
    now: st.now ? { ...st.now } : null,
    queue: st.queue.map((x) => ({ ...x })),
    history: st.history.slice(0, 20).map((x) => ({ ...x })),
  };
}

export function isKnownVideo(videoId) {
  const id = String(videoId || '').trim();
  if (!id) return false;
  for (const st of queues.values()) {
    if (st.now?.videoId === id) return true;
    if (st.queue.some((t) => t.videoId === id)) return true;
  }
  return false;
}

function nodeFromWeb(stream) {
  if (!stream) throw new Error('Sin flujo de audio');
  if (typeof stream.pipe === 'function') return stream;
  if (typeof Readable.fromWeb === 'function') return Readable.fromWeb(stream);
  throw new Error('Este Node no puede pipear el audio de YouTube');
}

function textOf(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v.text === 'string') return v.text.trim();
  if (typeof v.toString === 'function') {
    const s = v.toString();
    if (s && s !== '[object Object]') return String(s).trim();
  }
  return '';
}

function clockToSec(text) {
  const p = String(text || '').split(':').map((n) => parseInt(n, 10));
  if (!p.length || p.some((n) => !Number.isFinite(n))) return 0;
  if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2];
  if (p.length === 2) return p[0] * 60 + p[1];
  return 0;
}

function durationOf(item) {
  if (item?.duration && typeof item.duration === 'object') {
    return textOf(item.duration.text) || '';
  }
  return textOf(item?.length_text) || textOf(item?.duration) || '';
}

function thumbOf(item) {
  const best = item?.best_thumbnail || item?.best_thumbnail;
  if (best?.url) return String(best.url);
  const thumbs = item?.thumbnails;
  if (Array.isArray(thumbs) && thumbs.length) {
    const t = thumbs[thumbs.length - 1] || thumbs[0];
    if (t?.url) return String(t.url);
  }
  const img = item?.content_image?.image;
  if (Array.isArray(img) && img[0]?.url) return String(img[0].url);
  return '';
}

function mapVideo(item) {
  const kind = String(item?.content_type || item?.type || item?.constructor?.name || '');
  if (kind && /playlist|channel|reel|short/i.test(kind) && !/^Video$/i.test(kind) && kind !== 'VIDEO') return null;
  const contentId = item?.content_type === 'VIDEO' ? item?.content_id : '';
  const videoId = String(item?.video_id || item?.id || contentId || '').trim();
  if (!videoId || videoId.length < 6) return null;
  if (item?.is_live || item?.is_upcoming) return null;
  const title = textOf(item.title) || textOf(item.metadata?.title) || 'Canción';
  const author = textOf(item.author?.name) || textOf(item.author) || textOf(item.metadata?.metadata?.title) || '';
  const duration = durationOf(item);
  return { videoId, title, author, duration, durationSec: clockToSec(duration), thumb: thumbOf(item) };
}

export async function searchSongs(query) {
  const q = String(query || '').trim().slice(0, 120);
  if (q.length < 2) return [];
  const yt = await getYt();
  const res = await yt.search(q, { type: 'video' });
  const raw = [...(res.videos || []), ...(res.results || [])];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const mapped = mapVideo(item);
    if (!mapped || seen.has(mapped.videoId)) continue;
    seen.add(mapped.videoId);
    out.push(mapped);
    if (out.length >= 8) break;
  }
  return out;
}

function normUid(v) {
  return String(v || '').trim().toLowerCase().replace(/^@/, '');
}

function trackFromSearchHit(hit, requestedBy, extra = {}) {
  const duration = String(hit.duration || '');
  return {
    videoId: String(hit.videoId),
    title: String(hit.title || 'Canción'),
    author: String(hit.author || ''),
    duration,
    durationSec: Number(hit.durationSec) || clockToSec(duration),
    thumb: String(hit.thumb || ''),
    requestedBy: String(requestedBy || extra.requestedBy || 'panel').slice(0, 40),
    requestedUniqueId: normUid(extra.requestedUniqueId || hit.requestedUniqueId || ''),
    at: Date.now(),
  };
}

export async function addByQuery(userId, query, requestedBy, extra = {}) {
  const hits = await searchSongs(query);
  if (!hits.length) return { ok: false, error: 'No encontré esa canción.' };
  return addTrack(userId, { ...trackFromSearchHit(hits[0], requestedBy, extra), ...extra });
}

export function pendingByUser(userId, uniqueId) {
  const uid = normUid(uniqueId);
  if (!uid) return 0;
  const st = queues.get(String(userId || '')) || emptyState();
  let n = 0;
  if (st.now && normUid(st.now.requestedUniqueId) === uid) n += 1;
  n += st.queue.filter((t) => normUid(t.requestedUniqueId) === uid).length;
  return n;
}

export function addTrack(userId, track) {
  const key = String(userId || '');
  const st = queues.get(key) || emptyState();
  const t = trackFromSearchHit(track, track.requestedBy, track);
  if (!t.videoId) return { ok: false, error: 'Falta el video.' };
  if (st.queue.length >= QUEUE_CAP) return { ok: false, error: 'Cola llena (40).' };
  const idle = !st.now || !st.now.videoId;
  if (idle && track.autoplay !== false) {
    st.now = { ...t, startedAt: Date.now() };
    queues.set(key, st);
    return { ok: true, track: t, started: true };
  }
  st.queue.push(t);
  queues.set(key, st);
  return { ok: true, track: t, started: false };
}

export function play(userId) {
  const key = String(userId || '');
  const st = queues.get(key) || emptyState();
  if (!st.now) {
    st.now = st.queue.shift() || null;
    if (st.now) st.now.startedAt = Date.now();
  }
  queues.set(key, st);
  return getState(key);
}

function trackOwnedBy(t, uniqueId, nickname) {
  const uid = normUid(uniqueId);
  const nick = normUid(nickname);
  const id = normUid(t && t.requestedUniqueId);
  const by = normUid(t && t.requestedBy);
  if (uid && (id === uid || by === uid)) return true;
  if (nick && (id === nick || by === nick)) return true;
  return false;
}

export function revokeByUser(userId, uniqueId, nickname) {
  const key = String(userId || '');
  const uid = normUid(uniqueId);
  const st = queues.get(key) || emptyState();
  if (!uid && !normUid(nickname)) return { ok: false, error: 'Usuario inválido.' };
  for (let i = st.queue.length - 1; i >= 0; i--) {
    if (trackOwnedBy(st.queue[i], uniqueId, nickname)) {
      const removed = st.queue.splice(i, 1)[0];
      queues.set(key, st);
      return { ok: true, track: removed, skippedNow: false, ...getState(key) };
    }
  }
  if (st.now && trackOwnedBy(st.now, uniqueId, nickname)) {
    const removed = st.now;
    st.history.unshift({ ...st.now, skipped: true });
    if (st.history.length > 30) st.history.length = 30;
    st.now = st.queue.shift() || null;
    if (st.now) st.now.startedAt = Date.now();
    queues.set(key, st);
    return { ok: true, track: removed, skippedNow: true, ...getState(key) };
  }
  return { ok: false, error: 'No tienes canciones para retirar.' };
}

export function seekNow(userId, sec) {
  const key = String(userId || '');
  const st = queues.get(key) || emptyState();
  if (!st.now) return getState(key);
  const dur = Number(st.now.durationSec) || 0;
  let t = Math.max(0, Number(sec) || 0);
  if (dur > 1) t = Math.min(t, dur - 0.15);
  st.now.startedAt = Date.now() - t * 1000;
  queues.set(key, st);
  return getState(key);
}

export function skip(userId) {
  const key = String(userId || '');
  const st = queues.get(key) || emptyState();
  if (st.now) {
    st.history.unshift({ ...st.now, skipped: true });
    if (st.history.length > 30) st.history.length = 30;
  }
  st.now = st.queue.shift() || null;
  if (st.now) st.now.startedAt = Date.now();
  queues.set(key, st);
  return getState(key);
}

export function ended(userId, videoId) {
  const st = queues.get(String(userId || '')) || emptyState();
  if (!st.now) return getState(userId);
  if (videoId && st.now.videoId !== String(videoId)) return getState(userId);
  if (st.now.ending) return getState(userId);
  st.now.ending = true;
  return skip(userId);
}

export function clearQueue(userId) {
  queues.set(String(userId || ''), emptyState());
  return getState(userId);
}

function pickAndroidFile(info) {
  const all = [...(info.streaming_data?.formats || []), ...(info.streaming_data?.adaptive_formats || [])];
  return (
    all.find((f) => f.itag === 18 && f.url) ||
    all.find((f) => f.url && f.has_audio && f.has_video) ||
    all.find((f) => f.url && f.has_audio) ||
    null
  );
}

const CACHE_DIR = path.join(os.tmpdir(), 'livecoins-yt');
const audioJobs = new Map();

function pruneAudioCache() {
  try {
    if (!fs.existsSync(CACHE_DIR)) return;
    const files = fs.readdirSync(CACHE_DIR)
      .map((name) => {
        const file = path.join(CACHE_DIR, name);
        try { return { file, t: fs.statSync(file).mtimeMs }; } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => b.t - a.t);
    for (const x of files.slice(10)) {
      try { fs.unlinkSync(x.file); } catch {}
    }
  } catch {}
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) return reject(new Error('Falta ffmpeg-static'));
    const ff = spawn(ffmpegPath, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let errTxt = '';
    ff.stderr.on('data', (d) => { errTxt += String(d || ''); });
    ff.on('error', reject);
    ff.on('close', (code) => {
      if (code) reject(new Error((errTxt || ('ffmpeg ' + code)).slice(0, 180)));
      else resolve();
    });
  });
}

async function extractAudioFile(url, id) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const m4a = path.join(CACHE_DIR, id + '.m4a');
  const mp3 = path.join(CACHE_DIR, id + '.mp3');
  try {
    await runFfmpeg([
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', url,
      '-vn', '-sn', '-dn',
      '-c:a', 'copy',
      '-movflags', '+faststart',
      m4a,
    ]);
    const st = fs.statSync(m4a);
    if (st.size > 1000) return { file: m4a, mime: 'audio/mp4' };
  } catch {}
  await runFfmpeg([
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', url,
    '-vn', '-sn', '-dn',
    '-f', 'mp3', '-codec:a', 'libmp3lame', '-q:a', '5',
    mp3,
  ]);
  const st = fs.statSync(mp3);
  if (st.size < 1000) throw new Error('Audio vacío');
  return { file: mp3, mime: 'audio/mpeg' };
}

async function androidMediaUrl(videoId) {
  const yt = await getYt();
  const info = await yt.getBasicInfo(videoId, { client: 'ANDROID' });
  const status = String(info.playability_status?.status || '');
  if (status && status !== 'OK') {
    throw new Error(info.playability_status?.reason || ('YouTube: ' + status));
  }
  const fmt = pickAndroidFile(info);
  const url = String(fmt?.url || '').trim();
  if (!url) throw new Error('YouTube no dio un archivo de audio descargable');
  return url;
}

export async function openAudioFile(videoId) {
  const id = String(videoId || '').trim();
  if (!/^[a-zA-Z0-9_-]{6,20}$/.test(id)) throw new Error('ID inválido');
  const hit = [path.join(CACHE_DIR, id + '.m4a'), path.join(CACHE_DIR, id + '.mp3')]
    .map((file) => {
      try {
        const st = fs.statSync(file);
        if (st.size > 1000) return { file, mime: file.endsWith('.m4a') ? 'audio/mp4' : 'audio/mpeg', size: st.size };
      } catch {}
      return null;
    })
    .find(Boolean);
  if (hit) return hit;
  if (audioJobs.has(id)) return audioJobs.get(id);
  const job = (async () => {
    const url = await androidMediaUrl(id);
    const out = await extractAudioFile(url, id);
    pruneAudioCache();
    const st = fs.statSync(out.file);
    return { file: out.file, mime: out.mime, size: st.size };
  })();
  audioJobs.set(id, job);
  try {
    return await job;
  } finally {
    audioJobs.delete(id);
  }
}

export async function openAudioStream(videoId) {
  const { file, mime } = await openAudioFile(videoId);
  return { stream: fs.createReadStream(file), mime, length: fs.statSync(file).size };
}
