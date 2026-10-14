// Firma del WebSocket de TikTok con la API nueva de Euler Stream (api.eulerstream.com).
// La ruta vieja /webcast/fetch de tiktok.eulerstream.com ya no existe ("Route '/webcast/fetch' DNE"),
// y tiktok-live-connector 2.1.x todavía la usa. Aquí se llama directo a la nueva:
//   GET /webcast/anchors/{unique_id}/room_id   (si no se sabe la sala)
//   GET /webcast/rooms/{room_id}/connect       (firma + mensaje inicial)
import EulerStreamApiClient from 'tiktok-live-api-sdk';
import { deserializeMessage } from 'tiktok-live-connector';
import { isEulerConfigured } from './euler-config.js';

const BASE = (process.env.EULER_API_URL || 'https://api.eulerstream.com').replace(/\/+$/, '');
const CLIENT = 'ttlive-node';

let cached = null;
function api() {
  const key = (process.env.EULER_API_KEY || process.env.SIGN_API_KEY || '').trim();
  if (cached && cached.key === key) return cached.client;
  const client = new EulerStreamApiClient({
    basePath: BASE,
    apiKey: key,
    baseOptions: { validateStatus: () => true, timeout: 20000 },
  });
  cached = { key, client };
  return client;
}

function errText(data) {
  try {
    const s = Buffer.isBuffer(data) || data instanceof ArrayBuffer ? Buffer.from(data).toString('utf8') : JSON.stringify(data);
    return String(s || '').slice(0, 300);
  } catch { return ''; }
}

/** Sala del live a partir del usuario (Euler). Devuelve { ok, roomId, isLive, status, message }. */
export async function eulerRoomId(uniqueId) {
  const r = await api().anchors.retrieveRoomId(String(uniqueId || '').replace(/^@+/, ''));
  const d = r.data || {};
  if (r.status !== 200) return { ok: false, status: r.status, message: d.message || errText(d) };
  return { ok: !!d.room_id, roomId: d.room_id ? String(d.room_id) : '', isLive: d.is_live, status: r.status, message: d.message || '' };
}

/**
 * Pide a Euler la URL firmada del WebSocket. Devuelve
 * { status, data (Buffer con ProtoMessageFetchResult), setCookie, roomId, requestId, agentId }.
 */
export async function eulerSignWebcast({ roomId, uniqueId, cursor, useMobile, userAgent } = {}) {
  if (!isEulerConfigured()) throw new Error('El servidor no tiene la clave de Euler.');
  let rid = String(roomId || '').replace(/\D/g, '');
  if (!rid && uniqueId) {
    const q = await eulerRoomId(uniqueId);
    if (!q.ok) {
      const status = q.status && q.status !== 200 ? q.status : 404;
      return { status, data: Buffer.from(JSON.stringify({ code: status, message: q.message || 'No se encontró la sala del live.' })), setCookie: '', roomId: '' };
    }
    rid = q.roomId;
  }
  if (!rid) throw new Error('Falta la sala del live.');
  const r = await api().rooms.fetchWebcastURL(
    rid, CLIENT, undefined, cursor || undefined, userAgent || undefined, true, undefined,
    useMobile ? 'mobile' : 'web', undefined, undefined, undefined, undefined,
    { responseType: 'arraybuffer' },
  );
  const h = r.headers || {};
  return {
    status: r.status,
    data: Buffer.from(r.data || []),
    setCookie: h['x-set-tt-cookie'] || '',
    roomId: h['x-room-id'] || rid,
    requestId: h['x-request-id'] || '',
    agentId: h['x-agent-id'] || '',
  };
}

/**
 * Para usar como `signedWebSocketProvider` de tiktok-live-connector 2.1.x:
 * aplica cookies y sala igual que la librería y devuelve el ProtoMessageFetchResult.
 */
export function eulerSignedWebSocketProvider(getConn, uniqueId) {
  return async (p) => {
    const conn = getConn();
    if (!conn) throw new Error('conexión cancelada');
    const r = await eulerSignWebcast({
      roomId: p?.roomId || '',
      uniqueId: p?.roomId ? '' : (p?.uniqueId || uniqueId),
      cursor: conn.webClient?.clientParams?.cursor || '',
      useMobile: !!p?.useMobile,
      userAgent: conn.webClient?.axiosInstance?.defaults?.headers?.['User-Agent'],
    });
    if (r.status === 429) throw new Error('rate limit: too many connections');
    if (r.status !== 200) throw new Error(`Unexpected sign server status ${r.status}. Payload: ${errText(r.data)}`);
    if (!r.setCookie) throw new Error('No cookies received from sign server.');
    conn.webClient.cookieJar.processSetCookieHeader(r.setCookie);
    if (r.roomId) conn.webClient.roomId = r.roomId;
    return deserializeMessage('ProtoMessageFetchResult', r.data);
  };
}
