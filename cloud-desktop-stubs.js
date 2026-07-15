/** Stubs livianos para Render: no cargar bridges/ffmpeg (evitan OOM de 512MB). */

const nope = async () => ({ ok: false, error: 'solo_escritorio' });
const empty = () => null;
const falsy = () => false;
const status = () => ({ running: false, ok: false });

export const ffmpegPath = null;

export const stopMarioBridge = () => {};
export const stopPvzHybridBridge = () => {};
export const stopPvzToolkitBridge = () => {};
export const stopRepoBridge = () => {};
export const stopL4dBridge = () => {};
export const stopUnturnedBridge = () => {};
export const stopMcCoreBridge = () => {};
export const stopSmbxTiktokWebhook = () => {};

export const ensureRepoBridge = nope;
export const repoBridgeHealth = empty;
export const repoBridgeHealthOk = falsy;
export const repoBridgeStatus = status;
export const getRepoGameDirConfig = () => '';
export const setRepoGameDir = () => {};
export const installRepoMod = nope;
export const uninstallRepoMod = nope;

export const l4dBridgeHealth = empty;
export const l4dBridgeStatus = status;
export const getL4dGameDirConfig = () => '';
export const setL4dGameDir = () => {};
export const discoverL4dGameDir = () => null;
export const syncL4dGameDir = nope;
export const installL4dMod = nope;
export const uninstallL4dMod = nope;

export const unturnedBridgeHealth = empty;
export const unturnedBridgeStatus = status;
export const getUnturnedGameDirConfig = () => '';
export const setUnturnedGameDir = () => {};
export const discoverUnturnedSteamDir = () => null;
export const syncUnturnedGameDir = nope;
export const installUnturnedMod = nope;
export const uninstallUnturnedMod = nope;

export const ensureMcCoreLicense = nope;
export const mcCoreLicenseStatus = status;

export const ctrBridgeHealth = empty;
export const ensureCtrBridge = nope;
export const ctrBridgeStatus = status;

export const ensureSmwBridge = nope;
export const smwBridgeHealth = empty;
export const smwBridgeStatus = status;
export const installSmwMod = nope;
export const uninstallSmwMod = nope;

export const mslugBridgeHealth = empty;
export const mslugBridgeStatus = status;
export const getMslugGameDirConfig = () => '';
export const setMslugGameDir = () => {};
export const getMslugLastSpawn = () => null;
export const MSLUG_BRIDGE_VERSION = 'cloud-stub';
export const installMslugMod = nope;
export const uninstallMslugMod = nope;
export const ensureMslugBridge = nope;

export const ensureMslugSpawnWebhook = nope;
export const isMslugSpawnWebhookUp = falsy;
export const mslugSpawnWebhookStatus = status;
export const isMslug7760WebhookUrl = falsy;
export const runMslug7760WebhookExec = nope;

export const ensureSmbxTiktokWebhook = nope;
export const runWebhookExec = nope;
export const smbxTiktokWebhookStatus = status;
export const isMari0EnemySpawnWebhook = falsy;

export const runGameExec = nope;
export const smb3HealthOk = falsy;

export const ensureMarioBridge = nope;
export const ensureMari0Bridge = nope;
export const marioBridgeStatus = status;
export const bridgeHealthOk = falsy;

export const ensurePvzHybridBridge = nope;
export const pvzHybridBridgeStatus = status;
export const pvzHybridBridgeHealth = empty;
export const pvzHybridBridgeHealthOk = falsy;
export const findPvzToolsExe = () => null;

export const ensurePvzToolkitBridge = nope;
export const pvzToolkitBridgeStatus = status;
export const pvzToolkitBridgeHealth = empty;
export const pvzToolkitBridgeHealthOk = falsy;
