/* Overlay Top 3 puntos — datos en vivo desde pointsList / pointsUpdate
   Optimizado para OBS: menos DOM de brillos, fuentes bajo demanda, poda del Map,
   y pausa de animaciones cuando el documento no es visible. */
(function () {
  const PLACEHOLDER = 'https://cdn.pixabay.com/photo/2015/10/05/22/37/blank-profile-picture-973460_960_720.png';
  const PREVIEW_AVATAR = '/jarron/lv.png';
  const FONTS = {
    luckiest: "'Luckiest Guy', system-ui, sans-serif", bangers: "'Bangers', system-ui, sans-serif",
    lilita: "'Lilita One', system-ui, sans-serif", titan: "'Titan One', system-ui, sans-serif",
    fredoka: "'Fredoka', system-ui, sans-serif", bungee: "'Bungee', system-ui, sans-serif",
    rubik: "'Rubik', system-ui, sans-serif", oswald: "'Oswald', system-ui, sans-serif",
    bebas: "'Bebas Neue', Impact, sans-serif", montserrat: "'Montserrat', system-ui, sans-serif",
    poppins: "'Poppins', system-ui, sans-serif", orbitron: "'Orbitron', system-ui, sans-serif",
    inter: "'Inter', system-ui, sans-serif", system: 'system-ui, sans-serif',
  };
  const FONT_CSS = {
    luckiest: 'Luckiest+Guy',
    bangers: 'Bangers',
    lilita: 'Lilita+One',
    titan: 'Titan+One',
    fredoka: 'Fredoka:wght@600;700',
    bungee: 'Bungee',
    rubik: 'Rubik:wght@700;800;900',
    oswald: 'Oswald:wght@600;700',
    bebas: 'Bebas+Neue',
    montserrat: 'Montserrat:wght@700;800;900',
    poppins: 'Poppins:wght@700;800;900',
    orbitron: 'Orbitron:wght@700;800;900',
    inter: 'Inter:wght@600;700;800;900',
  };
  const MEDALS = ['👑', '🥈', '🥉'];
  const DEMO = [
    ['EverHdezHdez', 'https://randomuser.me/api/portraits/men/32.jpg', 6516, 43],
    ['MariaFan', 'https://randomuser.me/api/portraits/women/44.jpg', 6120, 42],
    ['LuisPro', 'https://randomuser.me/api/portraits/men/78.jpg', 3363, 31],
    ['Niki', 'https://randomuser.me/api/portraits/women/68.jpg', 2042, 28],
    ['Falcon D Mady', 'https://randomuser.me/api/portraits/men/12.jpg', 628, 22],
    ['TheGhost', 'https://randomuser.me/api/portraits/men/51.jpg', 507, 20],
    ['SofiLive', 'https://randomuser.me/api/portraits/women/21.jpg', 412, 18],
    ['KarimTT', 'https://randomuser.me/api/portraits/men/64.jpg', 301, 15],
    ['LunaVIP', 'https://randomuser.me/api/portraits/women/33.jpg', 188, 12],
    ['PabloX', 'https://randomuser.me/api/portraits/men/22.jpg', 95, 8],
  ];
  const SPARKLE_COUNT = 8;
  const loadedFonts = new Set(['inter', 'system']);

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function cleanName(raw) {
    if (raw == null || raw === '') return 'Usuario';
    const s = String(raw).trim().replace(/^@+/, '');
    return s || 'Usuario';
  }

  function ensureFont(key) {
    const k = String(key || 'inter');
    if (loadedFonts.has(k) || k === 'system' || !FONT_CSS[k]) return;
    loadedFonts.add(k);
    const href = 'https://fonts.googleapis.com/css2?family=' + FONT_CSS[k] + '&display=swap';
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    document.head.appendChild(link);
  }

  function init(opt) {
    const params = new URLSearchParams(location.search);
    const isEmbed = params.get('embed') === '1';
    let cfg = Object.assign({}, opt.defaults);
    const users = new Map();
    let orderKey = '';
    let animTimer = null;
    let seqTimers = [];
    let sparkBuilt = false;

    const root = document.documentElement;
    const listEl = document.getElementById('list');
    const titleEl = document.getElementById('title');
    const sparkEl = document.getElementById('sparkles');
    const widget = document.querySelector('.widget');
    const stage = document.getElementById('stage');
    const BASE_W = 920;

    if (isEmbed) document.documentElement.dataset.embed = '1';

    function clamp(v, lo, hi, def) { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def; }
    function maxRows() { return clamp(cfg.rows, 1, 10, 3); }

    function setPaused(on) {
      root.dataset.paused = on ? '1' : '0';
      if (on && animTimer) { clearInterval(animTimer); animTimer = null; }
    }

    function applyStyle() {
      ensureFont(cfg.font);
      root.style.setProperty('--tf-font-stack', FONTS[cfg.font] || FONTS.inter);
      root.style.setProperty('--ol-accent', cfg.accent || '#ffd54f');
      if (cfg.rowBg) root.style.setProperty('--row-bg', cfg.rowBg); else root.style.removeProperty('--row-bg');
      root.dataset.bg = cfg.transparent ? '1' : '0';
      root.dataset.lines = cfg.lines ? '1' : '0';
      root.dataset.shadows = cfg.shadows ? '1' : '0';
      root.dataset.namefx = cfg.nameRainbow ? '1' : '0';
      root.dataset.titlefx = cfg.titleRainbow ? '1' : '0';
      root.dataset.glitter = cfg.glitter ? '1' : '0';
      root.dataset.title = cfg.showTitle !== false ? '1' : '0';
      if (titleEl) titleEl.textContent = cfg.title || 'Top Puntos';
      if (sparkEl) {
        if (cfg.glitter) {
          if (!sparkBuilt) { sparkEl.innerHTML = buildSparkles(); sparkBuilt = true; }
        } else {
          sparkEl.innerHTML = '';
          sparkBuilt = false;
        }
      }
      if (!isEmbed) {
        const sc = clamp(cfg.scale, 60, 140, 100) / 100;
        widget.style.setProperty('--ol-scale', String(sc));
      }
    }

    function buildSparkles() {
      let html = '';
      for (let i = 0; i < SPARKLE_COUNT; i++) {
        const x = Math.floor(Math.random() * 100);
        const y = Math.floor(Math.random() * 100);
        const d = (2 + Math.random() * 2.5).toFixed(1);
        const delay = (Math.random() * 4).toFixed(2);
        html += '<span class="spark" style="left:' + x + '%;top:' + y + '%;animation-delay:' + delay + 's;animation-duration:' + d + 's"></span>';
      }
      return html;
    }

    function fit() {
      if (!isEmbed || !widget) return;
      widget.style.setProperty('--ol-scale', '1');
      widget.style.width = BASE_W + 'px';
      const h = widget.offsetHeight;
      if (!h) return;
      const s = Math.min(window.innerWidth / BASE_W, window.innerHeight / h, 1);
      widget.style.setProperty('--ol-scale', String(s));
      if (stage) {
        stage.style.width = Math.ceil(BASE_W * s) + 'px';
        stage.style.height = Math.ceil(h * s) + 'px';
      }
    }

    function clearSeq() { seqTimers.forEach((t) => clearTimeout(t)); seqTimers = []; }
    function runSeqReveal() {
      clearSeq();
      listEl.querySelectorAll('.list--seq .row').forEach((el, i) => {
        seqTimers.push(setTimeout(() => el.classList.add('show'), i * 380));
      });
    }

    function topArr() {
      return [...users.values()]
        .sort((a, b) => b.val - a.val)
        .slice(0, maxRows());
    }
    function rowKey(arr) { return arr.map((u) => u.id).join('\x1e'); }

    /** Solo conserva candidatos al top (evita retener hasta 2500 usuarios en el overlay). */
    function pruneUsers() {
      const keepN = Math.max(12, maxRows() * 4);
      if (users.size <= keepN) return;
      const ranked = [...users.values()].sort((a, b) => b.val - a.val);
      const keep = new Set(ranked.slice(0, keepN).map((u) => u.id));
      for (const id of users.keys()) {
        if (!keep.has(id)) users.delete(id);
      }
    }

    function buildRow(u, rank) {
      const div = document.createElement('div');
      div.className = 'row';
      div.dataset.rank = String(rank);
      div.dataset.uid = String(u.id);
      const medal = rank <= 3 ? MEDALS[rank - 1] : '';
      div.innerHTML =
        '<div class="rank">' + (medal ? '<span class="medal">' + medal + '</span>' : '<span class="rank-num">' + rank + '.</span>') + '</div>' +
        '<div class="av-wrap"><img class="av" alt="" referrerpolicy="no-referrer" decoding="async" src=""></div>' +
        '<div class="meta"><div class="name-row"><span class="name"></span>' +
        '<div class="valwrap"><span class="ico">⭐</span><span class="num">' + (u.disp != null ? u.disp : u.val).toLocaleString('es-ES') + '</span></div></div></div>';
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

    function render(opts) {
      opts = opts || {};
      clearSeq();
      const arr = topArr();
      listEl.classList.toggle('list--seq', !!opts.seq);
      listEl.innerHTML = '';
      if (!arr.length) {
        listEl.innerHTML = '<div class="empty">Sin usuarios con puntos todavía</div>';
        orderKey = '';
        if (isEmbed) fit();
        return;
      }
      arr.forEach((u, i) => listEl.appendChild(buildRow(u, i + 1)));
      orderKey = rowKey(arr);
      if (opts.seq) runSeqReveal();
      if (isEmbed) fit();
    }

    function ensureDisp(u) { if (u.disp == null) u.disp = u.val || 0; }

    function tick() {
      if (document.hidden) return;
      const arr = topArr();
      let moved = false, pending = false;
      arr.forEach((u) => {
        ensureDisp(u);
        const gap = (u.val || 0) - u.disp;
        if (gap > 0) {
          const step = gap > 500 ? Math.min(18, Math.ceil(gap / 40)) : gap > 50 ? 3 : 1;
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
    function scheduleTick() {
      if (document.hidden) return;
      if (!animTimer) animTimer = setInterval(tick, 40);
      tick();
    }

    function ingestUser(u) {
      if (!u) return;
      const id = u.uniqueId || u.id;
      if (!id) return;
      const val = Math.max(0, Number(u.total != null ? u.total : u.val) || 0);
      const prev = users.get(id);
      users.set(id, {
        id,
        name: u.nickname || u.name || (prev && prev.name) || id,
        pic: u.photo || u.pic || (prev && prev.pic) || PLACEHOLDER,
        level: u.level != null ? u.level : (prev && prev.level) || 1,
        val,
        disp: prev ? Math.min(prev.disp, val) : val,
      });
    }

    function ingestList(payload) {
      users.clear();
      (payload.users || []).forEach(ingestUser);
      pruneUsers();
      const arr = topArr();
      const needsAnim = arr.some((u) => u.disp < u.val);
      if (rowKey(arr) !== orderKey || !patchCounts(arr)) render();
      if (needsAnim) scheduleTick();
    }

    function onUpdate(payload) {
      if (!payload || !payload.user) return;
      ingestUser(payload.user);
      pruneUsers();
      const arr = topArr();
      if (rowKey(arr) === orderKey && patchCounts(arr)) { scheduleTick(); return; }
      render();
      scheduleTick();
    }

    function runTest() {
      if (animTimer) { clearInterval(animTimer); animTimer = null; }
      users.clear();
      for (let i = 0; i < Math.min(DEMO.length, maxRows()); i++) {
        const d = DEMO[i];
        users.set('demo_' + i, {
          id: 'demo_' + i,
          name: d[0],
          pic: isEmbed ? PREVIEW_AVATAR : d[1],
          level: d[3],
          val: d[2],
          disp: 0,
        });
      }
      render({ seq: true });
      scheduleTick();
    }

    let ws, rt;
    function connect() {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(proto + '://' + location.host + '/ws' + location.search);
      ws.onopen = () => clearTimeout(rt);
      ws.onclose = () => { rt = setTimeout(connect, 1500); };
      ws.onmessage = (ev) => {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.type === 'settings' && m.payload && m.payload[opt.settingsKey]) {
          cfg = Object.assign(cfg, m.payload[opt.settingsKey]);
          applyStyle();
          render();
        } else if (m.type === 'pointsList') {
          ingestList(m.payload || {});
        } else if (m.type === 'pointsUpdate') {
          onUpdate(m.payload);
        }
      };
    }

    window.addEventListener('message', (e) => {
      const d = e.data; if (!d || d.kind !== opt.kind) return;
      if (d.type === 'config') { cfg = Object.assign(cfg, d.config); applyStyle(); render(); }
      else if (d.type === 'test') {
        if (d.config) { cfg = Object.assign(cfg, d.config); applyStyle(); }
        runTest();
      }
      else if (d.type === 'reset') { if (isEmbed) runTest(); else render(); }
    });

    document.addEventListener('visibilitychange', () => {
      setPaused(document.hidden);
      if (!document.hidden) {
        const arr = topArr();
        if (arr.some((u) => (u.disp || 0) < (u.val || 0))) scheduleTick();
      }
    });
    setPaused(document.hidden);

    window.addEventListener('resize', fit);
    applyStyle();
    if (isEmbed) runTest(); else render();
    connect();
    if (isEmbed) {
      requestAnimationFrame(() => { fit(); requestAnimationFrame(fit); });
      try { new ResizeObserver(() => fit()).observe(document.documentElement); } catch {}
    }
  }

  window.PointsTopOverlay = { init };
})();
