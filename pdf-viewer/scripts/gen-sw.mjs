// ═══════════════════════════════════════════════════════════════
//   Volt — service-worker + asset-stamp generator
//   The PWA cache name derives from a SHA-256 of the app shell's
//   ACTUAL file contents, so any edit — app.js, style.css,
//   index.html, a vendored-library swap — produces a NEW cache name.
//   The worker then reinstalls, precaches the fresh files under the
//   new name, and purges every older cache on activate. Dev/preview
//   edits can never silently serve stale cached files again.
//
//   index.html is stamped the same way: every <script src> / stylesheet
//   <link href> / the pdf.js module-import specifier gets a ?v=<hash>
//   query of its CURRENT bytes, so the browser's plain HTTP cache drops
//   stale JS/CSS too — no service worker required. (Per-asset hashes:
//   editing css invalidates only css, never the multi-MB vendored pdf.js.)
//
//   Usage (from pdf-viewer/):
//     node scripts/gen-sw.mjs            print the current cache name
//     node scripts/gen-sw.mjs --write    (re)write sw.js + stamped index.html
//     node scripts/gen-sw.mjs --check    verify the checked-in artifacts match
//                                        the current files (drift guard; exit 1
//                                        on stale sw.js / index.html — the
//                                        release workflow runs this on every
//                                        tag, so a tag can never ship a worker
//                                        that precaches old files)
//   ═══════════════════════════════════════════════════════════════ */
"use strict";

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const APP_DIR = join(SCRIPTS_DIR, "..");
const SW_PATH = join(APP_DIR, "sw.js");
const INDEX_PATH = join(APP_DIR, "index.html");
const VERSION_PATH = join(APP_DIR, "VERSION");

/** The human-visible release version from the VERSION file (e.g. "1.0.0").
    The version banner shows the changelog diff between this and the pending
    version, so it must be a plain semantic version. Missing/invalid files
    fall back to "0.0.0" — the generator must never crash the dev server. */
export function appVersion() {
  try {
    const v = readFileSync(VERSION_PATH, "utf8").trim();
    return /^\d+\.\d+\.\d+$/.test(v) ? v : "0.0.0";
  } catch (e) { return "0.0.0"; }
}

/** Everything the worker precaches — also exactly what the cache name hashes.
    (Baked into the generated sw.js via JSON.stringify below.) */
const ASSETS = [
  "./",
  "./index.html",
  "./css/style.css",
  "./js/utils.js",
  "./js/annotations.js",
  "./js/ai.js",
  "./js/app.js",
  "./js/ocr.js",
  "./js/sample-data.js",
  "./js/voice.js",
  "./js/office-export.js",
  "./vendor/pdf.min.mjs",
  "./vendor/pdf.worker.min.mjs",
  "./vendor/pdf-lib.min.js",
  "./vendor/tesseract/tesseract.min.js",
  "./vendor/tesseract/worker.min.js",
  "./vendor/tesseract/core/tesseract-core.wasm.js",
  "./vendor/tesseract/core/tesseract-core.wasm",
  "./vendor/tesseract/core/tesseract-core-simd.wasm.js",
  "./vendor/tesseract/core/tesseract-core-simd.wasm",
  "./vendor/tesseract/core/tesseract-core-lstm.wasm.js",
  "./vendor/tesseract/core/tesseract-core-lstm.wasm",
  "./vendor/tesseract/core/tesseract-core-simd-lstm.wasm.js",
  "./vendor/tesseract/core/tesseract-core-simd-lstm.wasm",
  "./vendor/tesseract/tessdata/eng.traineddata.gz",
  "./manifest.json",
  "./assets/icon-192.png",
  "./assets/icon-512.png",
  "./CHANGELOG.md",
];

/** SHA-256 of the shell's bytes → first 12 hex chars. A missing file hashes
    a marker instead of throwing, so a mid-save edit can't crash the dev
    server (the served sw.js still reflects a consistent snapshot). */
export function shellHash() {
  const h = createHash("sha256");
  for (const name of ASSETS) {
    h.update(name);
    h.update("\u0000");
    let bytes;
    try {
      bytes = readFileSync(join(APP_DIR, name));
    } catch {
      bytes = Buffer.from("missing:" + name);
    }
    h.update(bytes);
    h.update("\u0000");
  }
  // the release version participates in the hash too: bumping VERSION without
  // touching app files still invalidates installed caches (a version bump is a
  // release), so the banner can surface the new changelog.
  h.update("VERSION\u0000");
  h.update(readFileSync(VERSION_PATH, "utf8"));
  h.update("\u0000");
  return h.digest("hex").slice(0, 12);
}

export function cacheName() {
  return "volt-" + shellHash();
}

/* ── index.html asset stamps (?v= HTTP-cache busting) ───────────
   Every external script, stylesheet, and the pdf.js module-import
   specifier in index.html carries ?v=<sha256:8> of its own file's
   current bytes. When any asset changes, its stamp changes, so the
   browser refetches that URL — even with no service worker and no
   cache headers. Editing css invalidates only css (per-asset hashes),
   never the ~1MB vendored pdf.js. */

/** SHA-256 of one app file → first 8 hex chars (the ?v= stamp). A missing
    file hashes a marker instead of throwing, matching shellHash. */
export function fileStamp(name) {
  let bytes;
  try {
    bytes = readFileSync(join(APP_DIR, name));
  } catch {
    bytes = Buffer.from("missing:" + name);
  }
  return createHash("sha256").update(bytes).digest("hex").slice(0, 8);
}

/** The asset paths index.html loads via <script src>, stylesheet <link href>
    and the pdf.js module-import specifier — exactly what gets a ?v= stamp.
    Keys are the literal strings in the html ("./vendor/pdf.min.mjs" etc.).
    Already-stamped sources yield the same paths (queries are stripped). */
export function referencedAssetPaths(source) {
  const paths = new Set();
  const TAG = /<(script|link)\b[^>]*>/g;
  let m;
  while ((m = TAG.exec(source))) {
    const tag = m[0];
    if (m[1] === "script") {
      const s = /\bsrc="([^"?]+)/.exec(tag);
      if (s) paths.add(s[1]);
    } else if (/\brel="stylesheet"/.test(tag)) {
      const h = /\bhref="([^"?]+)/.exec(tag);
      if (h) paths.add(h[1]);
    }
  }
  const imp = /from\s+["']([^"']+)["']/g;
  while ((m = imp.exec(source))) paths.add(m[1].split("?")[0]); // query-stripped, so an already-stamped import still resolves
  return [...paths];
}

/** path → stamp for every asset index.html references, from the files on disk. */
export function assetStamps() {
  const out = {};
  for (const p of referencedAssetPaths(readFileSync(INDEX_PATH, "utf8"))) out[p] = fileStamp(p);
  return out;
}

/** Stamp (or re-stamp) every script/style reference in an html source with
    ?v=<hash>. Idempotent: an existing ?v= query is replaced, never stacked;
    unknown paths (not in the current file set) are left untouched so a tag is
    never broken by a half-written state. */
export function stampHtml(source) {
  const stamps = assetStamps();
  const stampUrl = (path) => {
    // strip any existing ?v= BEFORE the lookup — the map is keyed by clean
    // paths, so a stale stamp is replaced rather than silently kept
    const clean = path.split("?")[0];
    const v = stamps[clean];
    if (!v) return path;
    return clean + "?v=" + v;
  };
  return source
    .replace(/<(script|link)\b[^>]*>/g, (tag, kind) => {
      if (kind === "script") return tag.replace(/\bsrc="([^"]+)"/g, (_m, path) => 'src="' + stampUrl(path) + '"');
      if (/\brel="stylesheet"/.test(tag)) return tag.replace(/\bhref="([^"]+)"/g, (_m, path) => 'href="' + stampUrl(path) + '"');
      return tag;
    })
    // import specifiers match like the tag rules: the full URL (query included)
    // is captured and stampUrl strips/replaces it — a stamped import must be
    // re-stampable, or a vendor swap would leave the pdf.js URL cached forever
    .replace(/(from\s+["'])([^"']+)(["'])/g, (_m, pre, path, post) => pre + stampUrl(path) + post);
}

export function renderIndexHtml() {
  // stamp the release version into the shell's __VOLT_VERSION__ placeholder
  // (index.html carries it in an inline script) — the running page then knows
  // its own version without fetching anything, so the banner can diff the
  // served sw.js VERSION against it. Idempotent: the on-disk stamped copy has
  // no placeholder left, so a re-render is a no-op.
  return stampHtml(readFileSync(INDEX_PATH, "utf8")).replace(/__VOLT_VERSION__/g, appVersion());
}

/** Regenerate BOTH derived artifacts in the ONE order that is consistent:
    index.html first (its ?v= stamps feed the shell hash), then sw.js (whose
    cache name hashes the freshly-stamped index.html). Writing sw.js first
    would bake the PRE-stamp index bytes into the cache name — a single
    regeneration after an asset edit would leave the artifacts inconsistent
    (the regression guard caught exactly this). Deterministic + idempotent. */
export function writeArtifacts() {
  writeFileSync(INDEX_PATH, renderIndexHtml());
  writeFileSync(SW_PATH, renderSw());
  return cacheName();
}

/** The full sw.js source with the derived cache name and version baked in. */
export function renderSw() {
  const CACHE = cacheName();
  const VERSION = appVersion();
  return `// ═══════════════════════════════════════════════════════════════
//   Volt — service worker  (GENERATED by scripts/gen-sw.mjs — do not edit)
//   Cache-first for the app shell + vendored libraries, so Volt is
//   fully usable offline after the first visit and launches as an
//   installable PWA (own window, own icon, no browser tab).
//
//   The cache name is a SHA-256 of the app shell's file contents:
//   any edit to app.js / css / html / vendor files changes it, which
//   makes the browser reinstall the worker and re-precache everything
//   fresh under the new name (older caches are purged on activate).
//
//   VERSION is the human-visible release (from the VERSION file); the
//   version banner compares it against the installed bundle's version
//   and shows the CHANGELOG diff in a tooltip.
//   ═══════════════════════════════════════════════════════════════ */
"use strict";

const CACHE = "${CACHE}";
const VERSION = "${VERSION}";
const ASSETS = ${JSON.stringify(ASSETS, null, 2)};

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// cache-first with network fallback; the app is fully static
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  e.respondWith(
    caches.match(e.request).then((hit) => {
      if (hit) return hit;
      return fetch(e.request).then((res) => {
        if (res.ok && (res.type === "basic" || res.type === "default")) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      });
    })
  );
});
`;
}

// CLI only — importing this module (serve.mjs, update-vendor.mjs) must not print
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const args = new Set(process.argv.slice(2));
  if (args.has("--write")) {
    const cache = writeArtifacts();
    console.log("sw.js + index.html written — cache " + cache);
  } else if (args.has("--check")) {
    // Drift guard: the checked-in sw.js + index.html must match what the
    // generator derives from the CURRENT tree. A stale artifact — an asset
    // edited but never regenerated — would ship a worker that precaches old
    // files under an old name and index.html stamps that don't bust the HTTP
    // cache. Byte-exact like the regression guard's own identity assertions:
    // the artifacts are generated, never hand-edited, so any difference means
    // the tree changed without a regeneration. Exit 1 with a clear diff.
    const wantSw = renderSw();
    const wantHtml = renderIndexHtml();
    const diskSw = readFileSync(SW_PATH, "utf8");
    const diskHtml = readFileSync(INDEX_PATH, "utf8");
    const diskCache = (diskSw.match(/const CACHE = "([^"]+)"/) || [])[1] || null;
    const stale = [];
    if (diskSw !== wantSw) stale.push("sw.js (disk CACHE " + diskCache + " ≠ generated " + cacheName() + ")");
    if (diskHtml !== wantHtml) stale.push("index.html (?v= stamps / version differ from the current files)");
    if (stale.length) {
      console.error("❌ stale generated artifact(s) — sw.js / index.html don't match the current files:");
      for (const s of stale) console.error("   - " + s);
      console.error("   Fix: run `node scripts/gen-sw.mjs --write` and commit sw.js + index.html together with the asset change.");
      process.exit(1);
    }
    console.log("✓ sw.js + index.html match the current files (cache " + cacheName() + ")");
  } else {
    console.log(cacheName());
  }
}
