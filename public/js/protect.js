/*
 * protect.js — Disuasión básica contra copia casual (clic derecho, F12, etc.).
 *
 * IMPORTANTE: esto NO es seguridad real. Todo lo que el navegador descarga
 * (HTML, CSS, JS, imágenes) siempre puede recuperarse por alguien con
 * conocimientos. Esto solo sube la barrera para el usuario casual.
 */
(function () {
  'use strict';

  // 1) Menú contextual (clic derecho) — bloquea "Guardar imagen", "Ver código", etc.
  document.addEventListener('contextmenu', function (e) {
    e.preventDefault();
    return false;
  }, { capture: true });

  // 2) Arrastrar imágenes/elementos fuera de la página.
  document.addEventListener('dragstart', function (e) {
    const t = e.target;
    if (t && (t.tagName === 'IMG' || t.tagName === 'A' || t.tagName === 'VIDEO')) {
      e.preventDefault();
      return false;
    }
  }, { capture: true });

  // 3) Atajos de teclado típicos para inspeccionar / guardar / ver fuente.
  document.addEventListener('keydown', function (e) {
    const key = (e.key || '').toLowerCase();
    const ctrl = e.ctrlKey || e.metaKey;

    // F12 — abrir herramientas de desarrollo.
    if (key === 'f12') { e.preventDefault(); return false; }

    // Ctrl/Cmd + Shift + I / J / C — inspector, consola, selector.
    if (ctrl && e.shiftKey && (key === 'i' || key === 'j' || key === 'c')) {
      e.preventDefault(); return false;
    }

    // Ctrl/Cmd + U — ver código fuente.
    if (ctrl && key === 'u') { e.preventDefault(); return false; }

    // Ctrl/Cmd + S — guardar la página.
    if (ctrl && key === 's') { e.preventDefault(); return false; }

    // Ctrl/Cmd + P — imprimir (suele usarse para extraer contenido).
    if (ctrl && key === 'p') { e.preventDefault(); return false; }
  }, { capture: true });

  // 4) Evita selección/arrastre de imágenes vía CSS (refuerzo visual).
  try {
    var style = document.createElement('style');
    style.textContent =
      'img,video{-webkit-user-drag:none;user-select:none;-webkit-user-select:none;}';
    (document.head || document.documentElement).appendChild(style);
  } catch (_) {}
})();
