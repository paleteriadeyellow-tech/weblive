/* Reporte de errores automático del panel: junta los errores de JavaScript y los manda al servidor
   (la app de PC los reenvía a Render). El admin los ve en Admin › Errores. No guarda datos del live. */
(function () {
  'use strict';
  var MAX_PER_PAGE = 25;
  var sentCount = 0;
  var seen = {};
  var queue = [];
  var timer = null;
  // Ruido que no es de Livecoins (extensiones, avisos del navegador, scripts de otros dominios sin datos).
  var IGNORE = /ResizeObserver loop|^Script error\.?$|chrome-extension:|moz-extension:|Non-Error promise rejection captured|AbortError|The play\(\) request was interrupted|NotAllowedError: play\(\)/i;

  function activeView() {
    try {
      var v = document.querySelector('.view.active');
      return v ? v.id.replace(/^view-/, '') : '';
    } catch (e) { return ''; }
  }
  function flush() {
    timer = null;
    if (!queue.length) return;
    var errors = queue.splice(0, 10);
    try {
      fetch('/api/client-errors', {
        method: 'POST',
        credentials: 'same-origin',
        keepalive: true,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app: window.desktopAPI ? 'pc' : 'web', errors: errors }),
      }).catch(function () {});
    } catch (e) {}
  }
  function report(message, source, line, stack) {
    message = String(message || '').slice(0, 400);
    if (!message || IGNORE.test(message) || IGNORE.test(String(source || ''))) return;
    if (sentCount >= MAX_PER_PAGE) return;
    var key = message + '|' + source + '|' + line;
    if (seen[key]) return;
    seen[key] = 1;
    sentCount++;
    queue.push({ kind: 'panel', message: message, source: String(source || '').slice(0, 200), line: Number(line) || 0, stack: String(stack || '').slice(0, 2000), view: activeView() });
    if (!timer) timer = setTimeout(flush, 2000);
  }

  window.addEventListener('error', function (e) {
    // Errores de carga de imágenes/recursos no son fallas de código.
    if (!e || !e.message) return;
    report(e.message, e.filename, e.lineno, e.error && e.error.stack);
  });
  window.addEventListener('unhandledrejection', function (e) {
    var r = e && e.reason;
    if (!r) return;
    var msg = (r && r.message) || (typeof r === 'string' ? r : '');
    if (!msg) return;
    var top = String((r && r.stack) || '').split('\n')[1] || '';
    var m = top.match(/\(?((?:https?:\/\/[^)\s]+?|\/[^)\s]+?)):(\d+):\d+\)?$/);
    report('Promesa: ' + msg, m ? m[1] : '', m ? m[2] : 0, r && r.stack);
  });
  window.addEventListener('pagehide', flush);
  window.lcReportError = function (msg, extra) { report(msg, extra && extra.source, extra && extra.line, extra && extra.stack); };
})();
