/* Editor de imágenes ligero para Livecoins (capas DOM + export canvas). */
(function () {
  const $ = (id) => document.getElementById(id);

  let wired = false;
  let layers = []; // { id, type, x, y, w, h, src?, name?, text?, color?, fontSize?, font?, rainbow?, motion?, locked?, label?, strokeWidth?, strokeColor?, shadow?, bg? }
  let selectedId = null;
  let stageW = 1080;
  let stageH = 1080;
  let scale = 1;
  let userZoom = null;
  let drag = null;
  let listDragId = null;
  let bgMode = 'color';
  let bgImageSrc = null;
  const HISTORY_MAX = 40;
  const DESIGNS_KEY = 'livecoins-editor-designs';
  let history = [];
  let historyIndex = -1;
  let skipHistory = false;

  /** Mismas fuentes que CFG_FONTS del panel */
  const EDITOR_FONTS = [
    ['pressstart', 'Press Start 2P ⛏'],
    ['exo2', 'Exo 2'],
    ['luckiest', 'Luckiest Guy ⭐'],
    ['bangers', 'Bangers ⭐'],
    ['lilita', 'Lilita One ⭐'],
    ['titan', 'Titan One ⭐'],
    ['fredoka', 'Fredoka ⭐'],
    ['bungee', 'Bungee ⭐'],
    ['rubik', 'Rubik'],
    ['oswald', 'Oswald'],
    ['bebas', 'Bebas Neue'],
    ['montserrat', 'Montserrat'],
    ['poppins', 'Poppins'],
    ['orbitron', 'Orbitron'],
    ['inter', 'Inter'],
    ['system', 'Sistema'],
  ];
  const FONT_STACKS = {
    pressstart: "'Press Start 2P', monospace",
    exo2: "'Exo 2', system-ui, sans-serif",
    luckiest: "'Luckiest Guy', system-ui, sans-serif",
    bangers: "'Bangers', system-ui, sans-serif",
    lilita: "'Lilita One', system-ui, sans-serif",
    titan: "'Titan One', system-ui, sans-serif",
    fredoka: "'Fredoka', system-ui, sans-serif",
    bungee: "'Bungee', system-ui, sans-serif",
    rubik: "'Rubik', system-ui, sans-serif",
    oswald: "'Oswald', system-ui, sans-serif",
    bebas: "'Bebas Neue', Impact, sans-serif",
    montserrat: "'Montserrat', system-ui, sans-serif",
    poppins: "'Poppins', system-ui, sans-serif",
    orbitron: "'Orbitron', system-ui, sans-serif",
    inter: "'Inter', system-ui, sans-serif",
    system: 'system-ui, -apple-system, "Segoe UI", sans-serif',
  };

  function fontKey(L) {
    if (L?.font && FONT_STACKS[L.font]) return L.font;
    // compat capas viejas con fontFamily
    const ff = String(L?.fontFamily || '');
    const hit = Object.entries(FONT_STACKS).find(([, stack]) => stack === ff);
    return hit ? hit[0] : 'rubik';
  }
  function fontStack(L) { return FONT_STACKS[fontKey(L)] || FONT_STACKS.rubik; }
  function fontWeight(L) {
    const k = fontKey(L);
    return (k === 'pressstart' || k === 'bangers' || k === 'luckiest' || k === 'lilita' || k === 'titan') ? '400' : '800';
  }
  function textNeedsGifAnim(L) {
    if (!L || L.type !== 'text') return false;
    return L.rainbow === 'move' || (L.motion && L.motion !== 'off');
  }
  function layerNeedsGifAnim(L) {
    if (!L) return false;
    if (L.motion && L.motion !== 'off') return true;
    return textNeedsGifAnim(L);
  }
  function motionSelectOptions() {
    return `
            <option value="off">Sin movimiento</option>
            <option value="float">Flotar</option>
            <option value="bounce">Rebote</option>
            <option value="pulse">Pulso</option>
            <option value="shake">Temblor</option>`;
  }

  function uid() {
    return 'l_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
  }

  function deepCloneLayer(L) {
    return JSON.parse(JSON.stringify(L));
  }

  function layerForSave(L) {
    const o = deepCloneLayer(L);
    if (o.gifBytes && o.gifBytes.byteLength > 512000) delete o.gifBytes;
    return o;
  }

  function snapshotState() {
    return {
      layers: layers.map(layerForSave),
      stageW,
      stageH,
      bgMode,
      bg: $('ied-bg')?.value || '#0b0f1a',
      bgG1: $('ied-bg-g1')?.value || '#0b0f1a',
      bgG2: $('ied-bg-g2')?.value || '#1a1040',
      bgImageSrc,
      selectedId,
    };
  }

  function restoreState(snap) {
    if (!snap) return;
    skipHistory = true;
    layers = (snap.layers || []).map((L) => {
      const copy = deepCloneLayer(L);
      if (copy.gifBytes && !(copy.gifBytes instanceof ArrayBuffer)) {
        try {
          const u8 = new Uint8Array(copy.gifBytes);
          copy.gifBytes = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
        } catch { delete copy.gifBytes; }
      }
      return copy;
    });
    stageW = snap.stageW || 1080;
    stageH = snap.stageH || 1080;
    bgMode = snap.bgMode || 'color';
    bgImageSrc = snap.bgImageSrc || null;
    const sizeSel = $('ied-size');
    if (sizeSel) sizeSel.value = stageW + 'x' + stageH;
    const bgModeSel = $('ied-bg-mode');
    if (bgModeSel) bgModeSel.value = bgMode;
    if ($('ied-bg')) $('ied-bg').value = snap.bg || '#0b0f1a';
    if ($('ied-bg-g1')) $('ied-bg-g1').value = snap.bgG1 || '#0b0f1a';
    if ($('ied-bg-g2')) $('ied-bg-g2').value = snap.bgG2 || '#1a1040';
    selectedId = snap.selectedId && getLayer(snap.selectedId) ? snap.selectedId : (layers.length ? layers[layers.length - 1].id : null);
    syncBgModeUi();
    applyStageBackground();
    fitScale();
    updateGuides();
    renderAll();
    skipHistory = false;
  }

  function pushSnapshot() {
    if (skipHistory) return;
    const snap = snapshotState();
    const prev = history[historyIndex];
    if (prev && JSON.stringify(prev) === JSON.stringify(snap)) return;
    history = history.slice(0, historyIndex + 1);
    history.push(snap);
    if (history.length > HISTORY_MAX) {
      history.shift();
      historyIndex = history.length - 1;
    } else {
      historyIndex++;
    }
    updateUndoRedoUi();
  }
  const pushHistory = pushSnapshot;

  function undo() {
    if (historyIndex <= 0) return;
    historyIndex--;
    restoreState(history[historyIndex]);
    updateUndoRedoUi();
  }

  function redo() {
    if (historyIndex >= history.length - 1) return;
    historyIndex++;
    restoreState(history[historyIndex]);
    updateUndoRedoUi();
  }

  function updateUndoRedoUi() {
    const u = $('ied-undo');
    const r = $('ied-redo');
    if (u) u.disabled = historyIndex <= 0;
    if (r) r.disabled = historyIndex >= history.length - 1;
  }

  function computedFitScale() {
    const vp = viewport();
    if (!vp) return 1;
    const pad = 24;
    const availW = Math.max(120, vp.clientWidth - pad);
    const availH = Math.max(120, vp.clientHeight - pad);
    return Math.min(availW / stageW, availH / stageH, 1);
  }

  function syncBgModeUi() {
    const mode = $('ied-bg-mode')?.value || bgMode || 'color';
    bgMode = mode;
    const cw = $('ied-bg-color-wrap');
    const gw = $('ied-bg-grad-wrap');
    const iw = $('ied-bg-img-wrap');
    if (cw) cw.hidden = mode !== 'color';
    if (gw) gw.hidden = mode !== 'gradient';
    if (iw) iw.hidden = mode !== 'image';
  }

  function stageBackgroundCss() {
    if (bgMode === 'gradient') {
      const g1 = $('ied-bg-g1')?.value || '#0b0f1a';
      const g2 = $('ied-bg-g2')?.value || '#1a1040';
      return `linear-gradient(135deg, ${g1}, ${g2})`;
    }
    if (bgMode === 'image' && bgImageSrc) {
      return `url("${bgImageSrc}") center/cover no-repeat`;
    }
    return $('ied-bg')?.value || '#0b0f1a';
  }

  function applyStageBackground() {
    const st = stage();
    if (!st) return;
    st.style.background = stageBackgroundCss();
  }

  /** Proxy same-origin para poder exportar PNG sin CORS de TikTok */
  function proxiedSrc(u) {
    const s = String(u || '');
    if (!s) return '';
    if (s.startsWith('data:') || s.startsWith('blob:')) return s;
    if (s.startsWith('/api/img-proxy')) return s;
    if (s.startsWith('/')) return s;
    if (/^https?:\/\//i.test(s)) return '/api/img-proxy?url=' + encodeURIComponent(s);
    if (s.startsWith('//')) return '/api/img-proxy?url=' + encodeURIComponent('https:' + s);
    return s;
  }

  function stage() { return $('ied-stage'); }
  function viewport() { return $('ied-viewport'); }

  function fitScale() {
    const sc = $('ied-stage-scale');
    if (!sc) return;
    const base = computedFitScale();
    scale = userZoom != null ? userZoom : base;
    sc.style.transform = `scale(${scale})`;
    sc.style.width = stageW + 'px';
    sc.style.height = stageH + 'px';
    const label = $('ied-zoom-label');
    if (label) {
      const pct = Math.round(scale * 100);
      const fitNote = userZoom != null ? ' (manual)' : '';
      label.textContent = pct + '% · ' + stageW + '×' + stageH + fitNote;
    }
  }

  function zoomIn() {
    const base = computedFitScale();
    userZoom = (userZoom != null ? userZoom : base) + 0.1;
    userZoom = Math.min(userZoom, 3);
    fitScale();
  }

  function zoomOut() {
    const base = computedFitScale();
    userZoom = (userZoom != null ? userZoom : base) - 0.1;
    userZoom = Math.max(userZoom, 0.1);
    fitScale();
  }

  function zoomFit() {
    userZoom = null;
    fitScale();
  }

  function applyStageSize() {
    const sel = $('ied-size')?.value || '1080x1080';
    const [w, h] = sel.split('x').map(Number);
    stageW = w || 1080;
    stageH = h || 1080;
    const st = stage();
    if (st) {
      st.style.width = stageW + 'px';
      st.style.height = stageH + 'px';
    }
    applyStageBackground();
    fitScale();
    updateGuides();
  }

  function gridStep() {
    return Math.max(20, Math.round(Math.min(stageW, stageH) / 27));
  }

  function snapVal(v) {
    if (!$('ied-snap')?.checked) return Math.round(v);
    const g = gridStep();
    return Math.round(v / g) * g;
  }

  function updateGuides() {
    const st = stage();
    if (!st) return;
    let guides = st.querySelector('.ied-guides');
    if (!guides) {
      guides = document.createElement('div');
      guides.className = 'ied-guides';
      st.insertBefore(guides, st.firstChild);
    }
    const showGrid = !!$('ied-grid')?.checked;
    const showCenter = !!$('ied-center-guides')?.checked;
    if (!showGrid && !showCenter) {
      guides.innerHTML = '';
      guides.hidden = true;
      return;
    }
    guides.hidden = false;
    const parts = [];
    if (showGrid) {
      const g = gridStep();
      for (let x = g; x < stageW; x += g) {
        parts.push(`<div class="ied-grid-line v" style="left:${x}px"></div>`);
      }
      for (let y = g; y < stageH; y += g) {
        parts.push(`<div class="ied-grid-line h" style="top:${y}px"></div>`);
      }
    }
    if (showCenter) {
      parts.push('<div class="ied-center-line v"></div><div class="ied-center-line h"></div>');
    }
    guides.innerHTML = parts.join('');
  }

  function refLayer() {
    return getLayer(selectedId) || layers.find((l) => l.type === 'image') || layers[0] || null;
  }

  function alignRow() {
    const ref = refLayer();
    if (!ref) { toast && toast('Añade o selecciona una imagen primero', 'warn'); return; }
    const y = snapVal(ref.y);
    layers.forEach((L) => {
      if (L.type === 'image' || L.id === ref.id) L.y = y;
    });
    renderAll();
    pushSnapshot();
    toast && toast('Fila alineada', 'ok');
  }

  function alignSelectedCenter() {
    const L = getLayer(selectedId);
    if (!L) { toast && toast('Selecciona una capa', 'warn'); return; }
    L.x = snapVal((stageW - L.w) / 2);
    L.y = snapVal((stageH - L.h) / 2);
    renderAll();
    pushSnapshot();
    toast && toast('Centrado', 'ok');
  }

  function alignSelectedH() {
    const L = getLayer(selectedId);
    if (!L) { toast && toast('Selecciona una capa', 'warn'); return; }
    L.x = snapVal((stageW - L.w) / 2);
    renderAll();
    pushSnapshot();
    toast && toast('Centro horizontal', 'ok');
  }

  function alignSelectedV() {
    const L = getLayer(selectedId);
    if (!L) { toast && toast('Selecciona una capa', 'warn'); return; }
    L.y = snapVal((stageH - L.h) / 2);
    renderAll();
    pushSnapshot();
    toast && toast('Centro vertical', 'ok');
  }

  function duplicateLayer(id) {
    const src = getLayer(id || selectedId);
    if (!src) { toast && toast('Selecciona una capa', 'warn'); return; }
    const L = deepCloneLayer(src);
    L.id = uid();
    L.x = snapVal((src.x || 0) + 20);
    L.y = snapVal((src.y || 0) + 20);
    L.locked = false;
    layers.push(L);
    renderAll();
    selectLayer(L.id);
    pushSnapshot();
    toast && toast('Capa duplicada', 'ok');
  }

  function equalSize() {
    const ref = refLayer();
    if (!ref) { toast && toast('Selecciona una imagen de referencia', 'warn'); return; }
    const w = snapVal(ref.w);
    const h = snapVal(ref.h);
    layers.forEach((L) => {
      if (L.type !== 'image') return;
      L.w = w;
      L.h = h;
    });
    renderAll();
    pushSnapshot();
    toast && toast('Tamaño igualado', 'ok');
  }

  function distributeH() {
    const imgs = layers.filter((l) => l.type === 'image');
    if (imgs.length < 2) { toast && toast('Necesitas al menos 2 imágenes', 'warn'); return; }
    imgs.sort((a, b) => a.x - b.x);
    const first = imgs[0];
    const last = imgs[imgs.length - 1];
    const span = (last.x + last.w) - first.x;
    const totalW = imgs.reduce((s, L) => s + L.w, 0);
    const gap = (span - totalW) / (imgs.length - 1);
    let x = first.x;
    imgs.forEach((L, i) => {
      if (i === 0) { x = L.x + L.w + gap; return; }
      if (i === imgs.length - 1) return;
      L.x = snapVal(x);
      x = L.x + L.w + gap;
    });
    // also snap first/last Y already aligned prefer; redistribute including ends with equal gaps across full row
    const left = snapVal(Math.min(...imgs.map((L) => L.x)));
    const right = Math.max(...imgs.map((L) => L.x + L.w));
    const usable = right - left;
    const tw = imgs.reduce((s, L) => s + L.w, 0);
    const g2 = (usable - tw) / (imgs.length - 1);
    let cx = left;
    imgs.forEach((L) => {
      L.x = snapVal(cx);
      cx = L.x + L.w + g2;
    });
    renderAll();
    pushSnapshot();
    toast && toast('Separación repartida', 'ok');
  }

  function selectLayer(id) {
    selectedId = id;
    renderLayersList();
    renderProps();
    renderStageSelection();
  }

  function getLayer(id) {
    return layers.find((l) => l.id === id);
  }

  function bringToFront(id) {
    const i = layers.findIndex((l) => l.id === id);
    if (i < 0) return;
    if (i === layers.length - 1) {
      toast && toast('Ya está al frente', 'ok');
      return;
    }
    const [L] = layers.splice(i, 1);
    layers.push(L);
    selectedId = id;
    renderAll();
    pushSnapshot();
    toast && toast('Capa al frente', 'ok');
  }

  function sendToBack(id) {
    const i = layers.findIndex((l) => l.id === id);
    if (i < 0) return;
    if (i === 0) {
      toast && toast('Ya está atrás', 'ok');
      return;
    }
    const [L] = layers.splice(i, 1);
    layers.unshift(L);
    selectedId = id;
    renderAll();
    pushSnapshot();
    toast && toast('Capa atrás', 'ok');
  }

  /** Un paso hacia adelante (↑) */
  function raiseLayer(id) {
    const i = layers.findIndex((l) => l.id === id);
    if (i < 0 || i >= layers.length - 1) return;
    const tmp = layers[i];
    layers[i] = layers[i + 1];
    layers[i + 1] = tmp;
    selectedId = id;
    renderAll();
    pushSnapshot();
  }

  /** Un paso hacia atrás (↓) */
  function lowerLayer(id) {
    const i = layers.findIndex((l) => l.id === id);
    if (i <= 0) return;
    const tmp = layers[i];
    layers[i] = layers[i - 1];
    layers[i - 1] = tmp;
    selectedId = id;
    renderAll();
    pushSnapshot();
  }

  function removeLayer(id) {
    const L = getLayer(id);
    if (L?.locked) { toast && toast('Capa bloqueada', 'warn'); return; }
    layers = layers.filter((l) => l.id !== id);
    if (selectedId === id) selectedId = layers.length ? layers[layers.length - 1].id : null;
    renderAll();
    pushSnapshot();
  }

  function stripFrameLayers() {
    layers = layers.filter((L) => L.type !== 'frame' && L.type !== 'panel');
    layers.forEach((L) => {
      if (L.type === 'image') {
        delete L.frame;
        delete L.frameId;
      }
    });
    if (selectedId && !getLayer(selectedId)) {
      selectedId = layers.length ? layers[layers.length - 1].id : null;
    }
  }

  function addImageLayer(src, name, opts) {
    if (!src) return;
    const size = Math.round(Math.min(stageW, stageH) * 0.22);
    const L = {
      id: uid(),
      type: 'image',
      name: name || 'Imagen',
      src: proxiedSrc(src),
      motion: 'off',
      label: opts?.label || '',
      x: Math.round((stageW - size) / 2),
      y: Math.round((stageH - size) / 2),
      w: size,
      h: size,
    };
    layers.push(L);
    renderAll();
    selectLayer(L.id);
    pushSnapshot();
  }

  function addGiftLayer(g) {
    const src = g.image || '';
    if (!src) return;
    const size = Math.round(Math.min(stageW, stageH) * 0.22);
    const L = {
      id: uid(),
      type: 'image',
      name: g.name || 'Regalo',
      src: proxiedSrc(src),
      motion: 'off',
      label: '',
      x: Math.round((stageW - size) / 2),
      y: Math.round((stageH - size) / 2),
      w: size,
      h: size,
    };
    layers.push(L);
    renderAll();
    selectLayer(L.id);
    pushSnapshot();
  }

  function addBadgeLayer(text) {
    const fs = Math.round(Math.min(stageW, stageH) * 0.08);
    const pad = Math.round(fs * 0.5);
    const L = {
      id: uid(),
      type: 'badge',
      name: 'Badge',
      text: text || '1x',
      color: '#ffffff',
      bg: '#e91e63',
      fontSize: fs,
      font: 'bangers',
      motion: 'off',
      x: Math.round((stageW - fs * 2.5) / 2),
      y: Math.round((stageH - fs * 1.4) / 2),
      w: Math.round(fs * 2.5),
      h: Math.round(fs * 1.4 + pad),
    };
    layers.push(L);
    renderAll();
    selectLayer(L.id);
    pushSnapshot();
  }

  const STICKER_SVGS = {
    crown: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path fill="#ffd700" stroke="#b8860b" stroke-width="2" d="M8 44h48l-6-28-14 16-10-20-10 20-14-16z"/><rect x="8" y="44" width="48" height="8" rx="2" fill="#daa520"/></svg>',
    star: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><polygon fill="#ffeb3b" stroke="#f57f17" stroke-width="2" points="32,4 40,26 64,26 44,40 52,62 32,48 12,62 20,40 0,26 24,26"/></svg>',
    heart: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path fill="#f44336" stroke="#b71c1c" stroke-width="2" d="M32 56S6 38 6 22a12 12 0 0 1 20-8 12 12 0 0 1 20 8c0 16-26 34-26 34z"/></svg>',
    circle: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="28" fill="#25f4ee" stroke="#0d9488" stroke-width="3"/></svg>',
  };

  function svgDataUri(svg) {
    return 'data:image/svg+xml,' + encodeURIComponent(svg);
  }

  function ensureStickersModal() {
    let modal = $('iedStickersModal');
    if (modal) return modal;
    modal = document.createElement('div');
    modal.id = 'iedStickersModal';
    modal.className = 'modal hidden ied-stickers-modal';
    modal.setAttribute('aria-hidden', 'true');
    modal.innerHTML = `
      <div class="modal-box ied-stickers-box">
        <div class="modal-head">
          <h2>Stickers</h2>
          <button type="button" class="modal-close" id="ied-stickers-close" aria-label="Cerrar">✕</button>
        </div>
        <div class="modal-body">
          <div class="ied-stickers-grid" id="ied-stickers-grid"></div>
        </div>
      </div>`;
    document.body.appendChild(modal);
    const grid = $('ied-stickers-grid');
    if (grid) {
      grid.innerHTML = Object.entries(STICKER_SVGS).map(([key, svg]) => `
        <button type="button" class="ied-sticker-btn" data-key="${key}" title="${key}">
          <img src="${svgDataUri(svg)}" alt="${key}" draggable="false">
          <span>${key}</span>
        </button>`).join('');
      grid.querySelectorAll('.ied-sticker-btn').forEach((btn) => {
        btn.onclick = () => {
          const key = btn.dataset.key;
          const svg = STICKER_SVGS[key];
          if (!svg) return;
          addImageLayer(svgDataUri(svg), 'Sticker ' + key);
          showModal('iedStickersModal', false);
        };
      });
    }
    $('ied-stickers-close')?.addEventListener('click', () => showModal('iedStickersModal', false));
    modal.addEventListener('click', (e) => {
      if (e.target?.id === 'iedStickersModal') showModal('iedStickersModal', false);
    });
    return modal;
  }

  function openStickersModal() {
    ensureStickersModal();
    showModal('iedStickersModal', true);
  }

  const PNG_DOWNLOAD_PACKS = [
    {
      id: 'geometrydash',
      name: 'Geometry Dash',
      desc: 'Pack de iconos PNG',
      cover: '/img/gdash/gdash-card.jpg',
      url: 'https://github.com/riusaki1995/.exe/releases/download/v1.0.79/geometryDash.zip',
      fileName: 'geometryDash.zip',
    },
  ];

  const PACK_DB_NAME = 'livecoins-editor-packs';
  const PACK_DB_VER = 1;
  const PACK_IMG_EXT = /\.(png|jpe?g|gif|webp)$/i;
  let pngDlTab = 'packs'; // packs | catalog
  let catalogPackId = null;
  let catalogFolder = null; // null = lista de carpetas del pack
  const packObjectUrls = new Map(); // key -> blob url
  let jszipPromise = null;

  const PACK_ROOT_SKIP = /^(geometrydash|gdash|images?|pngs?|icons?|assets?|img)$/i;

  function zipFolderFromPath(relativePath) {
    const parts = String(relativePath || '').replace(/\\/g, '/').split('/').filter(Boolean);
    if (parts.length <= 1) return '';
    parts.pop();
    while (parts.length && PACK_ROOT_SKIP.test(parts[0])) parts.shift();
    return parts.join(' / ');
  }

  function prettyFolderLabel(folder) {
    const f = String(folder || '').trim();
    if (!f) return 'General';
    const labels = (typeof GDASH_SECTION_LABEL !== 'undefined' && GDASH_SECTION_LABEL) || {
      colores: 'Colores del jugador',
      jugador: 'Tamaño / estado del jugador',
      camara: 'Efectos de cámara',
    };
    const key = f.toLowerCase().split('/').pop().trim();
    return labels[key] || f;
  }

  function folderFromGdashCatalog(baseName) {
    if (typeof GDASH_CATALOG === 'undefined' || !Array.isArray(GDASH_CATALOG)) return '';
    const n = String(baseName || '').toLowerCase().trim();
    if (!n) return '';
    const cat = GDASH_CATALOG.find((c) => {
      const id = String(c.id || '').toLowerCase();
      const nom = String(c.nombre || c.name || '').toLowerCase();
      return id === n || nom === n || nom.replace(/\s+/g, '') === n.replace(/\s+/g, '');
    });
    if (!cat?.section) return '';
    return prettyFolderLabel(cat.section);
  }

  function sortFolderNames(names, packId) {
    const list = [...names];
    if (packId === 'geometrydash' && typeof GDASH_SECTION_ORDER !== 'undefined') {
      const order = GDASH_SECTION_ORDER.map((s) => prettyFolderLabel(s));
      list.sort((a, b) => {
        const ia = order.indexOf(a);
        const ib = order.indexOf(b);
        if (ia < 0 && ib < 0) return a.localeCompare(b, 'es');
        if (ia < 0) return 1;
        if (ib < 0) return -1;
        return ia - ib;
      });
      return list;
    }
    return list.sort((a, b) => a.localeCompare(b, 'es'));
  }

  function loadJSZip() {
    if (window.JSZip) return Promise.resolve(window.JSZip);
    if (jszipPromise) return jszipPromise;
    jszipPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = '/js/lib/jszip.min.js';
      s.async = true;
      s.onload = () => (window.JSZip ? resolve(window.JSZip) : reject(new Error('JSZip')));
      s.onerror = () => reject(new Error('JSZip load'));
      document.head.appendChild(s);
    });
    return jszipPromise;
  }

  function openPackDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(PACK_DB_NAME, PACK_DB_VER);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('images')) {
          const st = db.createObjectStore('images', { keyPath: 'key' });
          st.createIndex('packId', 'packId', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('idb'));
    });
  }

  function idbReq(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function listInstalledPackMeta() {
    const db = await openPackDb();
    return idbReq(db.transaction('meta', 'readonly').objectStore('meta').getAll());
  }

  async function getPackMeta(packId) {
    const db = await openPackDb();
    return idbReq(db.transaction('meta', 'readonly').objectStore('meta').get(packId));
  }

  async function listPackImages(packId) {
    const db = await openPackDb();
    const idx = db.transaction('images', 'readonly').objectStore('images').index('packId');
    return idbReq(idx.getAll(packId));
  }

  async function clearPack(packId) {
    const db = await openPackDb();
    const imgs = await listPackImages(packId);
    const tx = db.transaction(['meta', 'images'], 'readwrite');
    tx.objectStore('meta').delete(packId);
    for (const im of imgs) tx.objectStore('images').delete(im.key);
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    for (const [k, u] of packObjectUrls) {
      if (k.startsWith(packId + '::')) {
        try { URL.revokeObjectURL(u); } catch { /* ignore */ }
        packObjectUrls.delete(k);
      }
    }
  }

  async function savePackFromZip(pack, zipBuf) {
    const JSZip = await loadJSZip();
    const zip = await JSZip.loadAsync(zipBuf);
    const entries = [];
    zip.forEach((relativePath, file) => {
      if (file.dir) return;
      if (/__MACOSX|\.DS_Store/i.test(relativePath)) return;
      if (!PACK_IMG_EXT.test(relativePath)) return;
      entries.push({ relativePath, file });
    });
    if (!entries.length) throw new Error('empty');

    await clearPack(pack.id).catch(() => {});

    const db = await openPackDb();
    const selected = entries.slice(0, 250);
    let saved = 0;
    const folderSet = new Set();
    for (const { relativePath, file } of selected) {
      const blob = await file.async('blob');
      if (!blob || blob.size < 32 || blob.size > 3 * 1024 * 1024) continue;
      const base = (relativePath.split('/').pop() || file.name || '').replace(PACK_IMG_EXT, '');
      let folder = zipFolderFromPath(relativePath);
      if (!folder && pack.id === 'geometrydash') folder = folderFromGdashCatalog(base);
      if (!folder) folder = 'General';
      folderSet.add(folder);
      const mime = /\.gif$/i.test(relativePath) ? 'image/gif'
        : /\.webp$/i.test(relativePath) ? 'image/webp'
          : /\.jpe?g$/i.test(relativePath) ? 'image/jpeg'
            : 'image/png';
      const typed = blob.type ? blob : new Blob([blob], { type: mime });
      const key = `${pack.id}::${saved}::${base}`;
      await idbReq(db.transaction('images', 'readwrite').objectStore('images').put({
        key,
        packId: pack.id,
        name: base || `img-${saved + 1}`,
        folder,
        blob: typed,
      }));
      saved += 1;
    }
    if (!saved) throw new Error('empty');
    await idbReq(db.transaction('meta', 'readwrite').objectStore('meta').put({
      id: pack.id,
      name: pack.name,
      cover: pack.cover || '',
      count: saved,
      folders: sortFolderNames([...folderSet], pack.id),
      updatedAt: Date.now(),
    }));
    return saved;
  }

  async function blobUrlForPackImage(im) {
    const k = im.key;
    if (packObjectUrls.has(k)) return packObjectUrls.get(k);
    const u = URL.createObjectURL(im.blob);
    packObjectUrls.set(k, u);
    return u;
  }

  async function fetchPackZip(pack) {
    const proxy = `/api/pack-download?url=${encodeURIComponent(pack.url)}`;
    let r = await fetch(proxy);
    if (!r.ok) {
      // fallback directo (por si el proxy no está en una build vieja)
      r = await fetch(pack.url);
    }
    if (!r.ok) throw new Error('fetch');
    return r.arrayBuffer();
  }

  function ensurePngDlModal() {
    let modal = $('iedPngDlModal');
    // Si el modal es viejo (sin pestañas / vistas separadas), recrearlo
    if (modal && (!$('ied-pngdl-packs-view') || !$('ied-pngdl-catalog-view') || !$('ied-pngdl-tabs'))) {
      try { modal.remove(); } catch { /* ignore */ }
      modal = null;
    }
    if (modal) return modal;
    modal = document.createElement('div');
    modal.id = 'iedPngDlModal';
    modal.className = 'modal hidden ied-pngdl-modal';
    modal.setAttribute('aria-hidden', 'true');
    modal.innerHTML = `
      <div class="modal-box ied-pngdl-box">
        <div class="modal-head">
          <h2>Descargar PNG</h2>
          <button type="button" class="modal-close" id="ied-pngdl-close" aria-label="Cerrar">✕</button>
        </div>
        <div class="modal-body ied-pngdl-body">
          <div class="ied-pngdl-tabs" id="ied-pngdl-tabs">
            <button type="button" class="ied-pngdl-tab is-active" data-tab="packs">Descargar</button>
            <button type="button" class="ied-pngdl-tab" data-tab="catalog">Catálogo</button>
          </div>
          <p class="ied-muted ied-pngdl-hint" id="ied-pngdl-hint">Solo packs disponibles para descargar (no van en el instalador).</p>
          <div id="ied-pngdl-packs-view">
            <div class="ied-pngdl-list" id="ied-pngdl-list"></div>
            <p class="ied-muted ied-pngdl-status" id="ied-pngdl-status" hidden></p>
          </div>
          <div id="ied-pngdl-catalog-view" hidden>
            <button type="button" class="ied-games-back ied-pngdl-back" id="ied-pngdl-back" hidden title="Volver">←</button>
            <div class="ied-pngdl-list" id="ied-pngdl-catalog-packs"></div>
            <div class="ied-pngdl-icons" id="ied-pngdl-catalog-icons" hidden></div>
          </div>
        </div>
      </div>`;
    document.body.appendChild(modal);
    $('ied-pngdl-close')?.addEventListener('click', () => showModal('iedPngDlModal', false));
    modal.addEventListener('click', (e) => {
      if (e.target?.id === 'iedPngDlModal') showModal('iedPngDlModal', false);
    });
    modal.querySelectorAll('.ied-pngdl-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        pngDlTab = btn.dataset.tab || 'packs';
        catalogPackId = null;
        catalogFolder = null;
        setPngDlStatus('', false);
        syncPngDlTabs();
        refreshPngDlViews();
      });
    });
    $('ied-pngdl-back')?.addEventListener('click', () => {
      if (catalogFolder != null) catalogFolder = null;
      else catalogPackId = null;
      refreshPngDlViews();
    });
    return modal;
  }

  function syncPngDlTabs() {
    document.querySelectorAll('#iedPngDlModal .ied-pngdl-tab').forEach((b) => {
      b.classList.toggle('is-active', b.dataset.tab === pngDlTab);
    });
    const packsView = $('ied-pngdl-packs-view');
    const catView = $('ied-pngdl-catalog-view');
    if (packsView) packsView.hidden = pngDlTab !== 'packs';
    if (catView) catView.hidden = pngDlTab !== 'catalog';
    const hint = $('ied-pngdl-hint');
    if (hint) {
      hint.textContent = pngDlTab === 'catalog'
        ? 'Packs guardados en tu PC. Ábre uno para ver carpetas e imágenes.'
        : 'Solo packs disponibles para descargar (no van en el instalador).';
    }
  }

  function setPngDlStatus(text, show) {
    const el = $('ied-pngdl-status');
    if (!el) return;
    el.hidden = !show;
    el.textContent = text || '';
  }

  async function importPngPack(pack) {
    if (!pack?.url) return;
    setPngDlStatus(`Descargando ${pack.name}…`, true);
    toast && toast(`Descargando ${pack.name}…`, 'ok');
    try {
      const buf = await fetchPackZip(pack);
      setPngDlStatus('Extrayendo imágenes…', true);
      const n = await savePackFromZip(pack, buf);
      setPngDlStatus('', false);
      toast && toast(`${pack.name}: ${n} imágenes en Catálogo`, 'ok');
      pngDlTab = 'catalog';
      catalogPackId = null;
      catalogFolder = null;
      syncPngDlTabs();
      await refreshPngDlViews();
    } catch (e) {
      console.error(e);
      setPngDlStatus('', false);
      toast && toast('No se pudo importar el pack. Revisa tu conexión.', 'err');
    }
  }

  async function renderPngDlList() {
    const list = $('ied-pngdl-list');
    if (!list) return;
    let installed = [];
    try { installed = await listInstalledPackMeta(); } catch { installed = []; }
    const have = new Set((installed || []).map((x) => x.id));
    if (!PNG_DOWNLOAD_PACKS.length) {
      list.innerHTML = '<p class="ied-muted">No hay packs para descargar.</p>';
      return;
    }
    list.innerHTML = PNG_DOWNLOAD_PACKS.map((p) => `
      <button type="button" class="ied-pngdl-row" data-id="${escapeAttr(p.id)}">
        <img src="${escapeAttr(p.cover || '')}" alt="" onerror="this.style.visibility='hidden'">
        <span class="ied-pngdl-copy">
          <strong>${escapeHtml(p.name)}</strong>
          <em>${have.has(p.id) ? 'Ya en catálogo · clic para actualizar' : escapeHtml(p.desc || 'Descargar')}</em>
        </span>
        <span class="ied-pngdl-dl" aria-hidden="true">↓</span>
      </button>
    `).join('');
    list.querySelectorAll('.ied-pngdl-row').forEach((btn) => {
      btn.onclick = () => {
        const pack = PNG_DOWNLOAD_PACKS.find((x) => x.id === btn.dataset.id);
        if (pack) importPngPack(pack);
      };
    });
  }

  async function renderPngCatalog() {
    const packsEl = $('ied-pngdl-catalog-packs');
    const iconsEl = $('ied-pngdl-catalog-icons');
    const back = $('ied-pngdl-back');
    if (!packsEl || !iconsEl) return;

    // Pack abierto → carpetas o imágenes de una carpeta
    if (catalogPackId) {
      packsEl.hidden = true;
      if (back) back.hidden = false;
      let imgs = [];
      try { imgs = await listPackImages(catalogPackId); } catch { imgs = []; }

      // Retrocompat: packs viejos sin folder → asignar por catálogo GD o General
      imgs = imgs.map((im) => {
        if (im.folder) return im;
        let folder = '';
        if (catalogPackId === 'geometrydash') folder = folderFromGdashCatalog(im.name);
        return { ...im, folder: folder || 'General' };
      });

      const byFolder = new Map();
      for (const im of imgs) {
        const f = im.folder || 'General';
        if (!byFolder.has(f)) byFolder.set(f, []);
        byFolder.get(f).push(im);
      }
      const folderNames = sortFolderNames([...byFolder.keys()], catalogPackId);

      // Si hay más de una carpeta y aún no eligió ninguna → lista de carpetas
      if (folderNames.length > 1 && catalogFolder == null) {
        iconsEl.hidden = true;
        packsEl.hidden = false;
        packsEl.innerHTML = folderNames.map((f) => `
          <button type="button" class="ied-pngdl-row" data-folder="${escapeAttr(f)}">
            <span class="ied-pngdl-folder-ico" aria-hidden="true">📁</span>
            <span class="ied-pngdl-copy">
              <strong>${escapeHtml(f)}</strong>
              <em>${(byFolder.get(f) || []).length} imágenes</em>
            </span>
            <span class="ied-pngdl-dl" aria-hidden="true">→</span>
          </button>
        `).join('');
        packsEl.querySelectorAll('.ied-pngdl-row').forEach((btn) => {
          btn.onclick = () => {
            catalogFolder = btn.getAttribute('data-folder');
            refreshPngDlViews();
          };
        });
        return;
      }

      const activeFolder = catalogFolder != null
        ? catalogFolder
        : (folderNames[0] || 'General');
      const folderImgs = byFolder.get(activeFolder) || imgs;
      iconsEl.hidden = false;
      packsEl.hidden = true;
      if (!folderImgs.length) {
        iconsEl.innerHTML = '<p class="ied-muted" style="grid-column:1/-1">Sin imágenes en esta carpeta.</p>';
        return;
      }
      const urls = await Promise.all(folderImgs.map((im) => blobUrlForPackImage(im)));
      const title = folderNames.length > 1
        ? `<p class="ied-pngdl-folder-title">${escapeHtml(activeFolder)}</p>`
        : '';
      iconsEl.innerHTML = title + folderImgs.map((im, i) => `
        <button type="button" class="ied-pngdl-ic" data-i="${i}" title="${escapeAttr(im.name)}">
          <img src="${escapeAttr(urls[i])}" alt="" loading="lazy">
          <span>${escapeHtml(im.name)}</span>
        </button>
      `).join('');
      iconsEl.querySelectorAll('.ied-pngdl-ic').forEach((btn) => {
        btn.onclick = () => {
          const im = folderImgs[Number(btn.dataset.i)];
          const src = urls[Number(btn.dataset.i)];
          if (!im || !src) return;
          addImageLayer(src, im.name);
          showModal('iedPngDlModal', false);
          toast && toast('Imagen añadida al Editor', 'ok');
        };
      });
      return;
    }

    if (back) back.hidden = true;
    iconsEl.hidden = true;
    packsEl.hidden = false;
    let metas = [];
    try { metas = await listInstalledPackMeta(); } catch { metas = []; }
    if (!metas.length) {
      packsEl.innerHTML = '<p class="ied-muted">Aún no hay packs. Ve a Descargar e importa uno.</p>';
      return;
    }
    packsEl.innerHTML = metas.map((p) => {
      const cover = p.cover || (PNG_DOWNLOAD_PACKS.find((x) => x.id === p.id)?.cover) || '';
      return `
      <button type="button" class="ied-pngdl-row" data-id="${escapeAttr(p.id)}">
        <img src="${escapeAttr(cover)}" alt="" onerror="this.style.visibility='hidden'">
        <span class="ied-pngdl-copy">
          <strong>${escapeHtml(p.name)}</strong>
          <em>${p.count || 0} imágenes · clic para abrir</em>
        </span>
        <span class="ied-pngdl-dl" aria-hidden="true">→</span>
      </button>`;
    }).join('');
    packsEl.querySelectorAll('.ied-pngdl-row').forEach((btn) => {
      btn.onclick = () => {
        catalogPackId = btn.dataset.id;
        catalogFolder = null;
        refreshPngDlViews();
      };
    });
  }

  async function refreshPngDlViews() {
    syncPngDlTabs();
    if (pngDlTab === 'packs') await renderPngDlList();
    else await renderPngCatalog();
  }

  function openPngDlModal() {
    ensurePngDlModal();
    pngDlTab = 'packs';
    catalogPackId = null;
    catalogFolder = null;
    setPngDlStatus('', false);
    syncPngDlTabs();
    refreshPngDlViews();
    showModal('iedPngDlModal', true);
  }

  let activeGamePack = null;

  function showModal(id, on) {
    const modal = $(id);
    if (!modal) return;
    modal.classList.toggle('hidden', !on);
    modal.setAttribute('aria-hidden', on ? 'false' : 'true');
  }

  function openGamesModal() {
    showModal('iedGameIconsModal', false);
    activeGamePack = null;
    const q = $('ied-games-q');
    if (q) q.value = '';
    renderGamesList();
    showModal('iedGamesModal', true);
  }

  function closeGamesModal() {
    showModal('iedGamesModal', false);
  }

  function openGameIconsModal(pack) {
    activeGamePack = pack || null;
    if (!activeGamePack) return;
    const title = $('ied-icons-title');
    if (title) title.textContent = activeGamePack.name;
    const q = $('ied-icons-q');
    if (q) q.value = '';
    showModal('iedGamesModal', false);
    renderGameIcons();
    showModal('iedGameIconsModal', true);
  }

  function closeGameIconsModal() {
    showModal('iedGameIconsModal', false);
    activeGamePack = null;
  }

  function backToGamesModal() {
    showModal('iedGameIconsModal', false);
    activeGamePack = null;
    showModal('iedGamesModal', true);
    renderGamesList();
  }

  function renderGamesList() {
    const list = $('ied-games-list');
    if (!list) return;
    const packs = typeof getEditorGamePacks === 'function' ? getEditorGamePacks() : [];
    const f = String($('ied-games-q')?.value || '').trim().toLowerCase();
    const filtered = f
      ? packs.filter((p) => p.name.toLowerCase().includes(f))
      : packs;
    if (!filtered.length) {
      list.innerHTML = '<p class="ied-muted">Sin juegos</p>';
      return;
    }
    list.innerHTML = filtered.map((p) => `
      <button type="button" class="ied-game-row" data-id="${escapeAttr(p.id)}">
        <img src="${escapeAttr(p.cover || '')}" alt="" onerror="this.style.visibility='hidden'">
        <span>${escapeHtml(p.name)}</span>
        <em class="ied-game-count">${p.items.length}</em>
      </button>
    `).join('');
    list.querySelectorAll('.ied-game-row').forEach((btn) => {
      btn.onclick = () => {
        const pack = packs.find((x) => x.id === btn.dataset.id);
        if (!pack) return;
        openGameIconsModal(pack);
      };
    });
  }

  function renderGameIcons() {
    const icons = $('ied-games-icons');
    if (!icons || !activeGamePack) return;
    const f = String($('ied-icons-q')?.value || '').trim().toLowerCase();
    const items = f
      ? activeGamePack.items.filter((it) => String(it.name || '').toLowerCase().includes(f))
      : activeGamePack.items;
    if (!items.length) {
      icons.innerHTML = '<p class="ied-muted" style="grid-column:1/-1">Sin resultados</p>';
      return;
    }
    icons.innerHTML = items.map((it, i) => `
      <button type="button" class="ied-game-ic" data-i="${i}" title="${escapeAttr(it.name)}">
        <img src="${escapeAttr(it.src)}" alt="" loading="lazy"
          data-fallback="${escapeAttr(it.srcFallback || '')}"
          onerror="if(this.dataset.fallback&&this.src!==this.dataset.fallback){this.src=this.dataset.fallback;return;} this.parentElement.style.opacity='.35'">
        <span>${escapeHtml(it.name)}</span>
      </button>
    `).join('');
    icons.querySelectorAll('.ied-game-ic').forEach((btn) => {
      btn.onclick = () => {
        const it = items[Number(btn.dataset.i)];
        if (!it) return;
        const img = btn.querySelector('img');
        const src = (img && (img.currentSrc || img.getAttribute('src'))) || it.src;
        addImageLayer(src, it.name);
        closeGameIconsModal();
        showModal('iedGamesModal', false);
        if (typeof toast === 'function') toast(`Añadido: ${it.name}`, 'ok');
      };
    });
  }

  function addTextLayer() {
    const L = {
      id: uid(),
      type: 'text',
      name: 'Texto',
      text: 'Tu texto',
      color: '#ffffff',
      fontSize: Math.round(Math.min(stageW, stageH) * 0.07),
      font: 'rubik',
      rainbow: 'off',
      motion: 'off',
      x: Math.round(stageW * 0.15),
      y: Math.round(stageH * 0.4),
      w: Math.round(stageW * 0.7),
      h: Math.round(stageH * 0.14),
    };
    layers.push(L);
    renderAll();
    selectLayer(L.id);
    pushSnapshot();
  }

  function applyTemplate(key) {
    if (!key) return;
    if (key === 'obs') {
      const sizeSel = $('ied-size');
      if (sizeSel) sizeSel.value = '1080x1080';
      stageW = 1080;
      stageH = 1080;
      const tr = $('ied-bg-transparent');
      if (tr) tr.checked = true;
      applyStageBackground();
      fitScale();
      updateGuides();
      toast && toast('Preset OBS: 1080×1080, fondo transparente', 'ok');
      return;
    }
    if (key === 'gift-menu') {
      const existingImgs = layers.filter((l) => l.type === 'image');
      if (existingImgs.length >= 4) {
        const rowY = Math.round(stageH * 0.55);
        const gap = Math.round(stageW * 0.04);
        const cellW = Math.round((stageW - gap * 5) / 4);
        existingImgs.slice(0, 4).forEach((L, i) => {
          L.w = cellW;
          L.h = cellW;
          L.x = gap + i * (cellW + gap);
          L.y = rowY;
        });
      } else {
        layers = [];
        const title = {
          id: uid(), type: 'text', name: 'Título', text: 'MENÚ DE REGALOS',
          color: '#ffffff', fontSize: Math.round(stageH * 0.06), font: 'bangers',
          rainbow: 'off', motion: 'off',
          x: Math.round(stageW * 0.1), y: Math.round(stageH * 0.08),
          w: Math.round(stageW * 0.8), h: Math.round(stageH * 0.1),
        };
        layers.push(title);
        const gap = Math.round(stageW * 0.04);
        const cellW = Math.round((stageW - gap * 5) / 4);
        const rowY = Math.round(stageH * 0.55);
        for (let i = 0; i < 4; i++) {
          const fs = Math.round(cellW * 0.35);
          layers.push({
            id: uid(), type: 'badge', name: 'Badge', text: (i + 1) + 'x',
            color: '#fff', bg: '#e91e63', fontSize: fs, font: 'bangers', motion: 'off',
            x: gap + i * (cellW + gap), y: rowY, w: cellW, h: Math.round(fs * 1.4),
          });
        }
      }
      selectedId = null;
    } else if (key === 'wins') {
      layers = [];
      selectedId = null;
      layers.push({
        id: uid(), type: 'text', name: 'Título', text: 'WINS',
        color: '#ffd700', fontSize: Math.round(stageH * 0.12), font: 'bangers',
        rainbow: 'off', motion: 'off',
        x: Math.round(stageW * 0.15), y: Math.round(stageH * 0.12),
        w: Math.round(stageW * 0.7), h: Math.round(stageH * 0.15),
      });
      const fs = Math.round(Math.min(stageW, stageH) * 0.2);
      layers.push({
        id: uid(), type: 'badge', name: 'Wins', text: '0',
        color: '#fff', bg: '#7c4dff', fontSize: fs, font: 'bangers', motion: 'pulse',
        x: Math.round((stageW - fs * 2) / 2), y: Math.round(stageH * 0.38),
        w: Math.round(fs * 2), h: Math.round(fs * 1.4),
      });
    } else if (key === 'alert') {
      layers = [];
      selectedId = null;
      layers.push({
        id: uid(), type: 'text', name: 'Alerta', text: 'ALERTA',
        color: '#ff1744', fontSize: Math.round(stageH * 0.1), font: 'bangers',
        rainbow: 'off', motion: 'shake',
        x: Math.round(stageW * 0.1), y: Math.round(stageH * 0.28),
        w: Math.round(stageW * 0.8), h: Math.round(stageH * 0.12),
      });
      layers.push({
        id: uid(), type: 'text', name: 'Subtítulo', text: '¡Nuevo evento!',
        color: '#ffffff', fontSize: Math.round(stageH * 0.05), font: 'rubik',
        rainbow: 'off', motion: 'off',
        x: Math.round(stageW * 0.1), y: Math.round(stageH * 0.45),
        w: Math.round(stageW * 0.8), h: Math.round(stageH * 0.08),
      });
    }
    renderAll();
    if (layers.length) selectLayer(layers[layers.length - 1].id);
    pushSnapshot();
    toast && toast('Plantilla aplicada', 'ok');
  }

  function loadDesignsList() {
    try {
      const raw = localStorage.getItem(DESIGNS_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch { return []; }
  }

  function saveDesignsList(list) {
    try { localStorage.setItem(DESIGNS_KEY, JSON.stringify(list)); } catch { /* ignore */ }
  }

  function refreshDesignsSelect() {
    const sel = $('ied-designs');
    if (!sel) return;
    const list = loadDesignsList();
    if (!list.length) {
      sel.innerHTML = '<option value="">Ninguno guardado aún</option>';
      return;
    }
    sel.innerHTML = '<option value="">Elegir diseño…</option>' +
      list.map((d, i) => `<option value="${i}">${escapeHtml(d.name || 'Sin nombre')}</option>`).join('');
  }

  function saveDesign() {
    const input = $('ied-design-name');
    let name = String(input?.value || '').trim();
    if (!name) {
      name = 'Diseño ' + new Date().toLocaleString();
      if (input) input.value = name;
    }
    if (!layers.length) {
      toast && toast('Añade algo al lienzo antes de guardar', 'warn');
      return;
    }
    let list = loadDesignsList();
    const design = {
      id: 'd_' + Date.now().toString(36),
      name,
      savedAt: Date.now(),
      stageW,
      stageH,
      bg: $('ied-bg')?.value || '#0b0f1a',
      bgMode,
      bgG1: $('ied-bg-g1')?.value || '#0b0f1a',
      bgG2: $('ied-bg-g2')?.value || '#1a1040',
      bgImageSrc: (bgImageSrc && String(bgImageSrc).startsWith('data:')) ? bgImageSrc : null,
      layers: layers.map(layerForSave),
    };
    // Si ya existe el mismo nombre, actualizar
    const existing = list.findIndex((d) => String(d.name || '').toLowerCase() === name.toLowerCase());
    if (existing >= 0) list[existing] = design;
    else list.push(design);
    try {
      saveDesignsList(list);
    } catch (err) {
      toast && toast('No se pudo guardar (almacenamiento lleno o bloqueado)', 'warn');
      return;
    }
    // Verificar que quedó
    const check = loadDesignsList();
    if (!check.some((d) => d.name === name)) {
      toast && toast('No se pudo guardar en este navegador', 'warn');
      return;
    }
    refreshDesignsSelect();
    const sel = $('ied-designs');
    if (sel) {
      const idx = check.findIndex((d) => d.name === name);
      if (idx >= 0) sel.value = String(idx);
    }
    toast && toast('Guardado: ' + name, 'ok');
  }

  function loadDesign() {
    const sel = $('ied-designs');
    const idx = sel && sel.value !== '' ? parseInt(sel.value, 10) : -1;
    const list = loadDesignsList();
    if (!list.length) {
      toast && toast('No hay diseños guardados. Escribe un nombre y pulsa Guardar.', 'warn');
      return;
    }
    let design = idx >= 0 ? list[idx] : null;
    if (!design) {
      toast && toast('Elige un diseño en la lista y pulsa Cargar', 'warn');
      return;
    }
    restoreState({
      layers: design.layers || [],
      stageW: design.stageW,
      stageH: design.stageH,
      bgMode: design.bgMode || 'color',
      bg: design.bg,
      bgG1: design.bgG1,
      bgG2: design.bgG2,
      bgImageSrc: design.bgImageSrc || null,
      selectedId: null,
    });
    if ($('ied-design-name')) $('ied-design-name').value = design.name || '';
    pushSnapshot();
    refreshDesignsSelect();
    if (sel) sel.value = String(Math.max(0, list.indexOf(design)));
    toast && toast('Cargado: ' + (design.name || ''), 'ok');
  }

  function deleteDesign() {
    const sel = $('ied-designs');
    const idx = sel && sel.value !== '' ? parseInt(sel.value, 10) : -1;
    let list = loadDesignsList();
    if (idx < 0 || !list[idx]) {
      toast && toast('Elige un diseño para borrar', 'warn');
      return;
    }
    const name = list[idx].name || 'Diseño';
    if (!confirm('¿Borrar "' + name + '"?')) return;
    list.splice(idx, 1);
    saveDesignsList(list);
    refreshDesignsSelect();
    if ($('ied-design-name')) $('ied-design-name').value = '';
    toast && toast('Diseño borrado', 'ok');
  }

  function isGifFile(file) {
    if (!file) return false;
    if (file.type === 'image/gif') return true;
    return /\.gif$/i.test(file.name || '');
  }

  async function addImageFromFile(file) {
    if (!file) return;
    const okType = (file.type && file.type.startsWith('image/')) || isGifFile(file);
    if (!okType) {
      toast && toast('Solo se admiten imágenes o GIF', 'warn');
      return;
    }
    const isGif = isGifFile(file);
    let gifBytes = null;
    if (isGif) {
      try { gifBytes = await file.arrayBuffer(); } catch { /* ignore */ }
    }
    const src = URL.createObjectURL(file);
    await new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const max = Math.round(Math.min(stageW, stageH) * 0.35);
        let w = img.naturalWidth || max;
        let h = img.naturalHeight || max;
        const r = Math.min(max / w, max / h, 1);
        w = Math.round(w * r);
        h = Math.round(h * r);
        const L = {
          id: uid(),
          type: 'image',
          name: file.name || (isGif ? 'GIF' : 'Imagen'),
          src,
          isGif,
          gifBytes,
          motion: 'off',
          x: Math.round((stageW - w) / 2),
          y: Math.round((stageH - h) / 2),
          w, h,
        };
        layers.push(L);
        renderAll();
        selectLayer(L.id);
        pushSnapshot();
        toast && toast(isGif ? 'GIF añadido' : 'Imagen añadida', 'ok');
        resolve();
      };
      img.onerror = () => {
        toast && toast('No se pudo cargar el archivo', 'warn');
        try { URL.revokeObjectURL(src); } catch { /* ignore */ }
        resolve();
      };
      img.src = src;
    });
  }

  async function addImagesFromFiles(fileList) {
    const files = Array.from(fileList || []).filter(Boolean);
    for (const f of files) await addImageFromFile(f);
  }

  function renderStageSelection() {
    const st = stage();
    if (!st) return;
    st.querySelectorAll('.ied-layer').forEach((el) => {
      const L = getLayer(el.dataset.id);
      el.classList.toggle('is-selected', el.dataset.id === selectedId);
      el.querySelectorAll('.ied-handle').forEach((h) => h.remove());
      if (el.dataset.id === selectedId && !L?.locked) {
        ['nw', 'ne', 'sw', 'se'].forEach((pos) => {
          const handle = document.createElement('div');
          handle.className = 'ied-handle ' + pos;
          handle.dataset.handle = pos;
          el.appendChild(handle);
        });
      }
    });
  }

  function layerListLabel(L) {
    if (L.type === 'text') return L.text || 'Texto';
    if (L.type === 'badge') return L.text || 'Badge';
    return L.name || 'Imagen';
  }

  function renderStage() {
    const st = stage();
    if (!st) return;
    applyStageBackground();
    st.querySelectorAll('.ied-layer').forEach((el) => el.remove());
    layers.forEach((L, idx) => {
      const el = document.createElement('div');
      el.className = 'ied-layer' +
        (L.id === selectedId ? ' is-selected' : '') +
        (L.locked ? ' is-locked' : '') +
        (L.type === 'badge' ? ' ied-badge-layer' : '');
      el.dataset.id = L.id;
      el.style.left = L.x + 'px';
      el.style.top = L.y + 'px';
      el.style.width = L.w + 'px';
      el.style.height = L.h + 'px';
      el.style.zIndex = String(10 + idx);

      if (L.type === 'text') {
        const t = document.createElement('div');
        const fk = fontKey(L);
        const rb = L.rainbow || 'off';
        const mot = L.motion || 'off';
        let cls = 'ied-text';
        if (fk === 'pressstart') cls += ' is-pressstart';
        if (rb === 'fixed') cls += ' ied-rb-fixed';
        else if (rb === 'move') cls += ' ied-rb-move';
        if (mot && mot !== 'off') cls += ' ied-motion-' + mot;
        if (L.shadow) cls += ' ied-text-shadow';
        t.className = cls;
        t.textContent = L.text || '';
        t.style.color = (rb === 'off') ? (L.color || '#fff') : 'transparent';
        t.style.fontSize = (L.fontSize || 48) + 'px';
        t.style.fontFamily = fontStack(L);
        t.style.fontWeight = fontWeight(L);
        const sw = L.strokeWidth || 0;
        if (sw > 0) {
          t.style.webkitTextStroke = sw + 'px ' + (L.strokeColor || '#000');
          t.style.paintOrder = 'stroke fill';
        }
        el.appendChild(t);
      } else if (L.type === 'badge') {
        const b = document.createElement('div');
        const mot = L.motion || 'off';
        b.className = 'ied-badge' + (mot && mot !== 'off' ? ' ied-motion-' + mot : '');
        b.textContent = L.text || '1x';
        b.style.color = L.color || '#fff';
        b.style.background = L.bg || '#e91e63';
        b.style.fontSize = (L.fontSize || 48) + 'px';
        b.style.fontFamily = fontStack(L);
        b.style.fontWeight = fontWeight(L);
        el.appendChild(b);
      } else {
        const wrap = document.createElement('div');
        wrap.className = 'ied-img-wrap';
        const img = document.createElement('img');
        const mot = L.motion || 'off';
        img.className = 'ied-img' + (mot && mot !== 'off' ? ' ied-motion-' + mot : '');
        img.src = L.src || '';
        img.alt = L.name || '';
        img.draggable = false;
        img.referrerPolicy = 'no-referrer';
        wrap.appendChild(img);
        if (L.label) {
          const lbl = document.createElement('div');
          lbl.className = 'ied-layer-label';
          lbl.textContent = L.label;
          wrap.appendChild(lbl);
        }
        el.appendChild(wrap);
      }

      el.addEventListener('pointerdown', onLayerPointerDown);
      st.appendChild(el);
    });
    updateGuides();
    renderStageSelection();
  }

  function reorderLayer(dragId, targetId, before) {
    if (!dragId || !targetId || dragId === targetId) return;
    const from = layers.findIndex((l) => l.id === dragId);
    const to = layers.findIndex((l) => l.id === targetId);
    if (from < 0 || to < 0) return;
    const [L] = layers.splice(from, 1);
    let insertAt = to;
    if (from < to) insertAt--;
    if (!before) insertAt++;
    layers.splice(insertAt, 0, L);
    renderAll();
    pushSnapshot();
  }

  function renderLayersList() {
    const box = $('ied-layers');
    if (!box) return;
    if (!layers.length) {
      box.innerHTML = '<p class="ied-muted">Sin capas aún</p>';
      return;
    }
    const ordered = [...layers].reverse();
    box.innerHTML = ordered.map((L) => `
      <div class="ied-layer-row ${L.id === selectedId ? 'active' : ''}${L.locked ? ' is-locked' : ''}" data-id="${L.id}" draggable="${L.locked ? 'false' : 'true'}">
        <span class="ied-lr-grip" title="Arrastrar">⠿</span>
        <span class="ied-lr-name">${escapeHtml(layerListLabel(L))}${L.locked ? ' 🔒' : ''}</span>
        <button type="button" data-act="up" title="Traer al frente">↑</button>
        <button type="button" data-act="down" title="Enviar atrás">↓</button>
        <button type="button" data-act="del" title="Eliminar" ${L.locked ? 'disabled' : ''}>✕</button>
      </div>
    `).join('');
    box.querySelectorAll('.ied-layer-row').forEach((row) => {
      const id = row.dataset.id;
      row.onclick = (e) => {
        const btn = e.target.closest('button');
        if (btn) {
          e.stopPropagation();
          const act = btn.dataset.act;
          if (act === 'del') removeLayer(id);
          else if (act === 'up') raiseLayer(id);
          else if (act === 'down') lowerLayer(id);
          return;
        }
        selectLayer(id);
      };
      row.addEventListener('dragstart', (e) => {
        if (getLayer(id)?.locked) { e.preventDefault(); return; }
        listDragId = id;
        row.classList.add('dragging');
        e.dataTransfer?.setData('text/plain', id);
        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
      });
      row.addEventListener('dragend', () => {
        row.classList.remove('dragging');
        listDragId = null;
        box.querySelectorAll('.ied-layer-row').forEach((r) => r.classList.remove('drag-over'));
      });
      row.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        row.classList.add('drag-over');
      });
      row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
      row.addEventListener('drop', (e) => {
        e.preventDefault();
        row.classList.remove('drag-over');
        const dragId = listDragId || e.dataTransfer?.getData('text/plain');
        if (!dragId) return;
        const rect = row.getBoundingClientRect();
        const before = e.clientY < rect.top + rect.height / 2;
        reorderLayer(dragId, id, before);
      });
    });
  }

  function wireLockProp(L) {
    const lockCb = $('ied-p-lock');
    if (lockCb) {
      lockCb.checked = !!L.locked;
      lockCb.onchange = () => {
        L.locked = lockCb.checked;
        renderStage();
        renderLayersList();
        pushSnapshot();
      };
    }
  }

  function renderProps() {
    const box = $('ied-props');
    if (!box) return;
    const L = getLayer(selectedId);
    if (!L) {
      box.innerHTML = '<p class="ied-muted">Selecciona una capa</p>';
      return;
    }
    const lockField = `
        <label class="ied-toggle">
          <input type="checkbox" id="ied-p-lock" ${L.locked ? 'checked' : ''}>
          <span class="ied-toggle-ui" aria-hidden="true"></span>
          <span class="ied-toggle-label">Bloquear capa</span>
        </label>`;
    const actions = `
        <div class="ied-prop-actions">
          <button type="button" class="btn ghost" id="ied-p-front">Al frente</button>
          <button type="button" class="btn ghost" id="ied-p-back">Atrás</button>
          <button type="button" class="btn danger" id="ied-p-del" ${L.locked ? 'disabled' : ''}>Borrar</button>
        </div>`;

    if (L.type === 'text') {
      box.innerHTML = `
        <label class="ied-field">Texto
          <textarea id="ied-p-text" rows="3">${escapeHtml(L.text || '')}</textarea>
        </label>
        <label class="ied-field">Fuente
          <select id="ied-p-font">
            ${EDITOR_FONTS.map(([v, label]) => `<option value="${v}">${escapeHtml(label)}</option>`).join('')}
          </select>
        </label>
        <label class="ied-field">Color
          <input type="color" id="ied-p-color" value="${escapeAttr(L.color || '#ffffff')}">
        </label>
        <label class="ied-field">Tamaño de fuente
          <input type="number" id="ied-p-fs" min="8" max="400" value="${L.fontSize || 48}">
        </label>
        <label class="ied-field">Borde (px)
          <input type="number" id="ied-p-stroke-w" min="0" max="20" value="${L.strokeWidth || 0}">
        </label>
        <label class="ied-field">Color borde
          <input type="color" id="ied-p-stroke-c" value="${escapeAttr(L.strokeColor || '#000000')}">
        </label>
        <label class="ied-toggle">
          <input type="checkbox" id="ied-p-shadow" ${L.shadow ? 'checked' : ''}>
          <span class="ied-toggle-ui" aria-hidden="true"></span>
          <span class="ied-toggle-label">Sombra</span>
        </label>
        <label class="ied-field">Arcoíris
          <select id="ied-p-rainbow">
            <option value="off">Apagado</option>
            <option value="fixed">Arcoíris fijo</option>
            <option value="move">Arcoíris animado</option>
          </select>
        </label>
        <label class="ied-field">Movimiento
          <select id="ied-p-motion">${motionSelectOptions()}</select>
        </label>
        ${lockField}
        <p class="ied-muted" style="margin:0">Al redimensionar el rectángulo, la fuente se ajusta sola.</p>
        ${actions}`;
      $('ied-p-font').value = fontKey(L);
      $('ied-p-rainbow').value = L.rainbow || 'off';
      $('ied-p-motion').value = L.motion || 'off';
      $('ied-p-text').oninput = () => { L.text = $('ied-p-text').value; L.name = 'Texto'; renderStage(); renderLayersList(); };
      $('ied-p-text').onchange = () => pushSnapshot();
      $('ied-p-color').oninput = () => { L.color = $('ied-p-color').value; renderStage(); };
      $('ied-p-color').onchange = () => pushSnapshot();
      $('ied-p-fs').onchange = () => { L.fontSize = Math.max(8, parseInt($('ied-p-fs').value, 10) || 48); renderStage(); pushSnapshot(); };
      $('ied-p-stroke-w').onchange = () => { L.strokeWidth = Math.max(0, parseInt($('ied-p-stroke-w').value, 10) || 0); renderStage(); pushSnapshot(); };
      $('ied-p-stroke-c').onchange = () => { L.strokeColor = $('ied-p-stroke-c').value; renderStage(); pushSnapshot(); };
      $('ied-p-shadow').onchange = () => { L.shadow = $('ied-p-shadow').checked; renderStage(); pushSnapshot(); };
      $('ied-p-font').onchange = () => { L.font = $('ied-p-font').value; delete L.fontFamily; renderStage(); pushSnapshot(); };
      $('ied-p-rainbow').onchange = () => { L.rainbow = $('ied-p-rainbow').value; renderStage(); pushSnapshot(); };
      $('ied-p-motion').onchange = () => { L.motion = $('ied-p-motion').value; renderStage(); pushSnapshot(); };
    } else if (L.type === 'badge') {
      box.innerHTML = `
        <label class="ied-field">Texto badge
          <input type="text" id="ied-p-badge-text" value="${escapeAttr(L.text || '1x')}">
        </label>
        <label class="ied-field">Color texto
          <input type="color" id="ied-p-color" value="${escapeAttr(L.color || '#ffffff')}">
        </label>
        <label class="ied-field">Fondo
          <input type="color" id="ied-p-bg" value="${escapeAttr(L.bg || '#e91e63')}">
        </label>
        <label class="ied-field">Tamaño fuente
          <input type="number" id="ied-p-fs" min="8" max="400" value="${L.fontSize || 48}">
        </label>
        <label class="ied-field">Movimiento
          <select id="ied-p-motion">${motionSelectOptions()}</select>
        </label>
        ${lockField}
        ${actions}`;
      $('ied-p-motion').value = L.motion || 'off';
      $('ied-p-badge-text').oninput = () => { L.text = $('ied-p-badge-text').value; renderStage(); renderLayersList(); };
      $('ied-p-badge-text').onchange = () => pushSnapshot();
      $('ied-p-color').onchange = () => { L.color = $('ied-p-color').value; renderStage(); pushSnapshot(); };
      $('ied-p-bg').onchange = () => { L.bg = $('ied-p-bg').value; renderStage(); pushSnapshot(); };
      $('ied-p-fs').onchange = () => { L.fontSize = Math.max(8, parseInt($('ied-p-fs').value, 10) || 48); renderStage(); pushSnapshot(); };
      $('ied-p-motion').onchange = () => { L.motion = $('ied-p-motion').value; renderStage(); pushSnapshot(); };
    } else {
      box.innerHTML = `
        <label class="ied-field">Nombre
          <input type="text" id="ied-p-name" value="${escapeAttr(L.name || '')}">
        </label>
        <label class="ied-field">Etiqueta (bajo imagen)
          <input type="text" id="ied-p-label" value="${escapeAttr(L.label || '')}" placeholder="Nombre o 1x">
        </label>
        <label class="ied-field">Movimiento
          <select id="ied-p-motion">${motionSelectOptions()}</select>
        </label>
        <label class="ied-field">Ancho
          <input type="number" id="ied-p-w" min="20" max="${stageW}" value="${L.w}">
        </label>
        <label class="ied-field">Alto
          <input type="number" id="ied-p-h" min="20" max="${stageH}" value="${L.h}">
        </label>
        ${lockField}
        ${actions}`;
      $('ied-p-motion').value = L.motion || 'off';
      $('ied-p-name').oninput = () => { L.name = $('ied-p-name').value; renderLayersList(); };
      $('ied-p-name').onchange = () => pushSnapshot();
      $('ied-p-label').oninput = () => { L.label = $('ied-p-label').value; renderStage(); };
      $('ied-p-label').onchange = () => pushSnapshot();
      $('ied-p-motion').onchange = () => { L.motion = $('ied-p-motion').value; renderStage(); pushSnapshot(); };
      $('ied-p-w').onchange = () => { L.w = clamp(parseInt($('ied-p-w').value, 10) || L.w, 20, stageW); renderStage(); pushSnapshot(); };
      $('ied-p-h').onchange = () => { L.h = clamp(parseInt($('ied-p-h').value, 10) || L.h, 20, stageH); renderStage(); pushSnapshot(); };
    }
    wireLockProp(L);
    const frontBtn = $('ied-p-front');
    const backBtn = $('ied-p-back');
    const delBtn = $('ied-p-del');
    if (frontBtn) frontBtn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); bringToFront(L.id); };
    if (backBtn) backBtn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); sendToBack(L.id); };
    if (delBtn) delBtn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); removeLayer(L.id); };
  }

  function renderAll() {
    renderStage();
    renderLayersList();
    renderProps();
  }

  function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

  function stagePointFromEvent(e) {
    const st = stage();
    const rect = st.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) / scale,
      y: (e.clientY - rect.top) / scale,
    };
  }

  function onLayerPointerDown(e) {
    if (e.button != null && e.button !== 0) return;
    const el = e.currentTarget;
    const id = el.dataset.id;
    const L = getLayer(id);
    if (!L) return;
    if (L.locked) return;
    selectLayer(id);
    const handle = e.target.closest?.('.ied-handle');
    const p = stagePointFromEvent(e);
    drag = {
      id,
      mode: handle ? ('resize-' + handle.dataset.handle) : 'move',
      startX: p.x,
      startY: p.y,
      orig: { x: L.x, y: L.y, w: L.w, h: L.h, fontSize: L.fontSize || 48 },
      moved: false,
    };
    el.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  }

  function onPointerMove(e) {
    if (!drag) return;
    const L = getLayer(drag.id);
    if (!L) return;
    const p = stagePointFromEvent(e);
    const dx = p.x - drag.startX;
    const dy = p.y - drag.startY;
    const o = drag.orig;

    if (drag.mode === 'move') {
      L.x = snapVal(clamp(o.x + dx, -L.w + 20, stageW - 20));
      L.y = snapVal(clamp(o.y + dy, -L.h + 20, stageH - 20));
    } else {
      let x = o.x, y = o.y, w = o.w, h = o.h;
      const m = drag.mode.replace('resize-', '');
      if (m.includes('e')) w = o.w + dx;
      if (m.includes('s')) h = o.h + dy;
      if (m.includes('w')) { w = o.w - dx; x = o.x + dx; }
      if (m.includes('n')) { h = o.h - dy; y = o.y + dy; }
      w = clamp(w, 24, stageW * 1.5);
      h = clamp(h, 24, stageH * 1.5);
      L.x = snapVal(x);
      L.y = snapVal(y);
      L.w = snapVal(w);
      L.h = snapVal(h);
      if (L.type === 'text' && o.w > 0 && o.h > 0) {
        const scaleF = Math.min(L.w / o.w, L.h / o.h);
        L.fontSize = clamp(Math.round(o.fontSize * scaleF), 8, 400);
      }
    }
    if (Math.abs(dx) > 1 || Math.abs(dy) > 1) drag.moved = true;
    const el = stage()?.querySelector(`.ied-layer[data-id="${L.id}"]`);
    if (el) {
      el.style.left = L.x + 'px';
      el.style.top = L.y + 'px';
      el.style.width = L.w + 'px';
      el.style.height = L.h + 'px';
      if (L.type === 'text') {
        const t = el.querySelector('.ied-text');
        if (t) t.style.fontSize = (L.fontSize || 48) + 'px';
      }
    }
  }

  function onPointerUp() {
    if (!drag) return;
    if (drag.moved) pushSnapshot();
    drag = null;
    renderProps();
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = proxiedSrc(src);
    });
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => { try { URL.revokeObjectURL(url); } catch { /* ignore */ } }, 1500);
  }

  function rainbowColors() {
    return ['#ff1744', '#ff9100', '#ffea00', '#00e676', '#00b0ff', '#e040fb'];
  }

  function motionOffset(L, tMs) {
    const mot = L.motion || 'off';
    if (mot === 'off') return { dx: 0, dy: 0, scale: 1, rot: 0 };
    const t = (tMs || 0) / 1000;
    if (mot === 'float') {
      return { dx: 0, dy: Math.sin(t * Math.PI * 2 / 2.6) * (L.h * 0.08), scale: 1, rot: 0 };
    }
    if (mot === 'bounce') {
      const p = (t % 1.1) / 1.1;
      const up = p < 0.4 ? (p / 0.4) : p < 0.6 ? 1 - ((p - 0.4) / 0.2) * 0.45 : 0.55 * (1 - (p - 0.6) / 0.4);
      return { dx: 0, dy: -up * (L.h * 0.12), scale: 1, rot: 0 };
    }
    if (mot === 'pulse') {
      const s = 1 + Math.sin(t * Math.PI * 2 / 1.4) * 0.08;
      return { dx: 0, dy: 0, scale: s, rot: 0 };
    }
    if (mot === 'shake') {
      return {
        dx: Math.sin(t * Math.PI * 2 / 0.55) * (L.w * 0.02),
        dy: 0,
        scale: 1,
        rot: Math.sin(t * Math.PI * 2 / 0.55) * 0.04,
      };
    }
    return { dx: 0, dy: 0, scale: 1, rot: 0 };
  }

  function drawTextLayer(ctx, L, tMs) {
    ctx.save();
    const fs = L.fontSize || 48;
    const lines = String(L.text || '').split('\n');
    const lineH = fs * (fontKey(L) === 'pressstart' ? 1.35 : 1.15);
    const cx0 = L.x + L.w / 2;
    const cy0 = L.y + L.h / 2;
    const mot = motionOffset(L, tMs);
    ctx.translate(cx0 + mot.dx, cy0 + mot.dy);
    ctx.rotate(mot.rot);
    ctx.scale(mot.scale, mot.scale);
    ctx.font = `${fontWeight(L)} ${fs}px ${fontStack(L)}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const baseY = -((lines.length - 1) * lineH) / 2;
    const rb = L.rainbow || 'off';
    const sw = L.strokeWidth || 0;
    const strokeCol = L.strokeColor || '#000';

    if (L.shadow) {
      ctx.shadowColor = 'rgba(0,0,0,0.55)';
      ctx.shadowBlur = Math.max(4, fs * 0.08);
      ctx.shadowOffsetX = Math.max(2, fs * 0.04);
      ctx.shadowOffsetY = Math.max(2, fs * 0.04);
    }

    lines.forEach((line, i) => {
      const y = baseY + i * lineH;
      if (rb === 'off') {
        if (sw > 0) {
          ctx.strokeStyle = strokeCol;
          ctx.lineWidth = sw * 2;
          ctx.lineJoin = 'round';
          ctx.strokeText(line, 0, y, L.w);
        }
        ctx.fillStyle = L.color || '#fff';
        ctx.fillText(line, 0, y, L.w);
        return;
      }
      const colors = rainbowColors();
      const shift = rb === 'move' ? Math.floor(((tMs || 0) / 90) % colors.length) : 0;
      let totalW = 0;
      const widths = [];
      for (const ch of line) {
        const w = ctx.measureText(ch).width;
        widths.push(w);
        totalW += w;
      }
      let x = -totalW / 2;
      for (let ci = 0; ci < line.length; ci++) {
        const ch = line[ci];
        const cx = x + widths[ci] / 2;
        if (sw > 0) {
          ctx.strokeStyle = strokeCol;
          ctx.lineWidth = sw * 2;
          ctx.strokeText(ch, cx, y);
        }
        ctx.fillStyle = colors[(ci + shift) % colors.length];
        ctx.fillText(ch, cx, y);
        x += widths[ci];
      }
    });
    ctx.restore();
  }

  function drawBadgeLayer(ctx, L, tMs) {
    ctx.save();
    const mot = motionOffset(L, tMs);
    const cx = L.x + L.w / 2 + mot.dx;
    const cy = L.y + L.h / 2 + mot.dy;
    ctx.translate(cx, cy);
    ctx.rotate(mot.rot);
    ctx.scale(mot.scale, mot.scale);
    const fs = L.fontSize || 48;
    const padX = fs * 0.35;
    const padY = fs * 0.2;
    const text = String(L.text || '1x');
    ctx.font = `${fontWeight(L)} ${fs}px ${fontStack(L)}`;
    const tw = ctx.measureText(text).width;
    const bw = Math.max(L.w, tw + padX * 2);
    const bh = Math.max(L.h, fs + padY * 2);
    const rx = -bw / 2;
    const ry = -bh / 2;
    const r = Math.min(bh / 2, fs * 0.35);
    ctx.fillStyle = L.bg || '#e91e63';
    ctx.beginPath();
    if (ctx.roundRect) {
      ctx.roundRect(rx, ry, bw, bh, r);
    } else {
      ctx.rect(rx, ry, bw, bh);
    }
    ctx.fill();
    ctx.fillStyle = L.color || '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 0, 0);
    ctx.restore();
  }

  function drawImageLabel(ctx, L) {
    if (!L.label) return;
    ctx.save();
    const fs = Math.max(12, Math.round(L.w * 0.12));
    ctx.font = `700 ${fs}px ${FONT_STACKS.rubik}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = 'rgba(0,0,0,0.7)';
    ctx.lineWidth = Math.max(2, fs * 0.12);
    const tx = L.x + L.w / 2;
    const ty = L.y + L.h + 4;
    ctx.strokeText(L.label, tx, ty, L.w);
    ctx.fillText(L.label, tx, ty, L.w);
    ctx.restore();
  }

  async function fillStageBackground(ctx, forceTransparent, bgImg) {
    const transparent = forceTransparent === true || !!$('ied-bg-transparent')?.checked;
    if (transparent) {
      ctx.clearRect(0, 0, stageW, stageH);
      return;
    }
    if (bgMode === 'gradient') {
      const g1 = $('ied-bg-g1')?.value || '#0b0f1a';
      const g2 = $('ied-bg-g2')?.value || '#1a1040';
      const grd = ctx.createLinearGradient(0, 0, stageW, stageH);
      grd.addColorStop(0, g1);
      grd.addColorStop(1, g2);
      ctx.fillStyle = grd;
      ctx.fillRect(0, 0, stageW, stageH);
      return;
    }
    if (bgMode === 'image' && bgImg) {
      try {
        ctx.drawImage(bgImg, 0, 0, stageW, stageH);
      } catch {
        ctx.fillStyle = $('ied-bg')?.value || '#0b0f1a';
        ctx.fillRect(0, 0, stageW, stageH);
      }
      return;
    }
    ctx.fillStyle = $('ied-bg')?.value || '#0b0f1a';
    ctx.fillRect(0, 0, stageW, stageH);
  }

  async function prepareStaticSources() {
    const map = new Map();
    await Promise.all(layers.map(async (L) => {
      if (L.type === 'text' || L.type === 'badge' || !L.src) return;
      try {
        map.set(L.id, await loadImage(L.src));
      } catch { /* omitida */ }
    }));
    return map;
  }

  async function loadBgImage() {
    if (bgMode !== 'image' || !bgImageSrc) return null;
    try { return await loadImage(bgImageSrc); } catch { return null; }
  }

  function exportScaleFactor() {
    const v = parseFloat($('ied-export-scale')?.value || '1');
    return (v > 0 && v <= 1) ? v : 1;
  }

  async function paintComposition(ctx, sourceMap, tMs, forceTransparent, bgImg) {
    await fillStageBackground(ctx, forceTransparent, bgImg);
    for (const L of layers) {
      if (L.type === 'text') {
        drawTextLayer(ctx, L, tMs || 0);
        continue;
      }
      if (L.type === 'badge') {
        drawBadgeLayer(ctx, L, tMs || 0);
        continue;
      }
      const img = sourceMap.get(L.id);
      if (!img) continue;
      try {
        const mot = motionOffset(L, tMs || 0);
        if (mot.dx || mot.dy || mot.scale !== 1 || mot.rot) {
          ctx.save();
          const cx = L.x + L.w / 2;
          const cy = L.y + L.h / 2;
          ctx.translate(cx + mot.dx, cy + mot.dy);
          ctx.rotate(mot.rot);
          ctx.scale(mot.scale, mot.scale);
          ctx.drawImage(img, -L.w / 2, -L.h / 2, L.w, L.h);
          ctx.restore();
        } else {
          ctx.drawImage(img, L.x, L.y, L.w, L.h);
        }
        drawImageLabel(ctx, L);
      } catch { /* ignore */ }
    }
  }

  let gifToolsPromise = null;
  function loadGifTools() {
    if (!gifToolsPromise) {
      gifToolsPromise = Promise.all([
        import('/js/lib/gifenc.esm.js'),
        import('/js/lib/gifuct.esm.js'),
      ]).then(([enc, decMod]) => {
        const dec = decMod.default || decMod;
        return {
          GIFEncoder: enc.GIFEncoder,
          quantize: enc.quantize,
          applyPalette: enc.applyPalette,
          parseGIF: dec.parseGIF,
          decompressFrames: dec.decompressFrames,
        };
      });
    }
    return gifToolsPromise;
  }

  /** Expande un GIF a fotogramas completos (canvas + delay ms). */
  function expandGifFrames(tools, arrayBuffer) {
    const gif = tools.parseGIF(arrayBuffer);
    const frames = tools.decompressFrames(gif, true);
    if (!frames.length) return [];
    const w = gif.lsd.width;
    const h = gif.lsd.height;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    const temp = document.createElement('canvas');
    const out = [];
    let prevDisposal = 0;
    let saved = null;

    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i];
      if (i === 0) ctx.clearRect(0, 0, w, h);
      else if (prevDisposal === 2) ctx.clearRect(0, 0, w, h);
      else if (prevDisposal === 3 && saved) ctx.putImageData(saved, 0, 0);

      if (frame.disposalType === 3) saved = ctx.getImageData(0, 0, w, h);

      temp.width = frame.dims.width;
      temp.height = frame.dims.height;
      const tctx = temp.getContext('2d');
      const imageData = tctx.createImageData(frame.dims.width, frame.dims.height);
      imageData.data.set(frame.patch);
      tctx.putImageData(imageData, 0, 0);
      ctx.drawImage(temp, frame.dims.left, frame.dims.top);

      const snap = document.createElement('canvas');
      snap.width = w;
      snap.height = h;
      snap.getContext('2d').drawImage(canvas, 0, 0);
      out.push({ canvas: snap, delay: Math.max(20, frame.delay || 100) });
      prevDisposal = frame.disposalType;
    }
    return out;
  }

  function frameAtTime(frames, tMs) {
    if (!frames?.length) return null;
    const total = frames.reduce((s, f) => s + f.delay, 0) || 1;
    let t = ((tMs % total) + total) % total;
    for (const f of frames) {
      if (t < f.delay) return f.canvas;
      t -= f.delay;
    }
    return frames[frames.length - 1].canvas;
  }

  async function waitFonts() {
    try { if (document.fonts?.ready) await document.fonts.ready; } catch { /* ignore */ }
  }

  async function renderExportCanvas(tMs, forceTransparent) {
    const sf = exportScaleFactor();
    const w = Math.round(stageW * sf);
    const h = Math.round(stageH * sf);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (sf !== 1) ctx.scale(sf, sf);
    await waitFonts();
    const sources = await prepareStaticSources();
    const bgImg = await loadBgImage();
    await paintComposition(ctx, sources, tMs, forceTransparent, bgImg);
    return canvas;
  }

  async function exportPng() {
    try {
      const canvas = await renderExportCanvas(0, false);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('blob');
      downloadBlob(blob, 'livecoins-editor-' + Date.now() + '.png');
      toast && toast('PNG descargado', 'ok');
    } catch {
      toast && toast('No se pudo exportar PNG. Prueba con imágenes/GIF subidos.', 'warn');
    }
  }

  async function copyToClipboard() {
    try {
      const canvas = await renderExportCanvas(0, false);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('blob');
      if (!navigator.clipboard?.write) throw new Error('clipboard');
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      toast && toast('PNG copiado al portapapeles', 'ok');
    } catch {
      toast && toast('No se pudo copiar (permiso o navegador)', 'warn');
    }
  }

  async function exportGif() {
    if (!layers.length) {
      toast && toast('Añade algo al lienzo primero', 'warn');
      return;
    }
    toast && toast('Generando GIF…', 'ok');
    try {
      await waitFonts();
      const tools = await loadGifTools();
      const staticMap = await prepareStaticSources();
      const bgImg = await loadBgImage();
      const animMap = new Map();
      let maxLoop = 0;

      for (const L of layers) {
        if (!L.isGif || !L.gifBytes) continue;
        try {
          const frames = expandGifFrames(tools, L.gifBytes);
          if (!frames.length) continue;
          animMap.set(L.id, frames);
          const total = frames.reduce((s, f) => s + f.delay, 0);
          if (total > maxLoop) maxLoop = total;
        } catch {
          // usa imagen estática
        }
      }

      const sf = exportScaleFactor();
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(stageW * sf);
      canvas.height = Math.round(stageH * sf);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (sf !== 1) ctx.scale(sf, sf);

      const textAnim = layers.some(layerNeedsGifAnim);
      const timeline = [];
      if (!animMap.size && !textAnim) {
        timeline.push({ t: 0, delay: 100 });
      } else if (!animMap.size && textAnim) {
        const step = 90;
        const duration = 4500;
        for (let t = 0; t < duration; t += step) timeline.push({ t, delay: step });
      } else {
        const duration = Math.min(Math.max(maxLoop, textAnim ? 4500 : 100), 6000);
        let primary = null;
        let primaryTotal = 0;
        animMap.forEach((frames) => {
          const total = frames.reduce((s, f) => s + f.delay, 0);
          if (total >= primaryTotal) {
            primaryTotal = total;
            primary = frames;
          }
        });
        if (animMap.size === 1 && primary && !textAnim) {
          let t = 0;
          for (const f of primary) {
            if (t >= duration) break;
            timeline.push({ t, delay: f.delay });
            t += f.delay;
          }
        } else {
          const step = 80;
          for (let t = 0; t < duration; t += step) {
            timeline.push({ t, delay: step });
          }
        }
        if (timeline.length > 80) timeline.length = 80;
      }

      const gif = tools.GIFEncoder();
      let first = true;
      for (const slot of timeline) {
        const sourceMap = new Map(staticMap);
        animMap.forEach((frames, id) => {
          const c = frameAtTime(frames, slot.t);
          if (c) sourceMap.set(id, c);
        });
        await paintComposition(ctx, sourceMap, slot.t, true, bgImg);
        const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const format = 'rgba4444';
        const palette = tools.quantize(data, 256, {
          format,
          oneBitAlpha: true,
          clearAlpha: true,
          clearAlphaThreshold: 10,
          clearAlphaColor: 0x00,
        });
        const index = tools.applyPalette(data, palette, format);
        let transparentIndex = -1;
        for (let pi = 0; pi < palette.length; pi++) {
          const c = palette[pi];
          if (c && c.length >= 4 && c[3] < 128) {
            transparentIndex = pi;
            break;
          }
        }
        // Si no hubo píxeles transparentes en la paleta, fuerza uno
        if (transparentIndex < 0) {
          if (palette.length < 256) {
            palette.push([0, 0, 0, 0]);
            transparentIndex = palette.length - 1;
          } else {
            palette[0] = [0, 0, 0, 0];
            transparentIndex = 0;
          }
        }
        gif.writeFrame(index, canvas.width, canvas.height, {
          palette,
          delay: slot.delay,
          repeat: 0,
          first,
          dispose: 2,
          transparent: true,
          transparentIndex,
        });
        first = false;
      }
      gif.finish();
      const bytes = gif.bytes();
      downloadBlob(new Blob([bytes], { type: 'image/gif' }), 'livecoins-editor-' + Date.now() + '.gif');
      toast && toast('GIF descargado', 'ok');
    } catch (err) {
      console.error(err);
      toast && toast('No se pudo generar el GIF', 'warn');
    }
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }
  function escapeAttr(s) { return escapeHtml(s).replace(/\n/g, ' '); }

  function wire() {
    if (wired) return;
    wired = true;

    $('ied-add-gift')?.addEventListener('click', async () => {
      if (typeof openGiftModalCb === 'function') {
        await openGiftModalCb((g) => addGiftLayer(g));
      } else if (typeof toast === 'function') {
        toast('Catálogo de regalos no disponible aún', 'warn');
      }
    });

    $('ied-add-text')?.addEventListener('click', () => addTextLayer());
    $('ied-add-icon')?.addEventListener('click', () => $('ied-icon-file')?.click());
    $('ied-icon-file')?.addEventListener('change', (e) => {
      const list = e.target.files;
      if (list && list.length) addImagesFromFiles(list).catch(() => {});
      e.target.value = '';
    });

    $('ied-add-games')?.addEventListener('click', () => openGamesModal());
    $('ied-add-badge')?.addEventListener('click', () => addBadgeLayer());
    $('ied-add-sticker')?.addEventListener('click', () => openStickersModal());
    $('ied-dl-png')?.addEventListener('click', () => openPngDlModal());
    $('ied-games-close')?.addEventListener('click', () => closeGamesModal());
    $('ied-icons-close')?.addEventListener('click', () => closeGameIconsModal());
    $('ied-games-back')?.addEventListener('click', () => backToGamesModal());
    $('iedGamesModal')?.addEventListener('click', (e) => {
      if (e.target?.id === 'iedGamesModal') closeGamesModal();
    });
    $('iedGameIconsModal')?.addEventListener('click', (e) => {
      if (e.target?.id === 'iedGameIconsModal') closeGameIconsModal();
    });
    $('ied-games-q')?.addEventListener('input', () => renderGamesList());
    $('ied-icons-q')?.addEventListener('input', () => renderGameIcons());

    $('ied-size')?.addEventListener('change', () => { applyStageSize(); pushSnapshot(); });
    $('ied-bg-mode')?.addEventListener('change', () => {
      syncBgModeUi();
      applyStageBackground();
      pushSnapshot();
    });
    $('ied-bg')?.addEventListener('input', () => { applyStageBackground(); });
    $('ied-bg')?.addEventListener('change', () => pushSnapshot());
    $('ied-bg-g1')?.addEventListener('input', () => { if (bgMode === 'gradient') applyStageBackground(); });
    $('ied-bg-g1')?.addEventListener('change', () => pushSnapshot());
    $('ied-bg-g2')?.addEventListener('input', () => { if (bgMode === 'gradient') applyStageBackground(); });
    $('ied-bg-g2')?.addEventListener('change', () => pushSnapshot());
    $('ied-bg-pick')?.addEventListener('click', () => $('ied-bg-file')?.click());
    $('ied-bg-file')?.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try { if (bgImageSrc?.startsWith('blob:')) URL.revokeObjectURL(bgImageSrc); } catch { /* ignore */ }
      bgImageSrc = URL.createObjectURL(file);
      bgMode = 'image';
      const modeSel = $('ied-bg-mode');
      if (modeSel) modeSel.value = 'image';
      syncBgModeUi();
      applyStageBackground();
      pushSnapshot();
      e.target.value = '';
    });

    $('ied-tpl-apply')?.addEventListener('click', () => {
      const key = $('ied-template')?.value;
      if (!key) { toast && toast('Elige una plantilla', 'warn'); return; }
      applyTemplate(key);
    });
    $('ied-save-design')?.addEventListener('click', () => saveDesign());
    $('ied-load-design')?.addEventListener('click', () => loadDesign());
    $('ied-del-design')?.addEventListener('click', () => deleteDesign());
    $('ied-designs')?.addEventListener('change', () => {
      const sel = $('ied-designs');
      const idx = sel && sel.value !== '' ? parseInt(sel.value, 10) : -1;
      const list = loadDesignsList();
      if (idx >= 0 && list[idx] && $('ied-design-name')) {
        $('ied-design-name').value = list[idx].name || '';
      }
    });
    $('ied-design-name')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        saveDesign();
      }
    });
    refreshDesignsSelect();

    $('ied-export')?.addEventListener('click', () => { exportPng().catch(() => {}); });
    $('ied-export-gif')?.addEventListener('click', () => { exportGif().catch(() => {}); });
    $('ied-copy')?.addEventListener('click', () => { copyToClipboard().catch(() => {}); });
    $('ied-clear')?.addEventListener('click', () => {
      if (!layers.length) return;
      if (!confirm('¿Limpiar todas las capas del lienzo?')) return;
      layers = [];
      selectedId = null;
      renderAll();
      pushSnapshot();
    });

    $('ied-zoom-in')?.addEventListener('click', () => zoomIn());
    $('ied-zoom-out')?.addEventListener('click', () => zoomOut());
    $('ied-zoom-fit')?.addEventListener('click', () => zoomFit());
    $('ied-undo')?.addEventListener('click', () => undo());
    $('ied-redo')?.addEventListener('click', () => redo());
    $('ied-dup')?.addEventListener('click', () => duplicateLayer());

    $('ied-align-center')?.addEventListener('click', () => alignSelectedCenter());
    $('ied-align-h')?.addEventListener('click', () => alignSelectedH());
    $('ied-align-v')?.addEventListener('click', () => alignSelectedV());

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);

    stage()?.addEventListener('pointerdown', (e) => {
      if (e.target === stage() || e.target?.classList?.contains('ied-guides') || e.target?.closest?.('.ied-guides')) {
        selectLayer(null);
      }
    });

    $('ied-grid')?.addEventListener('change', () => updateGuides());
    $('ied-center-guides')?.addEventListener('change', () => updateGuides());
    $('ied-align-row')?.addEventListener('click', () => alignRow());
    $('ied-equal-size')?.addEventListener('click', () => equalSize());
    $('ied-distribute')?.addEventListener('click', () => distributeH());

    document.addEventListener('keydown', (e) => {
      if (!$('view-editor')?.classList.contains('active')) return;
      const tag = (e.target && e.target.tagName) || '';
      const inField = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
        return;
      }
      if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) {
        e.preventDefault();
        redo();
        return;
      }
      if (mod && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        duplicateLayer();
        return;
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId && !inField) {
        const L = getLayer(selectedId);
        if (L?.locked) return;
        e.preventDefault();
        removeLayer(selectedId);
      }
    });

    window.addEventListener('resize', () => fitScale());
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => fitScale()) : null;
    if (ro && viewport()) ro.observe(viewport());
  }

  window.initImageEditorView = function initImageEditorView() {
    wire();
    syncBgModeUi();
    refreshDesignsSelect();
    const sel = $('ied-size')?.value || '1080x1080';
    const [w, h] = sel.split('x').map(Number);
    stageW = w || 1080;
    stageH = h || 1080;
    const st = stage();
    if (st) {
      st.style.width = stageW + 'px';
      st.style.height = stageH + 'px';
    }
    applyStageBackground();
    stripFrameLayers();
    renderAll();
    history = [];
    historyIndex = -1;
    pushSnapshot();
    updateUndoRedoUi();
    requestAnimationFrame(fitScale);
  };

  function openEditorViewShell() {
    document.querySelectorAll('.nav-item').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
    const view = $('view-editor');
    if (view) view.classList.add('active');
    const navBtn = document.querySelector('.nav-item[data-view="editor"]');
    if (navBtn) navBtn.classList.add('active');
    wire();
    syncBgModeUi();
    refreshDesignsSelect();
  }

  function prepareEditorStage(w, h) {
    let sw = Math.max(1, Math.round(w) || 1080);
    let sh = Math.max(1, Math.round(h) || 1080);
    const maxSide = 4096;
    if (sw > maxSide || sh > maxSide) {
      const r = Math.min(maxSide / sw, maxSide / sh);
      sw = Math.max(1, Math.round(sw * r));
      sh = Math.max(1, Math.round(sh * r));
    }
    stageW = sw;
    stageH = sh;
    const sizeSel = $('ied-size');
    if (sizeSel) {
      const key = `${sw}x${sh}`;
      let opt = Array.from(sizeSel.options).find((o) => o.value === key);
      if (!opt) {
        opt = document.createElement('option');
        opt.value = key;
        opt.textContent = `Importado ${sw}×${sh}`;
        sizeSel.appendChild(opt);
      }
      sizeSel.value = key;
    }
    const tr = $('ied-bg-transparent');
    if (tr) tr.checked = true;
    bgMode = 'color';
    const bgModeSel = $('ied-bg-mode');
    if (bgModeSel) bgModeSel.value = 'color';
    syncBgModeUi();
    const st = stage();
    if (st) {
      st.style.width = stageW + 'px';
      st.style.height = stageH + 'px';
    }
    applyStageBackground();
    return { sw, sh };
  }

  function finishEditorImport(selectId) {
    history = [];
    historyIndex = -1;
    renderAll();
    if (selectId) selectLayer(selectId);
    else if (layers.length) selectLayer(layers[layers.length - 1].id);
    pushSnapshot();
    updateUndoRedoUi();
    requestAnimationFrame(fitScale);
  }

  /** Abre la pestaña Editor e importa un PNG/URL generado (overlays planos, etc.). */
  window.importGeneratedImageToEditor = async function importGeneratedImageToEditor(src, opts = {}) {
    if (!src) return false;
    const name = String(opts.name || 'Overlay generado').replace(/\.png$/i, '') || 'Overlay generado';
    try {
      openEditorViewShell();
      const img = await new Promise((resolve, reject) => {
        const im = new Image();
        im.crossOrigin = 'anonymous';
        im.onload = () => resolve(im);
        im.onerror = () => reject(new Error('load'));
        im.src = proxiedSrc(src);
      });
      const w = img.naturalWidth || img.width || 1080;
      const h = img.naturalHeight || img.height || 1080;
      prepareEditorStage(w, h);
      layers = [];
      selectedId = null;
      const L = {
        id: uid(),
        type: 'image',
        name,
        src: proxiedSrc(src),
        motion: 'off',
        label: '',
        x: 0,
        y: 0,
        w: stageW,
        h: stageH,
      };
      layers.push(L);
      finishEditorImport(L.id);
      toast && toast('Imagen abierta en el Editor. Edítala y exporta cuando quieras.', 'ok');
      return true;
    } catch (e) {
      console.error('importGeneratedImageToEditor', e);
      toast && toast('No se pudo abrir la imagen en el Editor.', 'err');
      return false;
    }
  };

  /**
   * Abre el Editor con capas separadas (acción, regalo, badge, texto…).
   * payload: { width, height, layers: [{ type, name, src?, text?, x, y, w, h, ... }], name? }
   */
  window.importOverlayLayersToEditor = async function importOverlayLayersToEditor(payload = {}) {
    const list = Array.isArray(payload.layers) ? payload.layers.filter(Boolean) : [];
    if (!list.length) {
      toast && toast('No hay elementos para importar al Editor.', 'warn');
      return false;
    }
    try {
      openEditorViewShell();
      prepareEditorStage(payload.width || 1080, payload.height || 1080);
      layers = [];
      selectedId = null;
      for (const raw of list) {
        const type = raw.type || (raw.src ? 'image' : 'text');
        const id = uid();
        if (type === 'badge') {
          layers.push({
            id,
            type: 'badge',
            name: raw.name || 'Cantidad',
            text: String(raw.text || 'x1'),
            color: raw.color || '#ffffff',
            bg: raw.bg || '#e91e63',
            fontSize: Math.max(12, Math.round(raw.fontSize || 22)),
            font: raw.font || 'rubik',
            motion: 'off',
            x: Math.round(raw.x || 0),
            y: Math.round(raw.y || 0),
            w: Math.max(20, Math.round(raw.w || 60)),
            h: Math.max(16, Math.round(raw.h || 32)),
          });
          continue;
        }
        if (type === 'text') {
          layers.push({
            id,
            type: 'text',
            name: raw.name || 'Texto',
            text: String(raw.text || ''),
            color: raw.color || '#ffffff',
            fontSize: Math.max(12, Math.round(raw.fontSize || 28)),
            font: raw.font || 'system',
            rainbow: 'off',
            motion: 'off',
            strokeWidth: raw.strokeWidth || 0,
            strokeColor: raw.strokeColor || '#000',
            x: Math.round(raw.x || 0),
            y: Math.round(raw.y || 0),
            w: Math.max(20, Math.round(raw.w || 80)),
            h: Math.max(20, Math.round(raw.h || 40)),
          });
          continue;
        }
        if (!raw.src) continue;
        layers.push({
          id,
          type: 'image',
          name: raw.name || 'Imagen',
          src: proxiedSrc(raw.src),
          motion: 'off',
          label: raw.label || '',
          x: Math.round(raw.x || 0),
          y: Math.round(raw.y || 0),
          w: Math.max(8, Math.round(raw.w || 64)),
          h: Math.max(8, Math.round(raw.h || 64)),
        });
      }
      if (!layers.length) {
        toast && toast('No se pudieron crear capas en el Editor.', 'warn');
        return false;
      }
      finishEditorImport(layers[layers.length - 1].id);
      toast && toast(`Overlay en el Editor: ${layers.length} capas editables.`, 'ok');
      return true;
    } catch (e) {
      console.error('importOverlayLayersToEditor', e);
      toast && toast('No se pudo abrir el overlay en el Editor.', 'err');
      return false;
    }
  };
})();
