/**
 * Livecoins ↔ Unturned (mod S2E Doorstop: UnturnedTikTok.dll en :55001).
 * Aislado: no importa ni modifica bridges de otros juegos.
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverSteamExe, discoverSteamLibraryRoots } from './steam-game-dir.js';

export const UNTURNED_STEAM_APP_ID = '304930';
const UNTURNED_EXE = 'Unturned.exe';
const UNTURNED_MOD_VERSION = '1.0.0';
const UNTURNED_MOD_VERSION_CODE = 1;
/** Zip remoto (GitHub Releases). Override: UNTURNED_MOD_ZIP_URL */
export const UNTURNED_MOD_ZIP_URL = process.env.UNTURNED_MOD_ZIP_URL
  || 'https://github.com/riusaki1995/.exe/releases/download/v1.0.79/unturned-livecoins-mod.zip';
const UNTURNED_CACHE_DIR = path.join(process.env.LOCALAPPDATA || '', 'LivecoinsUnturned', 'mod-cache');
const UNTURNED_INSTALL_ROOT_FILES = [
  'doorstop_config.ini',
  '.doorstop_version',
  'winhttp.dll',
  's2e.json',
  's2e_info.json',
  'StreamerNames.json',
];
const GAME_DIR_FILE = path.join(process.env.LOCALAPPDATA || '', 'LivecoinsUnturned', 'game_dir.txt');
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const UNTURNED_HTTP_PORT = Number(process.env.UNTURNED_HTTP_PORT) || 55001;
const UNTURNED_HTTP_HOST = process.env.UNTURNED_HTTP_HOST || '127.0.0.1';
const UNTURNED_HTTP_BASE = `http://${UNTURNED_HTTP_HOST}:${UNTURNED_HTTP_PORT}/`;
const UNTURNED_AUTH_PROFILES = [
  {
    token: process.env.UNTURNED_HTTP_TOKEN || 'streamtoearn.io',
    origin: process.env.UNTURNED_HTTP_ORIGIN || 'https://streamtoearn.io',
  },
  {
    token: 'livecoins',
    origin: 'https://streamtoearn.io',
  },
];

function normDir(dir) {
  try {
    return path.resolve(String(dir || '').trim());
  } catch {
    return String(dir || '').trim();
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function hasUnturnedExe(dir) {
  try {
    return fs.existsSync(path.join(dir, UNTURNED_EXE));
  } catch {
    return false;
  }
}

function hasUnturnedMod(dir) {
  if (!dir || !hasUnturnedExe(dir)) return false;
  try {
    const dll = fs.existsSync(path.join(dir, 'S2E_Unturned', 'UnturnedTikTok.dll'));
    const doorstop = fs.existsSync(path.join(dir, 'doorstop_config.ini'));
    const proxy = fs.existsSync(path.join(dir, 'winhttp.dll'));
    return dll && doorstop && proxy;
  } catch {
    return false;
  }
}

function findLocalUnturnedModPackDir() {
  const candidates = [];
  if (process.env.UNTURNED_MOD_PACK_DIR) candidates.push(process.env.UNTURNED_MOD_PACK_DIR);
  candidates.push(path.join(__dirname, 'unturned-mod-pack'));
  for (const dir of candidates) {
    try {
      if (fs.existsSync(path.join(dir, 'S2E_Unturned', 'UnturnedTikTok.dll'))) return dir;
    } catch { /* ignore */ }
  }
  return null;
}

function packLooksValid(dir) {
  return !!(dir && fs.existsSync(path.join(dir, 'S2E_Unturned', 'UnturnedTikTok.dll')));
}

async function downloadFile(url, destPath) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 10 * 60 * 1000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, redirect: 'follow' });
    if (!r.ok) throw new Error(`Descarga falló HTTP ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 1000) throw new Error('El archivo descargado es demasiado pequeño');
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, buf);
    return destPath;
  } finally {
    clearTimeout(to);
  }
}

function extractZip(zipPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const ps = `
$ErrorActionPreference = 'Stop'
Expand-Archive -LiteralPath ${JSON.stringify(zipPath)} -DestinationPath ${JSON.stringify(destDir)} -Force
`;
  execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], {
    windowsHide: true,
    timeout: 180000,
  });
}

function resolveExtractedPackRoot(extractRoot) {
  if (packLooksValid(extractRoot)) return extractRoot;
  try {
    for (const name of fs.readdirSync(extractRoot)) {
      const nested = path.join(extractRoot, name);
      if (packLooksValid(nested)) return nested;
      const nested2 = path.join(nested, 'unturned-mod-pack');
      if (packLooksValid(nested2)) return nested2;
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * Devuelve carpeta del pack: cache, descarga remota, o fallback local (dev).
 */
export async function ensureUnturnedModPack(opts = {}) {
  const forceDownload = !!opts.forceDownload;
  const zipPath = path.join(UNTURNED_CACHE_DIR, 'unturned-livecoins-mod.zip');
  const extractRoot = path.join(UNTURNED_CACHE_DIR, 'extract');
  const packOut = path.join(UNTURNED_CACHE_DIR, 'pack');

  if (!forceDownload && packLooksValid(packOut)) {
    return { packDir: packOut, via: 'cache' };
  }

  const url = String(opts.url || UNTURNED_MOD_ZIP_URL).trim();
  if (!/^https?:\/\//i.test(url)) throw new Error('URL del mod Unturned inválida');

  try {
    fs.mkdirSync(UNTURNED_CACHE_DIR, { recursive: true });
    await downloadFile(url, zipPath);

    rmDirRecursive(extractRoot);
    extractZip(zipPath, extractRoot);
    const resolved = resolveExtractedPackRoot(extractRoot);
    if (!resolved) throw new Error('El zip del mod no tiene S2E_Unturned/UnturnedTikTok.dll');

    rmDirRecursive(packOut);
    copyDirRecursive(resolved, packOut);
    if (!packLooksValid(packOut)) throw new Error('No se pudo preparar el pack descargado');
    return { packDir: packOut, via: 'download', url };
  } catch (err) {
    if (!forceDownload) {
      const local = findLocalUnturnedModPackDir();
      if (local && local !== packOut) return { packDir: local, via: 'local-fallback' };
    }
    throw err;
  }
}

function applyUnturnedPackToGame(pack, gameDir) {
  for (const name of UNTURNED_INSTALL_ROOT_FILES) {
    const src = path.join(pack, name);
    if (!fs.existsSync(src)) continue;
    copyFile(src, path.join(gameDir, name));
  }

  const s2eSrc = path.join(pack, 'S2E_Unturned');
  const s2eDst = path.join(gameDir, 'S2E_Unturned');
  if (!fs.existsSync(s2eSrc)) throw new Error('Pack incompleto: falta S2E_Unturned');
  rmDirRecursive(s2eDst);
  copyDirRecursive(s2eSrc, s2eDst);

  const mapSrc = path.join(pack, 'Maps', 'StreamToEarn');
  if (fs.existsSync(mapSrc)) {
    copyDirRecursive(mapSrc, path.join(gameDir, 'Maps', 'StreamToEarn'));
  }

  writeUnturnedMarkerFiles(gameDir);
}

export async function installUnturnedMod(gameDir, opts = {}) {
  const dir = normDir(gameDir || findUnturnedGameDir() || discoverUnturnedSteamDir() || '');
  if (!dir) throw new Error('No se encontró Unturned en Steam. Elige la carpeta del juego.');
  if (!hasUnturnedExe(dir)) throw new Error('No parece Unturned (falta Unturned.exe)');

  setUnturnedGameDir(dir);
  const { packDir, via, url } = await ensureUnturnedModPack(opts);
  applyUnturnedPackToGame(packDir, dir);

  if (!isUnturnedModInstalled(dir)) throw new Error('El mod no quedó instalado');
  return {
    ok: true,
    gameDir: dir,
    installed: true,
    version: UNTURNED_MOD_VERSION,
    via,
    url: url || undefined,
  };
}

function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function copyDirRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirRecursive(from, to);
    else copyFile(from, to);
  }
}

function rmDirRecursive(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch { /* ignore */ }
}

function writeUnturnedMarkerFiles(gameDir) {
  const dir = normDir(gameDir);
  const payload = {
    versionName: UNTURNED_MOD_VERSION,
    versionCode: UNTURNED_MOD_VERSION_CODE,
    info: 'livecoins',
    game: 'Unturned',
    path: dir,
    installPath: dir,
  };
  fs.writeFileSync(path.join(dir, 's2e_info.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  const s2ePath = path.join(dir, 's2e.json');
  if (!fs.existsSync(s2ePath)) {
    fs.writeFileSync(s2ePath, `${JSON.stringify({
      versionName: '3.0',
      versionCode: 3,
      info: 'livecoins',
      game: 'Unturned',
    }, null, '\t')}\n`, 'utf8');
  }
}

export function getUnturnedGameDirConfig() {
  try {
    if (fs.existsSync(GAME_DIR_FILE)) {
      const p = fs.readFileSync(GAME_DIR_FILE, 'utf8').trim();
      if (p) return p;
    }
  } catch { /* ignore */ }
  return '';
}

export function setUnturnedGameDir(dir) {
  const p = String(dir || '').trim();
  if (!p) throw new Error('Ruta vacia');
  if (!fs.existsSync(p)) throw new Error('La carpeta no existe');
  if (!hasUnturnedExe(p)) throw new Error('No parece Unturned (falta Unturned.exe)');
  fs.mkdirSync(path.dirname(GAME_DIR_FILE), { recursive: true });
  fs.writeFileSync(GAME_DIR_FILE, p, 'utf8');
  return p;
}

function gameDirFromManifest(steamRoot, appId) {
  try {
    const manifest = path.join(steamRoot, 'steamapps', `appmanifest_${appId}.acf`);
    if (!fs.existsSync(manifest)) return null;
    const txt = fs.readFileSync(manifest, 'utf8');
    const m = txt.match(/"installdir"\s+"([^"]+)"/i);
    if (!m) return null;
    const dir = path.join(steamRoot, 'steamapps', 'common', m[1]);
    return hasUnturnedExe(dir) ? normDir(dir) : null;
  } catch {
    return null;
  }
}

export function discoverUnturnedSteamDir() {
  for (const root of discoverSteamLibraryRoots()) {
    const viaManifest = gameDirFromManifest(root, UNTURNED_STEAM_APP_ID);
    if (viaManifest) return viaManifest;
    const guess = path.join(root, 'steamapps', 'common', 'Unturned');
    if (hasUnturnedExe(guess)) return normDir(guess);
  }
  return null;
}

export function unturnedGameDirPaths() {
  const out = [];
  if (process.env.UNTURNED_GAME_DIR) out.push(process.env.UNTURNED_GAME_DIR);
  const saved = getUnturnedGameDirConfig();
  if (saved) out.push(saved);
  const steam = discoverUnturnedSteamDir();
  if (steam) out.push(steam);
  out.push('C:\\Program Files (x86)\\Steam\\steamapps\\common\\Unturned');
  out.push('C:\\Program Files\\Steam\\steamapps\\common\\Unturned');
  return [...new Set(out.filter(Boolean))];
}

export function findUnturnedGameDir() {
  for (const dir of unturnedGameDirPaths()) {
    try {
      if (hasUnturnedExe(dir)) return normDir(dir);
    } catch { /* ignore */ }
  }
  return null;
}

export function isUnturnedModInstalled(gameDir = findUnturnedGameDir()) {
  return hasUnturnedMod(gameDir);
}

export function syncUnturnedGameDir() {
  const dir = findUnturnedGameDir();
  if (dir && !getUnturnedGameDirConfig()) {
    try { setUnturnedGameDir(dir); } catch { /* ignore */ }
  }
  return dir;
}

export function uninstallUnturnedMod(gameDir) {
  const dir = normDir(gameDir || findUnturnedGameDir() || '');
  if (!dir) throw new Error('Elige la carpeta del juego primero');
  if (!hasUnturnedExe(dir)) throw new Error('No parece Unturned (falta Unturned.exe)');

  rmDirRecursive(path.join(dir, 'S2E_Unturned'));
  for (const name of UNTURNED_INSTALL_ROOT_FILES) {
    try {
      const p = path.join(dir, name);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch { /* ignore */ }
  }
  return { ok: true, gameDir: dir, installed: false };
}

function isUnturnedProcessRunning() {
  try {
    const out = execFileSync(
      'tasklist',
      ['/FI', 'IMAGENAME eq Unturned.exe', '/FO', 'CSV', '/NH'],
      { encoding: 'utf8', windowsHide: true, timeout: 8000 },
    );
    return /"Unturned\.exe"/i.test(String(out || ''));
  } catch {
    return false;
  }
}

function unturnedHttpHeaders(extra = {}, profile = UNTURNED_AUTH_PROFILES[0]) {
  return {
    Origin: profile.origin,
    Superdupertoken: profile.token,
    ...extra,
  };
}

function unturnedTcpReachable(timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: UNTURNED_HTTP_HOST, port: UNTURNED_HTTP_PORT });
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.on('connect', () => finish(true));
    socket.on('timeout', () => finish(false));
    socket.on('error', () => finish(false));
  });
}

async function unturnedHttpPingOnce(timeoutMs = 4000) {
  for (const profile of UNTURNED_AUTH_PROFILES) {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(`${UNTURNED_HTTP_BASE}spawn`, {
        method: 'OPTIONS',
        signal: ctrl.signal,
        headers: unturnedHttpHeaders({
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'content-type, superdupertoken',
          Connection: 'close',
        }, profile),
      });
      clearTimeout(to);
      if (r.status >= 200 && r.status < 300) {
        return { ok: true, status: r.status, via: 'options', profile: profile.token };
      }
    } catch {
      clearTimeout(to);
    }
  }
  if (await unturnedTcpReachable()) {
    return { ok: true, status: 0, via: 'tcp', degraded: true };
  }
  return { ok: false, error: 'sin_conexion' };
}

export async function unturnedBridgeHealth() {
  const gameDir = findUnturnedGameDir();
  if (!gameDir) {
    return { ok: false, error: 'no_instalado', game_dir: null, mod_installed: false };
  }
  const installed = isUnturnedModInstalled(gameDir);
  if (!installed) {
    return { ok: false, error: 'mod_no_instalado', game_dir: gameDir, mod_installed: false };
  }
  const ping = await unturnedHttpPingOnce();
  const running = isUnturnedProcessRunning();
  const ok = ping.ok || running;
  return {
    ok,
    error: ok ? undefined : 'juego_no_corriendo',
    game_dir: gameDir,
    mod_installed: true,
    game_running: running,
    http_ready: !!ping.ok && !ping.degraded,
    http_port: UNTURNED_HTTP_PORT,
    http_status: ping.status,
    version: UNTURNED_MOD_VERSION,
  };
}

export function unturnedBridgeStatus() {
  const gameDir = findUnturnedGameDir();
  return {
    game_dir: gameDir,
    mod_installed: isUnturnedModInstalled(gameDir),
    http_port: UNTURNED_HTTP_PORT,
    game_running: isUnturnedProcessRunning(),
    version: UNTURNED_MOD_VERSION,
    pack_ready: packLooksValid(path.join(UNTURNED_CACHE_DIR, 'pack')) || !!findLocalUnturnedModPackDir(),
    mod_zip_url: UNTURNED_MOD_ZIP_URL,
  };
}

export function stopUnturnedBridge() {
  /* El HTTP vive dentro del proceso del juego (Doorstop). */
}

/**
 * thing: "spawn:NORMAL", "spawnanimal:pig", "giveitem:15", "heal", "day", …
 * params.amount opcional (heal/food/ítems/…).
 */
export function resolveUnturnedAction(thing, params = {}) {
  const raw = String(thing || '').trim();
  const amount = params.amount != null && Number.isFinite(Number(params.amount))
    ? Number(params.amount)
    : undefined;
  if (!raw) return { path: '', effect: '', amount };
  if (!raw.includes(':')) {
    return { path: raw.toLowerCase(), effect: '', amount };
  }
  const idx = raw.indexOf(':');
  const pathPart = raw.slice(0, idx).trim().toLowerCase();
  const effect = raw.slice(idx + 1).trim();
  return { path: pathPart, effect, amount };
}

export async function unturnedHttpEffect(pathCmd, name = '', opts = {}) {
  const cmd = String(pathCmd || '').trim().toLowerCase().replace(/^\/+/, '');
  if (!cmd) return { ok: false, error: 'sin_comando' };
  const url = `${UNTURNED_HTTP_BASE}${encodeURIComponent(cmd)}`;
  const payload = { name: String(name || 'Viewer') };
  const bodyEffect = opts.bodyEffect != null ? String(opts.bodyEffect).trim() : '';
  if (bodyEffect) payload.effect = bodyEffect;
  if (opts.amount != null && Number.isFinite(Number(opts.amount))) {
    payload.amount = Number(opts.amount);
  }
  const timeoutMs = Math.max(3000, Number(opts.timeoutMs) || 8000);
  const attempts = Math.max(1, Number(opts.attempts) || 3);
  let last = { ok: false, error: 'sin_auth', url };

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    for (const profile of UNTURNED_AUTH_PROFILES) {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const r = await fetch(url, {
          method: 'POST',
          signal: ctrl.signal,
          headers: unturnedHttpHeaders({ 'Content-Type': 'application/json', Connection: 'close' }, profile),
          body: JSON.stringify(payload),
        });
        clearTimeout(to);
        if (r.ok) return { ok: true, status: r.status, url, auth: profile.token };
        let detail = '';
        try {
          const j = await r.json();
          if (j?.error) detail = String(j.error);
        } catch { /* ignore */ }
        last = { ok: false, status: r.status, url, error: detail || `http_${r.status}`, auth: profile.token };
        if (r.status !== 401 && r.status !== 403) break;
      } catch (e) {
        clearTimeout(to);
        last = { ok: false, error: e && e.message ? e.message : 'sin_conexion', url, auth: profile.token };
      }
    }
    if (last.ok) return last;
    if (attempt < attempts - 1) await sleep(350);
  }
  return last;
}

export async function unturnedSpawn(thing, name, times = 1, params = {}) {
  if (!isUnturnedModInstalled(findUnturnedGameDir())) {
    return { ok: false, error: 'bridge_unturned_no_disponible' };
  }
  const { path: cmd, effect, amount } = resolveUnturnedAction(thing, params);
  if (!cmd) return { ok: false, error: 'sin_thing' };
  const t = Math.max(1, Math.min(20, Number(times) || 1));
  let last = { ok: false };
  for (let i = 0; i < t; i += 1) {
    last = await unturnedHttpEffect(cmd, String(name || 'Viewer'), {
      bodyEffect: effect,
      amount: amount != null ? amount : params.amount,
      params,
    });
    if (!last.ok) break;
    if (i < t - 1) await sleep(120);
  }
  return last;
}

export async function launchUnturnedGameFromBridge() {
  syncUnturnedGameDir();
  const gameDir = findUnturnedGameDir();
  if (!gameDir) return { ok: false, error: 'no_instalado' };
  const steamExe = discoverSteamExe();
  if (steamExe) {
    try {
      const child = spawn(steamExe, ['-applaunch', UNTURNED_STEAM_APP_ID], {
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
      });
      child.unref();
      return { ok: true, via: 'steam', steamExe, gameDir };
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : 'steam_spawn_fallo' };
    }
  }
  const exe = path.join(gameDir, UNTURNED_EXE);
  if (!fs.existsSync(exe)) return { ok: false, error: 'sin_exe' };
  try {
    const child = spawn(exe, [], { cwd: gameDir, detached: true, stdio: 'ignore', windowsHide: false });
    child.unref();
    return { ok: true, via: 'exe', exe, gameDir };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : 'spawn_fallo' };
  }
}
