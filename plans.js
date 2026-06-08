// Sistema de planes (Gratis / Premium) controlado por el administrador.
// El admin define, para cada plan: límites numéricos (cuántas alertas, videos, etc.)
// y qué características/overlays están disponibles. Cada cuenta tiene un plan asignado.
// La configuración se guarda en DATA_DIR/plans.json (disco persistente en hosting).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PLANS_FILE = path.join(DATA_DIR, 'plans.json');

fs.mkdirSync(DATA_DIR, { recursive: true });

// Catálogo de TODO lo que se puede limitar/activar. El panel de admin se construye
// automáticamente a partir de esto, así que añadir algo aquí lo expone en el admin.
export const CAPABILITIES = {
  // Límites numéricos (máximo permitido). 0 = no permitido; un número alto = "ilimitado".
  limits: [
    { key: 'soundAlerts', label: 'Alertas sonoras (máx.)' },
    { key: 'videos', label: 'Videos (máx.)' },
    { key: 'battleAlerts', label: 'Animaciones de batalla (máx.)' },
  ],
  // Pestañas del panel (se ocultan si no están permitidas).
  tabs: [
    { key: 'tab_alertas', label: 'Pestaña Alertas' },
    { key: 'tab_videos', label: 'Pestaña Videos' },
    { key: 'tab_batallas', label: 'Pestaña Batallas PK' },
    { key: 'tab_overlays', label: 'Pestaña Overlays' },
    { key: 'tab_tts', label: 'Pestaña Chat TTS' },
    { key: 'tab_timer', label: 'Pestaña Temporizador' },
  ],
  // Overlays individuales (se ocultan en la lista si no están permitidos).
  // El "path" enlaza con el data-path del overlay en el panel.
  overlays: [
    { key: 'ov_joinlive', label: 'Join al live', path: '/join-live.html' },
    { key: 'ov_alertvideo', label: 'Alertas + Videos', path: '/overlay.html' },
    { key: 'ov_jarron', label: 'Jarrón', path: '/jarron.html' },
    { key: 'ov_vaquita', label: 'Vaquita', path: '/vaquita.html' },
    { key: 'ov_marranito', label: 'Marranito', path: '/marranito.html' },
    { key: 'ov_pelotas', label: 'Pelotas de fans', path: '/pelotas.html' },
    { key: 'ov_topdonor', label: 'Top donador semanal', path: '/topdonor.html' },
    { key: 'ov_gcounter', label: 'Contador de meta', path: '/gcounter.html' },
    { key: 'ov_giftvs', label: 'Gift VS', path: '/giftvs.html' },
    { key: 'ov_giftseq', label: 'Gift Sequence', path: '/giftseq.html' },
    { key: 'ov_mejorregalo', label: 'Mejor regalo', path: '/mejorregalo.html' },
    { key: 'ov_mejorracha', label: 'Mejor racha', path: '/mejorracha.html' },
    { key: 'ov_batallaregalos', label: 'Batalla de regalos', path: '/batallaregalos.html' },
    { key: 'ov_batallalikes', label: 'Batalla de likes', path: '/batallalikes.html' },
    { key: 'ov_coinmatch', label: 'Coin Match', path: '/coinmatch.html' },
    { key: 'ov_meta', label: 'Barra de meta (Hype)', path: '/meta.html' },
    { key: 'ov_toplikes', label: 'Top likes', path: '/toplikes.html' },
    { key: 'ov_topdiamantes', label: 'Top diamantes', path: '/topdiamantes.html' },
    { key: 'ov_toplikeslista', label: 'Ranking likes (lista)', path: '/toplikes-lista.html' },
    { key: 'ov_topdiamanteslista', label: 'Ranking diamantes (lista)', path: '/topdiamantes-lista.html' },
    { key: 'ov_alertaregalo', label: 'Alerta de regalo', path: '/alerta-regalo.html' },
    { key: 'ov_alertalikes', label: 'Alerta de likes', path: '/alerta-likes.html' },
    { key: 'ov_alertaseguidor', label: 'Alerta de nuevo seguidor', path: '/alerta-seguidor.html' },
    { key: 'ov_timer', label: 'Temporizador (overlay)', path: '/timer.html' },
  ],
  // Características sueltas.
  extras: [
    { key: 'tts_tiktok', label: 'Voces TikTok / Disney (TTS)' },
  ],
};

// Lista de todas las claves booleanas (tabs + overlays + extras).
function allFeatureKeys() {
  return [...CAPABILITIES.tabs, ...CAPABILITIES.overlays, ...CAPABILITIES.extras].map((c) => c.key);
}
function allLimitKeys() {
  return CAPABILITIES.limits.map((c) => c.key);
}

const BIG = 9999; // "ilimitado" práctico

// Configuración por defecto: Premium todo desbloqueado; Gratis con lo básico.
function defaultConfig() {
  const features = {};
  for (const k of allFeatureKeys()) features[k] = true;
  const premiumLimits = {};
  for (const k of allLimitKeys()) premiumLimits[k] = BIG;

  // Gratis: límites bajos y solo overlays/pestañas básicos.
  const freeFeatures = {};
  for (const k of allFeatureKeys()) freeFeatures[k] = true;
  // Por defecto, en gratis bloqueamos las voces TikTok (suelen ser premium).
  freeFeatures.tts_tiktok = false;

  return {
    free: {
      limits: { soundAlerts: 5, videos: 3, battleAlerts: 2 },
      features: freeFeatures,
    },
    premium: {
      limits: premiumLimits,
      features: { ...features },
    },
  };
}

let config = loadConfig();

function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(PLANS_FILE, 'utf8'));
    return normalizeConfig(raw);
  } catch {
    const def = defaultConfig();
    saveConfigToDisk(def);
    return def;
  }
}

// Asegura que el config tenga todas las claves (por si se añaden capacidades nuevas).
function normalizeConfig(raw) {
  const def = defaultConfig();
  const out = { free: { limits: {}, features: {} }, premium: { limits: {}, features: {} } };
  for (const plan of ['free', 'premium']) {
    const src = (raw && raw[plan]) || {};
    for (const k of allLimitKeys()) {
      const v = Number(src.limits?.[k]);
      out[plan].limits[k] = Number.isFinite(v) && v >= 0 ? v : def[plan].limits[k];
    }
    for (const k of allFeatureKeys()) {
      out[plan].features[k] = src.features?.[k] !== undefined ? !!src.features[k] : def[plan].features[k];
    }
  }
  return out;
}

function saveConfigToDisk(cfg) {
  try {
    const tmp = PLANS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
    fs.renameSync(tmp, PLANS_FILE);
  } catch (e) {
    console.error('  [!] No se pudo guardar plans.json -', e.message);
  }
}

export function getPlanConfig() {
  return config;
}
export function savePlanConfig(raw) {
  config = normalizeConfig(raw);
  saveConfigToDisk(config);
  return config;
}

// Devuelve las capacidades efectivas de un plan ('free' | 'premium'). El admin
// (sin restricciones) se maneja aparte en server.js dándole 'premium'.
export function effectiveCaps(planName) {
  const plan = planName === 'premium' ? 'premium' : 'free';
  const c = config[plan] || defaultConfig()[plan];
  return { plan, limits: { ...c.limits }, features: { ...c.features } };
}

// Capacidades "todo abierto" (para el admin).
export function adminCaps() {
  const features = {};
  for (const k of allFeatureKeys()) features[k] = true;
  const limits = {};
  for (const k of allLimitKeys()) limits[k] = BIG;
  return { plan: 'admin', limits, features };
}
