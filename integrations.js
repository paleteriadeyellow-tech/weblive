// Pruebas de conexión para la sub-pestaña "Configuración" (solo .exe):
//   - RCON   (protocolo Source RCON sobre TCP)  → Minecraft y otros servidores
//   - OBS    (obs-websocket v5, normalmente :4455)
//   - Streamer.bot (WebSocket, normalmente :8080)
// Cada función devuelve { ok: true } o { ok: false, error: '...' } sin lanzar.
import net from 'node:net';
import crypto from 'node:crypto';
import http from 'node:http';
import { WebSocket } from 'ws';

/* ----------------------------- RCON ----------------------------- */
// Paquete RCON: int32 size | int32 id | int32 type | body (null-term) | null
function rconPacket(id, type, body) {
  const bodyBuf = Buffer.from(body || '', 'utf8');
  const size = 4 + 4 + bodyBuf.length + 2;
  const buf = Buffer.alloc(4 + size);
  buf.writeInt32LE(size, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  bodyBuf.copy(buf, 12);
  buf.writeInt8(0, 12 + bodyBuf.length);
  buf.writeInt8(0, 12 + bodyBuf.length + 1);
  return buf;
}

export function testRcon({ host, port, password }) {
  return new Promise((resolve) => {
    let done = false;
    const socket = new net.Socket();
    const finish = (r) => { if (done) return; done = true; try { socket.destroy(); } catch {} resolve(r); };
    const to = setTimeout(() => finish({ ok: false, error: 'Tiempo de espera agotado (¿host/puerto correctos y RCON activo?)' }), 5000);
    socket.connect(Number(port) || 25575, host || '127.0.0.1', () => {
      // type 3 = SERVERDATA_AUTH
      try { socket.write(rconPacket(1, 3, password || '')); } catch (e) { clearTimeout(to); finish({ ok: false, error: e.message }); }
    });
    socket.on('data', (data) => {
      clearTimeout(to);
      try {
        // El id de la respuesta de auth es -1 cuando la contraseña es incorrecta.
        const id = data.readInt32LE(4);
        if (id === -1) finish({ ok: false, error: 'Contraseña RCON incorrecta' });
        else finish({ ok: true });
      } catch { finish({ ok: false, error: 'Respuesta inválida del servidor' }); }
    });
    socket.on('error', (e) => { clearTimeout(to); finish({ ok: false, error: friendly(e) }); });
  });
}

// Lee paquetes RCON de un buffer TCP (puede venir fragmentado).
function readRconPackets(buf) {
  const out = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const size = buf.readInt32LE(off);
    if (size < 10 || off + 4 + size > buf.length) break;
    out.push({
      id: buf.readInt32LE(off + 4),
      type: buf.readInt32LE(off + 8),
      body: buf.toString('utf8', off + 12, off + 4 + size - 2),
    });
    off += 4 + size;
  }
  return { packets: out, rest: buf.subarray(off) };
}

function rconLooksFailed(text) {
  const t = String(text || '').toLowerCase();
  if (!t.trim()) return false;
  return /unknown|incorrect|invalid|syntax|no entity|could not|failed|error|not found|expected|malformed|must be|cannot|unable/.test(t);
}

// Envía uno o varios comandos al servidor por RCON (type 2 = SERVERDATA_EXECCOMMAND).
// command puede ser un string o un array de strings (se envían en secuencia).
export function sendRcon({ host, port, password } = {}, command) {
  const cmds = (Array.isArray(command) ? command : [command]).filter((c) => c != null && String(c).trim() !== '');
  return new Promise((resolve) => {
    if (!cmds.length) return resolve({ ok: false, error: 'Sin comando' });
    let done = false; let authed = false; let idx = 0; let buf = Buffer.alloc(0);
    let reqId = 2; const responses = []; let lastFail = '';
    const socket = new net.Socket();
    const finish = (r) => { if (done) return; done = true; try { socket.destroy(); } catch {} resolve(r); };
    const to = setTimeout(() => finish({ ok: false, error: 'Tiempo de espera agotado (¿RCON activo?)', responses, lastCmd: cmds[idx - 1] || cmds[0] }), 12000);
    const sendCmd = () => {
      if (idx >= cmds.length) {
        clearTimeout(to);
        return finish(lastFail ? { ok: false, error: lastFail, responses, lastCmd: cmds[idx - 1] } : { ok: true, responses });
      }
      const c = cmds[idx++];
      reqId++;
      try { socket.write(rconPacket(reqId, 2, c)); } catch (e) { clearTimeout(to); finish({ ok: false, error: e.message, lastCmd: c }); }
    };
    socket.connect(Number(port) || 25575, host || '127.0.0.1', () => {
      try { socket.write(rconPacket(1, 3, password || '')); } catch (e) { clearTimeout(to); finish({ ok: false, error: e.message }); }
    });
    socket.on('data', (chunk) => {
      try {
        buf = Buffer.concat([buf, chunk]);
        const { packets, rest } = readRconPackets(buf);
        buf = rest;
        for (const p of packets) {
          if (!authed) {
            if (p.id === -1) { clearTimeout(to); return finish({ ok: false, error: 'Contraseña RCON incorrecta' }); }
            if (p.type === 2) { authed = true; sendCmd(); }
            continue;
          }
          if (p.type === 0 && p.body != null) {
            responses.push(p.body);
            if (rconLooksFailed(p.body)) lastFail = p.body.trim().slice(0, 180);
            sendCmd();
          }
        }
      } catch { clearTimeout(to); finish({ ok: false, error: 'Respuesta inválida del servidor' }); }
    });
    socket.on('error', (e) => { clearTimeout(to); finish({ ok: false, error: friendly(e) }); });
  });
}

/* ----------------------------- OBS ----------------------------- */
export function testObs({ ip, port, password }) {
  return new Promise((resolve) => {
    let done = false; let ws;
    const finish = (r) => { if (done) return; done = true; try { ws.close(); } catch {} resolve(r); };
    try { ws = new WebSocket(`ws://${ip || '127.0.0.1'}:${Number(port) || 4455}`); }
    catch (e) { return resolve({ ok: false, error: e.message }); }
    const to = setTimeout(() => finish({ ok: false, error: 'Tiempo de espera agotado (¿WebSocket de OBS activo?)' }), 6000);
    ws.on('message', (raw) => {
      let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.op === 0) {
        const d = msg.d || {};
        const ident = { rpcVersion: d.rpcVersion || 1 };
        if (d.authentication) {
          const { challenge, salt } = d.authentication;
          const secret = crypto.createHash('sha256').update((password || '') + salt).digest('base64');
          ident.authentication = crypto.createHash('sha256').update(secret + challenge).digest('base64');
        }
        try { ws.send(JSON.stringify({ op: 1, d: ident })); } catch {}
      } else if (msg.op === 2) { clearTimeout(to); finish({ ok: true }); }
    });
    ws.on('close', (code) => { clearTimeout(to); if (!done) finish({ ok: false, error: code === 4009 ? 'Contraseña de OBS incorrecta' : 'Conexión cerrada por OBS (código ' + code + ')' }); });
    ws.on('error', (e) => { clearTimeout(to); finish({ ok: false, error: friendly(e) }); });
  });
}

/* ------------------------- Streamer.bot ------------------------- */
export function testStreamerbot({ address, port, endpoint }) {
  return new Promise((resolve) => {
    let done = false; let ws;
    const finish = (r) => { if (done) return; done = true; try { ws.close(); } catch {} resolve(r); };
    let ep = endpoint || '/';
    if (!ep.startsWith('/')) ep = '/' + ep;
    try { ws = new WebSocket(`ws://${address || '127.0.0.1'}:${Number(port) || 8080}${ep === '/' ? '' : ep}`); }
    catch (e) { return resolve({ ok: false, error: e.message }); }
    const to = setTimeout(() => finish({ ok: false, error: 'Tiempo de espera agotado (¿servidor de Streamer.bot activo?)' }), 6000);
    ws.on('open', () => {
      try { ws.send(JSON.stringify({ request: 'GetInfo', id: 'livecoins-test' })); } catch {}
      // Si abrió la conexión, la consideramos válida tras un instante.
      setTimeout(() => { clearTimeout(to); finish({ ok: true }); }, 500);
    });
    ws.on('error', (e) => { clearTimeout(to); finish({ ok: false, error: friendly(e) }); });
    ws.on('close', (code) => { if (!done) { clearTimeout(to); finish({ ok: false, error: 'No se pudo conectar (código ' + code + ')' }); } });
  });
}

/* ------------------------- ServerTap ------------------------- */
// ServerTap (y el mod de TikFinity) exponen una API REST en el servidor de Minecraft.
// La autenticación va en la cabecera "key". Para enviar comandos se hace
// POST /v1/server/exec con el cuerpo "command=<cmd>" (x-www-form-urlencoded).
function servertapRequest({ ip, port, key }, { method = 'GET', path: reqPath = '/v1/server', body = null } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => { if (done) return; done = true; resolve(r); };
    const data = body == null ? null : Buffer.from(body, 'utf8');
    const headers = { key: key || '', Accept: 'application/json' };
    if (data) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      headers['Content-Length'] = data.length;
    }
    let req;
    try {
      req = http.request({
        host: ip || '127.0.0.1',
        port: Number(port) || 4567,
        path: reqPath,
        method,
        headers,
        timeout: 6000,
      }, (res) => {
        let chunks = '';
        res.on('data', (c) => { chunks += c; });
        res.on('end', () => finish({ status: res.statusCode || 0, text: chunks }));
      });
    } catch (e) { return finish({ status: 0, error: e.message }); }
    req.on('timeout', () => { try { req.destroy(); } catch {} finish({ status: 0, error: 'Tiempo de espera agotado (¿servidor y plugin ServerTap activos?)' }); });
    req.on('error', (e) => finish({ status: 0, error: friendly(e) }));
    if (data) req.write(data);
    req.end();
  });
}

// Prueba de conexión: pide /v1/server. 200 = OK; 401/403 = key incorrecta.
export async function testServertap({ ip, port, key } = {}) {
  const r = await servertapRequest({ ip, port, key }, { method: 'GET', path: '/v1/server' });
  if (r.error) return { ok: false, error: r.error };
  if (r.status === 200) return { ok: true };
  if (r.status === 401 || r.status === 403) return { ok: false, error: 'Key (contraseña) de ServerTap incorrecta' };
  if (r.status === 404) return { ok: false, error: 'Responde pero no es ServerTap (404 en /v1/server)' };
  if (!r.status) return { ok: false, error: 'No se pudo conectar (¿IP/puerto correctos?)' };
  return { ok: false, error: 'El servidor respondió con código ' + r.status };
}

// Envía uno o varios comandos por la API de ServerTap (uno por petición).
// Si "playername" está configurado, reemplaza @p por ese jugador (como TikFinity);
// si está vacío, deja @p para que aplique a todos los jugadores.
export async function sendServertap(conn = {}, command) {
  const cmds = (Array.isArray(command) ? command : [command])
    .filter((c) => c != null && String(c).trim() !== '');
  if (!cmds.length) return { ok: false, error: 'Sin comando' };
  const player = String(conn.playername || '').trim();
  const responses = [];
  let lastFail = ''; let failCmd = '';
  for (const raw of cmds) {
    let cmd = String(raw).trim();
    if (player) cmd = cmd.replace(/@p\b/g, player);
    if (cmd.startsWith('/')) cmd = cmd.slice(1); // ServerTap no quiere la barra inicial
    const r = await servertapRequest(conn, {
      method: 'POST',
      path: '/v1/server/exec',
      body: 'command=' + encodeURIComponent(cmd) + '&time=0',
    });
    if (r.error) { lastFail = r.error; failCmd = cmd; continue; }
    if (r.status === 401 || r.status === 403) return { ok: false, error: 'Key de ServerTap incorrecta', lastCmd: cmd };
    if (r.status < 200 || r.status >= 300) { lastFail = 'Código ' + r.status; failCmd = cmd; continue; }
    responses.push(r.text);
  }
  if (lastFail) return { ok: false, error: lastFail, responses, lastCmd: failCmd };
  return { ok: true, responses };
}

/* ----------------- Envío de comandos (acciones) ----------------- */
// Abre una conexión a OBS, autentica si hace falta, envía un comando y cierra.
// cmd: { type, scene, source }
export function sendObsCommand(conn, cmd) {
  return new Promise((resolve) => {
    let done = false; let ws; let authed = false; let pendingToggleId = null;
    const finish = (r) => { if (done) return; done = true; try { ws.close(); } catch {} resolve(r); };
    try { ws = new WebSocket(`ws://${conn.ip || '127.0.0.1'}:${Number(conn.port) || 4455}`); }
    catch (e) { return resolve({ ok: false, error: e.message }); }
    const to = setTimeout(() => finish({ ok: false, error: 'Tiempo de espera agotado' }), 7000);
    const sendReq = (requestType, requestData) => {
      ws.send(JSON.stringify({ op: 6, d: { requestType, requestId: 'lc-' + Date.now(), requestData: requestData || {} } }));
    };
    const buildRequest = () => {
      switch (cmd.type) {
        case 'scene': sendReq('SetCurrentProgramScene', { sceneName: cmd.scene }); break;
        case 'startRecord': sendReq('StartRecord'); break;
        case 'stopRecord': sendReq('StopRecord'); break;
        case 'startStream': sendReq('StartStream'); break;
        case 'stopStream': sendReq('StopStream'); break;
        case 'showSource':
        case 'hideSource':
        case 'toggleSource':
          // Necesitamos el sceneItemId de la fuente dentro de la escena.
          sendReq('GetSceneItemId', { sceneName: cmd.scene, sourceName: cmd.source });
          break;
        default: sendReq('GetVersion');
      }
    };
    ws.on('message', (raw) => {
      let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.op === 0) {
        const d = msg.d || {};
        const ident = { rpcVersion: d.rpcVersion || 1 };
        if (d.authentication) {
          const { challenge, salt } = d.authentication;
          const secret = crypto.createHash('sha256').update((conn.password || '') + salt).digest('base64');
          ident.authentication = crypto.createHash('sha256').update(secret + challenge).digest('base64');
        }
        try { ws.send(JSON.stringify({ op: 1, d: ident })); } catch {}
      } else if (msg.op === 2) {
        authed = true;
        buildRequest();
      } else if (msg.op === 7) {
        const d = msg.d || {};
        const rt = d.requestType;
        const ok = d.requestStatus && d.requestStatus.result;
        if (rt === 'GetSceneItemId') {
          if (!ok) { clearTimeout(to); return finish({ ok: false, error: 'No se encontró la fuente en la escena' }); }
          const itemId = d.responseData.sceneItemId;
          const enabled = cmd.type === 'showSource' ? true : cmd.type === 'hideSource' ? false : undefined;
          if (enabled === undefined) {
            // toggle: consultamos el estado actual y lo invertimos.
            sendReq('GetSceneItemEnabled', { sceneName: cmd.scene, sceneItemId: itemId });
            pendingToggleId = itemId;
          } else {
            sendReq('SetSceneItemEnabled', { sceneName: cmd.scene, sceneItemId: itemId, sceneItemEnabled: enabled });
            clearTimeout(to); finish({ ok: true });
          }
        } else if (rt === 'GetSceneItemEnabled') {
          const cur = d.responseData && d.responseData.sceneItemEnabled;
          sendReq('SetSceneItemEnabled', { sceneName: cmd.scene, sceneItemId: pendingToggleId, sceneItemEnabled: !cur });
          clearTimeout(to); finish({ ok: true });
        } else {
          clearTimeout(to);
          finish(ok ? { ok: true } : { ok: false, error: (d.requestStatus && d.requestStatus.comment) || 'OBS rechazó el comando' });
        }
      }
    });
    ws.on('close', (code) => { if (!done) { clearTimeout(to); finish({ ok: false, error: code === 4009 ? 'Contraseña de OBS incorrecta' : (authed ? 'Conexión cerrada' : 'No se pudo autenticar') }); } });
    ws.on('error', (e) => { clearTimeout(to); finish({ ok: false, error: friendly(e) }); });
  });
}

// Ejecuta una acción de Streamer.bot por nombre (o id). Abre, envía DoAction y cierra.
export function triggerStreamerbot(conn, action) {
  return new Promise((resolve) => {
    let done = false; let ws;
    const finish = (r) => { if (done) return; done = true; try { ws.close(); } catch {} resolve(r); };
    let ep = conn.endpoint || '/';
    if (!ep.startsWith('/')) ep = '/' + ep;
    try { ws = new WebSocket(`ws://${conn.address || '127.0.0.1'}:${Number(conn.port) || 8080}${ep === '/' ? '' : ep}`); }
    catch (e) { return resolve({ ok: false, error: e.message }); }
    const to = setTimeout(() => finish({ ok: false, error: 'Tiempo de espera agotado' }), 7000);
    ws.on('open', () => {
      // Streamer.bot acepta DoAction por id o por nombre.
      const isId = /^[0-9a-f-]{30,}$/i.test(action);
      const req = { request: 'DoAction', action: isId ? { id: action } : { name: action }, id: 'lc-' + Date.now() };
      try { ws.send(JSON.stringify(req)); } catch {}
      setTimeout(() => { clearTimeout(to); finish({ ok: true }); }, 400);
    });
    ws.on('error', (e) => { clearTimeout(to); finish({ ok: false, error: friendly(e) }); });
    ws.on('close', (code) => { if (!done) { clearTimeout(to); finish({ ok: false, error: 'No se pudo conectar (código ' + code + ')' }); } });
  });
}

function friendly(e) {
  const c = e && (e.code || e.message) || 'error';
  if (c === 'ECONNREFUSED') return 'Conexión rechazada (¿está abierto el servidor y el puerto?)';
  if (c === ' EHOSTUNREACH' || c === 'EHOSTUNREACH') return 'Host inalcanzable';
  if (c === 'ETIMEDOUT') return 'Tiempo de espera agotado';
  if (c === 'ENOTFOUND') return 'No se encontró el host';
  return String(c);
}
