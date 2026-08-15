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
    cwd: APP_ROOT, stdio: "inherit", timeout: 600000,
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

  try {
    const { code, text } = await runApp(feedUrl, adv);
    // SAFETY: the round-trip must never actually INSTALL the app — the feed's
    // installer is a real one. If an install dir materialized, the app quit
    // path ran the installer (autoInstallOnAppQuit regressed) — fail loudly
    // instead of silently leaving Volt installed on the machine.
    const installProbe = join(process.env.LOCALAPPDATA || "", "Programs", "Volt");
    if (existsSync(installProbe)) {
      fail("GATE SAFETY VIOLATION: " + installProbe + " appeared — the round-trip triggered a real install! " +
        "autoInstallOnAppQuit must stay disabled in --smoke-feed.");
    }
    const m = /SMOKE_RESULT\s+(\{.*\})/.exec(text);
    if (!m) {
      fail("no SMOKE_RESULT in app output (exit " + code + "). Log tail:\n" + text.slice(-3000));
    }
    const result = JSON.parse(m[1]);
    const f = result.feed || {};
    if (result.ok && f.bannerShown && f.pendingVersion === adv && f.updaterEnabled) {
      ok("round-trip verified: updater engaged → downloaded " + adv + " → version banner " +
        "(restart=" + f.restartVisible + ", downloadHidden=" + f.downloadHidden + ", countdown=" + f.countdown + ")");
      process.exit(0);
    }
    console.error("❌ round-trip FAILED: " + JSON.stringify(result));
    process.exit(1);
  } finally {
    server.close();
  }
}

main().catch((e) => fail((e && e.stack) || String(e)));
