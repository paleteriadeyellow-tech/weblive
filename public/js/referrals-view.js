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

  // Botón «Invita y gana» de arriba: muestra los Coins (disponibles + en espera) si tiene.
  function updateTopBtn() {
    const el = document.getElementById('refTopCoins');
    if (!el) return;
    const total = data ? (Number(data.coins) || 0) + (Number(data.pendingCoins) || 0) : 0;
    el.hidden = !(total > 0);
    el.textContent = total > 0 ? `🪙 ${fmt(total)}` : '';
  }
  function goInvita() {
    const nav = document.querySelector('.nav-item[data-view="invita"]');
    if (nav) nav.click();
  }

  function render() {
    updateTopBtn();
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

    const maxReward = Math.max(d.rewards.pro, d.rewards.premium, d.rewards.founder);
    const paidN = friends.filter((f) => f.status === 'paid' || f.status === 'pending').length;
    const initial = (u) => esc(String(u || '?').replace(/^@/, '').charAt(0).toUpperCase() || '?');

    body.innerHTML = `
      <section class="rf-hero">
        <div class="rf-hero-txt">
          <span class="rf-kicker">Programa de invitados</span>
          <h2>Comparte Livecoins y <em>gana días gratis</em></h2>
          <p>Tu amigo ahorra <b>${d.discountPct}%</b> en su primer mes y tú ganas hasta <b>+${fmt(maxReward)} Coins</b> por cada amigo que pague.</p>
        </div>
        <div class="rf-ticket">
          <span class="rf-ticket-lbl">Tu código</span>
          <button type="button" class="rf-ticket-code" data-ref="copy-code" title="Copiar código">${esc(d.code)}</button>
          <div class="rf-ticket-btns">
            <button type="button" class="rf-btn rf-btn-main" data-ref="copy-invite">Copiar invitación</button>
            <button type="button" class="rf-btn rf-btn-soft" data-ref="copy-link">Copiar enlace</button>
          </div>
          <button type="button" class="rf-link" data-ref="edit-code">Cambiar mi código</button>
        </div>
      </section>

      <div class="rf-stats">
        <section class="rf-tile rf-wallet">
          <div class="rf-tile-top"><span class="rf-tile-lbl">Saldo disponible</span><span class="rf-rate">${d.dayCost.pro} = 1 día PRO · ${d.dayCost.premium} = 1 día VIP</span></div>
          <div class="rf-num">${fmt(d.coins)}<small>Coins</small></div>
          <div class="rf-meter"><i style="width:${d.coins >= goal.cost ? 100 : pct}%"></i></div>
          <p class="rf-hint">${d.coins >= goal.cost
    ? (anyRedeem ? `Ya puedes canjear <b>${canDays(goal.plan)} día(s)</b> de ${PLAN_NAME[goal.plan]}.` : 'Tienes Coins suficientes para canjear cuando tu plan tenga fecha.')
    : `Te faltan <b>${fmt(missing)} Coins</b> para ${d.coins || d.pendingCoins ? 'otro' : 'tu primer'} día gratis de ${PLAN_NAME[goal.plan]}.`}</p>
          <button type="button" class="rf-btn rf-btn-main" data-ref="redeem" ${anyRedeem ? '' : 'disabled'}>Canjear por días</button>
          ${(d.redeem || []).length ? '' : '<p class="rf-hint rf-muted">Tu plan actual no tiene días que sumar; guarda tus Coins para después.</p>'}
        </section>
        <section class="rf-tile">
          <span class="rf-tile-lbl">En espera</span>
          <div class="rf-num rf-gold">${fmt(d.pendingCoins)}<small>Coins</small></div>
          <p class="rf-hint">${d.pendingCoins
    ? `Se liberan ${d.holdDays} días después del pago de tu amigo. Próximo: <b>${new Date(d.nextRelease).toLocaleDateString('es-MX')}</b>.`
    : `Cuando un amigo pague, sus Coins aparecen aquí y se liberan a los ${d.holdDays} días.`}</p>
        </section>
        <section class="rf-tile">
          <span class="rf-tile-lbl">Amigos</span>
          <div class="rf-num">${fmt(friends.length)}<small>${friends.length === 1 ? 'invitado' : 'invitados'}</small></div>
          <p class="rf-hint">${paidN ? `<b>${paidN}</b> ya ${paidN === 1 ? 'pagó' : 'pagaron'} su plan.` : 'Aún ninguno ha pagado su plan.'}</p>
        </section>
      </div>

      <section class="rf-steps">
        <h3>Cómo funciona</h3>
        <ol>
          <li><span class="rf-step-n">1</span><div><b>Comparte tu código</b><small>Copia tu invitación y mándala a tus amigos streamers.</small></div></li>
          <li><span class="rf-step-n">2</span><div><b>Tu amigo se une</b><small>Crea su cuenta con tu código y ahorra ${d.discountPct}% en su primer mes.</small></div></li>
          <li><span class="rf-step-n">3</span><div><b>Tú ganas Coins</b><small>Cuando paga, recibes Coins (se liberan a los ${d.holdDays} días):</small>
            <div class="rf-rewards"><span>PRO <b>+${fmt(d.rewards.pro)}</b></span><span>VIP <b>+${fmt(d.rewards.premium)}</b></span><span>Founder <b>+${fmt(d.rewards.founder)}</b></span></div></div></li>
        </ol>
      </section>

      ${d.canEnterCode || d.referredBy ? `
      <section class="rf-strip">
        ${d.referredBy
    ? `<p>🎟️ Entraste con la invitación de <b>@${esc(d.referredBy)}</b>.${d.myDiscountPct ? ` Tienes <b>${d.myDiscountPct}% de descuento</b> en tu primer pago de PRO o VIP.`
      : d.discountBlocked ? ' <span class="rf-muted">Sin descuento: desde tu red ya se usó un código o es la misma red de quien te invitó.</span>' : ''}</p>`
    : `<div class="rf-strip-txt"><b>¿Te invitó alguien?</b><small>Pon su código antes de tu primer pago y ten ${d.discountPct}% de descuento.</small></div>
           <div class="rf-strip-form"><input type="text" class="ref-input rf-input" maxlength="16" placeholder="Código de tu amigo" data-ref-input="apply"><button type="button" class="rf-btn rf-btn-main" data-ref="apply">Aplicar</button></div>`}
      </section>` : ''}

      <section class="rf-friends">
        <h3>Tus amigos</h3>
        ${friends.length ? `<ul>${friends.map((f) => `
          <li>
            <span class="rf-av">${initial(f.username)}</span>
            <div class="rf-fr-txt"><b>@${esc(f.username)}</b><small>${f.at ? 'Se unió el ' + new Date(f.at).toLocaleDateString('es-MX') : ''}</small></div>
            ${f.status === 'paid' ? `<span class="rf-tag rf-tag-ok">+${fmt(f.coins)} Coins</span>`
    : f.status === 'blocked' ? '<span class="rf-tag rf-tag-off" title="Mismo correo o misma red que tú, o desde su red ya se usó otro código.">Sin Coins · misma persona o red</span>'
      : f.status === 'pending' ? `<span class="rf-tag rf-tag-wait">+${fmt(f.coins)} el ${new Date(f.until).toLocaleDateString('es-MX')}</span>`
      : '<span class="rf-tag">Aún no paga</span>'}
          </li>`).join('')}</ul>`
    : '<div class="rf-empty">Aún no entra nadie con tu código.<br>Compártelo y aquí verás a tus amigos.</div>'}
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
    const mo = new MutationObserver(() => {
      const on = root.classList.contains('active');
      document.getElementById('refTopBtn')?.classList.toggle('is-active', on);
      if (on && !loading) load();
    });
    mo.observe(root, { attributes: true, attributeFilter: ['class'] });
    if (root.classList.contains('active')) load();
    // Botón de arriba y aviso de Planes → abren Invita y gana.
    document.getElementById('refTopBtn')?.addEventListener('click', goInvita);
    document.addEventListener('click', (e) => {
      if (e.target.closest && e.target.closest('[data-ipp-invita]')) goInvita();
    });
    // Coins en el botón: una consulta ligera al abrir el panel (después se actualiza al entrar a la vista).
    setTimeout(async () => {
      if (data || loading) return;
      try {
        const r = await fetch('/api/referrals/me', { credentials: 'same-origin' });
        const j = await r.json().catch(() => null);
        if (r.ok && j && j.ok !== false && !data) { data = j; updateTopBtn(); }
      } catch {}
    }, 6000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
