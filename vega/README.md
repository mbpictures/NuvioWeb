# Nuvio TV — Vega (Amazon Fire TV)

A thin React Native host that renders the existing Nuvio web app inside a Vega `WebView`.
No UI is reimplemented here: `scripts/package-vega.mjs` copies the normal `dist/` build into
`vega/assets/web/`, and `App.js` loads it from `file:///pkg/assets/web/index.html`.

## Scope

Torrent / P2P playback is **not** available on Vega. The webOS and Tizen builds back
`js/core/p2p/*` with a Node service (`services/webos`, `services/tizen`); Vega has no Node
service runtime. Those resolvers gate on `Platform.isWebOS()` / `Platform.isTizen()`, so they
are inert under the `vega` adapter. Debrid playback is plain HTTP and works unchanged.

## You cannot test this on an x86 virtual device

Vega WebView apps do **not** install on the Vega Virtual Device on Ubuntu, WSL, or Intel Macs.
The VVD image for those platforms omits the WebView native module, and installation fails with:

```
error (Module dependency not found): The following module dependencies declared in the
application manifest are not found:
  - /com.amazon.kepler.webview_3@IWebview_3
```

Confirmed by Amazon staff on the developer forum. To run this app you need either a physical
**Fire TV Stick 4K Select**, or a VVD on an **Apple Silicon Mac**. Everything short of the final
install — bundling, manifest validation, `.vpkg` creation — does work on a local VVD, so the build
pipeline can still be exercised there.

## Build and install

```bash
npm run package:vega            # Debug: stage + build
npm run package:vega:release    # Release
```

Optional: `--target=aarch64` to build one arch (default builds `kepler.targets`). Use `aarch64` for
an Apple Silicon VVD, `x86_64` for an x86 VVD, `armv7` for a Fire TV Stick. Build number defaults
to `1`; override with `NUVIO_VEGA_BUILD_NUMBER`.

The build runs **`react-native build-vega`**, not `vega build`. `vega build` is the native/C++
path: it emits a `.vpkg` that passes `vpt validate` but contains no `bundle/index.bundle`, and the
device rejects it at install with `error (Package is invalid)`. `build-vega` runs Metro, compiles
the Hermes bundle, then delegates to the same native build.

Version and build number are **not** manifest fields — they are passed as
`--build-version/--build-number`, and the script wires them from the root `package.json` version.

Install and launch:

```bash
vega run-app build/x86_64-debug/nuvio-vega_x86_64.vpkg space.nuvio.vega.main -d VirtualDevice
```

Verify a built package with `$KEPLER_SDK_PATH/bin/tools/vpt info <vpkg> --json` (note: the
`brazil-build-tool-exec vpt` wrapper does not resolve `vpt` on PATH).

## Building under WSL

The Vega SDK is officially macOS/Ubuntu only, but it runs in WSL2 with three fixes:

1. **Add your user to the `kvm` group** — `sudo usermod -aG kvm $USER`, then `wsl --shutdown`.
   Without it QEMU cannot open `/dev/kvm`, the emulator dies instantly, and `vega virtual-device
start` reports only `Deadline reached (60s) but virtual device unresponsive`. Check with
   `.../vmtools/agent/emulator-check accel`.
2. **Install `libpulse0`** — the bundled QEMU binary is dynamically linked against
   `libpulse.so.0`, which a bare Ubuntu WSL rootfs lacks. It exits 127 before running.
3. **Build from a WSL-native path, not `/mnt/...`** — building on a Windows drive mount
   produces a `.vpkg` whose zstd archive is corrupt (`vpt` then fails with ``failed to parse
`build-info.json` ``). `scripts/package-vega.mjs` refuses to build from `/mnt` for this reason.

The practical flow: run `npm run package:vega -- --stage-only` (or just `npm run build` +
`node scripts/package-vega.mjs --stage-only`) on Windows, copy `vega/` to `~/nuvio-vega`,
`npm install` there, and build from that copy.

Note that the root `node_modules` holds a **win32 esbuild binary**, so `npm run build` must run on
Windows, not in WSL.

## Fast Refresh (Debug builds only)

```bash
cd ~/nuvio-vega && npm start                            # Metro, port 8081 (fixed)
vega device start-port-forwarding --port 8081 --forward false
vega device launch-app -a space.nuvio.vega.main
```

Metro must be running before launch. This hot-reloads `App.js` (the host), not the web app —
for web changes re-run the staging step.

## Platform detection

Two independent paths set `window.__NUVIO_PLATFORM__ = "vega"`, because the WebView user agent
carries no reliable Vega marker:

1. `injectedJavaScriptBeforeContentLoaded` in `App.js`, and
2. a `<script>` that `package-vega.mjs` injects into the staged `index.html`.

`js/platform/index.js` also falls back to a `vega` / `kepler` user-agent match.

## CORS

The web app runs at a `file://` origin, so its origin is `null`. Probed against a real Chromium
at `file://`, using each API's actual request path:

| Endpoint                             | Result                                           |
| ------------------------------------ | ------------------------------------------------ |
| TMDB, TMDB images, Cinemeta, mdblist | readable (`Access-Control-Allow-Origin: *`)      |
| Trakt (custom headers → preflight)   | readable                                         |
| Supabase REST + RPC preflight        | readable; preflight allows `null` and `apikey`   |
| jsDelivr (`fetch` and `<script>`)    | readable                                         |
| `localStorage`                       | works                                            |
| introdb                              | **blocked** — pins `ACAO: https://introdb.app`   |
| IMDb ratings API                     | **blocked** — sends no `Access-Control-*` at all |

The two blocked APIs are proxied through the host bridge, so they work on Vega.
Everything else is reached directly. Credentialed requests against an `ACAO: *` server are
rejected by spec, but the app makes none.

## Still unverified

The app has never been installed on real hardware, so these remain open:

- **Spatial navigation** — `vegaAdapter.init()` cancels arrow-key defaults to stop Chromium's
  spatial navigation from fighting `focusEngine`. Untested against a real WebView.
- **Streaming libs** — `js/runtime/loadStreamingLibs.js` pulls hls.js and dash.js from jsDelivr at
  runtime, so playback depends on network reachability when the player opens.
- **Codecs / DRM** — HEVC Main10 and VP9 Profile2 are documented as supported, Widevine and
  PlayReady likewise, but nothing has been exercised.

## manifest.toml gotchas

Both of these produce `error (Package is invalid)` at install time, with no further detail —
`vpt validate` passes, `vpt info` prints correct metadata, and `vpm monitor-installer` only says
`INSTALL_FAILED_INVALID_PACKAGE`. Each was found by bisecting against the `helloWorld` template
(`vega project generate --template helloWorld`), which installs cleanly:

- **No `icon` key.** `icon = "@image/icon.png"` needs a registered resource; without one the device
  rejects the package. The template declares no icon at all. `scripts/package-vega.mjs` still
  stages `assets/images/icon.png` for whenever the resource system is figured out.
- **`kepler.targets` is a device profile, not an architecture.** It must be `["tv"]`. Architectures
  (`armv7` / `aarch64` / `x86_64`) are chosen with the `--target` build flag. Omitting `targets`
  entirely crashes the CLI with `Cannot read properties of undefined (reading 'filter')`.

Verified harmless: `[processes]`, `[wants.service]`, and `[wants.privilege]` all install fine.

## Host bridge

Web → host, via `postVegaHostMessage(type, payload)`:

| type    | Host action                                       |
| ------- | ------------------------------------------------- |
| `exit`  | `BackHandler.exitApp()`                           |
| `fetch` | native `fetch`, reply injected back into the page |

Messages are JSON with `{ source: "nuvio", type, payload }`; the host ignores anything else.

`fetch` exists because React Native's networking has no document origin and is therefore not
subject to the WebView's CORS rules. `fetchViaVegaHost(url, { timeoutMs })` in
`js/platform/vega/vegaHostFetch.js` posts a request, the host performs it, and the reply comes
back through `injectJavaScript` into `window.__NUVIO_VEGA_BRIDGE__.receive`. It resolves to a
`Response`, or to `null` on timeout, host error, non-Vega platform, or a non-`https` URL — so
every caller keeps its normal `fetch` as a fallback and degrades exactly as before.

Callers: `skipIntroRepository` and `imdbEpisodeRatingsRepository`.

Requests are restricted to `https`, capped at 2 MB, and time out after 10s host-side. Replies are
escaped for U+2028/U+2029 before injection, since those are legal in JSON but terminate a line in
JavaScript source.
