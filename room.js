// Una "room" = un usuario. Encapsula TODO su estado, ajustes, conexión a TikTok,
// puntajes de batalla, ranking semanal y sus clientes WebSocket (panel + overlays).
// Los broadcasts solo llegan a los clientes de ESTA room, por lo que las alertas y
// datos de distintos usuarios nunca se mezclan.
import './euler-config.js';
import fs from 'node:fs';
import path from 'node:path';
import { TikTokLiveConnection, WebcastEvent, ControlEvent } from 'tiktok-live-connector';
import { DEFAULT_SETTINGS, deepMerge, ensureGiftSeqDefaults, ensureGiftVsDefaults, ensureGiftShowcaseDefaults, ensureFlowMeterDefaults } from './default-settings.js';
import * as spotify from './spotify.js';
import { sendObsCommand, triggerStreamerbot, sendRcon, sendServertap } from './integrations.js';
import { bumpMcPanic, mcRunToken, mcWait, executeMcRconQueue, executeMcRconPlan, fireGameActionTimed, fireGameActionCountTimed } from './mc-panic.js';
import { marioSpawn, marioEffect, mari0Spawn, mari0Effect, smb3Spawn, smb3Effect, pvzSpawn, pvzSun, pvzCmd, pvzHybridSpawn, pvzHybridSun, pvzHybridCmd, repoSpawn, l4dSpawn, gtavKothSpawn, gtavChaosSpawn, gtavChiliadSpawn, unturnedSpawn, ctrSpawn, mslugSpawn, smwSpawn, runGameExec, resolveRepoSpawnKey } from './game-local.js';
import { ensureMarioBridge, ensureMari0Bridge } from './mario-bridge.js';
import { likeTriggerFires } from './like-trigger.js';
import { buildGdashEffectUrl, fireGdashEffectRequest } from './gdash-effect.js';
import { runWebhookExec } from './smbx-tiktok-webhook.js';
import { decryptAndMapTfc, mapTikfinityActionsToMc, tikfinityObsCmdFromAction, tikfinitySbCmdFromAction } from './tikfinity-tfc.js';

/* ----------------------- Helpers sin estado (compartidos) ----------------------- */
function getPhoto(user) {
  if (!user) return null;
  return (
    user.profilePictureUrl ||
    user.profilePicture?.url?.[0] ||
    user.profilePicture?.urls?.[0] ||
    user.avatarThumb?.url?.[0] ||
    user.avatarThumb?.urlList?.[0] ||
    user.userDetails?.profilePictureUrls?.[0] ||
    null
  );
}
/** Se asigna dentro de createRoom (usa emitSound del scope). */
let playGameActionSoundImpl = () => {};
function playGameActionSound(a, times = 1) {
  try { playGameActionSoundImpl(a, times); } catch {}
}
function withGameActionTiming(a, fn) {
  if (a && typeof a === 'object') {
    playGameActionSound(a, 1);
    fireGameActionTimed(a, fn);
  } else fn();
}
function withGameActionCountTiming(a, unitCount, fn) {
  if (!a || typeof a !== 'object') { fn(); return; }
  playGameActionSound(a, 1);
  fireGameActionCountTimed({ ...a, count: Math.max(1, Number(unitCount) || 1) }, fn);
}

function pickImageUrl(img) {
  if (!img) return null;
  if (typeof img === 'string') return img;
  if (img.giftPictureUrl) return img.giftPictureUrl;
  if (Array.isArray(img.url) && img.url[0]) return img.url[0];
  if (Array.isArray(img.urlList) && img.urlList[0]) return img.urlList[0];
  if (Array.isArray(img.url_list) && img.url_list[0]) return img.url_list[0];
  return null;
}
function getGiftImage(data) {
  if (!data) return null;
  return (
    pickImageUrl(data.giftDetails?.giftImage) ||
    pickImageUrl(data.giftImage) ||
    pickImageUrl(data.giftDetails?.image) ||
    pickImageUrl(data.image) ||
    data.giftPictureUrl ||
    null
  );
}
function baseUser(user) {
  const uid = user?.uniqueId || (user?.userId != null && String(user.userId) !== '0' ? String(user.userId) : '') || '';
  return {
    uniqueId: uid,
    nickname: user?.nickname || user?.uniqueId || uid || 'Anónimo',
    photo: getPhoto(user),
  };
}
function normTikTokUser(s) {
  return String(s || '')
    .replace(/^@+/, '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '');
}
function tiktokUserMatches(wantRaw, username, nickname) {
  const want = normTikTokUser(wantRaw);
  if (!want) return false;
  const u = normTikTokUser(username);
  const n = normTikTokUser(nickname);
  return want === u || want === n;
}
function userJoinVideoInfo(user, data) {
  const u = baseUser(user || data?.user || data);
  const username = u.uniqueId || String(data?.user?.userId || data?.userId || '').trim();
  return { username, nickname: u.nickname };
}
function numMemberLevel(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && n <= 50 ? n : 0;
}
function badgeScene(b) {
  return Number(b?.badgeSceneType ?? b?.badgeScene ?? b?.sceneType ?? 0);
}
function levelFromBadge(b) {
  if (!b) return 0;
  const candidates = [
    b.level,
    b.privilegeLogExtra?.level,
    b.logExtra?.level,
    b.combine?.profileCardPanel?.profileContent?.numberConfig?.number,
    b.combine?.str,
    b.str?.str,
  ];
  for (const v of candidates) {
    const n = numMemberLevel(v);
    if (n) return n;
  }
  return 0;
}
function flattenBadges(raw) {
  const out = [];
  for (const b of [].concat(raw || [])) {
    if (!b || typeof b !== 'object') continue;
    out.push(b);
    const scene = badgeScene(b);
    if (Array.isArray(b.badges)) {
      for (const inner of b.badges) {
        out.push({
          ...inner,
          badgeSceneType: inner?.badgeSceneType ?? scene,
          badgeScene: inner?.badgeScene ?? scene,
        });
      }
    }
    if (Array.isArray(b.imageBadges)) {
      for (const ib of b.imageBadges) {
        if (ib) {
          out.push({
            ...ib,
            badgeSceneType: scene,
            badgeScene: scene,
            type: 'image',
            url: ib.image?.url,
          });
        }
      }
    }
    const privLevel = b.privilegeLogExtra?.level || b.logExtra?.level;
    if (privLevel && privLevel !== '0') {
      out.push({
        type: 'privilege',
        level: parseInt(String(privLevel), 10),
        badgeSceneType: scene,
        badgeScene: scene,
        privilegeLogExtra: b.privilegeLogExtra,
        logExtra: b.logExtra,
      });
    }
  }
  return out;
}
function memberLevelFromUser(u) {
  const levels = [
    numMemberLevel(u?.fansClub?.data?.level),
    numMemberLevel(u?.fansClubInfo?.fansLevel),
    numMemberLevel(u?.teamMemberLevel),
  ];
  if (u?.fansClub?.preferData && typeof u.fansClub.preferData === 'object') {
    for (const entry of Object.values(u.fansClub.preferData)) {
      levels.push(numMemberLevel(entry?.level));
    }
  }
  const badges = flattenBadges([
    ...(u.badges || []),
    ...(u.userBadges || []),
    ...(u.newUserBadges || []),
    ...(u.badgeImageList || []),
  ]);
  for (const b of badges) {
    if (badgeScene(b) === 10) levels.push(levelFromBadge(b));
  }
  return Math.max(0, ...levels);
}
function gifterLevelFromUser(u) {
  if (!u) return 0;
  const levels = [
    numMemberLevel(u?.userHonor?.level),
    numMemberLevel(u?.payGrade?.level),
    numMemberLevel(u?.gifterLevel),
  ];
  const badges = flattenBadges([].concat(u.badges || [], u.userBadges || [], u.newUserBadges || [], u.badgeImageList || []));
  for (const b of badges) {
    if (badgeScene(b) === 8) levels.push(levelFromBadge(b)); // BadgeSceneType_UserGrade (donador TikTok)
    if (String(b?.type || '').toLowerCase() === 'privilege') levels.push(levelFromBadge(b));
  }
  return Math.max(0, ...levels);
}
function chatUserRoles(data) {
  // Formato moderno: data.user. Legacy (connector antiguo): campos aplanados en data.
  const u = data?.user || data || {};
  const ui = data?.userIdentity || {};
  const badges = flattenBadges([].concat(u.badges || [], u.userBadges || [], u.newUserBadges || [], u.badgeImageList || []));
  const scene = badgeScene;
  const badgeUrl = (b) => String(b?.url || b?.image?.url?.[0] || b?.image?.uri || '').toLowerCase();
  const badgeType = (b) => String(b?.type || b?.displayType || '').toLowerCase();

  const isMod = !!(
    ui.isModeratorOfAnchor ||
    badges.some((b) => scene(b) === 1 || badgeType(b).includes('moderator'))
  );
  const isSub = !!(
    ui.isSubscriberOfAnchor ||
    numMemberLevel(u?.fansClub?.data?.level) > 0 ||
    numMemberLevel(u?.fansClubInfo?.fansLevel) > 0 ||
    badges.some((b) => scene(b) === 4 || scene(b) === 7 || badgeUrl(b).includes('/sub_'))
  );
  const followStatus = Number(u?.followInfo?.followStatus ?? u?.followStatus ?? 0);
  const isFollower = !!(ui.isFollowerOfAnchor || ui.isMutualFollowingWithAnchor || followStatus >= 1);
  const teamBadge = badges.find((b) => scene(b) === 10);
  const memberLevel = memberLevelFromUser(u);
  const isTeam = !!(levelFromBadge(teamBadge) > 0 || memberLevel > 0);
  const gifterLevel = gifterLevelFromUser(u);

  return { isMod, isSub, isFollower, isTeam, memberLevel, gifterLevel };
}
function matchesCommand(command, comment) {
  const cmd = String(command || '').trim().toLowerCase();
  if (!cmd) return false;
  const text = String(comment || '').trim().toLowerCase();
  if (!text) return false;
  return text === cmd || text.split(/\s+/)[0] === cmd;
}
function emoteIdFrom(obj) {
  if (!obj || typeof obj !== 'object') return '';
  return String(obj.emoteId ?? obj.emote_id ?? obj.uuid ?? obj.packageId ?? obj.id ?? '').trim();
}
function emoteImageUrl(img) {
  if (!img) return '';
  if (typeof img === 'string') return img;
  return img.url_list?.[0] || img.urlList?.[0] || img.imageUrl || img.url?.[0] || img.uri || '';
}
function currentWeekRange(now = Date.now()) {
  const d = new Date(now);
  const day = (d.getDay() + 6) % 7; // 0 = lunes
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate() - day, 0, 0, 0, 0).getTime();
  const end = start + 7 * 86400000;
  return [start, end];
}
function currentMonthRange(now = Date.now()) {
  const d = new Date(now);
  const start = new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0).getTime();
  const end = new Date(d.getFullYear(), d.getMonth() + 1, 1, 0, 0, 0, 0).getTime();
  return [start, end];
}
// Multiplicador PK (x2/x3 / guante): lee SOLO MatchInfo tipado del GiftMessage.
// No escanear el regalo entero: nombres/URLs con «glove» daban falsos positivos.
function readMatchInfoMultiplier(mi) {
  const out = { crit: false, value: 0, hits: [] };
  if (!mi || typeof mi !== 'object') return out;
  const cardOn = mi.effectCardInUse === true || mi.effectCardInUse === 1 || mi.effectCardInUse === '1';
  if (cardOn) {
    out.crit = true;
    out.hits.push('effectCardInUse');
  }
  const t = Number(mi.multiplierType);
  if (t === 1 || t === 2) {
    out.crit = true;
    out.value = Math.max(out.value, 2);
    out.hits.push(`multiplierType=${t}`);
  } else if (t === 3) {
    out.crit = true;
    out.value = Math.max(out.value, 3);
    out.hits.push(`multiplierType=${t}`);
  } else if (Number.isFinite(t) && t >= 4 && t <= 50) {
    out.crit = true;
    out.value = Math.max(out.value, t);
    out.hits.push(`multiplierType=${t}`);
  }
  const mv = Math.round(Number(mi.multiplierValue));
  if (mv >= 2 && mv <= 50) {
    out.crit = true;
    out.value = Math.max(out.value, mv);
    out.hits.push(`multiplierValue=${mv}`);
  }
  // critical es string/int64; "0" = off
  const critN = Math.round(Number(mi.critical));
  if (Number.isFinite(critN) && critN >= 1) {
    out.crit = true;
    out.value = Math.max(out.value, critN >= 2 ? critN : 2);
    out.hits.push(`critical=${mi.critical}`);
  }
  return out;
}

// Busca el multiplicador del golpe crítico / potenciador (x2/x3) en mensajes PK.
// TikTok lo manda en regalos (matchInfo), LinkMicArmies (triggerCriticalStrike) y
// otros envelopes de batalla. multiplierType: 1=critical, 2=top2/x2, 3=top3/x3.
function readBattleMultiplier(obj, depth = 0, acc = null) {
  const out = acc || { crit: false, value: 0, hits: [] };
  if (!obj || typeof obj !== 'object' || depth > 8) return out;

  // Atajo: matchInfo tipado del GiftMessage
  const mi = obj.matchInfo || obj.match_info;
  if (mi && typeof mi === 'object' && depth === 0) {
    const fromMi = readMatchInfoMultiplier(mi);
    if (fromMi.crit || fromMi.value >= 2) {
      out.crit = out.crit || fromMi.crit;
      out.value = Math.max(out.value, fromMi.value);
      out.hits.push(...fromMi.hits);
    }
  }

  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      readBattleMultiplier(v, depth + 1, out);
      continue;
    }
    if (Array.isArray(v)) {
      for (const item of v) {
        if (item && typeof item === 'object') readBattleMultiplier(item, depth + 1, out);
      }
      continue;
    }
    const key = String(k).toLowerCase().replace(/_/g, '');
    if (key === 'triggercriticalstrike' && (v === true || v === 1 || v === '1')) {
      out.crit = true;
      out.value = Math.max(out.value, 2);
      out.hits.push(`${k}=${v}`);
    } else if (key === 'effectcardinuse' && (v === true || v === 1 || v === '1')) {
      out.crit = true;
      out.hits.push(`${k}=${v}`);
    } else if (key === 'multipliertype') {
      const t = Number(v);
      // 1 = critical strike (guante), 2 = x2, 3 = x3 (enums TikTok)
      if (t === 1) { out.crit = true; out.value = Math.max(out.value, 2); out.hits.push(`${k}=${v}`); }
      else if (t === 2) { out.crit = true; out.value = Math.max(out.value, 2); out.hits.push(`${k}=${v}`); }
      else if (t === 3) { out.crit = true; out.value = Math.max(out.value, 3); out.hits.push(`${k}=${v}`); }
      else if (t >= 2 && t <= 50) { out.crit = true; out.value = Math.max(out.value, t); out.hits.push(`${k}=${v}`); }
    } else if (key === 'multipliervalue' || key === 'multiplier') {
      const n = Math.round(Number(v));
      if (n >= 2 && n <= 50) { out.value = Math.max(out.value, n); out.crit = true; out.hits.push(`${k}=${v}`); }
    } else if (key === 'critical') {
      const n = Math.round(Number(v));
      // "0" / 0 = apagado (MatchInfo por defecto)
      if (n >= 1 || v === true || v === 'true') {
        out.crit = true;
        if (n >= 2) out.value = Math.max(out.value, n);
        else out.value = Math.max(out.value, 2);
        out.hits.push(`${k}=${v}`);
      }
    } else if (typeof v === 'string') {
      const s = v.toLowerCase();
      // Sin «glove(s)»: coincidía con Boxing Gloves y URLs y daba falsos x2.
      if (/booster[_-]?x?3|card_?x?3|top3_buffer/.test(s)) {
        out.crit = true; out.value = Math.max(out.value, 3); out.hits.push(`${k}=${v}`);
      } else if (/booster[_-]?x?2|card_?x?2|top2_buffer|card_crit/.test(s)) {
        out.crit = true; out.value = Math.max(out.value, 2); out.hits.push(`${k}=${v}`);
      }
    }
  }
  return out;
}

/** Compat: mismo contrato que el antiguo scanMultiplier. */
function scanMultiplier(obj, depth, acc) {
  readBattleMultiplier(obj, depth || 0, acc);
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
    try {
      fs.renameSync(tmp, file);
    } catch {
      // Windows/antivirus a veces bloquea rename: copiar encima y borrar tmp.
      fs.copyFileSync(tmp, file);
      try { fs.unlinkSync(tmp); } catch {}
    }
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

function relativizeMediaUrl(u) {
  if (!u || typeof u !== 'string') return u;
  if (u.startsWith('/')) return u;
  try {
    const p = new URL(u);
    if (/^\/(uploads|audios|video)\//.test(p.pathname)) return p.pathname + (p.search || '');
  } catch {}
  return u;
}
function normalizeSettingsMediaUrls(s) {
  if (!s || typeof s !== 'object') return;
  const rel = relativizeMediaUrl;
  for (const a of (s.soundAlerts || [])) if (a.sound) a.sound = rel(a.sound);
  for (const v of (s.videos || [])) if (v.url) v.url = rel(v.url);
  for (const b of (s.battleAlerts || [])) if (b.url) b.url = rel(b.url);
  for (const a of (s.actions || [])) if (a.sound) a.sound = rel(a.sound);
  for (const a of (s.mcActions || [])) if (a.sound) a.sound = rel(a.sound);
}
function normalizeProfilesMediaUrls(p) {
  if (!p) return;
  for (const slot of (p.slots || [])) normalizeSettingsMediaUrls(slot);
  normalizeSettingsMediaUrls(p.general);
}

/* --------------------------------- La room --------------------------------- */
export function createRoom({ id, username: account, roomKey, dataDir, giftsById, getCaps, onUserSave, getLevelVideo, onRelayAction, chargeSpotifyRemote, onStreamerRank, onLiveSessionEnd, onGameExec }) {
  fs.mkdirSync(dataDir, { recursive: true });
  const SETTINGS_FILE = path.join(dataDir, 'settings.json');
  const PROFILES_FILE = path.join(dataDir, 'profiles.json');
  const WEEKLY_FILE = path.join(dataDir, 'weekly.json');
  const TOP1FIRE_FILE = path.join(dataDir, 'top1fire.json');
  const HABIBI_TOP_FILE = path.join(dataDir, 'habibi-top.json');
  const GIFTGOALS_FILE = path.join(dataDir, 'gift-goals.json');
  const RANKS_FILE = path.join(dataDir, 'rank-overlays.json');
  const FOC_METRICS_FILE = path.join(dataDir, 'foc-metrics.json');
  const RANK_IDS = ['toplikes', 'topdiam', 'toplikeslist', 'topdiamlist', 'topcomments'];
  const RANK_SETTINGS_KEY = {
    toplikes: 'toplikesRank', topdiam: 'topdiamRank',
    toplikeslist: 'toplikesList', topdiamlist: 'topdiamList',
    topcomments: 'topcommentsRank',
  };
  const POINTS_FILE = path.join(dataDir, 'points.json');
  const SESSION_FILE = path.join(dataDir, 'session.json');
  const SESSION_OVERLAYS_FILE = path.join(dataDir, 'session-overlays.json');
  const GIFT_OVERLAY_PERIOD_FILE = path.join(dataDir, 'gift-overlays-period.json');
  const GIFT_OVERLAY_KEYS = ['topGift', 'lastGift', 'topStreak'];
  // Perfiles (solo se usan en la app .exe): 10 ranuras, cada una guarda una
  // configuración COMPLETA. El perfil activo es el que se edita/guarda. Nunca se
  // borran: una ranura vacía simplemente arranca con los valores por defecto.
  const PROFILE_COUNT = 10;

  const state = {
    username: null,
    connected: false,
    connecting: false,
    inBattle: false,
    criticalTimer: null,
    pendingMult: 0,
    pendingSrc: '',
    // Potenciador activo en la PK: solo animamos al ENTRAR o al SUBIR (x2→x3), no en cada regalo.
    battleMult: { active: false, value: 0 },
    roomId: null,
    startedAt: null,
    stats: { viewers: 0, likes: 0, diamonds: 0, comments: 0, gifts: 0, follows: 0, shares: 0, joins: 0 },
    gifters: new Map(),
  };

  const battle = { scoreA: 0, scoreB: 0 };
  /** Marcador Batalla VS (Diseño Overlay): wins vs mismo rival + puntos por ronda. */
  const pkBattle = {
    live: false,
    frozen: false,
    /** true solo tras «Testear» en el panel; el PK real lo limpia */
    demo: false,
    battleId: '',
    host: { uniqueId: '', nickname: '', photo: '', userId: '' },
    rival: { uniqueId: '', nickname: '', photo: '', userId: '' },
    pointsHost: 0,
    pointsRival: 0,
    winsHost: 0,
    winsRival: 0,
    rivalKey: '',
    armyTopHost: null,
    armyTopRival: null,
    armyTop3Host: [],
    /** Tras fin de ronda: overlays (Meta) muestran Felicidades/Suerte hasta el próximo PK */
    showEnd: false,
  };
  let pkBattleBroadcastTimer = null;
  const giftCounter = { count: 0 }; // contador de meta (cuenta de la sesión)
  /** Metas de regalos multi-item: counts[id], completers[id], donors[id][uid] */
  const giftGoalsState = {
    counts: Object.create(null),
    completers: Object.create(null),
    donors: Object.create(null),
  };
  const giftGoalsMeta = { period: 'live', start: 0, end: 0 };
  let giftGoalsSaveTimer = null;
  let lastGiftGoalsPeriod = null;
  const timer = { remaining: 0, running: false };
  let timerInterval = null;
  const weekly = { start: 0, end: 0, donors: new Map() };
  const top1fire = { start: 0, end: 0, period: 'live', donors: new Map() };
  const top1fireSession = new Map();
  let top1fireSaveTimer = null;
  let lastTop1FirePeriod = null;
  const habibiTop = { start: 0, end: 0, period: 'live', donors: new Map() };
  const habibiTopSession = new Map();
  let habibiTopSaveTimer = null;
  let lastHabibiTopPeriod = null;
  let habibiTopSnapshot = null;
  const rankSession = Object.fromEntries(RANK_IDS.map((id) => [id, new Map()]));
  const rankPersist = Object.fromEntries(RANK_IDS.map((id) => [id, { period: 'live', start: 0, end: 0, users: new Map() }]));
  let rankSaveTimer = null;
  const lastRankPeriods = {};
  const followerCounter = { count: 0, nickname: '', uniqueId: '', photo: '', userId: '', ready: false };

  let rankSnap = { likes: 0, diamonds: 0 };
  let rankLastTick = 0;
  let rankStreamerTimer = null;
  function resetRankSnap() {
    rankSnap = { likes: state.stats.likes || 0, diamonds: state.stats.diamonds || 0 };
    rankLastTick = Date.now();
  }
  function flushStreamerRank(extraStreamMs = 0) {
    if (!onStreamerRank || !state.connected) return;
    const now = Date.now();
    let streamMsDelta = extraStreamMs;
    if (!streamMsDelta && rankLastTick && state.startedAt) {
      streamMsDelta = Math.min(now - rankLastTick, 120000);
    }
    const likesDelta = Math.max(0, (state.stats.likes || 0) - rankSnap.likes);
    const diamondsDelta = Math.max(0, (state.stats.diamonds || 0) - rankSnap.diamonds);
    if (likesDelta) rankSnap.likes = state.stats.likes;
    if (diamondsDelta) rankSnap.diamonds = state.stats.diamonds;
    rankLastTick = now;
    if (!(likesDelta || diamondsDelta || streamMsDelta)) return;
    try {
      onStreamerRank({
        userId: id,
        username: account,
        tiktok: state.username || '',
        nickname: followerCounter.nickname || state.username || account,
        photo: followerCounter.photo || '',
        likesDelta,
        diamondsDelta,
        streamMsDelta,
      });
    } catch { /* ignore */ }
  }
  function startRankStreamerTimer() {
    if (!onStreamerRank) return;
    clearInterval(rankStreamerTimer);
    rankStreamerTimer = setInterval(() => flushStreamerRank(), 60000);
    rankStreamerTimer.unref?.();
  }
  function stopRankStreamerTimer() {
    clearInterval(rankStreamerTimer);
    rankStreamerTimer = null;
  }
  // Usuario y Puntos: balance acumulado (de por vida) por usuario + historial de transacciones.
  const points = new Map();          // uniqueId -> { uniqueId, nickname, photo, total, levelPoints, firstAt, lastAt }
  let pointsTx = [];                 // transacciones recientes (las más nuevas primero), acotadas
  const POINTS_MAX_USERS = 2500;
  const POINTS_MAX_TX = 500;
  const clients = new Set();         // todos los WS de esta room (panel + overlays)
  const IS_CLOUD_ROOM = !!process.env.RENDER;
  const clientRoles = new WeakMap(); // ws -> 'panel' | 'relay' | 'local'
  let relayLocalOrigin = '';         // http://127.0.0.1:PUERTO (modo relay .exe)
  const videoScreens = new Map();    // ws -> número de pantalla
  const chatSeenUsers = new Set();
  /** Último chat por usuario (ms) — para detectar “salió y volvió” en primer mensaje. */
  const chatLastAt = new Map();
  const recentChatKeys = new Set();
  const recentChatOrder = [];
  function chatEventKey(data, comment) {
    const msgId = data?.common?.msgId || data?.msgId;
    if (msgId && String(msgId) !== '0') return 'id:' + msgId;
    const uid = data?.user?.uniqueId || data?.user?.userId || '';
    const ct = data?.common?.createTime || '';
    return `f:${uid}|${comment}|${ct}`;
  }
  function consumeChatOnce(key) {
    if (recentChatKeys.has(key)) return false;
    recentChatKeys.add(key);
    recentChatOrder.push(key);
    if (recentChatOrder.length > 500) recentChatKeys.delete(recentChatOrder.shift());
    return true;
  }
  // Al conectar/reconectar tarde, TikTok a menudo suelta un chorro de chats viejos.
  // Los absorbemos y solo procesamos el ÚLTIMO (TTS, comandos, etc.); luego todo normal.
  let chatCatchupActive = false;
  let chatCatchupLast = null;
  let chatCatchupTimer = null;
  const CHAT_CATCHUP_IDLE_MS = 900;
  const CHAT_CATCHUP_MAX_MS = 3500;
  function clearChatCatchup() {
    clearTimeout(chatCatchupTimer);
    chatCatchupTimer = null;
    chatCatchupActive = false;
    chatCatchupLast = null;
  }
  function beginChatCatchup() {
    clearTimeout(chatCatchupTimer);
    chatCatchupActive = true;
    chatCatchupLast = null;
    chatCatchupTimer = setTimeout(() => flushChatCatchup(), CHAT_CATCHUP_MAX_MS);
    try { chatCatchupTimer.unref?.(); } catch {}
  }
  function noteChatCatchup(data) {
    chatCatchupLast = data;
    clearTimeout(chatCatchupTimer);
    chatCatchupTimer = setTimeout(() => flushChatCatchup(), CHAT_CATCHUP_IDLE_MS);
    try { chatCatchupTimer.unref?.(); } catch {}
  }
  function flushChatCatchup() {
    clearTimeout(chatCatchupTimer);
    chatCatchupTimer = null;
    if (!chatCatchupActive) return;
    chatCatchupActive = false;
    const last = chatCatchupLast;
    chatCatchupLast = null;
    if (last) processChatEvent(last);
  }
  const emoteCatalog = new Map();
  const EMOTES_FILE = path.join(dataDir, 'emotes.json');
  let emotesSaveTimer = null;

  function loadEmotesCatalog() {
    const r = readJsonSafe(EMOTES_FILE);
    const list = Array.isArray(r.data) ? r.data : (Array.isArray(r.data?.results) ? r.data.results : []);
    for (const e of list) {
      const eid = String(e?.id || '').trim();
      if (!eid) continue;
      const img = emoteImageUrl(e.image) || String(e.image || '').trim();
      const name = String(e.name || e.nombre || '').trim().slice(0, 64);
      emoteCatalog.set(eid, { id: eid, image: img, name });
    }
  }
  loadEmotesCatalog();

  function saveEmotesCatalogNow() {
    writeJsonAtomic(EMOTES_FILE, [...emoteCatalog.values()]);
  }
  function scheduleSaveEmotesCatalog() {
    clearTimeout(emotesSaveTimer);
    emotesSaveTimer = setTimeout(saveEmotesCatalogNow, 400);
  }
  function mergeEmotes(list) {
    if (!Array.isArray(list) || !list.length) return false;
    let changed = false;
    for (const e of list) {
      const eid = String(e?.id || e?.emoteId || '').trim();
      if (!eid) continue;
      const url = emoteImageUrl(e.image) || emoteImageUrl(e.emoteImage) || String(e.image || e.emoteImage || '').trim();
      const name = String(e.name || e.nombre || '').trim().slice(0, 64);
      const prev = emoteCatalog.get(eid);
      if (!prev) {
        emoteCatalog.set(eid, { id: eid, image: url || '', name: name || '' });
        changed = true;
        continue;
      }
      let next = prev;
      if (url && !prev.image) {
        next = { ...next, image: url };
        changed = true;
      }
      if (name && !prev.name) {
        next = { ...next, name };
        changed = true;
      }
      if (next !== prev) emoteCatalog.set(eid, next);
    }
    if (changed) {
      scheduleSaveEmotesCatalog();
      broadcast('emoteCatalog', { results: [...emoteCatalog.values()] });
    }
    return changed;
  }

  const communityGiftCatalog = new Map();
  const COMMUNITY_GIFTS_FILE = path.join(dataDir, 'community-gifts.json');
  let communityGiftsSaveTimer = null;

  function loadCommunityGiftsCatalog() {
    const r = readJsonSafe(COMMUNITY_GIFTS_FILE);
    const list = Array.isArray(r.data) ? r.data : (Array.isArray(r.data?.results) ? r.data.results : []);
    for (const g of list) {
      const gid = String(g?.id || '').trim();
      const img = String(g?.image || '').trim();
      if (!gid || !img) continue;
      communityGiftCatalog.set(gid, {
        id: gid,
        name: g.name || 'Regalo',
        diamonds: Number(g.diamonds) || 0,
        image: img,
        community: true,
      });
    }
  }
  loadCommunityGiftsCatalog();

  function saveCommunityGiftsCatalogNow() {
    writeJsonAtomic(COMMUNITY_GIFTS_FILE, [...communityGiftCatalog.values()]);
  }
  function scheduleSaveCommunityGiftsCatalog() {
    clearTimeout(communityGiftsSaveTimer);
    communityGiftsSaveTimer = setTimeout(saveCommunityGiftsCatalogNow, 400);
  }
  function registerCommunityGift(g) {
    const gid = String(g?.id || '').trim();
    const img = String(g?.image || '').trim();
    if (!gid || !img) return false;
    const prev = communityGiftCatalog.get(gid);
    const entry = {
      id: gid,
      name: g.name || prev?.name || 'Regalo',
      diamonds: Number(g.diamonds) || prev?.diamonds || 0,
      image: img,
      community: true,
    };
    if (prev && prev.image === entry.image && prev.name === entry.name && prev.diamonds === entry.diamonds) return false;
    communityGiftCatalog.set(gid, entry);
    scheduleSaveCommunityGiftsCatalog();
    broadcast('communityGiftCatalog', { results: [...communityGiftCatalog.values()] });
    return true;
  }
  function mergeCommunityGifts(list) {
    if (!Array.isArray(list) || !list.length) return false;
    let changed = false;
    for (const g of list) {
      if (registerCommunityGift(g)) changed = true;
    }
    return changed;
  }
  function getCommunityGifts() {
    return [...communityGiftCatalog.values()];
  }
  function fetchRoomCommunityGifts(conn) {
    if (!conn || typeof conn.fetchAvailableGifts !== 'function') return;
    conn.fetchAvailableGifts()
      .then((gifts) => {
        const list = (Array.isArray(gifts) ? gifts : []).map((g) => ({
          id: g.id,
          name: g.name,
          diamonds: g.diamond_count ?? g.diamondCount ?? 0,
          image: g.image?.url_list?.[0] || g.icon?.url_list?.[0] || (typeof g.image === 'string' ? g.image : ''),
        })).filter((g) => g.id && g.image);
        if (list.length) mergeCommunityGifts(list);
      })
      .catch(() => {});
  }
  // Pelotas de fans: acumulado por usuario (con sobrante) para soltar pelotas.
  const fanCoinAcc = new Map();      // uniqueId -> monedas pendientes
  const fanLikeAcc = new Map();      // uniqueId -> likes pendientes
  // Likes por usuario: acumula tandas hasta llegar al mínimo (likeN) de cada acción.
  const gameLikeAcc = new Map();
  // Overlays de sesión (top1, mejor regalo/racha, batallas, hype…) persistidos en disco.
  const sessionOv = {
    top1: {},
    topGift: null,
    lastGift: null,
    topStreak: null,
    batallaGifts: {},
    batallaLikes: {},
    hype: { score: 0, target: 100, coinTotal: 0 },
  };
  let sessionOverlaysSaveTimer = null;
  const giftOverlayPeriod = Object.create(null);
  const lastGiftOverlayPeriods = Object.create(null);
  let giftOverlayPeriodSaveTimer = null;
  for (const k of GIFT_OVERLAY_KEYS) {
    giftOverlayPeriod[k] = { period: 'live', start: 0, end: 0, record: null };
    lastGiftOverlayPeriods[k] = null;
  }
  const recentSubs = new Map();      // dedupe suscripciones (subscribe/subNotify)
  const recentSuperFans = new Map(); // dedupe super fans (superFan/superFanJoin)
  // TikTok puede mandar el MISMO follow/share por dos canales (SOCIAL y FOLLOW/SHARE):
  // sin esto, videos/sonidos/acciones/juegos disparaban dos veces por usuario.
  const recentFollowShare = new Map(); // `${kind}:${uid}` -> ts
  function followShareOnce(kind, user) {
    const uid = normTikTokUser(user?.uniqueId) || normTikTokUser(user?.nickname)
      || String(user?.uniqueId || user?.nickname || '').trim().toLowerCase();
    if (!uid) return true; // sin identidad no podemos dedupe: mejor disparar que perder
    const key = `${kind}:${uid}`;
    const now = Date.now();
    if (now - (recentFollowShare.get(key) || 0) < 4000) return false;
    recentFollowShare.set(key, now);
    if (recentFollowShare.size > 4000) recentFollowShare.clear();
    return true;
  }
  // Stickers: el mismo emote suele llegar por CHAT y por EMOTE → sonidos/videos/acciones x2.
  const recentEmoteFire = new Map(); // `${uid}:${emoteId}` | `msg:${msgId}:${emoteId}` -> ts
  function emoteFireOnce(user, emoteId, data) {
    const eid = String(emoteId || '').trim();
    if (!eid) return true;
    const msgId = String(data?.common?.msgId || data?.msgId || '').trim();
    const uid = normTikTokUser(user?.uniqueId) || normTikTokUser(user?.nickname)
      || String(user?.uniqueId || user?.nickname || '').trim().toLowerCase();
    const keys = [];
    if (msgId && msgId !== '0') keys.push(`msg:${msgId}:${eid}`);
    if (uid) keys.push(`u:${uid}:${eid}`);
    if (!keys.length) return true;
    const now = Date.now();
    for (const key of keys) {
      if (now - (recentEmoteFire.get(key) || 0) < 2500) return false;
    }
    for (const key of keys) recentEmoteFire.set(key, now);
    if (recentEmoteFire.size > 4000) recentEmoteFire.clear();
    return true;
  }
  const memberLevels = new Map();    // uniqueId -> último nivel de miembro visto (para detectar subidas)
  const joinVideoCooldown = new Map(); // clave por video/usuario -> última vez que se disparó
  /** ¿Silencio desde el último chat >= delay? (visita nueva / primer mensaje). */
  function isFirstMessageVisit(info, delaySec = 30) {
    const delay = Math.max(0, Number(delaySec) || 0);
    const gapMs = Number.isFinite(Number(info.gapMs)) ? Number(info.gapMs) : Infinity;
    if (delay <= 0) return true;
    return gapMs >= delay * 1000;
  }
  /** Primer mensaje por ítem: delay 0 = una vez por live; >0 = solo tras silencio >= delay. */
  function claimFirstMessageSlot(info, itemKey, delaySecRaw) {
    const delaySec = (delaySecRaw == null) ? 30 : Math.max(0, Number(delaySecRaw) || 0);
    const who = normTikTokUser(info.username) || normTikTokUser(info.nickname) || 'any';
    const cdKey = `fm|${itemKey}|${who}`;
    const now = Date.now();
    const lastFire = joinVideoCooldown.get(cdKey) || 0;
    if (delaySec <= 0) {
      if (lastFire) return false;
    } else if (!isFirstMessageVisit(info, delaySec)) {
      return false;
    }
    joinVideoCooldown.set(cdKey, now);
    return true;
  }
  const gameFollowShareCooldown = new Map(); // follow/share de acciones de juego / teclas por usuario

  /** Anti-spam: mismo usuario no puede reactivar follow/share/emote hasta eventDelay segundos (default 30; 0 = sin límite). */
  function allowFollowSharePerUser(a, eventType, user, bucket) {
    if (eventType !== 'follow' && eventType !== 'share' && eventType !== 'emote') return true;
    if (!a) return true;
    const delaySec = (a.eventDelay == null) ? 30 : Math.max(0, Number(a.eventDelay) || 0);
    if (delaySec <= 0) return true;
    const now = Date.now();
    const userKey = normTikTokUser(user?.uniqueId) || normTikTokUser(user?.nickname) || '_unknown';
    const id = a.uid || a.id || a.catId || (a.slot != null ? String(a.slot) : '') || a.thing || a.name || 'x';
    const cdKey = `${bucket}|${id}|${eventType}|${userKey}`;
    const last = gameFollowShareCooldown.get(cdKey) || 0;
    if (now - last < delaySec * 1000) return false;
    gameFollowShareCooldown.set(cdKey, now);
    if (gameFollowShareCooldown.size > 800) {
      for (const [k, t] of gameFollowShareCooldown) {
        if (now - t > Math.max(delaySec, 60) * 1000) gameFollowShareCooldown.delete(k);
      }
    }
    return true;
  }
  // Spotify Song Requests (solo .exe): cola pedida por el chat + historial + anti-spam.
  let spotifyQueue = [];             // { uniqueId, nickname, name, artists, image, uri, at }
  let spotifyHistory = [];           // { at, user, track, status }
  const spotifyCooldown = new Map(); // uniqueId -> ts
  let spotifyNowPlaying = null;      // { name, artists, image, uri, progressMs, durationMs, playing, requestedBy, serverTs }
  let lastSpotifyUri = '';
  let spotifyPollTimer = null;


  let connection = null;
  let saveTimer = null;
  let weeklySaveTimer = null;
  let statsTimer = null;
  let lastTotalLikes = 0;
  let lastLikeSound = 0;
  let lastSeen = 0; // última vez que hubo una conexión (panel u overlay) activa

  // Sesión de live en curso (persiste en disco para sobrevivir reinicios de Render).
  // La auto-conexión la usa para NO vaciar overlays al reconectar el mismo live.
  let liveSession = { roomId: null, username: null, active: false, startedAt: null };
  (function loadLiveSession() {
    const r = readJsonSafe(SESSION_FILE);
    if (r.data && typeof r.data === 'object') {
      liveSession = {
        roomId: r.data.roomId ?? null,
        username: r.data.username ?? null,
        active: !!r.data.active,
        startedAt: r.data.startedAt ?? null,
      };
    }
  })();
  function saveLiveSession() {
    writeJsonAtomic(SESSION_FILE, liveSession);
  }
  function liveUserMatch(a, b) {
    return !!(a && b && String(a).toLowerCase() === String(b).toLowerCase());
  }
  function isSameLiveSession(roomId, username) {
    return !!(liveSession.roomId && roomId &&
      String(liveSession.roomId) === String(roomId) &&
      liveUserMatch(liveSession.username, username));
  }
  function markLiveSessionEnded() {
    liveSession.active = false;
    liveSession.roomId = null;
    saveLiveSession();
  }
  function resetSessionState() {
    lastTotalLikes = 0;
    resetStats();
    resetLiveUptimeSession();
    resetSessionOverlays();
  }
  // Auto-conexión / reinicio Render: resetea solo si es un live distinto (otro roomId).
  function applyAutoLiveConnected(newRoomId, username) {
    if (isSameLiveSession(newRoomId, username)) {
      liveSession.username = username;
      liveSession.active = true;
      saveLiveSession();
      state.startedAt = liveSession.startedAt || Date.now();
      return 'reconnect';
    }
    const prevRoomId = liveSession.roomId;
    const isNewLive = !!(newRoomId && prevRoomId && String(newRoomId) !== String(prevRoomId));
    const isFirstLive = !prevRoomId;
    if (isNewLive || isFirstLive) resetSessionState();
    liveSession = { roomId: newRoomId, username, active: true, startedAt: Date.now() };
    saveLiveSession();
    state.startedAt = liveSession.startedAt;
    liveBadgeSent = false;
    return isNewLive || isFirstLive ? 'new' : 'auto';
  }

  let profiles = loadProfiles();
  let settingsGeneration = 0;
  const profilesMediaBefore = JSON.stringify(profiles);
  normalizeProfilesMediaUrls(profiles);
  if (JSON.stringify(profiles) !== profilesMediaBefore) {
    try { writeJsonAtomic(PROFILES_FILE, profiles); } catch {}
  }
  function resolveProfileSettings(slot) {
    if (slot && typeof slot === 'object' && !Array.isArray(slot)) {
      return ensureFlowMeterDefaults(ensureGiftShowcaseDefaults(ensureGiftVsDefaults(ensureGiftSeqDefaults(deepMerge(structuredClone(DEFAULT_SETTINGS), slot)))));
    }
    return structuredClone(DEFAULT_SETTINGS);
  }
  function cloneSettings(obj) {
    if (!obj || typeof obj !== 'object') return structuredClone(DEFAULT_SETTINGS);
    try { return structuredClone(obj); } catch { return JSON.parse(JSON.stringify(obj)); }
  }
  /** Claves de ajustes compartidos entre perfiles (como Spotify).
   *  Overlays + Chat TTS + Temporizador + Usuario/Puntos + Webhook/RCON
   *  no cambian al cambiar de perfil. */
  const PROFILE_SHARED_KEYS = [
    'spotify',
    'tts',
    'timer',
    'points',
    'webhook', // RCON / OBS / Streamer.bot / ServerTap (conexión global)
    // Overlays (Streams / Gifts / Metas / Rankings / Diseño / Batalla / Contador)
    'perrito', 'jarron', 'vaquita', 'marranito', 'corazonLava', 'pelotas',
    'topDonor', 'giftVs', 'batallaVs', 'batallaMeta', 'batallaMvp', 'batallaTop3',
    'flowMeter', 'giftSeq', 'giftShowcase',
    'winsCounter', 'winsCounterGamer', 'winsCounterMinecraft', 'winsCounterMario',
    'top1', 'top1fire', 'habibiTop', 'topGift', 'lastGift', 'giftGoals', 'giftCounter', 'topStreak',
    'batallaGifts', 'batallaLikes', 'coinMatch', 'sorteosOverlay', 'topKills', 'screenFx',
    'toplikesRank', 'topdiamRank', 'toplikesList', 'topdiamList', 'topcommentsRank',
    'topAltRank', 'topAltRankNeon', 'topPointsRank', 'topMultiRank', 'pointsLookup',
    'hypeBar', 'alertaGift', 'alertaLikes', 'alertaFollow', 'fuegos',
    'followerCounter', 'followerCounterMc', 'liveTimer',
    'streamJoin', 'streamJoinMc', 'streamJoinDbz', 'streamJoinMario',
  ];
  /** Spotify (y el resto de keys globales) no dependen del perfil activo. */
  function defaultSpotifyCfg() {
    try { return structuredClone(DEFAULT_SETTINGS.spotify || {}); }
    catch { return { ...(DEFAULT_SETTINGS.spotify || {}) }; }
  }
  function normalizeSpotifyCfg(raw) {
    return { ...defaultSpotifyCfg(), ...(raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) };
  }
  function defaultSharedValue(key) {
    const def = DEFAULT_SETTINGS[key];
    if (def === undefined) return null;
    try { return structuredClone(def); }
    catch {
      if (Array.isArray(def)) return def.slice();
      if (def && typeof def === 'object') return { ...def };
      return def;
    }
  }
  function normalizeSharedValue(key, raw) {
    if (key === 'spotify') return normalizeSpotifyCfg(raw);
    const def = defaultSharedValue(key);
    if (def == null) return raw == null ? null : raw;
    if (Array.isArray(def)) return Array.isArray(raw) ? raw : def;
    if (def && typeof def === 'object') {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return def;
      try { return deepMerge(structuredClone(def), raw); }
      catch { return { ...def, ...raw }; }
    }
    return raw !== undefined && raw !== null ? raw : def;
  }
  function pickSharedForMigration(key) {
    const candidates = [];
    const activeSlot = profiles.slots?.[profiles.active];
    if (activeSlot && activeSlot[key] != null) candidates.push(activeSlot[key]);
    for (const s of profiles.slots || []) {
      if (!s || s === activeSlot) continue;
      if (s[key] != null) candidates.push(s[key]);
    }
    if (profiles.general && profiles.general[key] != null) candidates.push(profiles.general[key]);
    if (key === 'spotify') {
      const withId = candidates.find((c) => String(c?.clientId || '').trim());
      return normalizeSharedValue(key, withId || candidates[0] || null);
    }
    if (key === 'webhook') {
      // Preferir la ranura que ya tenga RCON/ServerTap configurado.
      const withCreds = candidates.find((c) => {
        if (!c || typeof c !== 'object') return false;
        const pw = String(c.rcon?.password || '').trim();
        const host = String(c.rcon?.host || '').trim();
        const stapKey = String(c.servertap?.key || '').trim();
        const stapOn = !!c.servertap?.enabled;
        return !!(pw || (host && host !== '127.0.0.1') || (stapOn && stapKey && stapKey !== 'change_me'));
      });
      return normalizeSharedValue(key, withCreds || candidates[0] || null);
    }
    return normalizeSharedValue(key, candidates[0] || null);
  }
  function ensureSharedKey(key) {
    const cur = profiles[key];
    if (cur != null && typeof cur === 'object' && !Array.isArray(cur)) {
      profiles[key] = normalizeSharedValue(key, cur);
      return false;
    }
    // Algunas keys pueden ser arrays en el futuro; hoy todas son objetos.
    if (Array.isArray(DEFAULT_SETTINGS[key]) && Array.isArray(cur)) {
      profiles[key] = normalizeSharedValue(key, cur);
      return false;
    }
    profiles[key] = pickSharedForMigration(key);
    return true;
  }
  function ensureAllSharedKeys() {
    let migrated = false;
    for (const key of PROFILE_SHARED_KEYS) {
      if (ensureSharedKey(key)) migrated = true;
    }
    return migrated;
  }
  function getSharedValue(key) {
    ensureSharedKey(key);
    return normalizeSharedValue(key, profiles[key]);
  }
  function persistSharedFromSettings() {
    if (!settings || typeof settings !== 'object') return;
    for (const key of PROFILE_SHARED_KEYS) {
      if (settings[key] === undefined) continue;
      profiles[key] = normalizeSharedValue(key, settings[key]);
      settings[key] = normalizeSharedValue(key, profiles[key]);
    }
  }
  function stripSharedFromSnap(snap) {
    if (!snap || typeof snap !== 'object') return snap;
    for (const key of PROFILE_SHARED_KEYS) delete snap[key];
    return snap;
  }
  /** Quita claves globales de todas las ranuras (evita copias viejas en disco).
   *  Devuelve true si se borró alguna clave (hay que persistir). */
  function stripSharedFromAllSlots() {
    let stripped = false;
    const stripOne = (snap) => {
      if (!snap || typeof snap !== 'object') return;
      for (const key of PROFILE_SHARED_KEYS) {
        if (!Object.prototype.hasOwnProperty.call(snap, key)) continue;
        delete snap[key];
        stripped = true;
      }
    };
    for (let i = 0; i < (profiles.slots || []).length; i++) stripOne(profiles.slots[i]);
    stripOne(profiles.general);
    return stripped;
  }
  /**
   * Tras migrar, un slot vacío puede dejar flowMeter/giftShowcase/etc. sin demos.
   * Solo en migración/import — no en cada attach (respeta vacíos intencionales del usuario).
   */
  function healSharedOverlayDefaults() {
    const bag = {};
    for (const key of ['flowMeter', 'giftShowcase', 'giftSeq', 'giftVs']) {
      bag[key] = getSharedValue(key);
    }
    ensureFlowMeterDefaults(ensureGiftShowcaseDefaults(ensureGiftVsDefaults(ensureGiftSeqDefaults(bag))));
    for (const key of ['flowMeter', 'giftShowcase', 'giftSeq', 'giftVs']) {
      if (bag[key] && typeof bag[key] === 'object') profiles[key] = bag[key];
    }
  }
  function attachSharedSettings(s) {
    if (!s || typeof s !== 'object') return s;
    for (const key of PROFILE_SHARED_KEYS) {
      s[key] = getSharedValue(key);
    }
    return s;
  }
  /** Aplica bolsa shared de backup/nube. replace pisa; merge solo rellena keys ausentes. */
  function applySharedBag(sharedBag, mode) {
    if (!sharedBag || typeof sharedBag !== 'object' || Array.isArray(sharedBag)) return false;
    let applied = false;
    const merge = mode === 'merge';
    for (const key of PROFILE_SHARED_KEYS) {
      if (sharedBag[key] == null) continue;
      if (key === 'spotify') {
        const curId = String(profiles.spotify?.clientId || '').trim();
        const incId = String(sharedBag.spotify?.clientId || '').trim();
        // Merge: no borrar un Client ID local con un backup sin ID.
        if (merge && curId && !incId) continue;
        if (merge && profiles.spotify != null && typeof profiles.spotify === 'object' && !incId) continue;
        if (!merge || !profiles.spotify || incId || !curId) {
          profiles.spotify = normalizeSpotifyCfg(sharedBag.spotify);
          applied = true;
        }
        continue;
      }
      if (key === 'webhook') {
        const curPw = String(profiles.webhook?.rcon?.password || '').trim();
        const incPw = String(sharedBag.webhook?.rcon?.password || '').trim();
        const stapInc = String(sharedBag.webhook?.servertap?.key || '').trim();
        const hasInc = !!(incPw || (stapInc && stapInc !== 'change_me'));
        // Merge: no pisar RCON local; sí rellenar si local está vacío y el backup trae credenciales.
        if (merge && curPw) continue;
        if (merge && profiles.webhook != null && typeof profiles.webhook === 'object' && !hasInc) continue;
        if (!merge || !profiles.webhook || hasInc || !curPw) {
          profiles.webhook = normalizeSharedValue('webhook', sharedBag.webhook);
          applied = true;
        }
        continue;
      }
      if (merge && profiles[key] != null && typeof profiles[key] === 'object') continue;
      profiles[key] = normalizeSharedValue(key, sharedBag[key]);
      applied = true;
    }
    return applied;
  }
  function sharedBagHasContent(sharedBag) {
    if (!sharedBag || typeof sharedBag !== 'object' || Array.isArray(sharedBag)) return false;
    return PROFILE_SHARED_KEYS.some((k) => sharedBag[k] != null);
  }
  // Compat: nombres antiguos usados por Spotify
  function ensureSharedSpotify() { return ensureSharedKey('spotify'); }
  function getSharedSpotify() { return getSharedValue('spotify'); }
  function persistSharedSpotifyFromSettings() { persistSharedFromSettings(); }
  function attachSharedSpotify(s) { return attachSharedSettings(s); }
  (function isolateProfileSlotsOnLoad() {
    let refDupes = false;
    const refs = new Map();
    for (let i = 0; i < (profiles.slots || []).length; i++) {
      const s = profiles.slots[i];
      if (!s || typeof s !== 'object') continue;
      if (refs.has(s)) refDupes = true;
      else refs.set(s, i);
      profiles.slots[i] = cloneSettings(s);
    }
    if (profiles.general && typeof profiles.general === 'object') {
      if (refs.has(profiles.general)) refDupes = true;
      profiles.general = cloneSettings(profiles.general);
    }
    const contentSeen = new Map();
    for (let i = 0; i < (profiles.slots || []).length; i++) {
      const s = profiles.slots[i];
      if (!s) continue;
      let hash;
      try { hash = JSON.stringify(s); } catch { continue; }
      if (contentSeen.has(hash)) {
        console.warn(`  [profiles] Perfil ${i + 1} es idéntico al perfil ${contentSeen.get(hash) + 1} (datos duplicados en disco).`);
      } else contentSeen.set(hash, i);
    }
    if (refDupes) {
      try { writeJsonAtomic(PROFILES_FILE, profiles); } catch {}
      console.log('  [profiles] Ranuras enlazadas separadas y guardadas.');
    }
  })();
  function loadSettings() {
    return attachSharedSettings(resolveProfileSettings(profiles.slots[profiles.active]));
  }
  function loadGeneralSettings() {
    return attachSharedSettings(resolveProfileSettings(profiles.general));
  }
  const hadSharedSpotify = !!(profiles.spotify && typeof profiles.spotify === 'object' && !Array.isArray(profiles.spotify));
  const migratedShared = ensureAllSharedKeys();
  // Solo sanar demos al migrar por primera vez (no en cada arranque: respeta vacíos del usuario).
  if (migratedShared) healSharedOverlayDefaults();
  const strippedSharedSlots = stripSharedFromAllSlots();
  let settings = profiles.editMode === 'general' ? loadGeneralSettings() : loadSettings();
  attachSharedSettings(settings);
  if (!hadSharedSpotify || migratedShared || strippedSharedSlots) {
    try { saveProfilesNow(); } catch {}
  }
  loadWeekly();
  loadTop1Fire();
  loadHabibiTop();
  loadGiftGoalsPersist();
  loadRankOverlays();
  loadGiftOverlayPeriods();
  loadSessionOverlays();
  loadPoints();
  restoreTimerFromSettings();
  // Recuerda el último @usuario de TikTok conectado (queda guardado en los ajustes, así
  // sobrevive a reinicios) para prerellenar el campo y poder auto-conectar al iniciar el live.
  state.username = settings.tiktokUser || null;
  if (settings.tiktokPhoto) followerCounter.photo = String(settings.tiktokPhoto);

  /* ----------------------------- Persistencia ----------------------------- */
  // Intenta recuperar profiles.json desde copias de seguridad (.bak / .corrupt).
  // Preferir el backup con MÁS contenido (no el más reciente): tras un wipe + AV
  // el .bak nuevo suele ser el vacío y el .corrupt viejo el bueno.
  function profileSlotContentScore(s) {
    if (!s || typeof s !== 'object') return 0;
    let n = 0;
    for (const k of ['actions', 'mcActions', 'mcshooterActions', 'bedrockActions', 'parkourActions', 'kothActions', 'farmActions', 'sandboxActions', 'soundAlerts', 'videos', 'marioActions', 'mari0Actions', 'smb3Actions', 'pvzActions', 'pvzHybridActions', 'repoActions', 'l4dActions', 'gtavKothActions', 'gtavChaosActions', 'gtavChiliadActions', 'unturnedActions', 'ctrActions', 'mslugActions', 'gdashActions', 'smwActions', 'robloxActions', 'roblox3Actions']) {
      const a = s[k];
      if (Array.isArray(a)) n += a.length * 1000 + JSON.stringify(a).length;
    }
    return n;
  }
  const PROFILE_ACTION_KEYS = ['actions', 'mcActions', 'mcshooterActions', 'bedrockActions', 'parkourActions', 'kothActions', 'farmActions', 'sandboxActions', 'soundAlerts', 'videos', 'marioActions', 'mari0Actions', 'smb3Actions', 'pvzActions', 'pvzHybridActions', 'repoActions', 'l4dActions', 'gtavKothActions', 'gtavChaosActions', 'gtavChiliadActions', 'unturnedActions', 'ctrActions', 'mslugActions', 'gdashActions', 'smwActions', 'robloxActions', 'roblox3Actions'];
  /** Huella estable para detectar acciones duplicadas al mezclar PC + nube. */
  function actionDedupeKey(a) {
    if (!a || typeof a !== 'object') return String(a);
    try {
      const mario = a.marioSpawn && typeof a.marioSpawn === 'object' ? a.marioSpawn : null;
      return [
        String(a.trigger || a.event || ''),
        String(a.giftId || ''),
        String(a.giftName || '').trim().toLowerCase(),
        String(a.likeN || a.likeMin || a.likes || ''),
        String(a.name || a.label || '').trim().toLowerCase(),
        String(a.keys || a.key || a.combo || ''),
        String(a.cmd || a.command || ''),
        String(a.thing || a.npcId || mario?.npcId || ''),
        String(a.count || a.times || a.quantity || mario?.quantity || ''),
        String(a.url || a.webhook || a.file || a.src || a.sound || a.video || ''),
        String(a.holdDurationMs || a.holdSec || ''),
        String(a.enabled === false ? '0' : '1'),
      ].join('|');
    } catch {
      try { return JSON.stringify(a); } catch { return String(Math.random()); }
    }
  }
  /** Une dos listas de acciones: local + remoto, sin duplicados. */
  function mergeActionArraysUnion(localArr, remoteArr) {
    const out = [];
    const seen = new Set();
    const add = (item) => {
      if (!item || typeof item !== 'object') return;
      const key = actionDedupeKey(item);
      if (seen.has(key)) return;
      seen.add(key);
      try { out.push(cloneSettings(item)); } catch { out.push({ ...item }); }
    };
    if (Array.isArray(localArr)) for (const a of localArr) add(a);
    if (Array.isArray(remoteArr)) for (const a of remoteArr) add(a);
    return out;
  }
  /**
   * Mezcla dos ranuras de perfil: une acciones de ambos lados (sin repetir)
   * y en el resto de campos conserva valores reales (no pisa con vacíos).
   */
  function mergeSlotsUnion(local, remote) {
    if (!remote || typeof remote !== 'object') return local || remote;
    if (!local || typeof local !== 'object') return remote;
    const out = mergePreferFilledShared(cloneSettings(local), cloneSettings(remote));
    for (const k of PROFILE_ACTION_KEYS) {
      out[k] = mergeActionArraysUnion(local[k], remote[k]);
    }
    return out;
  }
  /** Valor “vacío” que no debe pisar un secreto/config local al sincronizar. */
  function isEmptyishSharedField(v) {
    if (v == null) return true;
    if (typeof v === 'boolean') return false;
    if (typeof v === 'number') return false;
    if (typeof v === 'string') {
      const t = v.trim();
      return !t || t === 'change_me' || t === 'changeme';
    }
    if (Array.isArray(v)) return v.length === 0;
    if (typeof v === 'object') {
      try {
        const s = JSON.stringify(v);
        return !s || s === '{}' || s === '[]' || s === 'null';
      } catch { return true; }
    }
    return false;
  }
  /** Mezcla remoto sobre local sin borrar campos locales con valor real. */
  function mergePreferFilledShared(local, remote) {
    if (remote == null) return local;
    if (local == null) return remote;
    if (Array.isArray(remote)) {
      if (Array.isArray(local) && local.length > remote.length && remote.length === 0) return local;
      return remote;
    }
    if (typeof remote !== 'object') {
      if (isEmptyishSharedField(remote) && !isEmptyishSharedField(local)) return local;
      return remote;
    }
    if (typeof local !== 'object' || Array.isArray(local)) return remote;
    const out = { ...local };
    for (const k of Object.keys(remote)) {
      const rv = remote[k];
      const lv = local[k];
      if (rv && typeof rv === 'object' && !Array.isArray(rv)) {
        out[k] = mergePreferFilledShared(lv && typeof lv === 'object' && !Array.isArray(lv) ? lv : {}, rv);
      } else if (isEmptyishSharedField(rv) && !isEmptyishSharedField(lv)) {
        out[k] = lv;
      } else {
        out[k] = rv;
      }
    }
    return out;
  }
  function sharedValueContentScore(key, v) {
    if (v == null) return 0;
    let n = 0;
    try {
      const s = JSON.stringify(v);
      if (s && s !== '{}' && s !== '[]' && s !== 'null') n += Math.min(s.length, 80000);
    } catch { return 0; }
    // Extra peso a credenciales: que una nube vacía nunca “gane” a RCON/Spotify local.
    if (key === 'webhook' && v && typeof v === 'object') {
      const pw = String(v.rcon?.password || '').trim();
      const host = String(v.rcon?.host || '').trim();
      const stapKey = String(v.servertap?.key || '').trim();
      const stapOn = !!v.servertap?.enabled;
      if (pw) n += 50000;
      if (host && host !== '127.0.0.1') n += 20000;
      if (stapOn && stapKey && stapKey !== 'change_me') n += 50000;
      const wh = String(v.url || v.webhookUrl || '').trim();
      if (wh) n += 15000;
    }
    if (key === 'spotify' && v && typeof v === 'object') {
      if (String(v.clientId || '').trim()) n += 40000;
      if (String(v.refreshToken || v.accessToken || '').trim()) n += 40000;
    }
    return n;
  }
  function applySharedKeyFromRemote(key, rawRemote, mergeKeepRicher) {
    if (rawRemote == null) return false;
    const incoming = normalizeSharedValue(key, rawRemote);
    if (!mergeKeepRicher) {
      profiles[key] = incoming;
      return true;
    }
    const local = profiles[key];
    // Unión: campos de ambos; si uno viene vacío y el otro tiene valor, se conserva el valor.
    profiles[key] = normalizeSharedValue(key, mergePreferFilledShared(local, incoming));
    return true;
  }
  function profilesDataContentScore(p) {
    if (!p || typeof p !== 'object') return 0;
    let total = 0;
    if (Array.isArray(p.slots)) for (const s of p.slots) total += profileSlotContentScore(s);
    if (p.general) total += profileSlotContentScore(p.general);
    return total;
  }
  function recoverProfilesFromBackups() {
    try {
      const dir = path.dirname(PROFILES_FILE);
      const base = path.basename(PROFILES_FILE);
      const candidates = fs.readdirSync(dir)
        .filter((f) => f === base + '.bak' || f.startsWith(base + '.bak.') || f.startsWith(base + '.corrupt'))
        .map((f) => path.join(dir, f));
      let best = null;
      let bestScore = -1;
      let bestSize = -1;
      for (const file of candidates) {
        let size = 0;
        try { size = fs.statSync(file).size || 0; } catch { continue; }
        const r = readJsonSafe(file);
        if (!r.data || !Array.isArray(r.data.slots) || !r.data.slots.some((s) => s != null)) continue;
        const score = profilesDataContentScore(r.data);
        if (score > bestScore || (score === bestScore && size > bestSize)) {
          best = r.data;
          bestScore = score;
          bestSize = size;
        }
      }
      if (best) {
        console.log('  [profiles] Recuperado backup con score', bestScore, '(tamaño ~' + bestSize + ')');
        return best;
      }
    } catch {}
    return null;
  }
  // Si el profiles.json actual quedó “flaco” tras un update/AV pero hay un backup
  // mucho más rico, restaurarlo automáticamente (una sola vez al cargar).
  function healThinProfilesFromBackup(current) {
    try {
      const curScore = profilesDataContentScore(current);
      const best = recoverProfilesFromBackups();
      if (!best) return current;
      const bestScore = profilesDataContentScore(best);
      if (bestScore > curScore + 8000 && bestScore > curScore * 1.4) {
        console.log('  [profiles] Restaurando backup más completo (local', curScore, '→ backup', bestScore + ')');
        return best;
      }
    } catch {}
    return current;
  }
  // Carga (o crea/migra) el archivo de perfiles. Migración: si ya había un
  // settings.json suelto, se convierte en el "Perfil 1". NUNCA se borran ranuras
  // con datos: si falta profiles.json se reconstruye conservando todo lo posible.
  function loadProfiles() {
    const r = readJsonSafe(PROFILES_FILE);
    let p = r.data;
    let created = false;
    let healed = false;
    if (r.corrupt) p = recoverProfilesFromBackups();
    if (!p || !Array.isArray(p.slots)) {
      const legacy = readJsonSafe(SETTINGS_FILE).data || null;
      p = { active: 0, names: [], slots: [] };
      p.slots[0] = legacy; // Perfil 1 hereda lo que ya había (o null = defaults)
      created = true;
    } else {
      const before = p;
      p = healThinProfilesFromBackup(p);
      if (p !== before) healed = true;
    }
    // Normaliza tamaño y nombres.
    p.slots = Array.isArray(p.slots) ? p.slots.slice(0, PROFILE_COUNT) : [];
    while (p.slots.length < PROFILE_COUNT) p.slots.push(null);
    p.names = Array.isArray(p.names) ? p.names.slice(0, PROFILE_COUNT) : [];
    for (let i = 0; i < PROFILE_COUNT; i++) {
      if (!p.names[i]) p.names[i] = `Perfil ${i + 1}`;
    }
    p.active = Number.isInteger(p.active) && p.active >= 0 && p.active < PROFILE_COUNT ? p.active : 0;
    if (p.general != null && (typeof p.general !== 'object' || Array.isArray(p.general))) p.general = null;
    if (p.editMode !== 'general') p.editMode = 'profile';
    // Persiste de inmediato si acabamos de crear/migrar/recuperar para que un reinicio
    // o actualización no vuelva a dejar la room sin profiles.json.
    if (created || healed || r.corrupt || !fs.existsSync(PROFILES_FILE)) {
      try { writeJsonAtomic(PROFILES_FILE, p); } catch {}
    }
    return p;
  }
  function saveProfilesNow() {
    try {
      profiles.syncTs = Date.now();
      if (fs.existsSync(PROFILES_FILE)) {
        try { fs.copyFileSync(PROFILES_FILE, PROFILES_FILE + '.bak'); } catch {}
      }
      writeJsonAtomic(PROFILES_FILE, profiles);
    } catch {}
  }
  function persistCurrentEdit() {
    clearTimeout(saveTimer);
    persistSharedFromSettings();
    const snap = cloneSettings(settings);
    // Globales (Spotify, overlays, TTS, timer, puntos): no guardar copia por ranura.
    stripSharedFromSnap(snap);
    if (profiles.editMode === 'general') profiles.general = snap;
    else profiles.slots[profiles.active] = snap;
  }
  function getActiveProfileSettings() {
    // Solo el perfil numerado activo (1, 2, 3…). Nunca otros slots guardados.
    if (profiles.editMode === 'profile') return attachSharedSettings(resolveProfileSettings(settings));
    return loadSettings();
  }
  function getGeneralProfileSettings() {
    // En edición del general, `settings` ya es la copia viva (el guardado en disco puede ir con debounce).
    if (profiles.editMode === 'general') return attachSharedSettings(resolveProfileSettings(settings));
    if (!profiles.general) return null;
    return attachSharedSettings(resolveProfileSettings(profiles.general));
  }
  function forEachTriggerProfile(run) {
    run(getActiveProfileSettings(), false);
    const g = getGeneralProfileSettings();
    if (g) run(g, true);
  }
  function saveSettings() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      normalizeSettingsMediaUrls(settings);
      persistSharedFromSettings();
      const snap = cloneSettings(settings);
      // Copia independiente por ranura: evita que acciones de un perfil contaminen otro.
      // Spotify / overlays / TTS / timer / puntos quedan en profiles.* (compartidos).
      stripSharedFromSnap(snap);
      if (profiles.editMode === 'general') profiles.general = snap;
      else profiles.slots[profiles.active] = snap;
      saveProfilesNow();
      // Mantenemos settings.json como espejo del perfil activo (compatibilidad y
      // sincronización con el servidor remoto, que lee el perfil activo).
      writeJsonAtomic(SETTINGS_FILE, settings);
    }, 300);
  }

  /* ------------------------------- Perfiles ------------------------------- */
  // Cuántos perfiles permite el plan actual (acotado al total de ranuras).
  function profileLimit() {
    const caps = currentCaps();
    const n = Number(caps && caps.limits && caps.limits.profiles);
    if (!Number.isFinite(n) || n <= 0) return 1;
    return Math.min(PROFILE_COUNT, Math.max(1, Math.floor(n)));
  }
  function profilesInfo() {
    return {
      active: profiles.active,
      count: PROFILE_COUNT,
      max: profileLimit(),
      names: profiles.names.slice(),
      used: profiles.slots.map((s) => !!s),
      editingGeneral: profiles.editMode === 'general',
      generalUsed: !!profiles.general,
      settingsGeneration,
      editMode: profiles.editMode === 'general' ? 'general' : 'profile',
    };
  }
  function broadcastProfiles() { broadcast('profiles', profilesInfo()); }
  /** Al cambiar de perfil: cancela MC en cola, rachas y acumuladores del perfil anterior. */
  function clearProfileRuntimeState() {
    settingsGeneration += 1;
    try { bumpMcPanic(); } catch {}
    try { giftStreakGameProgress.clear(); } catch {}
    try { giftStreakAlertProgress.clear(); } catch {}
    try { gameLikeAcc.clear(); } catch {}
    try { recentGiftTriggers.clear(); } catch {}
    try {
      for (const key of [...webhookActive.keys()]) clearWebhookActive(key);
    } catch {}
  }
  // Cambia de perfil: primero asegura que lo actual quede guardado, luego carga el
  // perfil destino y difunde sus ajustes a panel/overlays.
  function switchProfile(i) {
    const idx = Number(i);
    if (!Number.isInteger(idx) || idx < 0 || idx >= PROFILE_COUNT) return;
    if (idx >= profileLimit()) return; // perfil bloqueado por el plan
    if (profiles.editMode === 'profile' && idx === profiles.active) return;
    persistCurrentEdit();
    profiles.editMode = 'profile';
    profiles.active = idx;
    clearProfileRuntimeState();
    saveProfilesNow();
    settings = loadSettings();
    writeJsonAtomic(SETTINGS_FILE, settings);
    enforceLimits();
    // Overlays/TTS/timer son globales: no recargar ni vaciar sesiones live al cambiar de perfil.
    // Solo reenviar el estado actual a paneles/overlays.
    try { broadcastTop1Fire(); } catch {}
    try { broadcastHabibiTop(); } catch {}
    try { broadcastGiftGoals(); } catch {}
    try { broadcastAllRankStates(); } catch {}
    broadcast('settings', settings);
    broadcastProfiles();
    clampTimer();
    broadcastTimer();
    if (typeof onUserSave === 'function') { try { onUserSave(settings); } catch {} }
  }
  // Editar el perfil general (siempre activo en segundo plano junto al perfil activo).
  function switchToGeneralEdit() {
    if (profiles.editMode === 'general') return;
    persistCurrentEdit();
    profiles.editMode = 'general';
    clearProfileRuntimeState();
    saveProfilesNow();
    settings = loadGeneralSettings();
    writeJsonAtomic(SETTINGS_FILE, settings);
    enforceLimits();
    broadcast('settings', settings);
    broadcastProfiles();
    if (typeof onUserSave === 'function') { try { onUserSave(settings); } catch {} }
  }
  function renameProfile(i, name) {
    const idx = Number(i);
    if (!Number.isInteger(idx) || idx < 0 || idx >= PROFILE_COUNT) return;
    const clean = String(name || '').trim().slice(0, 40);
    profiles.names[idx] = clean || `Perfil ${idx + 1}`;
    saveProfilesNow();
    broadcastProfiles();
  }
  // Devuelve TODOS los perfiles (con sus ajustes completos) para exportar. El perfil
  // activo usa los ajustes en memoria (por si hay cambios sin guardar todavía).
  function getProfilesFull() {
    const slots = profiles.slots.map((s, i) => {
      let src = s;
      if (profiles.editMode !== 'general' && i === profiles.active) src = settings;
      if (!src) return null;
      const out = cloneSettings(src);
      stripSharedFromSnap(out);
      return out;
    });
    let general = null;
    if (profiles.editMode === 'general') general = cloneSettings(settings);
    else if (profiles.general) general = cloneSettings(profiles.general);
    if (general) stripSharedFromSnap(general);
    const shared = {};
    for (const key of PROFILE_SHARED_KEYS) shared[key] = getSharedValue(key);
    return {
      active: profiles.active,
      names: profiles.names.slice(),
      slots,
      general,
      editingGeneral: profiles.editMode === 'general',
      syncTs: profiles.syncTs || 0,
      // Compat export: spotify también en raíz (clientes viejos / transfer)
      spotify: shared.spotify,
      shared,
    };
  }
  // Importa una lista de perfiles { name, settings } en las ranuras 0..N-1. En modo
  // 'replace' cada perfil sustituye al de su ranura; en 'merge' se fusiona encima.
  function importProfiles(list, mode, sharedBag) {
    if (!Array.isArray(list) || !list.length) return;
    persistCurrentEdit();
    profiles.editMode = 'profile';
    const hasBag = sharedBagHasContent(sharedBag);
    if (hasBag) applySharedBag(sharedBag, mode);
    const n = Math.min(list.length, PROFILE_COUNT);
    for (let i = 0; i < n; i++) {
      const entry = list[i] || {};
      const incoming = entry.settings || entry.data;
      if (incoming && typeof incoming === 'object' && !Array.isArray(incoming)) {
        const inc = cloneSettings(incoming);
        // Promueve claves globales del primer perfil (backups viejos las traían en cada ranura).
        if (i === 0 && !hasBag) {
          applySharedBag(inc, mode);
        }
        stripSharedFromSnap(inc);
        const base = (mode === 'merge' && profiles.slots[i])
          ? cloneSettings(profiles.slots[i])
          : structuredClone(DEFAULT_SETTINGS);
        stripSharedFromSnap(base);
        profiles.slots[i] = deepMerge(base, inc);
      }
      const nm = String(entry.name || '').trim().slice(0, 40);
      if (nm) profiles.names[i] = nm;
    }
    const migrated = ensureAllSharedKeys();
    // En replace: sanar demos vacíos del backup. En merge: solo si acabamos de migrar keys nuevas.
    if (mode !== 'merge' || migrated) healSharedOverlayDefaults();
    stripSharedFromAllSlots();
    saveProfilesNow();
    settings = loadSettings(); // recarga el perfil activo desde su ranura ya actualizada
    enforceLimits();
    writeJsonAtomic(SETTINGS_FILE, settings);
    broadcast('settings', settings);
    broadcastProfiles();
    restoreTimerFromSettings();
    clampTimer();
    broadcastTimer();
    if (typeof onUserSave === 'function') { try { onUserSave(settings); } catch {} }
  }
  // Sincroniza la estructura completa de perfiles (desde la nube o copia de seguridad).
  // opts.mergeKeepRicher: no reemplazar una ranura local rica con una remota vacía/pobre
  // (evita que un sync tras update borre acciones de juegos).
  function importProfilesFull(data, opts) {
    if (!data || typeof data !== 'object') return false;
    const silent = !!(opts && opts.silent);
    const mergeKeepRicher = !!(opts && opts.mergeKeepRicher);
    persistCurrentEdit();
    const idx = Number(data.active);
    if (Number.isInteger(idx) && idx >= 0 && idx < PROFILE_COUNT) profiles.active = idx;
    if (Array.isArray(data.names)) {
      for (let i = 0; i < PROFILE_COUNT; i++) {
        const nm = String(data.names[i] || '').trim().slice(0, 40);
        if (nm) profiles.names[i] = nm;
      }
    }
    if (Array.isArray(data.slots)) {
      for (let i = 0; i < PROFILE_COUNT; i++) {
        const s = data.slots[i];
        const incoming = (s && typeof s === 'object' && !Array.isArray(s)) ? cloneSettings(s) : null;
        if (mergeKeepRicher) {
          // Unión PC + nube: acciones de ambos, sin duplicados; no se pierde nada.
          if (profiles.slots[i] && incoming) {
            profiles.slots[i] = mergeSlotsUnion(profiles.slots[i], incoming);
          } else {
            profiles.slots[i] = incoming || profiles.slots[i] || null;
          }
        } else {
          profiles.slots[i] = incoming;
        }
      }
    }
    if (data.general != null) {
      const incomingG = (data.general && typeof data.general === 'object' && !Array.isArray(data.general))
        ? cloneSettings(data.general) : null;
      if (mergeKeepRicher) {
        if (profiles.general && incomingG) profiles.general = mergeSlotsUnion(profiles.general, incomingG);
        else profiles.general = incomingG || profiles.general || null;
      } else {
        profiles.general = incomingG;
      }
    }
    // Restaurar claves globales (Spotify + overlays + TTS + timer + webhook/RCON…).
    // Con mergeKeepRicher: no pisar secretos/config local con nube vacía o más pobre.
    if (data.shared && typeof data.shared === 'object' && !Array.isArray(data.shared)) {
      for (const key of PROFILE_SHARED_KEYS) {
        if (data.shared[key] != null) applySharedKeyFromRemote(key, data.shared[key], mergeKeepRicher);
      }
    }
    for (const key of PROFILE_SHARED_KEYS) {
      if (data[key] != null && typeof data[key] === 'object') {
        applySharedKeyFromRemote(key, data[key], mergeKeepRicher);
      }
    }
    ensureAllSharedKeys();
    healSharedOverlayDefaults();
    stripSharedFromAllSlots();
    profiles.editMode = data.editingGeneral ? 'general' : 'profile';
    clearProfileRuntimeState();
    saveProfilesNow();
    settings = profiles.editMode === 'general' ? loadGeneralSettings() : loadSettings();
    attachSharedSettings(settings);
    enforceLimits();
    writeJsonAtomic(SETTINGS_FILE, settings);
    loadTop1Fire();
    broadcastTop1Fire();
    loadHabibiTop();
    broadcastHabibiTop();
    loadGiftGoalsPersist();
    broadcastGiftGoals();
    loadRankOverlays();
    broadcastAllRankStates();
    broadcast('settings', settings);
    broadcastProfiles();
    restoreTimerFromSettings();
    clampTimer();
    broadcastTimer();
    if (!silent && typeof onUserSave === 'function') { try { onUserSave(settings); } catch {} }
    return true;
  }
  function profilesFullContentScore(full) {
    if (!full || typeof full !== 'object') return 0;
    let total = 0;
    if (Array.isArray(full.slots)) for (const s of full.slots) total += profileSlotContentScore(s);
    if (full.general) total += profileSlotContentScore(full.general);
    const scoreSharedBag = (bag) => {
      if (!bag || typeof bag !== 'object') return 0;
      let n = 0;
      for (const key of PROFILE_SHARED_KEYS) {
        n += sharedValueContentScore(key, bag[key]);
      }
      return n;
    };
    const sharedBag = (full.shared && typeof full.shared === 'object' && !Array.isArray(full.shared))
      ? { ...full.shared } : {};
    for (const key of PROFILE_SHARED_KEYS) {
      if (full[key] != null && sharedBag[key] == null) sharedBag[key] = full[key];
    }
    total += scoreSharedBag(sharedBag);
    return total;
  }
  function profilesFullSyncScore(full) {
    // Contenido + syncTs (desempate). La decisión de pisar local usa content score.
    if (!full || typeof full !== 'object') return 0;
    return profilesFullContentScore(full) + (Number(full.syncTs) || 0);
  }
  function normalizeResetPeriod(p) {
    return p === 'week' || p === 'month' ? p : 'live';
  }
  // Aplica un bloque de ajustes (fusión profunda), persiste y difunde. Si el cambio
  // viene del panel del usuario (fromUser), avisa para sincronizarlo con el remoto.
  // meta (opcional): profileActive / editMode / settingsGeneration — rechaza saves
  // stale de otro perfil tras un cambio rápido de perfil.
  function applyIncomingSettings(obj, fromUser, meta) {
    if (!obj) return;
    if (fromUser && meta && typeof meta === 'object') {
      const wantMode = meta.editMode === 'general' ? 'general' : (meta.editMode === 'profile' ? 'profile' : null);
      if (wantMode && wantMode !== profiles.editMode) {
        console.log('  [profiles] Ignorado saveSettings de modo', wantMode, '(activo:', profiles.editMode + ')');
        return;
      }
      if (wantMode !== 'general' && meta.profileActive != null && Number.isFinite(Number(meta.profileActive))) {
        if (Number(meta.profileActive) !== profiles.active) {
          console.log('  [profiles] Ignorado saveSettings del perfil', meta.profileActive, '(activo:', profiles.active + ')');
          return;
        }
      }
      if (meta.settingsGeneration != null && Number.isFinite(Number(meta.settingsGeneration))) {
        if (Number(meta.settingsGeneration) !== settingsGeneration) {
          console.log('  [profiles] Ignorado saveSettings generation', meta.settingsGeneration, '(actual:', settingsGeneration + ')');
          return;
        }
      }
    }
    const prevTop1FirePeriod = getTop1FirePeriod();
    const prevHabibiTopPeriod = getHabibiTopPeriod();
    const prevGiftGoalsPeriod = getGiftGoalsPeriod();
    const prevGiftOverlayPeriods = {};
    for (const k of GIFT_OVERLAY_KEYS) prevGiftOverlayPeriods[k] = getGiftOverlayPeriod(k);
    const prevRankPeriods = {};
    for (const rankId of RANK_IDS) prevRankPeriods[rankId] = getRankPeriod(rankId);
    // Periodos ALT previos: solo reaccionar si el propio ALT cambió de periodo,
    // no si el ranking individual difiere (evita vaciar likes/gifts en cada saveSettings).
    const prevAltLikes = normalizeResetPeriod(settings.topAltRank?.resetPeriodLikes);
    const prevAltDiam = normalizeResetPeriod(settings.topAltRank?.resetPeriodDiam);
    const prevNeonLikes = normalizeResetPeriod(settings.topAltRankNeon?.resetPeriodLikes);
    const prevNeonDiam = normalizeResetPeriod(settings.topAltRankNeon?.resetPeriodDiam);
    const prevMultiLikes = normalizeResetPeriod(settings.topMultiRank?.resetPeriodLikes);
    const prevMultiDiam = normalizeResetPeriod(settings.topMultiRank?.resetPeriodDiam);
    const prevMultiComments = normalizeResetPeriod(settings.topMultiRank?.resetPeriodComments);
    // Si apagan videos/batallas (master o individual), cortar lo que esté sonando en Live Studio.
    let stopVideoScreens = null;
    if (obj.videos !== undefined || obj.videosEnabled !== undefined
      || obj.battleAlerts !== undefined || obj.battleAlertsEnabled !== undefined) {
      const prevVids = Array.isArray(settings.videos) ? settings.videos : [];
      const prevBas = Array.isArray(settings.battleAlerts) ? settings.battleAlerts : [];
      const prevVidEn = settings.videosEnabled !== false;
      const prevBaEn = settings.battleAlertsEnabled !== false;
      const nextVids = Array.isArray(obj.videos) ? obj.videos : prevVids;
      const nextBas = Array.isArray(obj.battleAlerts) ? obj.battleAlerts : prevBas;
      const nextVidEn = obj.videosEnabled !== undefined ? obj.videosEnabled !== false : prevVidEn;
      const nextBaEn = obj.battleAlertsEnabled !== undefined ? obj.battleAlertsEnabled !== false : prevBaEn;
      stopVideoScreens = new Set();
      for (const v of prevVids) {
        if (!prevVidEn || v.enabled === false) continue;
        const nv = nextVids.find((x) => String(x.id) === String(v.id));
        const onNow = nextVidEn && !!nv && nv.enabled !== false;
        if (!onNow) stopVideoScreens.add(clampMediaScreen(v.screen));
      }
      for (const b of prevBas) {
        if (!prevBaEn || b.enabled === false) continue;
        const nb = nextBas.find((x) => String(x.id) === String(b.id));
        const onNow = nextBaEn && !!nb && nb.enabled !== false;
        if (!onNow) stopVideoScreens.add(clampMediaScreen(b.screen));
      }
      if (!stopVideoScreens.size) stopVideoScreens = null;
    }
    // Top kills: no pisar jugadores con [] salvo clearPlayers (Reset del usuario).
    if (obj.topKills && typeof obj.topKills === 'object') {
      const incomingPlayers = obj.topKills.players;
      const curPlayers = settings.topKills?.players;
      const clearPlayers = !!obj.topKills.clearPlayers;
      if (clearPlayers) {
        obj.topKills = { ...obj.topKills, players: Array.isArray(incomingPlayers) ? incomingPlayers : [], clearPlayers: undefined };
      } else if (Array.isArray(incomingPlayers) && incomingPlayers.length === 0
        && Array.isArray(curPlayers) && curPlayers.length > 0) {
        obj.topKills = { ...obj.topKills, players: curPlayers };
      }
    }
    settings = deepMerge(settings, obj);
    if (settings.topKills && 'clearPlayers' in settings.topKills) delete settings.topKills.clearPlayers;
    if (obj.top1fire && obj.top1fire.resetPeriod != null
      && normalizeResetPeriod(obj.top1fire.resetPeriod) !== prevTop1FirePeriod) onTop1FireSettingsChange();
    if (obj.habibiTop && obj.habibiTop.resetPeriod != null
      && normalizeResetPeriod(obj.habibiTop.resetPeriod) !== prevHabibiTopPeriod) onHabibiTopSettingsChange();
    if (obj.giftGoals && obj.giftGoals.resetPeriod != null
      && normalizeResetPeriod(obj.giftGoals.resetPeriod) !== prevGiftGoalsPeriod) onGiftGoalsPeriodChange();
    for (const k of GIFT_OVERLAY_KEYS) {
      if (obj[k] && obj[k].resetPeriod != null
        && normalizeResetPeriod(obj[k].resetPeriod) !== prevGiftOverlayPeriods[k]) {
        onGiftOverlayPeriodChange(k);
      }
    }
    for (const rankId of RANK_IDS) {
      const key = RANK_SETTINGS_KEY[rankId];
      if (obj[key] && obj[key].resetPeriod != null
        && normalizeResetPeriod(obj[key].resetPeriod) !== prevRankPeriods[rankId]) onRankPeriodChange(rankId);
    }
    if (obj.topAltRank) {
      const incoming = obj.topAltRank;
      if (incoming.resetPeriodLikes != null
        && normalizeResetPeriod(incoming.resetPeriodLikes) !== prevAltLikes) {
        if (!settings.toplikesRank) settings.toplikesRank = {};
        settings.toplikesRank.resetPeriod = incoming.resetPeriodLikes;
        onRankPeriodChange('toplikes');
      }
      if (incoming.resetPeriodDiam != null
        && normalizeResetPeriod(incoming.resetPeriodDiam) !== prevAltDiam) {
        if (!settings.topdiamRank) settings.topdiamRank = {};
        settings.topdiamRank.resetPeriod = incoming.resetPeriodDiam;
        onRankPeriodChange('topdiam');
      }
    }
    if (obj.topAltRankNeon) {
      const incoming = obj.topAltRankNeon;
      if (incoming.resetPeriodLikes != null
        && normalizeResetPeriod(incoming.resetPeriodLikes) !== prevNeonLikes) {
        if (!settings.toplikesRank) settings.toplikesRank = {};
        settings.toplikesRank.resetPeriod = incoming.resetPeriodLikes;
        onRankPeriodChange('toplikes');
      }
      if (incoming.resetPeriodDiam != null
        && normalizeResetPeriod(incoming.resetPeriodDiam) !== prevNeonDiam) {
        if (!settings.topdiamRank) settings.topdiamRank = {};
        settings.topdiamRank.resetPeriod = incoming.resetPeriodDiam;
        onRankPeriodChange('topdiam');
      }
    }
    if (obj.topMultiRank) {
      const incoming = obj.topMultiRank;
      if (incoming.resetPeriodLikes != null
        && normalizeResetPeriod(incoming.resetPeriodLikes) !== prevMultiLikes) {
        if (!settings.toplikesRank) settings.toplikesRank = {};
        settings.toplikesRank.resetPeriod = incoming.resetPeriodLikes;
        onRankPeriodChange('toplikes');
      }
      if (incoming.resetPeriodDiam != null
        && normalizeResetPeriod(incoming.resetPeriodDiam) !== prevMultiDiam) {
        if (!settings.topdiamRank) settings.topdiamRank = {};
        settings.topdiamRank.resetPeriod = incoming.resetPeriodDiam;
        onRankPeriodChange('topdiam');
      }
      if (incoming.resetPeriodComments != null
        && normalizeResetPeriod(incoming.resetPeriodComments) !== prevMultiComments) {
        if (!settings.topcommentsRank) settings.topcommentsRank = {};
        settings.topcommentsRank.resetPeriod = incoming.resetPeriodComments;
        onRankPeriodChange('topcomments');
      }
    }
    enforceLimits();
    saveSettings();
    broadcast('settings', settings);
    if (obj.followerCounter || obj.followerCounterMc) {
      try { broadcastFollowerCounter(); } catch { /* foc aún no listo en boot */ }
    }
    clampTimer();
    broadcastTimer();
    if (stopVideoScreens) {
      for (const scr of stopVideoScreens) emitStopMedia(scr);
    }
    if (fromUser && typeof onUserSave === 'function') {
      try { onUserSave(settings); } catch {}
    }
  }

  /* ------------------------------- Broadcast ------------------------------ */
  function broadcast(type, payload) {
    const msg = JSON.stringify({ type, payload });
    for (const client of clients) {
      if (client.readyState === 1) client.send(msg);
    }
  }
  function broadcastToLocal(type, payload) {
    const msg = JSON.stringify({ type, payload });
    for (const client of clients) {
      if (client.readyState !== 1) continue;
      const role = clientRoles.get(client) || 'panel';
      if (role === 'relay' || role === 'local') client.send(msg);
    }
  }
  function hasLocalRelayClient() {
    for (const client of clients) {
      if (client.readyState !== 1) continue;
      const role = clientRoles.get(client) || 'panel';
      if (role === 'relay' || role === 'local') return true;
    }
    return false;
  }
  function noteGameExec(exec) {
    if (typeof onGameExec !== 'function' || !exec?.tipo) return;
    try { onGameExec(exec.tipo); } catch { /* ignore */ }
  }
  function emitLocalExec(exec) {
    if (!IS_CLOUD_ROOM || !exec || !exec.tipo) return false;
    if (!hasLocalRelayClient()) return false;
    broadcastToLocal('localExec', exec);
    noteGameExec(exec);
    return true;
  }
  function mcRelayExec(exec) {
    if (!emitLocalExec(exec)) return false;
    broadcast('log', { level: 'ok', text: `🟩 Minecraft: ${exec.name || 'acción'} → tu PC` });
    return true;
  }
  function mcCloudNeedsRelay() {
    return IS_CLOUD_ROOM && !hasLocalRelayClient();
  }
  function dispatchLocalGameExec(exec) {
    if (!exec || !exec.tipo) return Promise.resolve({ ok: false, error: 'sin_tipo' });
    if (emitLocalExec(exec)) return Promise.resolve({ ok: true, relayed: true });
    noteGameExec(exec);
    return runGameExec(exec);
  }
  let screensBroadcastTimer = null;
  let screensPulseTimer = null;
  function broadcastScreens(immediate) {
    clearTimeout(screensBroadcastTimer);
    const send = () => broadcast('screens', { connected: [...new Set(videoScreens.values())] });
    if (immediate) send();
    else screensBroadcastTimer = setTimeout(send, 200);
  }
  // Recordatorio periódico: el panel recupera "Conectada" tras un redeploy aunque se perdiera un hello.
  screensPulseTimer = setInterval(() => {
    if (videoScreens.size) broadcastScreens(true);
  }, 15000);
  /* --------------------- Contador de meta (gift counter) -------------------- */
  function serializeGiftCounter() {
    const goal = Math.max(1, Number(settings.giftCounter?.goal) || 50);
    return { count: giftCounter.count, goal };
  }
  function broadcastGiftCounter() { broadcast('giftCounter', serializeGiftCounter()); }
  function setGiftCounter(n) {
    giftCounter.count = Math.max(0, Math.floor(Number(n) || 0));
    broadcastGiftCounter();
    saveSessionOverlays();
  }
  function resetGiftCounter() { giftCounter.count = 0; broadcastGiftCounter(); saveSessionOverlays(); }
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
    saveSessionOverlays();
  }


  function getGiftGoalsPeriod() {
    const p = settings.giftGoals?.resetPeriod;
    return p === 'week' || p === 'month' ? p : 'live';
  }
  function clearGiftGoalsState() {
    giftGoalsState.counts = Object.create(null);
    giftGoalsState.completers = Object.create(null);
    giftGoalsState.donors = Object.create(null);
  }
  function loadGiftGoalsPersist() {
    const period = getGiftGoalsPeriod();
    lastGiftGoalsPeriod = period;
    if (period === 'live') {
      giftGoalsMeta.period = 'live';
      giftGoalsMeta.start = 0;
      giftGoalsMeta.end = 0;
      return;
    }
    const [start, end] = period === 'month' ? currentMonthRange() : currentWeekRange();
    const raw = readJsonSafe(GIFTGOALS_FILE).data;
    if (raw && raw.period === period && raw.start === start) {
      giftGoalsMeta.period = period;
      giftGoalsMeta.start = start;
      giftGoalsMeta.end = end;
      clearGiftGoalsState();
      const rc = raw.counts || {};
      for (const [id, v] of Object.entries(rc)) {
        giftGoalsState.counts[id] = Math.max(0, Number(v?.count != null ? v.count : v) || 0);
        if (v?.completer) giftGoalsState.completers[id] = v.completer;
      }
      if (raw.completers && typeof raw.completers === 'object') {
        for (const [id, c] of Object.entries(raw.completers)) {
          if (c) giftGoalsState.completers[id] = c;
        }
      }
      if (raw.donors && typeof raw.donors === 'object') {
        for (const [id, map] of Object.entries(raw.donors)) {
          if (!map || typeof map !== 'object') continue;
          giftGoalsState.donors[id] = Object.create(null);
          for (const [uid, d] of Object.entries(map)) {
            giftGoalsState.donors[id][uid] = {
              uniqueId: uid,
              nickname: d?.nickname || uid,
              avatar: d?.avatar || '',
              count: Math.max(0, Number(d?.count) || 0),
            };
          }
        }
      }
      return;
    }
    giftGoalsMeta.period = period;
    giftGoalsMeta.start = start;
    giftGoalsMeta.end = end;
    clearGiftGoalsState();
  }
  function saveGiftGoalsPersist() {
    if (getGiftGoalsPeriod() === 'live') return;
    clearTimeout(giftGoalsSaveTimer);
    giftGoalsSaveTimer = setTimeout(() => {
      writeJsonAtomic(GIFTGOALS_FILE, {
        period: giftGoalsMeta.period,
        start: giftGoalsMeta.start,
        end: giftGoalsMeta.end,
        counts: giftGoalsState.counts,
        completers: giftGoalsState.completers,
        donors: giftGoalsState.donors,
      });
    }, 400);
  }
  function ensureGiftGoalsPeriod() {
    const period = getGiftGoalsPeriod();
    if (period === 'live') return;
    const [start, end] = period === 'month' ? currentMonthRange() : currentWeekRange();
    if (period !== giftGoalsMeta.period || start !== giftGoalsMeta.start) {
      giftGoalsMeta.period = period;
      giftGoalsMeta.start = start;
      giftGoalsMeta.end = end;
      clearGiftGoalsState();
      saveGiftGoalsPersist();
      broadcastGiftGoals();
    }
  }
  function onGiftGoalsPeriodChange() {
    const period = getGiftGoalsPeriod();
    if (period === lastGiftGoalsPeriod) return;
    lastGiftGoalsPeriod = period;
    clearGiftGoalsState();
    loadGiftGoalsPersist();
    broadcast('giftGoalsReset', {});
    broadcastGiftGoals();
  }
  function topDonorForGiftGoal(itemId) {
    const map = giftGoalsState.donors[itemId];
    if (!map) return null;
    let best = null;
    for (const d of Object.values(map)) {
      if (!d) continue;
      if (!best || Number(d.count) > Number(best.count)) best = d;
    }
    if (!best) return null;
    return {
      nickname: best.nickname || best.uniqueId || 'Usuario',
      avatar: best.avatar || '',
      uniqueId: best.uniqueId || '',
      count: Math.max(0, Number(best.count) || 0),
    };
  }
  function serializeGiftGoals(bumpId) {
    const counts = {};
    const completers = {};
    for (const [id, n] of Object.entries(giftGoalsState.counts)) {
      const top = giftGoalsState.completers[id] || topDonorForGiftGoal(id);
      counts[id] = { count: Math.max(0, Number(n) || 0), completer: top || null };
      if (top) completers[id] = top;
    }
    for (const [id, c] of Object.entries(giftGoalsState.completers)) {
      completers[id] = c;
      if (!counts[id]) counts[id] = { count: 0, completer: c };
    }
    return { counts, completers, bumpId: bumpId || '' };
  }
  function broadcastGiftGoals(bumpId) {
    broadcast('giftGoals', serializeGiftGoals(bumpId));
  }
  function resetGiftGoals() {
    clearGiftGoalsState();
    if (getGiftGoalsPeriod() !== 'live') saveGiftGoalsPersist();
    broadcast('giftGoalsReset', {});
    broadcastGiftGoals();
    if (getGiftGoalsPeriod() === 'live') saveSessionOverlays();
  }
  function resetGiftGoalsSession() {
    if (getGiftGoalsPeriod() !== 'live') return;
    clearGiftGoalsState();
    broadcast('giftGoalsReset', {});
    broadcastGiftGoals();
  }
  function countGiftForGiftGoals(user, giftId, giftName, repeatCount) {
    const items = Array.isArray(settings.giftGoals?.items) ? settings.giftGoals.items : [];
    if (!items.length) return;
    if (getGiftGoalsPeriod() !== 'live') ensureGiftGoalsPeriod();
    const gid = String(giftId || '').trim();
    const gname = String(giftName || '').trim().toLowerCase();
    const add = Math.max(1, Number(repeatCount) || 1);
    const uid = String(user?.uniqueId || user?.nickname || '').trim() || 'anon';
    let bumped = '';
    for (const it of items) {
      if (!it || !it.id) continue;
      const wantId = String(it.giftId || '').trim();
      const wantName = String(it.giftName || '').trim().toLowerCase();
      if (wantId) {
        if (gid !== wantId) continue;
      } else if (wantName) {
        if (gname !== wantName) continue;
      } else continue;
      const goal = Math.max(1, Number(it.goal) || 10);
      if (!giftGoalsState.donors[it.id]) giftGoalsState.donors[it.id] = Object.create(null);
      const prevDonor = giftGoalsState.donors[it.id][uid] || { count: 0 };
      giftGoalsState.donors[it.id][uid] = {
        uniqueId: uid,
        nickname: user?.nickname || uid,
        avatar: user?.photo || prevDonor.avatar || '',
        count: Math.max(0, Number(prevDonor.count) || 0) + add,
      };
      const prev = Math.max(0, Number(giftGoalsState.counts[it.id]) || 0);
      const next = Math.min(goal, prev + add);
      giftGoalsState.counts[it.id] = next;
      // Top donador de ese regalo (quien más envió) ilumina el cuadro al completar
      if (next >= goal) {
        giftGoalsState.completers[it.id] = topDonorForGiftGoal(it.id);
      }
      bumped = it.id;
    }
    if (bumped) {
      broadcastGiftGoals(bumped);
      if (getGiftGoalsPeriod() === 'live') saveSessionOverlays();
      else saveGiftGoalsPersist();
    }
  }
  // Contadores de victorias: si un regalo está asignado a una acción (+1/-1/sumar/restar),
  // ajusta automáticamente el contador cuando llega ese regalo en el live.
  function applyWinsGiftHooks(giftId, repeatCount) {
    const reps = Math.max(1, Number(repeatCount) || 1);
    const wantId = String(giftId || '').trim();
    if (!wantId) return;
    const ACTS = [
      { id: 'inc1', sign: 1, fixed: 1 },
      { id: 'dec1', sign: -1, fixed: 1 },
      { id: 'incN', sign: 1, fixed: null },
      { id: 'decN', sign: -1, fixed: null },
    ];
    let changed = false;
    for (const key of ['winsCounter', 'winsCounterGamer', 'winsCounterMinecraft', 'winsCounterMario']) {
      const c = settings[key];
      const hk = c && c.hotkeys;
      if (!c || !hk) continue;
      // wins libre: los regalos pueden subir por encima del máximo y bajar de 0.
      let wins = parseInt(c.wins, 10) || 0;
      let touched = false;
      for (const a of ACTS) {
        const d = hk[a.id];
        if (!d || !d.giftId || String(d.giftId).trim() !== wantId) continue;
        const amount = a.fixed != null ? a.fixed : Math.max(1, parseInt(d.amount, 10) || 1);
        wins += a.sign * amount * reps;
        touched = true;
      }
      if (touched) {
        c.wins = Math.max(-999999, Math.min(999999, wins));
        changed = true;
      }
    }
    if (changed) { saveSettings(); broadcast('settings', settings); }
  }
  // Capacidades del plan (límites + features). El panel las usa para ocultar
  // pestañas/overlays y bloquear el añadir más alertas de las permitidas.
  function currentCaps() {
    try { return getCaps ? getCaps() : null; } catch { return null; }
  }
  function broadcastCaps(caps) {
    broadcast('caps', caps || currentCaps() || {});
    // El límite de perfiles depende del plan: reenvía el estado para refrescar bloqueos.
    broadcast('profiles', profilesInfo());
    // Si el plan se degradó y el perfil activo quedó bloqueado, vuelve al Perfil 1.
    if (profiles.active >= profileLimit() && profiles.active !== 0) switchProfile(0);
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
    settings.actions = cap(settings.actions, lim.actions);
  }
  function screenSize(n) {
    return settings.screens?.[(Number(n) || 1) - 1]?.size ?? 100;
  }
  function screenSizeForCfg(cfg, n) {
    return cfg?.screens?.[(Number(n) || 1) - 1]?.size ?? 100;
  }
  function clampMediaScreen(n) {
    return Math.max(1, Math.min(10, Number(n) || 1));
  }
  /**
   * Envía `media` a las Browser Sources de esa pantalla.
   * Si hay video.html conectado: SOLO a esas pantallas (no al overlay alertas+videos),
   * para no duplicar el clip. Sin video.html: fallback a todos los clientes (overlay).
   * En relay nube→PC: no spamear media al overlay de Render; el video va por playMedia.
   */
  function broadcastMedia(payload) {
    const scr = clampMediaScreen(payload?.screen);
    const body = { ...payload, screen: scr };
    // En relay, /uploads locales deben apuntar a la PC (igual que emitSound):
    // OBS corre en la PC, así el overlay de Render también puede cargar el video.
    if (body.url) body.url = rewriteRelayMediaUrl(body.url);
    const msg = JSON.stringify({ type: 'media', payload: body });
    if (videoScreens.size > 0) {
      for (const [client, screenNum] of videoScreens) {
        if (client.readyState === 1 && clampMediaScreen(screenNum) === scr) client.send(msg);
      }
      return body;
    }
    // Sin pantallas video.html: el overlay "Alertas + Videos" hace de fallback,
    // excepto si el .exe en relay ya va a reproducir en la PC (playMedia).
    if (IS_CLOUD_ROOM && hasLocalRelayClient()) return body;
    for (const client of clients) {
      if (client.readyState === 1) client.send(msg);
    }
    return body;
  }
  function emitProfileMedia(cfg, v, scr, isGeneral) {
    emitMedia({
      id: v.id,
      name: v.name,
      url: v.url,
      screen: scr,
      volume: v.volume ?? 100,
      size: screenSizeForCfg(cfg, scr),
      general: !!isGeneral,
      playQueue: cfg.playback?.playQueue !== false,
    });
  }
  function emitMedia(payload) {
    const body = broadcastMedia(payload);
    // Si el .exe está en relay, también a local (por si la fuente apunta al host de la PC).
    if (IS_CLOUD_ROOM && hasLocalRelayClient()) {
      broadcastToLocal('playMedia', body);
    }
  }
  function emitStopMedia(scr) {
    const screen = Number(scr) || 1;
    // Siempre avisar a las fuentes de la room (p. ej. video.html en Render).
    broadcast('stopMedia', { screen });
    // En relay, también a la PC (fuentes apuntando a localhost).
    if (IS_CLOUD_ROOM && hasLocalRelayClient()) {
      broadcastToLocal('stopMediaLocal', { screen });
    }
  }
  function emitPanicMedia() {
    for (let scr = 1; scr <= 10; scr++) broadcast('stopMedia', { screen: scr });
    if (IS_CLOUD_ROOM && hasLocalRelayClient()) {
      broadcastToLocal('panicLocal', {});
    }
  }
  function rewriteRelayMediaUrl(url) {
    if (!url || typeof url !== 'string') return url;
    if (!IS_CLOUD_ROOM || !relayLocalOrigin) return url;
    if (url.startsWith('/') && /^\/(uploads|audios)\//.test(url)) {
      return relayLocalOrigin.replace(/\/+$/, '') + url;
    }
    return url;
  }
  function emitSound(payload) {
    const p = { ...payload };
    if (p.sound) p.sound = rewriteRelayMediaUrl(p.sound);
    if (p.image) p.image = rewriteRelayMediaUrl(p.image);
    broadcast('sound', p);
  }
  playGameActionSoundImpl = (a, times = 1) => {
    if (!a || !a.sound || a.audioOn === false) return;
    // Minecraft family: runMcAction → playMcActionSound.
    if (a.cmd || (Array.isArray(a.cmds) && a.cmds.length)) return;
    const n = Math.max(1, Math.min(Number(times) || 1, 50));
    const vol = a.soundVolume != null ? a.soundVolume : 100;
    for (let i = 0; i < n; i++) {
      emitSound({
        id: a.uid || a.id || '',
        name: a.name || a.label || a.soundName || 'Acción',
        sound: a.sound,
        image: a.image || a.giftImage || '',
        volume: vol,
      });
    }
  };
  function emitKeyAction(payload) {
    if (IS_CLOUD_ROOM && hasLocalRelayClient()) {
      broadcastToLocal('keyAction', payload);
      return;
    }
    broadcast('keyAction', payload);
  }

  /* ----------------------------- Temporizador ----------------------------- */
  // El temporizador es AUTORITATIVO en el servidor: aquí corre la cuenta atrás y
  // se difunde cada segundo a todos los overlays/paneles de la room. Así se mantiene
  // sincronizado aunque un overlay se reconecte o el navegador esté en segundo plano.
  // El tiempo restante se persiste en settings.timer.saved* para sobrevivir reinicios
  // de la app / redeploys en Render.
  function persistTimerState() {
    if (!settings.timer || typeof settings.timer !== 'object') settings.timer = {};
    settings.timer.savedRemaining = Math.max(0, Math.round(timer.remaining));
    settings.timer.savedRunning = !!timer.running;
    settings.timer.savedAt = Date.now();
    saveSettings();
  }
  function restoreTimerFromSettings() {
    const t = settings.timer || {};
    const raw = t.savedRemaining;
    if (raw == null || !Number.isFinite(Number(raw))) {
      timer.remaining = Math.max(0, Math.floor(Number(t.defaultInitialSec) || 0));
      timer.running = false;
      return;
    }
    let rem = Math.max(0, Math.floor(Number(raw)));
    const wasRunning = !!t.savedRunning;
    const savedAt = Number(t.savedAt) || 0;
    if (wasRunning && savedAt > 0) {
      const elapsed = Math.floor((Date.now() - savedAt) / 1000);
      if (elapsed > 0) rem = Math.max(0, rem - elapsed);
    }
    timer.remaining = rem;
    if (t.maxEnabled && Number(t.maxCapSec) > 0) {
      timer.remaining = Math.min(timer.remaining, Number(t.maxCapSec));
    }
    timer.running = false;
    if (wasRunning && timer.remaining > 0) {
      // Reanuda tras cargar la room (mismo tick de evento).
      setTimeout(() => { try { startTimer(); } catch {} }, 0);
    }
  }
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
  function broadcastTimer() {
    broadcast('timer', serializeTimer());
    persistTimerState();
  }
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

  /* ------------------------ Tiempo en live (overlay) ------------------------ */
  const liveUptime = { accumulatedMs: 0, tickStart: null, ticking: false, interval: null };
  function liveTimerOnEndMode() {
    return settings.liveTimer?.onLiveEnd === 'reset' ? 'reset' : 'pause';
  }
  function getLiveUptimeMs() {
    let ms = liveUptime.accumulatedMs;
    if (liveUptime.tickStart) ms += Date.now() - liveUptime.tickStart;
    return Math.max(0, Math.floor(ms));
  }
  function serializeLiveUptime() {
    return { ms: getLiveUptimeMs(), ticking: !!liveUptime.ticking, connected: !!state.connected };
  }
  function broadcastLiveUptime() { broadcast('liveUptime', serializeLiveUptime()); }
  function stopLiveUptimeInterval() {
    if (liveUptime.interval) { clearInterval(liveUptime.interval); liveUptime.interval = null; }
  }
  function startLiveUptimeInterval() {
    stopLiveUptimeInterval();
    if (!liveUptime.ticking) return;
    liveUptime.interval = setInterval(broadcastLiveUptime, 1000);
  }
  function resetLiveUptimeHard() {
    liveUptime.accumulatedMs = 0;
    liveUptime.tickStart = liveUptime.ticking ? Date.now() : null;
    broadcastLiveUptime();
  }
  function resetLiveUptimeSession() {
    liveUptime.accumulatedMs = 0;
    liveUptime.tickStart = null;
    liveUptime.ticking = false;
    stopLiveUptimeInterval();
    broadcastLiveUptime();
  }
  function resetLiveUptime() {
    resetLiveUptimeHard();
    if (!liveUptime.ticking) broadcastLiveUptime();
  }
  function beginLiveUptimeTick() {
    if (liveTimerOnEndMode() === 'reset') liveUptime.accumulatedMs = 0;
    liveUptime.tickStart = Date.now();
    liveUptime.ticking = true;
    broadcastLiveUptime();
    startLiveUptimeInterval();
  }
  function endLiveUptimeTick() {
    if (liveUptime.tickStart) {
      liveUptime.accumulatedMs += Date.now() - liveUptime.tickStart;
      liveUptime.tickStart = null;
    }
    liveUptime.ticking = false;
    stopLiveUptimeInterval();
    if (liveTimerOnEndMode() === 'reset') liveUptime.accumulatedMs = 0;
    broadcastLiveUptime();
  }
  function syncLiveUptimeOnConnect() {
    if (state.connected) beginLiveUptimeTick();
  }
  function syncLiveUptimeOnDisconnect() {
    if (liveUptime.ticking || liveUptime.accumulatedMs > 0) endLiveUptimeTick();
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
  // (top donador semanal). Se usa al pulsar Conectar (manual), al detectar un live
  // NUEVO vía auto-conexión, y al finalizar el live (stream end).
  // NO se reinicia en auto-reconexión al mismo live ni al reconectar overlays WS.
  function canRestoreSessionOverlays(saved) {
    if (!saved) return false;
    if (saved.roomId && liveSession.roomId) {
      return String(saved.roomId) === String(liveSession.roomId);
    }
    if (saved.username && liveSession.username && liveSession.active) {
      return liveUserMatch(saved.username, liveSession.username);
    }
    return false;
  }
  function clearSessionOverlayState() {
    giftCounter.count = 0;
    if (getGiftGoalsPeriod() === 'live') clearGiftGoalsState();
    top1fireSession.clear();
    habibiTopSession.clear();
    if (getHabibiTopPeriod() === 'live') habibiTopSnapshot = null;
    fanCoinAcc.clear();
    fanLikeAcc.clear();
    gameLikeAcc.clear();
    sessionOv.top1 = {};
    if (getGiftOverlayPeriod('topGift') === 'live') sessionOv.topGift = null;
    if (getGiftOverlayPeriod('lastGift') === 'live') sessionOv.lastGift = null;
    if (getGiftOverlayPeriod('topStreak') === 'live') sessionOv.topStreak = null;
    sessionOv.batallaGifts = {};
    sessionOv.batallaLikes = {};
    sessionOv.hype = { score: 0, target: 100, coinTotal: 0 };
  }
  function loadSessionOverlays() {
    const raw = readJsonSafe(SESSION_OVERLAYS_FILE).data;
    if (!canRestoreSessionOverlays(raw)) return;
    giftCounter.count = Math.max(0, Number(raw.giftCounter?.count) || 0);
    if (getGiftGoalsPeriod() === 'live') {
      clearGiftGoalsState();
      if (raw.giftGoals && typeof raw.giftGoals === 'object') {
        const rc = raw.giftGoals.counts || {};
        for (const [id, v] of Object.entries(rc)) {
          giftGoalsState.counts[id] = Math.max(0, Number(v?.count != null ? v.count : v) || 0);
          if (v?.completer) giftGoalsState.completers[id] = v.completer;
        }
        if (raw.giftGoals.completers && typeof raw.giftGoals.completers === 'object') {
          for (const [id, c] of Object.entries(raw.giftGoals.completers)) {
            if (c) giftGoalsState.completers[id] = c;
          }
        }
        if (raw.giftGoals.donors && typeof raw.giftGoals.donors === 'object') {
          for (const [id, map] of Object.entries(raw.giftGoals.donors)) {
            if (!map || typeof map !== 'object') continue;
            giftGoalsState.donors[id] = Object.create(null);
            for (const [uid, d] of Object.entries(map)) {
              if (!d) continue;
              giftGoalsState.donors[id][uid] = {
                uniqueId: uid,
                nickname: d.nickname || uid,
                avatar: d.avatar || '',
                count: Math.max(0, Number(d.count) || 0),
              };
            }
          }
        }
      }
    }
    if (getTop1FirePeriod() === 'live' && Array.isArray(raw.top1fireLive)) {
      top1fireSession.clear();
      for (const u of raw.top1fireLive) {
        if (u?.uniqueId) top1fireSession.set(u.uniqueId, u);
      }
    }
    if (getHabibiTopPeriod() === 'live' && Array.isArray(raw.habibiTopLive)) {
      habibiTopSession.clear();
      if (raw.habibiTopSnapshot && typeof raw.habibiTopSnapshot === 'object') {
        habibiTopSnapshot = raw.habibiTopSnapshot;
      }
      for (const u of raw.habibiTopLive) {
        if (u?.uniqueId) habibiTopSession.set(u.uniqueId, restoreHabibiDonor(u));
      }
    }
    fanCoinAcc.clear();
    fanLikeAcc.clear();
    gameLikeAcc.clear();
    for (const row of raw.fanCoinAcc || []) {
      if (Array.isArray(row) && row[0]) fanCoinAcc.set(row[0], Number(row[1]) || 0);
    }
    for (const row of raw.fanLikeAcc || []) {
      if (Array.isArray(row) && row[0]) fanLikeAcc.set(row[0], Number(row[1]) || 0);
    }
    sessionOv.top1 = (raw.top1 && typeof raw.top1 === 'object') ? raw.top1 : {};
    sessionOv.topGift = raw.topGift || null;
    sessionOv.lastGift = raw.lastGift || null;
    sessionOv.topStreak = raw.topStreak || null;
    sessionOv.batallaGifts = (raw.batallaGifts && typeof raw.batallaGifts === 'object') ? raw.batallaGifts : {};
    sessionOv.batallaLikes = (raw.batallaLikes && typeof raw.batallaLikes === 'object') ? raw.batallaLikes : {};
    sessionOv.hype = raw.hype || { score: 0, target: 100, coinTotal: 0 };
  }
  function serializeSessionOverlaysPayload() {
    return {
      top1: sessionOv.top1,
      topGift: getActiveGiftOverlayRecord('topGift'),
      lastGift: getActiveGiftOverlayRecord('lastGift'),
      topStreak: getActiveGiftOverlayRecord('topStreak'),
      batallaGifts: sessionOv.batallaGifts,
      batallaLikes: sessionOv.batallaLikes,
      hype: sessionOv.hype,
    };
  }
  function saveSessionOverlaysNow() {
    clearTimeout(sessionOverlaysSaveTimer);
    sessionOverlaysSaveTimer = null;
    const data = {
      roomId: liveSession.roomId || null,
      username: liveSession.username || null,
      giftCounter: { count: giftCounter.count },
      giftGoals: getGiftGoalsPeriod() === 'live' ? {
        ...serializeGiftGoals(),
        donors: giftGoalsState.donors,
      } : null,
      top1fireLive: getTop1FirePeriod() === 'live' ? [...top1fireSession.values()] : [],
      habibiTopLive: getHabibiTopPeriod() === 'live' ? [...habibiTopSession.values()] : [],
      habibiTopSnapshot: habibiTopSnapshot || null,
      fanCoinAcc: [...fanCoinAcc.entries()],
      fanLikeAcc: [...fanLikeAcc.entries()],
      top1: sessionOv.top1,
      topGift: sessionOv.topGift,
      lastGift: sessionOv.lastGift,
      topStreak: sessionOv.topStreak,
      batallaGifts: sessionOv.batallaGifts,
      batallaLikes: sessionOv.batallaLikes,
      hype: sessionOv.hype,
    };
    writeJsonAtomic(SESSION_OVERLAYS_FILE, data);
  }
  function saveSessionOverlays() {
    clearTimeout(sessionOverlaysSaveTimer);
    sessionOverlaysSaveTimer = setTimeout(saveSessionOverlaysNow, 400);
  }
  function trackSessionHypeEvent(kind, amount) {
    const c = settings.hypeBar || {};
    const goalKind = String(c.goalKind || 'hype').toLowerCase();
    if (goalKind === 'viewers') return;
    const onReach = String(c.whenReach || 'increase');
    const allow = goalKind === 'hype'
      ? { like: true, follow: true, gift: true, share: true, member: false }
      : {
        like: goalKind === 'likes',
        follow: goalKind === 'follow',
        gift: goalKind === 'gift',
        share: goalKind === 'share',
        member: goalKind === 'member',
      };
    if (kind === 'like' && !allow.like) return;
    if (kind === 'follow' && !allow.follow) return;
    if (kind === 'share' && !allow.share) return;
    if (kind === 'member' && !allow.member) return;
    if (kind === 'gift' && !allow.gift && goalKind !== 'hype') return;
    const delta = Math.max(0, Number(amount) || 0);
    if (delta <= 0) return;
    let target = Math.max(1, parseInt(c.meta, 10) || 100);
    let { score, coinTotal } = sessionOv.hype;
    const giftMult = Math.max(1, parseInt(c.pointsGift, 10) || 1);
    if (kind === 'gift' && (goalKind === 'gift' || goalKind === 'regalos')) {
      coinTotal += delta;
      score = coinTotal;
    } else {
      score += kind === 'gift' ? delta * giftMult : delta;
    }
    if (onReach === 'increase') { while (score >= target) target += 50; }
    else if (onReach === 'reset' && score >= target) score = 0;
    else if (onReach === 'keep') {
      score = Math.min(score, target);
      if (goalKind === 'gift' || goalKind === 'regalos') coinTotal = score;
    }
    sessionOv.hype = { score, target, coinTotal };
    saveSessionOverlays();
  }
  function getGiftOverlayPeriod(key) {
    const p = settings?.[key]?.resetPeriod;
    return p === 'week' || p === 'month' ? p : 'live';
  }
  function loadGiftOverlayPeriods() {
    const raw = readJsonSafe(GIFT_OVERLAY_PERIOD_FILE).data || {};
    for (const key of GIFT_OVERLAY_KEYS) {
      const period = getGiftOverlayPeriod(key);
      lastGiftOverlayPeriods[key] = period;
      if (period === 'live') {
        giftOverlayPeriod[key] = { period: 'live', start: 0, end: 0, record: null };
        continue;
      }
      const [start, end] = period === 'month' ? currentMonthRange() : currentWeekRange();
      const bag = raw[key];
      if (bag && bag.period === period && bag.start === start) {
        giftOverlayPeriod[key] = {
          period,
          start,
          end,
          record: bag.record && typeof bag.record === 'object' ? bag.record : null,
        };
      } else {
        giftOverlayPeriod[key] = { period, start, end, record: null };
      }
    }
  }
  function saveGiftOverlayPeriodsNow() {
    clearTimeout(giftOverlayPeriodSaveTimer);
    giftOverlayPeriodSaveTimer = null;
    const data = {};
    for (const key of GIFT_OVERLAY_KEYS) {
      if (getGiftOverlayPeriod(key) === 'live') continue;
      const bag = giftOverlayPeriod[key] || {};
      data[key] = {
        period: bag.period,
        start: bag.start,
        end: bag.end,
        record: bag.record || null,
      };
    }
    writeJsonAtomic(GIFT_OVERLAY_PERIOD_FILE, data);
  }
  function saveGiftOverlayPeriods() {
    clearTimeout(giftOverlayPeriodSaveTimer);
    giftOverlayPeriodSaveTimer = setTimeout(saveGiftOverlayPeriodsNow, 400);
  }
  function ensureGiftOverlayPeriod(key) {
    const period = getGiftOverlayPeriod(key);
    if (period === 'live') return;
    const [start, end] = period === 'month' ? currentMonthRange() : currentWeekRange();
    const bag = giftOverlayPeriod[key] || (giftOverlayPeriod[key] = { period: 'live', start: 0, end: 0, record: null });
    if (bag.period !== period || bag.start !== start) {
      bag.period = period;
      bag.start = start;
      bag.end = end;
      bag.record = null;
      saveGiftOverlayPeriods();
    }
  }
  function getActiveGiftOverlayRecord(key) {
    if (getGiftOverlayPeriod(key) === 'live') return sessionOv[key] || null;
    ensureGiftOverlayPeriod(key);
    return giftOverlayPeriod[key]?.record || null;
  }
  function setActiveGiftOverlayRecord(key, record) {
    if (getGiftOverlayPeriod(key) === 'live') {
      sessionOv[key] = record;
      return;
    }
    ensureGiftOverlayPeriod(key);
    giftOverlayPeriod[key].record = record;
    saveGiftOverlayPeriods();
  }
  function clearActiveGiftOverlayRecord(key) {
    if (getGiftOverlayPeriod(key) === 'live') {
      sessionOv[key] = null;
      saveSessionOverlays();
      return;
    }
    ensureGiftOverlayPeriod(key);
    giftOverlayPeriod[key].record = null;
    saveGiftOverlayPeriods();
  }
  function onGiftOverlayPeriodChange(key) {
    const period = getGiftOverlayPeriod(key);
    if (period === lastGiftOverlayPeriods[key]) return;
    lastGiftOverlayPeriods[key] = period;
    if (period === 'live') {
      giftOverlayPeriod[key] = { period: 'live', start: 0, end: 0, record: null };
    } else {
      const [start, end] = period === 'month' ? currentMonthRange() : currentWeekRange();
      const raw = readJsonSafe(GIFT_OVERLAY_PERIOD_FILE).data || {};
      const bag = raw[key];
      if (bag && bag.period === period && bag.start === start) {
        giftOverlayPeriod[key] = {
          period,
          start,
          end,
          record: bag.record && typeof bag.record === 'object' ? bag.record : null,
        };
      } else {
        giftOverlayPeriod[key] = { period, start, end, record: null };
      }
      saveGiftOverlayPeriods();
    }
    broadcast('sessionOverlays', serializeSessionOverlaysPayload());
  }
  function trackSessionGift(user, giftName, repeatCount, diamondsEach, image) {
    const total = diamondsEach * repeatCount;
    if (total <= 0) return;
    const uid = user?.uniqueId || user?.nickname;
    if (uid) {
      if (!sessionOv.top1[uid]) {
        sessionOv.top1[uid] = { name: user.nickname || uid, coins: 0, pic: user.photo || '' };
      }
      sessionOv.top1[uid].coins += total;
      if (user.photo) sessionOv.top1[uid].pic = user.photo;
      if (!sessionOv.batallaGifts[uid]) {
        sessionOv.batallaGifts[uid] = { name: user.nickname || uid, monedas: 0, pic: user.photo || '' };
      }
      sessionOv.batallaGifts[uid].monedas += total;
      if (user.photo) sessionOv.batallaGifts[uid].pic = user.photo;
    }
    const nick = user.nickname || uid || 'Usuario';
    if (diamondsEach > 0) {
      const curTop = getActiveGiftOverlayRecord('topGift');
      if (!curTop || diamondsEach > curTop.coins) {
        setActiveGiftOverlayRecord('topGift', {
          coins: diamondsEach,
          nickname: nick,
          image: image || '',
          uniqueId: uid || '',
        });
      }
    }
    if (diamondsEach > 0 || image) {
      setActiveGiftOverlayRecord('lastGift', {
        coins: Math.max(0, Number(diamondsEach) || 0),
        nickname: nick,
        image: image || '',
        giftName: giftName || '',
        uniqueId: uid || '',
      });
    }
    const rc = Math.max(0, Number(repeatCount) || 0);
    if (rc > 0) {
      const curStreak = getActiveGiftOverlayRecord('topStreak');
      if (!curStreak || rc > curStreak.streak) {
        setActiveGiftOverlayRecord('topStreak', {
          streak: rc,
          nickname: nick,
          giftName: giftName || '',
          image: image || '',
          uniqueId: uid || '',
        });
      }
    }
    trackSessionHypeEvent('gift', total);
    saveSessionOverlays();
  }
  function trackSessionLike(user, count) {
    const n = Math.max(0, Number(count) || 0);
    if (n <= 0) return;
    const uid = user?.uniqueId || user?.nickname;
    if (uid) {
      if (!sessionOv.batallaLikes[uid]) {
        sessionOv.batallaLikes[uid] = { name: user.nickname || uid, likes: 0, pic: user.photo || '' };
      }
      sessionOv.batallaLikes[uid].likes += n;
      if (user.photo) sessionOv.batallaLikes[uid].pic = user.photo;
    }
    const c = settings.hypeBar || {};
    const pts = Math.max(1, parseInt(c.pointsLike, 10) || 1);
    trackSessionHypeEvent('like', n * pts);
    saveSessionOverlays();
  }
  function resetSessionOverlays() {
    clearSessionOverlayState();
    try { fs.unlinkSync(SESSION_OVERLAYS_FILE); } catch {}
    // Botes / contadores acumulados de la sesión
    broadcast('jarronReset', {});
    broadcast('vaquitaReset', {});
    broadcast('marranitoReset', {});
    broadcast('corazonLavaReset', {});
    broadcast('perritoReset', {});
    broadcast('pelotasReset', {});
    // Versus y secuencias
    broadcast('giftVsReset', {});
    broadcast('flowMeterReset', {});
    broadcast('giftSeqReset', {});
    broadcast('pkBattleReset', {});
    resetPkBattleAll();
    // Mejor regalo / último regalo / mejor racha (solo si periodo = live)
    if (getGiftOverlayPeriod('topGift') === 'live') broadcast('topGiftReset', {});
    if (getGiftOverlayPeriod('lastGift') === 'live') broadcast('lastGiftReset', {});
    if (getGiftOverlayPeriod('topStreak') === 'live') broadcast('topStreakReset', {});
    // Top 1 donador (MVP de la sesión)
    broadcast('top1Reset', {});
    resetTop1FireSession();
    resetHabibiTopSession();
    // Contador de meta (gift counter) vuelve a 0
    resetGiftCounter();
    // Metas de regalos: solo sesión live; semana/mes se conservan
    if (getGiftGoalsPeriod() === 'live') {
      broadcast('giftGoalsReset', {});
      broadcastGiftGoals();
    } else {
      broadcastGiftGoals();
    }
    // Batallas de ranking (regalos / likes)
    broadcast('batallaGiftsReset', {});
    broadcast('batallaLikesReset', {});
    broadcast('winsReset', {});
    broadcast('winsGamerReset', {});
    broadcast('winsMinecraftReset', {});
    broadcast('winsMarioReset', {});
    // Barra de meta (hype)
    broadcast('hypeReset', {});
    // Coin match (partido cronometrado)
    broadcast('coinMatchControl', { action: 'reset' });
    // Rankings de likes / diamantes (bandas y listas) de la sesión
    for (const rank of RANK_IDS) resetRankSession(rank);
    for (const rankId of RANK_IDS) {
      if (getRankPeriod(rankId) !== 'live') broadcastRankState(rankId);
    }
    if (getTop1FirePeriod() !== 'live') broadcastTop1Fire();
    if (getHabibiTopPeriod() !== 'live') broadcastHabibiTop();
    // Animaciones momentáneas (corta cualquier alerta en curso)
    broadcast('alertaGiftReset', {});
    broadcast('alertaLikesReset', {});
    broadcast('alertaFollowReset', {});
    broadcast('fuegosReset', {});
    broadcast('streamJoinReset', {});
    // Temporizador: NO se reinicia aquí (subathon). Solo con el botón Reiniciar
    // o la acción al llegar a 00:00. El tiempo se persiste entre reinicios de app/Render.
    // OJO: NO se reinicia el top donador semanal (weeklyTop / topDonor): es acumulado semanal.
  }

  /* ------------------------------- Batalla VS (Diseño Overlay) ------------------------------- */
  function serializePkBattle() {
    return {
      live: !!pkBattle.live,
      frozen: !!pkBattle.frozen,
      host: { ...pkBattle.host },
      rival: { ...pkBattle.rival },
      pointsHost: Math.max(0, Math.round(pkBattle.pointsHost) || 0),
      pointsRival: Math.max(0, Math.round(pkBattle.pointsRival) || 0),
      winsHost: Math.max(0, Math.round(pkBattle.winsHost) || 0),
      winsRival: Math.max(0, Math.round(pkBattle.winsRival) || 0),
      rivalKey: pkBattle.rivalKey || '',
      armyTopHost: pkBattle.armyTopHost ? { ...pkBattle.armyTopHost } : null,
      armyTop3Host: Array.isArray(pkBattle.armyTop3Host) ? pkBattle.armyTop3Host.map((u) => ({ ...u })) : [],
      ending: !!(pkBattle.showEnd && !pkBattle.live),
    };
  }
  function broadcastPkBattle(immediate) {
    if (immediate) {
      if (pkBattleBroadcastTimer) { clearTimeout(pkBattleBroadcastTimer); pkBattleBroadcastTimer = null; }
      broadcast('pkBattle', serializePkBattle());
      return;
    }
    if (pkBattleBroadcastTimer) return;
    pkBattleBroadcastTimer = setTimeout(() => {
      pkBattleBroadcastTimer = null;
      broadcast('pkBattle', serializePkBattle());
    }, 120);
  }
  function pkHostIdentity() {
    const uniqueId = String(followerCounter.uniqueId || state.username || '').replace(/^@/, '');
    const userId = String(
      pkBattle.host.userId
      || followerCounter.userId
      || pkRoomOwnerUserId()
      || '',
    ).replace(/^0$/, '');
    return {
      uniqueId,
      nickname: String(followerCounter.nickname || uniqueId || 'Yo'),
      photo: String(followerCounter.photo || ''),
      userId,
    };
  }
  function pkRoomOwnerUserId() {
    try {
      const ri = connection?.roomInfo;
      const d = ri?.data || ri || {};
      const users = [
        d?.owner, d?.user, d?.anchor, d?.liveRoom?.owner,
        ri?.user, ri?.liveRoomUserInfo?.user, d?.owner_info, d?.ownerInfo,
      ].filter(Boolean);
      for (const u of users) {
        const id = u.userId ?? u.user_id ?? u.id;
        if (id != null && String(id) !== '0' && String(id) !== '') return String(id);
      }
    } catch {}
    return '';
  }
  function pkAvatarFromThumb(img) {
    if (!img) return '';
    if (typeof img === 'string') return img.trim();
    return pickImageUrl(img)
      || (Array.isArray(img.url) && img.url[0])
      || (Array.isArray(img.urlList) && img.urlList[0])
      || (Array.isArray(img.url_list) && img.url_list[0])
      || (typeof img.url === 'string' ? img.url : '')
      || '';
  }
  function pkNormalizeParticipant(raw, key) {
    if (!raw || typeof raw !== 'object') return null;
    const u = raw.user || raw.battleGroup?.user || raw;
    if (!u || typeof u !== 'object') return null;
    const uniqueId = String(
      u.displayId || u.display_id || u.uniqueId || u.unique_id || raw.uniqueId || '',
    ).replace(/^@/, '');
    const nickname = String(
      u.nickName || u.nickname || raw.nickname || uniqueId || '',
    );
    const photo = pkAvatarFromThumb(
      u.avatarThumb || u.avatar_thumb || u.profilePicture || u.profilePictureUrl
      || raw.profilePictureUrl || raw.avatarThumb,
    ) || String(getPhoto(u) || getPhoto(raw) || '');
    let userId = String(u.userId || u.user_id || raw.userId || key || '').trim();
    if (userId === '0') userId = '';
    if (!uniqueId && !nickname && !userId && !photo) return null;
    return {
      userId,
      uniqueId,
      nickname: nickname || uniqueId || 'Rival',
      photo: photo || '',
    };
  }
  function parsePkAnchors(data) {
    const out = [];
    const seen = new Set();
    const push = (raw, key) => {
      const p = pkNormalizeParticipant(raw, key);
      if (!p) return;
      const sig = [normTikTokUser(p.userId), normTikTokUser(p.uniqueId), normTikTokUser(p.nickname)]
        .filter(Boolean).join('|') || p.photo;
      if (!sig || seen.has(sig)) return;
      seen.add(sig);
      out.push(p);
    };
    const info = data?.anchorInfo || data?.anchors;
    if (info && typeof info === 'object' && !Array.isArray(info)) {
      for (const [key, val] of Object.entries(info)) push(val, key);
    }
    const users = data?.battleUsers;
    if (Array.isArray(users)) {
      for (const u of users) push(u, u?.userId || u?.uniqueId || '');
    }
    return out;
  }
  function pkIsSamePerson(a, b) {
    if (!a || !b) return false;
    const idsA = [a.userId, a.uniqueId].map(normTikTokUser).filter(Boolean);
    const idsB = [b.userId, b.uniqueId].map(normTikTokUser).filter(Boolean);
    if (idsA.some((id) => idsB.includes(id))) return true;
    const nickA = normTikTokUser(a.nickname);
    const nickB = normTikTokUser(b.nickname);
    const placeholders = new Set(['', 'rival', 'yo', 'esperando', 'anonimo', 'host']);
    if (!nickA || !nickB || placeholders.has(nickA) || placeholders.has(nickB)) return false;
    return nickA === nickB;
  }
  function pkPickRival(anchors, host) {
    const list = Array.isArray(anchors) ? anchors : [];
    return list.find((a) => !pkIsSamePerson(a, host)) || null;
  }
  function pkApplyRival(rival, { resetWinsIfChanged } = {}) {
    if (!rival) return false;
    const nextKey = normTikTokUser(rival.uniqueId) || normTikTokUser(rival.nickname) || String(rival.userId || '');
    let changed = false;
    if (resetWinsIfChanged && nextKey && pkBattle.rivalKey && nextKey !== pkBattle.rivalKey) {
      pkBattle.winsHost = 0;
      pkBattle.winsRival = 0;
      changed = true;
    }
    if (nextKey) pkBattle.rivalKey = nextKey;
    const next = {
      uniqueId: rival.uniqueId || pkBattle.rival.uniqueId || '',
      nickname: rival.nickname || pkBattle.rival.nickname || 'Rival',
      photo: rival.photo || pkBattle.rival.photo || '',
      userId: rival.userId || pkBattle.rival.userId || '',
    };
    if (
      next.uniqueId !== pkBattle.rival.uniqueId
      || next.nickname !== pkBattle.rival.nickname
      || next.photo !== pkBattle.rival.photo
      || next.userId !== pkBattle.rival.userId
    ) {
      pkBattle.rival = next;
      changed = true;
    }
    return changed;
  }
  /** Actualiza rival/host sin reiniciar puntos (ACCEPT tardío, armies, etc.). */
  function enrichPkParticipants(anchors) {
    const host = pkHostIdentity();
    if (host.uniqueId && !pkBattle.host.uniqueId) pkBattle.host.uniqueId = host.uniqueId;
    if (host.nickname && (!pkBattle.host.nickname || pkBattle.host.nickname === 'Yo')) {
      pkBattle.host.nickname = host.nickname;
    }
    if (host.photo && !pkBattle.host.photo) pkBattle.host.photo = host.photo;
    if (host.userId && !pkBattle.host.userId) pkBattle.host.userId = host.userId;
    const rival = pkPickRival(anchors, { ...pkBattle.host, ...host });
    const changed = pkApplyRival(rival, { resetWinsIfChanged: false });
    if (changed) broadcastPkBattle(true);
    return changed;
  }
  function beginPkBattleRound(opts) {
    opts = opts || {};
    const midJoin = !!opts.midJoin;
    const host = pkHostIdentity();
    // Conservar userId de host si mid-join ya lo tenía
    if (midJoin && pkBattle.host.userId && !host.userId) host.userId = pkBattle.host.userId;
    pkBattle.host = { ...host, photo: host.photo || pkBattle.host.photo || '' };
    const anchors = Array.isArray(opts.anchors) ? opts.anchors : [];
    let rival = pkPickRival(anchors, host);
    if (!rival && opts.rival) rival = opts.rival;
    if (!rival && midJoin && (pkBattle.rival.uniqueId || pkBattle.rival.userId || pkBattle.rival.nickname !== 'Rival')) {
      rival = { ...pkBattle.rival };
    }
    if (!rival) {
      rival = { uniqueId: '', nickname: 'Rival', photo: '', userId: '' };
    }
    pkApplyRival(rival, { resetWinsIfChanged: true });
    if (opts.battleId) pkBattle.battleId = String(opts.battleId);
    // Batalla nueva → puntos a 0. Entrar a media batalla → NO tocar puntos (los pone el marcador oficial).
    if (!midJoin) {
      pkBattle.pointsHost = 0;
      pkBattle.pointsRival = 0;
      pkBattle.armyTopHost = null;
      pkBattle.armyTopRival = null;
      pkBattle.armyTop3Host = [];
    }
    pkBattle.live = true;
    pkBattle.frozen = false;
    pkBattle.demo = false;
    pkBattle.showEnd = false;
    broadcastPkBattle(true);
  }
  function pkPickArmyTop(userArmy) {
    const top = pkPickArmyTopN(userArmy, 1);
    return top[0] || null;
  }
  function pkPickArmyTopN(userArmy, n = 3) {
    if (!Array.isArray(userArmy) || !userArmy.length) return [];
    const byId = new Map();
    for (const u of userArmy) {
      if (!u || typeof u !== 'object') continue;
      const points = Math.max(0, Math.round(Number(u.score ?? u.diamondScore ?? 0)) || 0);
      const uniqueId = String(u.userIdStr || u.userId || u.uniqueId || '').replace(/^@/, '');
      const key = uniqueId || `${u.nickname || ''}|${points}`;
      const prev = byId.get(key);
      if (prev && points <= prev.points) continue;
      byId.set(key, {
        uniqueId,
        nickname: String(u.nickname || u.nickName || 'Fan'),
        photo: pkAvatarFromThumb(u.avatarThumb || u.avatar_thumb || u.profilePicture) || '',
        points,
      });
    }
    return [...byId.values()]
      .sort((a, b) => b.points - a.points || String(a.nickname).localeCompare(String(b.nickname)))
      .slice(0, Math.max(1, Math.min(10, Number(n) || 3)));
  }
  function pkArmyTop3Sig(list) {
    if (!Array.isArray(list) || !list.length) return '';
    return list.map((u) => `${u.uniqueId}|${u.points}|${u.nickname}|${u.photo}`).join(';');
  }
  function pkSetArmyTop3Host(top3) {
    // TikTok a veces manda userArmy vacío o a medias → no borrar el top ya conocido.
    const incoming = Array.isArray(top3) ? top3 : [];
    if (!incoming.length && pkBattle.armyTop3Host.length) return false;

    // Fusionar por usuario y quedarse con el máximo de puntos de la ronda (no bajar).
    const byId = new Map();
    const push = (u) => {
      if (!u || typeof u !== 'object') return;
      const points = Math.max(0, Math.round(Number(u.points) || 0));
      const uniqueId = String(u.uniqueId || '').replace(/^@/, '');
      const key = uniqueId || `${u.nickname || ''}|${u.photo || ''}`;
      if (!key || key === '|') return;
      const prev = byId.get(key);
      if (prev && points < prev.points) {
        // Conservar foto/nick más recientes si vienen, pero no bajar puntos
        byId.set(key, {
          ...prev,
          nickname: u.nickname || prev.nickname,
          photo: u.photo || prev.photo,
        });
        return;
      }
      byId.set(key, {
        uniqueId,
        nickname: String(u.nickname || prev?.nickname || 'Fan'),
        photo: u.photo || prev?.photo || '',
        points: Math.max(points, prev?.points || 0),
      });
    };
    for (const u of pkBattle.armyTop3Host) push(u);
    for (const u of incoming) push(u);

    const next = [...byId.values()]
      .sort((a, b) => b.points - a.points || String(a.nickname).localeCompare(String(b.nickname)))
      .slice(0, 3);
    if (pkArmyTop3Sig(next) === pkArmyTop3Sig(pkBattle.armyTop3Host)) return false;
    pkBattle.armyTop3Host = next;
    if (next[0]) pkBattle.armyTopHost = { ...next[0] };
    return true;
  }
  function emitPkBattleMvp() {
    let winner = null;
    if (pkBattle.pointsHost > pkBattle.pointsRival) winner = 'host';
    else if (pkBattle.pointsRival > pkBattle.pointsHost) winner = 'rival';
    const scoreHost = Math.max(0, Math.round(pkBattle.pointsHost) || 0);
    const scoreRival = Math.max(0, Math.round(pkBattle.pointsRival) || 0);
    // Siempre MVP de TU equipo (host), ganes o pierdas. Nunca el del rival.
    const sideTop = pkBattle.armyTopHost;
    const streamer = pkBattle.host;
    const mvp = (sideTop && sideTop.points > 0)
      ? { ...sideTop }
      : {
          uniqueId: streamer.uniqueId || '',
          nickname: streamer.nickname || 'Tú',
          photo: streamer.photo || '',
          points: scoreHost,
        };
    broadcast('pkBattleMvp', {
      draw: !winner,
      winner: winner || null,
      mvp,
      scoreHost,
      scoreRival,
    });
  }
  function endPkBattleRound() {
    if (!pkBattle.live) {
      broadcastPkBattle(true);
      return;
    }
    // Fin de una demo de Testear: no sumar wins ni emitir MVP
    if (pkBattle.demo) {
      pkBattle.live = false;
      pkBattle.frozen = false;
      pkBattle.demo = false;
      pkBattle.showEnd = false;
      pkBattle.battleId = '';
      pkBattle.pointsHost = 0;
      pkBattle.pointsRival = 0;
      broadcastPkBattle(true);
      return;
    }
    if (pkBattle.pointsHost > pkBattle.pointsRival) pkBattle.winsHost += 1;
    else if (pkBattle.pointsRival > pkBattle.pointsHost) pkBattle.winsRival += 1;
    emitPkBattleMvp();
    const scoreHost = Math.max(0, Math.round(pkBattle.pointsHost) || 0);
    const scoreRival = Math.max(0, Math.round(pkBattle.pointsRival) || 0);
    let winner = null;
    if (scoreHost > scoreRival) winner = 'host';
    else if (scoreRival > scoreHost) winner = 'rival';
    pkBattle.live = false;
    pkBattle.frozen = false;
    pkBattle.demo = false;
    pkBattle.showEnd = true;
    // Evento explícito para overlays (Meta Felicidades / Suerte) — Live Studio no debe depender solo del flanco live.
    broadcast('pkBattleEnd', {
      ...serializePkBattle(),
      ending: true,
      winner,
      scoreHost,
      scoreRival,
    });
    // Conservamos battleId/rival/wins para la siguiente ronda vs el mismo
    broadcastPkBattle(true);
  }
  function resetPkBattleAll() {
    pkBattle.live = false;
    pkBattle.frozen = false;
    pkBattle.demo = false;
    pkBattle.battleId = '';
    pkBattle.host = { uniqueId: '', nickname: '', photo: '', userId: '' };
    pkBattle.rival = { uniqueId: '', nickname: '', photo: '', userId: '' };
    pkBattle.pointsHost = 0;
    pkBattle.pointsRival = 0;
    pkBattle.winsHost = 0;
    pkBattle.winsRival = 0;
    pkBattle.rivalKey = '';
    pkBattle.armyTopHost = null;
    pkBattle.armyTopRival = null;
    pkBattle.armyTop3Host = [];
    pkBattle.showEnd = false;
    broadcastPkBattle(true);
  }
  function addPkHostGiftPoints(_diamonds) {
    // Intencionalmente vacío: el marcador PK usa SOLO el score oficial de TikTok
    // (LINK_MIC_ARMIES). Sumar regalos/likes aquí inflaba el marcador y bloqueaba
    // la corrección al valor real (p. ej. 1365 local vs 44 oficial).
  }
  /** @deprecated likes/taptap ya vienen en hostScore del ejército PK */
  function addPkHostLikePoints(_likeCount) {}
  function pkIdSet(...parts) {
    const set = new Set();
    for (const p of parts) {
      const n = normTikTokUser(p);
      if (n) set.add(n);
      const raw = String(p || '').trim();
      if (raw && raw !== '0') set.add(raw.toLowerCase());
    }
    return set;
  }
  /**
   * Activa el marcador si hay PK en curso (p. ej. te conectaste a media batalla).
   * No reinicia puntos: updatePkArmyScores pondrá el marcador oficial.
   */
  function ensurePkBattleFromArmies(data) {
    const battleId = String(data?.battleId || '').trim();
    const hasScores = !!(
      (data?.battleItems && Object.keys(data.battleItems).length)
      || (Array.isArray(data?.teamArmies) && data.teamArmies.length)
    );
    if (!hasScores && !battleId) return;
    if (!pkBattle.live) {
      // Tras el fin de ronda: NO reabrir el PK por paquetes residuales de ejército
      // (eso borraba Felicidades y volvía a «Mantén X de ventaja»).
      if (pkBattle.showEnd) return;
      beginPkBattleRound({
        midJoin: true,
        battleId,
        anchors: parsePkAnchors(data),
      });
      return;
    }
    if (battleId && pkBattle.battleId && battleId !== pkBattle.battleId) {
      // TikTok a veces cambia battleId a media pelea → NO reiniciar a 0 (provoca EMPATE 0 vs 0).
      if (pkBattle.pointsHost > 0 || pkBattle.pointsRival > 0 || pkBattle.armyTop3Host.length) {
        pkBattle.battleId = battleId;
        return;
      }
      beginPkBattleRound({
        midJoin: false,
        battleId,
        anchors: parsePkAnchors(data),
      });
      return;
    }
    if (battleId && !pkBattle.battleId) pkBattle.battleId = battleId;
  }
  function pkSetScore(side, score) {
    const n = Math.max(0, Math.round(Number(score) || 0));
    const cur = side === 'host' ? pkBattle.pointsHost : pkBattle.pointsRival;
    // Durante el PK el marcador oficial no baja; paquetes incompletos mandan 0 y provocan
    // parpadeo «EMPATE 0 vs 0» / «Faltan X» en el overlay Meta.
    if (pkBattle.live && n < cur) return false;
    if (side === 'host') {
      if (pkBattle.pointsHost !== n) { pkBattle.pointsHost = n; return true; }
    } else if (pkBattle.pointsRival !== n) {
      pkBattle.pointsRival = n;
      return true;
    }
    return false;
  }
  function updatePkArmyScores(data) {
    // Fuente de verdad ABSOLUTA: hostScore / teamTotalScore de TikTok (likes + regalos).
    ensurePkBattleFromArmies(data);
    if (!pkBattle.live) return;
    let changed = false;

    // Asegurar userId del host desde roomInfo si aún falta
    if (!pkBattle.host.userId) {
      const oid = pkRoomOwnerUserId() || followerCounter.userId;
      if (oid) pkBattle.host.userId = oid;
    }

    const hostIds = pkIdSet(
      pkBattle.host.userId, pkBattle.host.uniqueId,
      followerCounter.userId, followerCounter.uniqueId, state.username,
      pkRoomOwnerUserId(),
    );
    const rivalIds = pkIdSet(pkBattle.rival.userId, pkBattle.rival.uniqueId);

    if (Array.isArray(data?.teamArmies) && data.teamArmies.length) {
      for (const team of data.teamArmies) {
        const score = Math.max(0, Math.round(Number(team?.teamTotalScore ?? team?.score ?? 0)) || 0);
        const teamUserIds = (team?.teamUsers || []).map((u) => String(u?.userId || u || ''));
        const ids = pkIdSet(team?.userArmies?.anchorIdStr, team?.teamId, ...teamUserIds);
        const isHost = [...ids].some((id) => hostIds.has(id));
        const top = pkPickArmyTop(team?.userArmies?.userArmy || team?.userArmy);
        const top3 = pkPickArmyTopN(team?.userArmies?.userArmy || team?.userArmy, 3);
        if (isHost) {
          if (pkSetScore('host', score)) changed = true;
          if (pkSetArmyTop3Host(top3)) changed = true;
          else if (top && (!pkBattle.armyTopHost || top.points >= (pkBattle.armyTopHost.points || 0))) {
            pkBattle.armyTopHost = top;
            changed = true;
          }
        } else {
          if (pkSetScore('rival', score)) changed = true;
          if (!pkBattle.rival.userId && teamUserIds[0]) {
            pkBattle.rival.userId = String(teamUserIds[0]);
            changed = true;
          }
          if (top && (!pkBattle.armyTopRival || top.points >= (pkBattle.armyTopRival.points || 0))) pkBattle.armyTopRival = top;
        }
      }
    }

    const items = data?.battleItems;
    if (items && typeof items === 'object') {
      const entries = Object.entries(items).map(([k, v]) => {
        const score = Math.max(0, Math.round(Number(v?.hostScore ?? v?.score ?? 0)) || 0);
        const anchor = String(v?.anchorIdStr || k || '');
        const ids = pkIdSet(k, anchor);
        return {
          k: String(k),
          score,
          anchor,
          isHost: [...ids].some((id) => hostIds.has(id)),
          isRival: [...ids].some((id) => rivalIds.has(id)),
          top: pkPickArmyTop(v?.userArmy || v?.user_army),
          top3: pkPickArmyTopN(v?.userArmy || v?.user_army, 3),
        };
      });

      let hostEntry = entries.find((e) => e.isHost) || null;
      let rivalEntry = entries.find((e) => e.isRival) || null;

      // 1v1: si solo matcheó un lado, el otro es el contrario
      if (hostEntry && !rivalEntry && entries.length >= 2) {
        rivalEntry = entries.find((e) => e.k !== hostEntry.k) || null;
      }
      if (rivalEntry && !hostEntry && entries.length >= 2) {
        hostEntry = entries.find((e) => e.k !== rivalEntry.k) || null;
      }

      // Sin IDs aún pero hay exactamente 2 lados: NO adivinar por puntuación.
      // Si tenemos userId de host, matchear; si no, intentar room owner otra vez.
      if (!hostEntry && !rivalEntry && entries.length === 2) {
        const oid = pkBattle.host.userId || pkRoomOwnerUserId() || followerCounter.userId;
        if (oid) {
          hostEntry = entries.find((e) => e.k === String(oid) || e.anchor === String(oid)) || null;
          if (hostEntry) rivalEntry = entries.find((e) => e.k !== hostEntry.k) || null;
        }
      }

      if (hostEntry) {
        if (pkSetScore('host', hostEntry.score)) changed = true;
        if (hostEntry.k && !pkBattle.host.userId) {
          pkBattle.host.userId = hostEntry.k;
          if (!followerCounter.userId) followerCounter.userId = hostEntry.k;
          changed = true;
        }
        if (pkSetArmyTop3Host(hostEntry.top3)) changed = true;
        else if (hostEntry.top && (!pkBattle.armyTopHost || hostEntry.top.points >= (pkBattle.armyTopHost.points || 0))) {
          pkBattle.armyTopHost = hostEntry.top;
        }
      }
      if (rivalEntry) {
        if (pkSetScore('rival', rivalEntry.score)) changed = true;
        if (rivalEntry.k && !pkBattle.rival.userId) {
          pkBattle.rival.userId = rivalEntry.k;
          changed = true;
        }
        if (rivalEntry.top && (!pkBattle.armyTopRival || rivalEntry.top.points >= (pkBattle.armyTopRival.points || 0))) {
          pkBattle.armyTopRival = rivalEntry.top;
        }
      }
    }

    if (changed) broadcastPkBattle(true);
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
  /* --------------------------- Auto-conexión ---------------------------- */
  // Recuerda el último @usuario y se reconecta solo (reintentando cada cierto tiempo)
  // hasta que el creador inicie su live. Se enciende al conectar manualmente y se apaga
  // al pulsar "Desconectar". Así no hace falta darle a "Conectar" cada vez.
  const AUTO_CONNECT_POLL_MS = 45000;
  let autoConnectTimer = null;
  let lastAutoWaitLog = 0;

  // En modo relay (HOKEY_RELAY=1), la conexión a TikTok y el procesamiento corren en la
  // NUBE. El servidor local NUNCA debe conectarse para no duplicar la conexión (y el
  // gasto del sign server). Solo ejecuta lo local vía las órdenes que llegan de la nube.
  // En Render (IS_CLOUD_ROOM) HOKEY_RELAY no aplica: aquí SIEMPRE conecta TikTok.
  const RELAY = process.env.HOKEY_RELAY === '1' && !IS_CLOUD_ROOM;
  function autoConnectOn() {
    if (RELAY) return false;
    return settings.autoConnect !== false && !!settings.tiktokUser;
  }
  function startAutoConnectLoop() {
    if (autoConnectTimer) return;
    autoConnectTimer = setInterval(() => {
      if (autoConnectOn() && !state.connected && !state.connecting) {
        connectTo(settings.tiktokUser, { auto: true });
      }
    }, AUTO_CONNECT_POLL_MS);
    if (autoConnectTimer.unref) autoConnectTimer.unref();
    // Primer intento rápido al arrancar (por si ya estás en vivo).
    setTimeout(() => {
      if (autoConnectOn() && !state.connected && !state.connecting) {
        connectTo(settings.tiktokUser, { auto: true });
      }
    }, 3000);
  }

  // Guarda el último usuario (y reactiva el auto si fue una conexión manual).
  function rememberTikTokUser(username, manual) {
    let changed = false;
    if (settings.tiktokUser !== username) {
      settings.tiktokUser = username;
      // Usuario distinto → foto vieja no aplica hasta el próximo live.
      if (settings.tiktokPhoto) settings.tiktokPhoto = '';
      changed = true;
    }
    if (manual && settings.autoConnect === false) { settings.autoConnect = true; changed = true; }
    if (changed) {
      saveSettings();
      if (manual && typeof onUserSave === 'function') { try { onUserSave(settings); } catch {} }
    }
  }

  function rememberTikTokPhoto(photo) {
    const p = String(photo || '').trim();
    if (!p || settings.tiktokPhoto === p) return;
    settings.tiktokPhoto = p;
    saveSettings();
  }

  function connectTo(username, opts = {}) {
    if (RELAY) return; // en modo relay la conexión a TikTok la hace la nube, no esta PC
    if (!username) return;
    if (state.connecting || (state.connected && state.username === username)) return;

    disconnect();

    rememberTikTokUser(username, !opts.auto);

    state.username = username;
    state.connecting = true;
    // No resetear aquí: tras conectar se decide por roomId (mismo live = conservar overlays;
    // live nuevo / primera conexión = reset). Evita borrar todo al reconectar por un fallo.
    pushState();
    if (!opts.auto) broadcast('log', { level: 'info', text: `Conectando a @${username}...` });

    connection = new TikTokLiveConnection(username, {
      processInitialData: false,
      fetchRoomInfoOnConnect: true,
      requestPollingIntervalMs: 2000,
    });

    bindEvents(connection);
    tryConnect(connection, username, 1, !!opts.auto);
  }

  function tryConnect(conn, username, attempt, auto) {
    if (conn !== connection) return;
    conn
      .connect()
      .then((connState) => {
        state.connected = true;
        state.connecting = false;
        const newRoomId = connState?.roomId ?? null;
        state.roomId = newRoomId;
        const mode = applyAutoLiveConnected(newRoomId, username);
        seedStatsFromRoomInfo();
        resetRankSnap();
        startRankStreamerTimer();
        startLiveBadgeTimer();
        pushState();
        syncLiveUptimeOnConnect();
        if (mode === 'reconnect') {
          broadcast('log', {
            level: 'ok',
            text: auto
              ? `Reconectado al live (sala ${newRoomId ?? ''}) — overlays conservados`
              : `Reconectado a @${username} (sala ${newRoomId ?? ''}) — overlays conservados`,
          });
        } else {
          broadcastAllRankStates();
          if (getTop1FirePeriod() !== 'live') broadcastTop1Fire();
          if (getHabibiTopPeriod() !== 'live') broadcastHabibiTop();
          broadcast('log', {
            level: 'ok',
            text: auto
              ? `Conectado automáticamente a la sala ${newRoomId ?? ''}`
              : `Conectado a la sala ${newRoomId ?? ''}`,
          });
        }
        fetchRoomCommunityGifts(conn);
        // Evita leer/TTS de todo el backlog de chat al conectar tarde.
        beginChatCatchup();
      })
      .catch((err) => {
        if (conn !== connection) return;
        const msg = err?.message || String(err);
        // En modo manual reintentamos varias veces seguidas (por saturación del servicio).
        if (!auto && attempt < MAX_CONNECT_ATTEMPTS) {
          const delay = attempt * 2500;
          broadcast('log', {
            level: 'info',
            text: `Intento ${attempt} fallido. Reintentando en ${delay / 1000}s... (el servicio gratuito de TikTok a veces está saturado)`,
          });
          setTimeout(() => tryConnect(conn, username, attempt + 1, auto), delay);
          return;
        }
        state.connecting = false;
        state.connected = false;
        pushState();
        if (auto) {
          // Auto-conexión: seguramente aún no estás en vivo. Esperamos en silencio; el bucle
          // lo volverá a intentar y avisamos como mucho cada pocos minutos para no llenar el log.
          const now = Date.now();
          if (now - lastAutoWaitLog > 180000) {
            lastAutoWaitLog = now;
            broadcast('log', { level: 'info', text: `Esperando a que @${username} inicie el live para conectar automáticamente…` });
          }
        } else {
          broadcast('log', {
            level: 'error',
            text: `No se pudo conectar tras ${MAX_CONNECT_ATTEMPTS} intentos: ${msg}. Verifica que @${username} esté EN VIVO y vuelve a intentar en un minuto.`,
          });
        }
      });
  }

  let liveBadgeSent = false;
  const BADGE_LIVE_MIN_MS = 15 * 60 * 1000;
  let liveBadgeTimer = null;

  function stopLiveBadgeTimer() {
    clearInterval(liveBadgeTimer);
    liveBadgeTimer = null;
  }

  /** Acredita la live al cumplir 15 min (en vivo o al desconectar). */
  function notifyLiveSessionEnd() {
    if (liveBadgeSent) return false;
    if (typeof onLiveSessionEnd !== 'function') return false;
    const started = Number(state.startedAt || liveSession.startedAt) || 0;
    if (!started) return false;
    const durationMs = Math.max(0, Date.now() - started);
    if (durationMs < BADGE_LIVE_MIN_MS) return false;
    const peakViewers = Math.max(
      Number(state.stats?.peakViewers) || 0,
      Number(state.stats?.viewers) || 0,
    );
    liveBadgeSent = true;
    stopLiveBadgeTimer();
    try {
      onLiveSessionEnd({
        userId: id,
        durationMs,
        peakViewers,
      });
    } catch { /* ignore */ }
    return true;
  }

  function maybeCreditLiveBadge() {
    if (!state.connected) return;
    notifyLiveSessionEnd();
  }

  function startLiveBadgeTimer() {
    stopLiveBadgeTimer();
    liveBadgeTimer = setInterval(maybeCreditLiveBadge, 15000);
    liveBadgeTimer.unref?.();
    // Por si ya llevaba ≥15 min (reconexión / reinicio).
    setTimeout(maybeCreditLiveBadge, 2500);
  }

  function disconnect() {
    const wasLive = !!state.connected || !!state.startedAt;
    if (state.connected) flushStreamerRank();
    stopRankStreamerTimer();
    stopLiveBadgeTimer();
    clearBattleCountdown();
    clearChatCatchup();
    state.inBattle = false;
    if (connection) {
      try { connection.disconnect(); } catch { /* ignore */ }
      connection = null;
    }
    state.connected = false;
    state.connecting = false;
    state.roomId = null;
    syncLiveUptimeOnDisconnect();
    if (wasLive) notifyLiveSessionEnd();
  }

  // Desconexión MANUAL (botón "Desconectar"): además de cortar, apaga la auto-conexión
  // para que NO se vuelva a conectar solo hasta que el usuario lo pida de nuevo.
  function disconnectManual() {
    if (settings.autoConnect !== false) {
      settings.autoConnect = false;
      saveSettings();
      if (typeof onUserSave === 'function') { try { onUserSave(settings); } catch {} }
    }
    disconnect();
    pushState();
  }

  startAutoConnectLoop();

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

  // Rachas (rosas, etc.): TikTok envía repeatCount 1,2,3… durante la racha.
  // Minecraft/Roblox deben disparar por cada rosa nueva (delta), no solo al final
  // ni bloqueados por "Racha = 1" de alertas.
  const giftStreakGameProgress = new Map();
  // Cuántas alertas/videos ya disparamos en esta racha (para no duplicar al cerrar).
  const giftStreakAlertProgress = new Map();
  function giftStreakGameKey(uniqueId, giftId) {
    return `${uniqueId || ''}:${String(giftId || '')}`;
  }

  /** Dispara videos + sonidos de regalo N veces (tope 50). */
  function fireGiftMediaAlerts(user, giftId, giftInfo, times) {
    const n = Math.max(1, Math.min(50, Number(times) || 1));
    const giftInfoForAlerts = {
      ...giftInfo,
      giftName: String(giftInfo.giftName || '').toLowerCase(),
      repeatCount: n,
    };
    triggerVideos('gift', giftInfoForAlerts, user, n);
    triggerSoundAlerts('gift', giftInfo, user, n);
  }
  function triggerGiftGameActions(user, giftId, repeatCount, repeatEnd, giftType, giftInfo) {
    const key = giftStreakGameKey(user.uniqueId, giftId);
    const rep = Math.max(1, Number(repeatCount) || 1);
    const streakGift = giftType === 1;

    if (!streakGift) {
      giftStreakGameProgress.delete(key);
      triggerMinecraftActions('gift', { ...giftInfo, repeatCount: rep }, user);
      triggerActions('gift', { ...giftInfo, repeatCount: rep }, user);
      return;
    }

    const prev = giftStreakGameProgress.get(key) || 0;
    const delta = Math.max(0, rep - prev);
    if (delta > 0) giftStreakGameProgress.set(key, rep);

    if (delta > 0) {
      triggerMinecraftActions('gift', { ...giftInfo, repeatCount: delta, comboStreak: 'delta' }, user);
      triggerActions('gift', { ...giftInfo, repeatCount: delta, comboStreak: 'delta' }, user);
    }
    if (repeatEnd) {
      giftStreakGameProgress.delete(key);
      triggerMinecraftActions('gift', { ...giftInfo, repeatCount: rep, comboStreak: 'end' }, user);
      triggerActions('gift', { ...giftInfo, repeatCount: rep, comboStreak: 'end' }, user);
    }
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
    saveSessionOverlays();
    if (drops > 0) {
      const count = Math.min(200, drops);
      broadcast('fanBallDrop', { photo: user.photo || '', nickname: user.nickname || '', count });
      broadcast('log', { level: 'ok', text: `🏀 Pelotas: ${count} de ${user.nickname || uid} (${kind === 'coins' ? 'monedas' : 'likes'} +${amount}, cada ${every})` });
    }
  }

  /** Efectos a pantalla completa (App PC): disparadores tipo Acciones/MC. */
  function fireScreenFxRule(r, label) {
    if (!r || r.on === false) return;
    const allowedSet = new Set([
      'black', 'lightning', 'dvd', 'snow', 'confetti', 'glitch',
      'matrix', 'static', 'flash', 'hearts', 'bubbles',
    ]);
    const effectRaw = String(r.effect || 'black').toLowerCase();
    const allowed = allowedSet.has(effectRaw) ? effectRaw : 'black';
    let durationSec = Number(r.durationSec);
    if (!Number.isFinite(durationSec) || durationSec < 1) durationSec = 10;
    durationSec = Math.max(1, Math.min(120, Math.round(durationSec)));
    let soundVol = Number(r.soundVol);
    if (!Number.isFinite(soundVol)) soundVol = 80;
    soundVol = Math.max(0, Math.min(100, Math.round(soundVol)));
    const cfg = settings.screenFx || {};
    broadcast('screenFx', {
      effect: allowed,
      durationSec,
      giftId: String(r.giftId || '').trim(),
      giftName: r.giftName || label || '',
      sound: String(r.sound || '').trim(),
      soundVol,
      allowInteract: cfg.allowInteract !== false,
    });
    broadcast('log', {
      level: 'ok',
      text: `🖥️ Efecto pantalla · ${allowed} ${durationSec}s (${label || r.giftName || r.trigger || 'ok'})`,
    });
  }

  function processScreenFxTriggers(eventType, info = {}, user = null) {
    const cfg = settings.screenFx;
    if (!cfg || cfg.enabled === false) return;
    const rules = Array.isArray(cfg.rules) ? cfg.rules : [];
    if (!rules.length) return;
    for (const r of rules) {
      if (!r || r.on === false) continue;
      const trig = r.trigger || 'gift';
      if (eventType === 'gift') {
        if (trig !== 'gift' && trig !== 'gift-any' && trig !== 'gift-diamonds') continue;
        // Regalo específico sin elegir = no dispara (usa «Cualquier regalo»).
        if (trig === 'gift') {
          const wantId = String(r.giftId || '').trim();
          const wantName = String(r.giftName || '').trim();
          if (!wantId && !wantName) continue;
        }
        if (!gameGiftTriggerMatches(r, info)) continue;
      } else if (eventType === 'like') {
        if (trig !== 'like') continue;
        const likeFires = gameLikeTriggerFires(r, info, user, 'sfx');
        if (likeFires <= 0) continue;
        for (let lf = 0; lf < likeFires; lf++) {
          fireScreenFxRule(r, `likes ×${info.likeCount || 1}`);
        }
        continue;
      } else if (eventType === 'chat') {
        if (trig === 'chatCommand') {
          if (!matchesCommand(r.text, info.comment)) continue;
        } else if (trig === 'chatUser') {
          const want = String(r.text || '').replace(/^@/, '').trim().toLowerCase();
          if (!want) continue;
          const uname = String(info.username || '').toLowerCase();
          const nname = String(info.nickname || '').toLowerCase();
          if (want !== uname && want !== nname) continue;
        } else {
          continue;
        }
      } else if (trig !== eventType) {
        continue;
      }
      if (!allowFollowSharePerUser(r, eventType, user, 'sfx')) continue;
      const label = eventType === 'gift'
        ? (info.giftName || r.giftName || info.giftId || 'regalo')
        : (trig || eventType);
      fireScreenFxRule(r, label);
    }
  }

  function processScreenFxLikeGlobal(total, prevTotal) {
    const cfg = settings.screenFx;
    if (!cfg || cfg.enabled === false) return;
    const rules = Array.isArray(cfg.rules) ? cfg.rules : [];
    for (const r of rules) {
      if (!r || r.on === false || (r.trigger || '') !== 'likeGlobal') continue;
      const goal = Math.max(1, r.likeN || 100);
      if (Math.floor(total / goal) > Math.floor(prevTotal / goal)) {
        fireScreenFxRule(r, `${total} likes globales`);
      }
    }
  }

  /** @deprecated usar processScreenFxTriggers('gift', …) */
  function processScreenFx(giftId, giftName) {
    processScreenFxTriggers('gift', {
      giftId,
      giftName,
      totalDiamonds: 0,
      diamonds: 0,
      repeatCount: 1,
    }, null);
  }

  function triggerSoundAlerts(eventType, info = {}, user = null, times = 1) {
    // Igual que videos/batallas: la misma alerta en perfil activo + Perfil General
    // debe sonar UNA vez, no dos.
    const fireTimes = Math.max(1, Math.min(50, Number(times) || 1));
    const fired = new Set();
    forEachTriggerProfile((cfg, isGeneral) => {
      for (const a of cfg.soundAlerts) {
        if (!a.enabled || !a.sound) continue;
        const dedupeKey = String(a.id || a.sound);
        if (fired.has(dedupeKey)) continue;
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
          const likeFires = gameLikeTriggerFires(a, info, user, `sa_${a.id}`);
          if (likeFires <= 0) continue;
          fired.add(dedupeKey);
          for (let lf = 0; lf < likeFires; lf++) {
            broadcast('log', { level: 'ok', text: `🔊 Alerta sonora: "${a.name}"` });
            emitSound({ id: a.id, name: a.name, sound: a.sound, image: a.image, volume: a.volume });
          }
          continue;
        }
        if (eventType === 'levelUp') {
          const wantLevel = Math.max(0, Number(a.level) || 0);
          if (wantLevel > 0 && wantLevel !== Number(info.level || 0)) continue;
        }
        if (eventType === 'chatCommand') {
          if (!matchesCommand(a.command, info.comment)) continue;
        }
        if (eventType === 'follow' || eventType === 'share' || eventType === 'emote') {
          if (!allowFollowSharePerUser(a, eventType, user, `sa_${isGeneral ? 'g' : 'a'}`)) continue;
        }
        fired.add(dedupeKey);
        for (let t = 0; t < fireTimes; t++) {
          broadcast('log', { level: 'ok', text: `🔊 Alerta sonora: "${a.name}"${fireTimes > 1 ? ` (${t + 1}/${fireTimes})` : ''}` });
          emitSound({ id: a.id, name: a.name, sound: a.sound, image: a.image, volume: a.volume });
        }
      }
    });
  }

  // Acciones (solo se usan en la app .exe): cuando un evento coincide, avisamos al
  // cliente de escritorio (vía 'keyAction') para que simule la pulsación de teclas.
  // En la web nadie las atiende, así que no hacen nada.
  // Una acción "dispara algo" si tiene teclas, sonido o alguna salida activada.
  function actionDoesSomething(a) {
    return !!(a && (a.keys || a.sound
      || (a.mediaShow && a.mediaShow.on && a.mediaShow.url)
      || (a.marioSpawn && a.marioSpawn.npcId != null)
      || (a.webhookCmd && a.webhookCmd.on && a.webhookCmd.url)
      || (a.obsCmd && a.obsCmd.on)
      || (a.sbCmd && a.sbCmd.on && a.sbCmd.action)));
  }

  function triggerActions(eventType, info = {}, user = null) {
    forEachTriggerProfile((cfg) => {
      const list = cfg.actions || [];
      for (const a of list) {
        if (!a || a.enabled === false || !actionDoesSomething(a)) continue;
        const ev = a.event || 'gift-any';
        if (eventType === 'gift') {
          if (ev === 'gift') {
            const wantName = (a.giftName || '').trim().toLowerCase();
            const wantId = String(a.giftId || '').trim();
            // Acciones: regalo vacío = no dispara (hay que asignar regalo; usa gift-any para cualquiera).
            if (!wantId && !wantName) continue;
            const idMatch = wantId && wantId === String(info.giftId || '');
            const nameMatch = wantName && wantName === (info.giftName || '').toLowerCase();
            if (!idMatch && !nameMatch) continue;
            if ((a.minDiamonds || 0) > (info.diamonds || 0)) continue;
            if (!gameComboStreakAllows(a, info)) continue;
            fireAction(a, Math.max(1, Number(info.repeatCount) || 1), cfg, { info, user });
            continue;
          } else if (ev === 'gift-any') {
            const total = info.totalDiamonds || 0;
            if ((a.rangeMin || 0) > total) continue;
            if ((a.rangeMax || 0) > 0 && total > a.rangeMax) continue;
            if (!gameComboStreakAllows(a, info)) continue;
            fireAction(a, Math.max(1, Number(info.repeatCount) || 1), cfg, { info, user });
            continue;
          } else {
            continue;
          }
        } else if (eventType === 'like') {
          if (ev !== 'like') continue;
          const likeFires = gameLikeTriggerFires(a, info, user, `acc_${a.id}`);
          if (likeFires <= 0) continue;
          for (let lf = 0; lf < likeFires; lf++) {
            fireAction(a, 1, cfg, { info, user });
          }
          continue;
        } else if (eventType === 'emote') {
          if (ev !== 'emote') continue;
          const wantId = (a.emoteId || '').trim();
          if (wantId && wantId !== String(info.emoteId || '')) continue;
        } else if (eventType === 'chatCommand') {
          if (ev !== 'chatCommand') continue;
          if (!matchesCommand(a.command, info.comment)) continue;
          const want = String(a.user || '').replace(/^@/, '').trim().toLowerCase();
          if (want) {
            const u = String(info.username || '').toLowerCase();
            const n = String(info.nickname || '').toLowerCase();
            if (want !== u && want !== n) continue;
          }
        } else if (eventType === 'levelUp') {
          if (ev !== 'levelUp') continue;
          const wantLevel = Math.max(0, Number(a.level) || 0);
          if (wantLevel > 0 && wantLevel !== Number(info.level || 0)) continue;
        } else if (ev !== eventType) {
          continue;
        }
        if (!allowFollowSharePerUser(a, eventType, user, 'acc')) continue;
        fireAction(a, 1, cfg, { info, user });
      }
    });
  }

  // Likes globales: dispara la acción cada vez que el total de likes cruza un múltiplo
  // del objetivo configurado (igual que las alertas sonoras de "Likes globales").
  function triggerActionsLikeGlobal(total) {
    if (!total) return;
    forEachTriggerProfile((cfg) => {
      for (const a of (cfg.actions || [])) {
        if (!a || a.enabled === false || !actionDoesSomething(a) || (a.event || '') !== 'likeGlobal') continue;
        const goal = Math.max(1, a.likeGoal || 100);
        if (Math.floor(total / goal) > Math.floor(lastTotalLikes / goal)) {
          fireAction(a, 1, cfg, { info: { likeCount: total, totallikecount: total } });
        }
      }
    });
  }

  // Stream Deck: 1.er pulsado = play; si aún suena/reproduce = stop; si ya terminó = play otra vez.
  const webhookActive = new Map(); // id -> { kind, screen?, timer }

  function clearWebhookActive(id) {
    const key = String(id || '');
    if (!key) return;
    const prev = webhookActive.get(key);
    if (prev?.timer) clearTimeout(prev.timer);
    webhookActive.delete(key);
  }

  function noteWebhookActive(id, meta = {}) {
    const key = String(id || '');
    if (!key) return;
    clearWebhookActive(key);
    const timer = setTimeout(() => webhookActive.delete(key), 180000);
    webhookActive.set(key, { kind: meta.kind || 'video', screen: meta.screen || 1, timer });
  }

  function stopWebhookActive(id) {
    const key = String(id || '');
    const cur = webhookActive.get(key);
    if (!cur) return false;
    if (cur.kind === 'video' || cur.kind === 'battle' || cur.kind === 'action') {
      emitStopMedia(cur.screen || 1);
    }
    if (cur.kind === 'sound' || cur.kind === 'action') {
      broadcast('stopSound', { id: key });
    }
    clearWebhookActive(key);
    broadcast('log', { level: 'ok', text: `🪝 Webhook stop → ${key}` });
    return true;
  }

  // Lista de acciones para el webhook HTTP (/get_actions).
  function listActions() {
    return (settings.actions || []).map((a) => ({ id: a.id, name: a.name || '', enabled: a.enabled !== false }));
  }

  // Ejecuta una acción desde el webhook HTTP (/execute_action). Busca por id o por
  // nombre, sustituye variables ({username}, {giftname}, …) en el texto/teclas y la dispara.
  function executeWebhookAction({ id, name, data, actionsOverride } = {}) {
    const list = Array.isArray(actionsOverride) ? actionsOverride : (settings.actions || []);
    let a = null;
    if (id != null && String(id) !== '') a = list.find((x) => String(x.id) === String(id));
    if (!a && name) {
      const n = String(name).trim().toLowerCase();
      a = list.find((x) => (x.name || '').trim().toLowerCase() === n);
    }
    if (!a) return { ok: false, error: 'not_found' };
    if (a.enabled === false) return { ok: false, error: 'disabled' };

    const aid = String(a.id);
    if (webhookActive.has(aid)) {
      stopWebhookActive(aid);
      return { ok: true, stopped: true, action: { id: a.id, name: a.name || '' } };
    }

    const d = data || {};
    const times = Math.max(1, Number(d.repeatcount ?? d.repeatCount) || 1);
    const vars = {
      username: d.username ?? d.uniqueId ?? '',
      nickname: d.nickname ?? '',
      giftname: d.giftname ?? d.giftName ?? '',
      giftid: d.giftid ?? d.giftId ?? '',
      coins: d.coins ?? d.diamondCount ?? '',
      repeatcount: times,
      comment: d.comment ?? d.message ?? '',
      likecount: d.likecount ?? '',
      totaluserlikes: d.totaluserlikes ?? '',
      totallikecount: d.totallikecount ?? '',
      imgprofile: d.imgprofile ?? d.avatar ?? '',
    };
    const sub = (s) => String(s == null ? '' : s).replace(/\{(\w+)\}/g, (m, k) => {
      const v = vars[k.toLowerCase()];
      return v != null && v !== '' ? String(v) : m;
    });
    const fired = { ...a, keys: sub(a.keys), name: sub(a.name || '') };
    broadcast('log', { level: 'ok', text: `🪝 Webhook → acción "${a.name || a.keys}"` });
    fireAction(fired, times, settings, {
      info: {
        ...d,
        giftName: d.giftname ?? d.giftName ?? '',
        giftId: d.giftid ?? d.giftId ?? '',
        repeatCount: times,
        nickname: d.nickname ?? '',
        username: d.username ?? d.uniqueId ?? '',
      },
      user: { nickname: d.nickname ?? '', uniqueId: d.username ?? d.uniqueId ?? '' },
    });
    const scr = Number(a.mediaShow?.screen) || 1;
    noteWebhookActive(aid, { kind: 'action', screen: scr });
    return { ok: true, action: { id: a.id, name: a.name || '' } };
  }

  // Reproduce una alerta sonora desde el webhook HTTP (/execute_sound).
  function executeWebhookSound({ id, name, soundAlertsOverride } = {}) {
    const list = Array.isArray(soundAlertsOverride) ? soundAlertsOverride : (settings.soundAlerts || []);
    let a = null;
    if (id != null && String(id) !== '') a = list.find((x) => String(x.id) === String(id));
    if (!a && name) {
      const n = String(name).trim().toLowerCase();
      a = list.find((x) => (x.name || '').trim().toLowerCase() === n);
    }
    if (!a) return { ok: false, error: 'not_found', message: 'No encontrada en Alertas sonoras.' };
    if (a.enabled === false) return { ok: false, error: 'disabled' };
    if (!a.sound) return { ok: false, error: 'no_sound' };

    const sid = String(a.id);
    if (webhookActive.has(sid)) {
      stopWebhookActive(sid);
      return { ok: true, stopped: true, sound: { id: a.id, name: a.name || '' } };
    }

    broadcast('log', { level: 'ok', text: `🪝 Webhook → sonido "${a.name || a.id}"` });
    emitSound({ id: a.id, name: a.name, sound: a.sound, image: a.image, volume: a.volume, webhookToggle: true });
    noteWebhookActive(sid, { kind: 'sound' });
    return { ok: true, sound: { id: a.id, name: a.name || '' } };
  }

  // Lista de videos + animaciones de batalla para el webhook HTTP (/get_videos).
  // overrides opcionales (relay: listas traídas de la nube) sin tocar settings.
  function listVideos(videosOverride, battleAlertsOverride) {
    const vids = Array.isArray(videosOverride) ? videosOverride : (settings.videos || []);
    const bas = Array.isArray(battleAlertsOverride) ? battleAlertsOverride : (settings.battleAlerts || []);
    const mapOne = (v, kind) => ({
      id: v.id,
      name: v.name || '',
      enabled: v.enabled !== false,
      screen: Number(v.screen) || 1,
      kind,
    });
    return [
      ...vids.map((v) => mapOne(v, 'video')),
      ...bas.map((v) => mapOne(v, 'battle')),
    ];
  }

  // Reproduce un video/animación desde el webhook HTTP (/execute_video).
  // Busca por id o nombre en Videos y en Batallas. kind opcional: "video" | "battle".
  function executeWebhookVideo({
    id, name, kind, videosOverride, battleAlertsOverride, videosEnabled, battleAlertsEnabled,
  } = {}) {
    const vids = Array.isArray(videosOverride) ? videosOverride : (settings.videos || []);
    const bas = Array.isArray(battleAlertsOverride) ? battleAlertsOverride : (settings.battleAlerts || []);
    const want = String(kind || '').trim().toLowerCase();
    const useVids = !want || want === 'video' || want === 'videos';
    const useBas = !want || want === 'battle' || want === 'batalla' || want === 'battles';
    const tagged = [
      ...(useVids ? vids.map((x) => ({ item: x, isBattle: false })) : []),
      ...(useBas ? bas.map((x) => ({ item: x, isBattle: true })) : []),
    ];
    let hit = null;
    if (id != null && String(id) !== '') {
      hit = tagged.find((x) => String(x.item.id) === String(id));
    }
    if (!hit && name) {
      const n = String(name).trim().toLowerCase();
      hit = tagged.find((x) => (x.item.name || '').trim().toLowerCase() === n);
    }
    if (!hit) {
      return {
        ok: false,
        error: 'not_found',
        message: want
          ? `No encontrado en ${want === 'battle' || want === 'batalla' ? 'Batallas' : 'Videos'}. Revisa el nombre.`
          : 'No encontrado en Videos ni en Batallas. Revisa el nombre.',
      };
    }
    const v = hit.item;
    const isBattle = hit.isBattle;
    if (v.enabled === false) return { ok: false, error: 'disabled' };
    if (!v.url) return { ok: false, error: 'no_url' };

    const vid = String(v.id);
    if (webhookActive.has(vid)) {
      stopWebhookActive(vid);
      return {
        ok: true,
        stopped: true,
        video: { id: v.id, name: v.name || '', screen: Number(v.screen) || 1, kind: isBattle ? 'battle' : 'video' },
      };
    }

    if (isBattle) {
      const en = battleAlertsOverride != null
        ? (battleAlertsEnabled !== false)
        : (settings.battleAlertsEnabled !== false);
      if (!en) return { ok: false, error: 'disabled', message: 'Animaciones de batalla apagadas.' };
    } else {
      const en = videosOverride != null
        ? (videosEnabled !== false)
        : (settings.videosEnabled !== false);
      if (!en) return { ok: false, error: 'disabled', message: 'Videos apagados en el panel.' };
    }

    const scr = Number(v.screen) || 1;
    broadcast('log', {
      level: 'ok',
      text: `🪝 Webhook → ${isBattle ? 'batalla' : 'video'} "${v.name || v.id}" · P${scr}`,
    });
    emitMedia({
      id: v.id,
      name: v.name || '',
      url: v.url,
      screen: scr,
      volume: v.volume ?? 100,
      size: v.size ?? screenSize(scr),
      playQueue: settings.playback?.playQueue !== false,
      maxDurationSec: v.originalDuration === false ? 5 : (v.maxDurationSec || 0),
      test: true,
      webhookToggle: true,
    });
    noteWebhookActive(vid, { kind: isBattle ? 'battle' : 'video', screen: scr });
    return { ok: true, video: { id: v.id, name: v.name || '', screen: scr, kind: isBattle ? 'battle' : 'video' } };
  }

  function resolveKeyTimes(a, eventTimes = 1) {
    // Cantidad de regalos (o likes) del evento × repetición fija de teclas (si está ON).
    const gifts = Math.max(1, Number(eventTimes) || 1);
    if (a && a.keyRepeatOn && a.keys) {
      const per = Math.max(1, Math.min(50, parseInt(a.keyRepeat, 10) || 1));
      return Math.max(1, Math.min(1000, per * gifts));
    }
    return Math.max(1, Math.min(1000, gifts));
  }

  function fireAction(a, times = 1, cfg, context = null) {
    const s = cfg || settings;
    const t = resolveKeyTimes(a, times);
    if (a.keys) {
      const holdNote = Number(a.keyHoldSec) > 0 ? ` (${a.keyHoldSec}s)` : '';
      broadcast('log', { level: 'ok', text: `⚡ Acción: "${a.name || a.keys}" → ${a.keys}${holdNote}${t > 1 ? ` ×${t}` : ''}` });
      emitKeyAction({
        id: a.id, name: a.name || '', keys: a.keys, gameCompat: !!a.gameCompat,
        keyHoldSec: Number(a.keyHoldSec) > 0 ? Number(a.keyHoldSec) : 0,
        keyStaggerOn: !!a.keyStaggerOn,
        keyStaggerMs: Math.max(50, Math.min(10000, parseInt(a.keyStaggerMs, 10) || 300)),
        times: t, sound: a.sound || '', soundName: a.soundName || '',
        soundVolume: a.soundVolume != null ? a.soundVolume : 1,
      });
    } else if (a.sound) {
      emitKeyAction({
        id: a.id, name: a.name || '', keys: '', times: t,
        sound: a.sound, soundName: a.soundName || '',
        soundVolume: a.soundVolume != null ? a.soundVolume : 1,
      });
    }
    if (a.mediaShow?.on && a.mediaShow?.url) {
      const scr = Number(a.mediaShow.screen) || 1;
      const ms = a.mediaShow;
      broadcast('log', { level: 'ok', text: `🎬 Media: "${a.name || ms.name || 'acción'}"` });
      emitMedia({
        id: a.id,
        name: a.name || ms.name || '',
        url: ms.url,
        screen: scr,
        volume: ms.volume ?? 100,
        size: ms.size ?? screenSize(scr),
        playQueue: s.playback?.playQueue !== false,
        maxDurationSec: ms.originalDuration === false ? 5 : 0,
      });
    }
    const ctx = context ? { info: context.info || {}, user: context.user || null, times: t } : null;
    const marioFromField = fireMarioSpawnFromAction(a, context, t);
    if (!marioFromField) {
      runActionOutputs(
        { webhookCmd: a.webhookCmd, obsCmd: a.obsCmd, sbCmd: a.sbCmd },
        s,
        ctx,
      );
    } else if (a.obsCmd?.on || (a.sbCmd?.on && a.sbCmd?.action)) {
      runActionOutputs({ obsCmd: a.obsCmd, sbCmd: a.sbCmd }, s, ctx);
    }
  }

  // Ejecuta las salidas de integración de una acción (si están activadas) usando los
  // datos de conexión de settings.webhook. No bloquea: cada salida corre por su cuenta.
  function sleepMs(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function fireWebhookShot(webhookCmd, wh, context, times) {
    const t = Math.max(1, Number(times) || 1);
    const mario = resolveMarioSpawnFromWebhook(webhookCmd, context, t);
    if (mario) {
      if (emitLocalExec({ tipo: 'MARIO_SPAWN', thing: mario.npcId, name: mario.name, times: mario.times })) {
        broadcast('log', {
          level: 'ok',
          text: `🍄 Mario → tu PC: npc ${mario.npcId} · ${mario.name || 'espectador'}${mario.times > 1 ? ` ×${mario.times}` : ''}`,
        });
      } else {
        marioSpawn(mario.npcId, mario.name, mario.times)
          .then(() => {
            broadcast('log', {
              level: 'ok',
              text: `🍄 Mario (panel): npc ${mario.npcId} · ${mario.name || 'espectador'}${mario.times > 1 ? ` ×${mario.times}` : ''}`,
            });
          })
          .catch((e) => broadcast('log', { level: 'err', text: `🍄 Mario spawn falló: ${e?.message || e}` }));
      }
      return;
    }
    let whCmd = (context && urlHasActionPlaceholders(webhookCmd.url))
      ? webhookCmdWithVars(webhookCmd, context.info || {}, context.user || null, t)
      : { ...webhookCmd };
    if (/\/spawn\b/i.test(whCmd.url)) {
      whCmd = {
        ...whCmd,
        url: isMari0ActivadorWebhook(whCmd.url)
          ? applyWebhookQuantityToUrl(whCmd.url, t)
          : applySpawnQuantityToUrl(whCmd.url, t),
      };
    } else {
      whCmd = { ...whCmd, url: applyWebhookQuantityToUrl(whCmd.url, t) };
    }
    const method = (whCmd.method || 'GET').toUpperCase();
    if (emitLocalExec({ tipo: 'WEBHOOK', method, url: whCmd.url, body: whCmd.body || '' })) {
      broadcast('log', { level: 'ok', text: `🪝 WebHook → tu PC (${method} ${whCmd.url})` });
    } else {
      // Misma ruta que Probar (.exe / game-exec): nunca fetch a ciegas.
      runWebhookExec({
        tipo: 'WEBHOOK',
        method,
        url: whCmd.url,
        body: whCmd.body || '',
      })
        .then((r) => {
          if (r && r.ok !== false) {
            broadcast('log', { level: 'ok', text: `🪝 WebHook → ${method} ${whCmd.url}` });
          } else {
            broadcast('log', { level: 'err', text: `🪝 WebHook falló: ${r?.error || 'error'}` });
          }
        })
        .catch((e) => broadcast('log', { level: 'err', text: `🪝 WebHook falló: ${e.message}` }));
    }
  }

  function fireStreamerbotShot(sbCmd, wh) {
    if (emitLocalExec({ tipo: 'STREAMER_BOT', conn: wh.streamerbot || {}, action: sbCmd.action })) {
      broadcast('log', { level: 'ok', text: `🤖 Streamer.bot → tu PC ("${sbCmd.action}")` });
    } else {
      triggerStreamerbot(wh.streamerbot || {}, sbCmd.action)
        .then((r) => broadcast('log', { level: r.ok ? 'ok' : 'err', text: r.ok ? `🤖 Streamer.bot: "${sbCmd.action}" OK` : `🤖 Streamer.bot falló: ${r.error}` }))
        .catch((e) => broadcast('log', { level: 'err', text: `🤖 Streamer.bot falló: ${e.message}` }));
    }
  }

  function runActionOutputs({ webhookCmd, obsCmd, sbCmd } = {}, cfg, context = null) {
    const wh = (cfg || settings).webhook || {};
    if (webhookCmd && webhookCmd.on && webhookCmd.url) {
      const times = Math.max(1, Number(context?.times) || 1);
      const staggerOn = !!webhookCmd.staggerOn && times > 1;
      const gap = Math.max(50, Math.min(10000, parseInt(webhookCmd.staggerMs, 10) || 300));
      if (staggerOn) {
        (async () => {
          for (let i = 0; i < times; i++) {
            fireWebhookShot(webhookCmd, wh, context, 1);
            if (i < times - 1) await sleepMs(gap);
          }
        })();
      } else {
        fireWebhookShot(webhookCmd, wh, context, times);
      }
    }
    if (obsCmd && obsCmd.on) {
      if (emitLocalExec({ tipo: 'OBS', conn: wh.obs || {}, cmd: obsCmd })) {
        broadcast('log', { level: 'ok', text: `🎬 OBS → tu PC (${obsCmd.type || 'cmd'})` });
      } else {
        sendObsCommand(wh.obs || {}, obsCmd)
          .then((r) => broadcast('log', { level: r.ok ? 'ok' : 'err', text: r.ok ? `🎬 OBS: ${obsCmd.type} OK` : `🎬 OBS falló: ${r.error}` }))
          .catch((e) => broadcast('log', { level: 'err', text: `🎬 OBS falló: ${e.message}` }));
      }
    }
    if (sbCmd && sbCmd.on && sbCmd.action) {
      const times = Math.max(1, Number(context?.times) || 1);
      const staggerOn = !!sbCmd.staggerOn && times > 1;
      const gap = Math.max(50, Math.min(10000, parseInt(sbCmd.staggerMs, 10) || 300));
      if (staggerOn) {
        (async () => {
          for (let i = 0; i < times; i++) {
            fireStreamerbotShot(sbCmd, wh);
            if (i < times - 1) await sleepMs(gap);
          }
        })();
      } else {
        fireStreamerbotShot(sbCmd, wh);
      }
    }
  }

  /* ------------------- Acciones de Minecraft (RCON) ------------------- */
  // Construye el mapa de variables disponibles para los comandos de Minecraft.
  function buildMcVars(info = {}, user = null) {
    const u = user || {};
    const clean = (v) => String(v == null ? '' : v).replace(/["\\]/g, '').slice(0, 48);
    const mcPl = String(settings.webhook?.rcon?.playername || settings.webhook?.servertap?.playername || '').trim().replace(/^@/, '');
    const mcplayer = mcPl ? clean(mcPl) : '@p';
    return {
      // Posición del streamer en el mundo (usar en «execute at …»).
      streamer: '@p',
      at: '@p',
      // Tu nick de Minecraft (Configuración → Nombre del Jugador). QualityArmory «qa give» lo necesita.
      mcplayer,
      playername: clean(u.nickname || u.uniqueId || info.nickname || info.giftName || 'Espectador') || 'Espectador',
      nickname: clean(u.nickname || info.nickname || ''),
      username: clean(u.uniqueId || info.username || ''),
      giftname: clean(info.giftName || ''),
      giftid: String(info.giftId || ''),
      coins: String(info.totalDiamonds || info.diamonds || info.coins || ''),
      comment: clean(info.comment || ''),
      repeatcount: Math.max(1, Number(info.repeatCount) || 1),
      likecount: String(info.likeCount || ''),
      imgprofile: u.photo || '',
    };
  }

  function buildActionWebhookVars(info = {}, user = null, times = 1) {
    const u = user || {};
    const nick = String(u.nickname || info.nickname || '');
    const uname = String(u.uniqueId || info.username || info.uniqueId || '');
    const rep = Math.max(1, Number(times) || Number(info.repeatCount) || 1);
    return {
      username: uname,
      uniqueid: uname,
      nickname: nick,
      giftname: String(info.giftName || ''),
      giftid: String(info.giftId || ''),
      coins: String(info.totalDiamonds ?? info.diamonds ?? info.coins ?? ''),
      diamondcount: String(info.diamonds ?? info.totalDiamonds ?? ''),
      repeatcount: String(rep),
      quantity: String(rep),
      comment: String(info.comment || ''),
      likecount: String(info.likeCount ?? ''),
      imgprofile: String(u.photo || info.photo || ''),
      avatar: String(u.photo || info.photo || ''),
    };
  }

  function substituteActionTemplate(tpl, vars, encodeUri = false) {
    const rep = (m, k) => {
      const v = vars[k.toLowerCase()];
      if (v == null || v === '') return m;
      const s = String(v);
      return encodeUri ? encodeURIComponent(s) : s;
    };
    return String(tpl == null ? '' : tpl)
      .replace(/\{(\w+)\}/gi, rep)
      .replace(/%([a-z_]+)%/gi, rep);
  }

  function webhookCmdWithVars(cmd, info = {}, user = null, times = 1) {
    if (!cmd || !cmd.on || !cmd.url) return cmd;
    const vars = buildActionWebhookVars(info, user, times);
    return {
      ...cmd,
      url: substituteActionTemplate(cmd.url, vars, true),
      body: cmd.body ? substituteActionTemplate(cmd.body, vars, false) : cmd.body,
    };
  }

  function applySpawnQuantityToUrl(url, quantity) {
    const q = Math.max(1, Math.min(999, Number(quantity) || 1));
    const s = String(url || '');
    if (!/\/spawn\b/i.test(s)) return s;
    if (/[?&]quantity=\d+/i.test(s)) return s.replace(/([?&]quantity=)\d+/i, `$1${q}`);
    if (/[?&]count=\d+/i.test(s)) return s.replace(/([?&]count=)\d+/i, `$1${q}`);
    return `${s}${s.includes('?') ? '&' : '?'}quantity=${q}`;
  }

  function applyWebhookQuantityToUrl(url, quantity) {
    const q = Math.max(1, Math.min(999, Number(quantity) || 1));
    const s = String(url || '');
    if (/[?&]quantity=\d+/i.test(s)) return s.replace(/([?&]quantity=)\d+/i, `$1${q}`);
    if (/[?&]count=\d+/i.test(s)) return s.replace(/([?&]count=)\d+/i, `$1${q}`);
    if (/\/spawn\b|\/powerup\b/i.test(s)) return `${s}${s.includes('?') ? '&' : '?'}quantity=${q}`;
    return s;
  }

  /** URLs tipo TikFinity / SMBX2 Webhook: GET …/spawn?id=14&quantity=1&userName=… */
  function parseExternalSpawnUrl(url) {
    if (!url || !/\/spawn\b/i.test(String(url))) return null;
    try {
      const u = new URL(String(url).replace(/\{[^}]+\}/g, ''));
      const rawId = u.searchParams.get('id') ?? u.searchParams.get('npcId');
      if (rawId == null || rawId === '') return null;
      const n = Number(rawId);
      const npcId = Number.isFinite(n) ? n : rawId;
      const quantity = Math.max(1, parseInt(u.searchParams.get('quantity') ?? u.searchParams.get('count') ?? '1', 10) || 1);
      const rawName = u.searchParams.get('userName') ?? u.searchParams.get('nickname') ?? u.searchParams.get('name') ?? '';
      const name = rawName ? decodeURIComponent(String(rawName).replace(/\+/g, ' ')) : '';
      return { npcId, quantity, name };
    } catch {
      const idM = String(url).match(/[?&](?:id|npcId)=(\d+)/i);
      if (!idM) return null;
      return { npcId: Number(idM[1]), quantity: 1, name: '' };
    }
  }

  function urlHasActionPlaceholders(url) {
    return /\{[^}]+\}/.test(String(url || '')) || /%[a-z_]+%/i.test(String(url || ''));
  }

  function isExternalSmbxTiktokWebhook(url) {
    return /(?:localhost|127\.0\.0\.1):5720\b/i.test(String(url || ''));
  }

  /** Webhook Mari0 activador (:5720 enemy=/powerup/efectos), no SMBX spawn?id=. */
  function isMari0ActivadorWebhook(url) {
    if (!isExternalSmbxTiktokWebhook(url)) return false;
    try {
      const u = new URL(String(url).replace(/\{[^}]+\}/g, 'x'));
      if (!/\/spawn\b/i.test(u.pathname)) return true;
      const rawId = u.searchParams.get('id') ?? u.searchParams.get('npcId');
      if (rawId != null && rawId !== '') return false;
      return !!(u.searchParams.get('enemy') || u.searchParams.get('type'));
    } catch {
      return /[?&]enemy=/i.test(String(url || '')) || /[?&]type=/i.test(String(url || ''));
    }
  }

  function resolveMarioSpawnFromWebhook(webhookCmd, context, times = 1) {
    if (!webhookCmd?.on || !webhookCmd.url) return null;
    if (!/\/spawn\b/i.test(webhookCmd.url)) return null;
    // Mari0 activador (enemy=/type=) no es spawn SMBX por id.
    if (isMari0ActivadorWebhook(webhookCmd.url)) return null;
    // Incluye http://127.0.0.1:5720/spawn?id=… — misma ruta que Probar (marioSpawn → archivo),
    // no un fetch HTTP a ciegas (antes se excluía :5720 y el live no spawneaba).
    const t = Math.max(1, Number(times) || 1);
    const resolved = (context && urlHasActionPlaceholders(webhookCmd.url))
      ? webhookCmdWithVars(webhookCmd, context.info || {}, context.user || null, t)
      : webhookCmd;
    const parsed = parseExternalSpawnUrl(resolved.url);
    if (!parsed) return null;
    const vars = context ? buildActionWebhookVars(context.info || {}, context.user || null, t) : {};
    const nick = parsed.name || vars.nickname || vars.username || '';
    // times del contexto × quantity de la URL. Callers Mario ya ponen quantity=total y times=1.
    return { npcId: parsed.npcId, name: nick, times: Math.max(1, parsed.quantity * t) };
  }

  function fireMarioSpawnFromAction(a, context, times = 1) {
    const ms = a?.marioSpawn;
    if (ms == null || ms.npcId == null) return false;
    const t = Math.max(1, Number(times) || 1);
    const vars = context ? buildActionWebhookVars(context.info || {}, context.user || null, t) : { nickname: '', username: '' };
    const nick = vars.nickname || vars.username || '';
    // Cap 999 (igual que pestaña Mario). Hay que pasar `a` a spawnMarioThing para que
    // withGameActionCountTiming repita N veces; sin eso solo spawneaba 1.
    const total = Math.min(999, Math.max(1, (parseInt(ms.quantity, 10) || 1) * t));
    broadcast('log', {
      level: 'ok',
      text: `🍄 Mario: npc ${ms.npcId} · ${nick || 'espectador'}${total > 1 ? ` ×${total}` : ''}`,
    });
    spawnMarioThing(ms.npcId, nick, total, a);
    return true;
  }

  // Recorre settings.mcActions y ejecuta por RCON las que coincidan con el evento.
  function triggerMinecraftActions(eventType, info = {}, user = null) {
    forEachTriggerProfile((cfg) => triggerMinecraftActionsCfg(eventType, info, user, cfg));
  }
  function triggerMinecraftActionsCfg(eventType, info = {}, user = null, cfg) {
    triggerRobloxActions(eventType, info, user, cfg);
    triggerRoblox3Actions(eventType, info, user, cfg);
    if (eventType !== 'like') triggerMarioActions(eventType, info, user, cfg);
    triggerMari0Actions(eventType, info, user, cfg);
    triggerSmb3Actions(eventType, info, user, cfg);
    triggerPvzActions(eventType, info, user, cfg);
    triggerPvzHybridActions(eventType, info, user, cfg);
    if (eventType !== 'like') triggerRepoActions(eventType, info, user, cfg);
    triggerL4dActions(eventType, info, user, cfg);
    triggerGtavKothActions(eventType, info, user, cfg);
    triggerGtavChaosActions(eventType, info, user, cfg);
    triggerGtavChiliadActions(eventType, info, user, cfg);
    triggerUnturnedActions(eventType, info, user, cfg);
    triggerCtrActions(eventType, info, user, cfg);
    triggerMslugActions(eventType, info, user, cfg);
    triggerGdashActions(eventType, info, user, cfg);
    triggerSmwActions(eventType, info, user, cfg);
    const vars = buildMcVars(info, user);
    if (Array.isArray(cfg.mcActions) && cfg.mcActions.length) processMcList(cfg.mcActions, eventType, info, vars, user);
    if (Array.isArray(cfg.mcshooterActions) && cfg.mcshooterActions.length) processMcList(cfg.mcshooterActions, eventType, info, vars, user);
    if (Array.isArray(cfg.bedrockActions) && cfg.bedrockActions.length) processMcList(cfg.bedrockActions, eventType, info, vars, user);
    if (Array.isArray(cfg.parkourActions) && cfg.parkourActions.length) processMcList(cfg.parkourActions, eventType, info, vars, user);
    if (Array.isArray(cfg.kothActions) && cfg.kothActions.length) processMcList(cfg.kothActions, eventType, info, vars, user);
    if (Array.isArray(cfg.farmActions) && cfg.farmActions.length) processMcList(cfg.farmActions, eventType, info, vars, user);
    if (Array.isArray(cfg.sandboxActions) && cfg.sandboxActions.length) processMcList(cfg.sandboxActions, eventType, info, vars, user);
    if (eventType === 'chat') triggerMcShooterColiseo(info, user, cfg);
  }

  let lastMcshooterColiseoAt = 0;

  function mcshooterColiseoSpawnTpl(col) {
    const custom = String(col?.spawnCmd || '').trim();
    if (custom) return custom;
    const x = Number(col?.posX) || 0;
    const y = Number.isFinite(Number(col?.posY)) ? Number(col.posY) : 64;
    const z = Number(col?.posZ) || 0;
    return `execute positioned ${x} ${y} ${z} run summon zombie ~ ~ ~ {CustomName:'"{playername}"',CustomNameVisible:1b}`;
  }

  function triggerMcShooterColiseo(info = {}, user = null, cfg = settings, opts = {}) {
    const col = cfg?.mcshooterColiseo;
    if (!col || col.enabled === false) return;
    const cmdText = String(col.chatCmd || '!entro').trim();
    if (!cmdText) return;
    if (!matchesCommand(cmdText, info.comment)) return;
    const cdMs = Math.max(1000, (Math.max(1, parseInt(col.cooldownSec, 10) || 40)) * 1000);
    const now = Date.now();
    if (!opts.force && now - lastMcshooterColiseoAt < cdMs) {
      const wait = Math.ceil((cdMs - (now - lastMcshooterColiseoAt)) / 1000);
      broadcast('log', { level: 'warn', text: `🏟️ Coliseo: espera ${wait}s para otro zombie` });
      return;
    }
    lastMcshooterColiseoAt = now;
    const vars = buildMcVars(info, user);
    const spawnCmd = mcshooterColiseoSpawnTpl(col);
    const who = vars.nickname || vars.username || 'Espectador';
    scheduleMcAction(() => runMcAction({ name: 'Coliseo zombie', cmd: spawnCmd, enabled: true }, vars, { soundTimes: 1 }));
    broadcast('log', { level: 'ok', text: `🏟️ Coliseo: zombie de ${who} (${cmdText})` });
  }
  function playMcActionSound(a, times = 1) {
    if (!a || !a.audioOn || !a.sound) return;
    const n = Math.max(1, Math.min(Number(times) || 1, 50));
    for (let i = 0; i < n; i++) {
      emitSound({
        id: a.uid || a.catId || '',
        name: a.name || a.soundName || 'Minecraft',
        sound: a.sound,
        image: a.image || (a.catId ? `/img/minecraft/${a.catId}.png` : ''),
        volume: a.soundVolume != null ? a.soundVolume : 100,
      });
    }
  }


  /** Rango de diamantes (trigger gift-diamonds): totalDiamonds = diamantes × cantidad. */
  function gameGiftDiamondsRangeOk(a, info) {
    const total = Number(info.totalDiamonds) || 0;
    if ((Number(a.rangeMin) || 0) > total) return false;
    if ((Number(a.rangeMax) || 0) > 0 && total > (Number(a.rangeMax) || 0)) return false;
    return true;
  }

  /** Regalo asignado: debe coincidir. Sin asignar: cualquier regalo (como Probar). */
  function gameGiftTriggerMatches(a, info) {
    const trig = a?.trigger || 'gift';
    if (trig === 'gift-any') return true;
    if (trig === 'gift-diamonds') return gameGiftDiamondsRangeOk(a, info);
    if (trig !== 'gift') return false;
    const wantId = String(a?.giftId || '').trim();
    const wantName = String(a?.giftName || '').trim().toLowerCase();
    if (!wantId && !wantName) return true;
    const idMatch = wantId && wantId === String(info?.giftId || '');
    const nameMatch = wantName && wantName === String(info?.giftName || '').toLowerCase();
    return !!(idMatch || nameMatch);
  }

  /** comboInstant=true → solo delta; false → solo end. Sin streak → ok. */
  function gameComboStreakAllows(a, info) {
    if (!info || info.comboStreak == null) return true;
    const comboOn = a?.comboInstant !== false;
    if (info.comboStreak === 'delta' && !comboOn) return false;
    if (info.comboStreak === 'end' && comboOn) return false;
    return true;
  }

  function processMcList(list, eventType, info, vars, user = null) {
    for (const a of list) {
      if (!a || a.enabled === false) continue;
      if (!a.cmd && !(Array.isArray(a.cmds) && a.cmds.length)) continue;
      const trig = a.trigger || 'gift';
      if (eventType === 'gift') {
        if (trig === 'gift' || trig === 'gift-any' || trig === 'gift-diamonds') {
          if (!gameGiftTriggerMatches(a, info)) continue;
        } else {
          continue;
        }
        if (!gameComboStreakAllows(a, info)) continue;
      } else if (eventType === 'like') {
        if (trig !== 'like') continue;
        const likeFires = gameLikeTriggerFires(a, info, user, 'mc');
        if (likeFires <= 0) continue;
        for (let lf = 0; lf < likeFires; lf++) {
          scheduleMcAction(() => runMcAction(a, vars, { soundTimes: 1 }));
        }
        continue;
      } else if (eventType === 'chat') {
        if (trig === 'chatCommand') {
          if (!matchesCommand(a.text, info.comment)) continue;
        } else if (trig === 'chatUser') {
          const want = String(a.text || '').replace(/^@/, '').trim().toLowerCase();
          if (!want) continue;
          const uname = String(info.username || '').toLowerCase();
          const nname = String(info.nickname || '').toLowerCase();
          if (want !== uname && want !== nname) continue;
        } else {
          continue;
        }
      } else if (trig !== eventType) {
        continue;
      }
      if (!allowFollowSharePerUser(a, eventType, user, 'mc')) continue;
      const soundTimes = eventType === 'gift' ? Math.max(1, Number(info.repeatCount) || 1) : 1;
      scheduleMcAction(() => runMcAction(a, vars, { soundTimes }));
    }
  }

  // ---- Acciones de Roblox: simulan teclas (vía 'keyAction') al cliente .exe ----
  function fireRobloxKeys(a, times) {
    if (!a || !a.keys) return;
    const units = Math.max(1, Number(times) || 1);
    withGameActionCountTiming(a, units, () => {
      broadcast('log', { level: 'ok', text: `🟥 Roblox: "${a.name || a.keys}" → ${a.keys}${units > 1 ? ` ×${units}` : ''}` });
      try { if (typeof onGameExec === 'function') onGameExec('ROBLOX'); } catch { /* ignore */ }
      emitKeyAction({
        id: 'rbx_' + (a.slot != null ? a.slot : ''), name: a.name || 'Roblox',
        keys: a.keys, gameCompat: true, times: 1, sound: '', soundName: '', soundVolume: 1,
      });
    });
  }
  function triggerRobloxActions(eventType, info = {}, user = null, cfg = settings) {
    const list = cfg.robloxActions || [];
    if (!list.length) return;
    for (const a of list) {
      if (!a || a.enabled === false || !a.keys) continue;
      const trig = a.trigger || 'gift';
      let times = Math.max(1, parseInt(a.count, 10) || 1);
      if (eventType === 'gift') {
        if (trig === 'gift' || trig === 'gift-any' || trig === 'gift-diamonds') {
          if (!gameGiftTriggerMatches(a, info)) continue;
          times *= Math.max(1, Number(info.repeatCount) || 1);
        } else {
          continue;
        }
        if (!gameComboStreakAllows(a, info)) continue;
      } else if (eventType === 'like') {
        if (trig !== 'like') continue;
        const likeFires = gameLikeTriggerFires(a, info, user, 'roblox');
        if (likeFires <= 0) continue;
        for (let lf = 0; lf < likeFires; lf++) fireRobloxKeys(a, times);
        continue;
      } else if (eventType === 'chat') {
        if (trig === 'chatCommand') {
          if (!matchesCommand(a.text, info.comment)) continue;
        } else if (trig === 'chatUser') {
          const want = String(a.text || '').replace(/^@/, '').trim().toLowerCase();
          if (!want) continue;
          const uname = String(info.username || '').toLowerCase();
          const nname = String(info.nickname || '').toLowerCase();
          if (want !== uname && want !== nname) continue;
        } else {
          continue;
        }
      } else if (trig !== eventType) {
        continue;
      }
      if (!allowFollowSharePerUser(a, eventType, user, 'game')) continue;
      fireRobloxKeys(a, times);
    }
  }

  // ---- Acciones de Roblox 3: misma lógica que Roblox pero con su propia lista ----
  function fireRoblox3Keys(a, times) {
    if (!a || !a.keys) return;
    const units = Math.max(1, Number(times) || 1);
    withGameActionCountTiming(a, units, () => {
      broadcast('log', { level: 'ok', text: `🟥 Roblox 3: "${a.name || a.keys}" → ${a.keys}${units > 1 ? ` ×${units}` : ''}` });
      try { if (typeof onGameExec === 'function') onGameExec('ROBLOX3'); } catch { /* ignore */ }
      emitKeyAction({
        id: 'rbx3_' + (a.slot != null ? a.slot : ''), name: a.name || 'Roblox 3',
        keys: a.keys, gameCompat: true, times: 1, sound: '', soundName: '', soundVolume: 1,
      });
    });
  }
  function triggerRoblox3Actions(eventType, info = {}, user = null, cfg = settings) {
    const list = cfg.roblox3Actions || [];
    if (!list.length) return;
    for (const a of list) {
      if (!a || a.enabled === false || !a.keys) continue;
      const trig = a.trigger || 'gift';
      let times = Math.max(1, parseInt(a.count, 10) || 1);
      if (eventType === 'gift') {
        if (trig === 'gift' || trig === 'gift-any' || trig === 'gift-diamonds') {
          if (!gameGiftTriggerMatches(a, info)) continue;
          times *= Math.max(1, Number(info.repeatCount) || 1);
        } else {
          continue;
        }
        if (!gameComboStreakAllows(a, info)) continue;
      } else if (eventType === 'like') {
        if (trig !== 'like') continue;
        const likeFires = gameLikeTriggerFires(a, info, user, 'roblox3');
        if (likeFires <= 0) continue;
        for (let lf = 0; lf < likeFires; lf++) fireRoblox3Keys(a, times);
        continue;
      } else if (eventType === 'chat') {
        if (trig === 'chatCommand') {
          if (!matchesCommand(a.text, info.comment)) continue;
        } else if (trig === 'chatUser') {
          const want = String(a.text || '').replace(/^@/, '').trim().toLowerCase();
          if (!want) continue;
          const uname = String(info.username || '').toLowerCase();
          const nname = String(info.nickname || '').toLowerCase();
          if (want !== uname && want !== nname) continue;
        } else {
          continue;
        }
      } else if (trig !== eventType) {
        continue;
      }
      if (!allowFollowSharePerUser(a, eventType, user, 'game')) continue;
      fireRoblox3Keys(a, times);
    }
  }

  // ---- Acciones de Mario Bros (SMBX2) vía bridge :7755 ----
  function spawnMarioThing(npcIdOrThing, name, times, actionForTiming) {
    const units = Math.min(999, Math.max(1, Number(times) || 1));
    // Si no hay objeto acción (p. ej. WS marioSpawn), usar timing sintético para
    // que withGameActionCountTiming sí repita N veces (si no, solo spawnea 1).
    const timing = (actionForTiming && typeof actionForTiming === 'object')
      ? actionForTiming
      : { count: units, delayEach: 0, delayBefore: 0 };
    withGameActionCountTiming(timing, units, () => {
      if (npcIdOrThing == null || npcIdOrThing === '') return;
      if (emitLocalExec({ tipo: 'MARIO_SPAWN', thing: npcIdOrThing, name: String(name || ''), times: 1 })) return;
      marioSpawn(npcIdOrThing, name, 1).catch((e) => {
        broadcast('log', { level: 'err', text: `🍄 Mario spawn falló: ${e && e.message || e}` });
      });
    });
  }

  function applyMarioEffect(type, seconds, factor, actionForTiming) {
    withGameActionCountTiming(actionForTiming, 1, () => {
      if (!type) return;
      if (emitLocalExec({
        tipo: 'MARIO_EFFECT', type,
        seconds: Math.min(60, Math.max(1, Number(seconds) || 5)),
        factor: Math.min(10, Math.max(0, Number(factor) || 0)),
      })) return;
      marioEffect(type, seconds, factor).catch(() => {});
    });
  }

  function gameLikeTriggerFires(a, info, user, fallbackKey) {
    return likeTriggerFires(gameLikeAcc, a, info, user, fallbackKey);
  }

  function marioLikeTriggerTimes(a, info, user) {
    return gameLikeTriggerFires(a, info, user, 'mario');
  }

  function triggerMarioActions(eventType, info = {}, user = null, cfg = settings) {
    const list = cfg.marioActions || [];
    if (!list.length) return;
    const name = (user && user.nickname) || info.nickname || '';
    for (const a of list) {
      if (!a || a.enabled === false) continue;
      const hasSpawn = a.thing || a.npcId != null || (a.webhookCmd?.on && a.webhookCmd?.url);
      if (!hasSpawn) continue;
      const trig = a.trigger || 'gift';
      let times = Math.max(1, parseInt(a.count, 10) || 1);
      if (eventType === 'gift') {
        if (trig === 'gift' || trig === 'gift-any' || trig === 'gift-diamonds') {
          if (!gameGiftTriggerMatches(a, info)) continue;
          times *= Math.max(1, Number(info.repeatCount) || 1);
        } else {
          continue;
        }
        if (!gameComboStreakAllows(a, info)) continue;
      } else if (eventType === 'like') {
        if (trig !== 'like') continue;
        const likeFires = marioLikeTriggerTimes(a, info, user);
        if (likeFires <= 0) continue;
        for (let lf = 0; lf < likeFires; lf++) {
          const qty = Math.min(999, Math.max(1, parseInt(a.count, 10) || 1));
          if ((a.kind || 'spawn') === 'effect') {
            broadcast('log', { level: 'ok', text: `🍄 Mario: efecto "${a.thing}" (${a.seconds || 5}s)` });
            applyMarioEffect(a.thing, a.seconds, a.factor, a);
          } else if (a.webhookCmd?.on && a.webhookCmd?.url) {
            // Igual que Probar: quantity en URL = total; times=1 para no multiplicar count².
            const whCmd = {
              ...a.webhookCmd,
              url: applySpawnQuantityToUrl(a.webhookCmd.url, qty),
            };
            const ctx = {
              info: { ...info, repeatCount: qty },
              user: user || { nickname: name, uniqueId: info.username || '' },
              times: 1,
            };
            runActionOutputs({ webhookCmd: whCmd }, cfg, ctx);
            broadcast('log', {
              level: 'ok',
              text: `🍄 Mario WebHook: ${a.label || a.thing || 'spawn'}${qty > 1 ? ` ×${qty}` : ''}`,
            });
          } else {
            broadcast('log', { level: 'ok', text: `🍄 Mario: generar "${a.thing}"${qty > 1 ? ` ×${qty}` : ''}` });
            spawnMarioThing(a.thing ?? a.npcId, name, qty, a);
          }
        }
        continue;
      } else if (eventType === 'chat') {
        if (trig === 'chatCommand') {
          if (!matchesCommand(a.text, info.comment)) continue;
        } else if (trig === 'chatUser') {
          const want = String(a.text || '').replace(/^@/, '').trim().toLowerCase();
          if (!want) continue;
          const uname = String(info.username || '').toLowerCase();
          const nname = String(info.nickname || '').toLowerCase();
          if (want !== uname && want !== nname) continue;
        } else {
          continue;
        }
      } else if (trig !== eventType) {
        continue;
      }
      if (!allowFollowSharePerUser(a, eventType, user, 'game')) continue;
      times = Math.min(999, times);
      if ((a.kind || 'spawn') === 'effect') {
        broadcast('log', { level: 'ok', text: `🍄 Mario: efecto "${a.thing}" (${a.seconds || 5}s)` });
        applyMarioEffect(a.thing, a.seconds, a.factor, a);
      } else if (a.webhookCmd?.on && a.webhookCmd?.url) {
        // Igual que Probar: quantity en URL = total; times=1 para no multiplicar count².
        const whCmd = {
          ...a.webhookCmd,
          url: applySpawnQuantityToUrl(a.webhookCmd.url, times),
        };
        const ctx = {
          info: { ...info, repeatCount: times },
          user: user || { nickname: name, uniqueId: info.username || '' },
          times: 1,
        };
        runActionOutputs({ webhookCmd: whCmd }, cfg, ctx);
        broadcast('log', {
          level: 'ok',
          text: `🍄 Mario WebHook: ${a.label || a.thing || 'spawn'}${times > 1 ? ` ×${times}` : ''}`,
        });
      } else {
        broadcast('log', { level: 'ok', text: `🍄 Mario: generar "${a.thing}"${times > 1 ? ` ×${times}` : ''}` });
        spawnMarioThing(a.thing ?? a.npcId, name, times, a);
      }
    }
  }

  // ---- Acciones de Super Mario Bros. 3 (FCEUX + smb3-bridge.exe :7755) ----
  function spawnSmb3Thing(thing, spawnId, npcId, name, times, actionForTiming) {
    const units = Math.min(200, Math.max(1, Number(times) || 1));
    withGameActionCountTiming(actionForTiming, units, () => {
      if (emitLocalExec({
        tipo: 'SMB3_SPAWN', thing, spawnId, npcId, name: String(name || ''), times: 1,
      })) return;
      smb3Spawn({ thing, spawnId, npcId, name, times: 1 }).catch((e) => {
        broadcast('log', { level: 'err', text: `🎮 SMB3 spawn falló: ${e && e.message || e}` });
      });
    });
  }

  function applySmb3Effect(effect, name, seconds, actionForTiming) {
    withGameActionCountTiming(actionForTiming, 1, () => {
      if (!effect) return;
      if (emitLocalExec({
        tipo: 'SMB3_EFFECT', effect, name: String(name || ''),
        seconds: Math.min(60, Math.max(1, Number(seconds) || 5)),
      })) return;
      smb3Effect(effect, name, seconds).catch(() => {});
    });
  }

  function triggerSmb3Actions(eventType, info = {}, user = null, cfg = settings) {
    const list = cfg.smb3Actions || [];
    if (!list.length) return;
    const name = (user && user.nickname) || info.nickname || '';
    for (const a of list) {
      if (!a || a.enabled === false) continue;
      if ((a.kind || 'spawn') !== 'effect' && !a.thing && a.spawnId == null && a.npcId == null) continue;
      const trig = a.trigger || 'gift';
      let times = Math.max(1, parseInt(a.count, 10) || 1);
      let likeFires = 1;
      if (eventType === 'gift') {
        if (trig === 'gift' || trig === 'gift-any' || trig === 'gift-diamonds') {
          if (!gameGiftTriggerMatches(a, info)) continue;
          times *= Math.max(1, Number(info.repeatCount) || 1);
        } else {
          continue;
        }
        if (!gameComboStreakAllows(a, info)) continue;
      } else if (eventType === 'like') {
        if (trig !== 'like') continue;
        likeFires = gameLikeTriggerFires(a, info, user, 'smb3');
        if (likeFires <= 0) continue;
        times = Math.max(1, parseInt(a.count, 10) || 1) * likeFires;
      } else if (eventType === 'chat') {
        if (trig === 'chatCommand') {
          if (!matchesCommand(a.text, info.comment)) continue;
        } else if (trig === 'chatUser') {
          const want = String(a.text || '').replace(/^@/, '').trim().toLowerCase();
          if (!want) continue;
          const uname = String(info.username || '').toLowerCase();
          const nname = String(info.nickname || '').toLowerCase();
          if (want !== uname && want !== nname) continue;
        } else {
          continue;
        }
      } else if (trig !== eventType) {
        continue;
      }
      if (!allowFollowSharePerUser(a, eventType, user, 'game')) continue;
      times = Math.min(200, times);
      if ((a.kind || 'spawn') === 'effect') {
        broadcast('log', { level: 'ok', text: `🎮 SMB3: efecto "${a.thing}" (${a.seconds || 5}s)` });
        for (let lf = 0; lf < (eventType === 'like' ? likeFires : 1); lf++) {
          applySmb3Effect(a.thing, name, a.seconds, a);
        }
      } else {
        broadcast('log', { level: 'ok', text: `🎮 SMB3: generar "${a.label || a.thing}"${times > 1 ? ` ×${times}` : ''}` });
        spawnSmb3Thing(a.thing, a.spawnId, a.npcId, name, times, a);
      }
    }
  }

  function mari0GiftMatches(a, info) {
    return gameGiftTriggerMatches(a, info);
  }

  // ---- Acciones de Mari0 (webhook :5720 / spawn :5722) ----
  function fireMari0MatchedAction(a, cfg, info, user, name, times, actionForTiming) {
    const qty = Math.min(200, Math.max(1, Number(times) || 1));
    if (a.webhookCmd?.on && a.webhookCmd?.url) {
      const ctx = {
        info: { ...info, repeatCount: qty },
        user: user || {
          nickname: name,
          uniqueId: info.username || info.uniqueId || '',
          photo: info.photo || '',
        },
        times: qty,
      };
      runActionOutputs({ webhookCmd: a.webhookCmd }, cfg, ctx);
      broadcast('log', {
        level: 'ok',
        text: `🌀 Mari0 WebHook: ${a.label || a.thing}${qty > 1 ? ` ×${qty}` : ''}`,
      });
      return;
    }
    if ((a.kind || 'spawn') === 'effect') {
      const dur = a.instant ? '' : (a.seconds ? ` (${a.seconds}s)` : '');
      broadcast('log', { level: 'ok', text: `🌀 Mari0: efecto "${a.label || a.thing}"${dur}` });
      applyMari0Effect(a.thing, a.instant ? null : a.seconds, a.factor, name, actionForTiming);
      return;
    }
    broadcast('log', { level: 'ok', text: `🌀 Mari0: generar "${a.thing}"${qty > 1 ? ` ×${qty}` : ''}` });
    spawnMari0Thing(a.thing, name, qty, actionForTiming);
  }

  function spawnMari0Thing(thing, name, times, actionForTiming) {
    const units = Math.min(200, Math.max(1, Number(times) || 1));
    withGameActionCountTiming(actionForTiming, units, () => {
      if (!thing) return;
      if (emitLocalExec({ tipo: 'MARI0_SPAWN', thing, name: String(name || ''), times: 1 })) return;
      mari0Spawn(thing, name, 1).catch((e) => {
        broadcast('log', { level: 'err', text: `🌀 Mari0 spawn falló: ${e && e.message || e}` });
      });
    });
  }

  function applyMari0Effect(type, seconds, factor, name, actionForTiming) {
    withGameActionCountTiming(actionForTiming, 1, () => {
      if (!type) return;
      const sec = seconds != null && seconds !== '' ? Math.min(60, Math.max(1, Number(seconds) || 0)) : null;
      if (emitLocalExec({
        tipo: 'MARI0_EFFECT', type,
        seconds: sec,
        factor: Math.min(10, Math.max(0, Number(factor) || 0)),
        name: String(name || ''),
      })) return;
      mari0Effect(type, sec, factor, name).catch(() => {});
    });
  }

  function triggerMari0Actions(eventType, info = {}, user = null, cfg = settings) {
    const list = cfg.mari0Actions || [];
    if (!list.length) return;
    const name = (user && user.nickname) || info.nickname || '';
    for (const a of list) {
      if (!a || a.enabled === false) continue;
      const hasSpawn = a.thing || (a.webhookCmd?.on && a.webhookCmd?.url);
      if (!hasSpawn) continue;
      const trig = a.trigger || 'gift';
      let times = Math.max(1, parseInt(a.count, 10) || 1);
      if (eventType === 'gift') {
        if (trig === 'gift' || trig === 'gift-any' || trig === 'gift-diamonds') {
          if (!mari0GiftMatches(a, info)) continue;
          times *= Math.max(1, Number(info.repeatCount) || 1);
        } else {
          continue;
        }
        if (!gameComboStreakAllows(a, info)) continue;
      } else if (eventType === 'like') {
        if (trig !== 'like') continue;
        const likeFires = gameLikeTriggerFires(a, info, user, 'mari0');
        if (likeFires <= 0) continue;
        for (let lf = 0; lf < likeFires; lf++) {
          const qty = Math.min(200, Math.max(1, parseInt(a.count, 10) || 1));
          fireMari0MatchedAction(a, cfg, info, user, name, qty, a);
        }
        continue;
      } else if (eventType === 'chat') {
        if (trig === 'chatCommand') {
          if (!matchesCommand(a.text, info.comment)) continue;
        } else if (trig === 'chatUser') {
          const want = String(a.text || '').replace(/^@/, '').trim().toLowerCase();
          if (!want) continue;
          const uname = String(info.username || '').toLowerCase();
          const nname = String(info.nickname || '').toLowerCase();
          if (want !== uname && want !== nname) continue;
        } else {
          continue;
        }
      } else if (trig !== eventType) {
        continue;
      }
      if (!allowFollowSharePerUser(a, eventType, user, 'game')) continue;
      times = Math.min(200, times);
      fireMari0MatchedAction(a, cfg, info, user, name, times, a);
    }
  }

  // ---- Acciones de Plants vs Zombies (PvZ Toolkit, HTTP :7756 / WS :3132) ----
  function spawnPvzThing(thing, name, times, actionForTiming) {
    const units = Math.min(20, Math.max(1, Number(times) || 1));
    withGameActionCountTiming(actionForTiming, units, () => {
      if (!thing) return;
      if (emitLocalExec({ tipo: 'PVZ_SPAWN', thing, name: String(name || ''), times: 1 })) return;
      pvzSpawn(thing, name, 1).catch(() => { /* bridge/tools no listo */ });
    });
  }

  function givePvzSun(amount, actionForTiming) {
    withGameActionCountTiming(actionForTiming, 1, () => {
      const n = Math.min(9990, Math.max(1, Number(amount) || 50));
      if (emitLocalExec({ tipo: 'PVZ_SUN', amount: n })) return;
      pvzSun(n).catch(() => { /* bridge/tools no listo */ });
    });
  }

  function pvzCommand(p, actionForTiming) {
    withGameActionCountTiming(actionForTiming, 1, () => {
      const cmdPath = String(p || '');
      if (!cmdPath.startsWith('/')) return;
      if (emitLocalExec({ tipo: 'PVZ_CMD', path: cmdPath })) return;
      pvzCmd(cmdPath).catch(() => { /* bridge/tools no listo */ });
    });
  }

  // ---- PvZ Hybrid vía PvZ Tools (bridge HTTP :7757 / WS :3132) ----
  function spawnPvzHybridThing(thing, name, times, label, actionForTiming) {
    const units = Math.min(999, Math.max(1, Number(times) || 1));
    withGameActionCountTiming(actionForTiming, units, () => {
      if (!thing) return;
      if (emitLocalExec({ tipo: 'PVZ_HYBRID_SPAWN', thing, name: String(name || ''), times: 1, label })) return;
      pvzHybridSpawn(thing, name, 1, label).catch(() => { /* bridge/tools no listo */ });
    });
  }

  function givePvzHybridSun(amount, name, label, actionForTiming) {
    withGameActionCountTiming(actionForTiming, 1, () => {
      const n = Math.min(9990, Math.max(1, Number(amount) || 50));
      if (emitLocalExec({ tipo: 'PVZ_HYBRID_SUN', amount: n, name: String(name || ''), label })) return;
      pvzHybridSun(amount, name, label).catch(() => { /* bridge/tools no listo */ });
    });
  }

  function pvzHybridCommand(p, name, label, actionForTiming) {
    withGameActionCountTiming(actionForTiming, 1, () => {
      const cmdPath = String(p || '');
      if (!cmdPath.startsWith('/')) return;
      if (emitLocalExec({ tipo: 'PVZ_HYBRID_CMD', path: cmdPath, name: String(name || ''), label })) return;
      pvzHybridCmd(cmdPath, name, label).catch(() => { /* bridge/tools no listo */ });
    });
  }

  function triggerPvzHybridActions(eventType, info = {}, user = null, cfg = settings) {
    const list = cfg.pvzHybridActions || [];
    if (!list.length) return;
    const name = (user && user.nickname) || info.nickname || '';
    for (const a of list) {
      if (!a || a.enabled === false || !a.thing) continue;
      const trig = a.trigger || 'gift';
      let times = Math.max(1, parseInt(a.count, 10) || 1);
      let likeFires = 1;
      if (eventType === 'gift') {
        if (trig === 'gift' || trig === 'gift-any' || trig === 'gift-diamonds') {
          if (!gameGiftTriggerMatches(a, info)) continue;
          times *= Math.max(1, Number(info.repeatCount) || 1);
        } else continue;
        if (!gameComboStreakAllows(a, info)) continue;
      } else if (eventType === 'like') {
        if (trig !== 'like') continue;
        likeFires = gameLikeTriggerFires(a, info, user, 'pvzhybrid');
        if (likeFires <= 0) continue;
        times = Math.max(1, parseInt(a.count, 10) || 1) * likeFires;
      } else if (eventType === 'chat') {
        if (trig === 'chatCommand') {
          if (!matchesCommand(a.text, info.comment)) continue;
        } else if (trig === 'chatUser') {
          const want = String(a.text || '').replace(/^@/, '').trim().toLowerCase();
          if (!want) continue;
          const uname = String(info.username || '').toLowerCase();
          const nname = String(info.nickname || '').toLowerCase();
          if (want !== uname && want !== nname) continue;
        } else continue;
      } else if (trig !== eventType) continue;
      if (!allowFollowSharePerUser(a, eventType, user, 'game')) continue;
      if ((a.kind || 'spawn') === 'sun') {
        for (let lf = 0; lf < (eventType === 'like' ? likeFires : 1); lf++) {
          broadcast('log', { level: 'ok', text: `🧬 PvZ Hybrid: dar ${a.amount || 50} soles` });
          givePvzHybridSun(a.amount, name, a.label || `+${a.amount || 50} soles`, a);
        }
      } else if ((a.kind || 'spawn') === 'cmd') {
        for (let lf = 0; lf < (eventType === 'like' ? likeFires : 1); lf++) {
          broadcast('log', { level: 'ok', text: `🧬 PvZ Hybrid: ${a.label || a.thing}` });
          pvzHybridCommand(a.path, name, a.label || a.thing, a);
        }
      } else {
        times = Math.min(999, times);
        broadcast('log', { level: 'ok', text: `🧬 PvZ Hybrid: generar "${a.thing}"${times > 1 ? ` ×${times}` : ''}` });
        spawnPvzHybridThing(a.thing, name, times, a.label || a.thing, a);
      }
    }
  }

  function repoActionParams(a) {
    const out = {};
    for (const key of ['health', 'stamina']) {
      const n = Number(a?.[key]);
      if (Number.isFinite(n)) out[key] = n;
    }
    return out;
  }

  function spawnRepoThing(thing, name, times, units, meta = {}, actionForTiming) {
    const unitCount = Math.min(50, Math.max(1, Number(times) || 1));
    withGameActionCountTiming(actionForTiming, unitCount, () => {
      if (!thing) return;
      const spawnKey = resolveRepoSpawnKey(thing);
      const exec = { tipo: 'REPO_SPAWN', thing: spawnKey, name: String(name || ''), times: 1 };
      if (meta.params && typeof meta.params === 'object') exec.params = meta.params;
      if (units != null && Number(units) > 0) exec.units = Math.max(1, Number(units) || 1);
      if (meta.label) exec.label = meta.label;
      if (meta.reason) exec.reason = meta.reason;
      if (meta.giftName) exec.giftName = meta.giftName;
      if (meta.eventType) exec.eventType = meta.eventType;
      if (emitLocalExec(exec)) return;
      repoSpawn(spawnKey, exec.name, 1, exec.params || {}).catch(() => { /* spawns en juego, sin log en panel */ });
    });
  }

  function repoPerUnit(a) {
    const n = parseInt(a?.count, 10);
    return Math.max(1, Number.isFinite(n) && n > 0 ? n : 1);
  }

  function triggerRepoActions(eventType, info = {}, user = null, cfg = settings) {
    const list = cfg.repoActions || [];
    if (!list.length) return;
    const name = (user && user.nickname) || info.nickname || '';
    for (const a of list) {
      if (!a || a.enabled === false || !a.thing) continue;
      const trig = a.trigger || 'gift';
      const perUnit = repoPerUnit(a);
      let units = 1;
      if (eventType === 'gift') {
        if (trig === 'gift' || trig === 'gift-any' || trig === 'gift-diamonds') {
          if (!gameGiftTriggerMatches(a, info)) continue;
          units = Math.max(1, Number(info.repeatCount) || 1);
        } else continue;
        if (!gameComboStreakAllows(a, info)) continue;
      } else if (eventType === 'like') {
        if (trig !== 'like') continue;
        const likeFires = gameLikeTriggerFires(a, info, user, 'repo');
        if (likeFires <= 0) continue;
        const batch = Math.max(1, Number(info.likeCount) || 1);
        const totalQty = Math.min(50, perUnit * likeFires);
        spawnRepoThing(a.thing, name, totalQty, likeFires, {
          label: a.label || a.thing,
          eventType: 'like',
          reason: `${batch} like(s) → ${likeFires} spawn(s)`,
          params: repoActionParams(a),
        }, a);
        continue;
      } else if (eventType === 'chat') {
        if (trig === 'chatCommand') {
          if (!matchesCommand(a.text, info.comment)) continue;
        } else if (trig === 'chatUser') {
          const want = String(a.text || '').replace(/^@/, '').trim().toLowerCase();
          if (!want) continue;
          const uname = String(info.username || '').toLowerCase();
          const nname = String(info.nickname || '').toLowerCase();
          if (want !== uname && want !== nname) continue;
        } else continue;
      } else if (trig !== eventType) continue;
      if (!allowFollowSharePerUser(a, eventType, user, 'game')) continue;

      const times = Math.min(50, perUnit * units);
      const giftLabel = info.giftName ? `Regalo: ${info.giftName}${units > 1 ? ` ×${units}` : ''}` : null;
      spawnRepoThing(a.thing, name, times, units, {
        label: a.label || a.thing,
        eventType,
        giftName: info.giftName,
        reason: giftLabel || eventType,
        params: repoActionParams(a),
      }, a);
    }
  }

  function l4dPerUnit(a) {
    const n = parseInt(a?.count, 10);
    return Math.max(1, Number.isFinite(n) && n > 0 ? n : 1);
  }

  function l4dActionParams(a) {
    const out = {};
    for (const key of ['hp', 'ammo', 'radius', 'seconds']) {
      const n = Number(a?.[key]);
      if (Number.isFinite(n)) out[key] = n;
    }
    return out;
  }

  function spawnL4dThing(thing, name, times, units, meta = {}, actionForTiming) {
    const unitCount = Math.min(20, Math.max(1, Number(times) || 1));
    withGameActionCountTiming(actionForTiming, unitCount, () => {
      if (!thing) return;
      const exec = { tipo: 'L4D_SPAWN', thing: String(thing || ''), name: String(name || ''), times: 1 };
      if (meta.params && typeof meta.params === 'object') exec.params = meta.params;
      if (units != null && Number(units) > 0) exec.units = Math.max(1, Number(units) || 1);
      if (meta.label) exec.label = meta.label;
      if (meta.reason) exec.reason = meta.reason;
      if (meta.giftName) exec.giftName = meta.giftName;
      if (meta.eventType) exec.eventType = meta.eventType;
      if (emitLocalExec(exec)) return;
      l4dSpawn(exec.thing, exec.name, 1, exec.params || {}).catch(() => { /* spawns en juego, sin log en panel */ });
    });
  }

  function triggerL4dActions(eventType, info = {}, user = null, cfg = settings) {
    const list = cfg.l4dActions || [];
    if (!list.length) return;
    const name = (user && user.nickname) || info.nickname || '';
    for (const a of list) {
      if (!a || a.enabled === false || !a.thing) continue;
      const trig = a.trigger || 'gift';
      const perUnit = l4dPerUnit(a);
      let units = 1;
      if (eventType === 'gift') {
        if (trig === 'gift' || trig === 'gift-any' || trig === 'gift-diamonds') {
          if (!gameGiftTriggerMatches(a, info)) continue;
          units = Math.max(1, Number(info.repeatCount) || 1);
        } else continue;
        if (!gameComboStreakAllows(a, info)) continue;
      } else if (eventType === 'like') {
        if (trig !== 'like') continue;
        const likeFires = gameLikeTriggerFires(a, info, user, 'l4d');
        if (likeFires <= 0) continue;
        const batch = Math.max(1, Number(info.likeCount) || 1);
        const totalQty = Math.min(20, perUnit * likeFires);
        spawnL4dThing(a.thing, name, totalQty, likeFires, {
          label: a.label || a.thing,
          eventType: 'like',
          params: l4dActionParams(a),
          reason: `${batch} like(s) → ${likeFires} spawn(s)`,
        }, a);
        continue;
      } else if (eventType === 'chat') {
        if (trig === 'chatCommand') {
          if (!matchesCommand(a.text, info.comment)) continue;
        } else if (trig === 'chatUser') {
          const want = String(a.text || '').replace(/^@/, '').trim().toLowerCase();
          if (!want) continue;
          const uname = String(info.username || '').toLowerCase();
          const nname = String(info.nickname || '').toLowerCase();
          if (want !== uname && want !== nname) continue;
        } else continue;
      } else if (trig !== eventType) continue;
      if (!allowFollowSharePerUser(a, eventType, user, 'game')) continue;

      const times = Math.min(20, perUnit * units);
      const giftLabel = info.giftName ? `Regalo: ${info.giftName}${units > 1 ? ` ×${units}` : ''}` : null;
      spawnL4dThing(a.thing, name, times, units, {
        label: a.label || a.thing,
        eventType,
        giftName: info.giftName,
        params: l4dActionParams(a),
        reason: giftLabel || eventType,
      }, a);
    }
  }

  function gtavKothPerUnit(a) {
    const n = parseInt(a?.count, 10);
    return Math.max(1, Number.isFinite(n) && n > 0 ? n : 1);
  }

  function gtavKothActionParams(a) {
    const out = {};
    for (const key of ['hp', 'ammo', 'radius', 'seconds', 'wanted']) {
      const n = Number(a?.[key]);
      if (Number.isFinite(n)) out[key] = n;
    }
    return out;
  }

  function spawnGtavKothThing(thing, name, times, units, meta = {}, actionForTiming) {
    const unitCount = Math.min(500, Math.max(1, Number(times) || 1));
    // Una sola ejecución con times=N (no N×1) para respetar 200/500 coches.
    withGameActionCountTiming(actionForTiming, 1, () => {
      if (!thing) return;
      const exec = { tipo: 'GTAVKOTH_SPAWN', thing: String(thing || ''), name: String(name || ''), times: unitCount };
      if (meta.params && typeof meta.params === 'object') exec.params = meta.params;
      if (units != null && Number(units) > 0) exec.units = Math.max(1, Number(units) || 1);
      if (meta.label) exec.label = meta.label;
      if (meta.reason) exec.reason = meta.reason;
      if (meta.giftName) exec.giftName = meta.giftName;
      if (meta.eventType) exec.eventType = meta.eventType;
      const label = meta.label || thing;
      const why = meta.reason ? ` (${meta.reason})` : '';
      if (emitLocalExec(exec)) {
        broadcast('log', { level: 'ok', text: `🚗 GTA V KOTH: "${label}" ×${unitCount} → tu PC${why}` });
        return;
      }
      broadcast('log', { level: 'info', text: `🚗 GTA V KOTH: enviando "${label}" ×${unitCount}${why}…` });
      gtavKothSpawn(exec.thing, exec.name, unitCount, exec.params || {})
        .then((r) => {
          if (r && r.ok !== false) {
            broadcast('log', { level: 'ok', text: `🚗 GTA V KOTH: "${label}" OK (${r.via || 'local'} · ${r.sent || unitCount})` });
          } else {
            broadcast('log', {
              level: 'err',
              text: `🚗 GTA V KOTH falló: ${r?.hint || r?.error || 'bridge_no_disponible'} — Conectar + GTA en Historia`,
            });
          }
        })
        .catch((e) => {
          broadcast('log', { level: 'err', text: `🚗 GTA V KOTH falló: ${e?.message || e}` });
        });
    });
  }

  function triggerGtavKothActions(eventType, info = {}, user = null, cfg = settings) {
    const list = cfg.gtavKothActions || [];
    if (!list.length) return;
    const name = (user && user.nickname) || info.nickname || '';
    for (const a of list) {
      if (!a || a.enabled === false || !a.thing) continue;
      const trig = a.trigger || 'gift';
      const perUnit = gtavKothPerUnit(a);
      let units = 1;
      if (eventType === 'gift') {
        if (trig === 'gift' || trig === 'gift-any' || trig === 'gift-diamonds') {
          if (!gameGiftTriggerMatches(a, info)) continue;
          units = Math.max(1, Number(info.repeatCount) || 1);
        } else continue;
        if (!gameComboStreakAllows(a, info)) continue;
      } else if (eventType === 'like') {
        if (trig !== 'like') continue;
        const likeFires = gameLikeTriggerFires(a, info, user, 'gtavkoth');
        if (likeFires <= 0) continue;
        const batch = Math.max(1, Number(info.likeCount) || 1);
        const totalQty = Math.min(500, perUnit * likeFires);
        spawnGtavKothThing(a.thing, name, totalQty, likeFires, {
          label: a.label || a.thing,
          eventType: 'like',
          params: gtavKothActionParams(a),
          reason: `${batch} like(s) → ${likeFires} spawn(s)`,
        }, a);
        continue;
      } else if (eventType === 'chat') {
        if (trig === 'chatCommand') {
          if (!matchesCommand(a.text, info.comment)) continue;
        } else if (trig === 'chatUser') {
          const want = String(a.text || '').replace(/^@/, '').trim().toLowerCase();
          if (!want) continue;
          const uname = String(info.username || '').toLowerCase();
          const nname = String(info.nickname || '').toLowerCase();
          if (want !== uname && want !== nname) continue;
        } else continue;
      } else if (trig !== eventType) continue;
      if (!allowFollowSharePerUser(a, eventType, user, 'game')) continue;

      const times = Math.min(500, perUnit * units);
      const giftLabel = info.giftName ? `Regalo: ${info.giftName}${units > 1 ? ` ×${units}` : ''}` : null;
      spawnGtavKothThing(a.thing, name, times, units, {
        label: a.label || a.thing,
        eventType,
        giftName: info.giftName,
        params: gtavKothActionParams(a),
        reason: giftLabel || eventType,
      }, a);
    }
  }

  function gtavChaosPerUnit(a) {
    const n = parseInt(a?.count, 10);
    return Math.max(1, Number.isFinite(n) && n > 0 ? n : 1);
  }

  function spawnGtavChaosThing(thing, name, times, units, meta = {}, actionForTiming) {
    const unitCount = Math.min(50, Math.max(1, Number(times) || 1));
    withGameActionCountTiming(actionForTiming, 1, () => {
      if (!thing) return;
      const exec = { tipo: 'GTAVCHAOS_SPAWN', thing: String(thing || ''), name: String(name || ''), times: unitCount };
      if (meta.params && typeof meta.params === 'object') exec.params = meta.params;
      if (units != null && Number(units) > 0) exec.units = Math.max(1, Number(units) || 1);
      if (meta.label) exec.label = meta.label;
      if (meta.reason) exec.reason = meta.reason;
      if (meta.giftName) exec.giftName = meta.giftName;
      if (meta.eventType) exec.eventType = meta.eventType;
      const label = meta.label || thing;
      const why = meta.reason ? ` (${meta.reason})` : '';
      if (emitLocalExec(exec)) {
        broadcast('log', { level: 'ok', text: `🌀 GTA V Chaos: "${label}" ×${unitCount} → tu PC${why}` });
        return;
      }
      broadcast('log', { level: 'info', text: `🌀 GTA V Chaos: enviando "${label}" ×${unitCount}${why}…` });
      gtavChaosSpawn(exec.thing, exec.name, unitCount, exec.params || {})
        .then((r) => {
          if (r && r.ok !== false) {
            broadcast('log', { level: 'ok', text: `🌀 GTA V Chaos: "${label}" OK (${r.via || 'local'} · ${r.sent || unitCount})` });
          } else {
            broadcast('log', {
              level: 'err',
              text: `🌀 GTA V Chaos falló: ${r?.hint || r?.error || 'bridge_no_disponible'} — Conectar + GTA en Historia (:6722)`,
            });
          }
        })
        .catch((e) => {
          broadcast('log', { level: 'err', text: `🌀 GTA V Chaos falló: ${e?.message || e}` });
        });
    });
  }

  function triggerGtavChaosActions(eventType, info = {}, user = null, cfg = settings) {
    const list = cfg.gtavChaosActions || [];
    if (!list.length) return;
    const name = (user && user.nickname) || info.nickname || '';
    for (const a of list) {
      if (!a || a.enabled === false || !a.thing) continue;
      const trig = a.trigger || 'gift';
      const perUnit = gtavChaosPerUnit(a);
      let units = 1;
      if (eventType === 'gift') {
        if (trig === 'gift' || trig === 'gift-any' || trig === 'gift-diamonds') {
          if (!gameGiftTriggerMatches(a, info)) continue;
          units = Math.max(1, Number(info.repeatCount) || 1);
        } else continue;
        if (!gameComboStreakAllows(a, info)) continue;
      } else if (eventType === 'like') {
        if (trig !== 'like') continue;
        const likeFires = gameLikeTriggerFires(a, info, user, 'gtavchaos');
        if (likeFires <= 0) continue;
        const batch = Math.max(1, Number(info.likeCount) || 1);
        const totalQty = Math.min(50, perUnit * likeFires);
        spawnGtavChaosThing(a.thing, name, totalQty, likeFires, {
          label: a.label || a.thing,
          eventType: 'like',
          reason: `${batch} like(s) → ${likeFires} spawn(s)`,
        }, a);
        continue;
      } else if (eventType === 'chat') {
        if (trig === 'chatCommand') {
          if (!matchesCommand(a.text, info.comment)) continue;
        } else if (trig === 'chatUser') {
          const want = String(a.text || '').replace(/^@/, '').trim().toLowerCase();
          if (!want) continue;
          const uname = String(info.username || '').toLowerCase();
          const nname = String(info.nickname || '').toLowerCase();
          if (want !== uname && want !== nname) continue;
        } else continue;
      } else if (trig !== eventType) continue;
      if (!allowFollowSharePerUser(a, eventType, user, 'game')) continue;

      const times = Math.min(50, perUnit * units);
      const giftLabel = info.giftName ? `Regalo: ${info.giftName}${units > 1 ? ` ×${units}` : ''}` : null;
      spawnGtavChaosThing(a.thing, name, times, units, {
        label: a.label || a.thing,
        eventType,
        giftName: info.giftName,
        reason: giftLabel || eventType,
      }, a);
    }
  }

  function gtavChiliadPerUnit(a) {
    const n = parseInt(a?.count, 10);
    return Math.max(1, Number.isFinite(n) && n > 0 ? n : 1);
  }

  function spawnGtavChiliadThing(thing, name, times, units, meta = {}, actionForTiming) {
    const unitCount = Math.min(50, Math.max(1, Number(times) || 1));
    withGameActionCountTiming(actionForTiming, 1, () => {
      if (!thing) return;
      const exec = { tipo: 'GTAVCHILIAD_SPAWN', thing: String(thing || ''), name: String(name || ''), times: unitCount };
      if (meta.params && typeof meta.params === 'object') exec.params = meta.params;
      if (units != null && Number(units) > 0) exec.units = Math.max(1, Number(units) || 1);
      if (meta.label) exec.label = meta.label;
      if (meta.reason) exec.reason = meta.reason;
      if (meta.giftName) exec.giftName = meta.giftName;
      if (meta.eventType) exec.eventType = meta.eventType;
      const label = meta.label || thing;
      const why = meta.reason ? ` (${meta.reason})` : '';
      if (emitLocalExec(exec)) {
        broadcast('log', { level: 'ok', text: `⛰️ GTA V Chiliad: "${label}" ×${unitCount} → tu PC${why}` });
        return;
      }
      broadcast('log', { level: 'info', text: `⛰️ GTA V Chiliad: enviando "${label}" ×${unitCount}${why}…` });
      gtavChiliadSpawn(exec.thing, exec.name, unitCount, exec.params || {})
        .then((r) => {
          if (r && r.ok !== false) {
            broadcast('log', { level: 'ok', text: `⛰️ GTA V Chiliad: "${label}" OK (${r.via || 'local'} · ${r.sent || unitCount})` });
          } else {
            broadcast('log', {
              level: 'err',
              text: `⛰️ GTA V Chiliad falló: ${r?.hint || r?.error || 'bridge_no_disponible'} — Conectar + GTA en Historia (:6723)`,
            });
          }
        })
        .catch((e) => {
          broadcast('log', { level: 'err', text: `⛰️ GTA V Chiliad falló: ${e?.message || e}` });
        });
    });
  }

  function triggerGtavChiliadActions(eventType, info = {}, user = null, cfg = settings) {
    const list = cfg.gtavChiliadActions || [];
    if (!list.length) return;
    const name = (user && user.nickname) || info.nickname || '';
    for (const a of list) {
      if (!a || a.enabled === false || !a.thing) continue;
      const trig = a.trigger || 'gift';
      const perUnit = gtavChiliadPerUnit(a);
      let units = 1;
      if (eventType === 'gift') {
        if (trig === 'gift' || trig === 'gift-any' || trig === 'gift-diamonds') {
          if (!gameGiftTriggerMatches(a, info)) continue;
          units = Math.max(1, Number(info.repeatCount) || 1);
        } else continue;
        if (!gameComboStreakAllows(a, info)) continue;
      } else if (eventType === 'like') {
        if (trig !== 'like') continue;
        const likeFires = gameLikeTriggerFires(a, info, user, 'gtavchiliad');
        if (likeFires <= 0) continue;
        const batch = Math.max(1, Number(info.likeCount) || 1);
        const totalQty = Math.min(50, perUnit * likeFires);
        spawnGtavChiliadThing(a.thing, name, totalQty, likeFires, {
          label: a.label || a.thing,
          eventType: 'like',
          reason: `${batch} like(s) → ${likeFires} spawn(s)`,
        }, a);
        continue;
      } else if (eventType === 'chat') {
        if (trig === 'chatCommand') {
          if (!matchesCommand(a.text, info.comment)) continue;
        } else if (trig === 'chatUser') {
          const want = String(a.text || '').replace(/^@/, '').trim().toLowerCase();
          if (!want) continue;
          const uname = String(info.username || '').toLowerCase();
          const nname = String(info.nickname || '').toLowerCase();
          if (want !== uname && want !== nname) continue;
        } else continue;
      } else if (trig !== eventType) continue;
      if (!allowFollowSharePerUser(a, eventType, user, 'game')) continue;

      const times = Math.min(50, perUnit * units);
      const giftLabel = info.giftName ? `Regalo: ${info.giftName}${units > 1 ? ` ×${units}` : ''}` : null;
      spawnGtavChiliadThing(a.thing, name, times, units, {
        label: a.label || a.thing,
        eventType,
        giftName: info.giftName,
        reason: giftLabel || eventType,
      }, a);
    }
  }

  function unturnedPerUnit(a) {
    const n = parseInt(a?.count, 10);
    return Math.max(1, Number.isFinite(n) && n > 0 ? n : 1);
  }

  function unturnedActionParams(a) {
    const out = {};
    const n = Number(a?.amount);
    if (Number.isFinite(n)) out.amount = n;
    return out;
  }

  function spawnUnturnedThing(thing, name, times, units, meta = {}, actionForTiming) {
    const unitCount = Math.min(20, Math.max(1, Number(times) || 1));
    withGameActionCountTiming(actionForTiming, unitCount, () => {
      if (!thing) return;
      const exec = { tipo: 'UNTURNED_SPAWN', thing: String(thing || ''), name: String(name || ''), times: 1 };
      if (meta.params && typeof meta.params === 'object') exec.params = meta.params;
      if (units != null && Number(units) > 0) exec.units = Math.max(1, Number(units) || 1);
      if (meta.label) exec.label = meta.label;
      if (meta.reason) exec.reason = meta.reason;
      if (meta.giftName) exec.giftName = meta.giftName;
      if (meta.eventType) exec.eventType = meta.eventType;
      if (emitLocalExec(exec)) return;
      unturnedSpawn(exec.thing, exec.name, 1, exec.params || {}).catch(() => { /* spawns en juego, sin log en panel */ });
    });
  }

  function triggerUnturnedActions(eventType, info = {}, user = null, cfg = settings) {
    const list = cfg.unturnedActions || [];
    if (!list.length) return;
    const name = (user && user.nickname) || info.nickname || '';
    for (const a of list) {
      if (!a || a.enabled === false || !a.thing) continue;
      const trig = a.trigger || 'gift';
      const perUnit = unturnedPerUnit(a);
      let units = 1;
      if (eventType === 'gift') {
        if (trig === 'gift' || trig === 'gift-any' || trig === 'gift-diamonds') {
          if (!gameGiftTriggerMatches(a, info)) continue;
          units = Math.max(1, Number(info.repeatCount) || 1);
        } else continue;
        if (!gameComboStreakAllows(a, info)) continue;
      } else if (eventType === 'like') {
        if (trig !== 'like') continue;
        const likeFires = gameLikeTriggerFires(a, info, user, 'unturned');
        if (likeFires <= 0) continue;
        const batch = Math.max(1, Number(info.likeCount) || 1);
        const totalQty = Math.min(20, perUnit * likeFires);
        spawnUnturnedThing(a.thing, name, totalQty, likeFires, {
          label: a.label || a.thing,
          eventType: 'like',
          params: unturnedActionParams(a),
          reason: `${batch} like(s) → ${likeFires} spawn(s)`,
        }, a);
        continue;
      } else if (eventType === 'chat') {
        if (trig === 'chatCommand') {
          if (!matchesCommand(a.text, info.comment)) continue;
        } else if (trig === 'chatUser') {
          const want = String(a.text || '').replace(/^@/, '').trim().toLowerCase();
          if (!want) continue;
          const uname = String(info.username || '').toLowerCase();
          const nname = String(info.nickname || '').toLowerCase();
          if (want !== uname && want !== nname) continue;
        } else continue;
      } else if (trig !== eventType) continue;
      if (!allowFollowSharePerUser(a, eventType, user, 'game')) continue;

      const times = Math.min(20, perUnit * units);
      const giftLabel = info.giftName ? `Regalo: ${info.giftName}${units > 1 ? ` ×${units}` : ''}` : null;
      spawnUnturnedThing(a.thing, name, times, units, {
        label: a.label || a.thing,
        eventType,
        giftName: info.giftName,
        params: unturnedActionParams(a),
        reason: giftLabel || eventType,
      }, a);
    }
  }

  function ctrPerUnit(a) {
    const n = parseInt(a?.count, 10);
    return Math.max(1, Number.isFinite(n) && n > 0 ? n : 1);
  }

  function spawnCtrThing(thing, name, times, units, meta = {}, actionForTiming) {
    const unitCount = Math.min(80, Math.max(1, Number(times) || 1));
    withGameActionCountTiming(actionForTiming, unitCount, () => {
      if (!thing) return;
      const exec = { tipo: 'CTR_SPAWN', thing: String(thing || ''), name: String(name || ''), times: 1 };
      if (units != null && Number(units) > 0) exec.units = Math.max(1, Number(units) || 1);
      if (meta.label) exec.label = meta.label;
      if (meta.reason) exec.reason = meta.reason;
      if (meta.giftName) exec.giftName = meta.giftName;
      if (meta.eventType) exec.eventType = meta.eventType;
      if (emitLocalExec(exec)) return;
      ctrSpawn(exec.thing, exec.name, 1).catch(() => { /* efectos en juego, sin log en panel */ });
    });
  }

  function triggerCtrActions(eventType, info = {}, user = null, cfg = settings) {
    const list = cfg.ctrActions || [];
    if (!list.length) return;
    const name = (user && user.nickname) || info.nickname || '';
    for (const a of list) {
      if (!a || a.enabled === false || !a.thing) continue;
      const trig = a.trigger || 'gift';
      const perUnit = ctrPerUnit(a);
      let units = 1;
      if (eventType === 'gift') {
        if (trig === 'gift' || trig === 'gift-any' || trig === 'gift-diamonds') {
          if (!gameGiftTriggerMatches(a, info)) continue;
          units = Math.max(1, Number(info.repeatCount) || 1);
        } else continue;
        if (!gameComboStreakAllows(a, info)) continue;
      } else if (eventType === 'like') {
        if (trig !== 'like') continue;
        const likeFires = gameLikeTriggerFires(a, info, user, 'ctr');
        if (likeFires <= 0) continue;
        const batch = Math.max(1, Number(info.likeCount) || 1);
        const totalQty = Math.min(80, perUnit * likeFires);
        spawnCtrThing(a.thing, name, totalQty, likeFires, {
          label: a.label || a.thing,
          eventType: 'like',
          reason: `${batch} like(s) → ${likeFires} efecto(s)`,
        }, a);
        continue;
      } else if (eventType === 'chat') {
        if (trig === 'chatCommand') {
          if (!matchesCommand(a.text, info.comment)) continue;
        } else if (trig === 'chatUser') {
          const want = String(a.text || '').replace(/^@+/, '').trim().toLowerCase();
          if (!want) continue;
          const uname = String(info.username || '').toLowerCase();
          const nname = String(info.nickname || '').toLowerCase();
          if (want !== uname && want !== nname) continue;
        } else continue;
      } else if (trig !== eventType) continue;
      if (!allowFollowSharePerUser(a, eventType, user, 'game')) continue;

      const times = Math.min(80, perUnit * units);
      const giftLabel = info.giftName ? `Regalo: ${info.giftName}${units > 1 ? ` ×${units}` : ''}` : null;
      spawnCtrThing(a.thing, name, times, units, {
        label: a.label || a.thing,
        eventType,
        giftName: info.giftName,
        reason: giftLabel || eventType,
      }, a);
    }
  }

  function smwPerUnit(a) {
    const n = parseInt(a?.count, 10);
    return Math.max(1, Number.isFinite(n) && n > 0 ? n : 1);
  }

  function spawnSmwThing(thing, name, times, units, meta = {}, actionForTiming) {
    const unitCount = Math.min(40, Math.max(1, Number(times) || 1));
    withGameActionCountTiming(actionForTiming, unitCount, () => {
      if (!thing) return;
      const exec = { tipo: 'SMW_SPAWN', thing: String(thing || ''), name: String(name || ''), times: 1 };
      if (units != null && Number(units) > 0) exec.units = Math.max(1, Number(units) || 1);
      if (meta.label) exec.label = meta.label;
      if (meta.reason) exec.reason = meta.reason;
      if (meta.giftName) exec.giftName = meta.giftName;
      if (meta.eventType) exec.eventType = meta.eventType;
      if (emitLocalExec(exec)) return;
      smwSpawn(exec.thing, exec.name, 1).catch(() => { /* spawns en BizHawk, sin log en panel */ });
    });
  }

  function triggerSmwActions(eventType, info = {}, user = null, cfg = settings) {
    const list = cfg.smwActions || [];
    if (!list.length) return;
    const name = (user && user.nickname) || info.nickname || '';
    for (const a of list) {
      if (!a || a.enabled === false || !a.thing) continue;
      const trig = a.trigger || 'gift';
      const perUnit = smwPerUnit(a);
      let units = 1;
      if (eventType === 'gift') {
        if (trig === 'gift' || trig === 'gift-any' || trig === 'gift-diamonds') {
          if (!gameGiftTriggerMatches(a, info)) continue;
          units = Math.max(1, Number(info.repeatCount) || 1);
        } else continue;
        if (!gameComboStreakAllows(a, info)) continue;
      } else if (eventType === 'like') {
        if (trig !== 'like') continue;
        const likeFires = gameLikeTriggerFires(a, info, user, 'smw');
        if (likeFires <= 0) continue;
        const batch = Math.max(1, Number(info.likeCount) || 1);
        const totalQty = Math.min(40, perUnit * likeFires);
        spawnSmwThing(a.thing, name, totalQty, likeFires, {
          label: a.label || a.thing,
          eventType: 'like',
          reason: `${batch} like(s) → ${likeFires} efecto(s)`,
        }, a);
        continue;
      } else if (eventType === 'chat') {
        if (trig === 'chatCommand') {
          if (!matchesCommand(a.text, info.comment)) continue;
        } else if (trig === 'chatUser') {
          const want = String(a.text || '').replace(/^@+/, '').trim().toLowerCase();
          if (!want) continue;
          const uname = String(info.username || '').toLowerCase();
          const nname = String(info.nickname || '').toLowerCase();
          if (want !== uname && want !== nname) continue;
        } else continue;
      } else if (trig !== eventType) continue;
      if (!allowFollowSharePerUser(a, eventType, user, 'game')) continue;

      const times = Math.min(40, perUnit * units);
      const giftLabel = info.giftName ? `Regalo: ${info.giftName}${units > 1 ? ` ×${units}` : ''}` : null;
      spawnSmwThing(a.thing, name, times, units, {
        label: a.label || a.thing,
        eventType,
        giftName: info.giftName,
        reason: giftLabel || eventType,
      }, a);
    }
  }

  function mslugPerUnit(a) {
    const n = parseInt(a?.count, 10);
    return Math.max(1, Number.isFinite(n) && n > 0 ? n : 1);
  }

  function spawnMslugThing(thing, name, times, units, meta = {}, actionForTiming) {
    const unitCount = Math.min(50, Math.max(1, Number(times) || 1));
    withGameActionCountTiming(actionForTiming, unitCount, () => {
      if (!thing) return;
      const exec = { tipo: 'MSLUG_SPAWN', thing: String(thing || ''), name: String(name || ''), times: 1 };
      if (units != null && Number(units) > 0) exec.units = Math.max(1, Number(units) || 1);
      if (meta.label) exec.label = meta.label;
      if (meta.reason) exec.reason = meta.reason;
      if (meta.giftName) exec.giftName = meta.giftName;
      if (meta.eventType) exec.eventType = meta.eventType;
      if (emitLocalExec(exec)) return;
      mslugSpawn(exec.thing, exec.name, 1).catch(() => { /* spawns en juego, sin log en panel */ });
    });
  }

  function triggerMslugActions(eventType, info = {}, user = null, cfg = settings) {
    const list = cfg.mslugActions || [];
    if (!list.length) return;
    const name = (user && user.nickname) || info.nickname || '';
    for (const a of list) {
      if (!a || a.enabled === false || !a.thing) continue;
      const trig = a.trigger || 'gift';
      const perUnit = mslugPerUnit(a);
      let units = 1;
      if (eventType === 'gift') {
        if (trig === 'gift' || trig === 'gift-any' || trig === 'gift-diamonds') {
          if (!gameGiftTriggerMatches(a, info)) continue;
          units = Math.max(1, Number(info.repeatCount) || 1);
        } else continue;
        if (!gameComboStreakAllows(a, info)) continue;
      } else if (eventType === 'like') {
        if (trig !== 'like') continue;
        const likeFires = gameLikeTriggerFires(a, info, user, 'mslug');
        if (likeFires <= 0) continue;
        const batch = Math.max(1, Number(info.likeCount) || 1);
        const totalQty = Math.min(50, perUnit * likeFires);
        spawnMslugThing(a.thing, name, totalQty, likeFires, {
          label: a.label || a.thing,
          eventType: 'like',
          reason: `${batch} like(s) → ${likeFires} spawn(s)`,
        }, a);
        continue;
      } else if (eventType === 'chat') {
        if (trig === 'chatCommand') {
          if (!matchesCommand(a.text, info.comment)) continue;
        } else if (trig === 'chatUser') {
          const want = String(a.text || '').replace(/^@+/, '').trim().toLowerCase();
          if (!want) continue;
          const uname = String(info.username || '').toLowerCase();
          const nname = String(info.nickname || '').toLowerCase();
          if (want !== uname && want !== nname) continue;
        } else continue;
      } else if (trig !== eventType) continue;
      if (!allowFollowSharePerUser(a, eventType, user, 'game')) continue;

      const times = Math.min(50, perUnit * units);
      const giftLabel = info.giftName ? `Regalo: ${info.giftName}${units > 1 ? ` ×${units}` : ''}` : null;
      spawnMslugThing(a.thing, name, times, units, {
        label: a.label || a.thing,
        eventType,
        giftName: info.giftName,
        reason: giftLabel || eventType,
      }, a);
    }
  }

  const GDASH_EFFECT_SECONDS = {
    reverse: 5,
    spin: 8,
  };

  function gdashSecondsFor(a) {
    const n = parseInt(a?.seconds, 10);
    if (Number.isFinite(n) && n > 0) return n;
    return GDASH_EFFECT_SECONDS[a?.thing] || 10;
  }

  function fireGdashEffect(code, name, seconds, meta = {}) {
    if (!code) return;
    const sec = gdashSecondsFor({ thing: code, seconds });
    const nick = String(name || 'Viewer').trim() || 'Viewer';
    const url = buildGdashEffectUrl(code, nick, sec);
    const exec = { tipo: 'WEBHOOK', method: 'GET', url, label: meta.label, reason: meta.reason };
    if (meta.label || meta.reason) {
      broadcast('log', {
        level: 'ok',
        text: `📐 Geometry Dash: ${meta.label || code}${nick ? ` · ${nick}` : ''}${meta.reason ? ` (${meta.reason})` : ''}`,
      });
    }
    if (emitLocalExec(exec)) return;
    fireGdashEffectRequest(code, nick, sec).catch(() => { /* efecto en juego */ });
  }

  function spawnGdashEffect(code, name, times, meta = {}, actionForTiming) {
    const unitCount = Math.min(50, Math.max(1, Number(times) || 1));
    const seconds = gdashSecondsFor(actionForTiming);
    withGameActionCountTiming(actionForTiming, unitCount, () => {
      fireGdashEffect(code, name, seconds, meta);
    });
  }

  function gdashPerUnit(a) {
    const n = parseInt(a?.count, 10);
    return Math.max(1, Number.isFinite(n) && n > 0 ? n : 1);
  }

  function triggerGdashActions(eventType, info = {}, user = null, cfg = settings) {
    const list = cfg.gdashActions || [];
    if (!list.length) return;
    const name = (user && user.nickname) || info.nickname || '';
    for (const a of list) {
      if (!a || a.enabled === false || !a.thing) continue;
      const trig = a.trigger || 'gift';
      const perUnit = gdashPerUnit(a);
      let units = 1;
      if (eventType === 'gift') {
        if (trig === 'gift' || trig === 'gift-any' || trig === 'gift-diamonds') {
          if (!gameGiftTriggerMatches(a, info)) continue;
          units = Math.max(1, Number(info.repeatCount) || 1);
        } else continue;
        if (!gameComboStreakAllows(a, info)) continue;
      } else if (eventType === 'like') {
        if (trig !== 'like') continue;
        const likeFires = gameLikeTriggerFires(a, info, user, 'gdash');
        if (likeFires <= 0) continue;
        const batch = Math.max(1, Number(info.likeCount) || 1);
        const totalQty = Math.min(50, perUnit * likeFires);
        spawnGdashEffect(a.thing, name, totalQty, {
          label: a.label || a.thing,
          eventType: 'like',
          reason: `${batch} like(s) → ${likeFires} efecto(s)`,
        }, a);
        continue;
      } else if (eventType === 'chat') {
        if (trig === 'chatCommand') {
          if (!matchesCommand(a.text, info.comment)) continue;
        } else if (trig === 'chatUser') {
          const want = String(a.text || '').replace(/^@+/, '').trim().toLowerCase();
          if (!want) continue;
          const uname = String(info.username || '').toLowerCase();
          const nname = String(info.nickname || '').toLowerCase();
          if (want !== uname && want !== nname) continue;
        } else continue;
      } else if (eventType === 'firstMessage') {
        if (trig !== 'firstMessage') continue;
      } else if (trig !== eventType) continue;
      if (!allowFollowSharePerUser(a, eventType, user, 'game')) continue;

      const times = Math.min(50, perUnit * units);
      const giftLabel = info.giftName ? `Regalo: ${info.giftName}${units > 1 ? ` ×${units}` : ''}` : null;
      spawnGdashEffect(a.thing, name, times, {
        label: a.label || a.thing,
        eventType,
        giftName: info.giftName,
        reason: giftLabel || eventType,
      }, a);
    }
  }

  function triggerPvzActions(eventType, info = {}, user = null, cfg = settings) {
    const list = cfg.pvzActions || [];
    if (!list.length) return;
    const name = (user && user.nickname) || info.nickname || '';
    for (const a of list) {
      if (!a || a.enabled === false || !a.thing) continue;
      const trig = a.trigger || 'gift';
      let times = Math.max(1, parseInt(a.count, 10) || 1);
      let likeFires = 1;
      if (eventType === 'gift') {
        if (trig === 'gift' || trig === 'gift-any' || trig === 'gift-diamonds') {
          if (!gameGiftTriggerMatches(a, info)) continue;
          times *= Math.max(1, Number(info.repeatCount) || 1);
        } else {
          continue;
        }
        if (!gameComboStreakAllows(a, info)) continue;
      } else if (eventType === 'like') {
        if (trig !== 'like') continue;
        likeFires = gameLikeTriggerFires(a, info, user, 'pvz');
        if (likeFires <= 0) continue;
        times = Math.max(1, parseInt(a.count, 10) || 1) * likeFires;
      } else if (eventType === 'chat') {
        if (trig === 'chatCommand') {
          if (!matchesCommand(a.text, info.comment)) continue;
        } else if (trig === 'chatUser') {
          const want = String(a.text || '').replace(/^@/, '').trim().toLowerCase();
          if (!want) continue;
          const uname = String(info.username || '').toLowerCase();
          const nname = String(info.nickname || '').toLowerCase();
          if (want !== uname && want !== nname) continue;
        } else {
          continue;
        }
      } else if (trig !== eventType) {
        continue;
      }
      if (!allowFollowSharePerUser(a, eventType, user, 'game')) continue;
      if ((a.kind || 'spawn') === 'sun') {
        for (let lf = 0; lf < (eventType === 'like' ? likeFires : 1); lf++) {
          broadcast('log', { level: 'ok', text: `🧟 PvZ: dar ${a.amount || 50} soles` });
          givePvzSun(a.amount, a);
        }
      } else if ((a.kind || 'spawn') === 'cmd') {
        for (let lf = 0; lf < (eventType === 'like' ? likeFires : 1); lf++) {
          broadcast('log', { level: 'ok', text: `🧟 PvZ: ${a.label || a.thing}` });
          pvzCommand(a.path, a);
        }
      } else {
        times = Math.min(20, times);
        broadcast('log', { level: 'ok', text: `🧟 PvZ: generar "${a.thing}"${times > 1 ? ` ×${times}` : ''}` });
        spawnPvzThing(a.thing, name, times, a);
      }
    }
  }

  // Sustituye variables {var}, {radius} y {random:min max} en un comando.
  function substituteMcCmd(tpl, vars, radius) {
    const map = {
      ...vars,
      streamer: '@p',
      at: '@p',
      radius: (radius != null && radius !== '') ? radius : 3,
    };
    // «execute at {playername}» usa el nombre de TikTok, no un jugador de MC → corregir a @p.
    let out = String(tpl == null ? '' : tpl)
      .replace(/\bexecute\s+at\s+\{(?:playername|nickname|username)\}/gi, 'execute at @p');
    // Varias pasadas por si {radius} queda dentro de {random:…}.
    for (let pass = 0; pass < 6; pass++) {
      const prev = out;
      out = out.replace(/\{(\w+)\}/g, (m, k) => {
        const key = k.toLowerCase();
        return Object.prototype.hasOwnProperty.call(map, key) ? String(map[key]) : m;
      });
      out = out.replace(/\{random:\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\}/gi, (m, a1, b1) => {
        const lo = Math.min(parseFloat(a1), parseFloat(b1));
        const hi = Math.max(parseFloat(a1), parseFloat(b1));
        const isInt = Number.isInteger(parseFloat(a1)) && Number.isInteger(parseFloat(b1));
        const val = lo + Math.random() * (hi - lo);
        return String(isInt ? Math.round(val) : Number(val.toFixed(2)));
      });
      if (out === prev) break;
    }
    // Plugins Bukkit (QualityArmory «qa give») no resuelven @p vía RCON → usar nick configurado.
    const mcTarget = map.mcplayer;
    if (mcTarget && mcTarget !== '@p' && /\bqa\s+/i.test(out)) out = out.replace(/@p\b/g, mcTarget);
    return out;
  }

  // Ejecuta una acción de Minecraft (catálogo o personalizada) por RCON, con repeticiones,
  // delays, comando aleatorio y sustitución de variables.
  function mcCmdText(entry) {
    if (entry == null) return '';
    if (typeof entry === 'string') return entry.trim();
    return String(entry.cmd || entry.text || '').trim();
  }

  function mcActionUsesExtra(a) {
    if (!a) return false;
    if (a.cmdsExtra) return true;
    if (!Array.isArray(a.cmds) || !a.cmds.length) return false;
    return a.cmds.some((x) => x && typeof x === 'object' && (
      x.repeat != null || x.delayEach != null || x.delayBefore != null || x.delayGroup != null
    ));
  }

  function parseMcCmdEntry(entry, defaults) {
    const d = defaults || {};
    const cmd = mcCmdText(entry);
    if (!cmd) return null;
    if (typeof entry === 'string') {
      return {
        cmd,
        repeat: Math.max(1, parseInt(d.repeat, 10) || 1),
        delayEach: Math.max(0, parseInt(d.delayEach, 10) || 0),
        delayBefore: Math.max(0, parseInt(d.delayBefore ?? d.delayGroup, 10) || 0),
        radius: d.radius != null ? d.radius : 3,
      };
    }
    return {
      cmd,
      repeat: Math.max(1, parseInt(entry.repeat, 10) || 1),
      delayEach: Math.max(0, parseInt(entry.delayEach, 10) || 0),
      delayBefore: Math.max(0, parseInt(entry.delayBefore ?? entry.delayGroup, 10) || 0),
      radius: entry.radius != null ? Number(entry.radius) : (d.radius != null ? d.radius : 3),
    };
  }

  function mcActionRunTimes(a, vars) {
    const baseRepeat = Math.max(1, parseInt(a.repeat, 10) || 1);
    const rep = Math.max(1, Number(vars?.repeatcount) || 1);
    // Comandos personalizados: «Veces que se repite» es exacto (sin «Cantidad a enviar»).
    if (a.custom) {
      const times = a.giftMult === false ? baseRepeat : baseRepeat * rep;
      return Math.min(times, 600);
    }
    const qty = Math.max(1, parseInt(a.count, 10) || 1);
    const base = baseRepeat * qty;
    const times = a.giftMult === false ? base : base * rep;
    return Math.min(times, 200);
  }

  // Paralelo: varias "Probar" o regalos a la vez deben solaparse (no esperar a que
  // acaben los N spawns de la acción anterior). Cada acción sigue su propia cola interna.
  function scheduleMcAction(fn) {
    const run = Promise.resolve().then(() => fn());
    run.catch(() => {});
    return run;
  }

  async function runMcActionExtra(a, vars, sendCmds, logMcFail, extra = {}) {
    const token = extra.token ?? mcRunToken();
    const defaults = {
      repeat: a.repeat,
      delayEach: a.delayEach,
      delayGroup: a.delayGroup,
      radius: a.radius,
    };
    let entries = (Array.isArray(a.cmds) ? a.cmds : [])
      .map((e) => parseMcCmdEntry(e, defaults))
      .filter(Boolean);
    if (!entries.length) return;

    const times = mcActionRunTimes(a, vars);
    const delayGroup = extra.skipDelayGroup ? 0 : Math.max(0, parseInt(a.delayGroup, 10) || 0);
    if (a.random) entries = [entries[Math.floor(Math.random() * entries.length)]];

    const steps = [];
    for (const e of entries) {
      steps.push({
        cmd: substituteMcCmd(e.cmd, vars, e.radius),
        repeat: Math.max(1, Number(e.repeat) || 1),
        delayEach: Math.max(0, Number(e.delayEach) || 0),
        delayBefore: Math.max(0, Number(e.delayBefore) || 0),
      });
    }

    const rconCfg = (settings.webhook && settings.webhook.rcon) || {};
    const stapCfg = (settings.webhook && settings.webhook.servertap) || {};
    const useStapRelay = !!stapCfg.enabled;
    if (mcCloudNeedsRelay()) {
      broadcast('log', { level: 'warn', text: '🟩 Minecraft: abre Livecoins (.exe) en tu PC — relay local desconectado' });
      return;
    }
    if (mcRelayExec({
      tipo: 'MINECRAFT_RCON_SEQ',
      conn: useStapRelay ? stapCfg : rconCfg,
      useStap: useStapRelay,
      delayGroup: 0,
      times,
      random: false,
      steps,
      name: a.name || '',
    })) return;

    try {
      const r = await executeMcRconPlan(
        { steps, times, delayGroup, random: false },
        (cmd) => sendCmds([cmd]),
        token,
      );
      if (r.cancelled) {
        if (r.sent > 0) broadcast('log', { level: 'info', text: `⛔ Minecraft: ${a.name} cancelado (${r.sent} enviados)` });
        return;
      }
      if (r.ok) broadcast('log', { level: 'ok', text: `🟩 Minecraft: ${a.name} OK (${r.sent})` });
      else logMcFail(r, r.lastCmd);
    } catch (e) {
      broadcast('log', { level: 'err', text: `🟩 Minecraft "${a.name}" falló: ${e.message}` });
    }
  }

  async function runMcAction(a, vars, opts = {}) {
    const token = mcRunToken();
    const soundTimes = Math.max(1, Number(opts.soundTimes) || 1);
    const rcon = (settings.webhook && settings.webhook.rcon) || {};
    const stap = (settings.webhook && settings.webhook.servertap) || {};
    const useStap = !!stap.enabled;
    const sendCmds = (cmds) => useStap ? sendServertap(stap, cmds) : sendRcon(rcon, cmds);
    const logMcFail = (r, cmd) => {
      const err = r?.error || 'Error desconocido';
      const preview = cmd ? ` · ${String(cmd).slice(0, 90)}…` : '';
      broadcast('log', { level: 'err', text: `🟩 Minecraft "${a.name}" falló: ${err}${preview}` });
    };

    const delayGroup = Math.max(0, parseInt(a.delayGroup, 10) || 0);
    if (!(await mcWait(delayGroup, token))) return;
    playMcActionSound(a, soundTimes);

    const useCmdPlan = mcActionUsesExtra(a);
    if (useCmdPlan) {
      return runMcActionExtra(a, vars, sendCmds, logMcFail, { skipDelayGroup: true, token });
    }

    const lines = (a.custom && Array.isArray(a.cmds) && a.cmds.length)
      ? a.cmds
      : String(a.cmd || '').split(';;');
    const clean = lines.map((x) => mcCmdText(x)).filter(Boolean);
    if (!clean.length) return;
    const times = mcActionRunTimes(a, vars);
    const delayEach = Math.max(0, parseInt(a.delayEach, 10) || 0);
    const queue = [];
    for (let i = 0; i < times; i++) {
      if (a.random) queue.push(substituteMcCmd(clean[Math.floor(Math.random() * clean.length)], vars, a.radius));
      else for (const l of clean) queue.push(substituteMcCmd(l, vars, a.radius));
    }
    if (queue.length > 600) queue.length = 600;

    if (mcCloudNeedsRelay()) {
      broadcast('log', { level: 'warn', text: '🟩 Minecraft: abre Livecoins (.exe) en tu PC — relay local desconectado' });
      return;
    }
    if (mcRelayExec({
      tipo: useStap ? 'SERVERTAP' : 'MINECRAFT_RCON',
      conn: useStap ? stap : rcon,
      commands: queue,
      delayEach,
      name: a.name || '',
    })) return;

    try {
      const r = await executeMcRconQueue(queue, (cmd) => sendCmds([cmd]), { token, delayEach });
      if (r.cancelled) {
        if (r.sent > 0) broadcast('log', { level: 'info', text: `⛔ Minecraft: ${a.name} cancelado (${r.sent}/${queue.length})` });
        return;
      }
      if (r.ok) broadcast('log', { level: 'ok', text: `🟩 Minecraft: ${a.name} OK (${r.sent})` });
      else logMcFail(r, r.lastCmd || queue[0]);
    } catch (e) {
      broadcast('log', { level: 'err', text: `🟩 Minecraft "${a.name}" falló: ${e.message}` });
    }
  }

  function triggerLikeGlobal(total) {
    if (!total || total <= lastTotalLikes) { lastTotalLikes = total || lastTotalLikes; return; }
    const prevTotal = lastTotalLikes;
    triggerActionsLikeGlobal(total);
    processScreenFxLikeGlobal(total, prevTotal);
    const firedLikeVid = new Set();
    forEachTriggerProfile((cfg, isGeneral) => {
      for (const a of (cfg.mcActions || [])) {
        if (!a || a.enabled === false || (a.trigger || '') !== 'likeGlobal') continue;
        if (!a.cmd && !(Array.isArray(a.cmds) && a.cmds.length)) continue;
        const goal = Math.max(1, a.likeN || 100);
        if (Math.floor(total / goal) > Math.floor(lastTotalLikes / goal)) {
          scheduleMcAction(() => runMcAction(a, buildMcVars({ likeCount: total }, null), { soundTimes: 1 }));
        }
      }
      for (const a of (cfg.mcshooterActions || [])) {
        if (!a || a.enabled === false || (a.trigger || '') !== 'likeGlobal') continue;
        if (!a.cmd && !(Array.isArray(a.cmds) && a.cmds.length)) continue;
        const goal = Math.max(1, a.likeN || 100);
        if (Math.floor(total / goal) > Math.floor(lastTotalLikes / goal)) {
          scheduleMcAction(() => runMcAction(a, buildMcVars({ likeCount: total }, null), { soundTimes: 1 }));
        }
      }
      for (const a of (cfg.robloxActions || [])) {
        if (!a || a.enabled === false || (a.trigger || '') !== 'likeGlobal' || !a.keys) continue;
        const goal = Math.max(1, a.likeN || 100);
        if (Math.floor(total / goal) > Math.floor(lastTotalLikes / goal)) fireRobloxKeys(a, Math.max(1, parseInt(a.count, 10) || 1));
      }
      for (const a of (cfg.roblox3Actions || [])) {
        if (!a || a.enabled === false || (a.trigger || '') !== 'likeGlobal' || !a.keys) continue;
        const goal = Math.max(1, a.likeN || 100);
        if (Math.floor(total / goal) > Math.floor(lastTotalLikes / goal)) fireRoblox3Keys(a, Math.max(1, parseInt(a.count, 10) || 1));
      }
      for (const a of (cfg.marioActions || [])) {
        if (!a || a.enabled === false || (a.trigger || '') !== 'likeGlobal' || (!a.thing && a.npcId == null && !a.webhookCmd?.url)) continue;
        const goal = Math.max(1, a.likeN || 100);
        if (Math.floor(total / goal) > Math.floor(lastTotalLikes / goal)) {
          const t = Math.max(1, parseInt(a.count, 10) || 1);
          if ((a.kind || 'spawn') === 'effect') applyMarioEffect(a.thing, a.seconds, a.factor);
          else if (a.webhookCmd?.on && a.webhookCmd?.url) {
            runActionOutputs({ webhookCmd: a.webhookCmd }, cfg, { info: { likeCount: total }, user: null, times: t });
          } else spawnMarioThing(a.thing ?? a.npcId, '', t, a);
        }
      }
      for (const a of (cfg.mari0Actions || [])) {
        if (!a || a.enabled === false || (a.trigger || '') !== 'likeGlobal') continue;
        if (!a.thing && !(a.webhookCmd?.on && a.webhookCmd?.url)) continue;
        const goal = Math.max(1, a.likeN || 100);
        if (Math.floor(total / goal) > Math.floor(lastTotalLikes / goal)) {
          const t = Math.max(1, parseInt(a.count, 10) || 1);
          if ((a.kind || 'spawn') === 'effect') applyMari0Effect(a.thing, a.instant ? null : a.seconds, a.factor, '', a);
          else if (a.webhookCmd?.on && a.webhookCmd?.url) {
            runActionOutputs({ webhookCmd: a.webhookCmd }, cfg, { info: { likeCount: total }, user: null, times: t });
            broadcast('log', { level: 'ok', text: `🌀 Mari0 WebHook (likes globales): ${a.label || a.thing}${t > 1 ? ` ×${t}` : ''}` });
          } else spawnMari0Thing(a.thing, '', t, a);
        }
      }
      for (const a of (cfg.smb3Actions || [])) {
        if (!a || a.enabled === false || (a.trigger || '') !== 'likeGlobal') continue;
        if ((a.kind || 'spawn') !== 'effect' && !a.thing && a.spawnId == null && a.npcId == null) continue;
        const goal = Math.max(1, a.likeN || 100);
        if (Math.floor(total / goal) > Math.floor(lastTotalLikes / goal)) {
          if ((a.kind || 'spawn') === 'effect') applySmb3Effect(a.thing, '', a.seconds, a);
          else spawnSmb3Thing(a.thing, a.spawnId, a.npcId, '', Math.max(1, parseInt(a.count, 10) || 1), a);
        }
      }
      for (const a of (cfg.pvzActions || [])) {
        if (!a || a.enabled === false || (a.trigger || '') !== 'likeGlobal' || !a.thing) continue;
        const goal = Math.max(1, a.likeN || 100);
        if (Math.floor(total / goal) > Math.floor(lastTotalLikes / goal)) {
          if ((a.kind || 'spawn') === 'sun') givePvzSun(a.amount, a);
          else if ((a.kind || 'spawn') === 'cmd') pvzCommand(a.path, a);
          else spawnPvzThing(a.thing, '', Math.max(1, parseInt(a.count, 10) || 1), a);
        }
      }
      for (const a of (cfg.pvzHybridActions || [])) {
        if (!a || a.enabled === false || (a.trigger || '') !== 'likeGlobal' || !a.thing) continue;
        const goal = Math.max(1, a.likeN || 100);
        if (Math.floor(total / goal) > Math.floor(lastTotalLikes / goal)) {
          if ((a.kind || 'spawn') === 'sun') givePvzHybridSun(a.amount, '', a.label || `+${a.amount || 50} soles`, a);
          else if ((a.kind || 'spawn') === 'cmd') pvzHybridCommand(a.path, '', a.label || a.thing, a);
          else spawnPvzHybridThing(a.thing, '', Math.min(999, Math.max(1, parseInt(a.count, 10) || 1)), a.label || a.thing, a);
        }
      }
      for (const a of (cfg.repoActions || [])) {
        if (!a || a.enabled === false || (a.trigger || '') !== 'likeGlobal' || !a.thing) continue;
        const goal = Math.max(1, a.likeN || 100);
        if (Math.floor(total / goal) > Math.floor(lastTotalLikes / goal)) {
          spawnRepoThing(a.thing, '', Math.min(50, Math.max(1, parseInt(a.count, 10) || 1)), 1, { params: repoActionParams(a) }, a);
        }
      }
      for (const a of (cfg.l4dActions || [])) {
        if (!a || a.enabled === false || (a.trigger || '') !== 'likeGlobal' || !a.thing) continue;
        const goal = Math.max(1, a.likeN || 100);
        if (Math.floor(total / goal) > Math.floor(lastTotalLikes / goal)) {
          spawnL4dThing(a.thing, '', Math.min(20, Math.max(1, parseInt(a.count, 10) || 1)), 1, { params: l4dActionParams(a) }, a);
        }
      }
      for (const a of (cfg.gtavKothActions || [])) {
        if (!a || a.enabled === false || (a.trigger || '') !== 'likeGlobal' || !a.thing) continue;
        const goal = Math.max(1, a.likeN || 100);
        if (Math.floor(total / goal) > Math.floor(lastTotalLikes / goal)) {
          spawnGtavKothThing(a.thing, '', Math.min(500, Math.max(1, parseInt(a.count, 10) || 1)), 1, { params: gtavKothActionParams(a) }, a);
        }
      }
      for (const a of (cfg.gtavChaosActions || [])) {
        if (!a || a.enabled === false || (a.trigger || '') !== 'likeGlobal' || !a.thing) continue;
        const goal = Math.max(1, a.likeN || 100);
        if (Math.floor(total / goal) > Math.floor(lastTotalLikes / goal)) {
          spawnGtavChaosThing(a.thing, '', Math.min(50, Math.max(1, parseInt(a.count, 10) || 1)), 1, {}, a);
        }
      }
      for (const a of (cfg.gtavChiliadActions || [])) {
        if (!a || a.enabled === false || (a.trigger || '') !== 'likeGlobal' || !a.thing) continue;
        const goal = Math.max(1, a.likeN || 100);
        if (Math.floor(total / goal) > Math.floor(lastTotalLikes / goal)) {
          spawnGtavChiliadThing(a.thing, '', Math.min(50, Math.max(1, parseInt(a.count, 10) || 1)), 1, {}, a);
        }
      }
      for (const a of (cfg.unturnedActions || [])) {
        if (!a || a.enabled === false || (a.trigger || '') !== 'likeGlobal' || !a.thing) continue;
        const goal = Math.max(1, a.likeN || 100);
        if (Math.floor(total / goal) > Math.floor(lastTotalLikes / goal)) {
          spawnUnturnedThing(a.thing, '', Math.min(20, Math.max(1, parseInt(a.count, 10) || 1)), 1, { params: unturnedActionParams(a) }, a);
        }
      }
      for (const a of (cfg.ctrActions || [])) {
        if (!a || a.enabled === false || (a.trigger || '') !== 'likeGlobal' || !a.thing) continue;
        const goal = Math.max(1, a.likeN || 100);
        if (Math.floor(total / goal) > Math.floor(lastTotalLikes / goal)) {
          spawnCtrThing(a.thing, '', Math.min(80, Math.max(1, parseInt(a.count, 10) || 1)), 1, {}, a);
        }
      }
      for (const a of (cfg.smwActions || [])) {
        if (!a || a.enabled === false || (a.trigger || '') !== 'likeGlobal' || !a.thing) continue;
        const goal = Math.max(1, a.likeN || 100);
        if (Math.floor(total / goal) > Math.floor(lastTotalLikes / goal)) {
          spawnSmwThing(a.thing, '', Math.min(40, Math.max(1, parseInt(a.count, 10) || 1)), 1, {}, a);
        }
      }
      for (const a of (cfg.mslugActions || [])) {
        if (!a || a.enabled === false || (a.trigger || '') !== 'likeGlobal' || !a.thing) continue;
        const goal = Math.max(1, a.likeN || 100);
        if (Math.floor(total / goal) > Math.floor(lastTotalLikes / goal)) {
          spawnMslugThing(a.thing, '', Math.min(50, Math.max(1, parseInt(a.count, 10) || 1)), 1, {}, a);
        }
      }
      for (const a of (cfg.gdashActions || [])) {
        if (!a || a.enabled === false || (a.trigger || '') !== 'likeGlobal' || !a.thing) continue;
        const goal = Math.max(1, a.likeN || 100);
        if (Math.floor(total / goal) > Math.floor(lastTotalLikes / goal)) {
          spawnGdashEffect(a.thing, 'Livecoins', Math.min(50, Math.max(1, parseInt(a.count, 10) || 1)), {
            label: a.label || a.thing,
            eventType: 'likeGlobal',
            reason: `${total} likes globales`,
          }, a);
        }
      }
      for (const a of cfg.soundAlerts) {
        if (!a.enabled || !a.sound || (a.trigger || '') !== 'likeGlobal') continue;
        const goal = Math.max(1, a.likeGoal || 100);
        const before = Math.floor(lastTotalLikes / goal);
        const now = Math.floor(total / goal);
        if (now > before) {
          emitSound({ id: a.id, name: a.name, sound: a.sound, image: a.image, volume: a.volume });
        }
      }
      if (cfg.videosEnabled !== false) {
        for (const v of cfg.videos) {
          if (!v.url || v.enabled === false || (v.trigger || '') !== 'likeGlobal') continue;
          const goal = Math.max(1, v.likeGoal || 100);
          if (Math.floor(total / goal) > Math.floor(lastTotalLikes / goal)) {
            const scr = clampMediaScreen(v.screen);
            const dedupeKey = `${v.id || v.url}|${scr}`;
            if (firedLikeVid.has(dedupeKey)) continue;
            firedLikeVid.add(dedupeKey);
            emitProfileMedia(cfg, v, scr, isGeneral);
          }
        }
      }
    });
    lastTotalLikes = total;
  }

  function triggerVideos(eventType, info = {}, user = null, times = 1) {
    // Evita el mismo video en la misma pantalla 2 veces (perfil activo + Perfil General).
    const fireTimes = Math.max(1, Math.min(50, Number(times) || 1));
    const fired = new Set();
    forEachTriggerProfile((cfg, isGeneral) => {
      if (cfg.videosEnabled === false) return;
      for (const v of cfg.videos) {
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
          const likeFires = gameLikeTriggerFires(v, info, user, `vid_${v.id}`);
          if (likeFires <= 0) continue;
          const scr = clampMediaScreen(v.screen);
          const dedupeKey = `${v.id || v.url}|${scr}`;
          if (fired.has(dedupeKey)) continue;
          fired.add(dedupeKey);
          for (let lf = 0; lf < likeFires; lf++) {
            emitProfileMedia(cfg, v, scr, isGeneral);
          }
          continue;
        }
        if (eventType === 'levelUp') {
          const wantLevel = Math.max(0, Number(v.level) || 0);
          if (wantLevel > 0 && wantLevel !== Number(info.level || 0)) continue;
        }
        if (eventType === 'chatCommand') {
          if (!matchesCommand(v.command, info.comment)) continue;
        }
        if (eventType === 'chatCommand' || eventType === 'firstMessage' || eventType === 'userJoin') {
          const want = String(v.user || '').replace(/^@/, '').trim();
          if (eventType === 'userJoin' && !want) continue;
          if (want) {
            if (!tiktokUserMatches(want, info.username, info.nickname)) continue;
          }
        }
        if (eventType === 'firstMessage') {
          // Sin delay elegido (vacío/0) → solo su primer mensaje del live (una vez por usuario).
          // Con delay > 0 → puede repetirse si calla >= delay s y vuelve a escribir.
          const fmDelay = (v.joinDelay == null) ? 0 : Math.max(0, Number(v.joinDelay) || 0);
          if (!claimFirstMessageSlot(info, `${v.id}|${isGeneral ? 'g' : 'a'}`, fmDelay)) continue;
        }
        if (eventType === 'userJoin') {
          const delaySec = (v.joinDelay == null) ? 30 : Math.max(0, Number(v.joinDelay) || 0);
          if (delaySec > 0) {
            const now = Date.now();
            const who = normTikTokUser(info.username) || normTikTokUser(info.nickname) || 'any';
            const cdKey = `${v.id}|${isGeneral ? 'g' : 'a'}|${who}`;
            const last = joinVideoCooldown.get(cdKey) || 0;
            if (now - last < delaySec * 1000) continue;
            joinVideoCooldown.set(cdKey, now);
          }
        }
        if (eventType === 'emote') {
          if (!allowFollowSharePerUser(v, eventType, user || { uniqueId: info.username, nickname: info.nickname }, `vid_${isGeneral ? 'g' : 'a'}`)) continue;
        }
        const scr = clampMediaScreen(v.screen);
        const dedupeKey = `${v.id || v.url}|${scr}`;
        if (fired.has(dedupeKey)) continue;
        fired.add(dedupeKey);
        for (let t = 0; t < fireTimes; t++) {
          emitProfileMedia(cfg, v, scr, isGeneral);
        }
      }
    });
  }

  // Anti-doble + anti-escalera: TikTok a veces manda el salto a pedazos
  // (1→2→3…→28) o duplica el mismo evento. Solo disparamos UNA vez el nivel final.
  const memberLevelUpLastFired = new Map(); // uniqueId -> { ts, level }
  const pendingMemberLevelUps = new Map(); // uniqueId -> { fromLevel, toLevel, data, timer }
  const MEMBER_LEVEL_UP_DEBOUNCE_MS = 1500;

  function flushMemberLevelUp(uid) {
    const pending = pendingMemberLevelUps.get(uid);
    pendingMemberLevelUps.delete(uid);
    if (!pending) return;
    const { fromLevel, toLevel, data } = pending;
    if (!uid || toLevel <= fromLevel) return;
    const now = Date.now();
    const last = memberLevelUpLastFired.get(uid);
    if (last && (now - last.ts) < 2500 && toLevel <= last.level) return;
    memberLevelUpLastFired.set(uid, { ts: now, level: toLevel });
    const user = baseUser(data?.user || data);
    const lvl = toLevel;
    const info = {
      username: uid,
      nickname: user.nickname,
      level: lvl,
      fromLevel,
      toLevel: lvl,
    };
    broadcast('log', { level: 'ok', text: `⬆️ ${user.nickname} subió a nivel de miembro ${lvl} (antes ${fromLevel})` });
    triggerVideos('levelUp', info);
    triggerSoundAlerts('levelUp', info);
    triggerActions('levelUp', info, user);
    triggerMinecraftActions('levelUp', info, user);
    processScreenFxTriggers('levelUp', info, user);
    playLevelVideo(lvl);
  }

  function emitMemberLevelUp(data, fromLevel, toLevel) {
    const user = baseUser(data?.user || data);
    const uid = user.uniqueId;
    if (!uid || toLevel <= fromLevel) return;
    const existing = pendingMemberLevelUps.get(uid);
    if (existing) {
      try { clearTimeout(existing.timer); } catch {}
      existing.fromLevel = Math.min(existing.fromLevel, fromLevel);
      existing.toLevel = Math.max(existing.toLevel, toLevel);
      existing.data = data;
      existing.timer = setTimeout(() => flushMemberLevelUp(uid), MEMBER_LEVEL_UP_DEBOUNCE_MS);
      return;
    }
    pendingMemberLevelUps.set(uid, {
      fromLevel,
      toLevel,
      data,
      timer: setTimeout(() => flushMemberLevelUp(uid), MEMBER_LEVEL_UP_DEBOUNCE_MS),
    });
  }

  // Detecta cuándo un usuario SUBE su nivel de miembro (insignia junto al nombre).
  // TikTok no envía un evento propio, así que recordamos el último nivel visto de
  // cada usuario (al chatear, regalar o entrar) y, si en una interacción posterior
  // su nivel es mayor, disparamos el evento 'levelUp'. Solo se detecta dentro de la
  // sesión: necesitamos haber visto su nivel anterior al menos una vez.
  function checkMemberLevelUp(data) {
    const user = baseUser(data?.user || data);
    const uid = user.uniqueId;
    if (!uid) return;
    const level = Number(chatUserRoles(data).memberLevel || 0);
    if (!level) return; // sin insignia de nivel: nada que comparar
    const prev = memberLevels.get(uid);
    memberLevels.set(uid, level);
    if (prev == null || level <= prev) return; // primera vez o no subió
    emitMemberLevelUp(data, prev, level);
  }

  // Reproduce automáticamente el video de public/video/niveles (nivelN.webm).
  function playLevelVideo(level, screenOverride) {
    const cfg = settings.levelVideos || {};
    if (cfg.enabled === false) return;
    if (typeof getLevelVideo !== 'function') return;
    const n = Math.max(1, Number(level) || 1);
    const url = getLevelVideo(n);
    if (!url) {
      broadcast('log', { level: 'warn', text: `⚠️ No hay video para nivel ${n} (nivel${n}.webm en public/video/niveles).` });
      return;
    }
    const scr = Math.max(1, Math.min(10, Number(screenOverride) || Number(cfg.screen) || 1));
    const payload = {
      id: 'level_' + n,
      name: `Nivel ${n}`,
      url,
      screen: scr,
      volume: cfg.volume ?? 100,
      size: screenSize(scr),
    };
    broadcast('log', { level: 'ok', text: `🎬 Video de nivel ${n} → pantalla ${scr}.` });
    // Por broadcastMedia: solo llega a las fuentes de ESA pantalla (mismo filtro
    // servidor que el resto de videos). En relay también va a la PC.
    const body = broadcastMedia(payload);
    if (IS_CLOUD_ROOM && hasLocalRelayClient()) {
      broadcastToLocal('playMedia', body);
    }
  }

  // Cuenta atrás PK → dispara battleLast10 una vez al cruzar ≤10s.
  let battleEndAtMs = 0;
  let battleLast10Fired = false;
  let battleCountdownTimer = null;

  function clearBattleCountdown() {
    if (battleCountdownTimer) {
      clearInterval(battleCountdownTimer);
      battleCountdownTimer = null;
    }
    battleEndAtMs = 0;
    battleLast10Fired = false;
  }

  function parseBattleEndMs(bs) {
    if (!bs || typeof bs !== 'object') return 0;
    const endMs = Number(bs.endTimeMs) || 0;
    if (endMs > 0) return endMs;
    const startMs = Number(bs.startTimeMs) || 0;
    let dur = Number(bs.duration) || 0;
    const extraSec = Number(bs.extraDurationSecond) || 0;
    // TikTok suele mandar duration en segundos (p.ej. 300); si es enorme, ya es ms.
    if (dur > 0 && dur <= 7200) dur *= 1000;
    const total = dur + extraSec * 1000;
    if (startMs && total) return startMs + total;
    if (total) return Date.now() + total;
    return 0;
  }

  function syncBattleCountdown(bs) {
    const end = parseBattleEndMs(bs);
    if (!end || end < Date.now() - 2000) return;
    battleEndAtMs = end;
    ensureBattleCountdownTick();
  }

  function ensureBattleCountdownTick() {
    if (battleCountdownTimer) return;
    battleCountdownTimer = setInterval(() => {
      if (!state.inBattle || !battleEndAtMs) {
        if (!state.inBattle) clearBattleCountdown();
        return;
      }
      const remainSec = Math.ceil((battleEndAtMs - Date.now()) / 1000);
      if (!battleLast10Fired && remainSec <= 10 && remainSec >= 0) {
        battleLast10Fired = true;
        broadcast('log', { level: 'ok', text: `⚔️ Batalla: quedan ${remainSec}s` });
        fireBattleAlerts('battleLast10', { remaining: remainSec });
      }
      if (remainSec < 0 && battleCountdownTimer) {
        clearInterval(battleCountdownTimer);
        battleCountdownTimer = null;
      }
    }, 400);
  }

  // Animaciones de batalla PK: 'critical' (x2), 'critical3' (x3),
  // 'battleGift' = potenciador guante / multiplicador (NO el regalo Boxing Gloves),
  // 'battleGiftAny', 'battleStart', 'battleEnd', 'battleLast10'.
  function fireBattleAlerts(actionType, info = {}) {
    let matched = 0;
    // Igual que videos/sonidos: perfil activo + Perfil General, sin repetir el mismo clip.
    const fired = new Set();
    forEachTriggerProfile((cfg, isGeneral) => {
      if (cfg.battleAlertsEnabled === false) return;
      for (const b of (cfg.battleAlerts || [])) {
        if (!b.url || b.enabled === false) continue;
        const trig = b.trigger || ((b.giftName || b.giftId) ? 'battleGift' : 'battleGiftAny');
        if (trig !== actionType) continue;
        if (actionType === 'battleGift') {
          // Potenciador guante: minCount = multiplicador mínimo (1/2 = x2+, 3 = x3+).
          const minMult = Math.max(1, Number(b.minCount) || 1);
          const m = Math.max(2, Number(info.multiplier) || 2);
          if (m < minMult) continue;
        }
        if (actionType === 'battleGiftAny') {
          const count = info.repeatCount || info.giftCount || 1;
          if ((b.minCount || 1) > count) continue;
        }
        const scr = Number(b.screen) || 1;
        const dedupeKey = `${b.id || b.url}|${scr}`;
        if (fired.has(dedupeKey)) continue;
        fired.add(dedupeKey);
        matched += 1;
        broadcast('log', { level: 'ok', text: `⚔️ Animación de batalla [${actionType}]: "${b.name}"` });
        // Mismo carril que los videos: las del Perfil General van marcadas como
        // "general" y respetan playQueue (antes se mezclaban con el perfil activo).
        emitProfileMedia(cfg, b, scr, isGeneral);
      }
    });
    if (!matched && (actionType === 'critical' || actionType === 'critical3' || actionType === 'battleGift')) {
      broadcast('log', {
        level: 'warn',
        text: `⚡ Multiplicador detectado (${actionType}) pero no hay animación ON con ese disparo + video. Revisa Batallas → x2 / x3 / potenciador.`,
      });
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

  /* ---------------------- Spotify Song Requests (solo .exe) ---------------------- */
  function spotifyBalance(uniqueId) {
    const key = String(uniqueId || '').trim().replace(/^@/, '').toLowerCase();
    return points.get(key)?.total || 0;
  }
  function pushSpotifyQueue() {
    broadcast('spotifyQueue', {
      queue: spotifyQueue.map((q) => ({
        uniqueId: q.uniqueId,
        nickname: q.nickname,
        name: q.name,
        artists: q.artists,
        image: q.image,
        durationMs: q.durationMs || 0,
      })),
    });
  }
  function pushSpotifyHistory() {
    broadcast('spotifyHistory', { history: spotifyHistory });
  }
  function pushSpotifyNowPlaying() {
    broadcast('spotifyNowPlaying', { track: spotifyNowPlaying });
  }

  async function pollSpotifyPlayback() {
    if (!clients.size || !spotify.isConnected(id)) return;
    let state;
    try { state = await spotify.getPlaybackState(id); } catch { return; }
    if (!state?.uri) {
      if (spotifyNowPlaying) {
        spotifyNowPlaying = null;
        lastSpotifyUri = '';
        pushSpotifyNowPlaying();
      }
      return;
    }

    let requestedBy = spotifyNowPlaying?.requestedBy || '';
    let requestedUniqueId = spotifyNowPlaying?.requestedUniqueId || '';
    if (state.uri !== lastSpotifyUri) {
      requestedBy = '';
      requestedUniqueId = '';
      const idx = spotifyQueue.findIndex((q) => q.uri === state.uri);
      if (idx !== -1) {
        requestedBy = spotifyQueue[idx].nickname || '';
        requestedUniqueId = spotifyQueue[idx].uniqueId || '';
        spotifyQueue.splice(idx, 1);
        pushSpotifyQueue();
        spotifyHistory.unshift({
          at: Date.now(),
          user: requestedBy,
          track: `${state.name} — ${state.artists}`,
          status: 'Reproduciendo',
        });
        if (spotifyHistory.length > 50) spotifyHistory.length = 50;
        pushSpotifyHistory();
      }
      lastSpotifyUri = state.uri;
    }

    spotifyNowPlaying = {
      name: state.name,
      artists: state.artists,
      image: state.image,
      uri: state.uri,
      progressMs: state.progressMs,
      durationMs: state.durationMs,
      playing: state.playing,
      requestedBy,
      requestedUniqueId,
      serverTs: Date.now(),
    };
    pushSpotifyNowPlaying();
  }

  function startSpotifyPoller() {
    if (spotifyPollTimer) return;
    spotifyPollTimer = setInterval(() => { pollSpotifyPlayback().catch(() => {}); }, 3000);
    spotifyPollTimer.unref?.();
    pollSpotifyPlayback().catch(() => {});
  }

  function stopSpotifyPoller() {
    if (spotifyPollTimer) { clearInterval(spotifyPollTimer); spotifyPollTimer = null; }
  }

  function spotifyUserAllowed(cfg, user, roles) {
    if (!cfg) return false;
    if (cfg.permAll) return true;
    if (cfg.permMods && roles?.isMod) return true;
    if (cfg.permSubs && roles?.isSub) return true;
    if (!cfg.permUsersOn) return false;
    const list = Array.isArray(cfg.permUsers) ? cfg.permUsers : [];
    if (!list.length) return false;
    const username = user?.uniqueId || '';
    const nickname = user?.nickname || '';
    // Compara @uniqueId y nickname (con normalización), igual que el resto de filtros TikTok.
    return list.some((want) => tiktokUserMatches(want, username, nickname));
  }

  async function handleSpotifyCommands(comment, user, roles) {
    const cfg = settings.spotify;
    if (!cfg) return;
    const text = String(comment || '').trim();
    const lower = text.toLowerCase();
    let kind = null, arg = '';
    if (lower === '!skip') kind = 'skip';
    else if (lower === '!revoke') kind = 'revoke';
    else if (lower.startsWith('!play')) { kind = 'play'; arg = text.slice(5).trim(); }
    if (!kind) return;

    // Permisos: todos / mods / super fans-subs / usuarios @ específicos.
    const allowed = spotifyUserAllowed(cfg, user, roles);
    if (!allowed) return;

    // Anti-spam por usuario (3s).
    const now = Date.now();
    if (now - (spotifyCooldown.get(user.uniqueId) || 0) < 3000) return;
    spotifyCooldown.set(user.uniqueId, now);

    if (!spotify.isConnected(id)) {
      broadcast('log', { level: 'warn', text: '🎵 Spotify no está conectado. Conéctalo en la pestaña Spotify.' });
      return;
    }

    const reply = (txt, ok = true) => {
      broadcast('spotifyCommand', { user: user.nickname, text: txt, ok });
      broadcast('log', { level: ok ? 'ok' : 'warn', text: '🎵 ' + txt });
    };
    const addHistory = (track, status) => {
      spotifyHistory.unshift({ at: Date.now(), user: user.nickname, track, status });
      if (spotifyHistory.length > 50) spotifyHistory.length = 50;
      pushSpotifyHistory();
    };
    const charge = async (cost, desc) => {
      cost = Math.max(0, parseInt(cost, 10) || 0);
      if (cost <= 0) return true;
      // En modo relay (.exe), los puntos viven en la nube (fuente de verdad): delegamos
      // la comprobación + cobro a Render. Si no hay saldo, devuelve ok:false.
      if (typeof chargeSpotifyRemote === 'function') {
        let r = null;
        try { r = await chargeSpotifyRemote({ uniqueId: user.uniqueId, nickname: user.nickname, photo: user.photo, cost, desc }); } catch {}
        if (!r || !r.ok) { reply(`${user.nickname}: necesitas ${cost} puntos.`, false); return false; }
        return true;
      }
      if (spotifyBalance(user.uniqueId) < cost) { reply(`${user.nickname}: necesitas ${cost} puntos.`, false); return false; }
      addUserPoints({ uniqueId: user.uniqueId, nickname: user.nickname, photo: user.photo, amount: -cost, counted: false, description: desc });
      return true;
    };

    if (kind === 'play') {
      if (cfg.playOn === false) return;
      if (!arg) { reply('Uso: !play Canción - Artista', false); return; }
      const total = spotifyQueue.length;
      const userCount = spotifyQueue.filter((q) => q.uniqueId === user.uniqueId).length;
      if (total >= Math.max(1, cfg.queueTotal)) { reply('La cola está llena, intenta más tarde.', false); return; }
      if (userCount >= Math.max(1, cfg.queueUser)) { reply(`${user.nickname}: ya tienes el máximo en cola.`, false); return; }
      let track = null;
      try { track = await spotify.searchTrack(id, arg); } catch {}
      if (!track) { reply(`No encontré "${arg}".`, false); return; }
      if (track.explicit && cfg.explicit === false) { reply(`"${track.name}" es explícita y no está permitida.`, false); return; }
      if (!(await charge(cfg.playCost, 'Spotify !play'))) return;
      let ok = false;
      try { ok = await spotify.addToQueue(id, track.uri); } catch {}
      if (!ok) { reply('No pude añadir a la cola (¿Spotify está reproduciendo una playlist?).', false); return; }
      spotifyQueue.push({
        uniqueId: user.uniqueId,
        nickname: user.nickname,
        name: track.name,
        artists: track.artists,
        image: track.image,
        uri: track.uri,
        durationMs: track.durationMs || 0,
        at: Date.now(),
      });
      pushSpotifyQueue();
      addHistory(`${track.name} — ${track.artists}`, 'En cola');
      reply(`Añadida: ${track.name} — ${track.artists} (por ${user.nickname})`);
      pollSpotifyPlayback().catch(() => {});
      return;
    }

    if (kind === 'skip') {
      if (cfg.skipOn === false) return;
      // Opción: solo saltar canción propia (no las de otros ni las del streamer).
      // skipOwnOnlyStrict: también aplica a mods. skipOwnOnly: los mods sí pueden saltar cualquiera.
      const enforceOwnSkip = !!cfg.skipOwnOnlyStrict || (!!cfg.skipOwnOnly && !roles?.isMod);
      if (enforceOwnSkip) {
        const owner = normTikTokUser(spotifyNowPlaying?.requestedUniqueId);
        const me = normTikTokUser(user.uniqueId);
        if (!owner) {
          reply(`${user.nickname}: no puedes saltar las pistas del streamer.`, false);
          return;
        }
        if (owner !== me) {
          reply(`${user.nickname}: solo puedes saltar tu propia canción.`, false);
          return;
        }
      }
      if (!(await charge(cfg.skipCost, 'Spotify !skip'))) return;
      let ok = false;
      try { ok = await spotify.skipNext(id); } catch {}
      if (!ok) { reply('No pude saltar la pista.', false); return; }
      // La pista actual ya salió de la cola al empezar a sonar; no hacer shift aquí.
      pollSpotifyPlayback().catch(() => {});
      addHistory('—', 'Saltada');
      reply(`${user.nickname} saltó la pista.`);
      return;
    }

    if (kind === 'revoke') {
      // Spotify no permite quitar de su cola; revocamos de nuestra lista/overlay.
      const rev = [...spotifyQueue].reverse().findIndex((q) => q.uniqueId === user.uniqueId);
      if (rev === -1) { reply(`${user.nickname}: no tienes canciones para revocar.`, false); return; }
      const realIdx = spotifyQueue.length - 1 - rev;
      const removed = spotifyQueue.splice(realIdx, 1)[0];
      pushSpotifyQueue();
      addHistory(`${removed.name} — ${removed.artists}`, 'Revocada');
      reply(`${user.nickname} revocó: ${removed.name}`);
      return;
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
      broadcast('log', {
        level: 'ok',
        text: `⚡ Multiplicador x${m} en batalla PK → animación${src2 ? ' [' + src2 + ']' : ''}`,
      });
      // x2 → critical ; x3+ → critical3 (opciones separadas en el panel)
      if (m >= 3) fireBattleAlerts('critical3', { multiplier: m });
      else fireBattleAlerts('critical', { multiplier: m });
      // «Potenciador guante / multiplicador» (cualquier x2+)
      fireBattleAlerts('battleGift', { multiplier: m });
    }, 350);
  }

  /** Detecta x2/x3 / guante crítico en un payload TikTok y dispara animaciones. */
  function detectBattleMultiplier(payload, src = '', { giftOnlyMatchInfo = false } = {}) {
    let acc;
    if (giftOnlyMatchInfo) {
      acc = readMatchInfoMultiplier(payload?.matchInfo || payload?.match_info);
    } else {
      acc = readBattleMultiplier(payload);
    }
    if (!(acc.crit || acc.value >= 2)) {
      // Si el card se apaga, permitir disparar de nuevo la próxima vez que se active.
      if (giftOnlyMatchInfo) {
        const mi = payload?.matchInfo || payload?.match_info;
        if (mi && mi.effectCardInUse === false && Number(mi.multiplierType || 0) === 0) {
          state.battleMult.active = false;
          state.battleMult.value = 0;
        }
      }
      return false;
    }
    state.inBattle = true;
    const m = Math.max(2, Number(acc.value) || 2);
    const newlyOn = !state.battleMult.active;
    const upgraded = m > (state.battleMult.value || 0);
    state.battleMult.active = true;
    state.battleMult.value = Math.max(state.battleMult.value || 0, m);
    // Solo al entrar el potenciador o al subir (x2→x3). Evita spam en cada regalo.
    if (!newlyOn && !upgraded) return false;
    const label = src || (acc.hits.length ? acc.hits.slice(0, 4).join(' ') : 'battle');
    noteCritical(m, label);
    return true;
  }

  function resetBattleMultiplierState() {
    state.battleMult.active = false;
    state.battleMult.value = 0;
    state.pendingMult = 0;
    state.pendingSrc = '';
    if (state.criticalTimer) {
      try { clearTimeout(state.criticalTimer); } catch {}
      state.criticalTimer = null;
    }
  }

  /* ------------------------------- Estado ------------------------------- */
  function topGifters(limit = 10) {
    return [...state.gifters.values()].sort((a, b) => b.diamonds - a.diamonds).slice(0, limit);
  }
  function serializeState() {
    return {
      username: state.username || settings.tiktokUser || null,
      nickname: followerCounter.nickname || state.username || null,
      photo: followerCounter.photo || settings.tiktokPhoto || '',
      connected: state.connected,
      connecting: state.connecting,
      autoConnect: settings.autoConnect !== false,
      roomId: state.roomId,
      startedAt: state.startedAt,
      stats: state.stats,
      topGifters: topGifters(),
    };
  }
  function pushState() {
    broadcast('state', serializeState());
  }

  // Al conectar, TikTok entrega la info de la sala con totales ACUMULADOS desde que
  // empezó el live: likes totales, espectadores actuales y total de entradas. Los
  // sembramos para no empezar en 0 aunque te conectes al panel a mitad del live.
  // NOTA: TikTok NO expone el histórico de diamantes/regalos/comentarios/follows/
  // shares; esos solo llegan como eventos en vivo, así que solo se cuentan desde
  // que el panel está conectado (no hay forma de recuperarlos hacia atrás).
  function pickAvatarUrl(u) {
    if (!u || typeof u !== 'object') return '';
    return u.profilePictureUrl || u.profile_picture_url
      || (Array.isArray(u.avatarThumb?.url) && u.avatarThumb.url[0])
      || (Array.isArray(u.avatarThumb?.urlList) && u.avatarThumb.urlList[0])
      || (Array.isArray(u.avatar_thumb?.url_list) && u.avatar_thumb.url_list[0])
      || (Array.isArray(u.profilePicture?.url) && u.profilePicture.url[0])
      || (Array.isArray(u.profilePicture?.urls) && u.profilePicture.urls[0])
      || '';
  }
  function extractFollowerFromRoomInfo(ri, username) {
    const out = { count: null, nickname: '', uniqueId: username || '', photo: '', userId: '' };
    if (!ri) return out;
    const d = ri.data || ri;
    const users = [d?.owner, d?.user, d?.anchor, d?.liveRoom?.owner, ri?.user, ri?.liveRoomUserInfo?.user].filter(Boolean);
    for (const u of users) {
      if (!out.nickname && u.nickname) out.nickname = u.nickname;
      if (!out.uniqueId && (u.uniqueId || u.display_id || u.displayId)) out.uniqueId = u.uniqueId || u.display_id || u.displayId;
      if (!out.photo) out.photo = pickAvatarUrl(u);
      if (!out.userId) {
        const id = u.userId ?? u.user_id ?? u.id;
        if (id != null && String(id) !== '0') out.userId = String(id);
      }
      const fc = Number(
        u?.follow_info?.follower_count ?? u?.followInfo?.followerCount
        ?? u?.stats?.followerCount ?? u?.follower_count ?? u?.followerCount,
      );
      if (Number.isFinite(fc) && fc >= 0) { out.count = Math.floor(fc); break; }
    }
    if (out.count == null) {
      const fc = Number(d?.stats?.followerCount ?? d?.follower_count ?? d?.followerCount);
      if (Number.isFinite(fc) && fc >= 0) out.count = Math.floor(fc);
    }
    return out;
  }
  function serializeFollowerCounter() {
    ensureFocMetricsFresh();
    const followers = Math.max(0, Math.floor(Number(followerCounter.count) || 0));
    const likesLive = Math.max(0, Math.floor(Number(state.stats.likes) || 0));
    const diamondsLive = Math.max(0, Math.floor(Number(state.stats.diamonds) || 0));
    const likesWeek = Math.max(0, Math.floor(Number(focMetrics.likes.week.total) || 0));
    const likesMonth = Math.max(0, Math.floor(Number(focMetrics.likes.month.total) || 0));
    const diamondsWeek = Math.max(0, Math.floor(Number(focMetrics.diamonds.week.total) || 0));
    const diamondsMonth = Math.max(0, Math.floor(Number(focMetrics.diamonds.month.total) || 0));
    const metric = normalizeFocMetric(settings.followerCounter?.metric);
    const period = normalizeResetPeriod(settings.followerCounter?.resetPeriod);
    let count = followers;
    if (metric === 'likes') count = period === 'week' ? likesWeek : period === 'month' ? likesMonth : likesLive;
    else if (metric === 'diamonds') count = period === 'week' ? diamondsWeek : period === 'month' ? diamondsMonth : diamondsLive;
    return {
      count,
      followers,
      likesLive, likesWeek, likesMonth,
      diamondsLive, diamondsWeek, diamondsMonth,
      metric, resetPeriod: period,
      nickname: followerCounter.nickname,
      uniqueId: followerCounter.uniqueId,
      photo: followerCounter.photo,
      userId: followerCounter.userId,
      ready: followerCounter.ready || metric !== 'followers',
    };
  }
  function broadcastFollowerCounter() {
    broadcast('followerCounter', serializeFollowerCounter());
  }
  function normalizeFocMetric(m) {
    return m === 'likes' || m === 'diamonds' ? m : 'followers';
  }
  function emptyFocBucket(period) {
    const [start, end] = period === 'month' ? currentMonthRange() : currentWeekRange();
    return { start, end, total: 0 };
  }
  let focMetrics = {
    likes: { week: emptyFocBucket('week'), month: emptyFocBucket('month') },
    diamonds: { week: emptyFocBucket('week'), month: emptyFocBucket('month') },
  };
  let focMetricsSaveTimer = null;
  function loadFocMetrics() {
    const raw = readJsonSafe(FOC_METRICS_FILE).data || {};
    for (const kind of ['likes', 'diamonds']) {
      for (const period of ['week', 'month']) {
        const [start, end] = period === 'month' ? currentMonthRange() : currentWeekRange();
        const saved = raw[kind]?.[period];
        if (saved && saved.start === start && Number.isFinite(Number(saved.total))) {
          focMetrics[kind][period] = { start, end, total: Math.max(0, Math.floor(Number(saved.total) || 0)) };
        } else {
          focMetrics[kind][period] = { start, end, total: 0 };
        }
      }
    }
  }
  function saveFocMetrics() {
    clearTimeout(focMetricsSaveTimer);
    focMetricsSaveTimer = setTimeout(() => {
      try {
        writeJsonAtomic(FOC_METRICS_FILE, {
          likes: focMetrics.likes,
          diamonds: focMetrics.diamonds,
        });
      } catch { /* ignore */ }
    }, 400);
  }
  function ensureFocMetricsFresh() {
    for (const kind of ['likes', 'diamonds']) {
      for (const period of ['week', 'month']) {
        const [start, end] = period === 'month' ? currentMonthRange() : currentWeekRange();
        const cur = focMetrics[kind][period];
        if (!cur || cur.start !== start) {
          focMetrics[kind][period] = { start, end, total: 0 };
          saveFocMetrics();
        } else {
          cur.end = end;
        }
      }
    }
  }
  function bumpFocMetrics(kind, amount) {
    const n = Math.max(0, Math.floor(Number(amount) || 0));
    if (kind !== 'likes' && kind !== 'diamonds') return;
    if (n > 0) {
      ensureFocMetricsFresh();
      focMetrics[kind].week.total += n;
      focMetrics[kind].month.total += n;
      saveFocMetrics();
    }
    const uses = [settings.followerCounter, settings.followerCounterMc].some((c) => normalizeFocMetric(c?.metric) === kind);
    if (uses) broadcastFollowerCounter();
  }
  function resetFocMetricTotals(kind, period) {
    if (kind !== 'likes' && kind !== 'diamonds') return;
    ensureFocMetricsFresh();
    if (period === 'week' || period === 'month') {
      focMetrics[kind][period].total = 0;
      saveFocMetrics();
    }
  }
  loadFocMetrics();

  function bumpFollowerCounter(delta, raw) {
    const abs = Number(raw?.followCount);
    if (Number.isFinite(abs) && abs > 0) followerCounter.count = Math.floor(abs);
    else followerCounter.count = Math.max(0, (followerCounter.count || 0) + (delta || 0));
    followerCounter.ready = true;
    broadcastFollowerCounter();
  }
  function seedFollowerCounterFromRoomInfo() {
    const parsed = extractFollowerFromRoomInfo(connection?.roomInfo, state.username);
    if (parsed.count != null) followerCounter.count = parsed.count;
    if (parsed.nickname) followerCounter.nickname = parsed.nickname;
    if (parsed.uniqueId) followerCounter.uniqueId = parsed.uniqueId;
    if (parsed.photo) {
      followerCounter.photo = parsed.photo;
      rememberTikTokPhoto(parsed.photo);
    }
    if (parsed.userId) followerCounter.userId = parsed.userId;
    followerCounter.ready = parsed.count != null;
    if (!followerCounter.uniqueId && state.username) followerCounter.uniqueId = state.username;
    if (!followerCounter.userId) {
      const oid = pkRoomOwnerUserId();
      if (oid) followerCounter.userId = oid;
    }
    broadcastFollowerCounter();
  }
  function resetFollowerCounterFromRoom() {
    if (connection?.roomInfo) seedFollowerCounterFromRoomInfo();
    else {
      followerCounter.count = 0;
      followerCounter.ready = false;
    }
    const metric = normalizeFocMetric(settings.followerCounter?.metric);
    const period = normalizeResetPeriod(settings.followerCounter?.resetPeriod);
    if ((metric === 'likes' || metric === 'diamonds') && (period === 'week' || period === 'month')) {
      resetFocMetricTotals(metric, period);
    }
    const metricMc = normalizeFocMetric(settings.followerCounterMc?.metric);
    const periodMc = normalizeResetPeriod(settings.followerCounterMc?.resetPeriod);
    if ((metricMc === 'likes' || metricMc === 'diamonds') && (periodMc === 'week' || periodMc === 'month')) {
      if (metricMc !== metric || periodMc !== period) resetFocMetricTotals(metricMc, periodMc);
    }
    broadcastFollowerCounter();
  }
  function socialDisplayType(data) {
    return String(data?.common?.displayText?.displayType || data?.displayType || '').toLowerCase();
  }
  function seedStatsFromRoomInfo() {
    try {
      const ri = connection && connection.roomInfo;
      if (!ri) return;
      const d = ri.data || ri;
      const st = d.stats || {};
      const likes = Number(d.like_count ?? st.like_count ?? 0) || 0;
      const viewers = Number(d.user_count ?? st.user_count ?? d.viewerCount ?? 0) || 0;
      const entradas = Number(st.total_user ?? d.total_user ?? 0) || 0;
      if (likes > state.stats.likes) { state.stats.likes = likes; lastTotalLikes = Math.max(lastTotalLikes, likes); }
      if (viewers > 0) {
        state.stats.viewers = viewers;
        state.stats.peakViewers = Math.max(Number(state.stats.peakViewers) || 0, viewers);
      }
      if (entradas > state.stats.joins) state.stats.joins = entradas;
      seedFollowerCounterFromRoomInfo();
      pushState();
    } catch { /* roomInfo opcional: si falla, seguimos contando desde 0 */ }
  }
  function resetStats() {
    state.stats = { viewers: 0, peakViewers: 0, likes: 0, diamonds: 0, comments: 0, gifts: 0, follows: 0, shares: 0, joins: 0 };
    state.gifters.clear();
    chatSeenUsers.clear();
    chatLastAt.clear();
    joinVideoCooldown.clear();
    recentChatKeys.clear();
    recentChatOrder.length = 0;
    fanCoinAcc.clear();
    fanLikeAcc.clear();
    gameLikeAcc.clear();
    recentSubs.clear();
    recentSuperFans.clear();
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

  /* ------------------------- Top 1 Donador Fuego ------------------------- */
  function getTop1FirePeriod() {
    const p = settings.top1fire?.resetPeriod;
    return p === 'week' || p === 'month' ? p : 'live';
  }
  function loadTop1Fire() {
    const period = getTop1FirePeriod();
    lastTop1FirePeriod = period;
    if (period === 'live') {
      top1fireSession.clear();
      return;
    }
    const [start, end] = period === 'month' ? currentMonthRange() : currentWeekRange();
    const r = readJsonSafe(TOP1FIRE_FILE);
    const raw = r.data;
    if (raw && raw.period === period && raw.start === start) {
      top1fire.period = period;
      top1fire.start = start;
      top1fire.end = end;
      top1fire.donors = new Map((raw.donors || []).map((u) => [u.uniqueId, u]));
      return;
    }
    top1fire.period = period;
    top1fire.start = start;
    top1fire.end = end;
    top1fire.donors = new Map();
  }
  function saveTop1Fire() {
    if (getTop1FirePeriod() === 'live') return;
    clearTimeout(top1fireSaveTimer);
    top1fireSaveTimer = setTimeout(() => {
      const data = {
        period: top1fire.period,
        start: top1fire.start,
        end: top1fire.end,
        donors: [...top1fire.donors.values()],
      };
      writeJsonAtomic(TOP1FIRE_FILE, data);
    }, 400);
  }
  function ensureTop1FirePeriod() {
    const period = getTop1FirePeriod();
    if (period === 'live') return;
    const [start, end] = period === 'month' ? currentMonthRange() : currentWeekRange();
    if (period !== top1fire.period || start !== top1fire.start) {
      top1fire.period = period;
      top1fire.start = start;
      top1fire.end = end;
      top1fire.donors.clear();
      saveTop1Fire();
      broadcastTop1Fire();
    }
  }
  function onTop1FireSettingsChange() {
    const period = getTop1FirePeriod();
    if (period === lastTop1FirePeriod) return;
    lastTop1FirePeriod = period;
    top1fireSession.clear();
    loadTop1Fire();
    broadcastTop1Fire();
  }
  function addTop1FireDonation(user, coins) {
    if (!user?.uniqueId || !(coins > 0)) return;
    const period = getTop1FirePeriod();
    if (period === 'live') {
      const u = top1fireSession.get(user.uniqueId) || { uniqueId: user.uniqueId, nickname: user.nickname, photo: user.photo, coins: 0 };
      u.coins += coins;
      u.nickname = user.nickname || u.nickname;
      if (user.photo) u.photo = user.photo;
      top1fireSession.set(user.uniqueId, u);
      broadcastTop1Fire();
      saveSessionOverlays();
      return;
    }
    ensureTop1FirePeriod();
    const u = top1fire.donors.get(user.uniqueId) || { uniqueId: user.uniqueId, nickname: user.nickname, photo: user.photo, coins: 0 };
    u.coins += coins;
    u.nickname = user.nickname || u.nickname;
    if (user.photo) u.photo = user.photo;
    top1fire.donors.set(user.uniqueId, u);
    saveTop1Fire();
    broadcastTop1Fire();
  }
  function serializeTop1Fire() {
    const period = getTop1FirePeriod();
    let donors;
    if (period === 'live') {
      donors = [...top1fireSession.values()];
    } else {
      ensureTop1FirePeriod();
      donors = [...top1fire.donors.values()];
    }
    const sorted = donors.sort((a, b) => b.coins - a.coins);
    const top = sorted[0] || null;
    return {
      top: top ? { uniqueId: top.uniqueId, nickname: top.nickname, profilePictureUrl: top.photo, coins: top.coins } : null,
      period,
      periodStart: period === 'live' ? 0 : top1fire.start,
      periodEnd: period === 'live' ? 0 : top1fire.end,
      now: Date.now(),
    };
  }
  function broadcastTop1Fire() {
    broadcast('top1fire', serializeTop1Fire());
  }
  function resetTop1FireSession() {
    if (getTop1FirePeriod() !== 'live') return;
    top1fireSession.clear();
    broadcast('top1fireReset', {});
    broadcastTop1Fire();
  }
  function resetTop1FireAll() {
    top1fireSession.clear();
    top1fire.donors.clear();
    if (getTop1FirePeriod() !== 'live') saveTop1Fire();
    broadcast('top1fireReset', {});
    broadcastTop1Fire();
  }

  /* ------------------------- Habibi Top Donador ------------------------- */
  function getHabibiTopPeriod() {
    const p = settings.habibiTop?.resetPeriod;
    return p === 'week' || p === 'month' ? p : 'live';
  }
  function habibiDonorPhoto(u) {
    if (!u) return '';
    return String(u.photo || u.profilePictureUrl || '').trim();
  }
  function restoreHabibiDonor(u) {
    const entry = { ...u };
    const snapPhoto = habibiTopSnapshot && entry.uniqueId === habibiTopSnapshot.uniqueId
      ? habibiDonorPhoto(habibiTopSnapshot) : '';
    const photo = habibiDonorPhoto(entry) || snapPhoto;
    if (photo) entry.photo = photo;
    return entry;
  }
  function updateHabibiTopSnapshot(top) {
    if (!top?.uniqueId) return;
    const photo = habibiDonorPhoto(top) || habibiDonorPhoto(habibiTopSnapshot);
    habibiTopSnapshot = {
      uniqueId: top.uniqueId,
      nickname: top.nickname || top.uniqueId,
      photo,
      profilePictureUrl: photo,
      coins: Number(top.coins) || 0,
    };
  }
  function buildHabibiTopPayload(top) {
    if (!top) return null;
    let photo = habibiDonorPhoto(top);
    if (!photo && habibiTopSnapshot && top.uniqueId === habibiTopSnapshot.uniqueId) {
      photo = habibiDonorPhoto(habibiTopSnapshot);
    }
    return {
      uniqueId: top.uniqueId,
      nickname: top.nickname || top.uniqueId,
      profilePictureUrl: photo,
      photo,
      coins: top.coins || 0,
    };
  }
  function readHabibiTopFile() {
    const r = readJsonSafe(HABIBI_TOP_FILE);
    if (r.data) return r.data;
    if (!r.corrupt) return null;
    try {
      const dir = path.dirname(HABIBI_TOP_FILE);
      const base = path.basename(HABIBI_TOP_FILE);
      const candidates = fs.readdirSync(dir)
        .filter((f) => f.startsWith(base + '.corrupt'))
        .map((f) => path.join(dir, f))
        .sort((a, b) => (fs.statSync(b).mtimeMs || 0) - (fs.statSync(a).mtimeMs || 0));
      for (const file of candidates) {
        const rr = readJsonSafe(file);
        if (rr.data && typeof rr.data === 'object') return rr.data;
      }
    } catch {}
    return null;
  }
  function reconcileHabibiTopFromSnapshot() {
    if (!habibiTopSnapshot?.uniqueId || habibiTop.donors.size > 0) return false;
    const snap = restoreHabibiDonor(habibiTopSnapshot);
    if (!(Number(snap.coins) > 0) && !snap.nickname) return false;
    habibiTop.donors.set(snap.uniqueId, snap);
    saveHabibiTop();
    console.log('  [habibiTop] Donador restaurado desde topSnapshot:', snap.nickname || snap.uniqueId);
    return true;
  }
  function loadHabibiTop() {
    const period = getHabibiTopPeriod();
    lastHabibiTopPeriod = period;
    if (period === 'live') {
      habibiTopSession.clear();
      return;
    }
    const [start, end] = period === 'month' ? currentMonthRange() : currentWeekRange();
    const raw = readHabibiTopFile();
    habibiTopSnapshot = raw?.topSnapshot && typeof raw.topSnapshot === 'object' ? raw.topSnapshot : null;
    if (raw && raw.period === period && raw.start === start) {
      habibiTop.period = period;
      habibiTop.start = start;
      habibiTop.end = end;
      habibiTop.donors = new Map((raw.donors || []).map((u) => [u.uniqueId, restoreHabibiDonor(u)]));
      reconcileHabibiTopFromSnapshot();
      return;
    }
    habibiTop.period = period;
    habibiTop.start = start;
    habibiTop.end = end;
    habibiTop.donors = new Map();
    habibiTopSnapshot = null;
  }
  function saveHabibiTop() {
    if (getHabibiTopPeriod() === 'live') return;
    clearTimeout(habibiTopSaveTimer);
    habibiTopSaveTimer = setTimeout(() => {
      const data = {
        period: habibiTop.period,
        start: habibiTop.start,
        end: habibiTop.end,
        donors: [...habibiTop.donors.values()],
        topSnapshot: habibiTopSnapshot,
      };
      writeJsonAtomic(HABIBI_TOP_FILE, data);
    }, 400);
  }
  function ensureHabibiTopPeriod() {
    const period = getHabibiTopPeriod();
    if (period === 'live') return;
    const [start, end] = period === 'month' ? currentMonthRange() : currentWeekRange();
    if (period !== habibiTop.period || start !== habibiTop.start) {
      habibiTop.period = period;
      habibiTop.start = start;
      habibiTop.end = end;
      habibiTop.donors.clear();
      habibiTopSnapshot = null;
      saveHabibiTop();
      broadcastHabibiTop();
    }
  }
  function onHabibiTopSettingsChange() {
    const period = getHabibiTopPeriod();
    if (period === lastHabibiTopPeriod) return;
    lastHabibiTopPeriod = period;
    habibiTopSession.clear();
    habibiTopSnapshot = null;
    loadHabibiTop();
    broadcastHabibiTop();
  }
  function addHabibiTopDonation(user, coins) {
    if (!user?.uniqueId || !(coins > 0)) return;
    const period = getHabibiTopPeriod();
    const incomingPhoto = habibiDonorPhoto(user);
    if (period === 'live') {
      const u = habibiTopSession.get(user.uniqueId) || { uniqueId: user.uniqueId, nickname: user.nickname, photo: '', coins: 0 };
      u.coins += coins;
      u.nickname = user.nickname || u.nickname;
      if (incomingPhoto) u.photo = incomingPhoto;
      habibiTopSession.set(user.uniqueId, u);
      broadcastHabibiTop();
      saveSessionOverlays();
      return;
    }
    ensureHabibiTopPeriod();
    const u = habibiTop.donors.get(user.uniqueId) || { uniqueId: user.uniqueId, nickname: user.nickname, photo: '', coins: 0 };
    u.coins += coins;
    u.nickname = user.nickname || u.nickname;
    if (incomingPhoto) u.photo = incomingPhoto;
    habibiTop.donors.set(user.uniqueId, u);
    broadcastHabibiTop();
    saveHabibiTop();
  }
  function serializeHabibiTop() {
    const period = getHabibiTopPeriod();
    let donors;
    if (period === 'live') {
      donors = [...habibiTopSession.values()];
    } else {
      ensureHabibiTopPeriod();
      donors = [...habibiTop.donors.values()];
    }
    const sorted = donors.sort((a, b) => b.coins - a.coins);
    let rawTop = sorted[0] || null;
    if (!rawTop && habibiTopSnapshot?.uniqueId) rawTop = restoreHabibiDonor(habibiTopSnapshot);
    const top = buildHabibiTopPayload(rawTop);
    if (top) updateHabibiTopSnapshot(top);
    return {
      top,
      period,
      periodStart: period === 'live' ? 0 : habibiTop.start,
      periodEnd: period === 'live' ? 0 : habibiTop.end,
      now: Date.now(),
    };
  }
  function broadcastHabibiTop() {
    broadcast('habibiTop', serializeHabibiTop());
  }
  function resetHabibiTopSession() {
    if (getHabibiTopPeriod() !== 'live') return;
    habibiTopSession.clear();
    habibiTopSnapshot = null;
    broadcast('habibiTopReset', {});
    broadcastHabibiTop();
  }
  function resetHabibiTopAll() {
    habibiTopSession.clear();
    habibiTop.donors.clear();
    habibiTopSnapshot = null;
    if (getHabibiTopPeriod() !== 'live') saveHabibiTop();
    else saveSessionOverlays();
    broadcast('habibiTopReset', {});
    broadcastHabibiTop();
  }

  /* -------------------- Rankings likes / diamantes (overlays) -------------------- */
  function getRankPeriod(rankId) {
    const p = settings[RANK_SETTINGS_KEY[rankId]]?.resetPeriod;
    return p === 'week' || p === 'month' ? p : 'live';
  }
  // Restaura rankings de sesión (periodo «live») tras reinicio si es el mismo live.
  function canRestoreLiveRank(saved) {
    if (!saved || saved.period !== 'live' || !Array.isArray(saved.users) || !saved.users.length) return false;
    if (saved.roomId && liveSession.roomId) {
      return String(saved.roomId) === String(liveSession.roomId);
    }
    if (saved.username && liveSession.username && liveSession.active) {
      return liveUserMatch(saved.username, liveSession.username);
    }
    return false;
  }
  function restoreLiveRankSession(rankId, saved) {
    rankSession[rankId].clear();
    if (!canRestoreLiveRank(saved)) return;
    for (const u of saved.users) {
      if (u?.uniqueId) rankSession[rankId].set(u.uniqueId, u);
    }
  }
  function loadRankOverlays() {
    const r = readJsonSafe(RANKS_FILE);
    const raw = r.data || {};
    for (const rankId of RANK_IDS) {
      const period = getRankPeriod(rankId);
      lastRankPeriods[rankId] = period;
      rankSession[rankId].clear();
      const saved = raw[rankId];
      if (period === 'live') {
        restoreLiveRankSession(rankId, saved);
        continue;
      }
      const [start, end] = period === 'month' ? currentMonthRange() : currentWeekRange();
      if (saved && saved.period === period && saved.start === start) {
        rankPersist[rankId].period = period;
        rankPersist[rankId].start = start;
        rankPersist[rankId].end = end;
        rankPersist[rankId].users = new Map((saved.users || []).map((u) => [u.uniqueId, u]));
      } else {
        rankPersist[rankId].period = period;
        rankPersist[rankId].start = start;
        rankPersist[rankId].end = end;
        rankPersist[rankId].users = new Map();
      }
    }
  }
  function saveRankOverlays() {
    clearTimeout(rankSaveTimer);
    rankSaveTimer = setTimeout(() => {
      const data = {};
      for (const rankId of RANK_IDS) {
        const period = getRankPeriod(rankId);
        if (period === 'live') {
          data[rankId] = {
            period: 'live',
            roomId: liveSession.roomId || null,
            username: liveSession.username || null,
            users: [...rankSession[rankId].values()],
          };
          continue;
        }
        const p = rankPersist[rankId];
        data[rankId] = { period: p.period, start: p.start, end: p.end, users: [...p.users.values()] };
      }
      writeJsonAtomic(RANKS_FILE, data);
    }, 400);
  }
  function ensureRankPeriod(rankId) {
    const period = getRankPeriod(rankId);
    if (period === 'live') return;
    const [start, end] = period === 'month' ? currentMonthRange() : currentWeekRange();
    const p = rankPersist[rankId];
    if (p.period !== period || p.start !== start) {
      p.period = period;
      p.start = start;
      p.end = end;
      p.users.clear();
      saveRankOverlays();
      broadcastRankState(rankId);
    }
  }
  function onRankPeriodChange(rankId) {
    rankSession[rankId].clear();
    const period = getRankPeriod(rankId);
    lastRankPeriods[rankId] = period;
    if (period === 'live') {
      rankPersist[rankId].users.clear();
      const saved = (readJsonSafe(RANKS_FILE).data || {})[rankId];
      restoreLiveRankSession(rankId, saved);
    } else {
      const [start, end] = period === 'month' ? currentMonthRange() : currentWeekRange();
      rankPersist[rankId].period = period;
      rankPersist[rankId].start = start;
      rankPersist[rankId].end = end;
      rankPersist[rankId].users.clear();
      saveRankOverlays();
    }
    broadcastRankState(rankId);
  }
  function getRankUsers(rankId) {
    if (getRankPeriod(rankId) === 'live') return rankSession[rankId];
    ensureRankPeriod(rankId);
    return rankPersist[rankId].users;
  }
  function addRankValue(rankId, user, delta) {
    if (!user?.uniqueId || !(delta > 0)) return;
    const users = getRankUsers(rankId);
    const u = users.get(user.uniqueId) || { uniqueId: user.uniqueId, nickname: user.nickname, photo: user.photo, val: 0 };
    u.val += delta;
    u.nickname = user.nickname || u.nickname;
    if (user.photo) u.photo = user.photo;
    users.set(user.uniqueId, u);
    saveRankOverlays();
    broadcastRankState(rankId);
  }
  function addRankLikes(user, count) {
    if (!user?.uniqueId || !(count > 0)) return;
    addRankValue('toplikes', user, count);
    addRankValue('toplikeslist', user, count);
  }
  function addRankDiamonds(user, coins) {
    if (!user?.uniqueId || !(coins > 0)) return;
    addRankValue('topdiam', user, coins);
    addRankValue('topdiamlist', user, coins);
  }
  function addRankComments(user, count) {
    if (!user?.uniqueId || !(count > 0)) return;
    addRankValue('topcomments', user, count);
  }
  function serializeRankState(rankId) {
    const period = getRankPeriod(rankId);
    const users = getRankUsers(rankId);
    const p = rankPersist[rankId];
    return {
      rank: rankId,
      users: [...users.values()].map((u) => ({ uniqueId: u.uniqueId, nickname: u.nickname, photo: u.photo, val: u.val })),
      period,
      periodStart: period === 'live' ? 0 : p.start,
      periodEnd: period === 'live' ? 0 : p.end,
      now: Date.now(),
    };
  }
  function broadcastRankState(rankId) {
    broadcast('rankState', serializeRankState(rankId));
  }
  function broadcastAllRankStates() {
    for (const rankId of RANK_IDS) broadcastRankState(rankId);
  }
  function resetRankSession(rankId) {
    if (!RANK_IDS.includes(rankId) || getRankPeriod(rankId) !== 'live') return;
    rankSession[rankId].clear();
    saveRankOverlays();
    broadcast('rankReset', { rank: rankId });
    broadcastRankState(rankId);
  }
  function resetRankAll(rankId) {
    if (!RANK_IDS.includes(rankId)) return;
    rankSession[rankId].clear();
    if (getRankPeriod(rankId) !== 'live') {
      rankPersist[rankId].users.clear();
    }
    saveRankOverlays();
    broadcast('rankReset', { rank: rankId });
    broadcastRankState(rankId);
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
  function donorLevelForUid(uid) {
    const key = String(uid || '').trim().replace(/^@/, '').toLowerCase();
    if (!key) return 0;
    const u = points.get(key);
    if (!u) return 0;
    return levelForPoints(u.levelPoints);
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

  const pointsLookupCooldown = new Map();
  function buildPointsLookupPayload(user) {
    const key = String(user?.uniqueId || '').trim().replace(/^@/, '').toLowerCase();
    const sorted = [...points.values()].sort((a, b) => b.total - a.total);
    let stored = null;
    let rank = 0;
    if (key) {
      stored = points.get(key) || null;
      if (!stored) {
        for (const v of points.values()) {
          if (String(v.uniqueId || '').toLowerCase() === key) { stored = v; break; }
        }
      }
      rank = sorted.findIndex((x) => String(x.uniqueId || '').toLowerCase() === key) + 1;
    }
    if (stored) {
      const ser = serializePointUser(stored);
      return {
        uniqueId: ser.uniqueId,
        nickname: user?.nickname || ser.nickname,
        photo: user?.photo || ser.photo,
        total: ser.total,
        level: ser.level,
        rank: rank || 1,
      };
    }
    return {
      uniqueId: key || user?.uniqueId || '',
      nickname: user?.nickname || key || 'Usuario',
      photo: user?.photo || '',
      total: 0,
      level: 1,
      rank: Math.max(1, sorted.length + 1),
    };
  }
  function tryPointsLookupCommand(comment, user) {
    const cfg = settings.pointsLookup || {};
    if (cfg.enabled === false) return;
    const cmd = (cfg.command && String(cfg.command).trim()) || '!puntos';
    if (!matchesCommand(cmd, comment)) return;
    const uid = String(user?.uniqueId || '').trim().replace(/^@/, '').toLowerCase() || 'anon';
    const now = Date.now();
    if (now - (pointsLookupCooldown.get(uid) || 0) < 3000) return;
    pointsLookupCooldown.set(uid, now);
    if (pointsLookupCooldown.size > 2000) {
      for (const [k, t] of pointsLookupCooldown) if (now - t > 600000) pointsLookupCooldown.delete(k);
    }
    broadcast('pointsLookup', buildPointsLookupPayload(user));
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

  function normalizeImportedPhoto(url) {
    let p = String(url || '').trim();
    if (!p) return '';
    if (p.startsWith('//')) p = 'https:' + p;
    else if (!/^https?:\/\//i.test(p)) p = 'https://' + p.replace(/^\/+/, '');
    return p.slice(0, 500);
  }

  /** Importa lista de usuarios con puntos (absolutos). mode: merge | replace */
  function importPointsUsers(list, mode) {
    const arr = Array.isArray(list) ? list : [];
    if (mode === 'replace') {
      points.clear();
      pointsTx = [];
    }
    let imported = 0;
    let updated = 0;
    const now = Date.now();
    for (const raw of arr) {
      if (!raw || typeof raw !== 'object') continue;
      const key = String(raw.uniqueId || raw.username || '').trim().replace(/^@/, '').toLowerCase();
      if (!key) continue;
      const total = Math.max(0, Math.round(Number(raw.total != null ? raw.total : raw.totalRewardAmount != null ? raw.totalRewardAmount : raw.totalAmount) || 0));
      const levelPoints = Math.max(0, Math.round(Number(raw.levelPoints != null ? raw.levelPoints : total) || 0));
      const nickname = String(raw.nickname || key).slice(0, 64);
      const photo = normalizeImportedPhoto(raw.photo || raw.thumbnailUrl || '');
      const firstAt = Number(raw.firstAt) || Date.parse(raw.createdAt) || now;
      const lastAt = Number(raw.lastAt) || Date.parse(raw.lastUpsertAt || raw.updatedAt) || now;
      const prev = points.get(key);
      if (mode === 'merge' && prev && prev.total >= total && prev.levelPoints >= levelPoints) {
        if (nickname && nickname !== prev.nickname) prev.nickname = nickname;
        if (photo && !prev.photo) prev.photo = photo;
        continue;
      }
      if (prev) updated++;
      else imported++;
      points.set(key, {
        uniqueId: key,
        nickname: nickname || (prev && prev.nickname) || key,
        photo: photo || (prev && prev.photo) || '',
        total,
        levelPoints,
        firstAt: prev ? Math.min(prev.firstAt || firstAt, firstAt) : firstAt,
        lastAt: Math.max(prev ? (prev.lastAt || 0) : 0, lastAt),
      });
    }
    enforcePointsCap();
    savePoints();
    broadcast('pointsList', serializePoints());
    return { ok: true, imported, updated, total: points.size };
  }

  async function fetchTikfinityChannelUsers(channelId) {
    const id = String(channelId || '').trim();
    if (!/^\d+$/.test(id)) throw new Error('Channel ID inválido (debe ser el número de Setup → Tu cuenta).');
    const out = [];
    const pageSize = 100;
    let page = 0;
    for (;;) {
      const url = `https://tikfinity.zerody.one/api/rest/channeluser?channelId=${encodeURIComponent(id)}&pageSize=${pageSize}&page=${page}&orderColumn=totalRewardAmount`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`TikFinity respondió HTTP ${res.status}`);
      const data = await res.json();
      const list = Array.isArray(data.channelusers) ? data.channelusers
        : (Array.isArray(data.channelUsers) ? data.channelUsers : []);
      for (const u of list) {
        if (!u) continue;
        const uniqueId = String(u.username || u.uniqueId || '').trim().replace(/^@/, '').toLowerCase();
        if (!uniqueId) continue;
        const total = Math.max(0, Math.round(Number(
          u.totalRewardAmount != null ? u.totalRewardAmount : u.totalAmount
        ) || 0));
        out.push({
          uniqueId,
          nickname: String(u.nickname || uniqueId).slice(0, 64),
          photo: normalizeImportedPhoto(u.thumbnailUrl || u.thumbnailUrlV2 || ''),
          total,
          levelPoints: total,
          firstAt: Date.parse(u.createdAt) || Date.now(),
          lastAt: Date.parse(u.lastUpsertAt || u.updatedAt) || Date.now(),
        });
      }
      if (!data.hasNext || !list.length) break;
      page += 1;
      if (out.length >= POINTS_MAX_USERS || page > 250) break;
    }
    return out.slice(0, POINTS_MAX_USERS);
  }

  function replyPointsImport(ws, payload) {
    try {
      if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'pointsImportResult', payload }));
    } catch {}
  }

  function replyTikfinityCloudSettings(ws, payload) {
    try {
      if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'tikfinityCloudSettingsResult', payload }));
    } catch {}
  }

  async function fetchTikfinityActions(channelId) {
    const id = String(channelId || '').trim();
    if (!/^\d+$/.test(id)) throw new Error('Channel ID inválido (debe ser el número de Setup → Tu cuenta).');
    const out = [];
    const pageSize = 100;
    let page = 0;
    for (;;) {
      const url = `https://tikfinity.zerody.one/api/rest/action?channelId=${encodeURIComponent(id)}&pageSize=${pageSize}&page=${page}&orderColumn=id`;
      const res = await fetch(url);
      if (res.status === 429) {
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      if (!res.ok) throw new Error(`TikFinity actions HTTP ${res.status}`);
      const data = await res.json();
      const list = Array.isArray(data.actions) ? data.actions : [];
      for (const a of list) {
        if (!a || a.isDeleted) continue;
        out.push(a);
      }
      if (!data.hasNext || !list.length) break;
      page += 1;
      if (out.length >= 2000 || page > 100) break;
    }
    return out;
  }

  function mapTikfinityActionsToLegacy(actions, events) {
    const byId = new Map();
    if (Array.isArray(events)) {
      for (const ev of events) {
        if (!ev) continue;
        const aid = ev.actionId ?? ev.action_id ?? ev.action?.id;
        if (aid == null) continue;
        const giftName = String(ev.giftName || ev.gift_name || ev.gift || ev.triggerName || '').trim();
        const giftId = String(ev.giftId || ev.gift_id || '').trim();
        const type = String(ev.type || ev.eventType || ev.trigger || ev.event || 'gift').toLowerCase();
        byId.set(Number(aid), { giftName, giftId, type });
      }
    }
    const alertas = [];
    const videos = [];
    const interacciones = [];
    for (const a of actions || []) {
      if (!a) continue;
      const link = byId.get(Number(a.id)) || {};
      const giftRef = link.giftName || (link.giftId ? `#${link.giftId}` : '');
      const volPct = Math.max(0, Math.min(100, Math.round(Number(a.dynamicConfig?.mediaSoundVolume ?? 100) || 100)));
      const name = String(a.name || 'Acción').slice(0, 80);
      const enabled = a.isDeleted !== true;
      if (a.videoUrl) {
        videos.push({
          nombreLista: name,
          videoUrl: String(a.videoUrl),
          videoName: String(a.dynamicConfig?.videoUrlOriginalFilename || 'video').slice(0, 80),
          videoVol: volPct,
          screen: Math.max(1, Math.min(10, Number(a.screenId) || 1)),
          enabled,
          nombreRegalo: giftRef,
          trigger: link.type || 'gift',
        });
      } else if (a.audioUrl) {
        alertas.push({
          nombre: name,
          audioUrl: String(a.audioUrl),
          audioName: String(a.dynamicConfig?.audioUrlOriginalFilename || 'audio').slice(0, 80),
          volumen: volPct,
          enabled,
          nombreRegalo: giftRef,
          trigger: link.type === 'any_gift' ? 'any_gift' : 'gift',
        });
      }
      if (a.mcCmd) {
        /* Minecraft → más abajo */
      } else {
        const whUrl = String(a.webhookUrl || '').trim();
        const keys = a.keystrokes ? String(a.keystrokes).slice(0, 120) : '';
        const obsCmd = tikfinityObsCmdFromAction(a);
        const sbCmd = tikfinitySbCmdFromAction(a);
        const hasMedia = !!(a.videoUrl || a.audioUrl);
        const wantObs = !!(obsCmd && (!hasMedia || keys || whUrl || sbCmd));
        if (keys || whUrl || sbCmd || wantObs) {
          const type = String(link.type || 'gift').toLowerCase();
          const isAny = type === 'any_gift' || type === 'gift-any' || (!giftRef && !link.giftId);
          interacciones.push({
            nombre: name,
            tecla: keys,
            enabled,
            nombreRegalo: isAny ? '' : giftRef,
            trigger: isAny ? 'gift-any' : (type || 'gift'),
            giftId: isAny ? '' : (link.giftId || ''),
            webhookUrl: whUrl,
            obsCmd: wantObs ? obsCmd : undefined,
            sbCmd: sbCmd || undefined,
          });
        }
      }
    }
    const minecraft = mapTikfinityActionsToMc(actions, events);
    return { alertas, videos, interacciones, minecraft };
  }

  /** Descifra export .tfc de TikFinity (CryptoJS AES / OpenSSL Salted__). */
  function evpBytesToKey(password, salt, keyLen, ivLen) {
    const crypto = require('crypto');
    const pass = Buffer.from(String(password || ''), 'utf8');
    let data = Buffer.alloc(0);
    const parts = [];
    while (Buffer.concat(parts).length < keyLen + ivLen) {
      const hash = crypto.createHash('md5');
      hash.update(data);
      hash.update(pass);
      hash.update(salt);
      data = hash.digest();
      parts.push(data);
    }
    const ms = Buffer.concat(parts);
    return { key: ms.slice(0, keyLen), iv: ms.slice(keyLen, keyLen + ivLen) };
  }

  function decryptCryptoJsOpenSsl(ciphertextB64, password) {
    const crypto = require('crypto');
    const buf = Buffer.from(String(ciphertextB64 || '').trim().replace(/\s+/g, ''), 'base64');
    if (buf.length < 32 || buf.slice(0, 8).toString('utf8') !== 'Salted__') {
      throw new Error('No es un .tfc cifrado (Salted__) válido.');
    }
    const salt = buf.slice(8, 16);
    const ct = buf.slice(16);
    const attempts = [
      { keyLen: 32, ivLen: 16, algo: 'aes-256-cbc' },
      { keyLen: 16, ivLen: 16, algo: 'aes-128-cbc' },
    ];
    let lastErr = null;
    for (const a of attempts) {
      try {
        const { key, iv } = evpBytesToKey(password, salt, a.keyLen, a.ivLen);
        const decipher = crypto.createDecipheriv(a.algo, key, iv);
        const out = Buffer.concat([decipher.update(ct), decipher.final()]);
        const text = out.toString('utf8');
        if (text && text.trim()) return text;
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('descifrado falló');
  }

  function buildTikfinityPassphrases({ channelId, password, username } = {}) {
    const out = [];
    const add = (v) => {
      const s = String(v == null ? '' : v);
      if (!s || out.includes(s)) return;
      out.push(s);
    };
    add(password);
    add(channelId);
    if (channelId) {
      add(String(channelId).trim());
      add('tikfinity' + channelId);
      add('TikFinity' + channelId);
      add('tikfinity_' + channelId);
      add(channelId + '_settings');
    }
    if (username) {
      add(username);
      add(String(username).toLowerCase());
      add(String(username).replace(/^@/, ''));
    }
    add('tikfinity');
    add('TikFinity');
    add('zerody');
    add('TikFinitySettings');
    add('settings');
    add('export');
    add('tfc');
    return out;
  }

  function decryptTikfinityTfc(ciphertext, opts = {}) {
    try {
      const mapped = decryptAndMapTfc(ciphertext);
      if (mapped?.data) {
        return {
          data: mapped.data,
          passphraseUsed: 'tikfinity-tfc',
          encVersion: mapped.encVersion,
          sourceChannelId: mapped.sourceChannelId,
          counts: mapped.counts,
          emotes: mapped.emotes || [],
        };
      }
    } catch (e) {
      const keys = buildTikfinityPassphrases(opts);
      let lastErr = e;
      for (const key of keys) {
        try {
          const plain = decryptCryptoJsOpenSsl(ciphertext, key);
          const trimmed = String(plain || '').trim();
          if (!trimmed) continue;
          const data = JSON.parse(trimmed);
          if (!data || typeof data !== 'object') continue;
          return { data, passphraseUsed: key === opts.password ? '(password)' : (key === String(opts.channelId) ? 'channelId' : 'key') };
        } catch (err) {
          lastErr = err;
        }
      }
      throw new Error(
        lastErr?.message?.includes('Salted')
          ? lastErr.message
          : (lastErr?.message || 'No se pudo descifrar el .tfc.')
      );
    }
    throw new Error('El .tfc se abrió pero no trae alertas/acciones.');
  }

  function replyTikfinityDecrypt(ws, payload) {
    try {
      if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'tikfinityDecryptResult', payload }));
    } catch {}
  }

  /* ------------------------------- Emotes ------------------------------- */
  function rememberEmote(emoteId, image) {
    const eid = String(emoteId || '').trim();
    if (!eid) return;
    const url = emoteImageUrl(image);
    const prev = emoteCatalog.get(eid);
    if (!prev || (!prev.image && url)) {
      emoteCatalog.set(eid, { id: eid, image: url });
      scheduleSaveEmotesCatalog();
      broadcast('emoteCatalog', { results: [...emoteCatalog.values()] });
      if (!prev) broadcast('log', { level: 'info', text: `🙂 Sticker guardado (#${eid.slice(-6)})` });
    }
  }

  // TikTok envía stickers en varios formatos según el conector / tipo de mensaje:
  // emoteList (EMOTE), emotes[].emote (CHAT protobuf), emotes[].emoteId (legacy/simplificado).
  // allowRootFallback: solo en WebcastEvent.EMOTE (el payload trae el emote en la raíz).
  // En CHAT, si no hay emotes[], NO usar data.id del mensaje (dispararía alertas falsas).
  function extractEmotes(data, { allowRootFallback = false } = {}) {
    const out = [];
    const seen = new Set();
    const addRaw = (item) => {
      if (!item || typeof item !== 'object') return;
      const eid = emoteIdFrom(item);
      if (!eid || seen.has(eid)) return;
      seen.add(eid);
      out.push({ emoteId: eid, image: item.emoteImageUrl || item.image || null });
    };
    if (Array.isArray(data?.emoteList)) {
      for (const e of data.emoteList) addRaw(e);
    }
    if (Array.isArray(data?.emotes)) {
      for (const se of data.emotes) {
        if (se?.emote) addRaw(se.emote);
        else addRaw(se);
      }
    }
    if (!out.length && allowRootFallback) {
      if (data?.emoteId || data?.emote_id || data?.emoteImageUrl || data?.uuid || data?.packageId) {
        addRaw(data);
      }
    }
    return out;
  }

  function fireEmoteTriggers(data, user = null, opts = {}) {
    const list = extractEmotes(data, opts);
    if (!list.length) return;
    for (const e of list) rememberEmote(e.emoteId, e.image);
    for (const e of list) {
      // Evita 1 sticker → 2 sonidos cuando TikTok manda CHAT + EMOTE casi a la vez.
      if (!emoteFireOnce(user, e.emoteId, data)) continue;
      const info = { emoteId: e.emoteId };
      triggerSoundAlerts('emote', info, user);
      triggerVideos('emote', info, user);
      triggerActions('emote', info, user);
      if (user) triggerMinecraftActions('emote', info, user);
    }
  }

  function processChatEvent(data) {
      const comment = data.comment || '';
      state.stats.comments++;
      const msgId = data?.common?.msgId || '';
      const chatUser = baseUser(data.user || data);
      addRankComments(chatUser, 1);
      const atUser = data.atUser ? baseUser(data.atUser) : null;
      const roles = chatUserRoles(data);
      const ptsDonor = donorLevelForUid(chatUser.uniqueId);
      const donorLevel = roles.gifterLevel > 0 ? roles.gifterLevel : ptsDonor;
      const donorSource = roles.gifterLevel > 0 ? 'tiktok' : (ptsDonor > 0 ? 'points' : '');
      broadcast('chat', {
        ...chatUser,
        comment,
        msgId: msgId && String(msgId) !== '0' ? String(msgId) : chatKey,
        replyTo: atUser?.uniqueId || '',
        replyToNick: atUser?.nickname || '',
        ...roles,
        donorLevel,
        donorSource,
      });
      pushStatsThrottled();
      checkMemberLevelUp(data);
      fireEmoteTriggers(data, chatUser);
      const chatInfo = { comment, username: chatUser.uniqueId, nickname: chatUser.nickname };
      triggerVideos('chatCommand', chatInfo);
      triggerSoundAlerts('chatCommand', chatInfo);
      triggerActions('chatCommand', chatInfo, chatUser);
      handleChatCommands(comment, chatUser);
      tryPointsLookupCommand(comment, chatUser);
      handleSpotifyCommands(comment, chatUser, chatUserRoles(data));
      triggerMinecraftActions('chat', chatInfo, chatUser);
      processScreenFxTriggers('chat', chatInfo, chatUser);
      if (settings.timer?.chat) addTimerSeconds(settings.timer.chat);
      // ID estable del hablante (uniqueId o userId numérico).
      const uidRaw = chatUser.uniqueId || data.user?.uniqueId || data.user?.userId || data.userId || '';
      const uid = normTikTokUser(uidRaw) || String(uidRaw || '').trim()
        || normTikTokUser(chatUser.nickname) || String(chatUser.nickname || '').trim();
      const username = chatUser.uniqueId || String(data.user?.userId || data.userId || '').trim();
      const nowChat = Date.now();
      const prevChat = uid ? (chatLastAt.get(uid) || 0) : 0;
      const gapMs = prevChat ? (nowChat - prevChat) : Infinity;
      if (uid) {
        chatLastAt.set(uid, nowChat);
        if (chatLastAt.size > 8000) {
          for (const [k, t] of chatLastAt) if (nowChat - t > 6 * 3600 * 1000) chatLastAt.delete(k);
        }
      }
      const firstMsgInfo = { comment, username, nickname: chatUser.nickname, gapMs };
      // Primer mensaje: cada video aplica su cooldown (joinDelay). Sonidos/juegos/acciones: visita ~30s.
      triggerVideos('firstMessage', firstMsgInfo);
      if (isFirstMessageVisit(firstMsgInfo, 30)) {
        triggerSoundAlerts('firstMessage', firstMsgInfo);
        triggerMinecraftActions('firstMessage', firstMsgInfo, chatUser);
        triggerActions('firstMessage', firstMsgInfo, chatUser);
        processScreenFxTriggers('firstMessage', firstMsgInfo, chatUser);
      }
      // Hint de entrada: solo la primera vez en el live (si TikTok no manda MEMBER).
      if (uid && !chatSeenUsers.has(uid)) {
        chatSeenUsers.add(uid);
        triggerVideos('userJoin', firstMsgInfo);
      }
  }

  /* --------------------------- Eventos del live --------------------------- */
  function bindEvents(conn) {
    conn.on(ControlEvent.DISCONNECTED, () => {
      state.connected = false;
      clearChatCatchup();
      pushState();
      broadcast('log', { level: 'info', text: 'Desconectado del live.' });
    });

    conn.on(ControlEvent.ERROR, (e) => {
      broadcast('log', { level: 'error', text: `Error: ${e?.info || e?.exception?.message || e}` });
    });

    conn.on(WebcastEvent.CHAT, (data) => {
      const comment = data.comment || '';
      const chatKey = chatEventKey(data, comment);
      if (!consumeChatOnce(chatKey)) return;
      // Conectar/reconectar tarde: TikTok suelta chats viejos; solo procesar el último.
      if (chatCatchupActive) {
        noteChatCatchup(data);
        return;
      }
      processChatEvent(data);
    });
    conn.on(WebcastEvent.GIFT, (data) => {
      // Multiplicador x2/x3 / guante crítico en regalos durante la PK (matchInfo).
      try {
        if (data?.matchInfo || state.inBattle) {
          detectBattleMultiplier(data, 'Gift.matchInfo', { giftOnlyMatchInfo: true });
        }
      } catch {}
      const user = baseUser(data.user);
      const giftType = data.giftDetails?.giftType;
      const giftId = data.giftId ?? data.giftDetails?.id ?? '';
      const cat = giftsById.get(String(giftId));
      const diamondsEach = data.giftDetails?.diamondCount || cat?.diamonds || 0;
      const giftName = data.giftDetails?.giftName || cat?.name || 'Regalo';
      const repeatCount = data.repeatCount || 1;
      const image = getGiftImage(data) || cat?.image || null;
      if (image && giftId) {
        const sid = String(giftId);
        const prev = giftsById.get(sid);
        const giftEntry = {
          id: sid,
          name: giftName || prev?.name || 'Regalo',
          diamonds: diamondsEach || prev?.diamonds || 0,
          image,
        };
        giftsById.set(sid, giftEntry);
        registerCommunityGift(giftEntry);
      }
      const giftInfo = { giftName, giftId, diamonds: diamondsEach, totalDiamonds: diamondsEach * repeatCount, repeatCount };

      const isStreak = giftType === 1 && !data.repeatEnd;
      const streakGiftType = giftType === 1;
      const comboOnce = !!settings.playback?.comboOnce;
      let repeatDelta = Math.max(1, Number(repeatCount) || 1);
      if (streakGiftType) {
        const sk = giftStreakGameKey(user.uniqueId, giftId);
        const prev = giftStreakGameProgress.get(sk) || 0;
        repeatDelta = Math.max(0, Number(repeatCount) - prev);
      }

      // Alertas durante la racha (rosas, etc.):
      // - "Racha = 1" ON  → no suena aquí; solo al cerrar (abajo).
      // - "Racha = 1" OFF → suena por cada rosa nueva (delta).
      if (streakGiftType && isStreak && !comboOnce && repeatDelta > 0) {
        const sk = giftStreakGameKey(user.uniqueId, giftId);
        fireGiftMediaAlerts(user, giftId, giftInfo, repeatDelta);
        giftStreakAlertProgress.set(sk, (giftStreakAlertProgress.get(sk) || 0) + repeatDelta);
      }

      if (!isStreak) {
        const total = diamondsEach * repeatCount;
        state.stats.gifts++;
        state.stats.diamonds += total;
        bumpFocMetrics('diamonds', total);

        if (user.uniqueId) {
          const g = state.gifters.get(user.uniqueId) || { ...user, diamonds: 0 };
          g.diamonds += total;
          g.nickname = user.nickname;
          g.photo = user.photo || g.photo;
          state.gifters.set(user.uniqueId, g);
        }
        addWeeklyDonation(user, total);
        addTop1FireDonation(user, total);
        addHabibiTopDonation(user, total);
        addRankDiamonds(user, total);
        // Usuario y Puntos: acumula los puntos donados de por vida (configurable: puntos por moneda).
        if (user.uniqueId && total > 0) {
          const perCoin = Number(settings.points?.perCoin);
          const award = Math.round(total * (Number.isFinite(perCoin) && perCoin > 0 ? perCoin : 1));
          if (award > 0) addUserPoints({ uniqueId: user.uniqueId, nickname: user.nickname, photo: user.photo, amount: award, counted: true, description: `Regalo: ${giftName}`, manual: false });
        }
        pushState();
        flushStreamerRank();

        if (settings.battle.enabled && total > 0) {
          if (settings.battle.receiving === 'A') battle.scoreA += total;
          else if (settings.battle.receiving === 'B') battle.scoreB += total;
          if (settings.battle.receiving !== 'off') broadcast('battle', serializeBattle());
        }
        addPkHostGiftPoints(total);

        addTimerSeconds(total * (settings.timer?.giftMult || 0));

        broadcast('log', { level: 'info', text: `🎁 Regalo: ${giftName} (id ${giftId}) ×${repeatCount} · 💎${diamondsEach}` });

        // Cierre de racha o regalo sin racha.
        const sk = giftStreakGameKey(user.uniqueId, giftId);
        if (comboOnce) {
          // Una sola alerta por racha (o por regalo).
          if (!comboShouldSkip(user.uniqueId, giftId)) {
            fireGiftMediaAlerts(user, giftId, giftInfo, 1);
          }
          giftStreakAlertProgress.delete(sk);
        } else if (streakGiftType) {
          // Ya sonó por cada rosa durante la racha; solo completa si faltó algún evento.
          const already = giftStreakAlertProgress.get(sk) || 0;
          giftStreakAlertProgress.delete(sk);
          const missing = Math.max(0, Math.max(1, Number(repeatCount) || 1) - already);
          if (missing > 0) fireGiftMediaAlerts(user, giftId, giftInfo, missing);
        } else {
          // Regalo normal (no racha): N copias = repeatCount.
          fireGiftMediaAlerts(user, giftId, giftInfo, Math.max(1, Number(repeatCount) || 1));
        }

        countGiftForGoal(giftId, giftName, repeatCount);
        countGiftForGiftGoals(user, giftId, giftName, repeatCount);
        applyWinsGiftHooks(giftId, repeatCount);
        processFanBalls('coins', user, total);
        trackSessionGift(user, giftName, repeatCount, diamondsEach, image);
        processScreenFxTriggers('gift', giftInfo, user);
      }

      triggerGiftGameActions(user, giftId, repeatCount, !!data.repeatEnd, giftType, giftInfo);

      broadcast('gift', {
        ...user, giftName, giftId, repeatCount, repeatDelta,
        diamonds: diamondsEach, image, streak: isStreak,
        repeatEnd: !!data.repeatEnd, streakGift: streakGiftType,
      });
      checkMemberLevelUp(data);
    });

    conn.on(WebcastEvent.LIKE, (data) => {
      state.stats.likes = data.totalLikeCount ?? state.stats.likes + (data.likeCount || 0);
      addTimerSeconds(((data.likeCount || 0) / 100) * (settings.timer?.like || 0));
      processFanBalls('likes', baseUser(data.user), data.likeCount || 0);
      addRankLikes(baseUser(data.user), data.likeCount || 0);
      trackSessionLike(baseUser(data.user), data.likeCount || 0);
      bumpFocMetrics('likes', data.likeCount || 0);
      broadcast('like', { ...baseUser(data.user), count: data.likeCount || 0, total: state.stats.likes });
      addPkHostLikePoints(data.likeCount || 0);
      const likeUser = baseUser(data.user);
      const likeInfo = { likeCount: data.likeCount || 0 };
      forEachTriggerProfile((cfg) => triggerMarioActions('like', likeInfo, likeUser, cfg));
      forEachTriggerProfile((cfg) => triggerRepoActions('like', likeInfo, likeUser, cfg));
      triggerMinecraftActions('like', likeInfo, likeUser);
      // Videos y Acciones acumulan likes por usuario (meta likeN): deben recibir
      // TODAS las tandas o el conteo se queda corto. El freno de 3 s es solo
      // anti-spam de sonidos (su propósito original).
      triggerVideos('like', likeInfo, likeUser);
      triggerActions('like', likeInfo, likeUser);
      processScreenFxTriggers('like', likeInfo, likeUser);
      if (Date.now() - lastLikeSound > 3000) {
        lastLikeSound = Date.now();
        triggerSoundAlerts('like', likeInfo, likeUser);
      }
      if (typeof data.totalLikeCount === 'number') triggerLikeGlobal(data.totalLikeCount);
      pushStatsThrottled();
      flushStreamerRank();
    });

    conn.on(WebcastEvent.MEMBER, (data) => {
      state.stats.joins++;
      if (data.memberCount) {
        state.stats.viewers = data.memberCount;
        state.stats.peakViewers = Math.max(Number(state.stats.peakViewers) || 0, data.memberCount);
      }
      const member = baseUser(data.user);
      broadcast('member', member);
      // Registrar nivel al entrar (baseline para detectar subidas después).
      checkMemberLevelUp(data);
      // Video al entrar un usuario específico (el anti-spam por tiempo se aplica en
      // triggerVideos, con el delay configurado en cada video).
      const joinInfo = userJoinVideoInfo(data.user, data);
      // Marcar visto ya en MEMBER para que el fallback de primer chat no dispare
      // userJoin otra vez. Se guardan TODAS las formas de la identidad (usuario y
      // nickname, normalizados y crudos) porque el chat puede llegar con otra clave.
      const joinKeys = [
        normTikTokUser(joinInfo.username), String(joinInfo.username || '').trim(),
        normTikTokUser(joinInfo.nickname), String(joinInfo.nickname || '').trim(),
      ].filter(Boolean);
      for (const k of joinKeys) chatSeenUsers.add(k);
      if (joinInfo.username || joinInfo.nickname) {
        triggerVideos('userJoin', joinInfo);
      }
      pushStatsThrottled();
    });

    conn.on(WebcastEvent.ROOM_USER, (data) => {
      if (typeof data.viewerCount === 'number') {
        state.stats.viewers = data.viewerCount;
        state.stats.peakViewers = Math.max(Number(state.stats.peakViewers) || 0, data.viewerCount);
        pushStatsThrottled();
      }
    });

    conn.on(WebcastEvent.SOCIAL, (data) => {
      const user = baseUser(data.user);
      const action = (data.action || '').toLowerCase();
      const dt = socialDisplayType(data);
      if (dt.includes('unfollow') || action.includes('unfollow')) bumpFollowerCounter(-1, data);
      if (action.includes('follow')) {
        if (!followShareOnce('follow', user)) return; // ya lo procesó el canal FOLLOW
        state.stats.follows++;
        broadcast('follow', user);
        triggerVideos('follow');
        triggerSoundAlerts('follow', {}, user);
        triggerActions('follow', {}, user);
        triggerMinecraftActions('follow', {}, user);
      processScreenFxTriggers('follow', {}, user);
        if (timerEventOnce('follow', user.uniqueId)) addTimerSeconds(settings.timer?.follow || 0);
        const c = settings.hypeBar || {};
        trackSessionHypeEvent('follow', Math.max(1, parseInt(c.pointsFollow, 10) || 1));
      } else if (action.includes('share')) {
        if (!followShareOnce('share', user)) return; // ya lo procesó el canal SHARE
        state.stats.shares++;
        broadcast('share', user);
        triggerVideos('share');
        triggerSoundAlerts('share', {}, user);
        triggerActions('share', {}, user);
        triggerMinecraftActions('share', {}, user);
      processScreenFxTriggers('share', {}, user);
        if (timerEventOnce('share', user.uniqueId)) addTimerSeconds(settings.timer?.share || 0);
        const c = settings.hypeBar || {};
        trackSessionHypeEvent('share', Math.max(1, parseInt(c.pointsShare, 10) || 1));
      }
      pushStatsThrottled();
    });

    conn.on(WebcastEvent.FOLLOW, (data) => {
      const user = baseUser(data.user);
      bumpFollowerCounter(1, data); // el contador de seguidores solo se suma aquí
      if (!followShareOnce('follow', user)) { pushStatsThrottled(); return; } // ya lo procesó SOCIAL
      state.stats.follows++;
      broadcast('follow', user);
      triggerVideos('follow');
      triggerSoundAlerts('follow', {}, user);
      triggerActions('follow', {}, user);
      triggerMinecraftActions('follow', {}, user);
      processScreenFxTriggers('follow', {}, user);
      if (timerEventOnce('follow', user.uniqueId)) addTimerSeconds(settings.timer?.follow || 0);
      const c = settings.hypeBar || {};
      trackSessionHypeEvent('follow', Math.max(1, parseInt(c.pointsFollow, 10) || 1));
      pushStatsThrottled();
    });

    conn.on(WebcastEvent.SHARE, (data) => {
      const user = baseUser(data.user);
      if (!followShareOnce('share', user)) { pushStatsThrottled(); return; } // ya lo procesó SOCIAL
      state.stats.shares++;
      broadcast('share', user);
      triggerVideos('share');
      triggerSoundAlerts('share', {}, user);
      triggerActions('share', {}, user);
      triggerMinecraftActions('share', {}, user);
      processScreenFxTriggers('share', {}, user);
      if (timerEventOnce('share', user.uniqueId)) addTimerSeconds(settings.timer?.share || 0);
      // Hype: igual que la rama share de SOCIAL (si este canal gana el dedupe, que no se pierda).
      const c = settings.hypeBar || {};
      trackSessionHypeEvent('share', Math.max(1, parseInt(c.pointsShare, 10) || 1));
      pushStatsThrottled();
    });

    conn.on(WebcastEvent.EMOTE, (data) => {
      fireEmoteTriggers(data, baseUser(data.user || data), { allowRootFallback: true });
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
      triggerActions('subscribe', info, user);
      triggerMinecraftActions('subscribe', info, user);
      processScreenFxTriggers('subscribe', info, user);
      addTimerSeconds(settings.timer?.subscribe || 0);
      const subBonus = Math.round(Number(settings.points?.subBonus) || 0);
      if (user.uniqueId && subBonus > 0) {
        addUserPoints({ uniqueId: user.uniqueId, nickname: user.nickname, photo: user.photo, amount: subBonus, counted: true, description: months > 0 ? `Suscripción (${months} m)` : 'Suscripción', manual: false });
      }
    }
    conn.on('subscribe', handleSubscribe);
    conn.on(WebcastEvent.SUB_NOTIFY, handleSubscribe);

    // ===== Super fans =====
    // SUPER_FAN = se hace Super Fan. SUPER_FAN_JOIN / displayType joined = ya era SF y entró al live.
    function isSuperFanJoinBarrage(data) {
      const dts = [
        data?.content?.displayType,
        data?.commonBarrageContent?.displayType,
        data?.displayType,
      ].map((x) => String(x || '').toLowerCase());
      return dts.some((dt) =>
        dt.includes('superfanjoined')
        || dt.includes('superfan_join')
        || dt.includes('super_fan_join')
        || (dt.includes('superfan') && dt.includes('join')));
    }
    function handleSuperFan(data, forceKind = null) {
      const isJoin = forceKind === 'join' || (forceKind !== 'become' && isSuperFanJoinBarrage(data));
      const eventType = isJoin ? 'superFanJoin' : 'superFan';
      const user = baseUser(data?.user || data);
      const level = Number(data?.superFanLevel ?? data?.fanLevel ?? data?.level ?? 0) || 0;
      const uid = user.uniqueId || 'anon';
      const now = Date.now();
      const dedupeKey = `${eventType}:${uid}`;
      if (now - (recentSuperFans.get(dedupeKey) || 0) < 5000) return;
      recentSuperFans.set(dedupeKey, now);
      if (recentSuperFans.size > 500) recentSuperFans.clear();
      const label = isJoin ? 'Super fan entró' : 'Super fan';
      broadcast('log', { level: 'ok', text: `🌟 ${label}: ${user.nickname}${level ? ` · nivel ${level}` : ''}` });
      const info = { ...user, level, isJoin };
      broadcast(isJoin ? 'superfanjoin' : 'superfan', info);
      triggerSoundAlerts(eventType, info, user);
      triggerVideos(eventType, info);
      triggerActions(eventType, info, user);
      triggerMinecraftActions(eventType, info, user);
      processScreenFxTriggers(eventType, info, user);
      // Pelota / puntos solo al volverse Super Fan (no al entrar).
      if (!isJoin) {
        broadcast('goldenBall', { photo: user.photo || '', nickname: user.nickname || '', count: 1 });
        const bonus = Math.round(Number(settings.points?.superFanBonus) || 0);
        if (user.uniqueId && bonus > 0) {
          addUserPoints({ uniqueId: user.uniqueId, nickname: user.nickname, photo: user.photo, amount: bonus, counted: true, description: 'Super fan', manual: false });
        }
      }
    }
    conn.on(WebcastEvent.SUPER_FAN, (data) => handleSuperFan(data));
    if (WebcastEvent.SUPER_FAN_JOIN) {
      conn.on(WebcastEvent.SUPER_FAN_JOIN, (data) => handleSuperFan(data, 'join'));
    }

    // ===== Batallas PK de TikTok =====
    // Catch-all: escanea mensajes gift/linkmic/battle por multiplicador x2/x3.
    conn.on(ControlEvent.DECODED_DATA, (type, decoded) => {
      try {
        const t = String(type || '');
        if (!/gift|linkmic|battle|itemcard|boost/i.test(t)) return;
        const isBattleMsg = /linkmic|battle|itemcard|boost/i.test(t);
        if (!isBattleMsg && !state.inBattle) return;
        const data = decoded?.data ?? decoded;
        if (!data || typeof data !== 'object') return;
        detectBattleMultiplier(data, t.replace(/^Webcast/, ''));
      } catch {}
    });

    conn.on(WebcastEvent.LINK_MIC_BATTLE, (data) => {
      try {
        const a = data?.action;
        const isOpen = a === 4 || a === 'BATTLE_ACTION_OPEN';
        const isAccept = a === 7 || a === 'BATTLE_ACTION_ACCEPT';
        const isEnd = a === 5 || a === 6 || a === 'BATTLE_ACTION_FINISH' || a === 'BATTLE_ACTION_CUT_SHORT';
        const anchors = parsePkAnchors(data);
        const battleId = String(data?.battleId || '').trim();
        if (isOpen || isAccept) {
          state.inBattle = true;
          if (isOpen) {
            clearBattleCountdown();
            resetBattleMultiplierState();
            broadcast('log', { level: 'ok', text: '⚔️ Batalla PK iniciada' });
            fireBattleAlerts('battleStart', {});
            beginPkBattleRound({ anchors, battleId });
          } else if (isAccept && (!pkBattle.live || pkBattle.demo)) {
            // Si había un «Testear» (demo), sustituir por la PK real
            beginPkBattleRound({ anchors, battleId });
          } else if (isAccept && pkBattle.live) {
            if (battleId && !pkBattle.battleId) pkBattle.battleId = battleId;
            if (anchors.length) enrichPkParticipants(anchors);
          }
          if (pkBattle.live && anchors.length) enrichPkParticipants(anchors);
          syncBattleCountdown(data?.battleSetting || data?.battleSettings);
        } else if (isEnd) {
          clearBattleCountdown();
          state.inBattle = false;
          resetBattleMultiplierState();
          broadcast('log', { level: 'info', text: '⚔️ Batalla PK finalizada' });
          fireBattleAlerts('battleEnd', {});
          endPkBattleRound();
        } else if (anchors.length || battleId) {
          // Update sin open/accept: si hay PK activo o marcador, engancharse
          if (pkBattle.demo) {
            beginPkBattleRound({ anchors, battleId });
          } else if (!pkBattle.live && !pkBattle.showEnd && (state.inBattle || anchors.length >= 2)) {
            beginPkBattleRound({ midJoin: true, anchors, battleId });
          } else if (pkBattle.live && anchors.length) {
            enrichPkParticipants(anchors);
          }
        }
        // Scores en battleResult (a veces llegan aquí además de armies)
        if (pkBattle.live && data?.battleResult && typeof data.battleResult === 'object') {
          const hostIds = pkIdSet(
            pkBattle.host.userId, pkBattle.host.uniqueId,
            followerCounter.userId, followerCounter.uniqueId, state.username, pkRoomOwnerUserId(),
          );
          let brChanged = false;
          for (const [k, val] of Object.entries(data.battleResult)) {
            const score = Math.max(0, Math.round(Number(val?.score ?? 0)) || 0);
            const uid = String(val?.userId || k || '');
            const ids = pkIdSet(k, uid);
            if ([...ids].some((id) => hostIds.has(id))) {
              if (pkSetScore('host', score)) brChanged = true;
            } else {
              if (pkSetScore('rival', score)) brChanged = true;
              if (uid && !pkBattle.rival.userId) pkBattle.rival.userId = uid;
            }
          }
          if (brChanged) broadcastPkBattle(true);
        }
        detectBattleMultiplier(data, 'LinkMicBattle');
      } catch {}
    });

    conn.on(WebcastEvent.LINK_MIC_ARMIES, (data) => {
      try {
        state.inBattle = true;
        syncBattleCountdown(data?.battleSettings);
        // Auto: si entras a media batalla, activa y copia el marcador real (30–20, etc.)
        updatePkArmyScores(data);
        if (data?.triggerCriticalStrike) {
          detectBattleMultiplier(data, 'LinkMicArmies.crit');
        } else {
          detectBattleMultiplier(data, 'LinkMicArmies');
        }
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
        }
      } catch {}
    });

    conn.on(WebcastEvent.STREAM_END, () => {
      clearBattleCountdown();
      state.inBattle = false;
      resetBattleMultiplierState();
      endPkBattleRound();
      resetPkBattleAll();
      const wasLive = !!state.connected || !!state.startedAt;
      state.connected = false;
      syncLiveUptimeOnDisconnect();
      stopLiveBadgeTimer();
      if (wasLive) notifyLiveSessionEnd();
      markLiveSessionEnded();
      pushState();
      broadcast('log', { level: 'info', text: 'El live terminó.' });
      resetSessionOverlays(); // al finalizar el live, limpia overlays (menos los semanales)
    });
  }

  /* ---- TTS: solo 1 cliente habla el mismo mensaje (anti .exe + OBS / multi-pestaña) ---- */
  const ttsClaims = new Map();
  const TTS_CLAIM_TTL_MS = 90000;
  const TTS_CLAIM_MAX = 500;
  function pruneTtsClaims() {
    const now = Date.now();
    for (const [k, t] of ttsClaims) {
      if (now - t >= TTS_CLAIM_TTL_MS) ttsClaims.delete(k);
    }
    if (ttsClaims.size <= TTS_CLAIM_MAX) return;
    const sorted = [...ttsClaims.entries()].sort((a, b) => a[1] - b[1]);
    for (let i = 0; i < sorted.length - TTS_CLAIM_MAX; i++) ttsClaims.delete(sorted[i][0]);
  }

  /* ---------------------- Mensajes WS desde el navegador ---------------------- */
  function handleMessage(ws, data) {
    switch (data.action) {
      case 'ttsClaim': {
        // Primer cliente que reclama la clave gana; el resto recibe deny / ttsClaimed.
        const key = String(data.key || '').slice(0, 240);
        if (!key) break;
        pruneTtsClaims();
        let ok = false;
        if (!ttsClaims.has(key)) {
          ttsClaims.set(key, Date.now());
          ok = true;
          const msg = JSON.stringify({ type: 'ttsClaimed', payload: { key } });
          for (const client of clients) {
            if (client === ws || client.readyState !== 1) continue;
            try { client.send(msg); } catch { /* ignore */ }
          }
        }
        try {
          if (ws && ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'ttsClaimResult', payload: { key, ok } }));
          }
        } catch { /* ignore */ }
        break;
      }
      case 'ping':
        // Keepalive desde el navegador: respondemos al instante para confirmar vida.
        if (ws) ws.isAlive = true;
        try { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'pong' })); } catch {}
        break;
      case 'connect':
        if (RELAY) {
          if (typeof onRelayAction === 'function' && data.username) {
            onRelayAction('connect', { username: String(data.username).trim().replace(/^@/, '') });
          }
          break;
        }
        if (data.username) connectTo(String(data.username).trim().replace(/^@/, ''));
        break;
      case 'disconnect':
        if (RELAY) {
          if (typeof onRelayAction === 'function') onRelayAction('disconnect', {});
          break;
        }
        disconnectManual();
        break;
      case 'saveSettings':
        if (data.settings) {
          applyIncomingSettings(data.settings, true, {
            profileActive: data.profileActive,
            editMode: data.editMode,
            settingsGeneration: data.settingsGeneration,
          });
        }
        break;
      case 'getProfiles':
        try { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'profiles', payload: profilesInfo() })); } catch {}
        break;
      case 'switchProfile':
        switchProfile(data.index);
        break;
      case 'switchGeneralProfile':
        switchToGeneralEdit();
        break;
      case 'renameProfile':
        renameProfile(data.index, data.name);
        break;
      case 'getProfilesFull':
        try { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'profilesFull', payload: getProfilesFull() })); } catch {}
        break;
      case 'importProfiles':
        importProfiles(data.profiles, data.mode, data.shared);
        break;
      case 'relayHello':
        // El .exe manda esto al conectar; asegura rol relay por si la URL aún no lo pasó.
        clientRoles.set(ws, 'relay');
        if (data.localOrigin && typeof data.localOrigin === 'string') {
          relayLocalOrigin = String(data.localOrigin).replace(/\/+$/, '');
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
      case 'testAction': {
        const a = (settings.actions || []).find((x) => x.id === data.id);
        if (a && actionDoesSomething(a)) fireAction(a);
        break;
      }
      case 'testMcAction': {
        const a = (settings.mcActions || []).find((x) => x.uid === data.uid)
          || (settings.mcshooterActions || []).find((x) => x.uid === data.uid)
          || (settings.bedrockActions || []).find((x) => x.uid === data.uid)
          || (settings.parkourActions || []).find((x) => x.uid === data.uid)
          || (settings.kothActions || []).find((x) => x.uid === data.uid)
          || (settings.farmActions || []).find((x) => x.uid === data.uid)
          || (settings.sandboxActions || []).find((x) => x.uid === data.uid);
        if (a && (a.cmd || (Array.isArray(a.cmds) && a.cmds.length))) {
          scheduleMcAction(() => runMcAction(a, buildMcVars({ giftName: 'Rose', giftId: '5655', diamonds: 1, repeatCount: 1, comment: 'Prueba' }, { nickname: 'Prueba', uniqueId: 'prueba' })));
        } else {
          broadcast('log', { level: 'warn', text: '⚠️ Acción no encontrada o sin comando configurado' });
        }
        break;
      }
      case 'testMcDraft': {
        const entry = data.entry;
        if (!entry || !mcCmdText(entry)) break;
        const once = String(data.testMode || '') !== 'timed';
        const useExtra = !once && !!data.cmdsExtra;
        const draft = {
          name: once ? 'Prueba rápida' : 'Prueba con tiempos',
          custom: true,
          cmdsExtra: useExtra,
          cmds: useExtra ? [entry] : [mcCmdText(entry)],
          repeat: once ? 1 : Math.max(1, parseInt(data.repeat, 10) || 1),
          delayEach: once ? 0 : Math.max(0, parseInt(data.delayEach, 10) || 0),
          delayGroup: once ? 0 : Math.max(0, parseInt(data.delayGroup, 10) || 0),
          delayBefore: once ? 0 : Math.max(0, parseInt(data.delayGroup, 10) || 0),
          random: false,
          radius: data.radius != null ? data.radius : 3,
          giftMult: false,
        };
        // Extra: los tiempos van en el entry; la secuencia global no se aplica encima.
        if (useExtra) {
          draft.repeat = 1;
          draft.delayGroup = 0;
          draft.delayBefore = 0;
          draft.delayEach = 0;
        }
        scheduleMcAction(() => runMcAction(draft, buildMcVars({ giftName: 'Prueba', giftId: '5655', diamonds: 1, repeatCount: 1, comment: 'Prueba' }, { nickname: 'Prueba', uniqueId: 'prueba' })));
        break;
      }
      case 'runMcRaw': {
        // Ejecuta un comando "crudo" en el servidor de Minecraft (configuraciones de
        // Bedrock: solo "Probar", no se guardan como tarjeta).
        const cmd = String(data.command || '').trim();
        if (cmd) scheduleMcAction(() => runMcAction({ cmd, name: String(data.name || 'Comando') }, buildMcVars({ nickname: 'Streamer', uniqueId: 'streamer' }, { nickname: 'Streamer', uniqueId: 'streamer' })));
        break;
      }
      case 'testMcShooterColiseo': {
        triggerMcShooterColiseo(
          { comment: String(settings?.mcshooterColiseo?.chatCmd || '!entro') },
          { nickname: 'Prueba', uniqueId: 'prueba' },
          settings,
          { force: !!data.force },
        );
        break;
      }
      case 'runActionOutputs': {
        const testUser = { nickname: 'Prueba', uniqueId: 'prueba' };
        const testInfo = { nickname: 'Prueba', username: 'prueba', giftName: 'Rose', giftId: '5655', repeatCount: 1 };
        const testTimes = Math.max(1, Number(data.times) || 1);
        runActionOutputs(
          { webhookCmd: data.webhookCmd, obsCmd: data.obsCmd, sbCmd: data.sbCmd },
          settings,
          { info: testInfo, user: testUser, times: testTimes },
        );
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
      case 'importPointsBulk': {
        try {
          const mode = data.mode === 'replace' ? 'replace' : 'merge';
          const result = importPointsUsers(data.users || [], mode);
          replyPointsImport(ws, { ...result, source: 'file' });
          broadcast('log', { level: 'info', text: `📥 Puntos importados: ${result.imported + result.updated} usuario(s) (total ${result.total}).` });
        } catch (e) {
          replyPointsImport(ws, { ok: false, error: e.message || String(e) });
        }
        break;
      }
      case 'importEmotes': {
        try {
          const list = Array.isArray(data.emotes) ? data.emotes : [];
          const before = emoteCatalog.size;
          const changed = mergeEmotes(list);
          const added = Math.max(0, emoteCatalog.size - before);
          if (changed) {
            broadcast('log', { level: 'info', text: `🎭 Stickers en catálogo: ${emoteCatalog.size}${added ? ` (+${added})` : ''}.` });
          }
          try {
            ws.send(JSON.stringify({
              type: 'importEmotesResult',
              payload: { ok: true, added, total: emoteCatalog.size },
            }));
          } catch {}
        } catch (e) {
          try {
            ws.send(JSON.stringify({
              type: 'importEmotesResult',
              payload: { ok: false, error: e.message || String(e) },
            }));
          } catch {}
        }
        break;
      }
      case 'importTikfinityPoints': {
        const channelId = String(data.channelId || '').trim();
        const mode = data.mode === 'replace' ? 'replace' : 'merge';
        (async () => {
          try {
            replyPointsImport(ws, { ok: true, pending: true, text: 'Descargando usuarios de TikFinity…' });
            const users = await fetchTikfinityChannelUsers(channelId);
            if (!users.length) {
              replyPointsImport(ws, { ok: false, error: 'TikFinity no devolvió usuarios para ese Channel ID.' });
              return;
            }
            const result = importPointsUsers(users, mode);
            replyPointsImport(ws, { ...result, source: 'tikfinity', fetched: users.length });
            broadcast('log', { level: 'info', text: `📥 TikFinity: ${users.length} usuario(s) → ${result.total} en Livecoins.` });
          } catch (e) {
            replyPointsImport(ws, { ok: false, error: e.message || String(e) });
          }
        })();
        break;
      }
      case 'decryptTikfinityTfc': {
        try {
          const ciphertext = String(data.ciphertext || '');
          if (!ciphertext || ciphertext.length < 32) {
            replyTikfinityDecrypt(ws, { ok: false, error: 'Archivo vacío o inválido.' });
            break;
          }
          if (ciphertext.length > 12_000_000) {
            replyTikfinityDecrypt(ws, { ok: false, error: 'Archivo demasiado grande.' });
            break;
          }
          const result = decryptTikfinityTfc(ciphertext, {
            channelId: data.channelId,
            password: data.password,
            username: data.username,
          });
          try {
            const emotes = Array.isArray(result.emotes) ? result.emotes : [];
            if (emotes.length) mergeEmotes(emotes);
            else {
              const fromLists = [];
              for (const a of result.data?.alertas || []) {
                if (a?.trigger === 'emote' && a.emoteId) {
                  fromLists.push({ id: a.emoteId, image: a.emoteImage || '', name: a.nombre || '' });
                }
              }
              for (const v of result.data?.videos || []) {
                if (v?.trigger === 'emote' && v.emoteId) {
                  fromLists.push({ id: v.emoteId, image: v.emoteImage || '', name: v.nombreLista || '' });
                }
              }
              if (fromLists.length) mergeEmotes(fromLists);
            }
          } catch {}
          replyTikfinityDecrypt(ws, {
            ok: true,
            data: result.data,
            hint: result.passphraseUsed,
            sourceChannelId: result.sourceChannelId || null,
            counts: result.counts || null,
            encVersion: result.encVersion || null,
            emotes: result.emotes || [],
          });
          const c = result.counts || {};
          broadcast('log', {
            level: 'info',
            text: `📥 .tfc TikFinity: ${c.alertas || 0} sonido(s), ${c.videos || 0} video(s), ${c.interacciones || 0} acción(es), ${c.minecraft || 0} Minecraft, ${c.emotes || 0} sticker(s).`,
          });
        } catch (e) {
          replyTikfinityDecrypt(ws, { ok: false, error: e.message || String(e) });
        }
        break;
      }
      case 'importTikfinityCloudSettings': {
        const channelId = String(data.channelId || '').trim();
        const events = Array.isArray(data.events) ? data.events : null;
        (async () => {
          try {
            replyTikfinityCloudSettings(ws, { ok: true, pending: true, text: 'Descargando acciones de TikFinity…' });
            const actions = await fetchTikfinityActions(channelId);
            if (!actions.length) {
              replyTikfinityCloudSettings(ws, { ok: false, error: 'TikFinity no devolvió acciones/alertas para ese User ID.' });
              return;
            }
            const legacy = mapTikfinityActionsToLegacy(actions, events);
            const counts = {
              alertas: legacy.alertas.length,
              videos: legacy.videos.length,
              interacciones: legacy.interacciones.length,
              minecraft: Array.isArray(legacy.minecraft) ? legacy.minecraft.length : 0,
              actionsFetched: actions.length,
            };
            replyTikfinityCloudSettings(ws, { ok: true, data: legacy, counts });
            broadcast('log', {
              level: 'info',
              text: `📥 TikFinity nube: ${counts.alertas} sonido(s), ${counts.videos} video(s), ${counts.interacciones} acción(es), ${counts.minecraft} Minecraft.`,
            });
          } catch (e) {
            replyTikfinityCloudSettings(ws, { ok: false, error: e.message || String(e) });
          }
        })();
        break;
      }
      case 'hello':
        if (data.role === 'videoScreen') {
          const scr = Math.max(1, Math.min(10, parseInt(data.screen, 10) || 1));
          videoScreens.set(ws, scr);
          broadcastScreens(true);
        }
        break;
      case 'mediaEnded':
      case 'soundEnded':
        if (data.id != null) clearWebhookActive(data.id);
        break;
      case 'testVideo':
        if (data.video) {
          const scr = Number(data.video.screen) || 1;
          emitMedia({
            ...data.video,
            screen: scr,
            size: data.video.size ?? screenSize(scr),
            maxDurationSec: data.video.originalDuration === false ? 5 : (data.video.maxDurationSec || 0),
            test: true,
          });
        }
        break;
      case 'testLevelUp': {
        const level = Math.max(1, Number(data.level) || 1);
        const fromLevel = Math.max(0, Number(data.fromLevel) ?? (level - 1));
        emitMemberLevelUp(
          { user: { uniqueId: 'test_user', nickname: data.nickname || 'Prueba' } },
          fromLevel,
          level,
        );
        break;
      }
      case 'testLevelVideo':
        playLevelVideo(Math.max(1, Number(data.level) || 1), data.screen);
        break;
      case 'stopVideo': {
        emitStopMedia(Number(data.screen) || 1);
        break;
      }
      case 'playMediaRelay': {
        if (data.media) {
          const m = { ...data.media };
          if (m.url) m.url = relativizeMediaUrl(m.url);
          const scr = clampMediaScreen(m.screen);
          broadcastMedia({ ...m, screen: scr, size: m.size ?? screenSize(scr) });
        }
        break;
      }
      case 'panicLocal':
        broadcast('panic', {});
        for (let scr = 1; scr <= 10; scr++) broadcast('stopMedia', { screen: scr });
        break;
      case 'testScreen': {
        const scr = Number(data.screen) || 1;
        emitMedia({ test: true, screenTest: true, name: 'Pantalla ' + scr, screen: scr, size: screenSize(scr) });
        break;
      }
      case 'ensureMarioBridge': {
        ensureMarioBridge().then((ok) => {
          broadcast('log', {
            level: ok ? 'ok' : 'warn',
            text: ok
              ? '🍄 Bridge Mario activo (SMBX2). Abre el juego en marios_pad.'
              : '🍄 Bridge Mario no disponible. Descarga SMBX2 + mod o comprueba Node.',
          });
        }).catch(() => {
          broadcast('log', {
            level: 'warn',
            text: '🍄 Bridge Mario no disponible. Descarga SMBX2 + mod o comprueba Node.',
          });
        });
        break;
      }
      case 'ensureMari0Bridge': {
        ensureMari0Bridge().then((ok) => {
          broadcast('log', {
            level: ok ? 'ok' : 'warn',
            text: ok
              ? '🌀 Bridge Mari0 activo en :7755'
              : '🌀 Bridge Mari0 no disponible. Instala el juego o comprueba Node.',
          });
        }).catch(() => {
          broadcast('log', {
            level: 'warn',
            text: '🌀 Bridge Mari0 no disponible. Instala el juego o comprueba Node.',
          });
        });
        break;
      }
      case 'marioSpawn': {
        const thing = data.thing ?? data.npcId;
        spawnMarioThing(thing, data.name, data.times);
        broadcast('log', {
          level: 'ok',
          text: `🍄 Spawn: ${thing || '?'}${Number(data.times) > 1 ? ` ×${data.times}` : ''}`,
        });
        break;
      }
      case 'marioEffect':
        applyMarioEffect(String(data.type || ''), data.seconds, data.factor);
        break;
      case 'mari0Spawn': {
        const thing0 = data.thing;
        spawnMari0Thing(thing0, data.name, data.times);
        broadcast('log', {
          level: 'ok',
          text: `🌀 Mari0 spawn: ${thing0 || '?'}${Number(data.times) > 1 ? ` ×${data.times}` : ''}`,
        });
        break;
      }
      case 'mari0Effect':
        applyMari0Effect(String(data.type || ''), data.seconds, data.factor);
        break;
      case 'smb3Spawn': {
        spawnSmb3Thing(
          data.thing,
          data.spawnId ?? data.spawn,
          data.npcId,
          data.name ?? data.viewer ?? data.nickname,
          data.times ?? data.count,
        );
        broadcast('log', {
          level: 'ok',
          text: `🎮 SMB3 spawn: ${data.thing || data.spawnId || data.npcId || '?'}${Number(data.times || data.count) > 1 ? ` ×${data.times || data.count}` : ''}`,
        });
        break;
      }
      case 'smb3Effect':
        applySmb3Effect(String(data.effect || data.type || ''), data.name ?? data.viewer, data.seconds);
        break;
      case 'pvzSpawn':
        // Prueba manual desde el panel: genera el zombie en Plants vs Zombies.
        spawnPvzThing(String(data.thing || ''), data.name, data.times);
        break;
      case 'pvzSun':
        // Prueba manual: da soles al jugador.
        givePvzSun(data.amount);
        break;
      case 'pvzCmd':
        // Prueba manual: comando GET (efecto de plantas, nivel, etc.).
        pvzCommand(String(data.path || ''));
        break;
      case 'pvzHybridSpawn':
        spawnPvzHybridThing(String(data.thing || ''), data.name, data.times);
        break;
      case 'pvzHybridSun':
        givePvzHybridSun(data.amount);
        break;
      case 'pvzHybridCmd':
        pvzHybridCommand(String(data.path || ''));
        break;
      case 'repoSpawn':
        spawnRepoThing(String(data.thing || ''), data.name, data.times);
        break;
      case 'l4dSpawn':
        spawnL4dThing(String(data.thing || ''), data.name, data.times, null, {
          params: data.params && typeof data.params === 'object' ? data.params : {},
        });
        break;
      case 'gtavKothSpawn':
        spawnGtavKothThing(String(data.thing || ''), data.name, data.times, null, {
          params: data.params && typeof data.params === 'object' ? data.params : {},
        });
        break;
      case 'gtavChaosSpawn':
        spawnGtavChaosThing(String(data.thing || ''), data.name, data.times, null, {
          params: data.params && typeof data.params === 'object' ? data.params : {},
        });
        break;
      case 'gtavChiliadSpawn':
        spawnGtavChiliadThing(String(data.thing || ''), data.name, data.times, null, {
          params: data.params && typeof data.params === 'object' ? data.params : {},
        });
        break;
      case 'unturnedSpawn':
        spawnUnturnedThing(String(data.thing || ''), data.name, data.times, null, {
          params: data.params && typeof data.params === 'object' ? data.params : {},
        });
        break;
      case 'ctrSpawn':
        spawnCtrThing(String(data.thing || ''), data.name, data.times);
        break;
      case 'smwSpawn':
        spawnSmwThing(String(data.thing || ''), data.name, data.times);
        break;
      case 'mslugSpawn':
        spawnMslugThing(String(data.thing || ''), data.name, data.times);
        break;
      case 'testSound':
        if (data.alert) emitSound({ ...data.alert, test: true });
        break;
      case 'panic':
        bumpMcPanic();
        for (const key of [...webhookActive.keys()]) clearWebhookActive(key);
        broadcast('panic', {});
        emitPanicMedia();
        broadcast('log', { level: 'info', text: '⛔ Pánico: cola de Minecraft cancelada' });
        break;
      case 'stopSounds':
        // Stop de UNA tarjeta de alerta sonora: corta solo los sonidos (panel y
        // overlays), sin tumbar videos, TTS ni la cola de Minecraft como 'panic'.
        broadcast('stopSound', {});
        broadcast('log', { level: 'info', text: '🔇 Sonidos detenidos' });
        break;
      case 'testPerrito':
        broadcast('perritoTest', { count: Number(data.count) || 200 });
        break;
      case 'resetPerrito':
        broadcast('perritoReset', {});
        break;
      case 'dropPerrito':
        broadcast('perritoDropOne', { image: data.image || '', diamonds: Number(data.diamonds) || 1, giftId: data.giftId || '', giftName: data.giftName || '' });
        break;
      case 'testJarron':
        broadcast('jarronTest', { count: Number(data.count) || 200 });
        break;
      case 'resetJarron':
        broadcast('jarronReset', {});
        break;
      case 'dropJarron':
        broadcast('jarronDropOne', { image: data.image || '', diamonds: Number(data.diamonds) || 1, giftId: data.giftId || '', giftName: data.giftName || '' });
        break;
      case 'testVaquita':
        broadcast('vaquitaTest', { count: Number(data.count) || 200 });
        break;
      case 'resetVaquita':
        broadcast('vaquitaReset', {});
        break;
      case 'dropVaquita':
        broadcast('vaquitaDropOne', { image: data.image || '', diamonds: Number(data.diamonds) || 1, giftId: data.giftId || '', giftName: data.giftName || '' });
        break;
      case 'testMarranito':
        broadcast('marranitoTest', { count: Number(data.count) || 200 });
        break;
      case 'resetMarranito':
        broadcast('marranitoReset', {});
        break;
      case 'dropMarranito':
        broadcast('marranitoDropOne', { image: data.image || '', diamonds: Number(data.diamonds) || 1, giftId: data.giftId || '', giftName: data.giftName || '' });
        break;
      case 'testCorazonLava':
        broadcast('corazonLavaTest', {
          count: Number(data.count) || 200,
          filterGiftId: data.filterGiftId || data.giftId || '',
          filterGiftName: data.filterGiftName || data.giftName || '',
          filterGiftImage: data.filterGiftImage || data.image || '',
          filterGiftDiamonds: Number(data.filterGiftDiamonds || data.diamonds) || 15,
          giftId: data.filterGiftId || data.giftId || '',
          giftName: data.filterGiftName || data.giftName || '',
          image: data.filterGiftImage || data.image || '',
          diamonds: Number(data.filterGiftDiamonds || data.diamonds) || 15,
        });
        break;
      case 'resetCorazonLava':
        broadcast('corazonLavaReset', {});
        break;
      case 'dropCorazonLava':
        broadcast('corazonLavaDropOne', { image: data.image || '', diamonds: Number(data.diamonds) || 1, giftId: data.giftId || '', giftName: data.giftName || '' });
        break;
      case 'testPelotas':
        broadcast('pelotasTest', { count: Number(data.count) || 16 });
        break;
      case 'resetPelotas':
        broadcast('pelotasReset', {});
        break;
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
      case 'giftVsControl':
        broadcast('giftVsControl', { action: data.gvsAction });
        break;
      case 'testBatallaVs': {
        const demoPhoto = '/jarron/lv.png';
        pkBattle.live = true;
        pkBattle.frozen = false;
        pkBattle.demo = true;
        pkBattle.battleId = 'demo';
        pkBattle.rivalKey = 'rival_demo';
        pkBattle.host = {
          uniqueId: followerCounter.uniqueId || state.username || 'host',
          nickname: followerCounter.nickname || 'GABY 🏆',
          photo: followerCounter.photo || demoPhoto,
          userId: pkBattle.host.userId || '',
        };
        pkBattle.rival = {
          uniqueId: 'rival_demo',
          nickname: 'Vianel 🔸',
          photo: demoPhoto,
          userId: 'rival_demo',
        };
        pkBattle.pointsHost = 210;
        pkBattle.pointsRival = 57;
        pkBattle.winsHost = 0;
        pkBattle.winsRival = 0;
        broadcast('pkBattleTest', {});
        broadcastPkBattle(true);
        break;
      }
      case 'resetBatallaVs':
        resetPkBattleAll();
        broadcast('pkBattleReset', {});
        break;
      case 'testBatallaMvp': {
        const demoPhoto = '/jarron/lv.png';
        broadcast('pkBattleMvp', {
          draw: false,
          winner: 'host',
          demo: true,
          mvp: {
            uniqueId: 'mvp_demo',
            nickname: followerCounter.nickname || 'Fan MVP',
            photo: followerCounter.photo || demoPhoto,
            points: 820,
          },
          scoreHost: 1171,
          scoreRival: 44,
        });
        break;
      }
      case 'resetBatallaMvp':
        broadcast('pkBattleMvpReset', {});
        break;
      case 'testBatallaMeta':
        broadcast('batallaMetaTest', {});
        break;
      case 'resetBatallaMeta':
        broadcast('batallaMetaReset', {});
        break;
      case 'testBatallaTop3':
        broadcast('batallaTop3Test', {});
        break;
      case 'resetBatallaTop3':
        broadcast('batallaTop3Reset', {});
        break;
      case 'startBatallaVs':
      case 'stopBatallaVs':
        // El marcador es automático con el PK de TikTok; estos botones ya no hacen falta.
        broadcastPkBattle(true);
        break;
      case 'testFlowMeter':
        broadcast('flowMeterTest', {});
        break;
      case 'resetFlowMeter':
        broadcast('flowMeterReset', {});
        break;
      case 'flowMeterControl':
        broadcast('flowMeterControl', { action: data.flwAction });
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
        clearActiveGiftOverlayRecord('topGift');
        broadcast('topGiftReset', {});
        broadcast('sessionOverlays', serializeSessionOverlaysPayload());
        break;
      case 'testLastGift':
        broadcast('lastGiftTest', { gift: data.gift || null });
        break;
      case 'resetLastGift':
        clearActiveGiftOverlayRecord('lastGift');
        broadcast('lastGiftReset', {});
        broadcast('sessionOverlays', serializeSessionOverlaysPayload());
        break;
      case 'testTop1':
        broadcast('top1Test', {});
        break;
      case 'resetTop1':
        broadcast('top1Reset', {});
        break;
      case 'testTop1Fire':
        broadcast('top1fireTest', {});
        break;
      case 'resetTop1Fire':
        resetTop1FireAll();
        break;
      case 'testTopHabibi':
        broadcast('habibiTopTest', {});
        break;
      case 'resetTopHabibi':
        resetHabibiTopAll();
        break;
      case 'testWins':
        broadcast('winsTest', {});
        break;
      case 'resetWins':
        broadcast('winsReset', {});
        break;
      case 'testWinsGamer':
        broadcast('winsGamerTest', {});
        break;
      case 'resetWinsGamer':
        broadcast('winsGamerReset', {});
        break;
      case 'testWinsMinecraft':
        broadcast('winsMinecraftTest', {});
        break;
      case 'resetWinsMinecraft':
        broadcast('winsMinecraftReset', {});
        break;
      case 'testWinsMario':
        broadcast('winsMarioTest', {});
        break;
      case 'resetWinsMario':
        broadcast('winsMarioReset', {});
        break;
      case 'testTopKills':
        broadcast('topKillsTest', {});
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
      case 'testGiftGoals':
        broadcast('giftGoalsTest', {});
        break;
      case 'resetGiftGoals':
        resetGiftGoals();
        break;
      case 'testTopStreak':
        broadcast('topStreakTest', { gift: data.gift || null });
        break;
      case 'resetTopStreak':
        clearActiveGiftOverlayRecord('topStreak');
        broadcast('topStreakReset', {});
        broadcast('sessionOverlays', serializeSessionOverlaysPayload());
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
        resetRankAll(data.rank);
        break;
      case 'testRankAlt':
        broadcast('rankAltTest', {});
        break;
      case 'resetRankAlt':
        resetRankAll('toplikes');
        resetRankAll('topdiam');
        break;
      case 'testRankMulti':
        broadcast('rankMultiTest', {});
        break;
      case 'resetRankMulti':
        resetRankAll('toplikes');
        resetRankAll('topdiam');
        resetRankAll('topcomments');
        break;
      case 'testPointsLookup':
        broadcast('pointsLookupTest', {});
        break;
      case 'resetPointsLookup':
        broadcast('pointsLookupReset', {});
        break;
      case 'testHype':
        broadcast('hypeTest', {});
        break;
      case 'resetHype':
        sessionOv.hype = { score: 0, target: Math.max(1, parseInt(settings.hypeBar?.meta, 10) || 100), coinTotal: 0 };
        saveSessionOverlays();
        broadcast('hypeReset', {});
        broadcast('sessionOverlays', serializeSessionOverlaysPayload());
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
      case 'testFuegos':
        broadcast('fuegosTest', {});
        break;
      case 'resetFuegos':
        broadcast('fuegosReset', {});
        break;
      case 'testChatGamer':
        broadcast('chatGamerTest', {});
        break;
      case 'resetChatGamer':
        broadcast('chatGamerReset', {});
        break;
      case 'testFollowerCounter': {
        const base = serializeFollowerCounter();
        broadcast('followerCounter', {
          ...base,
          count: 1234,
          followers: 1234,
          likesLive: 1234, likesWeek: 1234, likesMonth: 1234,
          diamondsLive: 1234, diamondsWeek: 1234, diamondsMonth: 1234,
          nickname: base.nickname || 'PreviewFan',
          uniqueId: base.uniqueId || 'previewfan',
          photo: base.photo || '',
          ready: true,
        });
        break;
      }
      case 'resetFollowerCounter':
        resetFollowerCounterFromRoom();
        break;
      case 'testLiveTimer':
        beginLiveUptimeTick();
        break;
      case 'resetLiveTimer':
        resetLiveUptimeSession();
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
      case 'sorteos':
        broadcast('sorteosControl', {
          action: data.sorteosAction,
          forceInitial: !!data.forceInitial,
        });
        break;
      case 'testSorteos':
        broadcast('sorteosTest', {});
        break;
      case 'testScreenFx':
        broadcast('screenFx', {
          effect: data.effect || 'black',
          durationSec: Math.max(1, Math.min(120, Number(data.durationSec) || 5)),
          giftId: data.giftId || '',
          giftName: data.giftName || 'Test',
          sound: String(data.sound || '').trim(),
          soundVol: Math.max(0, Math.min(100, Number(data.soundVol) || 80)),
          allowInteract: data.allowInteract !== false,
        });
        break;
      case 'stopScreenFx':
        broadcast('screenFxStop', {});
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
  function addClient(ws, role = 'panel') {
    clientRoles.set(ws, role === 'relay' || role === 'local' ? role : 'panel');
    clients.add(ws);
    lastSeen = Date.now();
    ws.send(JSON.stringify({ type: 'state', payload: serializeState() }));
    ws.send(JSON.stringify({ type: 'settings', payload: settings }));
    ws.send(JSON.stringify({ type: 'battle', payload: serializeBattle() }));
    ws.send(JSON.stringify({ type: 'pkBattle', payload: serializePkBattle() }));
    ws.send(JSON.stringify({ type: 'screens', payload: { connected: [...new Set(videoScreens.values())] } }));
    ws.send(JSON.stringify({ type: 'weeklyTop', payload: serializeWeeklyTop() }));
    ws.send(JSON.stringify({ type: 'top1fire', payload: serializeTop1Fire() }));
    ws.send(JSON.stringify({ type: 'habibiTop', payload: serializeHabibiTop() }));
    for (const rankId of RANK_IDS) {
      ws.send(JSON.stringify({ type: 'rankState', payload: serializeRankState(rankId) }));
    }
    ws.send(JSON.stringify({ type: 'pointsList', payload: serializePoints() }));
    ws.send(JSON.stringify({ type: 'timer', payload: serializeTimer() }));
    ws.send(JSON.stringify({ type: 'liveUptime', payload: serializeLiveUptime() }));
    ws.send(JSON.stringify({ type: 'giftCounter', payload: serializeGiftCounter() }));
    ws.send(JSON.stringify({ type: 'giftGoals', payload: serializeGiftGoals() }));
    ws.send(JSON.stringify({ type: 'sessionOverlays', payload: serializeSessionOverlaysPayload() }));
    ws.send(JSON.stringify({ type: 'followerCounter', payload: serializeFollowerCounter() }));
    ws.send(JSON.stringify({ type: 'emoteCatalog', payload: { results: [...emoteCatalog.values()] } }));
    ws.send(JSON.stringify({ type: 'communityGiftCatalog', payload: { results: [...communityGiftCatalog.values()] } }));
    try { ws.send(JSON.stringify({ type: 'profiles', payload: profilesInfo() })); } catch (e) { console.error('[profiles]', e); }
    ws.send(JSON.stringify({ type: 'spotifyQueue', payload: { queue: spotifyQueue.map((q) => ({ uniqueId: q.uniqueId, nickname: q.nickname, name: q.name, artists: q.artists, image: q.image, durationMs: q.durationMs || 0 })) } }));
    ws.send(JSON.stringify({ type: 'spotifyHistory', payload: { history: spotifyHistory } }));
    ws.send(JSON.stringify({ type: 'spotifyNowPlaying', payload: { track: spotifyNowPlaying } }));
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
    flushStreamerRank();
    stopRankStreamerTimer();
    disconnect();
    if (autoConnectTimer) { clearInterval(autoConnectTimer); autoConnectTimer = null; }
    if (screensPulseTimer) { clearInterval(screensPulseTimer); screensPulseTimer = null; }
    clearTimeout(screensBroadcastTimer);
    stopTimerInterval();
    clearTimeout(weeklySaveTimer);
    clearTimeout(statsTimer);
    // Flush perfiles YA: saveSettings() va con debounce 300ms y settings es un clone
    // de la ranura. Si solo cancelamos el timer (antes) se perdían acciones/regalos
    // al cambiar de cuenta o cerrar sesión.
    try {
      try { normalizeSettingsMediaUrls(settings); } catch {}
      persistCurrentEdit();
      saveProfilesNow();
    } catch {}
    try { writeJsonAtomic(SETTINGS_FILE, settings); } catch {}
    try {
      const data = { start: weekly.start, end: weekly.end, donors: [...weekly.donors.values()] };
      writeJsonAtomic(WEEKLY_FILE, data);
    } catch {}
    clearTimeout(pointsSaveTimer);
    try { writeJsonAtomic(POINTS_FILE, { users: [...points.values()], tx: pointsTx.slice(0, POINTS_MAX_TX) }); } catch {}
    try { saveLiveSession(); } catch {}
    try { saveSessionOverlaysNow(); } catch {}
    clearTimeout(emotesSaveTimer);
    try { saveEmotesCatalogNow(); } catch {}
    clearTimeout(communityGiftsSaveTimer);
    try { saveCommunityGiftsCatalogNow(); } catch {}
    stopSpotifyPoller();
    try { if (weekInterval) clearInterval(weekInterval); } catch {}
    try { kickAll(); } catch {}
  }

  // Chequeo de cambio de semana por room.
  const weekInterval = setInterval(ensureWeek, 60000);
  weekInterval.unref?.();
  startSpotifyPoller();

  function getStatus() {
    return {
      live: !!state.connected,
      connecting: !!state.connecting,
      liveSince: state.startedAt || null,
      account: state.username || null,
      nickname: followerCounter.nickname || state.username || null,
      photo: followerCounter.photo || '',
      viewers: Number(state.stats?.viewers) || 0,
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
    getEmotes, mergeEmotes, getCommunityGifts, mergeCommunityGifts, shutdown, getStatus, kickAll, broadcastCaps,
    listActions, executeWebhookAction, executeWebhookSound, listVideos, executeWebhookVideo,
    getSettings: () => settings,
    applySettings: (obj) => applyIncomingSettings(obj, false),
    hasSavedSettings: () => fs.existsSync(SETTINGS_FILE),
    broadcastLog: (level, text) => broadcast('log', { level, text }),
    getProfilesInfo: profilesInfo,
    getProfilesFull,
    importProfilesFull,
    profilesFullSyncScore,
    profilesFullContentScore,
    switchProfile,
    switchToGeneralEdit,
    renameProfile,
    importProfiles,
    // Modo relay (.exe): el chat lo recibe la nube; el panel reenvía aquí los comandos
    // de Spotify para procesarlos LOCALMENTE (tokens y cola viven en esta PC).
    handleSpotifyChat: (comment, user, roles) => handleSpotifyCommands(comment, user, roles),
    get clientCount() { return clients.size; },
    pushBadges: (payload) => {
      try { broadcast('badges', payload || {}); } catch { /* ignore */ }
    },
  };
}
