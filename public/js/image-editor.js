/* Editor de imágenes ligero para Livecoins (capas DOM + export canvas). */
(function () {
  const $ = (id) => document.getElementById(id);

  let wired = false;
  let layers = []; // { id, type, x, y, w, h, src?, name?, text?, color?, fontSize?, font?, rainbow?, motion?, locked?, label?, strokeWidth?, strokeColor?, shadow?, bg? }
  let selectedId = null; // capa primaria (props / handles)
  let selectedIds = []; // selección múltiple (incluye selectedId)
  let stageW = 1080;
  let stageH = 1080;
  let scale = 1;
  let userZoom = null;
  let drag = null;
  let marquee = null; // { startX, startY, curX, curY, additive, moved }
  let listDragId = null;
  let bgMode = 'color';
  let bgImageSrc = null;
  let sliceMode = false;
  let sliceDrag = null; // { layerId, startX, startY, curX, curY }
  let layerClipboard = []; // capas copiadas (deep clone sin id vivo)
  let ctxPasteAt = null; // { x, y } en coords del stage para pegar
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

  /** blob: muere al recargar; hay que persistir data: (o URL http/proxy). */
  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result || ''));
      fr.onerror = () => reject(fr.error || new Error('no se pudo leer el archivo'));
      fr.readAsDataURL(file);
    });
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result || ''));
      fr.onerror = () => reject(fr.error || new Error('no se pudo convertir la imagen'));
      fr.readAsDataURL(blob);
    });
  }

  async function persistableSrc(src) {
    const s = String(src || '');
    if (!s || s.startsWith('data:') || s.startsWith('/') || /^https?:\/\//i.test(s)) return s;
    if (!s.startsWith('blob:')) return s;
    try {
      const res = await fetch(s);
      const blob = await res.blob();
      return await blobToDataUrl(blob);
    } catch {
      return s;
    }
  }

  function layerForSave(L) {
    // JSON.stringify pierde ArrayBuffer; serializar gifBytes a array de bytes.
    const gifBytes = L && L.gifBytes;
    const base = { ...L, gifBytes: undefined };
    const o = deepCloneLayer(base);
    if (gifBytes) {
      try {
        const u8 = gifBytes instanceof ArrayBuffer
          ? new Uint8Array(gifBytes)
          : new Uint8Array(gifBytes);
        if (u8.byteLength > 512000) delete o.gifBytes;
        else o.gifBytes = Array.from(u8);
      } catch { /* ignore */ }
    }
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
      selectedIds: selectedIds.slice(),
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
    const validIds = (snap.selectedIds || (snap.selectedId ? [snap.selectedId] : []))
      .filter((id) => layers.some((l) => l.id === id));
    selectedIds = validIds;
    selectedId = (snap.selectedId && validIds.includes(snap.selectedId))
      ? snap.selectedId
      : (validIds.length ? validIds[validIds.length - 1] : (layers.length ? layers[layers.length - 1].id : null));
    if (selectedId && !selectedIds.includes(selectedId)) selectedIds = [selectedId];
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
    const ids = selectedIds.length ? selectedIds : (selectedId ? [selectedId] : []);
    if (!ids.length) { toast && toast('Selecciona una capa', 'warn'); return; }
    ids.forEach((id) => {
      const L = getLayer(id);
      if (!L || L.locked) return;
      L.x = snapVal((stageW - L.w) / 2);
      L.y = snapVal((stageH - L.h) / 2);
    });
    renderAll();
    pushSnapshot();
    toast && toast(ids.length > 1 ? 'Centradas' : 'Centrado', 'ok');
  }

  function alignSelectedH() {
    const ids = selectedIds.length ? selectedIds : (selectedId ? [selectedId] : []);
    if (!ids.length) { toast && toast('Selecciona una capa', 'warn'); return; }
    ids.forEach((id) => {
      const L = getLayer(id);
      if (!L || L.locked) return;
      L.x = snapVal((stageW - L.w) / 2);
    });
    renderAll();
    pushSnapshot();
    toast && toast('Centro horizontal', 'ok');
  }

  function alignSelectedV() {
    const ids = selectedIds.length ? selectedIds : (selectedId ? [selectedId] : []);
    if (!ids.length) { toast && toast('Selecciona una capa', 'warn'); return; }
    ids.forEach((id) => {
      const L = getLayer(id);
      if (!L || L.locked) return;
      L.y = snapVal((stageH - L.h) / 2);
    });
    renderAll();
    pushSnapshot();
    toast && toast('Centro vertical', 'ok');
  }

  function duplicateLayer(id) {
    const ids = id
      ? [id]
      : (selectedIds.length ? selectedIds.slice() : (selectedId ? [selectedId] : []));
    if (!ids.length) { toast && toast('Selecciona una capa', 'warn'); return; }
    const created = [];
    ids.forEach((sid) => {
      const src = getLayer(sid);
      if (!src) return;
      const L = deepCloneLayer(src);
      L.id = uid();
      L.x = snapVal((src.x || 0) + 20);
      L.y = snapVal((src.y || 0) + 20);
      L.locked = false;
      layers.push(L);
      created.push(L.id);
    });
    if (!created.length) return;
    renderAll();
    setSelection(created, created[created.length - 1]);
    pushSnapshot();
    toast && toast(created.length > 1 ? (created.length + ' capas duplicadas') : 'Capa duplicada', 'ok');
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

  /** Alinea las seleccionadas al mismo Y que la capa de referencia (clic derecho). */
  function alignSelectedToLevel(refId) {
    const ref = getLayer(refId) || getLayer(selectedId);
    if (!ref) { toast && toast('Selecciona una capa', 'warn'); return; }
    let ids = selectedIds.length ? selectedIds.slice() : [ref.id];
    if (!ids.includes(ref.id)) ids = [...ids, ref.id];
    if (ids.length < 2) {
      toast && toast('Selecciona al menos 2 capas para alinear', 'warn');
      return;
    }
    const y = snapVal(ref.y);
    let n = 0;
    ids.forEach((id) => {
      const L = getLayer(id);
      if (!L || L.locked) return;
      L.y = y;
      n++;
    });
    if (!n) return;
    renderAll();
    pushSnapshot();
    updateGroupSelectionBox();
    toast && toast('Alineadas al mismo nivel', 'ok');
  }

  /** Todas las seleccionadas toman el tamaño de la capa de referencia (clic derecho). */
  function matchSelectedSizeTo(refId) {
    const ref = getLayer(refId) || getLayer(selectedId);
    if (!ref) { toast && toast('Selecciona una capa de referencia', 'warn'); return; }
    let ids = selectedIds.length ? selectedIds.slice() : [ref.id];
    if (!ids.includes(ref.id)) ids = [...ids, ref.id];
    if (ids.length < 2) {
      toast && toast('Selecciona al menos 2 capas', 'warn');
      return;
    }
    const w = snapVal(ref.w);
    const h = snapVal(ref.h);
    const scaleFont = (ref.fontSize || 48);
    let n = 0;
    ids.forEach((id) => {
      if (id === ref.id) return;
      const L = getLayer(id);
      if (!L || L.locked) return;
      const oldW = Math.max(1, L.w);
      const oldH = Math.max(1, L.h);
      L.w = w;
      L.h = h;
      if (L.type === 'text' || L.type === 'badge') {
        const s = Math.min(w / oldW, h / oldH);
        L.fontSize = clamp(Math.round((L.fontSize || scaleFont) * s), 8, 400);
      }
      n++;
    });
    if (!n) { toast && toast('No hay otras capas para igualar', 'warn'); return; }
    renderAll();
    pushSnapshot();
    updateGroupSelectionBox();
    toast && toast('Mismo tamaño aplicado', 'ok');
  }

  function copySelectedLayers() {
    const ids = selectedIds.length ? selectedIds.slice() : (selectedId ? [selectedId] : []);
    if (!ids.length) { toast && toast('Selecciona algo para copiar', 'warn'); return false; }
    layerClipboard = ids.map((id) => getLayer(id)).filter(Boolean).map((L) => {
      const c = deepCloneLayer(layerForSave(L));
      delete c.id;
      return c;
    });
    if (!layerClipboard.length) return false;
    toast && toast(layerClipboard.length > 1 ? (layerClipboard.length + ' capas copiadas') : 'Capa copiada', 'ok');
    return true;
  }

  function pasteClipboardLayers(at) {
    if (!layerClipboard.length) { toast && toast('Nada en el portapapeles', 'warn'); return; }
    let minX = Infinity;
    let minY = Infinity;
    layerClipboard.forEach((L) => {
      minX = Math.min(minX, L.x || 0);
      minY = Math.min(minY, L.y || 0);
    });
    if (!Number.isFinite(minX)) minX = 0;
    if (!Number.isFinite(minY)) minY = 0;
    const dx = at && Number.isFinite(at.x) ? (at.x - minX) : 24;
    const dy = at && Number.isFinite(at.y) ? (at.y - minY) : 24;
    const created = [];
    layerClipboard.forEach((raw) => {
      const L = deepCloneLayer(raw);
      L.id = uid();
      L.x = snapVal((raw.x || 0) + dx);
      L.y = snapVal((raw.y || 0) + dy);
      L.locked = false;
      if (L.gifBytes && !(L.gifBytes instanceof ArrayBuffer)) {
        try {
          const u8 = new Uint8Array(L.gifBytes);
          L.gifBytes = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
        } catch { delete L.gifBytes; }
      }
      layers.push(L);
      created.push(L.id);
    });
    renderAll();
    setSelection(created, created[created.length - 1]);
    pushSnapshot();
    toast && toast(created.length > 1 ? (created.length + ' capas pegadas') : 'Capa pegada', 'ok');
  }

  function hideContextMenu() {
    document.getElementById('ied-ctx-menu')?.remove();
    ctxPasteAt = null;
  }

  function showContextMenu(clientX, clientY, refId, opts) {
    hideContextMenu();
    opts = opts || {};
    const onLayer = !!refId && !!getLayer(refId);
    const hasSel = selectedIds.length > 0 || !!selectedId;
    const hasClip = layerClipboard.length > 0;

    const menu = document.createElement('div');
    menu.id = 'ied-ctx-menu';
    menu.className = 'ied-ctx-menu';
    menu.setAttribute('role', 'menu');

    const nSel = selectedIds.length;
    const items = [];
    if (onLayer || nSel >= 2) {
      items.push({
        id: 'align',
        label: nSel >= 2 ? `Alinear las ${nSel} al mismo nivel` : 'Alinear al mismo nivel',
        enabled: nSel >= 2,
      });
      items.push({
        id: 'size',
        label: nSel >= 2 ? `Mismo tamaño en las ${nSel} (como esta)` : 'Mismo tamaño que esta',
        enabled: nSel >= 2,
      });
      items.push({ sep: true });
    }
    items.push({
      id: 'copy',
      label: nSel > 1 ? `Copiar las ${nSel}` : 'Copiar',
      enabled: hasSel || onLayer,
      shortcut: 'Ctrl+C',
    });
    items.push({ id: 'paste', label: 'Pegar', enabled: hasClip, shortcut: 'Ctrl+V' });
    items.push({ sep: true });
    items.push({
      id: 'delete',
      label: nSel > 1 ? `Borrar las ${nSel}` : 'Borrar',
      enabled: hasSel || onLayer,
      danger: true,
    });

    menu.innerHTML = items.map((it) => {
      if (it.sep) return '<div class="ied-ctx-sep"></div>';
      const dis = it.enabled === false ? ' disabled' : '';
      const danger = it.danger ? ' is-danger' : '';
      const tip = it.shortcut ? `<span class="ied-ctx-kbd">${it.shortcut}</span>` : '';
      return `<button type="button" class="ied-ctx-item${danger}${dis}" data-act="${it.id}" ${it.enabled === false ? 'disabled' : ''}><span>${it.label}</span>${tip}</button>`;
    }).join('');

    document.body.appendChild(menu);
    const pad = 8;
    const mw = menu.offsetWidth;
    const mh = menu.offsetHeight;
    let left = clientX;
    let top = clientY;
    if (left + mw > window.innerWidth - pad) left = window.innerWidth - mw - pad;
    if (top + mh > window.innerHeight - pad) top = window.innerHeight - mh - pad;
    menu.style.left = Math.max(pad, left) + 'px';
    menu.style.top = Math.max(pad, top) + 'px';

    menu.addEventListener('pointerdown', (e) => e.stopPropagation());
    menu.querySelectorAll('.ied-ctx-item').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const act = btn.dataset.act;
        const pastePt = ctxPasteAt;
        hideContextMenu();
        if (act === 'align') alignSelectedToLevel(refId);
        else if (act === 'size') matchSelectedSizeTo(refId);
        else if (act === 'copy') {
          if (onLayer && !isSelected(refId)) selectLayer(refId);
          copySelectedLayers();
        } else if (act === 'paste') pasteClipboardLayers(pastePt);
        else if (act === 'delete') removeSelectedLayers();
      });
    });
  }

  function onLayerContextMenu(e) {
    e.preventDefault();
    e.stopPropagation();
    if (sliceMode) return;
    const id = e.currentTarget?.dataset?.id;
    const L = getLayer(id);
    if (!L) return;
    if (!isSelected(id)) selectLayer(id);
    else {
      selectedId = id;
      renderLayersList();
      renderProps();
      renderStageSelection();
    }
    const p = stagePointFromEvent(e);
    ctxPasteAt = { x: p.x, y: p.y };
    showContextMenu(e.clientX, e.clientY, id);
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

  function isSelected(id) {
    return !!id && selectedIds.includes(id);
  }

  function setSelection(ids, primary) {
    const seen = new Set();
    const next = [];
    (ids || []).forEach((id) => {
      if (!id || seen.has(id) || !getLayer(id)) return;
      seen.add(id);
      next.push(id);
    });
    selectedIds = next;
    if (primary && selectedIds.includes(primary)) selectedId = primary;
    else selectedId = selectedIds.length ? selectedIds[selectedIds.length - 1] : null;
    renderLayersList();
    renderProps();
    renderStageSelection();
  }

  /** @param {string|null} id @param {{ add?: boolean, toggle?: boolean, keepMulti?: boolean }=} opts */
  function selectLayer(id, opts) {
    opts = opts || {};
    if (!id) {
      setSelection([]);
      return;
    }
    if (!getLayer(id)) return;
    if (opts.toggle) {
      if (isSelected(id)) setSelection(selectedIds.filter((x) => x !== id));
      else setSelection([...selectedIds, id], id);
      return;
    }
    if (opts.add) {
      if (!isSelected(id)) setSelection([...selectedIds, id], id);
      else setSelection(selectedIds, id);
      return;
    }
    if (opts.keepMulti && isSelected(id) && selectedIds.length > 1) {
      selectedId = id;
      renderLayersList();
      renderProps();
      renderStageSelection();
      return;
    }
    setSelection([id], id);
  }

  function getLayer(id) {
    return layers.find((l) => l.id === id);
  }

  function focusSingleInSelection(id) {
    if (!id) return;
    selectedId = id;
    if (!selectedIds.includes(id)) selectedIds = [id];
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
    focusSingleInSelection(id);
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
    focusSingleInSelection(id);
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
    focusSingleInSelection(id);
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
    focusSingleInSelection(id);
    renderAll();
    pushSnapshot();
  }

  function removeLayer(id) {
    const L = getLayer(id);
    if (L?.locked) { toast && toast('Capa bloqueada', 'warn'); return; }
    layers = layers.filter((l) => l.id !== id);
    selectedIds = selectedIds.filter((x) => x !== id && getLayer(x));
    if (selectedId === id) {
      selectedId = selectedIds.length
        ? selectedIds[selectedIds.length - 1]
        : (layers.length ? layers[layers.length - 1].id : null);
    }
    if (selectedId && !selectedIds.includes(selectedId) && getLayer(selectedId)) {
      selectedIds = [selectedId];
    }
    if (!selectedId) selectedIds = [];
    renderAll();
    pushSnapshot();
  }

  function removeSelectedLayers() {
    const ids = selectedIds.length ? selectedIds.slice() : (selectedId ? [selectedId] : []);
    if (!ids.length) return;
    let removed = 0;
    ids.forEach((id) => {
      const L = getLayer(id);
      if (!L || L.locked) return;
      layers = layers.filter((l) => l.id !== id);
      removed++;
    });
    selectedIds = [];
    selectedId = layers.length ? layers[layers.length - 1].id : null;
    if (selectedId) selectedIds = [selectedId];
    renderAll();
    if (removed) pushSnapshot();
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
    selectedIds = selectedIds.filter((id) => getLayer(id));
    if (selectedId && !selectedIds.includes(selectedId)) {
      selectedIds = selectedId ? [selectedId] : [];
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
    {
      id: 'mario',
      name: 'Mario',
      desc: 'Pack de iconos PNG',
      cover: '/img/mari0-card.png',
      url: 'https://github.com/paleteriadeyellow-tech/exe/releases/download/logos/mari0.zip',
      fileName: 'mari0.zip',
    },
    {
      id: 'minecraftcubo',
      name: 'Minecraft Cubo',
      desc: 'Pack de iconos PNG',
      cover: '/img/bedrock-card.jpg',
      url: 'https://github.com/paleteriadeyellow-tech/exe/releases/download/logos/minecraftCubo.zip',
      fileName: 'minecraftCubo.zip',
    },
    {
      id: 'minecraftsandbox',
      name: 'Minecraft SandBox',
      desc: 'Pack de iconos PNG',
      cover: '/img/sandbox-card.jpg',
      url: 'https://github.com/paleteriadeyellow-tech/exe/releases/download/logos/minecraftSandBox.zip',
      fileName: 'minecraftSandBox.zip',
    },
    {
      id: 'gtavsurvival',
      name: 'GTA V Survival',
      desc: 'Pack de iconos PNG',
      cover: '/img/gtavkoth-card.png',
      url: 'https://github.com/paleteriadeyellow-tech/exe/releases/download/logos/gtavSurvival.zip',
      fileName: 'gtavSurvival.zip',
    },
    {
      id: 'pvzavengerszombies',
      name: 'PvZ Avengers Zombies',
      desc: 'Pack de iconos PNG',
      cover: '/img/pvzhybrid-card.jpg',
      url: 'https://github.com/paleteriadeyellow-tech/exe/releases/download/logos/pvzAvengersZombies.zip',
      fileName: 'pvzAvengersZombies.zip',
    },
    {
      id: 'pvzextras',
      name: 'PvZ Extras',
      desc: 'Pack de iconos PNG',
      cover: '/img/plantasvszombies-card.jpg',
      url: 'https://github.com/paleteriadeyellow-tech/exe/releases/download/logos/pvzExtras.zip',
      fileName: 'pvzExtras.zip',
    },
    {
      id: 'pvzfusionplantas',
      name: 'PvZ Fusion Plantas',
      desc: 'Pack de iconos PNG',
      cover: '/img/pvzhybrid-card.jpg',
      url: 'https://github.com/paleteriadeyellow-tech/exe/releases/download/logos/pvzFusionPlantas.zip',
      fileName: 'pvzFusionPlantas.zip',
    },
    {
      id: 'pvzfusionzombies',
      name: 'PvZ Fusion Zombies',
      desc: 'Pack de iconos PNG',
      cover: '/img/pvzhybrid-card.jpg',
      url: 'https://github.com/paleteriadeyellow-tech/exe/releases/download/logos/pvzFusionZombies.zip',
      fileName: 'pvzFusionZombies.zip',
    },
    {
      id: 'pvzhybridplantas',
      name: 'PvZ Hybrid Plantas',
      desc: 'Pack de iconos PNG',
      cover: '/img/pvzhybrid-card.jpg',
      url: 'https://github.com/paleteriadeyellow-tech/exe/releases/download/logos/pvzHybridPlantas.zip',
      fileName: 'pvzHybridPlantas.zip',
    },
    {
      id: 'pvzhybridzombies',
      name: 'PvZ Hybrid Zombies',
      desc: 'Pack de iconos PNG',
      cover: '/img/pvzhybrid-card.jpg',
      url: 'https://github.com/paleteriadeyellow-tech/exe/releases/download/logos/pvzHybridZombies.zip',
      fileName: 'pvzHybridZombies.zip',
    },
    {
      id: 'pvznarutoplantas',
      name: 'PvZ Naruto Plantas',
      desc: 'Pack de iconos PNG',
      cover: '/img/pvzhybrid-card.jpg',
      url: 'https://github.com/paleteriadeyellow-tech/exe/releases/download/logos/pvzNarutoPlantas.zip',
      fileName: 'pvzNarutoPlantas.zip',
    },
    {
      id: 'pvznarutozombies',
      name: 'PvZ Naruto Zombies',
      desc: 'Pack de iconos PNG',
      cover: '/img/pvzhybrid-card.jpg',
      url: 'https://github.com/paleteriadeyellow-tech/exe/releases/download/logos/pvzNarutoZombies.zip',
      fileName: 'pvzNarutoZombies.zip',
    },
    {
      id: 'pvzplantas',
      name: 'PvZ Plantas',
      desc: 'Pack de iconos PNG',
      cover: '/img/plantasvszombies-card.jpg',
      url: 'https://github.com/paleteriadeyellow-tech/exe/releases/download/logos/pvzPlantas.zip',
      fileName: 'pvzPlantas.zip',
    },
    {
      id: 'pvzzombies',
      name: 'PvZ Zombies',
      desc: 'Pack de iconos PNG',
      cover: '/img/plantasvszombies-card.jpg',
      url: 'https://github.com/paleteriadeyellow-tech/exe/releases/download/logos/pvzZombies.zip',
      fileName: 'pvzZombies.zip',
    },
    {
      id: 'repo',
      name: 'R.E.P.O.',
      desc: 'Pack de iconos PNG',
      cover: '/img/repo-card.jpg',
      url: 'https://github.com/paleteriadeyellow-tech/exe/releases/download/logos/repo.zip',
      fileName: 'repo.zip',
    },
    {
      id: 're2',
      name: 'RE2',
      desc: 'Pack de iconos PNG',
      cover: '/img/re2-card.png',
      url: 'https://github.com/paleteriadeyellow-tech/exe/releases/download/logos/re2.zip',
      fileName: 're2.zip',
    },
    {
      id: 'rdr2',
      name: 'RDR2',
      desc: 'Pack de iconos PNG',
      cover: '/img/rdr2-card.png',
      url: 'https://github.com/paleteriadeyellow-tech/exe/releases/download/logos/rdr2.zip',
      fileName: 'rdr2.zip',
    },
    {
      id: 'left4dead',
      name: 'Left 4 Dead',
      desc: 'Pack de iconos PNG',
      cover: '/img/l4d2-card.png',
      url: 'https://github.com/paleteriadeyellow-tech/exe/releases/download/logos/lesfor.rar',
      fileName: 'lesfor.rar',
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

  const PACK_ROOT_SKIP = /^(geometrydash|gdash|mari0|mario|minecraftcubo|minecraftsandbox|minecraft|cubo|sandbox|bedrock|pvz|plantasvszombies|repo|re2|rdr2|left4dead|l4d|l4d2|images?|pngs?|icons?|assets?|img)$/i;

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

  async function savePackFromEntries(pack, fileEntries) {
    if (!fileEntries?.length) throw new Error('empty');
    await clearPack(pack.id).catch(() => {});

    const db = await openPackDb();
    const selected = fileEntries.slice(0, 250);
    let saved = 0;
    const folderSet = new Set();
    for (const ent of selected) {
      const relativePath = String(ent.relativePath || ent.name || '');
      let blob = ent.blob;
      if (!blob && ent.base64) {
        const bin = atob(ent.base64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        blob = new Blob([bytes], { type: ent.mime || 'image/png' });
      }
      if (!blob || blob.size < 32 || blob.size > 3 * 1024 * 1024) continue;
      const base = (relativePath.split('/').pop() || '').replace(PACK_IMG_EXT, '');
      let folder = zipFolderFromPath(relativePath);
      if (!folder && pack.id === 'geometrydash') folder = folderFromGdashCatalog(base);
      if (!folder) folder = 'General';
      folderSet.add(folder);
      const mime = ent.mime
        || (/\.gif$/i.test(relativePath) ? 'image/gif'
          : /\.webp$/i.test(relativePath) ? 'image/webp'
            : /\.jpe?g$/i.test(relativePath) ? 'image/jpeg'
              : 'image/png');
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
    const mapped = [];
    for (const { relativePath, file } of entries.slice(0, 250)) {
      const blob = await file.async('blob');
      mapped.push({ relativePath, blob });
    }
    return savePackFromEntries(pack, mapped);
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
    if (r.status === 413) throw new Error('too_large');
    if (!r.ok) {
      // fallback directo (por si el proxy no está en una build vieja)
      r = await fetch(pack.url);
    }
    if (!r.ok) throw new Error('fetch');
    return r.arrayBuffer();
  }

  function isPackRar(pack) {
    return /\.rar(\?|$)/i.test(String(pack?.url || ''))
      || /\.rar$/i.test(String(pack?.fileName || ''));
  }

  function ensurePngDlModal() {
    let modal = $('iedPngDlModal');
    // Recrear si es layout viejo (sin v2 / pestañas)
    if (modal && (!modal.classList.contains('ied-pngdl-v3') || !$('ied-pngdl-packs-view') || !$('ied-pngdl-catalog-view') || !$('ied-pngdl-tabs'))) {
      try { modal.remove(); } catch { /* ignore */ }
      modal = null;
    }
    if (modal) return modal;
    modal = document.createElement('div');
    modal.id = 'iedPngDlModal';
    modal.className = 'modal hidden ied-pngdl-modal ied-pngdl-v3';
    modal.setAttribute('aria-hidden', 'true');
    modal.innerHTML = `
      <div class="modal-box ied-pngdl-box">
        <div class="modal-head ied-pngdl-head">
          <div class="ied-pngdl-head-text">
            <h2>Descargar PNG</h2>
            <p class="ied-pngdl-sub">Elige un pack para descargar o abrir sus iconos</p>
          </div>
          <button type="button" class="modal-close" id="ied-pngdl-close" aria-label="Cerrar">✕</button>
        </div>
        <div class="modal-body ied-pngdl-body">
          <div class="ied-pngdl-seg" id="ied-pngdl-tabs" role="tablist">
            <button type="button" class="ied-pngdl-tab is-active" data-tab="packs" role="tab" aria-selected="true">Descargar</button>
            <button type="button" class="ied-pngdl-tab" data-tab="catalog" role="tab" aria-selected="false">Catálogo</button>
          </div>
          <p class="ied-muted ied-pngdl-hint" id="ied-pngdl-hint">Descargas online · no forman parte del instalador.</p>
          <div id="ied-pngdl-packs-view">
            <div class="ied-pngdl-list" id="ied-pngdl-list"></div>
            <p class="ied-muted ied-pngdl-status" id="ied-pngdl-status" hidden></p>
          </div>
          <div id="ied-pngdl-catalog-view" hidden>
            <button type="button" class="ied-pngdl-back" id="ied-pngdl-back" hidden title="Volver">← Volver</button>
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
      catalogPackId = null;
      catalogFolder = null;
      refreshPngDlViews();
    });
    return modal;
  }

  function syncPngDlTabs() {
    document.querySelectorAll('#iedPngDlModal .ied-pngdl-tab').forEach((b) => {
      const on = b.dataset.tab === pngDlTab;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    const packsView = $('ied-pngdl-packs-view');
    const catView = $('ied-pngdl-catalog-view');
    if (packsView) packsView.hidden = pngDlTab !== 'packs';
    if (catView) catView.hidden = pngDlTab !== 'catalog';
    const hint = $('ied-pngdl-hint');
    if (hint) {
      hint.textContent = pngDlTab === 'catalog'
        ? 'Packs guardados en tu PC. Ábre uno para ver todas sus imágenes.'
        : 'Descargas online · no forman parte del instalador.';
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
      let n = 0;
      if (isPackRar(pack)) {
        if (!window.desktopAPI?.packImportArchive) throw new Error('rar_desktop_only');
        setPngDlStatus('Extrayendo RAR…', true);
        const r = await window.desktopAPI.packImportArchive(pack.url);
        if (!r?.ok) throw new Error(r?.error || 'rar');
        setPngDlStatus('Guardando imágenes…', true);
        n = await savePackFromEntries(pack, r.files || []);
      } else {
        const buf = await fetchPackZip(pack);
        setPngDlStatus('Extrayendo imágenes…', true);
        n = await savePackFromZip(pack, buf);
      }
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
      const msg = String(e?.message || e);
      if (msg === 'too_large') toast && toast('El pack es demasiado grande para descargar.', 'err');
      else if (msg === 'empty') toast && toast('El archivo no tiene imágenes PNG/JPG/GIF/WebP usables.', 'err');
      else if (msg === 'rar_desktop_only') toast && toast('Los packs .rar solo se importan en la app PC (.exe).', 'warn');
      else toast && toast('No se pudo importar el pack. Revisa tu conexión.', 'err');
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
    list.innerHTML = PNG_DOWNLOAD_PACKS.map((p) => {
      const installed = have.has(p.id);
      return `
      <button type="button" class="ied-pngdl-row${installed ? ' is-installed' : ''}" data-id="${escapeAttr(p.id)}">
        <span class="ied-pngdl-thumb">
          <img src="${escapeAttr(p.cover || '')}" alt="" onerror="this.style.opacity='0'">
        </span>
        <span class="ied-pngdl-copy">
          <strong>${escapeHtml(p.name)}</strong>
          <em>${installed ? 'Ya en catálogo · clic para actualizar' : escapeHtml(p.desc || 'Pack de iconos PNG')}</em>
        </span>
        <span class="ied-pngdl-action ${installed ? 'is-refresh' : ''}" aria-hidden="true">${installed ? '↻' : '↓'}</span>
      </button>`;
    }).join('');
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

    // Pack abierto → todas sus imágenes (sin carpetas intermedias)
    if (catalogPackId) {
      packsEl.hidden = true;
      iconsEl.hidden = false;
      if (back) back.hidden = false;
      let imgs = [];
      try { imgs = await listPackImages(catalogPackId); } catch { imgs = []; }
      if (!imgs.length) {
        iconsEl.innerHTML = '<p class="ied-muted" style="grid-column:1/-1">Sin imágenes en este pack.</p>';
        return;
      }
      const urls = await Promise.all(imgs.map((im) => blobUrlForPackImage(im)));
      iconsEl.innerHTML = imgs.map((im, i) => `
        <button type="button" class="ied-pngdl-ic" data-i="${i}" title="${escapeAttr(im.name)}">
          <img src="${escapeAttr(urls[i])}" alt="" loading="lazy">
          <span>${escapeHtml(im.name)}</span>
        </button>
      `).join('');
      iconsEl.querySelectorAll('.ied-pngdl-ic').forEach((btn) => {
        btn.onclick = () => {
          const im = imgs[Number(btn.dataset.i)];
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
        <span class="ied-pngdl-thumb">
          <img src="${escapeAttr(cover)}" alt="" onerror="this.style.opacity='0'">
        </span>
        <span class="ied-pngdl-copy">
          <strong>${escapeHtml(p.name)}</strong>
          <em>${p.count || 0} imágenes · clic para abrir</em>
        </span>
        <span class="ied-pngdl-action is-open" aria-hidden="true">→</span>
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
      selectedIds = [];
    } else if (key === 'wins') {
      layers = [];
      selectedId = null;
      selectedIds = [];
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
      selectedIds = [];
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

  async function saveDesign() {
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
    toast && toast('Guardando imágenes…', 'ok');
    // Convertir blob: temporales a data: para que sobrevivan a Cargar / recargar.
    const persistLayers = [];
    for (const L of layers) {
      const o = layerForSave(L);
      if (o.src && String(o.src).startsWith('blob:')) {
        const data = await persistableSrc(o.src);
        o.src = data;
        if (data && data.startsWith('data:')) L.src = data;
      }
      persistLayers.push(o);
    }
    let bgPersist = bgImageSrc || null;
    if (bgPersist && String(bgPersist).startsWith('blob:')) {
      bgPersist = await persistableSrc(bgPersist);
      if (bgPersist && bgPersist.startsWith('data:')) bgImageSrc = bgPersist;
    }
    if (bgPersist && !String(bgPersist).startsWith('data:')) bgPersist = null;

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
      bgImageSrc: bgPersist,
      layers: persistLayers,
    };
    // Si ya existe el mismo nombre, actualizar
    const existing = list.findIndex((d) => String(d.name || '').toLowerCase() === name.toLowerCase());
    if (existing >= 0) list[existing] = design;
    else list.push(design);
    try {
      saveDesignsList(list);
    } catch (err) {
      toast && toast('No se pudo guardar (imágenes muy pesadas o almacenamiento lleno). Prueba PNGs más pequeños.', 'warn');
      return;
    }
    // Verificar que quedó
    const check = loadDesignsList();
    if (!check.some((d) => d.name === name)) {
      toast && toast('No se pudo guardar en este navegador (cuota llena)', 'warn');
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
    const broken = (design.layers || []).filter((L) => L && L.src && String(L.src).startsWith('blob:')).length;
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
    if (broken) {
      toast && toast(
        'Cargado, pero ' + broken + ' imagen(es) subidas se perdieron (guardado antiguo). Vuelve a añadirlas y pulsa Guardar.',
        'warn'
      );
    } else {
      toast && toast('Cargado: ' + (design.name || ''), 'ok');
    }
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
    let src;
    try {
      src = await fileToDataUrl(file);
    } catch {
      toast && toast('No se pudo leer el archivo', 'warn');
      return;
    }
    if (!src) {
      toast && toast('No se pudo leer el archivo', 'warn');
      return;
    }
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
        resolve();
      };
      img.src = src;
    });
  }

  async function addImagesFromFiles(fileList) {
    const files = Array.from(fileList || []).filter(Boolean);
    for (const f of files) await addImageFromFile(f);
  }

  function selectionBounds(ids) {
    const list = (ids && ids.length ? ids : selectedIds)
      .map((id) => getLayer(id))
      .filter((L) => L && !L.locked);
    if (!list.length) return null;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    list.forEach((L) => {
      minX = Math.min(minX, L.x);
      minY = Math.min(minY, L.y);
      maxX = Math.max(maxX, L.x + L.w);
      maxY = Math.max(maxY, L.y + L.h);
    });
    return { x: minX, y: minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) };
  }

  function editableSelectedIds() {
    return selectedIds.filter((id) => {
      const L = getLayer(id);
      return L && !L.locked;
    });
  }

  /** Escala el grupo respecto a un ancla (esquina opuesta o centro). */
  function applyGroupScale(ids, origById, groupOrig, scale, anchorX, anchorY) {
    const s = clamp(scale, 0.05, 8);
    ids.forEach((sid) => {
      const L = getLayer(sid);
      const o = origById[sid];
      if (!L || !o) return;
      L.w = snapVal(clamp(o.w * s, 16, stageW * 2));
      L.h = snapVal(clamp(o.h * s, 16, stageH * 2));
      L.x = snapVal(anchorX + (o.x - anchorX) * s);
      L.y = snapVal(anchorY + (o.y - anchorY) * s);
      if ((L.type === 'text' || L.type === 'badge') && o.fontSize) {
        L.fontSize = clamp(Math.round(o.fontSize * s), 8, 400);
      }
      patchLayerDom(L);
    });
    return s;
  }

  function scaleSelectedGroup(factor, opts) {
    opts = opts || {};
    const ids = editableSelectedIds();
    if (ids.length < 1) {
      if (!opts.quiet) toast && toast('Selecciona capas', 'warn');
      return;
    }
    const bounds = selectionBounds(ids);
    if (!bounds) return;
    const origById = {};
    ids.forEach((sid) => {
      const L = getLayer(sid);
      if (!L) return;
      origById[sid] = { x: L.x, y: L.y, w: L.w, h: L.h, fontSize: L.fontSize || 48 };
    });
    const cx = bounds.x + bounds.w / 2;
    const cy = bounds.y + bounds.h / 2;
    applyGroupScale(ids, origById, bounds, factor, cx, cy);
    updateGroupSelectionBox();
    if (!opts.skipHistory) pushSnapshot();
    if (!opts.quiet) toast && toast(factor < 1 ? 'Más chicas' : 'Más grandes', 'ok');
  }

  let wheelScaleTimer = null;
  function pointInSelectionBounds(p, pad) {
    const ids = editableSelectedIds();
    if (ids.length < 1) return false;
    const b = selectionBounds(ids);
    if (!b) return false;
    const m = pad == null ? 12 : pad;
    return p.x >= b.x - m && p.y >= b.y - m && p.x <= b.x + b.w + m && p.y <= b.y + b.h + m;
  }

  function onStageWheel(e) {
    if (sliceMode) return;
    if (!$('view-editor')?.classList.contains('active')) return;

    const layerEl = e.target.closest?.('.ied-layer');
    const p = stagePointFromEvent(e);
    let ids = editableSelectedIds();

    if (layerEl) {
      const id = layerEl.dataset.id;
      const L = getLayer(id);
      if (!L || L.locked) return;
      if (!isSelected(id)) {
        // Con varias ya seleccionadas, no romper el grupo al pasar la rueda por otra capa
        if (selectedIds.length > 1) {
          if (!pointInSelectionBounds(p, 20)) return;
        } else {
          selectLayer(id);
        }
      }
    } else {
      // Huecos del marco / guía / lienzo: si hay selección (2+), escalar todo el grupo
      if (ids.length < 1) return;
      if (!pointInSelectionBounds(p, 16)) return;
    }

    ids = editableSelectedIds();
    if (!ids.length) return;
    e.preventDefault();
    e.stopPropagation();
    // Rueda arriba → más grande; abajo → más chica (mismo factor para TODAS)
    const steps = Math.min(4, Math.max(1, Math.round(Math.abs(e.deltaY) / 80)));
    const base = e.deltaY < 0 ? 1.07 : 0.935;
    const factor = Math.pow(base, steps);
    scaleSelectedGroup(factor, { quiet: true, skipHistory: true });
    if (wheelScaleTimer) clearTimeout(wheelScaleTimer);
    wheelScaleTimer = setTimeout(() => {
      wheelScaleTimer = null;
      pushSnapshot();
    }, 300);
  }

  function updateGroupSelectionBox() {
    const st = stage();
    if (!st) return;
    let box = st.querySelector('.ied-group-box');
    const ids = editableSelectedIds();
    if (selectedIds.length <= 1 || ids.length <= 1) {
      box?.remove();
      return;
    }
    const b = selectionBounds(ids);
    if (!b) {
      box?.remove();
      return;
    }
    if (!box) {
      box = document.createElement('div');
      box.className = 'ied-group-box';
      box.innerHTML = ['nw', 'ne', 'sw', 'se'].map((pos) =>
        `<div class="ied-handle ied-group-handle ${pos}" data-handle="${pos}"></div>`
      ).join('');
      st.appendChild(box);
      box.querySelectorAll('.ied-group-handle').forEach((h) => {
        h.addEventListener('pointerdown', onGroupHandlePointerDown);
      });
    }
    box.style.left = Math.round(b.x) + 'px';
    box.style.top = Math.round(b.y) + 'px';
    box.style.width = Math.round(b.w) + 'px';
    box.style.height = Math.round(b.h) + 'px';
  }

  function onGroupHandlePointerDown(e) {
    if (e.button != null && e.button !== 0) return;
    if (sliceMode) return;
    const handle = e.currentTarget?.dataset?.handle;
    if (!handle) return;
    const ids = editableSelectedIds();
    if (ids.length < 2) return;
    const bounds = selectionBounds(ids);
    if (!bounds) return;
    const p = stagePointFromEvent(e);
    const origById = {};
    ids.forEach((sid) => {
      const L = getLayer(sid);
      if (!L) return;
      origById[sid] = { x: L.x, y: L.y, w: L.w, h: L.h, fontSize: L.fontSize || 48 };
    });
    let anchorX = bounds.x;
    let anchorY = bounds.y;
    if (handle.includes('w')) anchorX = bounds.x + bounds.w;
    if (handle.includes('n')) anchorY = bounds.y + bounds.h;
    if (handle.includes('e')) anchorX = bounds.x;
    if (handle.includes('s')) anchorY = bounds.y;
    // esquinas: ancla = esquina opuesta
    if (handle === 'se') { anchorX = bounds.x; anchorY = bounds.y; }
    if (handle === 'sw') { anchorX = bounds.x + bounds.w; anchorY = bounds.y; }
    if (handle === 'ne') { anchorX = bounds.x; anchorY = bounds.y + bounds.h; }
    if (handle === 'nw') { anchorX = bounds.x + bounds.w; anchorY = bounds.y + bounds.h; }

    drag = {
      id: null,
      ids,
      mode: 'group-resize-' + handle,
      startX: p.x,
      startY: p.y,
      orig: { ...bounds },
      origById,
      anchorX,
      anchorY,
      moved: false,
    };
    e.currentTarget.setPointerCapture?.(e.pointerId);
    e.preventDefault();
    e.stopPropagation();
  }

  function renderStageSelection() {
    const st = stage();
    if (!st) return;
    st.querySelectorAll('.ied-layer').forEach((el) => {
      const L = getLayer(el.dataset.id);
      const sel = isSelected(el.dataset.id);
      el.classList.toggle('is-selected', sel);
      el.classList.toggle('is-primary', el.dataset.id === selectedId && sel);
      el.querySelectorAll('.ied-handle').forEach((h) => h.remove());
      // Handles individuales solo con 1 capa; con varias usa el marco del grupo
      if (el.dataset.id === selectedId && sel && selectedIds.length <= 1 && !L?.locked) {
        ['nw', 'ne', 'sw', 'se'].forEach((pos) => {
          const handle = document.createElement('div');
          handle.className = 'ied-handle ' + pos;
          handle.dataset.handle = pos;
          el.appendChild(handle);
        });
      }
    });
    updateGroupSelectionBox();
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
        (isSelected(L.id) ? ' is-selected' : '') +
        (L.id === selectedId && isSelected(L.id) ? ' is-primary' : '') +
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
      el.addEventListener('contextmenu', onLayerContextMenu);
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
      <div class="ied-layer-row ${isSelected(L.id) ? 'active' : ''}${L.id === selectedId && isSelected(L.id) ? ' is-primary' : ''}${L.locked ? ' is-locked' : ''}" data-id="${L.id}" draggable="${L.locked ? 'false' : 'true'}">
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
        if (e.ctrlKey || e.metaKey) selectLayer(id, { toggle: true });
        else if (e.shiftKey) selectLayer(id, { add: true });
        else selectLayer(id);
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
    if (selectedIds.length > 1) {
      const n = selectedIds.length;
      const ref = getLayer(selectedId) || getLayer(selectedIds[0]);
      const ids = editableSelectedIds();
      const sameW = ids.length && ids.every((id) => getLayer(id)?.w === ref?.w);
      const sameH = ids.length && ids.every((id) => getLayer(id)?.h === ref?.h);
      const sameMot = ids.length && ids.every((id) => (getLayer(id)?.motion || 'off') === (ref?.motion || 'off'));
      const wVal = ref?.w || 80;
      const hVal = ref?.h || 80;
      box.innerHTML = `
        <p class="ied-muted"><strong>${n}</strong> capas seleccionadas — los cambios se aplican a todas</p>
        <label class="ied-field">Movimiento
          <select id="ied-p-motion">${motionSelectOptions()}</select>
        </label>
        <label class="ied-field">Ancho
          <input type="number" id="ied-p-w" min="20" max="${Math.round(stageW * 2)}" value="${wVal}">
        </label>
        <label class="ied-field">Alto
          <input type="number" id="ied-p-h" min="20" max="${Math.round(stageH * 2)}" value="${hVal}">
        </label>
        ${!sameW || !sameH || !sameMot ? '<p class="ied-muted" style="margin-top:2px">Hay tamaños/movimientos distintos; al editar se igualan en las ' + n + '.</p>' : ''}
        <div class="ied-prop-actions" style="flex-wrap:wrap;margin-top:8px">
          <button type="button" class="btn ghost" id="ied-p-smaller">Más chicas</button>
          <button type="button" class="btn ghost" id="ied-p-bigger">Más grandes</button>
          <button type="button" class="btn ghost" id="ied-p-align-multi">Alinear nivel</button>
          <button type="button" class="btn ghost" id="ied-p-size-multi">Igualar tamaño</button>
          <button type="button" class="btn ghost" id="ied-p-dup-multi">Duplicar</button>
          <button type="button" class="btn danger" id="ied-p-del-multi">Borrar</button>
        </div>`;
      if ($('ied-p-motion')) {
        $('ied-p-motion').value = sameMot ? (ref?.motion || 'off') : (ref?.motion || 'off');
        $('ied-p-motion').onchange = () => {
          const mot = $('ied-p-motion').value;
          editableSelectedIds().forEach((id) => {
            const layer = getLayer(id);
            if (layer) layer.motion = mot;
          });
          renderStage();
          updateGroupSelectionBox();
          pushSnapshot();
        };
      }
      const applySizeToAll = (dim) => {
        const wEl = $('ied-p-w');
        const hEl = $('ied-p-h');
        const w = clamp(parseInt(wEl?.value, 10) || 20, 20, Math.round(stageW * 2));
        const h = clamp(parseInt(hEl?.value, 10) || 20, 20, Math.round(stageH * 2));
        if (wEl) wEl.value = String(w);
        if (hEl) hEl.value = String(h);
        editableSelectedIds().forEach((id) => {
          const layer = getLayer(id);
          if (!layer) return;
          if (dim === 'w' || dim === 'both') {
            if (layer.type === 'text' || layer.type === 'badge') {
              const s = w / Math.max(1, layer.w);
              layer.fontSize = clamp(Math.round((layer.fontSize || 48) * s), 8, 400);
            }
            layer.w = w;
          }
          if (dim === 'h' || dim === 'both') {
            if ((layer.type === 'text' || layer.type === 'badge') && dim === 'h') {
              const s = h / Math.max(1, layer.h);
              layer.fontSize = clamp(Math.round((layer.fontSize || 48) * s), 8, 400);
            }
            layer.h = h;
          }
        });
        renderStage();
        updateGroupSelectionBox();
        pushSnapshot();
      };
      if ($('ied-p-w')) {
        $('ied-p-w').onchange = () => applySizeToAll('w');
        $('ied-p-w').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); applySizeToAll('w'); } };
      }
      if ($('ied-p-h')) {
        $('ied-p-h').onchange = () => applySizeToAll('h');
        $('ied-p-h').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); applySizeToAll('h'); } };
      }
      if ($('ied-p-smaller')) $('ied-p-smaller').onclick = () => scaleSelectedGroup(0.85);
      if ($('ied-p-bigger')) $('ied-p-bigger').onclick = () => scaleSelectedGroup(1.15);
      if ($('ied-p-align-multi')) $('ied-p-align-multi').onclick = () => alignSelectedToLevel(selectedId);
      if ($('ied-p-size-multi')) $('ied-p-size-multi').onclick = () => matchSelectedSizeTo(selectedId);
      if ($('ied-p-dup-multi')) $('ied-p-dup-multi').onclick = () => duplicateLayer();
      if ($('ied-p-del-multi')) $('ied-p-del-multi').onclick = () => removeSelectedLayers();
      return;
    }
    const L = getLayer(selectedId);
    if (!L) {
      box.innerHTML = '<p class="ied-muted">Selecciona una capa<br><span style="opacity:.75">Arrastra un rectángulo en el lienzo para seleccionar varias</span></p>';
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
        <button type="button" class="ied-chip" id="ied-p-slice" style="width:100%;margin-top:4px">✂ Cortar región a capa</button>
        <p class="ied-muted" style="margin:4px 0 0">Una PNG no tiene capas internas: marca un rectángulo para separar un trozo.</p>
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
      $('ied-p-slice')?.addEventListener('click', () => setSliceMode(true));
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

  function setSliceMode(on) {
    sliceMode = !!on;
    if (!sliceMode) sliceDrag = null;
    const btn = $('ied-slice-tool');
    if (btn) btn.classList.toggle('is-active', sliceMode);
    const st = stage();
    if (st) st.classList.toggle('ied-slice-mode', sliceMode);
    updateSliceOverlay(null);
    if (sliceMode) {
      toast && toast('Cortar: clic en la imagen y arrastra el rectángulo. Esc para salir.', 'ok');
    }
  }

  function updateSliceOverlay(r) {
    const st = stage();
    if (!st) return;
    let ov = st.querySelector('.ied-slice-overlay');
    if (!r || r.w < 2 || r.h < 2) {
      ov?.remove();
      return;
    }
    if (!ov) {
      ov = document.createElement('div');
      ov.className = 'ied-slice-overlay';
      st.appendChild(ov);
    }
    ov.style.left = Math.round(r.x) + 'px';
    ov.style.top = Math.round(r.y) + 'px';
    ov.style.width = Math.round(r.w) + 'px';
    ov.style.height = Math.round(r.h) + 'px';
  }

  function updateMarqueeOverlay(r) {
    const st = stage();
    if (!st) return;
    let ov = st.querySelector('.ied-marquee');
    if (!r || r.w < 1 || r.h < 1) {
      ov?.remove();
      return;
    }
    if (!ov) {
      ov = document.createElement('div');
      ov.className = 'ied-marquee';
      st.appendChild(ov);
    }
    ov.style.left = Math.round(r.x) + 'px';
    ov.style.top = Math.round(r.y) + 'px';
    ov.style.width = Math.round(r.w) + 'px';
    ov.style.height = Math.round(r.h) + 'px';
  }

  function marqueeRectFromDrag() {
    if (!marquee) return null;
    const x1 = Math.min(marquee.startX, marquee.curX);
    const y1 = Math.min(marquee.startY, marquee.curY);
    const x2 = Math.max(marquee.startX, marquee.curX);
    const y2 = Math.max(marquee.startY, marquee.curY);
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  }

  function rectsIntersect(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }

  function layersInMarquee(r) {
    if (!r || r.w < 4 || r.h < 4) return [];
    return layers
      .filter((L) => rectsIntersect({ x: L.x, y: L.y, w: L.w, h: L.h }, r))
      .map((L) => L.id);
  }

  function patchLayerDom(L) {
    const el = stage()?.querySelector(`.ied-layer[data-id="${L.id}"]`);
    if (!el) return;
    el.style.left = L.x + 'px';
    el.style.top = L.y + 'px';
    el.style.width = L.w + 'px';
    el.style.height = L.h + 'px';
    if (L.type === 'text') {
      const t = el.querySelector('.ied-text');
      if (t) t.style.fontSize = (L.fontSize || 48) + 'px';
    }
  }

  function sliceRectFromDrag() {
    if (!sliceDrag) return null;
    const x1 = Math.min(sliceDrag.startX, sliceDrag.curX);
    const y1 = Math.min(sliceDrag.startY, sliceDrag.curY);
    const x2 = Math.max(sliceDrag.startX, sliceDrag.curX);
    const y2 = Math.max(sliceDrag.startY, sliceDrag.curY);
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  }

  async function applySliceFromDrag() {
    const r = sliceRectFromDrag();
    const layerId = sliceDrag?.layerId;
    sliceDrag = null;
    updateSliceOverlay(null);
    if (!r || r.w < 8 || r.h < 8) {
      toast && toast('Arrastra un área más grande para cortar', 'warn');
      return;
    }
    const L = getLayer(layerId);
    if (!L || L.type !== 'image' || !L.src) {
      toast && toast('Selecciona una capa de imagen', 'warn');
      return;
    }
    // Intersección con la capa
    const ix = Math.max(L.x, r.x);
    const iy = Math.max(L.y, r.y);
    const ix2 = Math.min(L.x + L.w, r.x + r.w);
    const iy2 = Math.min(L.y + L.h, r.y + r.h);
    const rw = ix2 - ix;
    const rh = iy2 - iy;
    if (rw < 8 || rh < 8) {
      toast && toast('El corte debe estar sobre la imagen', 'warn');
      return;
    }
    try {
      const img = await loadImage(L.src);
      const nw = img.naturalWidth || img.width;
      const nh = img.naturalHeight || img.height;
      if (!nw || !nh) throw new Error('sin tamaño');
      const sx = ((ix - L.x) / L.w) * nw;
      const sy = ((iy - L.y) / L.h) * nh;
      const sw = (rw / L.w) * nw;
      const sh = (rh / L.h) * nh;

      const cut = document.createElement('canvas');
      cut.width = Math.max(1, Math.round(sw));
      cut.height = Math.max(1, Math.round(sh));
      cut.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, cut.width, cut.height);
      const cutSrc = cut.toDataURL('image/png');

      // Quitar el trozo de la imagen original (hueco transparente)
      const full = document.createElement('canvas');
      full.width = nw;
      full.height = nh;
      const fctx = full.getContext('2d');
      fctx.drawImage(img, 0, 0);
      fctx.clearRect(sx, sy, sw, sh);
      L.src = full.toDataURL('image/png');
      L.isGif = false;
      delete L.gifBytes;

      const NL = {
        id: uid(),
        type: 'image',
        name: (L.name || 'Imagen') + ' · corte',
        src: cutSrc,
        motion: 'off',
        x: Math.round(ix),
        y: Math.round(iy),
        w: Math.round(rw),
        h: Math.round(rh),
      };
      layers.push(NL);
      selectLayer(NL.id);
      renderAll();
      pushSnapshot();
      toast && toast('Trozo separado como capa nueva. Repite para más botones.', 'ok');
    } catch (err) {
      toast && toast('No se pudo cortar esta imagen', 'warn');
    }
  }

  function onLayerPointerDown(e) {
    if (e.button != null && e.button !== 0) return;
    const el = e.currentTarget;
    const id = el.dataset.id;
    const L = getLayer(id);
    if (!L) return;
    if (L.locked) return;
    const p = stagePointFromEvent(e);
    const additive = e.ctrlKey || e.metaKey || e.shiftKey;

    if (sliceMode) {
      if (L.type !== 'image' || !L.src) {
        toast && toast('Cortar solo funciona en capas de imagen', 'warn');
        return;
      }
      drag = null;
      marquee = null;
      updateMarqueeOverlay(null);
      selectLayer(id);
      sliceDrag = { layerId: id, startX: p.x, startY: p.y, curX: p.x, curY: p.y };
      updateSliceOverlay({ x: p.x, y: p.y, w: 0, h: 0 });
      el.setPointerCapture?.(e.pointerId);
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    if (additive) {
      if (e.shiftKey && !(e.ctrlKey || e.metaKey)) selectLayer(id, { add: true });
      else selectLayer(id, { toggle: true });
    } else {
      selectLayer(id, { keepMulti: true });
    }

    let handle = e.target.closest?.('.ied-handle');
    if (handle?.classList?.contains('ied-group-handle')) return;

    const moveIds = (!handle && selectedIds.length > 1 && isSelected(id))
      ? selectedIds.filter((sid) => {
          const layer = getLayer(sid);
          return layer && !layer.locked;
        })
      : [id];

    // Redimensionar una sola capa del grupo → escala todo el grupo desde esa esquina
    if (handle && selectedIds.length > 1 && isSelected(id)) {
      const ids = editableSelectedIds();
      const bounds = selectionBounds(ids);
      if (bounds && ids.length > 1) {
        const pos = handle.dataset.handle;
        const origById = {};
        ids.forEach((sid) => {
          const layer = getLayer(sid);
          if (!layer) return;
          origById[sid] = { x: layer.x, y: layer.y, w: layer.w, h: layer.h, fontSize: layer.fontSize || 48 };
        });
        let anchorX = bounds.x;
        let anchorY = bounds.y;
        if (pos === 'se') { anchorX = bounds.x; anchorY = bounds.y; }
        if (pos === 'sw') { anchorX = bounds.x + bounds.w; anchorY = bounds.y; }
        if (pos === 'ne') { anchorX = bounds.x; anchorY = bounds.y + bounds.h; }
        if (pos === 'nw') { anchorX = bounds.x + bounds.w; anchorY = bounds.y + bounds.h; }
        drag = {
          id,
          ids,
          mode: 'group-resize-' + pos,
          startX: p.x,
          startY: p.y,
          orig: { ...bounds },
          origById,
          anchorX,
          anchorY,
          moved: false,
        };
        el.setPointerCapture?.(e.pointerId);
        e.preventDefault();
        e.stopPropagation();
        return;
      }
    }

    const origById = {};
    moveIds.forEach((sid) => {
      const layer = getLayer(sid);
      if (!layer) return;
      origById[sid] = { x: layer.x, y: layer.y, w: layer.w, h: layer.h, fontSize: layer.fontSize || 48 };
    });

    drag = {
      id,
      ids: moveIds,
      mode: handle ? ('resize-' + handle.dataset.handle) : 'move',
      startX: p.x,
      startY: p.y,
      orig: { x: L.x, y: L.y, w: L.w, h: L.h, fontSize: L.fontSize || 48 },
      origById,
      moved: false,
    };
    el.setPointerCapture?.(e.pointerId);
    e.preventDefault();
    e.stopPropagation();
  }

  function onPointerMove(e) {
    if (marquee) {
      const p = stagePointFromEvent(e);
      marquee.curX = p.x;
      marquee.curY = p.y;
      if (Math.abs(p.x - marquee.startX) > 3 || Math.abs(p.y - marquee.startY) > 3) marquee.moved = true;
      updateMarqueeOverlay(marqueeRectFromDrag());
      return;
    }
    if (sliceDrag) {
      const p = stagePointFromEvent(e);
      sliceDrag.curX = p.x;
      sliceDrag.curY = p.y;
      updateSliceOverlay(sliceRectFromDrag());
      return;
    }
    if (!drag) return;
    const p = stagePointFromEvent(e);
    const dx = p.x - drag.startX;
    const dy = p.y - drag.startY;

    if (drag.mode === 'move' && drag.ids && drag.ids.length) {
      drag.ids.forEach((sid) => {
        const L = getLayer(sid);
        const o = drag.origById?.[sid];
        if (!L || !o) return;
        L.x = snapVal(clamp(o.x + dx, -L.w + 20, stageW - 20));
        L.y = snapVal(clamp(o.y + dy, -L.h + 20, stageH - 20));
        patchLayerDom(L);
      });
      updateGroupSelectionBox();
    } else if (String(drag.mode).startsWith('group-resize-')) {
      const g = drag.orig;
      const ax = drag.anchorX;
      const ay = drag.anchorY;
      const handle = drag.mode.replace('group-resize-', '');
      let newW = g.w;
      let newH = g.h;
      if (handle.includes('e')) newW = Math.max(16, (p.x - ax));
      if (handle.includes('w')) newW = Math.max(16, (ax - p.x));
      if (handle.includes('s')) newH = Math.max(16, (p.y - ay));
      if (handle.includes('n')) newH = Math.max(16, (ay - p.y));
      // Escala uniforme (misma proporción para todas)
      const sx = newW / Math.max(1, g.w);
      const sy = newH / Math.max(1, g.h);
      const scale = Math.max(0.05, Math.min(8, (sx + sy) / 2));
      applyGroupScale(drag.ids, drag.origById, g, scale, ax, ay);
      updateGroupSelectionBox();
    } else {
      const L = getLayer(drag.id);
      if (!L) return;
      const o = drag.orig;
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
      patchLayerDom(L);
    }
    if (Math.abs(dx) > 1 || Math.abs(dy) > 1) drag.moved = true;
  }

  function onPointerUp() {
    if (marquee) {
      const r = marqueeRectFromDrag();
      const hit = layersInMarquee(r);
      if (hit.length) {
        if (marquee.additive) {
          const merged = [];
          const seen = new Set();
          [...selectedIds, ...hit].forEach((id) => {
            if (seen.has(id)) return;
            seen.add(id);
            merged.push(id);
          });
          setSelection(merged);
        } else {
          setSelection(hit);
        }
      } else if (!marquee.additive && !marquee.moved) {
        setSelection([]);
      }
      marquee = null;
      updateMarqueeOverlay(null);
      return;
    }
    if (sliceDrag) {
      applySliceFromDrag();
      return;
    }
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
    return ['#ff1744', '#ff9100', '#ffea00', '#00e676', '#00b0ff', '#e040fb', '#ff1744'];
  }

  /** Interpola keyframes CSS-like: [{ p:0..1, v }, ...] */
  function sampleKeyframes(frames, tSec, periodSec) {
    const u = ((tSec % periodSec) + periodSec) % periodSec / periodSec;
    for (let i = 0; i < frames.length - 1; i++) {
      const a = frames[i];
      const b = frames[i + 1];
      if (u >= a.p && u <= b.p) {
        const k = (u - a.p) / Math.max(1e-6, b.p - a.p);
        return a.v + (b.v - a.v) * k;
      }
    }
    return frames[frames.length - 1].v;
  }

  function motionOffset(L, tMs) {
    const mot = L.motion || 'off';
    if (mot === 'off') return { dx: 0, dy: 0, scale: 1, rot: 0 };
    const t = (tMs || 0) / 1000;
    const h = Math.max(1, L.h || 1);
    const w = Math.max(1, L.w || 1);
    // Misma timing/amplitud que @keyframes del editor (CSS)
    if (mot === 'float') {
      // 2.6s: 0 → -10% → 0
      const dy = sampleKeyframes(
        [{ p: 0, v: 0 }, { p: 0.5, v: -0.10 }, { p: 1, v: 0 }],
        t, 2.6,
      ) * h;
      return { dx: 0, dy, scale: 1, rot: 0 };
    }
    if (mot === 'bounce') {
      // 1.1s: 0 → -14% @40% → -6% @60% → 0
      const dy = sampleKeyframes(
        [{ p: 0, v: 0 }, { p: 0.4, v: -0.14 }, { p: 0.6, v: -0.06 }, { p: 1, v: 0 }],
        t, 1.1,
      ) * h;
      return { dx: 0, dy, scale: 1, rot: 0 };
    }
    if (mot === 'pulse') {
      // 1.4s: scale 1 → 1.08 → 1
      const scale = sampleKeyframes(
        [{ p: 0, v: 1 }, { p: 0.5, v: 1.08 }, { p: 1, v: 1 }],
        t, 1.4,
      );
      return { dx: 0, dy: 0, scale, rot: 0 };
    }
    if (mot === 'shake') {
      // 0.55s: ±3% X, ±2deg
      const dx = sampleKeyframes(
        [{ p: 0, v: 0 }, { p: 0.25, v: -0.03 }, { p: 0.75, v: 0.03 }, { p: 1, v: 0 }],
        t, 0.55,
      ) * w;
      const rotDeg = sampleKeyframes(
        [{ p: 0, v: 0 }, { p: 0.25, v: -2 }, { p: 0.75, v: 2 }, { p: 1, v: 0 }],
        t, 0.55,
      );
      return { dx, dy: 0, scale: 1, rot: rotDeg * Math.PI / 180 };
    }
    return { dx: 0, dy: 0, scale: 1, rot: 0 };
  }

  /** Degradado arcoíris continuo (como CSS background-clip), con scroll si rainbow=move. */
  function rainbowFillStyle(ctx, textW, tMs, moving) {
    const colors = rainbowColors();
    const tw = Math.max(8, textW);
    // background-size: 300%; position 0%→100% en 4.5s
    const period = 4500;
    const progress = moving ? (((tMs || 0) % period) / period) : 0;
    const span = tw * 3;
    const start = -tw / 2 - progress * (span - tw);
    const grd = ctx.createLinearGradient(start, 0, start + span, 0);
    const stops = colors.length;
    for (let i = 0; i < stops; i++) {
      grd.addColorStop(i / (stops - 1), colors[i]);
    }
    return grd;
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
    const movingRb = rb === 'move';

    if (L.shadow || rb === 'fixed' || rb === 'move') {
      // drop-shadow del editor en arcoíris / sombra
      ctx.shadowColor = 'rgba(0,0,0,0.5)';
      ctx.shadowBlur = L.shadow ? Math.max(4, fs * 0.08) : 0;
      ctx.shadowOffsetX = L.shadow ? Math.max(2, fs * 0.04) : 0;
      ctx.shadowOffsetY = Math.max(2, Math.round(fs * 0.04));
    }

    lines.forEach((line, i) => {
      const y = baseY + i * lineH;
      const textW = Math.max(8, Math.min(L.w, ctx.measureText(line).width || L.w));

      // Contorno sin sombra (más limpio, como paint-order stroke fill)
      if (sw > 0) {
        ctx.save();
        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 0;
        ctx.strokeStyle = strokeCol;
        ctx.lineWidth = sw * 2;
        ctx.lineJoin = 'round';
        ctx.miterLimit = 2;
        ctx.strokeText(line, 0, y, L.w);
        ctx.restore();
      }

      if (rb === 'off') {
        ctx.fillStyle = L.color || '#fff';
        ctx.fillText(line, 0, y, L.w);
        return;
      }

      // Arcoíris fijo o en movimiento = degradado continuo (igual que CSS del editor)
      ctx.fillStyle = rainbowFillStyle(ctx, textW, tMs, movingRb);
      ctx.fillText(line, 0, y, L.w);
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
    ctx.strokeStyle = 'rgba(0,0,0,.7)';
    ctx.lineWidth = Math.max(2, fs * 0.12);
    const tx = L.x + L.w / 2;
    const ty = L.y + L.h + 4;
    ctx.strokeText(L.label, tx, ty, L.w);
    ctx.fillText(L.label, tx, ty, L.w);
    ctx.restore();
  }

  /**
   * Igual que CSS object-fit en el editor (por defecto contain = no estirar).
   * mode: 'contain' | 'cover' | 'fill'
   */
  function fitRectInBox(srcW, srcH, boxX, boxY, boxW, boxH, mode) {
    const m = mode || 'contain';
    if (!srcW || !srcH || !boxW || !boxH) {
      return { x: boxX, y: boxY, w: boxW, h: boxH };
    }
    if (m === 'fill' || m === 'stretch') {
      return { x: boxX, y: boxY, w: boxW, h: boxH };
    }
    const srcR = srcW / srcH;
    const boxR = boxW / boxH;
    let w;
    let h;
    if (m === 'cover') {
      if (srcR > boxR) { h = boxH; w = boxH * srcR; }
      else { w = boxW; h = boxW / srcR; }
    } else {
      // contain — misma apariencia que en el lienzo del editor
      if (srcR > boxR) { w = boxW; h = boxW / srcR; }
      else { h = boxH; w = boxH * srcR; }
    }
    return {
      x: boxX + (boxW - w) / 2,
      y: boxY + (boxH - h) / 2,
      w,
      h,
    };
  }

  function layerImageSize(img) {
    const w = img.naturalWidth || img.width || 0;
    const h = img.naturalHeight || img.height || 0;
    return { w, h };
  }

  /** Dibuja la imagen de una capa como en el editor (sin estirar por defecto). */
  function drawLayerImage(ctx, img, L, tMs) {
    const { w: nw, h: nh } = layerImageSize(img);
    const fitMode = L.objectFit || L.fit || 'contain';
    const fit = fitRectInBox(nw, nh, L.x, L.y, L.w, L.h, fitMode);
    const mot = motionOffset(L, tMs || 0);
    if (mot.dx || mot.dy || mot.scale !== 1 || mot.rot) {
      ctx.save();
      const cx = L.x + L.w / 2;
      const cy = L.y + L.h / 2;
      ctx.translate(cx + mot.dx, cy + mot.dy);
      ctx.rotate(mot.rot);
      ctx.scale(mot.scale, mot.scale);
      ctx.drawImage(img, fit.x - cx, fit.y - cy, fit.w, fit.h);
      ctx.restore();
    } else {
      ctx.drawImage(img, fit.x, fit.y, fit.w, fit.h);
    }
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
        drawLayerImage(ctx, img, L, tMs || 0);
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
        // Ciclo del arcoíris CSS (4.5s) + frames más suaves para flotar/rebote/etc.
        const step = 50;
        const duration = 4500;
        for (let t = 0; t < duration; t += step) timeline.push({ t, delay: step });
      } else {
        const duration = Math.min(Math.max(maxLoop, textAnim ? 4500 : 100), 9000);
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
          const step = textAnim ? 50 : 80;
          for (let t = 0; t < duration; t += step) {
            timeline.push({ t, delay: step });
          }
        }
        if (timeline.length > (textAnim ? 100 : 80)) timeline.length = textAnim ? 100 : 80;
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
    $('ied-slice-tool')?.addEventListener('click', () => setSliceMode(!sliceMode));
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
    $('ied-bg-file')?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const data = await fileToDataUrl(file);
        bgImageSrc = data;
        bgMode = 'image';
        const modeSel = $('ied-bg-mode');
        if (modeSel) modeSel.value = 'image';
        syncBgModeUi();
        applyStageBackground();
        pushSnapshot();
      } catch {
        toast && toast('No se pudo cargar el fondo', 'warn');
      }
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
      selectedIds = [];
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
      if (sliceMode) return;
      if (e.button != null && e.button !== 0) return;
      hideContextMenu();
      const t = e.target;
      const onEmpty = t === stage()
        || t?.classList?.contains('ied-guides')
        || t?.closest?.('.ied-guides')
        || t?.classList?.contains('ied-marquee');
      if (!onEmpty) return;
      const p = stagePointFromEvent(e);
      const additive = e.ctrlKey || e.metaKey || e.shiftKey;
      drag = null;
      marquee = {
        startX: p.x, startY: p.y, curX: p.x, curY: p.y,
        additive, moved: false,
      };
      if (!additive) setSelection([]);
      updateMarqueeOverlay({ x: p.x, y: p.y, w: 0, h: 0 });
      e.preventDefault();
    });

    stage()?.addEventListener('contextmenu', (e) => {
      if (sliceMode) return;
      const t = e.target;
      if (t?.closest?.('.ied-layer')) return;
      e.preventDefault();
      const p = stagePointFromEvent(e);
      ctxPasteAt = { x: p.x, y: p.y };
      showContextMenu(e.clientX, e.clientY, null, { empty: true });
    });

    // Rueda: escala TODAS las seleccionadas por igual (también con 8, 10, etc.)
    viewport()?.addEventListener('wheel', (e) => {
      if (sliceMode) return;
      if (!editableSelectedIds().length && !e.target?.closest?.('.ied-layer')) return;
      const overStage = e.target === stage()
        || !!e.target?.closest?.('#ied-stage')
        || !!e.target?.closest?.('.ied-guides')
        || !!e.target?.closest?.('.ied-layer')
        || !!e.target?.closest?.('.ied-group-box')
        || !!e.target?.closest?.('#ied-stage-scale');
      if (!overStage) return;
      onStageWheel(e);
    }, { passive: false });

    document.addEventListener('pointerdown', (e) => {
      if (e.target?.closest?.('#ied-ctx-menu')) return;
      hideContextMenu();
    }, true);

    $('ied-grid')?.addEventListener('change', () => updateGuides());
    $('ied-center-guides')?.addEventListener('change', () => updateGuides());
    $('ied-align-row')?.addEventListener('click', () => alignRow());
    $('ied-equal-size')?.addEventListener('click', () => equalSize());
    $('ied-distribute')?.addEventListener('click', () => distributeH());

    document.addEventListener('keydown', (e) => {
      if (!$('view-editor')?.classList.contains('active')) return;
      const tag = (e.target && e.target.tagName) || '';
      const inField = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
      if (e.key === 'Escape' && (sliceMode || sliceDrag)) {
        e.preventDefault();
        setSliceMode(false);
        hideContextMenu();
        return;
      }
      if (e.key === 'Escape') {
        if (document.getElementById('ied-ctx-menu')) {
          e.preventDefault();
          hideContextMenu();
          return;
        }
        if (selectedIds.length && !inField) {
          e.preventDefault();
          setSelection([]);
          return;
        }
      }
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
      if (mod && e.key.toLowerCase() === 'c' && !inField) {
        e.preventDefault();
        copySelectedLayers();
        return;
      }
      if (mod && e.key.toLowerCase() === 'v' && !inField) {
        e.preventDefault();
        pasteClipboardLayers({ x: 40, y: 40 });
        return;
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && (selectedIds.length || selectedId) && !inField) {
        e.preventDefault();
        removeSelectedLayers();
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
      selectedIds = [];
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
      selectedIds = [];
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
