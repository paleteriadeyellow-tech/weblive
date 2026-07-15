/** Carga real de bridges/ffmpeg (PC local / no-Render). */
export { default as ffmpegPath } from 'ffmpeg-static';

export { stopMarioBridge, ensureMarioBridge, ensureMari0Bridge, marioBridgeStatus, bridgeHealthOk } from './mario-bridge.js';
export { stopPvzHybridBridge, ensurePvzHybridBridge, pvzHybridBridgeStatus, pvzHybridBridgeHealth, pvzHybridBridgeHealthOk, findPvzToolsExe } from './pvz-hybrid-bridge.js';
export {
  stopRepoBridge, ensureRepoBridge, repoBridgeHealth, repoBridgeHealthOk, repoBridgeStatus,
  getRepoGameDirConfig, setRepoGameDir, installRepoMod, uninstallRepoMod,
} from './repo-bridge.js';
export {
  stopL4dBridge, l4dBridgeHealth, l4dBridgeStatus, getL4dGameDirConfig, setL4dGameDir,
  discoverL4dGameDir, syncL4dGameDir, installL4dMod, uninstallL4dMod,
} from './l4d-bridge.js';
export {
  stopUnturnedBridge, unturnedBridgeHealth, unturnedBridgeStatus,
  getUnturnedGameDirConfig, setUnturnedGameDir, discoverUnturnedSteamDir, syncUnturnedGameDir,
  installUnturnedMod, uninstallUnturnedMod,
} from './unturned-bridge.js';
export { ensureMcCoreLicense, mcCoreLicenseStatus, stopMcCoreBridge } from './mc-core-bridge.js';
export { ctrBridgeHealth, ensureCtrBridge, ctrBridgeStatus } from './ctr-bridge.js';
export { ensureSmwBridge, smwBridgeHealth, smwBridgeStatus, installSmwMod, uninstallSmwMod } from './smw-bridge.js';
export {
  mslugBridgeHealth, mslugBridgeStatus, getMslugGameDirConfig, setMslugGameDir,
  getMslugLastSpawn, MSLUG_BRIDGE_VERSION,
  installMslugMod, uninstallMslugMod, ensureMslugBridge,
} from './mslug-bridge.js';
export {
  ensureMslugSpawnWebhook, isMslugSpawnWebhookUp, mslugSpawnWebhookStatus,
  isMslug7760WebhookUrl, runMslug7760WebhookExec,
} from './mslug-spawn-webhook.js';
export {
  ensureSmbxTiktokWebhook, stopSmbxTiktokWebhook, runWebhookExec, smbxTiktokWebhookStatus,
  isMari0EnemySpawnWebhook,
} from './smbx-tiktok-webhook.js';
export { runGameExec, smb3HealthOk } from './game-local.js';
export {
  ensurePvzToolkitBridge, pvzToolkitBridgeStatus, pvzToolkitBridgeHealth,
  pvzToolkitBridgeHealthOk, stopPvzToolkitBridge,
} from './pvz-toolkit-bridge.js';
