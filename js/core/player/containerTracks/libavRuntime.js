// Shared libav.js runtime: loading the WASM under file://, instantiating it,
// and reading remote files through range requests. Used by both track
// discovery and audio decoding so there is one implementation of the
// platform workarounds.
// Reads a media container's track list without downloading it.
//
// Chromium exposes no AudioTrackList on Vega, so a multi-language stream shows
// exactly one synthetic entry in the audio selector. libav.js (ffmpeg compiled
// to WebAssembly) can demux the container itself and report every stream with
// its language and title, which is what the selector needs.
//
// Only the container's index is read, via HTTP range requests served on demand
// through libav's block-reader device — a 10GB remote file costs a few hundred
// KB here, not a download.

const LIBAV_VARIANT = "libav-6.10.9.0-nuvio-dolby";
const LIBAV_BASE = "assets/libs/libav";
// Enough for the demuxer to find the index and stream headers on a normal file.
// Matroska keeps its cues at the end as often as the start, so the reader must
// be able to seek; this is only the per-request chunk size.
const BLOCK_SIZE = 256 * 1024;
const PROBE_TIMEOUT_MS = 20000;
// Workers ARE available from file://, just not by pointing `new Worker()` at a
// file:// script — that fails with "cannot be accessed from origin 'null'".
// A blob: worker is allowed, and a blob worker may then importScripts() a
// file:// URL (both measured on device). So the worker is bootstrapped from a
// tiny blob shim that imports the emscripten glue, and nothing else — see
// resolveWorkerUrl for why "nothing else" is load-bearing.
//
// This matters: demuxing takes ~1.4s on a real stream, which would visibly
// freeze the UI if it ran on the main thread — and continuous audio decoding
// later would be far worse.
let workerUrlPromise = null;

function resolveAssetUrl(relativePath) {
  return new URL(relativePath, globalThis.location.href).href;
}

async function resolveWorkerUrl() {
  if (!workerUrlPromise) {
    workerUrlPromise = (async () => {
      // libav's own `toImport` default is `base + "/libav-<ver>-<variant>.<target>.js"`
      // — the emscripten glue, NOT the dispatcher. Importing the dispatcher
      // here produces a worker that never signals ready, because the dispatcher
      // has no worker-side message loop.
      const workerScript = resolveAssetUrl(`${LIBAV_BASE}/${LIBAV_VARIANT}.wasm.js`);
      // The shim must NOT define `LibAV`. The glue installs its worker-side
      // message loop only when `typeof LibAV === "undefined"` - that is how it
      // tells "I am the worker" from "I was imported with noworker". Setting
      // `LibAV.base` here to help it find siblings makes it skip the loop
      // entirely: the worker loads, defines its factory, and then ignores the
      // config message forever, so the factory promise never settles. It does
      // not need `base` anyway, because `wasmurl` is passed explicitly.
      const shim = `importScripts(${JSON.stringify(workerScript)});\n`;
      return URL.createObjectURL(new Blob([shim], { type: "text/javascript" }));
    })().catch((error) => {
      workerUrlPromise = null;
      throw error;
    });
  }
  return workerUrlPromise;
}

let libavLoadPromise = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.onload = resolve;
    script.onerror = () => {
      script.remove();
      reject(new Error(`Failed to load ${src}`));
    };
    document.head.appendChild(script);
  });
}

// Emscripten normally fetches its own .wasm, which Chromium forbids under
// file://. The build emits the binary as base64 in a script instead; script
// tags are permitted from file://. Decoded once into a blob URL that libav
// accepts through its `wasmurl` option.
let wasmUrlPromise = null;

async function resolveWasmUrl() {
  if (!wasmUrlPromise) {
    wasmUrlPromise = (async () => {
      await loadScript(`${LIBAV_BASE}/${LIBAV_VARIANT}.wasm.base64.js`);
      const base64 = globalThis.__LIBAV_WASM_BASE64__;
      if (!base64) {
        throw new Error("libav wasm payload missing");
      }
      const binary = globalThis.atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }
      // Released for GC: a few MB of base64 is not worth holding.
      globalThis.__LIBAV_WASM_BASE64__ = "";
      return URL.createObjectURL(new Blob([bytes], { type: "application/wasm" }));
    })().catch((error) => {
      wasmUrlPromise = null;
      throw error;
    });
  }
  return wasmUrlPromise;
}

async function loadLibav() {
  if (globalThis.LibAV?.LibAV) {
    return globalThis.LibAV;
  }
  if (!libavLoadPromise) {
    libavLoadPromise = (async () => {
      // `base` tells libav.js where to find its own files alongside the loader.
      globalThis.LibAV = globalThis.LibAV || {};
      globalThis.LibAV.base = LIBAV_BASE;
      await loadScript(`${LIBAV_BASE}/${LIBAV_VARIANT}.js`);
      if (!globalThis.LibAV?.LibAV) {
        throw new Error("libav.js did not initialize");
      }
      return globalThis.LibAV;
    })().catch((error) => {
      libavLoadPromise = null;
      throw error;
    });
  }
  return libavLoadPromise;
}

// Whether to run libav on a worker is per-caller, because the two callers want
// opposite things. Measured on device against a real stream:
//
//              libav load    track read
//   main       201ms         1426ms
//   worker     8190ms        17743ms
//
// Each instance pays a fresh WASM compile, and a worker's is ~8s on this
// hardware — far more than the work itself for a one-off index read that is
// then cached per URL, so track discovery stays on the main thread.
//
// Continuous audio decoding is the opposite shape: long lived and CPU-heavy.
// On the main thread it saturates the event loop and the UI stops responding
// entirely, so it pays the startup cost once and runs on a worker.
const WORKER_READY_TIMEOUT_MS = 30000;

/**
 * @param {{worker?: boolean}} [options] `worker: true` keeps the decode off the
 *   main thread. Falls back to the main thread if the worker cannot start,
 *   since a slow UI beats no audio.
 */
export async function instantiateLibav({ worker = false } = {}) {
  const LibAVFactory = await loadLibav();
  const wasmurl = await resolveWasmUrl();

  if (worker) {
    const startedAt = Date.now();
    try {
      const toImport = await resolveWorkerUrl();
      // Guarded: a worker that never signals ready must not hang the caller.
      const instance = await Promise.race([
        LibAVFactory.LibAV({ wasmurl, toImport, variant: LIBAV_VARIANT }),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("libav worker never became ready")),
            WORKER_READY_TIMEOUT_MS
          )
        )
      ]);
      console.log("libav worker ready", { ms: Date.now() - startedAt });
      return instance;
    } catch (error) {
      console.warn(
        `libav worker unavailable after ${Date.now() - startedAt}ms; running on ` +
          `the main thread: ${String(error?.message || error)}`
      );
    }
  }

  return LibAVFactory.LibAV({ wasmurl, noworker: true });
}

// One libav instance is kept alive for audio decoding. Instantiating it costs
// several seconds on this hardware, and switching audio language would pay that
// again every time. Only one decoder runs at a time - the sidecar tears the
// previous track down before starting the next - so a single shared instance is
// enough, and it is released when playback ends.
let sharedDecodePromise = null;

/** The shared worker-hosted instance used for continuous audio decoding. */
export function acquireDecodeLibav() {
  if (!sharedDecodePromise) {
    sharedDecodePromise = instantiateLibav({ worker: true }).catch((error) => {
      sharedDecodePromise = null;
      throw error;
    });
  }
  return sharedDecodePromise;
}

/**
 * Tears the shared instance down: at the end of playback, or after an error
 * that may have left its format context in an unknown state.
 */
export async function releaseDecodeLibav() {
  const pending = sharedDecodePromise;
  sharedDecodePromise = null;
  if (!pending) {
    return;
  }
  try {
    (await pending).terminate();
  } catch (_) {
    // Never started, or already gone.
  }
}

/**
 * Loads and instantiates libav.js without touching the network for media.
 * Useful on platforms where the WASM asset path is the thing in doubt.
 */
export async function ensureLibavReady() {
  const started = Date.now();
  const libav = await instantiateLibav();
  try {
    return {
      ok: true,
      ms: Date.now() - started,
      variant: LIBAV_VARIANT,
      libavVersion: String(libav.libavjsVersion || libav.VERSION || ""),
      hasDemuxer: typeof libav.ff_init_demuxer_file === "function",
      hasBlockReader: typeof libav.mkblockreaderdev === "function",
      hasDecoder: typeof libav.ff_init_decoder === "function"
    };
  } finally {
    try {
      libav.terminate();
    } catch (_) {
      // Nothing else to release.
    }
  }
}

// A byte-range reader. Overridable because the Vega WebView's fetch() is
// subject to CORS restrictions that block many stream hosts; there the reads
// have to be proxied through the native host bridge instead.
export async function defaultRangeFetch(url, start, end, { signal } = {}) {
  const response = await fetch(url, {
    headers: { Range: `bytes=${start}-${end}` },
    signal
  });
  if (!response.ok) {
    throw new Error(`Range request failed (HTTP ${response.status}) at byte ${start}`);
  }
  const contentRange = response.headers.get("Content-Range") || "";
  const totalMatch = /\/(\d+)\s*$/.exec(contentRange);
  return {
    bytes: new Uint8Array(await response.arrayBuffer()),
    // Usually 0: Content-Range is not a CORS-safelisted response header, so it
    // reads as empty cross-origin unless the server opts in via
    // Access-Control-Expose-Headers. probeTotalSize covers that case.
    totalSize: totalMatch ? Number(totalMatch[1]) : 0,
    // A server that ignores Range returns 200 and the whole body; the demuxer
    // would still work but every "range" would refetch everything.
    supportsRanges: response.status === 206
  };
}

// Content-Length *is* CORS-safelisted, so the size comes from a plain GET whose
// body is cancelled the instant the headers arrive — nothing is downloaded.
export async function probeTotalSize(url, { signal } = {}) {
  const response = await fetch(url, { signal });
  try {
    if (!response.ok) {
      throw new Error(`Size probe failed (${response.status})`);
    }
    return Number(response.headers.get("Content-Length") || 0);
  } finally {
    try {
      await response.body?.cancel();
    } catch (_) {
      // Already consumed or unsupported; nothing further to release.
    }
  }
}

let deviceSequence = 0;

/**
 * Wires a block-reader device to HTTP range requests, so libav can demux a
 * remote file by pulling only the parts it needs.
 *
 * Returns the device name and the total size; call `dispose()` when done.
 */
export async function attachRangeDevice(
  libav,
  url,
  { rangeFetch, signal, name = "", blockSize = BLOCK_SIZE } = {}
) {
  // The audio decoder reuses one libav instance across tracks, so a fixed name
  // would have each track recreate a device the previous one had just torn
  // down - and any state left behind under that name belongs to the old track.
  const deviceName = name || `input-${(deviceSequence += 1)}`;
  const read = typeof rangeFetch === "function" ? rangeFetch : defaultRangeFetch;
  const head = await read(url, 0, 1023, { signal });
  if (head.supportsRanges === false) {
    throw new Error("Server ignored range request");
  }
  const totalSize = Number(head.totalSize || 0) || (await probeTotalSize(url, { signal }));
  if (!totalSize) {
    throw new Error("Container size unknown");
  }

  let lastReadError = null;
  // The name comes back from libav rather than being closed over: the handler
  // is a single slot on the instance, and the send has to answer the device
  // that actually asked.
  libav.onblockread = async (requestedDevice, position, length) => {
    try {
      const start = Math.max(0, Number(position) || 0);
      const wanted = Math.max(Number(length) || 0, blockSize);
      const end = Math.min(totalSize - 1, start + wanted - 1);
      if (start > end) {
        await libav.ff_block_reader_dev_send(requestedDevice, start, new Uint8Array(0));
        return;
      }
      const chunk = await read(url, start, end, { signal });
      await libav.ff_block_reader_dev_send(requestedDevice, start, chunk.bytes);
    } catch (error) {
      // An empty send ends the read, which libav then reports as a clean EOF.
      // Recording it here is the only way a caller can tell a truncated read
      // from a file that genuinely ended.
      lastReadError = error;
      await libav.ff_block_reader_dev_send(
        requestedDevice,
        Number(position) || 0,
        new Uint8Array(0)
      );
    }
  };

  await libav.mkblockreaderdev(deviceName, totalSize);

  return {
    name: deviceName,
    totalSize,
    /** The last range request that failed, or null; cleared once observed. */
    takeReadError() {
      const error = lastReadError;
      lastReadError = null;
      return error;
    },
    async dispose() {
      libav.onblockread = null;
      try {
        await libav.unlink(deviceName);
      } catch (_) {
        // Device may already be gone.
      }
    }
  };
}
