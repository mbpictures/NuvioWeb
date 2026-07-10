import { Environment } from "../environment.js";
import { isVegaHostBridgeAvailable, postVegaHostMessage } from "./vegaBridge.js";

const DEFAULT_TIMEOUT_MS = 8000;
const RECEIVER_GLOBAL = "__NUVIO_VEGA_BRIDGE__";
const NULL_BODY_RESPONSE_STATUSES = new Set([204, 205, 304]);

const pendingRequests = new Map();
let nextRequestId = 1;
let receiverInstalled = false;

// The host answers by calling into this global via injectJavaScript, since a
// WebView can only push strings back into the page.
function installReceiver() {
  if (receiverInstalled) {
    return;
  }
  receiverInstalled = true;
  globalThis[RECEIVER_GLOBAL] = {
    receive(raw) {
      let message = null;
      try {
        message = JSON.parse(String(raw || ""));
      } catch (error) {
        console.warn("Vega host bridge sent an unparsable reply:", error);
        return;
      }
      const pending = pendingRequests.get(message?.id);
      if (!pending) {
        return;
      }
      pendingRequests.delete(message.id);
      pending.settle(message);
    }
  };
}

function isProxyableUrl(value = "") {
  try {
    return new URL(String(value || "").trim()).protocol === "https:";
  } catch (_) {
    return false;
  }
}

function buildResponse(message) {
  const status = Number(message?.status || 0);
  if (!status) {
    return null;
  }
  const headers = message?.headers && typeof message.headers === "object" ? message.headers : {};
  const body = NULL_BODY_RESPONSE_STATUSES.has(status)
    ? null
    : typeof message?.body === "string"
      ? message.body
      : "";

  if (typeof Response === "function") {
    return new Response(body, { status, headers });
  }

  return {
    status,
    ok: status >= 200 && status < 300,
    async text() {
      return body || "";
    },
    async json() {
      return JSON.parse(body || "null");
    }
  };
}

export function isVegaHostFetchAvailable() {
  return Environment.isVega() && isVegaHostBridgeAvailable();
}

/**
 * Performs a request on the React Native host, which is not subject to the
 * WebView's CORS rules. Returns null when the bridge is unavailable or the
 * request fails, so callers can fall back to a normal fetch.
 */
export function fetchViaVegaHost(url, { method = "GET", headers = {}, timeoutMs } = {}) {
  if (!isVegaHostFetchAvailable() || !isProxyableUrl(url)) {
    return Promise.resolve(null);
  }

  installReceiver();
  const id = nextRequestId;
  nextRequestId += 1;

  return new Promise((resolve) => {
    let timer = 0;

    const settle = (message) => {
      if (timer) {
        clearTimeout(timer);
      }
      if (!message?.ok) {
        resolve(null);
        return;
      }
      resolve(buildResponse(message));
    };

    pendingRequests.set(id, { settle });

    timer = setTimeout(
      () => {
        pendingRequests.delete(id);
        resolve(null);
      },
      Math.max(1, Number(timeoutMs) || DEFAULT_TIMEOUT_MS)
    );

    const posted = postVegaHostMessage("fetch", {
      id,
      url: String(url),
      method: String(method || "GET").toUpperCase(),
      headers
    });

    if (!posted) {
      pendingRequests.delete(id);
      clearTimeout(timer);
      resolve(null);
    }
  });
}
