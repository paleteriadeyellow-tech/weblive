/* Lógica compartida para los overlays de ranking (likes / diamantes), estilo bandas o lista. */
(function () {
  const PLACEHOLDER = 'https://cdn.pixabay.com/photo/2015/10/05/22/37/blank-profile-picture-973460_960_720.png';
  const PREVIEW_AVATAR = '/jarron/lv.png';
  const FONTS = { pressstart: "'Press Start 2P', monospace", exo2: "'Exo 2', system-ui, sans-serif", luckiest: "'Luckiest Guy', system-ui, sans-serif", bangers: "'Bangers', system-ui, sans-serif", lilita: "'Lilita One', system-ui, sans-serif", titan: "'Titan One', system-ui, sans-serif", fredoka: "'Fredoka', system-ui, sans-serif", bungee: "'Bungee', system-ui, sans-serif", rubik: "'Rubik', system-ui, sans-serif", oswald: "'Oswald', system-ui, sans-serif", bebas: "'Bebas Neue', Impact, sans-serif", montserrat: "'Montserrat', system-ui, sans-serif", poppins: "'Poppins', system-ui, sans-serif", orbitron: "'Orbitron', system-ui, sans-serif", inter: "'Inter', system-ui, sans-serif", cinzel: "'Cinzel', Georgia, serif", system: "system-ui, sans-serif" };

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function ensureCoinStyles() {
    if (document.getElementById('ranking-overlay-coin-css')) return;
    const st = document.createElement('style');
    st.id = 'ranking-overlay-coin-css';
    st.textContent = '.ico .ico-coin { width: 1em; height: 1em; display: block; flex-shrink: 0; object-fit: contain; }';
    document.head.appendChild(st);
  }
  function ensureMirrorStyles() {
    let st = document.getElementById('ranking-overlay-mirror-css');
    if (!st) {
      st = document.createElement('style');
      st.id = 'ranking-overlay-mirror-css';
      document.head.appendChild(st);
    }
    st.textContent =
      'html[data-mirror="1"] .widget{margin-left:auto;margin-right:0;transform:scale(var(--ol-scale,1)) scaleX(-1);transform-origin:top left}' +
      'html[data-mirror="1"] .list .row>*{transform:scaleX(-1)}' +
      'html[data-mirror="1"] .meta{text-align:right}' +
      'html[data-mirror="1"] .name-row{align-items:flex-end;text-align:right}' +
      'html[data-mirror="1"] .valwrap{justify-content:flex-end;width:100%}';
  }
  function coinIconMarkup(color) {
    const c = (color && /^#[0-9a-fA-F]{3,8}$/.test(color)) ? color : '#ffd700';
    return '<svg class="ico-coin" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true">' +
      '<circle cx="12" cy="12" r="11" fill="' + c + '"/>' +
      '<circle cx="12" cy="12" r="5" fill="none" stroke="#fff" stroke-width="2.5"/></svg>';
  }
  function iconMarkup(icon, accent) {
    if (icon === 'mc-heart') return '<span class="ico-mc-heart" aria-hidden="true"></span>';
    if (icon === 'mc-diamond') return '<span class="ico-mc-diamond" aria-hidden="true"></span>';
    if (icon === '🪙' || icon === 'coin') return coinIconMarkup(accent);
    if (/^(\/|https?:)/.test(icon)) {
      return '<img class="ico-coin" src="' + esc(icon) + '" alt="" aria-hidden="true" decoding="async">';
    }
    return esc(icon);
  }
  function cleanName(raw) {
    if (raw == null || raw === '') return 'Usuario';
    const s = String(raw).trim().replace(/^@+/, '');
    return s || 'Usuario';
  }

  function fitEmbed(widget) {
    if (!widget) return;
    widget.style.setProperty('--ol-scale', '1');
    widget.style.zoom = '';
    widget.style.height = '';
    widget.style.marginBottom = '';
    const w = widget.offsetWidth;
    const h = widget.offsetHeight;
    if (!w || !h) return;
    const pad = 12;
    const s = Math.min((window.innerWidth - pad * 2) / w, (window.innerHeight - pad * 2) / h, 1);
    if (s >= 0.999) return;
    widget.style.zoom = String(s);
  }

  function init(opt) {
    ensureCoinStyles();
    ensureMirrorStyles();
    const params = new URLSearchParams(location.search);
    const isEmbed = params.get('embed') === '1';
    const style = opt.style; // 'banded' | 'lista'
    const theme = opt.theme || '';
    const metric = opt.metric; // 'likes' | 'diamonds'
    const icon = opt.icon;
    const baseW = opt.baseW || (style === 'lista' ? 360 : 920);
    const medalSet = style === 'banded' ? ['👑', '🥈', '🥉'] : ['🥇', '🥈', '🥉'];

    let cfg = Object.assign({}, opt.defaults);
    let data = {};
    let orderKey = '';
    let seqTimers = [];
    let animTimer = null;
    const root = document.documentElement;
    const listEl = document.getElementById('list');
    const widget = document.querySelector('.widget');

    function clamp(v, lo, hi, def) { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def; }
    function maxRows() { return clamp(cfg.rows, 1, 15, 5); }

    function applyStyle() {
      root.style.setProperty('--tf-font-stack', FONTS[cfg.font] || (theme === 'minecraft' ? FONTS.pressstart : FONTS.inter));
      root.style.setProperty('--ol-accent', cfg.accent || '#ffffff');
      if (cfg.rowBg) root.style.setProperty('--row-bg', cfg.rowBg); else root.style.removeProperty('--row-bg');
      root.dataset.bg = cfg.transparent ? '1' : '0';
      root.dataset.lines = cfg.lines ? '1' : '0';
      root.dataset.shadows = cfg.shadows ? '1' : '0';
      root.dataset.namefx = cfg.nameRainbow ? '1' : '0';
      if (cfg.mirror) root.dataset.mirror = '1'; else delete root.dataset.mirror;
      if (theme) root.dataset.theme = theme; else delete root.dataset.theme;
      if (!isEmbed) {
        const sc = clamp(cfg.scale, 60, 140, 100) / 100;
        widget.style.setProperty('--ol-scale', String(sc));
      } else {
        requestAnimationFrame(fit);
      }
    }

    function fit() {
      if (!isEmbed) return;
      fitEmbed(widget);
    }

    function clearSeq() { seqTimers.forEach((t) => clearTimeout(t)); seqTimers = []; }
    function runSeqReveal() {
      clearSeq();
      const rows = listEl.querySelectorAll('.list--seq .row');
      rows.forEach((el, i) => { seqTimers.push(setTimeout(() => { el.classList.add('show'); }, i * 360)); });
    }

    function ensureDisp(u) { if (u.disp == null) u.disp = u.val || 0; }

    function rowKey(arr) { return arr.map((u) => u.id).join('\x1e'); }

    function buildRow(u, rank) {
      const isMc = theme === 'minecraft';
      let rankInner;
      if (isMc && rank <= 3) {
        const cls = ['mc-gold', 'mc-iron', 'mc-copper'][rank - 1];
        rankInner = '<span class="medal mc-slot ' + cls + '"></span>';
      } else if (rank <= 3) {
        rankInner = '<span class="medal">' + medalSet[rank - 1] + '</span>';
      } else {
        rankInner = '<span class="rank-num">' + rank + '.</span>';
      }
      const crownHtml = isMc
        ? '<span class="crown mc-helm"></span>'
        : '<img class="crown" src="/img/gold-crown.png" alt="" aria-hidden="true" decoding="async">';
      const div = document.createElement('div');
      div.className = 'row';
      div.dataset.rank = String(rank);
      div.dataset.uid = String(u.id);
      div.innerHTML =
        '<div class="rank">' + rankInner + '</div>' +
        '<div class="av-wrap">' + crownHtml + '<img class="av" alt="" referrerpolicy="no-referrer" src=""></div>' +
        '<div class="meta"><div class="name-row"><span class="name"></span>' +
        '<div class="valwrap"><span class="ico">' + iconMarkup(icon, cfg.accent) + '</span><span class="num">' + (u.disp || 0).toLocaleString('es-ES') + '</span></div></div></div>';
      const img = div.querySelector('.av');
      img.src = u.pic || PLACEHOLDER;
      img.onerror = function () { this.onerror = null; this.src = PLACEHOLDER; };
      const nm = div.querySelector('.name');
      const safe = cleanName(u.name);
      nm.textContent = safe; nm.title = safe;
      return div;
    }

    function patchCounts(arr) {
      const rows = listEl.querySelectorAll('.row');
      if (rows.length !== arr.length) return false;
      for (let i = 0; i < arr.length; i++) {
        if (rows[i].dataset.uid !== String(arr[i].id)) return false;
      }
      for (let i = 0; i < arr.length; i++) {
        rows[i].querySelector('.num').textContent = (arr[i].disp != null ? arr[i].disp : arr[i].val).toLocaleString('es-ES');
      }
      return true;
    }

    function topArr() {
      return Object.values(data).sort((a, b) => b.val - a.val).slice(0, maxRows());
    }

    function render(opts) {
      opts = opts || {};
      clearSeq();
      const arr = topArr();
      listEl.classList.toggle('list--seq', !!opts.seq);
      listEl.innerHTML = '';
      arr.forEach((u, i) => { ensureDisp(u); listEl.appendChild(buildRow(u, i + 1)); });
      orderKey = rowKey(arr);
      if (opts.seq) runSeqReveal();
      if (isEmbed) fit();
    }

    function tick() {
      const arr = topArr();
      let moved = false, pending = false;
      arr.forEach((u) => {
        ensureDisp(u);
        const gap = (u.val || 0) - u.disp;
        if (gap > 0) {
          const step = gap > 120 ? Math.min(12, Math.ceil(gap / 35)) : 1;
          u.disp = Math.min(u.val, u.disp + step);
          moved = true;
          if (u.val > u.disp) pending = true;
        }
      });
      if (moved) {
        if (rowKey(arr) !== orderKey || !patchCounts(arr)) render();
      }
      if (!pending && animTimer) { clearInterval(animTimer); animTimer = null; }
    }
    function scheduleTick() { if (!animTimer) animTimer = setInterval(tick, 24); tick(); }

    function bump(uid, name, pic, delta) {
      if (delta <= 0) return;
      if (!data[uid]) data[uid] = { id: uid, name: name, pic: pic || PLACEHOLDER, val: 0, disp: 0 };
      data[uid].val += delta;
      if (name) data[uid].name = name;
      if (pic) data[uid].pic = pic;
      ensureDisp(data[uid]);
      const arr = topArr();
      if (rowKey(arr) === orderKey && patchCounts(arr)) { scheduleTick(); return; }
      render();
      scheduleTick();
    }

    function onGift(p) {
      if (p && p.streak) return;
      const delta = (Number(p.diamonds) || 0) * (Number(p.repeatCount) || 1);
      const uid = p.uniqueId || p.nickname; if (!uid) return;
      bump(uid, p.nickname || uid, p.photo, delta);
    }
    function onLike(p) {
      const uid = p.uniqueId || p.nickname; if (!uid) return;
      bump(uid, p.nickname || uid, p.photo, Math.max(0, Number(p.count) || 0));
    }

    const DEMO = [
      ['PreviewFan', 'https://randomuser.me/api/portraits/men/32.jpg'],
      ['MariaFan', 'https://randomuser.me/api/portraits/women/44.jpg'],
      ['LuisPro', 'https://randomuser.me/api/portraits/men/78.jpg'],
      ['SofiaStar', 'https://randomuser.me/api/portraits/women/65.jpg'],
      ['Cazador', 'https://randomuser.me/api/portraits/men/12.jpg'],
      ['Neo', 'https://randomuser.me/api/portraits/women/68.jpg'],
      ['Kai', 'https://randomuser.me/api/portraits/men/45.jpg'],
      ['Luna', 'https://randomuser.me/api/portraits/women/33.jpg'],
      ['Alex', 'https://randomuser.me/api/portraits/men/22.jpg'],
      ['Sam', 'https://randomuser.me/api/portraits/women/12.jpg'],
      ['River', 'https://randomuser.me/api/portraits/men/5.jpg'],
      ['Jordan', 'https://randomuser.me/api/portraits/women/5.jpg'],
      ['Casey', 'https://randomuser.me/api/portraits/men/60.jpg'],
      ['Taylor', 'https://randomuser.me/api/portraits/women/60.jpg'],
      ['Morgan', 'https://randomuser.me/api/portraits/men/8.jpg'],
    ];

    function runTest() {
      if (animTimer) { clearInterval(animTimer); animTimer = null; }
      data = {};
      const R = maxRows();
      const base = (metric === 'likes' ? 15000 : 12000) + Math.floor(Math.random() * 4000);
      for (let i = 0; i < R; i++) {
        const d = DEMO[i % DEMO.length];
        const id = 'demo_' + i;
        data[id] = { id, name: d[0], pic: isEmbed ? PREVIEW_AVATAR : d[1], val: Math.max(40, Math.round((base - i * (base / (R + 2))) * (0.85 + Math.random() * 0.3))), disp: 0 };
      }
      render({ seq: true });
      scheduleTick();
    }
    function resetAll() {
      if (animTimer) { clearInterval(animTimer); animTimer = null; }
      data = {}; render();
    }

    function applyRankState(payload) {
      const incoming = payload.users || [];
      const next = {};
      for (const u of incoming) {
        const id = u.uniqueId || u.id;
        if (!id) continue;
        const val = Math.max(0, Number(u.val) || 0);
        const prev = data[id];
        next[id] = {
          id,
          name: u.nickname || u.name || (prev && prev.name) || id,
          pic: u.photo || u.pic || (prev && prev.pic) || PLACEHOLDER,
          val,
          disp: prev ? Math.min(prev.disp, val) : val,
        };
      }
      data = next;
      const arr = topArr();
      const needsAnim = arr.some((u) => u.disp < u.val);
      if (rowKey(arr) !== orderKey || !patchCounts(arr)) render();
      if (needsAnim) scheduleTick();
    }

    let ws, rt;
    function connect() {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(proto + '://' + location.host + '/ws' + location.search);
      ws.onopen = () => clearTimeout(rt);
      ws.onclose = () => { rt = setTimeout(connect, 1500); };
      ws.onmessage = (ev) => {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.type === 'settings') { if (m.payload && m.payload[opt.settingsKey]) { cfg = Object.assign(cfg, m.payload[opt.settingsKey]); applyStyle(); render(); } }
        else if (m.type === 'rankState') { if (!isEmbed && m.payload && m.payload.rank === opt.rank) applyRankState(m.payload); }
        else if (m.type === 'rankTest') { if (!isEmbed && m.payload && m.payload.rank === opt.rank) runTest(); }
        else if (m.type === 'rankReset') {
          if (!isEmbed && m.payload && m.payload.rank === opt.rank) {
            const p = cfg.resetPeriod;
            if (p === 'week' || p === 'month') return;
            resetAll();
          }
        }
      };
    }

    window.addEventListener('message', (e) => {
      const d = e.data; if (!d || d.kind !== opt.kind) return;
      if (d.type === 'config') { cfg = Object.assign(cfg, d.config); applyStyle(); render(); }
      else if (d.type === 'test') runTest();
      else if (d.type === 'reset') { isEmbed ? runTest() : resetAll(); }
    });

    window.addEventListener('resize', fit);

    applyStyle();
    if (isEmbed) runTest(); else render();
    connect();
  }

  /* Alterna entre ranking diamantes y likes (mismas tarjetas banda). */
  function initAlt(opt) {
    ensureCoinStyles();
    ensureMirrorStyles();
    const params = new URLSearchParams(location.search);
    const isEmbed = params.get('embed') === '1';
    const medalSet = ['👑', '🥈', '🥉'];
    const modes = opt.modes || [
      { rank: 'topdiam', icon: '🪙', accentKey: 'diamAccent', periodKey: 'resetPeriodDiam' },
      { rank: 'toplikes', icon: '❤️', accentKey: 'likesAccent', periodKey: 'resetPeriodLikes' },
    ];

    let cfg = Object.assign({}, opt.defaults);
    const stores = {};
    modes.forEach((m) => { stores[m.rank] = {}; });
    let modeIdx = 0;
    let orderKey = '';
    let seqTimers = [];
    let animTimer = null;
    let altTimer = null;
    const root = document.documentElement;
    const listEl = document.getElementById('list');
    const widget = document.querySelector('.widget');
    if (isEmbed) root.dataset.embed = '1';

    function clamp(v, lo, hi, def) { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def; }
    function maxRows() { return clamp(cfg.rows, 1, 15, 5); }
    function intervalMs() { return Math.max(2, clamp(cfg.intervalSec, 2, 60, 3)) * 1000; }
    function curMode() { return modes[modeIdx]; }
    function curData() { return stores[curMode().rank]; }

    const isNeon = opt.layout === 'neon';

    function applyStyle() {
      root.style.setProperty('--tf-font-stack', FONTS[cfg.font] || (isNeon ? FONTS.orbitron : FONTS.inter));
      const m = curMode();
      root.style.setProperty('--ol-accent', cfg[m.accentKey] || cfg.likesAccent || '#ffffff');
      if (cfg.rowBg) root.style.setProperty('--row-bg', cfg.rowBg); else root.style.removeProperty('--row-bg');
      if (isNeon) {
        root.style.setProperty('--neon-border', cfg.neonBorder || '#5b7cff');
        root.style.setProperty('--neon-glow', cfg.neonGlow || '#b44dff');
        root.style.setProperty('--pill-bg', cfg.pillBg || 'rgba(8,12,28,0.18)');
        root.dataset.layout = 'neon';
        root.dataset.bounce = cfg.bounce !== false ? '1' : '0';
      } else {
        root.style.removeProperty('--neon-border');
        root.style.removeProperty('--neon-glow');
        root.style.removeProperty('--pill-bg');
        delete root.dataset.layout;
        delete root.dataset.bounce;
      }
      root.dataset.bg = cfg.transparent ? '1' : '0';
      root.dataset.lines = cfg.lines != null ? (cfg.lines ? '1' : '0') : '0';
      root.dataset.shadows = cfg.shadows != null ? (cfg.shadows ? '1' : '0') : '1';
      root.dataset.namefx = cfg.nameRainbow ? '1' : '0';
      if (cfg.mirror) root.dataset.mirror = '1'; else delete root.dataset.mirror;
      if (!isEmbed) {
        const sc = clamp(cfg.scale, 60, 140, 100) / 100;
        widget.style.setProperty('--ol-scale', String(sc));
      } else {
        requestAnimationFrame(fit);
      }
    }

    function fit() {
      if (!isEmbed) return;
      fitEmbed(widget);
    }

    function clearSeq() { seqTimers.forEach((t) => clearTimeout(t)); seqTimers = []; }
    function runSeqReveal() {
      clearSeq();
      const rows = listEl.querySelectorAll('.list--seq .row');
      rows.forEach((el, i) => { seqTimers.push(setTimeout(() => { el.classList.add('show'); }, i * 360)); });
    }

    function ensureDisp(u) { if (u.disp == null) u.disp = u.val || 0; }
    function rowKey(arr) { return arr.map((u) => u.id).join('\x1e'); }

    function buildRow(u, rank, icon, accentColor) {
      const div = document.createElement('div');
      div.className = 'row';
      div.dataset.rank = String(rank);
      div.dataset.uid = String(u.id);
      if (isNeon) {
        div.innerHTML =
          '<div class="av-wrap"><img class="av" alt="" referrerpolicy="no-referrer" src=""></div>' +
          '<div class="meta">' +
            '<div class="name-pill"><div class="name-pill-inner"><span class="name"></span></div></div>' +
            '<div class="valwrap"><span class="ico">' + iconMarkup(icon, accentColor) + '</span><span class="num">' + (u.disp || 0).toLocaleString('es-ES') + '</span></div>' +
          '</div>';
      } else {
        const medal = rank <= 3 ? medalSet[rank - 1] : '';
        div.innerHTML =
          '<div class="rank">' + (medal ? '<span class="medal">' + medal + '</span>' : '<span class="rank-num">' + rank + '.</span>') + '</div>' +
          '<div class="av-wrap"><img class="crown" src="/img/gold-crown.png" alt="" aria-hidden="true" decoding="async"><img class="av" alt="" referrerpolicy="no-referrer" src=""></div>' +
          '<div class="meta"><div class="name-row"><span class="name"></span>' +
          '<div class="valwrap"><span class="ico">' + iconMarkup(icon, accentColor) + '</span><span class="num">' + (u.disp || 0).toLocaleString('es-ES') + '</span></div></div></div>';
      }
      const img = div.querySelector('.av');
      img.src = u.pic || PLACEHOLDER;
      img.onerror = function () { this.onerror = null; this.src = PLACEHOLDER; };
      const nm = div.querySelector('.name');
      const safe = cleanName(u.name);
      nm.textContent = safe; nm.title = safe;
      return div;
    }

    function patchCounts(arr) {
      const rows = listEl.querySelectorAll('.row');
      if (rows.length !== arr.length) return false;
      for (let i = 0; i < arr.length; i++) {
        if (rows[i].dataset.uid !== String(arr[i].id)) return false;
      }
      for (let i = 0; i < arr.length; i++) {
        rows[i].querySelector('.num').textContent = (arr[i].disp != null ? arr[i].disp : arr[i].val).toLocaleString('es-ES');
      }
      return true;
    }

    function topArr(data) {
      return Object.values(data).sort((a, b) => b.val - a.val).slice(0, maxRows());
    }

    function render(opts) {
      opts = opts || {};
      clearSeq();
      const m = curMode();
      applyStyle();
      const data = curData();
      const arr = topArr(data);
      listEl.classList.toggle('list--seq', !!opts.seq);
      listEl.innerHTML = '';
      arr.forEach((u, i) => { ensureDisp(u); listEl.appendChild(buildRow(u, i + 1, m.icon, cfg[m.accentKey] || cfg.likesAccent)); });
      orderKey = rowKey(arr);
      if (opts.seq) {
        runSeqReveal();
        if (isEmbed) seqTimers.push(setTimeout(fit, maxRows() * 360 + 80));
      }
      if (isEmbed) {
        fit();
        requestAnimationFrame(fit);
        setTimeout(fit, 120);
      }
    }

    function tick() {
      const data = curData();
      const arr = topArr(data);
      let moved = false, pending = false;
      arr.forEach((u) => {
        ensureDisp(u);
        const gap = (u.val || 0) - u.disp;
        if (gap > 0) {
          const step = gap > 120 ? Math.min(12, Math.ceil(gap / 35)) : 1;
          u.disp = Math.min(u.val, u.disp + step);
          moved = true;
          if (u.val > u.disp) pending = true;
        }
      });
      if (moved) {
        if (rowKey(arr) !== orderKey || !patchCounts(arr)) render();
      }
      if (!pending && animTimer) { clearInterval(animTimer); animTimer = null; }
    }
    function scheduleTick() { if (!animTimer) animTimer = setInterval(tick, 24); tick(); }

    function applyRankState(payload) {
      const rank = payload.rank;
      if (!stores[rank]) return;
      const incoming = payload.users || [];
      const next = {};
      const prevStore = stores[rank];
      for (const u of incoming) {
        const id = u.uniqueId || u.id;
        if (!id) continue;
        const val = Math.max(0, Number(u.val) || 0);
        const prev = prevStore[id];
        next[id] = {
          id,
          name: u.nickname || u.name || (prev && prev.name) || id,
          pic: u.photo || u.pic || (prev && prev.pic) || PLACEHOLDER,
          val,
          disp: prev ? Math.min(prev.disp, val) : val,
        };
      }
      stores[rank] = next;
      if (curMode().rank !== rank) return;
      const arr = topArr(stores[rank]);
      const needsAnim = arr.some((u) => u.disp < u.val);
      if (rowKey(arr) !== orderKey || !patchCounts(arr)) render();
      if (needsAnim) scheduleTick();
    }

    function resetRank(rank) {
      const m = modes.find((x) => x.rank === rank);
      if (m) {
        const p = cfg[m.periodKey];
        if (p === 'week' || p === 'month') return;
      }
      stores[rank] = {};
      if (curMode().rank === rank) {
        if (animTimer) { clearInterval(animTimer); animTimer = null; }
        render();
      }
    }

    const DEMO = [
      ['PreviewFan', 'https://randomuser.me/api/portraits/men/32.jpg'],
      ['MariaFan', 'https://randomuser.me/api/portraits/women/44.jpg'],
      ['LuisPro', 'https://randomuser.me/api/portraits/men/78.jpg'],
      ['SofiaStar', 'https://randomuser.me/api/portraits/women/65.jpg'],
      ['Cazador', 'https://randomuser.me/api/portraits/men/12.jpg'],
    ];

    function fillDemo(baseVal) {
      const out = {};
      const R = maxRows();
      for (let i = 0; i < R; i++) {
        const d = DEMO[i % DEMO.length];
        const id = 'demo_' + i;
        out[id] = {
          id, name: d[0], pic: isEmbed ? PREVIEW_AVATAR : d[1],
          val: Math.max(40, Math.round((baseVal - i * (baseVal / (R + 2))) * (0.85 + Math.random() * 0.3))),
          disp: 0,
        };
      }
      return out;
    }

    function runTest() {
      if (animTimer) { clearInterval(animTimer); animTimer = null; }
      stores.topdiam = fillDemo(12000 + Math.floor(Math.random() * 4000));
      stores.toplikes = fillDemo(15000 + Math.floor(Math.random() * 4000));
      modeIdx = 0;
      render({ seq: true });
      scheduleTick();
      startAlt();
    }

    function resetAll() {
      if (animTimer) { clearInterval(animTimer); animTimer = null; }
      modes.forEach((m) => { stores[m.rank] = {}; });
      render();
    }

    function switchMode() {
      listEl.classList.remove('alt-show');
      setTimeout(() => {
        modeIdx = (modeIdx + 1) % modes.length;
        render({ seq: true });
        listEl.classList.add('alt-show');
        scheduleTick();
      }, 280);
    }

    function startAlt() {
      clearInterval(altTimer);
      listEl.classList.add('alt-show');
      altTimer = setInterval(switchMode, intervalMs());
    }
    function stopAlt() { clearInterval(altTimer); altTimer = null; }

    let ws, rt;
    function connect() {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(proto + '://' + location.host + '/ws' + location.search);
      ws.onopen = () => clearTimeout(rt);
      ws.onclose = () => { rt = setTimeout(connect, 1500); };
      ws.onmessage = (ev) => {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.type === 'settings') {
          if (m.payload && m.payload[opt.settingsKey]) {
            cfg = Object.assign(cfg, m.payload[opt.settingsKey]);
            applyStyle();
            render();
            if (altTimer) startAlt();
          }
        } else if (m.type === 'rankState') {
          if (!isEmbed && m.payload && stores[m.payload.rank]) applyRankState(m.payload);
        } else if (m.type === 'rankTest') {
          if (!isEmbed && m.payload && stores[m.payload.rank]) runTest();
        } else if (m.type === 'rankAltTest') {
          if (!isEmbed) runTest();
        } else if (m.type === 'rankReset') {
          if (!isEmbed && m.payload && m.payload.rank) resetRank(m.payload.rank);
        }
      };
    }

    window.addEventListener('message', (e) => {
      const d = e.data; if (!d || d.kind !== opt.kind) return;
      if (d.type === 'config') {
        cfg = Object.assign(cfg, d.config);
        applyStyle();
        render();
        if (altTimer || isEmbed) startAlt();
      } else if (d.type === 'test') runTest();
      else if (d.type === 'reset') { isEmbed ? runTest() : resetAll(); }
    });

    window.addEventListener('resize', fit);

    applyStyle();
    if (isEmbed) runTest(); else { render(); startAlt(); }
    connect();
  }

  /* Overlay rotatorio: likes / coins / comentarios / puntos (diseño corona). */
  function initMulti(opt) {
    ensureCoinStyles();
    const params = new URLSearchParams(location.search);
    const isEmbed = params.get('embed') === '1';
    const ALL_MODES = [
      { id: 'likes', store: 'toplikes', showKey: 'showLikes', titleKey: 'titleLikes', icon: '/img/likes-heart.gif', defaultTitle: 'TOP LIKES' },
      { id: 'coins', store: 'topdiam', showKey: 'showCoins', titleKey: 'titleCoins', icon: '/img/diamonds-coin.gif', defaultTitle: 'TOP COINS' },
      { id: 'comments', store: 'topcomments', showKey: 'showComments', titleKey: 'titleComments', icon: '💬', defaultTitle: 'TOP CHAT' },
      { id: 'points', store: 'points', showKey: 'showPoints', titleKey: 'titlePoints', icon: '⭐', defaultTitle: 'RANKING' },
    ];

    let cfg = Object.assign({}, opt.defaults);
    const stores = { toplikes: {}, topdiam: {}, topcomments: {}, points: {} };
    let modeIdx = 0;
    let orderKey = '';
    let seqTimers = [];
    let animTimer = null;
    let rotTimer = null;
    const root = document.documentElement;
    const listEl = document.getElementById('list');
    const titleEl = document.getElementById('multi-title');
    const headerEl = document.getElementById('multi-header');
    const widget = document.querySelector('.widget');
    if (isEmbed) root.dataset.embed = '1';

    function clamp(v, lo, hi, def) { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def; }
    function maxRows() { return clamp(cfg.rows, 1, 10, 3); }
    function intervalMs() { return Math.max(2, clamp(cfg.intervalSec, 2, 60, 4)) * 1000; }

    function activeModes() {
      const list = ALL_MODES.filter((m) => cfg[m.showKey] !== false);
      return list.length ? list : [ALL_MODES[0]];
    }
    function curMode() {
      const modes = activeModes();
      if (modeIdx >= modes.length) modeIdx = 0;
      return modes[modeIdx];
    }
    function curData() { return stores[curMode().store] || {}; }

    function applyStyle() {
      root.style.setProperty('--tf-font-stack', FONTS[cfg.font] || FONTS.cinzel || FONTS.inter);
      const mode = cfg.colorMode === 'rainbow' || cfg.colorMode === 'aurora' ? cfg.colorMode : 'solid';
      root.dataset.colormode = mode;
      const setColor = (key, cssVar, fallback) => {
        const v = cfg[key];
        root.style.setProperty(cssVar, (v && /^#[0-9a-fA-F]{3,8}$/.test(v)) ? v : fallback);
      };
      setColor('titleColor', '--tmr-title', '#ffffff');
      setColor('nameColor', '--tmr-name', '#ffffff');
      setColor('valueColor', '--tmr-value', '#ffffff');
      setColor('starColor', '--tmr-star', '#ffd54f');
      setColor('ring1', '--tmr-ring-1', '#ffd54f');
      setColor('ring2', '--tmr-ring-2', '#cfd8dc');
      setColor('ring3', '--tmr-ring-3', '#ffab73');
      setColor('ringOther', '--tmr-ring-other', '#7dd3fc');
      setColor('posColor', '--tmr-pos', '#ffd54f');
      const sc = clamp(cfg.scale, 60, 150, 100) / 100;
      widget.style.setProperty('--ol-scale', String(sc));
      if (isEmbed) requestAnimationFrame(fit);
      const m = curMode();
      if (titleEl) titleEl.textContent = (cfg[m.titleKey] && String(cfg[m.titleKey]).trim()) || m.defaultTitle;
      root.dataset.mode = m.id;
    }

    function fit() {
      if (!isEmbed || !widget) return;
      /* Conservar escala del usuario; zoom solo para caber en el iframe de preview. */
      const userScale = clamp(cfg.scale, 60, 150, 100) / 100;
      widget.style.setProperty('--ol-scale', String(userScale));
      widget.style.zoom = '';
      widget.style.height = '';
      widget.style.marginBottom = '';
      const w = widget.offsetWidth;
      const h = widget.offsetHeight;
      if (!w || !h) return;
      const pad = 12;
      const visualW = w * userScale;
      const visualH = h * userScale;
      const s = Math.min((window.innerWidth - pad * 2) / visualW, (window.innerHeight - pad * 2) / visualH, 1);
      if (s < 0.999) widget.style.zoom = String(s);
    }

    function clearSeq() { seqTimers.forEach((t) => clearTimeout(t)); seqTimers = []; }
    function runSeqReveal() {
      clearSeq();
      const rows = listEl.querySelectorAll('.list--seq .row');
      rows.forEach((el, i) => { seqTimers.push(setTimeout(() => { el.classList.add('show'); }, i * 280)); });
    }

    function ensureDisp(u) { if (u.disp == null) u.disp = u.val || 0; }
    function rowKey(arr) { return arr.map((u) => u.id).join('\x1e'); }

    function buildRow(u, rank, icon) {
      const div = document.createElement('div');
      div.className = 'row';
      div.dataset.rank = String(rank);
      div.dataset.uid = String(u.id);
      const crown = rank === 1
        ? '<img class="crown" src="/img/gold-crown.png" alt="" aria-hidden="true" decoding="async">'
        : '';
      const posLabel = rank === 1 ? '1st' : (rank === 2 ? '2nd' : (rank === 3 ? '3rd' : rank + 'th'));
      div.innerHTML =
        '<div class="av-wrap">' + crown +
          '<div class="av-ring"><img class="av" alt="" referrerpolicy="no-referrer" src=""></div>' +
          '<span class="pos">' + posLabel + '</span>' +
        '</div>' +
        '<div class="meta">' +
          '<span class="name fx-text"></span>' +
          '<div class="valwrap"><span class="num fx-text">' + (u.disp || 0).toLocaleString('es-ES') + '</span>' +
          '<span class="ico">' + iconMarkup(icon, cfg.starColor || '#ffd54f') + '</span></div>' +
        '</div>';
      const img = div.querySelector('.av');
      img.src = u.pic || PLACEHOLDER;
      img.onerror = function () { this.onerror = null; this.src = PLACEHOLDER; };
      const nm = div.querySelector('.name');
      const safe = cleanName(u.name);
      nm.textContent = safe; nm.title = safe;
      return div;
    }

    function patchCounts(arr) {
      const rows = listEl.querySelectorAll('.row');
      if (rows.length !== arr.length) return false;
      for (let i = 0; i < arr.length; i++) {
        if (rows[i].dataset.uid !== String(arr[i].id)) return false;
      }
      for (let i = 0; i < arr.length; i++) {
        rows[i].querySelector('.num').textContent = (arr[i].disp != null ? arr[i].disp : arr[i].val).toLocaleString('es-ES');
      }
      return true;
    }

    function topArr(data) {
      return Object.values(data).sort((a, b) => b.val - a.val).slice(0, maxRows());
    }

    function render(opts) {
      opts = opts || {};
      clearSeq();
      applyStyle();
      const m = curMode();
      const data = curData();
      const arr = topArr(data);
      listEl.classList.toggle('list--seq', !!opts.seq);
      listEl.innerHTML = '';
      arr.forEach((u, i) => { ensureDisp(u); listEl.appendChild(buildRow(u, i + 1, m.icon)); });
      orderKey = rowKey(arr);
      if (opts.seq) {
        runSeqReveal();
        if (isEmbed) seqTimers.push(setTimeout(fit, maxRows() * 280 + 80));
      }
      if (isEmbed) {
        fit();
        requestAnimationFrame(fit);
        setTimeout(fit, 120);
      }
    }

    function tick() {
      const data = curData();
      const arr = topArr(data);
      let moved = false, pending = false;
      arr.forEach((u) => {
        ensureDisp(u);
        const gap = (u.val || 0) - u.disp;
        if (gap > 0) {
          const step = gap > 120 ? Math.min(12, Math.ceil(gap / 35)) : 1;
          u.disp = Math.min(u.val, u.disp + step);
          moved = true;
          if (u.val > u.disp) pending = true;
        }
      });
      if (moved) {
        if (rowKey(arr) !== orderKey || !patchCounts(arr)) render();
      }
      if (!pending && animTimer) { clearInterval(animTimer); animTimer = null; }
    }
    function scheduleTick() { if (!animTimer) animTimer = setInterval(tick, 24); tick(); }

    function applyRankState(payload) {
      const rank = payload.rank;
      if (!stores[rank] || rank === 'points') return;
      const incoming = payload.users || [];
      const next = {};
      const prevStore = stores[rank];
      for (const u of incoming) {
        const id = u.uniqueId || u.id;
        if (!id) continue;
        const val = Math.max(0, Number(u.val) || 0);
        const prev = prevStore[id];
        next[id] = {
          id,
          name: u.nickname || u.name || (prev && prev.name) || id,
          pic: u.photo || u.pic || (prev && prev.pic) || PLACEHOLDER,
          val,
          disp: prev ? Math.min(prev.disp, val) : val,
        };
      }
      stores[rank] = next;
      if (curMode().store !== rank) return;
      const arr = topArr(stores[rank]);
      const needsAnim = arr.some((u) => u.disp < u.val);
      if (rowKey(arr) !== orderKey || !patchCounts(arr)) render();
      if (needsAnim) scheduleTick();
    }

    function applyPointsList(payload) {
      const incoming = (payload && payload.users) || [];
      const next = {};
      const prevStore = stores.points;
      for (const u of incoming) {
        const id = u.uniqueId || u.id;
        if (!id) continue;
        const val = Math.max(0, Number(u.total != null ? u.total : u.val) || 0);
        const prev = prevStore[id];
        next[id] = {
          id,
          name: u.nickname || u.name || (prev && prev.name) || id,
          pic: u.photo || u.pic || (prev && prev.pic) || PLACEHOLDER,
          val,
          disp: prev ? Math.min(prev.disp, val) : val,
        };
      }
      stores.points = next;
      if (curMode().store !== 'points') return;
      const arr = topArr(stores.points);
      const needsAnim = arr.some((u) => u.disp < u.val);
      if (rowKey(arr) !== orderKey || !patchCounts(arr)) render();
      if (needsAnim) scheduleTick();
    }

    function applyPointsUpdate(payload) {
      const u = payload && payload.user;
      if (!u) return;
      const id = u.uniqueId || u.id;
      if (!id) return;
      const val = Math.max(0, Number(u.total != null ? u.total : u.val) || 0);
      const prev = stores.points[id];
      stores.points[id] = {
        id,
        name: u.nickname || u.name || (prev && prev.name) || id,
        pic: u.photo || u.pic || (prev && prev.pic) || PLACEHOLDER,
        val,
        disp: prev ? Math.min(prev.disp, val) : val,
      };
      if (curMode().store !== 'points') return;
      const arr = topArr(stores.points);
      const needsAnim = arr.some((x) => x.disp < x.val);
      if (rowKey(arr) !== orderKey || !patchCounts(arr)) render();
      if (needsAnim) scheduleTick();
    }

    function resetRank(rank) {
      if (rank === 'toplikes' || rank === 'topdiam' || rank === 'topcomments') {
        const periodKey = rank === 'toplikes' ? 'resetPeriodLikes'
          : (rank === 'topdiam' ? 'resetPeriodDiam' : 'resetPeriodComments');
        const p = cfg[periodKey];
        if (p === 'week' || p === 'month') return;
        stores[rank] = {};
        if (curMode().store === rank) {
          if (animTimer) { clearInterval(animTimer); animTimer = null; }
          render();
        }
      }
    }

    const DEMO = [
      ['PreviewFan', 'https://randomuser.me/api/portraits/men/32.jpg'],
      ['MariaFan', 'https://randomuser.me/api/portraits/women/44.jpg'],
      ['LuisPro', 'https://randomuser.me/api/portraits/men/78.jpg'],
      ['SofiaStar', 'https://randomuser.me/api/portraits/women/65.jpg'],
      ['Cazador', 'https://randomuser.me/api/portraits/men/12.jpg'],
    ];

    function fillDemo(baseVal) {
      const out = {};
      const R = maxRows();
      for (let i = 0; i < R; i++) {
        const d = DEMO[i % DEMO.length];
        const id = 'demo_' + i;
        out[id] = {
          id, name: d[0], pic: isEmbed ? PREVIEW_AVATAR : d[1],
          val: Math.max(40, Math.round((baseVal - i * (baseVal / (R + 2))) * (0.85 + Math.random() * 0.3))),
          disp: 0,
        };
      }
      return out;
    }

    function runTest() {
      if (animTimer) { clearInterval(animTimer); animTimer = null; }
      stores.toplikes = fillDemo(15000 + Math.floor(Math.random() * 4000));
      stores.topdiam = fillDemo(12000 + Math.floor(Math.random() * 4000));
      stores.topcomments = fillDemo(80 + Math.floor(Math.random() * 40));
      stores.points = fillDemo(5000 + Math.floor(Math.random() * 2000));
      modeIdx = 0;
      render({ seq: true });
      scheduleTick();
      startRot();
    }

    function resetAll() {
      if (animTimer) { clearInterval(animTimer); animTimer = null; }
      stores.toplikes = {};
      stores.topdiam = {};
      stores.topcomments = {};
      /* puntos: no borrar el leaderboard del sistema en reset de ranks */
      render();
    }

    function switchMode() {
      const modes = activeModes();
      if (modes.length <= 1) return;
      listEl.classList.remove('multi-show');
      if (headerEl) headerEl.classList.remove('multi-show');
      setTimeout(() => {
        modeIdx = (modeIdx + 1) % modes.length;
        render({ seq: true });
        listEl.classList.add('multi-show');
        if (headerEl) headerEl.classList.add('multi-show');
        scheduleTick();
      }, 260);
    }

    function startRot() {
      clearInterval(rotTimer);
      rotTimer = null;
      listEl.classList.add('multi-show');
      if (headerEl) headerEl.classList.add('multi-show');
      const modes = activeModes();
      if (modes.length > 1) rotTimer = setInterval(switchMode, intervalMs());
    }
    function stopRot() { clearInterval(rotTimer); rotTimer = null; }

    let ws, rt;
    function connect() {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(proto + '://' + location.host + '/ws' + location.search);
      ws.onopen = () => clearTimeout(rt);
      ws.onclose = () => { rt = setTimeout(connect, 1500); };
      ws.onmessage = (ev) => {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.type === 'settings') {
          if (m.payload && m.payload[opt.settingsKey]) {
            cfg = Object.assign(cfg, m.payload[opt.settingsKey]);
            applyStyle();
            render();
            startRot();
          }
        } else if (m.type === 'rankState') {
          if (!isEmbed && m.payload && stores[m.payload.rank] != null && m.payload.rank !== 'points') applyRankState(m.payload);
        } else if (m.type === 'pointsList') {
          if (!isEmbed && m.payload) applyPointsList(m.payload);
        } else if (m.type === 'pointsUpdate') {
          if (!isEmbed && m.payload) applyPointsUpdate(m.payload);
        } else if (m.type === 'rankMultiTest') {
          if (!isEmbed) runTest();
        } else if (m.type === 'rankReset') {
          if (!isEmbed && m.payload && m.payload.rank) resetRank(m.payload.rank);
        }
      };
    }

    window.addEventListener('message', (e) => {
      const d = e.data; if (!d || d.kind !== opt.kind) return;
      if (d.type === 'config') {
        cfg = Object.assign(cfg, d.config);
        applyStyle();
        render();
        startRot();
      } else if (d.type === 'test') runTest();
      else if (d.type === 'reset') { isEmbed ? runTest() : resetAll(); }
    });

    window.addEventListener('resize', fit);

    applyStyle();
    if (isEmbed) runTest(); else { render(); startRot(); }
    connect();
  }

  window.RankingOverlay = { init, initAlt, initMulti };
})();
