/** Stubs de juegos para Render: room.js no debe cargar game-local/bridges (OOM 512MB). */

const nope = async () => ({ ok: false, error: 'solo_escritorio' });

export const marioSpawn = nope;
export const marioEffect = nope;
export const mari0Spawn = nope;
export const mari0Effect = nope;
export const smb3Spawn = nope;
export const smb3Effect = nope;
export const pvzSpawn = nope;
export const pvzSun = nope;
export const pvzCmd = nope;
export const pvzHybridSpawn = nope;
export const pvzHybridSun = nope;
export const pvzHybridCmd = nope;
export const repoSpawn = nope;
export const l4dSpawn = nope;
export const unturnedSpawn = nope;
export const ctrSpawn = nope;
export const mslugSpawn = nope;
export const smwSpawn = nope;
export const runGameExec = nope;
export function resolveRepoSpawnKey(key) {
  return key;
}

export const ensureMarioBridge = nope;
export const ensureMari0Bridge = nope;
