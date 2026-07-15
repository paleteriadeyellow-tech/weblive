/**
 * Bridge Livecoins ↔ PvZ clásico vía PvZ Toolkit (WS :3132, HTTP :7756).
 * Puerto distinto de Mario (:7755) y PvZ Hybrid (:7757).
 */
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findPvzToolsExe, stopPvzHybridBridge } from './pvz-hybrid-bridge.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_HOST = '127.0.0.1';
export const PVZ_TOOLKIT_HTTP_PORT = Number(process.env.PVZ_HTTP_PORT) || 7756;
const WS_PORT = Number(process.env.PVZ_WS_PORT) || 3132;
const HEALTH_URL = `http://${BRIDGE_HOST}:${PVZ_TOOLKIT_HTTP_PORT}/health`;

let bridgeProc = null;
let bridgeStarting = null;
let lastBridgeError = null;

function appServerRoot() {
  if (process.env.DESKTOP_RESOURCES) {
    return path.join(process.env.DESKTOP_RESOURCES, 'app-server');
  }
  return __dirname;
}

function bridgeScriptPaths() {
  const out = [];
  if (process.env.PVZ_TOOLKIT_BRIDGE_SCRIPT) out.push(process.env.PVZ_TOOLKIT_BRIDGE_SCRIPT);
  out.push(path.join(process.env.LOCALAPPDATA || '', 'LivecoinsPvZ', 'bridge', 'pvz-toolkit-bridge-server.js'));
  if (process.env.DESKTOP_RESOURCES) {
    out.push(path.join(process.env.DESKTOP_RESOURCES, 'pvz-bridge', 'pvz-toolkit-bridge-server.js'));
  }
  out.push(path.join(__dirname, 'desktop', 'pvz-bridge', 'pvz-toolkit-bridge-server.js'));
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

export function pvzToolkitBridgeHealthOk(j) {
  return !!(j && j.ok && j.api === 'livecoins-pvz-toolkit');
}

export async function isPvzToolkitBridgeUp() {
  return pvzToolkitBridgeHealthOk(await fetchHealth());
}

function killBridgePorts() {
  if (process.platform !== 'win32') return;
  try {
    execSync(
      `powershell -NoProfile -Command "${PVZ_TOOLKIT_HTTP_PORT},${WS_PORT} | ForEach-Object { Get-NetTCPConnection -LocalPort $_ -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue } }"`,
      { stdio: 'ignore' },
    );
  } catch { /* ignore */ }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function stopPvzToolkitBridge() {
  if (bridgeProc && !bridgeProc.killed) {
    try { bridgeProc.kill(); } catch { /* ignore */ }
  }
  bridgeProc = null;
}

export async function ensurePvzToolkitBridge() {
  if (await isPvzToolkitBridgeUp()) return true;
  if (bridgeStarting) return bridgeStarting;

  bridgeStarting = (async () => {
    lastBridgeError = null;
    const script = findBridgeScript();
    if (!script) {
      lastBridgeError = 'sin_script';
      return false;
    }

    stopPvzHybridBridge();
    killBridgePorts();
    await sleep(400);

    const { cmd, args, env } = nodeSpawnArgs(script);
    const scriptDir = path.dirname(script);
    const root = appServerRoot();
    const spawnEnv = {
      ...env,
      PVZ_HTTP_PORT: String(PVZ_TOOLKIT_HTTP_PORT),
      PVZ_WS_PORT: String(WS_PORT),
      NODE_PATH: [
        path.join(scriptDir, 'node_modules'),
        path.join(root, 'node_modules'),
        env.NODE_PATH || '',
      ].filter(Boolean).join(path.delimiter),
    };

    let exited = null;
    try {
      bridgeProc = spawn(cmd, args, {
        cwd: scriptDir,
        env: spawnEnv,
        detached: false,
        stdio: 'ignore',
        windowsHide: true,
      });
      bridgeProc.on('exit', (code) => {
        if (bridgeProc) exited = code;
        bridgeProc = null;
      });
      bridgeProc.on('error', (e) => {
        lastBridgeError = e?.message || 'spawn_error';
        bridgeProc = null;
      });
    } catch (e) {
      lastBridgeError = e?.message || 'spawn_error';
      bridgeProc = null;
      return false;
    }

    for (let i = 0; i < 50; i++) {
      if (exited != null && !(await isPvzToolkitBridgeUp())) {
        lastBridgeError = 'proceso_cerrado';
        return false;
      }
      if (i > 0) await sleep(120);
      if (await isPvzToolkitBridgeUp()) return true;
    }
    lastBridgeError = lastBridgeError || 'timeout';
    return false;
  })();

  try {
    return await bridgeStarting;
  } finally {
    bridgeStarting = null;
  }
}

export function pvzToolkitBridgeStatus() {
  return {
    httpPort: PVZ_TOOLKIT_HTTP_PORT,
    wsPort: WS_PORT,
    script: findBridgeScript(),
    toolsExe: findPvzToolsExe(),
    running: !!bridgeProc && !bridgeProc.killed,
    lastError: lastBridgeError,
  };
}

export async function pvzToolkitBridgeHealth() {
  return fetchHealth();
}

process.on('exit', stopPvzToolkitBridge);
