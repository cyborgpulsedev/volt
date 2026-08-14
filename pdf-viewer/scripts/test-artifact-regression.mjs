// ═══════════════════════════════════════════════════════════════
//   Volt — artifact-generator negative regression guard
//   Proves the sw.js cache name (and the index.html ?v= stamps) are
//   actually derived from the app shell's file contents, and that the
//   smoke's artifact stages FAIL when they go stale:
//
//     · edits js/app.js, then without regenerating anything asserts
//       the generator's cacheName() CHANGED (a regression that stops
//       shellHash from reflecting the file can't hide — the name
//       stays put and the test fails);
//     · runs the smoke against the STALE disk artifact and asserts it
//       FAILS (swCache.allOk === false — the guard works);
//     · regenerates sw.js + index.html and asserts the smoke PASSES;
//     · separately starts serve.mjs and asserts the SERVED /sw.js
//       cache name changes on the wire when the file changes (the
//       dev-server freshness path the smoke doesn't cover);
//     · finally restores app.js byte-for-byte and regenerates, then
//       asserts sw.js + index.html are byte-identical to the baseline.
//
//   Uses --smoke-no-focus: the artifact stages live in the shared
//   renderer probe, and skipping the real-keyboard stage removes the
//   OS-focus dependency that would make this flaky in VM/CI sessions.
//
//   Usage (from pdf-viewer/):  node scripts/test-artifact-regression.mjs
//   ═══════════════════════════════════════════════════════════════ */
"use strict";

import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { cacheName, assetStamps, writeArtifacts } from "./gen-sw.mjs";

const require = createRequire(import.meta.url);
const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const APP_DIR = join(SCRIPTS_DIR, "..");
const SW_PATH = join(APP_DIR, "sw.js");
const INDEX_PATH = join(APP_DIR, "index.html"); // baseline read for the final byte-identity check
const TARGET = join(APP_DIR, "js", "app.js");
const MARKER = "\n// volt:artifact-regression-marker (harmless trailing comment)\n";
const SERVE_PORT = 8573; // unusual port — the test's own serve.mjs instance

const ELECTRON = require("electron"); // the electron binary path (from the npm package)

let pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra !== undefined ? " — " + JSON.stringify(extra) : "")); }
}

/** The CACHE constant currently on disk (what the embedded server serves). */
const diskCache = () => {
  try { return (readFileSync(SW_PATH, "utf8").match(/const CACHE = "([^"]+)"/) || [])[1] || null; }
  catch { return null; }
};

/** Run the Electron smoke headless and parse SMOKE_RESULT. */
function runSmoke() {
  const r = spawnSync(ELECTRON, [".", "--smoke-no-focus"], {
    cwd: APP_DIR, encoding: "utf8", shell: false,
    timeout: 180000, maxBuffer: 16 * 1024 * 1024,
  });
  const out = (r.stdout || "") + (r.stderr || "");
  const m = out.match(/SMOKE_RESULT (\{.*\})/s);
  const result = m ? JSON.parse(m[1]) : null;
  return {
    status: r.status,
    hung: !!(r.error && r.error.code === "ETIMEDOUT"),
    ok: !!(result && result.ok === true),
    result,
    tail: out.slice(-500),
  };
}

/** Poll a URL until it answers 200 (or the timeout elapses). */
async function waitForHttp(url, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const res = await fetch(url); if (res.ok) return true; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

const swNameFrom = async (url) => {
  const text = await (await fetch(url)).text();
  const m = text.match(/const CACHE = "([^"]+)"/);
  if (!m) throw new Error("no CACHE constant in served sw.js");
  return m[1];
};

console.log("Volt — artifact-generator negative regression guard\n");

const original = readFileSync(TARGET);
const baseSwBytes = readFileSync(SW_PATH);
const baseIndexBytes = readFileSync(INDEX_PATH);
const baseCache = cacheName();
const baseAppStamp = assetStamps()["js/app.js"];

let server = null;
let serveStderr = "";
try {
  // ══ Phase 1 — the SERVED /sw.js must track the generator on the wire ══
  // serve.mjs renders sw.js (and index.html) fresh per request from the
  // current files, so editing an app file must change the served cache name
  // immediately — this is the dev-server freshness path the Electron smoke
  // never exercises (its embedded server serves the disk artifact).
  console.log("served /sw.js freshness (serve.mjs per-request rendering)");
  server = spawn(process.execPath, ["serve.mjs", String(SERVE_PORT)], {
    cwd: APP_DIR, stdio: ["ignore", "ignore", "pipe"],
  });
  server.stderr.on("data", (d) => { serveStderr += String(d); });
  const base = `http://127.0.0.1:${SERVE_PORT}`;
  const up = await waitForHttp(base + "/sw.js");
  // the spawned serve.mjs must still be alive — a bound check, so a port
  // collision (EADDRINUSE: it exits, something ELSE answers on 8573) fails
  // loudly instead of silently testing a foreign server
  const bound = up && server.exitCode === null;
  if (!bound) {
    t("serve.mjs bound port " + SERVE_PORT + " (not pre-occupied by another server)", false,
      { exited: server.exitCode, stderr: serveStderr.slice(-400) });
  } else {
    let name1, name2, name3;
    try {
      name1 = await swNameFrom(base + "/sw.js");
      t("served /sw.js matches the generator at baseline", name1 === baseCache, { name1, baseCache });
      writeFileSync(TARGET, Buffer.concat([original, Buffer.from(MARKER)])); // edit (no regeneration)
      name2 = await swNameFrom(base + "/sw.js");
      t("SERVED /sw.js cache name CHANGED after editing js/app.js", name2 !== name1, { name1, name2 });
      t("served name equals the recomputed generator value", name2 === cacheName(), { name2, recomputed: cacheName() });
      const html2 = await (await fetch(base + "/")).text();
      const stamp = assetStamps()["js/app.js"];
      t("served index.html carries the fresh app.js ?v= stamp", stamp && html2.includes("js/app.js?v=" + stamp), { stamp });
      writeFileSync(TARGET, original); // restore the edit
      name3 = await swNameFrom(base + "/sw.js");
      t("served /sw.js back to baseline after restore", name3 === name1, { name3, name1 });
    } catch (e) {
      t("served-fetch phase completed", false, { error: String((e && e.message) || e) });
    } finally {
      // the restore must happen even on a mid-phase failure
      writeFileSync(TARGET, original);
    }
  }
  try { server.kill(); } catch { /* already gone */ }
  server = null;

  // ══ Phase 2 — generator sensitivity + smoke negative/positive ══
  console.log("generator sensitivity + smoke stale-artifact guard");
  writeFileSync(TARGET, Buffer.concat([original, Buffer.from(MARKER)])); // edit, artifacts left stale
  const editedCache = cacheName();
  t("generator is content-sensitive: cacheName() changed after editing js/app.js",
    editedCache !== baseCache, { baseCache, editedCache });
  t("generator is content-sensitive: app.js ?v= stamp changed",
    assetStamps()["js/app.js"] !== baseAppStamp, { baseAppStamp, now: assetStamps()["js/app.js"] });

  // negative smoke: the disk sw.js is STALE (file edited, artifact never
  // regenerated) — the swCache stage must fail, and the overall smoke must
  // report ok:false because of it
  const neg = runSmoke();
  t("smoke FAILS with a stale sw.js (edit not regenerated)",
    neg.ok === false, { status: neg.status, hung: neg.hung, tail: neg.ok === false ? undefined : neg.tail });
  t("swCache stage is the failing gate (allOk === false)",
    !!neg.result && neg.result.serviceWorkerCache && neg.result.serviceWorkerCache.allOk === false,
    { swCacheAllOk: neg.result && neg.result.serviceWorkerCache && neg.result.serviceWorkerCache.allOk });
  t("indexHtmlCache stage also fails on the stale stamp",
    !!neg.result && neg.result.indexHtmlCache && neg.result.indexHtmlCache.allOk === false,
    { htmlAllOk: neg.result && neg.result.indexHtmlCache && neg.result.indexHtmlCache.allOk });

  // regenerate the artifacts — the cache name must now CHANGE from baseline.
  // (Compared against baseCache only: the pre-regeneration editedCache is
  // computed with the still-unstamped index.html, so it differs from the
  // final value by design — the stamp feed-back into the shell hash.)
  writeArtifacts();
  const regenCache = cacheName();
  t("cache name CHANGED after edit + regenerate", regenCache !== baseCache, { baseCache, regenCache });
  t("disk sw.js carries the new cache name", diskCache() === regenCache, { disk: diskCache(), expected: regenCache });

  // positive smoke: freshly regenerated artifacts must pass
  const pos = runSmoke();
  t("smoke PASSES with freshly regenerated artifacts",
    pos.ok === true, { status: pos.status, swAllOk: pos.result && pos.result.serviceWorkerCache && pos.result.serviceWorkerCache.allOk, tail: pos.ok === true ? undefined : pos.tail });
} finally {
  // restore the app file byte-for-byte, regenerate the artifacts, and prove
  // the tree is exactly where it started
  if (server) { try { server.kill(); } catch { /* already gone */ } }
  writeFileSync(TARGET, original);
  writeArtifacts();
  t("FINAL: app.js restored byte-for-byte", readFileSync(TARGET).equals(original));
  t("FINAL: sw.js byte-identical to baseline", readFileSync(SW_PATH).equals(baseSwBytes));
  t("FINAL: index.html byte-identical to baseline", readFileSync(INDEX_PATH).equals(baseIndexBytes));
  t("FINAL: cache name back to baseline", cacheName() === baseCache && diskCache() === baseCache,
    { now: cacheName(), baseline: baseCache });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
