import { resolveVideo, validateVideo } from './youtubeManager.js';
import { createCreditsManager } from './creditsManager.js';
import { createQueueManager } from './queueManager.js';
import { createHistoryManager } from './historyManager.js';

export function createMusicEngine({ db, getSettings, broadcast, log }) {
  const credits = createCreditsManager(db);
  const queue = createQueueManager(db);
  const history = createHistoryManager(db);
  const cooldowns = new Map();

  let current = null;
  let playerState = { playing: false, paused: false, progressMs: 0, autodj: false };
  let autodjIndex = 0;

  function emit(type, data = {}) {
    if (typeof broadcast === 'function') broadcast(type, data);
  }

  function cfg() {
    const s = getSettings()?.musicRequests || {};
    return {
      enabled: s.enabled !== false,
      command: String(s.command || '!sr').trim().toLowerCase() || '!sr',
      maxDuration: Number(s.maxDuration) || 600,
      cooldown: Number(s.cooldown) || 30,
      allowDuplicates: !!s.allowDuplicates,
      followersOnly: !!s.followersOnly,
      subsOnly: !!s.subsOnly,
      modsOnly: !!s.modsOnly,
      creditsRequired: s.creditsRequired !== false,
      creditCost: Math.max(1, Number(s.creditCost) || 1),
      autodjEnabled: !!s.autodjEnabled,
      autodjPlaylist: Array.isArray(s.autodjPlaylist) ? s.autodjPlaylist : [],
      volume: Math.max(0, Math.min(100, Number(s.volume) ?? 80)),
      permMods: s.permMods !== false,
      permSubs: !!s.permSubs,
      permAll: s.permAll !== false,
      giftRewards: Array.isArray(s.giftRewards) ? s.giftRewards : [],
    };
  }

  function giftReward(giftId, giftName) {
    const name = String(giftName || '').trim().toLowerCase();
    const id = String(giftId || '').trim();
    for (const g of cfg().giftRewards) {
      if (g.giftId && String(g.giftId) === id) return g;
      if (g.giftName && String(g.giftName).trim().toLowerCase() === name) return g;
    }
    return null;
  }

  function canRequest(user, roles = {}) {
    const c = cfg();
    if (roles.isMod && c.permMods) return true;
    if (roles.isSub && c.permSubs) return true;
    if (c.permAll) return true;
    if (c.modsOnly && !roles.isMod) return false;
    if (c.subsOnly && !roles.isSub) return false;
    if (c.followersOnly && !roles.isFollower) return false;
    return true;
  }

  function onCooldown(uniqueId) {
    const key = String(uniqueId || '').trim().replace(/^@/, '').toLowerCase();
    if (!key) return false;
    const cd = cfg().cooldown * 1000;
    if (!cd) return false;
    const last = cooldowns.get(key) || 0;
    return Date.now() - last < cd;
  }

  function cooldownLeftSec(uniqueId) {
    const key = String(uniqueId || '').trim().replace(/^@/, '').toLowerCase();
    const cd = cfg().cooldown * 1000;
    if (!cd || !key) return 0;
    const last = cooldowns.get(key) || 0;
    return Math.max(0, Math.ceil((cd - (Date.now() - last)) / 1000));
  }

  function touchCooldown(uniqueId) {
    const key = String(uniqueId || '').trim().replace(/^@/, '').toLowerCase();
    if (key) cooldowns.set(key, Date.now());
  }

  function snapshot() {
    return {
      queue: queue.list(),
      current,
      playerState: { ...playerState, volume: cfg().volume },
      credits: credits.list(),
    };
  }

  function pushQueueUpdate() {
    emit('queueUpdated', { queue: queue.list() });
    emit('creditsUpdated', { credits: credits.list() });
  }

  async function addSongRequest({ query, user, priority = 0, skipCredits = false, skipCooldown = false, roles = {} }) {
    const c = cfg();
    if (!c.enabled) return { ok: false, error: 'Music Requests desactivado' };

    const uniqueId = String(user?.uniqueId || '').replace(/^@/, '');
    const nickname = user?.nickname || uniqueId;
    if (!uniqueId) return { ok: false, error: 'Usuario inválido' };

    const modBypass = !!(roles.isMod && c.permMods);
    if (!skipCooldown && !modBypass && onCooldown(uniqueId)) {
      const left = cooldownLeftSec(uniqueId);
      emit('musicAlert', { kind: 'cooldown', user: nickname, seconds: left });
      return { ok: false, error: `Estás en cooldown (${left}s restantes)` };
    }

    const resolved = await resolveVideo(query);
    if (!resolved.ok) return resolved;

    const valid = validateVideo(resolved.video, c);
    if (!valid.ok) return valid;

    if (!c.allowDuplicates) {
      if (queue.hasDuplicate(resolved.video.videoId)) {
        return { ok: false, error: 'Ese video ya está en la cola' };
      }
      if (current?.videoId === resolved.video.videoId) {
        return { ok: false, error: 'Ese video ya está sonando' };
      }
    }

    if (c.creditsRequired && !skipCredits) {
      const charge = credits.remove(uniqueId, c.creditCost);
      if (!charge.ok) {
        emit('musicAlert', { kind: 'noCredits', user: nickname, balance: charge.balance });
        return { ok: false, error: 'Sin créditos suficientes' };
      }
      emit('creditsUpdated', { credits: credits.list() });
    }

    const row = credits.find(uniqueId);
    const prio = Math.max(Number(priority) || 0, row?.priorityBoost || 0);

    const song = {
      ...resolved.video,
      requestedBy: uniqueId,
      requestedByNick: nickname,
      priority: prio,
    };
    const q = queue.add(song);
    if (!skipCooldown && !modBypass) touchCooldown(uniqueId);
    emit('songAdded', { song, queue: q });
    emit('musicAlert', { kind: 'added', song });
    pushQueueUpdate();

    if (!current) startNext();
    else if (!playerState.playing && !playerState.paused) play();
    return { ok: true, song };
  }

  function play() {
    playerState.paused = false;
    if (current) {
      playerState.playing = true;
      playerState.progressMs = playerState.progressMs || 0;
      emit('songStarted', { song: current, playerState: { ...playerState, volume: cfg().volume } });
      emit('currentSongUpdated', { song: current, playerState: { ...playerState, volume: cfg().volume } });
      return current;
    }
    return startNext();
  }

  function startNext() {
    const next = queue.shift();
    if (next) {
      playerState.autodj = false;
      current = { ...next, startedAt: Date.now() };
      playerState.playing = true;
      playerState.paused = false;
      playerState.progressMs = 0;
      emit('songStarted', { song: current });
      emit('currentSongUpdated', { song: current, playerState: { ...playerState, volume: cfg().volume } });
      pushQueueUpdate();
      return current;
    }
    return startAutodj();
  }

  function startAutodj() {
    const c = cfg();
    const pl = c.autodjPlaylist.filter((v) => v?.videoId);
    if (!c.autodjEnabled || !pl.length) {
      current = null;
      playerState.playing = false;
      playerState.autodj = false;
      emit('currentSongUpdated', { song: null, playerState: { ...playerState, volume: cfg().volume } });
      return null;
    }
    autodjIndex = autodjIndex % pl.length;
    const v = pl[autodjIndex++];
    current = {
      id: `autodj_${v.videoId}`,
      videoId: v.videoId,
      title: v.title || 'AutoDJ',
      duration: v.duration || 0,
      thumbnail: v.thumbnail || `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`,
      channel: v.channel || 'AutoDJ',
      url: v.url || `https://www.youtube.com/watch?v=${v.videoId}`,
      requestedBy: 'autodj',
      requestedByNick: 'AutoDJ',
      requestedAt: Date.now(),
      priority: 0,
      startedAt: Date.now(),
    };
    playerState.playing = true;
    playerState.paused = false;
    playerState.autodj = true;
    playerState.progressMs = 0;
    emit('songStarted', { song: current });
    emit('currentSongUpdated', { song: current, playerState: { ...playerState, volume: cfg().volume } });
    return current;
  }

  function onSongFinished() {
    if (current && current.requestedBy !== 'autodj') {
      history.add(current);
      emit('songFinished', { song: current });
      emit('musicAlert', { kind: 'finished', song: current });
    }
    current = null;
    startNext();
  }

  function skip() {
    const prev = current;
    if (prev) emit('songSkipped', { song: prev });
    current = null;
    return startNext();
  }

  function pause() {
    playerState.paused = true;
    playerState.playing = false;
    emit('playerPaused', { playerState: { ...playerState, volume: cfg().volume } });
  }

  function resume() {
    playerState.paused = false;
    playerState.playing = true;
    emit('playerResumed', { playerState: { ...playerState, volume: cfg().volume } });
  }

  function stop() {
    current = null;
    playerState.playing = false;
    playerState.paused = false;
    playerState.autodj = false;
    emit('playerStopped', {});
    emit('currentSongUpdated', { song: null, playerState: { ...playerState, volume: cfg().volume } });
  }

  function clearQueue() {
    queue.clear();
    emit('queueCleared', {});
    pushQueueUpdate();
  }

  function handleGift({ giftId, giftName, nickname, uniqueId }) {
    const reward = giftReward(giftId, giftName);
    if (!reward) return;
    const bal = credits.add(uniqueId, nickname, reward.credits || 0, { priorityBoost: reward.priority || 0 });
    emit('creditsUpdated', { credits: credits.list() });
    log?.('ok', `🎵 +${reward.credits} créditos música → ${nickname} (${bal} total)`);
  }

  async function handleChat(comment, user, roles = {}) {
    const c = cfg();
    if (!c.enabled) return null;
    const text = String(comment || '').trim();
    if (!text) return null;
    const parts = text.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const base = c.command.toLowerCase();

    if (cmd === base) {
      if (!canRequest(user, roles)) return { ok: false, error: 'Sin permiso' };
      const query = parts.slice(1).join(' ').trim();
      if (!query) return { ok: false, error: 'Escribe: !sr nombre de canción' };
      return addSongRequest({ query, user, priority: 0, roles });
    }

    if (cmd === '!queue') {
      return { ok: true, message: `🎵 Cola: ${queue.list().length} canción(es)` };
    }
    if (cmd === '!current') {
      if (!current) return { ok: true, message: '🎵 No hay canción sonando' };
      return { ok: true, message: `🎵 Ahora: ${current.title} — ${current.requestedByNick}` };
    }
    if (cmd === '!credits') {
      const bal = credits.balance(user?.uniqueId);
      return { ok: true, message: `🎵 Tienes ${bal} crédito(s)` };
    }
    if (cmd === '!skip' && roles.isMod) {
      skip();
      return { ok: true, message: '⏭️ Canción saltada' };
    }
    if (cmd === '!clearqueue' && roles.isMod) {
      clearQueue();
      return { ok: true, message: '🗑️ Cola vaciada' };
    }
    if (cmd === '!remove' && roles.isMod) {
      const n = Number(parts[1]);
      if (!Number.isInteger(n) || n < 1) return { ok: false, error: 'Uso: !remove 3' };
      queue.removeAt(n - 1);
      pushQueueUpdate();
      return { ok: true, message: `🗑️ Eliminada posición ${n}` };
    }
    return null;
  }

  function updateProgress(progressMs, extra = {}) {
    playerState.progressMs = Math.max(0, Number(progressMs) || 0);
    if (extra.playing != null) playerState.playing = !!extra.playing;
    if (current) {
      const dur = Math.floor(Number(extra.durationSec) || 0);
      if (dur > 0) current.duration = dur;
      if (extra.title && (!current.title || current.title === 'YouTube' || current.title.startsWith('Video '))) {
        current.title = String(extra.title).slice(0, 200);
      }
      if (extra.channel && !current.channel) current.channel = String(extra.channel).slice(0, 120);
    }
    const now = Date.now();
    if (!updateProgress._last || now - updateProgress._last > 400) {
      updateProgress._last = now;
      emit('musicProgress', {
        song: current ? { ...current } : null,
        playerState: { ...playerState, volume: cfg().volume },
      });
    }
  }

  function applySnapshot(snap) {
    if (!snap || typeof snap !== 'object') return;
    if (Array.isArray(snap.queue)) queue.replaceAll(snap.queue);
    if (Array.isArray(snap.credits)) credits.replaceAll(snap.credits);
    current = snap.current || null;
    playerState = {
      playing: false,
      paused: false,
      progressMs: 0,
      autodj: false,
      ...(snap.playerState || {}),
    };
    emit('musicState', snapshot());
    if (current && playerState.playing && !playerState.paused) {
      emit('songStarted', { song: { ...current }, playerState: { ...playerState, volume: cfg().volume } });
    }
  }

  return {
    cfg, snapshot, applySnapshot, credits, queue, history,
    addSongRequest, handleChat, handleGift,
    onSongFinished, skip, pause, resume, stop, clearQueue, play,
    startNext, updateProgress, emit, getCurrent: () => current,
  };
}
