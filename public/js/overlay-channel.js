/**
 * Declara el canal WS de este overlay ANTES de new WebSocket.
 * El panel (index.html) no carga este archivo → sigue recibiendo todo.
 */
(function () {
  if (window.__lcOvCh) return;
  window.__lcOvCh = true;
  try {
    var path = String(location.pathname || '').split('/').pop() || '';
    if (!/\.html$/i.test(path)) return;
    if (/^(index|login|admin)\.html$/i.test(path)) return;
    var ch = path.replace(/\.html$/i, '').toLowerCase();
    var Orig = window.WebSocket;
    if (!Orig) return;
    function LCWebSocket(url, protocols) {
      var isLcWs = false;
      try {
        var u = new URL(url, location.href);
        var p = u.pathname || '';
        isLcWs = (p === '/ws' || /\/ws$/i.test(p));
        if (isLcWs && !u.searchParams.get('ov')) {
          u.searchParams.set('ov', ch);
          url = u.toString();
        }
      } catch (e) {}
      var ws = protocols !== undefined ? new Orig(url, protocols) : new Orig(url);
      if (isLcWs) {
        ws.addEventListener('open', function () {
          try {
            if (ws.readyState === Orig.OPEN) {
              ws.send(JSON.stringify({ action: 'hello', role: 'overlay', ov: ch, path: path }));
            }
          } catch (e2) {}
        });
      }
      return ws;
    }
    LCWebSocket.prototype = Orig.prototype;
    try { Object.setPrototypeOf(LCWebSocket, Orig); } catch (e3) {}
    LCWebSocket.CONNECTING = Orig.CONNECTING;
    LCWebSocket.OPEN = Orig.OPEN;
    LCWebSocket.CLOSING = Orig.CLOSING;
    LCWebSocket.CLOSED = Orig.CLOSED;
    window.WebSocket = LCWebSocket;
  } catch (err) {}
})();
