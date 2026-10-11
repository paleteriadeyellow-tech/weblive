// Anti-tamper de plan/caps en el .exe con login nube (AUTH_REMOTE).
// No es DRM perfecto (el binario se puede parchear); sí bloquea editar
// users.json / plans.json a mano en %APPDATA% para auto-activarse Premium.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const KEY_FILE = path.join(DATA_DIR, '.entitlement-key');
const SEED = 'LivecoinsPlanLock.v1.2026';

fs.mkdirSync(DATA_DIR, { recursive: true });

/** .exe + cuentas de Render: el plan local debe ir sellado por sync/login nube. */
export function isDesktopCloudLock() {
  return process.env.DESKTOP === '1' && !!(process.env.AUTH_REMOTE || '').replace(/\/+$/, '');
}

function localKeyMaterial() {
  try {
    const existing = fs.readFileSync(KEY_FILE, 'utf8').trim();
    if (existing.length >= 32) return existing;
  } catch {}
  const fresh = crypto.randomBytes(32).toString('hex');
  try { fs.writeFileSync(KEY_FILE, fresh, { mode: 0o600 }); } catch {}
  return fresh;
}

export function getEntitlementKey() {
  return crypto.createHmac('sha256', SEED).update(localKeyMaterial()).digest();
}

export function hmacHex(payload) {
  return crypto.createHmac('sha256', getEntitlementKey()).update(String(payload)).digest('hex');
}

export function sealsEqual(a, b) {
  try {
    const ba = Buffer.from(String(a || ''), 'hex');
    const bb = Buffer.from(String(b || ''), 'hex');
    if (ba.length === 0 || ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}
