// Euler Stream (sign server de tiktok-live-connector).
// La API key NO va en el código: EULER_API_KEY o SIGN_API_KEY en el entorno
// (Render → Environment) o en .env local (gitignored).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SignConfig } from 'tiktok-live-connector';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadDotEnv() {
  try {
    const envPath = path.join(__dirname, '.env');
    if (!fs.existsSync(envPath)) return;
    for (const raw of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const i = line.indexOf('=');
      if (i < 1) continue;
      const key = line.slice(0, i).trim();
      if (process.env[key] !== undefined) continue;
      let val = line.slice(i + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      process.env[key] = val;
    }
  } catch { /* ignore */ }
}

loadDotEnv();

const apiKey = (process.env.EULER_API_KEY || process.env.SIGN_API_KEY || '').trim();
if (apiKey) {
  SignConfig.apiKey = apiKey;
  if (!process.env.SIGN_API_KEY) process.env.SIGN_API_KEY = apiKey;
}

export function isEulerConfigured() {
  return !!(SignConfig.apiKey && String(SignConfig.apiKey).trim());
}

export function eulerStartupLine() {
  if (!isEulerConfigured()) {
    return 'Euler: sin API key (anónimo)';
  }
  const k = String(SignConfig.apiKey);
  const masked = k.length > 12 ? `${k.slice(0, 8)}…${k.slice(-4)}` : '…';
  return `Euler: API key activa (${masked})`;
}
