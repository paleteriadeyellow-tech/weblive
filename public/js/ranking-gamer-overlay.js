/* Ranking gamer (escudos / medallas) — likes o monedas. */
(function (global) {
  const PLACEHOLDER = 'https://cdn.pixabay.com/photo/2015/10/05/22/37/blank-profile-picture-973460_960_720.png';
  const PREVIEW_AVATAR = '/jarron/lv.png';
  const H1 = 92, H = 68, GAP = 10;
  const mir = (w) => '<use href="#' + w + '"/><use href="#' + w + '" transform="translate(60 0) scale(-1 1)"/>';
  const BADGE = [
    mir('wingA') + '<use href="#ribbon"/><use href="#medal"/>',
    mir('wingB') + '<use href="#ribbon"/><use href="#medal"/>',
    mir('wingC') + '<use href="#ribbon"/><use href="#medal"/>',
    '<use href="#medal"/>',
  ];
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
  ];
  const HUES = [45, 290, 170, 330, 200, 20, 250, 120];

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }
  function cleanName(raw) {
    if (raw == null || raw === '') return 'Usuario';
    return String(raw).trim().replace(/^@+/, '') || 'Usuario';
  }
  const fmt = (n) => Math.round(Number(n) || 0).toLocaleString('es-MX');

  function init(opt) {
    const params = new URLSearchParams(location.search);
    const isEmbed = params.get('embed') === '1';
    const metric = opt.metric === 'diamonds' ? 'diamonds' : 'likes';
    const list = document.getElementById('list');
    const board = document.querySelector('.board');
    const els = new Map();
    let cfg = Object.assign({ rows: 5, scale: 100, resetPeriod: 'live', compact: false, scoreBelow: false, mirror: false }, opt.defaults || {});
    let data = {};
    let lastTopId = '';
    let seqTimers = [];
    let animTimer = null;
    let orderKey = '';

    function maxRows() {
      const n = parseInt(cfg.rows, 10);
      return Number.isFinite(n) ? Math.min(10, Math.max(3, n)) : 5;
    }
    function rowMetrics() {
      const compact = !!cfg.compact;
      const below = !!cfg.scoreBelow;
      if (compact && below) return { h1: 78, h: 62, gap: 6 };
      if (compact) return { h1: 72, h: 54, gap: 6 };
      if (below) return { h1: 108, h: 82, gap: 8 };
      return { h1: H1, h: H, gap: GAP };
    }
    function applyLayoutFlags() {
      const root = document.documentElement;
      if (cfg.compact) root.dataset.compact = '1'; else delete root.dataset.compact;
      if (cfg.scoreBelow) root.dataset.scoreBelow = '1'; else delete root.dataset.scoreBelow;
      if (cfg.mirror) root.dataset.mirror = '1'; else delete root.dataset.mirror;
    }
    function applyScale() {
      if (!board) return;
      if (isEmbed) {
        board.style.setProperty('--ol-scale', '1');
        requestAnimationFrame(fitEmbed);
        return;
      }
      const sc = Math.min(140, Math.max(60, parseInt(cfg.scale, 10) || 100)) / 100;
      board.style.setProperty('--ol-scale', String(sc));
    }
    function fitEmbed() {
      if (!isEmbed || !board) return;
      board.style.zoom = '';
      const w = board.offsetWidth;
      const h = board.offsetHeight;
      if (!w || !h) return;
      const pad = 10;
      const s = Math.min((window.innerWidth - pad * 2) / w, (window.innerHeight - pad * 2) / h, 1);
      if (s < 0.999) board.style.zoom = String(s);
    }

    function clearSeq() {
      seqTimers.forEach((t) => clearTimeout(t));
      seqTimers = [];
    }

    function scoreIcon() {
      if (metric === 'diamonds') {
        return '<svg viewBox="0 0 24 24" aria-hidden="true">' +
          '<circle cx="12" cy="12" r="11" fill="#ffd700"/>' +
          '<circle cx="12" cy="12" r="5" fill="none" stroke="#fff" stroke-width="2.5"/>' +
          '</svg>';
      }
      return '<svg viewBox="0 0 24 24" aria-hidden="true"><use href="#heart"/></svg>';
    }

    function fillAv(avi, u) {
      const name = cleanName(u.name);
      const hue = HUES[[...name].reduce((a, c) => a + c.charCodeAt(0), 0) % HUES.length];
      const url = String(u.pic || '').trim();
      const key = url || 'h' + hue;
      if (avi.dataset.k === key) return;
      avi.dataset.k = key;
      if (url) {
        avi.innerHTML = '<img alt="" referrerpolicy="no-referrer" src="' + esc(url) + '" onerror="this.onerror=null;this.src=\'' + PLACEHOLDER + '\'">';
      } else {
        avi.innerHTML = '<svg style="color:hsl(' + hue + ' 90% 62%)"><use href="#pilot"/></svg>';
      }
    }

    function ensureDisp(u) { if (u.disp == null) u.disp = u.val || 0; }
    function rowKey(arr) { return arr.map((u) => u.id).join('\x1e'); }

    function build(u) {
      const el = document.createElement('div');
      el.className = 'row';
      el.dataset.uid = String(u.id);
      el.innerHTML =
        '<div class="gl"></div>' +
        '<div class="fx"></div>' +
        '<div class="rank"><svg viewBox="0 0 60 62"></svg><b></b></div>' +
        '<div class="avo"><svg class="crown"><use href="#crown"/></svg><div class="avw"><div class="avi"></div></div></div>' +
        '<div class="mid"><div class="name"></div><div class="score">' + scoreIcon() + '<span></span></div><div class="bar"><b></b></div></div>';
      const fx = el.querySelector('.fx');
      for (let k = 0; k < 12; k++) {
        const i = document.createElement('i');
        i.style.cssText = '--x:' + (Math.random() * 100) + '%;--d:' + (2 + Math.random() * 2.5) + 's;--t:-' + (Math.random() * 3) + 's;--dx:' + ((Math.random() * 40 - 20) | 0) + 'px';
        fx.appendChild(i);
      }
      fillAv(el.querySelector('.avi'), u);
      el.querySelector('.name').textContent = cleanName(u.name);
      list.appendChild(el);
      els.set(String(u.id), el);
      return el;
    }

    function topArr() {
      return Object.values(data).sort((a, b) => b.val - a.val).slice(0, maxRows());
    }

    function patchCounts(arr) {
      const rows = list.querySelectorAll('.row');
      if (rows.length !== arr.length) return false;
      for (let i = 0; i < arr.length; i++) {
        if (rows[i].dataset.uid !== String(arr[i].id)) return false;
      }
      const top = arr[0] ? arr[0].val : 1;
      for (let i = 0; i < arr.length; i++) {
        const u = arr[i];
        const shown = u.disp != null ? u.disp : u.val;
        rows[i].querySelector('.score span').textContent = fmt(shown);
        rows[i].querySelector('.bar b').style.width = Math.max(6, (Number(shown) / Math.max(1, top)) * 100) + '%';
      }
      return true;
    }

    function layoutRows(arr, opts) {
      opts = opts || {};
      const top = arr[0] ? arr[0].val : 1;
      const keep = new Set(arr.map((u) => String(u.id)));
      for (const [id, el] of [...els.entries()]) {
        if (!keep.has(id)) { el.remove(); els.delete(id); }
      }
      const m = rowMetrics();
      let y = 0;
      arr.forEach((u, i) => {
        ensureDisp(u);
        const id = String(u.id);
        let el = els.get(id);
        if (!el) el = build(u);
        else {
          fillAv(el.querySelector('.avi'), u);
          const nm = cleanName(u.name);
          const nameEl = el.querySelector('.name');
          if (nameEl.textContent !== nm) nameEl.textContent = nm;
        }
        const h = i ? m.h : m.h1;
        const bump = el.classList.contains('bump') ? ' bump' : '';
        const seqHide = opts.seq && !el.classList.contains('seq-show') ? ' seq-hide' : '';
        const seqShow = el.classList.contains('seq-show') ? ' seq-show' : '';
        el.className = 'row r' + (i + 1) + bump + seqHide + seqShow;
        el.style.height = h + 'px';
        // keep translateY for absolute layout; seq uses opacity
        el.style.transform = 'translateY(' + y + 'px)';
        el.querySelector('.rank b').textContent = String(i + 1);
        const rs = el.querySelector('.rank svg');
        const bk = Math.min(i, 3);
        if (rs.dataset.k != bk) { rs.dataset.k = bk; rs.innerHTML = BADGE[bk]; }
        const shown = opts.seq && u.disp == null ? 0 : (u.disp != null ? u.disp : u.val);
        el.querySelector('.score span').textContent = fmt(shown);
        el.querySelector('.bar b').style.width = Math.max(6, (Number(shown) / Math.max(1, top)) * 100) + '%';
        y += h + m.gap;
      });
      list.style.height = Math.max(0, y - m.gap) + 'px';
      orderKey = rowKey(arr);
      if (isEmbed) fitEmbed();
    }

    function runSeqReveal(arr) {
      clearSeq();
      arr.forEach((u, i) => {
        const el = els.get(String(u.id));
        if (!el) return;
        el.classList.add('seq-hide');
        el.classList.remove('seq-show');
        seqTimers.push(setTimeout(() => {
          el.classList.remove('seq-hide');
          el.classList.add('seq-show');
          // bump al aparecer
          el.classList.remove('bump');
          void el.offsetWidth;
          el.classList.add('bump');
        }, i * 360));
      });
    }

    function tick() {
      if (document.hidden) {
        const arr = topArr();
        arr.forEach((u) => { u.disp = u.val || 0; });
        if (animTimer) { clearInterval(animTimer); animTimer = null; }
        layoutRows(arr);
        return;
      }
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
        if (rowKey(arr) !== orderKey || !patchCounts(arr)) layoutRows(arr);
      }
      if (!pending && animTimer) { clearInterval(animTimer); animTimer = null; }
    }
    function scheduleTick() {
      if (document.hidden) { tick(); return; }
      if (!animTimer) animTimer = setInterval(tick, 66);
      tick();
    }

    function render(opts) {
      opts = opts || {};
      clearSeq();
      const arr = topArr();
      if (opts.seq) {
        arr.forEach((u) => { u.disp = 0; });
        layoutRows(arr, { seq: true });
        runSeqReveal(arr);
        scheduleTick();
      } else {
        arr.forEach((u) => ensureDisp(u));
        layoutRows(arr);
      }
      const topId = arr[0] ? String(arr[0].id) : '';
      if (!opts.seq && topId && lastTopId && lastTopId !== topId) {
        const el = els.get(topId);
        if (el) { el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump'); }
      }
      lastTopId = topId;
    }

    function applyRankState(payload) {
      const incoming = payload.users || [];
      const next = {};
      for (const u of incoming) {
        const id = u.uniqueId || u.id;
        if (!id) continue;
        const val = Math.max(0, Number(u.val) || 0);
        const prev = data[String(id)];
        next[String(id)] = {
          id: String(id),
          name: u.nickname || u.name || id,
          pic: u.photo || u.pic || PLACEHOLDER,
          val,
          disp: prev ? Math.min(prev.disp != null ? prev.disp : val, val) : val,
        };
      }
      data = next;
      const arr = topArr();
      const needsAnim = arr.some((u) => (u.disp != null ? u.disp : 0) < u.val);
      layoutRows(arr);
      if (needsAnim) scheduleTick();
    }

    function runTest() {
      if (animTimer) { clearInterval(animTimer); animTimer = null; }
      clearSeq();
      // limpia filas previas para la secuencia
      for (const [, el] of els) el.remove();
      els.clear();
      data = {};
      lastTopId = '';
      const R = maxRows();
      const base = (metric === 'likes' ? 1800 : 1200) + Math.floor(Math.random() * 400);
      for (let i = 0; i < R; i++) {
        const d = DEMO[i % DEMO.length];
        const id = 'demo_' + i;
        data[id] = {
          id,
          name: d[0],
          pic: isEmbed ? PREVIEW_AVATAR : d[1],
          val: Math.max(40, Math.round((base - i * (base / (R + 1))) * (0.85 + Math.random() * 0.3))),
          disp: 0,
        };
      }
      render({ seq: true });
    }
    function resetAll() {
      if (animTimer) { clearInterval(animTimer); animTimer = null; }
      clearSeq();
      for (const [, el] of els) el.remove();
      els.clear();
      data = {};
      lastTopId = '';
      list.style.height = '0px';
    }

    function applyConfig(c) {
      if (!c) return;
      cfg = Object.assign(cfg, c);
      applyLayoutFlags();
      applyScale();
      render();
    }

    let ws, rt;
    function connect() {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(proto + '://' + location.host + '/ws' + location.search);
      ws.onopen = () => clearTimeout(rt);
      ws.onclose = () => { rt = setTimeout(connect, 1500); };
      ws.onmessage = (ev) => {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.type === 'settings') {
          if (m.payload && m.payload[opt.settingsKey]) applyConfig(m.payload[opt.settingsKey]);
        } else if (m.type === 'rankState') {
          if (!isEmbed && m.payload && m.payload.rank === opt.rank) applyRankState(m.payload);
        } else if (m.type === 'rankTest') {
          if (!isEmbed && m.payload && m.payload.rank === opt.rank) runTest();
        } else if (m.type === 'rankReset') {
          if (!isEmbed && m.payload && m.payload.rank === opt.rank) {
            if (cfg.resetPeriod === 'week' || cfg.resetPeriod === 'month') return;
            resetAll();
          }
        }
      };
    }
    try { connect(); } catch (e) {}

    window.addEventListener('message', (e) => {
      const d = e.data;
      if (!d || d.kind !== opt.kind) return;
      if (d.type === 'config') applyConfig(d.config);
      else if (d.type === 'test') runTest();
      else if (d.type === 'reset') resetAll();
    });

    applyLayoutFlags();
    applyScale();
    if (isEmbed) {
      setTimeout(runTest, 350);
    } else {
      render();
    }
  }

  global.RankingGamerOverlay = { init };
})(window);
