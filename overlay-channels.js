/**
 * Canales WS por overlay (OBS / Live Studio).
 *
 * Sin canal (panel, relay, overlay viejo sin ov=): se manda TODO, igual que antes.
 * Con canal conocido: solo los tipos de esa lista + panic/pong.
 * Canal desconocido: TODO (no romper overlays nuevos).
 */
const ALWAYS = new Set(['panic', 'pong', 'accountPending']);
const PANEL_PAGES = new Set(['', '/', 'index.html', 'login.html', 'admin.html']);

function setOf(...xs) {
  return new Set(xs.flat().filter(Boolean));
}

const S = 'settings';
const SESSION = 'sessionOverlays';
const STATE = 'state';
const GIFT = 'gift';
const LIKE = 'like';
const BAILE = ['baileRondaState', 'baileRondaStart', 'baileRondaReset', 'baileRondaTest'];

/** filename sin .html → tipos extra (además de ALWAYS) */
export const OVERLAY_CHANNELS = {
  'baile-rank': setOf(S, GIFT, BAILE, 'baileRankTest', 'baileRankReset'),
  'baile-ronda': setOf(S, GIFT, LIKE, BAILE),
  'baile-combo': setOf(S, GIFT, BAILE, 'baileComboTest', 'baileComboReset'),
  overlay: setOf(S, 'media', 'actionAnim', 'actionAlert', 'stopMedia', 'sound', 'stopSound', GIFT, 'follow', 'share', 'member', LIKE),
  video: setOf(S, 'media', 'stopMedia'),
  top1: setOf(S, GIFT, SESSION, 'top1Test', 'top1Reset'),
  'top1fire': setOf(S, 'top1fire', 'top1fireTest', 'top1fireReset'),
  'habibi-top': setOf(S, 'habibiTop', 'habibiTopTest', 'habibiTopReset'),
  'contador-wins': setOf(S, 'winsTest', 'winsReset'),
  'contador-wins-gamer': setOf(S, 'winsGamerTest', 'winsGamerReset'),
  'contador-wins-minecraft': setOf(S, 'winsMinecraftTest', 'winsMinecraftReset'),
  'contador-wins-mario': setOf(S, 'winsMarioTest', 'winsMarioReset'),
  'contador-wins-pro': setOf(S, 'winsProTest', 'winsProReset'),
  'batalla-giftball': setOf(S, GIFT, 'pkBattle', 'pkBattleReset', 'batallaGiftBallTest', 'batallaGiftBallDropOne', 'batallaGiftBallReset'),
  batallaregalos: setOf(S, GIFT, SESSION, 'batallaGiftsTest', 'batallaGiftsReset'),
  batallalikes: setOf(S, LIKE, SESSION, 'batallaLikesTest', 'batallaLikesReset'),
  'batalla-coinbar': setOf(S, STATE, 'batallaCoinBarState', 'pkBattle', 'pkBattleReset', 'batallaCoinBarReset', 'batallaCoinBarTest'),
  'batalla-top3': setOf(S, 'pkBattle', 'pkBattleReset', 'batallaTop3Reset', 'batallaTop3Test'),
  'batalla-mvp': setOf(S, 'pkBattle', 'pkBattleMvp', 'pkBattleMvpReset', 'pkBattleReset'),
  'batalla-meta': setOf(S, 'pkBattle', 'pkBattleEnd', 'pkBattleReset', 'batallaMetaReset', 'batallaMetaTest'),
  'batalla-vs': setOf(S, STATE, 'pkBattle', 'pkBattleReset', 'pkBattleTest'),
  sorteos: setOf(S, GIFT, 'chat', 'sorteosControl', 'sorteosTest'),
  'sorteos-vidas': setOf(S, GIFT, 'chat', 'sorteosVidasControl', 'sorteosVidasTest'),
  'youtube-overlay': setOf(S, 'youtubeState', 'youtubeSeek', 'youtubeProgress'),
  'gift-metas': setOf(S, 'giftGoals', 'giftGoalsTest', 'giftGoalsReset'),
  jarron: setOf(S, STATE, GIFT, 'jarronTest', 'jarronDropOne', 'jarronReset'),
  perrito: setOf(S, STATE, GIFT, 'perritoTest', 'perritoDropOne', 'perritoReset'),
  marranito: setOf(S, STATE, GIFT, 'marranitoTest', 'marranitoDropOne', 'marranitoReset'),
  vaquita: setOf(S, STATE, GIFT, 'vaquitaTest', 'vaquitaDropOne', 'vaquitaReset'),
  'corazon-lava': setOf(S, STATE, GIFT, 'corazonLavaTest', 'corazonLavaDropOne', 'corazonLavaReset'),
  pelotas: setOf(S, 'fanBallDrop', 'goldenBall', 'pelotasTest', 'pelotasReset'),
  meta: setOf(S, STATE, LIKE, 'follow', 'share', 'member', GIFT, 'hypeTest', 'hypeReset', SESSION),
  'meta-mario': setOf(S, STATE, LIKE, 'follow', 'share', 'member', GIFT, 'hypeTest', 'hypeReset', SESSION),
  'meta-minecraft': setOf(S, STATE, LIKE, 'follow', 'share', 'member', GIFT, 'hypeTest', 'hypeReset', SESSION),
  'meta-dragonball': setOf(S, STATE, LIKE, 'follow', 'share', 'member', GIFT, 'hypeTest', 'hypeReset', SESSION),
  'spotify-overlay': setOf(S, 'spotifyNowPlaying', 'spotifyQueue', 'spotifyHistory'),
  'spotify-player-overlay': setOf(S, 'spotifyNowPlaying'),
  'tiempo-live-neon': setOf(S, STATE, 'liveUptime'),
  timer: setOf(S, 'timer', 'timerBeep'),
  'chat-gamer': setOf(S, 'chat', 'chatGamerTest', 'chatGamerReset'),
  ultimoregalo: setOf(S, GIFT, SESSION, 'lastGiftTest', 'lastGiftReset'),
  'points-lookup': setOf(S, 'pointsLookup', 'pointsLookupTest', 'pointsLookupReset'),
  'top-kills': setOf(S, 'topKillsTest'),
  'top-kills-widget': setOf(S),
  giftvs: setOf(S, GIFT, 'giftVsTest', 'giftVsReset', 'giftVsControl'),
  'medidor-flow': setOf(S, GIFT, 'flowMeterTest', 'flowMeterReset', 'flowMeterControl'),
  'join-live': setOf(S, 'member', 'streamJoinTest', 'streamJoinReset'),
  coinmatch: setOf(S, GIFT, 'coinMatchControl', 'coinMatchTest'),
  fuegos: setOf(S, GIFT, 'fuegosTest', 'fuegosReset'),
  'alerta-seguidor': setOf(S, 'follow', 'alertaFollowTest', 'alertaFollowReset'),
  'alerta-likes': setOf(S, LIKE, 'alertaLikesTest', 'alertaLikesReset'),
  'alerta-regalo': setOf(S, GIFT, 'alertaGiftTest', 'alertaGiftReset'),
  gcounter: setOf(S, 'giftCounter', 'giftCounterTest'),
  mejorregalo: setOf(S, GIFT, SESSION, 'topGiftTest', 'topGiftReset'),
  mejorracha: setOf(S, GIFT, SESSION, 'topStreakTest', 'topStreakReset'),
  'contador-seguidores': setOf(S, 'followerCounter'),
  'contador-seguidores-minecraft': setOf(S, 'followerCounter'),
  topdonor: setOf(S, 'weeklyTop', 'topDonorTest', 'topDonorTestEnd'),
  giftseq: setOf(S, 'giftSeqTest', 'giftSeqReset'),
  'gift-banda': setOf(S),
  'ruleta-regalos': setOf(S, 'rouletteStart', 'rouletteReset', 'rouletteResult'),
};

function normalizeChannel(raw) {
  let s = String(raw || '').trim().toLowerCase();
  if (!s) return '';
  s = s.replace(/\\/g, '/');
  if (/^https?:/.test(s)) {
    try { s = new URL(s).pathname; } catch { return ''; }
  }
  const file = s.split('/').pop() || '';
  if (PANEL_PAGES.has(file) || PANEL_PAGES.has(s)) return '';
  return file.replace(/\.html$/i, '');
}

export function resolveOverlayChannel(meta = {}) {
  const role = String(meta.role || '');
  if (role === 'relay' || role === 'local') return '';
  if (role === 'videoScreen') return 'video';
  const fromOv = normalizeChannel(meta.ov || meta.ch || '');
  if (fromOv) return fromOv;
  const fromPath = normalizeChannel(meta.path || '');
  if (fromPath) return fromPath;
  return normalizeChannel(meta.referer || '');
}

export function overlayAcceptsType(channel, type) {
  if (!channel) return true;
  if (ALWAYS.has(String(type || ''))) return true;
  const allow = OVERLAY_CHANNELS[channel];
  if (!allow) return true;
  return allow.has(String(type || ''));
}
