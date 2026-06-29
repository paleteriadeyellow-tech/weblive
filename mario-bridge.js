// Los bridges de Mario/Mari0 corren en la PC del streamer (.exe). Stub en Render.
const noop = async () => false;

export function bridgeHealthOk() { return false; }
export const isMarioBridgeUp = noop;
export const isMari0BridgeUp = noop;
export function stopMarioBridge() {}
export const ensureMarioBridge = noop;
export const ensureMari0Bridge = noop;
export function marioBridgeStatus() { return { ok: false }; }
