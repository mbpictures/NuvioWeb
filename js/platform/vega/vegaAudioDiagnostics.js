import { postVegaHostMessage } from "./vegaBridge.js";

// Diagnostics for the Vega audio path (js/core/player/vegaAudio/).
//
// Two device facts shape this. The Kepler logger truncates object arguments -
// console.log("x", {a, b}) prints half a line - and the device log stream drops
// console output under load, while a message posted over the host bridge is
// printed by vega/App.js as one complete line. So every diagnostic here is a
// single pre-built string, and it goes out both ways.

// Plays two short tones on the device: 440Hz on the first key press after the
// app starts, and 880Hz through the sidecar's own output graph the moment a
// decoded track takes over. Together they tell apart, by ear, the three ways
// the third hardware run (2026-09-10) could have gone silent with the context
// reporting "running": no tone at all means Web Audio has no audible output on
// this WebView; only the first tone means the element's own audio stream shuts
// the sidecar's context out of the output; both tones but no track audio means
// the fault is in decoding or scheduling and the stats lines say which.
// Turn off once audio through the sidecar has been heard.
export const VEGA_AUDIO_DEBUG_TONE = true;

function formatDetails(details) {
  if (!details || typeof details !== "object") {
    return "";
  }
  return Object.entries(details)
    .map(([key, value]) => {
      if (typeof value === "number" || typeof value === "boolean" || value == null) {
        return `${key}=${value}`;
      }
      return `${key}=${JSON.stringify(value)}`;
    })
    .join(" ");
}

function emit(level, message, details) {
  const detailText = formatDetails(details);
  const text = detailText ? `${message} ${detailText}` : String(message);
  if (level === "warn") {
    console.warn(text);
  } else {
    console.log(text);
  }
  postVegaHostMessage("log", { tag: "vega audio", level, message: text });
  return text;
}

export function vegaAudioLog(message, details) {
  return emit("log", message, details);
}

export function vegaAudioWarn(message, details) {
  return emit("warn", message, details);
}

/** The facts about an AudioContext that decide whether it can be heard. */
export function describeAudioContext(context) {
  if (!context) {
    return { context: "none" };
  }
  let maxChannelCount = 0;
  let channelCount = 0;
  try {
    maxChannelCount = Number(context.destination?.maxChannelCount || 0);
    channelCount = Number(context.destination?.channelCount || 0);
  } catch (_) {
    // Some implementations throw on destination access after close().
  }
  return {
    state: String(context.state || ""),
    sampleRate: Number(context.sampleRate || 0),
    currentTime: Number((Number(context.currentTime) || 0).toFixed(3)),
    baseLatency: Number((Number(context.baseLatency) || 0).toFixed(4)),
    outputLatency: Number((Number(context.outputLatency) || 0).toFixed(4)),
    maxChannelCount,
    channelCount
  };
}

/**
 * Plays a short tone through `output`, an AudioNode that reaches the
 * destination, and resolves once it has ended. Resolves false when the graph
 * refused it, which is itself a finding.
 */
export function playVegaDebugTone(
  context,
  output,
  { frequency = 880, durationMs = 250, level = 0.2 } = {}
) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    try {
      const oscillator = context.createOscillator();
      const envelope = context.createGain();
      oscillator.frequency.value = frequency;
      envelope.gain.value = level;
      oscillator.connect(envelope);
      envelope.connect(output);
      oscillator.onended = () => {
        try {
          oscillator.disconnect();
          envelope.disconnect();
        } catch (_) {
          // Already gone.
        }
        finish(true);
      };
      const now = context.currentTime;
      oscillator.start(now);
      oscillator.stop(now + durationMs / 1000);
      // onended never fires on a context whose clock does not advance.
      setTimeout(() => finish(true), durationMs + 500);
    } catch (_) {
      finish(false);
    }
  });
}

/**
 * Plays the startup tone on the first key press, which is the earliest moment
 * a user activation is guaranteed and long before any media element holds the
 * audio output. Logs what the context looked like while it played.
 */
export function armVegaStartupAudioTone() {
  if (!VEGA_AUDIO_DEBUG_TONE || typeof document === "undefined") {
    return;
  }
  const onKeyDown = () => {
    document.removeEventListener("keydown", onKeyDown, true);
    void (async () => {
      const AudioContextImpl = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (typeof AudioContextImpl !== "function") {
        vegaAudioLog("Vega startup tone skipped: no AudioContext");
        return;
      }
      let context = null;
      try {
        context = new AudioContextImpl();
        try {
          await context.resume();
        } catch (_) {
          // Reported through the state below.
        }
        const before = Number(context.currentTime) || 0;
        const played = await playVegaDebugTone(context, context.destination, {
          frequency: 440,
          durationMs: 300
        });
        vegaAudioLog("Vega startup tone", {
          played,
          advanced: Number(((Number(context.currentTime) || 0) - before).toFixed(3)),
          ...describeAudioContext(context)
        });
      } catch (error) {
        vegaAudioWarn(`Vega startup tone failed: ${String(error?.message || error)}`);
      } finally {
        try {
          await context?.close();
        } catch (_) {
          // Already closed.
        }
      }
    })();
  };
  document.addEventListener("keydown", onKeyDown, true);
}
