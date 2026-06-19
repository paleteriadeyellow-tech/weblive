/* Catálogo de regalos TikTok — pestaña dedicada, carga diferida y paginada. */
(function () {
  'use strict';

  const PAGE_SIZE = 56;
  const DIA_ICON = '💎';
  const REGIONS = [
    { code: 'auto', label: 'Auto (servidor)' },
    { code: 'MX', label: 'MX · México' },
    { code: 'US', label: 'US · Estados Unidos' },
    { code: 'ES', label: 'ES · España' },
    { code: 'AR', label: 'AR · Argentina' },
    { code: 'CO', label: 'CO · Colombia' },
  ];

  const CATEGORIES = [
    { id: 'all', label: 'Todos', icon: '📦', test: () => true },
    { id: 'popular', label: 'Populares', icon: '🔥', test: (g) => g.diamonds <= 10 },
    { id: 'basic', label: 'Básicos', icon: '🌱', test: (g) => g.diamonds >= 1 && g.diamonds <= 5 },
    { id: 'animated', label: 'Animados', icon: '✨', test: (g) => g.diamonds >= 11 && g.diamonds <= 99 },
    { id: 'featured', label: 'Destacados', icon: '⭐', test: (g) => g.diamonds >= 100 && g.diamonds <= 499 },
    { id: 'premium', label: 'Premium', icon: '💎', test: (g) => g.diamonds >= 500 },
  ];

  const DIAMOND_RANGES = [
    { id: 'all', label: 'Todos' },
    { id: '1-10', min: 1, max: 10 },
    { id: '11-99', min: 11, max: 99 },
    { id: '100-499', min: 100, max: 499 },
    { id: '500-999', min: 500, max: 999 },
    { id: '1000+', min: 1000, max: Infinity },
  ];

  let inited = false;
  let loading = false;
  let allGifts = [];
  let filtered = [];
  let catCounts = {};
  let state = {
    category: 'all',
    diamonds: 'all',
    query: '',
    page: 1,
    region: localStorage.getItem('gc-region') || 'auto',
    selectedId: null,
  };

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

  function normGift(g) {
    return {
      id: g.id,
      name: g.name,
      diamonds: Number(g.diamonds) || 0,
      image: g.image || '',
    };
  }

  function diamondRangeLabel(r) {
    if (r.id === 'all') return 'Todos';
    if (r.id === '1000+') return `1000+ ${DIA_ICON}`;
    return `${r.min} ${DIA_ICON} – ${r.max}`;
  }

  function sameOrigin(u) {
    try { return new URL(u, location.href).origin === location.origin; } catch { return false; }
  }
  function proxied(u) {
    if (!u) return '';
    return sameOrigin(u) ? u : ('/api/img-proxy?url=' + encodeURIComponent(u));
  }

  function giftCategory(g) {
    for (let i = CATEGORIES.length - 1; i >= 1; i--) {
      if (CATEGORIES[i].test(g)) return CATEGORIES[i];
    }
    return CATEGORIES[0];
  }

  function inDiamondRange(g, rangeId) {
    const r = DIAMOND_RANGES.find((x) => x.id === rangeId);
    if (!r || r.id === 'all') return true;
    const d = Number(g.diamonds) || 0;
    return d >= r.min && d <= r.max;
  }

  function computeCounts(list) {
    const counts = { all: list.length };
    for (const c of CATEGORIES) {
      if (c.id === 'all') continue;
      counts[c.id] = list.filter((g) => c.test(g)).length;
    }
    return counts;
  }

  function applyFilters() {
    const cat = CATEGORIES.find((c) => c.id === state.category) || CATEGORIES[0];
    const q = state.query.trim().toLowerCase();
    const diamondActive = state.diamonds !== 'all';
    const categoryActive = !diamondActive && state.category !== 'all';

    filtered = allGifts.filter((g) => {
      if (diamondActive) {
        if (!inDiamondRange(g, state.diamonds)) return false;
      } else if (categoryActive && !cat.test(g)) {
        return false;
      }
      if (!q) return true;
      return g.name.toLowerCase().includes(q)
        || String(g.id).includes(q)
        || String(g.diamonds).includes(q);
    });

    const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    if (state.page > pages) state.page = pages;
    if (state.page < 1) state.page = 1;
  }

  function selectedGift() {
    if (!state.selectedId) return filtered[0] || allGifts[0] || null;
    return filtered.find((g) => String(g.id) === String(state.selectedId))
      || allGifts.find((g) => String(g.id) === String(state.selectedId))
      || null;
  }

  function renderFilters() {
    const catBox = $('gc-cats');
    if (!catBox) return;
    catBox.innerHTML = CATEGORIES.map((c) => `
      <button type="button" class="gc-filter ${state.category === c.id && state.diamonds === 'all' ? 'active' : ''}" data-cat="${c.id}">
        <span class="gc-filter-ico">${c.icon}</span>
        <span class="gc-filter-label">${esc(c.label)}</span>
        <span class="gc-filter-count">${catCounts[c.id] ?? 0}</span>
      </button>`).join('');
    catBox.querySelectorAll('[data-cat]').forEach((btn) => {
      btn.onclick = () => {
        state.category = btn.dataset.cat;
        state.diamonds = 'all';
        state.page = 1;
        renderAll();
      };
    });

    const diaBox = $('gc-diamonds');
    if (!diaBox) return;
    diaBox.innerHTML = DIAMOND_RANGES.map((r) => `
      <button type="button" class="gc-filter gc-filter-sm ${state.diamonds === r.id ? 'active' : ''}" data-dia="${r.id}">
        ${esc(diamondRangeLabel(r))}
      </button>`).join('');
    diaBox.querySelectorAll('[data-dia]').forEach((btn) => {
      btn.onclick = () => {
        state.diamonds = btn.dataset.dia;
        if (state.diamonds !== 'all') state.category = 'all';
        state.page = 1;
        renderAll();
      };
    });
  }

  function renderGrid() {
    const grid = $('gc-grid');
    const countEl = $('gc-count');
    const pageInfo = $('gc-page-info');
    if (!grid) return;

    applyFilters();
    const total = filtered.length;
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const start = (state.page - 1) * PAGE_SIZE;
    const pageItems = filtered.slice(start, start + PAGE_SIZE);

    if (countEl) countEl.textContent = `${total} / ${allGifts.length}`;
    if (pageInfo) pageInfo.textContent = `Página ${state.page} de ${pages}`;

    const prev = $('gc-prev');
    const next = $('gc-next');
    if (prev) prev.disabled = state.page <= 1;
    if (next) next.disabled = state.page >= pages;

    if (!total) {
      grid.innerHTML = '<div class="gc-empty">Sin resultados para estos filtros</div>';
      renderPreview(null);
      return;
    }

    if (!state.selectedId || !pageItems.some((g) => String(g.id) === String(state.selectedId))) {
      state.selectedId = pageItems[0].id;
    }

    grid.innerHTML = pageItems.map((g) => `
      <button type="button" class="gc-cell ${String(g.id) === String(state.selectedId) ? 'sel' : ''}"
        data-id="${g.id}" title="${esc(g.name)} · #${g.id}">
        <img src="${esc(g.image)}" alt="" loading="lazy" decoding="async" onerror="this.style.visibility='hidden'">
        <div class="gc-cell-name">${esc(g.name)}</div>
        <div class="gc-cell-coin">${DIA_ICON} ${g.diamonds}</div>
      </button>`).join('');

    grid.querySelectorAll('.gc-cell').forEach((cell) => {
      cell.onclick = () => {
        state.selectedId = cell.dataset.id;
        grid.querySelectorAll('.gc-cell').forEach((c) => c.classList.toggle('sel', c === cell));
        renderPreview(selectedGift());
      };
    });

    renderPreview(selectedGift());
  }

  function renderPreview(g) {
    const box = $('gc-preview');
    if (!box) return;
    if (!g) {
      box.innerHTML = '<div class="gc-preview-empty">Selecciona un regalo</div>';
      return;
    }
    const cat = giftCategory(g);
    const regionLabel = REGIONS.find((r) => r.code === state.region)?.label || 'Auto';
    box.innerHTML = `
      <div class="gc-preview-img">
        <div class="gc-preview-float">
          <img id="gc-preview-img" src="${esc(g.image)}" alt="${esc(g.name)}" loading="eager" decoding="async">
        </div>
      </div>
      <div class="gc-preview-name">${esc(g.name)}</div>
      <dl class="gc-preview-meta">
        <div><dt>ID</dt><dd>${g.id}</dd></div>
        <div><dt>Diamantes</dt><dd>${DIA_ICON} ${g.diamonds}</dd></div>
        <div><dt>Categoría</dt><dd><span class="gc-badge">${esc(cat.label)}</span></dd></div>
        <div><dt>Región</dt><dd>${esc(regionLabel)}</dd></div>
      </dl>
      <button type="button" class="btn primary gc-dl" id="gc-dl-btn">⬇ Descargar PNG</button>`;
    $('gc-dl-btn').onclick = () => downloadGiftPng(g);
  }

  async function downloadGiftPng(g) {
    if (!g?.image) {
      (window.toast && toast('Este regalo no tiene imagen.', 'warn'));
      return;
    }
    const btn = $('gc-dl-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Descargando…'; }
    const safeName = (g.name || 'regalo').replace(/[^\w.\- ]+/g, '_').trim() || 'regalo';
    const fileName = `${safeName}_${g.id}.png`;
    try {
      const r = await fetch(proxied(g.image));
      if (!r.ok) throw new Error('fetch');
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      window.toast && toast('PNG descargado.', 'ok');
    } catch {
      try {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = proxied(g.image); });
        const cv = document.createElement('canvas');
        cv.width = img.naturalWidth || 256;
        cv.height = img.naturalHeight || 256;
        cv.getContext('2d').drawImage(img, 0, 0);
        const a = document.createElement('a');
        a.href = cv.toDataURL('image/png');
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.toast && toast('PNG descargado.', 'ok');
      } catch {
        window.toast && toast('No se pudo descargar. ¿Hay internet?', 'error');
      }
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '⬇ Descargar PNG'; }
    }
  }

  function renderAll() {
    renderFilters();
    renderGrid();
  }

  function bindStaticUI() {
    const search = $('gc-search');
    if (search && !search.dataset.bound) {
      search.dataset.bound = '1';
      let t = null;
      search.addEventListener('input', () => {
        clearTimeout(t);
        t = setTimeout(() => {
          state.query = search.value;
          state.page = 1;
          renderGrid();
        }, 180);
      });
    }

    const prev = $('gc-prev');
    const next = $('gc-next');
    if (prev && !prev.dataset.bound) {
      prev.dataset.bound = '1';
      prev.onclick = () => { if (state.page > 1) { state.page--; renderGrid(); } };
    }
    if (next && !next.dataset.bound) {
      next.dataset.bound = '1';
      next.onclick = () => {
        applyFilters();
        const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
        if (state.page < pages) { state.page++; renderGrid(); }
      };
    }

    const region = $('gc-region');
    if (region && !region.dataset.bound) {
      region.dataset.bound = '1';
      region.innerHTML = REGIONS.map((r) =>
        `<option value="${r.code}" ${state.region === r.code ? 'selected' : ''}>${esc(r.label)}</option>`).join('');
      region.onchange = () => {
        state.region = region.value;
        localStorage.setItem('gc-region', state.region);
        state.page = 1;
        state.selectedId = null;
        loadCatalog(false);
      };
    }

    const refresh = $('gc-refresh');
    if (refresh && !refresh.dataset.bound) {
      refresh.dataset.bound = '1';
      refresh.onclick = () => loadCatalog(true);
    }
  }

  function giftsApiUrl(force) {
    const q = new URLSearchParams({ region: state.region || 'auto' });
    if (force) q.set('force', '1');
    return `/api/gifts?${q.toString()}`;
  }

  async function loadCatalog(force = false) {
    if (loading) return;
    loading = true;
    const status = $('gc-status');
    const regionLabel = REGIONS.find((r) => r.code === state.region)?.label || 'Auto';
    if (status) status.textContent = force ? `Actualizando (${regionLabel})…` : `Cargando (${regionLabel})…`;
    try {
      let list = [];
      if (!force && state.region === 'auto' && typeof giftCatalog !== 'undefined' && giftCatalog.length) {
        list = giftCatalog.slice();
      } else {
        const res = await fetch(giftsApiUrl(force));
        const data = await res.json();
        list = data.results || [];
        if (state.region === 'auto' && typeof giftCatalog !== 'undefined' && list.length) {
          giftCatalog.length = 0;
          giftCatalog.push(...list);
          if (typeof indexGiftCatalog === 'function') indexGiftCatalog();
        }
      }
      const map = new Map();
      for (const g of list) {
        if (g && g.name) map.set(String(g.id), normGift(g));
      }
      allGifts = [...map.values()].sort((a, b) => a.diamonds - b.diamonds || a.name.localeCompare(b.name));
      catCounts = computeCounts(allGifts);
      if (status) status.textContent = `${allGifts.length} regalos · ${regionLabel}`;
      state.page = 1;
      renderAll();
    } catch {
      if (status) status.textContent = 'Error al cargar';
      const grid = $('gc-grid');
      if (grid) grid.innerHTML = '<div class="gc-empty">No se pudo cargar el catálogo (¿hay internet?)</div>';
    } finally {
      loading = false;
    }
  }

  window.initGiftCatalogView = function initGiftCatalogView() {
    bindStaticUI();
    if (allGifts.length) { renderAll(); return; }
    if (!inited) {
      inited = true;
      loadCatalog(false);
    }
  };
})();
