/** Generación de pánico para colas RCON de Minecraft (cancelación cooperativa). */

let mcPanicGen = 0;

export function bumpMcPanic() {
  mcPanicGen = (mcPanicGen + 1) % 0x7fffffff;
  return mcPanicGen;
}

export function mcRunToken() {
  return mcPanicGen;
}

export function mcCancelled(token) {
  return token !== mcPanicGen;
}

export async function mcWait(ms, token) {
  if (mcCancelled(token)) return false;
  const n = Math.max(0, Number(ms) || 0);
  if (!n) return true;
  const step = 50;
  let left = n;
  while (left > 0) {
    if (mcCancelled(token)) return false;
    const chunk = Math.min(step, left);
    await new Promise((r) => setTimeout(r, chunk));
    left -= chunk;
  }
  return !mcCancelled(token);
}

/** Lista de spawns: atMs = ms desde el inicio de la cadena; todos los comandos en paralelo. */
export function buildMcSpawnJobs(steps) {
  const jobs = [];
  for (const step of steps) {
    const delayBefore = Math.max(0, Number(step.delayBefore) || 0);
    const rep = Math.max(1, Number(step.repeat) || 1);
    const delayEach = Math.max(0, Number(step.delayEach) || 0);
    const cmd = typeof step === 'string' ? step : step.cmd;
    if (!cmd) continue;
    for (let r = 0; r < rep; r++) {
      jobs.push({ atMs: delayBefore + r * delayEach, cmd });
    }
  }
  return jobs;
}

async function waitUntilSpawn(atMs, chainStart, token) {
  if (mcCancelled(token)) return false;
  const waitMs = atMs - (Date.now() - chainStart);
  if (waitMs > 0) return mcWait(waitMs, token);
  return !mcCancelled(token);
}

/** Cola plana de comandos con delay opcional entre cada uno. */
export async function executeMcRconQueue(queue, sendOne, opts = {}) {
  const token = opts.token ?? mcRunToken();
  const delayEach = Math.max(0, Number(opts.delayEach) || 0);
  let sent = 0;
  for (const c of queue) {
    if (mcCancelled(token)) return { ok: false, cancelled: true, sent };
    const res = await sendOne(c);
    sent++;
    if (!res.ok) return { ok: false, cancelled: false, sent, error: res.error, lastCmd: c };
    if (delayEach > 0 && !(await mcWait(delayEach, token))) return { ok: false, cancelled: true, sent };
  }
  return { ok: true, sent };
}

/**
 * Plan Extra: todos los comandos se programan desde t=0.
 * Retraso (ms) = cuándo sale cada spawn desde el inicio; Intervalo = pausa entre repeticiones del mismo comando.
 * El reloj no espera a que un send lento (p. ej. title) acabe: un summon a 100 ms
 * no se retrasa al intervalo 2000 ms de otra línea. times (combo) se fusiona en
 * el mismo timeline para no esperar la tanda anterior.
 * Los envíos van en serie (1 RCON a la vez, en orden de reloj) para no pelearse por el socket.
 */
export async function executeMcRconPlan(plan, sendOne, token) {
  const tok = token ?? mcRunToken();
  const delayGroup = Math.max(0, Number(plan.delayGroup) || 0);
  if (!(await mcWait(delayGroup, tok))) return { ok: false, cancelled: true, sent: 0 };

  let steps = Array.isArray(plan.steps) ? plan.steps : [];
  if (plan.random && steps.length) steps = [steps[Math.floor(Math.random() * steps.length)]];
  const times = Math.min(Math.max(1, Number(plan.times) || 1), 200);

  const jobs = [];
  for (let t = 0; t < times; t++) {
    const wave = buildMcSpawnJobs(steps);
    if (wave.length > 600) wave.length = 600;
    jobs.push(...wave);
  }
  if (!jobs.length) return { ok: true, sent: 0 };
  jobs.sort((a, b) => a.atMs - b.atMs);
  if (jobs.length > 3000) jobs.length = 3000;

  const chainStart = Date.now();
  let sendTail = Promise.resolve();
  const outcomes = [];

  const enqueueSend = (cmd) => {
    const p = sendTail.then(async () => {
      if (mcCancelled(tok)) return { cancelled: true };
      try {
        const res = await sendOne(cmd);
        return { cancelled: false, res, cmd };
      } catch (e) {
        return { cancelled: false, res: { ok: false, error: e && e.message ? e.message : String(e) }, cmd };
      }
    });
    sendTail = p.then(() => undefined, () => undefined);
    outcomes.push(p);
  };

  let stopped = false;
  for (const job of jobs) {
    if (!(await waitUntilSpawn(job.atMs, chainStart, tok))) {
      stopped = true;
      break;
    }
    enqueueSend(job.cmd);
  }

  const results = await Promise.all(outcomes);
  let sent = 0;
  let firstErr = null;
  let cancelled = stopped || mcCancelled(tok);
  for (const o of results) {
    if (!o) continue;
    if (o.cancelled) {
      cancelled = true;
      continue;
    }
    if (!o.res) continue;
    sent++;
    if (!o.res.ok && !firstErr) firstErr = o;
  }
  if (cancelled) return { ok: false, cancelled: true, sent };
  if (firstErr) return { ok: false, cancelled: false, sent, error: firstErr.res.error, lastCmd: firstErr.cmd };
  return { ok: true, sent };
}

export function readGameActionCountTiming(a) {
  return {
    count: Math.max(1, parseInt(a?.count, 10) || 1),
    delayBefore: Math.max(0, parseInt(a?.delayBefore ?? a?.delayGroup, 10) || 0),
    delayEach: Math.max(0, parseInt(a?.delayEach, 10) || 100),
  };
}

export async function runGameActionCountTimedRepeats(a, fn) {
  const { count, delayBefore, delayEach } = readGameActionCountTiming(a);
  if (delayBefore) await mcWait(delayBefore);
  for (let i = 0; i < count; i++) {
    await fn(i);
    if (i < count - 1 && delayEach) await mcWait(delayEach);
  }
}

export function fireGameActionCountTimed(a, fn) {
  runGameActionCountTimedRepeats(a, fn).catch(() => {});
}

export function readGameActionTiming(a) {
  return {
    repeat: Math.max(1, parseInt(a?.repeat, 10) || 1),
    delayBefore: Math.max(0, parseInt(a?.delayBefore ?? a?.delayGroup, 10) || 0),
    delayEach: Math.max(0, parseInt(a?.delayEach, 10) || 100),
  };
}

export async function runGameActionTimedRepeats(a, fn) {
  const { repeat, delayBefore, delayEach } = readGameActionTiming(a);
  if (delayBefore) await mcWait(delayBefore);
  for (let i = 0; i < repeat; i++) {
    await fn(i);
    if (i < repeat - 1 && delayEach) await mcWait(delayEach);
  }
}

export function fireGameActionTimed(a, fn) {
  runGameActionTimedRepeats(a, fn).catch(() => {});
}
