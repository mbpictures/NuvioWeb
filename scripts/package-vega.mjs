import { access, cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readAppMetadata, syncVersionFiles } from "./appMetadata.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const distDir = path.join(rootDir, "dist");
const vegaDir = path.join(rootDir, "vega");
const vegaAssetsDir = path.join(vegaDir, "assets");
const vegaWebDir = path.join(vegaAssetsDir, "web");
const vegaImagesDir = path.join(vegaAssetsDir, "images");

const platformBootstrapScript = `  <script>window.__NUVIO_PLATFORM__ = "vega";</script>`;
const buildMode = process.argv.includes("--release") ? "Release" : "Debug";
const shouldBuild = !process.argv.includes("--stage-only");
const buildTarget = readArgValue("--target");
const buildNumber = String(process.env.NUVIO_VEGA_BUILD_NUMBER || "1");

function readArgValue(flag) {
  const match = process.argv.find((entry) => entry.startsWith(`${flag}=`));
  return match ? match.slice(flag.length + 1) : "";
}

async function assertDistExists() {
  try {
    await access(path.join(distDir, "index.html"), fsConstants.R_OK);
  } catch {
    throw new Error(`Build output not found at ${distDir}. Run "npm run build" first.`);
  }
}

// The Vega CLI is a shell shim on Windows, so it has to be spawned through a shell.
// Both call sites pass fixed, non-interpolated arguments.
function hasVegaCli() {
  const result = spawnSync("vega --version", { stdio: "ignore", shell: true });
  return result.status === 0;
}

// `vega build` is the native/C++ path and produces a .vpkg with no JS bundle, which
// the device rejects as invalid. React Native apps must go through build-vega, which
// runs Metro and Hermes first, then delegates to the native build.
function runReactNativeBuild(args) {
  const command = `npx react-native ${args.join(" ")}`;
  return new Promise((resolve, reject) => {
    const child = spawn(command, { cwd: vegaDir, stdio: "inherit", shell: true });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} exited with code ${code}`));
    });
  });
}

// The Vega WebView (Chromium-based) blocks XHR from file:// pages to other
// file:// resources, even same-origin ones. The web app fetches res/values/strings.xml
// via XHR at startup and throws a fatal error if all paths fail. We intercept that
// specific XHR by replacing XMLHttpRequest with a thin wrapper that serves the file
// content inline for the known paths, and forwards all other requests to the real XHR.
//
// Locale strings are too large to embed inline (~4.8 MB total). Instead they are
// written to a separate vega-locales.js file loaded with `defer` so it never blocks
// rendering. The shim checks window.__VEGA_LOCALES__ at XHR call-time; by then the
// deferred script has always already executed (locale XHRs happen asynchronously,
// at least two event-loop turns after the initial script execution).
async function buildXhrShim() {
  const stringsXmlPath = path.join(vegaWebDir, "res", "values", "strings.xml");
  let stringsXml;
  try {
    stringsXml = await readFile(stringsXmlPath, "utf8");
  } catch {
    console.warn("vega: res/values/strings.xml not found — skipping XHR shim");
    return null;
  }

  const encoded = JSON.stringify(stringsXml);

  return (
    `(function(){` +
    `var C=${encoded};` +
    `var O=window.XMLHttpRequest;` +
    // _i: inline content (base English)
    // _lc: pending locale code (deferred data not yet available)
    // _n: native XHR (for all other URLs)
    `function V(){this._n=null;this._i=null;this._lc=null;this.status=0;this.responseText="";this.onload=null;this.onerror=null;}` +
    `V.prototype.open=function(m,u,a){` +
    `if(u==="res/values/strings.xml"||u==="dist/res/values/strings.xml"||(u&&u.endsWith("/res/values/strings.xml"))){` +
    `this._i=C;` +
    `}else if(typeof u==="string"){` +
    `var lm=(/[/]values-([^/]+)[/]strings[.]xml$/).exec(u);` +
    `if(lm){this._lc=lm[1];}` +
    `else{this._n=new O();this._n.open(m,u,a===undefined?true:a);this._u=u;}` +
    `}else{this._n=new O();this._n.open(m,u,a===undefined?true:a);this._u=u;}` +
    `};` +
    `V.prototype.send=function(d){` +
    `var s=this;` +
    `if(s._i!==null){` +
    `s.status=0;s.responseText=s._i;` +
    `setTimeout(function(){if(s.onload)s.onload.call(s);},0);` +
    `}else if(s._lc!==null){` +
    // Poll for the deferred vega-locales.js to finish. It sets window.__VEGA_LOCALES__
    // as a {locale: "xml string"} map. Checks every 50ms, gives up after 5s (100 tries)
    // and resolves with empty string so i18n falls back to base English.
    `var lc=s._lc,n=0;` +
    `(function poll(){` +
    `var L=window.__VEGA_LOCALES__;` +
    `if(L!==undefined){s.status=0;s.responseText=L[lc]||"";if(s.onload)s.onload.call(s);}` +
    `else if(n++<100){setTimeout(poll,50);}` +
    `else{s.status=0;s.responseText="";if(s.onload)s.onload.call(s);}` +
    `})();` +
    `}else if(s._n){` +
    `var u=s._u||"?";` +
    `s._n.onload=function(){s.status=s._n.status;s.responseText=s._n.responseText;if(s.onload)s.onload.call(s);};` +
    `s._n.onerror=function(){if(s.onerror)s.onerror.call(s);};` +
    `s._n.send(d);` +
    `}` +
    `};` +
    `V.prototype.setRequestHeader=function(k,v){if(this._n)this._n.setRequestHeader(k,v);};` +
    `V.prototype.abort=function(){if(this._n)this._n.abort();};` +
    `V.UNSENT=0;V.OPENED=1;V.HEADERS_RECEIVED=2;V.LOADING=3;V.DONE=4;` +
    `window.XMLHttpRequest=V;` +
    `})();`
  );
}

// Builds the deferred locale script: window.__VEGA_LOCALES__ = { locale: "raw xml", ... }
// Loaded with `defer` so it never blocks the initial render.
async function buildLocalesScript() {
  const resDirPath = path.join(vegaWebDir, "res");
  const localeMap = {};
  try {
    const entries = await readdir(resDirPath, { withFileTypes: true });
    await Promise.all(
      entries
        .filter((e) => e.isDirectory() && e.name.startsWith("values-"))
        .map(async (e) => {
          const locale = e.name.slice("values-".length);
          try {
            localeMap[locale] = await readFile(
              path.join(resDirPath, e.name, "strings.xml"),
              "utf8"
            );
          } catch {
            // no strings.xml for this locale
          }
        })
    );
  } catch {
    // res/ not readable
  }
  return `window.__VEGA_LOCALES__=${JSON.stringify(localeMap)};`;
}

async function stageWebBundle() {
  await rm(vegaWebDir, { recursive: true, force: true });
  await mkdir(vegaWebDir, { recursive: true });
  await cp(distDir, vegaWebDir, { recursive: true });

  await rm(path.join(vegaWebDir, "appinfo.json"), { force: true });

  const [xhrShim, localesScript] = await Promise.all([buildXhrShim(), buildLocalesScript()]);

  const indexPath = path.join(vegaWebDir, "index.html");
  let sourceIndex = await readFile(indexPath, "utf8");
  if (!sourceIndex.includes("<body>")) {
    throw new Error("dist/index.html has no <body> tag to anchor the Vega platform bootstrap.");
  }

  let patchedIndex = sourceIndex.replace("<body>", `<body>\n${platformBootstrapScript}`);

  if (xhrShim) {
    await writeFile(path.join(vegaWebDir, "vega-xhr-shim.js"), xhrShim, "utf8");
    // Inject the shim before all other scripts so XHR is patched from the very start.
    patchedIndex = patchedIndex.replace(
      /(<script\b[\s\S]*?src="app\.bundle\.js)/,
      `<script src="vega-xhr-shim.js"></script>\n    $1`
    );
  }

  // Inject locale data as a deferred (non-blocking) script just before app.bundle.js.
  // The shim polls window.__VEGA_LOCALES__ so it handles the async availability correctly.
  await writeFile(path.join(vegaWebDir, "vega-locales.js"), localesScript, "utf8");
  const appBundleIdx = patchedIndex.indexOf('src="app.bundle.js');
  if (appBundleIdx !== -1) {
    const scriptTagStart = patchedIndex.lastIndexOf("<script", appBundleIdx);
    if (scriptTagStart !== -1) {
      patchedIndex =
        patchedIndex.slice(0, scriptTagStart) +
        `<script src="vega-locales.js" defer></script>\n    ` +
        patchedIndex.slice(scriptTagStart);
    }
  }

  await writeFile(indexPath, patchedIndex, "utf8");
}

async function stageIcon() {
  await mkdir(vegaImagesDir, { recursive: true });
  await cp(
    path.join(rootDir, "assets", "images", "icon.png"),
    path.join(vegaImagesDir, "icon.png")
  );
}

// `vega build` writes a corrupt zstd archive when its working directory is a
// DrvFs mount, so refuse rather than emit a .vpkg that vpt cannot read.
function assertBuildableWorkingTree() {
  if (process.platform !== "linux" || !vegaDir.startsWith("/mnt/")) {
    return;
  }
  throw new Error(
    [
      `Refusing to build from ${vegaDir}.`,
      "Windows drive mounts corrupt the .vpkg archive. Copy the vega/ directory to a",
      "WSL-native path (for example ~/nuvio-vega), run npm install there, and build from it.",
      "Re-run with --stage-only to stage the web bundle without building."
    ].join("\n")
  );
}

async function packageVega() {
  await syncVersionFiles();
  await assertDistExists();

  const { version } = await readAppMetadata();

  console.log("staging Vega package files...");
  await Promise.all([stageWebBundle(), stageIcon()]);
  console.log(`web bundle staged at ${vegaWebDir} (loads from file:///pkg/assets/web/index.html)`);

  if (!shouldBuild) {
    return;
  }

  const buildArgs = [
    "build-vega",
    "--build-type",
    buildMode,
    "--build-version",
    version,
    "--build-number",
    buildNumber
  ];
  if (buildTarget) {
    buildArgs.push("--target", buildTarget);
  }

  if (!hasVegaCli()) {
    const arch = buildTarget || "x86_64";
    console.log(
      [
        "",
        "vega CLI not found on PATH; skipping the .vpkg build.",
        "Finish the packaging manually:",
        "  cd vega && npm install",
        `  npx react-native ${buildArgs.join(" ")}`,
        `  vega run-app build/${arch}-${buildMode.toLowerCase()}/nuvio-vega_${arch}.vpkg space.nuvio.vega.main -d VirtualDevice`
      ].join("\n")
    );
    return;
  }

  assertBuildableWorkingTree();
  console.log(`building Vega ${buildMode} package (version ${version}, build ${buildNumber})...`);
  await runReactNativeBuild(buildArgs);
}

packageVega().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
