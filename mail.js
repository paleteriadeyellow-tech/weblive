// Envío de correos vía Resend (API HTTP). Sin dependencia npm extra.
// Variables: RESEND_API_KEY (obligatoria), EMAIL_FROM (opcional).

export function isMailConfigured() {
  return !!String(process.env.RESEND_API_KEY || '').trim();
}

export async function sendMail({ to, subject, text, html } = {}) {
  const key = String(process.env.RESEND_API_KEY || '').trim();
  const from = String(process.env.EMAIL_FROM || '').trim() || 'Livecoins <onboarding@resend.dev>';
  const dest = String(to || '').trim();
  if (!key) {
    return { ok: false, error: 'El envío de correo no está configurado. Falta RESEND_API_KEY en el servidor.' };
  }
  if (!dest || !dest.includes('@')) {
    return { ok: false, error: 'Correo destino inválido.' };
  }
  try {
    const body = { from, to: [dest], subject: subject || 'Livecoins', text: text || '' };
    if (html) body.html = html;
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = data?.message || data?.error || `Error al enviar correo (${r.status})`;
      return { ok: false, error: String(msg) };
    }
    return { ok: true, id: data.id || null };
  } catch (e) {
    return { ok: false, error: e?.message || 'No se pudo conectar con el servicio de correo.' };
  }
}
