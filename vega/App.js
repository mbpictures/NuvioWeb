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
// JSON string, so they must be escaped before the reply is injected as code.
function toInjectableString(value) {
  return JSON.stringify(value)
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function isProxyableUrl(value) {
  try {
    return new URL(String(value)).protocol === "https:";
  } catch (error) {
    return false;
  }
}

async function performProxiedFetch(payload) {
  const { id, url, method = "GET", headers = {} } = payload || {};

  if (!isProxyableUrl(url)) {
    return { id, ok: false, error: "blocked" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, { method, headers, signal: controller.signal });
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
    const payload = toInjectableString(JSON.stringify(message));
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
