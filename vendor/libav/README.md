# libav.js — custom `nuvio-dolby` variant

ffmpeg compiled to WebAssembly, built here because **no published libav.js
variant contains the Dolby decoders**. Its shipped decoder fragments are `aac`,
`opus`, `libopus` and `h264` only; the few `ac3` strings inside the stock
binaries are Matroska codec-ID mappings in the demuxer, not decoders.

This variant does two jobs for the Vega build:

1. **Demux containers to enumerate audio tracks.** Chromium on Vega exposes no
   `AudioTrackList`, so a multi-language stream shows a single synthetic entry
   in the audio selector. libav reads the container index over HTTP range
   requests and reports every stream with its language and title.
2. **Decode AC-3 / E-AC-3 / DTS.** Chromium on Vega has none of these, so those
   streams play silent. Decoded output is `fltp` (float planar), which is what
   Web Audio wants.
3. **Decode AAC**, which Chromium *can* play — but only the container's first
   audio track, since there is no `AudioTrackList` to select through. A second
   or third AAC language is only reachable by decoding it here.

Verified on build: E-AC-3 5.1 -> 144 packets / 144 frames, 6 channels, `fltp`;
MP4 and Matroska both demux, and a track list with `language`/`title` comes back
after a single ~256KB range read.

The variant is still named `nuvio-dolby` after its original purpose, and that
name is load-bearing: it appears in the shipped filenames, in `LIBAV_VARIANT`
(`js/core/player/containerTracks/libavRuntime.js`) and in the copy step in
`scripts/build.mjs`.

## Rebuilding

Requires Docker (the build runs inside `emscripten/emsdk`; no local emscripten
needed). `<version>` must match the `libav.js` dependency in package.json.

```bash
# 1. Extract the build system that ships inside the npm package
mkdir libavbuild && tar xJf node_modules/libav.js/sources/libav.js.tar.xz -C libavbuild
cd libavbuild

# 2. Pre-place the sources so the build does not re-download them
mkdir -p build && cp ../node_modules/libav.js/sources/*.tar.* build/

# 3. Add the Dolby decoder fragment (a fragment is just ffmpeg configure flags).
#    There is no stock fragment for these; `decoder-aac` below needs none,
#    because mkconfig expands any unknown `decoder-X` to --enable-decoder=X.
mkdir -p configs/fragments/decoder-dolby
cp ../vendor/libav/decoder-dolby.ffmpeg-config.txt \
   configs/fragments/decoder-dolby/ffmpeg-config.txt

# 4. Create the variant: the stock `webcodecs` fragment list plus swresample
#    (for sample-rate conversion to the AudioContext rate), decoder-aac and
#    decoder-dolby
cd configs && node ./mkconfig.js nuvio-dolby '["avformat","avcodec","swresample","format-ogg","format-webm","format-mp4","parser-opus","codec-libopus","format-flac","parser-flac","codec-flac","format-wav","codec-pcm_f32le","parser-aac","decoder-aac","parser-h264","parser-hevc","bsf-extract_extradata","decoder-dolby"]' && cd ..

# 5. Build
docker build -t libavjs-build -f Dockerfile.development .
docker run --rm -v "$PWD":/src -w /src libavjs-build \
  bash -lc 'make build-nuvio-dolby -j"$(nproc)"'

# 6. Copy dist/libav-<version>-nuvio-dolby.{js,wasm.js,wasm.wasm} here
```

## Licensing

ffmpeg under LGPL; this variant enables no GPL components. See
`node_modules/libav.js/README.md` for libav.js's licensing notes and
`dist/assets/libs/libav/` for the shipped files.
