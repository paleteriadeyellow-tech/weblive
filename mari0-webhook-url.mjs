/** IDs de enemigos Mari0 activador (:5720/spawn?enemy=…), no Metal Slug. */
export const MARI0_SPAWN_ENEMY_IDS = new Set([
  'spiny', 'koopa', 'bigkoopa', 'goomba', 'biggoomba', 'chainchomp', 'kingbill', 'muncher',
  'larry', 'wendy', 'lemmy', 'roy', 'ludwig', 'iggy', 'morton', 'bowser', 'boomboom',
]);

export function isMari0SpawnEnemyName(thing) {
  const raw = String(thing || '').trim().toLowerCase();
  if (!raw) return false;
  const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length > 1) return parts.every((p) => MARI0_SPAWN_ENEMY_IDS.has(p));
  return MARI0_SPAWN_ENEMY_IDS.has(parts[0]);
}

export function isMari05720SpawnUrl(urlStr) {
  const s = String(urlStr || '');
  if (!/(?:localhost|127\.0\.0\.1):5720\b/i.test(s) || !/\/spawn\b/i.test(s) || !/[?&]enemy=/i.test(s)) {
    return false;
  }
  try {
    const u = new URL(s.replace(/localhost/gi, '127.0.0.1'));
    const enemy = u.searchParams.get('enemy') || u.searchParams.get('thing') || '';
    return isMari0SpawnEnemyName(enemy);
  } catch {
    return false;
  }
}
