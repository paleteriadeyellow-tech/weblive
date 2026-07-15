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



async function runSpawnJob(job, chainStart, sendOne, token) {

  if (!(await waitUntilSpawn(job.atMs, chainStart, token))) {

    return { cancelled: true };

  }

  const res = await sendOne(job.cmd);

  return { cancelled: false, res, cmd: job.cmd };

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

 */

export async function executeMcRconPlan(plan, sendOne, token) {

  const tok = token ?? mcRunToken();

  const delayGroup = Math.max(0, Number(plan.delayGroup) || 0);

  if (!(await mcWait(delayGroup, tok))) return { ok: false, cancelled: true, sent: 0 };



  let steps = Array.isArray(plan.steps) ? plan.steps : [];

  if (plan.random && steps.length) steps = [steps[Math.floor(Math.random() * steps.length)]];

  const times = Math.min(Math.max(1, Number(plan.times) || 1), 200);



  let sent = 0;

  for (let t = 0; t < times; t++) {

    if (mcCancelled(tok)) return { ok: false, cancelled: true, sent };

    const jobs = buildMcSpawnJobs(steps);

    if (!jobs.length) continue;

    if (jobs.length > 600) jobs.length = 600;



    const chainStart = Date.now();

    const outcomes = await Promise.all(jobs.map((job) => runSpawnJob(job, chainStart, sendOne, tok)));



    for (const o of outcomes) {

      if (o.cancelled) return { ok: false, cancelled: true, sent };

      if (!o.res) continue;

      sent++;

      if (!o.res.ok) return { ok: false, cancelled: false, sent, error: o.res.error, lastCmd: o.cmd };

    }

  }

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
