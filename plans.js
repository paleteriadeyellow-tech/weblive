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
    { key: 'actions', label: 'Acciones (máx.)' },
    { key: 'profiles', label: 'Perfiles del panel (máx.)' },
  ],
  // Pestañas del panel (se ocultan si no están permitidas).
  tabs: [
    { key: 'tab_alertas', label: 'Pestaña Alertas' },
    { key: 'tab_videos', label: 'Pestaña Videos' },
    { key: 'tab_batallas', label: 'Pestaña Batallas PK' },
    { key: 'tab_overlays', label: 'Pestaña Overlays' },
    { key: 'tab_tts', label: 'Pestaña Chat TTS' },
    { key: 'tab_timer', label: 'Pestaña Temporizador' },
    { key: 'tab_webhook', label: 'Pestaña Webhook y Configuración (.exe)' },
  ],
  // Overlays individuales (se ocultan en la lista si no están permitidos).
  // El "path" enlaza con el data-path del overlay en el panel.
  overlays: [
    { key: 'ov_joinlive', label: 'Join al live', path: '/join-live.html' },
    { key: 'ov_joinlivemc', label: 'Join al live (Minecraft)', path: '/join-live-minecraft.html' },
    { key: 'ov_joinlivedbz', label: 'Join al live (Dragon Ball Z)', path: '/join-live-dragonball.html' },
    { key: 'ov_joinlivemario', label: 'Join al live (Mario Bros)', path: '/join-live-mario.html' },
    { key: 'ov_alertvideo', label: 'Alertas + Videos', path: '/overlay.html' },
    { key: 'ov_perrito', label: 'Perrito', path: '/perrito.html' },
    { key: 'ov_jarron', label: 'Jarrón', path: '/jarron.html' },
    { key: 'ov_vaquita', label: 'Vaquita', path: '/vaquita.html' },
    { key: 'ov_marranito', label: 'Marranito', path: '/marranito.html' },
    { key: 'ov_pelotas', label: 'Pelotas de fans', path: '/pelotas.html' },
    { key: 'ov_topdonor', label: 'Top donador semanal', path: '/topdonor.html' },
    { key: 'ov_gcounter', label: 'Contador de meta', path: '/gcounter.html' },
    { key: 'ov_winscounter', label: 'Contador de victorias', path: '/contador-wins.html' },
    { key: 'ov_winscountergamer', label: 'Contador de victorias (Gamer HUD)', path: '/contador-wins-gamer.html' },
    { key: 'ov_winscounterminecraft', label: 'Contador de victorias (Minecraft)', path: '/contador-wins-minecraft.html' },
    { key: 'ov_winscountermario', label: 'Contador de victorias (Mario Bros)', path: '/contador-wins-mario.html' },
    { key: 'ov_giftvs', label: 'Gift VS', path: '/giftvs.html' },
    { key: 'ov_flowmeter', label: 'Medidor de Flow', path: '/medidor-flow.html' },
    { key: 'ov_giftseq', label: 'Gift Sequence', path: '/giftseq.html' },
    { key: 'ov_habibitop', label: 'Habibi Top Donador', path: '/habibi-top.html' },
    { key: 'ov_giftshowcase', label: 'Banda de regalos', path: '/gift-banda.html' },
    { key: 'ov_mejorregalo', label: 'Mejor regalo', path: '/mejorregalo.html' },
    { key: 'ov_mejorracha', label: 'Mejor racha', path: '/mejorracha.html' },
    { key: 'ov_batallaregalos', label: 'Batalla de regalos', path: '/batallaregalos.html' },
    { key: 'ov_batallalikes', label: 'Batalla de likes', path: '/batallalikes.html' },
    { key: 'ov_coinmatch', label: 'Coin Match', path: '/coinmatch.html' },
    { key: 'ov_top1fire', label: 'Top 1 Donador Fuego', path: '/top1fire.html' },
    { key: 'ov_meta', label: 'Barra de meta (Hype)', path: '/meta.html' },
    { key: 'ov_metamc', label: 'Barra de meta (Minecraft)', path: '/meta-minecraft.html' },
    { key: 'ov_metamario', label: 'Barra de meta (Mario Bros)', path: '/meta-mario.html' },
    { key: 'ov_metadbz', label: 'Barra de meta (Dragon Ball Super)', path: '/meta-dragonball.html' },
    { key: 'ov_topaltrankneon', label: 'Top Likes / Diamantes (neón)', path: '/topalt-rank-neon.html' },
    { key: 'ov_topaltrank', label: 'Top Likes / Diamantes (alternado)', path: '/topalt-rank.html' },
    { key: 'ov_toplikes', label: 'Top likes', path: '/toplikes.html' },
    { key: 'ov_topdiamantes', label: 'Top diamantes', path: '/topdiamantes.html' },
    { key: 'ov_toplikeslista', label: 'Ranking likes (lista)', path: '/toplikes-lista.html' },
    { key: 'ov_topdiamanteslista', label: 'Ranking diamantes (lista)', path: '/topdiamantes-lista.html' },
    { key: 'ov_toppoints', label: 'Top 3 puntos', path: '/toppoints.html' },
    { key: 'ov_contadorseguidores', label: 'Contador de seguidores', path: '/contador-seguidores.html' },
    { key: 'ov_contadorseguidoresmc', label: 'Contador de seguidores (Minecraft)', path: '/contador-seguidores-minecraft.html' },
    { key: 'ov_tiempolive', label: 'Tiempo en live (Neon)', path: '/tiempo-live-neon.html' },
    { key: 'ov_fuegos', label: 'Fuegos artificiales', path: '/fuegos.html' },
    { key: 'ov_alertaregalo', label: 'Alerta de regalo', path: '/alerta-regalo.html' },
    { key: 'ov_alertalikes', label: 'Alerta de likes', path: '/alerta-likes.html' },
    { key: 'ov_alertaseguidor', label: 'Alerta de nuevo seguidor', path: '/alerta-seguidor.html' },
    { key: 'ov_timer', label: 'Temporizador (overlay)', path: '/timer.html' },
  ],
  // Minijuegos (pestaña "Juegos" del .exe). Se pueden bloquear como los overlays.
  games: [
    { key: 'game_minecraft', label: 'Juego: Minecraft' },
    { key: 'game_mcservidor', label: 'Juego: Servidor Minecraft' },
    { key: 'game_mcparkour', label: 'Juego: Minecraft Parkour' },
    { key: 'game_mckoth', label: 'Juego: Minecraft KOTH' },
    { key: 'game_mcfarm', label: 'Juego: Minecraft Farm' },
    { key: 'game_mcshooter', label: 'Juego: Minecraft Shooters' },
    { key: 'game_bedrock', label: 'Juego: Bedrock (Cubo TNT)' },
    { key: 'game_sandbox', label: 'Juego: Sandbox' },
    { key: 'game_roblox', label: 'Juego: Roblox' },
    { key: 'game_roblox3', label: 'Juego: Roblox parkour' },
    { key: 'game_mariobros', label: 'Juego: Mario Bros' },
    { key: 'game_smb3', label: 'Juego: Super Mario Bros. 3' },
    { key: 'game_smw', label: 'Juego: Super Mario World' },
    { key: 'game_mari0', label: 'Juego: Mari0' },
    { key: 'game_plantasvszombies', label: 'Juego: Plants vs Zombies' },
    { key: 'game_pvzhybrid', label: 'Juego: Plants vs Zombies Pack' },
    { key: 'game_repo', label: 'Juego: R.E.P.O.' },
    { key: 'game_l4d', label: 'Juego: Left 4 Dead 2' },
    { key: 'game_gtavkoth', label: 'Juego: GTA V King of the Hill' },
    { key: 'game_unturned', label: 'Juego: Unturned' },
    { key: 'game_crashctr', label: 'Juego: Crash Team Racing (CTR)' },
    { key: 'game_metalslug', label: 'Juego: Metal Slug by Livecoins' },
    { key: 'game_geometrydash', label: 'Juego: Geometry Dash' },
  ],
  // Características sueltas.
  extras: [
    { key: 'tts_tiktok', label: 'Voces TikTok / Disney (TTS)' },
  ],
};

// Lista de todas las claves booleanas (tabs + overlays + games + extras).
function allFeatureKeys() {
  return [...CAPABILITIES.tabs, ...CAPABILITIES.overlays, ...CAPABILITIES.games, ...CAPABILITIES.extras].map((c) => c.key);
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
  freeFeatures.game_pvzhybrid = false;
  freeFeatures.game_repo = false;
  freeFeatures.game_l4d = false;
  freeFeatures.game_gtavkoth = false;
  freeFeatures.game_unturned = false;
  freeFeatures.game_crashctr = false;
  freeFeatures.game_smw = false;
  freeFeatures.game_metalslug = false;
  freeFeatures.game_geometrydash = false;

  // Metal Slug: próximamente — ni siquiera Premium hasta lanzamiento (solo admin).
  features.game_metalslug = false;

  return {
    free: {
      limits: { soundAlerts: 5, videos: 3, battleAlerts: 2, actions: 3, profiles: 1 },
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
