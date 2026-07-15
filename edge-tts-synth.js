// Síntesis TTS vía Microsoft Edge Read Aloud (sin API key).
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';

/** Locales Edge en español (clasificación por país, como Colombia). */
export const EDGE_SPANISH_REGIONS = {
  'es-AR': 'Argentina',
  'es-BO': 'Bolivia',
  'es-CL': 'Chile',
  'es-CO': 'Colombia',
  'es-CR': 'Costa Rica',
  'es-CU': 'Cuba',
  'es-DO': 'República Dominicana',
  'es-EC': 'Ecuador',
  'es-SV': 'El Salvador',
  'es-GQ': 'Guinea Ecuatorial',
  'es-GT': 'Guatemala',
  'es-HN': 'Honduras',
  'es-MX': 'México',
  'es-NI': 'Nicaragua',
  'es-PA': 'Panamá',
  'es-PY': 'Paraguay',
  'es-PE': 'Perú',
  'es-PR': 'Puerto Rico',
  'es-ES': 'España',
  'es-US': 'Estados Unidos',
  'es-UY': 'Uruguay',
  'es-VE': 'Venezuela',
};

/** Voces Neural Edge en español (id oficial Microsoft). */
export const EDGE_SPANISH_VOICES = [
  { id: 'es-AR-ElenaNeural', locale: 'es-AR', gender: 'f', name: 'Elena' },
  { id: 'es-AR-TomasNeural', locale: 'es-AR', gender: 'm', name: 'Tomás' },
  { id: 'es-BO-SofiaNeural', locale: 'es-BO', gender: 'f', name: 'Sofía' },
  { id: 'es-BO-MarceloNeural', locale: 'es-BO', gender: 'm', name: 'Marcelo' },
  { id: 'es-CL-CatalinaNeural', locale: 'es-CL', gender: 'f', name: 'Catalina' },
  { id: 'es-CL-LorenzoNeural', locale: 'es-CL', gender: 'm', name: 'Lorenzo' },
  { id: 'es-CO-SalomeNeural', locale: 'es-CO', gender: 'f', name: 'Salomé' },
  { id: 'es-CO-GonzaloNeural', locale: 'es-CO', gender: 'm', name: 'Gonzalo' },
  { id: 'es-CR-MariaNeural', locale: 'es-CR', gender: 'f', name: 'María' },
  { id: 'es-CR-JuanNeural', locale: 'es-CR', gender: 'm', name: 'Juan' },
  { id: 'es-CU-BelkysNeural', locale: 'es-CU', gender: 'f', name: 'Belkys' },
  { id: 'es-CU-ManuelNeural', locale: 'es-CU', gender: 'm', name: 'Manuel' },
  { id: 'es-DO-RamonaNeural', locale: 'es-DO', gender: 'f', name: 'Ramona' },
  { id: 'es-DO-EmilioNeural', locale: 'es-DO', gender: 'm', name: 'Emilio' },
  { id: 'es-EC-AndreaNeural', locale: 'es-EC', gender: 'f', name: 'Andrea' },
  { id: 'es-EC-LuisNeural', locale: 'es-EC', gender: 'm', name: 'Luis' },
  { id: 'es-SV-LorenaNeural', locale: 'es-SV', gender: 'f', name: 'Lorena' },
  { id: 'es-SV-RodrigoNeural', locale: 'es-SV', gender: 'm', name: 'Rodrigo' },
  { id: 'es-GQ-TeresaNeural', locale: 'es-GQ', gender: 'f', name: 'Teresa' },
  { id: 'es-GQ-JavierNeural', locale: 'es-GQ', gender: 'm', name: 'Javier' },
  { id: 'es-GT-MartaNeural', locale: 'es-GT', gender: 'f', name: 'Marta' },
  { id: 'es-GT-AndresNeural', locale: 'es-GT', gender: 'm', name: 'Andrés' },
  { id: 'es-HN-KarlaNeural', locale: 'es-HN', gender: 'f', name: 'Karla' },
  { id: 'es-HN-CarlosNeural', locale: 'es-HN', gender: 'm', name: 'Carlos' },
  { id: 'es-MX-DaliaNeural', locale: 'es-MX', gender: 'f', name: 'Dalia' },
  { id: 'es-MX-JorgeNeural', locale: 'es-MX', gender: 'm', name: 'Jorge' },
  { id: 'es-NI-YolandaNeural', locale: 'es-NI', gender: 'f', name: 'Yolanda' },
  { id: 'es-NI-FedericoNeural', locale: 'es-NI', gender: 'm', name: 'Federico' },
  { id: 'es-PA-MargaritaNeural', locale: 'es-PA', gender: 'f', name: 'Margarita' },
  { id: 'es-PA-RobertoNeural', locale: 'es-PA', gender: 'm', name: 'Roberto' },
  { id: 'es-PY-TaniaNeural', locale: 'es-PY', gender: 'f', name: 'Tania' },
  { id: 'es-PY-MarioNeural', locale: 'es-PY', gender: 'm', name: 'Mario' },
  { id: 'es-PE-CamilaNeural', locale: 'es-PE', gender: 'f', name: 'Camila' },
  { id: 'es-PE-AlexNeural', locale: 'es-PE', gender: 'm', name: 'Alex' },
  { id: 'es-PR-KarinaNeural', locale: 'es-PR', gender: 'f', name: 'Karina' },
  { id: 'es-PR-VictorNeural', locale: 'es-PR', gender: 'm', name: 'Víctor' },
  { id: 'es-ES-ElviraNeural', locale: 'es-ES', gender: 'f', name: 'Elvira' },
  { id: 'es-ES-XimenaNeural', locale: 'es-ES', gender: 'f', name: 'Ximena' },
  { id: 'es-ES-AlvaroNeural', locale: 'es-ES', gender: 'm', name: 'Álvaro' },
  { id: 'es-US-PalomaNeural', locale: 'es-US', gender: 'f', name: 'Paloma' },
  { id: 'es-US-AlonsoNeural', locale: 'es-US', gender: 'm', name: 'Alonso' },
  { id: 'es-UY-ValentinaNeural', locale: 'es-UY', gender: 'f', name: 'Valentina' },
  { id: 'es-UY-MateoNeural', locale: 'es-UY', gender: 'm', name: 'Mateo' },
  { id: 'es-VE-PaolaNeural', locale: 'es-VE', gender: 'f', name: 'Paola' },
  { id: 'es-VE-SebastianNeural', locale: 'es-VE', gender: 'm', name: 'Sebastián' },
];

export const EDGE_VOICES = new Set(EDGE_SPANISH_VOICES.map((v) => v.id));

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
