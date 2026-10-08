// Ajusta el contorno brillante (.fl-shine) al tamaño real de la pastilla en píxeles.
// Con width/rx en % el navegador de OBS no lo recalcula al cambiar el nombre y el
// brillo se queda con el ancho del anterior (corto o salido).
(function () {
  const px = (n) => `${Math.max(0, Math.round(n * 100) / 100)}px`;

  function fit(wrap) {
    const host = wrap.parentElement;
    const svg = wrap.querySelector('svg.fl-shine');
    if (!host || !svg) return;
    const w = host.offsetWidth;
    const h = host.offsetHeight;
    if (!w || !h) return;
    const r = h / 2;
    svg.setAttribute('width', String(w + 2));
    svg.setAttribute('height', String(h + 2));
    for (const rect of svg.querySelectorAll('rect')) {
      const geo = { x: 1, y: 1, width: w, height: h, rx: r, ry: r };
      for (const [k, v] of Object.entries(geo)) {
        rect.setAttribute(k, String(v));
        rect.style.setProperty(k, px(v));
      }
    }
  }

  /* Con la pastilla oculta el brillo no se ve: se congela para no repintar cada cuadro. */
  let pauseCss = null;
  function syncPlay(wrap) {
    const host = wrap.parentElement;
    const svg = wrap.querySelector('svg.fl-shine');
    if (!host || !svg) return;
    const on = host.classList.contains('show') && !host.classList.contains('empty');
    if (wrap._flOn === on) return;
    wrap._flOn = on;
    wrap.classList.toggle('fl-paused', !on);
    try { if (on) svg.unpauseAnimations(); else svg.pauseAnimations(); } catch (_) {}
  }

  function init() {
    const wraps = Array.from(document.querySelectorAll('.fl-shine-wrap'));
    if (!wraps.length) return;
    if (!pauseCss) {
      pauseCss = document.createElement('style');
      pauseCss.textContent = '.fl-shine-wrap.fl-paused rect{animation-play-state:paused!important}';
      document.head.appendChild(pauseCss);
    }
    const fitAll = () => wraps.forEach((w) => { fit(w); syncPlay(w); });
    if (typeof ResizeObserver === 'function') {
      const ro = new ResizeObserver(fitAll);
      wraps.forEach((w) => { if (w.parentElement) ro.observe(w.parentElement); });
    }
    const mo = new MutationObserver(() => requestAnimationFrame(fitAll));
    wraps.forEach((w) => {
      if (w.parentElement) mo.observe(w.parentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class', 'data-kind', 'src'] });
    });
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitAll).catch(() => {});
    window.addEventListener('resize', fitAll);
    fitAll();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
