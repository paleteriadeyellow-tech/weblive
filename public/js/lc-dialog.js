/**
 * Diálogos con el diseño de la app en vez de las ventanas de Windows (confirm / alert / prompt).
 *   await lcConfirm('¿Seguro?', { title, okText, cancelText, icon, danger })  → true / false
 *   await lcAlert('Texto', { title, icon })                                  → undefined
 *   await lcPrompt('Texto', valor, { title, okText, icon })                  → texto o null
 * Dentro del panel (iframe del mismo origen) usa los diálogos del panel (askConfirm / askText),
 * así se ven sobre toda la app con sus colores. Fuera del panel dibuja uno propio con las
 * variables de color de la página (--panel/--card, --line, --tx, --mut, --acc).
 */
(function () {
  if (window.lcConfirm) return;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const html = (s) => esc(s).replace(/\n/g, '<br>');

  function panel() {
    try {
      const p = window.parent;
      if (p && p !== window && typeof p.askConfirm === 'function') return p;
    } catch { /* otro origen */ }
    return null;
  }

  function injectCss() {
    if (document.getElementById('lc-dialog-css')) return;
    const st = document.createElement('style');
    st.id = 'lc-dialog-css';
    st.textContent = `
.lcd-back { position:fixed; inset:0; z-index:100000; display:flex; align-items:center; justify-content:center; padding:20px;
  background:rgba(0,0,0,.62); animation:lcdFade .14s ease; }
.lcd-box { position:relative; width:380px; max-width:92vw; overflow:hidden; text-align:center; padding:26px 22px 18px;
  border-radius:16px; border:1px solid var(--line, #2c3150); background:var(--panel, var(--card, #181c2e)); color:var(--tx, #eef);
  box-shadow:0 24px 60px rgba(0,0,0,.6); font:14px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
.lcd-box::before { content:''; position:absolute; top:0; left:0; right:0; height:4px; background:var(--accg, var(--acc, #8977d5)); }
.lcd-ico { font-size:36px; margin-bottom:6px; }
.lcd-box h3 { margin:0 0 6px; font-size:17px; }
.lcd-box p { margin:0 0 16px; color:var(--mut, #9aa); font-size:13.5px; word-break:break-word; }
.lcd-box input { width:100%; margin:0 0 16px; padding:9px 11px; border-radius:9px; border:1px solid var(--line, #2c3150);
  background:var(--bg, #0f1326); color:var(--tx, #eef); font:inherit; }
.lcd-btns { display:flex; gap:10px; justify-content:center; }
.lcd-btns button { min-width:118px; padding:9px 14px; border-radius:10px; font:inherit; font-weight:700; cursor:pointer; border:1px solid var(--line, #2c3150); }
.lcd-cancel { background:transparent; color:var(--tx, #eef); }
.lcd-ok { border:0 !important; background:var(--accg, var(--acc, #8977d5)); color:var(--acc-ink, #fff); }
.lcd-ok.danger { background:linear-gradient(135deg,#ff2b55,#ff4d6d); color:#fff; }
@keyframes lcdFade { from { opacity:0; } to { opacity:1; } }`;
    document.head.appendChild(st);
  }

  /** Diálogo propio (fuera del panel). kind: confirm | alert | prompt */
  function own(kind, message, o) {
    injectCss();
    return new Promise((resolve) => {
      const back = document.createElement('div');
      back.className = 'lcd-back';
      back.innerHTML = `<div class="lcd-box" role="dialog" aria-modal="true">
        ${o.icon ? `<div class="lcd-ico">${o.icon}</div>` : ''}
        ${o.title ? `<h3>${esc(o.title)}</h3>` : ''}
        ${message ? `<p>${html(message)}</p>` : ''}
        ${kind === 'prompt' ? `<input type="text" maxlength="500" value="${esc(o.value || '')}">` : ''}
        <div class="lcd-btns">
          ${kind === 'alert' ? '' : `<button type="button" class="lcd-cancel">${esc(o.cancelText || 'Cancelar')}</button>`}
          <button type="button" class="lcd-ok${o.danger ? ' danger' : ''}">${esc(o.okText || (kind === 'alert' ? 'Entendido' : 'Aceptar'))}</button>
        </div></div>`;
      document.body.appendChild(back);
      const input = back.querySelector('input');
      let done = false;
      const close = (ok) => {
        if (done) return;
        done = true;
        document.removeEventListener('keydown', onKey, true);
        back.remove();
        if (kind === 'confirm') resolve(!!ok);
        else if (kind === 'prompt') resolve(ok ? input.value : null);
        else resolve();
      };
      const onKey = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); close(false); }
        else if (e.key === 'Enter') { e.preventDefault(); close(true); }
      };
      document.addEventListener('keydown', onKey, true);
      back.querySelector('.lcd-ok').onclick = () => close(true);
      const c = back.querySelector('.lcd-cancel');
      if (c) c.onclick = () => close(false);
      back.addEventListener('click', (e) => { if (e.target === back) close(kind === 'alert'); });
      setTimeout(() => (input || back.querySelector('.lcd-ok')).focus(), 20);
    });
  }

  window.lcConfirm = function (message, o) {
    o = o || {};
    const p = panel();
    if (p) {
      return p.askConfirm({
        title: esc(o.title || message), message: o.title ? html(message) : '',
        confirmText: esc(o.okText || 'Aceptar'), cancelText: esc(o.cancelText || 'Cancelar'),
        icon: o.icon || '❓', danger: !!o.danger,
      });
    }
    return own('confirm', message, Object.assign({ icon: '❓' }, o));
  };

  window.lcAlert = function (message, o) {
    o = o || {};
    const p = panel();
    if (p) {
      // Aviso de un solo botón con el diseño del panel.
      return p.askConfirm({
        title: esc(o.title || 'Aviso'), message: html(message), confirmText: esc(o.okText || 'Entendido'),
        cancelText: 'Cerrar', icon: o.icon || 'ℹ️', danger: false, modalClass: 'lcd-alert',
      }).then(() => undefined);
    }
    return own('alert', message, Object.assign({ icon: 'ℹ️', title: 'Aviso' }, o));
  };

  window.lcPrompt = function (message, value, o) {
    o = o || {};
    const p = panel();
    if (p && typeof p.askText === 'function') {
      return p.askText({
        // askText ya escapa el texto.
        title: o.title || message, message: o.title ? String(message || '') : '', value: value || '',
        confirmText: o.okText || 'Aceptar', icon: o.icon || '✏️', maxLength: 500,
      });
    }
    return own('prompt', message, Object.assign({ icon: '✏️', value: value || '' }, o));
  };
})();
