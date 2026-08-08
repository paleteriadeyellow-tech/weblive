/**
 * Descifra y normaliza exports .tfc de TikFinity (esquema compatible con TikControl).
 * CommonJS + ESM friendly via createRequire from room.js (ESM).
 */
import crypto from 'node:crypto';

const OUTER_PASS = 'lolsurghwi378ukasfjsdf_s';
const SWAP = { U: 'V', V: 'U', i: 'j', j: 'i', r: 's', s: 'r' };

const SOUND_SYNTH = {
  505001: { trigger: 'follow' },
  505002: { trigger: 'share' },
  505003: { trigger: 'subscribe' },
  // TikFinity: "any gift" / genéricos — en Livecoins = regalo sin filtro
  505004: { trigger: 'gift', anyGift: true },
  505005: { trigger: 'gift', anyGift: true },
};

/** IDs largos de TikTok (estilo snowflake) = stickers/emotes, no regalos. */
function looksLikeEmoteId(id) {
  const s = String(id || '').trim();
  if (!/^\d+$/.test(s)) return false;
  // Regalos clásicos: pocos dígitos. Stickers/sub-emotes: ~15–19 dígitos.
  return s.length >= 12;
}

const EVENT_TRIGGER = {
  1: 'share',
  2: 'chatCommand',
  3: 'gift-diamonds', // min diamonds / barras
  4: 'gift', // specific gift
  7: 'like',
  8: 'emote', // sub emote / sticker (si aparece en el export)
  9: 'follow',
  10: 'subscribe',
  11: 'chatCommand',
  12: 'emote',
};

/** Normaliza comandos TikFinity (PLAYERNAME) → Livecoins ({playername} / @p). */
export function normalizeTikfinityMcCmd(cmd) {
  let s = String(cmd || '').trim();
  if (!s) return '';
  // Primero el caso execute at PLAYERNAME → @p (streamer), luego placeholders.
  s = s
    .replace(/\bexecute\s+at\s+PLAYERNAME\b/gi, 'execute at @p')
    .replace(/\bexecute\s+as\s+PLAYERNAME\b/gi, 'execute as @p')
    .replace(/%playername%/gi, '{playername}')
    .replace(/\bPLAYERNAME\b/g, '{playername}');
  return s;
}

/** Intenta emparejar con el catálogo visual de Livecoins (icono). */
function guessMcCatalog(cmd, name) {
  const blob = `${cmd || ''} ${name || ''}`.toLowerCase();
  const hits = [
    [/enchanted_golden_apple|manzana\s*dorada\s*encantada/, 'mc_golden_apple', 'Manzana Dorada Encantada', 'Se añade a tu inventario', 'give @p minecraft:enchanted_golden_apple 1'],
    [/totem_of_undying|t[oó]tem/, 'mc_totem', 'Tótem de Inmortalidad', 'Te da una segunda oportunidad', 'give @p minecraft:totem_of_undying 1'],
    [/diamond_sword|kit\s*diamante/, 'mc_diamond_kit', 'Kit Diamante', 'Full Armadura + Espada', null],
    [/diamond_helmet|armadura\s*diamante/, 'mc_diamond_helmet', 'Armadura Diamante', 'Se equipa automáticamente', 'item replace entity @p armor.head with minecraft:diamond_helmet'],
    [/\bgive\s+@p\s+minecraft:apple\b|\bmanzanas\b/, 'mc_apple', 'Manzanas', 'Van a tu inventario', 'give @p minecraft:apple 5'],
    [/summon\s+tnt|tnt\s*encendida/, 'mc_spawn_tnt', 'TNT Encendida', 'A tu lado', 'execute at @p run summon tnt ~1 ~ ~ {Fuse:60}'],
    [/lightning_bolt|rayo/, 'mc_lightning', 'Rayo Mortal', 'En tu posición', 'execute at @p run summon lightning_bolt ~ ~ ~'],
    [/minecraft:lava|cubo\s*de\s*lava/, 'mc_lava_drop', 'Cubo de Lava', 'Bloque en el suelo', 'execute at @p run setblock ~ ~ ~ minecraft:lava'],
    [/minecraft:anvil|yunque/, 'mc_yunque_caida', 'Yunque Aplastador', 'Cae para romper techos', 'execute at @p run setblock ~ ~10 ~ minecraft:anvil'],
    [/summon\s+warden|\bwarden\b/, 'mc_warden', 'El Warden', 'MUERTE INSTANTÁNEA', null],
    [/summon\s+wither\b/, 'mc_wither', 'Jefe: Wither', 'Destruirá tu mundo', null],
    [/summon\s+creeper.*powered|creeper\s*cargado/, 'mc_spawn_creeper_charged', 'Creeper Cargado', 'Detrás de ti', null],
    [/summon\s+zombie\b/, 'mc_spawn_zombie', 'Invocación Zombie', 'A tu lado derecho', null],
    [/summon\s+skeleton\b/, 'mc_spawn_skeleton', 'Esqueleto Arquero', 'Frente a ti', null],
  ];
  for (const [re, id, n, desc, catCmd] of hits) {
    if (re.test(blob)) return { id, name: n, desc, catCmd };
  }
  return null;
}

function mcTriggerFromEvent(ev) {
  if (!ev) return { trigger: 'gift', giftId: '', giftName: '', likeMin: 0, range: '', rangeMin: 0, rangeMax: 0 };
  let trigger = EVENT_TRIGGER[ev.triggerTypeId] || 'gift';
  const giftIdRaw = ev.giftId != null ? String(ev.giftId) : '';
  if (looksLikeEmoteId(giftIdRaw) || ev.emoteId) trigger = 'emote'; // MC no usa emote; se queda gift vacío
  if (trigger === 'emote') trigger = 'gift'; // fallback: usuario asigna regalo luego
  if (trigger === 'gift-diamonds') {
    const min = Math.max(0, Number(ev.minBarsAmount) || Number(ev.minDiamonds) || 0);
    return {
      trigger: 'gift-diamonds',
      giftId: '',
      giftName: '',
      likeMin: 0,
      text: '',
      rangeMin: min,
      rangeMax: 0,
    };
  }
  if (trigger === 'like') {
    return {
      trigger: 'like',
      giftId: '',
      giftName: '',
      likeMin: Math.max(1, Number(ev.minLikesAmount) || 1),
      text: '',
      rangeMin: 0,
      rangeMax: 0,
    };
  }
  if (trigger === 'chatCommand') {
    return {
      trigger: 'chatCommand',
      giftId: '',
      giftName: '',
      likeMin: 0,
      text: String(ev.chatCommand || ev.command || ev.triggerValue || '').trim(),
      rangeMin: 0,
      rangeMax: 0,
    };
  }
  const giftName = String(ev.giftName || '').trim();
  const giftId = giftIdRaw && !looksLikeEmoteId(giftIdRaw) ? giftIdRaw : '';
  // Sin regalo concreto → cualquier regalo (como “elegir regalo” vacío en UI)
  if (trigger === 'gift' && !giftName && !giftId) {
    return { trigger: 'gift-any', giftId: '', giftName: '', likeMin: 0, text: '', rangeMin: 0, rangeMax: 0 };
  }
  return {
    trigger,
    giftId,
    giftName,
    likeMin: 0,
    text: '',
    rangeMin: 0,
    rangeMax: 0,
  };
}

/** OBS por acción TikFinity → obsCmd de Acciones Livecoins. */
export function tikfinityObsCmdFromAction(a) {
  const scene = String(a?.obsSceneId || a?.obsScene || '').trim();
  const source = String(a?.obsSourceId || a?.obsSource || '').trim();
  if (!scene && !source) return null;
  if (source) {
    return { on: true, type: 'showSource', scene: scene || '', source };
  }
  return { on: true, type: 'scene', scene, source: '' };
}

/** Streamer.bot por acción TikFinity → sbCmd de Acciones Livecoins. */
export function tikfinitySbCmdFromAction(a) {
  const action = String(
    a?.streamerbotActionId
    || a?.streamerBotActionId
    || a?.streamerbotAction
    || a?.streamerBotActionName
    || a?.sbAction
    || ''
  ).trim();
  if (!action) return null;
  return { on: true, action, staggerOn: false, staggerMs: 300 };
}

/**
 * Acciones TikFinity con mcCmd → entradas Livecoins mcActions (Juegos → Minecraft).
 */
export function mapTikfinityActionsToMc(actions, events) {
  const eventByAction = new Map();
  for (const ev of events || []) {
    if (!ev) continue;
    const ids = [
      ...(Array.isArray(ev.actionIds) ? ev.actionIds : []),
      ...(Array.isArray(ev.actionRandomIds) ? ev.actionRandomIds : []),
      ...(ev.actionId != null ? [ev.actionId] : []),
    ];
    for (const id of ids) {
      const n = Number(id);
      if (!Number.isFinite(n)) continue;
      if (!eventByAction.has(n)) eventByAction.set(n, ev);
    }
  }
  const out = [];
  for (const a of actions || []) {
    if (!a || a.isDeleted) continue;
    const rawCmd = String(
      a.mcCmd
      || a.minecraftCmd
      || a.minecraftCommand
      || a.dynamicConfig?.mcCmd
      || a.dynamicConfig?.minecraftCmd
      || a.dynamicConfig?.command
      || ''
    ).trim();
    if (!rawCmd) continue;
    const cmd = normalizeTikfinityMcCmd(rawCmd);
    if (!cmd) continue;
    const name = String(a.name || 'Minecraft').slice(0, 80) || 'Minecraft';
    const ev = eventByAction.get(Number(a.id));
    const trig = mcTriggerFromEvent(ev);
    const hit = guessMcCatalog(cmd, name);
    // Los comandos personalizados de Livecoins usan `cmds[]`; el modal de edición solo lee eso.
    const cmdLines = cmd
      .split(/\n+|;;+/)
      .map((l) => l.replace(/^\s*\/+/, '').trim())
      .filter(Boolean);
    const primary = cmdLines[0] || cmd.replace(/^\s*\/+/, '').trim();
    const entry = {
      catId: hit?.id || '',
      name: name || hit?.name || 'Minecraft',
      desc: hit?.desc || 'Importado de TikFinity',
      trigger: trig.trigger,
      giftId: trig.giftId,
      giftName: trig.giftName,
      giftImage: '',
      enabled: a.isDeleted !== true && (ev ? ev.active !== false : true),
      count: 1,
      comboInstant: true,
      likeMin: trig.likeMin || 0,
      text: trig.text || '',
      rangeMin: trig.rangeMin || 0,
      rangeMax: trig.rangeMax || 0,
      image: String(a.imageUrl || '').trim(),
      sound: String(a.audioUrl || '').trim(),
      soundName: a.audioUrl ? String(a.dynamicConfig?.audioUrlOriginalFilename || 'audio').slice(0, 80) : '',
      audioOn: !!a.audioUrl,
      soundVolume: Math.max(0, Math.min(100, Math.round(Number(a.dynamicConfig?.mediaSoundVolume ?? 100) || 100))),
      custom: true,
      cmd: primary,
      cmds: cmdLines.length ? cmdLines : [primary],
      game: 'minecraft',
    };
    out.push(entry);
  }
  return out;
}

function evpBytesToKey(password, salt, keyLen, ivLen) {
  const parts = [];
  let data = Buffer.alloc(0);
  const pass = Buffer.from(String(password), 'utf8');
  while (Buffer.concat(parts).length < keyLen + ivLen) {
    const hash = crypto.createHash('md5');
    hash.update(data);
    hash.update(pass);
    if (salt) hash.update(salt);
    data = hash.digest();
    parts.push(data);
  }
  const ms = Buffer.concat(parts);
  return { key: ms.slice(0, keyLen), iv: ms.slice(keyLen, keyLen + ivLen) };
}

function decryptOpenSsl(b64, password) {
  const buf = Buffer.from(String(b64 || '').replace(/\s+/g, ''), 'base64');
  if (buf.length < 32 || buf.slice(0, 8).toString('utf8') !== 'Salted__') {
    throw new Error('Ciphertext no tiene cabecera Salted__');
  }
  const salt = buf.slice(8, 16);
  const ct = buf.slice(16);
  const { key, iv } = evpBytesToKey(password, salt, 32, 16);
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

function shash(nonce, version) {
  let input = String(nonce);
  if (version === 2) input = Buffer.from(input + 'Mozilla', 'utf8').toString('base64');
  else if (version === 3) input = Buffer.from(input + 'dfgkjoi3kdjkfe', 'utf8').toString('base64');
  else if (version === 4) input = Buffer.from(input + 'dfgkjol3kdjkfe', 'utf8').toString('base64');

  const n = [305419896, 2596069104, 4275878552, 2271560481];
  const o = Array.from(Buffer.from(input, 'utf8'));
  const bitLen = 8 * o.length;
  o.push(128);
  while (o.length % 64 !== 56) o.push(0);
  const lenBuf = Buffer.alloc(8);
  lenBuf.writeUInt32LE(bitLen >>> 0, 0);
  o.push(...lenBuf);
  const rotl = (x, t) => ((x << t) | (x >>> (32 - t))) >>> 0;

  for (let e = 0; e < o.length; e += 64) {
    const t = new Uint32Array(16);
    for (let r = 0; r < 16; r++) {
      t[r] = (o[e + 4 * r] | (o[e + 4 * r + 1] << 8) | (o[e + 4 * r + 2] << 16) | (o[e + 4 * r + 3] << 24)) >>> 0;
    }
    let a = n[0];
    let b = n[1];
    let c = n[2];
    let d = n[3];
    for (let i = 0; i < 64; i++) {
      let f;
      let g;
      if (i < 16) { f = (b & c) | (~b & d); g = i; }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; }
      else { f = c ^ (b | ~d); g = (7 * i) % 16; }
      f >>>= 0;
      const k = Math.floor(4294967295 * Math.abs(Math.sin(i + 1)));
      const u = (b + rotl((a + f + t[g] + k) >>> 0, (i % 4) + 4)) >>> 0;
      a = d;
      d = c;
      c = b;
      b = u;
    }
    n[0] = (n[0] + a) >>> 0;
    n[1] = (n[1] + b) >>> 0;
    n[2] = (n[2] + c) >>> 0;
    n[3] = (n[3] + d) >>> 0;
  }
  return n.map((x) => x.toString(16).padStart(8, '0')).join('');
}

function swapChars(s) {
  return String(s).replace(/[UVijrs]/g, (ch) => SWAP[ch] || ch);
}

function tryPlainReversedB64(raw) {
  try {
    const rev = String(raw).split('').reverse().join('');
    const pad = '='.repeat((4 - (rev.length % 4)) % 4);
    const json = decodeURIComponent(Buffer.from(rev + pad, 'base64').toString('binary'));
    const o = JSON.parse(json);
    if (o && typeof o === 'object' && o.version) return o;
  } catch { /* ignore */ }
  return null;
}

export function decryptTfc(raw) {
  const s = String(raw || '').trim();
  if (!s) throw new Error('Archivo .tfc vacío');
  const plain = tryPlainReversedB64(s);
  if (plain) return { encVersion: 1, nonce: null, payload: plain };

  const outer = decryptOpenSsl(s, OUTER_PASS).toString('utf8');
  const parts = outer.split(':');
  if (parts.length < 3) throw new Error(`Formato .tfc inesperado (${parts.length} partes)`);
  const version = parseInt(String(parts[0]).replace(/^v/i, ''), 10);
  const nonce = Buffer.from(parts[1], 'base64').toString('utf8');
  let innerB64 = parts.slice(2).join(':');
  if (version >= 3) innerB64 = swapChars(innerB64);
  const innerPass = shash(nonce, version);
  const innerJson = decryptOpenSsl(innerB64, innerPass).toString('utf8');
  const parsed = JSON.parse(innerJson);
  const b64RawData = parsed?.b64RawData;
  if (!b64RawData) throw new Error('Payload .tfc sin b64RawData');
  const rev = String(b64RawData).split('').reverse().join('');
  const pad = '='.repeat((4 - (rev.length % 4)) % 4);
  const payloadJson = decodeURIComponent(Buffer.from(rev + pad, 'base64').toString('binary'));
  return { encVersion: version, nonce, payload: JSON.parse(payloadJson) };
}

export function normalizeCharArrayObj(v) {
  if (v == null) return v;
  if (typeof v === 'string') {
    try { return JSON.parse(v); } catch { return v; }
  }
  if (typeof v !== 'object') return v;
  const keys = Object.keys(v).filter((k) => /^\d+$/.test(k));
  if (!keys.length) return v;
  const joined = keys.map(Number).sort((a, b) => a - b).map((k) => v[k]).join('');
  try { return JSON.parse(joined); } catch { return v; }
}

export function normalizePayload(payload) {
  const dyn = (payload && payload.dynamicSettings) || {};
  return {
    version: payload?.version,
    sourceChannelId: payload?.sourceChannelId,
    actions: Array.isArray(payload?.actions) ? payload.actions : [],
    events: normalizeCharArrayObj(dyn.events) || [],
    sounds: normalizeCharArrayObj(dyn.soundsdatasource) || [],
    timer: normalizeCharArrayObj(dyn.timer) || [],
    raw: payload,
  };
}

function giftRefFromEvent(ev) {
  if (!ev) return '';
  const name = String(ev.giftName || '').trim();
  if (name) return name;
  if (ev.giftId != null && ev.giftId !== '') return `#${ev.giftId}`;
  return '';
}

/**
 * Convierte payload TikFinity normalizado → formato legacy Livecoins
 * (alertas / videos / interacciones) para SettingsTransfer.convertLegacy.
 */
export function mapNormalizedToLegacy(norm) {
  const actions = Array.isArray(norm?.actions) ? norm.actions : [];
  const events = Array.isArray(norm?.events) ? norm.events : [];
  const sounds = Array.isArray(norm?.sounds) ? norm.sounds : [];

  const byActionId = new Map();
  for (const a of actions) {
    if (a && a.id != null) byActionId.set(Number(a.id), a);
  }

  // Primer evento por actionId (para regalo/trigger)
  const eventByAction = new Map();
  for (const ev of events) {
    if (!ev) continue;
    const ids = [
      ...(Array.isArray(ev.actionIds) ? ev.actionIds : []),
      ...(Array.isArray(ev.actionRandomIds) ? ev.actionRandomIds : []),
    ];
    for (const id of ids) {
      const n = Number(id);
      if (!eventByAction.has(n)) eventByAction.set(n, ev);
    }
  }

  const alertas = [];
  const videos = [];
  const interacciones = [];

  // Sound Alerts (página de sonidos de TikFinity) — nunca descartar si hay URL.
  for (const s of sounds) {
    if (!s || !s.soundUrl) continue;
    const trigRaw = String(s.triggerId || s.emoteId || '').trim();
    let trigger = 'gift';
    let nombreRegalo = '';
    let giftId = '';
    let emoteId = '';
    let emoteImage = String(s.emoteImageUrl || s.emoteImage || s.imageUrl || '').trim();
    let anyGift = false;
    if (/^\d+$/.test(trigRaw)) {
      const n = Number(trigRaw);
      const synth = SOUND_SYNTH[n];
      if (synth) {
        trigger = synth.trigger;
        anyGift = !!synth.anyGift;
      } else if (looksLikeEmoteId(trigRaw)) {
        trigger = 'emote';
        emoteId = trigRaw;
      } else {
        trigger = 'gift';
        giftId = trigRaw;
        for (const ev of events) {
          if (String(ev.giftId) === trigRaw && ev.giftName) {
            nombreRegalo = String(ev.giftName);
            break;
          }
        }
        if (!nombreRegalo) nombreRegalo = `#${trigRaw}`;
      }
    } else if (!trigRaw) {
      anyGift = true;
      trigger = 'gift';
    }
    alertas.push({
      nombre: String(s.soundName || (emoteId ? `Sticker ${emoteId.slice(-6)}` : 'Sonido')).slice(0, 80) || 'Sonido',
      audioUrl: String(s.soundUrl),
      audioName: String(s.soundName || 'audio').slice(0, 80),
      volumen: Math.max(0, Math.min(100, Math.round(Number(s.volume) || 80))),
      enabled: s.enabled !== false && !s.isTempDisabled,
      trigger,
      nombreRegalo: (trigger === 'gift' && !anyGift) ? nombreRegalo : '',
      giftId: (trigger === 'gift' && !anyGift) ? giftId : '',
      emoteId: trigger === 'emote' ? emoteId : '',
      emoteImage: trigger === 'emote' ? emoteImage : '',
    });
  }

  for (const a of actions) {
    if (!a || a.isDeleted) continue;
    const ev = eventByAction.get(Number(a.id));
    let eventType = ev ? (EVENT_TRIGGER[ev.triggerTypeId] || 'gift') : 'gift';
    // Si el “giftId” del evento es un snowflake → sticker
    const evGiftOrEmote = ev?.giftId != null ? String(ev.giftId) : (ev?.emoteId != null ? String(ev.emoteId) : '');
    if (ev && looksLikeEmoteId(evGiftOrEmote)) eventType = 'emote';
    if (ev?.emoteId || ev?.emoteImageUrl) eventType = 'emote';
    const giftRef = giftRefFromEvent(ev);
    const volPct = Math.max(0, Math.min(100, Math.round(Number(a.dynamicConfig?.mediaSoundVolume ?? 100) || 100)));
    const name = String(a.name || 'Acción').slice(0, 80);
    const enabled = a.isDeleted !== true && (ev ? ev.active !== false : true);
    const emoteId = eventType === 'emote'
      ? String(ev?.emoteId || (looksLikeEmoteId(evGiftOrEmote) ? evGiftOrEmote : '') || '').trim()
      : '';
    const emoteImage = eventType === 'emote'
      ? String(ev?.emoteImageUrl || ev?.emoteImage || ev?.giftImage || '').trim()
      : '';

    const mapTrigger = () => {
      if (eventType === 'like') return 'like';
      if (eventType === 'follow') return 'follow';
      if (eventType === 'share') return 'share';
      if (eventType === 'emote') return 'emote';
      if (eventType === 'subscribe') return 'subscribe';
      return 'gift';
    };
    const trig = mapTrigger();

    if (a.videoUrl) {
      videos.push({
        nombreLista: name,
        videoUrl: String(a.videoUrl),
        videoName: String(a.dynamicConfig?.videoUrlOriginalFilename || 'video').slice(0, 80),
        videoVol: volPct,
        screen: Math.max(1, Math.min(10, Number(a.screenId) || 1)),
        enabled,
        nombreRegalo: trig === 'gift' ? giftRef : '',
        trigger: trig,
        giftId: trig === 'gift' && ev?.giftId != null ? String(ev.giftId) : '',
        emoteId,
        emoteImage,
        likeMin: trig === 'like' ? Math.max(1, Number(ev?.minLikesAmount) || 1) : 0,
        minDiamonds: ev?.minBarsAmount != null ? Number(ev.minBarsAmount) || 0 : 0,
      });
    } else if (a.audioUrl) {
      alertas.push({
        nombre: name,
        audioUrl: String(a.audioUrl),
        audioName: String(a.dynamicConfig?.audioUrlOriginalFilename || 'audio').slice(0, 80),
        volumen: volPct,
        enabled,
        nombreRegalo: trig === 'gift' ? giftRef : '',
        trigger: trig,
        giftId: trig === 'gift' && ev?.giftId != null ? String(ev.giftId) : '',
        emoteId,
        emoteImage,
        likeMin: trig === 'like' ? Math.max(1, Number(ev?.minLikesAmount) || 1) : 0,
      });
    }

    // Minecraft va a Juegos → Minecraft; no duplicar teclas ahí.
    const hasMc = !!(a.mcCmd || a.minecraftCmd || a.minecraftCommand
      || a.dynamicConfig?.mcCmd || a.dynamicConfig?.minecraftCmd || a.dynamicConfig?.command);
    const whUrl = String(a.webhookUrl || '').trim();
    const keys = (!hasMc && a.keystrokes) ? String(a.keystrokes).slice(0, 120) : '';
    const obsCmd = !hasMc ? tikfinityObsCmdFromAction(a) : null;
    const sbCmd = !hasMc ? tikfinitySbCmdFromAction(a) : null;
    const hasMedia = !!(a.videoUrl || a.audioUrl);
    // Escena OBS pegada a un video/sonido de TF suele ser su overlay; no spamear Acciones.
    const wantObs = !!(obsCmd && (!hasMedia || keys || whUrl || sbCmd));
    // Webhook / teclas / Streamer.bot / OBS dedicado → Acciones del directo.
    if (keys || whUrl || sbCmd || wantObs) {
      let accTrig = trig;
      let accGift = trig === 'gift' ? giftRef : '';
      let accGiftId = trig === 'gift' && ev?.giftId != null ? String(ev.giftId) : '';
      if (trig === 'gift' && !accGift && !accGiftId) accTrig = 'gift-any';
      if (EVENT_TRIGGER[ev?.triggerTypeId] === 'gift-diamonds') {
        accTrig = 'gift-any';
        accGift = '';
        accGiftId = '';
      }
      interacciones.push({
        nombre: name,
        tecla: keys,
        enabled,
        nombreRegalo: accTrig === 'gift' ? accGift : '',
        trigger: accTrig,
        giftId: accTrig === 'gift' ? accGiftId : '',
        emoteId,
        emoteImage,
        likeMin: trig === 'like' ? Math.max(1, Number(ev?.minLikesAmount) || 1) : 0,
        rangeMin: accTrig === 'gift-any' ? Math.max(0, Number(ev?.minBarsAmount) || 0) : 0,
        webhookUrl: whUrl,
        obsCmd: wantObs ? obsCmd : undefined,
        sbCmd: sbCmd || undefined,
      });
    }
  }

  const minecraft = mapTikfinityActionsToMc(actions, events);

  // Eventos like/follow sin media pero con acciones → ya cubiertos arriba.
  // Eventos gift → like con actionIds apuntando a acciones sin audio: crear alerta vacía no sirve.

  return {
    alertas,
    videos,
    interacciones,
    minecraft,
    sourceChannelId: norm?.sourceChannelId,
    tikfinityVersion: norm?.version,
  };
}

export function decryptAndMapTfc(ciphertext) {
  const { encVersion, payload } = decryptTfc(ciphertext);
  const norm = normalizePayload(payload);
  const legacy = mapNormalizedToLegacy(norm);
  const emotes = collectEmotesFromLegacy(legacy);
  return {
    encVersion,
    sourceChannelId: norm.sourceChannelId,
    data: legacy,
    emotes,
    counts: {
      alertas: legacy.alertas.length,
      videos: legacy.videos.length,
      interacciones: legacy.interacciones.length,
      minecraft: Array.isArray(legacy.minecraft) ? legacy.minecraft.length : 0,
      emotes: emotes.length,
      actionsRaw: norm.actions.length,
      eventsRaw: Array.isArray(norm.events) ? norm.events.length : 0,
      soundsRaw: Array.isArray(norm.sounds) ? norm.sounds.length : 0,
    },
  };
}

/** Lista de stickers/emotes detectados en el .tfc (para el catálogo del selector). */
export function collectEmotesFromLegacy(legacy) {
  const map = new Map();
  const add = (id, image, name) => {
    const eid = String(id || '').trim();
    if (!eid) return;
    const prev = map.get(eid) || { id: eid, image: '', name: '' };
    const img = String(image || '').trim();
    const nm = String(name || '').trim();
    map.set(eid, {
      id: eid,
      image: prev.image || img,
      name: prev.name || nm,
    });
  };
  for (const a of legacy?.alertas || []) {
    if (a?.trigger === 'emote' && a.emoteId) add(a.emoteId, a.emoteImage, a.nombre);
  }
  for (const v of legacy?.videos || []) {
    if (v?.trigger === 'emote' && v.emoteId) add(v.emoteId, v.emoteImage, v.nombreLista || v.nombre);
  }
  for (const a of legacy?.interacciones || []) {
    if ((a?.trigger === 'emote' || a?.event === 'emote') && a.emoteId) {
      add(a.emoteId, a.emoteImage, a.nombre);
    }
  }
  return [...map.values()];
}
