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
    // (síntesis en el servidor) en vez de la voz del sistema. tiktokTranslateEs=true
    // traduce el texto al inglés para voces Disney. La casilla UI «Leer en español»
    // está marcada cuando tiktokTranslateEs es false.
    tiktokVoice: '', tiktokTranslateEs: false,
    // ElevenLabs (API key del creador). Si enabled + apiKey + voiceId, tiene prioridad
    // sobre TikTok/Edge/sistema. Livecoins no paga la API: usa la key del streamer.
    elevenlabs: {
      enabled: false,
      apiKey: '',
      voiceId: '',
      voiceName: '',
      modelId: 'eleven_multilingual_v2',
    },
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
    blockReplies: false,
    blockedWords: '',
    // Nuevos seguidores
    readFollow: false, followMsg: 'Hola {user}, gracias por seguirme',
    // Leer eventos
    readShare: false, readTaptap: false, taptapMin: 100, readGifts: false,
    // Comandos personalizados: cuando alguien escribe el comando (ej. !idwarzone) el
    // bot responde por voz (TTS) y muestra la respuesta. [{ id, command, response, enabled }]
    commands: [],
    // Voces personalizadas por usuario del chat: [{ id, userId, nickname, engine, lang, voice, translate }]
    userVoices: [],
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
  // pantallas (Browser Sources separados): tamaño por pantalla
  screens: [
    { id: 1, size: 100 },
    { id: 2, size: 100 },
    { id: 3, size: 100 },
    { id: 4, size: 100 },
    { id: 5, size: 100 },
    { id: 6, size: 100 },
    { id: 7, size: 100 },
    { id: 8, size: 100 },
    { id: 9, size: 100 },
    { id: 10, size: 100 },
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
    // Estado vivo (sobrevive reinicios de app / Render)
    savedRemaining: null,
    savedRunning: false,
    savedAt: 0,
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
    topBarEnabled: true,
    topBarLimit: 3,
    topBarColor: '#161820',
    topBarOpacity: 88,
    giftToastEnabled: true,
    giftToastColor: '#1c1e26',
    giftToastOpacity: 90,
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
    topBarEnabled: true, // barra rotativa TOP DONATOR encima del contador
    topBarLimit: 3, // hasta qué top mostrar (1–10)
    topBarColor: '#161820',
    topBarOpacity: 88,
    giftToastEnabled: true, // píldora «NAME DONATED» al recibir regalo
    giftToastColor: '#1c1e26',
    giftToastOpacity: 90,
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
    topBarEnabled: true,
    topBarLimit: 3,
    topBarColor: '#161820',
    topBarOpacity: 88,
    giftToastEnabled: true,
    giftToastColor: '#1c1e26',
    giftToastOpacity: 90,
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
    topBarEnabled: true,
    topBarLimit: 3,
    topBarColor: '#161820',
    topBarOpacity: 88,
    giftToastEnabled: true,
    giftToastColor: '#1c1e26',
    giftToastOpacity: 90,
    sizes: [
      { t: 5000, sz: 88 },
      { t: 1000, sz: 70 },
      { t: 100, sz: 56 },
      { t: 30, sz: 40 },
      { t: 0, sz: 32 },
    ],
  },
  // Overlay Corazón lava (alcancía: regalos caen dentro del corazón)
  corazonLava: {
    tint: '',
    metaLabel: 'Meta',
    metaGoal: 50,
    metaMode: 'gifts', // gifts = cuenta regalos | coins = cuenta monedas/diamantes
    // Solo este regalo cae / cuenta / aparece en Testear
    filterGiftId: '7934',
    filterGiftName: 'Heart Me',
    filterGiftImage: 'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/d56945782445b0b8c8658ed44f894c7b~tplv-obj.webp',
    filterGiftDiamonds: 15,
    giftToastEnabled: true,
    giftToastColor: '#1c1e26',
    giftToastOpacity: 90,
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
    meta: 100,
    goalStep: 100,
    onGoal: 'reset', // 'increase' | 'reset' | 'none'
    countdown: 2,
    cdWhen: 'start', // 'goal' | 'start'
    cdRestart: false,
    vsStyle: 1,
    rows: [
      {
        leftId: '13651',
        leftName: 'Go Popular',
        leftImg: 'https://p16-webcast.tiktokcdn.com/img/alisg/webcast-sg/resource/b342e28d73dac6547e0b3e2ad57f6597.png~tplv-obj.webp',
        leftDiamonds: 1,
        rightId: '231955',
        rightName: 'Good Job',
        rightImg: 'https://p16-webcast.tiktokcdn.com/img/alisg/webcast-sg/resource/047bfa2dcc6813c72fd2d8f649ee8ee2.png~tplv-obj.webp',
        rightDiamonds: 1,
      },
    ],
  },
  // Overlay Batalla VS (PK azul vs amarillo: wins + puntos por ronda)
  batallaVs: {
    enabled: true,
    // Estilo visual (no afecta la lógica del PK)
    winsHostColor: '#ffe566',
    winsRivalColor: '#4da3ff',
    pointsHostColor: '#ffe566',
    pointsRivalColor: '#7ec8ff',
    nameHostColor: '#ffffff',
    nameRivalColor: '#ffffff',
    ringHostColor: '', // vacío = marco PNG original
    ringRivalColor: '',
    circleScale: 100, // % tamaño círculo + avatar
    textScale: 100,   // % tamaño números + nombres
  },
  // Overlay Meta de la ronda (PK: faltan X / mantén ventaja)
  batallaMeta: {
    enabled: true,
    titleWaiting: 'Meta de la ronda',
    subWaiting: 'Se activa sola al empezar la batalla',
    labelWaiting: 'ESPERANDO PK',
    labelLive: 'EN VIVO',
    labelDemo: 'DEMO',
    subBehind: '¡Motiva al chat a empujar!',
    subAhead: 'No aflojes la presión',
    subTie: 'El siguiente punto decide la ronda',
    titleWin: 'Felicidades',
    subWin: '¡Ganaste la batalla!',
    titleLose: 'Suerte en la siguiente',
    subLose: 'La próxima es tuya',
    titleDraw: '¡Empate!',
    subDraw: 'La batalla terminó igualada',
    font: 'rubik',
    titleRainbow: true,
    tc1: '#ff00aa',
    tc2: '#00ddff',
    tc3: '#ffcc00',
    titleColor: '#ffffff',
    subColor: '#d2d2d8',
    behindColor: '#ff8f6b',
    aheadColor: '#7dffb0',
    tieColor: '#7ec8ff',
    winColor: '#7dffb0',
    loseColor: '#ff8f6b',
    hostScoreColor: '#7ec8ff',
    rivalScoreColor: '#ffe566',
    titleSize: 52,
  },
  // Overlay MVP de la batalla (PK: top al terminar)
  batallaMvp: {
    enabled: true,
    title: 'FAN MVP',
    badgeText: 'MVP',
    lineTpl: 'decidió la pelea con {n} puntos',
    lineNoPts: '',
    font: 'rubik',
    titleRainbow: true,
    showText: true,
    tc1: '#ff00aa',
    tc2: '#00ddff',
    tc3: '#ffcc00',
    nameColor: '#ffffff',
    lineColor: '#ffe566',
    scoreColor: '#b8b8c2',
    badgeBg1: '#ffd56a',
    badgeBg2: '#f0a800',
    badgeFg: '#1a1200',
    ring1: '#ffe98a',
    ring2: '#f0b400',
    nameSize: 36,
    lineSize: 34,
    showMs: 6500,
  },
  batallaTop3: {
    enabled: true,
    title: 'TOP 3 · TU EJÉRCITO',
    emptyText: 'Aún no hay aportes en tu ejército',
    labelWaiting: 'ESPERANDO PK',
    labelLive: 'EN VIVO',
    labelDemo: 'DEMO',
    font: 'rubik',
    titleRainbow: true,
    showTitle: true,
    showText: true,
    tc1: '#ff00aa',
    tc2: '#00ddff',
    tc3: '#ffcc00',
    titleColor: '#ffffff',
    nameColor: '#ffffff',
    ptsColor: '#ffe566',
    emptyColor: '#b8b8c2',
    titleSize: 28,
  },
  // Overlay Medidor de Flow (barra de progreso por participante / regalo)
  flowMeter: {
    title: 'MEDIDOR DE FLOW',
    textColor: '#ffffff',
    fontSize: 23,
    barHeight: 38,
    scale: 65,
    maxParticipants: 5,
    font: 'luckiest',
    showPercent: true,
    titleRainbow: true,
    nameRainbow: true,
    roundByTime: false,
    timerWins: false,
    roundSec: 60,
    participants: [
      {
        name: 'test1', tiktokUrl: '', avatar: '', color: '#ff4b91',
        giftId: '6093', giftName: 'Football',
        giftImage: 'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/c043cd9e418f13017793ddf6e0c6ee99~tplv-obj.webp',
      },
      {
        name: 'test2', tiktokUrl: '', avatar: '', color: '#40e0d0',
        giftId: '6064', giftName: 'GG',
        giftImage: 'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/3f02fa9594bd1495ff4e8aa5ae265eef~tplv-obj.webp',
      },
      {
        name: 'test3', tiktokUrl: '', avatar: '', color: '#9370db',
        giftId: '7934', giftName: 'Heart Me',
        giftImage: 'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/d56945782445b0b8c8658ed44f894c7b~tplv-obj.webp',
      },
      {
        name: 'test4', tiktokUrl: '', avatar: '', color: '#fbbf24',
        giftId: '7096', giftName: "It's corn",
        giftImage: 'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/37f5c76b65c17d6dbbbd4b6724f61bf2~tplv-obj.webp',
      },
    ],
    wins: [],
  },
  // Overlay Gift Sequence (secuencia rotativa de regalos con texto)
  giftSeq: {
    text: '#ffffff',
    accent: '#8df7d8',
    size: 28,
    font: 'system',
    anim: 'gift-zoom',
    rowSpeed: 7.6,
    textRainbow: true,
    stepSec: 2,
    sequence: [
      {
        giftName: "You're awesome",
        giftImage: 'https://p16-webcast.tiktokcdn.com/img/alisg/webcast-sg/resource/e9cafce8279220ed26016a71076d6a8a.png~tplv-obj.webp',
        customText: "You're awesome",
        textSide: 'bottom',
      },
      {
        giftName: 'Club Cheers',
        giftImage: 'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/resource/6a934c90e5533a4145bed7eae66d71bd.png~tplv-obj.webp',
        customText: 'Club Cheers',
        textSide: 'bottom',
      },
    ],
  },
  giftShowcase: {
    displayMode: 'marquee', visibleCount: 3, intervalSec: 2, marqueeSec: 18,
    iconSize: 88, gap: 24, font: 'bangers', fontSize: 22, textColor: '#ffffff', textStroke: 2,
    colorMode: 'solid', scale: 100,
    items: [
      {
        giftId: '19441',
        giftName: 'Freestyle',
        giftImage: 'https://p16-webcast.tiktokcdn.com/img/alisg/webcast-sg/resource/1f5ca5cfb4b98c2761fb85987f47c641.png~tplv-obj.webp',
        customText: 'Freestyle',
      },
      {
        giftId: '6064',
        giftName: 'GG',
        giftImage: 'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/3f02fa9594bd1495ff4e8aa5ae265eef~tplv-obj.webp',
        customText: 'GG',
      },
      {
        giftId: '54724',
        giftName: 'Creeper',
        giftImage: 'https://p16-webcast.tiktokcdn.com/img/alisg/webcast-sg/resource/d686d45bd66e16b0aca8b0e5eb52a977.png~tplv-obj.webp',
        customText: 'Creeper',
      },
      {
        giftId: '14543',
        giftName: 'Congratulations',
        giftImage: 'https://p16-webcast.tiktokcdn.com/img/alisg/webcast-sg/resource/8e73d843b23a9e68f8d3cf8c46fc0bee.png~tplv-obj.webp',
        customText: 'Congratulations',
      },
      {
        giftId: '131882',
        giftName: "It's Match Time",
        giftImage: 'https://p16-webcast.tiktokcdn.com/img/alisg/webcast-sg/resource/be170a9d325c02c1d5786301679bf013.png~tplv-obj.webp',
        customText: "It's Match Time",
      },
      {
        giftId: '7096',
        giftName: "It's corn",
        giftImage: 'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/37f5c76b65c17d6dbbbd4b6724f61bf2~tplv-obj.webp',
        customText: "It's corn",
      },
    ],
  },
  // Overlay Contador de victorias (manual, simple)
  winsCounter: {
    label: 'Wins', winsMax: 10, wins: 0, font: 'inter', rainbow: false,
    textColor: '#ffffff', accentColor: '#22c55e',
    bgColor: '#1c1c1f', borderColor: '#ffffff', fontSize: 28,
    hotkeys: {
      inc1: { on: false, key: 'F5', amount: 1, giftId: '', giftName: '', image: '' },
      dec1: { on: false, key: 'F6', amount: 1, giftId: '', giftName: '', image: '' },
      incN: { on: false, key: 'F7', amount: 5, giftId: '', giftName: '', image: '' },
      decN: { on: false, key: 'F8', amount: 5, giftId: '', giftName: '', image: '' },
    },
  },
  // Overlay Contador de victorias (manual, estilo Gamer HUD)
  winsCounterGamer: {
    label: 'WINS', winsMax: 10, wins: 0, font: 'orbitron', rainbow: false,
    scoreGlow: true,
    textColor: '#ffffff', accentColor: '#00ffaa',
    bgColor: '#0f0c1e', borderColor: '#9d4edd', fontSize: 28,
    hotkeys: {
      inc1: { on: false, key: 'F5', amount: 1, giftId: '', giftName: '', image: '' },
      dec1: { on: false, key: 'F6', amount: 1, giftId: '', giftName: '', image: '' },
      incN: { on: false, key: 'F7', amount: 5, giftId: '', giftName: '', image: '' },
      decN: { on: false, key: 'F8', amount: 5, giftId: '', giftName: '', image: '' },
    },
  },
  winsCounterMinecraft: {
    label: 'WINS', winsMax: 10, wins: 0, font: 'pressstart', rainbow: false,
    scoreGlow: true,
    textColor: '#ffffff', accentColor: '#55ff55',
    bgColor: '#565656', borderColor: '#c6c6c6', fontSize: 22,
    hotkeys: {
      inc1: { on: false, key: 'F1', amount: 1, giftId: '', giftName: '', image: '' },
      dec1: { on: false, key: 'F2', amount: 1, giftId: '', giftName: '', image: '' },
      incN: { on: false, key: 'F3', amount: 5, giftId: '', giftName: '', image: '' },
      decN: { on: false, key: 'F4', amount: 5, giftId: '', giftName: '', image: '' },
    },
  },
  winsCounterMario: {
    label: 'WINS', winsMax: 10, wins: 0, font: 'pressstart', rainbow: false,
    scoreGlow: true,
    textColor: '#ffffff', accentColor: '#ffe14d',
    bgColor: '#e52521', borderColor: '#049cd8', fontSize: 22,
    hotkeys: {
      inc1: { on: false, key: 'Ctrl+F1', amount: 1, giftId: '', giftName: '', image: '' },
      dec1: { on: false, key: 'Ctrl+F2', amount: 1, giftId: '', giftName: '', image: '' },
      incN: { on: false, key: 'Ctrl+F3', amount: 5, giftId: '', giftName: '', image: '' },
      decN: { on: false, key: 'Ctrl+F4', amount: 5, giftId: '', giftName: '', image: '' },
    },
  },
  // Spotify Song Requests (solo .exe · admin / albertoyt). Comandos del chat: !play/!skip/!revoke.
  spotify: {
    clientId: '',
    playOn: true, playCost: 0, skipOn: true, skipCost: 0,
    skipRequested: true, skipOwnOnly: false, skipOwnOnlyStrict: false, explicit: true, queueTotal: 2, queueUser: 2,
    overlayPermanent: true, permAll: false, permSubs: true, permMods: true,
    permUsersOn: false,
    // IDs de TikTok (@) que pueden usar !play / !skip / !revoke aunque no sean mod ni sub.
    permUsers: [],
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
  top1fire: {
    coinLabel: '',
    font: 'inter',
    showFx: true,
    resetPeriod: 'live',
    ng1: '#fff8f0', ng2: '#ffb347', ng3: '#ff4500',
    valueColor: '#ffe8d6', valueStroke: '#2a0a00', coinColor: '#ffd700',
  },
  habibiTop: {
    headerTitle: 'HABIBI DEL MES',
    resetPeriod: 'month',
    design: '1',
    coinLabel: 'diamantes',
    font: 'luckiest',
    rainbowMode: 'move',
    tc1: '#ff6b35', tc2: '#ff4500', tc3: '#ffd700',
    ng1: '#fff8f0', ng2: '#ffb347', ng3: '#ff4500',
    valueColor: '#ffe8d6', valueStroke: '#2a0a00', coinColor: '#ffd700',
    titleSize: 100,
    scale: 100,
  },
  // Overlay Mejor regalo (top único por monedas)
  topGift: {
    title: 'MEJOR REGALO',
    titleRainbow: true,
    titleColor: '#ffffff',
    tc1: '#ff00aa', tc2: '#00ddff', tc3: '#ffcc00',
    nameColor: '#e4e4ee', valueColor: '#e8c4a0',
    nameStroke: '#3d3d4a', valueStroke: '#4a3d2e',
    coinLabel: 'monedas', font: 'rubik',
    titleScale: 100, titleY: 0, bodyScale: 100, bodyY: 0, textLayer: 'front',
  },
  // Overlay Metas de regalos (multi-meta: 1/10, vertical / horizontal / banda)
  giftGoals: {
    layout: 'banda',
    scale: 67,
    iconSize: 78,
    gap: 18,
    font: 'luckiest',
    labelColor: '#ffffff',
    countColor: '#ffffff',
    barTrack: 'rgba(255,255,255,0.14)',
    bar1: '#22d3ee',
    bar2: '#e879f9',
    bar3: '#a855f7',
    showCompleted: true,
    bandaSec: 22,
    bandaVisible: 6,
    cardOpacity: 39,
    resetPeriod: 'month',
    items: [
      {
        id: 'gg_morning_bloom',
        giftId: '14785',
        giftName: 'Morning Bloom',
        giftImage: 'https://p16-webcast.tiktokcdn.com/img/alisg/webcast-sg/resource/89ada30bca30c6f1d684654ba70a5284.png~tplv-obj.webp',
        label: 'MORNING BLOOM',
        goal: 10,
      },
      {
        id: 'gg_thumbs_up',
        giftId: '6246',
        giftName: 'Thumbs Up',
        giftImage: 'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/570a663e27bdc460e05556fd1596771a~tplv-obj.webp',
        label: 'THUMBS UP',
        goal: 10,
      },
      {
        id: 'gg_pegasus',
        giftId: '9427',
        giftName: 'Pegasus',
        giftImage: 'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/resource/f600a2495ab5d250e7da2066484a9383.png~tplv-obj.webp',
        label: 'PEGASUS',
        goal: 10,
      },
      {
        id: 'gg_ice_cream_mic',
        giftId: '15199',
        giftName: 'Ice Cream Mic',
        giftImage: 'https://p16-webcast.tiktokcdn.com/img/alisg/webcast-sg/resource/7f784d1ec7b26d7d8cfd05faede11d76.png~tplv-obj.webp',
        label: 'ICE CREAM MIC',
        goal: 10,
      },
      {
        id: 'gg_dj_set',
        giftId: '133359',
        giftName: 'DJ Set',
        giftImage: 'https://p16-webcast.tiktokcdn.com/img/alisg/webcast-sg/resource/3798f7dd8de451efca9f0c357a591177.png~tplv-obj.webp',
        label: 'DJ SET',
        goal: 10,
      },
      {
        id: 'gg_animal_band',
        giftId: '11811',
        giftName: 'Animal Band',
        giftImage: 'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/resource/60d8c4148c9cd0c268e570741ccf4150.png~tplv-obj.webp',
        label: 'ANIMAL BAND',
        goal: 10,
      },
      {
        id: 'gg_rose',
        giftId: '5655',
        giftName: 'Rose',
        giftImage: 'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/eba3a9bb85c33e017f3648eaf88d7189~tplv-obj.webp',
        label: 'ROSE',
        goal: 3,
      },
      {
        id: 'gg_go_popular',
        giftId: '13651',
        giftName: 'Go Popular',
        giftImage: 'https://p16-webcast.tiktokcdn.com/img/alisg/webcast-sg/resource/b342e28d73dac6547e0b3e2ad57f6597.png~tplv-obj.webp',
        label: 'GO POPULAR',
        goal: 10,
      },
    ],
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
    titleColor: '#ffffff',
    tc1: '#ff00aa', tc2: '#00ddff', tc3: '#ffcc00',
    nameColor: '#e4e4ee', valueColor: '#e8c4a0',
    nameStroke: '#3d3d4a', valueStroke: '#4a3d2e',
    font: 'rubik',
    titleScale: 100, titleY: 0, bodyScale: 100, bodyY: 0, textLayer: 'front',
  },
  // Overlay Batalla de regalos (ranking por monedas)
  batallaGifts: {
    limit: 2, nameRainbow: true, placeholder: 'Esperando regalos...',
    valueColor: '#fde68a', coinColor: '#ffd700', bgOpacity: 45, vsStyle: 2,
    vsScale: 40, vsX: -19, vsY: 3, nameColor: '#ffffff', font: 'inter',
    cardBg: '#16262e', cardBorder: '#94a3b8',
  },
  // Overlay Batalla de likes (ranking por likes)
  batallaLikes: {
    limit: 2, nameRainbow: true, placeholder: 'Esperando combatientes...',
    valueColor: '#fecaca', likesIcon: '❤️', bgOpacity: 45, vsStyle: 2,
    vsScale: 40, vsX: -19, vsY: 3, nameColor: '#ffffff', font: 'inter',
    cardBg: '#16262e', cardBorder: '#94a3b8',
  },
  // Overlay Coin Match (partido cronometrado con podio)
  coinMatch: {
    title: 'Coin Match', durationSec: 180, topN: 3, accent: '#f43f5e',
    startDelaySec: 3, revealSec: 3, slowRevealFromSec: 3, slowRevealSec: 2, minBid: 1, maxParticipants: 100,
    winMode: 'keep', showTitle: true, showCount: true, scroll: true,
    sniper: false, slowReveal: false, font: 'inter',
  },
  // Rankings Likes / Diamantes (bandas y lista)
  toplikesRank: { rows: 5, accent: '#ffffff', rowBg: '#0c1c26', scale: 100, font: 'inter', transparent: false, nameRainbow: true, lines: true, shadows: true, mirror: false, resetPeriod: 'live' },
  topdiamRank: { rows: 5, accent: '#ffe08a', rowBg: '#0c1c26', scale: 100, font: 'inter', transparent: false, nameRainbow: true, lines: true, shadows: true, mirror: false, resetPeriod: 'live' },
  toplikesList: { rows: 9, accent: '#f4f4f5', scale: 100, font: 'inter', transparent: true, nameRainbow: true, lines: false, shadows: false, mirror: false, resetPeriod: 'live' },
  topdiamList: { rows: 9, accent: '#ffe08a', scale: 100, font: 'inter', transparent: true, nameRainbow: true, lines: false, shadows: false, mirror: false, resetPeriod: 'live' },
  topAltRank: {
    rows: 5, scale: 100, font: 'inter', rowBg: '#0c1c26',
    likesAccent: '#ffffff', diamAccent: '#ffe08a',
    transparent: false, nameRainbow: true, lines: true, shadows: true, mirror: false,
    intervalSec: 3, resetPeriodLikes: 'live', resetPeriodDiam: 'live',
  },
  topAltRankNeon: {
    rows: 3, scale: 100, font: 'orbitron',
    likesAccent: '#ff6b9d', diamAccent: '#ffe566',
    neonBorder: '#5b7cff', neonGlow: '#b44dff', pillBg: 'rgba(8,12,28,0.18)',
    transparent: true, nameRainbow: true, shadows: true, bounce: true, mirror: false,
    intervalSec: 3, resetPeriodLikes: 'live', resetPeriodDiam: 'live',
  },
  // Ranking de comentarios (chat): +1 por mensaje
  topcommentsRank: {
    rows: 5, accent: '#7dd3fc', rowBg: '#0c1c26', scale: 100, font: 'inter',
    transparent: false, nameRainbow: true, lines: true, shadows: true, mirror: false, resetPeriod: 'live',
  },
  // Overlay rotatorio: likes / coins / comentarios / puntos
  topMultiRank: {
    rows: 3, scale: 100, intervalSec: 4, font: 'cinzel',
    colorMode: 'solid',
    titleColor: '#ffffff', nameColor: '#ffffff', valueColor: '#ffffff', starColor: '#ffd54f',
    ring1: '#ffd54f', ring2: '#cfd8dc', ring3: '#ffab73', ringOther: '#7dd3fc', posColor: '#ffd54f',
    showLikes: true, showCoins: true, showComments: true, showPoints: true,
    titleLikes: 'TOP LIKES', titleCoins: 'TOP COINS', titleComments: 'TOP CHAT', titlePoints: 'RANKING',
    resetPeriodLikes: 'live', resetPeriodDiam: 'live', resetPeriodComments: 'live',
  },
  // Consulta de puntos por comando de chat (!puntos)
  pointsLookup: {
    enabled: true, command: '!puntos', durationSec: 6, scale: 100, font: 'inter',
    showCrown: true, pointsLabel: 'Points',
    rankColor: '#cfd8dc', levelColor: '#7dd3fc', nameColor: '#ffffff',
    pointsColor: '#b0b8c4', ringColor: '#ffd54f',
  },
  topPointsRank: {
    rows: 3, title: 'Top Puntos', accent: '#ffd54f', rowBg: '#0c1c26', scale: 100,
    font: 'inter', transparent: false, nameRainbow: true, titleRainbow: true,
    lines: true, shadows: true, glitter: true, showLevel: false, showTitle: true,
  },
  // Overlay Barra de meta (Hype) — skins: default | meta2 | meta3 | meta4
  hypeBar: {
    skin: 'default', goalKind: 'hype', title: '', meta: 100, whenReach: 'increase', scale: 100,
    pointsLike: 1, pointsFollow: 10, pointsShare: 8, pointsGift: 1, pointsMember: 1,
    font: 'inter', titleColor: '#ffffff', textColor: '#f8fafc',
    bar1: '#ff0f8f', bar2: '#38bdf8', bar3: '#c084fc', accent: '#38bdf8',
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
  fuegos: {
    minCoins: 1, maxFireworks: 5, soundEnabled: true, soundVolume: 80,
    showUsername: true, repeatWithCombos: true,
  },
  followerCounter: {
    variation: 'flip', font: 'exo2', fontSize: 50, lineSpacing: 50, letterSpacing: 50,
    fontColor: '#dedede', colorMode: 'solid',
    showFollowersText: true, showProfile: true, showProgressBar: true,
    showConfetti: false, goalFollowers: 10000, scale: 100,
  },
  followerCounterMc: {
    variation: 'flip', font: 'pressstart', fontSize: 42, lineSpacing: 50, letterSpacing: 50,
    fontColor: '#55ff55', colorMode: 'solid',
    showFollowersText: true, showProfile: true, showProgressBar: true,
    showConfetti: false, goalFollowers: 10000, scale: 100,
  },
  liveTimer: {
    title: 'TIEMPO EN LIVE',
    onLiveEnd: 'pause',
    neon: '#00ffcc',
    accent: '#ff00aa',
    liveColor: '#ff2244',
    textColor: '#ffffff',
    colorMode: 'solid',
    font: 'orbitron',
    titleSize: 22,
    timeSize: 42,
    dotSize: 14,
    letterSpacing: 12,
    scale: 100,
    bgOpacity: 88,
    showTitle: true,
    showLiveDot: true,
  },
  // Streams overlay — Join al live (estilo gamer)
  streamJoin: {
    neon: '#00ff66', durationSec: 4.5, scale: 100, posTop: 30, posLeft: 30, laserSpeed: 2, bgOpacity: 90,
    tagSize: 1.3, statusSize: 0.8, phraseMode: 'random', phrase: 'se unió al live',
    phrases: 'se unió a la partida|entró a la squad|ready to rumble|spawneó en el chat|se unió al live',
  },
  streamJoinMc: {
    neon: '#55ff55', accent: '#ffe14d', durationSec: 4.5, scale: 100, posTop: 24, posLeft: 30, laserSpeed: 2.2, bgOpacity: 92,
    tagSize: 0.72, statusSize: 0.52, phraseMode: 'random', phrase: 'entró al mundo',
    phrases: 'entró al mundo|spawn en el server|se unió al realm|minó el chat|player joined',
  },
  streamJoinDbz: {
    neon: '#ff9100', accent: '#2196f3', durationSec: 4.5, scale: 100, posTop: 30, posLeft: 30, laserSpeed: 1.6, bgOpacity: 88,
    tagSize: 1.55, statusSize: 0.72, phraseMode: 'random', phrase: 'entra en combate',
    phrases: 'entra en combate|power level rising|se unió a la batalla|ki detectado|fighter joined',
  },
  streamJoinMario: {
    neon: '#ffe14d', accent: '#e52521', durationSec: 4.5, scale: 100, posTop: 28, posLeft: 30, laserSpeed: 2, bgOpacity: 94,
    tagSize: 0.78, statusSize: 0.55, phraseMode: 'random', phrase: '¡player 1 join!',
    phrases: '¡player 1 join!|entró al nivel|1up en el chat|warp zone|se unió al castillo',
  },
  // Acciones (solo en la app .exe): cada acción dispara una tecla del teclado cuando
  // ocurre un evento del live. Lista de objetos:
  // { id, name, enabled, event, giftId, giftName, giftImage, minDiamonds,
  //   rangeMin, rangeMax, likeMin, likeGoal, emoteId, keys, gameCompat, keyHoldSec, image, sound, soundName, soundVolume }
  // Si el evento es un regalo específico y mandan varios (ej. 5 rosas), la tecla se
  // pulsa una vez por cada regalo. 'sound' (opcional) suena al activarse la acción.
  // event: 'gift-any' | 'gift' | 'like' | 'follow' | 'share'
  // keys: combinación ("Ctrl + A"), clic ("LeftClick") o texto ("Texto: hola")
  actions: [],
  // Webhook y Configuración (solo en la app .exe). El webhook HTTP (puerto 3199)
  // permite ejecutar acciones desde herramientas externas (OBS, Stream Deck, scripts).
  // La sub-pestaña "Configuración" guarda los datos de conexión a RCON / OBS / Streamer.bot.
  webhook: {
    rcon: { host: '127.0.0.1', port: 25575, password: '', playername: '' },
    obs: { ip: '127.0.0.1', port: 4455, password: '' },
    streamerbot: { address: '127.0.0.1', port: 8080, endpoint: '/', password: '' },
    // ServerTap / mod de TikFinity: alternativa a RCON para enviar comandos a Minecraft.
    servertap: { ip: 'localhost', port: 4567, key: 'change_me', playername: '', enabled: false },
  },
  // Acciones del juego Minecraft (solo .exe): cada una vincula un comando RCON a un
  // regalo o evento del live. { uid, catId, name, desc, cmd, trigger, giftId, giftName, giftImage, enabled }
  mcActions: [],
  // Acciones de Minecraft Shooters: mismo RCON que Survival, lista aparte.
  mcshooterActions: [],
  // Coliseo Shooters: comando de chat (!entro) → zombie en coords fijas, cooldown global.
  mcshooterColiseo: {
    enabled: false,
    chatCmd: '!entro',
    cooldownSec: 40,
    posX: 0,
    posY: 64,
    posZ: 0,
    spawnCmd: '',
  },
  // Acciones del juego Bedrock (Cubo TNT): mismas que Minecraft pero con comandos
  // /bedrock; se ejecutan por el MISMO RCON/ServerTap del servidor de Minecraft.
  bedrockActions: [],
  // Acciones del juego Minecraft Parkour: comandos /parkour; mismo RCON que Minecraft.
  parkourActions: [],
  // Acciones del juego Minecraft KOTH: comandos /koth; mismo RCON que Minecraft.
  kothActions: [],
  // Acciones del juego Minecraft Farm: comandos /farm; mismo RCON que Minecraft.
  farmActions: [],
  // Acciones del juego Sandbox: mismas que Bedrock pero con comandos /sandbox.
  sandboxActions: [],
  robloxActions: [],
  roblox3Actions: [],
  // Acciones del juego Mario Bros (solo .exe): cada una genera un objeto/enemigo en el
  // juego (vía http://localhost:7755/spawn) al recibir un regalo o evento del live.
  marioActions: [],
  mari0Actions: [],
  smb3Actions: [],
  // Acciones del juego Plants vs Zombies (solo .exe): genera zombies (/spawn) o da
  // soles al jugador (/sun) al recibir un regalo o evento del live.
  pvzActions: [],
  repoActions: [],
  l4dActions: [],
  unturnedActions: [],
  gtavKothActions: [],
  gtavChaosActions: [],
  gtavChiliadActions: [],
  ctrActions: [],
  smwActions: [],
  mslugActions: [],
  gdashActions: [],
  // Videos automáticos por nivel de miembro (public/video/niveles): al subir alguien de
  // nivel se reproduce nivelN.webm. screen = en qué Browser Source aparece.
  levelVideos: { enabled: true, screen: 1, volume: 100 },
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

/** True si hay al menos un regalo con nombre o imagen en la secuencia. */
export function giftSeqHasConfiguredGifts(cfg) {
  return Array.isArray(cfg?.sequence) && cfg.sequence.some((r) =>
    String(r?.giftName || '').trim() || String(r?.giftImage || '').trim()
  );
}

/**
 * Cuentas antiguas guardaron giftSeq con sequence: [] y pisan los defaults.
 * Si no hay regalos reales, aplica la secuencia demo por defecto.
 */
export function ensureGiftSeqDefaults(settings) {
  if (!settings || typeof settings !== 'object') return settings;
  if (!giftSeqHasConfiguredGifts(settings.giftSeq)) {
    settings.giftSeq = structuredClone(DEFAULT_SETTINGS.giftSeq);
  }
  return settings;
}

function giftVsHasConfiguredRows(cfg) {
  return Array.isArray(cfg?.rows) && cfg.rows.some((r) =>
    String(r?.leftId || r?.leftName || r?.leftImg || '').trim() ||
    String(r?.rightId || r?.rightName || r?.rightImg || '').trim()
  );
}

/**
 * Cuentas antiguas guardaron giftVs con rows: [] y pisan los defaults.
 * Si no hay parejas, aplica la demo Go Popular vs Good Job.
 */
export function ensureGiftVsDefaults(settings) {
  if (!settings || typeof settings !== 'object') return settings;
  if (!giftVsHasConfiguredRows(settings.giftVs)) {
    settings.giftVs = structuredClone(DEFAULT_SETTINGS.giftVs);
  }
  return settings;
}

/** True si hay al menos un regalo con nombre o imagen en la banda. */
export function giftShowcaseHasConfiguredItems(cfg) {
  return Array.isArray(cfg?.items) && cfg.items.some((r) =>
    String(r?.giftName || '').trim() || String(r?.giftImage || '').trim() || String(r?.giftId || '').trim()
  );
}

/**
 * Cuentas antiguas guardaron giftShowcase con items: [] y pisan los defaults.
 * Si no hay regalos reales, aplica la banda demo por defecto.
 */
export function ensureGiftShowcaseDefaults(settings) {
  if (!settings || typeof settings !== 'object') return settings;
  if (!giftShowcaseHasConfiguredItems(settings.giftShowcase)) {
    settings.giftShowcase = structuredClone(DEFAULT_SETTINGS.giftShowcase);
  }
  return settings;
}

/** True si hay al menos un participante con regalo real (id o imagen). */
export function flowMeterHasConfiguredParticipants(cfg) {
  return Array.isArray(cfg?.participants) && cfg.participants.some((p) =>
    String(p?.giftId || '').trim() || String(p?.giftImage || '').trim()
  );
}

/**
 * Cuentas antiguas guardaron flowMeter sin regalos reales y pisan los defaults.
 * Si no hay regalos, aplica la demo Football / GG / Heart Me / It's corn.
 */
export function ensureFlowMeterDefaults(settings) {
  if (!settings || typeof settings !== 'object') return settings;
  if (!flowMeterHasConfiguredParticipants(settings.flowMeter)) {
    settings.flowMeter = structuredClone(DEFAULT_SETTINGS.flowMeter);
  }
  return settings;
}
