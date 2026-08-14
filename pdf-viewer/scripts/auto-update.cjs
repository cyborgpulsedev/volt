// ═══════════════════════════════════════════════════════════════
//   Volt — background vendor self-update (child process)
//   Forked by main.js (utilityProcess) a few seconds after startup:
//   once a day at most, check whether a newer pdf.js exists on the
//   CDN; if it does AND the swapped-in files pass the Electron smoke
//   gate, commit the update; on ANY failure roll back and stay silent.
//   Reports a single result object to the parent, which toasts only
//   on success.
//
//   Usage:
//     (real)   utilityProcess.fork("scripts/auto-update.cjs",
//                [userDataDir, isPackaged])            — process.execPath is the app
//     (manual) node scripts/auto-update.cjs <userDataDir> false --smoke-exe <electron>
//                [--latest <range>]  — --latest forces a pdf.js range (tests only)
//   ═══════════════════════════════════════════════════════════════ */
"use strict";

const { spawnSync } = require("node:child_process");
const { mkdirSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { dirname, join } = require("node:path");

const SCRIPTS_DIR = __dirname;
const APP_DIR = join(SCRIPTS_DIR, "..");

const args = process.argv.slice(2);
const userDataDir = args[0];
const isPackaged = args[1] === "1";
let smokeExe = (process.argv.indexOf("--smoke-exe") >= 0 ? process.argv[process.argv.indexOf("--smoke-exe") + 1] : null) || process.execPath;
if (!require("node:path").isAbsolute(smokeExe)) smokeExe = join(APP_DIR, smokeExe);
const latestOverride = (process.argv.indexOf("--latest") >= 0 ? process.argv[process.argv.indexOf("--latest") + 1] : null);

const report = (status, extra) => {
  const out = { status, ...extra };
  console.log("AUTOUPDATE_RESULT " + JSON.stringify(out));
  if (process.parentPort) process.parentPort.postMessage(out); // utilityProcess IPC
  // Give undici's keep-alive socket pool a beat to close before exiting — a
  // bare process.exit() right after fetch() can trip a libuv double-close
  // assertion on newer Node builds (saw it on Node 24; Node 20/Electron fine).
  setTimeout(() => process.exit(0), 100);
};

async function main() {
  // ── once-a-day gate: mark the date BEFORE any network work, so a failed
  //    check doesn't retry on every launch ("no more than once a day")
  const today = new Date().toISOString().slice(0, 10);
  const markerPath = join(userDataDir || APP_DIR, "volt-vendor-check.json");
  try {
    const prev = JSON.parse(readFileSync(markerPath, "utf8"));
    if (prev && prev.lastCheck === today) return report("skipped", { reason: "checked today" });
  } catch { /* no marker yet */ }
  try {
    mkdirSync(dirname(markerPath), { recursive: true });
    writeFileSync(markerPath, JSON.stringify({ lastCheck: today }));
  } catch { /* best effort — gate still enforced via the in-memory date */ }

  // ── writability probe: a packaged install whose vendor files are locked
  //    (or still inside app.asar without asarUnpack) must skip silently
  const vendorDir = join(APP_DIR, "vendor");
  const probe = join(vendorDir, ".write-probe-" + process.pid);
  try {
    writeFileSync(probe, "x");
    rmSync(probe);
  } catch (e) {
    return report("readonly", { reason: String((e && e.message) || e) });
  }

  const updater = await import("./update-vendor.mjs");
  const current = updater.readVersions();

  // ── decide: is there anything newer to apply? (pdf.js drives the check)
  const targetRange = latestOverride || "latest";
  const latestMeta = await updater.fetchJson("pdfjs-dist", targetRange);
  if (!latestMeta || !latestMeta.version) return report("failed", { reason: "no version from CDN (offline?)", current: current.pdfjs });
  const latest = latestMeta.version;
  if (updater.cmpVersions(latest, current.pdfjs) <= 0) return report("current", { current: current.pdfjs });

  // ── smoke gate runs THIS app (current exe) in no-focus mode: the render +
  //    hidden-contract + modal-trap probe still fully gates, but the window is
  //    never shown/focused, so a background update can't steal focus or flash.
  updater.setSmokeRunner((extraArgs = []) => {
    // extraArgs (e.g. --vendor-stage <dir> for the pre-swap DOM-contract gate)
    // are appended so the staged smoke runs against the same packaged binary
    const childArgs = (isPackaged ? [] : ["."]).concat(["--smoke-no-focus"], extraArgs);
    const res = spawnSync(smokeExe, childArgs, { cwd: APP_DIR, encoding: "utf8", timeout: 180_000, windowsHide: true });
    const out = (res.stdout || "") + (res.stderr || "");
    const m = out.match(/"ok":(true|false)/);
    if (res.error) return { ok: false, reason: String(res.error).slice(0, 200), out: out.slice(-800) };
    if (!m) return { ok: false, reason: `smoke exited ${res.status} without ok result`, out: out.slice(-800) };
    if (m[1] !== "true") return { ok: false, reason: "smoke reported ok:false", out: out.slice(-800) };
    if (res.status !== 0) return { ok: false, reason: `smoke printed ok:true but exited ${res.status}`, out: out.slice(-800) };
    return { ok: true, out: out.slice(-500) };
  });

  // ── apply: try the target; on failure fall back to the current major's
  //    newest patch (that's where Chromium-compat fixes usually land)
  let applied = await updater.attemptUpdate(targetRange, "latest");
  if (!applied.ok) {
    const curMajor = String(current.pdfjs || "4").split(".")[0];
    const curLatest = await updater.fetchJson("pdfjs-dist", curMajor);
    if (curLatest && curLatest.version && updater.cmpVersions(curLatest.version, current.pdfjs) > 0) {
      applied = await updater.attemptUpdate(curMajor, "latest");
    }
  }
  if (!applied.ok) return report("failed", { current: current.pdfjs, target: latest });

  const after = updater.readVersions();
  return report("updated", { pdfjs: after.pdfjs, current: current.pdfjs });
}

main().catch((e) => report("error", { reason: String((e && e.message) || e) }));
