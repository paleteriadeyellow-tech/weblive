/**
 * Livecoins ↔ LiveCoinsCore (plugin Paper, WebSocket en 127.0.0.1:4043).
 * El plugin pide {"email":"..."} y valida contra Supabase; los admins pueden
 * activarse también vía RCON: /livecoinscore activate <email>
 */
import WebSocket from 'ws';
import net from 'node:net';
import { sendRcon } from './integrations.js';

const MC_CORE_WS_PORT = Number(process.env.MC_CORE_WS_PORT) || 4043;
const MC_CORE_WS_HOST = process.env.MC_CORE_WS_HOST || '127.0.0.1';
const MC_CORE_AUTH_TIMEOUT_MS = Number(process.env.MC_CORE_AUTH_TIMEOUT_MS) || 12000;
const MC_CORE_RECONNECT_MS = Number(process.env.MC_CORE_RECONNECT_MS) || 8000;

let ws = null;
let wsEmail = '';
let wsLicensed = false;
let wsLastError = '';
let wsConnecting = false;
let reconnectTimer = null;
let keepAlive = false;

export function resolveMcCoreLicenseEmail(user, override) {
  const ov = String(override || '').trim();
  if (ov) return ov;
  const mail = String(user?.googleEmail || '').trim();
  if (mail) return mail;
  return String(user?.username || '').trim();
}

function mcCoreWsUrl() {
  return `ws://${MC_CORE_WS_HOST}:${MC_CORE_WS_PORT}`;
}

async function mcCoreTcpReachable() {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host: MC_CORE_WS_HOST, port: MC_CORE_WS_PORT });
    const done = (ok) => { try { sock.destroy(); } catch {} resolve(ok); };
    sock.setTimeout(1500);
    sock.on('connect', () => done(true));
    sock.on('error', () => done(false));
    sock.on('timeout', () => done(false));
  });
}

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function closeWs() {
  if (!ws) return;
  try {
    ws.removeAllListeners();
    ws.close();
  } catch { /* ignore */ }
  ws = null;
}

function scheduleReconnect() {
  if (!keepAlive || !wsEmail || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (keepAlive && wsEmail) connectMcCoreWs(wsEmail).catch(() => {});
  }, MC_CORE_RECONNECT_MS);
}

function connectMcCoreWs(email) {
  const mail = String(email || '').trim();
  if (!mail) return Promise.resolve({ ok: false, error: 'sin_email' });
  if (ws && ws.readyState === WebSocket.OPEN && wsEmail === mail && wsLicensed) {
    return Promise.resolve({ ok: true, licensed: true, via: 'ws_cached' });
  }

  return new Promise((resolve) => {
    wsConnecting = true;
    keepAlive = true;
    wsEmail = mail;
    wsLicensed = false;
    wsLastError = '';
    clearReconnectTimer();
    closeWs();

    let settled = false;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      wsConnecting = false;
      resolve(r);
    };
    const timer = setTimeout(() => {
      wsLastError = 'timeout';
      finish({ ok: false, error: 'plugin_no_responde', via: 'ws' });
      scheduleReconnect();
    }, MC_CORE_AUTH_TIMEOUT_MS);

    try {
      const sock = new WebSocket(mcCoreWsUrl());
      ws = sock;

      sock.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(String(raw)); } catch { return; }
        const status = String(msg?.status || '');
        const action = String(msg?.action || '');

        if (action === 'request_auth' && !wsLicensed) {
          sock.send(JSON.stringify({ email: mail }));
          return;
        }
        if (status === 'auth_success') {
          wsLicensed = true;
          wsLastError = '';
          clearTimeout(timer);
          finish({ ok: true, licensed: true, via: 'ws', message: msg.message });
          return;
        }
        if (status === 'auth_failed') {
          wsLicensed = false;
          wsLastError = String(msg?.message || 'auth_failed');
          clearTimeout(timer);
          finish({ ok: false, error: 'licencia_denegada', via: 'ws', message: wsLastError });
          return;
        }
        if (status === 'error') {
          wsLastError = String(msg?.message || 'error');
        }
      });

      sock.on('close', () => {
        wsLicensed = false;
        if (ws === sock) ws = null;
        scheduleReconnect();
        if (!settled) {
          clearTimeout(timer);
          finish({ ok: false, error: wsLastError || 'ws_cerrado', via: 'ws' });
        }
      });

      sock.on('error', (e) => {
        wsLastError = e?.message || 'ws_error';
        if (!settled) {
          clearTimeout(timer);
          finish({ ok: false, error: wsLastError, via: 'ws' });
        }
      });
    } catch (e) {
      clearTimeout(timer);
      wsConnecting = false;
      finish({ ok: false, error: String(e?.message || e), via: 'ws' });
    }
  });
}

async function activateMcCoreViaRcon(email, rcon) {
  const mail = String(email || '').trim();
  if (!mail) return { ok: false, error: 'sin_email' };
  const cfg = { host: '127.0.0.1', port: 25575, ...(rcon || {}) };
  if (!String(cfg.password || '').trim()) return { ok: false, error: 'rcon_sin_password' };
  return sendRcon(cfg, `livecoinscore activate ${mail}`);
}

export async function ensureMcCoreLicense({ user, email, rcon } = {}) {
  const mail = resolveMcCoreLicenseEmail(user, email);
  if (!mail) return { ok: false, error: 'sin_email' };

  const reachable = await mcCoreTcpReachable();
  if (!reachable) {
    return { ok: false, error: 'plugin_core_offline', hint: 'Arranca el servidor MC con LiveCoinsCore' };
  }

  const wsRes = await connectMcCoreWs(mail);
  if (wsRes.ok) return { ...wsRes, email: mail };

  if (user?.isAdmin) {
    const rconRes = await activateMcCoreViaRcon(mail, rcon);
    if (rconRes?.ok) {
      wsLicensed = true;
      return { ok: true, licensed: true, via: 'rcon_admin', email: mail };
    }
    return {
      ok: false,
      error: 'licencia_fallida',
      email: mail,
      ws: wsRes,
      rcon: rconRes,
      hint: 'Como OP en el juego: /livecoinscore activate ' + mail,
    };
  }

  return { ...wsRes, email: mail };
}

export function mcCoreLicenseStatus() {
  return {
    port: MC_CORE_WS_PORT,
    host: MC_CORE_WS_HOST,
    email: wsEmail,
    licensed: wsLicensed,
    connected: !!(ws && ws.readyState === WebSocket.OPEN),
    lastError: wsLastError,
  };
}

export function stopMcCoreBridge() {
  keepAlive = false;
  clearReconnectTimer();
  closeWs();
  wsEmail = '';
  wsLicensed = false;
  wsLastError = '';
  wsConnecting = false;
}
