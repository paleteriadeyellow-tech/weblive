/**
 * Editor Pro — rejilla de fondos GIF + iconos centrados + regalos (tamaño y posición).
 */
(function () {
  const FONDOS = [
    { id: 'transparent', label: 'Transparente (flotando)', src: '', transparent: true },
    { id: 'fondo-1', label: 'Sunset rosa', src: '/gif/fondo-1.gif' },
    { id: 'fondo-2', label: 'Pastel suave', src: '/gif/fondo-2.gif' },
    { id: 'fondo-3', label: 'Neblina rosa', src: '/gif/fondo-3.gif' },
    { id: 'art-design', label: 'Art Design', src: '/gif/' + encodeURIComponent('Art Design GIF by jorgemariozuleta.gif') },
    { id: 'art-render', label: 'Art Render', src: '/gif/' + encodeURIComponent('Art Render GIF by time.gif') },
    { id: 'art-render-2', label: 'Art Render 2', src: '/gif/' + encodeURIComponent('Art Render GIF by time (1).gif') },
    { id: 'kimburgerly', label: 'Kimburgerly', src: '/gif/' + encodeURIComponent('GIF by kimburgerly.gif') },
    { id: 'uniondocs', label: 'UnionDocs', src: '/gif/' + encodeURIComponent('GIF by UnionDocs (1).gif') },
    { id: 'you-bilingue', label: 'You Bilingüe', src: '/gif/' + encodeURIComponent('GIF by YOU Bilingue.gif') },
    { id: 'gif-corto', label: 'Clip corto', src: '/gif/gif.gif' },
    { id: 'loop-space', label: 'Loop Space', src: '/gif/' + encodeURIComponent('Loop Space GIF by time.gif') },
    { id: 'loop-space-2', label: 'Loop Space 2', src: '/gif/' + encodeURIComponent('Loop Space GIF by time (1).gif') },
    { id: 'relaxed-mood', label: 'Relaxed Mood', src: '/gif/' + encodeURIComponent('Relaxed Mood GIF by Kaleidadope.gif') },
    { id: 'custom', label: 'Mi imagen / GIF', src: '', custom: true },
  ];
  const MIN_COUNT = 1;
  const MAX_COUNT = 64;
  const MAX_TEXTS_PER_CELL = 12;
  const STORAGE_KEY = 'livecoins_editor_rapido_v10';
  const TEXT_STYLES = ['solid', 'rainbow', 'aurora'];
  const FRAME_PRESETS = [
    { id: 'off', label: 'Sin marco', kind: 'off' },
    { id: 'solid', label: 'Color fijo', kind: 'solid' },
    {
      id: 'rainbow', label: 'Arcoíris', kind: 'anim', anim: 'flow', dur: '4s',
      gradient: 'linear-gradient(90deg, #ff006e, #8338ec, #3a86ff, #06ffa5, #ffbe0b, #fb5607, #ff006e)',
      stops: ['#ff006e', '#8338ec', '#3a86ff', '#06ffa5', '#ffbe0b', '#fb5607'],
    },
    {
      id: 'aurora', label: 'Aurora', kind: 'anim', anim: 'pulse', dur: '6s',
      gradient: 'linear-gradient(90deg, #22d3ee, #a78bfa, #34d399, #60a5fa, #c084fc, #2dd4bf, #22d3ee)',
      stops: ['#22d3ee', '#a78bfa', '#34d399', '#60a5fa'],
    },
    {
      id: 'fire', label: 'Fuego', kind: 'anim', anim: 'flow', dur: '3.2s',
      gradient: 'linear-gradient(90deg, #7f1d1d, #dc2626, #f97316, #fbbf24, #ef4444, #7f1d1d)',
      stops: ['#7f1d1d', '#dc2626', '#f97316', '#fbbf24'],
    },
    {
      id: 'ocean', label: 'Océano', kind: 'anim', anim: 'pulse', dur: '5.5s',
      gradient: 'linear-gradient(90deg, #0c4a6e, #0284c7, #22d3ee, #67e8f9, #38bdf8, #0c4a6e)',
      stops: ['#0c4a6e', '#0284c7', '#22d3ee', '#67e8f9'],
    },
    {
      id: 'neon', label: 'Neón', kind: 'anim', anim: 'flow', dur: '3.5s',
      gradient: 'linear-gradient(90deg, #ff00ff, #00ffff, #39ff14, #ff00aa, #00ffff, #ff00ff)',
      stops: ['#ff00ff', '#00ffff', '#39ff14', '#ff00aa'],
    },
    {
      id: 'gold', label: 'Oro', kind: 'anim', anim: 'pulse', dur: '4.5s',
      gradient: 'linear-gradient(90deg, #78350f, #f59e0b, #fde68a, #d97706, #fbbf24, #78350f)',
      stops: ['#78350f', '#f59e0b', '#fde68a', '#d97706'],
    },
    {
      id: 'candy', label: 'Dulce', kind: 'anim', anim: 'flow', dur: '4s',
      gradient: 'linear-gradient(90deg, #db2777, #f472b6, #c084fc, #fb7185, #e879f9, #db2777)',
      stops: ['#db2777', '#f472b6', '#c084fc', '#fb7185'],
    },
    {
      id: 'ice', label: 'Hielo', kind: 'anim', anim: 'pulse', dur: '5s',
      gradient: 'linear-gradient(90deg, #e0f2fe, #7dd3fc, #a5b4fc, #cffafe, #93c5fd, #e0f2fe)',
      stops: ['#e0f2fe', '#7dd3fc', '#a5b4fc', '#93c5fd'],
    },
    {
      id: 'sunset', label: 'Atardecer', kind: 'anim', anim: 'flow', dur: '4.8s',
      gradient: 'linear-gradient(90deg, #4c1d95, #db2777, #f97316, #fbbf24, #ec4899, #4c1d95)',
      stops: ['#4c1d95', '#db2777', '#f97316', '#fbbf24'],
    },
    {
      id: 'matrix', label: 'Matrix', kind: 'anim', anim: 'flow', dur: '3.8s',
      gradient: 'linear-gradient(90deg, #052e16, #16a34a, #4ade80, #86efac, #22c55e, #052e16)',
      stops: ['#052e16', '#16a34a', '#4ade80', '#86efac'],
    },
    {
      id: 'plasma', label: 'Plasma', kind: 'anim', anim: 'pulse', dur: '5.2s',
      gradient: 'linear-gradient(90deg, #581c87, #7c3aed, #06b6d4, #ec4899, #8b5cf6, #581c87)',
      stops: ['#581c87', '#7c3aed', '#06b6d4', '#ec4899'],
    },
    {
      id: 'mint', label: 'Menta', kind: 'anim', anim: 'pulse', dur: '4.6s',
      gradient: 'linear-gradient(90deg, #064e3b, #10b981, #6ee7b7, #99f6e4, #34d399, #064e3b)',
      stops: ['#064e3b', '#10b981', '#6ee7b7', '#34d399'],
    },
  ];

  function clampTextStyle(s) {
    return TEXT_STYLES.includes(s) ? s : 'solid';
  }

  function framePresetById(id) {
    return FRAME_PRESETS.find((p) => p.id === id) || FRAME_PRESETS[0];
  }

  function clampFrameMode(m) {
    return FRAME_PRESETS.some((p) => p.id === m) ? m : 'off';
  }

  function clampTextColor(c) {
    const s = String(c || '').trim();
    if (/^#[0-9a-fA-F]{6}$/.test(s)) return s;
    if (/^#[0-9a-fA-F]{3}$/.test(s)) {
      return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
    }
    return '#ffffff';
  }
  const CORNER_PRESETS = {
    like: { type: 'like', name: 'Like', src: '/img/likes-heart.gif' },
    follow: { type: 'follow', name: 'Follow', src: '/img/er-follow.png?v=3' },
    superfan: { type: 'superfan', name: 'Super fan', src: '/img/er-superfan.png?v=3' },
    share: { type: 'share', name: 'Compartir', src: '/img/er-share.png?v=3' },
  };

  const CORNER_MENU_ICONS = {
    gift: '/img/er-gift.png?v=3',
    like: '/img/er-like.png?v=3',
    follow: '/img/er-follow.png?v=3',
    superfan: '/img/er-superfan.png?v=3',
    share: '/img/er-share.png?v=3',
  };

  function clampGridN(n) {
    const v = Math.round(Number(n));
    // 0 = Automática. ≥1 = columnas fijas (presets NxN o personalizado CxF).
    if (!Number.isFinite(v) || v < 1) return 0;
    return Math.min(MAX_COUNT, v);
  }

  function isSquareGridPreset() {
    const g = clampGridN(state.gridN);
    return !!(g >= 2 && g <= 8 && state.count === g * g);
  }

  function layoutFor(count, gridN) {
    const fixed = clampGridN(gridN);
    const n = Math.max(MIN_COUNT, Math.min(MAX_COUNT, Number(count) || MIN_COUNT));
    if (fixed) {
      // Columnas fijas; filas según cuántos cuadros hay (8×4 = 32, 5×5 = 25, etc.).
      return { cols: fixed, rows: Math.max(1, Math.ceil(n / fixed)) };
    }
    if (n <= 6) return { cols: n, rows: 1 };
    const cols = Math.ceil(Math.sqrt(n));
    const rows = Math.ceil(n / cols);
    return { cols, rows };
  }

  function clampCount(n) {
    const v = Math.round(Number(n));
    if (!Number.isFinite(v)) return 4;
    return Math.max(MIN_COUNT, Math.min(MAX_COUNT, v));
  }

  function fondoById(id) {
    return FONDOS.find((f) => f.id === id) || FONDOS.find((f) => f.id === 'fondo-1') || FONDOS[0];
  }

  function isTransparentFondo(id) {
    return String(id || '') === 'transparent';
  }

  function resolveFondoSrc(st) {
    const s = st || state;
    if (isTransparentFondo(s.fondo)) return '';
    if (s.fondo === 'custom' && s.fondoCustomSrc) return String(s.fondoCustomSrc);
    const f = fondoById(s.fondo);
    if (f.custom) return String(s.fondoCustomSrc || '');
    return f.src || '';
  }

  function fondoLabel(st) {
    const s = st || state;
    if (isTransparentFondo(s.fondo)) return 'Transparente';
    if (s.fondo === 'custom') return s.fondoCustomSrc ? 'Mi imagen / GIF' : 'Mi imagen (elige archivo)';
    return fondoById(s.fondo).label;
  }

  function emptySlots() {
    return Array.from({ length: MAX_COUNT }, () => null);
  }

  function emptyTextSlots() {
    return Array.from({ length: MAX_COUNT }, () => []);
  }

  function textsAt(slot) {
    const raw = state.texts?.[slot];
    if (Array.isArray(raw)) return raw.filter(Boolean);
    if (raw && typeof raw === 'object') return [raw];
    return [];
  }

  function setTextsAt(slot, list) {
    const i = Number(slot);
    if (!Number.isFinite(i) || i < 0 || i >= MAX_COUNT) return;
    state.texts[i] = (list || []).filter(Boolean).slice(0, MAX_TEXTS_PER_CELL);
  }

  function getText(slot, idx) {
    return textsAt(slot)[Number(idx)] || null;
  }

  function selKey(slot, idx) {
    return `${Number(slot)}:${Number(idx)}`;
  }

  function isTextSelected(slot, idx) {
    return selectedText && selectedText.slot === Number(slot) && selectedText.idx === Number(idx);
  }

  function isTextEditing(slot, idx) {
    return textEditing && textEditing.slot === Number(slot) && textEditing.idx === Number(idx);
  }

  function normalizeTextList(raw) {
    if (Array.isArray(raw)) {
      return raw.map(cloneText).filter(Boolean).slice(0, MAX_TEXTS_PER_CELL);
    }
    const one = cloneText(raw);
    return one ? [one] : [];
  }

  const MOTIONS = ['off', 'float', 'bounce', 'pulse', 'shake'];

  function clampMotion(m) {
    return MOTIONS.includes(m) ? m : 'off';
  }

  function motionClass(motion) {
    const m = clampMotion(motion);
    return m && m !== 'off' ? ` ied-motion-${m}` : '';
  }

  function clampPct(n, fallback) {
    const v = Number(n);
    if (!Number.isFinite(v)) return fallback != null ? fallback : 50;
    return Math.min(92, Math.max(8, v));
  }

  function emptyFreeMove() {
    return Array.from({ length: MAX_COUNT }, () => false);
  }
  function isExternalMediaSrc(src) {
    const s = String(src || '');
    if (!s) return false;
    return s.startsWith('data:') || s.startsWith('blob:') || s.includes('/api/editor-rapido/media/');
  }

  function clampItemScale(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return 1;
    return Math.round(Math.max(0.35, Math.min(2.8, v)) * 100) / 100;
  }

  function cloneItem(o) {
    if (!o?.src) return null;
    const out = { src: o.src, name: o.name || '', type: o.type || 'gift' };
    if (o.giftId) out.giftId = String(o.giftId);
    if (Number.isFinite(Number(o.x))) out.x = clampPct(o.x);
    if (Number.isFinite(Number(o.y))) out.y = clampPct(o.y);
    if (Number.isFinite(Number(o.scale))) out.scale = clampItemScale(o.scale);
    if (Number.isFinite(Number(o.z))) out.z = Math.max(1, Math.min(50, Math.round(Number(o.z))));
    return out;
  }

  /** Posición/escala que el usuario puso a mano en un regalo. Se conserva
      aunque cambie la imagen del regalo al re-sincronizar desde Juegos. */
  function itemGeometry(o) {
    const out = {};
    if (!o) return out;
    if (Number.isFinite(Number(o.x))) out.x = clampPct(o.x);
    if (Number.isFinite(Number(o.y))) out.y = clampPct(o.y);
    if (Number.isFinite(Number(o.scale))) out.scale = clampItemScale(o.scale);
    if (Number.isFinite(Number(o.z))) out.z = Math.max(1, Math.min(50, Math.round(Number(o.z))));
    return out;
  }

  function isFreeMove(slot) {
    const i = Number(slot);
    return !!(state.freeMove && state.freeMove[i]);
  }

  /** Layout libre ya aplicado (se mantiene aunque no estés editando). */
  function isFreeLayout(slot) {
    const i = Number(slot);
    return !!(state.freeLayout && state.freeLayout[i]);
  }

  /** Usa posiciones/escala custom: editando o ya aplicado. */
  function usesCustomLayout(slot) {
    return isFreeMove(slot) || isFreeLayout(slot);
  }

  function ensureFreePos(slot) {
    const i = Number(slot);
    const o = state.overlays[i];
    if (o?.src) {
      if (!Number.isFinite(Number(o.x))) o.x = 50;
      if (!Number.isFinite(Number(o.y))) o.y = 50;
      if (!Number.isFinite(Number(o.scale))) o.scale = 1;
      if (!Number.isFinite(Number(o.z))) o.z = 2;
    }
    const g = state.gifts[i];
    if (g?.src) {
      if (!Number.isFinite(Number(g.x))) g.x = 82;
      if (!Number.isFinite(Number(g.y))) g.y = 82;
      if (!Number.isFinite(Number(g.scale))) g.scale = 1;
      if (!Number.isFinite(Number(g.z))) g.z = 4;
    }
    textsAt(i).forEach((t) => {
      if (t && !Number.isFinite(Number(t.z))) t.z = 3;
    });
  }

  function clearFreePos(slot) {
    const i = Number(slot);
    const o = state.overlays[i];
    if (o) {
      delete o.x;
      delete o.y;
      delete o.scale;
      delete o.z;
    }
    const g = state.gifts[i];
    if (g) {
      delete g.x;
      delete g.y;
      delete g.scale;
      delete g.z;
    }
  }

  function isFreeItemSelected(slot, kind) {
    return !!(selectedFreeItem
      && selectedFreeItem.slot === Number(slot)
      && selectedFreeItem.kind === kind);
  }

  function setSelectedFreeItem(slot, kind) {
    const i = Number(slot);
    if (!Number.isFinite(i) || i < 0 || i >= state.count || !isFreeMove(i)) {
      selectedFreeItem = null;
      return;
    }
    const k = kind === 'gift' ? 'gift' : 'overlay';
    const item = k === 'gift' ? state.gifts[i] : state.overlays[i];
    if (!item?.src) {
      selectedFreeItem = null;
      return;
    }
    selectedFreeItem = { slot: i, kind: k };
    selectedText = null;
    setSelectedSlot(i);
  }

  function clearSelectedFreeItem() {
    selectedFreeItem = null;
  }

  function toggleFreeMove(slot) {
    const i = Number(slot);
    if (!Number.isFinite(i) || i < 0 || i >= state.count) return;
    if (!state.freeMove) state.freeMove = emptyFreeMove();
    if (!state.freeLayout) state.freeLayout = emptyFreeMove();
    if (state.freeMove[i]) {
      // Salir del modo edición sin Aplicar: si no estaba aplicado, vuelve a layout normal
      state.freeMove[i] = false;
      if (selectedFreeItem?.slot === i) selectedFreeItem = null;
      if (!state.freeLayout[i]) {
        clearFreePos(i);
        toastMsg('Movimiento libre cancelado');
      } else {
        toastMsg('Edición cerrada · layout libre sigue aplicado');
      }
    } else {
      state.freeMove[i] = true;
      ensureFreePos(i);
      if (state.overlays[i]?.src) selectedFreeItem = { slot: i, kind: 'overlay' };
      else if (state.gifts[i]?.src) selectedFreeItem = { slot: i, kind: 'gift' };
      else selectedFreeItem = null;
      setSelectedSlot(i);
      toastMsg('Movimiento libre · clic para seleccionar · arrastra / asa / rueda = tamaño');
    }
    saveState(state);
    renderGrid();
  }

  function applyFreeMove(slot, opts) {
    const i = Number(slot);
    if (!Number.isFinite(i) || i < 0 || i >= state.count) return false;
    if (!state.freeMove) state.freeMove = emptyFreeMove();
    if (!state.freeLayout) state.freeLayout = emptyFreeMove();
    ensureFreePos(i);
    state.freeLayout[i] = true;
    state.freeMove[i] = false;
    if (selectedFreeItem?.slot === i) selectedFreeItem = null;
    if (!opts?.skipSave) {
      saveState(state);
      renderGrid();
    }
    if (!opts?.silent) toastMsg('Layout libre aplicado · ya no vuelve al centro/esquina');
    return true;
  }

  function applyActiveFreeMoves() {
    const slots = [];
    for (let i = 0; i < state.count; i++) {
      if (isFreeMove(i)) slots.push(i);
    }
    if (!slots.length) {
      toastMsg('Ningún cuadro en movimiento libre');
      updateFreeApplyBtn();
      return;
    }
    // Preferir el cuadro seleccionado si está editando
    const prefer = (selectedSlot != null && isFreeMove(selectedSlot)) ? [selectedSlot] : slots;
    prefer.forEach((i) => applyFreeMove(i, { silent: true, skipSave: true }));
    saveState(state);
    renderGrid();
    toastMsg(prefer.length === 1
      ? 'Layout libre aplicado · ya no vuelve al centro/esquina'
      : `Layout libre aplicado en ${prefer.length} cuadros`);
  }

  function clearFreeLayout(slot, opts) {
    const i = Number(slot);
    if (!Number.isFinite(i) || i < 0 || i >= state.count) return false;
    if (!state.freeMove) state.freeMove = emptyFreeMove();
    if (!state.freeLayout) state.freeLayout = emptyFreeMove();
    const had = !!(state.freeMove[i] || state.freeLayout[i]);
    state.freeMove[i] = false;
    state.freeLayout[i] = false;
    clearFreePos(i);
    if (selectedFreeItem?.slot === i) selectedFreeItem = null;
    if (!opts?.skipSave) {
      saveState(state);
      renderGrid();
    }
    if (!opts?.silent && had) toastMsg('Movimiento libre quitado · cuadro como los demás');
    return had;
  }

  function clearActiveFreeLayout() {
    const slots = [];
    for (let i = 0; i < state.count; i++) {
      if (isFreeMove(i) || isFreeLayout(i)) slots.push(i);
    }
    if (!slots.length) {
      toastMsg('Ningún cuadro con movimiento libre');
      updateFreeApplyBtn();
      return;
    }
    const prefer = (selectedSlot != null && (isFreeMove(selectedSlot) || isFreeLayout(selectedSlot)))
      ? [selectedSlot]
      : slots;
    prefer.forEach((i) => clearFreeLayout(i, { silent: true, skipSave: true }));
    saveState(state);
    renderGrid();
    toastMsg(prefer.length === 1
      ? 'Movimiento libre quitado · cuadro como los demás'
      : `Movimiento libre quitado en ${prefer.length} cuadros`);
  }

  function updateFreeApplyBtn() {
    const applyBtn = document.getElementById('er-apply-free');
    const clearBtn = document.getElementById('er-clear-free');
    let anyEdit = false;
    let anyFree = false;
    for (let i = 0; i < state.count; i++) {
      if (isFreeMove(i)) anyEdit = true;
      if (isFreeMove(i) || isFreeLayout(i)) anyFree = true;
    }
    if (applyBtn) {
      applyBtn.hidden = !anyEdit;
      applyBtn.disabled = !anyEdit;
      applyBtn.classList.toggle('is-on', anyEdit);
    }
    if (clearBtn) {
      clearBtn.hidden = !anyFree;
      clearBtn.disabled = !anyFree;
    }
  }

  function layerZ(kind, slot, textIdx) {
    if (kind === 'overlay') return Math.max(1, Number(state.overlays[slot]?.z) || 2);
    if (kind === 'gift') return Math.max(1, Number(state.gifts[slot]?.z) || 4);
    const t = getText(slot, textIdx);
    return Math.max(1, Number(t?.z) || 3);
  }

  function setLayerZ(kind, slot, textIdx, z) {
    const zz = Math.max(1, Math.min(50, Math.round(z)));
    if (kind === 'overlay' && state.overlays[slot]) state.overlays[slot].z = zz;
    else if (kind === 'gift' && state.gifts[slot]) state.gifts[slot].z = zz;
    else if (kind === 'text') {
      const list = textsAt(slot).slice();
      const t = list[textIdx];
      if (!t) return;
      list[textIdx] = { ...t, z: zz };
      setTextsAt(slot, list);
    }
  }

  function bumpLayer(kind, slot, textIdx, dir) {
    ensureFreePos(slot);
    const layers = [];
    if (state.overlays[slot]?.src) {
      layers.push({ kind: 'overlay', textIdx: 0, z: layerZ('overlay', slot), label: 'imagen' });
    }
    if (state.gifts[slot]?.src) {
      layers.push({ kind: 'gift', textIdx: 0, z: layerZ('gift', slot), label: 'regalo' });
    }
    textsAt(slot).forEach((_, ti) => {
      layers.push({ kind: 'text', textIdx: ti, z: layerZ('text', slot, ti), label: 'texto' });
    });
    if (layers.length < 2) {
      toastMsg('No hay otra capa para reordenar');
      return;
    }
    // Orden estable por z, luego por tipo
    const rank = { overlay: 0, text: 1, gift: 2 };
    layers.sort((a, b) => (a.z - b.z) || ((rank[a.kind] || 0) - (rank[b.kind] || 0)) || (a.textIdx - b.textIdx));
    // Normalizar z únicos 1..n para poder intercambiar limpio
    layers.forEach((l, i) => { l.z = i + 1; });
    layers.forEach((l) => setLayerZ(l.kind, slot, l.textIdx, l.z));

    const idx = layers.findIndex((l) => (
      l.kind === kind && (kind !== 'text' || l.textIdx === Number(textIdx || 0))
    ));
    if (idx < 0) return;
    const target = dir > 0 ? idx + 1 : idx - 1;
    if (target < 0 || target >= layers.length) {
      toastMsg(dir > 0 ? 'Ya está al frente' : 'Ya está atrás del todo');
      saveState(state);
      renderGrid();
      return;
    }
    const a = layers[idx];
    const b = layers[target];
    setLayerZ(a.kind, slot, a.textIdx, b.z);
    setLayerZ(b.kind, slot, b.textIdx, a.z);
    // mantener selección del item que movimos
    if (a.kind === 'overlay' || a.kind === 'gift') {
      selectedFreeItem = { slot: Number(slot), kind: a.kind };
    }
    saveState(state);
    renderGrid();
    toastMsg(dir > 0
      ? `${a.label} delante de ${b.label}`
      : `${a.label} detrás de ${b.label}`);
  }

  function applyItemScale(kind, slot, scale) {
    const arr = kind === 'gift' ? state.gifts : state.overlays;
    const item = arr[slot];
    if (!item?.src) return;
    item.scale = clampItemScale(scale);
    const el = document.querySelector(`.er-cell[data-slot="${slot}"] .er-free-item[data-free-kind="${kind}"]`)
      || document.querySelector(`.er-cell[data-slot="${slot}"] [data-free-kind="${kind}"]`);
    if (el) el.style.setProperty('--er-item-scale', String(item.scale));
  }

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

  function cloneText(t) {
    if (!t || typeof t !== 'object') return null;
    const scale = Number(t.scale);
    const out = {
      text: String(t.text != null ? t.text : 'Tu texto'),
      x: Math.min(92, Math.max(8, Number(t.x) || 50)),
      y: Math.min(92, Math.max(8, Number(t.y) || 50)),
      scale: Math.min(3, Math.max(0.4, Number.isFinite(scale) ? scale : 1)),
      style: clampTextStyle(t.style),
      color: clampTextColor(t.color),
    };
    if (Number.isFinite(Number(t.z))) out.z = Math.max(1, Math.min(50, Math.round(Number(t.z))));
    return out;
  }

  function defaultText() {
    return { text: 'Tu texto', x: 50, y: 50, scale: 1, style: 'solid', color: '#ffffff' };
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function normalizeGameSync(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const settingsKey = String(raw.settingsKey || '').trim();
    if (!settingsKey) return null;
    const uids = Array.isArray(raw.uids)
      ? raw.uids.map((u) => String(u || '')).slice(0, MAX_COUNT)
      : [];
    while (uids.length < MAX_COUNT) uids.push('');
    return {
      settingsKey,
      uids,
      templateId: String(raw.templateId || '').trim(),
    };
  }

  function clampZoom(z) {
    const n = Number(z);
    if (!Number.isFinite(n)) return 1;
    return Math.round(Math.max(0.5, Math.min(2, n)) * 100) / 100;
  }

  /** Escala global de imágenes centradas (no movimiento libre). */
  function clampImgScale(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return 1;
    return Math.round(Math.max(0.4, Math.min(1.6, v)) * 100) / 100;
  }

  const GIFT_POS = {
    tl: { x: 16, y: 16 },
    top: { x: 50, y: 16 },
    tr: { x: 84, y: 16 },
    left: { x: 16, y: 50 },
    center: { x: 50, y: 50 },
    right: { x: 84, y: 50 },
    bl: { x: 16, y: 84 },
    bottom: { x: 50, y: 84 },
    br: { x: 84, y: 84 },
  };

  function clampGiftScale(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return 1;
    return Math.round(Math.max(0.4, Math.min(2, v)) * 100) / 100;
  }

  function clampGiftPos(p) {
    const k = String(p || '').toLowerCase();
    return GIFT_POS[k] ? k : 'br';
  }

  function giftPosCenter(pos) {
    return GIFT_POS[clampGiftPos(pos)] || GIFT_POS.br;
  }

  function normalizeState(raw) {
    const st = {
      count: clampCount(raw?.count || 4),
      gap: raw?.gap !== false,
      spreadH: !!raw?.spreadH,
      fixedCellSize: !!raw?.fixedCellSize,
      gridN: clampGridN(raw?.gridN || 0),
      zoom: clampZoom(raw?.zoom ?? 1),
      imgScale: clampImgScale(raw?.imgScale ?? 1),
      giftScale: clampGiftScale(raw?.giftScale ?? 1),
      giftPos: clampGiftPos(raw?.giftPos || 'br'),
      frameMode: clampFrameMode(raw?.frameMode || 'off'),
      frameColor: clampTextColor(raw?.frameColor || '#25f4ee'),
      fondo: 'fondo-1',
      fondoCustomSrc: '',
      motion: clampMotion(raw?.motion || 'off'),
      textMotion: !!raw?.textMotion,
      overlays: emptySlots(),
      gifts: emptySlots(),
      texts: emptyTextSlots(),
      gameSync: null,
      filasSnap: null,
      freeMove: emptyFreeMove(),
      freeLayout: emptyFreeMove(),
    };
    // Con n° Filas, count puede ser < N×N (tras eliminar vacíos). No forzar N×N al cargar.
    if (typeof raw?.fondoCustomSrc === 'string' && raw.fondoCustomSrc) {
      st.fondoCustomSrc = raw.fondoCustomSrc;
    }
    if (raw?.fondo && FONDOS.some((f) => f.id === raw.fondo)) st.fondo = raw.fondo;
    else if (Array.isArray(raw?.slots) && raw.slots[0]) {
      st.fondo = fondoById(raw.slots[0]).id;
    }
    if (st.fondo === 'custom' && !st.fondoCustomSrc) st.fondo = 'fondo-1';
    if (Array.isArray(raw?.overlays)) {
      for (let i = 0; i < MAX_COUNT; i++) {
        const o = raw.overlays[i];
        if (o && typeof o.src === 'string' && o.src) {
          const item = { src: o.src, name: o.name || '' };
          if (Number.isFinite(Number(o.x))) item.x = clampPct(o.x);
          if (Number.isFinite(Number(o.y))) item.y = clampPct(o.y);
          if (Number.isFinite(Number(o.scale))) item.scale = clampItemScale(o.scale);
          if (Number.isFinite(Number(o.z))) item.z = Math.max(1, Math.min(50, Math.round(Number(o.z))));
          st.overlays[i] = item;
        }
      }
    }
    if (Array.isArray(raw?.gifts)) {
      for (let i = 0; i < MAX_COUNT; i++) {
        const o = raw.gifts[i];
        if (o && typeof o.src === 'string' && o.src) {
          let src = o.src;
          let type = o.type || 'gift';
          if (type === 'like' || /Like-Pop/i.test(src)) {
            type = 'like';
            src = CORNER_PRESETS.like.src;
          } else if (type === 'follow' || /er-follow\.(svg|png)/i.test(src)) {
            type = 'follow';
            src = CORNER_PRESETS.follow.src;
          } else if (type === 'superfan' || /er-superfan\.(svg|png)/i.test(src)) {
            type = 'superfan';
            src = CORNER_PRESETS.superfan.src;
          } else if (type === 'share' || /er-share\.(svg|png)/i.test(src)) {
            type = 'share';
            src = CORNER_PRESETS.share.src;
          }
          const name = o.name || CORNER_PRESETS[type]?.name || (type === 'gift' ? '' : type);
          const item = { src, name, type };
          if (type === 'gift' && o.giftId) item.giftId = String(o.giftId);
          if (Number.isFinite(Number(o.x))) item.x = clampPct(o.x);
          if (Number.isFinite(Number(o.y))) item.y = clampPct(o.y);
          if (Number.isFinite(Number(o.scale))) item.scale = clampItemScale(o.scale);
          if (Number.isFinite(Number(o.z))) item.z = Math.max(1, Math.min(50, Math.round(Number(o.z))));
          st.gifts[i] = item;
        }
      }
    }
    if (Array.isArray(raw?.texts)) {
      for (let i = 0; i < MAX_COUNT; i++) {
        st.texts[i] = normalizeTextList(raw.texts[i]);
      }
    }
    st.gameSync = normalizeGameSync(raw?.gameSync);
    st.filasSnap = normalizeFilasSnap(raw?.filasSnap);
    st.freeMove = emptyFreeMove();
    if (Array.isArray(raw?.freeMove)) {
      for (let i = 0; i < MAX_COUNT; i++) st.freeMove[i] = !!raw.freeMove[i];
    }
    st.freeLayout = emptyFreeMove();
    if (Array.isArray(raw?.freeLayout)) {
      for (let i = 0; i < MAX_COUNT; i++) st.freeLayout[i] = !!raw.freeLayout[i];
    }
    return st;
  }

  function normalizeFilasSnap(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const gridN = clampGridN(raw.gridN);
    if (!gridN) return null;
    const snap = {
      gridN,
      count: clampCount(raw.count != null ? raw.count : gridN * gridN),
      overlays: emptySlots(),
      gifts: emptySlots(),
      texts: emptyTextSlots(),
      freeMove: emptyFreeMove(),
      freeLayout: emptyFreeMove(),
      uids: null,
    };
    if (Array.isArray(raw.overlays)) {
      for (let i = 0; i < MAX_COUNT; i++) {
        snap.overlays[i] = cloneItem(raw.overlays[i]);
      }
    }
    if (Array.isArray(raw.gifts)) {
      for (let i = 0; i < MAX_COUNT; i++) {
        snap.gifts[i] = cloneItem(raw.gifts[i]);
      }
    }
    if (Array.isArray(raw.texts)) {
      for (let i = 0; i < MAX_COUNT; i++) {
        snap.texts[i] = normalizeTextList(raw.texts[i]);
      }
    }
    if (Array.isArray(raw.freeMove)) {
      for (let i = 0; i < MAX_COUNT; i++) snap.freeMove[i] = !!raw.freeMove[i];
    }
    if (Array.isArray(raw.freeLayout)) {
      for (let i = 0; i < MAX_COUNT; i++) snap.freeLayout[i] = !!raw.freeLayout[i];
    }
    if (Array.isArray(raw.uids)) {
      snap.uids = raw.uids.map((u) => String(u || '')).slice(0, MAX_COUNT);
      while (snap.uids.length < MAX_COUNT) snap.uids.push('');
    }
    if (Array.isArray(raw.autoMap)) {
      snap.autoMap = raw.autoMap.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n >= 0 && n < MAX_COUNT);
    } else {
      snap.autoMap = null;
    }
    return snap;
  }

  function buildFilasSnap(st) {
    const s = st || state;
    const gridN = clampGridN(s.gridN);
    if (!gridN) return s.filasSnap || null;
    return {
      gridN,
      count: clampCount(s.count),
      overlays: (s.overlays || []).map(cloneItem),
      gifts: (s.gifts || []).map(cloneItem),
      texts: (s.texts || []).map((cell) => normalizeTextList(cell)),
      freeMove: Array.isArray(s.freeMove) ? s.freeMove.map(Boolean).slice(0, MAX_COUNT) : emptyFreeMove(),
      freeLayout: Array.isArray(s.freeLayout) ? s.freeLayout.map(Boolean).slice(0, MAX_COUNT) : emptyFreeMove(),
      uids: s.gameSync?.uids
        ? s.gameSync.uids.map((u) => String(u || '')).slice(0, MAX_COUNT)
        : null,
      autoMap: Array.isArray(s.filasSnap?.autoMap) ? s.filasSnap.autoMap.slice() : null,
    };
  }

  /** Índices de Filas que pasan a Automática al compactar (antes del compact). */
  function buildFilasAutoMap() {
    const map = [];
    for (let i = 0; i < MAX_COUNT; i++) {
      if (slotHasContent(i)) map.push(i);
    }
    return map;
  }

  /**
   * En Automática, empuja ediciones (texto, regalo, tamaño, layout libre…) al snapshot de Filas
   * y también agrega cuadros nuevos / quita los borrados en Automática.
   */
  function syncFilasSnapFromCurrent(st) {
    const s = st || state;
    if (clampGridN(s.gridN)) return; // en Filas ya se actualiza con buildFilasSnap
    const prev = s.filasSnap;
    if (!prev || !clampGridN(prev.gridN)) return;
    const snap = normalizeFilasSnap(prev);
    if (!snap) return;

    if (s.gameSync?.uids && !snap.uids) {
      snap.uids = Array.from({ length: MAX_COUNT }, () => '');
    }

    const clearSnapSlot = (j) => {
      if (!Number.isFinite(j) || j < 0 || j >= MAX_COUNT) return;
      snap.overlays[j] = null;
      snap.gifts[j] = null;
      snap.texts[j] = [];
      snap.freeMove[j] = false;
      snap.freeLayout[j] = false;
      if (snap.uids) snap.uids[j] = '';
    };

    const copyAutoToSnap = (i, j) => {
      snap.overlays[j] = cloneItem(s.overlays[i]);
      snap.gifts[j] = cloneItem(s.gifts[i]);
      snap.texts[j] = normalizeTextList(s.texts[i]);
      snap.freeMove[j] = !!(s.freeMove && s.freeMove[i]);
      snap.freeLayout[j] = !!(s.freeLayout && s.freeLayout[i]);
      if (snap.uids && s.gameSync?.uids) {
        snap.uids[j] = String(s.gameSync.uids[i] || '');
      }
    };

    const snapHas = (j) => {
      if (snap.overlays[j] && String(snap.overlays[j].src || '').trim()) return true;
      if (snap.gifts[j] && String(snap.gifts[j].src || '').trim()) return true;
      return normalizeTextList(snap.texts[j]).some((t) => String(t?.text || '').trim());
    };

    const claimedAuto = new Set();
    const claimedSnap = new Set();
    const autoToSnap = [];
    const map = Array.isArray(prev.autoMap) ? prev.autoMap.slice() : [];

    // Índice UID → slot Filas (antes de limpiar, para no perder el mapeo)
    const destByUid = new Map();
    if (snap.uids) {
      for (let j = 0; j < MAX_COUNT; j++) {
        const u = String(snap.uids[j] || '').trim();
        if (u) destByUid.set(u, j);
      }
    }

    // Limpiar slots que venían de Automática (así un borrado en Automática no revive en Filas)
    for (const jRaw of map) {
      const j = Number(jRaw);
      if (Number.isFinite(j)) clearSnapSlot(j);
    }

    // 1) Por UID (juego vinculado)
    const curUids = s.gameSync?.uids;
    if (curUids && destByUid.size) {
      for (let i = 0; i < s.count; i++) {
        const u = String(curUids[i] || '').trim();
        if (!u || !destByUid.has(u)) continue;
        const j = destByUid.get(u);
        copyAutoToSnap(i, j);
        claimedAuto.add(i);
        claimedSnap.add(j);
        autoToSnap[i] = j;
      }
    }

    // 2) Por autoMap (mapeo al compactar Automática)
    for (let i = 0; i < map.length && i < s.count; i++) {
      if (claimedAuto.has(i)) continue;
      const j = Number(map[i]);
      if (!Number.isFinite(j) || j < 0 || j >= MAX_COUNT) continue;
      if (claimedSnap.has(j)) continue;
      copyAutoToSnap(i, j);
      claimedAuto.add(i);
      claimedSnap.add(j);
      autoToSnap[i] = j;
    }

    // 3) Fallback por índice para los que faltan (sin pisar snap ya reclamados)
    for (let i = 0; i < Math.min(s.count, snap.count); i++) {
      if (claimedAuto.has(i)) continue;
      if (claimedSnap.has(i)) continue;
      copyAutoToSnap(i, i);
      claimedAuto.add(i);
      claimedSnap.add(i);
      autoToSnap[i] = i;
    }

    const findFreeSnapSlot = () => {
      for (let j = 0; j < Math.max(snap.count, 0); j++) {
        if (claimedSnap.has(j)) continue;
        if (!snapHas(j)) return j;
      }
      for (let j = 0; j < MAX_COUNT; j++) {
        if (claimedSnap.has(j)) continue;
        if (!snapHas(j)) return j;
      }
      return -1;
    };

    // 4) Cuadros nuevos en Automática (no estaban en Filas)
    for (let i = 0; i < s.count; i++) {
      if (claimedAuto.has(i)) continue;
      const j = findFreeSnapSlot();
      if (j < 0) break;
      copyAutoToSnap(i, j);
      claimedAuto.add(i);
      claimedSnap.add(j);
      autoToSnap[i] = j;
    }

    // Ajustar count del snapshot para incluir lo nuevo
    let maxIdx = -1;
    for (let j = 0; j < MAX_COUNT; j++) {
      if (claimedSnap.has(j) || snapHas(j)) maxIdx = j;
    }
    const g = clampGridN(snap.gridN) || 1;
    const full = g * g;
    const need = Math.max(1, maxIdx + 1);
    // Si la rejilla estaba “llena” N×N, crecer al menos al full o al contenido
    if (prev.count >= full) {
      snap.count = clampCount(Math.max(full, need));
    } else {
      snap.count = clampCount(Math.max(need, Math.min(prev.count, full)));
      // Si hay más contenido que el count anterior (se agregó cuadro), crecer
      if (need > snap.count) snap.count = clampCount(need);
    }

    // Actualizar autoMap para el próximo viaje Automática ↔ Filas
    const newMap = [];
    for (let i = 0; i < s.count; i++) {
      if (Number.isFinite(autoToSnap[i])) newMap.push(autoToSnap[i]);
    }
    snap.autoMap = newMap;
    s.filasSnap = snap;
  }

  function applyFilasSnap(snap) {
    const s = normalizeFilasSnap(snap);
    if (!s) return false;
    state.gridN = s.gridN;
    state.count = s.count;
    state.overlays = s.overlays;
    state.gifts = s.gifts;
    state.texts = s.texts;
    state.freeMove = s.freeMove || emptyFreeMove();
    state.freeLayout = s.freeLayout || emptyFreeMove();
    if (s.uids && state.gameSync) {
      state.gameSync.uids = s.uids.slice();
      while (state.gameSync.uids.length < MAX_COUNT) state.gameSync.uids.push('');
    }
    state.filasSnap = buildFilasSnap(state);
    if (state.filasSnap && Array.isArray(s.autoMap)) state.filasSnap.autoMap = s.autoMap.slice();
    selectedSlot = null;
    selectedText = null;
    selectedFreeItem = null;
    if (moveFrom && moveFrom.slot >= state.count) cancelPick();
    return true;
  }

  function loadState() {
    for (const key of [STORAGE_KEY, 'livecoins_editor_rapido_v9', 'livecoins_editor_rapido_v8', 'livecoins_editor_rapido_v7', 'livecoins_editor_rapido_v6', 'livecoins_editor_rapido_v5', 'livecoins_editor_rapido_v4', 'livecoins_editor_rapido_v3', 'livecoins_editor_rapido_v2', 'livecoins_editor_rapido_v1']) {
      try {
        const raw = JSON.parse(localStorage.getItem(key) || 'null');
        if (raw && typeof raw === 'object') return normalizeState(raw);
      } catch {}
    }
    return null;
  }
  function saveState(st, opts) {
    // Mientras estás en n° Filas, cada cambio actualiza el snapshot para poder volver tal cual.
    if (clampGridN(st.gridN)) {
      st.filasSnap = buildFilasSnap(st);
    } else {
      // En Automática: reflejar ediciones (texto, regalo, tamaño…) en el snapshot de Filas
      syncFilasSnapFromCurrent(st);
    }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(st));
    } catch {
      // Quota: no borrar imágenes que siguen en el montaje. Subir a disco y reintentar.
      schedulePersistMediaAndSave();
      // Hasta que la subida termine el diseño solo existe en memoria: hay que avisar
      // o el usuario cierra el panel creyendo que quedó guardado.
      if (Date.now() - lastQuotaWarnAt > 20000) {
        lastQuotaWarnAt = Date.now();
        toastMsg('Almacenamiento lleno: subiendo las imágenes al disco. No cierres el panel hasta que termine.');
      }
    }
    if (!opts?.skipHistory) pushHistory();
    markEdited();
    schedulePublishLive();
    scheduleAutosaveTemplate();
  }

  const TPL_STORAGE_KEY = 'livecoins_er_templates_v1';
  const TPL_ACTIVE_KEY = 'livecoins_er_active_tpl_v1';
  const LIVE_BC = 'livecoins-editor-rapido';
  let activeTplId = '';
  try { activeTplId = String(localStorage.getItem(TPL_ACTIVE_KEY) || ''); } catch {}
  let livePublishTimer = null;
  let liveHeartbeatTimer = null;
  let persistMediaSaveTimer = null;
  let lastErLiveWarnAt = 0;
  let lastQuotaWarnAt = 0;
  /* data: que ya fallaron al subir: no reintentar ni avisar en cada heartbeat. */
  const erMediaFailKeys = new Set();
  let erMediaFailWarned = false;

  function erMediaKey(src) {
    const s = String(src || '');
    if (s.length < 40) return s;
    return `${s.length}:${s.slice(0, 48)}:${s.slice(-24)}`;
  }
  let livePublishInFlight = false;
  let livePublishAgain = false;
  let liveChannel = null;
  try { liveChannel = new BroadcastChannel(LIVE_BC); } catch {}
  /** @type {Array<{id:string,name:string,protected:boolean,savedAt:number,data:any}>|null} */
  let templatesCache = null;
  let templatesLoadPromise = null;
  let tplAutosaveTimer = null;
  let tplAutosavePaused = 0;

  /* === ER_PRO_FEATURES_START === */
  const HISTORY_MAX = 40;
  let historyStack = [];
  let historyIndex = -1;
  let historyLocked = false;
  let lastEditAt = 0;
  let selectedSlot = null;
  let slotDrag = null;

  function erViewActive() {
    return !!document.getElementById('view-editor-rapido')?.classList.contains('active');
  }

  function erTypingTarget(el) {
    if (!el) return false;
    const tag = (el.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable;
  }

  function refreshAllErUi() {
    try { renderLibrary(); } catch {}
    renderCountControls();
    renderGapToggle();
    renderSpreadToggle();
    renderCellSizeToggle();
    renderMotionControl();
    renderFrameControls();
    renderPickBar();
    renderGrid();
    renderTplSelect();
    updateUndoRedoBtns();
    updateTplActiveLine();
    applyCanvasZoom();
  }

  function pushHistory() {
    if (historyLocked) return;
    const snap = JSON.stringify(snapshotState(state));
    if (historyIndex >= 0 && historyStack[historyIndex] === snap) return;
    historyStack = historyStack.slice(0, historyIndex + 1);
    historyStack.push(snap);
    if (historyStack.length > HISTORY_MAX) historyStack.shift();
    historyIndex = historyStack.length - 1;
    updateUndoRedoBtns();
  }

  function undoEr() {
    if (historyIndex <= 0) return;
    historyLocked = true;
    historyIndex -= 1;
    try {
      state = normalizeState(JSON.parse(historyStack[historyIndex]));
      saveState(state, { skipHistory: true });
      refreshAllErUi();
      toastMsg('Deshecho');
    } finally {
      historyLocked = false;
      updateUndoRedoBtns();
    }
  }

  function redoEr() {
    if (historyIndex < 0 || historyIndex >= historyStack.length - 1) return;
    historyLocked = true;
    historyIndex += 1;
    try {
      state = normalizeState(JSON.parse(historyStack[historyIndex]));
      saveState(state, { skipHistory: true });
      refreshAllErUi();
      toastMsg('Rehecho');
    } finally {
      historyLocked = false;
      updateUndoRedoBtns();
    }
  }

  function updateUndoRedoBtns() {
    const u = document.getElementById('er-undo');
    const r = document.getElementById('er-redo');
    if (u) u.disabled = historyIndex <= 0;
    if (r) r.disabled = historyIndex < 0 || historyIndex >= historyStack.length - 1;
  }

  function markEdited() {
    lastEditAt = Date.now();
    updateTplActiveLine();
  }

  function formatEditAgo(ms) {
    if (!ms) return '';
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 3) return 'ahora';
    if (s < 60) return 'hace ' + s + ' s';
    const m = Math.floor(s / 60);
    if (m < 60) return 'hace ' + m + ' min';
    return 'hace ' + Math.floor(m / 60) + ' h';
  }

  function updateTplActiveLine() {
    const el = document.getElementById('er-tpl-active-line');
    if (!el) return;
    const id = activeTemplateId();
    const nameEl = document.getElementById('er-tpl-name');
    const name = String(nameEl?.value || '').trim()
      || (getTemplatesSync().find((t) => t.id === id)?.name || '');
    const ago = lastEditAt ? formatEditAgo(lastEditAt) : '';
    if (!id) {
      el.textContent = ago ? ('Borrador · editado ' + ago) : 'Sin plantilla abierta';
      return;
    }
    el.textContent = ago
      ? ('Activa: ' + (name || id) + ' · última edición ' + ago)
      : ('Activa: ' + (name || id));
  }

  function setSelectedSlot(i) {
    const n = Number(i);
    selectedSlot = Number.isFinite(n) && n >= 0 && n < state.count ? n : null;
    document.querySelectorAll('.er-cell.is-slot-selected').forEach((el) => el.classList.remove('is-slot-selected'));
    if (selectedSlot != null) {
      document.querySelector('.er-cell[data-slot="' + selectedSlot + '"]')?.classList.add('is-slot-selected');
    }
  }

  function clearSlotContents(slot) {
    const i = Number(slot);
    if (!Number.isFinite(i) || i < 0 || i >= state.count) return;
    state.overlays[i] = null;
    state.gifts[i] = null;
    state.texts[i] = [];
    if (state.gameSync?.uids) state.gameSync.uids[i] = '';
    // Sin contenido, el modo libre dejaría el cuadro vacío sin poder reordenarse.
    if (state.freeMove) state.freeMove[i] = false;
    if (state.freeLayout) state.freeLayout[i] = false;
    if (selectedFreeItem?.slot === i) selectedFreeItem = null;
    if (textEditing?.slot === i) textEditing = null;
    if (selectedText?.slot === i) selectedText = null;
    saveState(state);
    renderGrid();
    toastMsg('Cuadro ' + (i + 1) + ' vaciado');
  }

  function slotHasContent(i) {
    const o = state.overlays?.[i];
    const g = state.gifts?.[i];
    if (o && String(o.src || '').trim()) return true;
    if (g && String(g.src || '').trim()) return true;
    return textsAt(i).some((t) => String(t?.text || '').trim());
  }

  /** Empaqueta cuadros con contenido.
   *  keepGridN: deja la columna fija (ej. 8) y solo quita vacíos visibles; no pasa a Automática.
   *  Sin keepGridN (Automática): mira todo MAX_COUNT y recupera lo oculto por una N×N más chica. */
  function compactToUsedSlots(opts = {}) {
    const keepGridN = !!opts.keepGridN && !!clampGridN(state.gridN);
    const keptGrid = keepGridN ? clampGridN(state.gridN) : 0;
    const scanEnd = keepGridN ? Math.max(0, state.count) : MAX_COUNT;

    const used = [];
    for (let i = 0; i < scanEnd; i++) {
      if (slotHasContent(i)) used.push(i);
    }

    const newOverlays = emptySlots();
    const newGifts = emptySlots();
    const newTexts = emptyTextSlots();
    const newFree = emptyFreeMove();
    const newFreeLayout = emptyFreeMove();
    const newUids = state.gameSync?.uids
      ? Array.from({ length: MAX_COUNT }, () => '')
      : null;

    used.forEach((src, dest) => {
      newOverlays[dest] = cloneItem(state.overlays[src]);
      newGifts[dest] = cloneItem(state.gifts[src]);
      newTexts[dest] = textsAt(src).map((t) => cloneText(t)).filter(Boolean);
      newFree[dest] = !!(state.freeMove && state.freeMove[src]);
      newFreeLayout[dest] = !!(state.freeLayout && state.freeLayout[src]);
      if (newUids && state.gameSync?.uids) newUids[dest] = String(state.gameSync.uids[src] || '');
    });

    // Si solo limpiamos la vista fija, no tocar imágenes guardadas fuera de esa rejilla.
    if (keepGridN) {
      for (let i = scanEnd; i < MAX_COUNT; i++) {
        newOverlays[i] = cloneItem(state.overlays[i]);
        newGifts[i] = cloneItem(state.gifts[i]);
        newTexts[i] = textsAt(i).map((t) => cloneText(t)).filter(Boolean);
        newFree[i] = !!(state.freeMove && state.freeMove[i]);
        newFreeLayout[i] = !!(state.freeLayout && state.freeLayout[i]);
        if (newUids && state.gameSync?.uids) newUids[i] = String(state.gameSync.uids[i] || '');
      }
    }

    state.overlays = newOverlays;
    state.gifts = newGifts;
    state.texts = newTexts;
    state.freeMove = newFree;
    state.freeLayout = newFreeLayout;
    if (newUids && state.gameSync) state.gameSync.uids = newUids;
    state.count = clampCount(used.length || MIN_COUNT);
    state.gridN = keptGrid;
    selectedSlot = null;
    selectedText = null;
    selectedFreeItem = null;
    textEditing = null;
    if (moveFrom && moveFrom.slot >= state.count) cancelPick();
    return used.length;
  }

  function removeSlotCompletely(slot) {
    const i = Number(slot);
    if (!Number.isFinite(i) || i < 0 || i >= state.count) return;
    if (state.count <= MIN_COUNT) {
      clearSlotContents(i);
      toastMsg('Mínimo 1 cuadro — se vació el contenido');
      return;
    }
    for (let j = i; j < state.count - 1; j++) {
      state.overlays[j] = state.overlays[j + 1];
      state.gifts[j] = state.gifts[j + 1];
      state.texts[j] = state.texts[j + 1] || [];
      if (state.freeMove) state.freeMove[j] = !!state.freeMove[j + 1];
      if (state.freeLayout) state.freeLayout[j] = !!state.freeLayout[j + 1];
      if (state.gameSync?.uids) {
        state.gameSync.uids[j] = state.gameSync.uids[j + 1] || '';
      }
    }
    const last = state.count - 1;
    state.overlays[last] = null;
    state.gifts[last] = null;
    state.texts[last] = [];
    if (state.freeMove) state.freeMove[last] = false;
    if (state.freeLayout) state.freeLayout[last] = false;
    if (state.gameSync?.uids) state.gameSync.uids[last] = '';
    state.count = clampCount(state.count - 1);
    // Mantener columnas fijas si estaba en Fija N×N
    if (selectedSlot === i) selectedSlot = null;
    else if (selectedSlot != null && selectedSlot > i) selectedSlot -= 1;
    remapSelectionAfterRemoval(i);
    if (moveFrom) {
      if (moveFrom.slot === i) cancelPick();
      else if (moveFrom.slot > i) moveFrom = { ...moveFrom, slot: moveFrom.slot - 1 };
    }
    saveState(state);
    renderCountControls();
    renderGrid();
    toastMsg('Cuadro eliminado');
  }

  function countEmptySlots() {
    let n = 0;
    for (let i = 0; i < state.count; i++) {
      if (!slotHasContent(i)) n += 1;
    }
    return n;
  }

  function countHiddenContentSlots() {
    let n = 0;
    for (let i = state.count; i < MAX_COUNT; i++) {
      if (slotHasContent(i)) n += 1;
    }
    return n;
  }

  /** Acciones de Juegos que quedan fuera de la rejilla visible: siguen ligadas
      pero no se pueden ver ni editar hasta agrandar las filas. */
  function countHiddenLinkedSlots() {
    const uids = state.gameSync?.uids;
    if (!uids) return 0;
    let n = 0;
    for (let i = state.count; i < MAX_COUNT; i++) {
      if (String(uids[i] || '')) n += 1;
    }
    return n;
  }

  function hiddenSlotsNote() {
    const linked = countHiddenLinkedSlots();
    return linked ? ` (${linked} con acción ligada)` : '';
  }

  function removeEmptySlots() {
    const fixed = clampGridN(state.gridN);
    const empty = countEmptySlots();
    const hidden = countHiddenContentSlots();
    if (!empty && !(hidden && !fixed)) {
      toastMsg('No hay cuadros vacíos');
      return;
    }
    const before = state.count;
    const kept = compactToUsedSlots({ keepGridN: !!fixed });
    saveState(state);
    renderCountControls();
    renderGrid();
    const removed = Math.max(0, before - state.count);
    if (fixed) {
      toastMsg(
        removed
          ? `Sin vacíos · ${kept} cuadros en filas de ${fixed}`
          : `Filas de ${fixed} · ${kept} cuadros`
      );
    } else {
      toastMsg(
        removed
          ? `Eliminados ${removed} cuadro${removed === 1 ? '' : 's'} vacío${removed === 1 ? '' : 's'}`
          : 'Cuadros vacíos eliminados'
      );
    }
  }

  function duplicateSlot(fromSlot) {
    const src = fromSlot != null ? Number(fromSlot) : selectedSlot;
    if (src == null || src < 0 || src >= state.count) {
      toastMsg('Elige un cuadro (clic o teclas 1–9)');
      return;
    }
    let dest = -1;
    for (let i = 0; i < state.count; i++) {
      if (i === src) continue;
      const empty = !state.overlays[i] && !state.gifts[i] && !textsAt(i).length;
      if (empty) { dest = i; break; }
    }
    if (dest < 0) {
      if (state.count >= MAX_COUNT) {
        toastMsg('No hay espacio para duplicar');
        return;
      }
      state.count = clampCount(state.count + 1);
      dest = state.count - 1;
    }
    state.overlays[dest] = state.overlays[src] ? { ...state.overlays[src] } : null;
    state.gifts[dest] = state.gifts[src] ? { ...state.gifts[src] } : null;
    state.texts[dest] = textsAt(src).map((t) => ({ ...t }));
    if (!state.freeMove) state.freeMove = emptyFreeMove();
    if (!state.freeLayout) state.freeLayout = emptyFreeMove();
    state.freeMove[dest] = !!state.freeMove[src];
    state.freeLayout[dest] = !!state.freeLayout[src];
    if (state.gameSync?.uids) state.gameSync.uids[dest] = '';
    saveState(state);
    renderCountControls();
    renderGrid();
    setSelectedSlot(dest);
    toastMsg('Cuadro ' + (src + 1) + ' → ' + (dest + 1));
  }

  function swapSlots(a, b) {
    if (a === b || a < 0 || b < 0 || a >= state.count || b >= state.count) return;
    const o = state.overlays[a]; state.overlays[a] = state.overlays[b]; state.overlays[b] = o;
    const g = state.gifts[a]; state.gifts[a] = state.gifts[b]; state.gifts[b] = g;
    const t = state.texts[a]; state.texts[a] = state.texts[b]; state.texts[b] = t;
    if (state.freeMove) {
      const f = state.freeMove[a];
      state.freeMove[a] = state.freeMove[b];
      state.freeMove[b] = f;
    }
    if (state.freeLayout) {
      const fl = state.freeLayout[a];
      state.freeLayout[a] = state.freeLayout[b];
      state.freeLayout[b] = fl;
    }
    if (state.gameSync?.uids) {
      const u = state.gameSync.uids[a];
      state.gameSync.uids[a] = state.gameSync.uids[b];
      state.gameSync.uids[b] = u;
    }
    remapSelectionAfterSwap(a, b);
  }

  /* Las selecciones guardan el índice del cuadro. Si los cuadros se mueven o se
     borran hay que recolocarlas: si no, Suprimir o redimensionar actúan sobre
     el contenido de otro cuadro. */
  function remapSelectionSlots(fn) {
    const map = (sel) => {
      if (!sel || sel.slot == null) return sel;
      const next = fn(Number(sel.slot));
      return next == null ? null : (next === sel.slot ? sel : { ...sel, slot: next });
    };
    selectedText = map(selectedText);
    selectedFreeItem = map(selectedFreeItem);
    textEditing = map(textEditing);
  }

  function remapSelectionAfterSwap(a, b) {
    remapSelectionSlots((slot) => (slot === a ? b : (slot === b ? a : slot)));
  }

  function remapSelectionAfterRemoval(i) {
    remapSelectionSlots((slot) => (slot === i ? null : (slot > i ? slot - 1 : slot)));
  }

  function clearSelectionOutOfRange() {
    remapSelectionSlots((slot) => ((slot < 0 || slot >= state.count) ? null : slot));
    if (selectedSlot != null && (selectedSlot < 0 || selectedSlot >= state.count)) selectedSlot = null;
  }

  function alignSelectedText(mode) {
    const slot = selectedText?.slot ?? selectedSlot;
    const idx = selectedText?.idx ?? 0;
    if (slot == null) {
      toastMsg('Selecciona un texto o un cuadro con texto');
      return;
    }
    const list = textsAt(slot);
    if (!list.length) {
      toastMsg('Ese cuadro no tiene texto');
      return;
    }
    const ti = Math.min(idx, list.length - 1);
    const t = { ...list[ti] };
    if (mode === 'center') { t.x = 50; t.y = 50; }
    else if (mode === 'top') { t.x = 50; t.y = 14; }
    else if (mode === 'br') { t.x = 82; t.y = 82; }
    else if (mode === 'bl') { t.x = 18; t.y = 82; }
    else if (mode === 'tr') { t.x = 82; t.y = 18; }
    list[ti] = t;
    setTextsAt(slot, list);
    selectedText = { slot, idx: ti };
    saveState(state);
    renderGrid();
  }

  function applyCanvasZoom() {
    const z = clampZoom(state.zoom);
    state.zoom = z;
    const zoomEl = document.getElementById('er-canvas-zoom');
    const label = document.getElementById('er-zoom-label');
    if (zoomEl) zoomEl.style.transform = 'scale(' + z + ')';
    if (label) label.textContent = Math.round(z * 100) + '%';
  }

  function setCanvasZoom(z) {
    state.zoom = clampZoom(z);
    applyCanvasZoom();
    saveState(state);
  }

  function applyImgScaleUi() {
    const s = clampImgScale(state.imgScale);
    state.imgScale = s;
    const grid = document.getElementById('er-grid');
    if (grid) grid.style.setProperty('--er-fg-scale', String(s));
    const label = document.getElementById('er-img-scale-label');
    if (label) label.textContent = Math.round(s * 100) + '%';
    const range = document.getElementById('er-img-scale');
    if (range) {
      const pct = Math.round(s * 100);
      if (Number(range.value) !== pct) range.value = String(pct);
    }
  }

  function setImgScale(n, opts) {
    state.imgScale = clampImgScale(n);
    applyImgScaleUi();
    if (!opts?.skipSave) saveState(state);
  }

  function applyGiftUi() {
    const s = clampGiftScale(state.giftScale);
    const pos = clampGiftPos(state.giftPos);
    state.giftScale = s;
    state.giftPos = pos;
    const grid = document.getElementById('er-grid');
    if (grid) {
      grid.style.setProperty('--er-gift-scale', String(s));
      grid.dataset.erGiftPos = pos;
    }
    const label = document.getElementById('er-gift-scale-label');
    if (label) label.textContent = Math.round(s * 100) + '%';
    const range = document.getElementById('er-gift-scale');
    if (range) {
      const pct = Math.round(s * 100);
      if (Number(range.value) !== pct) range.value = String(pct);
    }
    document.querySelectorAll('#er-gift-pos-tools [data-er-gift-pos]').forEach((btn) => {
      btn.classList.toggle('is-on', btn.dataset.erGiftPos === pos);
    });
  }

  function setGiftScale(n, opts) {
    state.giftScale = clampGiftScale(n);
    applyGiftUi();
    if (!opts?.skipSave) saveState(state);
  }

  function setGiftPos(pos, opts) {
    state.giftPos = clampGiftPos(pos);
    applyGiftUi();
    if (!opts?.skipSave) saveState(state);
  }

  function loadImageEl(src, timeoutMs) {
    return new Promise((resolve) => {
      if (!src) return resolve(null);
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        clearTimeout(tid);
        resolve(v);
      };
      const tid = setTimeout(() => finish(null), Math.max(1500, timeoutMs || 8000));
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => finish(img);
      img.onerror = () => finish(null);
      try { img.src = src; } catch { finish(null); }
    });
  }

  function erYieldToUi() {
    return new Promise((r) => setTimeout(r, 0));
  }

  function erWithTimeout(promise, ms, errMsg) {
    let tid;
    const timeout = new Promise((_, rej) => {
      tid = setTimeout(() => rej(new Error(errMsg || 'timeout')), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(tid));
  }

  let erGifToolsPromise = null;
  function loadErGifTools() {
    if (!erGifToolsPromise) {
      erGifToolsPromise = erWithTimeout(
        Promise.all([
          import('/js/lib/gifenc.esm.js'),
          import('/js/lib/gifuct.esm.js'),
        ]),
        12000,
        'gif-libs-timeout',
      ).then(([enc, decMod]) => {
        const dec = decMod.default || decMod;
        if (!enc?.GIFEncoder || !enc?.quantize || !enc?.applyPalette) {
          throw new Error('gifenc incompleto');
        }
        if (!dec?.parseGIF || !dec?.decompressFrames) {
          throw new Error('gifuct incompleto');
        }
        return {
          GIFEncoder: enc.GIFEncoder,
          quantize: enc.quantize,
          applyPalette: enc.applyPalette,
          parseGIF: dec.parseGIF,
          decompressFrames: dec.decompressFrames,
        };
      }).catch((err) => {
        erGifToolsPromise = null;
        throw err;
      });
    }
    return erGifToolsPromise;
  }

  function erSampleKeyframes(keys, tSec, period) {
    const p = period > 0 ? (((tSec % period) + period) % period) / period : 0;
    for (let i = 0; i < keys.length - 1; i++) {
      const a = keys[i];
      const b = keys[i + 1];
      if (p >= a.p && p <= b.p) {
        const u = (b.p - a.p) < 1e-9 ? 0 : (p - a.p) / (b.p - a.p);
        return a.v + (b.v - a.v) * u;
      }
    }
    return keys[keys.length - 1]?.v ?? 0;
  }

  /** Offsets como las animaciones CSS del grid (float/bounce/pulse/shake). */
  function erMotionOffset(mot, tMs, boxW, boxH) {
    if (!mot || mot === 'off') return { dx: 0, dy: 0, scale: 1, rot: 0 };
    const t = (tMs || 0) / 1000;
    const h = Math.max(1, boxH || 1);
    const w = Math.max(1, boxW || 1);
    if (mot === 'float') {
      const dy = erSampleKeyframes(
        [{ p: 0, v: 0 }, { p: 0.5, v: -0.08 }, { p: 1, v: 0 }],
        t, 2.6,
      ) * h;
      return { dx: 0, dy, scale: 1, rot: 0 };
    }
    if (mot === 'bounce') {
      const dy = erSampleKeyframes(
        [{ p: 0, v: 0 }, { p: 0.4, v: -0.12 }, { p: 0.6, v: -0.05 }, { p: 1, v: 0 }],
        t, 1.1,
      ) * h;
      return { dx: 0, dy, scale: 1, rot: 0 };
    }
    if (mot === 'pulse') {
      const scale = erSampleKeyframes(
        [{ p: 0, v: 1 }, { p: 0.5, v: 1.08 }, { p: 1, v: 1 }],
        t, 1.4,
      );
      return { dx: 0, dy: 0, scale, rot: 0 };
    }
    if (mot === 'shake') {
      const dx = erSampleKeyframes(
        [{ p: 0, v: 0 }, { p: 0.25, v: -0.03 }, { p: 0.75, v: 0.03 }, { p: 1, v: 0 }],
        t, 0.55,
      ) * w;
      const rotDeg = erSampleKeyframes(
        [{ p: 0, v: 0 }, { p: 0.25, v: -2 }, { p: 0.75, v: 2 }, { p: 1, v: 0 }],
        t, 0.55,
      );
      return { dx, dy: 0, scale: 1, rot: rotDeg * Math.PI / 180 };
    }
    return { dx: 0, dy: 0, scale: 1, rot: 0 };
  }

  function expandErGifFrames(tools, arrayBuffer, opts) {
    const maxFrames = Math.max(2, Math.min(24, opts?.maxFrames || 16));
    const maxSide = Math.max(64, Math.min(384, opts?.maxSide || 256));
    try {
      const gif = tools.parseGIF(arrayBuffer);
      const frames = tools.decompressFrames(gif, true);
      if (!frames.length) return [];
      const w0 = Math.max(1, gif.lsd.width || frames[0].dims.width || 1);
      const h0 = Math.max(1, gif.lsd.height || frames[0].dims.height || 1);
      const scale = Math.min(1, maxSide / Math.max(w0, h0));
      const w = Math.max(1, Math.round(w0 * scale));
      const h = Math.max(1, Math.round(h0 * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const temp = document.createElement('canvas');
      const out = [];
      let prevDisposal = 0;
      let saved = null;
      const limit = Math.min(frames.length, maxFrames);
      for (let i = 0; i < limit; i++) {
        const frame = frames[i];
        if (i === 0) ctx.clearRect(0, 0, w, h);
        else if (prevDisposal === 2) ctx.clearRect(0, 0, w, h);
        else if (prevDisposal === 3 && saved) ctx.putImageData(saved, 0, 0);
        if (frame.disposalType === 3) {
          try { saved = ctx.getImageData(0, 0, w, h); } catch { saved = null; }
        }
        const fw = Math.max(1, frame.dims.width || 1);
        const fh = Math.max(1, frame.dims.height || 1);
        temp.width = fw;
        temp.height = fh;
        const tctx = temp.getContext('2d');
        const imageData = tctx.createImageData(fw, fh);
        imageData.data.set(frame.patch);
        tctx.putImageData(imageData, 0, 0);
        ctx.drawImage(
          temp,
          Math.round((frame.dims.left || 0) * scale),
          Math.round((frame.dims.top || 0) * scale),
          Math.round(fw * scale),
          Math.round(fh * scale),
        );
        const snap = document.createElement('canvas');
        snap.width = w;
        snap.height = h;
        snap.getContext('2d').drawImage(canvas, 0, 0);
        out.push({ canvas: snap, delay: Math.max(40, Math.min(400, frame.delay || 100)) });
        prevDisposal = frame.disposalType;
      }
      return out;
    } catch {
      return [];
    }
  }

  function erFrameAtTime(frames, tMs) {
    if (!frames?.length) return null;
    const total = frames.reduce((s, f) => s + f.delay, 0) || 1;
    let t = ((tMs % total) + total) % total;
    for (const f of frames) {
      if (t < f.delay) return f.canvas;
      t -= f.delay;
    }
    return frames[frames.length - 1].canvas;
  }

  const erAnimCache = new Map();

  async function loadErAnimOrStatic(tools, src, opts) {
    if (!src) return { kind: 'none' };
    const s = String(src);
    const allowAnim = !!(tools && opts?.allowAnim !== false);
    const cacheKey = (allowAnim ? 'a:' : 's:') + s;
    if (erAnimCache.has(cacheKey)) return erAnimCache.get(cacheKey);

    const looksGif = /\.gif(\?|#|$)/i.test(s) || /image\/gif/i.test(s) || s.startsWith('data:image/gif');
    if (looksGif && allowAnim) {
      try {
        const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
        const fetchP = fetch(s, {
          credentials: 'same-origin',
          signal: ctrl?.signal,
        });
        const r = await erWithTimeout(fetchP, opts?.fetchMs || 6000, 'gif-fetch-timeout').catch((e) => {
          try { ctrl?.abort(); } catch {}
          throw e;
        });
        if (r && r.ok) {
          const buf = await erWithTimeout(r.arrayBuffer(), 8000, 'gif-buffer-timeout');
          if (buf && buf.byteLength > 0 && buf.byteLength < 12 * 1024 * 1024) {
            const frames = expandErGifFrames(tools, buf, {
              maxFrames: opts?.maxFrames || 12,
              maxSide: opts?.maxSide || 220,
            });
            if (frames.length > 1) {
              const out = { kind: 'gif', frames };
              erAnimCache.set(cacheKey, out);
              return out;
            }
            if (frames.length === 1) {
              const out = { kind: 'static', img: frames[0].canvas };
              erAnimCache.set(cacheKey, out);
              return out;
            }
          }
        }
      } catch { /* caer a estático */ }
    }
    const img = await loadImageEl(s, opts?.imgMs || 6000);
    const out = img ? { kind: 'static', img } : { kind: 'none' };
    erAnimCache.set(cacheKey, out);
    return out;
  }

  function erDrawRoundedRect(ctx, x, y, w, h, rr) {
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  function erSourceBitmap(entry, tMs) {
    if (!entry || entry.kind === 'none') return null;
    try {
      if (entry.kind === 'gif') return erFrameAtTime(entry.frames, tMs);
      return entry.img || null;
    } catch {
      return null;
    }
  }

  function montageLayoutMetrics(cellW) {
    const count = Math.max(1, Math.min(MAX_COUNT, state.count || 1));
    const lay = layoutFor(count, state.gridN);
    const cw = cellW || 280;
    const ch = Math.round(cw * 10 / 16);
    const gap = state.gap ? Math.max(6, Math.round(cw * 0.05)) : 0;
    const pad = Math.max(10, Math.round(cw * 0.07));
    const W = pad * 2 + lay.cols * cw + (lay.cols - 1) * gap;
    const H = pad * 2 + lay.rows * ch + (lay.rows - 1) * gap;
    return { count, lay, cellW: cw, cellH: ch, gap, pad, W, H };
  }

  function paintMontageFrame(ctx, metrics, assets, tMs, opts) {
    const { count, lay, cellW, cellH, gap, pad, W, H } = metrics;
    // Export: siempre lienzo limpio con alpha (sin relleno negro)
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.restore();
    const wantClearBg = opts?.forceTransparent !== false; // default true en exports
    const fondoTransparent = isTransparentFondo(state.fondo);
    const skipCellFill = wantClearBg || fondoTransparent;
    const mot = clampMotion(state.motion);
    const moveText = !!state.textMotion && mot !== 'off';
    const bgBmp = fondoTransparent ? null : erSourceBitmap(assets.bg, tMs);

    for (let i = 0; i < count; i++) {
      const col = i % lay.cols;
      const row = Math.floor(i / lay.cols);
      const x = pad + col * (cellW + gap);
      const y = pad + row * (cellH + gap);
      try {
        if (!skipCellFill) {
          ctx.fillStyle = '#0b1220';
          erDrawRoundedRect(ctx, x, y, cellW, cellH, Math.max(8, Math.round(cellW * 0.06)));
          ctx.fill();
        }
        if (bgBmp && bgBmp.width && bgBmp.height && !fondoTransparent) {
          ctx.save();
          erDrawRoundedRect(ctx, x, y, cellW, cellH, Math.max(8, Math.round(cellW * 0.06)));
          ctx.clip();
          ctx.drawImage(bgBmp, x, y, cellW, cellH);
          ctx.restore();
        }

      const ovBmp = erSourceBitmap(assets.overlays[i], tMs);
      if (ovBmp && ovBmp.width && ovBmp.height) {
        const maxW = cellW * 0.72;
        const maxH = cellH * 0.72;
        const free = usesCustomLayout(i);
        const sizeMul = free
          ? clampItemScale(state.overlays[i]?.scale ?? 1)
          : clampImgScale(state.imgScale);
        const sc0 = Math.min(maxW / ovBmp.width, maxH / ovBmp.height) * sizeMul;
        const iw = ovBmp.width * sc0;
        const ih = ovBmp.height * sc0;
        const m = free ? { dx: 0, dy: 0, scale: 1, rot: 0 } : erMotionOffset(mot, tMs, iw, ih);
        const cx = free
          ? (x + clampPct(state.overlays[i]?.x, 50) / 100 * cellW + m.dx)
          : (x + cellW / 2 + m.dx);
        const cy = free
          ? (y + clampPct(state.overlays[i]?.y, 50) / 100 * cellH + m.dy)
          : (y + cellH / 2 + m.dy);
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(m.rot);
        ctx.scale(m.scale, m.scale);
        ctx.drawImage(ovBmp, -iw / 2, -ih / 2, iw, ih);
        ctx.restore();
      }

      const gfBmp = erSourceBitmap(assets.gifts[i], tMs);
      if (gfBmp && gfBmp.width && gfBmp.height) {
        const free = usesCustomLayout(i);
        const base = Math.min(cellW, cellH) * 0.32;
        const s = base * (free
          ? clampItemScale(state.gifts[i]?.scale ?? 1)
          : clampGiftScale(state.giftScale));
        const m = free ? { dx: 0, dy: 0, scale: 1, rot: 0 } : erMotionOffset(mot, tMs, s, s);
        let gx;
        let gy;
        if (free) {
          gx = x + clampPct(state.gifts[i]?.x, 82) / 100 * cellW - s / 2;
          gy = y + clampPct(state.gifts[i]?.y, 82) / 100 * cellH - s / 2;
        } else {
          const pos = giftPosCenter(state.giftPos);
          gx = x + pos.x / 100 * cellW - s / 2;
          gy = y + pos.y / 100 * cellH - s / 2;
        }
        ctx.save();
        ctx.translate(gx + s / 2 + m.dx, gy + s / 2 + m.dy);
        ctx.rotate(m.rot);
        ctx.scale(m.scale, m.scale);
        ctx.drawImage(gfBmp, -s / 2, -s / 2, s, s);
        ctx.restore();
      }

        for (const tx of textsAt(i)) {
          const scale = Math.min(3, Math.max(0.4, Number(tx.scale) || 1));
          const fontPx = Math.round(Math.max(10, 18 * scale * (cellW / 280)));
          ctx.font = '800 ' + fontPx + 'px Rubik, system-ui, sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          const style = clampTextStyle(tx.style);
          let fill = clampTextColor(tx.color);
          if (style === 'rainbow' || style === 'aurora') {
            const g = ctx.createLinearGradient(x, y, x + cellW, y + cellH);
            if (style === 'rainbow') {
              g.addColorStop(0, '#ff006e');
              g.addColorStop(0.33, '#8338ec');
              g.addColorStop(0.66, '#3a86ff');
              g.addColorStop(1, '#06ffa5');
            } else {
              g.addColorStop(0, '#22d3ee');
              g.addColorStop(0.5, '#a78bfa');
              g.addColorStop(1, '#34d399');
            }
            fill = g;
          }
          ctx.fillStyle = fill;
          ctx.shadowColor = 'rgba(0,0,0,.55)';
          ctx.shadowBlur = 6;
          let txX = x + (Number(tx.x) || 50) / 100 * cellW;
          let txY = y + (Number(tx.y) || 50) / 100 * cellH;
          if (moveText) {
            const m = erMotionOffset(mot, tMs, fontPx * 4, fontPx * 2);
            txX += m.dx;
            txY += m.dy;
          }
          ctx.fillText(String(tx.text || ''), txX, txY);
          ctx.shadowBlur = 0;
        }

        const fm = clampFrameMode(state.frameMode);
        const fp = framePresetById(fm);
        if (fp.kind !== 'off') {
          const rr = Math.max(8, Math.round(cellW * 0.06));
          const bw = Math.max(2, Math.round(cellW * 0.014));
          ctx.save();
          erDrawRoundedRect(ctx, x, y, cellW, cellH, rr);
          if (fp.kind === 'solid') {
            ctx.strokeStyle = clampTextColor(state.frameColor || '#25f4ee');
          } else {
            const stops = Array.isArray(fp.stops) && fp.stops.length ? fp.stops : ['#fff', '#aaa'];
            const shift = ((tMs || 0) % 4000) / 4000;
            const g = ctx.createLinearGradient(x + cellW * shift, y, x + cellW + cellW * shift, y);
            stops.forEach((c, si) => g.addColorStop(si / Math.max(1, stops.length - 1), c));
            ctx.strokeStyle = g;
          }
          ctx.lineWidth = bw;
          ctx.stroke();
          ctx.restore();
        }
      } catch { /* celda individual no tumba el export */ }
    }
  }

  async function prepareMontageAssets(tools, opts) {
    const allowAnim = !!(tools && opts?.allowAnim !== false);
    const bgSrc = resolveFondoSrc(state);
    const transparent = isTransparentFondo(state.fondo);
    let animLeft = allowAnim ? Math.max(1, opts?.maxAnimated || 8) : 0;

    const loadOne = async (src, preferAnim) => {
      if (!src) return { kind: 'none' };
      const useAnim = preferAnim && animLeft > 0;
      const entry = await loadErAnimOrStatic(tools, src, {
        allowAnim: useAnim,
        maxFrames: opts?.maxFrames || 12,
        maxSide: opts?.maxSide || 220,
        fetchMs: 5000,
        imgMs: 5000,
      });
      if (entry.kind === 'gif') animLeft -= 1;
      return entry;
    };

    const bg = (!transparent && bgSrc)
      ? await loadOne(bgSrc, true)
      : { kind: 'none' };
    await erYieldToUi();

    const overlays = [];
    const gifts = [];
    for (let i = 0; i < state.count; i++) {
      overlays[i] = state.overlays[i]?.src
        ? await loadOne(state.overlays[i].src, true)
        : { kind: 'none' };
      gifts[i] = state.gifts[i]?.src
        ? await loadOne(state.gifts[i].src, false)
        : { kind: 'none' };
      if (i % 4 === 3) await erYieldToUi();
    }
    return { bg, overlays, gifts };
  }

  function downloadErBlob(blob, filename) {
    const a = document.createElement('a');
    a.download = filename;
    a.href = URL.createObjectURL(blob);
    a.click();
    setTimeout(() => {
      try { URL.revokeObjectURL(a.href); } catch {}
    }, 8000);
  }

  function setErGifExportUi(busy, label) {
    const btn = document.getElementById('er-export-montage-gif');
    if (!btn) return;
    btn.disabled = !!busy;
    btn.classList.toggle('is-busy', !!busy);
    btn.setAttribute('aria-busy', busy ? 'true' : 'false');
    const strong = btn.querySelector('strong');
    if (strong) {
      if (busy) {
        if (!btn.dataset.erGifLabel) btn.dataset.erGifLabel = strong.textContent || 'Exportar GIF';
        strong.textContent = label || 'Generando…';
      } else if (btn.dataset.erGifLabel) {
        strong.textContent = btn.dataset.erGifLabel;
        delete btn.dataset.erGifLabel;
      }
    }
  }

  async function exportMontagePng() {
    toastMsg('Generando PNG…');
    try {
      const metrics = montageLayoutMetrics(280);
      const canvas = document.createElement('canvas');
      canvas.width = metrics.W;
      canvas.height = metrics.H;
      const ctx = canvas.getContext('2d', { alpha: true });
      if (!ctx) throw new Error('no-2d');
      // Fondo transparente (sin negro)
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const assets = await prepareMontageAssets(null, { allowAnim: false });
      paintMontageFrame(ctx, metrics, assets, 0, { forceTransparent: true });
      const a = document.createElement('a');
      a.download = 'livecoins-montage-' + metrics.count + 'c.png';
      a.href = canvas.toDataURL('image/png');
      a.click();
      toastMsg('PNG transparente descargado');
    } catch (e) {
      console.warn(e);
      toastMsg('No se pudo exportar el PNG');
    }
  }

  let erGifExportBusy = false;

  /** Prepara índices GIF con color transparente (alpha 0 → índice 0). */
  function encodeRgbaToGifIndex(tools, rgba) {
    const data = rgba instanceof Uint8ClampedArray ? rgba : new Uint8ClampedArray(rgba);
    const format = 'rgb444';
    const core = tools.quantize(data, 255, { format }) || [[1, 1, 1]];
    const index = tools.applyPalette(data, core, format);
    const palette = [[0, 0, 0]].concat(core).slice(0, 256);
    for (let p = 0, i = 0; p < data.length; p += 4, i++) {
      if (data[p + 3] < 12) index[i] = 0;
      else index[i] = (Number(index[i]) || 0) + 1;
    }
    return { index, palette };
  }

  async function encodeMontageGifFrames(tools, metrics, assets, timeline) {
    const canvas = document.createElement('canvas');
    canvas.width = metrics.W;
    canvas.height = metrics.H;
    const ctx = canvas.getContext('2d', { willReadFrequently: true, alpha: true });
    if (!ctx) throw new Error('no-2d');
    const gif = tools.GIFEncoder();
    let first = true;
    for (let i = 0; i < timeline.length; i++) {
      const slot = timeline[i];
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      paintMontageFrame(ctx, metrics, assets, slot.t, { forceTransparent: true });
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const { index, palette } = encodeRgbaToGifIndex(tools, data);
      gif.writeFrame(index, canvas.width, canvas.height, {
        palette,
        delay: slot.delay,
        repeat: 0,
        first,
        dispose: 2,
        transparent: true,
        transparentIndex: 0,
      });
      first = false;
      if (i % 2 === 1) await erYieldToUi();
    }
    gif.finish();
    return gif.bytes();
  }

  function buildGifTimeline(hasCssMotion, hasGifMedia, maxFrames) {
    const duration = hasCssMotion ? 2400 : (hasGifMedia ? 1600 : 600);
    const step = hasCssMotion || hasGifMedia ? 100 : 200;
    const timeline = [];
    for (let t = 0; t < duration; t += step) timeline.push({ t, delay: step });
    const cap = Math.max(4, Math.min(36, maxFrames || 24));
    if (timeline.length > cap) timeline.length = cap;
    if (!timeline.length) timeline.push({ t: 0, delay: 200 });
    return timeline;
  }

  async function exportMontageGif() {
    if (erGifExportBusy) {
      toastMsg('Ya se está generando un GIF…');
      return;
    }
    erGifExportBusy = true;
    setErGifExportUi(true, 'Generando…');
    toastMsg('Generando GIF…');
    const started = Date.now();
    const hardLimitMs = 90000;
    try { erAnimCache.clear(); } catch {}

    try {
      const tools = await loadErGifTools();
      const cellW = state.count > 36 ? 110 : (state.count > 16 ? 140 : 180);
      let metrics = montageLayoutMetrics(cellW);
      // Evitar canvas enormes que traban el navegador
      while ((metrics.W * metrics.H > 2_200_000) && metrics.cellW > 80) {
        metrics = montageLayoutMetrics(metrics.cellW - 20);
      }

      setErGifExportUi(true, 'Cargando…');
      const assets = await prepareMontageAssets(tools, {
        allowAnim: true,
        maxAnimated: state.count > 24 ? 4 : 8,
        maxFrames: 10,
        maxSide: 200,
      });
      if (Date.now() - started > hardLimitMs) throw new Error('timeout-assets');

      const mot = clampMotion(state.motion);
      const hasCssMotion = mot !== 'off';
      const hasGifMedia = [assets.bg, ...(assets.overlays || []), ...(assets.gifts || [])]
        .some((e) => e?.kind === 'gif');
      const maxFrames = state.count > 36 ? 12 : (state.count > 16 ? 18 : 24);
      const timeline = buildGifTimeline(hasCssMotion, hasGifMedia, maxFrames);

      setErGifExportUi(true, 'Codificando…');
      let bytes;
      try {
        bytes = await erWithTimeout(
          encodeMontageGifFrames(tools, metrics, assets, timeline),
          Math.max(15000, hardLimitMs - (Date.now() - started)),
          'encode-timeout',
        );
      } catch (encErr) {
        console.warn('GIF encode retry light', encErr);
        // Reintento ligero: menos frames + sin GIFs animados de media
        setErGifExportUi(true, 'Reintento…');
        const lightAssets = await prepareMontageAssets(null, { allowAnim: false });
        const lightMetrics = montageLayoutMetrics(Math.min(120, cellW));
        const lightTimeline = buildGifTimeline(hasCssMotion, false, 10);
        bytes = await erWithTimeout(
          encodeMontageGifFrames(tools, lightMetrics, lightAssets, lightTimeline),
          25000,
          'encode-retry-timeout',
        );
      }

      if (!bytes || !bytes.length) throw new Error('gif-vacio');
      downloadErBlob(new Blob([bytes], { type: 'image/gif' }), 'livecoins-montage-' + metrics.count + 'c.gif');
      toastMsg(hasCssMotion || hasGifMedia
        ? 'GIF del montage descargado (con movimiento)'
        : 'GIF del montage descargado');
    } catch (e) {
      console.warn(e);
      // Último recurso: PNG para que el usuario no se quede sin archivo
      try {
        toastMsg('GIF falló · descargando PNG…');
        await exportMontagePng();
      } catch {
        toastMsg('No se pudo generar el GIF');
      }
    } finally {
      erGifExportBusy = false;
      setErGifExportUi(false);
    }
  }

  function seedHistoryIfNeeded() {
    if (!historyStack.length) {
      historyStack = [JSON.stringify(snapshotState(state))];
      historyIndex = 0;
      updateUndoRedoBtns();
    }
  }
  /* === ER_PRO_FEATURES_END === */


  function pauseTplAutosave() {
    tplAutosavePaused += 1;
    clearTimeout(tplAutosaveTimer);
  }

  /** Vuelca ya el autoguardado pendiente. Captura el diseño y la plantilla de
      destino de forma síncrona, porque el que llama va a reemplazarlos enseguida. */
  function flushPendingTplAutosave() {
    if (!tplAutosaveTimer) return;
    clearTimeout(tplAutosaveTimer);
    tplAutosaveTimer = null;
    if (tplAutosavePaused > 0) return;
    const id = activeTemplateId();
    if (!id) return;
    const nameEl = document.getElementById('er-tpl-name');
    const template = {
      id,
      name: (String(nameEl?.value || '').trim() || 'Plantilla').slice(0, 80),
      protected: true,
      savedAt: Date.now(),
      data: snapshotState(state),
    };
    fetch('/api/editor-rapido/templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ template }),
    }).catch(() => {});
  }

  function resumeTplAutosave() {
    tplAutosavePaused = Math.max(0, tplAutosavePaused - 1);
  }

  function activeTemplateId() {
    return String((state.gameSync && state.gameSync.templateId) || activeTplId || '').trim();
  }

  function scheduleAutosaveTemplate() {
    if (tplAutosavePaused > 0) return;
    if (!activeTemplateId()) return;
    clearTimeout(tplAutosaveTimer);
    tplAutosaveTimer = setTimeout(() => {
      persistActiveTemplateQuiet().catch(() => {});
    }, 500);
  }

  function flashTplAutosaveStatus(ok) {
    const el = document.getElementById('er-tpl-autosave');
    if (!el) return;
    el.textContent = ok ? ('Autoguardado' + (lastEditAt ? (' · ' + formatEditAgo(lastEditAt)) : '')) : 'Error al guardar';
    updateTplActiveLine();
    el.classList.toggle('is-err', !ok);
    el.classList.add('is-on');
    clearTimeout(flashTplAutosaveStatus._t);
    flashTplAutosaveStatus._t = setTimeout(() => el.classList.remove('is-on'), 1600);
  }

  function liveRoomKey() {
    // Debe coincidir con el ?room= del URL de Live Studio (roomUrl local)
    try {
      if (typeof roomUrl === 'function') {
        const u = new URL(roomUrl('/editor-rapido-overlay.html'), location.origin);
        const r = String(u.searchParams.get('room') || '').trim();
        if (r) return r;
      }
    } catch {}
    return String(window.ROOM_KEY || 'local').trim() || 'local';
  }

  function snapshotState(st) {
    const s = st || state;
    return {
      count: s.count,
      gap: s.gap !== false,
      spreadH: !!s.spreadH,
      fixedCellSize: !!s.fixedCellSize,
      gridN: clampGridN(s.gridN),
      zoom: clampZoom(s.zoom),
      imgScale: clampImgScale(s.imgScale),
      giftScale: clampGiftScale(s.giftScale),
      giftPos: clampGiftPos(s.giftPos),
      frameMode: clampFrameMode(s.frameMode),
      frameColor: clampTextColor(s.frameColor || '#25f4ee'),
      fondo: s.fondo,
      fondoCustomSrc: s.fondo === 'custom' ? String(s.fondoCustomSrc || '') : '',
      motion: clampMotion(s.motion),
      textMotion: !!s.textMotion,
      overlays: (s.overlays || []).map(cloneItem),
      gifts: (s.gifts || []).map(cloneItem),
      texts: (s.texts || []).map((cell) => normalizeTextList(cell)),
      gameSync: normalizeGameSync(s.gameSync),
      filasSnap: normalizeFilasSnap(s.filasSnap) || (clampGridN(s.gridN) ? buildFilasSnap(s) : null),
      freeMove: Array.isArray(s.freeMove) ? s.freeMove.map(Boolean).slice(0, MAX_COUNT) : emptyFreeMove(),
      freeLayout: Array.isArray(s.freeLayout) ? s.freeLayout.map(Boolean).slice(0, MAX_COUNT) : emptyFreeMove(),
    };
  }

  function schedulePublishLive() {
    clearTimeout(livePublishTimer);
    // Siempre el state actual (no un snapshot viejo del debounce)
    livePublishTimer = setTimeout(() => { publishLive(state).catch(() => {}); }, 120);
  }

  async function uploadErMedia(dataUrl) {
    const r = await fetch('/api/editor-rapido/media', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dataUrl }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j?.ok || !j.url) {
      throw new Error(j?.error || `Error ${r.status}`);
    }
    return String(j.url);
  }

  async function persistSrcIfNeeded(src) {
    const s = String(src || '');
    if (!s) return '';
    if (!s.startsWith('data:')) return s;
    try {
      return await uploadErMedia(s);
    } catch (e) {
      erMediaFailKeys.add(erMediaKey(s));
      console.warn('Editor Pro: no se pudo subir imagen', e);
      if (!erMediaFailWarned) {
        erMediaFailWarned = true;
        warnErLive('No se pudo guardar la imagen en disco. Sigue en el montaje; pulsa Guardar otra vez.');
      }
      return s;
    }
  }

  function schedulePersistMediaAndSave() {
    if (persistMediaSaveTimer) return;
    persistMediaSaveTimer = setTimeout(() => {
      persistMediaSaveTimer = null;
      ensureMediaForLive(state).then(() => {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch {}
      }).catch(() => {});
    }, 80);
  }

  function mergeKeptMedia(from, to) {
    if (!from || !to) return to;
    const fill = (fromArr, toArr) => {
      if (!Array.isArray(fromArr) || !Array.isArray(toArr)) return;
      for (let i = 0; i < MAX_COUNT; i++) {
        if (fromArr[i]?.src && !toArr[i]?.src) toArr[i] = cloneItem(fromArr[i]);
      }
    };
    fill(from.overlays, to.overlays);
    fill(from.gifts, to.gifts);
    if (from.fondoCustomSrc && !to.fondoCustomSrc) {
      to.fondoCustomSrc = from.fondoCustomSrc;
      if (from.fondo === 'custom') to.fondo = 'custom';
    }
    if (from.filasSnap && to.filasSnap) {
      fill(from.filasSnap.overlays, to.filasSnap.overlays);
      fill(from.filasSnap.gifts, to.filasSnap.gifts);
    }
    return to;
  }

  function fillEmptyMediaFrom(srcSt) {
    if (!srcSt) return false;
    const before = JSON.stringify({
      o: (state.overlays || []).map((x) => x?.src || ''),
      g: (state.gifts || []).map((x) => x?.src || ''),
      f: state.fondoCustomSrc || '',
    });
    mergeKeptMedia(srcSt, state);
    const after = JSON.stringify({
      o: (state.overlays || []).map((x) => x?.src || ''),
      g: (state.gifts || []).map((x) => x?.src || ''),
      f: state.fondoCustomSrc || '',
    });
    return before !== after;
  }

  async function restoreKeptMediaFromDisk() {
    let changed = false;
    const id = activeTemplateId();
    if (id) {
      try {
        await ensureTemplatesLoaded();
        const tpl = getTemplatesSync().find((t) => t.id === id);
        if (tpl?.data) changed = fillEmptyMediaFrom(normalizeState(tpl.data)) || changed;
      } catch {}
    }
    try {
      const room = liveRoomKey();
      const r = await fetch(`/api/editor-rapido/live?room=${encodeURIComponent(room)}`, { cache: 'no-store' });
      const j = await r.json().catch(() => null);
      const payload = j?.live?.payload;
      if (payload) changed = fillEmptyMediaFrom(normalizeState(payload)) || changed;
    } catch {}
    if (!changed) return;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch {
      schedulePersistMediaAndSave();
    }
    renderGrid();
    schedulePublishLive();
  }

  async function replaceDataSrc(item, opts) {
    if (!item || typeof item !== 'object') return item;
    const src = String(item.src || '');
    if (!src.startsWith('data:')) return item;
    const key = erMediaKey(src);
    if (erMediaFailKeys.has(key)) return item;
    try {
      const url = await uploadErMedia(src);
      erMediaFailKeys.delete(key);
      return { ...item, src: url };
    } catch (e) {
      erMediaFailKeys.add(key);
      console.warn('Editor Pro: no se pudo subir media', e);
      if (!opts?.quiet && !erMediaFailWarned) {
        erMediaFailWarned = true;
        warnErLive('No se pudo subir una imagen al overlay. Pulsa Guardar otra vez.');
      }
      return item;
    }
  }

  /** Sube data: a /api/editor-rapido/media antes del live (Live Studio no traga payloads enormes). */
  async function ensureMediaForLive(st, opts) {
    const s = st || state;
    const quiet = !!opts?.quiet;
    let changed = false;
    if (s.fondo === 'custom') {
      const src = String(s.fondoCustomSrc || '');
      if (src.startsWith('data:')) {
        const fkey = erMediaKey(src);
        if (!erMediaFailKeys.has(fkey)) {
          try {
            const url = await uploadErMedia(src);
            erMediaFailKeys.delete(fkey);
            s.fondoCustomSrc = url;
            if (s === state || st === state) state.fondoCustomSrc = url;
            changed = true;
          } catch (e) {
            erMediaFailKeys.add(fkey);
            console.warn('Editor Pro: no se pudo subir fondo custom', e);
            if (!quiet && !erMediaFailWarned) {
              erMediaFailWarned = true;
              warnErLive('No se pudo subir el fondo al overlay. Pulsa Guardar otra vez.');
            }
          }
        }
      }
    }
    if (Array.isArray(s.overlays)) {
      for (let i = 0; i < s.overlays.length; i++) {
        const next = await replaceDataSrc(s.overlays[i], opts);
        if (next !== s.overlays[i]) {
          s.overlays[i] = next;
          if (state.overlays[i]) state.overlays[i] = next;
          changed = true;
        }
      }
    }
    if (Array.isArray(s.gifts)) {
      for (let i = 0; i < s.gifts.length; i++) {
        const next = await replaceDataSrc(s.gifts[i], opts);
        if (next !== s.gifts[i]) {
          s.gifts[i] = next;
          if (state.gifts[i]) state.gifts[i] = next;
          changed = true;
        }
      }
    }
    if (s.filasSnap) {
      if (Array.isArray(s.filasSnap.overlays)) {
        for (let i = 0; i < s.filasSnap.overlays.length; i++) {
          const next = await replaceDataSrc(s.filasSnap.overlays[i], opts);
          if (next !== s.filasSnap.overlays[i]) {
            s.filasSnap.overlays[i] = next;
            changed = true;
          }
        }
      }
      if (Array.isArray(s.filasSnap.gifts)) {
        for (let i = 0; i < s.filasSnap.gifts.length; i++) {
          const next = await replaceDataSrc(s.filasSnap.gifts[i], opts);
          if (next !== s.filasSnap.gifts[i]) {
            s.filasSnap.gifts[i] = next;
            changed = true;
          }
        }
      }
    }
    if (changed) {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch {}
      if (changed && s.fondo === 'custom') renderLibrary();
    }
    return s;
  }

  function applyCleanedMediaFromPayload(cleaned) {
    if (!cleaned || typeof cleaned !== 'object') return false;
    let changed = false;
    if (Array.isArray(cleaned.overlays)) {
      for (let i = 0; i < cleaned.overlays.length; i++) {
        const src = cleaned.overlays[i]?.src;
        if (src && state.overlays[i]?.src && src !== state.overlays[i].src && !String(src).startsWith('data:')) {
          state.overlays[i] = { ...state.overlays[i], src };
          changed = true;
        }
      }
    }
    if (Array.isArray(cleaned.gifts)) {
      for (let i = 0; i < cleaned.gifts.length; i++) {
        const src = cleaned.gifts[i]?.src;
        if (src && state.gifts[i]?.src && src !== state.gifts[i].src && !String(src).startsWith('data:')) {
          state.gifts[i] = { ...state.gifts[i], src };
          changed = true;
        }
      }
    }
    if (cleaned.fondo === 'custom' && cleaned.fondoCustomSrc && cleaned.fondoCustomSrc !== state.fondoCustomSrc
      && !String(cleaned.fondoCustomSrc).startsWith('data:')) {
      state.fondoCustomSrc = cleaned.fondoCustomSrc;
      changed = true;
      renderLibrary();
    }
    return changed;
  }

  function warnErLive(msg) {
    const now = Date.now();
    if (now - lastErLiveWarnAt < 8000) return;
    lastErLiveWarnAt = now;
    toastMsg(msg || 'No se pudo actualizar el overlay en OBS.');
  }

  async function publishLive(st, opts) {
    /* Dos publicaciones a la vez pueden llegar desordenadas y dejar en OBS una
       versión vieja. Se publica de una en una y, si llegó algo nuevo mientras
       tanto, se reprograma con el diseño actual. */
    if (livePublishInFlight) {
      if (!opts?.heartbeat) livePublishAgain = true;
      return;
    }
    livePublishInFlight = true;
    try {
      await publishLiveNow(st, opts);
    } finally {
      livePublishInFlight = false;
      if (livePublishAgain) {
        livePublishAgain = false;
        schedulePublishLive();
      }
    }
  }

  async function publishLiveNow(st, opts) {
    const ready = opts?.heartbeat
      ? (st || state)
      : await ensureMediaForLive(st || state);
    const payload = snapshotState(ready);
    const room = liveRoomKey();
    try {
      liveChannel?.postMessage({ type: 'er-live', room, payload, updatedAt: Date.now() });
    } catch {}
    try {
      // Sin keepalive: con data:/imágenes el body supera el límite ~64KB de keepalive
      // y el POST fallaba en silencio → Live Studio solo se actualizaba tras Guardar.
      const r = await fetch('/api/editor-rapido/live', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ room, payload }),
      });
      if (!r.ok) {
        warnErLive('No se pudo actualizar el overlay (OBS). Revisa que el .exe esté abierto.');
        return;
      }
      const j = await r.json().catch(() => null);
      const cleaned = j?.live?.payload;
      if (!cleaned || typeof cleaned !== 'object') return;
      if (applyCleanedMediaFromPayload(cleaned)) {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch {}
      }
    } catch {
      warnErLive('No se pudo actualizar el overlay (OBS). Revisa que el .exe esté abierto.');
    }
  }

  function startLiveHeartbeat() {
    if (liveHeartbeatTimer) return;
    // Mientras el panel esté abierto (aunque cambies de pestaña): OBS no se queda seco.
    liveHeartbeatTimer = setInterval(() => {
      if (document.hidden) return;
      // Solo mantiene vivo el overlay. No reintenta subir data: (eso disparaba el toast en bucle).
      publishLive(state, { heartbeat: true }).catch(() => {});
    }, 4000);
  }

  function normalizeTplList(raw) {
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((t) => t && typeof t === 'object' && t.id && t.data)
      .map((t) => ({
        id: String(t.id).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80),
        name: String(t.name || 'Sin nombre').slice(0, 80),
        protected: true,
        savedAt: Number(t.savedAt) || Date.now(),
        data: normalizeState(t.data),
      }))
      .filter((t) => t.id);
  }

  function loadTemplatesLocalFallback() {
    try {
      return normalizeTplList(JSON.parse(localStorage.getItem(TPL_STORAGE_KEY) || '[]'));
    } catch {
      return [];
    }
  }

  function getTemplatesSync() {
    return templatesCache || loadTemplatesLocalFallback();
  }

  async function refreshTemplatesFromDisk() {
    try {
      const r = await fetch('/api/editor-rapido/templates', { cache: 'no-store' });
      const j = await r.json();
      if (j?.ok && Array.isArray(j.templates)) {
        templatesCache = normalizeTplList(j.templates);
        // Migrar una vez lo que hubiera en localStorage si el disco está vacío
        if (!templatesCache.length) {
          const legacy = loadTemplatesLocalFallback();
          for (const t of legacy) {
            try {
              await fetch('/api/editor-rapido/templates', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ template: { ...t, data: snapshotState(t.data) } }),
              });
            } catch {}
          }
          if (legacy.length) {
            const r2 = await fetch('/api/editor-rapido/templates', { cache: 'no-store' });
            const j2 = await r2.json();
            if (j2?.ok && Array.isArray(j2.templates)) {
              templatesCache = normalizeTplList(j2.templates);
              try { localStorage.removeItem(TPL_STORAGE_KEY); } catch {}
            }
          }
        } else {
          try { localStorage.removeItem(TPL_STORAGE_KEY); } catch {}
        }
        return templatesCache;
      }
    } catch {}
    if (!templatesCache) templatesCache = loadTemplatesLocalFallback();
    return templatesCache;
  }

  function ensureTemplatesLoaded() {
    if (!templatesLoadPromise) templatesLoadPromise = refreshTemplatesFromDisk();
    return templatesLoadPromise;
  }

  function setActiveTplId(id) {
    activeTplId = String(id || '');
    try {
      if (activeTplId) localStorage.setItem(TPL_ACTIVE_KEY, activeTplId);
      else localStorage.removeItem(TPL_ACTIVE_KEY);
    } catch {}
  }

  function renderTplSelect() {
    const sel = document.getElementById('er-tpl-select');
    const nameEl = document.getElementById('er-tpl-name');
    const delBtn = document.getElementById('er-tpl-delete');
    if (!sel) return;
    const list = getTemplatesSync();
    const cur = activeTplId;
    sel.innerHTML = `<option value="">— Elegir plantilla —</option>` + list.map((t) =>
      `<option value="${escapeHtml(t.id)}"${t.id === cur ? ' selected' : ''}>${escapeHtml(t.name)} 🔒</option>`
    ).join('');
    if (cur) {
      const t = list.find((x) => x.id === cur);
      if (t && nameEl && document.activeElement !== nameEl) nameEl.value = t.name;
    }
    if (delBtn) delBtn.disabled = !cur;
  }

  function applyWorkingState(next, { keepTpl } = {}) {
    pauseTplAutosave();
    try {
      state = normalizeState(next);
      if (!Array.isArray(state.texts)) state.texts = emptyTextSlots();
      else {
        for (let i = 0; i < MAX_COUNT; i++) state.texts[i] = normalizeTextList(state.texts[i]);
      }
      if (!keepTpl) setActiveTplId('');
      /* El historial es una pila única. Sin limpiarla, Deshacer salta al diseño de
         la plantilla anterior y el autoguardado lo escribe dentro de esta. */
      historyStack = [];
      historyIndex = -1;
      saveState(state);
      renderLibrary();
      renderCountControls();
      renderGapToggle();
      renderSpreadToggle();
      renderCellSizeToggle();
      renderMotionControl();
      renderFrameControls();
      renderPickBar();
      renderGrid();
      renderTplSelect();
    } finally {
      resumeTplAutosave();
    }
  }

  async function createNewTemplateFromState(name) {
    const label = String(name || '').trim().slice(0, 80) || 'Plantilla';
    await ensureTemplatesLoaded();
    const id = `tpl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const payload = {
      id,
      name: label,
      protected: true,
      savedAt: Date.now(),
      data: snapshotState(state),
    };
    try {
      const r = await fetch('/api/editor-rapido/templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ template: payload }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j?.ok === false) {
        throw new Error(j?.error || `Error ${r.status}`);
      }
      const saved = j.template || payload;
      if (saved?.data) {
        state = normalizeState(saved.data);
        saveState(state);
      }
      setActiveTplId(saved.id || payload.id);
      const nameEl = document.getElementById('er-tpl-name');
      if (nameEl) nameEl.value = saved.name || label;
      await refreshTemplatesFromDisk();
      renderTplSelect();
      renderGrid();
      return saved;
    } catch (e) {
      toastMsg('No se pudo guardar la plantilla: ' + (e.message || 'error'));
      return null;
    }
  }

  function templateNameFromImport(opts, count) {
    let base = String(opts?.title || opts?.name || '').trim();
    base = base.replace(/\.(png|jpe?g|gif|webp)$/i, '');
    base = base.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
    base = base
      .replace(/\boverlay\b/gi, '')
      .replace(/\bmenu regalos\b/gi, 'Menú')
      .replace(/\s+/g, ' ')
      .trim();
    if (!base) base = 'Overlay juego';
    base = base.replace(/\b\w/g, (c) => c.toUpperCase());
    return `${base} · ${count} cuadros`.slice(0, 80);
  }

  async function saveCurrentTemplate() {
    erMediaFailKeys.clear();
    erMediaFailWarned = false;
    const nameEl = document.getElementById('er-tpl-name');
    const name = String(nameEl?.value || '').trim() || 'Plantilla';
    await ensureTemplatesLoaded();
    const list = getTemplatesSync().slice();
    let tpl = activeTplId ? list.find((t) => t.id === activeTplId) : null;
    if (!tpl) {
      tpl = list.find((t) => t.name.toLowerCase() === name.toLowerCase()) || null;
    }
    let payload;
    if (tpl) {
      // Plantilla ya creada: guardar sin confirm (también sirve para renombrar)
      payload = {
        id: tpl.id,
        name: name.slice(0, 80),
        protected: true,
        savedAt: Date.now(),
        data: snapshotState(state),
      };
    } else {
      const id = `tpl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      payload = {
        id,
        name: name.slice(0, 80),
        protected: true,
        savedAt: Date.now(),
        data: snapshotState(state),
      };
    }
    toastMsg(tpl ? 'Plantilla actualizada' : 'Guardando plantilla nueva…');
    try {
      const r = await fetch('/api/editor-rapido/templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ template: payload }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j?.ok === false) {
        throw new Error(j?.error || `Error ${r.status}`);
      }
      const saved = j.template || payload;
      pauseTplAutosave();
      try {
        if (saved?.data) {
          state = normalizeState(saved.data);
          saveState(state);
          renderGrid();
        }
        setActiveTplId(saved.id || payload.id);
        if (state.gameSync) state.gameSync.templateId = saved.id || payload.id;
        await refreshTemplatesFromDisk();
        renderTplSelect();
      } finally {
        resumeTplAutosave();
      }
      flashTplAutosaveStatus(true);
      toastMsg(tpl ? 'Plantilla guardada' : 'Plantilla nueva guardada en esta PC');
    } catch (e) {
      flashTplAutosaveStatus(false);
      toastMsg('No se pudo guardar en disco: ' + (e.message || 'error'));
    }
  }

  async function loadTemplateById(id) {
    if (!id) return;
    // Antes de tocar la plantilla activa: lo editado en la actual aún puede estar
    // esperando los 500 ms del autoguardado y se perdería al cambiar.
    flushPendingTplAutosave();
    pauseTplAutosave();
    try {
      await ensureTemplatesLoaded();
      const tpl = getTemplatesSync().find((t) => t.id === id);
      if (!tpl) {
        toastMsg('Plantilla no encontrada');
        renderTplSelect();
        return;
      }
      setActiveTplId(tpl.id);
      const nameEl = document.getElementById('er-tpl-name');
      if (nameEl) nameEl.value = tpl.name;
      applyWorkingState(tpl.data, { keepTpl: true });
      toastMsg(`Cargada: ${tpl.name}`);
    } finally {
      resumeTplAutosave();
    }
  }

  async function deleteCurrentTemplate() {
    const id = activeTplId || document.getElementById('er-tpl-select')?.value || '';
    if (!id) {
      toastMsg('Elige una plantilla para borrar');
      return;
    }
    await ensureTemplatesLoaded();
    const tpl = getTemplatesSync().find((t) => t.id === id);
    const label = tpl?.name || id;
    const safe = escapeHtml(label);
    const ask = (typeof askConfirm === 'function')
      ? askConfirm
      : async (opts) => window.confirm(`${opts.title || ''}\n\n${opts.message || ''}`);
    const ok1 = await ask({
      title: `¿Borrar la plantilla «${safe}»?`,
      message: 'Esta acción no se puede deshacer.',
      confirmText: 'Borrar',
      cancelText: 'Cancelar',
      icon: '🗑️',
      danger: true,
    });
    if (!ok1) return;
    const ok2 = await ask({
      title: 'Confirma otra vez',
      message: `Se eliminará permanentemente «${safe}» de esta PC.`,
      confirmText: 'Sí, borrar',
      cancelText: 'Cancelar',
      icon: '⚠️',
      danger: true,
    });
    if (!ok2) return;
    try {
      const r = await fetch(`/api/editor-rapido/templates/${encodeURIComponent(id)}`, { method: 'DELETE' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j?.ok === false) throw new Error(j?.error || `Error ${r.status}`);
      if (activeTplId === id) setActiveTplId('');
      await refreshTemplatesFromDisk();
      renderTplSelect();
      toastMsg('Plantilla eliminada');
    } catch (e) {
      toastMsg('No se pudo borrar: ' + (e.message || 'error'));
    }
  }

  function newBlankWorking() {
    flushPendingTplAutosave();
    setActiveTplId('');
    const nameEl = document.getElementById('er-tpl-name');
    if (nameEl) nameEl.value = '';
    applyWorkingState({ count: 4, gap: true, fondo: 'fondo-1', motion: 'off', textMotion: false });
    toastMsg('Nueva plantilla en blanco. Las guardadas siguen intactas.');
  }

  function refreshOverlayUrl() {
    const code = document.getElementById('er-ov-url');
    if (!code) return;
    const path = code.dataset.path || '/editor-rapido-overlay.html';
    let url = '';
    try {
      if (typeof roomUrl === 'function') url = roomUrl(path);
      else {
        const k = liveRoomKey();
        url = location.origin + path + (k && k !== 'local' ? `?room=${encodeURIComponent(k)}` : '');
      }
    } catch {
      url = location.origin + path;
    }
    code.textContent = url;
    code.setAttribute('title', url);
  }

  function copyOverlayUrl() {
    refreshOverlayUrl();
    const code = document.getElementById('er-ov-url');
    const btn = document.getElementById('er-ov-copy');
    const url = code?.textContent || '';
    if (!url || url === '…') return;
    const markCopied = () => {
      if (!btn) return;
      btn.classList.add('is-copied');
      const txt = btn.querySelector('.er-ov-copy-txt');
      if (txt) txt.textContent = '¡Copiado!';
      clearTimeout(copyOverlayUrl._t);
      copyOverlayUrl._t = setTimeout(() => {
        btn.classList.remove('is-copied');
        if (txt) txt.textContent = 'Copiar URL';
      }, 1600);
    };
    navigator.clipboard?.writeText(url).then(() => {
      markCopied();
      toastMsg('URL copiada');
    }).catch(() => {
      try {
        const ta = document.createElement('textarea');
        ta.value = url;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        markCopied();
        toastMsg('URL copiada');
      } catch {
        toastMsg('No se pudo copiar');
      }
    });
  }

  let state = loadState() || normalizeState({ count: 4, gap: true, fondo: 'fondo-1' });
  if (!Array.isArray(state.texts)) state.texts = emptyTextSlots();
  else {
    for (let i = 0; i < MAX_COUNT; i++) state.texts[i] = normalizeTextList(state.texts[i]);
  }
  let wired = false;
  /** @type {{ kind: 'image'|'gift'|'text', src?: string, name?: string, cornerType?: string }|null} */
  let pending = null;
  /** @type {{ kind: 'image'|'gift', slot: number }|null} */
  let moveFrom = null;
  let clipboardImage = null;
  let clipboardGift = null;
  let ctxSlot = null;
  let ctxTextIdx = null;
  /** @type {null|{ slot: number, idx: number }} */
  let selectedText = null;
  /** @type {null|{ slot: number, kind: 'overlay'|'gift' }} */
  let selectedFreeItem = null;
  /** @type {null|{ slot: number, idx: number }} */
  let textEditing = null;
  /** @type {null|{ mode: 'move'|'resize', slot: number, idx: number, startX: number, startY: number, origX: number, origY: number, origScale: number, moved: boolean, pointerId: number }} */
  let textDrag = null;
  /** @type {null|{ mode: 'move'|'resize', kind: 'overlay'|'gift', slot: number, startX: number, startY: number, origX: number, origY: number, origScale: number, moved: boolean, pointerId: number }} */
  let itemDrag = null;
  let lastTextTap = { slot: -1, idx: -1, t: 0 };
  let ignoreNextGridClick = false;

  function toastMsg(msg) {
    try {
      if (typeof toast === 'function') toast(msg);
      else console.log(msg);
    } catch {
      console.log(msg);
    }
  }

  function isBusy() {
    return !!(pending || moveFrom);
  }

  function arrFor(kind) {
    return kind === 'gift' ? state.gifts : state.overlays;
  }

  function thumbHtmlForFondo(f, srcOverride) {
    if (f.transparent) {
      return `<span class="er-fondo-thumb is-transparent" title="${escapeHtml(f.label)}"></span>`;
    }
    const src = srcOverride || f.src || '';
    if (!src) {
      return `<span class="er-fondo-thumb is-empty" title="${escapeHtml(f.label)}">＋</span>`;
    }
    return `<img class="er-fondo-thumb" src="${escapeHtml(src)}" alt="" loading="lazy" draggable="false">`;
  }

  function closeFondoMenu() {
    const menu = document.getElementById('er-fondo-dd-menu');
    const btn = document.getElementById('er-fondo-dd-btn');
    const wrap = document.getElementById('er-fondo-dd');
    if (menu) menu.classList.add('hidden');
    if (btn) btn.setAttribute('aria-expanded', 'false');
    if (wrap) wrap.classList.remove('is-open');
  }

  function openFondoMenu() {
    closeFrameMenu();
    const menu = document.getElementById('er-fondo-dd-menu');
    const btn = document.getElementById('er-fondo-dd-btn');
    const wrap = document.getElementById('er-fondo-dd');
    if (menu) menu.classList.remove('hidden');
    if (btn) btn.setAttribute('aria-expanded', 'true');
    if (wrap) wrap.classList.add('is-open');
  }

  function toggleFondoMenu() {
    const menu = document.getElementById('er-fondo-dd-menu');
    if (!menu) return;
    if (menu.classList.contains('hidden')) openFondoMenu();
    else closeFondoMenu();
  }

  function renderLibrary() {
    const thumb = document.getElementById('er-fondo-dd-thumb');
    const label = document.getElementById('er-fondo-dd-label');
    const menu = document.getElementById('er-fondo-dd-menu');
    const cur = fondoById(state.fondo);
    const curSrc = resolveFondoSrc(state);
    if (thumb) {
      thumb.className = 'er-fondo-dd-thumb';
      thumb.innerHTML = thumbHtmlForFondo(cur, cur.custom ? curSrc : (cur.transparent ? '' : curSrc || cur.src));
    }
    if (label) label.textContent = fondoLabel(state);
    if (menu) {
      menu.innerHTML = FONDOS.map((f) => {
        const src = f.custom ? (state.fondoCustomSrc || '') : f.src;
        const on = state.fondo === f.id ? ' is-on' : '';
        return `
          <button type="button" class="er-fondo-opt${on}" role="option" data-fondo="${escapeHtml(f.id)}" aria-selected="${state.fondo === f.id ? 'true' : 'false'}">
            ${thumbHtmlForFondo(f, src)}
            <span>${escapeHtml(f.label)}</span>
          </button>`;
      }).join('');
    }
  }

  function setFondo(fondoId, { skipPicker } = {}) {
    const f = fondoById(fondoId);
    if (f.custom) {
      if (!state.fondoCustomSrc && !skipPicker) {
        closeFondoMenu();
        document.getElementById('er-fondo-file')?.click();
        return;
      }
      state.fondo = 'custom';
    } else {
      state.fondo = f.id;
    }
    closeFondoMenu();
    saveState(state);
    renderLibrary();
    renderGrid();
  }

  async function setCustomFondoFromFile(file) {
    if (!file) return;
    const dataUrl = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result || ''));
      r.onerror = () => reject(new Error('read'));
      r.readAsDataURL(file);
    });
    if (!dataUrl) {
      toastMsg('No se pudo leer la imagen');
      return;
    }
    toastMsg('Guardando fondo para Live Studio…');
    let url = dataUrl;
    try {
      url = await uploadErMedia(dataUrl);
    } catch (e) {
      toastMsg('No se pudo guardar el fondo en disco: ' + (e.message || 'error'));
      return;
    }
    state.fondo = 'custom';
    state.fondoCustomSrc = url;
    saveState(state);
    renderLibrary();
    renderGrid();
    await publishLive(state);
    toastMsg('Fondo personalizado aplicado (también en el overlay)');
  }

  function renderCountControls() {
    const input = document.getElementById('er-count-input');
    const minus = document.getElementById('er-count-minus');
    const plus = document.getElementById('er-count-plus');
    const label = document.getElementById('er-count-label');
    const fixed = clampGridN(state.gridN);
    if (input) {
      input.value = String(state.count);
      input.disabled = !!fixed;
    }
    if (minus) minus.disabled = !!fixed || state.count <= MIN_COUNT;
    if (plus) plus.disabled = !!fixed || state.count >= MAX_COUNT;
    if (label) {
      const lay = layoutFor(state.count, state.gridN);
      if (fixed) {
        label.textContent = `${lay.cols}×${lay.rows} · ${state.count} cuadros`;
      } else {
        label.textContent = lay.rows === 1
          ? `${state.count} en una fila`
          : `${lay.rows} filas · ${lay.cols} columnas`;
      }
    }
    renderGridModeControls();
  }

  function renderGridModeControls() {
    const fixed = clampGridN(state.gridN);
    const autoBtn = document.getElementById('er-grid-auto');
    const fixedBtn = document.getElementById('er-grid-fixed');
    const nWrap = document.getElementById('er-grid-n-btns');
    const customWrap = document.getElementById('er-grid-custom');
    const customBtn = document.getElementById('er-grid-custom-btn');
    const colsInp = document.getElementById('er-grid-cols');
    const rowsInp = document.getElementById('er-grid-rows');
    const square = isSquareGridPreset();
    if (autoBtn) autoBtn.classList.toggle('is-on', !fixed);
    if (fixedBtn) fixedBtn.classList.toggle('is-on', !!fixed);
    if (nWrap) nWrap.classList.toggle('hidden', !fixed);
    document.querySelectorAll('#er-grid-n-btns [data-er-grid-n]').forEach((btn) => {
      const n = Number(btn.dataset.erGridN);
      btn.classList.toggle('is-on', square && fixed === n);
    });
    if (customBtn) customBtn.classList.toggle('is-on', !!fixed && !square);
    if (customWrap) {
      const showCustom = !!fixed && (!square || customWrap.dataset.open === '1');
      customWrap.classList.toggle('hidden', !showCustom);
      customWrap.hidden = !showCustom;
    }
    if (fixed && colsInp && rowsInp) {
      const lay = layoutFor(state.count, state.gridN);
      if (document.activeElement !== colsInp) colsInp.value = String(lay.cols);
      if (document.activeElement !== rowsInp) rowsInp.value = String(lay.rows);
    }
  }

  function setGridAuto() {
    // Guardar cómo quedó n° Filas antes de compactar a Automática
    if (clampGridN(state.gridN)) {
      const autoMap = buildFilasAutoMap();
      state.filasSnap = buildFilasSnap(state);
      if (state.filasSnap) state.filasSnap.autoMap = autoMap;
    }
    const hidden = countHiddenContentSlots();
    const kept = compactToUsedSlots();
    saveState(state);
    renderCountControls();
    renderGrid();
    if (hidden) {
      toastMsg(`Automática · ${kept} cuadros (se recuperaron los de fuera de la rejilla)`);
    } else {
      toastMsg(`Automática · ${kept || 1} cuadro${kept === 1 ? '' : 's'} con contenido`);
    }
  }

  function setGridN(n) {
    const fixed = clampGridN(n);
    if (!fixed) {
      setGridAuto();
      return;
    }
    // Preset cuadrado N×N
    const customWrap = document.getElementById('er-grid-custom');
    if (customWrap) customWrap.dataset.open = '';
    state.gridN = fixed;
    state.count = clampCount(fixed * fixed);
    if (moveFrom && moveFrom.slot >= state.count) cancelPick();
    if (selectedSlot != null && selectedSlot >= state.count) selectedSlot = null;
    if (selectedText != null && selectedText.slot >= state.count) selectedText = null;
    saveState(state);
    renderCountControls();
    renderGrid();
    const hidden = countHiddenContentSlots();
    toastMsg(
      hidden
        ? `${fixed}×${fixed} · ${hidden} cuadro${hidden === 1 ? '' : 's'} quedan guardados fuera${hiddenSlotsNote()}`
        : `n° Filas · ${fixed}×${fixed}`
    );
  }

  function setGridCustom(cols, rows) {
    let c = Math.round(Number(cols));
    let r = Math.round(Number(rows));
    if (!Number.isFinite(c) || c < 1) c = 1;
    if (!Number.isFinite(r) || r < 1) r = 1;
    c = Math.min(MAX_COUNT, c);
    r = Math.min(MAX_COUNT, r);
    let clipped = false;
    if (c * r > MAX_COUNT) {
      r = Math.max(1, Math.floor(MAX_COUNT / c));
      clipped = true;
    }
    const customWrap = document.getElementById('er-grid-custom');
    if (customWrap) customWrap.dataset.open = '1';
    state.gridN = c;
    state.count = clampCount(c * r);
    if (moveFrom && moveFrom.slot >= state.count) cancelPick();
    if (selectedSlot != null && selectedSlot >= state.count) selectedSlot = null;
    if (selectedText != null && selectedText.slot >= state.count) selectedText = null;
    saveState(state);
    renderCountControls();
    renderGrid();
    const hidden = countHiddenContentSlots();
    toastMsg(
      clipped
        ? `Personalizado · ${c}×${r} (máx. ${MAX_COUNT} cuadros)`
        : (hidden
          ? `${c}×${r} · ${hidden} cuadro${hidden === 1 ? '' : 's'} quedan guardados fuera${hiddenSlotsNote()}`
          : `n° Filas · ${c}×${r}`)
    );
  }

  function openGridCustomPanel() {
    const customWrap = document.getElementById('er-grid-custom');
    if (customWrap) {
      customWrap.dataset.open = '1';
      customWrap.classList.remove('hidden');
      customWrap.hidden = false;
    }
    if (!clampGridN(state.gridN)) {
      // Entrar a modo fijo con valores del panel (o 8×4 por defecto)
      const colsInp = document.getElementById('er-grid-cols');
      const rowsInp = document.getElementById('er-grid-rows');
      const c = Number(colsInp?.value) || 8;
      const r = Number(rowsInp?.value) || 4;
      setGridCustom(c, r);
      return;
    }
    renderGridModeControls();
    document.getElementById('er-grid-cols')?.focus();
  }

  function setGridFixedMode() {
    if (clampGridN(state.gridN)) {
      renderCountControls();
      return;
    }
    // Traer ediciones hechas en Automática al snapshot, luego restaurar rejilla Filas
    syncFilasSnapFromCurrent(state);
    if (applyFilasSnap(state.filasSnap)) {
      saveState(state);
      renderCountControls();
      renderGrid();
      toastMsg(`n° Filas · ${state.gridN} cols · ${state.count} cuadros`);
      return;
    }
    setGridN(4);
  }

  function renderMotionControl() {
    const sel = document.getElementById('er-motion');
    const chk = document.getElementById('er-text-motion');
    const wrap = document.getElementById('er-text-motion-wrap');
    const mot = clampMotion(state.motion);
    if (sel) sel.value = mot;
    if (chk) {
      chk.checked = !!state.textMotion;
      chk.disabled = mot === 'off';
    }
    if (wrap) wrap.classList.toggle('is-disabled', mot === 'off');
  }

  function setMotion(m) {
    state.motion = clampMotion(m);
    if (state.motion === 'off') state.textMotion = false;
    saveState(state);
    renderMotionControl();
    renderGrid();
  }

  function setTextMotion(on) {
    state.textMotion = !!on && clampMotion(state.motion) !== 'off';
    saveState(state);
    renderMotionControl();
    renderGrid();
  }

  function frameClassFor(mode) {
    const p = framePresetById(mode);
    if (p.kind === 'off') return '';
    if (p.kind === 'solid') return ' er-frame-on er-frame-solid';
    const pulse = p.anim === 'pulse' ? ' er-frame-pulse' : ' er-frame-flow';
    return ' er-frame-on er-frame-anim' + pulse;
  }

  function applyFrameCssVars(el) {
    if (!el) return;
    const p = framePresetById(state.frameMode);
    const color = clampTextColor(state.frameColor || '#25f4ee');
    el.style.setProperty('--er-frame-color', color);
    if (p.kind === 'anim') {
      el.style.setProperty('--er-frame-grad', p.gradient || 'linear-gradient(90deg,#fff,#fff)');
      el.style.setProperty('--er-frame-anim-dur', p.dur || '4s');
    } else {
      el.style.removeProperty('--er-frame-grad');
      el.style.removeProperty('--er-frame-anim-dur');
    }
  }

  function frameSwatchStyle(preset, solidColor) {
    if (!preset || preset.kind === 'off') {
      return 'background:transparent;border:1px dashed rgba(255,255,255,.35)';
    }
    if (preset.kind === 'solid') {
      return 'background:' + clampTextColor(solidColor || '#25f4ee');
    }
    return 'background-image:' + (preset.gradient || 'linear-gradient(90deg,#fff,#aaa)');
  }

  function closeFrameMenu() {
    const menu = document.getElementById('er-frame-dd-menu');
    const btn = document.getElementById('er-frame-dd-btn');
    const wrap = document.getElementById('er-frame-dd');
    if (menu) menu.classList.add('hidden');
    if (btn) btn.setAttribute('aria-expanded', 'false');
    if (wrap) wrap.classList.remove('is-open');
  }

  function openFrameMenu() {
    closeFondoMenu();
    const menu = document.getElementById('er-frame-dd-menu');
    const btn = document.getElementById('er-frame-dd-btn');
    const wrap = document.getElementById('er-frame-dd');
    if (menu) menu.classList.remove('hidden');
    if (btn) btn.setAttribute('aria-expanded', 'true');
    if (wrap) wrap.classList.add('is-open');
  }

  function toggleFrameMenu() {
    const menu = document.getElementById('er-frame-dd-menu');
    if (!menu) return;
    if (menu.classList.contains('hidden')) openFrameMenu();
    else closeFrameMenu();
  }

  function renderFrameControls() {
    const mode = clampFrameMode(state.frameMode);
    const preset = framePresetById(mode);
    const color = clampTextColor(state.frameColor || '#25f4ee');
    const label = document.getElementById('er-frame-dd-label');
    const swatch = document.getElementById('er-frame-dd-swatch');
    const menu = document.getElementById('er-frame-dd-menu');
    const wrap = document.getElementById('er-frame-color-wrap');
    const input = document.getElementById('er-frame-color');
    if (label) label.textContent = preset.label;
    if (swatch) swatch.style.cssText = frameSwatchStyle(preset, color);
    if (wrap) wrap.classList.toggle('hidden', preset.kind !== 'solid');
    if (input) input.value = color;
    if (menu) {
      menu.innerHTML = FRAME_PRESETS.map((p) => {
        const on = p.id === mode ? ' is-on' : '';
        const hint = p.kind === 'anim' ? 'movimiento' : (p.kind === 'solid' ? 'elige color' : '');
        return `<button type="button" class="er-fondo-opt${on}" role="option" data-er-frame="${p.id}" aria-selected="${p.id === mode ? 'true' : 'false'}">
          <span class="er-frame-dd-swatch er-frame-opt-preview" style="${frameSwatchStyle(p, color)}" aria-hidden="true"></span>
          <span>${escapeHtml(p.label)}${hint ? `<small class="er-frame-opt-hint">${escapeHtml(hint)}</small>` : ''}</span>
        </button>`;
      }).join('');
    }
  }

  function setFrameMode(mode) {
    state.frameMode = clampFrameMode(mode);
    closeFrameMenu();
    saveState(state);
    renderFrameControls();
    renderGrid();
  }

  function setFrameColor(color) {
    state.frameColor = clampTextColor(color);
    if (framePresetById(state.frameMode).kind !== 'solid') state.frameMode = 'solid';
    saveState(state);
    renderFrameControls();
    renderGrid();
  }

  function renderGapToggle() {
    const on = document.getElementById('er-gap-on');
    const off = document.getElementById('er-gap-off');
    if (on) on.classList.toggle('is-on', !!state.gap);
    if (off) off.classList.toggle('is-on', !state.gap);
  }

  function renderSpreadToggle() {
    const on = document.getElementById('er-spread-on');
    const off = document.getElementById('er-spread-off');
    if (on) on.classList.toggle('is-on', !!state.spreadH);
    if (off) off.classList.toggle('is-on', !state.spreadH);
  }

  function renderCellSizeToggle() {
    const fit = document.getElementById('er-cellsize-fit');
    const fixed = document.getElementById('er-cellsize-fixed');
    if (fit) fit.classList.toggle('is-on', !state.fixedCellSize);
    if (fixed) fixed.classList.toggle('is-on', !!state.fixedCellSize);
  }

  /** Ancho fijo de celda (no se achica al poner más columnas). */
  const FIXED_CELL_W = 200;
  function cellWidthFixed() {
    return FIXED_CELL_W;
  }

  function cellWidthForSpread(cols, zoom, bakeZoom) {
    const c = Math.max(1, Number(cols) || 1);
    const base = Math.min(200, Math.max(72, Math.floor(720 / c)));
    const z = bakeZoom ? clampZoom(zoom) : 1;
    return Math.round(base * z);
  }

  function setSpreadH(on) {
    state.spreadH = !!on;
    saveState(state);
    renderSpreadToggle();
    renderGrid();
  }

  function setFixedCellSize(on) {
    state.fixedCellSize = !!on;
    saveState(state);
    renderCellSizeToggle();
    renderGrid();
    toastMsg(on
      ? 'Tamaño fijo · los cuadros no se achican (scroll / zoom si no caben)'
      : 'Cuadros se adaptan al ancho del panel');
  }

  function renderPickBar() {
    const bar = document.getElementById('er-pick-bar');
    const prev = document.getElementById('er-pick-preview-img');
    const title = document.querySelector('#er-pick-bar .er-pick-copy strong');
    const sub = document.querySelector('#er-pick-bar .er-pick-copy span');
    const grid = document.getElementById('er-grid');
    const busy = isBusy();
    if (bar) bar.classList.toggle('hidden', !busy);

    let previewSrc = '';
    if (pending) previewSrc = pending.src;
    else if (moveFrom) previewSrc = arrFor(moveFrom.kind)[moveFrom.slot]?.src || '';

    if (prev) prev.src = previewSrc || '';

    const kind = pending?.kind || moveFrom?.kind || 'image';
    const isGift = kind === 'gift';
    const isText = kind === 'text';
    const moving = !!moveFrom;

    if (title) {
      title.textContent = moving
        ? (isGift ? 'Mover regalo' : 'Mover imagen')
        : (isGift ? 'Elige cuadro para el regalo' : isText ? 'Elige cuadro para el texto' : 'Elige un cuadro');
    }
    if (sub) {
      if (moving) {
        sub.textContent = `Cuadro ${(moveFrom.slot + 1)} → toca el destino${isGift ? ' (abajo derecha)' : ''}.`;
      } else if (isGift) {
        sub.textContent = 'Toca el cuadro: el regalo queda abajo a la derecha, chico.';
      } else if (isText) {
        sub.textContent = 'Toca el cuadro. Luego puedes mover y agrandar el texto solo dentro de ese cuadro.';
      } else {
        sub.textContent = 'Toca dónde quieres poner la imagen (queda centrada).';
      }
    }
    if (prev) {
      const wrap = prev.parentElement;
      if (wrap) wrap.classList.toggle('is-text', isText && !moving);
      if (isText && !moving) prev.removeAttribute('src');
    }
    if (grid) {
      grid.classList.toggle('is-picking', busy);
      grid.classList.toggle('is-moving', moving);
      grid.classList.toggle('is-gift-place', isGift);
    }
  }

  function positionMenu(menu, x, y) {
    const pad = 8;
    const rect = menu.getBoundingClientRect();
    let left = x;
    let top = y;
    if (left + rect.width > window.innerWidth - pad) left = Math.max(pad, window.innerWidth - rect.width - pad);
    if (top + rect.height > window.innerHeight - pad) top = Math.max(pad, window.innerHeight - rect.height - pad);
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  }

  function showCtxMenu(x, y, slotIndex, textIdx, layerKind) {
    hideCtxMenu();
    ctxSlot = slotIndex;
    const list = textsAt(slotIndex);
    ctxTextIdx = (textIdx != null && textIdx >= 0 && textIdx < list.length)
      ? Number(textIdx)
      : (selectedText?.slot === slotIndex ? selectedText.idx : (list.length ? list.length - 1 : null));
    const ctxLayer = layerKind
      || (selectedFreeItem?.slot === slotIndex ? selectedFreeItem.kind : null)
      || (ctxTextIdx != null ? 'text' : (state.overlays[slotIndex] ? 'overlay' : (state.gifts[slotIndex] ? 'gift' : 'overlay')));
    window.__erCtxLayer = { kind: ctxLayer, textIdx: ctxTextIdx };
    const hasImg = !!state.overlays[slotIndex];
    const hasGift = !!state.gifts[slotIndex];
    const hasText = list.length > 0;
    const freeEdit = isFreeMove(slotIndex);
    const freeApplied = isFreeLayout(slotIndex);
    const canLayer = !!(hasImg || hasGift || hasText);
    const layerTargetLabel = ctxLayer === 'gift' ? ' (regalo)' : (ctxLayer === 'text' ? ' (texto)' : (ctxLayer === 'overlay' ? ' (imagen)' : ''));
    const active = hasText && ctxTextIdx != null ? list[ctxTextIdx] : null;
    const txStyle = active ? clampTextStyle(active.style) : '';
    const menu = document.createElement('div');
    menu.id = 'er-ctx-menu';
    menu.className = 'ied-ctx-menu er-ctx-menu';
    const layerBlock = canLayer ? `
      <button type="button" class="ied-ctx-item" data-act="layer-forward">Capa adelante${layerTargetLabel}</button>
      <button type="button" class="ied-ctx-item" data-act="layer-back">Capa atrás${layerTargetLabel}</button>
    ` : '';
    const freeBlock = freeEdit ? `
      <div class="ied-ctx-sep"></div>
      <button type="button" class="ied-ctx-item is-on" data-act="apply-free">Aplicar</button>
      ${layerBlock}
      <button type="button" class="ied-ctx-item" data-act="free-move">Cerrar edición</button>
      <button type="button" class="ied-ctx-item is-danger" data-act="clear-free">Quitar movimiento libre</button>
    ` : `
      <button type="button" class="ied-ctx-item${freeApplied ? ' is-on' : ''}" data-act="free-move">${freeApplied ? 'Editar movimiento libre' : 'Movimiento libre'}</button>
      ${freeApplied ? '<button type="button" class="ied-ctx-item is-danger" data-act="clear-free">Quitar movimiento libre</button>' : ''}
      ${freeApplied && canLayer ? `<div class="ied-ctx-sep"></div>${layerBlock}` : ''}
    `;
    menu.innerHTML = `
      <button type="button" class="ied-ctx-item" data-act="copy-image" ${hasImg ? '' : 'disabled'}>Copiar imagen</button>
      <button type="button" class="ied-ctx-item" data-act="paste-image" ${clipboardImage?.src ? '' : 'disabled'}>Pegar imagen</button>
      <button type="button" class="ied-ctx-item" data-act="move-image" ${hasImg ? '' : 'disabled'}>Mover imagen</button>
      <button type="button" class="ied-ctx-item is-danger" data-act="delete-image" ${hasImg ? '' : 'disabled'}>Borrar imagen</button>
      <div class="ied-ctx-sep"></div>
      <button type="button" class="ied-ctx-item" data-act="change-corner">Cambiar regalo…</button>
      <button type="button" class="ied-ctx-item" data-act="copy-gift" ${hasGift ? '' : 'disabled'}>Copiar regalo</button>
      <button type="button" class="ied-ctx-item" data-act="paste-gift" ${clipboardGift?.src ? '' : 'disabled'}>Pegar regalo</button>
      <button type="button" class="ied-ctx-item" data-act="move-gift" ${hasGift ? '' : 'disabled'}>Mover regalo</button>
      <button type="button" class="ied-ctx-item is-danger" data-act="delete-gift" ${hasGift ? '' : 'disabled'}>Borrar regalo</button>
      <div class="ied-ctx-sep"></div>
      <button type="button" class="ied-ctx-item" data-act="edit-text" ${hasText ? '' : 'disabled'}>Editar texto${list.length > 1 && ctxTextIdx != null ? ` (${ctxTextIdx + 1}/${list.length})` : ''}</button>
      <button type="button" class="ied-ctx-item${txStyle === 'rainbow' ? ' is-on' : ''}" data-act="text-rainbow" ${hasText ? '' : 'disabled'}>Arcoíris</button>
      <button type="button" class="ied-ctx-item${txStyle === 'aurora' ? ' is-on' : ''}" data-act="text-aurora" ${hasText ? '' : 'disabled'}>Aurora con movimiento</button>
      <button type="button" class="ied-ctx-item" data-act="text-color" ${hasText ? '' : 'disabled'}>Elegir color…</button>
      <button type="button" class="ied-ctx-item is-danger" data-act="delete-text" ${hasText ? '' : 'disabled'}>Borrar texto</button>
      <div class="ied-ctx-sep"></div>
      <button type="button" class="ied-ctx-item" data-act="dup-slot">Duplicar cuadro</button>
      ${freeBlock}
      <button type="button" class="ied-ctx-item" data-act="align-center" ${hasText ? '' : 'disabled'}>Texto · Centro</button>
      <button type="button" class="ied-ctx-item" data-act="align-top" ${hasText ? '' : 'disabled'}>Texto · Arriba</button>
      <button type="button" class="ied-ctx-item" data-act="align-br" ${hasText ? '' : 'disabled'}>Texto · ↘</button>
      <button type="button" class="ied-ctx-item" data-act="clear-slot">Vaciar cuadro</button>
      <button type="button" class="ied-ctx-item is-danger" data-act="remove-slot">Eliminar cuadro completo</button>
      <button type="button" class="ied-ctx-item is-danger" data-act="remove-empty-slots"${countEmptySlots() ? '' : ' disabled'}>Eliminar cuadros vacíos</button>
    `;
    document.body.appendChild(menu);
    positionMenu(menu, x, y);
  }

  function hideCtxMenu() {
    document.getElementById('er-ctx-menu')?.remove();
    document.getElementById('er-corner-type-menu')?.remove();
    ctxSlot = null;
    ctxTextIdx = null;
  }

  function showCornerTypeMenu(x, y, slotIndex) {
    document.getElementById('er-ctx-menu')?.remove();
    document.getElementById('er-corner-type-menu')?.remove();
    ctxSlot = (slotIndex == null || Number.isNaN(Number(slotIndex))) ? null : Number(slotIndex);
    const cur = (ctxSlot != null && state.gifts[ctxSlot]) ? (state.gifts[ctxSlot].type || '') : '';
    const menu = document.createElement('div');
    menu.id = 'er-corner-type-menu';
    menu.className = 'ied-ctx-menu er-ctx-menu';
    const opts = [
      ['gift', 'Regalo'],
      ['like', 'Like'],
      ['follow', 'Follow'],
      ['superfan', 'Super fan'],
      ['share', 'Compartir'],
    ];
    menu.innerHTML = opts.map(([key, label]) => {
      const ico = CORNER_MENU_ICONS[key] || '';
      const on = cur === key ? ' is-on' : '';
      return `<button type="button" class="ied-ctx-item er-corner-opt${on}" data-corner="${key}"><img class="er-corner-ico" src="${ico}" alt="" draggable="false"><span>${label}</span></button>`;
    }).join('');
    document.body.appendChild(menu);
    positionMenu(menu, x, y);
  }

  function setCornerOnSlot(slotIndex, item) {
    const i = Number(slotIndex);
    if (!Number.isFinite(i) || i < 0 || i >= state.count) return;
    state.gifts[i] = cloneItem(item);
    saveState(state);
    renderGrid();
    syncGiftToGameAction(i);
  }

  /** El regalo de un cuadro es el disparador de la acción ligada, así que
      cambiarlo aquí debe cambiarlo también en la acción del juego. */
  function syncGiftToGameAction(slotIndex) {
    try {
      const i = Number(slotIndex);
      const key = String(state.gameSync?.settingsKey || '').trim();
      const uid = String(state.gameSync?.uids?.[i] || '').trim();
      if (!key || !uid) return;
      const g = state.gifts[i];
      if (!g || !g.src) return;
      if (typeof window.applyEditorRapidoGiftToGameAction !== 'function') return;
      const type = String(g.type || 'gift');
      if (type === 'gift' && !g.giftId) {
        toastMsg('Imagen puesta. La acción del juego mantiene su regalo.');
        return;
      }
      const ok = window.applyEditorRapidoGiftToGameAction(key, uid, {
        type,
        giftId: g.giftId || '',
        giftName: g.name || '',
      });
      if (ok) toastMsg('Disparador actualizado en la acción del juego');
    } catch { /* ignore */ }
  }

  async function openGiftCatalogThen(onPick) {
    if (typeof openGiftModalCb !== 'function') {
      toastMsg('Catálogo de regalos no disponible. Recarga el panel.');
      return;
    }
    try {
      await openGiftModalCb((g) => {
        const src = proxiedSrc(g?.image || '');
        if (!src) {
          toastMsg('Ese regalo no tiene imagen');
          return;
        }
        onPick({ src, name: g.name || 'Regalo', type: 'gift', giftId: String(g?.id ?? '') });
      });
    } catch {
      toastMsg('No se pudo abrir el catálogo');
    }
  }

  function applyCornerType(slotIndex, cornerType) {
    hideCtxMenu();
    const placingNew = slotIndex == null;

    if (cornerType === 'gift') {
      openGiftCatalogThen((item) => {
        if (placingNew) startPick('gift', item.src, item.name, 'gift', item.giftId);
        else {
          setCornerOnSlot(slotIndex, item);
          toastMsg(`Regalo en el cuadro ${slotIndex + 1}`);
        }
      });
      return;
    }

    const preset = CORNER_PRESETS[cornerType];
    if (!preset) return;
    if (placingNew) {
      startPick('gift', preset.src, preset.name, preset.type);
      return;
    }
    setCornerOnSlot(slotIndex, preset);
    toastMsg(`${preset.name} en el cuadro ${slotIndex + 1}`);
  }

  function renderGrid() {
    const grid = document.getElementById('er-grid');
    const meta = document.getElementById('er-grid-meta');
    if (!grid) return;
    const lay = layoutFor(state.count, state.gridN);
    const bgSrc = resolveFondoSrc(state);
    const transparent = isTransparentFondo(state.fondo);
    const kind = pending?.kind || moveFrom?.kind || '';
    const frameMode = clampFrameMode(state.frameMode);
    const frameCls = frameClassFor(frameMode);
    grid.style.setProperty('--er-cols', String(lay.cols));
    grid.style.setProperty('--er-rows', String(lay.rows));
    applyFrameCssVars(grid);
    grid.dataset.count = String(state.count);
    grid.classList.toggle('is-tight', !state.gap);
    grid.classList.toggle('is-spread', !!state.spreadH);
    grid.classList.toggle('is-fixed-cells', !!state.fixedCellSize);
    const viewport = document.getElementById('er-canvas-viewport');
    const zoomWrap = document.getElementById('er-canvas-zoom');
    if (viewport) viewport.classList.toggle('is-fixed-cells', !!state.fixedCellSize);
    if (zoomWrap) zoomWrap.classList.toggle('is-fixed-cells', !!state.fixedCellSize);
    if (state.fixedCellSize) {
      grid.style.setProperty('--er-cell-w', cellWidthFixed() + 'px');
    } else if (state.spreadH) {
      grid.style.setProperty('--er-cell-w', cellWidthForSpread(lay.cols, state.zoom, false) + 'px');
    } else {
      grid.style.removeProperty('--er-cell-w');
    }
    applyImgScaleUi();
    applyGiftUi();
    grid.classList.toggle('is-picking', isBusy());
    grid.classList.toggle('is-moving', !!moveFrom);
    grid.classList.toggle('is-gift-place', kind === 'gift');
    grid.classList.toggle('is-text-place', kind === 'text');
    const cells = [];
    for (let i = 0; i < state.count; i++) {
      const ov = state.overlays[i];
      const gf = state.gifts[i];
      const txList = textsAt(i);
      const free = isFreeMove(i);
      const custom = usesCustomLayout(i);
      const mot = motionClass(state.motion);
      const ox = clampPct(ov?.x, 50);
      const oy = clampPct(ov?.y, 50);
      const gx = clampPct(gf?.x, 82);
      const gy = clampPct(gf?.y, 82);
      const oScale = clampItemScale(ov?.scale ?? 1);
      const gScale = clampItemScale(gf?.scale ?? 1);
      const oZ = Math.max(1, Number(ov?.z) || 2);
      const gZ = Math.max(1, Number(gf?.z) || 4);
      const oSel = free && isFreeItemSelected(i, 'overlay');
      const gSel = free && isFreeItemSelected(i, 'gift');
      let fg = '';
      if (ov?.src) {
        if (custom) {
          fg = `<div class="er-free-item er-free-overlay${free ? ' is-free-edit' : ''}${oSel ? ' is-item-selected' : ''}${mot}" data-free-kind="overlay" data-slot="${i}" style="left:${ox}%;top:${oy}%;--er-item-scale:${oScale};z-index:${oZ}" title="${free ? 'Clic = seleccionar · arrastra · asa / rueda = tamaño' : 'Layout libre'}">
            <img class="er-cell-fg is-free" src="${ov.src}" alt="" draggable="false">
            ${free ? '<span class="er-free-handle" data-free-resize="overlay" data-slot="' + i + '" title="Redimensionar"></span>' : ''}
          </div>`;
        } else {
          fg = `<img class="er-cell-fg${mot}" src="${ov.src}" alt="" draggable="false">`;
        }
      }
      let gift = '';
      if (gf?.src) {
        if (custom) {
          gift = `<div class="er-free-item er-free-gift${free ? ' is-free-edit' : ''}${gSel ? ' is-item-selected' : ''}${mot}" data-free-kind="gift" data-slot="${i}" style="left:${gx}%;top:${gy}%;--er-item-scale:${gScale};z-index:${gZ}" title="${free ? escapeHtml(gf.name || 'Regalo') + ' · clic = seleccionar · arrastra · asa / rueda = tamaño' : escapeHtml(gf.name || 'Regalo')}">
            <img class="er-cell-gift is-free" src="${gf.src}" alt="" draggable="false">
            ${free ? '<span class="er-free-handle" data-free-resize="gift" data-slot="' + i + '" title="Redimensionar"></span>' : ''}
          </div>`;
        } else {
          gift = `<img class="er-cell-gift${mot}" src="${gf.src}" alt="" draggable="false" title="${escapeHtml(gf.name || 'Regalo')}">`;
        }
      }
      const movingHere = moveFrom && moveFrom.slot === i;
      const bgHtml = (!transparent && bgSrc)
        ? `<img class="er-cell-bg" src="${bgSrc}" alt="" draggable="false">`
        : '';
      const tip = isBusy()
        ? 'Poner aquí'
        : (free
          ? 'Movimiento libre · arrastra / rueda = tamaño · pulsa Aplicar arriba'
          : (custom
            ? 'Layout libre aplicado · clic derecho → Editar / capas'
            : 'Arrastra para reordenar · clic derecho para opciones'));
      const txMot = (state.textMotion && state.motion !== 'off') ? motionClass(state.motion) : '';
      const textByTi = txList.map((tx, ti) => {
        const txStyle = clampTextStyle(tx.style);
        const txColor = clampTextColor(tx.color);
        const txStyleCls = txStyle === 'rainbow' ? ' er-tx-rainbow' : (txStyle === 'aurora' ? ' er-tx-aurora' : '');
        const sel = isTextSelected(i, ti) ? ' is-selected' : '';
        const tz = Math.max(1, Number(tx.z) || 3);
        return `<div class="er-cell-text${sel}${txMot}" data-text-slot="${i}" data-text-idx="${ti}" style="left:${tx.x}%;top:${tx.y}%;--er-text-scale:${tx.scale};--er-text-color:${txColor};z-index:${tz}" title="Doble clic para editar · clic derecho para estilo">
            <span class="er-cell-text-label${txStyleCls}">${escapeHtml(tx.text)}</span>
            <span class="er-text-handle" data-resize-slot="${i}" data-resize-idx="${ti}" title="Redimensionar"></span>
          </div>`;
      });
      const sortedLayers = [];
      if (fg) sortedLayers.push({ z: oZ, html: fg });
      textByTi.forEach((html, ti) => {
        sortedLayers.push({ z: Math.max(1, Number(txList[ti]?.z) || 3), html });
      });
      if (gift) sortedLayers.push({ z: gZ, html: gift });
      sortedLayers.sort((a, b) => a.z - b.z);
      cells.push(`
        <div class="er-cell${transparent ? ' is-transparent-bg' : ''}${ov?.src ? ' has-fg' : ''}${gf?.src ? ' has-gift' : ''}${txList.length ? ' has-text' : ''}${free ? ' is-free-move' : ''}${custom && !free ? ' is-free-applied' : ''}${movingHere ? ' is-move-src' : ''}${selectedSlot === i ? ' is-slot-selected' : ''}${frameCls}" data-slot="${i}" draggable="${isBusy() || free ? 'false' : 'true'}" title="${tip}">
          ${bgHtml}
          ${sortedLayers.map((p) => p.html).join('')}
        </div>
      `);
    }
    grid.innerHTML = cells.join('');
    updateFreeApplyBtn();
    if (meta) {
      const gapTxt = state.gap ? 'con espacio' : 'pegados';
      const imgs = state.overlays.slice(0, state.count).filter(Boolean).length;
      const gifts = state.gifts.slice(0, state.count).filter(Boolean).length;
      const texts = state.texts.slice(0, state.count).reduce((n, cell) => n + normalizeTextList(cell).length, 0);
      const bits = [`${state.count} cuadros`, fondoLabel(state), gapTxt];
      if (state.spreadH) bits.push('estirado');
      if (state.fixedCellSize) bits.push('tamaño fijo');
      if (clampGridN(state.gridN)) {
        const lay = layoutFor(state.count, state.gridN);
        bits.push(lay.cols + '×' + lay.rows);
      }
      if (imgs) bits.push(`${imgs} img`);
      if (gifts) bits.push(`${gifts} regalo${gifts === 1 ? '' : 's'}`);
      if (texts) bits.push(`${texts} texto${texts === 1 ? '' : 's'}`);
      meta.textContent = bits.join(' · ');
    }
  }

  function setCount(n) {
    state.gridN = 0;
    state.count = clampCount(n);
    clearSelectionOutOfRange();
    if (moveFrom && moveFrom.slot >= state.count) cancelPick();
    saveState(state);
    renderCountControls();
    renderGrid();
  }

  function setGap(on) {
    state.gap = !!on;
    saveState(state);
    renderGapToggle();
    renderGrid();
  }

  function cancelPick() {
    pending = null;
    moveFrom = null;
    renderPickBar();
    renderGrid();
  }

  function startPick(kind, src, name, cornerType, giftId) {
    moveFrom = null;
    pending = {
      kind,
      src,
      name: name || '',
      cornerType: cornerType || (kind === 'gift' ? 'gift' : undefined),
      giftId: String(giftId || ''),
    };
    hideCtxMenu();
    renderPickBar();
    renderGrid();
    if (kind === 'gift') toastMsg('Elige el cuadro para el icono de esquina');
    else if (kind === 'text') toastMsg('Elige el cuadro para el texto');
    else toastMsg('Elige el cuadro donde poner la imagen');
  }

  async function startPickFromSrc(kind, src, name) {
    let out = src;
    if (typeof src === 'string' && src.startsWith('blob:')) {
      try {
        const blob = await fetch(src).then((r) => r.blob());
        out = await new Promise((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(String(r.result || ''));
          r.onerror = () => reject(r.error || new Error('read'));
          r.readAsDataURL(blob);
        });
      } catch {
        out = src;
      }
    }
    if (!out) {
      toastMsg('No se pudo abrir la imagen');
      return;
    }
    if (String(out).startsWith('data:')) {
      toastMsg('Guardando imagen…');
      out = await persistSrcIfNeeded(out);
    }
    startPick(kind, out, name);
  }

  function startMove(kind, slotIndex) {
    const i = Number(slotIndex);
    if (!arrFor(kind)[i]) return;
    pending = null;
    moveFrom = { kind, slot: i };
    hideCtxMenu();
    renderPickBar();
    renderGrid();
    toastMsg('Elige el cuadro destino');
  }

  function placeOnSlot(slotIndex) {
    const i = Number(slotIndex);
    if (!Number.isFinite(i) || i < 0 || i >= state.count) return;

    if (moveFrom) {
      const { kind, slot: from } = moveFrom;
      if (from === i) {
        cancelPick();
        return;
      }
      const uids = state.gameSync?.uids;
      const linked = !!(uids && (String(uids[from] || '') || String(uids[i] || '')));
      moveFrom = null;
      if (linked) {
        /* Con plantilla ligada a Juegos cada cuadro ES una acción. Mover solo el
           arte dejaría el cuadro mostrando una acción y mandando sobre otra, así
           que se mueve el cuadro entero (arte, regalo, textos y enlace). */
        swapSlots(from, i);
        saveState(state);
        renderPickBar();
        renderGrid();
        toastMsg(`Cuadro movido al ${i + 1}`);
        return;
      }
      const arr = arrFor(kind);
      const tmp = cloneItem(arr[i]);
      arr[i] = cloneItem(arr[from]);
      arr[from] = tmp;
      // La colocación libre vive en el cuadro, no en la imagen: si no se propaga,
      // lo movido pierde su posición personalizada al llegar al destino.
      if (isFreeLayout(from) && !isFreeLayout(i)) {
        if (!state.freeLayout) state.freeLayout = emptyFreeMove();
        state.freeLayout[i] = true;
      }
      saveState(state);
      renderPickBar();
      renderGrid();
      toastMsg(`${kind === 'gift' ? 'Regalo' : 'Imagen'} movido al cuadro ${i + 1}`);
      return;
    }

    if (!pending) return;

    if (pending.kind === 'text') {
      const list = textsAt(i).slice();
      if (list.length >= MAX_TEXTS_PER_CELL) {
        pending = null;
        renderPickBar();
        toastMsg(`Máximo ${MAX_TEXTS_PER_CELL} textos por cuadro`);
        return;
      }
      const t = defaultText();
      const n = list.length;
      t.x = Math.min(88, Math.max(12, 42 + (n % 3) * 10));
      t.y = Math.min(88, Math.max(12, 36 + Math.floor(n / 3) * 14));
      list.push(t);
      setTextsAt(i, list);
      selectedText = { slot: i, idx: list.length - 1 };
      pending = null;
      saveState(state);
      renderPickBar();
      renderGrid();
      toastMsg(`Texto ${list.length} en el cuadro ${i + 1}. Puedes añadir más.`);
      return;
    }

    const arr = arrFor(pending.kind);
    if (pending.kind === 'gift') {
      arr[i] = { src: pending.src, name: pending.name, type: pending.cornerType || 'gift' };
      if (pending.giftId) arr[i].giftId = String(pending.giftId);
    } else {
      arr[i] = { src: pending.src, name: pending.name };
    }
    const wasGift = pending.kind === 'gift';
    const placed = arr[i];
    pending = null;
    saveState(state);
    renderPickBar();
    renderGrid();
    toastMsg(wasGift
      ? `Icono en el cuadro ${i + 1} (esquina)`
      : `Imagen puesta en el cuadro ${i + 1}`);
    if (wasGift) syncGiftToGameAction(i);
    // Subir data: al disco ya (si no, un sync posterior o localStorage lleno las borra;
    // los iconos default del juego son rutas cortas y por eso "no se borran").
    if (placed?.src && String(placed.src).startsWith('data:')) {
      replaceDataSrc(placed).then((next) => {
        if (!next?.src || next.src === placed.src) return;
        if (arr[i] !== placed && arr[i]?.src !== placed.src) return;
        arr[i] = next;
        saveState(state);
        renderGrid();
        schedulePublishLive();
      }).catch(() => {});
    }
    return;
  }

  function editTextAt(slotIndex, textIdx) {
    const idx = textIdx != null ? Number(textIdx) : ctxTextIdx;
    beginInlineEdit(Number(slotIndex), idx);
  }

  function beginInlineEdit(slotIndex, textIdx) {
    const i = Number(slotIndex);
    const ti = Number(textIdx);
    const cur = getText(i, ti);
    if (!cur || isBusy()) return;
    if (textEditing && (textEditing.slot !== i || textEditing.idx !== ti)) {
      commitInlineEdit(textEditing.slot, textEditing.idx, true);
    }
    textDrag = null;
    selectedText = { slot: i, idx: ti };
    textEditing = { slot: i, idx: ti };
    renderGrid();
    const textEl = document.querySelector(`.er-cell-text[data-text-slot="${i}"][data-text-idx="${ti}"]`);
    const label = textEl?.querySelector('.er-cell-text-label');
    if (!textEl || !label) {
      textEditing = null;
      return;
    }
    textEl.classList.add('is-editing', 'is-selected');
    label.contentEditable = 'true';
    label.spellcheck = false;
    label.focus();
    try {
      const range = document.createRange();
      range.selectNodeContents(label);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } catch {}

    const onKey = (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        label.blur();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        label.textContent = cur.text || 'Tu texto';
        label.blur();
      }
      e.stopPropagation();
    };
    const onBlur = () => {
      label.removeEventListener('keydown', onKey);
      commitInlineEdit(i, ti, false);
    };
    label.addEventListener('keydown', onKey);
    label.addEventListener('blur', onBlur, { once: true });
  }

  function commitInlineEdit(slotIndex, textIdx, skipRender) {
    const i = Number(slotIndex);
    const ti = Number(textIdx);
    const textEl = document.querySelector(`.er-cell-text[data-text-slot="${i}"][data-text-idx="${ti}"]`);
    const label = textEl?.querySelector('.er-cell-text-label');
    const list = textsAt(i).slice();
    const cur = list[ti];
    textEditing = null;
    if (!cur) return;
    let next = cur.text;
    if (label) {
      label.contentEditable = 'false';
      next = String(label.innerText || '').replace(/\u00a0/g, ' ').trim() || 'Tu texto';
    }
    list[ti] = cloneText({ ...cur, text: next });
    setTextsAt(i, list);
    selectedText = { slot: i, idx: ti };
    saveState(state);
    if (!skipRender) renderGrid();
  }

  function setTextStyle(slotIndex, style, textIdx) {
    const i = Number(slotIndex);
    const ti = textIdx != null ? Number(textIdx) : (ctxTextIdx != null ? ctxTextIdx : selectedText?.idx);
    const list = textsAt(i).slice();
    const cur = list[ti];
    if (!cur) return;
    list[ti] = cloneText({ ...cur, style: clampTextStyle(style) });
    setTextsAt(i, list);
    selectedText = { slot: i, idx: ti };
    saveState(state);
    renderGrid();
    toastMsg(style === 'rainbow' ? 'Arcoíris aplicado' : style === 'aurora' ? 'Aurora aplicada' : 'Color sólido');
  }

  function pickTextColor(slotIndex, textIdx) {
    const i = Number(slotIndex);
    const ti = textIdx != null ? Number(textIdx) : (ctxTextIdx != null ? ctxTextIdx : selectedText?.idx);
    const cur = getText(i, ti);
    if (!cur) return;
    const input = document.getElementById('er-text-color-input');
    if (!input) return;
    input.value = clampTextColor(cur.color);
    const onChange = () => {
      const list = textsAt(i).slice();
      if (!list[ti]) return;
      list[ti] = cloneText({
        ...list[ti],
        style: 'solid',
        color: clampTextColor(input.value),
      });
      setTextsAt(i, list);
      selectedText = { slot: i, idx: ti };
      saveState(state);
      renderGrid();
      toastMsg('Color aplicado');
      input.removeEventListener('change', onChange);
      input.removeEventListener('input', onInput);
    };
    const onInput = () => {
      const el = document.querySelector(`.er-cell-text[data-text-slot="${i}"][data-text-idx="${ti}"]`);
      const label = el?.querySelector('.er-cell-text-label');
      if (label) {
        label.classList.remove('er-tx-rainbow', 'er-tx-aurora');
        el.style.setProperty('--er-text-color', clampTextColor(input.value));
      }
    };
    input.addEventListener('change', onChange);
    input.addEventListener('input', onInput);
    input.click();
  }

  function deleteTextAt(slotIndex, textIdx) {
    const i = Number(slotIndex);
    const ti = textIdx != null ? Number(textIdx) : (ctxTextIdx != null ? ctxTextIdx : selectedText?.idx);
    const list = textsAt(i).slice();
    if (ti == null || ti < 0 || ti >= list.length) return;
    list.splice(ti, 1);
    setTextsAt(i, list);
    if (selectedText?.slot === i) {
      selectedText = list.length
        ? { slot: i, idx: Math.min(ti, list.length - 1) }
        : null;
    }
    saveState(state);
    renderGrid();
    toastMsg('Texto borrado');
  }

  function applyTextPos(slot, idx, xPct, yPct) {
    const list = textsAt(slot);
    const t = list[idx];
    if (!t) return;
    t.x = Math.min(92, Math.max(8, xPct));
    t.y = Math.min(92, Math.max(8, yPct));
    const el = document.querySelector(`.er-cell-text[data-text-slot="${slot}"][data-text-idx="${idx}"]`);
    if (el) {
      el.style.left = `${t.x}%`;
      el.style.top = `${t.y}%`;
    }
  }

  function applyTextScale(slot, idx, scale) {
    const list = textsAt(slot);
    const t = list[idx];
    if (!t) return;
    t.scale = Math.min(3, Math.max(0.4, scale));
    const el = document.querySelector(`.er-cell-text[data-text-slot="${slot}"][data-text-idx="${idx}"]`);
    if (el) el.style.setProperty('--er-text-scale', String(t.scale));
  }

  function deleteKind(kind, slotIndex) {
    const i = Number(slotIndex);
    if (!arrFor(kind)[i]) return;
    arrFor(kind)[i] = null;
    if (moveFrom && moveFrom.kind === kind && moveFrom.slot === i) moveFrom = null;
    saveState(state);
    renderPickBar();
    renderGrid();
    toastMsg(kind === 'gift' ? 'Regalo borrado' : 'Imagen borrada');
  }

  function copyKind(kind, slotIndex) {
    const o = arrFor(kind)[slotIndex];
    if (!o?.src) return;
    if (kind === 'gift') clipboardGift = cloneItem(o);
    else clipboardImage = cloneItem(o);
    toastMsg('Copiado');
  }

  async function pasteKind(kind, slotIndex) {
    const clip = kind === 'gift' ? clipboardGift : clipboardImage;
    if (!clip?.src) return;
    const i = Number(slotIndex);
    if (!Number.isFinite(i) || i < 0 || i >= state.count) return;
    const item = cloneItem(clip);
    if (item?.src && String(item.src).startsWith('data:')) {
      item.src = await persistSrcIfNeeded(item.src);
    }
    arrFor(kind)[i] = item;
    saveState(state);
    renderGrid();
    toastMsg(`Pegado en el cuadro ${i + 1}`);
  }

  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result || ''));
      r.onerror = () => reject(r.error || new Error('No se pudo leer el archivo'));
      r.readAsDataURL(file);
    });
  }

  function wire() {
    if (wired) return;
    wired = true;
    document.getElementById('er-count-minus')?.addEventListener('click', () => setCount(state.count - 1));
    document.getElementById('er-count-plus')?.addEventListener('click', () => setCount(state.count + 1));
    document.getElementById('er-count-input')?.addEventListener('change', (e) => {
      setCount(e.target.value);
    });
    document.getElementById('er-count-input')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        setCount(e.target.value);
        e.target.blur();
      }
    });
    document.getElementById('er-gap-on')?.addEventListener('click', () => setGap(true));
    document.getElementById('er-gap-off')?.addEventListener('click', () => setGap(false));
    document.getElementById('er-cellsize-fit')?.addEventListener('click', () => setFixedCellSize(false));
    document.getElementById('er-cellsize-fixed')?.addEventListener('click', () => setFixedCellSize(true));
    document.getElementById('er-spread-on')?.addEventListener('click', () => setSpreadH(true));
    document.getElementById('er-spread-off')?.addEventListener('click', () => setSpreadH(false));
    document.getElementById('er-grid-auto')?.addEventListener('click', () => setGridAuto());
    document.getElementById('er-remove-empty')?.addEventListener('click', () => removeEmptySlots());
    document.getElementById('er-grid-fixed')?.addEventListener('click', () => setGridFixedMode());
    document.querySelectorAll('#er-grid-n-btns [data-er-grid-n]').forEach((btn) => {
      btn.addEventListener('click', () => setGridN(btn.dataset.erGridN));
    });
    document.getElementById('er-grid-custom-btn')?.addEventListener('click', () => openGridCustomPanel());
    document.getElementById('er-grid-custom-apply')?.addEventListener('click', () => {
      const c = document.getElementById('er-grid-cols')?.value;
      const r = document.getElementById('er-grid-rows')?.value;
      setGridCustom(c, r);
    });
    const applyCustomOnEnter = (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      document.getElementById('er-grid-custom-apply')?.click();
    };
    document.getElementById('er-grid-cols')?.addEventListener('keydown', applyCustomOnEnter);
    document.getElementById('er-grid-rows')?.addEventListener('keydown', applyCustomOnEnter);
    document.getElementById('er-motion')?.addEventListener('change', (e) => {
      setMotion(e.target.value);
    });
    document.getElementById('er-text-motion')?.addEventListener('change', (e) => {
      setTextMotion(!!e.target.checked);
    });
    document.getElementById('er-tpl-save')?.addEventListener('click', () => { saveCurrentTemplate().catch(() => {}); });
    document.getElementById('er-tpl-new')?.addEventListener('click', () => newBlankWorking());
    document.getElementById('er-tpl-delete')?.addEventListener('click', () => { deleteCurrentTemplate().catch(() => {}); });
    document.getElementById('er-tpl-select')?.addEventListener('change', (e) => {
      const id = e.target.value;
      if (id) loadTemplateById(id).catch(() => {});
      else renderTplSelect();
    });
    let nameAutosaveT = null;
    document.getElementById('er-tpl-name')?.addEventListener('input', () => {
      if (!activeTemplateId()) return;
      clearTimeout(nameAutosaveT);
      nameAutosaveT = setTimeout(() => { scheduleAutosaveTemplate(); }, 400);
    });
    document.getElementById('er-ov-copy')?.addEventListener('click', () => copyOverlayUrl());
    document.getElementById('er-undo')?.addEventListener('click', () => undoEr());
    document.getElementById('er-apply-free')?.addEventListener('click', () => applyActiveFreeMoves());
    document.getElementById('er-clear-free')?.addEventListener('click', () => clearActiveFreeLayout());
    document.getElementById('er-redo')?.addEventListener('click', () => redoEr());
    document.getElementById('er-dup-slot')?.addEventListener('click', () => duplicateSlot(selectedSlot));
    document.getElementById('er-export-montage')?.addEventListener('click', () => { exportMontagePng().catch(() => toastMsg('No se pudo exportar')); });
    document.getElementById('er-export-montage-gif')?.addEventListener('click', () => { exportMontageGif().catch(() => toastMsg('No se pudo exportar GIF')); });
    document.getElementById('er-zoom-in')?.addEventListener('click', () => setCanvasZoom(clampZoom(state.zoom) + 0.1));
    document.getElementById('er-zoom-out')?.addEventListener('click', () => setCanvasZoom(clampZoom(state.zoom) - 0.1));
    document.getElementById('er-zoom-fit')?.addEventListener('click', () => setCanvasZoom(1));
    const imgScaleRange = document.getElementById('er-img-scale');
    imgScaleRange?.addEventListener('input', () => {
      setImgScale(Number(imgScaleRange.value) / 100, { skipSave: true });
    });
    imgScaleRange?.addEventListener('change', () => {
      setImgScale(Number(imgScaleRange.value) / 100);
    });
    const giftScaleRange = document.getElementById('er-gift-scale');
    giftScaleRange?.addEventListener('input', () => {
      setGiftScale(Number(giftScaleRange.value) / 100, { skipSave: true });
    });
    giftScaleRange?.addEventListener('change', () => {
      setGiftScale(Number(giftScaleRange.value) / 100);
    });
    document.querySelectorAll('#er-gift-pos-tools [data-er-gift-pos]').forEach((btn) => {
      btn.addEventListener('click', () => setGiftPos(btn.dataset.erGiftPos));
    });
    document.querySelectorAll('[data-er-align]').forEach((btn) => {
      btn.addEventListener('click', () => alignSelectedText(btn.dataset.erAlign));
    });
    document.getElementById('er-fondo-dd-btn')?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleFondoMenu();
    });
    document.getElementById('er-fondo-dd-menu')?.addEventListener('click', (e) => {
      const opt = e.target.closest?.('[data-fondo]');
      if (!opt) return;
      e.preventDefault();
      setFondo(opt.dataset.fondo);
    });
    document.addEventListener('click', (e) => {
      if (e.target?.closest?.('#er-fondo-dd')) return;
      closeFondoMenu();
    });
    document.getElementById('er-fondo-upload')?.addEventListener('click', () => {
      document.getElementById('er-fondo-file')?.click();
    });
    document.getElementById('er-fondo-file')?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (!file) return;
      try {
        await setCustomFondoFromFile(file);
      } catch {
        toastMsg('No se pudo abrir la imagen');
      }
    });
    document.getElementById('er-frame-dd-btn')?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleFrameMenu();
    });
    document.getElementById('er-frame-dd-menu')?.addEventListener('click', (e) => {
      const opt = e.target.closest?.('[data-er-frame]');
      if (!opt) return;
      e.preventDefault();
      setFrameMode(opt.dataset.erFrame);
    });
    document.addEventListener('click', (e) => {
      if (e.target?.closest?.('#er-frame-dd')) return;
      closeFrameMenu();
    });
    document.getElementById('er-frame-color')?.addEventListener('input', (e) => {
      setFrameColor(e.target.value);
    });
    document.getElementById('er-add-image')?.addEventListener('click', () => {
      document.getElementById('er-image-file')?.click();
    });
    document.getElementById('er-add-games')?.addEventListener('click', () => {
      if (typeof window.openEditorGamesPicker !== 'function') {
        toastMsg('No se pudo abrir Juegos. Recarga el panel.');
        return;
      }
      window.openEditorGamesPicker((src, name) => {
        startPickFromSrc('image', src, name || 'acción')
          .catch(() => toastMsg('No se pudo abrir el icono'));
      });
    });
    document.getElementById('er-add-text')?.addEventListener('click', () => {
      startPick('text');
    });
    document.getElementById('er-add-gift')?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const btn = e.currentTarget;
      const rect = btn.getBoundingClientRect();
      // Abrir tras el click para que el listener global no lo cierre al instante
      setTimeout(() => {
        showCornerTypeMenu(rect.left, rect.bottom + 6, null);
      }, 0);
    });
    document.getElementById('er-image-file')?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (!file) return;
      try {
        const dataUrl = await readFileAsDataUrl(file);
        if (!dataUrl) throw new Error('vacío');
        toastMsg('Guardando imagen…');
        const src = await persistSrcIfNeeded(dataUrl);
        startPick('image', src, file.name || 'imagen');
      } catch {
        toastMsg('No se pudo abrir la imagen');
      }
    });
    document.getElementById('er-pick-cancel')?.addEventListener('click', cancelPick);
    document.getElementById('er-dl-png')?.addEventListener('click', () => {
      if (typeof window.openPngDlModal !== 'function') {
        toastMsg('No se pudo abrir Descargar PNG. Recarga el panel.');
        return;
      }
      window.openPngDlModal({
        onPickImage: (src, name) => {
          startPickFromSrc('image', src, name).catch(() => toastMsg('No se pudo abrir la imagen'));
        },
      });
    });
    const grid = document.getElementById('er-grid');

    function onItemDragMove(e) {
      if (!itemDrag) return;
      if (e.pointerId != null && itemDrag.pointerId != null && e.pointerId !== itemDrag.pointerId) return;
      const cell = document.querySelector(`.er-cell[data-slot="${itemDrag.slot}"]`);
      if (!cell) return;
      const rect = cell.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return;
      const dist = Math.abs(e.clientX - itemDrag.startX) + Math.abs(e.clientY - itemDrag.startY);
      if (dist > 3) itemDrag.moved = true;
      const arr = itemDrag.kind === 'gift' ? state.gifts : state.overlays;
      const cur = arr[itemDrag.slot];
      if (!cur) return;
      const wrap = document.querySelector(`.er-cell[data-slot="${itemDrag.slot}"] .er-free-item[data-free-kind="${itemDrag.kind}"]`);
      if (itemDrag.mode === 'resize') {
        const delta = ((e.clientX - itemDrag.startX) + (e.clientY - itemDrag.startY))
          / Math.min(rect.width, rect.height);
        applyItemScale(itemDrag.kind, itemDrag.slot, itemDrag.origScale + delta * 1.6);
        return;
      }
      const dx = ((e.clientX - itemDrag.startX) / rect.width) * 100;
      const dy = ((e.clientY - itemDrag.startY) / rect.height) * 100;
      const nx = clampPct(itemDrag.origX + dx);
      const ny = clampPct(itemDrag.origY + dy);
      cur.x = nx;
      cur.y = ny;
      if (wrap) {
        wrap.style.left = nx + '%';
        wrap.style.top = ny + '%';
      }
    }

    function onItemDragEnd(e) {
      if (!itemDrag) return;
      if (e && e.pointerId != null && itemDrag.pointerId != null && e.pointerId !== itemDrag.pointerId) return;
      const moved = !!itemDrag.moved;
      const slot = itemDrag.slot;
      const kind = itemDrag.kind;
      const wrap = document.querySelector(`.er-cell[data-slot="${slot}"] .er-free-item[data-free-kind="${kind}"]`);
      wrap?.classList.remove('is-dragging');
      itemDrag = null;
      document.removeEventListener('pointermove', onItemDragMove, true);
      document.removeEventListener('pointerup', onItemDragEnd, true);
      document.removeEventListener('pointercancel', onItemDragEnd, true);
      document.body.classList.remove('er-item-dragging', 'er-item-resizing');
      selectedFreeItem = { slot, kind };
      wrap?.classList.add('is-item-selected');
      document.querySelectorAll(`.er-cell[data-slot="${slot}"] .er-free-item.is-item-selected`).forEach((el) => {
        if (el.dataset.freeKind !== kind) el.classList.remove('is-item-selected');
      });
      if (moved) {
        ignoreNextGridClick = true;
        saveState(state);
      } else {
        // solo clic: re-render para mostrar asa de selección
        renderGrid();
      }
    }

    function onTextDragMove(e) {
      if (!textDrag) return;
      if (e.pointerId != null && textDrag.pointerId != null && e.pointerId !== textDrag.pointerId) return;
      const cell = document.querySelector(`.er-cell[data-slot="${textDrag.slot}"]`);
      if (!cell) return;
      const rect = cell.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return;
      const dist = Math.abs(e.clientX - textDrag.startX) + Math.abs(e.clientY - textDrag.startY);
      if (dist > 3) textDrag.moved = true;
      if (textDrag.mode === 'move') {
        const dx = ((e.clientX - textDrag.startX) / rect.width) * 100;
        const dy = ((e.clientY - textDrag.startY) / rect.height) * 100;
        applyTextPos(textDrag.slot, textDrag.idx, textDrag.origX + dx, textDrag.origY + dy);
      } else {
        const dx = e.clientX - textDrag.startX;
        const dy = e.clientY - textDrag.startY;
        const delta = (dx + dy) / Math.min(rect.width, rect.height);
        applyTextScale(textDrag.slot, textDrag.idx, textDrag.origScale + delta * 1.6);
      }
    }

    function onTextDragEnd(e) {
      if (!textDrag) return;
      if (e && e.pointerId != null && textDrag.pointerId != null && e.pointerId !== textDrag.pointerId) return;
      const slot = textDrag.slot;
      const idx = textDrag.idx;
      const moved = !!textDrag.moved;
      textDrag = null;
      document.removeEventListener('pointermove', onTextDragMove, true);
      document.removeEventListener('pointerup', onTextDragEnd, true);
      document.removeEventListener('pointercancel', onTextDragEnd, true);
      document.body.classList.remove('er-text-dragging');
      const textEl = document.querySelector(`.er-cell-text[data-text-slot="${slot}"][data-text-idx="${idx}"]`);
      textEl?.classList.remove('is-dragging');
      selectedText = { slot, idx };
      textEl?.classList.add('is-selected');
      if (moved) {
        ignoreNextGridClick = true;
        saveState(state);
      }
    }

    grid?.addEventListener('click', (e) => {
      if (ignoreNextGridClick) {
        ignoreNextGridClick = false;
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (e.target.closest?.('.er-cell-text, .er-text-handle, .er-free-item, .er-free-handle')) return;
      if (!isBusy()) {
        if (selectedText != null && textEditing == null) {
          selectedText = null;
          renderGrid();
        }
        return;
      }
      const cell = e.target.closest?.('.er-cell');
      if (!cell) return;
      placeOnSlot(cell.dataset.slot);
    });
    grid?.addEventListener('dblclick', (e) => {
      const textEl = e.target.closest?.('.er-cell-text');
      if (!textEl || isBusy()) return;
      e.preventDefault();
      e.stopPropagation();
      beginInlineEdit(Number(textEl.dataset.textSlot), Number(textEl.dataset.textIdx));
    });
    grid?.addEventListener('pointerdown', (e) => {
      if (isBusy()) return;
      if (textEditing != null) return;
      if (e.button != null && e.button !== 0) return;

      const freeHandle = e.target.closest?.('.er-free-handle');
      const freeWrap = e.target.closest?.('.er-free-item.is-free-edit');
      if (freeHandle || freeWrap) {
        const slot = Number((freeHandle || freeWrap).dataset.slot);
        const kind = (freeHandle?.dataset.freeResize || freeWrap?.dataset.freeKind) === 'gift' ? 'gift' : 'overlay';
        if (!isFreeMove(slot)) return;
        const item = kind === 'gift' ? state.gifts[slot] : state.overlays[slot];
        if (!item?.src) return;
        ensureFreePos(slot);
        e.preventDefault();
        e.stopPropagation();
        selectedFreeItem = { slot, kind };
        selectedText = null;
        setSelectedSlot(slot);
        document.querySelectorAll('.er-free-item.is-item-selected').forEach((el) => el.classList.remove('is-item-selected'));
        const wrap = document.querySelector(`.er-cell[data-slot="${slot}"] .er-free-item[data-free-kind="${kind}"]`);
        wrap?.classList.add('is-item-selected', 'is-dragging');
        const resizing = !!freeHandle;
        document.body.classList.add(resizing ? 'er-item-resizing' : 'er-item-dragging');
        itemDrag = {
          mode: resizing ? 'resize' : 'move',
          kind,
          slot,
          startX: e.clientX,
          startY: e.clientY,
          origX: clampPct(item.x, kind === 'gift' ? 82 : 50),
          origY: clampPct(item.y, kind === 'gift' ? 82 : 50),
          origScale: clampItemScale(item.scale ?? 1),
          moved: false,
          pointerId: e.pointerId,
        };
        document.addEventListener('pointermove', onItemDragMove, true);
        document.addEventListener('pointerup', onItemDragEnd, true);
        document.addEventListener('pointercancel', onItemDragEnd, true);
        try { (freeHandle || freeWrap).setPointerCapture(e.pointerId); } catch {}
        return;
      }

      const handle = e.target.closest?.('.er-text-handle');
      const textEl = e.target.closest?.('.er-cell-text');
      if (!textEl && !handle) return;
      const slot = Number(handle?.dataset.resizeSlot ?? textEl?.dataset.textSlot);
      const idx = Number(handle?.dataset.resizeIdx ?? textEl?.dataset.textIdx);
      const t = getText(slot, idx);
      if (!t) return;
      e.stopPropagation();

      if (!handle) {
        const now = Date.now();
        if (lastTextTap.slot === slot && lastTextTap.idx === idx && (now - lastTextTap.t) < 380) {
          lastTextTap = { slot: -1, idx: -1, t: 0 };
          e.preventDefault();
          beginInlineEdit(slot, idx);
          return;
        }
        lastTextTap = { slot, idx, t: now };
      }

      e.preventDefault();
      selectedText = { slot, idx };
      document.querySelectorAll('.er-cell-text.is-selected').forEach((el) => el.classList.remove('is-selected'));
      textEl?.classList.add('is-selected', 'is-dragging');
      document.body.classList.add('er-text-dragging');
      textDrag = {
        mode: handle ? 'resize' : 'move',
        slot,
        idx,
        startX: e.clientX,
        startY: e.clientY,
        origX: t.x,
        origY: t.y,
        origScale: t.scale,
        moved: false,
        pointerId: e.pointerId,
      };
      document.addEventListener('pointermove', onTextDragMove, true);
      document.addEventListener('pointerup', onTextDragEnd, true);
      document.addEventListener('pointercancel', onTextDragEnd, true);
      try { (handle || textEl).setPointerCapture(e.pointerId); } catch {}
    });
    grid?.addEventListener('wheel', (e) => {
      const freeWrap = e.target.closest?.('.er-free-item.is-free-edit');
      if (freeWrap && !isBusy()) {
        const slot = Number(freeWrap.dataset.slot);
        const kind = freeWrap.dataset.freeKind === 'gift' ? 'gift' : 'overlay';
        if (!isFreeMove(slot)) return;
        const item = kind === 'gift' ? state.gifts[slot] : state.overlays[slot];
        if (!item?.src) return;
        e.preventDefault();
        e.stopPropagation();
        selectedFreeItem = { slot, kind };
        ensureFreePos(slot);
        applyItemScale(kind, slot, (item.scale || 1) + (e.deltaY < 0 ? 0.08 : -0.08));
        saveState(state);
        freeWrap.classList.add('is-item-selected');
        return;
      }
      const textEl = e.target.closest?.('.er-cell-text');
      if (!textEl || isBusy() || textEditing != null) return;
      const slot = Number(textEl.dataset.textSlot);
      const idx = Number(textEl.dataset.textIdx);
      const t = getText(slot, idx);
      if (!t) return;
      e.preventDefault();
      selectedText = { slot, idx };
      applyTextScale(slot, idx, t.scale + (e.deltaY < 0 ? 0.08 : -0.08));
      saveState(state);
      textEl.classList.add('is-selected');
    }, { passive: false });

    grid?.addEventListener('click', (e) => {
      if (isBusy()) return;
      if (e.target.closest?.('.er-cell-text, .er-text-handle, .er-free-item, .er-free-handle')) return;
      const cell = e.target.closest?.('.er-cell');
      if (!cell) return;
      if (selectedFreeItem != null && isFreeMove(Number(cell.dataset.slot)) === false) {
        selectedFreeItem = null;
      } else if (!e.target.closest?.('.er-free-item') && selectedFreeItem != null) {
        // clic vacío del cuadro: mantener selección del item si mismo slot; si otro, limpiar item
        const slot = Number(cell.dataset.slot);
        if (selectedFreeItem.slot !== slot) {
          selectedFreeItem = null;
          renderGrid();
        }
      }
      setSelectedSlot(Number(cell.dataset.slot));
      updateFreeApplyBtn();
    });
    grid?.addEventListener('dragstart', (e) => {
      if (isBusy()) { e.preventDefault(); return; }
      if (e.target.closest?.('.er-cell-text, .er-text-handle, .er-free-item, .er-free-handle')) { e.preventDefault(); return; }
      const cell = e.target.closest?.('.er-cell');
      if (!cell) return;
      if (cell.classList.contains('is-free-move')) { e.preventDefault(); return; }
      const slot = Number(cell.dataset.slot);
      slotDrag = { from: slot };
      setSelectedSlot(slot);
      cell.classList.add('is-dragging-slot');
      try { e.dataTransfer.setData('text/plain', String(slot)); e.dataTransfer.effectAllowed = 'move'; } catch {}
    });
    grid?.addEventListener('dragend', () => {
      document.querySelectorAll('.er-cell.is-dragging-slot, .er-cell.is-drop-target').forEach((el) => {
        el.classList.remove('is-dragging-slot', 'is-drop-target');
      });
      slotDrag = null;
    });
    grid?.addEventListener('dragover', (e) => {
      if (!slotDrag) return;
      e.preventDefault();
      const cell = e.target.closest?.('.er-cell');
      document.querySelectorAll('.er-cell.is-drop-target').forEach((el) => el.classList.remove('is-drop-target'));
      if (cell) cell.classList.add('is-drop-target');
    });
    grid?.addEventListener('drop', (e) => {
      e.preventDefault();
      const cell = e.target.closest?.('.er-cell');
      document.querySelectorAll('.er-cell.is-dragging-slot, .er-cell.is-drop-target').forEach((el) => {
        el.classList.remove('is-dragging-slot', 'is-drop-target');
      });
      if (!slotDrag || !cell) { slotDrag = null; return; }
      const to = Number(cell.dataset.slot);
      const from = slotDrag.from;
      slotDrag = null;
      if (!Number.isFinite(to) || from === to) return;
      swapSlots(from, to);
      saveState(state);
      renderGrid();
      setSelectedSlot(to);
      toastMsg('Reordenado: ' + (from + 1) + ' ↔ ' + (to + 1));
    });

    grid?.addEventListener('contextmenu', (e) => {
      const textEl = e.target.closest?.('.er-cell-text');
      const freeWrap = e.target.closest?.('.er-free-item');
      const cell = e.target.closest?.('.er-cell');
      if (!cell) return;
      e.preventDefault();
      if (isBusy()) return;
      const textIdx = textEl ? Number(textEl.dataset.textIdx) : null;
      let layerKind = 'overlay';
      if (textEl) layerKind = 'text';
      else if (freeWrap?.dataset?.freeKind === 'gift') layerKind = 'gift';
      else if (freeWrap?.dataset?.freeKind === 'overlay') layerKind = 'overlay';
      else if (selectedFreeItem?.slot === Number(cell.dataset.slot)) layerKind = selectedFreeItem.kind;
      if (freeWrap && isFreeMove(Number(cell.dataset.slot))) {
        selectedFreeItem = {
          slot: Number(cell.dataset.slot),
          kind: freeWrap.dataset.freeKind === 'gift' ? 'gift' : 'overlay',
        };
        document.querySelectorAll('.er-free-item.is-item-selected').forEach((el) => el.classList.remove('is-item-selected'));
        freeWrap.classList.add('is-item-selected');
        setSelectedSlot(Number(cell.dataset.slot));
      }
      showCtxMenu(e.clientX, e.clientY, Number(cell.dataset.slot), textIdx, layerKind);
    });
    document.addEventListener('click', (e) => {
      if (e.target?.closest?.('#er-ctx-menu, #er-corner-type-menu')) return;
      hideCtxMenu();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        hideCtxMenu();
        if (isBusy()) cancelPick();
        return;
      }
      if (!erViewActive() || erTypingTarget(e.target)) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        if (e.shiftKey) redoEr(); else undoEr();
        return;
      }
      if (mod && (e.key === 'y' || e.key === 'Y')) {
        e.preventDefault();
        redoEr();
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedText) {
          e.preventDefault();
          deleteTextAt(selectedText.slot, selectedText.idx);
          return;
        }
        if (selectedSlot != null) {
          e.preventDefault();
          clearSlotContents(selectedSlot);
          return;
        }
      }
      if (!mod && /^[1-9]$/.test(e.key)) {
        const idx = Number(e.key) - 1;
        if (idx < state.count) {
          e.preventDefault();
          setSelectedSlot(idx);
          toastMsg('Cuadro ' + (idx + 1));
        }
        return;
      }
      if (!mod && (e.key === 'g' || e.key === 'G')) {
        e.preventDefault();
        document.getElementById('er-add-gift')?.click();
        return;
      }
      if (!mod && (e.key === 't' || e.key === 'T')) {
        e.preventDefault();
        startPick('text');
        return;
      }
      if (!mod && (e.key === 'd' || e.key === 'D')) {
        e.preventDefault();
        duplicateSlot(selectedSlot);
      }
    });
    document.addEventListener('click', (e) => {
      const cornerBtn = e.target.closest?.('#er-corner-type-menu [data-corner]');
      if (cornerBtn) {
        const slot = ctxSlot; // null = añadir nuevo
        const corner = cornerBtn.dataset.corner;
        if (!corner) return;
        applyCornerType(slot, corner);
        return;
      }
      const btn = e.target.closest?.('#er-ctx-menu [data-act]');
      if (!btn || btn.disabled) return;
      const act = btn.dataset.act;
      const slot = ctxSlot;
      const tIdx = ctxTextIdx;
      if (slot == null) return;
      if (act === 'change-corner') {
        const rect = btn.getBoundingClientRect();
        showCornerTypeMenu(rect.right + 4, rect.top, slot);
        return;
      }
      hideCtxMenu();
      if (act === 'copy-image') copyKind('image', slot);
      else if (act === 'paste-image') pasteKind('image', slot);
      else if (act === 'move-image') startMove('image', slot);
      else if (act === 'delete-image') deleteKind('image', slot);
      else if (act === 'copy-gift') copyKind('gift', slot);
      else if (act === 'paste-gift') pasteKind('gift', slot);
      else if (act === 'move-gift') startMove('gift', slot);
      else if (act === 'delete-gift') deleteKind('gift', slot);
      else if (act === 'edit-text') editTextAt(slot, tIdx);
      else if (act === 'text-rainbow') setTextStyle(slot, 'rainbow', tIdx);
      else if (act === 'text-aurora') setTextStyle(slot, 'aurora', tIdx);
      else if (act === 'text-color') pickTextColor(slot, tIdx);
      else if (act === 'delete-text') deleteTextAt(slot, tIdx);
      else if (act === 'dup-slot') duplicateSlot(slot);
      else if (act === 'free-move') toggleFreeMove(slot);
      else if (act === 'apply-free') applyFreeMove(slot);
      else if (act === 'clear-free') clearFreeLayout(slot);
      else if (act === 'layer-forward' || act === 'layer-back') {
        const layer = window.__erCtxLayer
          || (selectedFreeItem?.slot === slot ? { kind: selectedFreeItem.kind, textIdx: tIdx } : null)
          || { kind: 'overlay', textIdx: tIdx };
        bumpLayer(layer.kind || 'overlay', slot, layer.textIdx ?? tIdx ?? 0, act === 'layer-forward' ? 1 : -1);
      }
      else if (act === 'align-center') { selectedText = { slot, idx: tIdx ?? 0 }; alignSelectedText('center'); }
      else if (act === 'align-top') { selectedText = { slot, idx: tIdx ?? 0 }; alignSelectedText('top'); }
      else if (act === 'align-br') { selectedText = { slot, idx: tIdx ?? 0 }; alignSelectedText('br'); }
      else if (act === 'clear-slot') clearSlotContents(slot);
      else if (act === 'remove-slot') removeSlotCompletely(slot);
      else if (act === 'remove-empty-slots') removeEmptySlots();
    });
  }

  window.ensureEditorRapidoLivePublished = function ensureEditorRapidoLivePublished() {
    try { refreshOverlayUrl(); } catch {}
    publishLive(state).catch(() => {});
    startLiveHeartbeat();
  };

  window.getEditorRapidoLinkedSettingsKey = function getEditorRapidoLinkedSettingsKey() {
    if (state.gameSync?.settingsKey) return state.gameSync.settingsKey;
    try {
      const loaded = loadState();
      return loaded?.gameSync?.settingsKey || '';
    } catch {
      return '';
    }
  };

  function openEditorRapidoViewShell() {
    if (typeof window.editorRapidoUnlocked === 'function' && !window.editorRapidoUnlocked()) {
      toastMsg('Editor Pro es Solo VIP / Founder');
      return false;
    }
    document.querySelectorAll('.nav-item').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
    const view = document.getElementById('view-editor-rapido');
    if (view) view.classList.add('active');
    const navBtn = document.querySelector('.nav-item[data-view="editor-rapido"]');
    if (navBtn) {
      navBtn.classList.add('active');
      if (typeof pulseDockNav === 'function') pulseDockNav(navBtn);
    }
    return true;
  }

  function defaultQtyText(qty) {
    return {
      text: `x${Math.max(2, qty)}`,
      x: 50,
      y: 14,
      scale: 2.2,
      style: 'solid',
      color: '#ffffff',
    };
  }

  function upsertQtyTextAt(slot, qty) {
    const list = textsAt(slot).slice();
    const qtyIdx = list.findIndex((t) => /^x\d+$/i.test(String(t?.text || '').trim()));
    const n = Math.max(1, parseInt(qty, 10) || 1);
    if (n >= 2) {
      if (qtyIdx >= 0) {
        list[qtyIdx] = { ...list[qtyIdx], text: `x${n}` };
      } else {
        list.unshift(defaultQtyText(n));
      }
    } else if (qtyIdx >= 0) {
      list.splice(qtyIdx, 1);
    }
    setTextsAt(slot, list);
  }

  function upsertGiftEmojiAt(slot, emoji) {
    const kept = textsAt(slot).filter((t) => {
      const s = String(t?.text || '').trim();
      if (/^x\d+$/i.test(s)) return true;
      if (s.length <= 2 && !/\w{2,}/.test(s)) return false;
      return true;
    });
    if (emoji) {
      kept.push({
        text: String(emoji),
        x: 84,
        y: 84,
        scale: 1.15,
        style: 'solid',
        color: '#ffffff',
      });
    }
    setTextsAt(slot, kept);
  }

  function applyCornerPatchToSlot(slot, patch) {
    const i = Number(slot);
    if (!Number.isFinite(i) || i < 0 || i >= MAX_COUNT) return;
    const cur = state.gifts[i];
    if (isExternalMediaSrc(cur?.src)) {
      if (patch?.qty != null) upsertQtyTextAt(i, patch.qty);
      return;
    }
    const cornerKey = String(patch?.cornerType || '').toLowerCase();
    /* Si moviste o escalaste el regalo dentro del cuadro, esa colocación es tuya:
       re-sincronizar desde Juegos no debe devolverlo a la esquina por defecto. */
    const geom = itemGeometry(cur);
    if (CORNER_PRESETS[cornerKey]) {
      const next = cloneItem(CORNER_PRESETS[cornerKey]);
      state.gifts[i] = next ? Object.assign(next, geom) : null;
      upsertGiftEmojiAt(i, '');
    } else {
      const giftSrc = proxiedSrc(patch?.giftSrc || '');
      if (giftSrc) {
        const next = { src: giftSrc, name: String(patch?.giftName || 'Regalo'), type: 'gift' };
        if (patch?.giftId) next.giftId = String(patch.giftId);
        state.gifts[i] = Object.assign(next, geom);
        upsertGiftEmojiAt(i, '');
      } else {
        state.gifts[i] = null;
        upsertGiftEmojiAt(i, patch?.giftEmoji || '');
      }
    }
    if (patch?.qty != null) upsertQtyTextAt(i, patch.qty);
  }

  async function persistLinkedTemplateQuiet() {
    return persistActiveTemplateQuiet();
  }

  async function persistActiveTemplateQuiet() {
    const id = activeTemplateId();
    if (!id || tplAutosavePaused > 0) return false;
    try {
      await ensureTemplatesLoaded();
      const tpl = getTemplatesSync().find((t) => t.id === id);
      const nameEl = document.getElementById('er-tpl-name');
      const name = String(nameEl?.value || '').trim() || tpl?.name || 'Plantilla';
      const payload = {
        id,
        name: name.slice(0, 80),
        protected: true,
        savedAt: Date.now(),
        data: snapshotState(state),
      };
      const r = await fetch('/api/editor-rapido/templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ template: payload }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j?.ok === false) throw new Error(j?.error || `Error ${r.status}`);
      if (state.gameSync) state.gameSync.templateId = id;
      if (!activeTplId) setActiveTplId(id);
      // Actualizar caché en memoria sin re-render agresivo
      const saved = j.template || payload;
      const list = getTemplatesSync().slice();
      const idx = list.findIndex((t) => t.id === id);
      const entry = {
        id,
        name: saved.name || name,
        protected: true,
        savedAt: saved.savedAt || payload.savedAt,
        data: saved.data ? normalizeState(saved.data) : normalizeState(payload.data),
      };
      if (idx >= 0) list[idx] = entry;
      else list.push(entry);
      templatesCache = list;
      renderTplSelect();
      // Misma limpieza de media que Guardar → Live Studio ve el cambio al instante
      if (saved?.data) applyCleanedMediaFromPayload(normalizeState(saved.data));
      await publishLive(state);
      flashTplAutosaveStatus(true);
      return true;
    } catch {
      flashTplAutosaveStatus(false);
      return false;
    }
  }

  function ensureGameSyncLoaded(settingsKey) {
    const key = String(settingsKey || '').trim();
    if (!key) return false;
    if (state.gameSync && state.gameSync.settingsKey === key) {
      if (!state.filasSnap) {
        try {
          const loaded = loadState();
          if (loaded?.filasSnap && loaded?.gameSync?.settingsKey === key) {
            state.filasSnap = loaded.filasSnap;
          }
        } catch {}
      }
      return true;
    }
    const loaded = loadState();
    if (loaded?.gameSync?.settingsKey === key) {
      mergeKeptMedia(state, loaded);
      state = loaded;
      return true;
    }
    return false;
  }

  /** keepUnmanaged: conservar los cuadros que el panel no manda (huecos y adornos
      del usuario). Solo al re-sincronizar; en una importación nueva arrastraría
      restos del montaje anterior. */
  function applyImportRowsToSlots(list, n, opts) {
    const keepUnmanaged = !!opts?.keepUnmanaged;
    const overlays = emptySlots();
    const gifts = emptySlots();
    const texts = emptyTextSlots();
    const freeMove = emptyFreeMove();
    const freeLayout = emptyFreeMove();
    const uids = Array.from({ length: MAX_COUNT }, () => '');
    const prevUidsRaw = state.gameSync?.uids || [];

    /* Cuadro que el panel no gestiona (hueco o adorno del usuario): se copia tal
       cual estaba. Sin esto, reconstruir la rejilla se lleva por delante lo que
       el usuario colocó a mano entre las acciones. */
    const keepPreviousSlot = (i) => {
      if (state.overlays?.[i]) overlays[i] = cloneItem(state.overlays[i]);
      if (state.gifts?.[i]) gifts[i] = cloneItem(state.gifts[i]);
      const kept = textsAt(i).map((t) => cloneText(t)).filter(Boolean);
      if (kept.length) texts[i] = kept;
      freeMove[i] = !!(state.freeMove && state.freeMove[i]);
      freeLayout[i] = !!(state.freeLayout && state.freeLayout[i]);
    };

    const prevByUid = {};
    if (state.gameSync?.uids) {
      // Incluir slots ocultos por n° Filas (índices ≥ count) para no perder textos custom
      for (let i = 0; i < MAX_COUNT; i++) {
        const uid = state.gameSync.uids[i];
        if (!uid) continue;
        prevByUid[uid] = {
          texts: textsAt(i),
          freeMove: !!(state.freeMove && state.freeMove[i]),
          freeLayout: !!(state.freeLayout && state.freeLayout[i]),
          overlay: state.overlays[i] ? cloneItem(state.overlays[i]) : null,
          gift: state.gifts[i] ? cloneItem(state.gifts[i]) : null,
        };
      }
    }

    for (let i = 0; i < n; i++) {
      const r = list[i] || {};
      const uid = String(r.actionUid || r.uid || '').trim();
      uids[i] = uid;
      if (!uid) {
        // Hueco intencionado o adorno: solo se conserva si no era de una acción.
        if (keepUnmanaged && !String(prevUidsRaw[i] || '')) keepPreviousSlot(i);
        continue;
      }
      if (uid && prevByUid[uid]?.freeMove) freeMove[i] = true;
      if (uid && prevByUid[uid]?.freeLayout) freeLayout[i] = true;
      const actionSrc = proxiedSrc(r.actionSrc || r.overlaySrc || '');
      const prevO = uid ? prevByUid[uid]?.overlay : null;
      if (prevO?.src) {
        // Conservar arte del Editor Pro (no pisar con icono de catálogo / nube).
        overlays[i] = cloneItem(prevO);
        const nm = String(r.actionName || prevO.name || '');
        if (nm) overlays[i].name = nm;
      } else if (actionSrc) {
        overlays[i] = { src: actionSrc, name: String(r.actionName || '') };
      }

      const cornerKey = String(r.cornerType || '').toLowerCase();
      const prevG = uid ? prevByUid[uid]?.gift : null;
      if (isExternalMediaSrc(prevG?.src)) {
        gifts[i] = cloneItem(prevG);
      } else if (CORNER_PRESETS[cornerKey]) {
        gifts[i] = cloneItem(CORNER_PRESETS[cornerKey]);
      } else {
        const giftSrc = proxiedSrc(r.giftSrc || '');
        if (giftSrc) {
          gifts[i] = { src: giftSrc, name: String(r.giftName || 'Regalo'), type: 'gift' };
          if (r.giftId) gifts[i].giftId = String(r.giftId);
        }
      }
      if (gifts[i] && prevG && Number.isFinite(Number(prevG.x))) {
        gifts[i].x = clampPct(prevG.x, 82);
        gifts[i].y = clampPct(prevG.y, 82);
      }
      if (gifts[i] && prevG && Number.isFinite(Number(prevG.scale))) gifts[i].scale = clampItemScale(prevG.scale);
      if (gifts[i] && prevG && Number.isFinite(Number(prevG.z))) gifts[i].z = Math.max(1, Math.min(50, Math.round(Number(prevG.z))));

      const cellTexts = [];
      const qty = Math.max(1, parseInt(r.qty, 10) || 1);
      const prevTexts = uid ? prevByUid[uid]?.texts : null;
      if (qty >= 2) {
        const prevQty = Array.isArray(prevTexts)
          ? prevTexts.find((t) => /^x\d+$/i.test(String(t?.text || '').trim()))
          : null;
        cellTexts.push(prevQty ? { ...cloneText(prevQty), text: `x${qty}` } : defaultQtyText(qty));
      }
      // Conservar textos custom (no qty / no emoji de regalo) del montaje anterior
      if (Array.isArray(prevTexts)) {
        for (const t of prevTexts) {
          const s = String(t?.text || '').trim();
          if (!s) continue;
          if (/^x\d+$/i.test(s)) continue;
          if (!gifts[i] && r.giftEmoji && s === String(r.giftEmoji)) continue;
          cellTexts.push(cloneText(t));
        }
      }
      if (!gifts[i] && r.giftEmoji) {
        const hasEmoji = cellTexts.some((t) => String(t?.text || '') === String(r.giftEmoji));
        if (!hasEmoji) {
          cellTexts.push({
            text: String(r.giftEmoji),
            x: 84,
            y: 84,
            scale: 1.15,
            style: 'solid',
            color: '#ffffff',
          });
        }
      }
      texts[i] = cellTexts.slice(0, MAX_TEXTS_PER_CELL);
    }

    /* Lo mismo para los cuadros que quedan fuera del rango de acciones. */
    if (keepUnmanaged) {
      for (let i = n; i < MAX_COUNT; i++) {
        if (String(prevUidsRaw[i] || '')) continue;
        keepPreviousSlot(i);
      }
    }
    return { overlays, gifts, texts, uids, freeMove, freeLayout };
  }

  /**
   * Actualiza (o reconstruye) el montaje vinculado a un juego.
   * rows: [{ uid/actionUid, actionSrc?, actionName?, giftSrc?, giftName?, giftEmoji?, cornerType?, qty? }]
   * Conserva n° Filas / filasSnap / zoom / marcos al sync desde Juegos.
   */
  window.syncEditorRapidoFromGameActions = async function syncEditorRapidoFromGameActions(settingsKey, rows) {
    const key = String(settingsKey || '').trim();
    if (!key) return false;
    const list = (Array.isArray(rows) ? rows : []).filter(Boolean);
    if (!ensureGameSyncLoaded(key)) return false;

    const prevFondo = state.fondo;
    const prevCustom = state.fondoCustomSrc;
    const prevGap = state.gap;
    const prevMotion = state.motion;
    const prevTextMotion = state.textMotion;
    const prevZoom = state.zoom;
    const prevImgScale = state.imgScale;
    const prevGiftScale = state.giftScale;
    const prevGiftPos = state.giftPos;
    const prevFrameMode = state.frameMode;
    const prevFrameColor = state.frameColor;
    const prevSpreadH = state.spreadH;
    const prevFixedCellSize = state.fixedCellSize;
    const prevGridN = clampGridN(state.gridN);
    const prevCount = state.count;
    const prevFilasSnap = normalizeFilasSnap(state.filasSnap)
      || (prevGridN ? buildFilasSnap(state) : null);
    const tplId = state.gameSync.templateId || activeTplId || '';

    const rawPrevUids = state.gameSync.uids || [];
    const prevUidsCompact = rawPrevUids
      .slice(0, Math.max(prevCount, rawPrevUids.length))
      .map((u) => String(u || ''))
      .filter(Boolean);
    const nextUids = list.map((r) => String(r.actionUid || r.uid || '').trim());
    const nextUidsCompact = nextUids.filter(Boolean);
    /* Solo importa QUÉ acciones hay, no en qué orden las lista el panel: si se
       comparara el orden, reordenar cuadros en el Editor se leería como cambio de
       estructura y el siguiente guardado reempaquetaría el montaje del usuario. */
    const prevUidSet = new Set(prevUidsCompact);
    const nextUidSet = new Set(nextUidsCompact);
    const structureChanged = prevUidSet.size !== nextUidSet.size
      || nextUidsCompact.some((u) => !prevUidSet.has(u))
      || prevUidsCompact.some((u) => !nextUidSet.has(u));

    if (structureChanged) {
      /* Cada acción se queda en el cuadro donde ya estaba; solo las nuevas buscan
         hueco. La disposición de la rejilla es del usuario, no del panel. */
      const slotByUid = new Map();
      for (let i = 0; i < MAX_COUNT; i++) {
        const u = String(rawPrevUids[i] || '');
        if (u && !slotByUid.has(u)) slotByUid.set(u, i);
      }
      const placedRows = new Array(MAX_COUNT).fill(null);
      const freshRows = [];
      for (const r of list) {
        const uid = String(r.actionUid || r.uid || '').trim();
        const slot = uid ? slotByUid.get(uid) : undefined;
        if (slot != null && slot < MAX_COUNT && placedRows[slot] == null) placedRows[slot] = r;
        else freshRows.push(r);
      }
      // Acción nueva: primer cuadro libre, sin pisar adornos que puso el usuario.
      let cursor = 0;
      for (const r of freshRows) {
        while (cursor < MAX_COUNT
          && (placedRows[cursor] != null
            || (!String(rawPrevUids[cursor] || '') && slotHasContent(cursor)))) cursor += 1;
        if (cursor >= MAX_COUNT) break;
        placedRows[cursor] = r;
        cursor += 1;
      }
      let lastUsed = -1;
      for (let i = 0; i < MAX_COUNT; i++) {
        const keeps = !String(rawPrevUids[i] || '') && slotHasContent(i);
        if (placedRows[i] != null || keeps) lastUsed = i;
      }
      const needed = Math.max(1, lastUsed + 1);

      const built = list.length
        ? applyImportRowsToSlots(placedRows, Math.min(MAX_COUNT, Math.max(needed, prevCount)), { keepUnmanaged: true })
        : { overlays: emptySlots(), gifts: emptySlots(), texts: emptyTextSlots(), uids: Array.from({ length: MAX_COUNT }, () => ''), freeMove: emptyFreeMove(), freeLayout: emptyFreeMove() };
      // Conservar el tamaño de la vista; solo crecer si las nuevas no cabían.
      let count = clampCount(Math.max(prevCount, needed));
      let gridN = prevGridN;
      if (gridN) {
        const full = gridN * gridN;
        if (prevCount >= full) count = clampCount(Math.max(full, needed));
      }

      let filasSnap = prevFilasSnap;
      if (filasSnap?.gridN) {
        const fg = clampGridN(filasSnap.gridN);
        const fFull = fg * fg;
        const snapCount = (filasSnap.count >= fFull)
          ? clampCount(Math.max(fFull, needed))
          : clampCount(Math.max(filasSnap.count || 1, needed));
        filasSnap = {
          gridN: fg,
          count: snapCount,
          overlays: built.overlays.map(cloneItem),
          gifts: built.gifts.map(cloneItem),
          texts: built.texts.map((cell) => normalizeTextList(cell)),
          freeMove: (built.freeMove || emptyFreeMove()).map(Boolean),
          freeLayout: (built.freeLayout || emptyFreeMove()).map(Boolean),
          uids: built.uids.slice(),
        };
      }

      state = normalizeState({
        count,
        gridN,
        gap: prevGap !== false,
        spreadH: !!prevSpreadH,
        fixedCellSize: !!prevFixedCellSize,
        zoom: prevZoom,
        imgScale: prevImgScale,
        giftScale: prevGiftScale,
        giftPos: prevGiftPos,
        frameMode: prevFrameMode,
        frameColor: prevFrameColor,
        fondo: prevFondo || 'transparent',
        fondoCustomSrc: prevCustom || '',
        motion: prevMotion || 'off',
        textMotion: !!prevTextMotion,
        overlays: built.overlays,
        gifts: built.gifts,
        texts: built.texts,
        freeMove: built.freeMove || emptyFreeMove(),
        freeLayout: built.freeLayout || emptyFreeMove(),
        gameSync: { settingsKey: key, uids: built.uids, templateId: tplId },
        filasSnap,
      });
    } else {
      const byUid = new Map();
      for (const p of list) {
        const uid = String(p?.actionUid || p?.uid || '').trim();
        if (uid) byUid.set(uid, p);
      }
      let changed = false;
      const patchSlot = (i, uidArr) => {
        const uid = uidArr?.[i];
        if (!uid || !byUid.has(uid)) return;
        const row = byUid.get(uid);
        // Solo actualizar regalos/esquinas/qty — no reemplazar el icono/arte del cuadro.
        // (Encender/apagar o sync de catálogo no debe destruir el montaje del Editor Pro.)
        const beforeGift = state.gifts[i] ? JSON.stringify(state.gifts[i]) : '';
        const beforeTexts = JSON.stringify(textsAt(i));
        applyCornerPatchToSlot(i, row);
        const afterGift = state.gifts[i] ? JSON.stringify(state.gifts[i]) : '';
        const afterTexts = JSON.stringify(textsAt(i));
        if (beforeGift !== afterGift || beforeTexts !== afterTexts) changed = true;
      };
      for (let i = 0; i < state.count; i++) {
        patchSlot(i, state.gameSync.uids);
      }
      // Mantener snapshot de n° Filas al día si estás en Automática
      if (state.filasSnap?.uids && !clampGridN(state.gridN)) {
        const snap = state.filasSnap;
        for (let i = 0; i < MAX_COUNT; i++) {
          const uid = snap.uids[i];
          if (!uid || !byUid.has(uid)) continue;
          const row = byUid.get(uid);
          // Nunca pisar arte custom del snap con el icono de catálogo.
          const prevSrc = String(snap.overlays[i]?.src || '');
          if (!prevSrc) {
            const actionSrc = proxiedSrc(row.actionSrc || row.overlaySrc || '');
            if (actionSrc) {
              snap.overlays[i] = { src: actionSrc, name: String(row.actionName || '') };
            }
          } else {
            const nm = String(row.actionName || snap.overlays[i]?.name || '');
            if (nm && snap.overlays[i]) snap.overlays[i].name = nm;
          }
        }
        state.filasSnap = normalizeFilasSnap(snap);
      }
      if (!changed) return false;
    }

    saveState(state);
    const view = document.getElementById('view-editor-rapido');
    if (view?.classList.contains('active')) {
      renderLibrary();
      renderCountControls();
      renderGapToggle();
      renderSpreadToggle();
      renderCellSizeToggle();
      renderMotionControl();
      renderFrameControls();
      renderPickBar();
      renderGrid();
    }
    await persistActiveTemplateQuiet();
    return true;
  };

  /**
   * Importa acciones de un juego: 1 cuadro por acción (icono centro + regalo/esq. + xN).
   * rows: [{ actionSrc, actionName, actionUid?, giftSrc?, giftName?, giftEmoji?, cornerType?, qty? }]
   */
  window.importGameActionsToEditorRapido = async function importGameActionsToEditorRapido(rows, opts = {}) {
    const list = (Array.isArray(rows) ? rows : []).filter(Boolean);
    if (!list.length) {
      toastMsg('No hay acciones para importar.');
      return false;
    }
    const n = Math.min(MAX_COUNT, list.length);
    const built = applyImportRowsToSlots(list, n);
    const settingsKey = String(opts.settingsKey || '').trim();
    const gameSync = settingsKey
      ? { settingsKey, uids: built.uids, templateId: '' }
      : null;

    state = normalizeState({
      count: n,
      gap: opts.gap !== false,
      fondo: opts.fondo || 'transparent',
      fondoCustomSrc: '',
      motion: 'off',
      textMotion: false,
      overlays: built.overlays,
      gifts: built.gifts,
      texts: built.texts,
      gameSync,
    });
    saveState(state);
    setActiveTplId('');
    if (!openEditorRapidoViewShell()) return false;
    window.initEditorRapidoView();

    const tplName = templateNameFromImport(opts, n);
    const nameEl = document.getElementById('er-tpl-name');
    if (nameEl) nameEl.value = tplName;

    const saved = await createNewTemplateFromState(tplName);
    if (saved) {
      if (!state.gameSync && gameSync) state.gameSync = normalizeGameSync(gameSync);
      if (state.gameSync) {
        state.gameSync.templateId = saved.id || '';
        saveState(state);
        await persistActiveTemplateQuiet();
      }
      const extra = list.length > MAX_COUNT ? ` (${MAX_COUNT} de ${list.length})` : '';
      toastMsg(`Plantilla nueva «${saved.name || tplName}»${extra}. Ya puedes editarla y Guardar.`);
    } else if (list.length > MAX_COUNT) {
      toastMsg(`Editor Pro: ${MAX_COUNT} de ${list.length} acciones (máximo ${MAX_COUNT}).`);
    } else {
      toastMsg(`Editor Pro: ${n} cuadro${n === 1 ? '' : 's'} listos.`);
    }
    return true;
  };

  window.initEditorRapidoView = function initEditorRapidoView() {
    if (typeof window.editorRapidoUnlocked === 'function' && !window.editorRapidoUnlocked()) {
      toastMsg('Editor Pro es Solo VIP / Founder');
      return;
    }
    wire();
    renderLibrary();
    renderCountControls();
    renderGapToggle();
    renderSpreadToggle();
    renderCellSizeToggle();
    renderMotionControl();
    renderFrameControls();
    renderPickBar();
    renderGrid();
    renderTplSelect();
    refreshOverlayUrl();
    seedHistoryIfNeeded();
    updateTplActiveLine();
    applyCanvasZoom();
    updateUndoRedoBtns();
    publishLive(state).catch(() => {});
    startLiveHeartbeat();
    ensureTemplatesLoaded().then(() => {
      renderTplSelect();
      updateTplActiveLine();
      restoreKeptMediaFromDisk().catch(() => {});
    }).catch(() => {});
    clearInterval(updateTplActiveLine._t);
    updateTplActiveLine._t = setInterval(updateTplActiveLine, 5000);
  };
})();
