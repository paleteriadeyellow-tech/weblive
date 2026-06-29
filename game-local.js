// Juegos locales (Mario, PvZ, REPO…) corren en la PC (.exe). En Render solo relay vía localExec.
const cloudNoop = async () => ({ ok: false, error: 'cloud_no_local_games' });

export const MARIO_SPAWN_MAX = 999;
export const MARI0_SPAWN_MAX = 200;
export const SMB3_SPAWN_MAX = 200;

export function smb3HealthOk() { return false; }
export const marioSpawn = cloudNoop;
export const smb3Health = async () => ({ ok: false });
export const smb3Spawn = cloudNoop;
export const smb3Effect = cloudNoop;
export const mari0Spawn = cloudNoop;
export const mari0Effect = cloudNoop;
export const launchMari0Game = cloudNoop;
export const marioEffect = cloudNoop;
export const pvzSpawn = cloudNoop;
export const pvzSun = cloudNoop;
export const pvzCmd = cloudNoop;
export const pvzHybridSpawn = cloudNoop;
export const pvzHybridSun = cloudNoop;
export const pvzHybridCmd = cloudNoop;
export const launchPvzHybridGame = cloudNoop;
export function resolveRepoSpawnKey(thing) { return String(thing || '').trim(); }
export const repoSpawn = cloudNoop;
export const launchRepoGame = cloudNoop;
export const launchRepoStack = cloudNoop;
export const launchPvzTools = cloudNoop;
export async function runGameExec() { return { ok: false, error: 'cloud_no_local_games' }; }
