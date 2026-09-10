import { createDolbyAudioTrack } from "./dolbyAudioTrack.js";

// Owns the lifetime of the WebAssembly audio track that plays alongside the
// <video> element on Vega.
//
// Two Chromium limits make this necessary there: it has no AC-3 / E-AC-3 / DTS
// decoder, so those streams play silent, and it exposes no AudioTrackList, so
// the only audio track reachable on the element is the container's first one.
// This keeps at most one decoded track running against that element, and swaps
// it when the user picks a different language.

// The codecs the vendored libav build carries decoders for; see
// vendor/libav/README.md for the rebuild recipe that would extend this.
//
// AAC is here even though Chromium decodes it, because a second or third AAC
// language is unreachable on the element and can only be played by decoding it
// ourselves. TrueHD deliberately is not: the build has no decoder for it.
const DECODABLE_CODECS = new Set([
  "aac",
  "mp4a",
  "ac3",
  "ac-3",
  "eac3",
  "e-ac-3",
  "ec-3",
  "ec3",
  "dts",
  "dca",
  "dts-hd",
  "dtshd"
]);

// What Chromium on Vega decodes on its own (measured; see the Vega media-limits
// notes). The element is the better decoder whenever it can do the job, so
// these go through the sidecar only when the wanted track is one the element
// will not play - that is, any track but the first.
const NATIVE_CODECS = new Set(["aac", "mp4a", "mp3", "mp2", "opus", "vorbis", "flac"]);

function normalizeCodecName(codec) {
  return (
    String(codec || "")
      .trim()
      .toLowerCase()
      // "A_EAC3", "audio/eac3", "eac3 (Dolby Digital Plus)" all reduce to a name
      // the set above can match.
      .replace(/^a_/, "")
      .replace(/^audio\//, "")
      .replace(/[\s(].*$/, "")
  );
}

/** True when the vendored libav build can decode this audio codec. */
export function canDecodeAudioCodec(codec) {
  return DECODABLE_CODECS.has(normalizeCodecName(codec));
}

/** True when the Vega WebView plays this audio codec without any help. */
export function isNativeAudioCodec(codec) {
  return NATIVE_CODECS.has(normalizeCodecName(codec));
}

// console.warn(msg, errorObject) reaches the device log as "[object Object]",
// so the message and the step it came from have to be flattened into the
// string itself.
function describeError(error) {
  return String(error?.message || error);
}

// While a track is playing there is nothing to see on screen that says whether
// it is healthy, and it can only be exercised on real hardware. This puts the
// numbers that distinguish "decoding fine" from "underrunning" or "source
// refused the second connection" into the device log.
const STATS_LOG_INTERVAL_MS = 10000;

export const vegaAudioSidecar = {
  track: null,
  url: "",
  streamIndex: -1,
  codec: "",
  starting: false,
  lastError: null,
  statsTimer: null,
  // Starting a track means opening the container over the network and waiting
  // for the audio output to come alive, which takes seconds on this hardware.
  // Picks that arrive during that window queue behind it and the newest one
  // wins, rather than being refused as a failure the user never caused.
  startToken: 0,
  startChain: null,
  // A track that failed once fails the same way every time on this source, so
  // remember it rather than re-opening the container on every retry.
  failedKey: "",
  // Set by the player controller: called whenever ownership of the element's
  // audio changes hands (a track started, stopped, or failed), so the element's
  // mute state can be recomputed by the one place that owns it.
  onStateChange: null,
  // A disengage({ release: true }) that lands while a start is still opening
  // its container: the start is cancelled once it resolves, and must release
  // the shared libav instance the way the disengage asked for.
  releasePending: false,
  // The start that is queued or opening right now, so that asking for the same
  // track again joins it instead of cancelling it and opening the container a
  // second time - the startup pass and the track sync both ask for the same
  // track within a few milliseconds of each other.
  pendingStart: null,

  notifyStateChange() {
    try {
      this.onStateChange?.();
    } catch (error) {
      console.warn(`Vega audio sidecar listener failed: ${describeError(error)}`);
    }
  },

  startStatsLogging() {
    this.stopStatsLogging();
    this.statsTimer = setInterval(() => {
      if (!this.track) {
        this.stopStatsLogging();
        return;
      }
      console.log("Vega audio sidecar", this.getStats());
    }, STATS_LOG_INTERVAL_MS);
  },

  stopStatsLogging() {
    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
  },

  isActive() {
    return Boolean(this.track);
  },

  /**
   * True while the element must stay muted: a decoded track is playing, or one
   * is being opened. The element only ever plays the container's first track,
   * so letting it sound while another track is on its way means hearing the
   * wrong language for the seconds the open takes.
   */
  ownsElementAudio() {
    return Boolean(this.track) || this.starting;
  },

  getActiveStreamIndex() {
    return this.track ? Number(this.streamIndex) : -1;
  },

  /**
   * Starts decoding `streamIndex` of `url` and scheduling it against `video`.
   *
   * Resolves to true when the track is playing, false when it could not start
   * (which leaves the element exactly as it was), and null when a newer pick
   * replaced this one before it ran - which is not a failure and must not be
   * reported to the user as one.
   *
   * @param {{retry?: boolean}} [options] `retry: true` reopens a track that
   *   already failed on this source. Automatic starts skip those; a user
   *   picking the same track again is asking for another attempt.
   */
  async engage({ video, url, streamIndex, codec, retry = false } = {}) {
    const targetUrl = String(url || "").trim();
    const targetIndex = Number(streamIndex);
    if (!video || !targetUrl || !Number.isFinite(targetIndex) || targetIndex < 0) {
      return false;
    }
    if (!canDecodeAudioCodec(codec)) {
      return false;
    }
    if (this.track && this.url === targetUrl && this.streamIndex === targetIndex) {
      return true;
    }
    const key = `${targetUrl}#${targetIndex}`;
    if (this.failedKey === key && !retry) {
      return false;
    }
    if (retry) {
      this.failedKey = "";
    }
    if (this.pendingStart?.key === key) {
      return this.pendingStart.promise;
    }

    const token = (this.startToken += 1);
    // Serialised: two starts overlapping would fight over the shared libav
    // instance and over which one owns the element's audio.
    const promise = Promise.resolve(this.startChain)
      .catch(() => {})
      .then(() =>
        this.startTrack(token, { video, url: targetUrl, streamIndex: targetIndex, codec, key })
      );
    this.startChain = promise;
    this.pendingStart = { key, token, promise };
    return promise;
  },

  async startTrack(token, { video, url, streamIndex, codec, key }) {
    // A newer pick arrived while this one was queued; it is about to run and
    // this one is no longer what the user wants.
    if (token !== this.startToken) {
      return null;
    }
    if (this.track && this.url === url && this.streamIndex === streamIndex) {
      return true;
    }

    this.starting = true;
    this.releasePending = false;
    // Stop first, then notify: stopping restores the element's earlier mute
    // state, and the recompute has to run after that so the element stays
    // silent while the next track opens.
    await this.stopActiveTrack();
    this.notifyStateChange();

    const track = createDolbyAudioTrack({
      video,
      url,
      streamIndex,
      // The track gives up after repeated decode failures rather than grinding
      // against a source it cannot read twice; that has to clear this owner
      // too, or it would report a track that is no longer playing.
      onFailure: (error) => {
        if (this.track !== track) {
          return;
        }
        this.lastError = error;
        this.failedKey = key;
        console.warn(`Vega audio sidecar gave up: ${describeError(error)}`);
        // Not disengage(): that would also cancel a pick the user has queued
        // behind this track, which should still get its turn.
        void this.stopActiveTrack().then(() => this.notifyStateChange());
      }
    });
    try {
      const info = await track.start();
      // Disengaged or replaced while the container was opening. Without this
      // the track would take the element's audio for a pick nobody wants any
      // more - or after playback has already been torn down.
      if (token !== this.startToken) {
        try {
          await track.stop({ release: this.releasePending });
        } catch (_) {
          // Best effort; it never played.
        }
        return null;
      }
      this.track = track;
      this.url = url;
      this.streamIndex = streamIndex;
      this.codec = normalizeCodecName(codec);
      this.lastError = null;
      this.failedKey = "";
      console.log("Vega audio sidecar started", {
        streamIndex,
        codec: this.codec,
        channels: info?.channels,
        sampleRate: info?.sampleRate,
        // A 5.1 track on a stereo output is downmixed by Web Audio; worth
        // knowing which happened when a mix sounds wrong.
        destinationChannels: info?.destinationChannels,
        openMs: info?.openMs,
        startMs: info?.startMs
      });
      this.startStatsLogging();
      return true;
    } catch (error) {
      // Leave the element untouched; silent video is better than a broken
      // pipeline, and the message says which of the two failure modes it was.
      this.lastError = error;
      this.failedKey = key;
      console.warn(`Vega audio sidecar failed to start: ${describeError(error)}`);
      try {
        await track.stop();
      } catch (_) {
        // Never started.
      }
      // Superseded while starting: the pick that replaced it is next in the
      // chain, so this failure is not the one to report.
      return token === this.startToken ? false : null;
    } finally {
      if (this.pendingStart?.token === token) {
        this.pendingStart = null;
      }
      this.starting = false;
      this.notifyStateChange();
    }
  },

  /**
   * @param {{release?: boolean}} [options] `release: true` also tears down the
   *   shared libav worker, which is otherwise kept alive so that switching
   *   language does not pay its multi-second startup again. Pass it when
   *   playback is over, not between tracks.
   */
  async disengage({ release = false } = {}) {
    // Also cancels a start that is still opening its container: it checks the
    // token once the open completes and stands down.
    this.startToken += 1;
    this.pendingStart = null;
    this.releasePending = release;
    await this.stopActiveTrack({ release });
    this.notifyStateChange();
  },

  async stopActiveTrack({ release = false } = {}) {
    this.stopStatsLogging();
    const track = this.track;
    this.track = null;
    this.url = "";
    this.streamIndex = -1;
    this.codec = "";
    if (!track) {
      return;
    }
    try {
      await track.stop({ release });
    } catch (error) {
      console.warn(`Vega audio sidecar teardown failed: ${describeError(error)}`);
    }
  },

  setVolume(value) {
    this.track?.setVolume(value);
  },

  getStats() {
    if (!this.track) {
      return {
        active: false,
        lastError: this.lastError ? String(this.lastError.message || this.lastError) : null
      };
    }
    return {
      active: true,
      streamIndex: this.streamIndex,
      codec: this.codec,
      ...this.track.getStats()
    };
  }
};
