// Vincular / verificar email de la cuenta (recuperación de contraseña).
(function () {
  const $ = (id) => document.getElementById(id);

  function ensureStyles() {
    if ($('email-acc-glass-css')) return;
    const style = document.createElement('style');
    style.id = 'email-acc-glass-css';
    style.textContent = `
      #emailVerifyPrompt .email-glass-card,
      #emailAccountModal .email-glass-card {
        max-width: 420px;
        width: 100%;
        border-radius: 18px;
        border: 1px solid rgba(255, 255, 255, 0.22);
        background: rgba(18, 24, 38, 0.55);
        backdrop-filter: blur(18px) saturate(1.35);
        -webkit-backdrop-filter: blur(18px) saturate(1.35);
        box-shadow:
          0 0 0 1px rgba(0, 229, 255, 0.12),
          0 20px 50px rgba(0, 0, 0, 0.45),
          inset 0 1px 0 rgba(255, 255, 255, 0.1);
        overflow: hidden;
      }
      #emailVerifyPrompt .email-glass-card .modal-head,
      #emailAccountModal .email-glass-card .modal-head {
        border-bottom: 1px solid rgba(255, 255, 255, 0.12);
        background: rgba(255, 255, 255, 0.04);
      }
      #emailAccountModal .email-glass-card input[type="email"],
      #emailAccountModal .email-glass-card input[type="text"] {
        width: 100%;
        border-radius: 12px;
        border: 1px solid rgba(255, 255, 255, 0.2);
        background: rgba(12, 19, 34, 0.45);
        backdrop-filter: blur(10px);
        -webkit-backdrop-filter: blur(10px);
        color: #e8ecf5;
        padding: 12px 14px;
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.06);
      }
      #emailAccountModal .email-glass-card input:focus {
        outline: none;
        border-color: rgba(0, 229, 255, 0.55);
        box-shadow: 0 0 0 3px rgba(0, 229, 255, 0.14);
      }
      #emailVerifyPrompt .btn.ghost {
        border-color: rgba(255, 255, 255, 0.22);
        background: rgba(255, 255, 255, 0.06);
        backdrop-filter: blur(8px);
        -webkit-backdrop-filter: blur(8px);
      }
    `;
    document.head.appendChild(style);
  }

  function dismissKey() {
    return `livecoins_email_prompt_later_${window.MY_USER || 'default'}`;
  }

  function wasDismissedLater() {
    try { return sessionStorage.getItem(dismissKey()) === '1'; } catch { return false; }
  }

  function markDismissedLater() {
    try { sessionStorage.setItem(dismissKey(), '1'); } catch {}
  }

  function clearDismissedLater() {
    try { sessionStorage.removeItem(dismissKey()); } catch {}
  }

  function ensureModal() {
    if ($('emailAccountModal')) return;
    ensureStyles();
    const wrap = document.createElement('div');
    wrap.id = 'emailAccountModal';
    wrap.className = 'modal hidden';
    wrap.innerHTML = `
      <div class="modal-card email-glass-card">
        <div class="modal-head">
          <h3>Correo de recuperación</h3>
          <button type="button" class="modal-x" id="email-acc-close" aria-label="Cerrar">×</button>
        </div>
        <div class="modal-body">
          <p class="hint" id="email-acc-status" style="margin-top:0">Añade un correo verificado para poder recuperar tu contraseña si la olvidas.</p>
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

  function ensurePrompt() {
    if ($('emailVerifyPrompt')) return;
    ensureStyles();
    const wrap = document.createElement('div');
    wrap.id = 'emailVerifyPrompt';
    wrap.className = 'modal hidden';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.innerHTML = `
      <div class="modal-card email-glass-card">
        <div class="modal-head">
          <h3>Verifica tu correo</h3>
        </div>
        <div class="modal-body">
          <p class="hint" style="margin-top:0;line-height:1.5">
            Para poder recuperar tu contraseña si la olvidas, verifica un correo en tu cuenta.
          </p>
          <div style="display:flex;gap:10px;margin-top:18px;flex-wrap:wrap">
            <button type="button" class="btn primary" id="email-prompt-verify" style="flex:1;min-width:140px">Verificar</button>
            <button type="button" class="btn ghost" id="email-prompt-later" style="flex:1;min-width:140px">Después</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    $('email-prompt-verify').onclick = () => {
      hidePrompt();
      open();
    };
    $('email-prompt-later').onclick = () => {
      markDismissedLater();
      hidePrompt();
    };
  }

  function showPrompt() {
    ensurePrompt();
    const el = $('emailVerifyPrompt');
    if (el) el.classList.remove('hidden');
  }

  function hidePrompt() {
    const el = $('emailVerifyPrompt');
    if (el) el.classList.add('hidden');
  }

  function maybeShowVerifyPrompt() {
    ensurePrompt();
    // Ya verificado → nunca mostrar (cuentas antiguas tras vincular correo).
    if (window.MY_EMAIL_VERIFIED === true) {
      hidePrompt();
      clearDismissedLater();
      const btn = $('email-acc-btn');
      if (btn) btn.hidden = true;
      return;
    }
    if (wasDismissedLater()) {
      hidePrompt();
      return;
    }
    showPrompt();
  }

  function setMsg(text, ok) {
    const el = $('email-acc-msg');
    if (!el) return;
    el.textContent = text || '';
    el.style.color = ok ? '#5be1a0' : (text ? '#ff7a90' : '');
  }

  function open() {
    ensureModal();
    hidePrompt();
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

      // Revalidar con /api/me para no dejar el aviso colgado si el espejo local no sincronizó.
      let confirmed = !!(d.emailVerified || d.email);
      try {
        const meR = await fetch('/api/me');
        if (meR.ok) {
          const me = await meR.json();
          if (typeof window.refreshEmailAccountUi === 'function') {
            window.refreshEmailAccountUi(me);
          } else {
            window.MY_EMAIL = me.email || d.email || '';
            window.MY_EMAIL_VERIFIED = !!me.emailVerified;
          }
          confirmed = !!me.emailVerified;
        }
      } catch {}

      if (!confirmed) {
        // Confiar en la respuesta del verify si /api/me aún no refleja el cambio.
        window.MY_EMAIL = d.email || window.MY_EMAIL || '';
        window.MY_EMAIL_VERIFIED = true;
        confirmed = true;
      }

      clearDismissedLater();
      hidePrompt();
      setMsg(d.message || 'Correo verificado.', true);
      const btn = $('email-acc-btn');
      if (btn) {
        btn.hidden = true;
        btn.title = window.MY_EMAIL ? `Email: ${window.MY_EMAIL}` : 'Correo de recuperación';
      }
      close();
      try { if (typeof toast === 'function') toast(d.message || 'Correo verificado.', 'ok'); } catch {}
    } catch {
      setMsg('Error de conexión.');
    }
  }

  function wireButton() {
    ensureModal();
    ensurePrompt();
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
    // Solo cuentas sin correo verificado (usuarios antiguos). Las nuevas ya verifican al registrarse.
    btn.hidden = !!window.MY_EMAIL_VERIFIED;
  }

  window.openEmailAccountModal = open;
  window.refreshEmailAccountUi = function (me) {
    if (!me) return;
    window.MY_EMAIL = me.email || null;
    // Aceptar true / "true" / 1 por si algún proxy altera el tipo.
    window.MY_EMAIL_VERIFIED = me.emailVerified === true || me.emailVerified === 'true' || me.emailVerified === 1;
    wireButton();
    const btn = $('email-acc-btn');
    if (btn) {
      btn.hidden = !!window.MY_EMAIL_VERIFIED;
      if (me.email) btn.title = `Email: ${me.email}`;
    }
    maybeShowVerifyPrompt();
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wireButton);
  } else {
    wireButton();
  }
})();
