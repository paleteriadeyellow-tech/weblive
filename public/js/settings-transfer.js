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
        { key: 'batallaGiftBall', label: 'Pelota de regalos' },
        { key: 'batallaCoinBar', label: 'Contador de monedas (metas)' },
        { key: 'giftSeq', label: 'Secuencia de regalos' },
        { key: 'giftShowcase', label: 'Showcase de regalos' },
        { key: 'flowMeter', label: 'Medidor de flow / regalos' },
        { key: 'giftGoals', label: 'Metas de regalos' },
        { key: 'topGift', label: 'Mejor regalo' },
        { key: 'lastGift', label: 'Último regalo' },
        { key: 'giftCounter', label: 'Contador de meta' },
        { key: 'corazonLava', label: 'Meta Heart Me' },
        { key: 'topStreak', label: 'Mejor racha' },
        { key: 'baileRonda', label: 'Overlay baile — Ronda' },
        { key: 'baileCombo', label: 'Overlay baile — Top combo' },
        { key: 'baileRank', label: 'Overlay baile — Ranking OUT' },
        { key: 'top1', label: 'Top 1 donador (MVP)' },
        { key: 'top1fire', label: 'Top 1 fuego' },
        { key: 'habibiTop', label: 'Habibi del mes' },
        { key: 'winsCounter', label: 'Contador de victorias' },
        { key: 'winsCounterGamer', label: 'Contador de victorias (Gamer HUD)' },
        { key: 'winsCounterMinecraft', label: 'Contador de victorias (Minecraft)' },
        { key: 'winsCounterMario', label: 'Contador de victorias (Mario Bros)' },
        { key: 'topKills', label: 'Top kills (manual)' },
        { key: 'screenFx', label: 'Efectos pantalla (App PC)' },
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
        { key: 'topMultiRank', label: 'Top rotatorio (likes / coins / chat / puntos)' },
        { key: 'pointsLookup', label: 'Consulta de puntos (!puntos)' },
        { key: 'topPointsRank', label: 'Ranking de puntos' },
        { key: 'topcommentsRank', label: 'Ranking de comentarios' },
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
        { key: 'chatGamer', label: 'Chat Gamer' },
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
        { key: 'pvzHybridActions', label: 'Plants vs Zombies Pack (Hybrid)' },
        { key: 'repoActions', label: 'R.E.P.O.' },
        { key: 'l4dActions', label: 'Left 4 Dead 2' },
        { key: 'gtavKothActions', label: 'GTA V King of the Hill' },
        { key: 'gtavChaosActions', label: 'GTA V Mod Chaos' },
        { key: 'gtavChiliadActions', label: 'GTA V Chiliad' },
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
    const trig = String(a.trigger || 'gift').trim() || 'gift';
    const isAny = trig === 'any_gift' || trig === 'gift-any';
    const isEmote = trig === 'emote';
    const gift = (isAny || isEmote) ? { giftId: '', giftName: '' } : parseGiftRef(a.nombreRegalo || a.giftName);
    const out = {
      id: uid('sa_'),
      name: String(a.nombre || `Alerta ${i + 1}`).trim(),
      enabled: a.enabled !== false,
      trigger: isAny ? 'gift' : (trig === 'gift-any' ? 'gift' : trig),
      giftName: isEmote ? '' : (gift.giftName || String(a.giftName || '').trim()),
      giftId: isEmote ? '' : String(a.giftId || gift.giftId || '').trim(),
      minDiamonds: Math.max(0, Number(a.minDiamonds) || 0),
      rangeMin: isAny ? 0 : Math.max(0, Number(a.rangeMin) || 0),
      rangeMax: isAny ? 0 : Math.max(0, Number(a.rangeMax) || 0),
      likeMin: Math.max(0, Number(a.likeMin) || 0),
      likeGoal: Math.max(0, Number(a.likeGoal) || 0),
      emoteId: isEmote ? String(a.emoteId || '').trim() : '',
      emoteImage: isEmote ? String(a.emoteImage || a.emoteImageUrl || '').trim() : '',
      sound: String(a.audioUrl || a.sound || '').trim(),
      soundName: String(a.audioName || a.soundName || 'audio').trim(),
      image: String(a.image || a.imageUrl || '').trim(),
      volume: normVolume(a.volumen != null ? a.volumen : a.volume),
    };
    if (isAny) {
      out.giftName = '';
      out.giftId = '';
    }
    return out;
  }

  function importLegacyVideo(v, i) {
    const trig = String(v.trigger || 'gift').trim() || 'gift';
    const isEmote = trig === 'emote';
    const gift = isEmote ? { giftId: '', giftName: '' } : parseGiftRef(v.nombreRegalo);
    return {
      id: uid('v_'),
      name: String(v.nombreLista || `Video ${i + 1}`).trim(),
      enabled: v.enabled !== false,
      trigger: trig,
      giftName: isEmote ? '' : gift.giftName,
      giftId: isEmote ? '' : String(v.giftId || gift.giftId || '').trim(),
      minDiamonds: Math.max(0, Number(v.minDiamonds) || 0),
      rangeMin: 0,
      rangeMax: 0,
      likeMin: Math.max(0, Number(v.likeMin) || 0),
      likeGoal: Math.max(0, Number(v.likeGoal) || 0),
      emoteId: isEmote ? String(v.emoteId || '').trim() : '',
      emoteImage: isEmote ? String(v.emoteImage || v.emoteImageUrl || '').trim() : '',
      command: '',
      url: String(v.videoUrl || '').trim(),
      fileName: String(v.videoName || 'video').trim(),
      volume: normVolume(v.videoVol),
      screen: Math.max(1, Math.min(10, Number(v.screen) || 1)),
    };
  }

  function importLegacyAction(a, i) {
    const trig = String(a.trigger || a.event || 'gift').trim() || 'gift';
    const isEmote = trig === 'emote';
    const isAny = trig === 'any_gift' || trig === 'gift-any';
    const gift = (isAny || isEmote) ? { giftId: '', giftName: '' } : parseGiftRef(a.nombreRegalo || a.giftName);
    let keys = String(a.tecla || a.keys || '').trim();
    if (keys.length === 1) keys = keys.toUpperCase();
    const whUrl = String(a.webhookUrl || a._webhookUrl || a.webhookCmd?.url || '').trim();
    let event = 'gift-any';
    if (isEmote) event = 'emote';
    else if (isAny) event = 'gift-any';
    else if (trig === 'gift' || trig === 'like' || trig === 'follow' || trig === 'share'
      || trig === 'subscribe' || trig === 'superFan' || trig === 'superFanJoin'
      || trig === 'likeGlobal' || trig === 'chatCommand') {
      event = trig === 'gift'
        ? ((gift.giftName || String(a.giftId || gift.giftId || '').trim()) ? 'gift' : 'gift-any')
        : trig;
    }
    const out = {
      id: uid('act_'),
      name: String(a.nombre || a.name || `Acción ${i + 1}`).replace(/\s*\[WH\]\s*$/i, '').trim(),
      enabled: a.enabled !== false,
      event,
      giftName: isEmote || isAny ? '' : (gift.giftName || String(a.giftName || '').trim()),
      giftId: isEmote || isAny ? '' : String(a.giftId || gift.giftId || '').trim(),
      giftImage: '',
      minDiamonds: Math.max(0, Number(a.minDiamonds) || 0),
      rangeMin: Math.max(0, Number(a.rangeMin) || 0),
      rangeMax: Math.max(0, Number(a.rangeMax) || 0),
      likeMin: Math.max(1, Number(a.likeMin) || 1),
      likeGoal: Math.max(0, Number(a.likeGoal) || 100),
      emoteId: isEmote ? String(a.emoteId || '').trim() : '',
      emoteImage: isEmote ? String(a.emoteImage || a.emoteImageUrl || '').trim() : '',
      keys,
      gameCompat: false,
      image: String(a.image || a.imageUrl || '').trim(),
      sound: String(a.sound || a.audioUrl || '').trim(),
      soundName: String(a.soundName || '').trim(),
      soundVolume: a.soundVolume != null ? Number(a.soundVolume) : 1,
      webhookCmd: whUrl ? {
        on: true,
        method: String(a.webhookCmd?.method || a.webhookMethod || 'GET').toUpperCase() || 'GET',
        url: whUrl,
        body: String(a.webhookCmd?.body || a.webhookBody || ''),
        staggerOn: !!a.webhookCmd?.staggerOn,
        staggerMs: Math.max(50, Math.min(10000, parseInt(a.webhookCmd?.staggerMs, 10) || 300)),
      } : {
        on: false, method: 'GET', url: '', body: '', staggerOn: false, staggerMs: 300,
      },
      obsCmd: (() => {
        if (a.obsCmd && typeof a.obsCmd === 'object' && (a.obsCmd.on || a.obsCmd.scene || a.obsCmd.source)) {
          return {
            on: a.obsCmd.on !== false,
            type: a.obsCmd.type || (a.obsCmd.source ? 'showSource' : 'scene'),
            scene: String(a.obsCmd.scene || '').trim(),
            source: String(a.obsCmd.source || '').trim(),
          };
        }
        const scene = String(a.obsSceneId || a.obsScene || '').trim();
        const source = String(a.obsSourceId || a.obsSource || '').trim();
        if (!scene && !source) return { on: false, type: 'scene', scene: '', source: '' };
        if (source) return { on: true, type: 'showSource', scene, source };
        return { on: true, type: 'scene', scene, source: '' };
      })(),
      sbCmd: (() => {
        if (a.sbCmd && typeof a.sbCmd === 'object' && (a.sbCmd.on || a.sbCmd.action)) {
          return {
            on: a.sbCmd.on !== false,
            action: String(a.sbCmd.action || '').trim(),
            staggerOn: !!a.sbCmd.staggerOn,
            staggerMs: Math.max(50, Math.min(10000, parseInt(a.sbCmd.staggerMs, 10) || 300)),
          };
        }
        const action = String(a.streamerbotActionId || a.streamerBotActionId || a.sbAction || '').trim();
        if (!action) return { on: false, action: '', staggerOn: false, staggerMs: 300 };
        return { on: true, action, staggerOn: false, staggerMs: 300 };
      })(),
    };
    return out;
  }

  /** Stubs viejos de import TikFinity MC → no deben ir a Acciones del directo. */
  function isLegacyMcStub(a) {
    if (!a || typeof a !== 'object') return false;
    if (a._mcCmd || a.mcCmd || a.cmd || (Array.isArray(a.cmds) && a.cmds.length)) return true;
    const name = String(a.nombre || a.name || '');
    if (/\[MC\]\s*$/i.test(name)) return true;
    if (a.tecla == null && a.keys == null && /minecraft| co?mando\s*mc/i.test(name)) return true;
    return false;
  }

  function importLegacyMcAction(a, i) {
    if (!a || typeof a !== 'object') return null;
    const cmd = String(a.cmd || (Array.isArray(a.cmds) ? a.cmds[0] : '') || a.mcCmd || '').trim();
    if (!cmd && !(Array.isArray(a.cmds) && a.cmds.length)) return null;
    const trig = String(a.trigger || 'gift').trim() || 'gift';
    const gift = parseGiftRef(a.giftName || a.nombreRegalo);
    const out = {
      uid: String(a.uid || '').trim() || uid('mca_'),
      catId: String(a.catId || '').trim(),
      name: String(a.name || a.nombre || `Minecraft ${i + 1}`).trim().slice(0, 80) || `Minecraft ${i + 1}`,
      desc: String(a.desc || 'Importado de TikFinity').trim().slice(0, 120),
      trigger: trig,
      giftId: String(a.giftId || gift.giftId || '').trim(),
      giftName: String(a.giftName || gift.giftName || '').trim(),
      giftImage: String(a.giftImage || '').trim(),
      enabled: a.enabled !== false,
      count: Math.max(1, Math.min(100, parseInt(a.count, 10) || 1)),
      comboInstant: a.comboInstant !== false,
      likeMin: Math.max(0, Number(a.likeMin) || 0),
      text: String(a.text || '').trim(),
      rangeMin: Math.max(0, Number(a.rangeMin) || 0),
      rangeMax: Math.max(0, Number(a.rangeMax) || 0),
      image: String(a.image || '').trim(),
      sound: String(a.sound || a.audioUrl || '').trim(),
      soundName: String(a.soundName || '').trim(),
      audioOn: !!(a.audioOn || a.sound || a.audioUrl),
      soundVolume: a.soundVolume != null ? Number(a.soundVolume) : 100,
      custom: a.custom === true || !a.catId,
      game: 'minecraft',
    };
    if (Array.isArray(a.cmds) && a.cmds.length) {
      out.cmds = a.cmds.map((c) => (typeof c === 'string' ? c : (c && c.cmd) || '')).filter(Boolean);
      out.cmdsExtra = !!a.cmdsExtra;
      out.custom = true;
      out.cmd = out.cmds[0] || cmd;
    } else if (cmd) {
      // TikFinity / legado: un solo `cmd` → también `cmds[]` (el editor solo lee cmds).
      out.cmd = cmd;
      out.cmds = [cmd];
      out.custom = true;
    }
    return out;
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
    if (raw.data && typeof raw.data === 'object') {
      const d = raw.data;
      if (d.alertas || d.videos || d.interacciones || d.soundAlerts || d.actions) return d;
    }
    if (raw.alertas || raw.videos || raw.interacciones || raw.soundAlerts || raw.actions) return raw;
    if (raw.settings && typeof raw.settings === 'object') {
      const s = raw.settings;
      if (s.alertas || s.videos || s.interacciones || s.soundAlerts || s.actions || s.soundAlerts) return s;
    }
    // Buscar anidado (perfiles / slots / dumps modernos).
    const stack = [raw];
    const seen = new Set();
    while (stack.length) {
      const cur = stack.pop();
      if (!cur || typeof cur !== 'object' || seen.has(cur)) continue;
      seen.add(cur);
      if (Array.isArray(cur.alertas) || Array.isArray(cur.soundAlerts) || Array.isArray(cur.interacciones)
        || Array.isArray(cur.videos) || Array.isArray(cur.actions)) {
        return cur;
      }
      for (const v of Object.values(cur)) {
        if (v && typeof v === 'object') stack.push(v);
        if (seen.size > 400) break;
      }
    }
    return raw.data || null;
  }

  function extractPointsUsers(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const roots = [raw, raw.data, raw.payload, raw.shared].filter((x) => x && typeof x === 'object');
    let arr = null;
    for (const r of roots) {
      if (Array.isArray(r.channelusers)) { arr = r.channelusers; break; }
      if (Array.isArray(r.channelUsers)) { arr = r.channelUsers; break; }
      if (Array.isArray(r.users) && r.users.some((u) => u && (u.totalAmount != null || u.totalRewardAmount != null || u.total != null || u.uniqueId))) {
        arr = r.users; break;
      }
      if (r.points && Array.isArray(r.points.users)) { arr = r.points.users; break; }
    }
    if (!arr || !arr.length) return null;
    const out = [];
    const seen = new Set();
    for (const u of arr) {
      if (!u || typeof u !== 'object') continue;
      const uniqueId = String(u.uniqueId || u.username || u.user || '').trim().replace(/^@/, '').toLowerCase();
      if (!uniqueId || seen.has(uniqueId)) continue;
      seen.add(uniqueId);
      const total = Math.max(0, Math.round(Number(
        u.total != null ? u.total
          : (u.totalRewardAmount != null ? u.totalRewardAmount : u.totalAmount)
      ) || 0));
      const levelPoints = Math.max(0, Math.round(Number(
        u.levelPoints != null ? u.levelPoints : total
      ) || 0));
      let photo = String(u.photo || u.thumbnailUrl || u.thumbnailUrlV2 || u.profilePictureUrl || '').trim();
      if (photo.startsWith('//')) photo = 'https:' + photo;
      else if (photo && !/^https?:\/\//i.test(photo)) photo = 'https://' + photo.replace(/^\/+/, '');
      const firstAt = Number(u.firstAt) || Date.parse(u.createdAt) || Date.now();
      const lastAt = Number(u.lastAt) || Date.parse(u.lastUpsertAt || u.updatedAt) || firstAt;
      out.push({
        uniqueId,
        nickname: String(u.nickname || uniqueId).slice(0, 64),
        photo,
        total,
        levelPoints,
        firstAt,
        lastAt,
      });
    }
    return out.length ? out : null;
  }

  function detectFormat(raw) {
    if (!raw || typeof raw !== 'object') return 'unknown';
    if (raw.format === 'livecoins' || raw.version === 2) return 'livecoins-v2';
    const d = legacyPayloadRoot(raw);
    if (d && (Array.isArray(d.alertas) || Array.isArray(d.interacciones) || Array.isArray(d.soundAlerts) || Array.isArray(d.videos) || Array.isArray(d.actions))) {
      return 'legacy-v1';
    }
    if (raw.data && (raw.data.soundAlerts || raw.data.videos)) return 'livecoins-v2';
    if (extractPointsUsers(raw)) return 'points-users';
    return 'unknown';
  }

  function convertPointsOnly(raw) {
    const users = extractPointsUsers(raw);
    if (!users) throw new Error('No se encontraron usuarios/puntos en el archivo.');
    return {
      patch: {},
      counts: { pointsUsers: users.length },
      format: 'points-users',
      pointsUsers: users,
    };
  }

  function attachPointsUsers(result, raw) {
    if (!result || result.pointsUsers) return result;
    const users = extractPointsUsers(raw);
    if (users && users.length) {
      result.pointsUsers = users;
      result.counts = result.counts || {};
      result.counts.pointsUsers = users.length;
    }
    return result;
  }

  function convertLegacy(raw, opts) {
    const data = legacyPayloadRoot(raw);
    if (!data) throw new Error('Archivo legacy no reconocido.');
    const patch = {};
    const counts = { soundAlerts: 0, videos: 0, actions: 0, tts: 0, timer: 0, points: 0 };

    const alertas = Array.isArray(data.alertas) ? data.alertas
      : (Array.isArray(data.soundAlerts) ? data.soundAlerts : null);
    if (alertas && alertas.length) {
      patch.soundAlerts = alertas.map((a, i) => {
        // Formato Livecoins ya migrado dentro del dump
        if (a && (a.sound != null || a.giftName != null) && a.nombre == null && a.audioUrl == null) {
          return { ...cloneVal(a), id: a.id || uid('sa_') };
        }
        return importLegacyAlerta(a, i);
      });
      counts.soundAlerts = patch.soundAlerts.length;
    }

    const videos = Array.isArray(data.videos) ? data.videos : null;
    if (videos && videos.length) {
      patch.videos = videos.map((v, i) => {
        if (v && v.url != null && v.nombreLista == null && v.videoUrl == null) {
          return { ...cloneVal(v), id: v.id || uid('v_') };
        }
        return importLegacyVideo(v, i);
      });
      counts.videos = patch.videos.length;
    }

    const interacciones = Array.isArray(data.interacciones) ? data.interacciones
      : (Array.isArray(data.actions) ? data.actions : null);
    if (opts.includeActions && interacciones && interacciones.length) {
      // Excluir stubs de Minecraft (van a mcActions, no a Acciones del directo).
      const onlyDirecto = interacciones.filter((a) => !isLegacyMcStub(a));
      if (onlyDirecto.length) {
        patch.actions = onlyDirecto.map((a, i) => {
          if (a && (a.keys != null || a.event != null) && a.tecla == null && a.nombreRegalo == null) {
            return { ...cloneVal(a), id: a.id || uid('act_') };
          }
          return importLegacyAction(a, i);
        });
        counts.actions = patch.actions.length;
      }
    }

    const mcSrc = Array.isArray(data.minecraft) ? data.minecraft
      : (Array.isArray(data.mcActions) ? data.mcActions : null);
    if (mcSrc && mcSrc.length) {
      const mapped = mcSrc.map((a, i) => {
        if (a && (a.cmd != null || Array.isArray(a.cmds)) && a.uid) {
          return { ...cloneVal(a), uid: a.uid || uid('mca_'), game: a.game || 'minecraft' };
        }
        return importLegacyMcAction(a, i);
      }).filter(Boolean);
      if (mapped.length) {
        patch.mcActions = mapped;
        counts.mcActions = mapped.length;
      }
    }

    const tts = importLegacyTts(data.fields, data.ttsChatExtra);
    if (tts) { patch.tts = tts; counts.tts = 1; }
    else if (data.tts && typeof data.tts === 'object') {
      patch.tts = cloneVal(data.tts);
      counts.tts = 1;
    }

    const ols = data.overlayLocalStorage || {};
    const timerRaw = ols['tf_timer_panel_config_v1'];
    const timer = importLegacyTimer(timerRaw);
    if (timer) { patch.timer = timer; counts.timer = 1; }
    else if (data.timer && typeof data.timer === 'object') {
      patch.timer = cloneVal(data.timer);
      counts.timer = 1;
    }

    // Reglas de puntos (no la lista de usuarios): campos típicos del panel legacy.
    const fields = data.fields || {};
    const pts = {};
    const perCoin = fields['puntos-por-moneda'] ?? fields['points-per-coin'] ?? fields['pts-per-coin']
      ?? data.pointsPerCoin ?? (data.points && data.points.perCoin);
    if (perCoin != null && perCoin !== '') pts.perCoin = Math.max(0, Number(perCoin) || 0);
    const sf = fields['bono-super-fan'] ?? fields['superfan-bonus'] ?? fields['super-fan-bonus']
      ?? (data.points && data.points.superFanBonus);
    if (sf != null && sf !== '') pts.superFanBonus = Math.max(0, Math.round(Number(sf) || 0));
    const sub = fields['bono-suscripcion'] ?? fields['sub-bonus'] ?? fields['subscribe-bonus']
      ?? (data.points && data.points.subBonus);
    if (sub != null && sub !== '') pts.subBonus = Math.max(0, Math.round(Number(sub) || 0));
    if (data.points && typeof data.points === 'object' && !Array.isArray(data.points)) {
      if (data.points.perCoin != null) pts.perCoin = Math.max(0, Number(data.points.perCoin) || 0);
      if (data.points.superFanBonus != null) pts.superFanBonus = Math.max(0, Math.round(Number(data.points.superFanBonus) || 0));
      if (data.points.subBonus != null) pts.subBonus = Math.max(0, Math.round(Number(data.points.subBonus) || 0));
    }
    if (Object.keys(pts).length) { patch.points = pts; counts.points = 1; }

    if (data.checks && data.checks['activar-sonidos-global'] === false) {
      /* no global flag in our model — skip */
    }

    return attachPointsUsers({ patch, counts, format: 'legacy-v1' }, raw);
  }

  function convertNative(raw) {
    const data = raw.data || raw.settings || raw;
    if (!data || typeof data !== 'object') throw new Error('Archivo Livecoins no reconocido.');
    const patch = {};
    for (const k of EXPORT_KEYS) {
      if (data[k] !== undefined) patch[k] = cloneVal(data[k]);
    }
    return attachPointsUsers({ patch, counts: countPatch(patch), format: 'livecoins-v2' }, raw);
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
    // Claves globales (overlays/TTS/timer/…) en raíz del backup o en raw.shared.
    let shared = null;
    if (raw.shared && typeof raw.shared === 'object' && !Array.isArray(raw.shared)) {
      shared = cloneVal(raw.shared);
    } else {
      const bag = {};
      let n = 0;
      for (const k of EXPORT_KEYS) {
        if (raw[k] != null && typeof raw[k] === 'object') {
          bag[k] = cloneVal(raw[k]);
          n++;
        }
      }
      if (n) shared = bag;
    }
    return { profiles, multi: true, counts: { profiles: filled }, format: 'livecoins-v2', shared };
  }

  function countPatch(patch) {
    const c = {};
    for (const [k, v] of Object.entries(patch)) {
      if (Array.isArray(v)) c[k] = v.length;
      else if (v && typeof v === 'object') c[k] = 1;
    }
    return c;
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
    const listKeys = ['soundAlerts', 'videos', 'battleAlerts', 'actions', 'mcActions'];
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      if (listKeys.includes(k) && Array.isArray(v)) {
        if (mode === 'replace') {
          out[k] = v.map((item) => {
            if (k === 'mcActions') return { ...item, uid: item.uid || uid('mca_') };
            return { ...item, id: item.id || uid(k === 'soundAlerts' ? 'sa_' : k === 'videos' ? 'v_' : k === 'actions' ? 'act_' : 'ba_') };
          });
        } else {
          const existing = Array.isArray(out[k]) ? out[k] : [];
          const imported = v.map((item) => {
            if (k === 'mcActions') return { ...item, uid: uid('mca_') };
            return { ...item, id: uid(k === 'soundAlerts' ? 'sa_' : k === 'videos' ? 'v_' : k === 'actions' ? 'act_' : 'ba_') };
          });
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
    if (counts.mcActions) parts.push(`${counts.mcActions} Minecraft`);
    if (counts.battleAlerts) parts.push(`${counts.battleAlerts} batalla(s)`);
    if (counts.tts) parts.push('TTS');
    if (counts.timer) parts.push('temporizador');
    if (counts.points) parts.push('reglas de puntos');
    if (counts.pointsUsers) parts.push(`${counts.pointsUsers} usuario(s) con puntos`);
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
    convertPointsOnly,
    extractPointsUsers,
    applyPatch,
    summarize,
    profilesFromFile,
    parseFile(text) {
      const trimmed = String(text || '').replace(/^\uFEFF/, '').trim();
      if (!trimmed) throw new Error('Archivo vacío.');
      // TikFinity cifra muchos .tfc (AES CryptoJS "Salted__"). No se puede leer aquí.
      if (trimmed.startsWith('U2FsdGVkX1') || (trimmed.startsWith('U2FsdGVk') && trimmed.charAt(0) !== '{')) {
        throw new Error('Este .tfc está cifrado por TikFinity. Los puntos NO van en ese archivo: ve a Usuario y Puntos → Importar puntos TikFinity e introduce tu Channel ID (Setup → Tu cuenta).');
      }
      let raw;
      try { raw = JSON.parse(trimmed); }
      catch { throw new Error('No es JSON válido. Si es un .tfc cifrado, usa Channel ID para puntos.'); }
      const fmt = detectFormat(raw);
      if (fmt === 'legacy-v1') return convertLegacy(raw, { includeActions: true });
      if (fmt === 'livecoins-v2') {
        const multi = convertMultiProfile(raw);
        if (multi) return attachPointsUsers(multi, raw);
        return convertNative(raw);
      }
      if (fmt === 'points-users') return convertPointsOnly(raw);
      throw new Error('Formato de archivo no reconocido. Usa un export de Livecoins, JSON de usuarios/puntos, o TikFinity legacy.');
    },
  };
})();
