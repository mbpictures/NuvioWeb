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

async function stageWebBundle() {
  await rm(vegaWebDir, { recursive: true, force: true });
  await mkdir(vegaWebDir, { recursive: true });
  await cp(distDir, vegaWebDir, { recursive: true });

  await rm(path.join(vegaWebDir, "appinfo.json"), { force: true });

  const indexPath = path.join(vegaWebDir, "index.html");
  const sourceIndex = await readFile(indexPath, "utf8");
  if (!sourceIndex.includes("<body>")) {
    throw new Error("dist/index.html has no <body> tag to anchor the Vega platform bootstrap.");
  }
  await writeFile(
    indexPath,
    sourceIndex.replace("<body>", `<body>\n${platformBootstrapScript}`),
    "utf8"
  );
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
