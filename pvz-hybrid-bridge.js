/**
 * Bridge Livecoins ↔ PvZ Hybrid vía PvZ Tools (WS :3132, HTTP :7757).
 */
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_HOST = '127.0.0.1';
const HTTP_PORT = Number(process.env.PVZ_HYBRID_HTTP_PORT) || 7757;
const WS_PORT = Number(process.env.PVZ_HYBRID_WS_PORT) || 3132;
const HEALTH_URL = `http://${BRIDGE_HOST}:${HTTP_PORT}/health`;

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
  if (process.env.PVZ_HYBRID_BRIDGE_SCRIPT) out.push(process.env.PVZ_HYBRID_BRIDGE_SCRIPT);
  out.push(path.join(process.env.LOCALAPPDATA || '', 'LivecoinsPvZHybrid', 'bridge', 'pvz-hybrid-bridge-server.js'));
  if (process.env.DESKTOP_RESOURCES) {
    out.push(path.join(process.env.DESKTOP_RESOURCES, 'pvz-hybrid-bridge', 'pvz-hybrid-bridge-server.js'));
  }
  out.push(path.join(__dirname, 'desktop', 'pvz-hybrid-bridge', 'pvz-hybrid-bridge-server.js'));
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

export function pvzHybridBridgeHealthOk(j) {
  return !!(j && j.ok && j.api === 'livecoins-pvz-hybrid');
}

export async function isPvzHybridBridgeUp() {
  return pvzHybridBridgeHealthOk(await fetchHealth());
}

function killBridgePorts() {
  if (process.platform !== 'win32') return;
  try {
    execSync(
      `powershell -NoProfile -Command "${HTTP_PORT},${WS_PORT},7756 | ForEach-Object { Get-NetTCPConnection -LocalPort $_ -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue } }"`,
      { stdio: 'ignore' },
    );
  } catch { /* ignore */ }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function stopPvzHybridBridge() {
  if (bridgeProc && !bridgeProc.killed) {
    try { bridgeProc.kill(); } catch { /* ignore */ }
  }
  bridgeProc = null;
}

export async function ensurePvzHybridBridge() {
  if (await isPvzHybridBridgeUp()) return true;
  if (bridgeStarting) return bridgeStarting;

  bridgeStarting = (async () => {
    lastBridgeError = null;
    const script = findBridgeScript();
    if (!script) {
      lastBridgeError = 'sin_script';
      return false;
    }

    try {
      const { stopPvzToolkitBridge } = await import('./pvz-toolkit-bridge.js');
      stopPvzToolkitBridge();
    } catch { /* ignore */ }

    killBridgePorts();
    await sleep(400);

    const { cmd, args, env } = nodeSpawnArgs(script);
    const scriptDir = path.dirname(script);
    const root = appServerRoot();
    const spawnEnv = {
      ...env,
      PVZ_HYBRID_HTTP_PORT: String(HTTP_PORT),
      PVZ_HYBRID_WS_PORT: String(WS_PORT),
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
      if (exited != null && !(await isPvzHybridBridgeUp())) {
        lastBridgeError = 'proceso_cerrado';
        return false;
      }
      if (i > 0) await sleep(120);
      if (await isPvzHybridBridgeUp()) return true;
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

export function pvzToolsExePaths() {
  const out = [];
  if (process.env.PVZ_TOOLS_EXE) out.push(process.env.PVZ_TOOLS_EXE);
  try {
    const cfg = path.join(process.env.LOCALAPPDATA || '', 'LivecoinsPvZ', 'pvz_tools_exe.txt');
    if (fs.existsSync(cfg)) {
      const p = fs.readFileSync(cfg, 'utf8').trim();
      if (p) out.push(p);
    }
  } catch { /* ignore */ }
  try {
    const cfg = path.join(process.env.LOCALAPPDATA || '', 'LivecoinsPvZHybrid', 'pvz_tools_exe.txt');
    if (fs.existsSync(cfg)) {
      const p = fs.readFileSync(cfg, 'utf8').trim();
      if (p) out.push(p);
    }
  } catch { /* ignore */ }
  out.push('C:\\Users\\Admin\\Downloads\\PvZ.Tools.v2.6 (1).exe');
  if (process.env.DESKTOP_RESOURCES) {
    out.push(path.join(process.env.DESKTOP_RESOURCES, 'pvz-hybrid-bridge', 'PvZ.Tools.exe'));
  }
  out.push(path.join(__dirname, 'desktop', 'pvz-hybrid-bridge', 'PvZ.Tools.exe'));
  return [...new Set(out.filter(Boolean))];
}

export function findPvzToolsExe() {
  for (const p of pvzToolsExePaths()) {
    try {
      if (fs.existsSync(p)) return p;
    } catch { /* ignore */ }
  }
  return null;
}

export function pvzHybridGamePaths() {
  const out = [];
  if (process.env.PVZ_HYBRID_GAME_DIR) out.push(process.env.PVZ_HYBRID_GAME_DIR);
  try {
    const cfg = path.join(process.env.LOCALAPPDATA || '', 'LivecoinsPvZHybrid', 'game_dir.txt');
    if (fs.existsSync(cfg)) {
      const p = fs.readFileSync(cfg, 'utf8').trim();
      if (p) out.push(p);
    }
  } catch { /* ignore */ }
  out.push('C:\\Users\\Admin\\Downloads\\PVZ.HYBRID.v3.6\\PVZ HYBRID v3.6');
  if (process.env.DESKTOP_RESOURCES) {
    out.push(path.join(process.env.DESKTOP_RESOURCES, 'pvz-hybrid-game'));
  }
  out.push(path.join(__dirname, 'desktop', 'pvz-hybrid-game'));
  return [...new Set(out.filter(Boolean))];
}

export function findPvzHybridExe() {
  for (const dir of pvzHybridGamePaths()) {
    try {
      if (!fs.existsSync(dir)) continue;
      let best = null;
      const walk = (d, depth) => {
        let entries = [];
        try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          const full = path.join(d, e.name);
          if (e.isFile() && e.name.toLowerCase().endsWith('.exe')) {
            const low = e.name.toLowerCase();
            if (low.includes('unins') || low.includes('setup') || low.includes('tools')) continue;
            if (!best) best = full;
            if (low.includes('hybrid') || low.includes('plant') || low.includes('zombie') || low.includes('pvz')) best = full;
          } else if (e.isDirectory() && depth < 2) {
            walk(full, depth + 1);
          }
        }
      };
      walk(dir, 0);
      if (best) return best;
    } catch { /* ignore */ }
  }
  return null;
}

export function pvzHybridBridgeStatus() {
  return {
    httpPort: HTTP_PORT,
    wsPort: WS_PORT,
    script: findBridgeScript(),
    toolsExe: findPvzToolsExe(),
    gameExe: findPvzHybridExe(),
    running: !!bridgeProc && !bridgeProc.killed,
    lastError: lastBridgeError,
  };
}

export async function pvzHybridBridgeHealth() {
  return fetchHealth();
}

process.on('exit', stopPvzHybridBridge);
