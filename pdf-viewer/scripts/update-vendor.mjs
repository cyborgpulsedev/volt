// ═══════════════════════════════════════════════════════════════
//   Volt — vendored-library updater
//   Re-downloads the vendored pdf.js + pdf-lib from a CDN, verifies
//   them against the API surface the app actually uses, swaps them
//   in, and gates everything on the Electron smoke test. If anything
//   fails (a pdf.js major bump that renames the build files, a
//   Chromium regression, an API rename), the previous vendor files
//   are restored untouched and the failure is reported loudly — so
//   the next breakage is caught the moment it appears, never shipped.
//
//   Usage (from pdf-viewer/):
//     node scripts/update-vendor.mjs             update to latest + verify
//     node scripts/update-vendor.mjs --pin 4     stay on pdf.js 4.x (latest patch)
//     node scripts/update-vendor.mjs --dry-run   report current vs latest, change nothing
//     node scripts/update-vendor.mjs --check     just verify current vendor + smoke
//     node scripts/update-vendor.mjs --verify-staged <dir>   run ONLY the pre-swap
//                                  DOM-contract gate against <dir>'s vendor files
//                                  (no downloads, no swap — the CI/manual check)
//   ═══════════════════════════════════════════════════════════════ */
"use strict";

import { spawnSync } from "node:child_process";
import { closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cacheName, renderSw, writeArtifacts } from "./gen-sw.mjs";

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const APP_DIR = join(SCRIPTS_DIR, "..");
const VENDOR_DIR = join(APP_DIR, "vendor");
const SW_PATH = join(APP_DIR, "sw.js");
const INDEX_PATH = join(APP_DIR, "index.html");
const VERSIONS_PATH = join(VENDOR_DIR, "VERSIONS.json");
const STAGING_DIR = join(VENDOR_DIR, ".staging");
const BACKUP_DIR = join(VENDOR_DIR, ".backup");
// Set before the swap, cleared after the smoke gate + commit (or a rollback).
// If the process dies inside that window, the next launch restores the backup
// (see scripts/vendor-recovery.cjs) instead of booting against half-swapped files.
const PENDING_FLAG = join(VENDOR_DIR, ".update-pending");

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has("--dry-run");
const CHECK_ONLY = args.has("--check");
const CHECK_ELECTRON = args.has("--check-electron"); // deep-test the latest Electron against the smoke gate
const SKIP_SMOKE = args.has("--skip-smoke");
// Headless gate for unattended runs (the weekly Scheduled Task): same render +
// hidden-contract + modal-trap probe, but the window is never shown or focused
// (the full --smoke variant briefly shows+focuses it for its keyboard stage).
const NO_FOCUS = args.has("--no-focus");
const pinArg = (flag) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
};
const PDFJS_PIN = pinArg("--pin");      // e.g. "4" → latest 4.x, null → latest
const PDFLIB_PIN = pinArg("--pin-lib"); // e.g. "1"

const CDNS = {
  unpkg: "https://unpkg.com/{pkg}@{range}/{file}",
  jsdelivr: "https://cdn.jsdelivr.net/npm/{pkg}@{range}/{file}",
};

// tesseract.js is PINNED, not floating: the OCR engine (API + worker + wasm
// core variants + the English traineddata) is version-locked, and bumping it is
// a deliberate change here — a "latest" bump would silently swap the engine the
// smoke's OCR stage gates on. The wasm binaries and the gzipped traineddata are
// BINARY (fetched as arrayBuffer, verified by size + gzip magic), everything
// else is text verified by an API marker.
const TESS_JS = "5.1.1";
const TESS_CORE = "5.1.0";
const TESS_LANG = "4.0.0";
const TESS_CORE_FILES = ["tesseract-core.wasm.js", "tesseract-core.wasm",
  "tesseract-core-simd.wasm.js", "tesseract-core-simd.wasm",
  "tesseract-core-lstm.wasm.js", "tesseract-core-lstm.wasm",
  "tesseract-core-simd-lstm.wasm.js", "tesseract-core-simd-lstm.wasm"];

/** the files to fetch for a given pair of ranges (per-attempt, not global). */
function filesFor(pdfjsRange, pdflibRange) {
  return [
    { id: "pdfjs",   pkg: "pdfjs-dist", range: pdfjsRange,   file: "build/pdf.min.mjs",            min: 100_000, marker: "TextLayer" },
    { id: "pdfjs-worker", pkg: "pdfjs-dist", range: pdfjsRange,   file: "build/pdf.worker.min.mjs", min: 200_000, marker: "WorkerMessageHandler" },
    { id: "pdflib",  pkg: "pdf-lib",     range: pdflibRange, file: "dist/pdf-lib.min.js",         min: 100_000, marker: "PDFDocument" },
    // ── tesseract.js OCR (pinned) ──
    { id: "tess-api", pkg: "tesseract.js", range: TESS_JS, file: "dist/tesseract.min.js", subdir: "tesseract", min: 50_000, marker: "Tesseract" },
    { id: "tess-worker", pkg: "tesseract.js", range: TESS_JS, file: "dist/worker.min.js", subdir: "tesseract", min: 50_000, marker: "importScripts" },
    ...TESS_CORE_FILES.map((f) => ({ id: "tess-core-" + f, pkg: "tesseract.js-core", range: TESS_CORE, file: f, subdir: "tesseract/core", binary: /\\.wasm$/.test(f), min: /\.wasm$/.test(f) ? 1_000_000 : 200_000 })),
    // the traineddata lives on tesseract.js's own tessdata host (not unpkg) —
    // fetchFile's absolute-url support handles it
    { id: "tess-lang", pkg: "tessdata", range: TESS_LANG, url: `https://tessdata.projectnaptha.com/${TESS_LANG}/eng.traineddata.gz`, file: "eng.traineddata.gz", subdir: "tesseract/tessdata", binary: true, min: 500_000 },
  ];
}

const fail = (msg) => { console.error("\n✗ " + msg); process.exitCode = 1; };

/** fetch with a hard timeout so a stalled CDN can't hang the updater forever. */
async function fetchWithTimeout(url, ms = 60_000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { signal: ctl.signal, headers: { "user-agent": "volt-vendor-updater" } });
  } finally {
    clearTimeout(t);
  }
}

/** fetch with a CDN fallback; returns { ok, text|buf, from, error }. Binary
    specs (wasm, traineddata) are fetched as arrayBuffer — .text() would corrupt
    them. A spec with an absolute `url` (the traineddata's own host) is fetched
    directly instead of through the CDN template. */
async function fetchFile(cdnSpec) {
  const tryUrl = async (url, label) => {
    const res = await fetchWithTimeout(url);
    if (!res.ok) throw new Error("HTTP " + res.status);
    if (cdnSpec.binary) {
      const buf = Buffer.from(await res.arrayBuffer());
      return { ok: true, buf, from: label, url };
    }
    return { ok: true, text: await res.text(), from: label, url };
  };
  try {
    if (cdnSpec.url) return await tryUrl(cdnSpec.url, "tessdata");
  } catch (e) {
    console.log(`    (tessdata failed: ${e.message})`);
    return { ok: false, text: "", error: `could not fetch ${cdnSpec.url}` };
  }
  for (const [cdn, tpl] of Object.entries(CDNS)) {
    const url = tpl.replace("{pkg}", cdnSpec.pkg).replace("{range}", cdnSpec.range).replace("{file}", cdnSpec.file);
    try {
      return await tryUrl(url, cdn);
    } catch (e) {
      console.log(`    (${cdn} failed: ${e.message})`);
    }
  }
  return { ok: false, text: "", error: `could not fetch ${cdnSpec.pkg}@${cdnSpec.range}/${cdnSpec.file} from any CDN` };
}

async function fetchJson(pkg, range) {
  for (const cdn of Object.keys(CDNS)) {
    const url = CDNS[cdn].replace("{pkg}", pkg).replace("{range}", range).replace("{file}", "package.json");
    try {
      const res = await fetchWithTimeout(url);
      if (res.ok) return await res.json();
    } catch (e) { /* try next */ }
  }
  return null;
}

const readVersions = () => {
  try { return JSON.parse(readFileSync(VERSIONS_PATH, "utf8")); } catch { return {}; }
};
const writeVersions = (v) => writeFileSync(VERSIONS_PATH, JSON.stringify(v, null, 2) + "\n");

/** Node has no DOM, and pdf.js's modern build refuses to even load without it.
    These minimal stubs expose the module's API surface for the check — the real
    functional gate is the Electron smoke test in an actual Chromium. */
function installDomStubs() {
  if (typeof globalThis.DOMMatrix === "undefined") {
    globalThis.DOMMatrix = class DOMMatrix { constructor() {} static fromMatrix(m) { return m; } };
    globalThis.DOMMatrixReadOnly = globalThis.DOMMatrix;
  }
  if (typeof globalThis.Path2D === "undefined") globalThis.Path2D = class Path2D {};
  if (typeof globalThis.OffscreenCanvas === "undefined") {
    globalThis.OffscreenCanvas = class OffscreenCanvas {
      constructor(w, h) { this.width = w; this.height = h; }
      getContext() { return null; }
    };
  }
}

let checkRun = 0;

/** pdf.js must expose the API the app calls; pdf-lib must expose PDFDocument. */
async function checkApi(pdfjsPath, pdflibPath) {
  installDomStubs();
  // ESM import cache keys on the URL — the staging files are rewritten between
  // attempts, so a cache-busting query keeps each attempt's check honest.
  const key = "?r=" + (++checkRun);
  const out = {};
  try {
    const m = await import(pathToFileURL(pdfjsPath).href + key);
    const need = ["getDocument", "TextLayer", "GlobalWorkerOptions", "Util", "version"];
    out.pdfjs = { ok: need.every((k) => typeof m[k] !== "undefined"), version: m.version,
      missing: need.filter((k) => typeof m[k] === "undefined") };
  } catch (e) {
    out.pdfjs = { ok: false, error: String((e && e.message) || e).slice(0, 200) };
  }
  try {
    const m = await import(pathToFileURL(pdflibPath).href + key);
    const lib = m && m.default ? m.default : m;
    out.pdflib = { ok: !!(lib && typeof lib.PDFDocument !== "undefined"), version: lib?.version || null };
  } catch (e) {
    out.pdflib = { ok: false, error: String((e && e.message) || e).slice(0, 200) };
  }
  // tesseract.min.js is a browser/worker UMD bundle — importing it in Node
  // throws on the worker-only `self` global, so the surface check is static
  // (size + markers): the REAL functional gate is the smoke probe's OCR stage,
  // which loads the actual engine in Chromium. The engine also needs the
  // worker, the wasm core, and the traineddata present — all checked here.
  const tessPath = join(VENDOR_DIR, "tesseract", "tesseract.min.js");
  if (existsSync(tessPath)) {
    const txt = readFileSync(tessPath, "utf8");
    const files = {
      worker: existsSync(join(VENDOR_DIR, "tesseract", "worker.min.js")),
      core: existsSync(join(VENDOR_DIR, "tesseract", "core", "tesseract-core.wasm.js")),
      lang: existsSync(join(VENDOR_DIR, "tesseract", "tessdata", "eng.traineddata.gz")),
    };
    out.tesseract = {
      ok: txt.length > 50_000 && txt.includes("createWorker") && txt.includes("Tesseract") &&
        Object.values(files).every(Boolean),
      files,
    };
  } else {
    out.tesseract = { ok: false, error: "missing vendor/tesseract/tesseract.min.js" };
  }
  return out;
}

// Background auto-updates (scripts/auto-update.cjs) run inside the app itself,
// so the smoke gate must spawn the CURRENT executable (electron.exe in dev,
// Volt.exe packaged) rather than the dev-only node_modules path.
let smokeRunner = null;
export function setSmokeRunner(fn) { smokeRunner = fn; }

/** run the Electron smoke test. Defaults to the app's pinned Electron; the
    --check-electron deep check passes the freshly-downloaded newer binary.
    extraArgs (e.g. --vendor-stage <dir>) are appended to the smoke argv and
    forwarded to the background auto-updater's smokeRunner when one is set. */
function runSmoke(exeOverride, extraArgs = []) {
  if (!exeOverride && smokeRunner) return smokeRunner(extraArgs);
  const exe = exeOverride || join(APP_DIR, "node_modules", "electron", "dist", process.platform === "win32" ? "electron.exe" : "electron");
  if (!existsSync(exe)) {
    return { ok: false, reason: `Electron binary not found at ${exe} — run start-volt-app.cmd once first` };
  }
  const res = spawnSync(exe, [".", NO_FOCUS ? "--smoke-no-focus" : "--smoke", ...extraArgs], { cwd: APP_DIR, encoding: "utf8", timeout: 120_000, windowsHide: true });
  const out = (res.stdout || "") + (res.stderr || "");
  const m = out.match(/"ok":(true|false)/);
  // the SMOKE_RESULT JSON is ~4.5 KB — keep enough of the transcript on the
  // failure path for summarizeSmokeFailures to parse the failing stage names
  if (res.error) return { ok: false, reason: String(res.error).slice(0, 200), out: out.slice(-12000) };
  if (!m) return { ok: false, reason: `smoke exited ${res.status} without ok result`, out: out.slice(-12000) };
  if (m[1] !== "true") return { ok: false, reason: "smoke reported ok:false", out: out.slice(-12000) };
  if (res.status !== 0) return { ok: false, reason: `smoke printed ok:true but exited ${res.status}`, out: out.slice(-12000) };
  return { ok: true, out: out.slice(-500) };
}

/** Pull the failing probe gates out of a SMOKE_RESULT transcript, so a failed
    gate names the DOM-contract stage (e.g. hiddenProbe.boot, visibleProbe,
    modalCycle) instead of a bare ok:false. Returns a comma-joined string or
    null when nothing can be parsed. */
function summarizeSmokeFailures(out) {
  const m = String(out || "").match(/SMOKE_RESULT (\{.*\})/);
  if (!m) return null;
  try {
    const r = JSON.parse(m[1]);
    const fails = [];
    for (const [k, v] of Object.entries(r.hiddenProbe || {})) {
      if (v && typeof v === "object" && v.pass === false) fails.push("hiddenProbe." + k);
    }
    for (const [k, v] of Object.entries(r.visibleProbe || {})) {
      if (v && typeof v === "object" && v.pass === false) fails.push("visibleProbe." + k);
    }
    for (const k of ["modalCycle", "serviceWorkerCache", "indexHtmlCache", "fingerprint", "restoreSummary", "restoreUrl", "textHighlightMove", "duplicate", "nudge", "rotateArea", "modal", "watch", "realKeys", "vendorBootErrors"]) {
      const v = r[k];
      if (v && typeof v === "object" && v.allOk === false) fails.push(k);
      if (k === "realKeys" && v && typeof v === "object" && v.ok === false) fails.push("realKeys");
      if (k === "realKeys" && v && typeof v === "object" && v.restore && v.restore.allOk === false) fails.push("realKeys.restore");
    }
    if (!fails.length && r.ok === false) return "probe reported ok:false (no stage detail)";
    return fails.length ? fails.join(", ") : null;
  } catch { return null; }
}

/** Pre-swap DOM-contract gate: run the FULL smoke probe — render, text layer,
    exports, and the hiddenProbe/visibleProbe DOM contracts — against the
    STAGED vendor files (via --vendor-stage), BEFORE they are swapped in. A
    bump that breaks the DOM contract (or anything else the probe measures)
    fails here with zero churn: no swap, no backup, no pending flag, nothing
    to roll back. */
function runStagedGate(stageDir) {
  // the gate's whole purpose is catching a bad/partial swap — if any staged
  // file is missing, the server would silently fall back to the REAL vendor
  // and the gate would test the old files instead of the new ones. Fail loud.
  const missing = ["pdf.min.mjs", "pdf.worker.min.mjs", "pdf-lib.min.js",
    "tesseract/tesseract.min.js", "tesseract/worker.min.js", "tesseract/tessdata/eng.traineddata.gz"].filter(
    (f) => !existsSync(join(stageDir, f)));
  if (missing.length) {
    return { ok: false, reason: "staged vendor incomplete — missing " + missing.join(", ") + " in " + stageDir };
  }
  const smoke = runSmoke(undefined, ["--vendor-stage", stageDir]);
  return { ok: smoke.ok, reason: smoke.reason, fails: summarizeSmokeFailures(smoke.out || ""), out: smoke.out };
}

/** Regenerate the derived artifacts (sw.js + stamped index.html): the cache
    name is a SHA-256 of the app shell's contents and the ?v= stamps hash each
    referenced asset, so the just-swapped vendor files flow into both
    automatically — installed apps drop the stale files, and the browser HTTP
    cache refetches the changed vendor URLs, without any manual version bump.
    writeArtifacts() orders index.html before sw.js — the stamps feed the
    shell hash, so one regeneration is consistent. */
function bumpSwCache() {
  try {
    writeArtifacts();
    return { ok: true, cache: cacheName() };
  } catch (e) {
    return { ok: false, reason: "could not regenerate sw.js/index.html: " + ((e && e.message) || e) };
  }
}

const banner = (s) => console.log("\n── " + s + " ──");

/** numeric-ish semver compare: 1 if a>b, -1 if a<b, 0 if equal. Shared with
    the background auto-updater (scripts/auto-update.cjs). */
function cmpVersions(a, b) {
  const pa = String(a || "").split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b || "").split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** the pinned Electron range from package.json (devDependencies.electron). */
function readPinnedElectron() {
  try {
    const pkg = JSON.parse(readFileSync(join(APP_DIR, "package.json"), "utf8"));
    const raw = pkg && pkg.devDependencies && pkg.devDependencies.electron;
    if (!raw) return null;
    const pinned = String(raw).replace(/^[\^~>= ]+/, "").replace(/^v/, "");
    return { raw: String(raw), pinned: /^\d+(\.\d+)*$/.test(pinned) ? pinned : null };
  } catch { return null; }
}

/** pinned vs latest stable Electron ({ raw, pinned, latest, newer } or null when unknown). */
async function electronStatus() {
  const pinned = readPinnedElectron();
  if (!pinned || !pinned.pinned) return null;
  const j = await fetchJson("electron", "latest");
  if (!j || !j.version) return null;
  return { raw: pinned.raw, pinned: pinned.pinned, latest: j.version, newer: cmpVersions(j.version, pinned.pinned) > 0 };
}

/** one-line Electron status for every run (a suggestion only — never bumps on its own). */
async function reportElectron() {
  const st = await electronStatus();
  if (!st) return; // offline or not pinned — stay silent
  if (st.newer) {
    console.log(`\nElectron: pinned ${st.pinned}, latest is ${st.latest}.`);
    console.log(`  The smoke gate (render + rAF/compositing shim) covers a bump — verify first:`);
    console.log(`    npm run update:vendor -- --check-electron   # downloads ${st.latest} to a temp dir and smoke-tests it`);
    console.log(`    npm install --save-dev electron@${st.latest} && npx install-electron && npm run smoke   # the bump`);
  } else {
    console.log(`\nElectron: ${st.pinned} is the latest stable.`);
  }
}

/** --check-electron: obtain the latest Electron in a temp dir and gate it on the
    real smoke test. Reports "safe to bump" only when that gate passes — the
    rAF/compositing shim keys on the Electron user-agent (version-agnostic), so
    the smoke's render-completes probe is the compatibility signal, not a guess. */
async function checkElectronDeep() {
  const st = await electronStatus();
  if (!st) { fail("could not determine the latest Electron (offline, or no electron pin in package.json)"); return; }
  if (!st.newer) { console.log(`Electron ${st.pinned} is already the latest stable.`); return; }
  if (DRY_RUN) { console.log(`(dry-run) would download electron ${st.latest} to a temp dir and run the smoke gate on it.`); return; }
  console.log(`\nElectron ${st.pinned} → ${st.latest}: installing the newer runtime into a temp dir (one-time download; cleaned up after)...`);
  console.log("  (note: run with Volt closed — the gate uses the app's own user-data dir)");
  const tmp = mkdtempSync(join(tmpdir(), "volt-electron-"));
  try {
    const npmArgs = ["install", "--prefix", tmp, "electron@" + st.latest, "--no-save", "--no-package-lock", "--no-audit", "--no-fund"];
    // Prefer npm's own cli.js under this node — npm sets npm_execpath for lifecycle
    // scripts; otherwise derive the standard install location. No shell needed in
    // either case; npm.cmd + shell remains only as a last-resort fallback.
    const npmCandidates = [process.env.npm_execpath, join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")]
      .filter((p) => p && existsSync(p));
    const res = npmCandidates.length
      ? spawnSync(process.execPath, [npmCandidates[0], ...npmArgs], { encoding: "utf8", timeout: 600_000, windowsHide: true })
      : spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", npmArgs, { encoding: "utf8", timeout: 600_000, windowsHide: true, shell: process.platform === "win32" });
    const pkgDir = join(tmp, "node_modules", "electron");
    const exe = join(pkgDir, "dist", process.platform === "win32" ? "electron.exe" : "electron");
    if (!existsSync(exe)) {
      // Electron ≥ 43 no longer ships an npm postinstall — the binary download is
      // an explicit step (bin: install-electron). Run the package's own installer;
      // for older versions (postinstall already ran) it's a fast no-op.
      const inst = spawnSync(process.execPath, [join(pkgDir, "install.js")], { cwd: pkgDir, encoding: "utf8", timeout: 600_000, windowsHide: true });
      if (!existsSync(exe)) {
        const log = ((res.stdout || "") + (res.stderr || "") + (inst.stdout || "") + (inst.stderr || "")).trim().split("\n").slice(-12).join("\n");
        const err = (res.error || inst.error);
        fail("could not obtain electron " + st.latest + " — " + ((err && err.message) || "npm install produced no binary"));
        if (log) console.log(log.replace(/^/gm, "    "));
        return;
      }
    }
    console.log("✓ electron " + st.latest + " downloaded — running the smoke gate on it...");
    const smoke = runSmoke(exe);
    if (!smoke.ok) {
      fail("electron " + st.latest + " FAILED the smoke test — keep the current pin (" + st.pinned + "). " + smoke.reason);
      if (smoke.out) console.log(smoke.out.replace(/^/gm, "    "));
      return;
    }
    console.log("✓ electron " + st.latest + " passes the smoke gate (render + rAF/compositing shim + focus trap).");
    console.log("  Safe to bump package.json:  npm install --save-dev electron@" + st.latest);
    console.log("  Newer Electron (≥ 43) ships its binary as an explicit step:  npx install-electron");
    console.log("  Then re-run:  npm run smoke   and   npm run update:vendor");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** one full update attempt: resolve range → download → API check → swap → smoke → commit.
    On any failure it rolls back and leaves the previous vendor untouched. */
async function attemptUpdate(pdfjsRange, pdflibRange) {
  let finalCache = null; // cache name after commit (sw is block-scoped to the try)
  // ── resolve versions ─────────────────────────────────────────
  const meta = {};
  for (const [pkg, range, key] of [["pdfjs-dist", pdfjsRange, "pdfjs"], ["pdf-lib", pdflibRange, "pdflib"]]) {
    const j = await fetchJson(pkg, range);
    meta[key] = j && j.version ? j.version : "?";
  }
  console.log(`target: pdf.js ${meta.pdfjs}${pdfjsRange === "latest" ? " (latest)" : ` (${pdfjsRange}.*)`} · pdf-lib ${meta.pdflib}${pdflibRange === "latest" ? " (latest)" : ` (${pdflibRange}.*)`}`);

  // ── download to staging ──────────────────────────────────────
  banner("downloading");
  mkdirSync(STAGING_DIR, { recursive: true });
  const staging = {};
  for (const spec of filesFor(pdfjsRange, pdflibRange)) {
    process.stdout.write(`  ${spec.id}: `);
    const res = await fetchFile(spec);
    if (!res.ok) { rmSync(STAGING_DIR, { recursive: true, force: true }); fail("download failed: " + res.error); return { ok: false }; }
    const size = spec.binary ? res.buf.length : res.text.length;
    if (size < spec.min) { rmSync(STAGING_DIR, { recursive: true, force: true }); fail(`${spec.id}: suspiciously small download (${size} bytes)`); return { ok: false }; }
    // text specs carry an API marker; binary specs are verified by size (the
    // gzipped traineddata additionally by its gzip magic bytes)
    if (!spec.binary && !res.text.includes(spec.marker)) { rmSync(STAGING_DIR, { recursive: true, force: true }); fail(`${spec.id}: missing expected marker "${spec.marker}"`); return { ok: false }; }
    if (spec.binary && spec.id === "tess-lang" && (res.buf[0] !== 0x1f || res.buf[1] !== 0x8b)) { rmSync(STAGING_DIR, { recursive: true, force: true }); fail(`${spec.id}: not a gzip stream (missing gzip magic)`); return { ok: false }; }
    const out = join(STAGING_DIR, spec.subdir || "", spec.file.split("/").pop());
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, spec.binary ? res.buf : res.text);
    staging[spec.id] = out;
    console.log(`ok (${(size / 1024).toFixed(0)} KB, via ${res.from})`);
  }

  // ── API surface check on the staged files ────────────────────
  banner("checking API surface");    const api = await checkApi(staging.pdfjs, staging.pdflib);
  const pdfjsStatus = api.pdfjs.ok ? "API OK"
    : (api.pdfjs.missing && api.pdfjs.missing.length ? "API MISMATCH — missing " + JSON.stringify(api.pdfjs.missing)
      : "could not load in Node: " + (api.pdfjs.error || "?"));
  console.log(`pdf.js ${api.pdfjs.version || "?"}: ${pdfjsStatus}`);
  console.log(`pdf-lib: ${api.pdflib.ok ? "API OK" : "API FAIL " + JSON.stringify(api.pdflib.error)}`);
  if (!api.pdfjs.ok || !api.pdflib.ok) {
    fail("new version is API-incompatible — keeping the current vendor files");
    rmSync(STAGING_DIR, { recursive: true, force: true });
    return { ok: false };
  }

  // ── pre-swap DOM-contract gate on the STAGED files ──────────
  // the API check above loads the staged modules in Node (no real DOM); the
  // DOM contract — hiddenProbe/visibleProbe, and the whole render/exports
  // probe — needs a real browser. Run the smoke probe against the staged
  // files BEFORE the swap: a bump that breaks the contract fails the
  // verification here, with no swap/backup/lock churn and nothing to roll
  // back. Only --skip-smoke opts out of this (and the post-swap) gate.
  if (!SKIP_SMOKE) {
    banner("pre-swap smoke gate (staged vendor)");
    const gate = runStagedGate(STAGING_DIR);
    if (!gate.ok) {
      if (gate.fails) console.log("✗ DOM/render contract broke: " + gate.fails);
      console.log("✗ " + gate.reason);
      if (gate.out) console.log(gate.out.replace(/^/gm, "    "));
      rmSync(STAGING_DIR, { recursive: true, force: true });
      fail("pre-swap gate failed with the new vendor — nothing was swapped; current files untouched");
      return { ok: false };
    }
    console.log("✓ staged vendor passes the pre-swap DOM-contract gate (render + hidden/visible probes)");
  } else {
    console.log("(pre-swap gate skipped via --skip-smoke)");
  }

  // ── swap with backup, smoke gate, commit (all rollback-guarded) ──
  // any exception here (fs lock, disk full, …) must restore the previous
  // vendor files — a partial swap is the one state we must never leave.
  banner("swapping vendor files");
  rmSync(BACKUP_DIR, { recursive: true, force: true });
  mkdirSync(BACKUP_DIR, { recursive: true });
  const targets = {};
  for (const spec of filesFor(pdfjsRange, pdflibRange)) {
    targets[spec.id] = join(VENDOR_DIR, spec.subdir || "", spec.file.split("/").pop());
  }
  let lockOwned = false; // this run created the pending-flag lock (see below)
  const restore = () => {
    for (const tgt of Object.values(targets)) rmSync(tgt, { force: true });
    for (const tgt of Object.values(targets)) {
      const bk = join(BACKUP_DIR, tgt.split(/[\\/]/).pop()); // backups are flat; filenames are unique
      if (existsSync(bk)) {
        mkdirSync(dirname(tgt), { recursive: true }); // subdir targets (tesseract/core/…) restore into their dirs
        renameSync(bk, tgt);
      }
    }
    rmSync(BACKUP_DIR, { recursive: true, force: true });
    // rollback complete — the flag must not outlive it. But only if WE created
    // it: clearing another updater's lock would leave that update unprotected.
    if (lockOwned) rmSync(PENDING_FLAG, { force: true });
  };

  try {
    // Mutual exclusion: the pending flag doubles as a cross-process lock, created
    // EXCLUSIVELY here. If another updater (the app's background auto-update, a
    // concurrent CLI run, the weekly Scheduled Task) is already inside the
    // swap→gate window, its flag file exists and this run aborts BEFORE touching
    // backups or targets — two updates can never interleave their file writes.
    let lockFd = null;
    try {
      lockFd = openSync(PENDING_FLAG, "wx");
      lockOwned = true;
    } catch (e) {
      if (e && e.code === "EEXIST") {
        rmSync(STAGING_DIR, { recursive: true, force: true });
        rmSync(BACKUP_DIR, { recursive: true, force: true }); // we only created an empty one
        fail("another vendor update is already in progress — this run skipped");
        return { ok: false };
      }
      throw e;
    }
    // Presence is the lock; the pid documents the owner. Write it through the
    // fd and close BEFORE anything throwable (the backup loop): restore() clears
    // the flag on rollback, and on Windows removing a file with an open handle
    // is EBUSY — an open fd here would abort the rollback midway.
    try {
      writeFileSync(lockFd, String(process.pid));
    } finally {
      closeSync(lockFd);
    }
    for (const tgt of Object.values(targets)) {
      if (existsSync(tgt)) copyFileSync(tgt, join(BACKUP_DIR, tgt.split(/[\\/]/).pop()));
    }
    for (const [id, staged] of Object.entries(staging)) renameSync(staged, targets[id]);
    rmSync(STAGING_DIR, { recursive: true, force: true });
    console.log("staged files moved into vendor/ (originals backed up)");

    // ── gate on the smoke test ─────────────────────────────────
    if (!SKIP_SMOKE) {
      banner("smoke test (Electron)");
      const smoke = runSmoke();
      if (!smoke.ok) {
        console.log("✗ " + smoke.reason);
        if (smoke.out) console.log(smoke.out.replace(/^/gm, "    "));
        banner("rolling back");
        restore();
        fail("smoke failed with the new vendor — previous files restored");
        return { ok: false };
      }
      console.log("✓ smoke passed with the new vendored libraries");
    } else {
      console.log("(smoke skipped via --skip-smoke)");
    }

    // ── commit: regenerate the artifacts (index.html first, then sw.js — the
    //    stamps feed the shell hash, so one pass is consistent), then record the
    //    versions with the ACTUAL post-regeneration cache name. Running the
    //    regeneration first means a failed commit records nothing at all (the
    //    rollback below restores the old vendor untouched) instead of a bogus
    //    VERSIONS entry for files that never shipped.
    const sw = bumpSwCache();
    if (!sw.ok) {
      banner("rolling back");
      restore();
      try { writeFileSync(SW_PATH, renderSw()); } catch (e) { /* best effort */ }
      fail(sw.reason + " — update applied but rolled back");
      return { ok: false };
    }
    writeVersions({ pdfjs: api.pdfjs.version, pdflib: meta.pdflib, tesseract: TESS_JS, tesseractCore: TESS_CORE, cache: sw.cache, updated: new Date().toISOString() });
    finalCache = sw.cache; // block-scoped sw is not visible after the try
    rmSync(PENDING_FLAG, { force: true }); // committed — no recovery needed
    rmSync(BACKUP_DIR, { recursive: true, force: true });
  } catch (e) {
    banner("error — rolling back");
    restore();
    try { writeFileSync(SW_PATH, renderSw()); } catch (e2) { /* best effort */ }
    fail((e && e.message) || String(e));
    return { ok: false };
  }

  console.log(`\n✓ updated: pdf.js ${api.pdfjs.version} · pdf-lib ${meta.pdflib}`);
  console.log(`  PWA cache regenerated to ${finalCache} — installed apps will refresh on next launch.`);
  return { ok: true };
}

async function main() {
  console.log("Volt vendored-library updater" + (DRY_RUN ? "  [dry-run — nothing will change]" : "") + (CHECK_ONLY ? "  [check-only — current vendor verified]" : ""));

  // ── current state ────────────────────────────────────────────
  const versions = readVersions();
  const current = {
    pdfjs: existsSync(join(VENDOR_DIR, "pdf.min.mjs")) ? (versions.pdfjs || "present") : "missing",
    pdflib: existsSync(join(VENDOR_DIR, "pdf-lib.min.js")) ? (versions.pdflib || "present") : "missing",
    tesseract: existsSync(join(VENDOR_DIR, "tesseract", "tesseract.min.js")) ? (versions.tesseract || "present") : "missing",
  };
  let swCache = "volt-v?";
  try { swCache = (readFileSync(SW_PATH, "utf8").match(/const CACHE = "([^"]+)"/) || [])[1] || swCache; } catch { /* keep default */ }
  console.log(`current: pdf.js ${current.pdfjs} · pdf-lib ${current.pdflib} · tesseract ${current.tesseract} · sw cache ${swCache}`);

  // ── Electron status (suggestion only; --check-electron deep-tests a bump) ──
  await reportElectron();

  const verifyStagedDir = pinArg("--verify-staged");
  if (verifyStagedDir) {
    // the standalone form of the pre-swap gate — no downloads, no swap; the
    // same code path attemptUpdate uses. The CI/manual check for "does THIS
    // vendor dir pass the DOM contract?"
    banner("pre-swap DOM-contract gate against " + verifyStagedDir);
    const gate = runStagedGate(verifyStagedDir);
    if (!gate.ok) {
      if (gate.fails) console.log("✗ DOM/render contract broke: " + gate.fails);
      console.log("✗ " + gate.reason);
      if (gate.out) console.log(gate.out.replace(/^/gm, "    "));
      fail("staged vendor failed the pre-swap gate");
      return;
    }
    console.log("✓ staged vendor passes the pre-swap DOM-contract gate");
    return;
  }

  if (CHECK_ONLY) {
    banner("verifying current vendor");
    const api = await checkApi(join(VENDOR_DIR, "pdf.min.mjs"), join(VENDOR_DIR, "pdf-lib.min.js"));
    const pdfjsStatus = api.pdfjs.ok ? "API OK"
      : (api.pdfjs.missing && api.pdfjs.missing.length ? "API MISMATCH — missing " + JSON.stringify(api.pdfjs.missing)
        : "could not load in Node: " + (api.pdfjs.error || "?"));
    console.log(`pdf.js ${api.pdfjs.version}: ${pdfjsStatus}`);
    console.log(`pdf-lib: ${api.pdflib.ok ? "API OK" : "API FAIL " + JSON.stringify(api.pdflib.error)}`);
    console.log(`tesseract: ${api.tesseract && api.tesseract.ok ? "API OK" : "API FAIL " + JSON.stringify(api.tesseract && api.tesseract.error)}`);
    if (SKIP_SMOKE) return;
    banner("smoke test (Electron)");
    const smoke = runSmoke();
    console.log(smoke.ok ? "✓ smoke passed" : "✗ " + smoke.reason);
    if (!api.pdfjs.ok || !api.pdflib.ok || !(api.tesseract && api.tesseract.ok) || !smoke.ok) { fail("vendor verification failed"); return; }
    console.log("\n✓ vendor is healthy");
    if (CHECK_ELECTRON) await checkElectronDeep(); // --check --check-electron runs both
    return;
  }

  if (CHECK_ELECTRON) { await checkElectronDeep(); return; }

  // ── decide target ranges ─────────────────────────────────────
  banner("checking CDN for updates");
  const meta = {};
  for (const [pkg, range, key] of [["pdfjs-dist", PDFJS_PIN || "latest", "pdfjs"], ["pdf-lib", PDFLIB_PIN || "latest", "pdflib"]]) {
    const j = await fetchJson(pkg, range);
    meta[key] = j && j.version ? j.version : "?";
  }
  console.log(`latest: pdf.js ${meta.pdfjs}${PDFJS_PIN ? ` (pinned ${PDFJS_PIN}.*)` : ""} · pdf-lib ${meta.pdflib}${PDFLIB_PIN ? ` (pinned ${PDFLIB_PIN}.*)` : ""}`);

  if (versions.pdfjs === meta.pdfjs && versions.pdflib === meta.pdflib) {
    console.log("already up to date — nothing to do.");
    return;
  }
  if (DRY_RUN) { console.log("(dry-run) an update is available — no files changed."); return; }

  // ── update: try latest, then fall back to the current major ──
  let result = await attemptUpdate(PDFJS_PIN || "latest", PDFLIB_PIN || "latest");
  if (!result.ok && !PDFJS_PIN) {
    // a major bump broke the app — stay on the known-good major's latest
    // patch/minor (that's where Chromium-compat fixes usually land)
    const curMajor = (versions.pdfjs || "4").split(".")[0];
    console.log(`\nlatest major is incompatible — retrying on the current major (pdf.js ${curMajor}.x)`);
    result = await attemptUpdate(curMajor, PDFLIB_PIN || "latest");
  }
  if (!result.ok) {
    fail("update aborted — the previous vendor files are still in place and working.");
    process.exitCode = 1;
  }
}

// Run only when invoked as a CLI (npm run update:vendor). Importing this module
// from the background auto-updater must be side-effect-free — no update runs.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((e) => { fail((e && e.stack) || String(e)); });
}

export { attemptUpdate, cmpVersions, fetchJson, readVersions }; // setSmokeRunner is exported inline above
