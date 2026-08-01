/**
 * Livecoins ↔ Super Mario World (BizHawk Interactive / ConnectorLib TCP :23884).
 * Aislado: no importa bridges de otros juegos.
 *
 * El Lua Interactive\connector.lua se conecta como cliente a 127.0.0.1:23884.
 * Livecoins escucha ahí y envía bloques JSON (length-prefix 4 bytes BE).
 *
 * Pack: descarga smw-livecoins-mod.zip → %LOCALAPPDATA%\LivecoinsSmw\
 */
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export const SMW_TCP_PORT = Number(process.env.SMW_TCP_PORT) || 23884;
export const SMW_TCP_HOST = process.env.SMW_TCP_HOST || '127.0.0.1';
export const SMW_MOD_VERSION = '1.0.0';
/** Zip remoto (GitHub Releases). Override: SMW_MOD_ZIP_URL */
export const SMW_MOD_ZIP_URL = process.env.SMW_MOD_ZIP_URL
  || 'https://github.com/paleteriadeyellow-tech/exe/releases/download/exe/smw-livecoins-mod.zip';

const SMW_ROOT = path.join(process.env.LOCALAPPDATA || '', 'LivecoinsSmw');
const SMW_CACHE_DIR = path.join(SMW_ROOT, 'mod-cache');
const SMW_INSTALL_DIR = path.join(SMW_ROOT, 'BizHawk-SMW-Livecoins');
const SMW_EXE = 'EmuHawk.exe';
const SMW_LUA = path.join('Interactive', 'connector.lua');

const CMD = {
  write_u8: 0x10,
  add_u8: 0x18, // parche Livecoins en connector.lua
  spawn_sprite: 0xC0,
  message: 0xB0,
  no_op: 0xFF,
};

/** Sin pausa entre spawns (como Mario SMBX). */
const SMW_SPAWN_GAP_MS = 0;

const w8 = (address, value) => ({ type: CMD.write_u8, domain: 'WRAM', address, value });
const add8 = (address, value) => ({ type: CMD.add_u8, domain: 'WRAM', address, value });
const spawnCmd = (sprite, extra = {}) => ({
  type: CMD.spawn_sprite,
  sprite,
  dx: extra.dx != null ? extra.dx : 16,
  dy: extra.dy != null ? extra.dy : -16,
  vx: extra.vx != null ? extra.vx : 0,
  vy: extra.vy != null ? extra.vy : 0,
  dir: extra.dir != null ? extra.dir : 0,
  sfx: extra.sfx != null ? extra.sfx : -1,
});
const sfx = (code) => w8(0x1DFC, code);
/** Power-up instantáneo: escribe $19 (0=small 1=big 2=cape 3=fire). */
const powerInstant = (status) => [w8(0x19, status), w8(0x0DB8, status), sfx(0x0A)];

/**
 * Catálogo = efectos Interactive / Crowd Control (nombres ES).
 * Power-ups: solo variantes [Instantáneo] (WRAM, sin esperar caja/ítem).
 */
export const SMW_CATALOG_SEED = [
  // —— Power-ups instantáneos ——
  {
    id: 'cape_instant', nombre: 'Pluma de capa [Instantáneo]', section: 'powerups', emoji: '🪶',
    desc: '¡Da a Mario una capa al instante!',
    cmds: powerInstant(2),
  },
  {
    id: 'fire_instant', nombre: 'Flor de fuego [Instantáneo]', section: 'powerups', emoji: '🌸',
    desc: 'Transforma a Mario en Mario de Fuego al instante.',
    cmds: powerInstant(3),
  },
  {
    id: 'mushroom_instant', nombre: 'Hongo [Instantáneo]', section: 'powerups', emoji: '🍄',
    desc: 'Transforma al instante a Mario en Mario grande.',
    cmds: powerInstant(1),
  },
  {
    id: 'star_instant', nombre: 'Estrella [Instantáneo]', section: 'powerups', emoji: '⭐',
    desc: 'Invencibilidad al instante.',
    cmds: [w8(0x1490, 0xFF), w8(0x13CB, 0xFF), sfx(0x0A)],
  },
  {
    id: 'give_1up', nombre: 'Dar 1-Up', section: 'powerups', emoji: '💚',
    desc: '¡Da al jugador 1 vida!',
    cmds: [add8(0x0DBE, 1), sfx(0x05)],
  },
  {
    id: 'give_3up', nombre: 'Dar 3-Up', section: 'powerups', emoji: '💚',
    desc: '¡Da al jugador 3 vidas!',
    cmds: [add8(0x0DBE, 3), sfx(0x05)],
  },
  {
    id: 'give_5up', nombre: 'Dar 5-Up', section: 'powerups', emoji: '💚',
    desc: '¡Da al jugador 5 vidas!',
    cmds: [add8(0x0DBE, 5), sfx(0x05)],
  },

  // —— Tiempo ——
  {
    id: 'add_time', nombre: 'Aumentar Tiempo', section: 'time', emoji: '⏱️',
    desc: 'Aumenta el tiempo del contador',
    cmds: [add8(0x0F31, 1), sfx(0x01)],
  },
  {
    id: 'reduce_time', nombre: 'Reducir Tiempo', section: 'time', emoji: '⏳',
    desc: 'Reduce el tiempo del contador',
    cmds: [add8(0x0F31, -1), sfx(0x2A)],
  },

  // —— Ataques ——
  {
    id: 'bullet_airstrike', nombre: 'Ataque aéreo de Bill Bala', section: 'attacks', emoji: '🔫',
    desc: 'Llama a un ataque aéreo de Bill Balas.',
    cmds: [
      spawnCmd(0x1C, { dx: -40, dy: -80, vx: 0x20, vy: 0x10 }),
      spawnCmd(0x1C, { dx: 0, dy: -90, vx: 0x18, vy: 0x14 }),
      spawnCmd(0x1C, { dx: 40, dy: -80, vx: 0x10, vy: 0x10 }),
      spawnCmd(0x1C, { dx: 80, dy: -100, vx: 0x28, vy: 0x18 }),
      spawnCmd(0x1C, { dx: -80, dy: -70, vx: 0x30, vy: 0x0C }),
    ],
  },
  {
    id: 'thwomp_rain', nombre: 'Lluvia de Thwomps', section: 'attacks', emoji: '🗿',
    desc: 'Hace que caigan Thwomps del cielo.',
    cmds: [
      spawnCmd(0x26, { dx: -48, dy: -100, vy: 0x30 }),
      spawnCmd(0x26, { dx: 0, dy: -120, vy: 0x28 }),
      spawnCmd(0x26, { dx: 48, dy: -90, vy: 0x34 }),
      spawnCmd(0x26, { dx: 96, dy: -110, vy: 0x2C }),
    ],
  },

  // —— Física ——
  {
    id: 'ice_physics', nombre: 'Física de hielo', section: 'physics', emoji: '🧊',
    desc: '¡Pisos helados por todas partes!',
    cmds: [w8(0x0086, 0xFF), sfx(0x01)],
  },
  {
    id: 'water_physics', nombre: 'Física de agua', section: 'physics', emoji: '🌊',
    desc: '¡Nada, tonto! Esto forzará al nivel a tener agua.',
    cmds: [w8(0x0085, 0x01), sfx(0x01)],
  },
  {
    id: 'sticky_floor', nombre: 'Suelo pegajoso', section: 'physics', emoji: '🍯',
    desc: 'Haz el suelo pegajoso como jarabe. Mario casi solo puede saltar.',
    cmds: [w8(0x0086, 0x01), sfx(0x01)],
  },
  {
    id: 'speed_mode', nombre: 'Modo velocidad', section: 'physics', emoji: '💨',
    desc: 'Si Mario reduce la velocidad, explotará.',
    cmds: [w8(0x13E4, 0x70), sfx(0x01)],
  },
];

let server = null;
let client = null;
let keepaliveTimer = null;
let msgId = 1;
let lastError = '';

function nextId() {
  msgId = (msgId % 1_000_000) + 1;
  return msgId;
}

function encodeFrame(obj) {
  const data = Buffer.from(JSON.stringify(obj), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(data.length, 0);
  return Buffer.concat([header, data]);
}

function sendToClient(obj) {
  if (!client || client.destroyed) return { ok: false, error: 'bizhawk_no_conectado' };
  try {
    client.write(encodeFrame(obj));
    return { ok: true };
  } catch (e) {
    lastError = e && e.message ? e.message : String(e);
    return { ok: false, error: lastError };
  }
}

function startKeepalive() {
  stopKeepalive();
  keepaliveTimer = setInterval(() => {
    if (!client || client.destroyed) return;
    sendToClient({ id: nextId(), stamp: Math.floor(Date.now() / 1000), type: CMD.no_op });
  }, 2500);
}

function stopKeepalive() {
  if (keepaliveTimer) {
    clearInterval(keepaliveTimer);
    keepaliveTimer = null;
  }
}

function attachClient(socket) {
  if (client && client !== socket) {
    try { client.destroy(); } catch { /* ignore */ }
  }
  client = socket;
  lastError = '';
  socket.setNoDelay(true);
  socket.on('error', () => {});
  socket.on('close', () => {
    if (client === socket) client = null;
  });
  sendToClient({ id: nextId(), stamp: Math.floor(Date.now() / 1000), type: CMD.no_op });
  sendToClient({
    id: nextId(),
    stamp: Math.floor(Date.now() / 1000),
    type: CMD.message,
    message: 'Livecoins SMW bridge OK',
  });
  startKeepalive();
}

function rmDirRecursive(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
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

function findRomInDir(dir) {
  const games = path.join(dir, 'GAMES');
  if (!fs.existsSync(games)) return null;
  try {
    const files = fs.readdirSync(games);
    const prefer = files.find((n) => /super\s*mario\s*world/i.test(n) && /\.(sfc|smc)$/i.test(n));
    if (prefer) return path.join(games, prefer);
    const any = files.find((n) => /\.(sfc|smc)$/i.test(n));
    return any ? path.join(games, any) : null;
  } catch {
    return null;
  }
}

export function packLooksValid(dir) {
  if (!dir) return false;
  try {
    return fs.existsSync(path.join(dir, SMW_EXE))
      && fs.existsSync(path.join(dir, SMW_LUA))
      && !!findRomInDir(dir);
  } catch {
    return false;
  }
}

function resolveExtractedPackRoot(extractRoot) {
  if (packLooksValid(extractRoot)) return extractRoot;
  try {
    for (const name of fs.readdirSync(extractRoot)) {
      const nested = path.join(extractRoot, name);
      if (packLooksValid(nested)) return nested;
    }
  } catch { /* ignore */ }
  return null;
}

export function getSmwInstallDir() {
  if (packLooksValid(SMW_INSTALL_DIR)) return SMW_INSTALL_DIR;
  return null;
}

export function isSmwModInstalled() {
  return !!getSmwInstallDir();
}

export function smwBridgeStatus() {
  const installDir = getSmwInstallDir();
  return {
    mode: 'bizhawk-connector',
    tcp_port: SMW_TCP_PORT,
    listening: !!(server && server.listening),
    bizhawk_connected: !!(client && !client.destroyed),
    mod_installed: !!installDir,
    install_dir: installDir || SMW_INSTALL_DIR,
    version: SMW_MOD_VERSION,
    mod_zip_url: SMW_MOD_ZIP_URL,
    last_error: lastError || undefined,
  };
}

export async function smwBridgeHealth() {
  const st = smwBridgeStatus();
  return {
    ok: st.listening,
    running: st.listening,
    ...st,
  };
}

export function smwBridgeHealthOk(h) {
  return !!(h && (h.running || h.listening));
}

/** Detecta Interactive.exe (Crowd Control) u otro proceso en :23884. Solo para UI «Conectar», no en el hot path de spawn. */
function describePortConflict() {
  try {
    const out = execFileSync('powershell.exe', [
      '-NoProfile', '-Command',
      `$c = Get-NetTCPConnection -LocalPort ${SMW_TCP_PORT} -State Listen -EA SilentlyContinue | Select-Object -First 1; if (-not $c) { '' } else { (Get-Process -Id $c.OwningProcess -EA SilentlyContinue).ProcessName }`,
    ], { windowsHide: true, timeout: 2500, encoding: 'utf8' }).trim();
    if (/^Interactive$/i.test(out)) {
      return 'Cierra Interactive.exe (Crowd Control): usa el mismo puerto 23884. Livecoins debe ser el único host.';
    }
    if (/^(electron|Livecoins)$/i.test(out)) {
      return `El bridge SMW ya está activo en esta app (puerto ${SMW_TCP_PORT}).`;
    }
    if (out) return `Puerto ${SMW_TCP_PORT} ocupado por ${out}. Ciérralo e intenta de nuevo.`;
  } catch { /* ignore */ }
  return `Puerto ${SMW_TCP_PORT} ocupado. Si ya pulsaste Conectar, el bridge ya corre; cierra Interactive.exe si está abierto.`;
}

export async function ensureSmwBridge(opts = {}) {
  if (server && server.listening) {
    return { ok: true, ...smwBridgeStatus() };
  }
  const diagnose = opts.diagnose !== false;
  return new Promise((resolve) => {
    const s = net.createServer((socket) => attachClient(socket));
    s.on('error', (e) => {
      const raw = e && e.message ? e.message : String(e);
      // Nunca bloquear spawn/Probar con PowerShell (2–5 s). Diagnóstico solo en Conectar.
      let friendly = raw;
      if (/EADDRINUSE/i.test(raw)) {
        friendly = diagnose
          ? describePortConflict()
          : `Puerto ${SMW_TCP_PORT} ocupado`;
      }
      lastError = friendly;
      resolve({
        ok: false,
        error: friendly,
        eaddrinuse: /EADDRINUSE/i.test(raw),
        ...smwBridgeStatus(),
      });
    });
    s.listen(SMW_TCP_PORT, SMW_TCP_HOST, () => {
      server = s;
      startKeepalive();
      resolve({ ok: true, ...smwBridgeStatus() });
    });
  });
}

export function stopSmwBridge() {
  stopKeepalive();
  try { if (client) client.destroy(); } catch { /* ignore */ }
  client = null;
  try { if (server) server.close(); } catch { /* ignore */ }
  server = null;
}

/**
 * Descarga el zip de GitHub y deja BizHawk listo en %LOCALAPPDATA%\LivecoinsSmw\
 */
export async function installSmwMod(opts = {}) {
  const forceDownload = !!opts.forceDownload;
  const zipPath = path.join(SMW_CACHE_DIR, 'smw-livecoins-mod.zip');
  const extractRoot = path.join(SMW_CACHE_DIR, 'extract');

  if (!forceDownload && packLooksValid(SMW_INSTALL_DIR)) {
    patchSmwConnectorLua(SMW_INSTALL_DIR);
    return {
      ok: true,
      installed: true,
      via: 'already',
      installDir: SMW_INSTALL_DIR,
      version: SMW_MOD_VERSION,
    };
  }

  const url = String(opts.url || SMW_MOD_ZIP_URL).trim();
  if (!/^https?:\/\//i.test(url)) throw new Error('URL del mod SMW inválida');

  fs.mkdirSync(SMW_CACHE_DIR, { recursive: true });
  await downloadFile(url, zipPath);

  rmDirRecursive(extractRoot);
  extractZip(zipPath, extractRoot);
  const resolved = resolveExtractedPackRoot(extractRoot);
  if (!resolved) {
    throw new Error('El zip no tiene EmuHawk.exe + Interactive/connector.lua + ROM SMW');
  }

  rmDirRecursive(SMW_INSTALL_DIR);
  copyDirRecursive(resolved, SMW_INSTALL_DIR);
  if (!packLooksValid(SMW_INSTALL_DIR)) throw new Error('No se pudo preparar la instalación SMW');

  fs.writeFileSync(
    path.join(SMW_INSTALL_DIR, 'livecoins-smw.json'),
    `${JSON.stringify({
      version: SMW_MOD_VERSION,
      info: 'livecoins',
      game: 'Super Mario World',
      installPath: SMW_INSTALL_DIR,
      zipUrl: url,
      installedAt: new Date().toISOString(),
    }, null, 2)}\n`,
    'utf8',
  );

  patchSmwConnectorLua(SMW_INSTALL_DIR);

  return {
    ok: true,
    installed: true,
    via: 'download',
    url,
    installDir: SMW_INSTALL_DIR,
    version: SMW_MOD_VERSION,
  };
}

/** Borra la instalación local de BizHawk SMW (no toca el zip en cache). */
export function uninstallSmwMod() {
  const had = packLooksValid(SMW_INSTALL_DIR);
  rmDirRecursive(SMW_INSTALL_DIR);
  return {
    ok: true,
    removed: had,
    installDir: SMW_INSTALL_DIR,
    mod_installed: false,
  };
}

/**
 * Abre EmuHawk con la ROM SMW y connector.lua. Antes arranca el bridge :23884.
 */
export async function launchSmwGameFromBridge() {
  const installDir = getSmwInstallDir();
  if (!installDir) {
    return { ok: false, error: 'mod_no_instalado' };
  }
  const exe = path.join(installDir, SMW_EXE);
  const lua = path.join(installDir, SMW_LUA);
  const rom = findRomInDir(installDir);
  if (!fs.existsSync(exe)) return { ok: false, error: 'sin_emuhawk' };
  if (!fs.existsSync(lua)) return { ok: false, error: 'sin_connector_lua' };
  if (!rom) return { ok: false, error: 'sin_rom' };

  patchSmwConnectorLua(installDir);
  await ensureSmwBridge();

  try {
    const child = spawn(exe, [`--lua=${lua}`, rom], {
      cwd: installDir,
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    child.unref();
    return {
      ok: true,
      via: 'emuhawk',
      exe,
      lua,
      rom,
      installDir,
      bridge: smwBridgeStatus(),
    };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : 'spawn_fallo' };
  }
}

/** Lista de comandos TCP para un thing del catálogo (o spawn:/msg: legacy). */
function resolveSmwCommands(thing) {
  const raw = String(thing || '').trim();
  if (!raw) return null;
  const seed = SMW_CATALOG_SEED.find((c) => c.id === raw);
  if (seed) {
    if (Array.isArray(seed.cmds) && seed.cmds.length) return seed.cmds.map((c) => ({ ...c }));
    if (seed.kind === 'message') return [{ type: CMD.message, message: seed.message || 'Livecoins' }];
    if (seed.sprite != null) return [spawnCmd(Number(seed.sprite) || 0x0F, seed)];
  }
  const m = raw.match(/^spawn:(0x[0-9a-fA-F]+|\d+)$/i);
  if (m) {
    const sprite = m[1].toLowerCase().startsWith('0x') ? parseInt(m[1], 16) : parseInt(m[1], 10);
    return [spawnCmd(sprite)];
  }
  if (raw.startsWith('msg:') || raw.startsWith('message:')) {
    return [{ type: CMD.message, message: raw.split(':').slice(1).join(':') || 'Livecoins' }];
  }
  if (raw.startsWith('{')) {
    try {
      const j = JSON.parse(raw);
      if (j && typeof j === 'object') return Array.isArray(j) ? j : [j];
    } catch { /* ignore */ }
  }
  return null;
}

function sendSmwBlock(partial, name) {
  return sendToClient({
    id: nextId(),
    stamp: Math.floor(Date.now() / 1000),
    uuid: randomUUID(),
    name: String(name || 'Viewer'),
    ...partial,
  });
}

/**
 * Parchea connector.lua instalado: add_u8 (0x18) para vidas/tiempo sin leer antes.
 * Idempotente.
 */
export function patchSmwConnectorLua(installDir = getSmwInstallDir()) {
  if (!installDir) return { ok: false, error: 'mod_no_instalado' };
  const luaPath = path.join(installDir, SMW_LUA);
  if (!fs.existsSync(luaPath)) return { ok: false, error: 'sin_connector_lua' };
  let src = fs.readFileSync(luaPath, 'utf8');
  if (src.includes('LIVECOINS_ADD_U8') || src.includes('commandType == 0x18')) {
    return { ok: true, patched: false, path: luaPath };
  }
  const marker = 'elseif commandType == 0x10 then -- write byte';
  if (!src.includes(marker)) return { ok: false, error: 'connector_formato_desconocido' };
  const inject = `elseif commandType == 0x18 then -- LIVECOINS_ADD_U8 add/sub byte
    local old = hal.read_u8(address, domain)
    local delta = tonumber(value) or 0
    local newv = old + delta
    if newv < 0 then newv = 0 end
    if newv > 255 then newv = 255 end
    -- dígitos del timer SMW ($0F31-$0F33) solo 0-9
    if address >= 0x0F31 and address <= 0x0F33 and newv > 9 then newv = 9 end
    hal.write_u8(address, newv, domain)
    result['value'] = newv

  ${marker}`;
  src = src.replace(marker, inject);
  fs.writeFileSync(luaPath, src, 'utf8');
  return { ok: true, patched: true, path: luaPath };
}

export async function smwSpawn(thing, name = '', times = 1) {
  // diagnose:false → si el bridge ya vive en el proceso del server (.exe),
  // no gastar 2–5 s en PowerShell; el caller (IPC) fallará rápido y usará HTTP.
  const ensured = await ensureSmwBridge({ diagnose: false });
  if (!ensured?.ok && ensured?.eaddrinuse) {
    return { ok: false, error: 'bridge_en_otro_proceso', eaddrinuse: true };
  }
  if (!client || client.destroyed) {
    return { ok: false, error: 'Abre BizHawk (Ejecutar juego) o carga Interactive/connector.lua' };
  }
  const cmds = resolveSmwCommands(thing);
  if (!cmds || !cmds.length) return { ok: false, error: 'sin_thing' };
  const t = Math.max(1, Math.min(40, Number(times) || 1));
  let last = { ok: false };
  let sent = 0;
  for (let i = 0; i < t; i += 1) {
    for (const cmd of cmds) {
      last = sendSmwBlock(cmd, name);
      if (!last.ok) return last;
      sent += 1;
    }
    if (i < t - 1 && SMW_SPAWN_GAP_MS > 0) {
      await new Promise((r) => setTimeout(r, SMW_SPAWN_GAP_MS));
    }
  }
  return { ok: true, sent, thing, times: t };
}
