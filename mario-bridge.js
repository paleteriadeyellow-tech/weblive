/**
 * Bridge Livecoins ↔ SMBX2 / Mari0 — solo se arranca bajo demanda.
 * Escucha en 127.0.0.1:7755 (misma API que game-local.js).
 */
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureSmbxTiktokWebhook, smbxTiktokWebhookStatus } from './smbx-tiktok-webhook.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_HOST = '127.0.0.1';
const BRIDGE_PORT = Number(process.env.MARIO_BRIDGE_PORT) || 7755;
const HEALTH_URL = `http://${BRIDGE_HOST}:${BRIDGE_PORT}/health`;

let bridgeProc = null;
let bridgeStarting = null;
let bridgeMode = null; // 'smbx' | 'mari0'

function bridgeScriptPaths() {
  const out = [];
  if (process.env.MARIO_BRIDGE_SCRIPT) out.push(process.env.MARIO_BRIDGE_SCRIPT);
  out.push(path.join(process.env.LOCALAPPDATA || '', 'LivecoinsMari0', 'bridge', 'livecoins-bridge-server.js'));
  if (process.env.DESKTOP_RESOURCES) {
    out.push(path.join(process.env.DESKTOP_RESOURCES, 'mario-bridge', 'livecoins-bridge-server.js'));
  }
  out.push(path.join(__dirname, 'desktop', 'mario-bridge', 'livecoins-bridge-server.js'));
  out.push(path.join(process.env.LOCALAPPDATA || '', 'LivecoinsSMBX2Mod', 'bridge', 'livecoins-bridge-server.js'));
  out.push('C:\\Users\\Admin\\Desktop\\mario2\\LivecoinsSMBX2Mod\\bridge\\livecoins-bridge-server.js');
  return [...new Set(out.filter(Boolean))];
}

function findBridgeScript() {
  for (const p of bridgeScriptPaths()) {
    try {
      if (fs.existsSync(p)) return p;
    } catch { /* ignore */ }
  }
  return null;
}

function nodeSpawnArgs(scriptPath) {
  if (process.env.ELECTRON_RUN_AS_NODE === '1' || process.versions.electron) {
    return {
      cmd: process.execPath,
      args: [scriptPath],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    };
  }
  return {
    cmd: process.env.NODE || 'node',
    args: [scriptPath],
    env: process.env,
  };
}

async function fetchHealth() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 900);
    const r = await fetch(HEALTH_URL, { signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

function readInstalledSmbxRoot() {
  try {
    const cfg = path.join(process.env.LOCALAPPDATA || '', 'LivecoinsSMBX2Mod', 'smbx_root.txt');
    if (fs.existsSync(cfg)) {
      const root = fs.readFileSync(cfg, 'utf8').trim();
      if (root) return root;
    }
  } catch { /* ignore */ }
  return null;
}

function defaultEpisodeDir() {
  if (process.env.SMBX_EPISODE_DIR) return process.env.SMBX_EPISODE_DIR;
  const root = readInstalledSmbxRoot();
  if (root) return path.join(root, 'data', 'worlds', 'cliche');
  return 'C:\\Games\\SMBX2\\data\\worlds\\cliche';
}

function expectedSpawnQueuePath() {
  return path.join(defaultEpisodeDir(), 'spawn_queue.txt').replace(/\//g, '\\').toLowerCase();
}

/** Comprueba si el bridge activo coincide con el modo pedido. */
export function bridgeHealthOk(j, mode = 'smbx') {
  if (!j || !j.ok || j.api !== 'livecoins') return false;
  const targets = Array.isArray(j.targets) ? j.targets : [];
  if (mode === 'mari0') {
    return !!(j.mari0?.enabled && (j.mari0?.only || targets.includes('mari0')));
  }
  if (j.mari0?.only || (targets.length === 1 && targets[0] === 'mari0')) return false;
  if (targets.includes('smbx2') || targets.includes('smb3-poll')) return true;
  const sq = String(j.spawnQueue || '').replace(/\//g, '\\').toLowerCase();
  if (!sq) return true;
  if (sq.includes('_livecoins')) return true;
  return sq === expectedSpawnQueuePath();
}

export async function isMarioBridgeUp() {
  return bridgeHealthOk(await fetchHealth(), 'smbx');
}

export async function isMari0BridgeUp() {
  return bridgeHealthOk(await fetchHealth(), 'mari0');
}

function killBridgeOnPort() {
  if (process.platform !== 'win32') return;
  try {
    execSync(
      `powershell -NoProfile -Command "7755,28379 | ForEach-Object { Get-NetTCPConnection -LocalPort $_ -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue } }"`,
      { stdio: 'ignore' },
    );
  } catch { /* ignore */ }
}

async function portUsedByOther() {
  const j = await fetchHealth();
  return !!(j && j.ok && j.api !== 'livecoins');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function stopMarioBridge() {
  if (bridgeProc && !bridgeProc.killed) {
    try { bridgeProc.kill(); } catch { /* ignore */ }
  }
  bridgeProc = null;
  bridgeMode = null;
}

async function ensureBridgeMode(mode) {
  const health = await fetchHealth();
  if (health && health.ok && health.api === 'livecoins') {
    if (bridgeHealthOk(health, mode)) {
      bridgeMode = mode;
      return true;
    }
    stopMarioBridge();
    killBridgeOnPort();
    await sleep(400);
  }
  if (await (mode === 'mari0' ? isMari0BridgeUp() : isMarioBridgeUp())) {
    bridgeMode = mode;
    return true;
  }
  if (await portUsedByOther()) return false;
  if (bridgeStarting) return bridgeStarting;

  bridgeStarting = (async () => {
    const script = findBridgeScript();
    if (!script) return false;

    killBridgeOnPort();
    await sleep(400);

    const { cmd, args, env } = nodeSpawnArgs(script);
    const cwd = path.dirname(script);
    const spawnEnv = {
      ...env,
      BRIDGE_PORT: String(BRIDGE_PORT),
    };
    if (mode === 'mari0') {
      spawnEnv.MARI0_ENABLED = '1';
      spawnEnv.MARI0_ONLY = '1';
    } else {
      spawnEnv.MARI0_ENABLED = '0';
      spawnEnv.MARI0_ONLY = '0';
      const ep = defaultEpisodeDir();
      spawnEnv.SMBX_EPISODE_DIR = ep;
      spawnEnv.SMBX_QUEUE_DIR = ep;
    }

    try {
      bridgeProc = spawn(cmd, args, {
        cwd,
        env: spawnEnv,
        detached: false,
        stdio: 'ignore',
        windowsHide: true,
      });
      bridgeProc.on('exit', () => { bridgeProc = null; bridgeMode = null; });
      bridgeProc.on('error', () => { bridgeProc = null; bridgeMode = null; });
      bridgeMode = mode;
    } catch {
      bridgeProc = null;
      bridgeMode = null;
      return false;
    }

    const check = mode === 'mari0' ? isMari0BridgeUp : isMarioBridgeUp;
    for (let i = 0; i < 40; i++) {
      if (i > 0) await sleep(100);
      if (await check()) return true;
    }
    return false;
  })();

  try {
    return await bridgeStarting;
  } finally {
    bridgeStarting = null;
  }
}

export async function ensureMarioBridge() {
  const ok = await ensureBridgeMode('smbx');
  if (ok) await ensureSmbxTiktokWebhook();
  return ok;
}

export async function ensureMari0Bridge() {
  return ensureBridgeMode('mari0');
}

export function marioBridgeStatus() {
  return {
    port: BRIDGE_PORT,
    script: findBridgeScript(),
    running: !!bridgeProc && !bridgeProc.killed,
    mode: bridgeMode,
    smbxWebhook: smbxTiktokWebhookStatus(),
  };
}

process.on('exit', stopMarioBridge);
