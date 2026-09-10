import {
  VEGA_AUDIO_DEBUG_TONE,
  describeAudioContext,
  playVegaDebugTone,
  playVegaScheduledDebugTone,
  vegaAudioLog,
  vegaAudioWarn
} from "../../../platform/vega/vegaAudioDiagnostics.js";
import { createDolbyAudioDecoder } from "./dolbyAudioDecoder.js";

// Plays a container's audio track through Web Audio, in sync with the <video>
// element that is rendering the picture.
//
// Chromium on Vega decodes the video of Dolby streams but has no AC-3/E-AC-3
// decoder, so they play silent; and with no AudioTrackList, only the
// container's first audio track is reachable at all. The element keeps doing
// what it already does; this decodes the wanted track from the same file and
// schedules the PCM against the element's clock.
//
// The scheduling contract: a sample at media time T must be heard when the
// element is displaying media time T. That mapping is held in an anchor pair
// (anchorVideoTime -> anchorContextTime) rather than recomputed per chunk, so
// the schedule does not inherit the jitter of reading video.currentTime, and
// it is re-established whenever the two clocks separate audibly.
//
// The anchor is deliberately set when the first chunk is *scheduled*, not when
// the decoder is asked to seek: decoding the first chunk takes a few hundred
// milliseconds, during which the picture keeps moving. Anchoring before that
// puts every early chunk in the past, and a chunk in the past used to be
// started immediately - so they piled up on top of each other and came out as
// clicks and fragments rather than audio.
//
// Note the platform check in start(): on the Vega *virtual* device Web Audio
// reports state "running" but never renders - currentTime advances ~0.04s per
// 2s of wall clock and an oscillator produces silence. Scheduling against a
// frozen clock makes every buffer land in the past, which sends the pump into
// a decode/resync spin. Better to refuse to start than to burn a core
// producing nothing.

// How much decoded audio to keep scheduled ahead of the playhead. Generous,
// because the cost of running dry is an audible resync and the source is
// coming over the network alongside the video element's own reads.
const TARGET_LEAD_SECONDS = 5;
// How much to ask the decoder for per decode call.
const DECODE_STEP_SECONDS = 1;
// Decode calls per pump. The lead is built up over a few pumps rather than in
// one burst, which would fight the video element for the same connection just
// as playback starts.
const MAX_DECODE_CALLS_PER_PUMP = 2;
// How often to top up the schedule.
const PUMP_INTERVAL_MS = 500;
// Where the first chunk of a sync lands, relative to now. Just far enough that
// it is not already in the past by the time the node is started.
const START_OFFSET_SECONDS = 0.12;
// Drift beyond this means the audio clock and the video clock have separated
// enough to be audible; resynchronise rather than let it slide.
const MAX_DRIFT_SECONDS = 0.35;
// Audio production falling this far behind the picture is an underrun, not
// drift: the decoder is not keeping up and re-seeking ahead is the only fix.
const UNDERRUN_SECONDS = 0.5;
// How far ahead of the playhead to seek when (re)starting, so the decode has
// somewhere to land. Grows if the decoder keeps arriving late.
const INITIAL_PREROLL_SECONDS = 0.75;
const MAX_PREROLL_SECONDS = 6;
// A timestamp further than this from where the stream is expected to be is a
// container quirk, not a real discontinuity; accumulate instead.
const PTS_SNAP_SECONDS = 0.25;
const PTS_TRUST_SECONDS = 30;
// Consecutive decode failures before giving up and handing the element back.
const MAX_DECODE_ERRORS = 3;
// The context clock must advance by at least this fraction of real time to be
// considered live. A real output can take a moment to start after resume(), so
// the check is sampled repeatedly and only gives up once the clock has had
// time to come alive - on the virtual device it never does.
const CLOCK_CHECK_MS = 250;
const CLOCK_SETTLE_MS = 3000;
const MIN_CLOCK_RATIO = 0.5;

export function createDolbyAudioTrack({ video, url, streamIndex, rangeFetch, onFailure } = {}) {
  let context = null;
  let gain = null;
  let decoder = null;
  let pumpTimer = null;
  let scheduled = [];
  let stopped = false;
  let starting = false;
  // The pump owns the decoder; everything else asks it to do the work rather
  // than touching the decoder concurrently. Overlapping decodes used to
  // interleave their chunks and scramble the schedule.
  let pumping = false;
  let pendingSeekTo = null;

  // Maps the video clock onto the AudioContext clock:
  //   contextTime = videoTime - anchorVideoTime + anchorContextTime
  let anchorVideoTime = 0;
  let anchorContextTime = 0;
  let anchorSet = false;
  // Media time of the next sample to be scheduled.
  let nextMediaTime = 0;
  let decodedEof = false;
  let prerollSeconds = INITIAL_PREROLL_SECONDS;
  let decodeErrors = 0;
  // Bumped by every resync. A decode that was already in flight belongs to the
  // old position, so its chunks are dropped rather than scheduled.
  let generation = 0;
  let channelCount = 0;

  // Diagnostics: these are the numbers that say which way a bad-sounding
  // playback went wrong, and none of them can be checked by ear remotely.
  let lastPeak = 0;
  let chunksScheduled = 0;
  let chunksDropped = 0;
  let chunksTrimmed = 0;
  let resyncs = 0;
  let underruns = 0;
  let lastError = "";
  // Whether the pump gets to schedule at all, and what the first chunk looked
  // like, are the two facts a silent track needs answered first.
  let pumps = 0;
  let pumpsSkipped = 0;
  let decodeCalls = 0;
  let firstChunk = null;
  let lastMediaTime = -1;

  // `paused` and `seeking` are what the element says; the media clock moving
  // is what it does. The pump trusts the clock when the two disagree, so a
  // flag that is stale or wrong on some WebView cannot silence the track.
  function isMediaClockAdvancing(mediaTime) {
    const advancing = lastMediaTime >= 0 && mediaTime > lastMediaTime + 0.01;
    lastMediaTime = mediaTime;
    return advancing;
  }

  // The element's own mute state, restored on stop so that switching back to a
  // track the element can play does not leave it silent.
  let previousMuted = null;

  function videoToContextTime(mediaTime) {
    return anchorContextTime + (mediaTime - anchorVideoTime);
  }

  function clearScheduled() {
    scheduled.forEach((node) => {
      try {
        node.stop();
        node.disconnect();
      } catch (_) {
        // Already finished.
      }
    });
    scheduled = [];
  }

  function scheduleChunk(chunk) {
    const duration = chunk.frames / chunk.sampleRate;
    const pts = Number(chunk.ptsSeconds);
    const hasPts = Number.isFinite(pts);

    // The container's own timestamp beats the accumulated count: a seek lands
    // on a packet boundary rather than exactly where it was asked to, and
    // gaps in the track would otherwise shift everything after them.
    if (hasPts) {
      const drift = Math.abs(pts - nextMediaTime);
      if (!anchorSet && drift < PTS_TRUST_SECONDS) {
        nextMediaTime = pts;
      } else if (drift > PTS_SNAP_SECONDS && drift < PTS_TRUST_SECONDS) {
        nextMediaTime = pts;
      }
    }

    if (!anchorSet) {
      // Anchored to where the picture actually is now, which is later than the
      // seek target by however long the decode took.
      anchorVideoTime = Number(video.currentTime) || 0;
      anchorContextTime = context.currentTime + START_OFFSET_SECONDS;
      anchorSet = true;
    }

    const now = context.currentTime;
    const when = videoToContextTime(nextMediaTime);
    nextMediaTime += duration;

    if (!firstChunk) {
      firstChunk = {
        when: Number(when.toFixed(3)),
        now: Number(now.toFixed(3)),
        pts: hasPts ? Number(pts.toFixed(3)) : null,
        videoTime: Number((Number(video.currentTime) || 0).toFixed(3)),
        frames: chunk.frames,
        sampleRate: chunk.sampleRate,
        channels: chunk.channels,
        late: when + duration <= now
      };
      vegaAudioLog("Vega audio first chunk", firstChunk);
    }

    // Entirely in the past - the usual case for the first chunks after a seek,
    // which lands before the requested point.
    if (when + duration <= now) {
      chunksDropped += 1;
      return;
    }

    let peak = 0;
    for (const plane of chunk.planes) {
      for (let i = 0; i < plane.length; i += 64) {
        const value = Math.abs(plane[i]);
        if (value > peak) {
          peak = value;
        }
      }
    }
    lastPeak = peak;
    channelCount = chunk.channels;

    const buffer = context.createBuffer(chunk.channels, chunk.frames, chunk.sampleRate);
    for (let channel = 0; channel < chunk.channels; channel += 1) {
      buffer.copyToChannel(chunk.planes[channel], channel);
    }
    const node = context.createBufferSource();
    node.buffer = buffer;
    node.connect(gain);
    node.onended = () => {
      scheduled = scheduled.filter((entry) => entry !== node);
    };

    if (when < now) {
      // Partly late: play the part that is still due, at the right moment.
      // Starting it whole would overlap the chunk already playing.
      node.start(now, now - when);
      chunksTrimmed += 1;
    } else {
      node.start(when);
    }
    scheduled.push(node);
    chunksScheduled += 1;
  }

  async function resync(mediaTime) {
    clearScheduled();
    decodedEof = false;
    anchorSet = false;
    generation += 1;
    resyncs += 1;
    // Seek ahead of the picture so the decode has somewhere to land; the
    // early chunks it produces are dropped until it catches up to live.
    const target = Math.max(0, mediaTime + prerollSeconds);
    await decoder.seek(target);
    nextMediaTime = target;
  }

  async function pump() {
    if (stopped || pumping || !decoder || !context) {
      return;
    }
    pumping = true;
    try {
      if (pendingSeekTo !== null) {
        const target = pendingSeekTo;
        pendingSeekTo = null;
        await resync(target);
      }

      const mediaTime = Number(video.currentTime) || 0;
      const advancing = isMediaClockAdvancing(mediaTime);
      const playing = advancing || (!video.paused && !video.seeking);
      if (!playing) {
        pumpsSkipped += 1;
        return;
      }
      pumps += 1;
      // A missed play event would otherwise leave the context suspended
      // (onPause suspends it) while the picture runs.
      if (context.state === "suspended") {
        void context.resume();
      }

      if (anchorSet) {
        // The audio has run out ahead of, or behind, what is on screen.
        if (!decodedEof && nextMediaTime < mediaTime - UNDERRUN_SECONDS) {
          underruns += 1;
          prerollSeconds = Math.min(MAX_PREROLL_SECONDS, prerollSeconds + 1);
          await resync(mediaTime);
        } else if (
          Math.abs(videoToContextTime(mediaTime) - context.currentTime) > MAX_DRIFT_SECONDS
        ) {
          // The two clocks have separated. Rebuild the schedule rather than
          // move the anchor under buffers that are already queued against it.
          await resync(mediaTime);
        }
      }

      const decodingGeneration = generation;
      let calls = 0;
      while (
        !decodedEof &&
        calls < MAX_DECODE_CALLS_PER_PUMP &&
        nextMediaTime - mediaTime < TARGET_LEAD_SECONDS
      ) {
        calls += 1;
        decodeCalls += 1;
        const { chunks, eof } = await decoder.decodeInto(DECODE_STEP_SECONDS);
        // A seek or a teardown landed while this was decoding; these chunks
        // describe a position the element has already left.
        if (stopped || generation !== decodingGeneration) {
          return;
        }
        decodedEof = eof;
        if (!chunks.length) {
          break;
        }
        chunks.forEach(scheduleChunk);
      }
      decodeErrors = 0;
    } finally {
      pumping = false;
    }
  }

  function schedulePump() {
    if (pumpTimer || stopped) {
      return;
    }
    pumpTimer = setInterval(() => {
      void pump().catch((error) => {
        if (stopped) {
          return;
        }
        decodeErrors += 1;
        lastError = String(error?.message || error);
        // The device log flattens an Error argument to "[object Object]", so
        // the message has to be in the string.
        vegaAudioWarn(
          `Vega audio pump failed (${decodeErrors}/${MAX_DECODE_ERRORS}): ${lastError}`
        );
        if (decodeErrors >= MAX_DECODE_ERRORS) {
          // Repeated failures mean the source is not readable a second time -
          // a host that caps concurrent connections, or a container the
          // demuxer cannot follow. Hand the element back rather than grind.
          if (pumpTimer) {
            clearInterval(pumpTimer);
            pumpTimer = null;
          }
          try {
            onFailure?.(new Error(lastError));
          } catch (_) {
            // The owner's problem, not this one's.
          }
          return;
        }
        // Otherwise start again from where the picture is now.
        pendingSeekTo = Number(video.currentTime) || 0;
      });
    }, PUMP_INTERVAL_MS);
  }

  const onPlay = () => {
    void context?.resume();
    schedulePump();
  };
  const onPause = () => {
    void context?.suspend();
  };
  const onSeeking = () => {
    clearScheduled();
    anchorSet = false;
    // A decode already in flight is for the position being left; bumping the
    // generation here discards it rather than letting it schedule against the
    // new one before the resync catches up.
    generation += 1;
  };
  const onSeeked = () => {
    // Handed to the pump instead of run here, so it cannot overlap a decode
    // that is already in flight.
    pendingSeekTo = Number(video.currentTime) || 0;
  };

  async function start() {
    if (starting || stopped) {
      return null;
    }
    starting = true;

    const startedAt = Date.now();
    decoder = createDolbyAudioDecoder({ url, streamIndex, rangeFetch });
    const info = await decoder.open();
    const openMs = Date.now() - startedAt;

    // Deliberately the platform's default rate, not the stream's. The rate was
    // passed in explicitly for a while; the physical Fire TV then rendered
    // nothing through the context while reporting it "running" (third hardware
    // run, 2026-09-10) - the shape of an output stream that could not be opened
    // at the requested rate and was replaced by a silent stand-in whose clock
    // still ticks. Web Audio resamples the scheduled buffers to the context
    // rate, so nothing is lost by taking the default.
    const AudioContextImpl = globalThis.AudioContext || globalThis.webkitAudioContext;
    context = new AudioContextImpl();
    gain = context.createGain();
    gain.connect(context.destination);

    try {
      await context.resume();
    } catch (_) {
      // Some platforms start running without an explicit resume.
    }

    // Verify the clock is actually live before committing to decoding.
    const clockStartedAt = Date.now();
    for (;;) {
      const before = context.currentTime;
      await new Promise((resolve) => setTimeout(resolve, CLOCK_CHECK_MS));
      if (stopped) {
        await context.close().catch(() => {});
        context = null;
        starting = false;
        return null;
      }
      const advanced = context.currentTime - before;
      if (advanced >= (CLOCK_CHECK_MS / 1000) * MIN_CLOCK_RATIO) {
        break;
      }
      const waited = Date.now() - clockStartedAt;
      if (waited >= CLOCK_SETTLE_MS) {
        const state = String(context.state);
        await context.close().catch(() => {});
        context = null;
        starting = false;
        throw new Error(
          `audio clock is not running (advanced ${advanced.toFixed(3)}s in ` +
            `${CLOCK_CHECK_MS}ms after ${waited}ms in state "${state}"); ` +
            `Web Audio cannot play this track`
        );
      }
    }

    // The element plays the container's first audio track, which is either
    // silent (no decoder) or the wrong language; either way it must not be
    // heard alongside this one.
    try {
      previousMuted = Boolean(video.muted);
      video.muted = true;
    } catch (_) {
      // Not fatal.
    }

    vegaAudioLog("Vega audio context", {
      streamRate: info.sampleRate,
      ...describeAudioContext(context)
    });
    if (VEGA_AUDIO_DEBUG_TONE) {
      // Through the same gain node the decoded audio will use, once the element
      // is muted: audible means this context reaches the speakers.
      const played = await playVegaDebugTone(context, gain, { frequency: 880, durationMs: 250 });
      vegaAudioLog("Vega sidecar tone", { played, ...describeAudioContext(context) });
      if (stopped) {
        await context.close().catch(() => {});
        context = null;
        starting = false;
        return null;
      }
      // Half a second after the oscillator: a scheduled PCM buffer, which is
      // what every decoded chunk is. Two tones and no audio means the fault is
      // upstream of the output; one tone means buffer scheduling itself fails.
      vegaAudioLog(
        "Vega sidecar scheduled tone",
        playVegaScheduledDebugTone(context, gain, { frequency: 660, delaySeconds: 0.5 })
      );
    }

    // The first decode happens on the pump, which anchors once it has a chunk.
    pendingSeekTo = Number(video.currentTime) || 0;

    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("seeking", onSeeking);
    video.addEventListener("seeked", onSeeked);

    // Always, not only when the element says it is playing: the pump checks
    // for itself on every tick and costs nothing while the picture is still.
    schedulePump();
    starting = false;
    return {
      ...info,
      channelCount: info.channels,
      destinationChannels: context.destination.maxChannelCount || 0,
      // Splitting the two tells a slow container read apart from a slow audio
      // output, which need opposite fixes.
      openMs,
      startMs: Date.now() - startedAt
    };
  }

  async function stop({ release = false } = {}) {
    stopped = true;
    if (pumpTimer) {
      clearInterval(pumpTimer);
      pumpTimer = null;
    }
    video.removeEventListener("play", onPlay);
    video.removeEventListener("pause", onPause);
    video.removeEventListener("seeking", onSeeking);
    video.removeEventListener("seeked", onSeeked);
    clearScheduled();
    if (previousMuted !== null) {
      try {
        video.muted = previousMuted;
      } catch (_) {
        // Not fatal.
      }
      previousMuted = null;
    }
    try {
      await context?.close();
    } catch (_) {
      // Already closed.
    }
    context = null;
    await decoder?.close({ release });
    decoder = null;
  }

  function setVolume(value) {
    if (gain) {
      gain.gain.value = Math.max(0, Math.min(1, Number(value)));
    }
  }

  function getStats() {
    const mediaTime = Number(video?.currentTime) || 0;
    return {
      contextState: context?.state || "none",
      // Two stats lines with the same contextTime while mediaTime moved on
      // mean the output clock stalled after the start-up check passed.
      contextTime: Number((Number(context?.currentTime) || 0).toFixed(2)),
      mediaTime: Number(mediaTime.toFixed(2)),
      paused: Boolean(video?.paused),
      seeking: Boolean(video?.seeking),
      readyState: Number(video?.readyState) || 0,
      pumps,
      pumpsSkipped,
      decodeCalls,
      pumpTimer: Boolean(pumpTimer),
      pendingSeek: pendingSeekTo,
      leadSeconds: Number((nextMediaTime - mediaTime).toFixed(2)),
      // Non-zero proves real samples are reaching the output.
      lastPeak: Number(lastPeak.toFixed(4)),
      channelCount,
      chunksScheduled,
      chunksTrimmed,
      chunksDropped,
      pendingNodes: scheduled.length,
      resyncs,
      underruns,
      prerollSeconds: Number(prerollSeconds.toFixed(2)),
      decodeErrors,
      lastError: lastError || null,
      eof: decodedEof
    };
  }

  return { start, stop, setVolume, getStats };
}
