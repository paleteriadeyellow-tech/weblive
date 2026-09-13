/**
 * Acumula likes por usuario hasta alcanzar el mínimo (likeN / likeMin).
 * Ej.: mínimo 50 → tandas de 15+20+20 disparan 1 acción y guardan 5 de sobra.
 * Sin uniqueId/nick (evento incompleto) usa 'anon' para no perder el disparo.
 */
export function likeTriggerFires(acc, a, info, user, fallbackKey) {
  const uid = String(
    user?.uniqueId || info?.username || user?.nickname || info?.nickname || 'anon',
  ).trim() || 'anon';
  const batch = Math.max(0, Number(info.likeCount) || 0);
  if (batch <= 0) return 0;
  const goal = Math.max(1, parseInt(a?.likeN ?? a?.likeMin, 10) || 1);
  const actKey = String(a?.uid || a?.id || a?.label || fallbackKey);
  const key = `${uid}:${actKey}`;
  const carry = (acc.get(key) || 0) + batch;
  const fires = Math.floor(carry / goal);
  acc.set(key, carry - fires * goal);
  if (acc.size > 8000) acc.clear();
  return fires;
}

/** Meta de likes globales: juegos usan likeN; Acciones/videos/sonidos usan likeGoal. */
export function likeGlobalGoal(a, fallback = 100) {
  const n = parseInt(a?.likeN ?? a?.likeGoal ?? a?.likeMin, 10);
  return Math.max(1, n || fallback || 100);
}

/**
 * Cuántas veces cruzó el umbral global entre prev y total.
 * 0→250 con meta 100 = 2. Tope 50 para no saturar al conectar a un live ya avanzado.
 */
export function likeGlobalTimes(total, prevTotal, goal) {
  const g = Math.max(1, parseInt(goal, 10) || 100);
  const t = Math.max(0, Number(total) || 0);
  const p = Math.max(0, Number(prevTotal) || 0);
  if (t <= p) return 0;
  const n = Math.floor(t / g) - Math.floor(p / g);
  if (n <= 0) return 0;
  return Math.min(50, n);
}
