#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════
   Volt — release-feed round-trip gate (CI + local)

   The END-TO-END auto-update check. It publishes a scratch release
   feed (a generic-provider "release repo" directory: latest.yml +
   the NSIS installer), serves it over 127.0.0.1, launches the
   PACKAGED app (dist/win-unpacked/Volt.exe) with --smoke-feed and
   VOLT_UPDATE_URL pointing at the feed, and asserts the version
   banner appears — i.e. the real electron-updater chain ran:
   startup check → update found → background download → update
   downloaded → banner. NOT a stub: the same artifacts and the same
   client code path a GitHub release serves.

   Why a local feed instead of a scratch GitHub repo: end users'
   clients can't read a PRIVATE repo's releases without a token, and
   CI creating scratch repos needs a PAT with repo-create rights.
   The generic provider + local HTTP exercises the identical client
   path (latest.yml fetch, sha512 verify, full download, update-
   downloaded) — the transport is the only difference.

   Usage:
     node scripts/test-release-feed.mjs            # use existing dist/
     node scripts/test-release-feed.mjs --build    # electron-builder first
   Exit code 0 = round-trip verified, 1 = any step failed.
   ═══════════════════════════════════════════════════════════════ */
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { createReadStream, existsSync, mkdirSync, rmSync, copyFileSync, readdirSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// CSC_LINK/CSC_KEY_PASSWORD from .env (real env vars win), so a --build here
// produces a SIGNED installer + app-update.yml when a cert is configured —
// the round-trip then exercises the updater's publisherName verification.
require("./load-env.cjs")();

const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), ".."); // pdf-viewer/
const DIST = join(APP_ROOT, "dist");
const UNPACKED_EXE = join(DIST, "win-unpacked", "Volt.exe");
const FEED_DIR = join(DIST, "feed-scratch");

const shouldBuild = process.argv.includes("--build");
const verbose = process.argv.includes("--verbose");
const fail = (msg) => { console.error("❌ " + msg); process.exit(1); };
const ok = (msg) => console.log("✅ " + msg);
const note = (msg) => console.log("·  " + msg);

function pkgVersion() {
  return String(JSON.parse(readFileSync(join(APP_ROOT, "package.json"), "utf8")).version || "1.0.0");
}

// Advertise a version strictly newer than the installed one. The renderer's
// banner handler only accepts numeric x.y.z (see _onDesktopUpdateDownloaded).
function advertisedVersion(installed) {
  const m = /^(\d+)\.\d+\.\d+$/.exec(installed);
  return m ? (parseInt(m[1], 10) + 1) + ".0.0" : "9.9.9";
}

function build() {
  note("building the installer (electron-builder --win nsis --publish never)…");
  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  const r = spawnSync(npx, ["electron-builder", "--win", "nsis", "--publish", "never"], {
    // shell:true on win32 — spawning npx.cmd directly EINVALs on modern Node
    cwd: APP_ROOT, stdio: "inherit", timeout: 600000, shell: process.platform === "win32",
  });
  if (r.status !== 0) fail("electron-builder failed (status " + r.status + ")");
}

function findInstaller() {
  let files = [];
  try { files = readdirSync(DIST).filter((f) => /^Volt-Setup-\d+\.\d+\.\d+\.exe$/.test(f)); } catch (e) { /* no dist */ }
  if (!files.length) fail("no NSIS installer in dist/ — run with --build (or npm run dist) first");
  files.sort();
  return join(DIST, files[files.length - 1]);
}

// Publish the scratch feed: copy the installer under the advertised version
// and write a latest.yml with its real sha512 — exactly what electron-builder
// writes for a release (same format electron-updater parses).
function makeFeed(installerPath, adv) {
  rmSync(FEED_DIR, { recursive: true, force: true });
  mkdirSync(FEED_DIR, { recursive: true });
  const exeName = "Volt-Setup-" + adv + ".exe";
  copyFileSync(installerPath, join(FEED_DIR, exeName));
  const buf = readFileSync(join(FEED_DIR, exeName));
  const sha512 = createHash("sha512").update(buf).digest("base64");
  writeFileSync(join(FEED_DIR, "latest.yml"), [
    "version: " + adv,
    "files:",
    "  - url: " + exeName,
    "    sha512: " + sha512,
    "    size: " + buf.length,
    "path: " + exeName,
    "sha512: " + sha512,
    "releaseDate: '" + new Date().toISOString() + "'",
    "",
  ].join("\n"));
  return { exeName, size: buf.length };
}

// electron-updater reads resources/app-update.yml for its initial config, and
// its download step re-reads it. The `dir` target and `--publish never` builds
// never write that file, so a dist/ produced by `npm run dist:dir` (or this
// test's own --build) would ENOENT mid-download and the round-trip would time
// out. Write the generic-provider config the run uses anyway (setFeedURL +
// VOLT_UPDATE_URL) — exactly what a generic-provider release's packaged app
// would contain — so the gate is deterministic regardless of how dist/ was
// produced. The client chain (latest.yml fetch → sha512 verify → download →
// update-downloaded → banner) stays 100% real.
const APP_UPDATE_ORIG = join(DIST, "win-unpacked", "resources", "app-update.yml.volt-orig");

function ensureAppUpdateYml(feedUrl) {
  const resourcesDir = join(DIST, "win-unpacked", "resources");
  if (!existsSync(resourcesDir)) mkdirSync(resourcesDir, { recursive: true });
  const ymlPath = join(resourcesDir, "app-update.yml");
  // PRESERVE publisherName from the build's own app-update.yml when present:
  // a signed build writes it (win.verifyUpdateCodeSignature), and that is
  // what arms the updater's Authenticode check. Without this the overwrite
  // below would strip it and the round-trip would silently skip signature
  // verification — passing even for unsigned/mismatched installers. With it:
  //   • unsigned build      → no publisherName → updater skips check (as a
  //     real unsigned release would), gate passes as before;
  //   • signed + trusted    → Status 0 + subject match → download installs;
  //   • signed + UNtrusted  → updater REJECTS the download (the dev-cert
  //     case) — the gate fails exactly as a real user's updater would.
  // The gate must never destroy its own input: earlier versions OVERWROTE the
  // signed build's app-update.yml (stripping publisherName), so a second run
  // would silently disarm signature verification and sign:check would start
  // failing on a perfectly good signed build. Back up the PRISTINE file once
  // and restore it after the run (main()'s finally).
  if (!existsSync(APP_UPDATE_ORIG) && existsSync(ymlPath)) {
    copyFileSync(ymlPath, APP_UPDATE_ORIG);
  }
  const pristine = existsSync(APP_UPDATE_ORIG) ? readFileSync(APP_UPDATE_ORIG, "utf8") : "";
  let publisherLines = "";
  let publisherNames = null;
  try {
    // js-yaml is a transitive dep of electron-updater (builder-util-runtime) —
    // proper parsing, because electron-builder writes publisherName as a YAML
    // LIST (a regex header-line grab silently drops the items and leaves a
    // null value, which disarms verification).
    const parsed = require("js-yaml").load(pristine);
    if (parsed && Array.isArray(parsed.publisherName) && parsed.publisherName.length) {
      publisherNames = parsed.publisherName.map(String);
      publisherLines = "publisherName:\n" + publisherNames.map((p) => "  - " + JSON.stringify(p)).join("\n");
    }
  } catch (e) { /* no existing file (dist:dir / first build) or unparsable */ }
  writeFileSync(ymlPath,
    "provider: generic\nurl: " + feedUrl + "\nupdaterCacheDirName: volt-pdf-reader-updater\n" +
    (publisherLines ? publisherLines + "\n" : ""));
  return publisherNames ? "publisherName=" + JSON.stringify(publisherNames) : null;
}

function serveFeed() {
  const server = createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
    const file = urlPath === "/" || urlPath === "/latest.yml"
      ? join(FEED_DIR, "latest.yml")
      : join(FEED_DIR, basename(urlPath));
    if (existsSync(file) && statSync(file).isFile()) {
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": statSync(file).size });
      createReadStream(file).pipe(res);
      return;
    }
    res.writeHead(404); res.end("not found");
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function runApp(feedUrl, adv) {
  const out = [];
  const child = spawn(UNPACKED_EXE, ["--smoke-feed"], {
    env: { ...process.env, VOLT_UPDATE_URL: feedUrl, VOLT_FEED_EXPECT_VERSION: adv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => { out.push(d.toString()); if (verbose) process.stdout.write("[volt] " + d); });
  child.stderr.on("data", (d) => { out.push(d.toString()); });
  const killer = setTimeout(() => { try { child.kill("SIGKILL"); } catch (e) { /* gone */ } }, 150000);
  return new Promise((resolve) => {
    child.on("exit", (code) => {
      clearTimeout(killer);
      resolve({ code, text: out.join("") });
    });
  });
}

async function main() {
  const installed = pkgVersion();
  const adv = advertisedVersion(installed);
  note("installed version " + installed + " → feed advertises " + adv);

  const installerExists = (() => { try { return !!findInstaller(); } catch (e) { return false; } })();
  if (shouldBuild || !existsSync(UNPACKED_EXE) || !installerExists) {
    if (!shouldBuild) note("dist/ missing or incomplete — building first");
    build();
  }
  const installer = findInstaller();
  if (!existsSync(UNPACKED_EXE)) fail("dist/win-unpacked/Volt.exe missing after build");

  const feed = makeFeed(installer, adv);
  ok("scratch feed published: " + FEED_DIR + " (" + feed.exeName + ", " + (feed.size / 1e6).toFixed(1) + " MB)");

  const server = await serveFeed();
  const feedUrl = "http://127.0.0.1:" + server.address().port + "/";
  note("feed server on " + feedUrl);
  const armed = ensureAppUpdateYml(feedUrl);
  if (armed) note("updater signature verification ARMED — " + armed + " (the feed's installer must be Authenticode-verified)");
  else note("no publisherName in app-update.yml — updater skips signature verification (unsigned build)");

  // NOTE: never process.exit() inside the try — the finally below MUST run to
  // restore the build's app-update.yml (process.exit skips finally blocks).
  let verdict = 1;
  try {
    const { code, text } = await runApp(feedUrl, adv);
    // SAFETY: the round-trip must never actually INSTALL the app — the feed's
    // installer is a real one. If an install dir materialized, the app quit
    // path ran the installer (autoInstallOnAppQuit regressed) — fail loudly
    // instead of silently leaving Volt installed on the machine.
    const installProbe = join(process.env.LOCALAPPDATA || "", "Programs", "Volt");
    if (existsSync(installProbe)) {
      throw new Error("GATE SAFETY VIOLATION: " + installProbe + " appeared — the round-trip triggered a real install! " +
        "autoInstallOnAppQuit must stay disabled in --smoke-feed.");
    }
    const m = /SMOKE_RESULT\s+(\{.*\})/.exec(text);
    if (!m) {
      throw new Error("no SMOKE_RESULT in app output (exit " + code + "). Log tail:\n" + text.slice(-3000));
    }
    const result = JSON.parse(m[1]);
    const f = result.feed || {};
    if (result.ok && f.bannerShown && f.pendingVersion === adv && f.updaterEnabled) {
      ok("round-trip verified: updater engaged → downloaded " + adv + " → version banner " +
        "(restart=" + f.restartVisible + ", downloadHidden=" + f.downloadHidden + ", countdown=" + f.countdown + ")");
      verdict = 0;
    } else {
      console.error("❌ round-trip FAILED: " + JSON.stringify(result));
    }
  } catch (e) {
    console.error("❌ round-trip FAILED: " + ((e && e.message) || e));
  } finally {
    server.close();
    // restore the build's own app-update.yml so a signed dist/ stays intact
    // for sign:check / future runs (and remove the pristine backup).
    try {
      if (existsSync(APP_UPDATE_ORIG)) {
        copyFileSync(APP_UPDATE_ORIG, join(DIST, "win-unpacked", "resources", "app-update.yml"));
        rmSync(APP_UPDATE_ORIG, { force: true });
      }
    } catch (e) {
      console.error("⚠ could not restore app-update.yml: " + e.message);
      verdict = 1;
    }
  }
  process.exit(verdict);
}

main().catch((e) => fail((e && e.stack) || String(e)));
