// Motor de acciones para modo nube: evalúa eventos en el servidor y delega la
// ejecución local (teclas, RCON, OBS…) al cliente PC vía WebSocket.
import { sendObsCommand, triggerStreamerbot, sendRcon, sendServertap } from './integrations.js';

export function createActionBridge({ getSettings, broadcast, broadcastToLocal, isCloud }) {
  const cloud = isCloud !== false;

  function settings() { return getSettings() || {}; }
  function log(level, text) { broadcast('log', { level, text }); }

  function emitKeyAction(payload) {
    if (cloud) broadcastToLocal('keyAction', payload);
    else broadcast('keyAction', payload);
  }

  function emitLocalExec(exec) {
    if (cloud) broadcastToLocal('localExec', exec);
    return !cloud;
  }

  function actionDoesSomething(a) {
    return !!(a && (a.keys || a.sound
      || (a.webhookCmd && a.webhookCmd.on && a.webhookCmd.url)
      || (a.obsCmd && a.obsCmd.on)
      || (a.sbCmd && a.sbCmd.on && a.sbCmd.action)));
  }

  function runActionOutputs({ webhookCmd, obsCmd, sbCmd } = {}) {
    const wh = settings().webhook || {};
    if (webhookCmd && webhookCmd.on && webhookCmd.url) {
      const method = (webhookCmd.method || 'GET').toUpperCase();
      if (emitLocalExec({ tipo: 'WEBHOOK', method, url: webhookCmd.url, body: webhookCmd.body || '' })) return;
      const opts = { method };
      if (method === 'POST' && webhookCmd.body) {
        opts.body = webhookCmd.body;
        opts.headers = { 'Content-Type': 'application/json' };
      }
      fetch(webhookCmd.url, opts)
        .then(() => log('ok', `🪝 WebHook → ${method} ${webhookCmd.url}`))
        .catch((e) => log('err', `🪝 WebHook falló: ${e.message}`));
    }
    if (obsCmd && obsCmd.on) {
      if (emitLocalExec({ tipo: 'OBS', conn: wh.obs || {}, cmd: obsCmd })) return;
      sendObsCommand(wh.obs || {}, obsCmd)
        .then((r) => log(r.ok ? 'ok' : 'err', r.ok ? `🎬 OBS: ${obsCmd.type} OK` : `🎬 OBS falló: ${r.error}`))
        .catch((e) => log('err', `🎬 OBS falló: ${e.message}`));
    }
    if (sbCmd && sbCmd.on && sbCmd.action) {
      if (emitLocalExec({ tipo: 'STREAMER_BOT', conn: wh.streamerbot || {}, action: sbCmd.action })) return;
      triggerStreamerbot(wh.streamerbot || {}, sbCmd.action)
        .then((r) => log(r.ok ? 'ok' : 'err', r.ok ? `🤖 Streamer.bot: "${sbCmd.action}" OK` : `🤖 Streamer.bot falló: ${r.error}`))
        .catch((e) => log('err', `🤖 Streamer.bot falló: ${e.message}`));
    }
  }

  function fireAction(a, times = 1) {
    const t = Math.max(1, Number(times) || 1);
    if (a.keys) {
      log('ok', `⚡ Acción: "${a.name || a.keys}" → ${a.keys}${t > 1 ? ` ×${t}` : ''}`);
      emitKeyAction({
        id: a.id, name: a.name || '', keys: a.keys, gameCompat: !!a.gameCompat,
        times: t, sound: a.sound || '', soundName: a.soundName || '',
        soundVolume: a.soundVolume != null ? a.soundVolume : 1,
      });
    } else if (a.sound) {
      emitKeyAction({
        id: a.id, name: a.name || '', keys: '', times: 1,
        sound: a.sound, soundName: a.soundName || '', soundVolume: a.soundVolume != null ? a.soundVolume : 1,
      });
    }
    runActionOutputs(a);
  }

  function triggerActions(eventType, info = {}) {
    for (const a of (settings().actions || [])) {
      if (!a || a.enabled === false || !actionDoesSomething(a)) continue;
      const ev = a.event || 'gift-any';
      if (eventType === 'gift') {
        if (ev === 'gift') {
          const wantName = (a.giftName || '').trim().toLowerCase();
          const idMatch = a.giftId && String(a.giftId) === String(info.giftId || '');
          const nameMatch = wantName && wantName === (info.giftName || '').toLowerCase();
          if (!idMatch && !nameMatch) continue;
          if ((a.minDiamonds || 0) > (info.diamonds || 0)) continue;
          if (info.comboStreak === 'delta' && !a.comboInstant) continue;
          if (info.comboStreak === 'end' && a.comboInstant) continue;
          fireAction(a, Math.max(1, Number(info.repeatCount) || 1));
          continue;
        } else if (ev === 'gift-any') {
          const total = info.totalDiamonds || 0;
          if ((a.rangeMin || 0) > total) continue;
          if ((a.rangeMax || 0) > 0 && total > a.rangeMax) continue;
          if (info.comboStreak === 'delta' && !a.comboInstant) continue;
          if (info.comboStreak === 'end' && a.comboInstant) continue;
        } else continue;
      } else if (eventType === 'like') {
        if (ev !== 'like') continue;
        if ((a.likeMin || 1) > (info.likeCount || 0)) continue;
      } else if (eventType === 'emote') {
        if (ev !== 'emote') continue;
        if ((a.emoteId || '').trim() && (a.emoteId || '').trim() !== String(info.emoteId || '')) continue;
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
      } else if (ev !== eventType) continue;
      fireAction(a);
    }
  }

  function triggerActionsLikeGlobal(total, lastTotalLikes) {
    if (!total) return;
    for (const a of (settings().actions || [])) {
      if (!a || a.enabled === false || !actionDoesSomething(a) || (a.event || '') !== 'likeGlobal') continue;
      const goal = Math.max(1, a.likeGoal || 100);
      if (Math.floor(total / goal) > Math.floor(lastTotalLikes / goal)) fireAction(a);
    }
  }

  function listActions() {
    return (settings().actions || []).map((a) => ({ id: a.id, name: a.name || '', enabled: a.enabled !== false }));
  }

  function executeWebhookAction({ id, name, data } = {}) {
    const list = settings().actions || [];
    let a = null;
    if (id != null && String(id) !== '') a = list.find((x) => String(x.id) === String(id));
    if (!a && name) {
      const n = String(name).trim().toLowerCase();
      a = list.find((x) => (x.name || '').trim().toLowerCase() === n);
    }
    if (!a) return { ok: false, error: 'not_found' };
    if (a.enabled === false) return { ok: false, error: 'disabled' };
    const d = data || {};
    const times = Math.max(1, Number(d.repeatcount ?? d.repeatCount) || 1);
    const vars = {
      username: d.username ?? d.uniqueId ?? '',
      nickname: d.nickname ?? '',
      giftname: d.giftname ?? d.giftName ?? '',
    };
    const sub = (s) => String(s == null ? '' : s).replace(/\{(\w+)\}/g, (m, k) => {
      const v = vars[k.toLowerCase()];
      return v != null && v !== '' ? String(v) : m;
    });
    const fired = { ...a, keys: sub(a.keys), name: sub(a.name || '') };
    log('ok', `🪝 Webhook → acción "${a.name || a.keys}"`);
    fireAction(fired, times);
    return { ok: true, action: { id: a.id, name: a.name || '' } };
  }

  function buildMcVars(info = {}, user = null) {
    const u = user || {};
    const clean = (v) => String(v == null ? '' : v).replace(/["\\]/g, '').slice(0, 48);
    return {
      streamer: '@p', at: '@p',
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

  function substituteMcCmd(tpl, vars, radius) {
    const map = { ...vars, streamer: '@p', at: '@p', radius: (radius != null && radius !== '') ? radius : 3 };
    let out = String(tpl == null ? '' : tpl)
      .replace(/\bexecute\s+at\s+\{(?:playername|nickname|username)\}/gi, 'execute at @p');
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
    return out;
  }

  function mcCmdText(entry) {
    if (entry == null) return '';
    if (typeof entry === 'string') return entry.trim();
    return String(entry.cmd || entry.text || '').trim();
  }

  function mcActionUsesExtra(a) {
    if (!a) return false;
    if (a.cmdsExtra) return true;
    if (!Array.isArray(a.cmds)) return false;
    return a.cmds.some((x) => x && typeof x === 'object');
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
    if (a.custom) {
      const times = a.giftMult === false ? baseRepeat : baseRepeat * rep;
      return Math.min(times, 600);
    }
    const qty = Math.max(1, parseInt(a.count, 10) || 1);
    const base = baseRepeat * qty;
    const times = a.giftMult === false ? base : base * rep;
    return Math.min(times, 200);
  }

  async function runMcActionExtra(a, vars, sendCmds, wait) {
    const defaults = { repeat: a.repeat, delayEach: a.delayEach, delayGroup: a.delayGroup, radius: a.radius };
    let entries = (Array.isArray(a.cmds) ? a.cmds : [])
      .map((e) => parseMcCmdEntry(e, defaults))
      .filter(Boolean);
    if (!entries.length) return;

    let times = mcActionRunTimes(a, vars);
    const delayGroup = Math.max(0, parseInt(a.delayGroup, 10) || 0);

    if (a.random) entries = [entries[Math.floor(Math.random() * entries.length)]];

    let totalSent = 0;
    try {
      if (delayGroup) await wait(delayGroup);
      for (let t = 0; t < times; t++) {
        for (let i = 0; i < entries.length; i++) {
          const e = entries[i];
          if (e.delayBefore) await wait(e.delayBefore);
          const rep = Math.max(1, e.repeat || 1);
          for (let r = 0; r < rep; r++) {
            if (r > 0 && e.delayEach) await wait(e.delayEach);
            const cmd = substituteMcCmd(e.cmd, vars, e.radius);
            const res = await sendCmds([cmd]);
            totalSent++;
            if (!res.ok) {
              log('err', `🟩 Minecraft "${a.name}" falló: ${res.error || 'Error'}`);
              return;
            }
          }
        }
      }
      log('ok', `🟩 Minecraft: ${a.name} OK (${totalSent})`);
    } catch (e) {
      log('err', `🟩 Minecraft "${a.name}" falló: ${e.message}`);
    }
  }

  async function runMcAction(a, vars) {
    const rcon = (settings().webhook && settings().webhook.rcon) || {};
    const stap = (settings().webhook && settings().webhook.servertap) || {};
    const useStap = !!stap.enabled;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const sendCmds = (cmds) => useStap ? sendServertap(stap, cmds) : sendRcon(rcon, cmds);

    if (mcActionUsesExtra(a)) {
      const defaults = { repeat: a.repeat, delayEach: a.delayEach, delayGroup: a.delayGroup, radius: a.radius };
      const steps = (Array.isArray(a.cmds) ? a.cmds : [])
        .map((e) => parseMcCmdEntry(e, defaults))
        .filter(Boolean)
        .map((e) => ({
          cmd: substituteMcCmd(e.cmd, vars, e.radius),
          repeat: e.repeat,
          delayEach: e.delayEach,
          delayBefore: e.delayBefore,
        }));
      if (!steps.length) return;
      let times = mcActionRunTimes(a, vars);
      if (emitLocalExec({
        tipo: 'MINECRAFT_RCON_SEQ',
        conn: useStap ? stap : rcon,
        useStap,
        delayGroup: Math.max(0, parseInt(a.delayGroup, 10) || 0),
        times,
        random: !!a.random,
        steps,
        name: a.name || '',
      })) return;
      return runMcActionExtra(a, vars, sendCmds, wait);
    }

    const lines = (a.custom && Array.isArray(a.cmds) && a.cmds.length)
      ? a.cmds
      : String(a.cmd || '').split(';;');
    const clean = lines.map((x) => mcCmdText(x)).filter(Boolean);
    if (!clean.length) return;
    const baseRepeat = Math.max(1, parseInt(a.repeat, 10) || 1);
    const qty = Math.max(1, parseInt(a.count, 10) || 1);
    let times = mcActionRunTimes(a, vars);
    const queue = [];
    for (let i = 0; i < times; i++) {
      if (a.random) queue.push(substituteMcCmd(clean[Math.floor(Math.random() * clean.length)], vars, a.radius));
      else for (const l of clean) queue.push(substituteMcCmd(l, vars, a.radius));
    }
    if (queue.length > 600) queue.length = 600;
    if (emitLocalExec({
      tipo: useStap ? 'SERVERTAP' : 'MINECRAFT_RCON',
      conn: useStap ? stap : rcon,
      commands: queue,
      name: a.name || '',
    })) return;
    try {
      const r = await sendCmds(queue);
      if (r.ok) log('ok', `🟩 Minecraft: ${a.name} OK (${queue.length})`);
      else log('err', `🟩 Minecraft "${a.name}" falló: ${r.error || 'Error'}`);
    } catch (e) {
      log('err', `🟩 Minecraft "${a.name}" falló: ${e.message}`);
    }
  }

  function fireRobloxKeys(a, times, prefix = 'rbx_') {
    if (!a?.keys) return;
    const t = Math.max(1, Number(times) || 1);
    log('ok', `🟥 Roblox: "${a.name || a.keys}" → ${a.keys}${t > 1 ? ` ×${t}` : ''}`);
    emitKeyAction({
      id: prefix + (a.slot != null ? a.slot : ''), name: a.name || 'Roblox',
      keys: a.keys, gameCompat: true, times: t, sound: '', soundName: '', soundVolume: 1,
    });
  }

  function matchGameTrigger(a, eventType, info, user) {
    const trig = a.trigger || 'gift';
    let times = Math.max(1, parseInt(a.count, 10) || 1);
    if (eventType === 'gift') {
      if (trig === 'gift') {
        const idMatch = a.giftId && String(a.giftId) === String(info.giftId || '');
        const nameMatch = (a.giftName || '').trim().toLowerCase() && (a.giftName || '').trim().toLowerCase() === (info.giftName || '').toLowerCase();
        if (!idMatch && !nameMatch) return null;
        times *= Math.max(1, Number(info.repeatCount) || 1);
      } else if (trig === 'gift-any') {
        times *= Math.max(1, Number(info.repeatCount) || 1);
      } else return null;
    } else if (eventType === 'like') {
      if (trig !== 'like') return null;
      if ((a.likeN || 1) > (info.likeCount || 0)) return null;
    } else if (eventType === 'chat') {
      if (trig === 'chatCommand') {
        if (!matchesCommand(a.text, info.comment)) return null;
      } else if (trig === 'chatUser') {
        const want = String(a.text || '').replace(/^@/, '').trim().toLowerCase();
        if (!want) return null;
        const uname = String(info.username || '').toLowerCase();
        const nname = String(info.nickname || '').toLowerCase();
        if (want !== uname && want !== nname) return null;
      } else return null;
    } else if (trig !== eventType) return null;
    return times;
  }

  function triggerRobloxList(list, eventType, info, user, prefix) {
    for (const a of list) {
      if (!a || a.enabled === false || !a.keys) continue;
      const times = matchGameTrigger(a, eventType, info, user);
      if (times == null) continue;
      if (eventType === 'gift' && info.comboStreak === 'delta' && !a.comboInstant) continue;
      if (eventType === 'gift' && info.comboStreak === 'end' && a.comboInstant) continue;
      fireRobloxKeys(a, times, prefix);
    }
  }

  function spawnMarioThing(thing, name, times) {
    const t = Math.max(1, Number(times) || 1);
    if (emitLocalExec({ tipo: 'MARIO_SPAWN', thing, name: String(name || ''), times: t })) return;
  }

  function applyMarioEffect(type, seconds, factor) {
    if (emitLocalExec({
      tipo: 'MARIO_EFFECT', type, seconds: Math.min(60, Math.max(1, Number(seconds) || 5)),
      factor: Math.min(10, Math.max(0, Number(factor) || 0)),
    })) return;
  }

  function spawnPvzThing(thing, name, times) {
    const t = Math.min(20, Math.max(1, Number(times) || 1));
    if (emitLocalExec({ tipo: 'PVZ_SPAWN', thing, name: String(name || ''), times: t })) return;
  }

  function givePvzSun(amount) {
    if (emitLocalExec({ tipo: 'PVZ_SUN', amount: Math.min(9990, Math.max(1, Number(amount) || 50)) })) return;
  }

  function pvzCommand(p) {
    const path = String(p || '');
    if (!path.startsWith('/')) return;
    if (emitLocalExec({ tipo: 'PVZ_CMD', path })) return;
  }

  function triggerMarioActions(eventType, info = {}, user = null) {
    const name = (user && user.nickname) || info.nickname || '';
    for (const a of (settings().marioActions || [])) {
      if (!a || a.enabled === false || !a.thing) continue;
      const times = matchGameTrigger(a, eventType, info, user);
      if (times == null) continue;
      if (eventType === 'gift' && info.comboStreak === 'end') continue;
      if ((a.kind || 'spawn') === 'effect') {
        log('ok', `🍄 Mario: efecto "${a.thing}" (${a.seconds || 5}s)`);
        applyMarioEffect(a.thing, a.seconds, a.factor);
      } else {
        log('ok', `🍄 Mario: generar "${a.thing}"${times > 1 ? ` ×${times}` : ''}`);
        spawnMarioThing(a.thing, name, times);
      }
    }
  }

  function triggerPvzActions(eventType, info = {}, user = null) {
    const name = (user && user.nickname) || info.nickname || '';
    for (const a of (settings().pvzActions || [])) {
      if (!a || a.enabled === false || !a.thing) continue;
      const times = matchGameTrigger(a, eventType, info, user);
      if (times == null) continue;
      if (eventType === 'gift' && info.comboStreak === 'end') continue;
      if ((a.kind || 'spawn') === 'sun') {
        log('ok', `🧟 PvZ: dar ${a.amount || 50} soles`);
        givePvzSun(a.amount);
      } else if ((a.kind || 'spawn') === 'cmd') {
        log('ok', `🧟 PvZ: ${a.label || a.thing}`);
        pvzCommand(a.path);
      } else {
        log('ok', `🧟 PvZ: generar "${a.thing}"${times > 1 ? ` ×${times}` : ''}`);
        spawnPvzThing(a.thing, name, times);
      }
    }
  }

  function playMcActionSound(a, times = 1) {
    if (!a || !a.audioOn || !a.sound) return;
    const n = Math.max(1, Math.min(Number(times) || 1, 50));
    for (let i = 0; i < n; i++) {
      broadcast('sound', {
        id: a.uid || a.catId || '',
        name: a.name || a.soundName || 'Minecraft',
        sound: a.sound,
        image: a.image || (a.catId ? `/img/minecraft/${a.catId}.png` : ''),
        volume: a.soundVolume != null ? a.soundVolume : 100,
      });
    }
  }

  function triggerMinecraftActions(eventType, info = {}, user = null) {
    triggerRobloxList(settings().robloxActions || [], eventType, info, user, 'rbx_');
    triggerRobloxList(settings().roblox3Actions || [], eventType, info, user, 'rbx3_');
    triggerMarioActions(eventType, info, user);
    triggerPvzActions(eventType, info, user);
    const vars = buildMcVars(info, user);
    // Minecraft, Bedrock y Sandbox comparten ejecución (mismo servidor por RCON/ServerTap).
    const both = [].concat(settings().mcActions || [], settings().bedrockActions || [], settings().sandboxActions || []);
    for (const a of both) {
      if (!a || a.enabled === false) continue;
      if (!a.cmd && !(Array.isArray(a.cmds) && a.cmds.length)) continue;
      const times = matchGameTrigger(a, eventType, info, user);
      if (times == null) continue;
      if (eventType === 'gift' && info.comboStreak === 'delta' && !a.comboInstant) continue;
      if (eventType === 'gift' && info.comboStreak === 'end' && a.comboInstant) continue;
      const soundTimes = eventType === 'gift' ? Math.max(1, Number(info.repeatCount) || 1) : 1;
      playMcActionSound(a, soundTimes);
      runMcAction(a, vars);
    }
  }

  function triggerLikeGlobalExtras(total, lastTotalLikes) {
    triggerActionsLikeGlobal(total, lastTotalLikes);
    const vars = buildMcVars({ likeCount: total }, null);
    for (const a of [].concat(settings().mcActions || [], settings().bedrockActions || [], settings().sandboxActions || [])) {
      if (!a || a.enabled === false || (a.trigger || '') !== 'likeGlobal') continue;
      if (!a.cmd && !(Array.isArray(a.cmds) && a.cmds.length)) continue;
      const goal = Math.max(1, a.likeN || 100);
      if (Math.floor(total / goal) > Math.floor(lastTotalLikes / goal)) {
        playMcActionSound(a);
        runMcAction(a, vars);
      }
    }
    for (const a of (settings().robloxActions || [])) {
      if (!a || a.enabled === false || (a.trigger || '') !== 'likeGlobal' || !a.keys) continue;
      const goal = Math.max(1, a.likeN || 100);
      if (Math.floor(total / goal) > Math.floor(lastTotalLikes / goal)) fireRobloxKeys(a, Math.max(1, parseInt(a.count, 10) || 1), 'rbx_');
    }
    for (const a of (settings().roblox3Actions || [])) {
      if (!a || a.enabled === false || (a.trigger || '') !== 'likeGlobal' || !a.keys) continue;
      const goal = Math.max(1, a.likeN || 100);
      if (Math.floor(total / goal) > Math.floor(lastTotalLikes / goal)) fireRobloxKeys(a, Math.max(1, parseInt(a.count, 10) || 1), 'rbx3_');
    }
  }

  return {
    fireAction, triggerActions, triggerMinecraftActions, triggerLikeGlobalExtras,
    runActionOutputs, runMcAction, playMcActionSound, buildMcVars, mcCmdText, listActions, executeWebhookAction, actionDoesSomething,
    spawnMarioThing, applyMarioEffect, spawnPvzThing, givePvzSun, pvzCommand,
  };
}

function matchesCommand(command, comment) {
  const cmd = String(command || '').trim().toLowerCase();
  if (!cmd) return false;
  const text = String(comment || '').trim().toLowerCase();
  if (!text) return false;
  return text === cmd || text.split(/\s+/)[0] === cmd;
}
