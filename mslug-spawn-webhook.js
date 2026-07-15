/**
 * Gestor del webhook Metal Slug (:7760) — mismo patrón que smbx-tiktok-webhook.
 */
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMari0SpawnEnemyName } from './mari0-webhook-url.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEBHOOK_HOST = '127.0.0.1';
export const MSLUG_WEBHOOK_PORT = Number(process.env.MSLUG_WEBHOOK_PORT) || 5720;
/** URL base para spawns (mismo patrón que Mario :5720). */
export const MSLUG_WEBHOOK_SPAWN_BASE = `http://${WEBHOOK_HOST}:${MSLUG_WEBHOOK_PORT}`;
const HEALTH_URL = `${MSLUG_WEBHOOK_SPAWN_BASE}/health`;

let webhookProc = null;
let webhookStarting = null;

function readSavedGameDir() {
  try {
    const f = path.join(process.env.LOCALAPPDATA || '', 'LivecoinsMslug', 'game_dir.txt');
    if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  } catch { /* ignore */ }
  return '';
}

/** Ruta donde el juego lee spawn_cmd.txt (…/METAL SLUG CLIENTES/bridge). Solo lectura/escritura en runtime. */
export function getMslugBridgeDirForGame(gameDir) {
  const dir = String(gameDir || readSavedGameDir() || '').trim();
  if (!dir) return '';
  return path.join(path.resolve(dir), 'bridge');
}

function webhookDirPaths() {
  const out = [];
  if (process.env.MSLUG_WEBHOOK_DIR) out.push(process.env.MSLUG_WEBHOOK_DIR);
  if (process.env.DESKTOP_RESOURCES) {
    out.push(path.join(process.env.DESKTOP_RESOURCES, 'mslug-webhook'));
  }
  out.push(path.join(__dirname, 'desktop', 'mslug-webhook'));
  return [...new Set(out.filter(Boolean))];
}

function webhookScriptPaths() {
  const out = [];
  if (process.env.MSLUG_WEBHOOK_SCRIPT) out.push(process.env.MSLUG_WEBHOOK_SCRIPT);
  for (const dir of webhookDirPaths()) {
    out.push(path.join(dir, 'mslug-spawn-webhook.js'));
  }
  out.push(path.join(process.env.LOCALAPPDATA || '', 'LivecoinsMslug', 'webhook', 'mslug-spawn-webhook.js'));
  return [...new Set(out.filter(Boolean))];
}

export function findMslugWebhookScript() {
  for (const p of webhookScriptPaths()) {
    try {
      if (fs.existsSync(p)) return p;
    } catch { /* ignore */ }
  }
  return null;
}

export function findMslugWebhookBat() {
  for (const dir of webhookDirPaths()) {
    const bat = path.join(dir, 'iniciar-webhook.cmd');
    try {
      if (fs.existsSync(bat)) return bat;
    } catch { /* ignore */ }
  }
  return null;
}

function nodeCmd() {
  if (process.env.ELECTRON_RUN_AS_NODE === '1' || process.versions.electron) {
    return { cmd: process.execPath, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } };
  }
  return { cmd: process.env.NODE || 'node', env: process.env };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function fetchMslugWebhookHealth() {
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

export async function fetchMslugBridgeStatus() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 900);
    const r = await fetch(`${MSLUG_WEBHOOK_SPAWN_BASE}/status`, { signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

export function mslugWebhookHealthOk(j) {
  return !!(j && j.ok && (
    j.api === 'livecoins-mslug-webhook'
    || j.api === 'pulse-v4'
    || j.api === 'mslug-interactivo-bridge'
  ));
}

export function mslugBridgeStatusOk(j) {
  return !!(j && j.ok && j.running);
}

export async function isMslugSpawnWebhookUp() {
  if (mslugWebhookHealthOk(await fetchMslugWebhookHealth())) return true;
  return mslugBridgeStatusOk(await fetchMslugBridgeStatus());
}

function killPort7760() {
  if (process.platform !== 'win32') return;
  try {
    execSync(
      `powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort ${MSLUG_WEBHOOK_PORT} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"`,
      { stdio: 'ignore' },
    );
  } catch { /* ignore */ }
}

export function stopMslugSpawnWebhook() {
  if (webhookProc && !webhookProc.killed) {
    try { webhookProc.kill(); } catch { /* ignore */ }
  }
  webhookProc = null;
}

/** Abre ventana CMD visible con el webhook (Windows). Solo depuración manual. */
export function launchMslugWebhookVisibleWindow() {
  if (process.platform !== 'win32') return false;
  const bat = findMslugWebhookBat();
  if (!bat) return false;
  const batDir = path.dirname(bat);
  const batName = path.basename(bat);
  try {
    execSync(`start "Livecoins MSlug Bridge :5720" cmd /k "${batName}"`, {
      cwd: batDir,
      windowsHide: false,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {{ visible?: boolean, forceWindow?: boolean, gameDir?: string }} opts
 * Inicia el bridge HTTP :5720 dentro de Livecoins (mismo rol que Metal Slug Bridge.exe).
 */
export async function ensureMslugSpawnWebhook({ visible = false, forceWindow = false, gameDir = '' } = {}) {
  if (!forceWindow && await isMslugSpawnWebhookUp()) return true;
  if (webhookStarting) return webhookStarting;

  webhookStarting = (async () => {
    const resolvedDir = String(gameDir || process.env.MSLUG_GAME_DIR || readSavedGameDir() || '').trim();
    const bridgeDir = resolvedDir ? getMslugBridgeDirForGame(resolvedDir) : '';
    if (resolvedDir) {
      try {
        const dirFile = path.join(process.env.LOCALAPPDATA || '', 'LivecoinsMslug', 'game_dir.txt');
        fs.mkdirSync(path.dirname(dirFile), { recursive: true });
        fs.writeFileSync(dirFile, resolvedDir, 'utf8');
      } catch { /* ignore */ }
    }

    const script = findMslugWebhookScript();
    if (!script) return false;
    if (!bridgeDir) return false;

    if (!forceWindow && mslugBridgeStatusOk(await fetchMslugBridgeStatus())) return true;

    killPort7760();
    stopMslugSpawnWebhook();
    await sleep(500);

    const childEnv = {
      ...process.env,
      MSLUG_WEBHOOK_PORT: String(MSLUG_WEBHOOK_PORT),
      MSLUG_GAME_DIR: resolvedDir,
      MSLUG_BRIDGE_DIR: bridgeDir,
    };

    let launched = false;
    if (process.platform === 'win32' && visible) {
      launched = launchMslugWebhookVisibleWindow();
    }

    if (!launched) {
      const { cmd, env } = nodeCmd();
      const cwd = path.dirname(script);
      try {
        webhookProc = spawn(cmd, [script], {
          cwd,
          env: { ...env, ...childEnv },
          detached: false,
          stdio: 'ignore',
          windowsHide: true,
        });
        webhookProc.on('exit', () => { webhookProc = null; });
        webhookProc.on('error', () => { webhookProc = null; });
        launched = true;
      } catch {
        webhookProc = null;
        return false;
      }
    }

    for (let i = 0; i < 45; i++) {
      await sleep(300);
      if (await isMslugSpawnWebhookUp()) return true;
    }
    return false;
  })();

  try {
    return await webhookStarting;
  } finally {
    webhookStarting = null;
  }
}

export function buildMslug7760SpawnUrl(thing, qty, userName) {
  const url = new URL(`${MSLUG_WEBHOOK_SPAWN_BASE}/spawn`);
  url.searchParams.set('enemy', String(thing || '').trim());
  url.searchParams.set('quantity', String(Math.max(1, Math.min(50, parseInt(qty, 10) || 1))));
  url.searchParams.set('nickname', String(userName || 'Viewer').trim() || 'Viewer');
  return url.href;
}

export function isMslug7760WebhookUrl(urlStr) {
  const parsed = parseMslug7760SpawnUrl(urlStr);
  if (!parsed) return false;
  if (isMari0SpawnEnemyName(parsed.thing)) return false;
  return true;
}

export function parseMslug7760SpawnUrl(urlStr) {
  try {
    const u = new URL(String(urlStr || '').replace(/localhost/gi, '127.0.0.1'));
    if (!isMslug7760WebhookUrl(u.href)) return null;
    const thing = String(u.searchParams.get('thing') || u.searchParams.get('enemy') || '').trim();
    const qty = Math.max(1, Math.min(50, parseInt(
      u.searchParams.get('quantity') || u.searchParams.get('times') || u.searchParams.get('qty') || '1',
      10,
    ) || 1));
    const name = String(
      u.searchParams.get('userName') || u.searchParams.get('nickname') || u.searchParams.get('name') || 'Viewer',
    ).trim();
    if (!thing) return null;
    return { thing, qty, name: name || 'Viewer' };
  } catch {
    return null;
  }
}

export async function runMslug7760Spawn(thing, name, times = 1) {
  if (!await isMslugSpawnWebhookUp()) {
    return { ok: false, error: 'webhook_no_disponible' };
  }
  return mslugSpawnViaWebhook(thing, name, times);
}

export async function runMslug7760WebhookExec(exec) {
  const parsed = parseMslug7760SpawnUrl(exec?.url);
  if (!parsed) return { ok: false, error: 'url_spawn_invalida' };
  return runMslug7760Spawn(parsed.thing, parsed.name, parsed.qty);
}

export async function mslugSpawnViaWebhook(thing, name, times = 1) {
  const up = await isMslugSpawnWebhookUp();
  if (!up) return { ok: false, error: 'webhook_no_disponible' };
  const q = Math.max(1, Math.min(50, parseInt(times, 10) || 1));
  const url = buildMslug7760SpawnUrl(thing, q, name);
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 60000);
    const r = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    const data = await r.json().catch(() => ({}));
    if (!r.ok || data.ok === false) {
      return { ok: false, error: data.error || `http_${r.status}`, url, ...data };
    }
    return { ...data, ok: data.ok !== false, url, via: 'webhook' };
  } catch (e) {
    return { ok: false, error: String(e?.message || e), url };
  }
}

export function mslugSpawnWebhookStatus() {
  return {
    port: MSLUG_WEBHOOK_PORT,
    spawnBase: MSLUG_WEBHOOK_SPAWN_BASE,
    script: findMslugWebhookScript(),
    bat: findMslugWebhookBat(),
    running: !!webhookProc && !webhookProc.killed,
    healthUrl: HEALTH_URL,
  };
}

process.on('exit', stopMslugSpawnWebhook);
