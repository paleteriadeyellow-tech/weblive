import fs from 'node:fs';
import path from 'node:path';

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { return fallback; }
}

function writeJsonAtomic(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

export function createMusicDb(baseDir) {
  fs.mkdirSync(baseDir, { recursive: true });
  const files = {
    queue: path.join(baseDir, 'songs_queue.json'),
    history: path.join(baseDir, 'songs_history.json'),
    credits: path.join(baseDir, 'music_credits.json'),
    settings: path.join(baseDir, 'music_settings.json'),
    giftRewards: path.join(baseDir, 'gift_rewards.json'),
  };

  function loadQueue() { return readJson(files.queue, []); }
  function saveQueue(q) { writeJsonAtomic(files.queue, q); }
  function loadHistory() { return readJson(files.history, []); }
  function saveHistory(h) { writeJsonAtomic(files.history, h.slice(0, 500)); }
  function loadCredits() { return readJson(files.credits, []); }
  function saveCredits(c) { writeJsonAtomic(files.credits, c); }
  function loadSettings() { return readJson(files.settings, null); }
  function saveSettings(s) { writeJsonAtomic(files.settings, s); }
  function loadGiftRewards() { return readJson(files.giftRewards, null); }
  function saveGiftRewards(g) { writeJsonAtomic(files.giftRewards, g); }

  return {
    loadQueue, saveQueue, loadHistory, saveHistory,
    loadCredits, saveCredits, loadSettings, saveSettings,
    loadGiftRewards, saveGiftRewards,
  };
}
