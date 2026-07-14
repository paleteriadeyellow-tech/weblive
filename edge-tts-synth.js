// Síntesis TTS vía Microsoft Edge Read Aloud (sin API key).
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';

export const EDGE_VOICES = new Set([
  'es-CO-SalomeNeural',
  'es-CO-GonzaloNeural',
]);

export function isEdgeTtsVoice(voice) {
  return EDGE_VOICES.has(String(voice || '').trim());
}

/** Devuelve audio mp3 en base64, o '' si falla. */
export async function ttsSynthEdge(text, voice, timeoutMs = 12000) {
  const v = String(voice || '').trim();
  const t = String(text || '').trim();
  if (!t || !isEdgeTtsVoice(v)) return '';

  const run = async () => {
    const tts = new MsEdgeTTS();
    await tts.setMetadata(v, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    const { audioStream } = tts.toStream(t);
    const chunks = [];
    for await (const chunk of audioStream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    try { tts.close(); } catch { /* ignore */ }
    if (!chunks.length) return '';
    return Buffer.concat(chunks).toString('base64');
  };

  return Promise.race([
    run().catch(() => ''),
    new Promise((resolve) => setTimeout(() => resolve(''), Math.max(3000, timeoutMs))),
  ]);
}
