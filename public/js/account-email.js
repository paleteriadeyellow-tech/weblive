// Vincular / verificar email de la cuenta (recuperación de contraseña).
(function () {
  const $ = (id) => document.getElementById(id);

  function ensureModal() {
    if ($('emailAccountModal')) return;
    const wrap = document.createElement('div');
    wrap.id = 'emailAccountModal';
    wrap.className = 'modal hidden';
    wrap.innerHTML = `
      <div class="modal-card" style="max-width:420px">
        <div class="modal-head">
          <h3>Correo de recuperación</h3>
          <button type="button" class="modal-x" id="email-acc-close" aria-label="Cerrar">×</button>
        </div>
        <div class="modal-body">
          <p class="hint" id="email-acc-status" style="margin-top:0">Añade un correo verificado para poder recuperar tu contraseña.</p>
          <label class="ml">Correo</label>
          <input type="email" id="email-acc-input" placeholder="tu@correo.com" autocomplete="email">
          <button type="button" class="btn primary" id="email-acc-send" style="margin-top:12px;width:100%">Enviar código</button>
          <div id="email-acc-codewrap" hidden style="margin-top:14px">
            <label class="ml">Código (6 dígitos)</label>
            <input type="text" id="email-acc-code" inputmode="numeric" maxlength="6" placeholder="000000" autocomplete="one-time-code">
            <button type="button" class="btn primary" id="email-acc-verify" style="margin-top:12px;width:100%">Verificar</button>
          </div>
          <p class="hint" id="email-acc-msg" style="min-height:1.2em"></p>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
    $('email-acc-close').onclick = close;
    $('email-acc-send').onclick = sendCode;
    $('email-acc-verify').onclick = verifyCode;
  }

  function setMsg(text, ok) {
    const el = $('email-acc-msg');
    if (!el) return;
    el.textContent = text || '';
    el.style.color = ok ? '#5be1a0' : (text ? '#ff7a90' : '');
  }

  function open() {
    ensureModal();
    const modal = $('emailAccountModal');
    const st = $('email-acc-status');
    const email = window.MY_EMAIL || '';
    const verified = !!window.MY_EMAIL_VERIFIED;
    if (st) {
      st.textContent = verified && email
        ? `Correo actual: ${email}. Puedes cambiarlo enviando un código al nuevo correo.`
        : 'Añade un correo verificado para poder recuperar tu contraseña si la olvidas.';
    }
    if ($('email-acc-input')) $('email-acc-input').value = email || '';
    if ($('email-acc-codewrap')) $('email-acc-codewrap').hidden = true;
    if ($('email-acc-code')) $('email-acc-code').value = '';
    setMsg('');
    modal.classList.remove('hidden');
  }

  function close() {
    const modal = $('emailAccountModal');
    if (modal) modal.classList.add('hidden');
  }

  async function sendCode() {
    const email = ($('email-acc-input')?.value || '').trim();
    if (!email) { setMsg('Escribe tu correo.'); return; }
    setMsg('Enviando…');
    try {
      const r = await fetch('/api/account/email/request-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setMsg(d.error || 'No se pudo enviar.'); return; }
      setMsg(d.message || 'Código enviado.', true);
      if ($('email-acc-codewrap')) $('email-acc-codewrap').hidden = false;
    } catch {
      setMsg('Error de conexión.');
    }
  }

  async function verifyCode() {
    const code = ($('email-acc-code')?.value || '').trim();
    if (!code) { setMsg('Escribe el código.'); return; }
    setMsg('Verificando…');
    try {
      const r = await fetch('/api/account/email/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setMsg(d.error || 'No se pudo verificar.'); return; }
      window.MY_EMAIL = d.email || '';
      window.MY_EMAIL_VERIFIED = true;
      setMsg(d.message || 'Correo verificado.', true);
      const btn = $('email-acc-btn');
      if (btn) btn.title = window.MY_EMAIL ? `Email: ${window.MY_EMAIL}` : 'Correo de recuperación';
    } catch {
      setMsg('Error de conexión.');
    }
  }

  function wireButton() {
    ensureModal();
    let btn = $('email-acc-btn');
    if (!btn) {
      const row = document.querySelector('#user-chip .user-chip-row');
      if (!row) return;
      btn = document.createElement('button');
      btn.type = 'button';
      btn.id = 'email-acc-btn';
      btn.className = 'sidebar-logout-btn';
      btn.textContent = 'Email';
      btn.title = 'Correo de recuperación';
      const logout = $('logout-btn');
      if (logout) row.insertBefore(btn, logout);
      else row.appendChild(btn);
    }
    btn.onclick = open;
  }

  window.openEmailAccountModal = open;
  window.refreshEmailAccountUi = function (me) {
    if (!me) return;
    window.MY_EMAIL = me.email || null;
    window.MY_EMAIL_VERIFIED = !!me.emailVerified;
    wireButton();
    const btn = $('email-acc-btn');
    if (btn && me.email) btn.title = `Email: ${me.email}`;
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wireButton);
  } else {
    wireButton();
  }
})();
