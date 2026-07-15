/**
 * Acumula likes por usuario hasta alcanzar el mínimo (likeN) configurado.
 * Ej.: mínimo 50 → tandas de 15+20+20 disparan 1 acción y guardan 5 de sobra.
 */
export function likeTriggerFires(acc, a, info, user, fallbackKey) {
  const uid = String(user?.uniqueId || info?.username || '').trim();
  const batch = Math.max(0, Number(info.likeCount) || 0);
  if (!uid || batch <= 0) return 0;
  const goal = Math.max(1, parseInt(a?.likeN ?? a?.likeMin, 10) || 1);
  const actKey = String(a?.uid || a?.id || a?.label || fallbackKey);
  const key = `${uid}:${actKey}`;
  const carry = (acc.get(key) || 0) + batch;
  const fires = Math.floor(carry / goal);
  acc.set(key, carry - fires * goal);
  if (acc.size > 8000) acc.clear();
  return fires;
}
