import { access, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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

  // Embed all locale strings.xml files so the XHR shim can serve them inline.
  // The Vega WebView loads pages from file:// which Chromium treats as null-origin,
  // so the real XHR can't load other file:// resources cross-origin.
  const localeMap = {};
  const resDirPath = path.join(vegaWebDir, "res");
  try {
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(resDirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith("values-")) continue;
      const locale = entry.name.slice("values-".length);
      const xmlPath = path.join(resDirPath, entry.name, "strings.xml");
      try {
        localeMap[locale] = await readFile(xmlPath, "utf8");
      } catch {
        // no strings.xml for this locale dir
      }
    }
  } catch {
    // res/ directory not readable — locale switching won't work
  }
  const localeMapEncoded = JSON.stringify(localeMap);

  return `(function(){` +
    // --- strings.xml XHR shim ---
    // C = base English strings.xml content (served for res/values/strings.xml)
    // L = locale map keyed by locale code (served for res/values-{locale}/strings.xml)
    `var C=${encoded};` +
    `var L=${localeMapEncoded};` +
    `var O=window.XMLHttpRequest;` +
    `function V(){this._n=null;this._i=null;this.status=0;this.responseText="";this.onload=null;this.onerror=null;}` +
    `V.prototype.open=function(m,u,a){` +
      `var ic=null;` +
      `if(u==="res/values/strings.xml"||u==="dist/res/values/strings.xml"||(u&&u.endsWith("/res/values/strings.xml"))){` +
        `ic=C;` +
      `}else if(typeof u==="string"){` +
        `var lm=(new RegExp("values-([^/]+)/strings\\.xml$")).exec(u);` +
        `if(lm&&L&&L[lm[1]])ic=L[lm[1]];` +
      `}` +
      `if(ic!==null){this._i=ic;}else{` +
        `this._n=new O();` +
        `this._n.open(m,u,a===undefined?true:a);` +
        `this._u=u;` +
      `}` +
    `};` +
    `V.prototype.send=function(d){` +
      `var s=this;` +
      `if(s._i!==null){s.status=0;s.responseText=s._i;setTimeout(function(){if(s.onload)s.onload.call(s);},0);}` +
      `else if(s._n){` +
        `var u=s._u||"?";` +
        `s._n.onload=function(){` +
          `s.status=s._n.status;s.responseText=s._n.responseText;` +
          `console.log("[vega-net] xhr "+s._n.status+" "+u);` +
          `if(s.onload)s.onload.call(s);` +
        `};` +
        `s._n.onerror=function(){` +
          `console.error("[vega-net] xhr-err "+u);` +
          `if(s.onerror)s.onerror.call(s);` +
        `};` +
        `s._n.send(d);` +
      `}` +
    `};` +
    `V.prototype.setRequestHeader=function(k,v){if(this._n)this._n.setRequestHeader(k,v);};` +
    `V.prototype.abort=function(){if(this._n)this._n.abort();};` +
    `V.UNSENT=0;V.OPENED=1;V.HEADERS_RECEIVED=2;V.LOADING=3;V.DONE=4;` +
    `window.XMLHttpRequest=V;` +
    // --- fetch() proxy through React Native bridge ---
    // The WebView's file:// origin blocks direct fetch() to https:// (Chromium cross-origin
    // restriction). We route all HTTP(S) fetch calls through the RN bridge instead, which
    // runs on the native JS thread and has no such restriction.
    `var _pfq={};var _pid=0;` +
    `window.__VEGA_FETCH_RECV__=function(msg){` +
      `var p=_pfq[msg.id];if(!p)return;delete _pfq[msg.id];` +
      `if(msg.ok){` +
        `var h={get:function(k){return(msg.headers||{})[k.toLowerCase()]||null;},` +
               `forEach:function(cb){var hd=msg.headers||{};Object.keys(hd).forEach(function(k){cb(hd[k],k);});}};` +
        `var body=msg.body||"";` +
        `p.res({ok:msg.status>=200&&msg.status<300,status:msg.status,statusText:"",headers:h,` +
              `text:function(){return Promise.resolve(body);},` +
              `json:function(){try{return Promise.resolve(JSON.parse(body));}catch(e){return Promise.reject(e);}},` +
              `clone:function(){return this;}});` +
      `}else{p.rej(new TypeError("Network request failed: "+(msg.error||"error")));}` +
    `};` +
    `function _hdrs(h){` +
      `if(!h)return{};` +
      `if(typeof h.forEach==="function"&&typeof h.get==="function"){` +
        `var o={};h.forEach(function(v,k){o[k]=v;});return o;` +
      `}` +
      `return h;` +
    `}` +
    `window.fetch=function(r,o){` +
      `var u=typeof r==="string"?r:(r&&r.url)||String(r);` +
      `if(u.indexOf("http://")===0||u.indexOf("https://")===0){` +
        `var id="vf"+(++_pid);` +
        `var m=(o&&o.method)||(r&&typeof r==="object"&&r.method)||"GET";` +
        `var hd=_hdrs((o&&o.headers)||(r&&typeof r==="object"&&r.headers)||{});` +
        `var bd=(o&&o.body)||(r&&typeof r==="object"&&r.body)||null;` +
        `return new Promise(function(res,rej){` +
          `_pfq[id]={res:res,rej:rej};` +
          `if(!window.ReactNativeWebView){rej(new TypeError("RN bridge unavailable"));return;}` +
          `window.ReactNativeWebView.postMessage(JSON.stringify({` +
            `source:"nuvio",type:"vegafetch",payload:{id:id,url:u,method:m,headers:hd,body:bd}` +
          `}));` +
        `});` +
      `}` +
      `return Promise.reject(new TypeError("fetch: unsupported URL scheme: "+u));` +
    `};` +
  `})();`;
}

async function stageWebBundle() {
  await rm(vegaWebDir, { recursive: true, force: true });
  await mkdir(vegaWebDir, { recursive: true });
  await cp(distDir, vegaWebDir, { recursive: true });

  await rm(path.join(vegaWebDir, "appinfo.json"), { force: true });

  const xhrShim = await buildXhrShim();

  const indexPath = path.join(vegaWebDir, "index.html");
  let sourceIndex = await readFile(indexPath, "utf8");
  if (!sourceIndex.includes("<body>")) {
    throw new Error("dist/index.html has no <body> tag to anchor the Vega platform bootstrap.");
  }

  let patchedIndex = sourceIndex.replace("<body>", `<body>\n${platformBootstrapScript}`);

  if (xhrShim) {
    await writeFile(path.join(vegaWebDir, "vega-xhr-shim.js"), xhrShim, "utf8");
    patchedIndex = patchedIndex.replace(
      /<script src="app\.bundle\.js/,
      `<script src="vega-xhr-shim.js"></script>\n    <script src="app.bundle.js`
    );
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
