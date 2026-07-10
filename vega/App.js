import React, { useCallback, useRef } from "react";
import { BackHandler, StyleSheet, View } from "react-native";
import { WebView } from "@amazon-devices/webview";

const WEB_APP_URI = "file:///pkg/assets/web/index.html";
const BACKGROUND_COLOR = "#0e0f12";
const BRIDGE_SOURCE = "nuvio";
const FETCH_TIMEOUT_MS = 10000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

// Runs before the bundle so Platform.detect() resolves to the Vega adapter even
// if the WebView user agent carries no Vega marker.
const PLATFORM_BOOTSTRAP = 'window.__NUVIO_PLATFORM__ = "vega"; true;';

// U+2028/U+2029 are literal line terminators in JS source but legal inside a
// JSON string, so they must be escaped before the value is injected as code.
// split/join avoids embedding the literal chars in a regex pattern (which Babel rejects).
const LS = " ";
const PS = " ";
function escapeLineTerminators(str) {
  return str.split(LS).join("\\u2028").split(PS).join("\\u2029");
}

// Produces a quoted JS string literal from any value (for bridge messages that
// expect a JSON string argument, like __NUVIO_VEGA_BRIDGE__.receive).
function toInjectableString(value) {
  return escapeLineTerminators(JSON.stringify(JSON.stringify(value)));
}

// Produces a JS object/array/primitive literal from any value (for callbacks
// that expect a plain object, like __VEGA_FETCH_RECV__).
function toInjectableObject(value) {
  return escapeLineTerminators(JSON.stringify(value));
}

function isProxyableUrl(value) {
  try {
    return new URL(String(value)).protocol === "https:";
  } catch (error) {
    return false;
  }
}

async function performProxiedFetch(payload) {
  const { id, url, method = "GET", headers = {}, body: requestBody = null } = payload || {};

  if (!isProxyableUrl(url)) {
    return { id, ok: false, error: "blocked" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method,
      headers,
      body: requestBody || undefined,
      signal: controller.signal
    });
    const body = await response.text();
    if (body.length > MAX_RESPONSE_BYTES) {
      return { id, ok: false, error: "too-large" };
    }

    const responseHeaders = {};
    response.headers?.forEach?.((headerValue, headerName) => {
      responseHeaders[headerName] = headerValue;
    });

    return { id, ok: true, status: response.status, headers: responseHeaders, body };
  } catch (error) {
    return { id, ok: false, error: String(error?.message || error) };
  } finally {
    clearTimeout(timer);
  }
}

export default function App() {
  const webViewRef = useRef(null);

  const replyToWeb = useCallback((message) => {
    const payload = toInjectableString(message);
    webViewRef.current?.injectJavaScript(
      `window.__NUVIO_VEGA_BRIDGE__ && window.__NUVIO_VEGA_BRIDGE__.receive(${payload}); true;`
    );
  }, []);

  const onMessage = useCallback(
    (event) => {
      const raw = String(event?.nativeEvent?.data || "");
      if (!raw) {
        return;
      }

      let message = null;
      try {
        message = JSON.parse(raw);
      } catch (error) {
        console.warn("Nuvio bridge received a non-JSON message", error);
        return;
      }

      if (message?.source !== BRIDGE_SOURCE) {
        return;
      }

      if (message.type === "exit") {
        BackHandler?.exitApp?.();
        return;
      }

      if (message.type === "fetch") {
        performProxiedFetch(message.payload).then(replyToWeb);
      }

      if (message.type === "vegafetch") {
        performProxiedFetch(message.payload).then((result) => {
          // toInjectableObject produces a JS object literal (single encode),
          // not a quoted string, so __VEGA_FETCH_RECV__ gets an object, not a string.
          const json = toInjectableObject(result);
          webViewRef.current?.injectJavaScript(
            `window.__VEGA_FETCH_RECV__ && window.__VEGA_FETCH_RECV__(${json}); true;`
          );
        });
      }
    },
    [replyToWeb]
  );

  const onError = useCallback((event) => {
    console.warn("Nuvio WebView error", event?.nativeEvent);
  }, []);

  const onHttpError = useCallback((event) => {
    console.warn("Nuvio WebView HTTP error", event?.nativeEvent);
  }, []);

  return (
    <View style={styles.container}>
      <WebView
        ref={webViewRef}
        style={styles.webView}
        source={{ uri: WEB_APP_URI }}
        hasTVPreferredFocus
        javaScriptEnabled
        domStorageEnabled
        allowFileAccess
        allowSystemKeyEvents
        allowsDefaultMediaControl
        thirdPartyCookiesEnabled
        mediaPlaybackRequiresUserAction={false}
        mixedContentMode="compatibility"
        injectedJavaScriptBeforeContentLoaded={PLATFORM_BOOTSTRAP}
        onMessage={onMessage}
        onError={onError}
        onHttpError={onHttpError}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: BACKGROUND_COLOR
  },
  webView: {
    flex: 1,
    backgroundColor: BACKGROUND_COLOR
  }
});
