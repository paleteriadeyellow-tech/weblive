// Ejecución LOCAL de acciones Mario Bros, Mari0 y Plants vs Zombies (puerto 7755 en esta PC).
// Usamos 127.0.0.1 (no "localhost") para evitar fallos con IPv6 en Windows.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureMarioBridge, ensureMari0Bridge } from './mario-bridge.js';
import { ensurePvzHybridBridge, findPvzHybridExe, findPvzToolsExe } from './pvz-hybrid-bridge.js';
import { ensurePvzToolkitBridge, PVZ_TOOLKIT_HTTP_PORT } from './pvz-toolkit-bridge.js';
import {
  ensureRepoBridge,
  findRepoExe,
  findRepoGameDir,
  repoSpawn as repoSpawnBridge,
  launchRepoGameFromBridge,
  launchRepoStackFromBridge,
} from './repo-bridge.js';
import { l4dSpawn as l4dSpawnBridge, launchL4dGameFromBridge } from './l4d-bridge.js';
import { unturnedSpawn as unturnedSpawnBridge, launchUnturnedGameFromBridge } from './unturned-bridge.js';
import { ctrWebhook, CTR_SPAWN_MAX } from './ctr-bridge.js';
import { mslugSpawnBridge, launchMslugStackFromBridge } from './mslug-bridge.js';
import { runMslug7760Spawn } from './mslug-spawn-webhook.js';
import { spawnSmbxTiktokFile } from './smbx-tiktok-webhook.js';
import { ensureSmwBridge, smwSpawn as smwSpawnBridge, launchSmwGameFromBridge } from './smw-bridge.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GAME_HOST = '127.0.0.1';
const GAME_PORT = 7755;
const PVZ_HYBRID_HTTP_PORT = Number(process.env.PVZ_HYBRID_HTTP_PORT) || 7757;
/** Máximo de spawns por racha/combo (100 rosas → 100 enemigos). */
export const MARIO_SPAWN_MAX = 999;
export const MARI0_SPAWN_MAX = 200;
export const MARI0_WEBHOOK_PORT = 5722;
export const MARI0_WEBHOOK_BASE = `http://127.0.0.1:${MARI0_WEBHOOK_PORT}`;
/** SMBX2: sin pausa entre spawns de una misma acción (el mod lee la cola al instante). */
const MARIO_SPAWN_GAP_MS = 0;
const SPAWN_GAP_MS = 100;

/** Cola global SMBX2: evita spawns concurrentes. */
let marioSpawnChain = Promise.resolve();
/** Cola global Mari0 (mismo puerto, bridge distinto). */
let mari0SpawnChain = Promise.resolve();
/** Cola global SMB3 Livecoins (FCEUX + smb3-bridge.exe en :7755). */
let smb3SpawnChain = Promise.resolve();
/** Cola global PvZ Hybrid (PvZ Tools + bridge WS :3132 / HTTP :7757). */
let pvzHybridSpawnChain = Promise.resolve();
let pvzToolkitSpawnChain = Promise.resolve();
let repoSpawnChain = Promise.resolve();
let l4dSpawnChain = Promise.resolve();
let unturnedSpawnChain = Promise.resolve();
let ctrSpawnChain = Promise.resolve();
let smwSpawnChain = Promise.resolve();
export const SMB3_SPAWN_MAX = 200;
export const MSLUG_SPAWN_MAX = 50;

export function smb3HealthOk(data) {
  if (!data || !data.ok) return false;
  return data.bridge === 'smb3-livecoins' || data.game === 'smb3';
}

async function gameFetch(path, opts = {}) {
  const ctrl = new AbortController();
  const timeoutMs = Math.max(2000, Number(opts.timeoutMs) || 4000);
  const to = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const port = opts.port != null ? opts.port : GAME_PORT;
    const url = `http://${GAME_HOST}:${port}${path}`;
    const init = { method: opts.method || 'GET', signal: ctrl.signal };
    if (opts.body) {
      init.body = opts.body;
      init.headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    }
    const r = await fetch(url, init);
    clearTimeout(to);
    let data = {};
    try { data = await r.json(); } catch { /* ignore */ }
    return {
      ok: r.ok && data.ok !== false,
      status: r.status,
      mari0Connected: data.mari0Connected,
      error: data.error,
      data,
    };
  } catch (e) {
    clearTimeout(to);
    return { ok: false, error: e && e.message ? e.message : 'sin_conexion' };
  }
}

function useMari0ByDefault() {
  if (process.env.MARIO_GAME_MODE === 'smbx') return false;
  if (process.env.MARIO_GAME_MODE === 'mari0') return true;
  return !!mari0ExePath();
}

export async function marioSpawn(thingOrNpcId, name, times = 1) {
  const thing = thingOrNpcId != null && thingOrNpcId !== '' ? thingOrNpcId : null;
  if (thing == null) return { ok: false, error: 'sin_thing' };
  const t = Math.min(MARIO_SPAWN_MAX, Math.max(1, Number(times) || 1));
  const run = async () => {
    const bridgeOk = await ensureMarioBridge();
    if (!bridgeOk) {
      return { ok: false, error: 'bridge_mario_no_disponible' };
    }
    let last = { ok: false };
    for (let i = 0; i < t; i++) {
      last = await gameFetch('/spawn', {
        method: 'POST',
        body: JSON.stringify({ thing, name: String(name || '') }),
      });
      if (last.ok) {
        const npcId = last.data?.npcId ?? (Number.isFinite(Number(thing)) ? Number(thing) : null);
        if (npcId != null) {
          spawnSmbxTiktokFile(npcId, name, 1).catch(() => {});
        }
      }
      if (i < t - 1 && MARIO_SPAWN_GAP_MS > 0) await new Promise((r) => setTimeout(r, MARIO_SPAWN_GAP_MS));
    }
    return last;
  };
  const job = marioSpawnChain.then(run, run);
  marioSpawnChain = job.catch(() => {});
  return job;
}

export async function smb3Health() {
  return gameFetch('/health', { timeoutMs: 2500 });
}

export async function smb3Spawn({ thing, spawnId, npcId, name, times = 1 } = {}) {
  const t = Math.min(SMB3_SPAWN_MAX, Math.max(1, Number(times) || 1));
  const body = { name: String(name || ''), times: 1 };
  if (spawnId != null && spawnId !== '') body.spawnId = Number(spawnId);
  else if (npcId != null && npcId !== '') body.npcId = Number(npcId);
  else if (thing != null && thing !== '') body.thing = String(thing);
  else return { ok: false, error: 'sin_thing' };

  const run = async () => {
    const health = await smb3Health();
    if (!smb3HealthOk(health.data)) {
      return { ok: false, error: 'bridge_smb3_no_disponible', data: health.data };
    }
    let last = { ok: false };
    for (let i = 0; i < t; i++) {
      last = await gameFetch('/spawn', {
        method: 'POST',
        body: JSON.stringify(body),
        timeoutMs: 8000,
      });
      if (last.data?.handled === false) {
        return { ok: false, error: 'no_handled', data: last.data };
      }
      if (i < t - 1) await new Promise((r) => setTimeout(r, SPAWN_GAP_MS));
    }
    return last;
  };
  const job = smb3SpawnChain.then(run, run);
  smb3SpawnChain = job.catch(() => {});
  return job;
}

export async function smb3Effect(effect, name, seconds = 5) {
  const eff = String(effect || '').toLowerCase();
  if (eff !== 'giant' && eff !== 'tiny') return { ok: false, error: 'effect_invalido' };
  const health = await smb3Health();
  if (!smb3HealthOk(health.data)) {
    return { ok: false, error: 'bridge_smb3_no_disponible', data: health.data };
  }
  return gameFetch('/effect', {
    method: 'POST',
    body: JSON.stringify({
      effect: eff,
      name: String(name || ''),
      seconds: Math.min(60, Math.max(1, Number(seconds) || 5)),
    }),
    timeoutMs: 6000,
  });
}

export function buildMari0SpawnUrl(thing, name) {
  const u = new URL(`${MARI0_WEBHOOK_BASE}/spawn`);
  u.searchParams.set('thing', String(thing || '').trim());
  u.searchParams.set('name', String(name || 'Viewer').trim() || 'Viewer');
  return u.href;
}

export async function mari0Spawn(thing, name, times = 1) {
  const t = Math.min(MARI0_SPAWN_MAX, Math.max(1, Number(times) || 1));
  const run = async () => {
    let last = { ok: false };
    for (let i = 0; i < t; i++) {
      try {
        const url = buildMari0SpawnUrl(thing, name);
        const ctrl = new AbortController();
        const to = setTimeout(() => ctrl.abort(), 5000);
        const r = await fetch(url, { method: 'GET', signal: ctrl.signal, cache: 'no-store' });
        clearTimeout(to);
        last = { ok: r.ok, status: r.status, url };
        if (i < t - 1) await new Promise((res) => setTimeout(res, 80));
      } catch (e) {
        last = { ok: false, error: e && e.message ? e.message : 'sin_conexion' };
      }
    }
    return last;
  };
  const job = mari0SpawnChain.then(run, run);
  mari0SpawnChain = job.catch(() => {});
  return job;
}

export function buildMari0EffectUrl(code, name, seconds) {
  const u = new URL(`${MARI0_WEBHOOK_BASE}/effect`);
  u.searchParams.set('code', String(code || '').trim());
  u.searchParams.set('name', String(name || 'Viewer').trim() || 'Viewer');
  const sec = parseInt(seconds, 10);
  if (Number.isFinite(sec) && sec > 0) u.searchParams.set('seconds', String(sec));
  return u.href;
}

export async function mari0Effect(type, seconds, factor, name = '') {
  if (!type) return { ok: false, error: 'sin_type' };
  try {
    const url = buildMari0EffectUrl(type, name, seconds);
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 5000);
    const r = await fetch(url, { method: 'GET', signal: ctrl.signal, cache: 'no-store' });
    clearTimeout(to);
    return { ok: r.ok, status: r.status, url };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : 'sin_conexion' };
  }
}

function mari0ExePath() {
  try {
    const cfg = path.join(process.env.LOCALAPPDATA || '', 'LivecoinsMari0', 'mari0_exe.txt');
    if (fs.existsSync(cfg)) {
      const p = fs.readFileSync(cfg, 'utf8').trim();
      if (p) return p;
    }
  } catch { /* ignore */ }
  if (process.env.DESKTOP_RESOURCES) {
    const bundled = path.join(process.env.DESKTOP_RESOURCES, 'mari0-game', 'mari0.exe');
    if (fs.existsSync(bundled)) return bundled;
  }
  const dev = path.join(__dirname, 'desktop', 'mari0-game', 'mari0.exe');
  if (fs.existsSync(dev)) return dev;
  return '';
}

export async function launchMari0Game() {
  const bridgeOk = await ensureMari0Bridge();
  if (!bridgeOk) return { ok: false, error: 'bridge_no_disponible' };
  const exe = mari0ExePath();
  if (!exe || !fs.existsSync(exe)) return { ok: false, error: 'no_instalado' };
  try {
    const child = spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: false });
    child.unref();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : 'spawn_fallo' };
  }
}

export async function marioEffect(type, seconds, factor) {
  if (!type) return { ok: false, error: 'sin_type' };
  const bridgeOk = await ensureMarioBridge();
  if (!bridgeOk) return { ok: false, error: 'bridge_mario_no_disponible' };
  return gameFetch('/effect', {
    method: 'POST',
    body: JSON.stringify({
      type,
      seconds: Math.min(60, Math.max(1, Number(seconds) || 5)),
      factor: Math.min(10, Math.max(0, Number(factor) || 0)),
    }),
  });
}

export async function pvzSpawn(thing, name, times = 1) {
  if (!thing) return { ok: false, error: 'sin_thing' };
  const t = Math.min(20, Math.max(1, Number(times) || 1));
  const parts = [
    `thing=${encodeURIComponent(thing)}`,
    `name=${encodeURIComponent(String(name || ''))}`,
  ];
  const q = parts.join('&');
  const run = async () => {
    let last = { ok: false };
    for (let i = 0; i < t; i++) {
      last = await pvzToolkitFetch(`/spawn?${q}`);
      if (i < t - 1) await new Promise((r) => setTimeout(r, 50));
    }
    return last;
  };
  const job = pvzToolkitSpawnChain.then(run, run);
  pvzToolkitSpawnChain = job.catch(() => {});
  return job;
}

export async function pvzSun(amount) {
  const n = Math.min(9990, Math.max(1, Number(amount) || 50));
  return pvzToolkitFetch(`/sun?amount=${n}`);
}

export async function pvzCmd(cmdPath) {
  const p = String(cmdPath || '');
  if (!p.startsWith('/')) return { ok: false, error: 'path_invalido' };
  return pvzToolkitFetch(p);
}

async function pvzToolkitFetch(path, opts = {}) {
  const bridgeOk = await ensurePvzToolkitBridge();
  if (!bridgeOk) return { ok: false, error: 'bridge_pvz_toolkit_no_disponible' };
  return gameFetch(path, { ...opts, port: PVZ_TOOLKIT_HTTP_PORT });
}

async function pvzHybridFetch(path, opts = {}) {
  const bridgeOk = await ensurePvzHybridBridge();
  if (!bridgeOk) return { ok: false, error: 'bridge_pvz_hybrid_no_disponible' };
  return gameFetch(path, { ...opts, port: PVZ_HYBRID_HTTP_PORT });
}

export async function pvzHybridSpawn(thing, name, times = 1, label = '') {
  if (!thing) return { ok: false, error: 'sin_thing' };
  const t = Math.min(999, Math.max(1, Number(times) || 1));
  const parts = [
    `thing=${encodeURIComponent(thing)}`,
    `name=${encodeURIComponent(String(name || ''))}`,
  ];
  if (label) parts.push(`label=${encodeURIComponent(String(label))}`);
  const q = parts.join('&');
  const run = async () => {
    let last = { ok: false };
    for (let i = 0; i < t; i++) {
      last = await pvzHybridFetch(`/spawn?${q}`);
      if (i < t - 1) await new Promise((r) => setTimeout(r, 150));
    }
    return last;
  };
  const job = pvzHybridSpawnChain.then(run, run);
  pvzHybridSpawnChain = job.catch(() => {});
  return job;
}

export async function pvzHybridSun(amount, name = '', label = '') {
  const n = Math.min(9990, Math.max(1, Number(amount) || 50));
  const parts = [`amount=${n}`];
  if (name) parts.push(`name=${encodeURIComponent(String(name))}`);
  if (label) parts.push(`label=${encodeURIComponent(String(label))}`);
  else if (name) parts.push(`label=${encodeURIComponent(`+${n} soles`)}`);
  return pvzHybridFetch(`/sun?${parts.join('&')}`);
}

export async function pvzHybridCmd(cmdPath, name = '', label = '') {
  const p = String(cmdPath || '');
  if (!p.startsWith('/')) return { ok: false, error: 'path_invalido' };
  const q = [];
  if (name) q.push(`name=${encodeURIComponent(String(name))}`);
  if (label) q.push(`label=${encodeURIComponent(String(label))}`);
  const suffix = q.length ? `?${q.join('&')}` : '';
  return pvzHybridFetch(`${p}${suffix}`);
}

export async function launchPvzHybridGame() {
  const bridgeOk = await ensurePvzHybridBridge();
  if (!bridgeOk) return { ok: false, error: 'bridge_no_disponible' };
  const exe = findPvzHybridExe();
  if (!exe) return { ok: false, error: 'no_instalado' };
  try {
    const child = spawn(exe, [], { cwd: path.dirname(exe), detached: true, stdio: 'ignore', windowsHide: false });
    child.unref();
    return { ok: true, exe };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : 'spawn_fallo' };
  }
}


export function resolveRepoSpawnKey(thing) {
  return String(thing || '').trim();
}

export async function repoSpawn(thing, name, times = 1, params = {}) {
  if (!thing) return { ok: false, error: 'sin_thing' };
  const spawnKey = resolveRepoSpawnKey(thing);
  const t = Math.min(50, Math.max(1, Number(times) || 1));
  const job = repoSpawnChain.then(async () => {
    let last = { ok: false };
    for (let i = 0; i < t; i += 1) {
      last = await repoSpawnBridge(spawnKey, name, 1, params);
      if (i < t - 1) await new Promise((r) => setTimeout(r, SPAWN_GAP_MS));
    }
    return last;
  }, async () => {
    let last = { ok: false };
    for (let i = 0; i < t; i += 1) {
      last = await repoSpawnBridge(spawnKey, name, 1, params);
      if (i < t - 1) await new Promise((r) => setTimeout(r, SPAWN_GAP_MS));
    }
    return last;
  });
  repoSpawnChain = job.catch(() => {});
  return job;
}

export async function launchRepoGame() {
  return launchRepoGameFromBridge();
}

export async function launchRepoStack() {
  return launchRepoStackFromBridge();
}

export async function launchL4dGame() {
  return launchL4dGameFromBridge();
}

export async function l4dSpawn(thing, name, times = 1, params = {}) {
  if (!thing) return { ok: false, error: 'sin_thing' };
  const t = Math.min(20, Math.max(1, Number(times) || 1));
  const p = params && typeof params === 'object' ? params : {};
  const job = l4dSpawnChain.then(async () => {
    let last = { ok: false };
    for (let i = 0; i < t; i += 1) {
      last = await l4dSpawnBridge(thing, name, 1, p);
      if (!last.ok) break;
      if (i < t - 1) await new Promise((r) => setTimeout(r, SPAWN_GAP_MS));
    }
    return last;
  }, async () => {
    let last = { ok: false };
    for (let i = 0; i < t; i += 1) {
      last = await l4dSpawnBridge(thing, name, 1, p);
      if (!last.ok) break;
      if (i < t - 1) await new Promise((r) => setTimeout(r, SPAWN_GAP_MS));
    }
    return last;
  });
  l4dSpawnChain = job.catch(() => {});
  return job;
}

export async function launchUnturnedGame() {
  return launchUnturnedGameFromBridge();
}

export async function unturnedSpawn(thing, name, times = 1, params = {}) {
  if (!thing) return { ok: false, error: 'sin_thing' };
  const t = Math.min(20, Math.max(1, Number(times) || 1));
  const p = params && typeof params === 'object' ? params : {};
  const job = unturnedSpawnChain.then(async () => {
    let last = { ok: false };
    for (let i = 0; i < t; i += 1) {
      last = await unturnedSpawnBridge(thing, name, 1, p);
      if (!last.ok) break;
      if (i < t - 1) await new Promise((r) => setTimeout(r, SPAWN_GAP_MS));
    }
    return last;
  }, async () => {
    let last = { ok: false };
    for (let i = 0; i < t; i += 1) {
      last = await unturnedSpawnBridge(thing, name, 1, p);
      if (!last.ok) break;
      if (i < t - 1) await new Promise((r) => setTimeout(r, SPAWN_GAP_MS));
    }
    return last;
  });
  unturnedSpawnChain = job.catch(() => {});
  return job;
}

/** GTA V KOTH: en weblive/Render no hay bridge; el .exe ejecuta vía emitLocalExec. */
export async function gtavKothSpawn() {
  return { ok: false, error: 'solo_escritorio' };
}
export async function gtavChaosSpawn() {
  return { ok: false, error: 'solo_escritorio' };
}

export async function ctrSpawn(thing, name, times = 1) {
  if (!thing) return { ok: false, error: 'sin_thing' };
  const t = Math.min(CTR_SPAWN_MAX, Math.max(1, Number(times) || 1));
  const job = ctrSpawnChain.then(async () => {
    let last = { ok: false };
    for (let i = 0; i < t; i += 1) {
      last = await ctrWebhook(thing);
      if (!last.ok) break;
      if (i < t - 1) await new Promise((r) => setTimeout(r, 200));
    }
    if (!last.ok) return last;
    return { ok: true, sent: t, event: last.event, last };
  });
  ctrSpawnChain = job.catch(() => {});
  return job;
}

export async function smwSpawn(thing, name, times = 1) {
  // ensureSmwBridge corre dentro de smwSpawnBridge (diagnose:false → Probar sin ~5s de PowerShell).
  const t = Math.min(40, Math.max(1, Number(times) || 1));
  const job = smwSpawnChain.then(async () => smwSpawnBridge(thing, name, t));
  smwSpawnChain = job.catch(() => {});
  return job;
}

export async function launchSmwGame() {
  return launchSmwGameFromBridge();
}

export async function mslugSpawn(thing, name, times = 1) {
  const t = Math.max(1, Math.min(MSLUG_SPAWN_MAX, parseInt(times, 10) || 1));
  const via = await runMslug7760Spawn(thing, name, t);
  if (via && via.ok !== false) return via;
  return mslugSpawnBridge(thing, name, t);
}

export async function launchMslugStack() {
  return launchMslugStackFromBridge();
}

export async function launchPvzTools() {
  const bridgeOk = await ensurePvzHybridBridge();
  if (!bridgeOk) return { ok: false, error: 'bridge_no_disponible' };
  const exe = findPvzToolsExe();
  if (!exe) return { ok: false, error: 'sin_tools' };
  try {
    const child = spawn(exe, [], { cwd: path.dirname(exe), detached: true, stdio: 'ignore', windowsHide: false });
    child.unref();
    return { ok: true, exe };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : 'spawn_fallo' };
  }
}

/** PvZ 1 clásico: bridge :7756 + PvZ.Tools en :3132 (no usar bridge Hybrid :7757). */
export async function launchPvzToolsClassic() {
  const bridgeOk = await ensurePvzToolkitBridge();
  if (!bridgeOk) return { ok: false, error: 'bridge_pvz_toolkit_no_disponible' };
  const exe = findPvzToolsExe();
  if (!exe) return { ok: false, error: 'sin_tools' };
  try {
    const child = spawn(exe, [], { cwd: path.dirname(exe), detached: true, stdio: 'ignore', windowsHide: false });
    child.unref();
    return { ok: true, exe };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : 'spawn_fallo' };
  }
}

export async function runGameExec(exec) {
  if (!exec || !exec.tipo) return { ok: false, error: 'sin_tipo' };
  switch (exec.tipo) {
    case 'MARIO_SPAWN':
      return marioSpawn(exec.thing ?? exec.npcId, exec.name, exec.times);
    case 'MARIO_EFFECT':
      return marioEffect(exec.type, exec.seconds, exec.factor);
    case 'MARI0_SPAWN':
      return mari0Spawn(exec.thing, exec.name, exec.times);
    case 'MARI0_EFFECT':
      return mari0Effect(exec.type, exec.seconds, exec.factor, exec.name);
    case 'SMB3_SPAWN':
      return smb3Spawn({
        thing: exec.thing,
        spawnId: exec.spawnId ?? exec.spawn,
        npcId: exec.npcId,
        name: exec.name ?? exec.viewer ?? exec.nickname,
        times: exec.times ?? exec.count,
      });
    case 'SMB3_EFFECT':
      return smb3Effect(exec.effect ?? exec.type, exec.name ?? exec.viewer, exec.seconds);
    case 'PVZ_SPAWN':
      return pvzSpawn(exec.thing, exec.name, exec.times);
    case 'PVZ_SUN':
      return pvzSun(exec.amount);
    case 'PVZ_CMD':
      return pvzCmd(exec.path);
    case 'PVZ_HYBRID_SPAWN':
      return pvzHybridSpawn(exec.thing, exec.name, exec.times, exec.label);
    case 'PVZ_HYBRID_SUN':
      return pvzHybridSun(exec.amount, exec.name, exec.label);
    case 'PVZ_HYBRID_CMD':
      return pvzHybridCmd(exec.path, exec.name, exec.label);
    case 'REPO_SPAWN':
      return repoSpawn(exec.thing, exec.name, exec.times, exec.params || {});
    case 'L4D_SPAWN':
      return l4dSpawnBridge(exec.thing, exec.name, exec.times, exec.params || {});
    case 'GTAVKOTH_SPAWN':
      return gtavKothSpawn(exec.thing, exec.name, exec.times, exec.params || {});
    case 'GTAVCHAOS_SPAWN':
      return gtavChaosSpawn(exec.thing, exec.name, exec.times, exec.params || {});
    case 'UNTURNED_SPAWN':
      return unturnedSpawnBridge(exec.thing, exec.name, exec.times, exec.params || {});
    case 'CTR_SPAWN':
      return ctrSpawn(exec.thing, exec.name, exec.times);
    case 'MSLUG_SPAWN':
      return mslugSpawn(exec.thing, exec.name, exec.times);
    case 'SMW_SPAWN':
      return smwSpawn(exec.thing, exec.name, exec.times);
    default:
      return { ok: false, error: 'tipo_desconocido' };
  }
}
