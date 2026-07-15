/**
 * Livecoins ↔ Metal Slug SB Fanthology (mod Interactive).
 * Lee el juego: bridge/spawn_cmd.txt (borra spawn_cmd.txt en raíz, no el de bridge).
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureMslugSpawnWebhook } from './mslug-spawn-webhook.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = path.join(process.env.LOCALAPPDATA || '', 'LivecoinsMslug');
const GAME_DIR_FILE = path.join(CONFIG_DIR, 'game_dir.txt');
const EXE_NAME = 'Metal Slug.exe';
const EXE_INTERACTIVO = 'PLAY.exe';
const HOOK_DLL = 'window_command_hook.dll';
const SPAWN_FILE = 'bridge/spawn_cmd.txt';
/** El juego intenta borrar spawn_cmd.txt en raíz; limpiarlo evita spawns fantasma. */
const SPAWN_FILE_ROOT = 'spawn_cmd.txt';
const SPAWN_LOG = 'bridge/livecoins_last_spawn.json';
export const MSLUG_BRIDGE_VERSION = '2026-07-02j';
/** Ruta canónica embebida en data.win (capturas / spawn). */
export const MSLUG_CANONICAL_DIR = 'C:\\Games\\MSlugFanthology';
const MARKERS = ['interactive_metalSlug.json', 'livecoins_metalSlug.json'];
export const MSLUG_SPAWN_MAX = 50;
export const MSLUG_DAEMON_PORT = 7760;

export const MSLUG_COMBOS = {
  combo_armas: ['H', 'L', 'R', 'F', 'S', 'C', 'D', 'G', 'B', '2H', 'granada', 'firebomb'],
  miniufo_oleada: ['miniufo', 'miniufo_baja'],
  marcianos: ['ufo', 'mutante', 'miniufo'],
};

/** Entre ítems de combo (armas, marcianos…). */
const MSLUG_COMBO_GAP_MS = 40;
/**
 * El juego usa spawn_lock: si escribes demasiado rápido solo procesa el primero.
 * ~300 ms entre pulsos es lo mínimo fiable (5 spawns ≈ 1,5 s).
 */
const MSLUG_BURST_GAP_MS = 300;
/** Tras borrar bridge/spawn_cmd antes de recrearlo. */
const MSLUG_PULSE_SETTLE_MS = 70;
/** Pausa al final de cada acción para que suelte spawn_lock antes del siguiente Probar. */
const MSLUG_LOCK_GAP_MS = 280;
let mslugPumpChain = Promise.resolve();
let mslugCmdSeq = 0;
let dataWinSpawnCached = null;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function normDir(dir) {
  try {
    return path.resolve(String(dir || '').trim());
  } catch {
    return String(dir || '').trim();
  }
}

function sanitizeNick(name) {
  const s = String(name || 'Viewer').replace(/\|/g, '').trim();
  return s || 'Viewer';
}

export function resolveMslugSpawnKey(thing) {
  const key = String(thing || '').trim();
  if (!key) return '';
  if (MSLUG_COMBOS[key]) return key;
  return key;
}

export function expandMslugSpawnKeys(thing) {
  const key = resolveMslugSpawnKey(thing);
  return MSLUG_COMBOS[key] || [key];
}

export function getMslugGameDirConfig() {
  try {
    if (fs.existsSync(GAME_DIR_FILE)) {
      const p = fs.readFileSync(GAME_DIR_FILE, 'utf8').trim();
      if (p) return p;
    }
  } catch { /* ignore */ }
  return '';
}

function mslugExeInDir(dir) {
  if (!dir) return null;
  const play = path.join(dir, EXE_INTERACTIVO);
  if (fs.existsSync(play)) return play;
  const fan = path.join(dir, EXE_NAME);
  if (fs.existsSync(fan)) return fan;
  return null;
}

export function isMslugInteractivoDir(gameDir) {
  const dir = normDir(gameDir);
  return !!(dir && fs.existsSync(path.join(dir, EXE_INTERACTIVO)));
}

export function setMslugGameDir(dir) {
  const p = normDir(dir);
  if (!p) throw new Error('Ruta vacia');
  if (!fs.existsSync(p)) throw new Error('La carpeta no existe');
  if (!mslugExeInDir(p)) {
    throw new Error(`No parece Metal Slug (falta ${EXE_NAME} o ${EXE_INTERACTIVO})`);
  }
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(GAME_DIR_FILE, p, 'utf8');
  return p;
}

export function mslugGameDirPaths() {
  const out = [];
  if (process.env.MSLUG_GAME_DIR) out.push(process.env.MSLUG_GAME_DIR);
  const saved = getMslugGameDirConfig();
  if (saved) out.push(saved);
  out.push('C:\\Games\\MSlugFanthology');
  out.push(path.join(process.env.USERPROFILE || '', 'Downloads', 'jesus', 'Metal Slug'));
  return [...new Set(out.filter(Boolean))];
}

export function findMslugExe(gameDir) {
  const dir = gameDir || findMslugGameDir();
  if (!dir) return null;
  return mslugExeInDir(dir);
}

export function findMslugGameDir() {
  for (const dir of mslugGameDirPaths()) {
    try {
      if (!dir || !fs.existsSync(dir)) continue;
      if (mslugExeInDir(dir)) return normDir(dir);
    } catch { /* ignore */ }
  }
  return null;
}

function hasMarker(gameDir) {
  return MARKERS.some((m) => fs.existsSync(path.join(gameDir, m)));
}

function dataWinHasSpawnCmd(gameDir) {
  if (dataWinSpawnCached && dataWinSpawnCached.dir === gameDir) {
    return dataWinSpawnCached.ok;
  }
  let ok = false;
  try {
    const p = path.join(gameDir, 'data.win');
    if (fs.existsSync(p)) {
      const buf = fs.readFileSync(p);
      ok = buf.includes(Buffer.from('bridge/spawn_cmd.txt', 'ascii'));
    }
  } catch { /* ignore */ }
  dataWinSpawnCached = { dir: gameDir, ok };
  return ok;
}

export function isMslugModInstalled(gameDir) {
  const dir = normDir(gameDir || findMslugGameDir());
  if (!dir) return false;
  if (!mslugExeInDir(dir)) return false;
  if (isMslugInteractivoDir(dir)) {
    return fs.existsSync(path.join(dir, HOOK_DLL)) && dataWinHasSpawnCmd(dir);
  }
  if (!fs.existsSync(path.join(dir, HOOK_DLL))) return false;
  if (!fs.existsSync(path.join(dir, 'bridge'))) return false;
  return hasMarker(dir) || dataWinHasSpawnCmd(dir);
}

export function mslugBridgeStatus() {
  const gameDir = findMslugGameDir();
  return {
    gameDir,
    modInstalled: !!(gameDir && isMslugModInstalled(gameDir)),
    exe: gameDir ? findMslugExe(gameDir) : null,
  };
}

export async function mslugBridgeHealth() {
  const gameDir = findMslugGameDir();
  if (!gameDir) {
    return { ok: false, error: 'no_instalado', game_dir: null, mod_installed: false };
  }
  if (!fs.existsSync(path.join(gameDir, HOOK_DLL))) {
    return { ok: false, error: 'sin_hook', game_dir: gameDir, mod_installed: false };
  }
  const modInstalled = isMslugModInstalled(gameDir);
  if (!modInstalled) {
    return { ok: false, error: 'mod_no_instalado', game_dir: gameDir, mod_installed: false };
  }
  return {
    ok: true,
    game_dir: gameDir,
    mod_installed: true,
    spawn_ready: dataWinHasSpawnCmd(gameDir),
    bridge_version: MSLUG_BRIDGE_VERSION,
    last_spawn: getMslugLastSpawn(gameDir),
  };
}

export function ensureMslugBridge() {
  const st = mslugBridgeStatus();
  return !!(st.gameDir && st.modInstalled);
}

export function resolveMslugSpawnGameDirs(gameDir) {
  const dirs = [];
  const primary = normDir(gameDir || findMslugGameDir());
  if (primary) dirs.push(primary);
  try {
    const canon = path.resolve(MSLUG_CANONICAL_DIR);
    if (canon !== primary && fs.existsSync(path.join(canon, EXE_NAME))) dirs.push(canon);
  } catch { /* ignore */ }
  return [...new Set(dirs)];
}

function allMslugSpawnFilePaths(gameDir) {
  const out = [];
  for (const dir of resolveMslugSpawnGameDirs(gameDir)) {
    out.push(path.join(dir, SPAWN_FILE));
    out.push(path.join(dir, SPAWN_FILE_ROOT));
  }
  return out;
}

function spawnFilePath(gameDir) {
  return path.join(gameDir, SPAWN_FILE);
}

function spawnRootFilePath(gameDir) {
  return path.join(gameDir, SPAWN_FILE_ROOT);
}

function makeCmdId() {
  return `lc_${Date.now()}_${++mslugCmdSeq}_${Math.random().toString(36).slice(2, 8)}`;
}

function uniqueViewerNick(name, cmdId) {
  const base = sanitizeNick(name);
  const tag = String(cmdId || makeCmdId()).replace(/[^a-zA-Z0-9]/g, '').slice(-6) || 'lc';
  return `${base}#${tag}`;
}

function buildSpawnLine(thing, nick, cmdId, qty) {
  const t = String(thing || '').trim();
  const id = cmdId || makeCmdId();
  const n = uniqueViewerNick(nick, id);
  const q = Math.max(1, Math.min(MSLUG_SPAWN_MAX, parseInt(qty, 10) || 1));
  return { line: `${t}|${t}|${n}|${t}|${id}|${q}`, cmdId: id, qty: q, thing: t };
}

function enqueueMslugWork(fn) {
  const job = mslugPumpChain.then(fn, fn);
  mslugPumpChain = job.catch(() => {});
  return job;
}

/** Limpia bridge + raíz en todas las rutas del juego (primaria + C:\\Games\\MSlugFanthology). */
export function clearMslugSpawnFiles(gameDir) {
  let cleared = false;
  for (const p of allMslugSpawnFilePaths(gameDir)) {
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p);
      const tmp = `${p}.new`;
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
      cleared = true;
    } catch { /* ignore */ }
  }
  return cleared;
}

function atomicWriteOne(targetPath, body) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const tmp = `${targetPath}.new`;
  fs.writeFileSync(tmp, body, 'ascii');
  try {
    fs.renameSync(tmp, targetPath);
  } catch {
    fs.writeFileSync(targetPath, body, 'ascii');
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

/** bridge/spawn_cmd.txt + spawn_cmd.txt raíz en cada carpeta del juego detectada. */
function writeSpawnFiles(gameDir, line) {
  const body = String(line || '').replace(/\r?\n$/, '');
  for (const dir of resolveMslugSpawnGameDirs(gameDir)) {
    atomicWriteOne(spawnFilePath(dir), body);
    atomicWriteOne(spawnRootFilePath(dir), body);
  }
}

/** Borra, espera y recrea bridge/spawn_cmd.txt (el juego detecta archivo nuevo). */
function interactivoCmdFile(gameDir) {
  return path.join(normDir(gameDir), 'bridge', 'spawn_cmd.txt');
}

function buildInteractivoLine(enemy, nick, qty) {
  const id = `${Date.now()}_${Math.floor(Math.random() * 99999)}`;
  const safeEnemy = String(enemy || 'rifle').replace(/\s+/g, '').substring(0, 300);
  const safeName = sanitizeNick(nick).replace(/,/g, '').substring(0, 18);
  const q = Math.max(1, Math.min(20, parseInt(qty, 10) || 1));
  const line = `${id}|${safeEnemy}|${safeName}|${q}`;
  return { line, id, enemy: safeEnemy, qty: q, thing: safeEnemy, cmdId: id };
}

function writeInteractivoSpawnFile(gameDir, enemy, nick, qty) {
  const built = buildInteractivoLine(enemy, nick, qty);
  clearMslugSpawnFiles(gameDir);
  atomicWriteOne(interactivoCmdFile(gameDir), built.line);
  return built;
}

async function pulseSpawn(gameDir, thing, nick, qty = 1) {
  if (isMslugInteractivoDir(gameDir)) {
    clearMslugSpawnFiles(gameDir);
    await sleep(MSLUG_PULSE_SETTLE_MS);
    const built = writeInteractivoSpawnFile(gameDir, thing, nick, qty);
    return built;
  }
  const built = buildSpawnLine(thing, nick, null, qty);
  clearMslugSpawnFiles(gameDir);
  await sleep(MSLUG_PULSE_SETTLE_MS);
  writeSpawnFiles(gameDir, built.line);
  return built;
}

function writeSpawnLog(gameDir, payload) {
  try {
    const logFile = path.join(gameDir, SPAWN_LOG);
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.writeFileSync(logFile, `${JSON.stringify({ ...payload, at: new Date().toISOString() }, null, 2)}\n`, 'utf8');
  } catch { /* ignore */ }
}

export function getMslugLastSpawn(gameDir) {
  const dir = normDir(gameDir || findMslugGameDir());
  if (!dir) return null;
  try {
    const logFile = path.join(dir, SPAWN_LOG);
    if (!fs.existsSync(logFile)) return null;
    return JSON.parse(fs.readFileSync(logFile, 'utf8'));
  } catch {
    return null;
  }
}

function commitSpawn(gameDir, built, extra = {}) {
  const payload = {
    line: built.line,
    thing: built.thing,
    qty: built.qty,
    cmdId: built.cmdId,
    bridge_version: MSLUG_BRIDGE_VERSION,
    files: [SPAWN_FILE, SPAWN_FILE_ROOT],
    ...extra,
  };
  writeSpawnLog(gameDir, payload);
  return payload;
}

export async function writeMslugSpawn(gameDir, thing, nick, qty = 1) {
  const dir = normDir(gameDir || findMslugGameDir());
  if (!dir) return { ok: false, error: 'no_instalado' };
  if (!isMslugModInstalled(dir)) return { ok: false, error: 'mod_no_instalado' };
  const q = Math.max(1, Math.min(MSLUG_SPAWN_MAX, parseInt(qty, 10) || 1));

  return enqueueMslugWork(async () => {
    try {
      const built = await pulseSpawn(dir, thing, nick, q);
      const spawn = commitSpawn(dir, built);
      await sleep(MSLUG_LOCK_GAP_MS);
      return { ok: true, sent: q, thing: built.thing, times: q, spawn, bridge_version: MSLUG_BRIDGE_VERSION };
    } catch (e) {
      return {
        ok: false,
        sent: 0,
        thing,
        times: q,
        error: e && e.message ? e.message : 'write_fallo',
      };
    }
  });
}

export async function mslugSpawnBridge(thing, name, times = 1) {
  const gameDir = findMslugGameDir();
  if (!gameDir) return { ok: false, error: 'bridge_mslug_no_disponible' };
  const keys = expandMslugSpawnKeys(thing);
  if (!keys.length || !keys[0]) return { ok: false, error: 'sin_thing' };
  const t = Math.max(1, Math.min(MSLUG_SPAWN_MAX, parseInt(times, 10) || 1));

  if (isMslugInteractivoDir(gameDir)) {
    const enemy = keys.length > 1 ? keys.join(',') : keys[0];
    return enqueueMslugWork(async () => {
      try {
        const built = await pulseSpawn(gameDir, enemy, name, Math.min(20, t));
        const summary = commitSpawn(gameDir, built, { qty: t, pulses: 1, mode: 'interactivo' });
        await sleep(MSLUG_LOCK_GAP_MS);
        return {
          ok: true,
          sent: 1,
          thing,
          times: t,
          spawn: summary,
          bridge_version: MSLUG_BRIDGE_VERSION,
          mode: 'interactivo',
        };
      } catch (e) {
        return {
          ok: false,
          sent: 0,
          thing,
          times: t,
          error: e && e.message ? e.message : 'write_fallo',
        };
      }
    });
  }

  return enqueueMslugWork(async () => {
    let sent = 0;
    let lastSpawn = null;
    try {
      clearMslugSpawnFiles(gameDir);
      for (let ki = 0; ki < keys.length; ki += 1) {
        if (ki > 0 && MSLUG_COMBO_GAP_MS > 0) await sleep(MSLUG_COMBO_GAP_MS);
        for (let i = 0; i < t; i += 1) {
          if (sent > 0) await sleep(MSLUG_BURST_GAP_MS);
          const built = await pulseSpawn(gameDir, keys[ki], name, 1);
          lastSpawn = built;
          sent += 1;
        }
      }
      const summary = commitSpawn(gameDir, lastSpawn || buildSpawnLine(keys[0], name, null, 1), {
        qty: t,
        pulses: sent,
      });
      await sleep(MSLUG_LOCK_GAP_MS);
      return {
        ok: true,
        sent,
        thing,
        times: t,
        spawn: summary,
        bridge_version: MSLUG_BRIDGE_VERSION,
      };
    } catch (e) {
      return {
        ok: sent > 0,
        sent,
        thing,
        times: t,
        spawn: lastSpawn,
        error: e && e.message ? e.message : 'write_fallo',
      };
    }
  });
}

function runPsScript(scriptName, gameDir) {
  const script = path.join(__dirname, 'scripts', scriptName);
  if (!fs.existsSync(script)) throw new Error(`Falta script ${scriptName}`);
  execFileSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-GameDir', gameDir],
    { stdio: 'pipe', windowsHide: true, timeout: 120000 },
  );
}

export function installMslugMod(dir) {
  const gameDir = normDir(dir || findMslugGameDir());
  if (!gameDir) throw new Error('Elige la carpeta del juego');
  runPsScript('instalar-mod-mslug.ps1', gameDir);
  setMslugGameDir(gameDir);
  clearMslugSpawnFiles(gameDir);
  dataWinSpawnCached = null;
  return { gameDir, installed: true };
}

export function uninstallMslugMod(dir) {
  const gameDir = normDir(dir || findMslugGameDir());
  if (!gameDir) throw new Error('Elige la carpeta del juego');
  runPsScript('desinstalar-mod-mslug.ps1', gameDir);
  clearMslugSpawnFiles(gameDir);
  dataWinSpawnCached = null;
  return { gameDir, removed: true };
}

export async function launchMslugGameFromBridge() {
  const gameDir = findMslugGameDir();
  if (!gameDir) return { ok: false, error: 'no_instalado' };
  const exe = findMslugExe(gameDir);
  if (!exe) return { ok: false, error: 'sin_exe' };
  if (!isMslugModInstalled(gameDir)) {
    return { ok: false, error: 'mod_no_instalado' };
  }
  clearMslugSpawnFiles(gameDir);
  try {
    const child = spawn(exe, [], { cwd: path.dirname(exe), detached: true, stdio: 'ignore', windowsHide: false });
    child.unref();
    return { ok: true, exe, gameDir };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : 'spawn_fallo' };
  }
}

export async function launchMslugStackFromBridge() {
  const gameDir = findMslugGameDir();
  if (!gameDir || !isMslugModInstalled(gameDir)) {
    return { ok: false, error: 'mod_no_instalado' };
  }
  clearMslugSpawnFiles(gameDir);
  await ensureMslugSpawnWebhook({ visible: true, forceWindow: true }).catch(() => {});
  await sleep(800);
  return launchMslugGameFromBridge();
}
