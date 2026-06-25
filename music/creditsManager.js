export function createCreditsManager(db) {
  function list() { return db.loadCredits(); }

  function find(uniqueId) {
    const key = String(uniqueId || '').trim().replace(/^@/, '').toLowerCase();
    return list().find((c) => c.uniqueId === key) || null;
  }

  function balance(uniqueId) {
    return find(uniqueId)?.credits || 0;
  }

  function saveAll(rows) {
    db.saveCredits(rows);
  }

  function upsert(uniqueId, nickname, delta, meta) {
    const key = String(uniqueId || '').trim().replace(/^@/, '').toLowerCase();
    if (!key) return 0;
    const rows = list();
    let row = rows.find((c) => c.uniqueId === key);
    if (!row) {
      row = { id: Date.now(), uniqueId: key, nickname: nickname || key, credits: 0, updatedAt: Date.now(), priorityBoost: 0 };
      rows.push(row);
    }
    row.credits = Math.max(0, (row.credits || 0) + delta);
    row.nickname = nickname || row.nickname;
    row.updatedAt = Date.now();
    if (meta?.priorityBoost) row.priorityBoost = Math.max(row.priorityBoost || 0, meta.priorityBoost);
    saveAll(rows);
    return row.credits;
  }

  function add(uniqueId, nickname, amount, meta) {
    return upsert(uniqueId, nickname, Math.max(0, Number(amount) || 0), meta);
  }

  function remove(uniqueId, amount) {
    const key = String(uniqueId || '').trim().replace(/^@/, '').toLowerCase();
    const cost = Math.max(0, Number(amount) || 0);
    const bal = balance(key);
    if (bal < cost) return { ok: false, balance: bal };
    const after = upsert(key, find(key)?.nickname, -cost);
    return { ok: true, balance: after };
  }

  function resetAll() {
    saveAll([]);
  }

  function replaceAll(rows) {
    saveAll(Array.isArray(rows) ? rows : []);
  }

  return { list, find, balance, add, remove, resetAll, replaceAll, upsert };
}
