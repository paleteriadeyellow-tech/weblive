/**
 * Livecoins ↔ Crash Team Racing (BizHawk, HTTP :19150 → command.txt).
 */
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CTR_HOST = '127.0.0.1';
export const CTR_HTTP_PORT = Number(process.env.CTR_HTTP_PORT) || 19150;
const STATUS_URL = `http://${CTR_HOST}:${CTR_HTTP_PORT}/status`;
const WEBHOOK_URL = `http://${CTR_HOST}:${CTR_HTTP_PORT}/webhook`;

let bridgeProc = null;
let bridgeStarting = null;
let lastBridgeError = null;

export const CTR_VALID_EVENTS = [
  'turbo', 'bomb', 'missile', 'crate', 'beaker', 'spring', 'shield', 'mask',
  'clock', 'orb', 'triplebomb', 'triplemissile', 'invis', 'engine',
  'slow', 'brake', 'noboost', 'spin', 'left', 'right', 'fire', 'burn',
  'burn_visual', 'rearcam', 'rescuecam',
];

export const CTR_SPAWN_MAX = 80;
const BURST_GAP_MS = 200;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function bridgeScriptPaths() {
  const out = [];
  if (process.env.CTR_BRIDGE_SCRIPT) out.push(process.env.CTR_BRIDGE_SCRIPT);
  out.push(path.join(process.env.LOCALAPPDATA || '', 'LivecoinsCTR', 'bridge', 'ctr-bridge-server.js'));
  if (process.env.DESKTOP_RESOURCES) {
    out.push(path.join(process.env.DESKTOP_RESOURCES, 'ctr-bridge', 'ctr-bridge-server.js'));
  }
  out.push(path.join(__dirname, 'desktop', 'ctr-bridge', 'ctr-bridge-server.js'));
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

function killBridgePort() {
  if (process.platform !== 'win32') return;
  try {
    execSync(
      `powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort ${CTR_HTTP_PORT} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"`,
      { stdio: 'ignore' },
    );
  } catch { /* ignore */ }
}

export function ctrBridgeHealthOk(j) {
  return !!(j && j.running);
}

export function ctrBridgeStatus() {
  return {
    port: CTR_HTTP_PORT,
    script: findBridgeScript() || null,
    pid: bridgeProc?.pid || null,
    lastError: lastBridgeError,
  };
}

export function stopCtrBridge() {
  if (bridgeProc && !bridgeProc.killed) {
    try { bridgeProc.kill(); } catch { /* ignore */ }
  }
  bridgeProc = null;
}

export async function ensureCtrBridge() {
  const health = await ctrBridgeHealth();
  if (ctrBridgeHealthOk(health)) return true;
  if (bridgeStarting) return bridgeStarting;

  bridgeStarting = (async () => {
    lastBridgeError = null;
    const script = findBridgeScript();
    if (!script) {
      lastBridgeError = 'sin_script';
      return false;
    }

    stopCtrBridge();
    killBridgePort();
    await sleep(350);

    const { cmd, args, env } = nodeSpawnArgs(script);
    try {
      bridgeProc = spawn(cmd, args, {
        env,
        stdio: 'ignore',
        windowsHide: true,
        detached: false,
      });
      const proc = bridgeProc;
      bridgeProc.on('exit', () => {
        if (bridgeProc === proc) bridgeProc = null;
      });
    } catch (e) {
      lastBridgeError = String(e?.message || e);
      return false;
    }

    for (let i = 0; i < 24; i += 1) {
      await sleep(250);
      const h = await ctrBridgeHealth();
      if (ctrBridgeHealthOk(h)) return true;
    }
    lastBridgeError = 'timeout';
    return false;
  })();

  try {
    return await bridgeStarting;
  } finally {
    bridgeStarting = null;
  }
}

function normalizeEvent(thing) {
  const ev = String(thing || '').toLowerCase().trim();
  if (!ev) return '';
  if (ev === 'rescuecam') return 'rearcam';
  return CTR_VALID_EVENTS.includes(ev) ? ev : '';
}

export async function ctrBridgeHealth() {
  try {
    const r = await fetch(STATUS_URL, { signal: AbortSignal.timeout(2500) });
    if (!r.ok) return { ok: false, running: false, status: r.status };
    const d = await r.json().catch(() => ({}));
    return {
      ok: true,
      running: !!d.running,
      port: d.port || CTR_HTTP_PORT,
      bridgeDir: d.bridgeDir || '',
      commandFile: d.commandFile || '',
      validEvents: Array.isArray(d.validEvents) ? d.validEvents : CTR_VALID_EVENTS,
    };
  } catch (e) {
    return { ok: false, running: false, error: String(e?.message || e || 'sin_conexion') };
  }
}

export async function ctrWebhook(event) {
  const ev = normalizeEvent(event);
  if (!ev) return { ok: false, error: 'evento_invalido', received: event };
  const url = `${WEBHOOK_URL}?event=${encodeURIComponent(ev)}`;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '',
      signal: AbortSignal.timeout(4000),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      return {
        ok: false,
        error: d.error || `http_${r.status}`,
        received: ev,
        validEvents: d.validEvents,
      };
    }
    return { ok: true, event: ev, written: d.written || ev, method: d.method || 'POST' };
  } catch (e) {
    return { ok: false, error: String(e?.message || e || 'sin_conexion'), received: ev };
  }
}

let ctrSpawnChain = Promise.resolve();

export async function ctrSpawn(thing, _name, times = 1) {
  const ev = normalizeEvent(thing);
  if (!ev) return { ok: false, error: 'evento_invalido', thing };
  const n = Math.min(CTR_SPAWN_MAX, Math.max(1, Number(times) || 1));
  const job = ctrSpawnChain.then(async () => {
    let last = { ok: false };
    for (let i = 0; i < n; i++) {
      last = await ctrWebhook(ev);
      if (!last.ok) return last;
      if (i < n - 1) await sleep(BURST_GAP_MS);
    }
    return { ok: true, sent: n, event: ev, last };
  });
  ctrSpawnChain = job.catch(() => {});
  return job;
}
