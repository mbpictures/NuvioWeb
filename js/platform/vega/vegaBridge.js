const BRIDGE_SOURCE = "nuvio";

function getHostBridge() {
  const bridge = globalThis.ReactNativeWebView;
  if (!bridge || typeof bridge.postMessage !== "function") {
    return null;
  }
  return bridge;
}

export function isVegaHostBridgeAvailable() {
  return Boolean(getHostBridge());
}

export function postVegaHostMessage(type, payload = {}) {
  const bridge = getHostBridge();
  if (!bridge || !type) {
    return false;
  }

  try {
    bridge.postMessage(
      JSON.stringify({
        source: BRIDGE_SOURCE,
        type: String(type),
        payload
      })
    );
    return true;
  } catch (error) {
    console.warn("Vega host bridge message failed:", error);
    return false;
  }
}
