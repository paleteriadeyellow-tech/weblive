/* Lógica compartida para los overlays de ranking (likes / diamantes), estilo bandas o lista. */
(function () {
  const PLACEHOLDER = 'https://cdn.pixabay.com/photo/2015/10/05/22/37/blank-profile-picture-973460_960_720.png';
  const PREVIEW_AVATAR = '/jarron/lv.png';

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function cleanName(raw) {
    if (raw == null || raw === '') return 'Usuario';
    const s = String(raw).trim().replace(/^@+/, '');
    return s || 'Usuario';
  }

  function init(opt) {
    const params = new URLSearchParams(location.search);
    const isEmbed = params.get('embed') === '1';
    const style = opt.style; // 'banded' | 'lista'
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
      root.style.setProperty('--ol-accent', cfg.accent || '#ffffff');
      if (cfg.rowBg) root.style.setProperty('--row-bg', cfg.rowBg); else root.style.removeProperty('--row-bg');
      root.dataset.bg = cfg.transparent ? '1' : '0';
      root.dataset.lines = cfg.lines ? '1' : '0';
      root.dataset.shadows = cfg.shadows ? '1' : '0';
      root.dataset.namefx = cfg.nameRainbow ? '1' : '0';
      if (!isEmbed) {
        const sc = clamp(cfg.scale, 60, 140, 100) / 100;
        widget.style.setProperty('--ol-scale', String(sc));
      }
    }

    function fit() {
      if (!isEmbed) return;
      widget.style.setProperty('--ol-scale', '1');
      const w = widget.offsetWidth, h = widget.offsetHeight;
      if (!w || !h) return;
      const s = Math.min(window.innerWidth / w, window.innerHeight / h, 1);
      widget.style.setProperty('--ol-scale', String(s));
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
      const medal = rank <= 3 ? medalSet[rank - 1] : '';
      const div = document.createElement('div');
      div.className = 'row';
      div.dataset.rank = String(rank);
      div.dataset.uid = String(u.id);
      div.innerHTML =
        '<div class="rank">' + (medal ? '<span class="medal">' + medal + '</span>' : '<span class="rank-num">' + rank + '.</span>') + '</div>' +
        '<div class="av-wrap"><span class="crown">👑</span><img class="av" alt="" referrerpolicy="no-referrer" src=""></div>' +
        '<div class="meta"><span class="name"></span>' +
        '<div class="valwrap"><span class="ico">' + icon + '</span><span class="num">' + (u.disp || 0).toLocaleString('es-ES') + '</span></div></div>';
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

    let ws, rt;
    function connect() {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(proto + '://' + location.host + '/ws' + location.search);
      ws.onopen = () => clearTimeout(rt);
      ws.onclose = () => { rt = setTimeout(connect, 1500); };
      ws.onmessage = (ev) => {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.type === 'gift') { if (!isEmbed && metric === 'diamonds') onGift(m.payload); }
        else if (m.type === 'like') { if (!isEmbed && metric === 'likes') onLike(m.payload); }
        else if (m.type === 'settings') { if (m.payload && m.payload[opt.settingsKey]) { cfg = Object.assign(cfg, m.payload[opt.settingsKey]); applyStyle(); render(); } }
        else if (m.type === 'rankTest') { if (!isEmbed && m.payload && m.payload.rank === opt.rank) runTest(); }
        else if (m.type === 'rankReset') { if (!isEmbed && m.payload && m.payload.rank === opt.rank) resetAll(); }
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

  window.RankingOverlay = { init };
})();
