// Correos de pagos: recibo al activar un plan y aviso 3 días antes de que venza.
// Usa mail.js (Resend). Sin RESEND_API_KEY no hace nada. Solo corre en Render (la nube activa los planes).
import fs from 'node:fs';
import path from 'node:path';
import { sendMail, isMailConfigured } from './mail.js';

const CONTACT = 'paleteriadeyellow@gmail.com';
const DAY = 24 * 60 * 60 * 1000;
const REMIND_BEFORE = 3 * DAY;
const PACK_NAMES = {
  'vip-3': 'VIP 3 meses', 'vip-6': 'VIP 6 meses', 'vip-12': 'VIP 1 año',
  'founder-6': 'Founder 6 meses', 'founder-12': 'Founder 1 año',
};

function planName(plan) {
  const p = String(plan || '').toLowerCase();
  return p === 'pro' ? 'PRO' : p === 'founder' ? 'Founder' : 'VIP';
}
function fmtDate(ts) {
  try { return new Date(ts).toLocaleDateString('es-MX', { day: 'numeric', month: 'long', year: 'numeric' }); } catch { return ''; }
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
/** Correo de la cuenta: el verificado, o el de Google. */
export function userEmail(user) {
  if (!user) return '';
  if (user.emailVerified && user.email) return String(user.email);
  return String(user.googleEmail || '');
}

function layout(title, bodyHtml) {
  return `<!doctype html><html lang="es"><body style="margin:0;background:#0b1020;padding:24px 12px;font-family:Segoe UI,Arial,sans-serif">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center">
<table role="presentation" width="100%" style="max-width:520px;background:#121826;border:1px solid #263042;border-radius:16px" cellspacing="0" cellpadding="0">
<tr><td style="padding:22px 24px 6px;font-size:20px;font-weight:800;color:#25f4ee">Livecoins</td></tr>
<tr><td style="padding:6px 24px 4px;font-size:18px;font-weight:700;color:#f1f5f9">${esc(title)}</td></tr>
<tr><td style="padding:6px 24px 22px;font-size:15px;line-height:1.6;color:#cbd5e1">${bodyHtml}</td></tr>
<tr><td style="padding:14px 24px;border-top:1px solid #263042;font-size:12px;color:#94a3b8">
¿Dudas? Escríbenos a <a style="color:#25f4ee" href="mailto:${CONTACT}">${CONTACT}</a>.
<a style="color:#94a3b8" href="https://livecoins.onrender.com/legal.html">Términos y privacidad</a>
</td></tr></table></td></tr></table></body></html>`;
}

/** Recibo: se llama al activar un plan pagado (PayPal o Mercado Pago). */
export async function sendPaymentReceipt(user, granted, meta = {}) {
  if (!isMailConfigured() || !user) return { ok: false, skipped: true };
  const to = userEmail(user) || String(meta.payerEmail || '');
  if (!to.includes('@')) return { ok: false, skipped: true };
  const name = meta.pack ? (PACK_NAMES[meta.pack] || planName(meta.plan)) : planName(granted && granted.plan ? granted.plan : meta.plan);
  const until = Number(granted && granted.premiumUntil) || 0;
  const amount = meta.amount ? `$${Number(meta.amount).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${meta.currency || ''}`.trim() : '';
  const rows = [
    ['Plan', name],
    ['Cuenta', user.username || ''],
    amount ? ['Monto', amount] : null,
    meta.provider ? ['Pagado con', meta.provider] : null,
    until ? ['Activo hasta', fmtDate(until)] : ['Duración', 'Sin fecha de fin'],
    meta.ref ? ['Operación', meta.ref] : null,
  ].filter(Boolean);
  const table = `<table role="presentation" cellspacing="0" cellpadding="0" style="width:100%;margin:12px 0;border-collapse:collapse">${rows.map(([k, v]) =>
    `<tr><td style="padding:7px 0;color:#94a3b8;border-bottom:1px solid #1f2937">${esc(k)}</td><td style="padding:7px 0;text-align:right;color:#f1f5f9;font-weight:600;border-bottom:1px solid #1f2937">${esc(v)}</td></tr>`).join('')}</table>`;
  const html = layout(`¡Gracias! Tu plan ${name} está activo`, `
    <p style="margin:0 0 6px">Recibimos tu pago y tu plan ya quedó activado.</p>${table}
    <p style="margin:0">Si usas la app de PC, ábrela (o recarga el panel) para ver tu plan nuevo.</p>
    <p style="margin:10px 0 0;font-size:13px;color:#94a3b8">No hay cobros automáticos: cuando se acabe, renuevas solo si quieres.</p>`);
  const text = `¡Gracias! Tu plan ${name} está activo.\n\n${rows.map(([k, v]) => `${k}: ${v}`).join('\n')}\n\nNo hay cobros automáticos.\nDudas: ${CONTACT}`;
  const r = await sendMail({ to, subject: `Livecoins · Recibo de tu plan ${name}`, text, html });
  if (!r.ok) console.warn('[billing-mail] recibo no enviado:', r.error);
  return r;
}

/** Aviso de vencimiento: revisa cada 6 h a quién se le acaba el plan en 3 días o menos (una vez por periodo). */
export function startExpiryReminders({ dataDir, listUsersDetailed, getUserById, getUserPlan }) {
  const file = path.join(dataDir, 'billing-reminders.json');
  let sent = {};
  try { sent = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { sent = {}; }
  const save = () => {
    try { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(file, JSON.stringify(sent), 'utf8'); } catch (e) { console.warn('[billing-mail] guardar:', e && e.message); }
  };
  async function sweep() {
    if (!isMailConfigured()) return;
    const now = Date.now();
    let changed = false;
    for (const row of listUsersDetailed()) {
      const until = Number(row.premiumUntil) || 0;
      if (!until || until <= now || until - now > REMIND_BEFORE || row.isAdmin) continue;
      if (sent[row.id] === until) continue; // ya avisado de este periodo
      const user = getUserById(row.id);
      const plan = user ? getUserPlan(user) : '';
      if (!user || !['pro', 'premium', 'founder'].includes(plan)) continue;
      const to = userEmail(user);
      if (!to.includes('@')) { sent[row.id] = until; changed = true; continue; } // sin correo: no volver a revisarlo
      const name = planName(plan);
      const days = Math.max(1, Math.ceil((until - now) / DAY));
      const html = layout(`Tu plan ${name} vence pronto`, `
        <p style="margin:0 0 10px">Hola <b>${esc(user.username || '')}</b>, tu plan <b>${name}</b> vence en <b>${days} día${days === 1 ? '' : 's'}</b> (${esc(fmtDate(until))}).</p>
        <p style="margin:0 0 10px">Para no perder tus funciones, renuévalo desde <b>Planes</b> en Livecoins. Puedes pagar con PayPal, tarjeta u OXXO.</p>
        <p style="margin:0;font-size:13px;color:#94a3b8">Si renuevas antes de que venza, los días nuevos se suman a los que te quedan.</p>`);
      const text = `Tu plan ${name} vence en ${days} día(s) (${fmtDate(until)}). Renuévalo desde Planes en Livecoins (PayPal, tarjeta u OXXO). Los días se suman a los que te quedan.\nDudas: ${CONTACT}`;
      const r = await sendMail({ to, subject: `Livecoins · Tu plan ${name} vence en ${days} día${days === 1 ? '' : 's'}`, text, html });
      if (r.ok) { sent[row.id] = until; changed = true; }
      else console.warn('[billing-mail] aviso no enviado (se reintenta en 6 h):', r.error);
    }
    if (changed) save();
  }
  setTimeout(() => { sweep().catch(() => {}); }, 2 * 60 * 1000);
  setInterval(() => { sweep().catch(() => {}); }, 6 * 60 * 60 * 1000);
  return { sweep };
}
