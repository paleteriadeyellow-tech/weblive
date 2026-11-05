// Vista «Invita y gana»: tu código, tus Coins, canje por días y tus amigos.
// Los datos viven en la nube (/api/referrals/*); el .exe los reenvía con su sesión.
(function () {
  const VIEW_ID = 'view-invita';
  let data = null;
  let loading = false;

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n) => (Number(n) || 0).toLocaleString('es-MX');
  const say = (msg, kind) => { try { if (typeof window.toast === 'function') return window.toast(msg, kind); } catch {} };
  const PLAN_NAME = { pro: 'PRO', premium: 'VIP' };

  async function api(path, body) {
    const r = await fetch(path, body ? {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    } : { credentials: 'same-origin' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.ok === false) throw new Error(j.error || 'No se pudo completar. Intenta de nuevo.');
    return j;
  }

  async function copy(text, okMsg) {
    try { await navigator.clipboard.writeText(text); }
    catch {
      const t = document.createElement('textarea');
      t.value = text; document.body.appendChild(t); t.select();
      try { document.execCommand('copy'); } catch {}
      t.remove();
    }
    say(okMsg || 'Copiado', 'ok');
  }

  function inviteText(d) {
    return `Descarga Livecoins (app de PC) y al crear tu cuenta pon mi código ${d.code}: tienes ${d.discountPct}% de descuento en tu primer mes. ${d.link}`;
  }

  // Siguiente meta: el canje más barato que puede hacer (PRO si se puede, si no VIP).
  function nextGoal(d) {
    const plan = (d.redeem || []).includes('pro') ? 'pro' : (d.redeem || [])[0] || 'pro';
    return { plan, cost: d.dayCost[plan] };
  }

  function render() {
    const root = document.getElementById(VIEW_ID);
    if (!root) return;
    const body = root.querySelector('.ref-body');
    if (!data) {
      body.innerHTML = `<div class="ref-card ref-empty">${loading ? 'Cargando…' : 'No se pudo cargar. <button type="button" class="btn ghost" data-ref="reload">Reintentar</button>'}</div>`;
      return;
    }
    const d = data;
    const goal = nextGoal(d);
    const pct = Math.min(100, Math.round(((d.coins % goal.cost) / goal.cost) * 100));
    const canDays = (plan) => Math.floor(d.coins / d.dayCost[plan]);
    const anyRedeem = (d.redeem || []).some((p) => canDays(p) >= 1);
    const missing = goal.cost - (d.coins % goal.cost);
    const friends = d.friends || [];

    body.innerHTML = `
      <div class="ref-top">
        <section class="ref-card ref-coins">
          <div class="ref-card-head"><span class="ref-ico">🪙</span><span>Tus Coins</span></div>
          <div class="ref-big">${fmt(d.coins)} <small>Coins</small></div>
          <div class="ref-bar"><i style="width:${d.coins >= goal.cost ? 100 : pct}%"></i></div>
          <p class="ref-sub">${d.coins >= goal.cost
    ? (anyRedeem ? `Ya puedes canjear <b>${canDays(goal.plan)} día(s)</b> de ${PLAN_NAME[goal.plan]}.` : 'Tienes Coins suficientes para canjear cuando tu plan tenga fecha.')
    : `Te faltan <b>${fmt(missing)} Coins</b> para ${d.coins || d.pendingCoins ? 'otro' : 'tu primer'} día gratis de ${PLAN_NAME[goal.plan]}.`}</p>
          <div class="ref-row">
            <button type="button" class="btn primary" data-ref="redeem" ${anyRedeem ? '' : 'disabled'}>Canjear por días</button>
            <span class="ref-note">${d.dayCost.pro} Coins = 1 día PRO · ${d.dayCost.premium} Coins = 1 día VIP</span>
          </div>
          ${d.pendingCoins ? `<p class="ref-note ref-wait">⏳ <b>${fmt(d.pendingCoins)} Coins en espera</b>: se liberan ${d.holdDays} días después del pago de tu amigo (el próximo el ${new Date(d.nextRelease).toLocaleDateString('es-MX')}).</p>` : ''}
          ${(d.redeem || []).length ? '' : '<p class="ref-note">Tu plan actual no tiene días que sumar; guarda tus Coins para después.</p>'}
        </section>

        <section class="ref-card ref-code">
          <div class="ref-card-head"><span class="ref-ico">🎟️</span><div><b>Tu código</b><small>Compártelo. Tu amigo ahorra ${d.discountPct}% y tú ganas Coins.</small></div></div>
          <button type="button" class="ref-codebox" data-ref="copy-code" title="Copiar código">${esc(d.code)} <span>⧉</span></button>
          <div class="ref-row ref-row-2">
            <button type="button" class="btn primary" data-ref="copy-invite">Copiar invitación</button>
            <button type="button" class="btn ghost" data-ref="copy-link">Copiar enlace</button>
          </div>
          <div class="ref-link">${esc(d.link)}</div>
          <button type="button" class="ref-mini" data-ref="edit-code">✏️ Cambiar mi código</button>
        </section>
      </div>

      ${d.canEnterCode || d.referredBy ? `
      <section class="ref-card ref-invited">
        ${d.referredBy
    ? `<p>Entraste con la invitación de <b>@${esc(d.referredBy)}</b>.${d.myDiscountPct ? ` Tienes <b>${d.myDiscountPct}% de descuento</b> en tu primer pago de PRO o VIP.`
      : d.discountBlocked ? ' <span class="ref-note">Sin descuento: desde tu red ya se usó un código o es la misma red de quien te invitó.</span>' : ''}</p>`
    : `<div><b>¿Te invitó alguien?</b><small>Pon su código antes de tu primer pago y ten ${d.discountPct}% de descuento.</small></div>
           <div class="ref-row"><input type="text" class="ref-input" maxlength="16" placeholder="CÓDIGO" data-ref-input="apply"><button type="button" class="btn primary" data-ref="apply">Aplicar</button></div>`}
      </section>` : ''}

      <section class="ref-card">
        <div class="ref-card-head"><span class="ref-ico">🏆</span><div><b>Cómo ganar Coins</b><small>Cada recompensa suma Coins a tu saldo.</small></div></div>
        <div class="ref-task">
          <span class="ref-ico">👥</span>
          <div class="ref-task-txt">
            <b>Invita a un amigo</b>
            <small>Tu amigo ahorra ${d.discountPct}% en su primer mes. Tú ganas Coins cuando paga (se liberan a los ${d.holdDays} días).</small>
            <div class="ref-chips"><span>Si compra PRO <b>+${fmt(d.rewards.pro)}</b></span><span>Si compra VIP <b>+${fmt(d.rewards.premium)}</b></span><span>Si compra Founder <b>+${fmt(d.rewards.founder)}</b></span></div>
          </div>
          <span class="ref-pill">Hasta +${fmt(Math.max(d.rewards.pro, d.rewards.premium, d.rewards.founder))}</span>
          <button type="button" class="btn primary" data-ref="copy-invite">Copiar invitación</button>
        </div>
      </section>

      <section class="ref-card">
        <div class="ref-card-head"><span class="ref-ico">🤝</span><div><b>Tus amigos</b><small>Así va cada amigo que entró con tu código.</small></div></div>
        ${friends.length ? `<div class="ref-friends">${friends.map((f) => `
          <div class="ref-friend">
            <b>@${esc(f.username)}</b>
            <small>${f.at ? new Date(f.at).toLocaleDateString('es-MX') : ''}</small>
            ${f.status === 'paid' ? `<span class="ref-st ok">Pagó · +${fmt(f.coins)} Coins</span>`
    : f.status === 'blocked' ? '<span class="ref-st">Pagó · sin Coins (misma persona)</span>'
      : f.status === 'pending' ? `<span class="ref-st wait">Pagó · +${fmt(f.coins)} Coins el ${new Date(f.until).toLocaleDateString('es-MX')}</span>`
      : '<span class="ref-st">Registrado · aún no paga</span>'}
          </div>`).join('')}</div>`
    : '<div class="ref-empty">Aún no entra nadie con tu código. Compártelo y aquí verás a tus amigos.</div>'}
      </section>`;
  }

  async function load() {
    loading = true;
    render();
    try { data = await api('/api/referrals/me'); }
    catch (e) { data = null; say(e.message, 'warn'); }
    loading = false;
    render();
  }

  async function refreshPlanOnly() {
    try {
      const me = await fetch('/api/me', { credentials: 'same-origin', cache: 'no-store' }).then((r) => (r.ok ? r.json() : null));
      if (!me) return;
      window.MY_PLAN = me.plan || 'free';
      window.MY_PREMIUM_UNTIL = Number(me.premiumUntil) || 0;
      if (typeof window.refreshDockPlanUi === 'function') window.refreshDockPlanUi(me);
      if (typeof window.renderPlanPricing === 'function') window.renderPlanPricing();
    } catch {}
  }

  function askRedeem() {
    const d = data;
    const opts = (d.redeem || []).filter((p) => Math.floor(d.coins / d.dayCost[p]) >= 1);
    if (!opts.length) return;
    const back = document.createElement('div');
    back.className = 'modal confirm-modal';
    back.innerHTML = `
      <div class="confirm-box" style="max-width:420px">
        <div class="confirm-ico">🪙</div>
        <h3>Canjear Coins</h3>
        <p>Tienes <b>${fmt(d.coins)} Coins</b>. Los días se suman a tu plan.</p>
        <div class="ref-redeem">
          ${opts.length > 1 ? `<select class="ref-input" data-k="plan">${opts.map((p) => `<option value="${p}">${PLAN_NAME[p]} (${d.dayCost[p]} Coins/día)</option>`).join('')}</select>` : `<p><b>${PLAN_NAME[opts[0]]}</b> · ${d.dayCost[opts[0]]} Coins por día</p>`}
          <input type="number" class="ref-input" data-k="days" min="1" value="1">
          <p class="ref-note" data-k="cost"></p>
        </div>
        <div class="confirm-btns">
          <button type="button" class="btn ghost c-cancel">Cancelar</button>
          <button type="button" class="btn primary c-ok">Canjear</button>
        </div>
      </div>`;
    document.body.appendChild(back);
    const $ = (k) => back.querySelector(`[data-k="${k}"]`);
    const plan = () => ($('plan') ? $('plan').value : opts[0]);
    const sync = () => {
      const max = Math.floor(d.coins / d.dayCost[plan()]);
      const inp = $('days');
      inp.max = String(max);
      let n = Math.round(Number(inp.value) || 1);
      if (n > max) { n = max; inp.value = String(n); }
      $('cost').textContent = `${n} día(s) de ${PLAN_NAME[plan()]} = ${fmt(n * d.dayCost[plan()])} Coins (máx. ${max}).`;
    };
    $('days').oninput = sync;
    if ($('plan')) $('plan').onchange = sync;
    sync();
    const close = () => back.remove();
    back.querySelector('.c-cancel').onclick = close;
    back.addEventListener('click', (e) => { if (e.target === back) close(); });
    back.querySelector('.c-ok').onclick = async () => {
      const days = Math.round(Number($('days').value) || 0);
      const btn = back.querySelector('.c-ok');
      btn.disabled = true;
      try {
        data = await api('/api/referrals/redeem', { plan: plan(), days });
        close();
        render();
        say(`¡Listo! Se sumaron ${days} día(s) de ${PLAN_NAME[plan()]}.`, 'ok');
        // Solo el plan (los límites nuevos llegan solos por el WebSocket). No usar loadMe():
        // es el arranque del panel y en pleno live volvería a cargar ajustes y sondeos.
        refreshPlanOnly();
      } catch (e) {
        btn.disabled = false;
        say(e.message, 'warn');
      }
    };
  }

  // Ventana propia (la web no tiene askText del .exe).
  function askCode(value) {
    return new Promise((resolve) => {
      const back = document.createElement('div');
      back.className = 'modal confirm-modal';
      back.innerHTML = `
        <div class="confirm-box" style="max-width:420px">
          <div class="confirm-ico">✏️</div>
          <h3>Cambiar mi código</h3>
          <p>De 4 a 16 letras o números. Tu código anterior seguirá funcionando. Solo puedes cambiarlo una vez por semana.</p>
          <div class="ref-redeem"><input type="text" class="ref-input" maxlength="16" style="text-transform:uppercase"></div>
          <div class="confirm-btns">
            <button type="button" class="btn ghost c-cancel">Cancelar</button>
            <button type="button" class="btn primary c-ok">Guardar</button>
          </div>
        </div>`;
      document.body.appendChild(back);
      const inp = back.querySelector('input');
      inp.value = value || '';
      const close = (v) => { back.remove(); resolve(v); };
      back.querySelector('.c-cancel').onclick = () => close(null);
      back.querySelector('.c-ok').onclick = () => close(inp.value);
      inp.onkeydown = (e) => { if (e.key === 'Enter') close(inp.value); else if (e.key === 'Escape') close(null); };
      back.addEventListener('click', (e) => { if (e.target === back) close(null); });
      setTimeout(() => { inp.focus(); inp.select(); }, 30);
    });
  }

  async function editCode() {
    const value = await askCode(data.code);
    if (value == null || !String(value).trim()) return;
    try {
      data = await api('/api/referrals/code', { code: value });
      render();
      say('Código actualizado', 'ok');
    } catch (e) { say(e.message, 'warn'); }
  }

  async function onClick(e) {
    const b = e.target.closest('[data-ref]');
    if (!b || !data && b.dataset.ref !== 'reload') return;
    const k = b.dataset.ref;
    if (k === 'reload') return load();
    if (k === 'copy-code') return copy(data.code, 'Código copiado');
    if (k === 'copy-link') return copy(data.link, 'Enlace copiado');
    if (k === 'copy-invite') return copy(inviteText(data), 'Invitación copiada');
    if (k === 'redeem') return askRedeem();
    if (k === 'edit-code') return editCode();
    if (k === 'apply') {
      const inp = document.querySelector(`#${VIEW_ID} [data-ref-input="apply"]`);
      const code = (inp && inp.value || '').trim();
      if (!code) return;
      b.disabled = true;
      try {
        data = await api('/api/referrals/apply', { code });
        render();
        say(`Código aplicado: tienes ${data.myDiscountPct}% de descuento en tu primer pago.`, 'ok');
        // Que Planes muestre ya el precio con descuento.
        try {
          await Promise.all([window.loadPaypalPremiumStatus?.(), window.loadMpPayStatus?.()]);
          window.renderPlanPricing?.();
        } catch {}
      } catch (err) { b.disabled = false; say(err.message, 'warn'); }
    }
  }

  function init() {
    const root = document.getElementById(VIEW_ID);
    if (!root || root.dataset.refInit) return;
    root.dataset.refInit = '1';
    root.addEventListener('click', onClick);
    // Carga cada vez que se abre la vista.
    const mo = new MutationObserver(() => { if (root.classList.contains('active') && !loading) load(); });
    mo.observe(root, { attributes: true, attributeFilter: ['class'] });
    if (root.classList.contains('active')) load();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
