(function () {
  const params = new URLSearchParams(location.search);
  const isEmbed = params.get('embed') === '1';
  let activeSkin = String(params.get('skin') || 'default').toLowerCase();
  if (activeSkin === '') activeSkin = 'default';
  if (isEmbed) document.documentElement.classList.add('embed');

  function skinFromConfig(c) {
    const s = String((c && c.skin) || 'default').toLowerCase();
    return s === '' ? 'default' : s;
  }
  function maybeReloadSkin(newSkin) {
    const next = newSkin || 'default';
    if (next === activeSkin) return false;
    const url = new URL(location.href);
    if (next === 'default') url.searchParams.delete('skin');
    else url.searchParams.set('skin', next);
    if (isEmbed) url.searchParams.set('embed', '1');
    location.replace(url.toString());
    return true;
  }

  const titulosMap = { hype: 'HYPE EN VIVO', regalos: 'META DE REGALOS', likes: 'META DE LIKES', seguidores: 'META DE SEGUIDORES', compartidos: 'META DE COMPARTIDOS', suscriptores: 'META DE SUSCRIPTORES', viewers: 'META DE ESPECTADORES' };
  const iconosMap = { hype: '✨', regalos: '🎁', likes: '❤️', follow: '👤', seguidores: '👤', compartidos: '↪️', share: '↪️', suscriptores: '⭐', viewers: '👁', gift: '🪙', member: '🌟' };

  (function buildSkin() {
    const w = document.querySelector('.wrap');
    if (!w) return;
    if (activeSkin === 'meta4') {
      document.body.classList.add('skin-meta4'); window.__hbSkinMeta4 = true;
      w.innerHTML = '<div class="hyper-glass-frame"><div class="hyper-glass-container"><div id="bar" class="hyper-progress-bar is-empty" aria-hidden="true"><div class="bar-plasma"><div class="bar-shine"></div></div><div class="bar-spark"></div></div><div class="hyper-glass-text" id="meta4-goal-text"></div></div></div>';
    } else if (activeSkin === 'meta3') {
      document.body.classList.add('skin-meta3'); window.__hbSkinMeta3 = true;
      w.innerHTML = '<div class="meta3-goal-container goal-container"><div id="bar" class="progress-bar is-empty" aria-hidden="true"><div class="bar-plasma"><div class="bar-shine"></div></div><div class="bar-spark"></div></div><div class="meta3-goal-text" id="meta3-goal-text"></div></div>';
    } else if (activeSkin === 'meta2') {
      document.body.classList.add('skin-meta2'); window.__hbSkinMeta2 = true;
      w.innerHTML = '<div class="meta2-box"><div class="meta2-card goal-card-slim"><div class="info-group"><span class="title-icon gift-icon" id="title-icon" aria-hidden="true">🎁</span><span class="goal-title" id="title"></span></div><div class="progress-wrapper"><div class="bar-bg" id="bar-bg"><div class="bar-track" aria-hidden="true"></div><div id="bar" class="is-empty"><div class="bar-plasma"><div class="bar-shine"></div></div><div class="bar-spark"></div></div><div class="bar-test-light" id="bar-test-light" aria-hidden="true"></div><div class="progress-text" id="meta2-progress-label"><span class="meta2-abs-line" id="meta2-abs-line"><span id="meta-current">0</span><span class="meta2-sep"> / </span><span id="meta-goal">0</span><span class="meta2-pts"> pts</span></span></div></div></div></div></div>';
    }
  })();

  let score = 0;
  let target = 100;
  let coinTotal = 0;
  let goalKind = 'hype';
  let customTitle = '';
  let tituloKey = 'hype';
  let onReach = 'increase';
  let modeAbsolute = false;
  let allow = { like: true, follow: true, gift: true, share: true, member: false };
  let points = { like: 1, follow: 10, share: 8, member: 1 };
  let giftMultiplier = 1;
  let baseTitleDisplay = titulosMap.hype;

  const titleIconEl = document.getElementById('title-icon');
  const metaIconEl = document.getElementById('meta-icon');
  const metaCurrent = document.getElementById('meta-current');
  const metaGoal = document.getElementById('meta-goal');
  const bar = document.getElementById('bar');
  const title = document.getElementById('title');
  const isM2 = !!window.__hbSkinMeta2, isM3 = !!window.__hbSkinMeta3, isM4 = !!window.__hbSkinMeta4;

  function fmtNum(n) { return Math.round(Number(n) || 0).toLocaleString('es-ES'); }

  function updateOverlayIcon() {
    const key = (goalKind && iconosMap[goalKind] != null) ? goalKind : tituloKey;
    const emo = iconosMap[key] || iconosMap[tituloKey] || iconosMap.hype;
    [titleIconEl, metaIconEl].forEach((el) => { if (el) el.textContent = emo; });
  }

  function setupKind() {
    modeAbsolute = goalKind === 'viewers';
    if (goalKind === 'hype') {
      allow = { like: true, follow: true, gift: true, share: true, member: false };
      tituloKey = 'hype';
    } else {
      allow = { like: goalKind === 'likes', follow: goalKind === 'follow', gift: goalKind === 'gift', share: goalKind === 'share', member: goalKind === 'member' };
      tituloKey = goalKind === 'likes' ? 'likes' : goalKind === 'follow' ? 'seguidores' : goalKind === 'share' ? 'compartidos' : goalKind === 'gift' ? 'regalos' : goalKind === 'member' ? 'suscriptores' : goalKind === 'viewers' ? 'viewers' : 'hype';
    }
  }

  function update() {
    if (!modeAbsolute) {
      if (onReach === 'increase') { while (score >= target) target += 50; }
      else if (onReach === 'reset' && score >= target) score = 0;
      else if (onReach === 'keep') { score = Math.min(score, target); if (goalKind === 'gift' || tituloKey === 'regalos') coinTotal = score; }
    }
    const pct = target > 0 ? Math.min(100, (score / target) * 100) : 0;
    const barEl = document.getElementById('bar');
    if (isM4 || isM3) {
      if (barEl) { barEl.style.width = pct + '%'; barEl.classList.toggle('is-empty', pct <= 0); }
      const gt = document.getElementById(isM4 ? 'meta4-goal-text' : 'meta3-goal-text');
      if (gt) {
        const act = Math.round(score).toLocaleString('en-US'), meta = Math.round(target).toLocaleString('en-US');
        gt.textContent = String(baseTitleDisplay || 'OBJETIVO').toUpperCase() + ': ' + act + '/' + meta + ' (' + Math.floor(pct) + '%)';
      }
      return;
    }
    if (metaCurrent) metaCurrent.textContent = isM2 ? fmtNum(score) : Math.round(score);
    if (metaGoal) metaGoal.textContent = isM2 ? fmtNum(target) : Math.round(target);
    if (barEl) { barEl.style.width = pct + '%'; barEl.classList.toggle('is-empty', pct <= 0); }
    if (title && !isM2) title.textContent = baseTitleDisplay;
  }

  function add(n, label) {
    if (modeAbsolute) return;
    score += n;
    if (title && !isM2 && !isM3 && !isM4) title.textContent = baseTitleDisplay + ' • ' + label;
    update();
  }

  let testSweepCleanupTimer = null;
  function finishTestLightSweep() {
    const bg = document.getElementById('bar-bg'); if (bg) bg.classList.remove('bar-bg--test-sweep');
    const b = document.getElementById('bar'); if (b) b.classList.remove('bar--no-transition');
    if (testSweepCleanupTimer) { clearTimeout(testSweepCleanupTimer); testSweepCleanupTimer = null; }
  }
  function runTestLightSweep() {
    const bg = document.getElementById('bar-bg'); const light = document.getElementById('bar-test-light');
    if (!bg || !light) return;
    finishTestLightSweep(); bg.classList.remove('bar-bg--test-sweep'); void light.offsetWidth;
    bg.classList.add('bar-bg--test-sweep');
    testSweepCleanupTimer = setTimeout(finishTestLightSweep, 2600);
  }

  let likeAnimQueue = 0, likeAnimTimer = null;
  const LIKE_TICK_MS = 20;
  function pumpLikeSteps() {
    if (likeAnimQueue <= 0) { if (likeAnimTimer) { clearInterval(likeAnimTimer); likeAnimTimer = null; } return; }
    const perTick = likeAnimQueue > 100 ? Math.min(6, Math.ceil(likeAnimQueue / 45)) : 1;
    for (let i = 0; i < perTick && likeAnimQueue > 0; i++) { likeAnimQueue--; add(points.like, '+Like'); }
    if (likeAnimQueue <= 0 && likeAnimTimer) { clearInterval(likeAnimTimer); likeAnimTimer = null; }
  }

  function resetOverlay() {
    finishTestLightSweep();
    likeAnimQueue = 0;
    if (likeAnimTimer) { clearInterval(likeAnimTimer); likeAnimTimer = null; }
    if (testBarTimer) { clearInterval(testBarTimer); testBarTimer = null; }
    lastTotalLike = {};
    score = 0; coinTotal = 0;
    if (title && !isM2 && !isM3 && !isM4) title.textContent = baseTitleDisplay;
    update();
  }

  let lastTotalLike = {};
  function onLike(p) {
    if (!allow.like) return;
    const b = Math.max(0, Math.floor(Number(p && p.count)) || 0);
    if (b <= 0) return;
    likeAnimQueue += b;
    if (!likeAnimTimer) likeAnimTimer = setInterval(pumpLikeSteps, LIKE_TICK_MS);
  }
  function onGift(p) {
    if (!allow.gift) return;
    if (p && p.streak) return;
    const coins = Math.max(1, (Number(p && p.diamonds) || 1) * (Number(p && p.repeatCount) || 1));
    if (goalKind === 'gift' || tituloKey === 'regalos') { coinTotal += coins; score = coinTotal; if (title && !isM2 && !isM3 && !isM4) title.textContent = baseTitleDisplay + ' • +Monedas'; update(); }
    else add(coins * giftMultiplier, '+Gift');
  }

  let testBarTimer = null, embedLoopTimer = null;
  function runTest() {
    resetOverlay();
    if (embedLoopTimer) { clearTimeout(embedLoopTimer); embedLoopTimer = null; }
    const savedReach = onReach; if (!modeAbsolute) onReach = 'keep';
    const budget = Math.max(1, Math.round(target));
    let added = 0;
    if (testBarTimer) { clearInterval(testBarTimer); testBarTimer = null; }
    testBarTimer = setInterval(() => {
      if (added >= budget) {
        clearInterval(testBarTimer); testBarTimer = null;
        runTestLightSweep();
        onReach = savedReach;
        if (isEmbed) embedLoopTimer = setTimeout(runTest, 2800);
        return;
      }
      const step = Math.max(1, Math.ceil(budget / 40));
      if (modeAbsolute) { score = Math.min(target, score + step); update(); }
      else add(step, goalKind === 'gift' ? '+Monedas' : '+Meta');
      added += step;
    }, 45);
  }

  function applyConfig(c) {
    if (!c || typeof c !== 'object') return;
    if (!isEmbed && maybeReloadSkin(skinFromConfig(c))) return;
    if (c.goalKind) goalKind = String(c.goalKind).toLowerCase();
    if (c.title != null) customTitle = String(c.title).trim();
    const nm = parseInt(c.meta, 10); if (Number.isFinite(nm) && nm > 0) target = Math.max(1, nm);
    if (['increase', 'reset', 'keep'].includes(String(c.whenReach))) onReach = String(c.whenReach);
    if (c.pointsLike != null) points.like = Math.max(1, parseInt(c.pointsLike, 10) || 1);
    if (c.pointsFollow != null) points.follow = Math.max(1, parseInt(c.pointsFollow, 10) || 1);
    if (c.pointsShare != null) points.share = Math.max(1, parseInt(c.pointsShare, 10) || 1);
    if (c.pointsMember != null) points.member = Math.max(1, parseInt(c.pointsMember, 10) || 1);
    if (c.pointsGift != null) giftMultiplier = Math.max(1, parseInt(c.pointsGift, 10) || 1);
    if (!isEmbed && c.scale != null) {
      const s = Math.min(2.85, Math.max(0.35, (parseInt(c.scale, 10) || 100) / 100));
      document.documentElement.style.setProperty('--ov-scale', String(s));
    }
    setupKind();
    baseTitleDisplay = customTitle || titulosMap[tituloKey] || titulosMap.hype;
    updateOverlayIcon();
    if (title && !isM2 && !isM3 && !isM4) title.textContent = baseTitleDisplay;
    update();
  }

  function fitEmbed() {
    if (!isEmbed) return;
    const NAT = { default: 640, meta2: 600, meta3: 620, meta4: 520 }[activeSkin] || 640;
    const s = Math.min(1, window.innerWidth / NAT);
    document.documentElement.style.setProperty('--ov-scale', String(s));
  }

  let ws, rt;
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(proto + '://' + location.host + '/ws' + location.search);
    ws.onopen = () => clearTimeout(rt);
    ws.onclose = () => { rt = setTimeout(connect, 1500); };
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === 'settings') { if (m.payload && m.payload.hypeBar) applyConfig(m.payload.hypeBar); return; }
      if (m.type === 'state') { if (goalKind === 'viewers' && m.payload && m.payload.stats) { const v = Number(m.payload.stats.viewers); if (Number.isFinite(v) && v >= 0) { score = v; update(); } } return; }
      if (isEmbed) return;
      if (m.type === 'like') onLike(m.payload);
      else if (m.type === 'follow') { if (allow.follow) add(points.follow, '+Follow'); }
      else if (m.type === 'share') { if (allow.share) add(points.share, '+Share'); }
      else if (m.type === 'member') { if (allow.member) add(points.member, '+Miembro'); }
      else if (m.type === 'gift') onGift(m.payload);
      else if (m.type === 'hypeTest') runTest();
      else if (m.type === 'hypeReset') resetOverlay();
      else if (m.type === 'sessionOverlays') {
        if (!isEmbed && m.payload && m.payload.hype) {
          score = Number(m.payload.hype.score) || 0;
          target = Math.max(1, Number(m.payload.hype.target) || target);
          coinTotal = Number(m.payload.hype.coinTotal) || 0;
          update();
        }
      }
    };
  }

  window.addEventListener('message', (e) => {
    const d = e.data; if (!d || d.kind !== 'hype') return;
    if (d.type === 'config') applyConfig(d.config);
    else if (d.type === 'test') runTest();
    else if (d.type === 'reset') { isEmbed ? runTest() : resetOverlay(); }
  });

  window.addEventListener('resize', fitEmbed);

  setupKind();
  updateOverlayIcon();
  if (title && !isM2 && !isM3 && !isM4) title.textContent = baseTitleDisplay;
  fitEmbed();
  update();
  if (isEmbed) runTest();
  connect();
})();
