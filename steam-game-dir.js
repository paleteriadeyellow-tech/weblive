/**
 * Detecta carpetas de juegos instalados por Steam (como hace StreamToEarn).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const L4D2_STEAM_APP_ID = '550';
const L4D2_FOLDER_NAMES = ['Left 4 Dead 2', 'left 4 dead 2'];
const L4D2_EXE = 'left4dead2.exe';

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function normalizeDir(dir) {
  return path.resolve(String(dir || '').trim());
}

function hasL4dExe(dir) {
  try {
    return fs.existsSync(path.join(dir, L4D2_EXE));
  } catch {
    return false;
  }
}

function readSteamPathFromRegistry() {
  if (process.platform !== 'win32') return '';
  try {
    const out = execFileSync(
      'reg',
      ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'],
      { encoding: 'utf8', windowsHide: true, timeout: 8000 },
    );
    const m = String(out).match(/SteamPath\s+REG_SZ\s+(.+)/i);
    return m ? normalizeDir(m[1].trim().replace(/\//g, '\\')) : '';
  } catch {
    return '';
  }
}

function parseVdfPaths(content) {
  const roots = new Set();
  const re = /"path"\s+"([^"]+)"/gi;
  let m;
  while ((m = re.exec(content)) !== null) {
    const p = m[1].replace(/\\\\/g, '\\').trim();
    if (p) roots.add(normalizeDir(p));
  }
  return [...roots];
}

export function discoverSteamExe() {
  const steamPath = readSteamPathFromRegistry();
  if (!steamPath) return null;
  const exe = path.join(steamPath, 'steam.exe');
  try {
    return fs.existsSync(exe) ? exe : null;
  } catch {
    return null;
  }
}

export function discoverSteamLibraryRoots() {
  const roots = new Set();
  const steamPath = readSteamPathFromRegistry();
  if (steamPath) roots.add(steamPath);

  const candidates = [];
  if (steamPath) {
    candidates.push(path.join(steamPath, 'steamapps', 'libraryfolders.vdf'));
    candidates.push(path.join(steamPath, 'config', 'libraryfolders.vdf'));
  }

  for (const file of candidates) {
    for (const p of parseVdfPaths(readText(file))) roots.add(p);
  }

  return [...roots];
}

function readInstallDirFromManifest(manifestPath) {
  const m = readText(manifestPath).match(/"installdir"\s+"([^"]+)"/i);
  return m ? m[1].trim() : '';
}

function gameDirFromLibraryRoot(libraryRoot, folderName) {
  const dir = path.join(libraryRoot, 'steamapps', 'common', folderName);
  return hasL4dExe(dir) ? dir : null;
}

function gameDirFromManifest(libraryRoot, appId) {
  const manifest = path.join(libraryRoot, 'steamapps', `appmanifest_${appId}.acf`);
  if (!fs.existsSync(manifest)) return null;
  const installdir = readInstallDirFromManifest(manifest);
  if (!installdir) return null;
  return gameDirFromLibraryRoot(libraryRoot, installdir);
}

/**
 * Busca Left 4 Dead 2 en todas las bibliotecas de Steam.
 * @param {{ preferMarkers?: string[] }} [opts]
 */
export function discoverL4d2SteamDir(opts = {}) {
  const markers = opts.preferMarkers || ['interactive_l4d2.json', 's2e_info.json'];
  const roots = discoverSteamLibraryRoots();
  const found = [];
  let withMarkers = null;

  for (const root of roots) {
    const viaManifest = gameDirFromManifest(root, L4D2_STEAM_APP_ID);
    if (viaManifest) found.push(viaManifest);

    for (const folder of L4D2_FOLDER_NAMES) {
      const dir = gameDirFromLibraryRoot(root, folder);
      if (dir && !found.includes(dir)) found.push(dir);
    }
  }

  for (const dir of found) {
    if (markers.some((name) => fs.existsSync(path.join(dir, name)))) {
      withMarkers = dir;
      break;
    }
  }

  if (withMarkers) return withMarkers;
  if (found.length) return found[0];

  for (const root of roots) {
    const pluginsDir = path.join(root, 'steamapps', 'common');
    if (!fs.existsSync(pluginsDir)) continue;
    try {
      for (const entry of fs.readdirSync(pluginsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const dir = path.join(pluginsDir, entry.name);
        if (!hasL4dExe(dir)) continue;
        if (markers.some((name) => fs.existsSync(path.join(dir, name)))) return dir;
      }
    } catch { /* ignore */ }
  }

  return null;
}

/** Todas las carpetas de L4D2 encontradas en bibliotecas Steam. */
export function findAllL4d2InstallDirs() {
  const found = [];
  const seen = new Set();
  const push = (dir) => {
    const key = path.resolve(dir).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    found.push(path.resolve(dir));
  };

  for (const root of discoverSteamLibraryRoots()) {
    const viaManifest = gameDirFromManifest(root, L4D2_STEAM_APP_ID);
    if (viaManifest) push(viaManifest);
    for (const folder of L4D2_FOLDER_NAMES) {
      const dir = gameDirFromLibraryRoot(root, folder);
      if (dir) push(dir);
    }
  }
  return found;
}
