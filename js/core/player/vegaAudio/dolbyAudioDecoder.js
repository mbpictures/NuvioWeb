import { vegaAudioLog } from "../../../platform/vega/vegaAudioDiagnostics.js";
import {
  acquireDecodeLibav,
  attachRangeDevice,
  releaseDecodeLibav
} from "../containerTracks/libavRuntime.js";

// Decodes one audio track of a remote container to PCM.
//
// Chromium on Vega has no AC-3/E-AC-3/DTS decoder, so those streams play with
// video and silence. The video element keeps playing the file as it does today;
// this pulls the same file's audio track down separately, decodes it with the
// bundled ffmpeg build, and hands raw PCM to the caller to play through Web
// Audio in sync with the picture.
//
// Only the audio track's packets are decoded, but they are interleaved with
// video in the container, so the bytes read are roughly the whole file. That is
// the cost of leaving video where it is - and it means the source is fetched
// twice at once, which some hosts limit.
//
// This runs on a worker (see libavRuntime): decoding continuously on the main
// thread saturates the event loop and the UI stops responding.

// AV_SAMPLE_FMT_* values that matter here. Dolby decoders emit FLTP.
const SAMPLE_FMT_FLT = 3;
const SAMPLE_FMT_FLTP = 8;

// Fallbacks for the two libav return codes that have to be told apart; the
// instance exposes both, and these only cover a build that does not.
const AVERROR_EOF = -541478725;
const EAGAIN = 6;
// The high word of AV_NOPTS_VALUE (INT64_MIN).
const AV_NOPTS_HI = -2147483648;

// How much of the container to demux per read. Audio is a small fraction of an
// interleaved file, so this is mostly video packets being skipped past.
const READ_LIMIT_BYTES = 512 * 1024;
// Sequential reading, so larger blocks than the index reader uses: fewer round
// trips through the worker boundary and fewer HTTP requests.
const READ_BLOCK_BYTES = 512 * 1024;
// A stream index that never yields packets would otherwise read to the end of
// the file in one call.
const MAX_READS_PER_CALL = 64;

/**
 * libav.js splits an int64 into a signed high word and an unsigned low word.
 * Returns seconds, or null when the timestamp is absent.
 */
function timestampToSeconds(low, high, timeBaseNum, timeBaseDen) {
  const hi = Number(high);
  const lo = Number(low);
  if (!Number.isFinite(hi) || !Number.isFinite(lo) || hi === AV_NOPTS_HI) {
    return null;
  }
  const num = Number(timeBaseNum);
  const den = Number(timeBaseDen);
  if (!num || !den) {
    return null;
  }
  return ((hi * 4294967296 + (lo >>> 0)) * num) / den;
}

function toFloat32Planes(frame) {
  const format = Number(frame?.format);
  const data = frame?.data;

  if (format === SAMPLE_FMT_FLTP) {
    // Planar: one Float32Array per channel, which is what AudioBuffer wants.
    return Array.isArray(data) ? data.map((plane) => new Float32Array(plane)) : [];
  }

  if (format === SAMPLE_FMT_FLT) {
    // Interleaved float: split it out per channel.
    const source = Array.isArray(data) ? data[0] : data;
    const channels = Math.max(1, Number(frame.channels) || 1);
    const frames = Math.floor(source.length / channels);
    const planes = Array.from({ length: channels }, () => new Float32Array(frames));
    for (let i = 0; i < frames; i += 1) {
      for (let c = 0; c < channels; c += 1) {
        planes[c][i] = source[i * channels + c];
      }
    }
    return planes;
  }

  // Anything else would need swresample; the build has it, but Dolby decoders
  // do not produce it, so this is reported rather than silently mishandled.
  throw new Error(`Unsupported sample format ${format}`);
}

/**
 * Names the step an open() failure came from, and how long the steps before it
 * took. The message is the only thing that reaches the device log, so it has
 * to carry both.
 */
function stageError(error, stage, timings) {
  const detail = Object.entries(timings)
    .map(([name, ms]) => `${name}=${ms}ms`)
    .join(" ");
  const wrapped = new Error(`${stage} failed: ${String(error?.message || error)} [${detail}]`);
  wrapped.stage = stage;
  wrapped.cause = error;
  return wrapped;
}

/**
 * Creates a decoder for one audio stream of `url`.
 *
 * Usage: `open()`, then `decodeInto(seconds)` repeatedly, `seek()` as needed,
 * and `close()` at the end.
 */
export function createDolbyAudioDecoder({ url, streamIndex, rangeFetch, signal } = {}) {
  const targetUrl = String(url || "").trim();
  let libav = null;
  let device = null;
  let formatContext = 0;
  let packet = 0;
  let frame = 0;
  let codecContext = 0;
  let stream = null;
  let eof = false;
  // A demuxer error can leave libav's format context mid-read; the instance is
  // then torn down rather than reused for the next track.
  let poisoned = false;

  function readMulti() {
    // ff_read_multi only forwards to this and logs a deprecation notice on
    // every call, which is not free when called continuously.
    return libav.ff_read_frame_multi(formatContext, packet, { limit: READ_LIMIT_BYTES });
  }

  async function open() {
    if (!targetUrl) {
      throw new Error("No audio source URL");
    }
    // Every step below can take seconds on this hardware and every one of them
    // fails in its own way. An error that does not name the step it came from,
    // with the timings of the steps before it, costs a device round trip to
    // tell apart - so the stage is carried on the error and into the log.
    const timings = {};
    let stage = "libav";
    let stageStartedAt = Date.now();
    const enterStage = (next) => {
      timings[stage] = Date.now() - stageStartedAt;
      stage = next;
      stageStartedAt = Date.now();
    };

    try {
      libav = await acquireDecodeLibav();

      enterStage("device");
      device = await attachRangeDevice(libav, targetUrl, {
        rangeFetch,
        signal,
        blockSize: READ_BLOCK_BYTES
      });

      enterStage("demux");
      const [context, streams] = await libav.ff_init_demuxer_file(device.name);
      formatContext = context;

      const audioStreams = streams.filter((entry) => Number(entry.codec_type) === 1);
      if (!audioStreams.length) {
        throw new Error("Container has no audio stream");
      }
      stream =
        audioStreams.find((entry) => Number(entry.index) === Number(streamIndex)) ||
        audioStreams[0];

      enterStage("decoder");
      const [, context2, pkt, frm] = await libav.ff_init_decoder(stream.codec_id, stream.codecpar);
      codecContext = context2;
      packet = pkt;
      frame = frm;

      enterStage("info");
      // ff_init_demuxer_file does not copy the sample rate or channel count out
      // of the stream, so they come from the codec parameters. Both are only a
      // starting point - the first decoded frame is what the schedule uses.
      const info = {
        streamIndex: Number(stream.index),
        codec: await libav.avcodec_get_name(stream.codec_id),
        sampleRate: Number(await libav.AVCodecParameters_sample_rate(stream.codecpar)) || 0,
        channels: Number(await libav.AVCodecParameters_ch_layout_nb_channels(stream.codecpar)) || 0
      };

      enterStage("open");
      vegaAudioLog("Vega audio decoder open", { ...info, ...timings });
      return info;
    } catch (error) {
      timings[stage] = Date.now() - stageStartedAt;
      throw stageError(error, stage, timings);
    }
  }

  // Decodes until at least `seconds` of audio has been produced, or EOF.
  async function decodeInto(seconds = 1) {
    if (!libav || !formatContext) {
      throw new Error("Decoder not open");
    }
    const eagain = -(Number(libav.EAGAIN) || EAGAIN);
    const endOfFile = Number(libav.AVERROR_EOF) || AVERROR_EOF;
    const chunks = [];
    let produced = 0;
    let reads = 0;

    while (produced < seconds && !eof && reads < MAX_READS_PER_CALL) {
      reads += 1;
      const [result, packets] = await readMulti();
      const streamPackets = packets[stream.index] || [];

      if (result === endOfFile) {
        eof = true;
      } else if (result !== eagain && result < 0) {
        // A failed range request also lands here, because the block reader
        // ends the read with an empty send. That one is worth naming.
        poisoned = true;
        const readError = device?.takeReadError();
        throw readError || new Error(`Demuxer failed (${result})`);
      }

      if (!streamPackets.length) {
        continue;
      }

      const frames = await libav.ff_decode_multi(codecContext, packet, frame, streamPackets, eof);
      for (const decoded of frames) {
        const planes = toFloat32Planes(decoded);
        if (!planes.length || !planes[0].length) {
          continue;
        }
        const sampleRate = Number(decoded.sample_rate) || 48000;
        // best_effort_timestamp is the one that survives containers that only
        // timestamp some frames; the frame carries its own time base.
        const ptsSeconds =
          timestampToSeconds(
            decoded.best_effort_timestamp,
            decoded.best_effort_timestamphi,
            decoded.time_base_num || stream.time_base_num,
            decoded.time_base_den || stream.time_base_den
          ) ??
          timestampToSeconds(
            decoded.pts,
            decoded.ptshi,
            decoded.time_base_num || stream.time_base_num,
            decoded.time_base_den || stream.time_base_den
          );
        chunks.push({
          planes,
          sampleRate,
          channels: planes.length,
          frames: planes[0].length,
          // Seconds on the container's timeline, or null when the container
          // did not timestamp this frame.
          ptsSeconds
        });
        produced += planes[0].length / sampleRate;
      }
    }

    return { chunks, eof, seconds: produced };
  }

  async function seek(seconds) {
    if (!libav || !formatContext) {
      return;
    }
    const target = Math.max(0, Number(seconds) || 0);
    // Seek by the stream's own time base, landing on or before the target so no
    // audio is skipped.
    const timestamp = Math.floor(
      target * (Number(stream.time_base_den) / Number(stream.time_base_num))
    );
    await libav.avformat_seek_file_max(formatContext, stream.index, timestamp, 0);
    await libav.avcodec_flush_buffers(codecContext);
    eof = false;
  }

  async function close({ release = false } = {}) {
    try {
      if (codecContext) {
        await libav.ff_free_decoder(codecContext, packet, frame);
      }
    } catch (_) {
      // Freeing a partially initialised decoder can throw.
    }
    try {
      if (formatContext) {
        await libav.avformat_close_input_js(formatContext);
      }
    } catch (_) {
      // Nothing useful to do.
    }
    await device?.dispose();
    // The instance outlives one track so that switching language does not pay
    // the multi-second startup again; a poisoned one is not worth keeping.
    if (release || poisoned) {
      await releaseDecodeLibav();
    }
    libav = null;
    device = null;
    formatContext = 0;
    codecContext = 0;
  }

  return { open, decodeInto, seek, close };
}

/**
 * Decodes a few seconds and reports how long it took, so the playback
 * architecture can be chosen from a real number rather than an estimate.
 */
export async function benchmarkDolbyDecode({ url, streamIndex, seconds = 5, rangeFetch } = {}) {
  const decoder = createDolbyAudioDecoder({ url, streamIndex, rangeFetch });
  const openedAt = Date.now();
  let info;
  try {
    info = await decoder.open();
    const decodeStartedAt = Date.now();
    const { chunks, seconds: produced } = await decoder.decodeInto(seconds);
    const decodeMs = Date.now() - decodeStartedAt;
    const first = chunks[0];
    return {
      ok: true,
      codec: info.codec,
      streamIndex: info.streamIndex,
      openMs: decodeStartedAt - openedAt,
      decodeMs,
      audioSeconds: Number(produced.toFixed(2)),
      // The number that decides everything: seconds of audio decoded per second
      // of wall clock. Anything under ~1 cannot keep up with playback.
      realtimeFactor: produced > 0 ? Number((produced / (decodeMs / 1000)).toFixed(1)) : 0,
      sampleRate: first?.sampleRate || 0,
      channels: first?.channels || 0,
      chunks: chunks.length
    };
  } catch (error) {
    return { ok: false, error: String(error?.message || error).slice(0, 160) };
  } finally {
    await decoder.close({ release: true });
  }
}
