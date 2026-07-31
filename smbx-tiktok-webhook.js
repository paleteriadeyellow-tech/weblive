/**
 * Webhook SMBX2 TikTok (puerto 5720) — igual que la app comercial.
 * Livecoins lo arranca al abrir la app y al iniciar el bridge Mario.
 */
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fireGdashEffectRequest, isGdash5721EffectUrl } from './gdash-effect.js';
import { isMari05720SpawnUrl } from './mari0-webhook-url.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEBHOOK_HOST = '127.0.0.1';
const WEBHOOK_PORT = Number(process.env.SMBX_WEBHOOK_PORT) || 5720;
const HEALTH_URL = `http://${WEBHOOK_HOST}:${WEBHOOK_PORT}/health`;

let webhookProc = null;
let webhookStarting = null;

function readSmbxRoot() {
  const candidates = [
    process.env.SMBX_ROOT,
    (() => {
      try {
        const cfg = path.join(process.env.LOCALAPPDATA || '', 'LivecoinsSMBX2Mod', 'smbx_root.txt');
        if (fs.existsSync(cfg)) return fs.readFileSync(cfg, 'utf8').trim();
      } catch { /* ignore */ }
      return '';
    })(),
    'C:\\Games\\SMBX2',
  ].filter(Boolean);
  for (const root of candidates) {
    if (fs.existsSync(path.join(root, 'data'))) return root;
  }
  return 'C:\\Games\\SMBX2';
}

export function getSmbxSpawnFile() {
  return path.join(readSmbxRoot(), 'data', 'tiktok_spawn.txt');
}

/** Misma sanitización que SMBX2 TikTok Webhook Setup 2.0.0 */
export function sanitizeSmbxUserName(raw) {
  let user = raw || '???';
  user = String(user).replace(/\|/g, ' ').replace(/[\r\n]/g, ' ');
  if (user.normalize) user = user.normalize('NFKD');
  user = user.replace(/[^\x20-\x7E]/g, '');
  if (!user.trim()) user = '???';
  return user.trim().slice(0, 32);
}

/** Escribe tiktok_spawn.txt directamente (spawns desde Livecoins con nickname real). */
export function writeSmbxSpawnFileDirect(npcId, qty = 1, name = '') {
  const id = Number(npcId);
  if (!Number.isFinite(id) || id < 1) return { ok: false, error: 'npc_invalido' };
  const q = Math.max(1, Number(qty) || 1);
  const userName = sanitizeSmbxUserName(String(name || '').trim() || '???');
  const nowMs = Date.now();
  const line = `${id}|${q}|${userName}|${nowMs}|${Math.floor(nowMs / 1000)}\n`;
  const spawnFile = getSmbxSpawnFile();
  fs.mkdirSync(path.dirname(spawnFile), { recursive: true });
  fs.writeFileSync(spawnFile, line, 'utf8');
  return { ok: true, userName, line: line.trim(), spawnFile };
}

function webhookScriptPaths() {
  const out = [];
  if (process.env.SMBX_WEBHOOK_SCRIPT) out.push(process.env.SMBX_WEBHOOK_SCRIPT);
  out.push(path.join(process.env.LOCALAPPDATA || '', 'LivecoinsSMBX2Mod', 'webhook', 'tiktok-webhook-server.js'));
  if (process.env.DESKTOP_RESOURCES) {
    out.push(path.join(process.env.DESKTOP_RESOURCES, 'smbx-webhook', 'tiktok-webhook-server.js'));
  }
  out.push(path.join(__dirname, 'desktop', 'smbx-webhook', 'tiktok-webhook-server.js'));
  return [...new Set(out.filter(Boolean))];
}

function findWebhookScript() {
  for (const p of webhookScriptPaths()) {
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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWebhookHealth() {
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

export function smbxWebhookHealthOk(j) {
  return !!(j && j.ok && Number(j.port) === WEBHOOK_PORT && j.spawnFile);
}

export async function isSmbxTiktokWebhookUp() {
  return smbxWebhookHealthOk(await fetchWebhookHealth());
}

function killPort5720() {
  if (process.platform !== 'win32') return;
  try {
    execSync(
      `powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort ${WEBHOOK_PORT} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"`,
      { stdio: 'ignore' },
    );
  } catch { /* ignore */ }
}

export function stopSmbxTiktokWebhook() {
  if (webhookProc && !webhookProc.killed) {
    try { webhookProc.kill(); } catch { /* ignore */ }
  }
  webhookProc = null;
}

export function isSmbx5720WebhookUrl(url) {
  return /(?:localhost|127\.0\.0\.1):5720\b/i.test(String(url || ''));
}

export function parseSmbx5720SpawnUrl(urlStr) {
  try {
    const u = new URL(String(urlStr || ''));
    if (!isSmbx5720WebhookUrl(u.href)) return null;
    if (!/\/spawn\b/i.test(u.pathname)) return null;
    const rawId = String(u.searchParams.get('id') ?? u.searchParams.get('npcId') ?? '');
    const qty = Math.max(1, Math.min(999, parseInt(u.searchParams.get('quantity') || u.searchParams.get('count') || '1', 10) || 1));
    let userName = u.searchParams.get('userName') || u.searchParams.get('nickname') || '???';
    try { userName = decodeURIComponent(userName); } catch { /* ignore */ }
    const ids = rawId.split(',').map((x) => parseInt(x.trim(), 10)).filter((n) => Number.isFinite(n) && n > 0);
    if (!ids.length) return null;
    return { ids, qty, userName };
  } catch {
    return null;
  }
}

async function sleepMs(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

/** Ejecuta webhook :5720 escribiendo directo en tiktok_spawn.txt para respuesta inmediata. */
export async function runSmbx5720WebhookExec(exec) {
  const url = String(exec?.url || '').replace(/localhost/gi, '127.0.0.1');
  const parsed = parseSmbx5720SpawnUrl(url);
  if (!parsed) return { ok: false, error: 'url_spawn_invalida' };

  ensureSmbxTiktokWebhook().catch(() => {});

  for (let i = 0; i < parsed.ids.length; i++) {
    const wr = writeSmbxSpawnFileDirect(parsed.ids[i], parsed.qty, parsed.userName);
    if (!wr.ok) return wr;
    if (i < parsed.ids.length - 1) await sleepMs(150);
  }
  return { ok: true, via: 'direct', count: parsed.ids.length };
}

export function isMari0EnemySpawnWebhook(url) {
  return isMari05720SpawnUrl(url);
}

export async function runWebhookExec(exec) {
  if (!exec || exec.tipo !== 'WEBHOOK') return { ok: false, error: 'sin_tipo' };
  const url = String(exec.url || '');
  if (!url) return { ok: false, error: 'sin_url' };
  // Mari0 activador: /spawn?enemy=… — nunca escribir tiktok_spawn.txt de SMBX2.
  if (isMari0EnemySpawnWebhook(url)) {
    const method = String(exec.method || 'GET').toUpperCase();
    const opts = { method };
    if (method === 'POST' && exec.body) {
      opts.body = exec.body;
      opts.headers = { 'Content-Type': 'application/json' };
    }
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      const r = await fetch(url, { ...opts, signal: ctrl.signal });
      clearTimeout(t);
      return r.ok ? { ok: true, via: 'mari0-enemy' } : { ok: false, error: `http_${r.status}` };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  }
  if (isSmbx5720WebhookUrl(url) && parseSmbx5720SpawnUrl(url)) return runSmbx5720WebhookExec(exec);
  if (isGdash5721EffectUrl(url)) {
    try {
      const u = new URL(url.replace(/localhost/gi, '127.0.0.1'));
      const code = u.searchParams.get('code') || '';
      const name = u.searchParams.get('name') || 'Viewer';
      const seconds = parseInt(u.searchParams.get('seconds') || '10', 10);
      return await fireGdashEffectRequest(code, name, seconds);
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  }
  const method = String(exec.method || 'GET').toUpperCase();
  const opts = { method };
  if (method === 'POST' && exec.body) {
    opts.body = exec.body;
    opts.headers = { 'Content-Type': 'application/json' };
  }
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    clearTimeout(t);
    return r.ok ? { ok: true } : { ok: false, error: `http_${r.status}` };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

export async function ensureSmbxTiktokWebhook() {
  const health = await fetchWebhookHealth();
  // Solo aceptar health SMBX real (puerto + spawnFile). Un {ok:true} de Mari0/MSlug en :5720 no cuenta.
  if (smbxWebhookHealthOk(health)) return true;
  if (webhookStarting) return webhookStarting;

  webhookStarting = (async () => {
    const script = findWebhookScript();
    if (!script) return false;

    killPort5720();
    await sleep(600);

    const { cmd, args, env } = nodeSpawnArgs(script);
    const cwd = path.dirname(script);

    try {
      webhookProc = spawn(cmd, args, {
        cwd,
        env: { ...env, WEBHOOK_PORT: String(WEBHOOK_PORT) },
        detached: false,
        stdio: 'ignore',
        windowsHide: true,
      });
      webhookProc.on('exit', () => { webhookProc = null; });
      webhookProc.on('error', () => { webhookProc = null; });
    } catch {
      webhookProc = null;
      return false;
    }

    for (let i = 0; i < 25; i++) {
      await sleep(200);
      if (await isSmbxTiktokWebhookUp()) return true;
    }
    return false;
  })();

  try {
    return await webhookStarting;
  } finally {
    webhookStarting = null;
  }
}

/** Spawn con nombre — escribe directo (Livecoins) y deja el webhook listo para TikFinity. */
export async function spawnSmbxTiktokFile(npcId, name, qty = 1) {
  await ensureSmbxTiktokWebhook().catch(() => {});
  return writeSmbxSpawnFileDirect(npcId, qty, name);
}

export function smbxTiktokWebhookStatus() {
  return {
    port: WEBHOOK_PORT,
    script: findWebhookScript(),
    spawnFile: getSmbxSpawnFile(),
    running: !!webhookProc && !webhookProc.killed,
  };
}

process.on('exit', stopSmbxTiktokWebhook);
