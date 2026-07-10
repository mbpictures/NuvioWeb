import { isBackEvent, normalizeKeyEvent } from "../sharedKeys.js";
import { isVegaHostBridgeAvailable, postVegaHostMessage } from "../vega/vegaBridge.js";

const VEGA_BACK_CODES = [27, 461, 10009, 8];

function isEditableTarget(target) {
  const tagName = String(target?.tagName || "").toUpperCase();
  return Boolean(
    target?.isContentEditable ||
    tagName === "INPUT" ||
    tagName === "TEXTAREA" ||
    tagName === "SELECT"
  );
}

function isDirectionalEvent(event) {
  const key = String(event?.key || "");
  const code = Number(event?.keyCode || event?.which || 0);
  return key.startsWith("Arrow") || (code >= 37 && code <= 40);
}

// Chromium spatial navigation moves focus on unhandled arrow keys, which fights
// the app focus engine. Cancelling the default action is the documented opt-out.
function suppressSpatialNavigation(event) {
  if (!isDirectionalEvent(event) || isEditableTarget(event?.target)) {
    return;
  }
  event.preventDefault?.();
}

export const vegaAdapter = {
  name: "vega",

  init() {
    globalThis.document?.addEventListener?.("keydown", suppressSpatialNavigation, true);
    globalThis.document?.documentElement?.classList?.add("vega-tv");
    globalThis.document?.body?.classList?.add("vega-tv");
  },

  exitApp() {
    return postVegaHostMessage("exit");
  },

  isBackEvent(event) {
    return isBackEvent(event, VEGA_BACK_CODES);
  },

  normalizeKey(event) {
    return normalizeKeyEvent(event, VEGA_BACK_CODES);
  },

  getDeviceLabel() {
    return "Amazon Fire TV (Vega)";
  },

  getCapabilities() {
    return {
      hlsJs: Boolean(globalThis.Hls?.isSupported?.()),
      dashJs: Boolean(globalThis.dashjs?.MediaPlayer),
      nativeVideo: true,
      webosAvplay: false,
      tizenAvplay: false,
      hostBridge: isVegaHostBridgeAvailable()
    };
  },

  prepareVideoElement(videoElement) {
    if (!videoElement) {
      return;
    }
    videoElement.disableRemotePlayback = true;
  }
};
