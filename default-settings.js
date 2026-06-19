// Ajustes por defecto de cada room (usuario). Es la plantilla que se fusiona con
// lo que cada usuario tenga guardado en su data/<id>/settings.json.
export const DEFAULT_SETTINGS = {
  alerts: {
    gift: true,
    follow: true,
    share: true,
    like: false,
    member: false,
    minDiamonds: 1,
    duration: 5,
  },
  tts: {
    enabled: false,
    // Configuración general
    lang: 'es', voice: '', readName: true, nameEmojis: true,
    rate: 1.2, pitch: 1, volume: 1,
    minLen: 1, maxLen: 150,
    // Voces TikTok (Disney / personajes). Si tiktokVoice tiene valor, se usa esa voz
    // (síntesis en el servidor) en vez de la voz del sistema. tiktokTranslateEs traduce
    // el texto al inglés para las voces Disney (que solo existen en inglés).
    tiktokVoice: '', tiktokTranslateEs: true,
    // Usuarios permitidos
    allowAll: true, allowFollowers: false, allowSubs: false, allowMods: false, allowTeam: false,
    // Nivel mínimo de miembro (club de fans) para que se lea el mensaje. 0 = sin requisito.
    // requireMinLevel activa/desactiva este filtro desde el interruptor del panel.
    requireMinLevel: false, minMemberLevel: 0,
    // Tipos de comentarios (activador): all | dot | slash | command
    trigger: 'all', command: '!tts',
    // Puntos de carga (monetización)
    charge: false, cost: 5,
    // Moderación inteligente
    blockSpam: true, blockAlpha: true, blockProfanity: true, blockSuspicious: true, stripEmojis: false,
    blockedWords: '',
    // Nuevos seguidores
    readFollow: false, followMsg: 'Hola {user}, gracias por seguirme',
    // Leer eventos
    readShare: false, readTaptap: false, taptapMin: 100, readGifts: false,
    // Comandos personalizados: cuando alguien escribe el comando (ej. !idwarzone) el
    // bot responde por voz (TTS) y muestra la respuesta. [{ id, command, response, enabled }]
    commands: [],
  },
  // Usuario y Puntos: cuántos puntos otorga cada moneda (diamante) donada.
  points: {
    perCoin: 1,
    superFanBonus: 500, // puntos extra al volverse super fan
    subBonus: 100,      // puntos extra por suscripción
  },
  // videos: [{ id, name, url, fileName, trigger, giftName, minDiamonds, volume, enabled, screen }]
  videos: [],
  videosEnabled: true, // interruptor maestro "TODAS"
  // Videos automáticos por nivel de miembro (carpeta «niveles»): al subir alguien de
  // nivel se reproduce el video nivelN. screen = en qué Browser Source aparece.
  levelVideos: { enabled: true, screen: 1, volume: 100 },
  // pantallas (Browser Sources separados): tamaño por pantalla
  screens: [
    { id: 1, size: 100 },
    { id: 2, size: 100 },
    { id: 3, size: 100 },
    { id: 4, size: 100 },
    { id: 5, size: 100 },
  ],
  // alertas sonoras: [{ id, name, giftName, minDiamonds, sound, soundName, image, volume, enabled }]
  soundAlerts: [],
  // Reproducción de alertas/sonidos/videos:
  //  - playQueue: encolar en vez de cortar (termina el actual y reproduce el siguiente)
  //  - comboOnce: una racha (ej. 10 rosas) dispara la alerta una sola vez
  playback: { playQueue: true, comboOnce: false },
  // Temporizador (cuenta regresiva que suma tiempo con la interacción del live).
  //  - giftMult: segundos por cada moneda/diamante de regalo
  //  - like:     segundos por cada 100 likes
  //  - follow/share/subscribe/chat: segundos por cada evento
  //  - defaultInitialSec: tiempo inicial (al reiniciar o conectar)
  //  - maxEnabled/maxCapSec: tope máximo opcional
  //  - actionOnFinish: qué hacer al llegar a 0 -> 'pause' | 'reset' | 'beep'
  timer: {
    giftMult: 5,
    like: 2,
    follow: 10,
    share: 15,
    subscribe: 60,
    chat: 0,
    defaultInitialSec: 300,
    maxEnabled: false,
    maxCapSec: 18000,
    actionOnFinish: 'pause',
  },
  battle: {
    enabled: false,
    teamA: 'Equipo A',
    teamB: 'Equipo B',
    goal: 1000,
    receiving: 'A', // a qué equipo van los diamantes de los regalos: 'A' | 'B' | 'off'
  },
  // Animaciones de batalla: reproducen un video al detectar un regalo concreto (ej. "guante").
  // [{ id, name, giftName, giftId, minCount, url, fileName, volume, screen, enabled }]
  battleAlerts: [],
  battleAlertsEnabled: true,
  // Overlay del perrito (mismos controles que el jarrón; se desborda al llenarse)
  perrito: {
    tint: '',
    sizes: [
      { t: 5000, sz: 88 },
      { t: 1000, sz: 70 },
      { t: 100, sz: 56 },
      { t: 30, sz: 40 },
      { t: 0, sz: 32 },
    ],
  },
  // Overlay del jarrón de regalos
  jarron: {
    tint: '', // color del cristal (vacío = transparente/normal)
    // Tabla de tamaños por umbral de monedas/diamantes: [{ t, sz }] de mayor a menor
    sizes: [
      { t: 5000, sz: 88 },
      { t: 1000, sz: 70 },
      { t: 100, sz: 56 },
      { t: 30, sz: 40 },
      { t: 0, sz: 32 },
    ],
  },
  // Overlay de la vaquita (mismos controles que el jarrón)
  vaquita: {
    tint: '',
    sizes: [
      { t: 5000, sz: 88 },
      { t: 1000, sz: 70 },
      { t: 100, sz: 56 },
      { t: 30, sz: 40 },
      { t: 0, sz: 32 },
    ],
  },
  // Overlay del marranito (mismos controles que el jarrón)
  marranito: {
    tint: '',
    sizes: [
      { t: 5000, sz: 88 },
      { t: 1000, sz: 70 },
      { t: 100, sz: 56 },
      { t: 30, sz: 40 },
      { t: 0, sz: 32 },
    ],
  },
  // Overlay de pelotas de fans: cae una pelota con la foto del donador al
  // alcanzar cierta cantidad de monedas y/o likes (acumulado por usuario).
  pelotas: {
    tint: '',
    ballSize: 64,
    coinsEnabled: true,
    coinsEvery: 100,
    likesEnabled: false,
    likesEvery: 100,
  },
  // Ruleta / sorteo en vivo. Recoge participantes por donación o por palabra en
  // el chat y luego gira para elegir un ganador.
  roulette: {
    mode: 'keyword',   // 'keyword' | 'donors'
    keyword: 'yo',     // palabra que da entrada (modo keyword)
    minCoins: 0,       // mínimo de monedas para entrar (modo donors)
    title: 'SORTEO EN VIVO',
    c1: '#7c4dff',
    c2: '#00e5ff',
  },
  // Overlay del top donador semanal
  topDonor: {
    c1: '#00e5ff',
    c2: '#ff2bd6',
    nameColor: '#ffffff',
    title: 'TOP DONADOR SEMANAL',
    coinLabel: 'diamantes',
    showCountdown: true,
    showRunners: true,
    scale: 100,
  },
  // Overlay Gift VS (versus de regalos por bandos)
  giftVs: {
    meta: 500,
    goalStep: 500,
    onGoal: 'increase', // 'increase' | 'reset' | 'none'
    countdown: 0,
    cdWhen: 'goal', // 'goal' | 'start'
    cdRestart: false,
    rows: [
      // { leftId, leftName, leftImg, leftDiamonds, rightId, rightName, rightImg, rightDiamonds }
    ],
  },
  // Overlay Gift Sequence (secuencia rotativa de regalos con texto)
  giftSeq: {
    text: '#f4f7ff',
    accent: '#8df7d8',
    size: 28,
    font: 'system',
    anim: 'gift-pop', // none|gift-fade|gift-pop|gift-zoom|gift-drop|gift-row-left
    rowSpeed: 7.6,
    textRainbow: false,
    stepSec: 2,
    sequence: [
      // { giftName, giftImage, customText, textSide }
    ],
  },
  // Overlay Top 1 Donador (MVP de la sesión: quien más monedas regala)
  top1: {
    headerTitle: 'MVP: Top 1 Donador',
    headerRainbow: false,
    hc1: '#22d3ee', hc2: '#06b6d4', hc3: '#2dd4bf',
    ng1: '#fffef5', ng2: '#ffe066', ng3: '#daa520',
    valueColor: '#e8e8ff', valueStroke: '#000000', coinColor: '#ffd700',
    coinLabel: '', font: 'inter',
    showHeader: true, showCrown: true, showFx: true,
  },
  // Overlay Top 1 Donador Fuego (MVP con aura de fuego; periodo configurable)
  top1fire: {
    headerTitle: 'MVP: Top 1 Donador',
    headerRainbow: false,
    hc1: '#ff6b35', hc2: '#ff4500', hc3: '#ffd700',
    ng1: '#fff8f0', ng2: '#ffb347', ng3: '#ff4500',
    valueColor: '#ffe8d6', valueStroke: '#2a0a00', coinColor: '#ffd700',
    fc1: '#fff4a3', fc2: '#ff8c00', fc3: '#ff2200',
    rc1: '#3d1500', rc2: '#1a0800',
    coinLabel: '', font: 'inter',
    showHeader: true, showCrown: true, showFx: true,
    resetPeriod: 'live', // live | week | month
  },
  // Overlay Mejor regalo (top único por monedas)
  topGift: {
    title: 'MEJOR REGALO',
    titleRainbow: true,
    tc1: '#ff00aa', tc2: '#00ddff', tc3: '#ffcc00',
    nameColor: '#e4e4ee', valueColor: '#e8c4a0',
    nameStroke: '#3d3d4a', valueStroke: '#4a3d2e',
    coinLabel: 'monedas', font: 'rubik',
  },
  // Overlay Contador de meta (cuenta un regalo concreto hasta una meta)
  // giftId/giftName vacíos => cuenta CUALQUIER regalo. count se lleva en el servidor.
  giftCounter: {
    title: 'MY CHALLENGE',
    giftId: '', giftName: '', image: '',
    goal: 50,
    titleRainbow: true,
    tc1: '#ff00aa', tc2: '#00ddff', tc3: '#ffcc00',
    titleColor: '#ffffff', counterColor: '#ebc94d',
    titleStroke: '#242424', counterStroke: '#3a3320',
    font: 'luckiest',
  },
  // Overlay Mejor racha (mayor combo)
  topStreak: {
    title: 'MEJOR RACHA',
    titleRainbow: true,
    tc1: '#ff00aa', tc2: '#00ddff', tc3: '#ffcc00',
    nameColor: '#e4e4ee', valueColor: '#e8c4a0',
    nameStroke: '#3d3d4a', valueStroke: '#4a3d2e',
    font: 'rubik',
  },
  // Overlay Batalla de regalos (ranking por monedas)
  batallaGifts: {
    limit: 2, nameRainbow: true, placeholder: 'Esperando regalos...',
    valueColor: '#fde68a', coinColor: '#ffd700',
  },
  // Overlay Batalla de likes (ranking por likes)
  batallaLikes: {
    limit: 2, nameRainbow: true, placeholder: 'Esperando combatientes...',
    valueColor: '#fecaca', likesIcon: '❤️',
  },
  // Overlay Coin Match (partido cronometrado con podio)
  coinMatch: {
    title: 'Coin Match', durationSec: 180, topN: 3, accent: '#f43f5e',
    startDelaySec: 3, revealSec: 3, minBid: 1, maxParticipants: 100,
    winMode: 'keep', showTitle: true, showCount: true, scroll: true,
    sniper: false, slowReveal: false, font: 'inter',
  },
  // Rankings Likes / Diamantes (bandas y lista)
  toplikesRank: { rows: 5, accent: '#ffffff', rowBg: '#0c1c26', scale: 100, font: 'inter', transparent: false, nameRainbow: true, lines: true, shadows: true, resetPeriod: 'live' },
  topdiamRank: { rows: 5, accent: '#ffe08a', rowBg: '#0c1c26', scale: 100, font: 'inter', transparent: false, nameRainbow: true, lines: true, shadows: true, resetPeriod: 'live' },
  toplikesList: { rows: 9, accent: '#f4f4f5', scale: 100, font: 'inter', transparent: true, nameRainbow: true, lines: false, shadows: false, resetPeriod: 'live' },
  topdiamList: { rows: 9, accent: '#ffe08a', scale: 100, font: 'inter', transparent: true, nameRainbow: true, lines: false, shadows: false, resetPeriod: 'live' },
  // Overlay alternado: Top diamantes ↔ Top likes cada N segundos
  topAltRank: {
    rows: 5, scale: 100, font: 'inter', rowBg: '#0c1c26',
    likesAccent: '#ffffff', diamAccent: '#ffe08a',
    transparent: false, nameRainbow: true, lines: true, shadows: true,
    intervalSec: 3, resetPeriodLikes: 'live', resetPeriodDiam: 'live',
  },
  // Overlay Barra de meta (Hype) — skins: default | meta2 | meta3 | meta4
  hypeBar: {
    skin: 'default', goalKind: 'hype', title: '', meta: 100, whenReach: 'increase', scale: 100,
    pointsLike: 1, pointsFollow: 10, pointsShare: 8, pointsGift: 1, pointsMember: 1,
  },
  // Diseño Overlay — alertas animadas (regalo / likes / nuevo seguidor)
  alertaGift: {
    headline: 'Gracias por tu regalo', durationSec: 6, scale: 100,
    g1: '#ff4d8d', g2: '#c084fc', g3: '#38bdf8', nameColor: '#ffffff', subColor: '#f8fafc',
  },
  alertaLikes: {
    durationSec: 6, scale: 100, g1: '#ff4d8d', g2: '#c084fc', g3: '#38bdf8',
  },
  alertaFollow: {
    headline1: '¡NUEVO', headline2: 'SEGUIDOR!', sub1: '¡Bienvenido/a a la comunidad!', sub2: 'Sigue interactuando',
    durationSec: 5, scale: 100, g1: '#00ffff', g2: '#7c3aed', g3: '#ff00ff', nameColor: '#ffffff', subColor: '#f8fafc',
    showAvatar: true, showShards: true, showRays: true, showDust: true, enterAnim: 'lift',
  },
  // Streams overlay — Join al live (estilo gamer)
  streamJoin: {
    neon: '#00ff66', durationSec: 4.5, scale: 100, posTop: 30, posLeft: 30, laserSpeed: 2, bgOpacity: 90,
    tagSize: 1.3, statusSize: 0.8, phraseMode: 'random', phrase: 'se unió al live',
    phrases: 'se unió a la partida|entró a la squad|ready to rumble|spawneó en el chat|se unió al live',
  },
  actions: [],
  webhook: {
    rcon: { host: '127.0.0.1', port: 25575, password: '' },
    obs: { ip: '127.0.0.1', port: 4455, password: '' },
    streamerbot: { address: '127.0.0.1', port: 8080, endpoint: '/', password: '' },
    servertap: { ip: 'localhost', port: 4567, key: 'change_me', playername: '', enabled: false },
  },
  mcActions: [],
  bedrockActions: [],
  sandboxActions: [],
  robloxActions: [],
  roblox3Actions: [],
  marioActions: [],
  mari0Actions: [],
  pvzActions: [],
};

export function deepMerge(target, src) {
  for (const k of Object.keys(src || {})) {
    if (src[k] && typeof src[k] === 'object' && !Array.isArray(src[k])) {
      target[k] = deepMerge(target[k] || {}, src[k]);
    } else {
      target[k] = src[k];
    }
  }
  return target;
}
