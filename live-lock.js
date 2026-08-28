/**
 * Un live por cuenta Livecoins: si ya hay lock en otro deviceId, el segundo Conectar se niega.
 * TTL corto: si la PC se cierra o pierde internet, el cupo se libera solo.
 */
import fs from 'node:fs';

const TTL_MS = 90 * 1000;
const MSG = 'Esta cuenta ya está en live en otro dispositivo. Cierra el live o pulsa Desconectar ahí para poder conectar aquí.';

function now() { return Date.now(); }

function expired(rec) {
  if (!rec) return true;
  const beat = Number(rec.lastBeat || rec.claimedAt || 0);
  return !beat || (now() - beat) > TTL_MS;
}

export function createLiveLockStore(filePath) {
  const locks = new Map();
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (raw && typeof raw === 'object') {
      for (const [id, rec] of Object.entries(raw)) {
        if (id && rec && rec.deviceId && !expired(rec)) locks.set(id, rec);
      }
    }
  } catch { /* sin archivo */ }

  let saveTimer = null;
  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        const obj = {};
        for (const [id, rec] of locks) {
          if (!expired(rec)) obj[id] = rec;
        }
        fs.writeFile(filePath, JSON.stringify(obj), () => {});
      } catch { /* ignore */ }
    }, 200);
  }

  function prune() {
    for (const [id, rec] of locks) {
      if (expired(rec)) locks.delete(id);
    }
  }

  function claim(userId, deviceId, username) {
    const uid = String(userId || '').trim();
    const dev = String(deviceId || '').trim();
    if (!uid || dev.length < 8) return { ok: false, code: 'bad_device', message: 'Falta identificador de dispositivo.' };
    prune();
    const cur = locks.get(uid);
    if (cur && !expired(cur) && cur.deviceId !== dev) {
      return { ok: false, code: 'live_in_use', message: MSG };
    }
    locks.set(uid, {
      deviceId: dev,
      claimedAt: cur && cur.deviceId === dev ? (cur.claimedAt || now()) : now(),
      lastBeat: now(),
      tiktok: String(username || cur?.tiktok || '').replace(/^@+/, '').slice(0, 40),
    });
    persist();
    return { ok: true };
  }

  function heartbeat(userId, deviceId) {
    const uid = String(userId || '').trim();
    const dev = String(deviceId || '').trim();
    if (!uid || dev.length < 8) return { ok: false, code: 'bad_device' };
    prune();
    const cur = locks.get(uid);
    if (!cur || expired(cur)) return { ok: false, code: 'no_lock' };
    if (cur.deviceId !== dev) return { ok: false, code: 'live_in_use', message: MSG };
    cur.lastBeat = now();
    persist();
    return { ok: true };
  }

  function release(userId, deviceId) {
    const uid = String(userId || '').trim();
    const dev = String(deviceId || '').trim();
    const cur = locks.get(uid);
    if (cur && (!dev || cur.deviceId === dev)) {
      locks.delete(uid);
      persist();
    }
    return { ok: true };
  }

  return { claim, heartbeat, release, message: MSG };
}
