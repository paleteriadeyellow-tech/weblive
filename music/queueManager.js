export function createQueueManager(db) {
  function list() { return db.loadQueue(); }

  function save(q) { db.saveQueue(q); }

  function sortQueue(q) {
    return q.slice().sort((a, b) => {
      const pd = (Number(b.priority) || 0) - (Number(a.priority) || 0);
      if (pd) return pd;
      return (Number(a.requestedAt) || 0) - (Number(b.requestedAt) || 0);
    });
  }

  function add(entry) {
    const q = list();
    q.push({
      id: entry.id || `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      videoId: entry.videoId,
      title: entry.title,
      duration: entry.duration || 0,
      thumbnail: entry.thumbnail || '',
      channel: entry.channel || '',
      url: entry.url || '',
      requestedBy: entry.requestedBy || '',
      requestedByNick: entry.requestedByNick || entry.requestedBy || '',
      requestedAt: entry.requestedAt || Date.now(),
      priority: Number(entry.priority) || 0,
    });
    const sorted = sortQueue(q);
    save(sorted);
    return sorted;
  }

  function removeAt(index) {
    const q = list();
    if (index < 0 || index >= q.length) return q;
    q.splice(index, 1);
    save(q);
    return q;
  }

  function removeById(id) {
    const q = list().filter((s) => s.id !== id);
    save(q);
    return q;
  }

  function move(index, dir) {
    const q = list();
    const j = index + dir;
    if (index < 0 || j < 0 || index >= q.length || j >= q.length) return q;
    [q[index], q[j]] = [q[j], q[index]];
    save(q);
    return q;
  }

  function playNow(id) {
    const q = list();
    const i = q.findIndex((s) => s.id === id);
    if (i <= 0) return q;
    const [song] = q.splice(i, 1);
    q.unshift(song);
    save(q);
    return q;
  }

  function shift() {
    const q = list();
    const song = q.shift() || null;
    save(q);
    return song;
  }

  function clear() {
    save([]);
    return [];
  }

  function hasDuplicate(videoId) {
    return list().some((s) => s.videoId === videoId);
  }

  return { list, add, removeAt, removeById, move, playNow, shift, clear, hasDuplicate, sortQueue };
}
