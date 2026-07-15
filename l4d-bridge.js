/**
 * Livecoins ↔ Left 4 Dead 2 (SourceMod + MetaMod, plugin s2e_l4d2.smx).
 */
import { execFileSync, spawn } from 'node:child_process';
import { discoverL4d2SteamDir, discoverSteamExe, findAllL4d2InstallDirs, L4D2_STEAM_APP_ID } from './steam-game-dir.js';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GAME_DIR_FILE = path.join(process.env.LOCALAPPDATA || '', 'LivecoinsL4d', 'game_dir.txt');
const L4D_PLUGIN = 'livecoins_l4d2.smx';
const L4D_LEGACY_PLUGIN = 's2e_l4d2.smx';
const L4D_MARKERS = ['interactive_l4d2.json', 's2e_info.json'];
const L4D_MOD_VERSION = '1.0.0';
const L4D_MOD_VERSION_CODE = 1;
/** Zip remoto (GitHub Releases). Override: L4D_MOD_ZIP_URL */
export const L4D_MOD_ZIP_URL = process.env.L4D_MOD_ZIP_URL
  || 'https://github.com/riusaki1995/.exe/releases/download/v1.0.79/l4d-livecoins-mod.zip';
const L4D_CACHE_DIR = path.join(process.env.LOCALAPPDATA || '', 'LivecoinsL4d', 'mod-cache');

function normDir(dir) {
  try {
    return path.resolve(String(dir || '').trim());
  } catch {
    return String(dir || '').trim();
  }
}

function sameDir(a, b) {
  if (!a || !b) return false;
  return normDir(a).toLowerCase() === normDir(b).toLowerCase();
}

function isL4dProcessRunning() {
  try {
    const out = execFileSync(
      'tasklist',
      ['/FI', 'IMAGENAME eq left4dead2.exe', '/FO', 'CSV', '/NH'],
      { encoding: 'utf8', windowsHide: true, timeout: 8000 },
    );
    return /"left4dead2\.exe"/i.test(String(out || ''));
  } catch {
    return false;
  }
}

export function getL4dGameDirConfig() {
  try {
    if (fs.existsSync(GAME_DIR_FILE)) {
      const p = fs.readFileSync(GAME_DIR_FILE, 'utf8').trim();
      if (p) return p;
    }
  } catch { /* ignore */ }
  return '';
}

export function setL4dGameDir(dir) {
  const p = String(dir || '').trim();
  if (!p) throw new Error('Ruta vacia');
  if (!fs.existsSync(p)) throw new Error('La carpeta no existe');
  if (!fs.existsSync(path.join(p, 'left4dead2.exe'))) {
    throw new Error('No parece Left 4 Dead 2 (falta left4dead2.exe)');
  }
  fs.mkdirSync(path.dirname(GAME_DIR_FILE), { recursive: true });
  fs.writeFileSync(GAME_DIR_FILE, p, 'utf8');
  return p;
}

export function discoverL4dGameDir() {
  return discoverL4d2SteamDir({ preferMarkers: L4D_MARKERS });
}

export function l4dGameDirPaths() {
  const out = [];
  if (process.env.L4D_GAME_DIR) out.push(process.env.L4D_GAME_DIR);
  const saved = getL4dGameDirConfig();
  if (saved) out.push(saved);
  const steam = discoverL4dGameDir();
  if (steam) out.push(steam);
  out.push('C:\\Program Files (x86)\\Steam\\steamapps\\common\\Left 4 Dead 2');
  out.push('C:\\Program Files\\Steam\\steamapps\\common\\Left 4 Dead 2');
  if (process.env.DESKTOP_RESOURCES) {
    out.push(path.join(process.env.DESKTOP_RESOURCES, 'l4d-game'));
  }
  out.push(path.join(__dirname, 'desktop', 'l4d-game'));
  return [...new Set(out.filter(Boolean))];
}

function hasL4dBridgePlugin(gameDir) {
  if (!gameDir) return false;
  const smPlugins = path.join(gameDir, 'left4dead2', 'addons', 'sourcemod', 'plugins');
  return fs.existsSync(path.join(smPlugins, L4D_PLUGIN))
    || fs.existsSync(path.join(smPlugins, L4D_LEGACY_PLUGIN));
}

export function findL4dModInstallDir() {
  for (const dir of findAllL4d2InstallDirs()) {
    if (isL4dModInstalled(dir) || hasL4dBridgePlugin(dir)) return dir;
  }
  return null;
}

export function findL4dGameDir() {
  const modDir = findL4dModInstallDir();
  if (modDir) return modDir;
  for (const dir of l4dGameDirPaths()) {
    try {
      if (!fs.existsSync(dir)) continue;
      if (fs.existsSync(path.join(dir, 'left4dead2.exe'))) return normDir(dir);
    } catch { /* ignore */ }
  }
  return null;
}

function writeL4dMarkerFiles(gameDir) {
  const dir = normDir(gameDir);
  const livecoinsPayload = {
    game: 'left4dead2',
    info: 'livecoins',
    versionCode: L4D_MOD_VERSION_CODE,
    versionName: L4D_MOD_VERSION,
    path: dir,
    installPath: dir,
  };
  fs.writeFileSync(path.join(dir, 's2e_info.json'), `${JSON.stringify(livecoinsPayload, null, 4)}\n`, 'utf8');

  const interactivePath = path.join(dir, 'interactive_l4d2.json');
  if (!fs.existsSync(interactivePath)) {
    const interactivePayload = {
      versionName: '3.0',
      game: 'Left 4 Dead 2',
    };
    fs.writeFileSync(interactivePath, `${JSON.stringify(interactivePayload, null, '\t')}\n`, 'utf8');
  }
}

function clearL4dMarkersFromOtherInstalls(targetDir) {
  const keep = normDir(targetDir).toLowerCase();
  for (const dir of findAllL4d2InstallDirs()) {
    if (normDir(dir).toLowerCase() === keep) continue;
    for (const name of L4D_MARKERS) {
      try {
        const p = path.join(dir, name);
        if (fs.existsSync(p)) fs.unlinkSync(p);
      } catch { /* ignore */ }
    }
  }
}

/** Alinea game_dir.txt con la carpeta donde está el mod (evita aviso de otra ruta). */
export function syncL4dGameDir() {
  const modDir = findL4dModInstallDir() || findL4dGameDir();
  if (!modDir) return { ok: false, gameDir: null, synced: false };
  if (hasL4dBridgePlugin(modDir) || isL4dModInstalled(modDir)) {
    writeL4dMarkerFiles(modDir);
    clearL4dMarkersFromOtherInstalls(modDir);
  }
  const saved = getL4dGameDirConfig();
  const synced = !saved || !sameDir(saved, modDir);
  if (synced) {
    try {
      setL4dGameDir(modDir);
    } catch { /* ignore */ }
  }
  return { ok: true, gameDir: modDir, synced, previous: saved || null };
}

export function findL4dExe() {
  const dir = findL4dGameDir();
  if (!dir) return null;
  const direct = path.join(dir, 'left4dead2.exe');
  return fs.existsSync(direct) ? direct : null;
}

function hasMarker(gameDir) {
  return L4D_MARKERS.some((name) => fs.existsSync(path.join(gameDir, name)));
}

export function isL4dModInstalled(gameDir) {
  if (!gameDir) return false;
  const pluginsDir = path.join(gameDir, 'left4dead2', 'addons', 'sourcemod', 'plugins');
  const plugin = path.join(pluginsDir, L4D_PLUGIN);
  const legacyPlugin = path.join(pluginsDir, L4D_LEGACY_PLUGIN);
  const metamod = path.join(gameDir, 'left4dead2', 'addons', 'metamod.vdf');
  const smCore = path.join(gameDir, 'left4dead2', 'addons', 'sourcemod', 'bin', 'sourcemod_mm.dll');
  return hasMarker(gameDir)
    && (fs.existsSync(plugin) || fs.existsSync(legacyPlugin))
    && fs.existsSync(metamod)
    && fs.existsSync(smCore);
}

function ps1Path(name) {
  return path.join(__dirname, 'scripts', name);
}

function packLooksValid(dir) {
  if (!dir) return false;
  try {
    return fs.existsSync(path.join(dir, 'left4dead2', 'addons', 'sourcemod', 'plugins', L4D_PLUGIN))
      && fs.existsSync(path.join(dir, 'left4dead2', 'addons', 'metamod.vdf'));
  } catch {
    return false;
  }
}

function findLocalL4dModPackDir() {
  const candidates = [];
  if (process.env.L4D_MOD_PACK_DIR) candidates.push(process.env.L4D_MOD_PACK_DIR);
  candidates.push(path.join(__dirname, 'l4d-mod-pack'));
  for (const dir of candidates) {
    if (packLooksValid(dir)) return dir;
  }
  return null;
}

async function downloadFile(url, destPath) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 15 * 60 * 1000);
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
    timeout: 300000,
  });
}

function rmDirRecursive(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch { /* ignore */ }
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

function resolveExtractedPackRoot(extractRoot) {
  if (packLooksValid(extractRoot)) return extractRoot;
  try {
    for (const name of fs.readdirSync(extractRoot)) {
      const nested = path.join(extractRoot, name);
      if (packLooksValid(nested)) return nested;
      const nested2 = path.join(nested, 'l4d-mod-pack');
      if (packLooksValid(nested2)) return nested2;
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * Devuelve carpeta del pack: cache, descarga remota, o fallback local (dev).
 */
export async function ensureL4dModPack(opts = {}) {
  const forceDownload = !!opts.forceDownload;
  const zipPath = path.join(L4D_CACHE_DIR, 'l4d-livecoins-mod.zip');
  const extractRoot = path.join(L4D_CACHE_DIR, 'extract');
  const packOut = path.join(L4D_CACHE_DIR, 'pack');

  if (!forceDownload && packLooksValid(packOut)) {
    return { packDir: packOut, via: 'cache' };
  }

  const url = String(opts.url || L4D_MOD_ZIP_URL).trim();
  if (!/^https?:\/\//i.test(url)) throw new Error('URL del mod L4D inválida');

  try {
    fs.mkdirSync(L4D_CACHE_DIR, { recursive: true });
    await downloadFile(url, zipPath);

    rmDirRecursive(extractRoot);
    extractZip(zipPath, extractRoot);
    const resolved = resolveExtractedPackRoot(extractRoot);
    if (!resolved) throw new Error('El zip del mod no tiene left4dead2/.../livecoins_l4d2.smx');

    rmDirRecursive(packOut);
    copyDirRecursive(resolved, packOut);
    if (!packLooksValid(packOut)) throw new Error('No se pudo preparar el pack descargado');
    return { packDir: packOut, via: 'download', url };
  } catch (err) {
    if (!forceDownload) {
      const local = findLocalL4dModPackDir();
      if (local && local !== packOut) return { packDir: local, via: 'local-fallback' };
    }
    throw err;
  }
}

function runL4dPs1(scriptName, gameDir, extraArgs = []) {
  const script = ps1Path(scriptName);
  if (!fs.existsSync(script)) throw new Error(`Falta script: ${script}`);
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-GameDir', gameDir, ...extraArgs];
  const out = execFileSync(
    'powershell.exe',
    args,
    { encoding: 'utf8', windowsHide: true, timeout: 300000 },
  );
  return String(out || '').trim();
}

export async function installL4dMod(gameDir, opts = {}) {
  const dir = normDir(gameDir || findL4dGameDir() || discoverL4dGameDir() || '');
  if (!dir) throw new Error('No se encontró Left 4 Dead 2 en Steam. Elige la carpeta del juego.');
  setL4dGameDir(dir);
  const { packDir, via, url } = await ensureL4dModPack(opts);
  runL4dPs1('instalar-mod-l4d.ps1', dir, ['-PackRoot', packDir]);
  if (!isL4dModInstalled(dir)) throw new Error('El mod no quedó instalado');
  writeL4dMarkerFiles(dir);
  clearL4dMarkersFromOtherInstalls(dir);
  return {
    ok: true,
    gameDir: dir,
    installed: true,
    version: L4D_MOD_VERSION,
    via,
    url: url || undefined,
  };
}

export function uninstallL4dMod(gameDir) {
  const dir = String(gameDir || findL4dGameDir() || '').trim();
  if (!dir) throw new Error('Elige la carpeta del juego primero');
  runL4dPs1('desinstalar-mod-l4d.ps1', dir);
  return { ok: true, gameDir: dir, installed: false };
}

export function l4dBridgeStatus() {
  syncL4dGameDir();
  const gameDir = findL4dGameDir();
  const configuredDir = getL4dGameDirConfig();
  return {
    mode: 'sourcemod',
    gameDir,
    configuredDir,
    pathMismatch: !!(gameDir && configuredDir && !sameDir(gameDir, configuredDir)),
    modInstalled: isL4dModInstalled(gameDir),
    pluginSmx: !!(gameDir && hasL4dBridgePlugin(gameDir)),
    version: readL4dModVersion(gameDir),
    mod_zip_url: L4D_MOD_ZIP_URL,
  };
}

function readL4dModVersion(gameDir) {
  if (!gameDir) return '';
  for (const name of L4D_MARKERS) {
    const p = path.join(gameDir, name);
    if (!fs.existsSync(p)) continue;
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      const v = j.versionName != null ? String(j.versionName) : '';
      if (v) return v;
    } catch { /* ignore */ }
  }
  return '3';
}

function l4dTcpReachable(timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: L4D_HTTP_HOST, port: L4D_HTTP_PORT });
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

async function l4dHttpPingOnce(timeoutMs = 4000) {
  for (const profile of L4D_AUTH_PROFILES) {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(`${L4D_HTTP_BASE}spawnenemy`, {
        method: 'OPTIONS',
        signal: ctrl.signal,
        headers: l4dHttpHeaders({
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'content-type, superdupertoken, superdupersignature',
          Connection: 'close',
        }, profile),
      });
      clearTimeout(to);
      if (r.status >= 200 && r.status < 300) {
        return { ok: true, status: r.status, via: 'options', profile: profile.token };
      }
    } catch (e) {
      clearTimeout(to);
    }
  }
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${L4D_HTTP_BASE}health`, {
      method: 'GET',
      signal: ctrl.signal,
      headers: { Origin: 'https://streamtoearn.io', Connection: 'close' },
    });
    clearTimeout(to);
    if (r.status >= 200 && r.status < 300) return { ok: true, status: r.status, via: 'health' };
    return { ok: false, status: r.status, via: 'health' };
  } catch (e) {
    clearTimeout(to);
    return { ok: false, error: e && e.message ? e.message : 'sin_conexion', via: 'health' };
  }
}

async function l4dHttpPing() {
  let last = { ok: false, error: 'sin_conexion' };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    last = await l4dHttpPingOnce();
    if (last.ok) return last;
    if (attempt < 2) await sleep(250);
  }
  if (await l4dTcpReachable()) {
    return { ok: true, status: 0, via: 'tcp', degraded: true };
  }
  return last;
}

export async function l4dBridgeHealth() {
  const gameDir = findL4dGameDir();
  if (!gameDir) {
    return { ok: false, error: 'no_instalado', game_dir: null, mod_installed: false };
  }
  const installed = isL4dModInstalled(gameDir);
  if (!installed) {
    return { ok: false, error: 'mod_no_instalado', game_dir: gameDir, mod_installed: false };
  }
  const ping = await l4dHttpPing();
  const running = isL4dProcessRunning();
  const ok = ping.ok || running;
  return {
    ok,
    error: ok ? undefined : 'juego_no_corriendo',
    game_dir: gameDir,
    mod_installed: true,
    game_running: running,
    http_ready: ping.ok,
    http_port: L4D_HTTP_PORT,
    http_status: ping.status,
  };
}

export function stopL4dBridge() {
  /* Sin proceso bridge aparte por ahora */
}

const L4D_HTTP_PORT = Number(process.env.L4D_HTTP_PORT) || 55001;
const L4D_HTTP_PING_PATH = process.env.L4D_HTTP_PING_PATH || 'health';
const L4D_HTTP_HOST = process.env.L4D_HTTP_HOST || '127.0.0.1';
const L4D_HTTP_BASE = `http://${L4D_HTTP_HOST}:${L4D_HTTP_PORT}/`;
const L4D_AUTH_PROFILES = [
  {
    token: process.env.L4D_HTTP_TOKEN || 'streamtoearn.io',
    origin: process.env.L4D_HTTP_ORIGIN || 'https://streamtoearn.io',
  },
  {
    token: 'livecoins',
    origin: 'https://streamtoearn.io',
  },
];

function l4dHttpHeaders(extra = {}, profile = L4D_AUTH_PROFILES[0]) {
  return {
    Origin: profile.origin,
    Superdupertoken: profile.token,
    ...(process.env.L4D_HTTP_SIGNATURE ? { SuperduperSignature: process.env.L4D_HTTP_SIGNATURE } : {}),
    ...extra,
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const L4D_ENEMY_NAME = {
  Tank: 'Tank',
  Witch: 'Witch',
  Horde: 'Horde',
  Common: 'Common',
  Smoker: 'Smoker',
  Boomer: 'Boomer',
  Hunter: 'Hunter',
  Spitter: 'Spitter',
  Jockey: 'Jockey',
  Charger: 'Charger',
};

const L4D_WEAPON_NAME = {
  smg_silenced: 'SMG Silenced',
  mp5: 'MP5',
  pump_shotgun: 'Pump Shotgun',
  chrome_shotgun: 'Chrome Shotgun',
  rifle: 'Rifle',
  ak47: 'AK47',
  desert_rifle: 'Desert Rifle',
  sg552: 'SG552',
  hunting_rifle: 'Hunting Rifle',
  sniper_military: 'Sniper Military',
  sniper_scout: 'Sniper Scout',
  awp: 'AWP',
  auto_shotgun: 'Auto Shotgun',
  spas: 'SPAS',
  chainsaw: 'Chainsaw',
  molotov: 'Molotov',
};

const L4D_ITEM_NAME = {
  pipe_bomb: 'Pipe Bomb',
  vomit_jar: 'Vomit Jar',
  first_aid_kit: 'First Aid Kit',
  defibrillator: 'Defibrillator',
  pain_pills: 'Pain Pills',
  adrenaline: 'Adrenaline',
  incendiary_pack: 'Incendiary Pack',
  explosive_pack: 'Explosive Pack',
  gas_can: 'Gas Can',
  propane_tank: 'Propane Tank',
  oxygen_tank: 'Oxygen Tank',
  firework_crate: 'Firework Crate',
};

const L4D_EFFECT_MAP = {
  randomweapon: 'randomweapon',
  health: 'health',
  addammo: 'addammo',
  stripweapon: 'stripweapon',
  killallenemies: 'killallenemies',
  healallsurvivors: 'healallsurvivors',
  killallsurvivors: 'killallsurvivors',
  incapacitatesurvivors: 'incapacitatesurvivors',
  stunplayer: 'stunplayer',
  expertmode: 'expertmode',
  airstrike: 'airstrike',
  restartmap: 'restartmap',
};

export function resolveL4dAction(thing, params = {}) {
  const raw = String(thing || '').trim();
  if (!raw.includes(':')) return { effect: raw.toLowerCase(), bodyEffect: '', params };
  const [kind, ...rest] = raw.split(':');
  const val = rest.join(':').trim();
  const k = kind.toLowerCase();
  if (k === 'enemy') {
    return { effect: 'spawnenemy', bodyEffect: L4D_ENEMY_NAME[val] || val, params };
  }
  if (k === 'weapon') {
    return { effect: 'giveweapon', bodyEffect: L4D_WEAPON_NAME[val] || val.replace(/_/g, ' '), params };
  }
  if (k === 'item') {
    return { effect: 'giveitem', bodyEffect: L4D_ITEM_NAME[val] || val.replace(/_/g, ' '), params };
  }
  if (k === 'effect') {
    const eff = L4D_EFFECT_MAP[val.toLowerCase()] || val.toLowerCase();
    return { effect: eff, bodyEffect: '', params };
  }
  return { effect: raw.toLowerCase(), bodyEffect: val, params };
}

export async function l4dHttpEffect(effect, name = '', opts = {}) {
  const eff = String(effect || '').trim().toLowerCase();
  if (!eff) return { ok: false, error: 'sin_effect' };
  const url = `${L4D_HTTP_BASE}${encodeURIComponent(eff)}`;
  const payload = { name: String(name || 'Viewer') };
  const bodyEffect = opts.bodyEffect != null ? String(opts.bodyEffect).trim() : '';
  if (bodyEffect) payload.effect = bodyEffect;
  const p = opts.params && typeof opts.params === 'object' ? opts.params : {};
  if (p.hp != null) payload.hp = p.hp;
  if (p.ammo != null) payload.ammo = p.ammo;
  if (p.radius != null) payload.radius = p.radius;
  if (p.seconds != null) payload.seconds = p.seconds;
  const timeoutMs = Math.max(3000, Number(opts.timeoutMs) || 8000);
  const attempts = Math.max(1, Number(opts.attempts) || 3);
  let last = { ok: false, error: 'sin_auth', url };

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    for (const profile of L4D_AUTH_PROFILES) {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const r = await fetch(url, {
          method: 'POST',
          signal: ctrl.signal,
          headers: l4dHttpHeaders({ 'Content-Type': 'application/json', Connection: 'close' }, profile),
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

export async function l4dSpawnEffect(effect, name, times = 1, bodyEffect = '', params = {}) {
  if (!isL4dModInstalled(findL4dGameDir())) {
    return { ok: false, error: 'bridge_l4d_no_disponible' };
  }
  const t = Math.max(1, Math.min(20, Number(times) || 1));
  let last = { ok: false };
  for (let i = 0; i < t; i += 1) {
    last = await l4dHttpEffect(effect, name, { bodyEffect, params });
    if (!last.ok) break;
    if (i < t - 1) await sleep(120);
  }
  return last;
}

export async function l4dSpawn(thing, name, times = 1, params = {}) {
  const { effect, bodyEffect, params: merged } = resolveL4dAction(thing, params);
  if (!effect) return { ok: false, error: 'sin_thing' };
  return l4dSpawnEffect(effect, String(name || 'Viewer'), times, bodyEffect, merged);
}

export async function launchL4dGameFromBridge() {
  syncL4dGameDir();
  const gameDir = findL4dGameDir();
  if (!gameDir) return { ok: false, error: 'no_instalado' };
  const steamExe = discoverSteamExe();
  if (steamExe) {
    try {
      const child = spawn(steamExe, ['-applaunch', L4D2_STEAM_APP_ID, '-insecure'], {
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
  const exe = findL4dExe();
  if (!exe) return { ok: false, error: 'sin_exe' };
  try {
    const child = spawn(exe, ['-insecure'], { cwd: path.dirname(exe), detached: true, stdio: 'ignore', windowsHide: false });
    child.unref();
    return { ok: true, via: 'exe', exe, gameDir };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : 'spawn_fallo' };
  }
}
