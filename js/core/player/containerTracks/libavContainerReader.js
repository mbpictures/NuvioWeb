import { attachRangeDevice, instantiateLibav } from "./libavRuntime.js";

// Reads a media container's track list without downloading it.
//
// Chromium exposes no AudioTrackList on Vega, so a multi-language stream shows
// exactly one synthetic entry in the audio selector. libav.js (ffmpeg compiled
// to WebAssembly) can demux the container itself and report every stream with
// its language and title, which is what the selector needs.

function normalizeTrack(stream, metadata, codecName) {
  const language = String(metadata.language || metadata.LANGUAGE || "").trim();
  const title = String(metadata.title || metadata.name || metadata.NAME || "").trim();
  return {
    index: Number(stream.index),
    codec: String(codecName || ""),
    language: language && language !== "und" ? language : "",
    title,
    // Present on the stream for audio; useful for labelling 5.1 vs stereo.
    channels: Number(stream.channels || stream.channel_layoutmask || 0) || 0,
    default: Boolean(Number(metadata.DISPOSITION_DEFAULT || 0)) || undefined
  };
}

/**
 * Enumerates the audio and subtitle tracks of a remote container.
 * Resolves to `{ audioTracks, subtitleTracks, durationSeconds }`, or throws.
 */
export async function readContainerTracks(url, { rangeFetch, signal } = {}) {
  const targetUrl = String(url || "").trim();
  if (!targetUrl) {
    throw new Error("No container URL");
  }

  const libav = await instantiateLibav();
  let device = null;
  let formatContext = 0;

  try {
    device = await attachRangeDevice(libav, targetUrl, { rangeFetch, signal });
    const [context, streams] = await libav.ff_init_demuxer_file(device.name);
    formatContext = context;

    const audioTracks = [];
    const subtitleTracks = [];

    for (const stream of streams) {
      const codecName = await libav.avcodec_get_name(stream.codec_id);
      let metadata = {};
      try {
        metadata = (await libav.ff_copyout_dict(await libav.AVStream_metadata(stream.ptr))) || {};
      } catch (_) {
        metadata = {};
      }
      const track = normalizeTrack(stream, metadata, codecName);
      // codec_type: 0 video, 1 audio, 3 subtitle (AVMEDIA_TYPE_*)
      if (Number(stream.codec_type) === 1) {
        audioTracks.push(track);
      } else if (Number(stream.codec_type) === 3) {
        subtitleTracks.push(track);
      }
    }

    return { audioTracks, subtitleTracks };
  } finally {
    try {
      if (formatContext) {
        await libav.avformat_close_input_js(formatContext);
      }
    } catch (_) {
      // Closing a half-opened context can throw; nothing useful to do.
    }
    await device?.dispose();
    try {
      libav.terminate();
    } catch (_) {
      // Already gone.
    }
  }
}

/**
 * Same as `readContainerTracks`, but shaped like the track objects the local
 * media service returns, so platforms without that service can feed the exact
 * same normalization and selector code.
 */
export async function readContainerTracksAsMediaTracks(url, options = {}) {
  const { audioTracks, subtitleTracks } = await readContainerTracks(url, options);

  const toMediaTrack = (track, type) => ({
    type,
    // The demuxer's stream index is the identity the selector maps back to.
    id: track.index,
    index: track.index,
    codec: track.codec,
    language: track.language,
    lang: track.language,
    title: track.title,
    name: track.title,
    channels: track.channels || "",
    channelCount: track.channels || "",
    // Only set when the container exposes the flag in stream metadata; this
    // build has no AVStream_disposition accessor, so consumers fall back to
    // the first audio stream, which is what Chromium plays anyway.
    default: Boolean(track.default)
  });

  return [
    ...audioTracks.map((track) => toMediaTrack(track, "audio")),
    ...subtitleTracks.map((track) => toMediaTrack(track, "subtitle"))
  ];
}
