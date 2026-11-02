/**
 * Idle compartido para todos los Browser Source.
 * - Si OBS oculta la fuente: pausa animaciones CSS (el live no las está mostrando).
 * - Nunca hace pause() de video/audio ni corta el WebSocket.
 * - Marca ocupado si hay medio sonando, para que keepalive no recargue a mitad de un regalo.
 */
(function () {
  try {
    var q = new URLSearchParams(location.search);
    if (q.get('embed') === '1' || q.get('osparent') === '1') return;
  } catch {}
  if (window.__lcOverlayIdle) return;
  window.__lcOverlayIdle = true;

  var css = document.createElement('style');
  css.setAttribute('data-lc-overlay-idle', '1');
  css.textContent = 'html.ov-src-hidden body *:not(video):not(audio){animation-play-state:paused!important}';
  (document.head || document.documentElement).appendChild(css);

  function mediaBusy() {
    try {
      var list = document.querySelectorAll('video, audio');
      for (var i = 0; i < list.length; i++) {
        var v = list[i];
        if (v && !v.paused && !v.ended && v.dataset.stopped !== '1') return true;
      }
    } catch {}
    return false;
  }

  var prevBusy = window.__lcOverlayBusy;
  window.__lcOverlayBusy = function () {
    try { if (typeof prevBusy === 'function' && prevBusy()) return true; } catch {}
    return mediaBusy();
  };

  function syncHidden() {
    document.documentElement.classList.toggle('ov-src-hidden', !!document.hidden);
  }
  document.addEventListener('visibilitychange', syncHidden);
  syncHidden();
})();
