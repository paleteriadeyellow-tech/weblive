// Spotify corre solo en la app .exe (OAuth local + cola en la PC del streamer).
// En Render la nube no conecta Spotify; room.js importa este módulo por compatibilidad
// de código compartido con la raíz. Todas las funciones son no-op.
export const SPOTIFY_CLIENT_ID = '';
export const SPOTIFY_CALLBACK_PORT = 8888;
export const SPOTIFY_REDIRECT_URI = 'http://127.0.0.1:8888/spotify/callback';

export function normalizeClientId(raw) {
  const id = String(raw || '').trim();
  if (!id || !/^[a-zA-Z0-9]{16,64}$/.test(id)) return '';
  return id;
}
export function isConnected() { return false; }
export function rememberPanelOrigin() {}
export function getPanelOrigin() { return ''; }
export function buildAuthUrl() { throw new Error('Spotify solo en app .exe'); }
export async function handleCallback() { return { ok: false }; }
export function logout() { return { ok: true }; }
export async function getStatus() { return { connected: false }; }
export async function searchTrack() { return null; }
export async function addToQueue() { return false; }
export async function skipNext() { return false; }
export async function getCurrentlyPlaying() { return null; }
export async function getPlaybackState() { return null; }
