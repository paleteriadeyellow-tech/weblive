/**
 * Proxy ElevenLabs TTS / clonado de voz.
 * La API key la aporta el creador en cada petición (no usamos key de Livecoins).
 */
const EL_BASE = 'https://api.elevenlabs.io';
const DEFAULT_MODEL = 'eleven_multilingual_v2';

function elHeaders(apiKey, extra = {}) {
  return {
    'xi-api-key': String(apiKey || '').trim(),
    Accept: 'application/json',
    ...extra,
  };
}

export function normalizeElevenApiKey(raw) {
  return String(raw || '').trim();
}

export async function elevenLabsListVoices(apiKey) {
  const key = normalizeElevenApiKey(apiKey);
  if (!key) return { ok: false, error: 'missing_api_key' };
  const to = setTimeout(() => {}, 0);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await fetch(`${EL_BASE}/v1/voices`, {
      method: 'GET',
      headers: elHeaders(key),
      signal: ctrl.signal,
    });
    const j = await r.json().catch(() => null);
    if (!r.ok) {
      const msg = (j && (j.detail?.message || j.detail || j.message)) || `http_${r.status}`;
      return { ok: false, error: typeof msg === 'string' ? msg : JSON.stringify(msg), status: r.status };
    }
    const voices = Array.isArray(j?.voices)
      ? j.voices.map((v) => ({
        id: String(v.voice_id || ''),
        name: String(v.name || v.voice_id || 'Voz'),
        category: String(v.category || ''),
        preview: String(v.preview_url || ''),
      })).filter((v) => v.id)
      : [];
    return { ok: true, voices };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  } finally {
    clearTimeout(timer);
    clearTimeout(to);
  }
}

/**
 * Sintetiza texto → mp3 base64.
 */
export async function elevenLabsSpeak(apiKey, voiceId, text, opts = {}) {
  const key = normalizeElevenApiKey(apiKey);
  const vid = String(voiceId || '').trim();
  let phrase = String(text || '').trim();
  if (!key) return { ok: false, error: 'missing_api_key' };
  if (!vid) return { ok: false, error: 'missing_voice_id' };
  if (!phrase) return { ok: false, error: 'missing_text' };
  if (phrase.length > 280) phrase = phrase.slice(0, 280);

  const modelId = String(opts.modelId || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Number(opts.timeoutMs) || 14000);
  try {
    const url = `${EL_BASE}/v1/text-to-speech/${encodeURIComponent(vid)}?output_format=mp3_44100_128`;
    const r = await fetch(url, {
      method: 'POST',
      headers: elHeaders(key, { 'Content-Type': 'application/json', Accept: 'audio/mpeg' }),
      signal: ctrl.signal,
      body: JSON.stringify({
        text: phrase,
        model_id: modelId,
        voice_settings: {
          stability: 0.45,
          similarity_boost: 0.75,
          style: 0,
          use_speaker_boost: true,
        },
      }),
    });
    if (!r.ok) {
      let err = `http_${r.status}`;
      try {
        const j = await r.json();
        err = (j && (j.detail?.message || j.detail || j.message)) || err;
        if (typeof err !== 'string') err = JSON.stringify(err);
      } catch {
        try { err = (await r.text()).slice(0, 200) || err; } catch { /* ignore */ }
      }
      return { ok: false, error: err, status: r.status };
    }
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length) return { ok: false, error: 'empty_audio' };
    return { ok: true, audio: buf.toString('base64'), mime: 'audio/mpeg' };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Clona una voz (IVC) con un sample de audio.
 * @param {Buffer} audioBuf
 */
export async function elevenLabsCloneVoice(apiKey, name, audioBuf, filename = 'sample.mp3') {
  const key = normalizeElevenApiKey(apiKey);
  const voiceName = String(name || '').trim().slice(0, 80) || 'Livecoins';
  if (!key) return { ok: false, error: 'missing_api_key' };
  if (!audioBuf || !audioBuf.length) return { ok: false, error: 'missing_audio' };
  if (audioBuf.length > 12 * 1024 * 1024) return { ok: false, error: 'audio_too_large' };

  const safeName = String(filename || 'sample.mp3').replace(/[^\w.\-]+/g, '_').slice(-60) || 'sample.mp3';
  const form = new FormData();
  form.append('name', voiceName);
  form.append('description', 'Clonada desde Livecoins Chat TTS');
  form.append('files', new Blob([audioBuf]), safeName);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  try {
    const r = await fetch(`${EL_BASE}/v1/voices/add`, {
      method: 'POST',
      headers: { 'xi-api-key': key },
      body: form,
      signal: ctrl.signal,
    });
    const j = await r.json().catch(() => null);
    if (!r.ok) {
      const msg = (j && (j.detail?.message || j.detail || j.message)) || `http_${r.status}`;
      return { ok: false, error: typeof msg === 'string' ? msg : JSON.stringify(msg), status: r.status };
    }
    const voiceId = String(j?.voice_id || '').trim();
    if (!voiceId) return { ok: false, error: 'no_voice_id' };
    return { ok: true, voiceId, name: voiceName, requiresVerification: !!j?.requires_verification };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  } finally {
    clearTimeout(timer);
  }
}
