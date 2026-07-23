/* Importar / exportar configuración del panel (formato Livecoins v2 y legacy TikFinity v1). */
(function () {
  const EXPORT_CATALOG = [
    {
      id: 'alertas',
      label: 'Alertas y videos',
      items: [
        { key: 'soundAlerts', label: 'Sonidos (lista)' },
        { key: 'videos', label: 'Videos (lista)' },
        { key: 'battleAlerts', label: 'Animaciones de batalla (lista)' },
        { key: 'actions', label: 'Acciones / teclas', desktopOnly: true },
        { key: 'videosEnabled', label: 'Interruptor global de videos' },
        { key: 'battleAlertsEnabled', label: 'Interruptor global de batallas' },
        { key: 'playback', label: 'Opciones de reproducción (cola, combo)' },
      ],
    },
    {
      id: 'panel',
      label: 'Panel y herramientas',
      items: [
        { key: 'tts', label: 'Chat TTS' },
        { key: 'timer', label: 'Temporizador' },
        { key: 'points', label: 'Usuario y puntos' },
        { key: 'screens', label: 'Pantallas (Browser Sources)' },
        { key: 'alerts', label: 'Alertas del panel (regalo, follow…)' },
        { key: 'battle', label: 'Batalla (equipos y meta)' },
        { key: 'spotify', label: 'Spotify song requests', desktopOnly: true },
        { key: 'webhook', label: 'Webhook / RCON / OBS / ServerTap', desktopOnly: true },
        { key: 'levelVideos', label: 'Videos automáticos por nivel', desktopOnly: true },
      ],
    },
    {
      id: 'gifts',
      label: 'Overlays de regalos y metas',
      items: [
        { key: 'jarron', label: 'Jarrón de regalos' },
        { key: 'perrito', label: 'Perrito' },
        { key: 'vaquita', label: 'Vaquita' },
        { key: 'marranito', label: 'Marranito' },
        { key: 'pelotas', label: 'Pelotas de fans' },
        { key: 'topDonor', label: 'Top donador semanal' },
        { key: 'giftVs', label: 'Gift VS' },
        { key: 'batallaVs', label: 'Batalla VS' },
        { key: 'batallaMeta', label: 'Meta de la ronda (PK)' },
        { key: 'batallaMvp', label: 'MVP de la batalla (PK)' },
        { key: 'batallaTop3', label: 'Top 3 de tu ejército (PK)' },
        { key: 'giftSeq', label: 'Secuencia de regalos' },
        { key: 'giftShowcase', label: 'Showcase de regalos' },
        { key: 'topGift', label: 'Mejor regalo' },
        { key: 'giftCounter', label: 'Contador de meta' },
        { key: 'corazonLava', label: 'Meta Heart Me' },
        { key: 'topStreak', label: 'Mejor racha' },
        { key: 'top1', label: 'Top 1 donador (MVP)' },
        { key: 'top1fire', label: 'Top 1 fuego' },
        { key: 'habibiTop', label: 'Habibi del mes' },
        { key: 'winsCounter', label: 'Contador de victorias' },
        { key: 'winsCounterGamer', label: 'Contador de victorias (Gamer HUD)' },
        { key: 'winsCounterMinecraft', label: 'Contador de victorias (Minecraft)' },
        { key: 'winsCounterMario', label: 'Contador de victorias (Mario Bros)' },
      ],
    },
    {
      id: 'rankings',
      label: 'Rankings y batallas overlay',
      items: [
        { key: 'batallaGifts', label: 'Batalla de regalos' },
        { key: 'batallaLikes', label: 'Batalla de likes' },
        { key: 'coinMatch', label: 'Coin Match' },
        { key: 'toplikesRank', label: 'Ranking likes (bandas)' },
        { key: 'topdiamRank', label: 'Ranking diamantes (bandas)' },
        { key: 'toplikesList', label: 'Lista ranking likes' },
        { key: 'topdiamList', label: 'Lista ranking diamantes' },
        { key: 'topAltRank', label: 'Ranking alternado likes/diamantes' },
        { key: 'topAltRankNeon', label: 'Ranking alternado likes/diamantes (neón)' },
        { key: 'topPointsRank', label: 'Ranking de puntos' },
      ],
    },
    {
      id: 'streams',
      label: 'Streams y diseño overlay',
      items: [
        { key: 'hypeBar', label: 'Barra de meta (Hype)' },
        { key: 'followerCounter', label: 'Contador de seguidores' },
        { key: 'followerCounterMc', label: 'Contador de seguidores (Minecraft)' },
        { key: 'liveTimer', label: 'Tiempo en live (Neon)' },
        { key: 'alertaGift', label: 'Diseño alerta regalo' },
        { key: 'alertaLikes', label: 'Diseño alerta likes' },
        { key: 'alertaFollow', label: 'Diseño alerta seguidor' },
        { key: 'fuegos', label: 'Diseño fuegos artificiales' },
        { key: 'streamJoin', label: 'Join al live' },
        { key: 'streamJoinMc', label: 'Join al live (Minecraft)' },
        { key: 'streamJoinDbz', label: 'Join al live (Dragon Ball Z)' },
        { key: 'streamJoinMario', label: 'Join al live (Mario Bros)' },
      ],
    },
    {
      id: 'juegos',
      label: 'Juegos (acciones)',
      desktopOnly: true,
      items: [
        { key: 'mcActions', label: 'Minecraft' },
        { key: 'mcshooterActions', label: 'Minecraft Shooters' },
        { key: 'mcshooterColiseo', label: 'Minecraft Shooters — Coliseo' },
        { key: 'bedrockActions', label: 'Bedrock (Cubo TNT)' },
        { key: 'parkourActions', label: 'Minecraft Parkour' },
        { key: 'kothActions', label: 'Minecraft KOTH' },
        { key: 'farmActions', label: 'Minecraft Farm' },
        { key: 'sandboxActions', label: 'Sandbox' },
        { key: 'robloxActions', label: 'Roblox' },
        { key: 'roblox3Actions', label: 'Roblox 3' },
        { key: 'marioActions', label: 'Mario Bros' },
        { key: 'mari0Actions', label: 'Mari0' },
        { key: 'smb3Actions', label: 'Super Mario Bros 3' },
        { key: 'pvzActions', label: 'Plants vs Zombies' },
        { key: 'repoActions', label: 'R.E.P.O.' },
        { key: 'l4dActions', label: 'Left 4 Dead 2' },
        { key: 'unturnedActions', label: 'Unturned' },
        { key: 'ctrActions', label: 'Crash Team Racing (CTR)' },
        { key: 'smwActions', label: 'Super Mario World (BizHawk)' },
        { key: 'mslugActions', label: 'Metal Slug' },
        { key: 'gdashActions', label: 'Geometry Dash' },
      ],
    },
  ];

  const ALL_EXPORT_KEYS = [...new Set(EXPORT_CATALOG.flatMap((g) => g.items.map((i) => i.key)))];
  const EXPORT_KEYS = ALL_EXPORT_KEYS;

  function getExportCatalog(isDesktop) {
    return EXPORT_CATALOG.map((g) => {
      if (g.desktopOnly && !isDesktop) return null;
      const items = g.items.filter((i) => !i.desktopOnly || isDesktop);
      if (!items.length) return null;
      return { ...g, items };
    }).filter(Boolean);
  }

  function defaultExportKeys(isDesktop) {
    return getExportCatalog(isDesktop).flatMap((g) => g.items.map((i) => i.key));
  }

  function uid(prefix) {
    return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function parseGiftRef(raw) {
    const v = String(raw ?? '').trim();
    if (!v) return { giftId: '', giftName: '' };
    if (/^\d+$/.test(v)) return { giftId: v, giftName: '' };
    return { giftId: '', giftName: v };
  }

  function normVolume(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return 100;
    if (n > 0 && n <= 1) return Math.round(n * 100);
    return Math.max(0, Math.min(100, Math.round(n)));
  }

  function cloneVal(v) {
    if (Array.isArray(v)) return JSON.parse(JSON.stringify(v));
    if (v && typeof v === 'object') return JSON.parse(JSON.stringify(v));
    return v;
  }

  /* ---- Legacy TikFinity v1 ---- */
  function importLegacyAlerta(a, i) {
    const isAny = a.trigger === 'any_gift';
    const gift = isAny ? { giftId: '', giftName: '' } : parseGiftRef(a.nombreRegalo);
    return {
      id: uid('sa_'),
      name: String(a.nombre || `Alerta ${i + 1}`).trim(),
      enabled: a.enabled !== false,
      trigger: 'gift',
      giftName: gift.giftName,
      giftId: gift.giftId,
      minDiamonds: 0,
      rangeMin: isAny ? 0 : 0,
      rangeMax: isAny ? 0 : 0,
      likeMin: 0,
      likeGoal: 0,
      emoteId: '',
      emoteImage: '',
      sound: String(a.audioUrl || '').trim(),
      soundName: String(a.audioName || 'audio').trim(),
      image: '',
      volume: normVolume(a.volumen),
    };
  }

  function importLegacyVideo(v, i) {
    const gift = parseGiftRef(v.nombreRegalo);
    return {
      id: uid('v_'),
      name: String(v.nombreLista || `Video ${i + 1}`).trim(),
      enabled: v.enabled !== false,
      trigger: 'gift',
      giftName: gift.giftName,
      giftId: gift.giftId,
      minDiamonds: 0,
      rangeMin: 0,
      rangeMax: 0,
      likeMin: 0,
      likeGoal: 0,
      emoteId: '',
      emoteImage: '',
      command: '',
      url: String(v.videoUrl || '').trim(),
      fileName: String(v.videoName || 'video').trim(),
      volume: normVolume(v.videoVol),
      screen: Math.max(1, Math.min(10, Number(v.screen) || 1)),
    };
  }

  function importLegacyAction(a, i) {
    const gift = parseGiftRef(a.nombreRegalo);
    let keys = String(a.tecla || '').trim();
    if (keys.length === 1) keys = keys.toUpperCase();
    return {
      id: uid('act_'),
      name: String(a.nombre || `Acción ${i + 1}`).trim(),
      enabled: a.enabled !== false,
      event: 'gift',
      giftName: gift.giftName,
      giftId: gift.giftId,
      giftImage: '',
      minDiamonds: 0,
      rangeMin: 0,
      rangeMax: 0,
      likeMin: 1,
      likeGoal: 100,
      emoteId: '',
      keys,
      gameCompat: false,
      image: '',
      sound: '',
      soundName: '',
      soundVolume: 1,
    };
  }

  function importLegacyTts(fields, extra) {
    if (!fields && !extra) return null;
    const f = fields || {};
    const e = extra || {};
    const out = {};
    if (f['select-voces-tiktok']) out.tiktokVoice = String(f['select-voces-tiktok']);
    if (f['tts-tiktok-traducir-es'] != null) out.tiktokTranslateEs = f['tts-tiktok-traducir-es'] === 'on' || f['tts-tiktok-traducir-es'] === true;
    if (f['palabras-prohibidas'] != null) out.blockedWords = String(f['palabras-prohibidas'] || '');
    if (f['rango-volumen-tts'] != null) out.volume = normVolume(f['rango-volumen-tts']) / 100;
    if (f['rango-velocidad-tts'] != null) out.rate = Math.max(0.5, Math.min(2, (Number(f['rango-velocidad-tts']) || 50) / 50));
    if (f['min-diamantes-tts'] != null) out.cost = Number(f['min-diamantes-tts']) || 0;
    if (e.engine === 'tiktok') out.tiktokVoice = out.tiktokVoice || e.tiktokVoice || '';
    if (e.allowTodos != null) out.allowAll = !!e.allowTodos;
    if (e.allowSeguidores != null) out.allowFollowers = !!e.allowSeguidores;
    if (e.allowSuperfans != null) out.allowSubs = !!e.allowSuperfans;
    if (e.allowMods != null) out.allowMods = !!e.allowMods;
    if (e.allowTeam != null) out.allowTeam = !!e.allowTeam;
    if (e.commentMode === 'any') out.trigger = 'all';
    if (e.commentPrefix === '!') out.trigger = 'dot';
    if (e.commentPrefix === '/') out.trigger = 'slash';
    if (e.moderationBlockSpam != null) out.blockSpam = !!e.moderationBlockSpam;
    if (e.moderationBlockProfanity != null) out.blockProfanity = !!e.moderationBlockProfanity;
    if (e.ttsFollowReadEnabled != null) out.readFollow = !!e.ttsFollowReadEnabled;
    if (e.ttsFollowMessage != null) out.followMsg = String(e.ttsFollowMessage);
    return Object.keys(out).length ? out : null;
  }

  function parseOverlayJson(raw) {
    if (!raw) return null;
    try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return null; }
  }

  function importLegacyTimer(raw) {
    const t = parseOverlayJson(raw);
    if (!t) return null;
    const out = {};
    if (t.defaultInitialSec != null) out.defaultInitialSec = Number(t.defaultInitialSec) || 0;
    if (t.gift != null) out.giftMult = Number(t.gift) || 0;
    if (t.like != null) out.like = Number(t.like) || 0;
    if (t.follow != null) out.follow = Number(t.follow) || 0;
    if (t.share != null) out.share = Number(t.share) || 0;
    if (t.subscribe != null) out.subscribe = Number(t.subscribe) || 0;
    if (t.chat != null) out.chat = Number(t.chat) || 0;
    if (t.maxEnabled != null) out.maxEnabled = !!t.maxEnabled;
    if (t.maxCapMin != null) out.maxCapSec = Math.max(0, Number(t.maxCapMin) || 0) * 60;
    if (t.actionOnFinish != null) out.actionOnFinish = String(t.actionOnFinish);
    return Object.keys(out).length ? out : null;
  }

  function legacyPayloadRoot(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (raw.data && typeof raw.data === 'object') return raw.data;
    if (raw.alertas || raw.videos || raw.interacciones) return raw;
    return raw.data || null;
  }

  function convertLegacy(raw, opts) {
    const data = legacyPayloadRoot(raw);
    if (!data) throw new Error('Archivo legacy no reconocido.');
    const patch = {};
    const counts = { soundAlerts: 0, videos: 0, actions: 0, tts: 0, timer: 0 };

    if (Array.isArray(data.alertas) && data.alertas.length) {
      patch.soundAlerts = data.alertas.map(importLegacyAlerta);
      counts.soundAlerts = patch.soundAlerts.length;
    }
    if (Array.isArray(data.videos) && data.videos.length) {
      patch.videos = data.videos.map(importLegacyVideo);
      counts.videos = patch.videos.length;
    }
    if (opts.includeActions && Array.isArray(data.interacciones) && data.interacciones.length) {
      patch.actions = data.interacciones.map(importLegacyAction);
      counts.actions = patch.actions.length;
    }

    const tts = importLegacyTts(data.fields, data.ttsChatExtra);
    if (tts) { patch.tts = tts; counts.tts = 1; }

    const ols = data.overlayLocalStorage || {};
    const timerRaw = ols['tf_timer_panel_config_v1'];
    const timer = importLegacyTimer(timerRaw);
    if (timer) { patch.timer = timer; counts.timer = 1; }

    if (data.checks && data.checks['activar-sonidos-global'] === false) {
      /* no global flag in our model — skip */
    }

    return { patch, counts, format: 'legacy-v1' };
  }

  function convertNative(raw) {
    const data = raw.data || raw.settings || raw;
    if (!data || typeof data !== 'object') throw new Error('Archivo Livecoins no reconocido.');
    const patch = {};
    for (const k of EXPORT_KEYS) {
      if (data[k] !== undefined) patch[k] = cloneVal(data[k]);
    }
    return { patch, counts: countPatch(patch), format: 'livecoins-v2' };
  }

  // Extrae una lista de perfiles { name, settings } si el archivo contiene varios.
  // Acepta distintas formas: raw.profiles, raw.data.profiles o raw.slots. Cada
  // entrada puede traer los ajustes en .data, .settings o directamente en la raíz.
  function profilesFromFile(raw) {
    let arr = null;
    if (Array.isArray(raw.profiles)) arr = raw.profiles;
    else if (raw.data && Array.isArray(raw.data.profiles)) arr = raw.data.profiles;
    else if (Array.isArray(raw.slots)) arr = raw.slots;
    if (!arr || !arr.length) return null;
    const out = arr.map((p) => {
      if (!p || typeof p !== 'object') return { name: '', settings: null };
      const src = p.data || p.settings || p;
      if (!src || typeof src !== 'object' || Array.isArray(src)) return { name: String(p.name || '').slice(0, 40), settings: null };
      const settings = {};
      for (const k of EXPORT_KEYS) if (src[k] !== undefined) settings[k] = cloneVal(src[k]);
      const hasData = Object.keys(settings).length > 0;
      return { name: String(p.name || '').slice(0, 40), settings: hasData ? settings : null };
    });
    // Solo es multi-perfil si al menos una entrada (más allá de la primera) tiene datos.
    return out.some((p, i) => i > 0 && p.settings) ? out : null;
  }

  function convertMultiProfile(raw) {
    const profiles = profilesFromFile(raw);
    if (!profiles) return null;
    let total = 0;
    for (const p of profiles) if (p.settings) total += Object.keys(p.settings).length;
    const filled = profiles.filter((p) => p.settings).length;
    return { profiles, multi: true, counts: { profiles: filled }, format: 'livecoins-v2' };
  }

  function countPatch(patch) {
    const c = {};
    for (const [k, v] of Object.entries(patch)) {
      if (Array.isArray(v)) c[k] = v.length;
      else if (v && typeof v === 'object') c[k] = 1;
    }
    return c;
  }

  function detectFormat(raw) {
    if (!raw || typeof raw !== 'object') return 'unknown';
    if (raw.format === 'livecoins' || raw.version === 2) return 'livecoins-v2';
    const d = legacyPayloadRoot(raw);
    if (d && (Array.isArray(d.alertas) || Array.isArray(d.interacciones))) return 'legacy-v1';
    if (raw.data && (raw.data.soundAlerts || raw.data.videos)) return 'livecoins-v2';
    return 'unknown';
  }

  function exportSettings(settings, opts) {
    const data = {};
    let keyList;
    if (opts?.keys && opts.keys.length) {
      keyList = opts.keys;
    } else if (opts?.skipActions) {
      keyList = ALL_EXPORT_KEYS.filter((k) => k !== 'actions');
    } else {
      keyList = ALL_EXPORT_KEYS;
    }
    for (const k of keyList) {
      if (settings[k] !== undefined) data[k] = cloneVal(settings[k]);
    }
    // No incluir API keys de ElevenLabs en el archivo exportado.
    try {
      if (data.tts && data.tts.elevenlabs && data.tts.elevenlabs.apiKey) {
        data.tts = { ...data.tts, elevenlabs: { ...data.tts.elevenlabs, apiKey: '' } };
      }
    } catch { /* ignore */ }
    return {
      version: 2,
      format: 'livecoins',
      savedAt: Date.now(),
      exportedKeys: [...keyList],
      data,
    };
  }

  function applyPatch(current, patch, mode) {
    const out = { ...current };
    const listKeys = ['soundAlerts', 'videos', 'battleAlerts', 'actions'];
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      if (listKeys.includes(k) && Array.isArray(v)) {
        if (mode === 'replace') {
          out[k] = v.map((item) => ({ ...item, id: item.id || uid(k === 'soundAlerts' ? 'sa_' : k === 'videos' ? 'v_' : k === 'actions' ? 'act_' : 'ba_') }));
        } else {
          const existing = Array.isArray(out[k]) ? out[k] : [];
          const imported = v.map((item) => ({ ...item, id: uid(k === 'soundAlerts' ? 'sa_' : k === 'videos' ? 'v_' : k === 'actions' ? 'act_' : 'ba_') }));
          out[k] = [...existing, ...imported];
        }
      } else if (v && typeof v === 'object' && !Array.isArray(v)) {
        out[k] = { ...(out[k] || {}), ...v };
      } else {
        out[k] = v;
      }
    }
    return out;
  }

  function summarize(counts) {
    const parts = [];
    if (counts.profiles) parts.push(`${counts.profiles} perfil(es)`);
    if (counts.soundAlerts) parts.push(`${counts.soundAlerts} alerta(s) sonora(s)`);
    if (counts.videos) parts.push(`${counts.videos} video(s)`);
    if (counts.actions) parts.push(`${counts.actions} acción(es)`);
    if (counts.battleAlerts) parts.push(`${counts.battleAlerts} batalla(s)`);
    if (counts.tts) parts.push('TTS');
    if (counts.timer) parts.push('temporizador');
    return parts.length ? parts.join(', ') : 'sin datos compatibles';
  }

  window.SettingsTransfer = {
    EXPORT_KEYS,
    ALL_EXPORT_KEYS,
    EXPORT_CATALOG,
    getExportCatalog,
    defaultExportKeys,
    exportSettings,
    detectFormat,
    convertLegacy,
    convertNative,
    applyPatch,
    summarize,
    profilesFromFile,
    parseFile(text) {
      const raw = JSON.parse(text);
      const fmt = detectFormat(raw);
      if (fmt === 'legacy-v1') return convertLegacy(raw, { includeActions: true });
      if (fmt === 'livecoins-v2') {
        // Si el archivo trae varios perfiles, los devolvemos todos para restaurarlos.
        const multi = convertMultiProfile(raw);
        if (multi) return multi;
        return convertNative(raw);
      }
      throw new Error('Formato de archivo no reconocido. Usa un export de Livecoins o TikFinity legacy.');
    },
  };
})();
