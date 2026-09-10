import { postVegaHostMessage } from "./vegaBridge.js";

// The device log stream drops JS console output under load (journald rotates
// aggressively on this image), so probe results are also painted into the page
// where a screenshot can read them. Development aid only.
const SHOW_PROBE_OVERLAY = false;

function paintProbeOverlay(payload) {
  if (!SHOW_PROBE_OVERLAY || typeof document === "undefined") {
    return;
  }
  try {
    let node = document.getElementById("nuvioProbeOverlay");
    if (!node) {
      node = document.createElement("pre");
      node.id = "nuvioProbeOverlay";
      node.style.cssText = [
        "position:fixed",
        "top:0",
        "left:0",
        "right:0",
        "z-index:2147483647",
        "margin:0",
        "padding:12px",
        "background:rgba(0,0,0,0.92)",
        "color:#7cf07c",
        "font-size:15px",
        "line-height:1.35",
        "white-space:pre-wrap",
        "font-family:monospace"
      ].join(";");
      document.documentElement.appendChild(node);
    }
    node.textContent = `${node.textContent}\n${JSON.stringify(payload, null, 1)}`;
  } catch (_) {
    // A probe must never break the app.
  }
}

// Measures the capabilities the in-WebView software-audio plan depends on, and
// reports them over the host bridge into `vega device start-log-stream` (the
// WebView has no reachable devtools).
//
// The plan: demux in JS, let Chromium decode the video, decode the audio codecs
// Chromium lacks (AC-3/E-AC-3/DTS) in WebAssembly, and play the resulting PCM
// through Web Audio in sync with the video element. Which variant is viable
// depends on four things that must be measured rather than assumed:
//
//   1. Does MSE accept HEVC (and Main10)? If yes, video can be fed through MSE
//      from a JS demuxer. If no, video has to stay on the plain <video> path
//      and the audio becomes a parallel sidecar (costing a second read of the
//      stream, since audio is interleaved with video in the container).
//   2. Does MSE accept AAC, and does it reject the Dolby codecs as expected?
//   3. Is Web Audio present, with AudioWorklet for sample-accurate scheduling?
//   4. Is WebAssembly present (it should be — libbitsub already runs here).

function supportsMse(type) {
  try {
    return Boolean(globalThis.MediaSource?.isTypeSupported?.(type));
  } catch (_) {
    return false;
  }
}

function canPlay(videoElement, type) {
  try {
    const result = String(videoElement?.canPlayType?.(type) || "");
    return result || "no";
  } catch (_) {
    return "err";
  }
}

const MSE_VIDEO = [
  ["h264", 'video/mp4; codecs="avc1.640028"'],
  ["hevc8", 'video/mp4; codecs="hvc1.1.6.L93.B0"'],
  ["hevc8-hev1", 'video/mp4; codecs="hev1.1.6.L93.B0"'],
  ["hevc10", 'video/mp4; codecs="hvc1.2.4.L120.B0"'],
  ["hevc10-hev1", 'video/mp4; codecs="hev1.2.4.L120.B0"'],
  // The exact string from Amazon's WebView guide, which documents this as
  // supported. It returns false on the virtual device and is expected to
  // return true on real Fire TV hardware.
  ["hevc10-doc", 'video/mp4; codecs="hev1.2.4.L153.B0"'],
  ["vp9p2-doc", 'video/webm; codecs="vp09.02.10.10"']
];

const MSE_AUDIO = [
  ["aac", 'audio/mp4; codecs="mp4a.40.2"'],
  ["ac-3", 'audio/mp4; codecs="ac-3"'],
  ["ec-3", 'audio/mp4; codecs="ec-3"'],
  ["opus", 'audio/webm; codecs="opus"'],
  ["flac", 'audio/mp4; codecs="flac"']
];

// Minimal module that uses a v128 instruction: validates only where SIMD is
// enabled. Without SIMD a software video decoder loses roughly half its speed.
const SIMD_TEST_MODULE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15,
  253, 98, 11
]);

function hasWasmSimd() {
  try {
    return Boolean(globalThis.WebAssembly?.validate?.(SIMD_TEST_MODULE));
  } catch (_) {
    return false;
  }
}

// WebCodecs would give access to whatever decoders the platform has without
// going through MSE. If HEVC is exposed here it changes the picture entirely,
// so it is worth asking rather than assuming it mirrors MSE.
export async function reportVegaVideoDecodeOptions() {
  const hasVideoDecoder = typeof globalThis.VideoDecoder === "function";
  const webCodecs = {};

  if (hasVideoDecoder) {
    const configs = [
      ["h264", "avc1.640028"],
      ["hevc8", "hvc1.1.6.L93.B0"],
      ["hevc10", "hvc1.2.4.L120.B0"]
    ];
    for (const [label, codec] of configs) {
      try {
        const result = await globalThis.VideoDecoder.isConfigSupported({
          codec,
          codedWidth: 1920,
          codedHeight: 1080
        });
        webCodecs[label] = Boolean(result?.supported);
      } catch (error) {
        webCodecs[label] = `err:${String(error?.name || error).slice(0, 24)}`;
      }
    }
  }

  const payload = {
    tag: "vega video decode options",
    videoDecoder: hasVideoDecoder,
    webCodecs,
    // These decide whether a WASM software decoder could keep up at all.
    wasmSimd: hasWasmSimd(),
    sharedArrayBuffer: typeof globalThis.SharedArrayBuffer === "function",
    crossOriginIsolated: Boolean(globalThis.crossOriginIsolated),
    hardwareConcurrency: Number(globalThis.navigator?.hardwareConcurrency || 0),
    deviceMemory: Number(globalThis.navigator?.deviceMemory || 0),
    webgl2: (() => {
      try {
        const canvas = document.createElement("canvas");
        return Boolean(canvas.getContext("webgl2"));
      } catch (_) {
        return false;
      }
    })()
  };

  paintProbeOverlay(payload);
  return postVegaHostMessage("log", payload);
}

// Can the page read stream bytes itself? libav.js demuxes over HTTP range
// requests, and the WebView's fetch() is CORS-restricted (which is why
// fetchViaVegaHost exists for manifests). A `Range` header is not CORS-safelisted,
// so it triggers a preflight; if the server's Access-Control-Allow-Headers omits
// Range, the browser blocks the read and the bytes have to be proxied through
// the native host bridge instead. The <video> element is unaffected because it
// loads media no-cors.
export async function reportVegaRangeFetch(urls = []) {
  const results = [];

  for (const entry of urls) {
    const label = String(entry?.label || "");
    const url = String(entry?.url || "");
    if (!url) {
      continue;
    }

    // With Range: the case libav.js actually needs.
    try {
      const response = await fetch(url, { headers: { Range: "bytes=0-1023" } });
      const buffer = await response.arrayBuffer();
      results.push({
        label,
        mode: "range",
        status: response.status,
        bytes: buffer.byteLength,
        contentRange: response.headers.get("Content-Range") || "",
        ok: response.ok
      });
    } catch (error) {
      results.push({ label, mode: "range", error: String(error?.message || error).slice(0, 90) });
    }

    // Without Range: a simple request, so no preflight. Distinguishes "CORS
    // blocks everything here" from "CORS blocks only the preflighted Range".
    try {
      const response = await fetch(url);
      results.push({ label, mode: "plain", status: response.status, ok: response.ok });
      // Not read to completion on purpose: these are large files.
      response.body?.cancel?.();
    } catch (error) {
      results.push({ label, mode: "plain", error: String(error?.message || error).slice(0, 90) });
    }
  }

  const payload = { tag: "vega range fetch", results };
  paintProbeOverlay(payload);
  return postVegaHostMessage("log", payload);
}

// Exercises the real production path end to end: the tracks repository's Vega
// branch -> libav.js demux over range requests -> the media-track shape the
// audio selector consumes.
export async function reportVegaTrackProbe(url) {
  const started = Date.now();
  let payload;
  try {
    // Calls the reader directly: the repository swallows failures and caches an
    // empty list, which hides the cause.
    const { ensureLibavReady, readContainerTracksAsMediaTracks } =
      await import("../../core/player/containerTracks/libavContainerReader.js");
    // Loading the WASM is the part most likely to break on this platform, and
    // it fails before any media URL is touched — so report it separately.
    const load = await ensureLibavReady();
    paintProbeOverlay({ tag: "vega libav load", ...load });
    const tracks = url ? await readContainerTracksAsMediaTracks(url) : [];
    payload = {
      tag: "vega track probe",
      ms: Date.now() - started,
      count: tracks.length,
      tracks: tracks.map((t) => ({
        type: t.type,
        id: t.id,
        codec: t.codec,
        language: t.language,
        title: t.title,
        channels: t.channels
      }))
    };
  } catch (error) {
    payload = {
      tag: "vega track probe",
      ms: Date.now() - started,
      error: String(error?.message || error).slice(0, 160)
    };
  }
  paintProbeOverlay(payload);
  return postVegaHostMessage("log", payload);
}

// Web Workers are documented as supported on Vega, but the page runs from
// file:// (origin "null"), where constructing a Worker from a file:// script
// fails outright. The usual escape is a blob: URL — this measures whether that
// works here, because it decides whether continuous audio decoding can run off
// the main thread or has to share it with the UI.
export async function reportVegaWorkerSupport() {
  const results = {};

  // 1. Directly from a file:// sibling script, which is what libav.js does.
  try {
    const worker = new Worker(`${"assets/libs/libav"}/libav-6.10.9.0-nuvio-dolby.js`);
    worker.terminate();
    results.fileWorker = true;
  } catch (error) {
    results.fileWorker = String(error?.message || error).slice(0, 100);
  }

  // 2. From a blob: URL, the standard workaround for a null origin.
  try {
    const source = "self.onmessage=function(e){self.postMessage(e.data*2)};";
    const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    const worker = new Worker(url);
    const value = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("blob worker timeout")), 4000);
      worker.onmessage = (event) => {
        clearTimeout(timer);
        resolve(event.data);
      };
      worker.onerror = (event) => {
        clearTimeout(timer);
        reject(new Error(event?.message || "blob worker error"));
      };
      worker.postMessage(21);
    });
    worker.terminate();
    URL.revokeObjectURL(url);
    results.blobWorker = value === 42 ? true : `unexpected:${value}`;
  } catch (error) {
    results.blobWorker = String(error?.message || error).slice(0, 100);
  }

  // 3. Can a worker pull in a file:// script once it is running?
  try {
    const source =
      "self.onmessage=function(e){try{importScripts(e.data);" +
      "self.postMessage(typeof LibAVFactory!=='undefined'?'ok:factory':'ok:no-factory')}" +
      "catch(err){self.postMessage('ERR '+err.message)}};";
    const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    const worker = new Worker(url);
    const absolute = new URL("assets/libs/libav/libav-6.10.9.0-nuvio-dolby.js", location.href).href;
    const value = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("importScripts timeout")), 5000);
      worker.onmessage = (event) => {
        clearTimeout(timer);
        resolve(event.data);
      };
      worker.onerror = (event) => {
        clearTimeout(timer);
        reject(new Error(event?.message || "worker error"));
      };
      worker.postMessage(absolute);
    });
    worker.terminate();
    URL.revokeObjectURL(url);
    results.blobWorkerImportsFile = value;
  } catch (error) {
    results.blobWorkerImportsFile = String(error?.message || error).slice(0, 100);
  }

  const payload = { tag: "vega worker support", ...results };
  paintProbeOverlay(payload);
  return postVegaHostMessage("log", payload);
}

// Measures real decode throughput on the device. `realtimeFactor` is the number
// that decides the playback architecture: seconds of audio decoded per second
// of wall clock. Below ~1 nothing can work; comfortably above it means audio can
// be decoded a little ahead of the playhead rather than far in advance.
export async function reportVegaDecodeBenchmark(url, streamIndex) {
  const { benchmarkDolbyDecode } = await import("../../core/player/vegaAudio/dolbyAudioDecoder.js");
  const payload = {
    tag: "vega decode benchmark",
    ...(await benchmarkDolbyDecode({ url, streamIndex, seconds: 5 }))
  };
  paintProbeOverlay(payload);
  return postVegaHostMessage("log", payload);
}

// Runs the real Dolby audio track against a synthetic clock and reports what
// happened. A virtual device cannot be listened to, so the evidence is: the
// AudioContext is running, buffers were scheduled, and the decoded PCM has a
// non-zero peak.
// Does the AudioContext clock actually advance on this platform, and does a
// plain oscillator produce output? Everything in the audio sidecar is scheduled
// against context.currentTime, so if that clock is frozen nothing else can work.
export async function reportVegaAudioClock() {
  const payload = { tag: "vega audio clock" };
  try {
    const AudioContextImpl = globalThis.AudioContext || globalThis.webkitAudioContext;
    const context = new AudioContextImpl();
    payload.initialState = context.state;
    payload.t0 = Number(context.currentTime.toFixed(3));

    // Some platforms hold a context suspended until resume() or a user gesture.
    try {
      await context.resume();
    } catch (error) {
      payload.resumeError = String(error?.message || error).slice(0, 60);
    }
    payload.stateAfterResume = context.state;

    // An oscillator through an analyser: proves the graph renders, not just
    // that the clock ticks.
    const oscillator = context.createOscillator();
    const analyser = context.createAnalyser();
    const silent = context.createGain();
    silent.gain.value = 0.0001;
    oscillator.connect(analyser);
    analyser.connect(silent);
    silent.connect(context.destination);
    oscillator.start();

    await new Promise((resolve) => setTimeout(resolve, 2000));

    const samples = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(samples);
    let peak = 0;
    for (let i = 0; i < samples.length; i += 1) {
      const value = Math.abs(samples[i]);
      if (value > peak) {
        peak = value;
      }
    }

    payload.t2 = Number(context.currentTime.toFixed(3));
    payload.advancedSeconds = Number((context.currentTime - payload.t0).toFixed(3));
    payload.oscillatorPeak = Number(peak.toFixed(4));
    payload.sampleRate = context.sampleRate;
    payload.finalState = context.state;
    oscillator.stop();
    await context.close();
  } catch (error) {
    payload.error = String(error?.message || error).slice(0, 160);
  }
  paintProbeOverlay(payload);
  return postVegaHostMessage("log", payload);
}

export async function reportVegaAudioPlayback(url, streamIndex) {
  const { createDolbyAudioTrack } = await import("../../core/player/vegaAudio/dolbyAudioTrack.js");

  // Stands in for the <video> element: the track only needs a clock, a paused
  // flag and the media events.
  const listeners = {};
  const startedAt = Date.now();
  const fakeVideo = {
    paused: false,
    seeking: false,
    muted: false,
    get currentTime() {
      return (Date.now() - startedAt) / 1000;
    },
    addEventListener(type, handler) {
      listeners[type] = handler;
    },
    removeEventListener(type) {
      delete listeners[type];
    }
  };

  const track = createDolbyAudioTrack({ video: fakeVideo, url, streamIndex });
  let payload;
  try {
    const info = await track.start();
    // Let the pump run for a few seconds of wall clock.
    await new Promise((resolve) => setTimeout(resolve, 5000));
    payload = { tag: "vega audio playback", ok: true, ...info, ...track.getStats() };
  } catch (error) {
    payload = {
      tag: "vega audio playback",
      ok: false,
      error: String(error?.message || error).slice(0, 160)
    };
  } finally {
    await track.stop();
  }

  paintProbeOverlay(payload);
  return postVegaHostMessage("log", payload);
}

export function reportVegaWebAudioCapabilities(videoElement = null) {
  const mseVideo = {};
  MSE_VIDEO.forEach(([label, type]) => {
    mseVideo[label] = supportsMse(type);
  });

  const mseAudio = {};
  MSE_AUDIO.forEach(([label, type]) => {
    mseAudio[label] = supportsMse(type);
  });

  let audioContextRate = 0;
  let audioWorklet = false;
  try {
    const AudioContextImpl = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (AudioContextImpl) {
      const context = new AudioContextImpl();
      audioContextRate = Number(context.sampleRate || 0);
      audioWorklet = typeof context.audioWorklet?.addModule === "function";
      // Probing must not leave a live context holding the audio device.
      context.close?.();
    }
  } catch (_) {
    audioContextRate = -1;
  }

  const payload = {
    tag: "vega webaudio caps",
    mseVideo,
    mseAudio,
    mediaSource: typeof globalThis.MediaSource === "function",
    sourceBuffer: typeof globalThis.SourceBuffer === "function",
    audioContext: audioContextRate,
    audioWorklet,
    audioWorkletNode: typeof globalThis.AudioWorkletNode === "function",
    wasm: typeof globalThis.WebAssembly === "object",
    wasmStreaming: typeof globalThis.WebAssembly?.instantiateStreaming === "function",
    // Matroska matters because Chromium reports "" for it yet often plays it
    // anyway; if the element really does play the user's .mkv files, video can
    // stay where it is and only the audio needs replacing.
    canPlayMkv: canPlay(videoElement, "video/x-matroska"),
    canPlayMkvHevc: canPlay(videoElement, 'video/x-matroska; codecs="hvc1.2.4.L120.B0"'),
    canPlayMp4Hevc: canPlay(videoElement, 'video/mp4; codecs="hvc1.2.4.L120.B0"')
  };

  paintProbeOverlay(payload);
  return postVegaHostMessage("log", payload);
}
