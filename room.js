// Una "room" = un usuario. Encapsula TODO su estado, ajustes, conexión a TikTok,
// puntajes de batalla, ranking semanal y sus clientes WebSocket (panel + overlays).
// Los broadcasts solo llegan a los clientes de ESTA room, por lo que las alertas y
// datos de distintos usuarios nunca se mezclan.
import fs from 'node:fs';
import path from 'node:path';
import { TikTokLiveConnection, WebcastEvent, ControlEvent } from 'tiktok-live-connector';
import { DEFAULT_SETTINGS, deepMerge } from './default-settings.js';

/* ----------------------- Helpers sin estado (compartidos) ----------------------- */
function getPhoto(user) {
  if (!user) return null;
  return (
    user.profilePictureUrl ||
    user.profilePicture?.url?.[0] ||
    user.profilePicture?.urls?.[0] ||
    user.userDetails?.profilePictureUrls?.[0] ||
    null
  );
}
function getGiftImage(data) {
  return (
    data?.giftDetails?.giftImage?.giftPictureUrl ||
    data?.giftDetails?.image?.url?.[0] ||
    data?.giftPictureUrl ||
    null
  );
}
function baseUser(user) {
  return {
    uniqueId: user?.uniqueId || '',
    nickname: user?.nickname || user?.uniqueId || 'Anónimo',
    photo: getPhoto(user),
  };
}
function chatUserRoles(data) {
  const u = data?.user || {};
  const ui = data?.userIdentity || {};
  const badges = [].concat(u.badges || [], u.userBadges || [], u.newUserBadges || [], u.badgeImageList || []);
  const scene = (b) => Number(b?.badgeSceneType ?? b?.badgeScene ?? b?.sceneType ?? 0);
  const badgeUrl = (b) => String(b?.url || b?.image?.url?.[0] || b?.image?.uri || '').toLowerCase();
  const badgeType = (b) => String(b?.type || b?.displayType || '').toLowerCase();

  const isMod = !!(
    ui.isModeratorOfAnchor ||
    badges.some((b) => scene(b) === 1 || badgeType(b).includes('moderator'))
  );
  const isSub = !!(
    ui.isSubscriberOfAnchor ||
    Number(u?.fansClub?.data?.level || u?.fansClubInfo?.badge?.level || 0) > 0 ||
    badges.some((b) => scene(b) === 4 || scene(b) === 7 || badgeUrl(b).includes('/sub_'))
  );
  const followStatus = Number(u?.followInfo?.followStatus ?? u?.followStatus ?? 0);
  const isFollower = !!(ui.isFollowerOfAnchor || ui.isMutualFollowingWithAnchor || followStatus >= 1);
  const teamBadge = badges.find((b) => scene(b) === 10);
  const isTeam = !!(Number(teamBadge?.level || 0) > 0);

  return { isMod, isSub, isFollower, isTeam };
}
function matchesCommand(command, comment) {
  const cmd = String(command || '').trim().toLowerCase();
  if (!cmd) return false;
  const text = String(comment || '').trim().toLowerCase();
  if (!text) return false;
  return text === cmd || text.split(/\s+/)[0] === cmd;
}
function emoteImageUrl(img) {
  if (!img) return '';
  if (typeof img === 'string') return img;
  return img.url_list?.[0] || img.urlList?.[0] || img.imageUrl || img.url?.[0] || '';
}
function currentWeekRange(now = Date.now()) {
  const d = new Date(now);
  const day = (d.getDay() + 6) % 7; // 0 = lunes
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate() - day, 0, 0, 0, 0).getTime();
  const end = start + 7 * 86400000;
  return [start, end];
}
// Busca el multiplicador del golpe crítico (x2/x3) en cualquier parte de un mensaje PK.
function scanMultiplier(obj, depth, acc) {
  if (!obj || typeof obj !== 'object' || depth > 6) return;
  for (const k in obj) {
    const v = obj[k];
    if (v && typeof v === 'object') { scanMultiplier(v, depth + 1, acc); continue; }
    const key = k.toLowerCase();
    if (key === 'triggercriticalstrike' && (v === true || v === 1 || v === '1')) {
      acc.crit = true; acc.hits.push(`${k}=${v}`);
    } else if (key === 'multipliertype' && Number(v) === 1) {
      acc.crit = true; acc.hits.push(`${k}=${v}`);
    } else if (key === 'multipliervalue' || key === 'multiplier') {
      const n = Math.round(Number(v));
      if (n >= 2 && n <= 50) { acc.value = Math.max(acc.value, n); acc.crit = true; }
      if (n >= 1) acc.hits.push(`${k}=${v}`);
    } else if (key === 'critical') {
      if (Number(v) >= 1) { acc.crit = true; acc.hits.push(`${k}=${v}`); }
    }
  }
}

const MAX_CONNECT_ATTEMPTS = 4;

/* ----------------------- Persistencia segura (sin pérdidas) ----------------------- */
// Escritura ATÓMICA: escribe a un archivo temporal y luego lo renombra encima del
// definitivo. Si se corta la luz o el proceso muere a mitad de la escritura, el
// archivo original queda intacto (nunca a medio escribir). Así las alertas, sonidos
// y videos guardados no se pueden corromper ni perder por un guardado interrumpido.
function writeJsonAtomic(file, obj) {
  try {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, file);
  } catch (e) {
    console.error('  [!] No se pudo guardar', file, '-', e.message);
  }
}

// Lectura SEGURA de un JSON. Devuelve:
//   { data }        -> leído correctamente
//   { data: null }  -> el archivo no existe todavía (usuario nuevo)
//   { corrupt:true} -> existe pero está dañado; se guarda una copia .corrupt-<ts>
//                      para poder recuperarlo y NUNCA se pierde la información.
function readJsonSafe(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { data: null }; // no existe -> arrancamos con valores por defecto
  }
  try {
    return { data: JSON.parse(raw) };
  } catch (e) {
    try { fs.copyFileSync(file, file + '.corrupt-' + Date.now()); } catch {}
    console.error('  [!] Archivo dañado, se respaldó como .corrupt y se conserva:', file, '-', e.message);
    return { corrupt: true };
  }
}

/* --------------------------------- La room --------------------------------- */
export function createRoom({ id, username: account, roomKey, dataDir, giftsById, getCaps }) {
  fs.mkdirSync(dataDir, { recursive: true });
  const SETTINGS_FILE = path.join(dataDir, 'settings.json');
  const WEEKLY_FILE = path.join(dataDir, 'weekly.json');
  const POINTS_FILE = path.join(dataDir, 'points.json');

  const state = {
    username: null,
    connected: false,
    connecting: false,
    inBattle: false,
    criticalTimer: null,
    pendingMult: 0,
    pendingSrc: '',
    roomId: null,
    startedAt: null,
    stats: { viewers: 0, likes: 0, diamonds: 0, comments: 0, gifts: 0, follows: 0, shares: 0, joins: 0 },
    gifters: new Map(),
  };

  const battle = { scoreA: 0, scoreB: 0 };
  const giftCounter = { count: 0 }; // contador de meta (cuenta de la sesión)
  const timer = { remaining: 0, running: false };
  let timerInterval = null;
  const weekly = { start: 0, end: 0, donors: new Map() };
  // Usuario y Puntos: balance acumulado (de por vida) por usuario + historial de transacciones.
  const points = new Map();          // uniqueId -> { uniqueId, nickname, photo, total, levelPoints, firstAt, lastAt }
  let pointsTx = [];                 // transacciones recientes (las más nuevas primero), acotadas
  const POINTS_MAX_USERS = 2500;
  const POINTS_MAX_TX = 500;
  const clients = new Set();         // todos los WS de esta room (panel + overlays)
  const videoScreens = new Map();    // ws -> número de pantalla
  const chatSeenUsers = new Set();
  const emoteCatalog = new Map();
  // Pelotas de fans: acumulado por usuario (con sobrante) para soltar pelotas.
  const fanCoinAcc = new Map();      // uniqueId -> monedas pendientes
  const fanLikeAcc = new Map();      // uniqueId -> likes pendientes
  const recentSubs = new Map();      // dedupe suscripciones (subscribe/subNotify)
  const recentSuperFans = new Map(); // dedupe super fans (superFan/superFanJoin)
  // Ruleta / sorteo: participantes recogidos durante la recolección.
  const roulette = { collecting: false, entries: new Map(), giftImage: '' }; // uid -> { uniqueId, nickname, photo }
  const ROULETTE_MAX = 300;

  let connection = null;
  let saveTimer = null;
  let weeklySaveTimer = null;
  let statsTimer = null;
  let lastTotalLikes = 0;
  let lastLikeSound = 0;
  let lastSeen = 0; // última vez que hubo una conexión (panel u overlay) activa

  let settings = loadSettings();
  loadWeekly();
  loadPoints();
  timer.remaining = Math.max(0, Math.floor(settings.timer?.defaultInitialSec || 0));

  /* ----------------------------- Persistencia ----------------------------- */
  function loadSettings() {
    const r = readJsonSafe(SETTINGS_FILE);
    // Si el archivo existe y es válido, fusionamos con los valores por defecto
    // (así se conservan TODAS las alertas/sonidos/videos guardados).
    if (r.data) return deepMerge(structuredClone(DEFAULT_SETTINGS), r.data);
    // Archivo dañado: ya se respaldó como .corrupt. Arrancamos con defaults para
    // poder seguir trabajando, pero el respaldo permite recuperar lo anterior.
    return structuredClone(DEFAULT_SETTINGS);
  }
  function saveSettings() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => writeJsonAtomic(SETTINGS_FILE, settings), 300);
  }

  /* ------------------------------- Broadcast ------------------------------ */
  function broadcast(type, payload) {
    const msg = JSON.stringify({ type, payload });
    for (const client of clients) {
      if (client.readyState === 1) client.send(msg);
    }
  }
  function broadcastScreens() {
    broadcast('screens', { connected: [...new Set(videoScreens.values())] });
  }
  /* --------------------- Contador de meta (gift counter) -------------------- */
  function serializeGiftCounter() {
    const goal = Math.max(1, Number(settings.giftCounter?.goal) || 50);
    return { count: giftCounter.count, goal };
  }
  function broadcastGiftCounter() { broadcast('giftCounter', serializeGiftCounter()); }
  function setGiftCounter(n) {
    giftCounter.count = Math.max(0, Math.floor(Number(n) || 0));
    broadcastGiftCounter();
  }
  function resetGiftCounter() { giftCounter.count = 0; broadcastGiftCounter(); }
  // Suma al contador si el regalo coincide con el configurado (o cualquiera si no hay filtro).
  function countGiftForGoal(giftId, giftName, repeatCount) {
    const c = settings.giftCounter || {};
    const wantId = String(c.giftId || '').trim();
    const wantName = String(c.giftName || '').trim().toLowerCase();
    if (wantId) { if (String(giftId) !== wantId) return; }
    else if (wantName) { if ((giftName || '').toLowerCase() !== wantName) return; }
    // sin filtro => cuenta cualquier regalo
    giftCounter.count += Math.max(1, Number(repeatCount) || 1);
    broadcastGiftCounter();
  }
  // Capacidades del plan (límites + features). El panel las usa para ocultar
  // pestañas/overlays y bloquear el añadir más alertas de las permitidas.
  function currentCaps() {
    try { return getCaps ? getCaps() : null; } catch { return null; }
  }
  function broadcastCaps(caps) {
    broadcast('caps', caps || currentCaps() || {});
  }
  // Recorta los arrays guardados para no exceder los límites del plan. Solo actúa
  // si el límite es un número válido y el array lo supera (caso de degradar plan).
  function enforceLimits() {
    const caps = currentCaps();
    const lim = caps && caps.limits;
    if (!lim) return;
    const cap = (arr, n) => (Array.isArray(arr) && Number.isFinite(n) && arr.length > n ? arr.slice(0, n) : arr);
    settings.soundAlerts = cap(settings.soundAlerts, lim.soundAlerts);
    settings.videos = cap(settings.videos, lim.videos);
    settings.battleAlerts = cap(settings.battleAlerts, lim.battleAlerts);
  }
  function screenSize(n) {
    return settings.screens?.[(Number(n) || 1) - 1]?.size ?? 100;
  }

  /* ----------------------------- Temporizador ----------------------------- */
  // El temporizador es AUTORITATIVO en el servidor: aquí corre la cuenta atrás y
  // se difunde cada segundo a todos los overlays/paneles de la room. Así se mantiene
  // sincronizado aunque un overlay se reconecte o el navegador esté en segundo plano.
  function clampTimer() {
    if (timer.remaining < 0) timer.remaining = 0;
    const t = settings.timer || {};
    if (t.maxEnabled && Number(t.maxCapSec) > 0) {
      timer.remaining = Math.min(timer.remaining, Number(t.maxCapSec));
    }
  }
  function serializeTimer() {
    return { remaining: Math.max(0, Math.round(timer.remaining)), running: !!timer.running };
  }
  function broadcastTimer() { broadcast('timer', serializeTimer()); }
  function stopTimerInterval() {
    if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  }
  function addTimerSeconds(delta) {
    const d = Number(delta);
    if (!d || !Number.isFinite(d)) return;
    timer.remaining += d;
    clampTimer();
    broadcastTimer();
  }
  function timerReachZero() {
    stopTimerInterval();
    timer.running = false;
    const act = String(settings.timer?.actionOnFinish || 'pause');
    if (act === 'reset') {
      timer.remaining = Math.max(0, Math.floor(settings.timer?.defaultInitialSec || 0));
      clampTimer();
    } else if (act === 'beep') {
      broadcast('timerBeep', {});
    }
    broadcastTimer();
  }
  function startTimer(seconds) {
    if (seconds != null) { timer.remaining = Math.max(0, Math.floor(Number(seconds))); clampTimer(); }
    if (timer.remaining <= 0) { timer.running = false; broadcastTimer(); return; }
    stopTimerInterval();
    timer.running = true;
    broadcastTimer();
    timerInterval = setInterval(() => {
      timer.remaining -= 1;
      if (timer.remaining <= 0) { timer.remaining = 0; timerReachZero(); return; }
      broadcastTimer();
    }, 1000);
  }
  function pauseTimer() { stopTimerInterval(); timer.running = false; broadcastTimer(); }
  function setTimer(seconds) {
    if (seconds != null) timer.remaining = Math.max(0, Math.floor(Number(seconds)));
    clampTimer();
    broadcastTimer();
  }
  function resetTimer() {
    stopTimerInterval();
    timer.running = false;
    timer.remaining = Math.max(0, Math.floor(settings.timer?.defaultInitialSec || 0));
    clampTimer();
    broadcastTimer();
  }
  // Evita contar dos veces el mismo evento (algunos eventos de TikTok llegan por dos
  // canales: p. ej. SOCIAL y FOLLOW). Coalesce por tipo+usuario en una ventana corta.
  const recentTimerEvents = new Map();
  function timerEventOnce(kind, uid) {
    const key = kind + ':' + (uid || '');
    const now = Date.now();
    const last = recentTimerEvents.get(key) || 0;
    if (now - last < 1500) return false;
    recentTimerEvents.set(key, now);
    if (recentTimerEvents.size > 300) {
      for (const [k, t] of recentTimerEvents) if (now - t > 5000) recentTimerEvents.delete(k);
    }
    return true;
  }

  // Reinicia TODOS los overlays de la sesión EXCEPTO los acumulados semanales/mensuales
  // (top donador semanal). Se usa SOLO al conectar a un live y al finalizar (stream end).
  // No se llama en ninguna otra circunstancia (ni al reconectar overlays, ni al guardar
  // ajustes), para no borrar datos sin querer.
  function resetSessionOverlays() {
    // Botes / contadores acumulados de la sesión
    broadcast('jarronReset', {});
    broadcast('vaquitaReset', {});
    broadcast('marranitoReset', {});
    // Versus y secuencias
    broadcast('giftVsReset', {});
    broadcast('giftSeqReset', {});
    // Mejor regalo / mejor racha de la sesión
    broadcast('topGiftReset', {});
    broadcast('topStreakReset', {});
    // Contador de meta (gift counter) vuelve a 0
    resetGiftCounter();
    // Batallas de ranking (regalos / likes)
    broadcast('batallaGiftsReset', {});
    broadcast('batallaLikesReset', {});
    // Barra de meta (hype)
    broadcast('hypeReset', {});
    // Coin match (partido cronometrado)
    broadcast('coinMatchControl', { action: 'reset' });
    // Rankings de likes / diamantes (bandas y listas) de la sesión
    for (const rank of ['toplikes', 'topdiam', 'toplikeslist', 'topdiamlist']) {
      broadcast('rankReset', { rank });
    }
    // Animaciones momentáneas (corta cualquier alerta en curso)
    broadcast('alertaGiftReset', {});
    broadcast('alertaLikesReset', {});
    broadcast('alertaFollowReset', {});
    broadcast('streamJoinReset', {});
    // Temporizador: vuelve al tiempo inicial y en pausa al iniciar/terminar el live.
    resetTimer();
    // OJO: NO se reinicia el top donador semanal (weeklyTop / topDonor): es acumulado semanal.
  }

  /* ------------------------------- Batalla ------------------------------- */
  function handleBattleAction(data) {
    switch (data.op) {
      case 'add':
        if (data.team === 'A') battle.scoreA += Number(data.amount) || 0;
        if (data.team === 'B') battle.scoreB += Number(data.amount) || 0;
        break;
      case 'set':
        if (data.team === 'A') battle.scoreA = Math.max(0, Number(data.amount) || 0);
        if (data.team === 'B') battle.scoreB = Math.max(0, Number(data.amount) || 0);
        break;
      case 'reset':
        battle.scoreA = 0;
        battle.scoreB = 0;
        break;
      case 'receiving':
        settings.battle.receiving = data.value; // 'A' | 'B' | 'off'
        saveSettings();
        broadcast('settings', settings);
        break;
    }
    if (battle.scoreA < 0) battle.scoreA = 0;
    if (battle.scoreB < 0) battle.scoreB = 0;
    broadcast('battle', serializeBattle());
  }
  function serializeBattle() {
    return {
      enabled: settings.battle.enabled,
      teamA: settings.battle.teamA,
      teamB: settings.battle.teamB,
      goal: settings.battle.goal,
      receiving: settings.battle.receiving,
      scoreA: battle.scoreA,
      scoreB: battle.scoreB,
    };
  }

  /* ------------------------- Conexión a TikTok LIVE ------------------------- */
  function connectTo(username) {
    if (!username) return;
    if (state.connecting || (state.connected && state.username === username)) return;

    disconnect();

    state.username = username;
    state.connecting = true;
    lastTotalLikes = 0;
    resetStats();
    resetSessionOverlays(); // arranca la sesión con los overlays limpios (menos los semanales)
    pushState();
    broadcast('log', { level: 'info', text: `Conectando a @${username}...` });

    connection = new TikTokLiveConnection(username, {
      processInitialData: false,
      fetchRoomInfoOnConnect: true,
      requestPollingIntervalMs: 2000,
    });

    bindEvents(connection);
    tryConnect(connection, username, 1);
  }

  function tryConnect(conn, username, attempt) {
    if (conn !== connection) return;
    conn
      .connect()
      .then((connState) => {
        state.connected = true;
        state.connecting = false;
        state.roomId = connState?.roomId ?? null;
        state.startedAt = Date.now();
        pushState();
        broadcast('log', { level: 'ok', text: `Conectado a la sala ${state.roomId ?? ''}` });
      })
      .catch((err) => {
        if (conn !== connection) return;
        const msg = err?.message || String(err);
        if (attempt < MAX_CONNECT_ATTEMPTS) {
          const delay = attempt * 2500;
          broadcast('log', {
            level: 'info',
            text: `Intento ${attempt} fallido. Reintentando en ${delay / 1000}s... (el servicio gratuito de TikTok a veces está saturado)`,
          });
          setTimeout(() => tryConnect(conn, username, attempt + 1), delay);
          return;
        }
        state.connecting = false;
        state.connected = false;
        pushState();
        broadcast('log', {
          level: 'error',
          text: `No se pudo conectar tras ${MAX_CONNECT_ATTEMPTS} intentos: ${msg}. Verifica que @${username} esté EN VIVO y vuelve a intentar en un minuto.`,
        });
      });
  }

  function disconnect() {
    if (connection) {
      try { connection.disconnect(); } catch { /* ignore */ }
      connection = null;
    }
    state.connected = false;
    state.connecting = false;
    state.roomId = null;
  }

  /* ----------------------------- Disparadores ----------------------------- */
  // "Racha = 1": coalesce de disparos del mismo usuario+regalo en una ventana corta.
  // Devuelve true si hay que SALTAR el disparo (porque ya sonó hace muy poco).
  const recentGiftTriggers = new Map(); // "uid:giftId" -> timestamp del último disparo
  const COMBO_WINDOW_MS = 5000;
  function comboShouldSkip(uniqueId, giftId) {
    if (!settings.playback?.comboOnce) return false;
    const key = `${uniqueId || ''}:${giftId || ''}`;
    const now = Date.now();
    const last = recentGiftTriggers.get(key) || 0;
    // Limpieza ligera para que el mapa no crezca sin límite.
    if (recentGiftTriggers.size > 200) {
      for (const [k, t] of recentGiftTriggers) if (now - t > COMBO_WINDOW_MS) recentGiftTriggers.delete(k);
    }
    if (now - last < COMBO_WINDOW_MS) return true;
    recentGiftTriggers.set(key, now);
    return false;
  }

  // Pelotas de fans: acumula la cantidad (monedas o likes) por usuario y, cada
  // vez que se completa el umbral configurado, manda caer una pelota con su foto.
  // El sobrante se guarda para el siguiente evento del mismo usuario.
  function processFanBalls(kind, user, amount) {
    const cfg = settings.pelotas;
    if (!cfg) return;
    const uid = user && user.uniqueId;
    if (!uid || !(amount > 0)) return;
    const enabled = kind === 'coins' ? cfg.coinsEnabled : cfg.likesEnabled;
    if (!enabled) return;
    const every = Math.max(1, Number(kind === 'coins' ? cfg.coinsEvery : cfg.likesEvery) || 1);
    const acc = kind === 'coins' ? fanCoinAcc : fanLikeAcc;
    const carry = (acc.get(uid) || 0) + amount;
    const drops = Math.floor(carry / every);
    acc.set(uid, carry - drops * every);
    if (acc.size > 5000) acc.clear();
    if (drops > 0) {
      const count = Math.min(200, drops);
      broadcast('fanBallDrop', { photo: user.photo || '', nickname: user.nickname || '', count });
      broadcast('log', { level: 'ok', text: `🏀 Pelotas: ${count} de ${user.nickname || uid} (${kind === 'coins' ? 'monedas' : 'likes'} +${amount}, cada ${every})` });
    }
  }

  // ---- Ruleta / sorteo en vivo ----
  // Cada participante tiene un "peso": en modo donación es la suma de diamantes
  // (quien dona más tiene un trozo más grande = más probabilidad). En modo
  // palabra todos pesan igual (1).
  function serializeRoulette() {
    const entries = [...roulette.entries.values()]
      .slice(0, ROULETTE_MAX)
      .map((u) => ({ uniqueId: u.uniqueId, nickname: u.nickname, photo: u.photo, weight: u.weight || 1 }));
    return { collecting: roulette.collecting, count: roulette.entries.size, entries, giftImage: roulette.giftImage || '' };
  }
  function broadcastRoulette() { broadcast('roulette', serializeRoulette()); }
  function addRouletteEntry(user, weight) {
    if (!roulette.collecting) return;
    const uid = user && user.uniqueId;
    if (!uid) return;
    const add = Math.max(0, Number(weight) || 0);
    const existing = roulette.entries.get(uid);
    if (existing) {
      // Mismo usuario que vuelve a participar: acumula su peso (más diamantes).
      existing.weight += add || 1;
      if (user.nickname) existing.nickname = user.nickname;
      if (user.photo) existing.photo = user.photo;
    } else {
      if (roulette.entries.size >= ROULETTE_MAX) return;
      roulette.entries.set(uid, { uniqueId: uid, nickname: user.nickname || uid, photo: user.photo || '', weight: add || 1 });
    }
    broadcastRoulette();
  }
  function rouletteFromGift(user, totalCoins, giftImage) {
    if (!roulette.collecting || settings.roulette?.mode !== 'donors') return;
    const min = Math.max(0, Number(settings.roulette?.minCoins) || 0);
    if (!(totalCoins > 0) || totalCoins < min) return;
    // Guardamos el icono del último regalo recibido para mostrarlo en el centro de la ruleta.
    if (giftImage) roulette.giftImage = giftImage;
    // El peso es la cantidad de diamantes: 5 diamantes pesa 5 veces más que 1.
    addRouletteEntry(user, totalCoins);
    // Anima el regalo entrando al centro de la ruleta.
    if (giftImage) broadcast('rouletteGift', { image: giftImage });
  }
  function rouletteFromChat(user, comment) {
    if (!roulette.collecting || settings.roulette?.mode !== 'keyword') return;
    const kw = String(settings.roulette?.keyword || '').trim().toLowerCase();
    if (!kw) return;
    const text = String(comment || '').trim().toLowerCase();
    // Coincide si el comentario es la palabra o la contiene como palabra suelta.
    if (text === kw || new RegExp('(^|\\s)' + kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|\\s)').test(text)) {
      addRouletteEntry(user, 1); // en modo palabra todos pesan igual
    }
  }
  function rouletteSpin() {
    const list = [...roulette.entries.values()];
    if (!list.length) {
      broadcast('log', { level: 'warn', text: '🎡 Ruleta: no hay participantes.' });
      return;
    }
    // Selección ponderada por peso (diamantes). A más peso, más probabilidad.
    const total = list.reduce((s, u) => s + (u.weight || 1), 0);
    let r = Math.random() * total;
    let winner = list[list.length - 1];
    for (const u of list) { r -= (u.weight || 1); if (r <= 0) { winner = u; break; } }
    roulette.collecting = false;
    broadcast('log', { level: 'ok', text: `🎡 Ruleta: ganador → ${winner.nickname}` });
    broadcast('rouletteSpin', {
      winner: { uniqueId: winner.uniqueId, nickname: winner.nickname, photo: winner.photo },
      entries: list.map((u) => ({ uniqueId: u.uniqueId, nickname: u.nickname, photo: u.photo, weight: u.weight || 1 })),
    });
  }

  function triggerSoundAlerts(eventType, info = {}) {
    for (const a of settings.soundAlerts) {
      if (!a.enabled || !a.sound) continue;
      const trig = a.trigger || 'gift';
      if (trig !== eventType) continue;
      if (eventType === 'gift') {
        const wantName = (a.giftName || '').trim().toLowerCase();
        if (wantName || a.giftId) {
          const idMatch = a.giftId && String(a.giftId) === String(info.giftId || '');
          const nameMatch = wantName && wantName === (info.giftName || '').toLowerCase();
          if (!idMatch && !nameMatch) continue;
          if ((a.minDiamonds || 0) > (info.diamonds || 0)) continue;
        } else {
          const total = info.totalDiamonds || 0;
          if ((a.rangeMin || 0) > total) continue;
          if ((a.rangeMax || 0) > 0 && total > a.rangeMax) continue;
        }
      }
      if (eventType === 'emote') {
        const wantId = (a.emoteId || '').trim();
        if (wantId && wantId !== String(info.emoteId || '')) continue;
      }
      if (eventType === 'like') {
        if ((a.likeMin || 1) > (info.likeCount || 0)) continue;
      }
      if (eventType === 'chatCommand') {
        if (!matchesCommand(a.command, info.comment)) continue;
      }
      broadcast('log', { level: 'ok', text: `🔊 Alerta sonora: "${a.name}"` });
      broadcast('sound', { id: a.id, name: a.name, sound: a.sound, image: a.image, volume: a.volume });
    }
  }

  function triggerLikeGlobal(total) {
    if (!total || total <= lastTotalLikes) { lastTotalLikes = total || lastTotalLikes; return; }
    for (const a of settings.soundAlerts) {
      if (!a.enabled || !a.sound || (a.trigger || '') !== 'likeGlobal') continue;
      const goal = Math.max(1, a.likeGoal || 100);
      const before = Math.floor(lastTotalLikes / goal);
      const now = Math.floor(total / goal);
      if (now > before) {
        broadcast('sound', { id: a.id, name: a.name, sound: a.sound, image: a.image, volume: a.volume });
      }
    }
    if (settings.videosEnabled !== false) {
      for (const v of settings.videos) {
        if (!v.url || v.enabled === false || (v.trigger || '') !== 'likeGlobal') continue;
        const goal = Math.max(1, v.likeGoal || 100);
        if (Math.floor(total / goal) > Math.floor(lastTotalLikes / goal)) {
          const scr = Number(v.screen) || 1;
          broadcast('media', { id: v.id, name: v.name, url: v.url, screen: scr, volume: v.volume ?? 100, size: screenSize(scr) });
        }
      }
    }
    lastTotalLikes = total;
  }

  function triggerVideos(eventType, info = {}) {
    if (settings.videosEnabled === false) return;
    for (const v of settings.videos) {
      if (!v.url || v.enabled === false) continue;
      const trig = v.trigger || 'gift';
      if (trig !== eventType) continue;
      if (eventType === 'gift') {
        const wantName = (v.giftName || '').trim().toLowerCase();
        if (wantName || v.giftId) {
          const idMatch = v.giftId && String(v.giftId) === String(info.giftId || '');
          const nameMatch = wantName && wantName === (info.giftName || '').toLowerCase();
          if (!idMatch && !nameMatch) continue;
          if ((v.minDiamonds || 0) > (info.diamonds || 0)) continue;
        } else {
          const total = info.totalDiamonds || 0;
          if ((v.rangeMin || 0) > total) continue;
          if ((v.rangeMax || 0) > 0 && total > v.rangeMax) continue;
        }
      }
      if (eventType === 'emote') {
        const wantId = (v.emoteId || '').trim();
        if (wantId && wantId !== String(info.emoteId || '')) continue;
      }
      if (eventType === 'like') {
        if ((v.likeMin || 1) > (info.likeCount || 0)) continue;
      }
      if (eventType === 'chatCommand') {
        if (!matchesCommand(v.command, info.comment)) continue;
      }
      const scr = Number(v.screen) || 1;
      broadcast('media', { id: v.id, name: v.name, url: v.url, screen: scr, volume: v.volume ?? 100, size: screenSize(scr) });
    }
  }

  // Animaciones de batalla PK: 'critical' (x2), 'critical3' (x3), 'battleGift',
  // 'battleGiftAny', 'battleStart', 'battleEnd'.
  function fireBattleAlerts(actionType, info = {}) {
    if (settings.battleAlertsEnabled === false) return;
    for (const b of (settings.battleAlerts || [])) {
      if (!b.url || b.enabled === false) continue;
      const trig = b.trigger || ((b.giftName || b.giftId) ? 'battleGift' : 'battleGiftAny');
      if (trig !== actionType) continue;
      if (actionType === 'battleGift') {
        const wantName = (b.giftName || '').trim().toLowerCase();
        const idMatch = b.giftId && String(b.giftId) === String(info.giftId || '');
        const nameMatch = wantName && wantName === (info.giftName || '').toLowerCase();
        if (!idMatch && !nameMatch) continue;
      }
      if (actionType === 'battleGift' || actionType === 'battleGiftAny') {
        const count = info.repeatCount || info.giftCount || 1;
        if ((b.minCount || 1) > count) continue;
      }
      const scr = Number(b.screen) || 1;
      broadcast('log', { level: 'ok', text: `⚔️ Animación de batalla [${actionType}]: "${b.name}"` });
      broadcast('media', { id: b.id, name: b.name, url: b.url, screen: scr, volume: b.volume ?? 100, size: screenSize(scr) });
    }
  }

  // Comandos personalizados del chat: si el comentario coincide con un comando
  // configurado (ej. !idwarzone), el bot responde por voz (TTS) y muestra la respuesta.
  // Cooldown por comando para que una racha de mensajes no spamee la respuesta.
  const commandCooldown = new Map(); // comando -> timestamp último disparo
  function handleChatCommands(comment, user) {
    const cmds = settings.tts?.commands;
    if (!Array.isArray(cmds) || !cmds.length) return;
    for (const c of cmds) {
      if (!c || c.enabled === false) continue;
      if (!c.command || !c.response) continue;
      if (!matchesCommand(c.command, comment)) continue;
      const key = String(c.command).toLowerCase();
      const now = Date.now();
      if (now - (commandCooldown.get(key) || 0) < 4000) return; // 4s anti-spam
      commandCooldown.set(key, now);
      const text = String(c.response).replace(/\{user\}/gi, user?.nickname || user?.uniqueId || '');
      // Mensaje de bot: el panel lo muestra en el chat y lo lee en voz alta.
      broadcast('botReply', { command: c.command, text });
      broadcast('log', { level: 'ok', text: `🤖 Comando ${c.command} → ${text}` });
      return; // solo un comando por mensaje
    }
  }

  function noteCritical(value = 0, src = '') {
    if (settings.battleAlertsEnabled === false) return;
    const v = Math.round(Number(value) || 0);
    if (v > state.pendingMult) state.pendingMult = v;
    if (src) state.pendingSrc = src;
    if (state.criticalTimer) return;
    state.criticalTimer = setTimeout(() => {
      state.criticalTimer = null;
      const m = state.pendingMult >= 2 ? state.pendingMult : 2; // crítico sin valor => x2
      const src2 = state.pendingSrc;
      state.pendingMult = 0;
      state.pendingSrc = '';
      broadcast('log', { level: 'ok', text: `⚡ Golpe crítico (x${m}) en la batalla → animación${src2 ? ' [' + src2 + ']' : ''}` });
      if (m >= 3) fireBattleAlerts('critical3', { multiplier: m });
      else fireBattleAlerts('critical', { multiplier: m });
    }, 600);
  }

  /* ------------------------------- Estado ------------------------------- */
  function topGifters(limit = 10) {
    return [...state.gifters.values()].sort((a, b) => b.diamonds - a.diamonds).slice(0, limit);
  }
  function serializeState() {
    return {
      username: state.username,
      connected: state.connected,
      connecting: state.connecting,
      roomId: state.roomId,
      startedAt: state.startedAt,
      stats: state.stats,
      topGifters: topGifters(),
    };
  }
  function pushState() {
    broadcast('state', serializeState());
  }
  function resetStats() {
    state.stats = { viewers: 0, likes: 0, diamonds: 0, comments: 0, gifts: 0, follows: 0, shares: 0, joins: 0 };
    state.gifters.clear();
    chatSeenUsers.clear();
    emoteCatalog.clear();
    fanCoinAcc.clear();
    fanLikeAcc.clear();
    recentSubs.clear();
    recentSuperFans.clear();
    roulette.entries.clear();
    roulette.collecting = false;
    roulette.giftImage = '';
  }
  let statsThrottle = false;
  function pushStatsThrottled() {
    if (statsThrottle) return;
    statsThrottle = true;
    statsTimer = setTimeout(() => { statsThrottle = false; pushState(); }, 500);
  }

  /* ------------------------- Top donador semanal ------------------------- */
  function loadWeekly() {
    const [start, end] = currentWeekRange();
    const r = readJsonSafe(WEEKLY_FILE);
    const raw = r.data;
    if (raw && raw.start === start) {
      weekly.start = start; weekly.end = end;
      weekly.donors = new Map((raw.donors || []).map((u) => [u.uniqueId, u]));
      return;
    }
    weekly.start = start; weekly.end = end; weekly.donors = new Map();
  }
  function saveWeekly() {
    clearTimeout(weeklySaveTimer);
    weeklySaveTimer = setTimeout(() => {
      const data = { start: weekly.start, end: weekly.end, donors: [...weekly.donors.values()] };
      writeJsonAtomic(WEEKLY_FILE, data);
    }, 400);
  }
  function ensureWeek() {
    const [start, end] = currentWeekRange();
    if (start !== weekly.start) {
      weekly.start = start; weekly.end = end; weekly.donors.clear();
      saveWeekly();
      broadcastWeeklyTop();
    }
  }
  function addWeeklyDonation(user, coins) {
    if (!user?.uniqueId || !(coins > 0)) return;
    ensureWeek();
    const u = weekly.donors.get(user.uniqueId) || { uniqueId: user.uniqueId, nickname: user.nickname, photo: user.photo, coins: 0 };
    u.coins += coins;
    u.nickname = user.nickname || u.nickname;
    if (user.photo) u.photo = user.photo;
    weekly.donors.set(user.uniqueId, u);
    saveWeekly();
    broadcastWeeklyTop();
  }
  function serializeWeeklyTop() {
    ensureWeek();
    const entries = [...weekly.donors.values()]
      .sort((a, b) => b.coins - a.coins)
      .slice(0, 3)
      .map((u) => ({ uniqueId: u.uniqueId, nickname: u.nickname, profilePictureUrl: u.photo, coins: u.coins }));
    return { top: entries[0] || null, entries, weekStart: weekly.start, weekEnd: weekly.end, now: Date.now() };
  }
  function broadcastWeeklyTop() {
    broadcast('weeklyTop', serializeWeeklyTop());
  }

  /* ------------------------- Usuario y Puntos ------------------------- */
  // El nivel se alcanza con una curva triangular: el nivel L se logra al acumular
  // STEP * L*(L-1)/2 puntos (cada nivel cuesta un poco más que el anterior).
  const POINTS_LEVEL_STEP = 7;
  function levelForPoints(p) {
    if (!(p > 0)) return 1;
    return Math.floor((Math.sqrt((8 * p) / POINTS_LEVEL_STEP + 1) - 1) / 2) + 1;
  }
  function pointsToReachLevel(level) {
    const L = Math.max(1, level);
    return Math.round((POINTS_LEVEL_STEP * L * (L - 1)) / 2);
  }

  let pointsSaveTimer = null;
  function loadPoints() {
    const r = readJsonSafe(POINTS_FILE);
    const raw = r.data;
    if (raw && Array.isArray(raw.users)) {
      for (const u of raw.users) {
        if (!u || !u.uniqueId) continue;
        points.set(u.uniqueId, {
          uniqueId: u.uniqueId,
          nickname: u.nickname || u.uniqueId,
          photo: u.photo || '',
          total: Math.max(0, Number(u.total) || 0),
          levelPoints: Math.max(0, Number(u.levelPoints != null ? u.levelPoints : u.total) || 0),
          firstAt: Number(u.firstAt) || Date.now(),
          lastAt: Number(u.lastAt) || Date.now(),
        });
      }
    }
    if (raw && Array.isArray(raw.tx)) pointsTx = raw.tx.slice(0, POINTS_MAX_TX);
  }
  function savePoints() {
    clearTimeout(pointsSaveTimer);
    pointsSaveTimer = setTimeout(() => {
      const data = { users: [...points.values()], tx: pointsTx.slice(0, POINTS_MAX_TX) };
      writeJsonAtomic(POINTS_FILE, data);
    }, 500);
  }

  function serializePointUser(u) {
    const level = levelForPoints(u.levelPoints);
    return {
      uniqueId: u.uniqueId, nickname: u.nickname, photo: u.photo,
      total: u.total, levelPoints: u.levelPoints, level,
      levelBase: pointsToReachLevel(level), nextLevel: pointsToReachLevel(level + 1),
      firstAt: u.firstAt, lastAt: u.lastAt,
    };
  }
  function serializePoints() {
    const users = [...points.values()]
      .sort((a, b) => b.total - a.total)
      .map(serializePointUser);
    return { users, count: users.length, max: POINTS_MAX_USERS, tx: pointsTx.slice(0, POINTS_MAX_TX) };
  }
  function pushPointUser(u) {
    broadcast('pointsUpdate', { user: serializePointUser(u), count: points.size });
  }

  // Si superamos el tope de usuarios, quitamos al de actividad más antigua.
  function enforcePointsCap() {
    while (points.size > POINTS_MAX_USERS) {
      let oldestKey = null; let oldestAt = Infinity;
      for (const [k, v] of points) { if (v.lastAt < oldestAt) { oldestAt = v.lastAt; oldestKey = k; } }
      if (oldestKey == null) break;
      points.delete(oldestKey);
    }
  }

  function logPointsTx(entry) {
    const tx = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      uniqueId: entry.uniqueId, nickname: entry.nickname,
      points: entry.points, description: entry.description || '',
      counted: entry.counted !== false, manual: !!entry.manual, at: Date.now(),
    };
    pointsTx.unshift(tx);
    if (pointsTx.length > POINTS_MAX_TX) pointsTx.length = POINTS_MAX_TX;
    broadcast('pointsTx', { tx });
    return tx;
  }

  // Añade (o resta) puntos a un usuario. counted=true => también cuentan para el nivel.
  function addUserPoints({ uniqueId, nickname, photo, amount, counted = true, description = '', manual = false }) {
    const key = String(uniqueId || '').trim().replace(/^@/, '').toLowerCase();
    if (!key || !Number.isFinite(amount) || amount === 0) return null;
    const now = Date.now();
    const u = points.get(key) || { uniqueId: key, nickname: nickname || key, photo: photo || '', total: 0, levelPoints: 0, firstAt: now, lastAt: now };
    u.total = Math.max(0, u.total + amount);
    if (counted) u.levelPoints = Math.max(0, u.levelPoints + amount);
    if (nickname) u.nickname = nickname;
    if (photo) u.photo = photo;
    u.lastAt = now;
    points.set(key, u);
    enforcePointsCap();
    logPointsTx({ uniqueId: key, nickname: u.nickname, points: amount, description, counted, manual });
    savePoints();
    pushPointUser(u);
    return u;
  }

  function resetAllPoints() {
    points.clear();
    pointsTx = [];
    savePoints();
    broadcast('pointsList', serializePoints());
  }
  function resetOnePoints(uniqueId) {
    const key = String(uniqueId || '').trim().replace(/^@/, '').toLowerCase();
    if (points.delete(key)) { savePoints(); broadcast('pointsList', serializePoints()); }
  }

  /* ------------------------------- Emotes ------------------------------- */
  function rememberEmote(emoteId, image) {
    const eid = String(emoteId || '').trim();
    if (!eid) return;
    const url = emoteImageUrl(image);
    const prev = emoteCatalog.get(eid);
    if (!prev || (!prev.image && url)) {
      emoteCatalog.set(eid, { id: eid, image: url });
      broadcast('emoteCatalog', { results: [...emoteCatalog.values()] });
    }
  }

  /* --------------------------- Eventos del live --------------------------- */
  function bindEvents(conn) {
    conn.on(ControlEvent.DISCONNECTED, () => {
      state.connected = false;
      pushState();
      broadcast('log', { level: 'info', text: 'Desconectado del live.' });
    });

    conn.on(ControlEvent.ERROR, (e) => {
      broadcast('log', { level: 'error', text: `Error: ${e?.info || e?.exception?.message || e}` });
    });

    conn.on(WebcastEvent.CHAT, (data) => {
      state.stats.comments++;
      const comment = data.comment || '';
      broadcast('chat', { ...baseUser(data.user || data), comment, ...chatUserRoles(data) });
      pushStatsThrottled();
      if (Array.isArray(data.emotes)) {
        for (const se of data.emotes) rememberEmote(se?.emote?.emoteId, se?.emote?.image);
      }
      triggerVideos('chatCommand', { comment });
      triggerSoundAlerts('chatCommand', { comment });
      handleChatCommands(comment, baseUser(data.user || data));
      rouletteFromChat(baseUser(data.user || data), comment);
      if (settings.timer?.chat) addTimerSeconds(settings.timer.chat);
      const uid = data.user?.uniqueId || data.user?.userId;
      if (uid && !chatSeenUsers.has(uid)) {
        chatSeenUsers.add(uid);
        triggerVideos('firstMessage', {});
        triggerSoundAlerts('firstMessage', {});
      }
    });

    conn.on(WebcastEvent.GIFT, (data) => {
      const user = baseUser(data.user);
      const giftType = data.giftDetails?.giftType;
      const giftId = data.giftId ?? data.giftDetails?.id ?? '';
      const cat = giftsById.get(String(giftId));
      const diamondsEach = data.giftDetails?.diamondCount || cat?.diamonds || 0;
      const giftName = data.giftDetails?.giftName || cat?.name || 'Regalo';
      const repeatCount = data.repeatCount || 1;
      const image = getGiftImage(data);

      const isStreak = giftType === 1 && !data.repeatEnd;
      if (!isStreak) {
        const total = diamondsEach * repeatCount;
        state.stats.gifts++;
        state.stats.diamonds += total;

        if (user.uniqueId) {
          const g = state.gifters.get(user.uniqueId) || { ...user, diamonds: 0 };
          g.diamonds += total;
          g.nickname = user.nickname;
          g.photo = user.photo || g.photo;
          state.gifters.set(user.uniqueId, g);
        }
        addWeeklyDonation(user, total);
        // Usuario y Puntos: acumula los puntos donados de por vida (configurable: puntos por moneda).
        if (user.uniqueId && total > 0) {
          const perCoin = Number(settings.points?.perCoin);
          const award = Math.round(total * (Number.isFinite(perCoin) && perCoin > 0 ? perCoin : 1));
          if (award > 0) addUserPoints({ uniqueId: user.uniqueId, nickname: user.nickname, photo: user.photo, amount: award, counted: true, description: `Regalo: ${giftName}`, manual: false });
        }
        pushState();

        if (settings.battle.enabled && total > 0) {
          if (settings.battle.receiving === 'A') battle.scoreA += total;
          else if (settings.battle.receiving === 'B') battle.scoreB += total;
          if (settings.battle.receiving !== 'off') broadcast('battle', serializeBattle());
        }

        addTimerSeconds(total * (settings.timer?.giftMult || 0));

        const giftInfo = { giftName, giftId, diamonds: diamondsEach, totalDiamonds: diamondsEach * repeatCount };
        broadcast('log', { level: 'info', text: `🎁 Regalo: ${giftName} (id ${giftId}) ×${repeatCount} · 💎${diamondsEach}` });
        // "Racha = 1": si está activo, una racha/ráfaga del mismo regalo y usuario dispara
        // la alerta/sonido/video una sola vez (los diamantes y contadores sí suman todo).
        if (!comboShouldSkip(user.uniqueId, giftId)) {
          triggerVideos('gift', { ...giftInfo, giftName: giftName.toLowerCase() });
          triggerSoundAlerts('gift', giftInfo);
        }
        countGiftForGoal(giftId, giftName, repeatCount);
        processFanBalls('coins', user, total);
        rouletteFromGift(user, total, image);
      }

      broadcast('gift', { ...user, giftName, giftId, repeatCount, diamonds: diamondsEach, image, streak: isStreak });
    });

    conn.on(WebcastEvent.LIKE, (data) => {
      state.stats.likes = data.totalLikeCount ?? state.stats.likes + (data.likeCount || 0);
      addTimerSeconds(((data.likeCount || 0) / 100) * (settings.timer?.like || 0));
      processFanBalls('likes', baseUser(data.user), data.likeCount || 0);
      broadcast('like', { ...baseUser(data.user), count: data.likeCount || 0, total: state.stats.likes });
      if (Date.now() - lastLikeSound > 3000) {
        lastLikeSound = Date.now();
        triggerSoundAlerts('like', { likeCount: data.likeCount || 0 });
        triggerVideos('like', { likeCount: data.likeCount || 0 });
      }
      if (typeof data.totalLikeCount === 'number') triggerLikeGlobal(data.totalLikeCount);
      pushStatsThrottled();
    });

    conn.on(WebcastEvent.MEMBER, (data) => {
      state.stats.joins++;
      if (data.memberCount) state.stats.viewers = data.memberCount;
      broadcast('member', baseUser(data.user));
      pushStatsThrottled();
    });

    conn.on(WebcastEvent.ROOM_USER, (data) => {
      if (typeof data.viewerCount === 'number') {
        state.stats.viewers = data.viewerCount;
        pushStatsThrottled();
      }
    });

    conn.on(WebcastEvent.SOCIAL, (data) => {
      const user = baseUser(data.user);
      const action = (data.action || '').toLowerCase();
      if (action.includes('follow')) {
        state.stats.follows++;
        broadcast('follow', user);
        triggerVideos('follow');
        triggerSoundAlerts('follow');
        if (timerEventOnce('follow', user.uniqueId)) addTimerSeconds(settings.timer?.follow || 0);
      } else if (action.includes('share')) {
        state.stats.shares++;
        broadcast('share', user);
        triggerVideos('share');
        triggerSoundAlerts('share');
        if (timerEventOnce('share', user.uniqueId)) addTimerSeconds(settings.timer?.share || 0);
      }
      pushStatsThrottled();
    });

    conn.on(WebcastEvent.FOLLOW, (data) => {
      const user = baseUser(data.user);
      state.stats.follows++;
      broadcast('follow', user);
      triggerSoundAlerts('follow');
      if (timerEventOnce('follow', user.uniqueId)) addTimerSeconds(settings.timer?.follow || 0);
      pushStatsThrottled();
    });

    conn.on(WebcastEvent.SHARE, (data) => {
      const user = baseUser(data.user);
      state.stats.shares++;
      broadcast('share', user);
      triggerSoundAlerts('share');
      if (timerEventOnce('share', user.uniqueId)) addTimerSeconds(settings.timer?.share || 0);
      pushStatsThrottled();
    });

    conn.on(WebcastEvent.EMOTE, (data) => {
      const list = data?.emoteList || (data?.emoteId ? [{ emoteId: data.emoteId, image: data.image }] : []);
      for (const e of list) rememberEmote(e?.emoteId, e?.image);
      const emoteId = list[0]?.emoteId || data?.emoteId || '';
      triggerSoundAlerts('emote', { emoteId });
      triggerVideos('emote', { emoteId });
    });

    // ===== Suscripciones (con nivel / meses) =====
    function handleSubscribe(data) {
      const user = baseUser(data?.user || data);
      const months = Number(data?.subMonth ?? data?.totalSubMonth ?? data?.months ?? data?.cumulativeMonths ?? 0) || 0;
      const level = Number(data?.subscribeLevel ?? data?.level ?? 0) || 0;
      const uid = user.uniqueId || 'anon';
      const now = Date.now();
      if (now - (recentSubs.get(uid) || 0) < 4000) return; // evita doble disparo (subscribe + subNotify)
      recentSubs.set(uid, now);
      if (recentSubs.size > 500) recentSubs.clear();
      const monthsTxt = months > 0 ? ` · ${months} ${months === 1 ? 'mes' : 'meses'}` : '';
      broadcast('log', { level: 'ok', text: `⭐ Suscriptor: ${user.nickname}${monthsTxt}${level ? ` · nivel ${level}` : ''}` });
      const info = { ...user, months, level };
      broadcast('subscribe', info);
      triggerSoundAlerts('subscribe', info);
      triggerVideos('subscribe', info);
      addTimerSeconds(settings.timer?.subscribe || 0);
      const subBonus = Math.round(Number(settings.points?.subBonus) || 0);
      if (user.uniqueId && subBonus > 0) {
        addUserPoints({ uniqueId: user.uniqueId, nickname: user.nickname, photo: user.photo, amount: subBonus, counted: true, description: months > 0 ? `Suscripción (${months} m)` : 'Suscripción', manual: false });
      }
    }
    conn.on('subscribe', handleSubscribe);
    conn.on(WebcastEvent.SUB_NOTIFY, handleSubscribe);

    // ===== Super fans =====
    function handleSuperFan(data) {
      const user = baseUser(data?.user || data);
      const level = Number(data?.superFanLevel ?? data?.fanLevel ?? data?.level ?? 0) || 0;
      const uid = user.uniqueId || 'anon';
      const now = Date.now();
      if (now - (recentSuperFans.get(uid) || 0) < 5000) return; // dedupe superFan + superFanJoin
      recentSuperFans.set(uid, now);
      if (recentSuperFans.size > 500) recentSuperFans.clear();
      broadcast('log', { level: 'ok', text: `🌟 Super fan: ${user.nickname}${level ? ` · nivel ${level}` : ''}` });
      const info = { ...user, level };
      broadcast('superfan', info);
      triggerSoundAlerts('superFan', info);
      triggerVideos('superFan', info);
      // Pelota dorada con la foto del super fan (overlay de pelotas).
      broadcast('goldenBall', { photo: user.photo || '', nickname: user.nickname || '', count: 1 });
      const bonus = Math.round(Number(settings.points?.superFanBonus) || 0);
      if (user.uniqueId && bonus > 0) {
        addUserPoints({ uniqueId: user.uniqueId, nickname: user.nickname, photo: user.photo, amount: bonus, counted: true, description: 'Super fan', manual: false });
      }
    }
    conn.on(WebcastEvent.SUPER_FAN, handleSuperFan);
    conn.on(WebcastEvent.SUPER_FAN_JOIN, handleSuperFan);

    // ===== Batallas PK de TikTok =====
    // Catch-all: escanea todos los mensajes en busca del golpe crítico (x2/x3).
    conn.on(ControlEvent.DECODED_DATA, (type, decoded) => {
      try {
        const t = String(type || '');
        if (!/gift|linkmic|battle/i.test(t)) return;
        const isBattleMsg = /linkmic|battle/i.test(t);
        if (!isBattleMsg && !state.inBattle) return;
        const data = decoded?.data ?? decoded;
        if (!data || typeof data !== 'object') return;
        const acc = { crit: false, value: 0, hits: [] };
        scanMultiplier(data, 0, acc);
        if (acc.crit || acc.value >= 2) {
          state.inBattle = true;
          const src = `${t.replace(/^Webcast/, '')}${acc.hits.length ? ' ' + acc.hits.join(' ') : ''}`;
          noteCritical(acc.value, src);
        }
      } catch {}
    });

    conn.on(WebcastEvent.LINK_MIC_BATTLE, (data) => {
      try {
        const a = data?.action;
        const isStart = a === 4 || a === 'BATTLE_ACTION_OPEN';
        const isEnd = a === 5 || a === 6 || a === 'BATTLE_ACTION_FINISH' || a === 'BATTLE_ACTION_CUT_SHORT';
        if (isStart) {
          state.inBattle = true;
          broadcast('log', { level: 'ok', text: '⚔️ Batalla PK iniciada' });
          fireBattleAlerts('battleStart', {});
        } else if (isEnd) {
          state.inBattle = false;
          broadcast('log', { level: 'info', text: '⚔️ Batalla PK finalizada' });
          fireBattleAlerts('battleEnd', {});
        }
      } catch {}
    });

    conn.on(WebcastEvent.LINK_MIC_ARMIES, (data) => {
      try {
        state.inBattle = true;
        const giftId = String(data?.giftId || '');
        const giftCount = Number(data?.giftCount || 0);
        const repeatCount = Number(data?.repeatCount || 0);
        const fromUserId = String(data?.fromUserId || '');
        const cat = giftsById.get(giftId);
        const giftName = (cat?.name || '').toLowerCase();
        const info = { giftId, giftName, giftCount, repeatCount: repeatCount || giftCount, fromUserId };
        if (giftId && giftId !== '0') {
          broadcast('log', { level: 'info', text: `⚔️ Regalo de batalla: ${cat?.name || ('id ' + giftId)} ×${info.repeatCount || 1}` });
          fireBattleAlerts('battleGiftAny', info);
          fireBattleAlerts('battleGift', info);
        }
      } catch {}
    });

    conn.on(WebcastEvent.STREAM_END, () => {
      state.inBattle = false;
      state.connected = false;
      pushState();
      broadcast('log', { level: 'info', text: 'El live terminó.' });
      resetSessionOverlays(); // al finalizar el live, limpia overlays (menos los semanales)
    });
  }

  /* ---------------------- Mensajes WS desde el navegador ---------------------- */
  function handleMessage(ws, data) {
    switch (data.action) {
      case 'ping':
        // Keepalive desde el navegador: respondemos al instante para confirmar vida.
        try { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'pong' })); } catch {}
        break;
      case 'connect':
        if (data.username) connectTo(String(data.username).trim().replace(/^@/, ''));
        break;
      case 'disconnect':
        disconnect();
        break;
      case 'saveSettings':
        if (data.settings) {
          settings = deepMerge(settings, data.settings);
          enforceLimits();
          saveSettings();
          broadcast('settings', settings);
          clampTimer();
          broadcastTimer();
        }
        break;
      case 'testAlert': {
        const demoUser = { uniqueId: 'demo', nickname: 'Usuario de prueba', photo: null };
        broadcast(data.kind || 'gift', {
          ...demoUser, giftName: 'Rosa', repeatCount: 1, diamonds: 5, image: null, streak: false, test: true,
        });
        // El regalo simulado también alimenta las pelotas de fans (modo prueba).
        if (!data.kind || data.kind === 'gift') processFanBalls('coins', demoUser, 5);
        break;
      }
      case 'getPoints':
        try { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'pointsList', payload: serializePoints() })); } catch {}
        break;
      case 'addPointsTx': {
        // Transacción manual: suma o resta puntos a un usuario. amount negativo = retirar.
        const amount = Math.round(Number(data.points) || 0);
        if (data.user && amount !== 0) {
          addUserPoints({
            uniqueId: data.user, nickname: data.nickname || data.user,
            amount, counted: data.counted !== false,
            description: String(data.description || '').slice(0, 120), manual: true,
          });
        }
        break;
      }
      case 'resetPoints':
        resetAllPoints();
        break;
      case 'resetUserPoints':
        if (data.user) resetOnePoints(data.user);
        break;
      case 'hello':
        if (data.role === 'videoScreen') {
          videoScreens.set(ws, Number(data.screen) || 1);
          broadcastScreens();
        }
        break;
      case 'testVideo':
        if (data.video) {
          const scr = Number(data.video.screen) || 1;
          broadcast('media', { ...data.video, screen: scr, size: screenSize(scr), test: true });
        }
        break;
      case 'stopVideo': {
        const scr = Number(data.screen) || 1;
        broadcast('stopMedia', { screen: scr });
        break;
      }
      case 'testScreen': {
        const scr = Number(data.screen) || 1;
        broadcast('media', { test: true, screenTest: true, name: 'Pantalla ' + scr, screen: scr, size: screenSize(scr) });
        break;
      }
      case 'testSound':
        if (data.alert) broadcast('sound', { ...data.alert, test: true });
        break;
      case 'panic':
        broadcast('panic', {});
        break;
      case 'testJarron':
        broadcast('jarronTest', { count: Number(data.count) || 200 });
        break;
      case 'resetJarron':
        broadcast('jarronReset', {});
        break;
      case 'testVaquita':
        broadcast('vaquitaTest', { count: Number(data.count) || 200 });
        break;
      case 'resetVaquita':
        broadcast('vaquitaReset', {});
        break;
      case 'testMarranito':
        broadcast('marranitoTest', { count: Number(data.count) || 200 });
        break;
      case 'resetMarranito':
        broadcast('marranitoReset', {});
        break;
      case 'testPelotas':
        broadcast('pelotasTest', { count: Number(data.count) || 16 });
        break;
      case 'resetPelotas':
        broadcast('pelotasReset', {});
        break;
      case 'getRoulette':
        try { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'roulette', payload: serializeRoulette() })); } catch {}
        break;
      case 'rouletteCollect':
        roulette.collecting = !!data.on;
        broadcast('log', { level: 'info', text: roulette.collecting ? '🎡 Ruleta: recolectando participantes…' : '🎡 Ruleta: recolección detenida.' });
        broadcastRoulette();
        break;
      case 'rouletteClear':
        roulette.entries.clear();
        roulette.collecting = false;
        roulette.giftImage = '';
        broadcastRoulette();
        broadcast('rouletteReset', {});
        break;
      case 'rouletteSpin':
        rouletteSpin();
        break;
      case 'testRoulette': {
        const names = ['@ana', '@luis', '@pepito', '@maria', '@chuy', '@sofia', '@dani', '@kevin'];
        broadcast('rouletteTest', {
          entries: names.map((n) => ({ uniqueId: n, nickname: n, photo: '', weight: 1 + Math.floor(Math.random() * 20) })),
        });
        break;
      }
      case 'testTopDonor':
        broadcast('topDonorTest', {});
        break;
      case 'stopTopDonor':
        broadcast('topDonorTestEnd', {});
        break;
      case 'resetWeeklyTop':
        weekly.donors.clear();
        saveWeekly();
        broadcastWeeklyTop();
        break;
      case 'testGiftVs':
        broadcast('giftVsTest', {});
        break;
      case 'resetGiftVs':
        broadcast('giftVsReset', {});
        break;
      case 'testGiftSeq':
        broadcast('giftSeqTest', {});
        break;
      case 'resetGiftSeq':
        broadcast('giftSeqReset', {});
        break;
      case 'testTopGift':
        broadcast('topGiftTest', { gift: data.gift || null });
        break;
      case 'resetTopGift':
        broadcast('topGiftReset', {});
        break;
      case 'testGiftCounter':
        broadcast('giftCounterTest', {});
        break;
      case 'resetGiftCounter':
        resetGiftCounter();
        break;
      case 'setGiftCounter':
        setGiftCounter(data.value);
        break;
      case 'testTopStreak':
        broadcast('topStreakTest', { gift: data.gift || null });
        break;
      case 'resetTopStreak':
        broadcast('topStreakReset', {});
        break;
      case 'testBatallaGifts':
        broadcast('batallaGiftsTest', {});
        break;
      case 'resetBatallaGifts':
        broadcast('batallaGiftsReset', {});
        break;
      case 'testBatallaLikes':
        broadcast('batallaLikesTest', {});
        break;
      case 'resetBatallaLikes':
        broadcast('batallaLikesReset', {});
        break;
      case 'testCoinMatch':
        broadcast('coinMatchTest', {});
        break;
      case 'testRank':
        broadcast('rankTest', { rank: data.rank });
        break;
      case 'resetRank':
        broadcast('rankReset', { rank: data.rank });
        break;
      case 'testHype':
        broadcast('hypeTest', {});
        break;
      case 'resetHype':
        broadcast('hypeReset', {});
        break;
      case 'testAlertaGift':
        broadcast('alertaGiftTest', {});
        break;
      case 'resetAlertaGift':
        broadcast('alertaGiftReset', {});
        break;
      case 'testAlertaLikes':
        broadcast('alertaLikesTest', {});
        break;
      case 'resetAlertaLikes':
        broadcast('alertaLikesReset', {});
        break;
      case 'testAlertaFollow':
        broadcast('alertaFollowTest', {});
        break;
      case 'resetAlertaFollow':
        broadcast('alertaFollowReset', {});
        break;
      case 'testStreamJoin':
        broadcast('streamJoinTest', {});
        break;
      case 'resetStreamJoin':
        broadcast('streamJoinReset', {});
        break;
      case 'coinMatch':
        broadcast('coinMatchControl', { action: data.coinAction, durationSec: data.durationSec });
        break;
      case 'timerControl': {
        const op = data.op;
        if (op === 'set') setTimer(data.totalSeconds);
        else if (op === 'start') startTimer(data.totalSeconds);
        else if (op === 'pause') pauseTimer();
        else if (op === 'reset') resetTimer();
        else if (op === 'add') addTimerSeconds(data.delta);
        break;
      }
      case 'battle':
        handleBattleAction(data);
        break;
    }
  }

  /* ------------------------ Gestión de clientes WS ------------------------ */
  function addClient(ws) {
    clients.add(ws);
    lastSeen = Date.now();
    ws.send(JSON.stringify({ type: 'state', payload: serializeState() }));
    ws.send(JSON.stringify({ type: 'settings', payload: settings }));
    ws.send(JSON.stringify({ type: 'battle', payload: serializeBattle() }));
    ws.send(JSON.stringify({ type: 'screens', payload: { connected: [...new Set(videoScreens.values())] } }));
    ws.send(JSON.stringify({ type: 'weeklyTop', payload: serializeWeeklyTop() }));
    ws.send(JSON.stringify({ type: 'pointsList', payload: serializePoints() }));
    ws.send(JSON.stringify({ type: 'timer', payload: serializeTimer() }));
    ws.send(JSON.stringify({ type: 'giftCounter', payload: serializeGiftCounter() }));
    ws.send(JSON.stringify({ type: 'emoteCatalog', payload: { results: [...emoteCatalog.values()] } }));
    const caps = currentCaps();
    if (caps) ws.send(JSON.stringify({ type: 'caps', payload: caps }));
  }
  function removeClient(ws) {
    clients.delete(ws);
    lastSeen = Date.now();
    if (videoScreens.has(ws)) {
      videoScreens.delete(ws);
      broadcastScreens();
    }
  }

  function getEmotes() {
    return [...emoteCatalog.values()];
  }
  function shutdown() {
    disconnect();
    stopTimerInterval();
    clearTimeout(saveTimer);
    clearTimeout(weeklySaveTimer);
    clearTimeout(statsTimer);
    // Vaciar a disco el estado actual antes de cerrar, por si quedó un guardado
    // pendiente en la ventana de debounce: así nunca se pierde el último cambio.
    try { writeJsonAtomic(SETTINGS_FILE, settings); } catch {}
    try {
      const data = { start: weekly.start, end: weekly.end, donors: [...weekly.donors.values()] };
      writeJsonAtomic(WEEKLY_FILE, data);
    } catch {}
    clearTimeout(pointsSaveTimer);
    try { writeJsonAtomic(POINTS_FILE, { users: [...points.values()], tx: pointsTx.slice(0, POINTS_MAX_TX) }); } catch {}
  }

  // Chequeo de cambio de semana por room.
  const weekInterval = setInterval(ensureWeek, 60000);
  weekInterval.unref?.();

  function getStatus() {
    return {
      live: !!state.connected,
      connecting: !!state.connecting,
      liveSince: state.startedAt || null,
      account: state.username || null,
      clients: clients.size,
      online: clients.size > 0,
      lastSeen: lastSeen || 0,
    };
  }

  function kickAll() {
    for (const ws of [...clients]) {
      try { ws.send(JSON.stringify({ type: 'accountPending' })); } catch {}
      try { ws.close(4003, 'pending'); } catch {}
    }
    clients.clear();
  }

  return {
    id, account, roomKey,
    addClient, removeClient, handleMessage,
    getEmotes, shutdown, getStatus, kickAll, broadcastCaps,
    get clientCount() { return clients.size; },
  };
}
