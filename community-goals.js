// Meta global de diamantes (admin): cada Livecoins user tiene su propio progreso.
// Al cambiar la meta desde admin se reinicia el progreso de todos.

import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_GOAL = 50000;

function clampGoal(n) {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v) || v < 1) return DEFAULT_GOAL;
  return Math.min(v, 1_000_000_000);
}

export function createCommunityGoals(dataDir) {
  const FILE = path.join(dataDir, 'community-goals.json');
  let saveTimer = null;
  let data = loadFile();

  function defaultData() {
    return { diamondsGoal: DEFAULT_GOAL, periodId: 1, progress: {} };
  }

  function loadFile() {
    try {
      const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      const progress = (raw && typeof raw.progress === 'object' && raw.progress) ? raw.progress : {};
      const clean = {};
      for (const [k, v] of Object.entries(progress)) {
        const n = Math.floor(Number(v));
        if (k && Number.isFinite(n) && n > 0) clean[k] = n;
      }
      return {
        diamondsGoal: clampGoal(raw?.diamondsGoal),
        periodId: Math.max(1, Math.floor(Number(raw?.periodId)) || 1),
        progress: clean,
      };
    } catch {
      return defaultData();
    }
  }

  function saveNow() {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      const tmp = FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
      fs.renameSync(tmp, FILE);
    } catch (e) {
      console.error('[community-goals] save', e.message);
    }
  }

  function scheduleSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      saveNow();
    }, 800);
    saveTimer.unref?.();
  }

  function keyOf(userId) {
    return String(userId || '').trim();
  }

  function getSnapshot(userId) {
    const key = keyOf(userId);
    const current = key ? Math.max(0, Math.floor(Number(data.progress[key]) || 0)) : 0;
    return {
      diamondsGoal: data.diamondsGoal,
      current,
      periodId: data.periodId,
    };
  }

  function recordDiamonds(userId, delta) {
    const key = keyOf(userId);
    const d = Math.floor(Number(delta));
    if (!key || !(d > 0)) return getSnapshot(userId);
    data.progress[key] = Math.max(0, Math.floor(Number(data.progress[key]) || 0)) + d;
    scheduleSave();
    return getSnapshot(userId);
  }

  /** Admin: cambia la meta y borra el progreso de todos. */
  function setGoalAndReset(newGoal) {
    data.diamondsGoal = clampGoal(newGoal);
    data.periodId = (data.periodId || 0) + 1;
    data.progress = {};
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    saveNow();
    return {
      diamondsGoal: data.diamondsGoal,
      periodId: data.periodId,
      current: 0,
      usersTracked: 0,
    };
  }

  function getAdmin() {
    return {
      diamondsGoal: data.diamondsGoal,
      periodId: data.periodId,
      usersTracked: Object.keys(data.progress).length,
    };
  }

  function flush() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    saveNow();
  }

  return { getSnapshot, recordDiamonds, setGoalAndReset, getAdmin, flush };
}
