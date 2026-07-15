/**
 * Livecoins ↔ R.E.P.O. (mod BepInEx + HTTP en 127.0.0.1:55001).
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GAME_DIR_FILE = path.join(process.env.LOCALAPPDATA || '', 'LivecoinsRepo', 'game_dir.txt');
const REPO_HTTP_PORT = Number(process.env.REPO_HTTP_PORT) || 55001;
const REPO_HTTP_HOST = process.env.REPO_HTTP_HOST || '127.0.0.1';
const REPO_HTTP_BASE = `http://${REPO_HTTP_HOST}:${REPO_HTTP_PORT}/`;
const REPO_PLUGIN_FILE = 'livecoins-repo.dll';
const REPO_AUTH_PROFILES = [
  {
    token: process.env.REPO_HTTP_TOKEN || 'streamtoearn.io',
    origin: process.env.REPO_HTTP_ORIGIN || 'https://streamtoearn.io',
  },
];

function repoHttpHeaders(extra = {}, profile = REPO_AUTH_PROFILES[0]) {
  return {
    Origin: profile.origin,
    Superdupertoken: profile.token,
    ...extra,
  };
}

function isRepoProcessRunning() {
  try {
    const out = execFileSync(
      'tasklist',
      ['/FI', 'IMAGENAME eq REPO.exe', '/FO', 'CSV', '/NH'],
      { encoding: 'utf8', windowsHide: true, timeout: 8000 },
    );
    return /"REPO\.exe"/i.test(String(out || ''));
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function getRepoGameDirConfig() {
  try {
    if (fs.existsSync(GAME_DIR_FILE)) {
      const p = fs.readFileSync(GAME_DIR_FILE, 'utf8').trim();
      if (p) return p;
    }
  } catch { /* ignore */ }
  return '';
}

export function setRepoGameDir(dir) {
  const p = String(dir || '').trim();
  if (!p) throw new Error('Ruta vacia');
  if (!fs.existsSync(p)) throw new Error('La carpeta no existe');
  if (!fs.existsSync(path.join(p, 'REPO.exe'))) {
    throw new Error('No parece R.E.P.O. (falta REPO.exe)');
  }
  fs.mkdirSync(path.dirname(GAME_DIR_FILE), { recursive: true });
  fs.writeFileSync(GAME_DIR_FILE, p, 'utf8');
  return p;
}

export function repoGameDirPaths() {
  const out = [];
  if (process.env.REPO_GAME_DIR) out.push(process.env.REPO_GAME_DIR);
  const saved = getRepoGameDirConfig();
  if (saved) out.push(saved);
  out.push('C:\\Program Files (x86)\\Steam\\steamapps\\common\\REPO');
  out.push('C:\\Program Files\\Steam\\steamapps\\common\\REPO');
  if (process.env.DESKTOP_RESOURCES) {
    out.push(path.join(process.env.DESKTOP_RESOURCES, 'repo-game'));
  }
  out.push(path.join(__dirname, 'desktop', 'repo-game'));
  return [...new Set(out.filter(Boolean))];
}

export function findRepoGameDir() {
  for (const dir of repoGameDirPaths()) {
    try {
      if (!fs.existsSync(dir)) continue;
      if (fs.existsSync(path.join(dir, 'REPO.exe'))) return dir;
    } catch { /* ignore */ }
  }
  return null;
}

export function findRepoExe() {
  const dir = findRepoGameDir();
  if (!dir) return null;
  const direct = path.join(dir, 'REPO.exe');
  return fs.existsSync(direct) ? direct : null;
}

export function isRepoModInstalled(gameDir) {
  if (!gameDir) return false;
  const marker = path.join(gameDir, 'interactive_repo.json');
  const plugin = path.join(gameDir, 'BepInEx', 'plugins', REPO_PLUGIN_FILE);
  const preloader = path.join(gameDir, 'BepInEx', 'core', 'BepInEx.Preloader.dll');
  const doorstop = path.join(gameDir, 'winhttp.dll');
  const legacyS2e = path.join(gameDir, 's2e_info.json');
  if (fs.existsSync(legacyS2e)) return false;
  return fs.existsSync(marker)
    && fs.existsSync(plugin)
    && fs.existsSync(preloader)
    && fs.existsSync(doorstop);
}

function ps1Path(name) {
  return path.join(__dirname, 'scripts', name);
}

function runRepoPs1(scriptName, gameDir) {
  const script = ps1Path(scriptName);
  if (!fs.existsSync(script)) throw new Error(`Falta script: ${script}`);
  const out = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-GameDir', gameDir],
    { encoding: 'utf8', windowsHide: true, timeout: 120000 },
  );
  return String(out || '').trim();
}

export function installRepoMod(gameDir) {
  const dir = String(gameDir || findRepoGameDir() || '').trim();
  if (!dir) throw new Error('Elige la carpeta del juego primero');
  setRepoGameDir(dir);
  runRepoPs1('instalar-mod-repo.ps1', dir);
  if (!isRepoModInstalled(dir)) throw new Error('El mod no quedó instalado');
  return { ok: true, gameDir: dir, installed: true };
}

export function uninstallRepoMod(gameDir) {
  const dir = String(gameDir || findRepoGameDir() || '').trim();
  if (!dir) throw new Error('Elige la carpeta del juego primero');
  runRepoPs1('desinstalar-mod-repo.ps1', dir);
  return { ok: true, gameDir: dir, installed: false };
}

export function repoBridgeStatus() {
  const gameDir = findRepoGameDir();
  return {
    mode: 'http',
    port: REPO_HTTP_PORT,
    gameDir,
    gameExe: findRepoExe(),
    configuredDir: getRepoGameDirConfig(),
    modInstalled: isRepoModInstalled(gameDir),
    pluginDll: !!(gameDir && fs.existsSync(path.join(gameDir, 'BepInEx', 'plugins', REPO_PLUGIN_FILE))),
    legacyS2e: !!(gameDir && fs.existsSync(path.join(gameDir, 's2e_info.json'))),
  };
}

export function repoBridgeHealthOk(j) {
  return !!(j && j.ok);
}

async function repoHttpPing(timeoutMs = 2000) {
  let last = { ok: false, error: 'sin_conexion' };
  for (const profile of REPO_AUTH_PROFILES) {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(REPO_HTTP_BASE, {
        method: 'OPTIONS',
        signal: ctrl.signal,
        headers: repoHttpHeaders({
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'content-type, superdupertoken',
        }, profile),
      });
      clearTimeout(to);
      if (r.status === 200) return { ok: true, status: r.status, profile: profile.token };
      last = { ok: false, status: r.status, profile: profile.token };
      if (r.status !== 401 && r.status !== 403) break;
    } catch (e) {
      clearTimeout(to);
      last = { ok: false, error: e && e.message ? e.message : 'sin_conexion', profile: profile.token };
    }
  }
  return last;
}

export async function repoBridgeHealth() {
  const gameDir = findRepoGameDir();
  if (!gameDir) {
    return { ok: false, error: 'no_instalado', game_dir: null, mod_installed: false };
  }
  const installed = isRepoModInstalled(gameDir);
  if (!installed) {
    return { ok: false, error: 'mod_no_instalado', game_dir: gameDir, mod_installed: false };
  }
  const ping = await repoHttpPing();
  const running = isRepoProcessRunning();
  const ok = ping.ok || running;
  return {
    ok,
    error: ok ? undefined : 'juego_no_corriendo',
    game_dir: gameDir,
    mod_installed: true,
    game_running: running,
    http_ready: ping.ok,
    http_port: REPO_HTTP_PORT,
    http_status: ping.status,
  };
}

export async function isRepoBridgeUp() {
  return repoBridgeHealthOk(await repoBridgeHealth());
}

export async function ensureRepoBridge() {
  const h = await repoBridgeHealth();
  return repoBridgeHealthOk(h);
}

export function stopRepoBridge() {
  /* HTTP en el juego: no hay proceso bridge aparte */
}

const REPO_EFFECT_DEFAULTS = {
  spawnenemy: 'Duck',
  spawnenemyrandomlocation: 'Duck',
  spawnitem: 'Cart Medium',
  spawnvaluableitem: 'Diamond',
  heal: '100',
  stamina: '100',
};

const REPO_EFFECT_OPTIONAL = new Set([
  'knockdown', 'infinitystamina', 'bonusspeed', 'randomupgrade', 'removecost',
  'changecostup', 'changecostdown', 'destroyitem', 'stunenemies', 'kill', 'revive',
  'randomteleport', 'randomteleportcart', 'teleporttocart', 'teleporttotruck',
  'pushplayerforward', 'pushplayerbackward', 'shakecartitem', 'spawnmine',
  'spawngrenade', 'spawnbottle', 'spawnwizarddumgolfsstaff', 'spawnrubberduck',
  'spawnchompbook',
]);

export function resolveRepoAction(thing, params = {}) {
  const raw = String(thing || '').trim();
  if (!raw) return { effect: '', bodyEffect: '', name: '' };
  if (raw.includes(':')) {
    const [kind, ...rest] = raw.split(':');
    const val = rest.join(':').trim();
    const k = kind.toLowerCase();
    if (k === 'enemy' || k === 'enemigo') {
      return { effect: 'spawnenemy', bodyEffect: val, name: '' };
    }
    if (k === 'enemyrandom' || k === 'enemiorandom') {
      return { effect: 'spawnenemyrandomlocation', bodyEffect: val, name: '' };
    }
    if (k === 'item') return { effect: 'spawnitem', bodyEffect: val, name: '' };
    if (k === 'valuable') return { effect: 'spawnvaluableitem', bodyEffect: val, name: '' };
    if (k === 'effect' || k === 'efecto') {
      let bodyEffect = '';
      if (val === 'heal' && params.health != null) bodyEffect = String(params.health);
      else if (val === 'stamina' && params.stamina != null) bodyEffect = String(params.stamina);
      else bodyEffect = REPO_EFFECT_DEFAULTS[val] || '';
      return { effect: val, bodyEffect, name: '' };
    }
  }
  return { effect: 'spawnenemy', bodyEffect: raw, name: '' };
}

export async function repoHttpEffect(effect, name = '', opts = {}) {
  const eff = String(effect || '').trim().toLowerCase();
  if (!eff) return { ok: false, error: 'sin_effect' };
  const url = `${REPO_HTTP_BASE}${encodeURIComponent(eff)}`;
  let bodyEffect = opts.bodyEffect != null ? String(opts.bodyEffect).trim() : '';
  if (!bodyEffect && REPO_EFFECT_DEFAULTS[eff]) bodyEffect = REPO_EFFECT_DEFAULTS[eff];
  const payload = { name: String(name || 'Viewer') };
  if (bodyEffect || !REPO_EFFECT_OPTIONAL.has(eff)) payload.effect = bodyEffect;
  const timeoutMs = Math.max(2000, Number(opts.timeoutMs) || 5000);
  let last = { ok: false, error: 'sin_auth', url };

  for (const profile of REPO_AUTH_PROFILES) {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(url, {
        method: 'POST',
        signal: ctrl.signal,
        headers: repoHttpHeaders({ 'Content-Type': 'application/json' }, profile),
        body: JSON.stringify(payload),
      });
      clearTimeout(to);
      if (r.ok) {
        return { ok: true, status: r.status, url, auth: profile.token };
      }
      last = { ok: false, status: r.status, url, error: `http_${r.status}`, auth: profile.token };
      if (r.status !== 401 && r.status !== 403) break;
    } catch (e) {
      clearTimeout(to);
      last = { ok: false, error: e && e.message ? e.message : 'sin_conexion', url, auth: profile.token };
    }
  }
  return last;
}

export async function repoSpawnEffect(effect, name, times = 1, bodyEffect = '') {
  if (!isRepoModInstalled(findRepoGameDir())) {
    return { ok: false, error: 'bridge_repo_no_disponible' };
  }
  const t = Math.max(1, Math.min(50, Number(times) || 1));
  let last = { ok: false };
  for (let i = 0; i < t; i += 1) {
    last = await repoHttpEffect(effect, name, { bodyEffect });
    if (!last.ok) break;
    if (i < t - 1) await sleep(120);
  }
  return last;
}

export async function repoSpawn(thing, name, times = 1, params = {}) {
  const { effect, bodyEffect, name: spawnName } = resolveRepoAction(thing, params);
  if (!effect) return { ok: false, error: 'sin_thing' };
  const nick = String(spawnName || name || 'Viewer');
  return repoSpawnEffect(effect, nick, times, bodyEffect);
}

export async function launchRepoGameFromBridge() {
  const gameDir = findRepoGameDir();
  if (!gameDir) return { ok: false, error: 'no_instalado' };
  const exe = findRepoExe();
  if (!exe) return { ok: false, error: 'sin_exe' };
  if (!isRepoModInstalled(gameDir)) {
    return { ok: false, error: 'mod_no_instalado' };
  }
  try {
    const child = spawn(exe, [], { cwd: path.dirname(exe), detached: true, stdio: 'ignore', windowsHide: false });
    child.unref();
    return { ok: true, exe, gameDir };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : 'spawn_fallo' };
  }
}

export async function launchRepoStackFromBridge() {
  const gameDir = findRepoGameDir();
  if (!gameDir || !isRepoModInstalled(gameDir)) {
    return { ok: false, error: 'mod_no_instalado' };
  }
  await sleep(200);
  return launchRepoGameFromBridge();
}
