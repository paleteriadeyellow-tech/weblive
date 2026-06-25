export function createHistoryManager(db) {
  function list() { return db.loadHistory(); }

  function add(entry) {
    const h = list();
    h.unshift({
      id: entry.id || Date.now(),
      videoId: entry.videoId,
      title: entry.title || '',
      requestedBy: entry.requestedBy || '',
      requestedByNick: entry.requestedByNick || entry.requestedBy || '',
      playedAt: entry.playedAt || Date.now(),
      duration: entry.duration || 0,
    });
    db.saveHistory(h);
    return h;
  }

  function clear() {
    db.saveHistory([]);
    return [];
  }

  return { list, add, clear };
}
