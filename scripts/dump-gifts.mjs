// Genera un catálogo FIJO de regalos (gifts.json) desde esta PC, que es la misma
// fuente/región que ve el .exe. Así weblive (Render) puede usar el MISMO catálogo,
// aunque su datacenter devuelva menos regalos por región.
// Incluye regalos con audio ("Gift audio") marcados con audio: true.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TikTokLiveConnection } from 'tiktok-live-connector';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const REGIONS = {
  auto: {},
  MX: { region: 'MX', priority_region: 'MX', app_language: 'es', browser_language: 'es-MX', webcast_language: 'es', tz_name: 'America/Mexico_City' },
  US: { region: 'US', priority_region: 'US', app_language: 'en', browser_language: 'en-US', webcast_language: 'en', tz_name: 'America/New_York' },
  ES: { region: 'ES', priority_region: 'ES', app_language: 'es', browser_language: 'es-ES', webcast_language: 'es', tz_name: 'Europe/Madrid' },
  AR: { region: 'AR', priority_region: 'AR', app_language: 'es', browser_language: 'es-AR', webcast_language: 'es', tz_name: 'America/Buenos_Aires' },
  CO: { region: 'CO', priority_region: 'CO', app_language: 'es', browser_language: 'es-CO', webcast_language: 'es', tz_name: 'America/Bogota' },
};

const MUSIC_NAME_RE = /music|song|melody|mic|guitar|piano|dj|beat|concert|album|drum|karaoke|band|singer|violin|trumpet|spotify|nota|canci[oó]n/i;

function isAudioGift(g) {
  const key = g?.gift_panel_banner?.display_text?.key || '';
  const pattern = g?.gift_panel_banner?.display_text?.default_pattern || '';
  const banner = JSON.stringify(g?.gift_panel_banner || {}).toLowerCase();
  return key.includes('audio')
    || /audio|music|song/i.test(pattern)
    || banner.includes('gift_audio')
    || banner.includes('audio_gift')
    || MUSIC_NAME_RE.test(String(g?.name || ''));
}

function normalizeGift(g) {
  return {
    id: g.id,
    name: g.name,
    diamonds: g.diamond_count ?? g.diamondCount ?? 0,
    image: g.image?.url_list?.[0] || g.icon?.url_list?.[0] || (typeof g.image === 'string' ? g.image : ''),
    ...(isAudioGift(g) ? { audio: true } : {}),
  };
}

async function main() {
  const merged = new Map();
  for (const [region, webParams] of Object.entries(REGIONS)) {
    try {
      const tmp = new TikTokLiveConnection('tv_asahi_news', { webClientParams: webParams });
      const gifts = await tmp.fetchAvailableGifts();
      let added = 0;
      for (const g of (Array.isArray(gifts) ? gifts : [])) {
        if (!g?.name) continue;
        const id = String(g.id);
        const next = normalizeGift(g);
        const prev = merged.get(id);
        if (!prev) added += 1;
        merged.set(id, prev ? { ...prev, ...next, audio: !!(prev.audio || next.audio) } : next);
      }
      console.log(`Región ${region}: ${Array.isArray(gifts) ? gifts.length : 0} · +${added} · total ${merged.size}`);
    } catch (e) {
      console.warn(`Región ${region}: error —`, e && e.message);
    }
  }

  const results = [...merged.values()]
    .filter((g) => g.name)
    .sort((a, b) => (a.diamonds - b.diamonds) || String(a.name).localeCompare(String(b.name)));

  const audioCount = results.filter((g) => g.audio).length;
  const out = JSON.stringify(results);
  const targets = [
    path.join(ROOT, 'gifts.json'),
    path.join(ROOT, 'weblive', 'gifts.json'),
  ];
  for (const t of targets) {
    fs.writeFileSync(t, out);
    console.log('Escrito:', t, '·', results.length, 'regalos ·', audioCount, 'música/audio');
  }
}

main().catch((e) => { console.error('Error:', e && e.message); process.exit(1); });
