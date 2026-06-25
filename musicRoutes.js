export function registerMusicRoutes(app, { userFromRequest, getRoomForUser }) {
  const json = (req, res, next) => {
    if (req.body != null) return next();
    expressJson(req, res, next);
  };

  function engine(req) {
    const user = userFromRequest(req);
    if (!user) return null;
    const room = getRoomForUser(user);
    return room.getMusicEngine?.() || null;
  }

  app.get('/api/music/queue', (req, res) => {
    const eng = engine(req);
    if (!eng) return res.status(401).json({ error: 'no auth' });
    const snap = eng.snapshot();
    res.json({ queue: snap.queue, current: snap.current, playerState: snap.playerState });
  });

  app.get('/api/music/current', (req, res) => {
    const eng = engine(req);
    if (!eng) return res.status(401).json({ error: 'no auth' });
    res.json({ song: eng.getCurrent(), playerState: eng.snapshot().playerState });
  });

  app.get('/api/music/history', (req, res) => {
    const eng = engine(req);
    if (!eng) return res.status(401).json({ error: 'no auth' });
    res.json({ history: eng.history.list() });
  });

  app.get('/api/music/credits', (req, res) => {
    const eng = engine(req);
    if (!eng) return res.status(401).json({ error: 'no auth' });
    res.json({ credits: eng.credits.list() });
  });

  app.post('/api/music/add', json, async (req, res) => {
    const eng = engine(req);
    if (!eng) return res.status(401).json({ error: 'no auth' });
    const user = userFromRequest(req);
    const r = await eng.addSongRequest({
      query: req.body?.query || req.body?.url || '',
      user: { uniqueId: user.username, nickname: user.username },
      priority: req.body?.priority || 0,
      skipCredits: !!req.body?.skipCredits,
      skipCooldown: !!req.body?.skipCooldown,
    });
    res.json(r);
  });

  app.post('/api/music/play', (req, res) => {
    const eng = engine(req);
    if (!eng) return res.status(401).json({ error: 'no auth' });
    eng.play();
    res.json({ ok: true, current: eng.getCurrent() });
  });

  app.post('/api/music/skip', (req, res) => {
    const eng = engine(req);
    if (!eng) return res.status(401).json({ error: 'no auth' });
    eng.skip();
    res.json({ ok: true });
  });

  app.post('/api/music/pause', (req, res) => {
    const eng = engine(req);
    if (!eng) return res.status(401).json({ error: 'no auth' });
    eng.pause();
    res.json({ ok: true });
  });

  app.post('/api/music/resume', (req, res) => {
    const eng = engine(req);
    if (!eng) return res.status(401).json({ error: 'no auth' });
    eng.resume();
    res.json({ ok: true });
  });

  app.post('/api/music/stop', (req, res) => {
    const eng = engine(req);
    if (!eng) return res.status(401).json({ error: 'no auth' });
    eng.stop();
    res.json({ ok: true });
  });

  app.post('/api/music/clear', (req, res) => {
    const eng = engine(req);
    if (!eng) return res.status(401).json({ error: 'no auth' });
    eng.clearQueue();
    res.json({ ok: true });
  });

  app.post('/api/music/credits/add', json, (req, res) => {
    const eng = engine(req);
    if (!eng) return res.status(401).json({ error: 'no auth' });
    const { uniqueId, nickname, amount } = req.body || {};
    const bal = eng.credits.add(uniqueId, nickname, amount);
    eng.emit('creditsUpdated', { credits: eng.credits.list() });
    res.json({ ok: true, balance: bal });
  });

  app.post('/api/music/credits/remove', json, (req, res) => {
    const eng = engine(req);
    if (!eng) return res.status(401).json({ error: 'no auth' });
    const { uniqueId, amount } = req.body || {};
    const r = eng.credits.remove(uniqueId, amount);
    eng.emit('creditsUpdated', { credits: eng.credits.list() });
    res.json(r);
  });

  app.post('/api/music/credits/reset', json, (req, res) => {
    const eng = engine(req);
    if (!eng) return res.status(401).json({ error: 'no auth' });
    eng.credits.resetAll();
    eng.emit('creditsUpdated', { credits: [] });
    res.json({ ok: true });
  });

  app.post('/api/music/queue/remove', json, (req, res) => {
    const eng = engine(req);
    if (!eng) return res.status(401).json({ error: 'no auth' });
    const id = req.body?.id;
    if (id) eng.queue.removeById(id);
    else if (Number.isInteger(req.body?.index)) eng.queue.removeAt(req.body.index);
    eng.emit('queueUpdated', { queue: eng.queue.list() });
    res.json({ ok: true, queue: eng.queue.list() });
  });

  app.post('/api/music/queue/move', json, (req, res) => {
    const eng = engine(req);
    if (!eng) return res.status(401).json({ error: 'no auth' });
    eng.queue.move(Number(req.body?.index) || 0, req.body?.dir === 'down' ? 1 : -1);
    eng.emit('queueUpdated', { queue: eng.queue.list() });
    res.json({ ok: true, queue: eng.queue.list() });
  });

  app.post('/api/music/queue/playnow', json, (req, res) => {
    const eng = engine(req);
    if (!eng) return res.status(401).json({ error: 'no auth' });
    if (req.body?.id) eng.queue.playNow(req.body.id);
    eng.skip();
    res.json({ ok: true });
  });

  app.post('/api/music/player/finished', (req, res) => {
    const eng = engine(req);
    if (!eng) return res.status(401).json({ error: 'no auth' });
    eng.onSongFinished();
    res.json({ ok: true });
  });

  app.post('/api/music/player/progress', json, (req, res) => {
    const eng = engine(req);
    if (!eng) return res.status(401).json({ error: 'no auth' });
    eng.updateProgress(req.body?.progressMs);
    res.json({ ok: true });
  });
}

function expressJson(req, res, next) {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    try { req.body = raw ? JSON.parse(raw) : {}; } catch { req.body = {}; }
    next();
  });
}
