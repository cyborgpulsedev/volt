// ═══════════════════════════════════════════════════════════════
//   Volt — Electron main process
//   Serves the static app through a tiny embedded HTTP server on an
//   ephemeral port, so pdf.js workers, fetch() (open-from-URL) and
//   the local Ollama API calls behave exactly like in the browser —
//   no file:// quirks, no CORS surprises.
//
//   Run:  npx electron .          (normal app)
//         npx electron . --smoke  (headless self-test: loads the app,
//                                  opens the sample PDF, prints
//                                  SMOKE_RESULT {...} and exits)
//         npx electron . --smoke-browser  (same, but the window loads WITHOUT
//                                  the preload bridge — the pure browser/PWA
//                                  context — and runs the real-keyboard stage,
//                                  so the focus trap is verified there too;
//                                  the real-keyboard stage also drives the
//                                  toolbar menus with native Alt+V / arrows /
//                                  Enter — Enter needs the rawKeyDown+char
//                                  pair, see keyEnter() in realKeyStage)
//         npx electron . --smoke-no-focus --vendor-stage <dir>
//                                  (run the full probe — incl. the hiddenProbe/
//                                  visibleProbe DOM contracts — against vendor
//                                  files served from <dir> instead of vendor/,
//                                  without touching anything on disk. The
//                                  vendored-library updater uses this to gate a
//                                  staged pdf.js/pdf-lib BEFORE the swap)
//         Volt.exe --smoke-feed      (PACKAGED builds only: end-to-end release-
//                                  feed round-trip — the real electron-updater
//                                  chain against VOLT_UPDATE_URL, asserting the
//                                  version banner. Driven by the CI gate
//                                  scripts/test-release-feed.mjs)
//   ═══════════════════════════════════════════════════════════════ */
"use strict";

const argValue = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
};

const { app, BrowserWindow, shell, ipcMain, utilityProcess, screen, session, Menu, dialog } = require("electron");
const { autoUpdater } = require("electron-updater");
const { createServer, request: httpRequest } = require("node:http");
const net = require("node:net");
const { get: httpsGet } = require("node:https");
const { spawn } = require("node:child_process");
const { readFile, writeFile } = require("node:fs/promises");
const { statSync, readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync, createWriteStream } = require("node:fs");
const { tmpdir } = require("node:os");
const { basename, extname, join, normalize } = require("node:path");

const APP_ROOT = __dirname;
const FileWatcher = require(join(APP_ROOT, "scripts", "file-watcher.cjs"));
const { recoverInterruptedVendorUpdate } = require(join(APP_ROOT, "scripts", "vendor-recovery.cjs"));
// --smoke:        full self-test (incl. the real-keyboard focus stage)
// --smoke-browser: same as --smoke but the window loads WITHOUT the preload
//                 bridge — exactly the context a browser/PWA tab gets — so the
//                 focus trap and the whole render chain are verified there too
// --smoke-no-focus: same render + modal probe, but the window is never shown
//                 or focused — used as the background auto-update smoke gate
const SMOKE_BROWSER = process.argv.includes("--smoke-browser");
// --smoke-feed: end-to-end release-feed round-trip (packaged builds only).
// With VOLT_UPDATE_URL pointing at a scratch feed (latest.yml + installer)
// the REAL electron-updater chain runs — startup check → background download
// → volt:update-downloaded → version banner — and runSmokeFeedTest reports
// the SMOKE_RESULT. This is the CI release-feed gate's in-app half; the
// harness (scripts/test-release-feed.mjs) builds the app, publishes the feed,
// launches it with --smoke-feed, and asserts the result.
const SMOKE_FEED = process.argv.includes("--smoke-feed");
const SMOKE = process.argv.includes("--smoke") || process.argv.includes("--smoke-no-focus") || SMOKE_BROWSER || SMOKE_FEED;
const SMOKE_FOCUS_STAGE = (process.argv.includes("--smoke") || SMOKE_BROWSER) && !process.argv.includes("--smoke-no-focus");
// --vendor-stage <dir>: serve /vendor/* from <dir> instead of vendor/ (falling
// back to the real vendor for anything missing). The updater gates a staged
// pdf.js/pdf-lib bump through the full smoke probe BEFORE swapping it in — the
// probe (render, hiddenProbe, visibleProbe, …) then runs against the staged
// files with zero churn on disk.
const VENDOR_STAGE = argValue("--vendor-stage") ? normalize(argValue("--vendor-stage")) : null;

// --expect-hidden=<n> (or --expect-hidden <n>, or VOLT_EXPECT_HIDDEN=n): pin
// how many elements carry [hidden] at boot. The hiddenProbe only requires the
// set to be non-empty, so a deliberate shell change that adds or removes a
// hidden element would silently change the checked set — with a pin, the smoke
// fails until the operator consciously bumps the expected count. Null = not
// pinned (the current lenient behavior).
const _expectHiddenRaw =
  (process.argv.includes("--expect-hidden") ? argValue("--expect-hidden") : null)
  || (process.argv.find((a) => a.startsWith("--expect-hidden=")) || "").slice("--expect-hidden=".length)
  || (process.env.VOLT_EXPECT_HIDDEN || "").trim()
  || null;
// 0 is rejected (unpinned): the probe already hard-requires the hidden set to
// be non-empty, so a pin of 0 is contradictory with the app's own contract and
// would only ever fail confusingly — the existing check covers that case.
const EXPECT_HIDDEN = _expectHiddenRaw !== null && /^[1-9]\d*$/.test(_expectHiddenRaw)
  ? parseInt(_expectHiddenRaw, 10) : null;

// Smoke runs boot into a throwaway profile. The real profile keeps a
// registered service worker (cache-first) whose scope can survive an OS
// ephemeral-port reuse, and a stale SW/HTTP cache from a previous run could
// serve OLD vendor files — silently masking a broken staged pdf.js/pdf-lib
// in the --vendor-stage gate (or any render regression). A fresh mkdtemp
// profile makes every smoke run deterministic and cleans up after itself.
let smokeProfileDir = null;
if (SMOKE) {
  smokeProfileDir = mkdtempSync(join(tmpdir(), "volt-smoke-"));
  app.setPath("userData", smokeProfileDir);
  // electron-updater ignores userData — its cache dir is LOCALAPPDATA-based
  // (getAppCacheDir), resolved lazily at download time. In the feed gate the
  // downloaded installer would otherwise land in the REAL AppData\Local and
  // pollute the machine; pointing LOCALAPPDATA at the throwaway profile keeps
  // the whole update (download + pending install) inside it, cleaned up with
  // the profile on exit.
  if (SMOKE_FEED) process.env.LOCALAPPDATA = smokeProfileDir;
}
const cleanupSmokeProfile = () => {
  if (smokeProfileDir) { try { rmSync(smokeProfileDir, { recursive: true, force: true }); } catch (e) { /* best effort */ } }
  smokeProfileDir = null;
};
// Electron's app.exit() does not emit before-quit/will-quit, and Node's exit
// event is not guaranteed on Electron's exit path — so the smoke's own exit
// points (report, watchdog) call cleanupSmokeProfile() explicitly, with the
// process-exit handler as belt-and-braces for any other exit path.
process.on("exit", cleanupSmokeProfile);

let vendorUpdater = null; // running background vendor-check child (utilityProcess)
let fileWatcher = null;   // active file watcher — one at a time, the open document

// Persisted window bounds (size + position + maximized) — restored on launch
// so the app reopens where the user left it instead of resetting to 1280x900.
// The pure validation lives in scripts/window-state.cjs (unit-tested); the
// file lives in the userData dir, which the smoke block above re-points at a
// throwaway profile, so self-test runs never touch the real window state.
const { loadState, saveState } = require(join(APP_ROOT, "scripts", "window-state.cjs"));
const WINDOW_STATE_FILE = join(app.getPath("userData"), "window-state.json");

// First-run local-LLM bootstrap: download the official per-user Ollama
// installer into the app's userData dir, reporting progress for the renderer's
// progress bar. (The install itself is the user's explicit one-click choice,
// so this is the only place Volt ever fetches a binary.)
const OLLAMA_SETUP_URL = "https://ollama.com/download/OllamaSetup.exe";
function downloadFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const out = createWriteStream(dest);
    const req = httpsGet(url, (res) => {
      if (res.statusCode >= 400) {
        reject(new Error("HTTP " + res.statusCode));
        out.destroy();
        return;
      }
      const total = parseInt(res.headers["content-length"] || "0", 10);
      let got = 0;
      res.on("data", (c) => {
        got += c.length;
        if (onProgress && total) onProgress(Math.round((got / total) * 100));
      });
      res.pipe(out);
    });
    req.on("error", (e) => { out.destroy(); reject(e); });
    out.on("finish", () => { if (onProgress) onProgress(100); resolve(dest); });
    out.on("error", (e) => { req.destroy(); reject(e); });
  });
}

// OLLAMA_ORIGINS pin: write a per-user env var (HKCU\Environment via setx —
// no admin needed, broadcast so new processes inherit it). Ollama reads it
// at process start, so the restriction applies on the next Ollama start;
// the CORS warning in the renderer tells the user to restart it. setx is
// on PATH on every Windows box; on non-Windows this is a no-op failure the
// callers treat as non-fatal (the desktop app targets Windows).
function setUserEnv(name, value) {
  return new Promise((resolve, reject) => {
    const child = spawn("setx.exe", [name, value], { windowsHide: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("close", (code) => (code === 0 ? resolve() : reject(new Error("setx exited " + code))));
  });
}

// Private Ollama instance — a dedicated `ollama serve` the app spawns on its
// own loopback port, with OLLAMA_ORIGINS pinned to Volt's origins and a
// dedicated model store (a second server on the user's shared store could
// contend on its lock files). Nothing else on the machine can reach it. Only
// ever triggered by the renderer's explicit toggle — never at boot on its own.
let privateOllamaChild = null;
let privateOllamaPort = 0;

// ── OLLAMA_ORIGINS CORS probe — runs in the MAIN process because the browser
// CORS model hides Access-Control-Allow-Origin from page JS (res.headers.get()
// returns null even when the header is on the wire), so the renderer can never
// see whether the running Ollama answers "*" (OLLAMA_ORIGINS=* — any website
// can drive the local model) or a specific origin. This sends the same request
// with a spoofed evil Origin and reads the RAW header: Ollama rejects foreign
// origins with 403 (safe — it actively blocks), echoes a specific origin when
// pinned, and answers "*" only for OLLAMA_ORIGINS=*. Returns
// { ok:true, status, acao } or { ok:false, error } when unreachable.
function probeOllamaCors() {
  return new Promise((resolve) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: 11434,
        path: "/api/tags",
        method: "GET",
        headers: { Origin: "http://evil.invalid", Accept: "application/json" },
        timeout: 2000,
      },
      (res) => {
        res.resume(); // drain + discard — only the status and ACAO matter
        const acao = (res.headers && res.headers["access-control-allow-origin"]) || null;
        resolve({ ok: true, status: res.statusCode || 0, acao });
      }
    );
    req.on("timeout", () => { req.destroy(); resolve({ ok: false, error: "timeout" }); });
    req.on("error", () => resolve({ ok: false, error: "unreachable" }));
    req.end(); // http.request needs an explicit end — without it nothing is sent
  });
}

/** A free loopback port (ask the OS for an ephemeral one). */
function pickFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

/** True when something already listens on the port (so a saved private port
    can be reused across restarts only while it stays free). */
function isPortBusy(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: "127.0.0.1", port }, () => { sock.destroy(); resolve(true); });
    sock.on("error", () => resolve(false));
  });
}

/** Poll GET /api/tags on the port until it answers 200 or the deadline hits. */
function waitForOllama(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const attempt = () => {
      const req = httpRequest(
        { host: "127.0.0.1", port, path: "/api/tags", method: "GET", timeout: 1500 },
        (res) => {
          res.resume();
          if (res.statusCode === 200) done(true);
          else if (Date.now() > deadline) done(false);
          else setTimeout(attempt, 500);
        }
      );
      const retry = () => { if (Date.now() > deadline) done(false); else setTimeout(attempt, 500); };
      req.on("timeout", () => { req.destroy(); retry(); });
      req.on("error", () => retry());
      req.end();
    };
    attempt();
  });
}

/** Spawn (or return the running) private Ollama. Idempotent: a live instance
    answers immediately with its port. Tries the saved port first so the
    renderer's baseUrl survives restarts, falls back to a fresh free port.
    Never called by the smoke — the renderer stubs the bridge. */
async function spawnPrivateOllama(origins, preferredPort) {
  if (privateOllamaChild && privateOllamaChild.exitCode == null && !privateOllamaChild.killed) {
    return { ok: true, port: privateOllamaPort, pid: privateOllamaChild.pid };
  }
  let port = null;
  if (typeof preferredPort === "number" && preferredPort > 0 && !(await isPortBusy(preferredPort))) {
    port = preferredPort;
  }
  if (!port) port = await pickFreePort();
  const modelsDir = join(app.getPath("userData"), "ollama-private", "models");
  let child;
  try {
    child = spawn("ollama", ["serve"], {
      env: {
        ...process.env,
        OLLAMA_HOST: "127.0.0.1:" + port,
        // file:// must never appear here — Ollama's env parser panics on it
        OLLAMA_ORIGINS: origins || "http://localhost:8421",
        OLLAMA_MODELS: modelsDir,
      },
      windowsHide: true,
      stdio: "ignore",
    });
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
  privateOllamaChild = child;
  privateOllamaPort = port;
  const onExit = () => { if (privateOllamaChild === child) { privateOllamaChild = null; privateOllamaPort = 0; } };
  child.once("exit", onExit);
  child.once("error", onExit);
  const started = await new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    child.once("error", (e) => done({ error: "ollama binary not found — " + ((e && e.code) || (e && e.message) || e) }));
    waitForOllama(port, 30000).then((ok) => done(ok ? true : { error: "no response on 127.0.0.1:" + port }));
  });
  if (started !== true) {
    try { child.kill(); } catch (e) { /* already gone */ }
    if (privateOllamaChild === child) { privateOllamaChild = null; privateOllamaPort = 0; }
    return { ok: false, error: started && started.error ? started.error : "Ollama did not start" };
  }
  return { ok: true, port, pid: child.pid };
}

function stopPrivateOllama() {
  if (privateOllamaChild) {
    try { privateOllamaChild.kill(); } catch (e) { /* already gone */ }
    privateOllamaChild = null;
    privateOllamaPort = 0;
  }
  return { ok: true };
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".pdf": "application/pdf",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

/** Start the static server on an ephemeral loopback port. */
function startServer() {
  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      try {
        let path = decodeURIComponent(new URL(req.url, "http://x").pathname);
        if (path === "/") path = "/index.html";
        const file = normalize(join(APP_ROOT, path));
        if (!file.startsWith(APP_ROOT + "\\") && !file.startsWith(APP_ROOT + "/")) throw Object.assign(new Error("forbidden"), { code: 403 });
        // --vendor-stage: /vendor/* resolves inside the staged dir first (with
        // the same traversal guard); a missing staged file falls back to the
        // real vendor so only the swapped libraries come from staging
        let stagedFile = null;
        if (VENDOR_STAGE && path.startsWith("/vendor/")) {
          stagedFile = normalize(join(VENDOR_STAGE, path.slice("/vendor/".length)));
          if (stagedFile !== VENDOR_STAGE && !stagedFile.startsWith(VENDOR_STAGE + "\\") && !stagedFile.startsWith(VENDOR_STAGE + "/")) {
            throw Object.assign(new Error("forbidden"), { code: 403 });
          }
        }
        let data = null;
        try {
          data = await readFile(stagedFile || file);
        } catch (e) {
          if (e && e.code === "ENOENT" && stagedFile) data = await readFile(file);
          else throw e;
        }
        const headers = { "Content-Type": MIME[extname(file)] || "application/octet-stream" };
        // the app shell must revalidate on every launch so the ?v= stamps on its
        // script/style tags are the live ones — no heuristic HTML caching
        if (extname(file) === ".html") headers["Cache-Control"] = "no-cache, no-store";
        res.writeHead(200, headers);
        res.end(data);
      } catch (e) {
        res.writeHead(e.code === 403 ? 403 : 404);
        res.end(e.code === 403 ? "forbidden" : "not found");
      }
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

let win = null;

// Voice input needs the microphone: the renderer requests getUserMedia, and
// Chromium asks the host for permission. The app is fully local (its own
// embedded server + file:// assets), so every 'media' request is ours — grant
// it without a prompt. speechSynthesis (read-aloud) needs no permission.
function allowMicPermission() {
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === "media" || permission === "audioCapture" || permission === "microphone");
  });
}

async function createWindow(port) {
  // restore the last-used size/position (validated against the CURRENT display
  // layout so a saved position on a now-unplugged monitor can't strand the
  // window off-screen); null → the default 1280x900, centered by Electron
  const savedState = SMOKE ? null : loadState(WINDOW_STATE_FILE, screen.getAllDisplays());
  win = new BrowserWindow({
    ...(savedState
      ? { x: savedState.x, y: savedState.y, width: savedState.width, height: savedState.height }
      : { width: 1280, height: 900 }),
    minWidth: 900,
    minHeight: 600,
    icon: join(APP_ROOT, "assets", "volt.ico"),
    autoHideMenuBar: true,
    backgroundColor: "#0c0e13",
    title: "Volt — local PDF reader & AI editor",
    show: !SMOKE, // the self-test is headless — don't flash a window on the desktop
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // --smoke-browser loads the app exactly as a browser tab would: NO
      // preload bridge, so window.voltDesktop is absent — the PWA context
      // (serve.mjs + a browser). The renderer must fully work without it.
      ...(SMOKE_BROWSER ? {} : { preload: join(APP_ROOT, "preload.js") }),
    },
  });

  // Persist the window state as the user moves/resizes it (debounced — the
  // events fire continuously during a drag) and a final write on close, so
  // the next launch reopens at the same size/position. Skipped in SMOKE:
  // the throwaway profile makes it pointless, and the smoke's own window
  // resizes (toolbarResizeStage) must never touch real state.
  if (!SMOKE) {
    let stateTimer = null;
    const scheduleSave = () => {
      clearTimeout(stateTimer);
      stateTimer = setTimeout(() => saveState(WINDOW_STATE_FILE, win), 500);
    };
    win.on("resize", scheduleSave);
    win.on("move", scheduleSave);
    win.on("close", () => {
      clearTimeout(stateTimer);
      saveState(WINDOW_STATE_FILE, win); // getNormalBounds() is valid here
    });
  }

  // A maximized window restores maximized: recreate at the saved NORMAL bounds,
  // then maximize when the window is about to show (no flash of the restored
  // size first). Never in SMOKE — savedState is null there by construction.
  if (savedState && savedState.maximized) {
    win.once("ready-to-show", () => {
      if (!win.isDestroyed() && !win.isMaximized()) win.maximize();
    });
  }

  // External links open in the system browser, never in-app
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });

  // Never navigate away from the app (e.g. a stray drop of a non-PDF file)
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith("http://127.0.0.1:")) e.preventDefault();
  });

  // With the native menu bar removed (see app.whenReady), keep the two dev
  // conveniences the default menu used to provide — Ctrl+Shift+I opens
  // DevTools and Ctrl+R reloads — on Windows/Linux where the bar is gone.
  if (process.platform !== "darwin") {
    win.webContents.on("before-input-event", (event, input) => {
      if (input.type !== "keyDown" || !input.control || input.shift || input.alt || input.meta) return;
      if (input.key.toLowerCase() === "i") { win.webContents.toggleDevTools(); event.preventDefault(); }
      else if (input.key.toLowerCase() === "r") { win.webContents.reload(); event.preventDefault(); }
    });
  }

  if (SMOKE_FEED) runSmokeFeedTest(win); // real feed round-trip (packaged only)
  else if (SMOKE) runSmokeTest(win); // attach listener before the page loads
  launchedBundleHash = readBundleHashSync(); // the version THIS window will run
  // ?smoke=1 tells the renderer to skip first-run onboarding (the setup
  // banner / wizard) so the self-test is deterministic — same signal for
  // the desktop and browser smokes, both of which load this URL.
  await win.loadURL(`http://127.0.0.1:${port}/index.html${SMOKE ? "?smoke=1" : ""}`);
}

/* ── background vendor self-update ───────────────────────────────
   A few seconds after startup, fork scripts/auto-update.cjs (a plain Node
   utilityProcess): it checks the CDN at most once a day and, if a newer
   pdf.js exists AND passes the smoke gate, applies it — toasting the user
   only on success. Every failure path stays silent and rolls back. */
function scheduleVendorAutoUpdate(w) {
  if (SMOKE || process.env.VOLT_NO_AUTO_UPDATE || process.argv.includes("--no-auto-update")) return; // deterministic self-tests
  setTimeout(() => {
    try {
      const child = utilityProcess.fork(join(APP_ROOT, "scripts", "auto-update.cjs"),
        [app.getPath("userData"), String(app.isPackaged)],
        { stdio: "inherit" });
      vendorUpdater = child;
      child.on("message", (msg) => {
        if (msg && msg.status === "updated" && !w.isDestroyed()) {
          w.webContents.send("volt:vendor-updated", { pdfjs: msg.pdfjs });
        }
        try { child.kill(); } catch (e) { /* already gone */ }
      });
      child.on("exit", () => { if (vendorUpdater === child) vendorUpdater = null; });
      // belt & braces: a hung child (stalled CDN, stuck smoke) must never leak
      setTimeout(() => { try { child.kill(); } catch (e) { /* gone */ } }, 10 * 60 * 1000).unref();
      console.log("vendor auto-update check started");
    } catch (e) { console.error("vendor auto-update check failed to start: " + ((e && e.message) || e)); }
  }, 5000).unref();
}

/* ── app auto-update (electron-updater) ────────────────────────────
   The DESKTOP app updates itself: on startup (packaged builds only) it
   asks the release feed (publish config in package.json — GitHub Releases
   by default, or any static host via the generic provider) whether a
   newer version exists, downloads it in the background, and surfaces the
   existing version banner so the user restarts when ready (the banner's
   auto-restart countdown and Cancel/never-auto-restart settings all apply
   — and quitting the app installs the pending update automatically).
   The renderer is told via volt:update-downloaded and the banner's
   Restart button routes through volt:restart → quitAndInstall().

   Never runs in smoke/dev: a smoke run must be deterministic and an
   unpackaged dev build has no app-update.yml (electron-updater would
   throw). VOLT_UPDATE_URL overrides the feed (generic provider) — useful
   for testing the flow against a local server, and as an escape hatch
   for enterprise/static-host distribution. VOLT_NO_APP_UPDATE=1 kills
   the whole feature. Every failure path is silent (console only) — an
   unreachable feed must never bother the user. */
let updaterEnabled = false;
let pendingUpdateVersion = null; // set once an update has finished downloading
// update preferences from the renderer (volt:update-prefs). checkOnStartup
// gates the background startup check; allowDownload gates autoUpdater.autoDownload
// (the renderer computes it from the 'download on metered connections' setting
// against its NetworkInformation read — main can't see navigator.connection).
// Defaults match the app's pre-change behavior: check on startup, download freely.
let updatePrefs = { checkOnStartup: true, allowDownload: true };

function initAppAutoUpdater() {
  // SMOKE_FEED is the one smoke mode that MUST reach the real updater — the
  // whole point of the release-feed gate is the genuine detect → download →
  // banner chain. Every other smoke stays deterministic and never touches it.
  if (!app.isPackaged || (SMOKE && !SMOKE_FEED) || process.env.VOLT_NO_APP_UPDATE) return;
  try {
    const feedUrl = process.env.VOLT_UPDATE_URL;
    if (feedUrl && /^https?:\/\//i.test(feedUrl)) {
      autoUpdater.setFeedURL({ provider: "generic", url: feedUrl });
    }
    autoUpdater.autoDownload = true; // download silently in the background
    // The feed gate must NEVER install anything: it quits right after the
    // banner assert, and autoInstallOnAppQuit would silently run the (real)
    // NSIS installer mid-gate — on a developer's machine that overwrites
    // their installed Volt. Real runs keep the quit-applies behavior.
    autoUpdater.autoInstallOnAppQuit = !SMOKE_FEED;
    autoUpdater.disableWebInstaller = true; // Volt ships a full NSIS installer, not a web stub
    autoUpdater.on("update-downloaded", (info) => {
      pendingUpdateVersion = info && info.version ? info.version : "";
      console.log("auto-update: downloaded " + pendingUpdateVersion);
      if (win && !win.isDestroyed()) {
        win.webContents.send("volt:update-downloaded", { version: pendingUpdateVersion });
      }
    });
    autoUpdater.on("update-available", (info) => {
      console.log("auto-update: new version available: " + (info && info.version));
      // background downloads suppressed (metered connection + pref off) — the
      // renderer must offer the download instead of it being silently skipped
      if (!autoUpdater.autoDownload && win && !win.isDestroyed()) {
        win.webContents.send("volt:update-available", { version: info && info.version });
      }
    });
    autoUpdater.on("error", (err) => {
      console.log("auto-update: " + ((err && err.message) || err));
    });
    updaterEnabled = true;
    // check shortly after startup — let the window and the renderer settle
    // first, so a fresh install isn't doing network + render at once. The
    // renderer pushes its prefs within the first second (volt:update-prefs),
    // so by the time this fires 'check on startup' is already known; if the
    // pref never arrives (no renderer?) the default true keeps the check.
    // The feed gate can't wait 12s — its whole budget is ~90s — so it checks
    // after 2.5s instead (the renderer's prefs arrive within the first second).
    setTimeout(() => {
      if (!updatePrefs.checkOnStartup) {
        console.log("auto-update: startup check disabled by preference (manual only)");
        return;
      }
      autoUpdater.checkForUpdates().catch((e) => console.log("auto-update: check failed: " + ((e && e.message) || e)));
    }, SMOKE_FEED ? 2500 : 12000).unref();
    console.log("app auto-update enabled (feed " + (feedUrl || "publish config") + ")");
  } catch (e) {
    updaterEnabled = false;
    console.log("app auto-update disabled: " + ((e && e.message) || e));
  }
}

/** Drive the modal focus trap with REAL keyboard input (sendInputEvent), so
    the smoke exercises Chromium's native input pipeline — the same path a
    physical Tab keypress takes — instead of synthetic KeyboardEvent dispatch.
    Runs with the settings modal open: native Tab/Shift+Tab must traverse and
    wrap inside the trap, and native Escape must close the modal, restore
    focus to the opener, and clear the inert background. */
async function realKeyStage(w) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const js = (code) => w.webContents.executeJavaScript(code);
  const key = async (keyCode, modifiers) => {
    const down = { type: "keyDown", keyCode };
    if (modifiers && modifiers.length) down.modifiers = modifiers;
    await w.webContents.sendInputEvent(down);
    await w.webContents.sendInputEvent({ type: "keyUp", keyCode, ...(down.modifiers ? { modifiers: down.modifiers } : {}) });
    await sleep(60); // let the trap's synchronous focus land and any async eviction settle
  };
  // Enter is special in Chromium's injected-input pipeline: the button
  // ACTIVATION default action (the click a physical Enter fires on a focused
  // <button>) only happens when the key arrives as rawKeyDown + char — the
  // normal printable-key sequence. A bare keyDown+keyUp pair delivers the DOM
  // keydown but skips the default action, so Enter gets its own helper.
  const keyEnter = async () => {
    await w.webContents.sendInputEvent({ type: "rawKeyDown", keyCode: "Return" });
    await w.webContents.sendInputEvent({ type: "char", keyCode: "Return" });
    await w.webContents.sendInputEvent({ type: "keyUp", keyCode: "Return" });
    await sleep(80);
  };
  const activeId = () => js(`(() => { const el = document.activeElement; return el ? (el.id || el.tagName) : "none"; })()`);
  const out = { ok: false, error: null };
  try {
    // native tab traversal needs the document to actually have focus — a
    // never-shown window has hasFocus()=false, so Chromium ignores Tab for
    // focus navigation. Show + focus for this stage, then hide again.
    w.show();
    w.focus();
    await sleep(150);
    // In VM/RDP sessions (which Volt explicitly supports) the window can fail
    // to win real OS foreground focus, leaving native Tab traversal dormant.
    // Fail with a clear reason rather than a baffling row of assertion flips.
    if (!(await js("document.hasFocus()"))) {
      w.focus();
      await sleep(250);
      if (!(await js("document.hasFocus()"))) {
        out.ok = false;
        out.error = "smoke window never gained OS focus — native Tab traversal not testable in this session";
        if (!w.isDestroyed()) w.hide();
        return out;
      }
    }
    // open the settings modal from the help button; _openModal focuses its first field
    const opened = await js(`(() => {
      const V = window.Volt.App;
      document.getElementById("btn-help").focus();
      V._openModal(V.elements.settingsModal);
      const ids = V._focusablesIn(V.elements.settingsModal).map((el) => el.id || el.tagName);
      return { first: ids[0], second: ids[1], last: ids[ids.length - 1], count: ids.length,
               active: document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : "none" };
    })()`);
    out.count = opened.count;
    out.openedFocus = opened.active;
    out.openedFocusIsFirst = opened.active === opened.first;
    // focus must HOLD on the modal's field over real time. Chromium asynchronously
    // evicts focus out of any inert subtree — a modal that ends up inside the
    // inerted #app loses its focused field ~60ms after opening (a bug the
    // synthetic test could never see). This is that regression's tripwire.
    await sleep(200);
    out.focusHeld = (await activeId()) === opened.first;

    // 1) native Tab from the first field → next focusable (forward traversal)
    await key("Tab", []);
    out.tabToSecond = (await activeId()) === opened.second;

    // 2) native Shift+Tab back to the first
    await key("Tab", ["shift"]);
    out.shiftTabBackToFirst = (await activeId()) === opened.first;

    // 3) native Shift+Tab from the first → wraps to the LAST (trap boundary)
    await key("Tab", ["shift"]);
    out.shiftTabWrapsToLast = (await activeId()) === opened.last;

    // 4) native Tab from the last → wraps to the FIRST
    await key("Tab", []);
    out.tabWrapsToFirst = (await activeId()) === opened.first;

    // 5) native Escape closes the modal, returns focus, clears inert
    await key("Escape", []);
    const closed = await js(`(() => ({
      hidden: window.Volt.App.elements.settingsModal.hidden,
      inert: window.Volt.App.elements.app.inert,
      active: document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : "none",
    }))()`);
    out.escapeClosed = closed.hidden === true;
    out.focusRestored = closed.active === "btn-help";
    out.inertCleared = closed.inert === false;

    // ── restore-backup prompt (native keys) ──────────────────
    // with a document open, a MISMATCHED backup must open the restore prompt
    // with all three action buttons (Cancel / Import into current doc / Open
    // this PDF…). Native Tab/Shift+Tab must reach each button and wrap at both
    // ends, and native Escape must close the prompt AND cancel the pending
    // backup — the dismissal guard in _closeModal clears _pendingBackup, so a
    // dismissed prompt can never auto-apply when the matching PDF opens later.
    const restore = {};
    try {
      const ro = await js(`(async () => {
        const V = window.Volt.App;
        // deliberately mismatched: different name, size, pages, and fingerprint
        // (the open sample has its own 16-hex fp) — _matchesBackup must reject
        const backup = { app: "volt", version: 5, file: "Mismatched-Backup.pdf",
          fileSize: 12345, filePages: 7, fileFingerprint: "0000000000000000",
          annotations: [], aiSettings: {}, chatHistory: [] };
        V._matchAndApplyBackup(backup); // async — _pendingBackup is set synchronously first
        const rm = V.elements.restoreModal;
        const t0 = Date.now();
        while (Date.now() - t0 < 5000 && rm.hidden) await new Promise((r) => setTimeout(r, 50));
        const ids = V._focusablesIn(rm).map((el) => el.id || el.tagName);
        return { opened: rm.hidden === false, pendingSet: V._pendingBackup !== null,
                 anywayShown: V.elements.restoreAnyway.hidden === false,
                 count: ids.length, first: ids[0], second: ids[1], last: ids[ids.length - 1],
                 active: document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : "none",
                 buttons: ids };
      })()`);
      restore.opened = ro.opened;
      restore.pendingSet = ro.pendingSet;
      restore.threeButtons = ro.anywayShown === true && ro.count === 3;
      restore.buttons = ro.buttons;
      restore.focusFirst = ro.active === ro.first && ro.first === "restore-cancel";
      // 1) native Tab → second button (Import into current doc)
      await key("Tab", []);
      restore.tabSecond = (await activeId()) === ro.second && ro.second === "restore-anyway";
      // 2) native Tab → third button (Open this PDF… — the last focusable)
      await key("Tab", []);
      restore.tabThird = (await activeId()) === ro.last && ro.last === "restore-open";
      // 3) native Tab from the last → wraps to the FIRST (trap boundary)
      await key("Tab", []);
      restore.tabWrapsFirst = (await activeId()) === ro.first;
      // 4) native Shift+Tab from the first → wraps to the LAST
      await key("Tab", ["shift"]);
      restore.shiftTabWrapsLast = (await activeId()) === ro.last;
      // 5) native Escape closes the prompt and CANCELS the pending backup
      await key("Escape", []);
      const rclosed = await js(`(() => ({
        hidden: window.Volt.App.elements.restoreModal.hidden,
        pending: window.Volt.App._pendingBackup,
        inert: window.Volt.App.elements.app.inert,
        active: document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : "none",
      }))()`);
      restore.escapeClosed = rclosed.hidden === true;
      restore.pendingCleared = rclosed.pending === null;
      restore.inertCleared = rclosed.inert === false;
      restore.focusRestored = rclosed.active === "btn-help";
    } catch (e) {
      restore.error = String((e && e.message) || e);
    }
    restore.allOk = restore.opened === true && restore.pendingSet === true &&
      restore.threeButtons === true && restore.focusFirst === true &&
      restore.tabSecond === true && restore.tabThird === true &&
      restore.tabWrapsFirst === true && restore.shiftTabWrapsLast === true &&
      restore.escapeClosed === true && restore.pendingCleared === true &&
      restore.inertCleared === true && restore.focusRestored === true && !restore.error;
    out.restore = restore;

    // ── pages-manager staged-plan undo (native Ctrl+Z) ──────────
    // the modal branch lends Ctrl+Z to the STAGED PLAN — a REAL native
    // Ctrl+Z (sendInputEvent, not a synthetic dispatch) must revert the
    // last staged edit, leaving the undo/redo buttons consistent.
    const pagesKey = {};
    try {
      const pk = await js(`(() => {
        const V = window.Volt.App;
        V.openPagesManager();
        const opened = V.elements.pagesModal.hidden === false;
        const before = (V._pagePlan || []).length;
        V.elements.btnPagesBlank.click(); // edit 1
        V.elements.btnPagesBlank.click(); // edit 2 — undoing THIS is what Ctrl+Z reverts
        const after = (V._pagePlan || []).length;
        return { opened, before, after };
      })()`);
      pagesKey.opened = pk.opened === true;
      pagesKey.editStaged = pk.after === pk.before + 2;
      // native Ctrl+Z → the staged plan reverts one edit (and the redo stack
      // gains it) while earlier history keeps the undo button live
      await key("z", ["control"]);
      const pk2 = await js(`(() => {
        const V = window.Volt.App;
        return { len: (V._pagePlan || []).length,
                 undoDisabled: V.elements.btnPagesUndo.disabled,
                 redoDisabled: V.elements.btnPagesRedo.disabled,
                 modalOpen: V.elements.pagesModal.hidden === false };
      })()`);
      pagesKey.reverted = pk2.len === pk.before + 1;
      pagesKey.undoBtnEnabled = pk2.undoDisabled === false;
      pagesKey.redoNowEnabled = pk2.redoDisabled === false;
      pagesKey.modalKeptOpen = pk2.modalOpen === true;
      // native Shift+↓ / Shift+End (the keyboard twin of Shift+click) must
      // grow the selection through Chromium's real input pipeline: fresh
      // start → Shift+↓ selects the first page, Shift+End reaches the last
      const pkLen = await js(`(() => { const V = window.Volt.App;
        V._pageSel = new Set(); V._pageSelAnchor = null; V._renderPagePlan();
        return (V._pagePlan || []).length; })()`);
      await key("Down", ["shift"]);
      const pkSd = await js(`(() => { const V = window.Volt.App;
        return V._pageSel ? [...V._pageSel] : []; })()`);
      pagesKey.selShiftDown = pkSd.length === 1 && pkSd[0] === 0;
      await key("End", ["shift"]);
      const pkSe = await js(`(() => { const V = window.Volt.App;
        return V._pageSel ? [...V._pageSel].sort((a, b) => a - b) : []; })()`);
      pagesKey.selShiftEnd = pkSe.length === pkLen && pkSe[0] === 0 && pkSe[pkSe.length - 1] === pkLen - 1;
      // close the manager the same native way (Escape)
      await key("Escape", []);
      pagesKey.escapeClosed = (await js(`window.Volt.App.elements.pagesModal.hidden`)) === true;
    } catch (e) {
      pagesKey.error = String((e && e.message) || e);
    }
    pagesKey.allOk = pagesKey.opened === true && pagesKey.editStaged === true &&
      pagesKey.reverted === true && pagesKey.undoBtnEnabled === true &&
      pagesKey.redoNowEnabled === true && pagesKey.modalKeptOpen === true &&
      pagesKey.selShiftDown === true && pagesKey.selShiftEnd === true &&
      pagesKey.escapeClosed === true && !pagesKey.error;
    out.pagesKey = pagesKey;

    // ── sidebar block move (native Ctrl+Home / Ctrl+End / Ctrl+M) ──              // the sidebar's multi-selected block (Ctrl+click toggles; Shift+click
              // ranges) can be moved without the drag: REAL
              // Ctrl+Home / Ctrl+End (sendInputEvent) must reach the global key handler
              // and rebuild the doc — the ann pattern traces the block's position (pages
    // 1 and 3 of the restored sample carry notes, page 2 the blank doesn't) —
    // and native Ctrl+M must open the sidebar's move form (focused input),
    // with native Escape closing it. Undo restores the pre-move order.
    const kb = {};
    try {
      // the doc here is the freshly-restored sample — make the ann pattern
      // deterministic by guaranteeing notes on pages 1 and 3 (page 2 stays
      // bare), so the badge pattern traces the block's position
      await js(`(() => {
        const A = window.Volt.Ann;
        // REPLACE the list with exactly pages 1 and 3 — the shared smoke
        // profile accumulates annotations across runs (and earlier probe
        // stages seed notes/highlights on the sample identity), so an
        // incremental seed would leave page 2 decorated and break the badge
        // pattern this stage traces (same deterministic trick as kbMove)
        A._mutate(() => {
          A.list = [
            { id: "kb-seed-1", type: "note", page: 1, point: { x: 40, y: 40 }, text: "kb seed", color: "#60a5fa", createdAt: Date.now() },
            { id: "kb-seed-3", type: "note", page: 3, point: { x: 40, y: 40 }, text: "kb seed", color: "#60a5fa", createdAt: Date.now() },
          ];
        });
        A._save(); // persist immediately (see the kbMove stage — the debounce races the next open)
        return true;
      })()`);
      await sleep(200); // badges render
      const ko = await js(`(() => {
        const V = window.Volt.App;
        const grid = document.getElementById("thumb-grid");
        const click = (el0) => el0.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true }));
        const q = (p) => grid.querySelector('.thumb-item[data-page="' + p + '"]');
        // Ctrl+click toggles the non-contiguous {1,3} pair (Shift+click now ranges)
        click(q(1)); click(q(3));
        // ghost thumbs (data-page=undefined) can transiently exist mid-render
        // during a rebuild — ignore them so the order read is stable
        const thumbs = [...grid.querySelectorAll(".thumb-item")].filter((it) => Number.isFinite(parseInt(it.dataset.page, 10)));
        return { sel: V._thumbSel ? [...V._thumbSel].join(",") : "null",
                 row: document.getElementById("thumb-block-actions").hidden === false,
                 order: thumbs.map((it) => parseInt(it.dataset.page, 10) + (it.querySelector(".pages-ann") ? "a" : "")).join(",") };
      })()`);
      kb.selBefore = ko.sel === "1,3" && ko.row === true;
      kb.orderBefore = ko.order === "1a,2,3a";
      // a native key commits ASYNC (rebuild + reopen + sidebar re-render take
      // ~1s). The next key must NOT fire until the previous commit has landed
      // — otherwise two commits race and the later read sees a mix. Each key
      // is therefore followed by a poll for the EXPECTED order: that both
      // serializes the keys and returns the state for the assertions (a
      // broken feature times out at 8s and the mismatched state shows up in
      // the failing field).
      const waitFor = (order, expectSel) => js(`(async () => {
        const V = window.Volt.App;
        const grid = document.getElementById("thumb-grid");
        const t0 = Date.now();
        const read = () => {
          const q = (p) => grid.querySelector('.thumb-item[data-page="' + p + '"]');
          const s = (p) => { const el = q(p); return !!el && el.classList.contains("sel"); };
          const thumbs = [...grid.querySelectorAll(".thumb-item")].filter((it) => Number.isFinite(parseInt(it.dataset.page, 10)));
          return { sel: V._thumbSel ? [...V._thumbSel].join(",") : "null",
                   order: thumbs.map((it) => parseInt(it.dataset.page, 10) + (it.querySelector(".pages-ann") ? "a" : "")).join(","),
                   undo: !!V._reorderUndo, s1: s(1), s2: s(2), s3: s(3) };
        };
        // wait for BOTH the order AND the applied .sel classes: the order
        // reflects the rebuilt grid, but the selection classes land only when
        // _renderThumbs finishes (async) — reading on order alone caught the
        // pre-class window
        while (Date.now() - t0 < 8000) {
          const st = read();
          if (st.order === ${JSON.stringify(order)} && grid.querySelectorAll(".thumb-item.sel").length === ${JSON.stringify(expectSel)}) return st;
          await new Promise((r) => setTimeout(r, 100));
        }
        return read();
      })()`);
      // native Ctrl+Home → the block jumps to the front
      await key("Home", ["control"]);
      const kh = await waitFor("1a,2a,3", 2);
      kb.ctrlHomeOrder = kh.order === "1a,2a,3"; // [orig1, orig3, blank]
      kb.ctrlHomeSel = kh.sel === "1,2" && kh.s1 === true && kh.s2 === true && kh.undo === true;
      // native Ctrl+End → the block jumps to the back
      await key("End", ["control"]);
      const ke = await waitFor("1,2a,3a", 2);
      kb.ctrlEndOrder = ke.order === "1,2a,3a"; // [blank, orig1, orig3]
      kb.ctrlEndSel = ke.sel === "2,3" && ke.s2 === true && ke.s3 === true;
      // native Ctrl+M opens the move form (focused input); Escape closes it
      await key("m", ["control"]);
      await sleep(150);
      const km = await js(`(() => ({
        form: window.Volt.App.elements.thumbMoveForm.hidden === false,
        focus: document.activeElement === document.getElementById("thumb-move-pos"),
      }))()`);
      kb.ctrlMForm = km.form === true;
      kb.ctrlMFocus = km.focus === true;
      await key("Escape", []);
      kb.escapeClosed = (await js(`window.Volt.App.elements.thumbMoveForm.hidden`)) === true;
      // undo the Ctrl+End move → the pre-move order, selection cleared
      const ku = await js(`(() => { const b = [...document.querySelectorAll(".toast-action")].pop();
        if (b && b.textContent === "Undo reorder") b.click();
        return !!(b && b.textContent === "Undo reorder"); })()`);
      kb.undoOffered = ku === true;
      const kr = await waitFor("1a,2a,3", 0);
      kb.undoRestored = kr.order === "1a,2a,3" && kr.sel === "null";
    } catch (e) {
      kb.error = String((e && e.message) || e);
    }
    kb.allOk = kb.selBefore === true && kb.orderBefore === true && kb.ctrlHomeOrder === true &&
      kb.ctrlHomeSel === true && kb.ctrlEndOrder === true && kb.ctrlEndSel === true &&
      kb.ctrlMForm === true && kb.ctrlMFocus === true && kb.escapeClosed === true &&
      kb.undoOffered === true && kb.undoRestored === true && !kb.error;
    out.kb = kb;

    // ── toolbar menus (native Alt+letter + arrows + Enter) ──────────
    // The native menu bar is removed on Windows (Menu.setApplicationMenu), so
    // a REAL Alt+V must reach the page and open OUR View menu with focus on
    // its first item; native arrows must traverse it, native Enter must
    // activate the focused item (Rotate → rotDelta +90) and close the panel,
    // and native Alt+T + Escape must open/close the Tools menu with focus
    // returned to its trigger.
    const menuKey = {};
    try {
      const rotBefore = await js(`window.Volt.App.rotDelta`);
      await key("V", ["alt"]);
      const mo = await js(`(() => ({
        open: document.getElementById("menu-view").querySelector(".tb-menu-panel").hidden === false,
        expanded: document.getElementById("btn-view").getAttribute("aria-expanded") === "true",
        active: document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : "none",
      }))()`);
      menuKey.altOpens = mo.open === true;
      menuKey.altAria = mo.expanded === true;
      menuKey.altFocus = mo.active === "btn-fit-width";
      await key("Down", []);
      menuKey.arrowNext = (await activeId()) === "btn-fit-page";
      await key("Down", []);
      menuKey.arrowRotate = (await activeId()) === "btn-rotate";
      await keyEnter(); // native Enter activates the focused item (Rotate)
      const ra = await js(`(() => ({
        rot: window.Volt.App.rotDelta,
        closed: document.getElementById("menu-view").querySelector(".tb-menu-panel").hidden === true,
        active: document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : "none",
      }))()`);
      menuKey.enterActivates = ra.rot === (rotBefore + 90) % 360;
      menuKey.closesOnActivate = ra.closed === true;
      // the activated item is now hidden, so focus must have returned to the
      // menu's trigger (the item-activation restore in _wireMenus)
      menuKey.activateFocus = ra.active === "btn-view";
      // Alt+T opens Tools with focus on a visible item; Escape closes it and
      // returns focus to the trigger
      await key("T", ["alt"]);
      const t0 = await js(`(() => {
        const panel = document.getElementById("menu-tools").querySelector(".tb-menu-panel");
        const items = [...panel.querySelectorAll(".tb-menu-item")]
          .filter((el) => !el.hidden && getComputedStyle(el).display !== "none");
        const a = document.activeElement;
        return { open: panel.hidden === false, inItems: items.indexOf(a) !== -1 };
      })()`);
      menuKey.altTools = t0.open === true && t0.inItems === true;
      await key("Escape", []);
      const t1 = await js(`(() => ({
        closed: document.getElementById("menu-tools").querySelector(".tb-menu-panel").hidden === true,
        expanded: document.getElementById("btn-tools").getAttribute("aria-expanded") === "false",
        active: document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : "none",
      }))()`);
      menuKey.escapeCloses = t1.closed === true;
      menuKey.escapeAria = t1.expanded === true;
      menuKey.escapeFocus = t1.active === "btn-tools";
    } catch (e) {
      menuKey.error = String((e && e.message) || e);
    }
    menuKey.allOk = menuKey.altOpens === true && menuKey.altFocus === true && menuKey.altAria === true &&
      menuKey.arrowNext === true && menuKey.arrowRotate === true &&
      menuKey.enterActivates === true && menuKey.closesOnActivate === true && menuKey.activateFocus === true &&
      menuKey.altTools === true && menuKey.escapeCloses === true &&
      menuKey.escapeAria === true && menuKey.escapeFocus === true && !menuKey.error;
    out.menuKey = menuKey;

    out.ok = out.openedFocusIsFirst && out.focusHeld && out.tabToSecond && out.shiftTabBackToFirst &&
      out.shiftTabWrapsToLast && out.tabWrapsToFirst && out.escapeClosed && out.focusRestored && out.inertCleared &&
      restore.allOk && pagesKey.allOk && kb.allOk && menuKey.allOk;
  } catch (e) {
    out.error = String((e && e.message) || e);
  }
  if (!w.isDestroyed()) w.hide();
  return out;
}

/** Office-export validation stage: the renderer wrote the generated .docx,
    .xlsx and .pptx to disk — run the real zipfile module over them (integrity
    + CRC, the OOXML/SpreadsheetML/PresentationML parts, and the content
    needles) so a broken writer fails the smoke instead of shipping a file
    Word/Excel/PowerPoint can't open. For each deck, also asserts the slide
    count the renderer computed matches what's actually in the zip (full deck
    first, then the Pages-selection subset deck when given). */
async function validateOfficeStage(docxPath, xlsxPath, pptxPath, subsetPath, subsetSlides) {
  const result = { ok: false, error: null, stdout: "", pptxSlides: null, subsetSlides: null };
  const py = join(APP_ROOT, "scripts", "validate-office.py");
  const args = [py, docxPath, "Quarterly Sales", xlsxPath, "Apples", pptxPath, "Apples", pptxPath, "<p:pic>"];
  if (subsetPath) args.push(subsetPath, "Page 3");
  await new Promise((resolve) => {
    const child = spawn("python", args, { windowsHide: true });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    child.on("error", (e) => { result.error = "python spawn: " + e.message; resolve(); });
    child.on("close", (code) => {
      result.stdout = out.trim();
      // python reports each deck's slide count with its path — map them so the
      // full and subset decks can be checked independently
      const counts = new Map();
      for (const m of out.matchAll(/OFFICE_VALIDATE SLIDES (\d+) (.+)/g)) counts.set(m[2].trim(), parseInt(m[1], 10));
      result.pptxSlides = counts.get(pptxPath) ?? null;
      result.subsetSlides = subsetPath ? (counts.get(subsetPath) ?? null) : null;
      const slidesOk = !subsetPath || result.subsetSlides === subsetSlides;
      result.ok = code === 0 && /OFFICE_VALIDATE OK/.test(out) && slidesOk;
      if (!result.ok) result.error = "validate-office.py exit " + code + ": " + out.trim().slice(0, 300);
      resolve();
    });
  });
  return result;
}

/** Responsive-toolbar stage: resize the window across the CSS media-query
    breakpoints (1280 → 760, the last two below the desktop 900px minimum —
    narrow browser-window widths) and assert the right-end controls (sidebar /
    AI / settings / help) stay on-screen at EVERY size — the regression that
    made the app look like it "doesn't adjust to resizing" (a ~1270px fixed
    toolbar pushing those buttons off the window edge). Also asserts each
    collapse tier actually engages (labels hide as the window shrinks) and
    the toolbar never overflows, then restores the original window size.
    Pure layout check — no focus needed, so it runs in --smoke-no-focus too. */
async function toolbarResizeStage(w) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const js = (code) => w.webContents.executeJavaScript(code);    const out = { ok: false, error: null, sizes: [] };
  const original = w.getSize();
  try {
    // the desktop window's minWidth 900 would clamp every sub-900 setSize —
    // relax it so the browser-width sizes genuinely exercise tier 4 (restored
    // in finally, so later stages run in the standard window)
    w.setMinimumSize(640, 480);
    // (outer width, height): every media-query breakpoint edge (1280 / 1100 /
    // 960 / 840) plus mid-tier and sub-desktop-minimum sizes — the last two
    // (840 / 760) cover narrow browser-window widths the desktop app itself
    // can never reach (its floor is 900x600)
    const sizes = [[1280, 900], [1100, 700], [1000, 650], [960, 640], [900, 620], [840, 620], [760, 580]];
    for (const [w_, h] of sizes) {
      w.setSize(w_, h);
      await sleep(450); // layout + the app's debounced resize handler settle
      const m = await js(`(() => {
        const tb = document.getElementById("toolbar");
        if (!tb) return { missing: true };
        const rect = (id) => { const el = document.getElementById(id); if (!el) return null; const b = el.getBoundingClientRect(); return { l: Math.round(b.left), r: Math.round(b.right), vis: b.right <= window.innerWidth + 1 && b.left >= 0, disp: getComputedStyle(el).display }; };
        const shown = (sel) => { const el = document.querySelector(sel); return el ? getComputedStyle(el).display !== "none" : null; };
        return {
          innerW: window.innerWidth,
          overflow: tb.scrollWidth > tb.clientWidth,
          sidebar: rect("btn-sidebar"), ai: rect("btn-ai"), settings: rect("btn-settings"), help: rect("btn-help"),
          brand: rect("btn-brand"), markup: rect("btn-markup"), view: rect("btn-view"), tools: rect("btn-tools"),
          menuLabel: shown("#btn-markup .menu-label"),
          brandName: shown(".brand-name"),
          zoomLabel: shown("#zoom-label"),
          searchCount: shown("#search-count"),
          searchPrev: shown("#search-prev"),
          gapPx: tb.scrollWidth - tb.clientWidth,
          searchW: (() => { const el = document.getElementById("search-input"); return el ? Math.round(el.getBoundingClientRect().width) : null; })(),
          label: shown("#btn-markup .menu-label"),
        };
      })()`);
      if (m.missing) { out.error = "toolbar missing at size " + w_ + "x" + h; break; }
      // the menu triggers joined the right-end controls: all must stay
      // on-screen (and on-clickable) at every width. (The brand trigger is
      // intentionally hidden below 840px — a tier-4 collapse — so it is
      // read but not required to stay visible.)
      const controls = [m.sidebar, m.ai, m.settings, m.help, m.markup, m.view, m.tools];
      const controlsVisible = controls.every((c) => c && c.vis && c.disp !== "none");
      // tier expectations (media queries key on the VIEWPORT = inner width):
      // tier 2 collapses the menu labels with the brand/zoom (the 960–1100
      // band is the tightest since the OCR group moved into Tools), tier 3
      // sheds the search count + tightens search, tier 4 drops the last
      // search buttons — same collapse ladder as before, re-anchored on the
      // menus
      const tier1 = m.innerW <= 1300, tier2 = m.innerW <= 1100, tier3 = m.innerW <= 960, tier4 = m.innerW <= 840;
      const tierOk =
        (!tier2 || (m.brandName === false && m.zoomLabel === false && m.menuLabel === false)) &&
        (!tier3 || m.searchCount === false) &&
        (!tier4 || m.searchPrev === false);
      out.sizes.push({
        outer: [w_, h], inner: m.innerW,
        controlsVisible, overflow: m.overflow, tierOk,
        tier: tier4 ? 4 : tier3 ? 3 : tier2 ? 2 : tier1 ? 1 : 0,
        sidebar: m.sidebar, ai: m.ai, settings: m.settings, help: m.help,
        gapPx: m.gapPx, searchW: m.searchW, label: m.label,
      });
    }
    // ── menu sanity (runs at a WIDE size — the brand trigger is hidden by
    // the tier-4 collapse, and the menu keyboard/aria checks are
    // viewport-independent, so restore the original window first): the
    // dropdowns hold the regrouped items, open exactly their own panel
    // (visible), and closing restores the [hidden] display contract; a real
    // item click still reaches its action (Volt → Export opens the modal)
    w.setSize(original[0], original[1]);
    await sleep(300); // layout settles before the keyboard probe
    const menuCheck = await js(`(async () => {
      const out = {};
      const has = (id) => !!document.getElementById(id);
      // File's items moved under the Volt-logo menu (menu-brand); the Markup
      // menu holds the annotation tools + insertions
      out.brandHas = ["btn-open", "btn-open-url", "btn-export", "btn-menu-settings", "btn-menu-help",
        "btn-check-updates", "btn-about", "btn-save-pdf", "btn-exit"].every(has);
      out.viewHas = ["btn-fit-width", "btn-fit-page", "btn-rotate", "btn-theme-light", "btn-theme-dark"].every(has);
      out.toolsHas = ["btn-ocr", "btn-ocr-lang", "btn-ocr-layer", "btn-readaloud"].every(has);
      out.markupHas = ["btn-sig", "btn-date", "btn-form"].every(has) &&
        // Select / Highlight / Rect / Underline / Strike / Note / Text (7 tools —
        // the Text tool joined the panel last; bump when a tool is added/removed)
        [...document.querySelectorAll("#menu-markup-panel .mode-btn")].length === 7;
      // ARIA contract: every trigger is a menu button (haspopup + expanded +
      // controls pointing at its panel), every panel is role=menu, every item
      // role=menuitem, and all triggers START collapsed (aria-expanded=false)
      // the trigger is either the element with the id itself (btn-file…) or a
      // descendant of a menu container (menu-file…); the helper handles both
      const trigOf = (id) => {
        const el = document.getElementById(id);
        if (!el) return null;
        return el.classList && el.classList.contains("tb-menu-trigger") ? el : el.querySelector(".tb-menu-trigger");
      };
      const aria = {};
      aria.haspopup = ["btn-brand", "btn-view", "btn-tools", "btn-markup"].every((id) => trigOf(id).getAttribute("aria-haspopup") === "menu");
      aria.controlsAndRoles = ["menu-brand", "menu-view", "menu-tools", "menu-markup"].every((id) => {
        const p = document.getElementById(id).querySelector(".tb-menu-panel");
        return trigOf(id).getAttribute("aria-controls") === p.id && p.getAttribute("role") === "menu";
      });
      aria.menuitems = ["btn-open", "btn-open-url", "btn-export", "btn-menu-settings", "btn-menu-help",
        "btn-check-updates", "btn-about", "btn-save-pdf", "btn-exit",
        "btn-fit-width", "btn-fit-page", "btn-rotate", "btn-theme-light", "btn-theme-dark",
        "btn-ocr", "btn-ocr-lang", "btn-ocr-layer", "btn-readaloud", "btn-sig", "btn-date", "btn-form"].every((id) => document.getElementById(id).getAttribute("role") === "menuitem");
      aria.modeItems = [...document.querySelectorAll("#menu-markup-panel .mode-btn")]
        .every((b) => b.getAttribute("role") === "menuitem");
      aria.expanded0 = ["btn-brand", "btn-view", "btn-tools", "btn-markup"].every((id) => trigOf(id).getAttribute("aria-expanded") === "false");
      out.aria = aria;
      for (const id of ["menu-brand", "menu-view", "menu-tools", "menu-markup"]) {
        const menu = document.getElementById(id);
        const trig = menu.querySelector(".tb-menu-trigger");
        const panel = menu.querySelector(".tb-menu-panel");
        trig.click();
        const opened = panel.hidden === false && trig.classList.contains("open");
        out[id] = { opened, panelVisible: getComputedStyle(panel).display !== "none",
                    expanded: trig.getAttribute("aria-expanded") === "true" };
        trig.click();
        out[id].closed = panel.hidden === true && getComputedStyle(panel).display === "none" &&
          trig.getAttribute("aria-expanded") === "false";
      }
      document.getElementById("btn-brand").click();
      document.getElementById("btn-export").click();
      out.exportOpens = document.getElementById("export-modal").hidden === false;
      document.getElementById("export-close").click();
      out.exportClosed = document.getElementById("export-modal").hidden === true;
      // ── keyboard: Alt+letter opens a menu and focuses its first item,
      // arrows / Home / End traverse and wrap, ← / → switch menus, Esc closes
      // and returns focus to the trigger, Alt+letter toggles — and while a
      // menu is open it owns the arrow keys (the page must not navigate
      // underneath). Enter-activation is native button behavior, verified
      // separately by the real-keyboard stage.
      const kd = (opts) => new KeyboardEvent("keydown", Object.assign({ bubbles: true, cancelable: true }, opts));
      const panelOf = (id) => document.getElementById(id).querySelector(".tb-menu-panel");
      const focusedId = () => (document.activeElement && document.activeElement.id) || "none";
      const pageBefore = window.Volt.App._currentPageNum();
      document.dispatchEvent(kd({ key: "v", altKey: true }));
      out.kbViewOpen = panelOf("menu-view").hidden === false && focusedId() === "btn-fit-width" &&
        trigOf("btn-view").getAttribute("aria-expanded") === "true";
      document.dispatchEvent(kd({ key: "ArrowDown" }));
      out.kbNext = focusedId() === "btn-fit-page";
      document.dispatchEvent(kd({ key: "ArrowDown" })); // → rotate
      document.dispatchEvent(kd({ key: "ArrowDown" })); // → Light skin
      document.dispatchEvent(kd({ key: "ArrowDown" })); // → Dark skin
      document.dispatchEvent(kd({ key: "ArrowDown" })); // wraps to the first
      out.kbWrap = focusedId() === "btn-fit-width";
      document.dispatchEvent(kd({ key: "ArrowUp" })); // wraps to the last
      out.kbWrapUp = focusedId() === "btn-theme-dark";
      document.dispatchEvent(kd({ key: "Home" }));
      document.dispatchEvent(kd({ key: "End" }));
      out.kbHomeEnd = focusedId() === "btn-theme-dark";
      out.kbNoPageNav = window.Volt.App._currentPageNum() === pageBefore;
      document.dispatchEvent(kd({ key: "ArrowRight" })); // → the next menu (Markup)
      const mp = panelOf("menu-markup");
      out.kbSwitchTools = mp.hidden === false && mp.contains(document.activeElement) &&
        document.activeElement.hidden !== true &&
        document.activeElement.classList && document.activeElement.classList.contains("mode-btn") &&
        trigOf("btn-markup").getAttribute("aria-expanded") === "true" &&
        trigOf("btn-view").getAttribute("aria-expanded") === "false";
      document.dispatchEvent(kd({ key: "ArrowLeft" })); // ← back to View
      out.kbSwitchBack = panelOf("menu-view").hidden === false && focusedId() === "btn-fit-width" &&
        trigOf("btn-markup").getAttribute("aria-expanded") === "false";
      document.dispatchEvent(kd({ key: "b", altKey: true })); // Alt+B jumps to the Volt menu
      out.kbAltB = panelOf("menu-brand").hidden === false && focusedId() === "btn-open" &&
        trigOf("btn-brand").getAttribute("aria-expanded") === "true" &&
        trigOf("btn-view").getAttribute("aria-expanded") === "false";
      document.dispatchEvent(kd({ key: "ArrowDown" }));
      document.dispatchEvent(kd({ key: "ArrowDown" })); // → Export
      out.kbArrowToExport = focusedId() === "btn-export";
      document.dispatchEvent(kd({ key: "Escape" })); // closes + restores focus to the trigger
      out.kbEscClose = panelOf("menu-brand").hidden === true && focusedId() === "btn-brand" &&
        trigOf("btn-brand").getAttribute("aria-expanded") === "false";
      document.dispatchEvent(kd({ key: "b", altKey: true })); // toggle back on
      out.kbAltBOn = panelOf("menu-brand").hidden === false && focusedId() === "btn-open" &&
        trigOf("btn-brand").getAttribute("aria-expanded") === "true";
      document.dispatchEvent(kd({ key: "b", altKey: true })); // and off again
      out.kbAltBOff = panelOf("menu-brand").hidden === true &&
        trigOf("btn-brand").getAttribute("aria-expanded") === "false";
      return out;
    })()`);
    out.menus = menuCheck;
    const menuOk = !!menuCheck && menuCheck.brandHas === true && menuCheck.viewHas === true && menuCheck.toolsHas === true && menuCheck.markupHas === true &&
      !!menuCheck.aria && menuCheck.aria.haspopup === true && menuCheck.aria.controlsAndRoles === true &&
      menuCheck.aria.menuitems === true && menuCheck.aria.modeItems === true && menuCheck.aria.expanded0 === true &&
      !!menuCheck["menu-brand"] && menuCheck["menu-brand"].opened === true && menuCheck["menu-brand"].expanded === true && menuCheck["menu-brand"].panelVisible === true && menuCheck["menu-brand"].closed === true &&
      !!menuCheck["menu-view"] && menuCheck["menu-view"].opened === true && menuCheck["menu-view"].expanded === true && menuCheck["menu-view"].panelVisible === true && menuCheck["menu-view"].closed === true &&
      !!menuCheck["menu-tools"] && menuCheck["menu-tools"].opened === true && menuCheck["menu-tools"].expanded === true && menuCheck["menu-tools"].panelVisible === true && menuCheck["menu-tools"].closed === true &&
      !!menuCheck["menu-markup"] && menuCheck["menu-markup"].opened === true && menuCheck["menu-markup"].expanded === true && menuCheck["menu-markup"].panelVisible === true && menuCheck["menu-markup"].closed === true &&
      menuCheck.exportOpens === true && menuCheck.exportClosed === true &&
      menuCheck.kbViewOpen === true && menuCheck.kbNext === true && menuCheck.kbWrap === true &&
      menuCheck.kbWrapUp === true && menuCheck.kbHomeEnd === true && menuCheck.kbNoPageNav === true &&
      menuCheck.kbSwitchTools === true && menuCheck.kbSwitchBack === true && menuCheck.kbAltB === true &&
      menuCheck.kbArrowToExport === true && menuCheck.kbEscClose === true &&
      menuCheck.kbAltBOn === true && menuCheck.kbAltBOff === true;
    out.ok = out.sizes.length === sizes.length && out.sizes.every((s) => s.controlsVisible && !s.overflow && s.tierOk) && menuOk;
  } catch (e) {
    out.error = String((e && e.message) || e);
  } finally {
    // restore the original window size AND minimum so later stages run in the
    // standard viewport (the real desktop window enforces 900x600)
    if (!w.isDestroyed()) {
      w.setSize(original[0], original[1]);
      w.setMinimumSize(900, 600);
    }
  }
  return out;
}

/** Launcher-integrity gate: every .cmd launcher must pass the static
    cmd.exe parse-hazard checks (ASCII + CRLF + paren rules), and on Windows
    the Volt launchers are actually executed through cmd.exe in a throwaway
    sandbox (node/npm/npx/powershell stubbed, mirrored temp tree) so a real
    parse error — the "… was unexpected at this time." class that once
    killed start-volt-app.cmd — fails the smoke instead of shipping. Pure
    Node/child-process, no window interaction, so it runs in
    --smoke-no-focus too. */
async function launcherGateStage() {
  const out = { ok: false, error: null };
  try {
    const checkerPath = join(__dirname, "..", "scripts", "check-launchers.cjs");
    if (!existsSync(checkerPath)) {
      out.ok = true;
      out.skipped = "launcher checker not present (packaged build)";
      return out;
    }
    const check = require(checkerPath);
    const bad = [];
    for (const f of check.LAUNCHERS) {
      if (!existsSync(f)) { bad.push(basename(f) + ": missing"); continue; }
      const errors = check.staticCheckLauncher(f);
      if (errors.length) bad.push(basename(f) + ": " + errors.join("; "));
    }
    // the hidden-console VBS launcher the desktop shortcut targets — it must
    // keep referencing the .cmd with window style 0, or the "no console box"
    // guarantee silently regresses
    if (typeof check.checkVbsLauncher === "function") {
      const vbsErrors = check.checkVbsLauncher();
      if (vbsErrors.length) bad.push("start-volt-app-hidden.vbs: " + vbsErrors.join("; "));
    }
    if (bad.length) { out.error = bad.join(" | "); return out; }
    if (process.platform === "win32") {
      const runs = check.realRunLaunchers();
      out.runs = runs.map((r) => ({ file: r.file, ok: r.ok, reason: r.reason }));
      const failed = runs.filter((r) => !r.ok);
      if (failed.length) {
        out.error = failed.map((r) => r.file + ": " + (r.reason || "parse run failed")).join(" | ");
        return out;
      }
    } else {
      out.runs = "skipped-non-windows";
    }
    out.ok = true;
  } catch (e) {
    out.error = String((e && e.message) || e);
  }
  return out;
}

/** Throwaway copy of the sample PDF for the smoke's file-change watch stage
    (the renderer watches it, main rewrites it, the banner must appear) plus a
    second copy the disk-persist stage uses: a reorder of a path-opened PDF
    must be written BACK to that same file, so the file's own bytes change. */
function prepareWatchTmp() {
  try {
    const dir = mkdtempSync(join(tmpdir(), "volt-smoke-watch-"));
    const target = join(dir, "watched.pdf");
    const diskTarget = join(dir, "disk-persist.pdf");
    const bytes = readFileSync(join(APP_ROOT, "samples", "sample.pdf"));
    writeFileSync(target, bytes);
    writeFileSync(diskTarget, bytes);
    return { dir, target, diskTarget, bytes }; // bytes reused for the "touch" rewrite
  } catch (e) {
    return null; // watch stage degrades to bridge-only in this case
  }
}

/** Headless self-test: open the sample document and report what rendered. */
function runSmokeTest(w) {
  // watchdog: never hang a terminal run — hard-exit if nothing reports.
  // A hung render (e.g. an incompatible pdf.js) can leave Chromium child
  // processes behind that lock the disk cache and poison the NEXT run, so on
  // Windows take the whole process tree down rather than just exiting.
  setTimeout(() => {
    console.log("SMOKE_RESULT " + JSON.stringify({ ok: false, error: "watchdog timeout" }));
    cleanupSmokeProfile();
    if (process.platform === "win32") {
      try { require("node:child_process").execSync("taskkill /F /T /PID " + process.pid); } catch (e) { /* already gone */ }
    }
    app.exit(2);
  }, 120000).unref(); // 120s: the suite has grown (OCR-via-WASM, watch, restore
  // stages all jitter on a loaded machine); 60s was tipping over under load
  // and killing runs that were merely slow, not hung

  const report = (ok, extra) => {
    // verdict LAST: extra often carries the probe's own `ok` field (e.g. a
    // failing bridge/invariant guard spread over a passing probe result) —
    // spread first so the printed ok ALWAYS matches the exit code
    console.log("SMOKE_RESULT " + JSON.stringify({ ...extra, ok }));
    cleanupSmokeProfile();
    setTimeout(() => app.exit(ok ? 0 : 1), 300);
  };

  // forward renderer console output so failures are visible in the log
  w.webContents.on("console-message", (e) => {
    if (e.level >= 1) console.log("[renderer] " + e.message);
  });
  w.webContents.on("did-fail-load", (_e, code, desc) => {
    console.log("[did-fail-load] " + code + " " + desc);
  });

  // when a .pdf was passed at launch, the probe verifies the OS handoff
  // opened it (argv -> queue -> renderer-ready -> IPC -> renderer). Browser
  // mode has no bridge, so there is nothing to hand off — the sample opens.
  const argvPdf = SMOKE_BROWSER ? null : findPdfArgv(process.argv);
  // file-change watcher stage: a throwaway copy of the sample sits in a temp
  // dir; the renderer opens it, watches it, and sets window.__voltWatchReady —
  // at which point this poller rewrites the file (same bytes, new mtime) so
  // the watcher fires and the reload banner must appear. Browser mode has no
  // watcher API either — the stage degrades to watch.allOk = true, so there's
  // no temp file to prepare and no poller to run.
  const watchTmp = SMOKE_BROWSER ? null : prepareWatchTmp();
  let watchReadyPoller = null;
  const watchTmpBytes = watchTmp ? watchTmp.bytes : null; // from prepareWatchTmp — no second read
  // No hard cap on the poller: the 60s smoke watchdog bounds everything, and
  // a slow renderer (cold start) must not lose the touch. It self-clears when
  // the renderer flips __voltWatchReady, and the probe clears it on finish.
  if (watchTmp) {
    watchReadyPoller = setInterval(() => {
      w.webContents.executeJavaScript("window.__voltWatchReady === true")
        .then((ready) => {
          if (ready) {
            clearInterval(watchReadyPoller);
            try { writeFileSync(watchTmp.target, watchTmpBytes); } catch (e) { /* never lets the smoke hang */ }
          }
        })
        .catch(() => {});
    }, 200);
  }

  const probe = async () => {
    try {
      // ── service-worker cache contract ─────────────────────
      // the shell computes the cache name the CURRENT files hash to — the very
      // same SHA-256 generator that renders sw.js — so the probe can assert the
      // served artifact declares it. A stale checked-in sw.js (an asset edited,
      // the derived artifact never regenerated) then fails the smoke instead of
      // silently precaching old files under an old name on static deployments.
      let expectSwCache = null, expectVersion = null, expectStamps = null, swGenErr = null;
      try {
        const swGen = await import("./scripts/gen-sw.mjs");
        expectSwCache = swGen.cacheName();
        expectVersion = swGen.appVersion();
        expectStamps = swGen.assetStamps() || {};
      } catch (e) {
        swGenErr = String((e && e.message) || e);
      }
      // office-export smoke artifacts: the renderer writes the generated
      // .docx / .xlsx / .pptx here, then main validates them with the real
      // zipfile module (scripts/validate-office.py)
      const officeTmp1 = join(smokeProfileDir, "office-test.docx");
      const officeTmp2 = join(smokeProfileDir, "office-test.xlsx");
      const officeTmp3 = join(smokeProfileDir, "office-test.pptx");
      const officeTmp4 = join(smokeProfileDir, "office-test-subset.pptx");
      const result = await w.webContents.executeJavaScript(`(async () => {
        const SAMPLE_PDF = ${JSON.stringify(join(APP_ROOT, "samples", "sample.pdf"))};
        const WATCH_TMP_PATH = ${JSON.stringify(watchTmp ? watchTmp.target : null)};
        const WATCH_TMP = ${JSON.stringify(watchTmp ? basename(watchTmp.target) : null)};
        const DISK_TMP_PATH = ${JSON.stringify(watchTmp ? watchTmp.diskTarget : null)};
        const DISK_TMP = ${JSON.stringify(watchTmp ? basename(watchTmp.diskTarget) : null)};
        const OFFICE_TMP1 = ${JSON.stringify(officeTmp1)};
        const OFFICE_TMP2 = ${JSON.stringify(officeTmp2)};
        const OFFICE_TMP3 = ${JSON.stringify(officeTmp3)};
        const OFFICE_TMP4 = ${JSON.stringify(officeTmp4)};
        const EXPECT_DOC = ${JSON.stringify(argvPdf ? basename(argvPdf) : null)};
        const EXPECT_SW_CACHE = ${JSON.stringify(expectSwCache)};
        const EXPECT_VERSION = ${JSON.stringify(expectVersion)};
        const EXPECT_STAMPS = ${JSON.stringify(expectStamps || {})};
        const EXPECT_HIDDEN = ${JSON.stringify(EXPECT_HIDDEN)};
        const SW_GEN_ERR = ${JSON.stringify(swGenErr)};        const Volt = window.Volt;
        window.addEventListener("error", (ev) => console.log("PAGE-ERROR: " + ((ev.error && ev.error.stack) || ev.message)));
        window.addEventListener("unhandledrejection", (ev) => console.log("UNHANDLED-REJ: " + ((ev.reason && ev.reason.stack) || ev.reason)));


        if (!Volt || !Volt.App) return { ok: false, error: "Volt.App missing" };
        if (!Volt.Ann || !Volt.AI) return { ok: false, error: "modules missing: " + Object.keys(Volt).join(",") };
        // desktop bridge: preload present + IPC file-read round-trip works
        let desktop = { bridge: false };
        if (window.voltDesktop) {
          try {
            const r = await window.voltDesktop.readFile(SAMPLE_PDF);
            desktop = { bridge: true, readOk: !!(r && r.data && r.data.byteLength > 1000 && r.name === "sample.pdf"),
              updateBridge: typeof window.voltDesktop.onVendorUpdated === "function" };
          } catch (e) { desktop = { bridge: true, readErr: String((e && e.message) || e) }; }
        }
        const out = {};
        const race = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r({ timeout: ms + "ms" }), ms))]);
        const T = async (label, fn) => {
          const t0 = Date.now();
          try { const v = await race(fn(), 10000); out[label] = { ms: Date.now() - t0, ...(v || {}) }; }
          catch (e) { out[label] = { err: String((e && e.message) || e) }; }
        };
        // ── hidden-attribute display contract ─────────────────
        // Modals, popovers, panels and badges rely on the global rule
        // [hidden]{display:none !important} to actually hide. A future display
        // rule (or a !important slip) can silently re-break that, so probe
        // every element carrying the hidden attribute and assert its computed
        // display is none. A calibration step deliberately breaks the contract
        // on a throwaway element to prove the probe isn't vacuously passing.
        const hiddenProbe = {};
        const checkHidden = (el) => {
          const d = getComputedStyle(el).display;
          return d === "none" ? null : { tag: el.tagName.toLowerCase(), id: el.id || "", cls: (el.className && String(el.className).split(" ").slice(0, 3).join(".")) || "", display: d };
        };
        const probeHidden = (label) => {
          const els = [...document.querySelectorAll("[hidden]")];
          const violations = [];
          for (const el of els) { const v = checkHidden(el); if (v) violations.push(v); }
          // checked > 0: an empty probe (hidden usage removed entirely) must not
          // silently pass — the calibration proves the mechanism is probe-able,
          // not that the app actually relies on it
          // pinned count: when --expect-hidden=<n> is set, the BOOT set (the
          // "start hidden" baseline) must match exactly — a shell change that
          // adds/removes a hidden element fails the smoke until the operator
          // consciously bumps the pin (expected/checked fields self-diagnose)
          const pin = EXPECT_HIDDEN !== null && label === "boot" ? EXPECT_HIDDEN : null;
          hiddenProbe[label] = {
            checked: els.length,
            ...(pin !== null ? { expected: pin } : {}),
            violations: violations.slice(0, 8),
            pass: violations.length === 0 && els.length > 0 && (pin === null || els.length === pin),
          };
        };
        // open the sample (or, when a file was passed at launch, rely on
        // the OS handoff to open it) and wait for the document to be ready
        if (!EXPECT_DOC) Volt.App.openSample();
        while (!Volt.App.currentDoc || !Volt.App.pageDims.length) await new Promise((r) => setTimeout(r, 200));
        // calibration: a hidden element whose display is forced to something
        // else must be flagged by the probe. An inline style with !important
        // outranks ANY author stylesheet rule (even a future, higher-specificity
        // [hidden] selector), so this stays a meaningful probe no matter how the
        // hiding rule evolves.
        const calibEl = document.createElement("div");
        calibEl.hidden = true;
        calibEl.style.setProperty("display", "block", "important");
        document.body.appendChild(calibEl);
        hiddenProbe.calibration = {
          caught: checkHidden(calibEl) !== null, // the probe flagged the broken element
        };
        calibEl.remove();
        probeHidden("boot");
        // ── inverse contract: viewer-critical elements must stay VISIBLE ─
        // the hidden probe guards display:none for [hidden] elements; its
        // mirror guards the opposite: a fixed set of elements the viewer
        // structurally depends on (the shell, scroll container, pages, toolbar
        // and status bar) must NOT compute display:none while a document is
        // open — a future rule hiding any of them (a display:none !important
        // on #app, #pages, the toolbar…) silently blanks the whole UI. A
        // calibration element hidden with an important rule must be flagged
        // by the same check, so the probe can't vacuously pass.
        const VISIBLE_IDS = ["app", "toolbar", "main", "viewer", "scroller", "pages", "statusbar",
          "sb-file", "sb-page", "sb-zoom",
          "btn-brand", "btn-view", "btn-tools", "btn-markup", "btn-sidebar", "btn-ai", "btn-settings", "btn-help"];
        const visibleProbe = {};
        const checkVisible = (el) => {
          const d = getComputedStyle(el).display;
          return d === "none" ? { id: el.id || "", tag: el.tagName.toLowerCase(), display: d } : null;
        };
        const probeVisible = (label) => {
          const els = [];
          const violations = [];
          // the ROOT elements have no ids — and getComputedStyle returns an
          // element's OWN display, so a rule hiding body/html blanks the whole
          // viewer while every id'd element still computes flex/block. The id
          // list alone can never catch that, so the roots are checked first.
          for (const root of [document.documentElement, document.body]) {
            els.push(root);
            const v = checkVisible(root);
            if (v) violations.push(v);
          }
          for (const id of VISIBLE_IDS) {
            const el = document.getElementById(id);
            if (!el) { violations.push({ id, missing: true }); continue; }
            els.push(el);
            const v = checkVisible(el);
            if (v) violations.push(v);
          }
          visibleProbe[label] = { checked: els.length, violations: violations.slice(0, 8), pass: violations.length === 0 && els.length > 0 };
        };
        const calibVisibleEl = document.createElement("div");
        calibVisibleEl.id = "calib-visible";
        calibVisibleEl.style.setProperty("display", "none", "important");
        document.body.appendChild(calibVisibleEl);
        visibleProbe.calibration = { caught: checkVisible(calibVisibleEl) !== null };
        calibVisibleEl.remove();
        probeVisible("boot");
        // ── service-worker cache contract ────────────────────
        // fetch the /sw.js a static deployment would serve (the embedded server
        // reads it straight from disk) and assert its CACHE constant equals the
        // cache name the shell computed from the CURRENT files. A stale
        // checked-in sw.js — an asset edited but the derived artifact never
        // regenerated — fails here instead of silently precaching old files
        // under an old name. The regex also proves the file parses as the
        // generator's artifact (a missing CACHE line fails, not just a mismatch).
        const swCache = { error: SW_GEN_ERR, expected: EXPECT_SW_CACHE };
        try {
          const swRes = await fetch("/sw.js");
          swCache.fetchOk = swRes.ok && swRes.status === 200;
          const swText = await swRes.text();
          // lenient regex (\s escaped for the outer template literal) — survives
          // cosmetic formatting drift in the generator
          const m = /const\\s+CACHE\\s*=\\s*"([^"]+)"/.exec(swText);
          swCache.parsed = !!m;
          swCache.served = m ? m[1] : null;
          swCache.matches = !!m && m[1] === EXPECT_SW_CACHE;
        } catch (e) { swCache.error = String((e && e.message) || e); }
        swCache.allOk = swCache.fetchOk === true && swCache.parsed === true &&
          swCache.matches === true && !swCache.error;
        // ── index.html asset-stamp contract (?v= HTTP-cache busting) ─
        // every external script / stylesheet / module-import in the served
        // index.html must carry ?v=<hash> of its CURRENT file contents, so the
        // browser's plain HTTP cache drops stale JS even with no service worker.
        // A stale checked-in index.html (asset edited, stamps never regenerated)
        // fails here: the served stamps must equal what the shell computed from
        // the files on disk (EXPECT_STAMPS).
        const htmlCache = { error: SW_GEN_ERR, expected: EXPECT_STAMPS };
        try {
          const hRes = await fetch("/");
          htmlCache.fetchOk = hRes.ok && hRes.status === 200;
          const html = await hRes.text();
          const pairs = [];
          // ?v=abc12345 → { path, v } (v without the "v=" prefix)
          const stampOf = (full) => { const parts = full.split("?"); return { path: parts[0], v: parts[1] ? parts[1].replace(/^v=/, "") : null }; };
          const tagRe = /<(script|link)\\b[^>]*>/g;
          let tm;
          while ((tm = tagRe.exec(html))) {
            const tag = tm[0];
            if (tm[1] === "script") {
              const s = /\\bsrc="([^"]+)"/.exec(tag);
              if (s) pairs.push(stampOf(s[1]));
            } else if (/\\brel="stylesheet"/.test(tag)) {
              const h = /\\bhref="([^"]+)"/.exec(tag);
              if (h) pairs.push(stampOf(h[1]));
            }
          }
          // the pdf.js module-import specifier (import ... from "./vendor/pdf.min.mjs")
          const impRe = /from\\s+["']([^"']+)["']/g;
          let im;
          while ((im = impRe.exec(html))) pairs.push(stampOf(im[1]));
          htmlCache.count = pairs.length;
          htmlCache.expectedCount = Object.keys(EXPECT_STAMPS).length;
          htmlCache.allStamped = pairs.length === htmlCache.expectedCount &&
            pairs.every((p) => p.v !== null);
          htmlCache.allMatch = pairs.every((p) =>
            EXPECT_STAMPS[p.path] !== undefined && p.v === EXPECT_STAMPS[p.path]);
          htmlCache.covered = Object.keys(EXPECT_STAMPS).every((k) =>
            pairs.some((p) => p.path === k));
          htmlCache.pairs = pairs;
        } catch (e) { htmlCache.error = String((e && e.message) || e); }
        htmlCache.allOk = htmlCache.fetchOk === true && htmlCache.allStamped === true &&
          htmlCache.allMatch === true && htmlCache.covered === true && !htmlCache.error;
        // ── version-ready banner (stale-bundle guard) ─────────
        // a running window can be stale while the files on disk moved on (the
        // desktop app's single-instance lock focuses the OLD process on a
        // re-launch — the recurring "I restarted but still see the old
        // behavior" — and a PWA can serve a cached bundle). Assert: the
        // banner exists and starts hidden; a fresh check against the REAL
        // served sw.js (which matches the installed cache) keeps it hidden;
        // a staged mismatch surfaces it; the Restart button routes through
        // the app's restart path (stubbed — the probe must not relaunch
        // itself); Dismiss hides it and persists per-version so the same
        // version never nags, while a NEWER hash shows the bar again.
        const verBanner = { error: null };
        try {
          const vb = document.getElementById("ver-banner");
          const vRestart = document.getElementById("ver-restart");
          const vDismiss = document.getElementById("ver-dismiss");
          verBanner.present = !!vb && !!vRestart && !!vDismiss;
          verBanner.hiddenBoot = !!vb && vb.hidden === true && getComputedStyle(vb).display === "none";
          await Volt.App._checkNewVersion();
          await new Promise((r) => setTimeout(r, 300));
          verBanner.freshHidden = !!vb && vb.hidden === true;
          Volt.App._showVersionBanner("volt-probe-stale");
          verBanner.shownStale = !!vb && vb.hidden === false;
          let restarted = false;
          const realRestart = Volt.App._restartApp;
          Volt.App._restartApp = () => { restarted = true; };
          try { vRestart.click(); } finally { Volt.App._restartApp = realRestart; }
          verBanner.restartCalls = restarted;
          vDismiss.click();
          verBanner.dismissed = !!vb && vb.hidden === true &&
            localStorage.getItem("volt:ver:dismiss:volt-probe-stale") === "1";
          Volt.App._showVersionBanner("volt-probe-stale");
          verBanner.noNag = !!vb && vb.hidden === true;
          Volt.App._showVersionBanner("volt-probe-stale-2");
          verBanner.newHashShows = !!vb && vb.hidden === false;
          Volt.App._hideVersionBanner();
          // -- what's-new tooltip (pending-update changelog) ----------
          // the banner shows a hover tooltip with the CHANGELOG sections the
          // pending version introduces. Assert: the tooltip element exists and
          // starts hidden; the REAL served CHANGELOG.md carries the current
          // version's section (so a release that forgets its changelog entry
          // fails the smoke); and with fetch stubbed to a fixture, a pending
          // NEWER version renders exactly its own section (the installed
          // version's entries are excluded).
          const vTip = document.getElementById("ver-tip");
          verBanner.verTipPresent = !!vTip && vTip.hidden === true && getComputedStyle(vTip).display === "none";
          const realMd = await fetch("CHANGELOG.md?_t=" + Date.now())
            .then((r) => (r.ok ? r.text() : "")).catch(() => "");
          verBanner.changelogServed = realMd.includes("## " + EXPECT_VERSION);
          const realFetch = window.fetch;
          // String.fromCharCode(10) not a backslash-n escape — this whole
          // probe is a template literal in main.js, so an escape sequence
          // would collapse to a real newline and break the string literal
          const NL10 = String.fromCharCode(10);
          const FIXTURE = "## 1.0.0" + NL10 + "- old stuff (installed)" + NL10 + "## 1.1.0" + NL10 + "- brand new feature" + NL10;
          window.fetch = (url, opts) => String(url).includes("CHANGELOG.md")
            ? Promise.resolve({ ok: true, text: () => Promise.resolve(FIXTURE) })
            : realFetch(url, opts);
          try {
            Volt.App._showVersionBanner("volt-probe-stale-2", "1.1.0");
            await new Promise((r) => setTimeout(r, 60));
            const tipHtml = (Volt.App._verChangelogHtml || "");
            verBanner.changelogDiff = tipHtml.includes("brand new feature") && !tipHtml.includes("old stuff") &&
              !!vTip && vTip.innerHTML.includes("brand new feature");
            vb.dispatchEvent(new MouseEvent("mouseenter"));
            verBanner.verTipHover = !!vTip && vTip.hidden === false;
            vb.dispatchEvent(new MouseEvent("mouseleave"));
            verBanner.verTipLeaves = !!vTip && vTip.hidden === true;
          } finally {
            window.fetch = realFetch;
            Volt.App._hideVersionBanner();
          }
          // ── auto-restart countdown ────────────────────────
          // showing the banner starts a countdown that restarts Volt on its
          // own, once. Cancel stops it and keeps the banner in manual mode;
          // the 'never auto-restart' setting suppresses it entirely; and
          // running the countdown to zero calls the restart path exactly
          // once. Drive the real path with the seconds forced to 1.
          const vCancel = document.getElementById("ver-cancel");
          verBanner.cancelPresent = !!vCancel;
          Volt.App._verManual = {};
          Volt.App._showVersionBanner("volt-probe-auto1");
          verBanner.autoCountdown = !!Volt.App._verTimer && Volt.App._verCountdown > 0 &&
            document.getElementById("ver-banner-text").textContent.includes("restarting in");
          if (vCancel) vCancel.click();
          verBanner.cancelStopped = !Volt.App._verTimer && !!vb && vb.hidden === false &&
            document.getElementById("ver-restart").textContent === "Restart now";
          // 'never auto-restart' in settings suppresses the countdown
          const savedAi = localStorage.getItem("volt:ai:settings");
          const aiS = JSON.parse(savedAi || "{}");
          aiS.noAutoRestart = true;
          localStorage.setItem("volt:ai:settings", JSON.stringify(aiS));
          Volt.App._showVersionBanner("volt-probe-auto2");
          verBanner.neverAuto = !Volt.App._verTimer && !!vb && vb.hidden === false;
          Volt.App._hideVersionBanner();
          delete aiS.noAutoRestart;
          localStorage.setItem("volt:ai:settings", JSON.stringify(aiS));
          // countdown to zero → the restart path fires exactly once
          let autoRestarts = 0;
          const realRestart2 = Volt.App._restartApp;
          Volt.App._restartApp = () => { autoRestarts++; };
          try {
            Volt.App._showVersionBanner("volt-probe-auto3");
            Volt.App._verCountdown = 1; // one tick away from zero
            await new Promise((r) => setTimeout(r, 1300));
            verBanner.autoFired = autoRestarts === 1 && !Volt.App._verTimer;
          } finally { Volt.App._restartApp = realRestart2; }
          Volt.App._hideVersionBanner();
          localStorage.removeItem("volt:ver:dismiss:volt-probe-stale");
          localStorage.removeItem("volt:ver:dismiss:volt-probe-stale-2");
          Volt.App._verManual = {};
          delete Volt.App._verServed;
        } catch (e) { verBanner.error = String((e && e.message) || e); }
        verBanner.allOk = verBanner.present === true && verBanner.hiddenBoot === true &&
          verBanner.freshHidden === true && verBanner.shownStale === true &&
          verBanner.restartCalls === true && verBanner.dismissed === true &&
          verBanner.noNag === true && verBanner.newHashShows === true &&
          verBanner.cancelPresent === true && verBanner.autoCountdown === true &&
          verBanner.cancelStopped === true && verBanner.neverAuto === true &&
          verBanner.autoFired === true &&
          verBanner.verTipPresent === true && verBanner.changelogServed === true &&
          verBanner.changelogDiff === true && verBanner.verTipHover === true &&
          verBanner.verTipLeaves === true && !verBanner.error;
        // ── document fingerprint (backup matching) ────────────
        // every open document gets a content fingerprint (hash of sampled page
        // text) so Restore backup can match a renamed copy and reject a doctored
        // same-size file. Poll until the async computation lands, then verify it
        // by recomputing from the same sample pages, and check it is stable
        // across a re-run (a race would break the renamed-copy guarantee).
        const fpStage = { error: null };
        let stored = null; // hoisted: the match assertions below read it too
        try {
          const ft0 = Date.now();
          while (Date.now() - ft0 < 8000 && !(Volt.App.currentDocInfo && Volt.App.currentDocInfo.fingerprint)) {
            await new Promise((r) => setTimeout(r, 200));
          }
          stored = (Volt.App.currentDocInfo && Volt.App.currentDocInfo.fingerprint) || null;
          fpStage.shape = typeof stored === "string" && /^[0-9a-f]{16}$/.test(stored);
          const np = Volt.App.currentDoc.numPages;
          const nums = [];
          if (np >= 1) nums.push(1);
          if (np >= 3) nums.push(Math.max(2, Math.round(np / 2)));
          if (np >= 2 && !nums.includes(np)) nums.push(np);
          let text = "";
          for (const n of nums) {
            const p = await Volt.App.currentDoc.getPage(n);
            text += (await p.getTextContent()).items.map((i) => i.str || "").join(" ");
          }
          const expected = Utils.fp64(Utils.fpNormalize(text));
          fpStage.matchesRecompute = stored === expected;
          const again = await Volt.App._computeDocFingerprint();
          fpStage.stableAcrossReopen = again === stored;
        } catch (e) { fpStage.error = String((e && e.message) || e); }
        // the matching DECISION is the point of the fingerprint — assert the
        // two behaviors the feature exists for: a renamed copy matches (name
        // ignored), a doctored same-size file is rejected
        fpStage.match = { error: null };
        try {
          const name = Volt.App.currentDocInfo.name;
          fpStage.match.renamedCopyMatches = Volt.App._matchesBackup(
            { file: "renamed.pdf", fileSize: Volt.App.currentDocInfo.size, filePages: Volt.App.currentDocInfo.pages, fileFingerprint: stored },
            "renamed.pdf", name) === true;
          fpStage.match.doctoredSameSizeRejected = Volt.App._matchesBackup(
            { file: name, fileSize: Volt.App.currentDocInfo.size, filePages: Volt.App.currentDocInfo.pages, fileFingerprint: Utils.fp64(Utils.fpNormalize("doctored content")) },
            name, name) === false;
        } catch (e) { fpStage.match.error = String((e && e.message) || e); }
        fpStage.allOk = fpStage.shape === true && fpStage.matchesRecompute === true &&
          fpStage.stableAcrossReopen === true && !fpStage.error &&
          fpStage.match && !fpStage.match.error &&
          fpStage.match.renamedCopyMatches === true && fpStage.match.doctoredSameSizeRejected === true;
        const page = await Volt.App.currentDoc.getPage(1);
        const vp = page.getViewport({ scale: 1 });
        await T("textContent", async () => ({ items: (await page.getTextContent()).items.length }));
        await T("textLayer", async () => {
          const box = document.createElement("div");
          box.style.cssText = "position:absolute;left:-9999px;width:" + vp.width + "px;height:" + vp.height + "px";
          document.body.appendChild(box);
          const layer = new pdfjsLib.TextLayer({ textContentSource: await page.getTextContent(), container: box, viewport: vp });
          await layer.render();
          return { spans: box.querySelectorAll("span").length };
        });
        await T("pageRender", async () => {
          const c = document.createElement("canvas");
          c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
          document.body.appendChild(c);
          const task = page.render({ canvasContext: c.getContext("2d"), viewport: vp });
          const resolved = await race(task.promise.then(() => true, () => false), 8000);
          return { resolved, painted: resolved === true && c.getContext("2d").getImageData(Math.floor(vp.width / 2), Math.floor(vp.height / 2), 1, 1).data[3] > 0 };
        });
        const t0 = Date.now();
        let modal = { error: null };
        while (Date.now() - t0 < 20000) {
          const wraps = document.querySelectorAll(".page-wrap").length;
          const textSpans = document.querySelectorAll(".page-text-layer span").length;
          const docName = document.getElementById("sb-file").textContent;
          if (wraps >= 1 && textSpans > 0 && (!EXPECT_DOC || docName === EXPECT_DOC)) {
            // ── modal focus trap ─────────────────────────────────
            // open the settings modal from a focused toolbar button and check:
            // focus lands inside the modal, Tab/Shift+Tab cycle within it,
            // Shift+? is ignored while it's open, Escape closes it, and focus
            // returns to the opener with the app UI no longer inert
            try {
              const opener = document.getElementById("btn-help");
              opener.focus();
              Volt.App._openModal(Volt.App.elements.settingsModal);
              const sm = Volt.App.elements.settingsModal;
              const foc = Volt.App._focusablesIn(sm);
              modal.openedFocus = document.activeElement === foc[0] ? foc[0].id || foc[0].tagName : null;
              document.dispatchEvent(new KeyboardEvent("keydown", { key: "?", bubbles: true, cancelable: true, shiftKey: true }));
              modal.shiftQuestionIgnored = Volt.App.elements.helpModal.hidden === true;
              // drive the wrap-around purely through the trap (focus starts on
              // foc[0] after _openModal; never call .focus() while #app is inert)
              if (foc.length >= 2) {
                document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true, shiftKey: true }));
                modal.shiftTabWrappedToLast = document.activeElement === foc[foc.length - 1];
                document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
                modal.tabWrappedToFirst = document.activeElement === foc[0];
              }
              document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
              modal.escapeClosed = sm.hidden === true;
              modal.focusRestored = document.activeElement === opener;
              modal.inertCleared = Volt.App.elements.app.inert === false;
              modal.focusableCount = foc.length; // for diagnosing allOk when the modal has <2 focusables
            } catch (e) { modal.error = String((e && e.message) || e); }
            // ── file-change watcher ─────────────────────────────
            // bridge shape must exist, and the functional loop must hold:
            // open the temp copy by path → watch it → (main touches the file
            // once __voltWatchReady flips) → the reload banner appears →
            // "Reload now" clears the offer and the doc is still loaded
            const watch = {};
            if (window.voltDesktop && typeof window.voltDesktop.watchFile === "function") {
              try {
                watch.bridge = typeof window.voltDesktop.unwatchFile === "function" &&
                  typeof window.voltDesktop.onFileChanged === "function";
                if (WATCH_TMP_PATH) {
                  Volt.App.openPath(WATCH_TMP_PATH);
                  const wt0 = Date.now();
                  while (Date.now() - wt0 < 8000 &&
                         !(Volt.App.currentDocInfo && Volt.App.currentDocInfo.name === WATCH_TMP)) {
                    await new Promise((r) => setTimeout(r, 200));
                  }
                  watch.opened = !!(Volt.App.currentDocInfo && Volt.App.currentDocInfo.name === WATCH_TMP);
                  await window.voltDesktop.watchFile(WATCH_TMP_PATH);
                  window.__voltWatchReady = true; // main now rewrites the file
                  const banner = document.getElementById("reload-banner");
                  const wt1 = Date.now();
                  while (Date.now() - wt1 < 8000 && banner.hidden) await new Promise((r) => setTimeout(r, 200));
                  watch.bannerShown = banner.hidden === false;
                  if (watch.bannerShown) {
                    document.getElementById("reload-now").click();
                    const wt2 = Date.now();
                    while (Date.now() - wt2 < 8000 && !banner.hidden) await new Promise((r) => setTimeout(r, 200));
                    watch.offerCleared = banner.hidden === true;
                    watch.reloaded = !!Volt.App.currentDoc;
                    watch.bannerMsg = banner.querySelector(".reload-msg").textContent;
                  }
                  await window.voltDesktop.unwatchFile();
                  // back to the sample so the rest of the probe holds (guarded:
                  // a hung openSample must never hang the whole smoke)
                  Volt.App.openSample();
                  const wt3 = Date.now();
                  while (Date.now() - wt3 < 8000 &&
                         (!Volt.App.currentDocInfo || Volt.App.currentDocInfo.name !== "The Quiet Engine — sample.pdf")) {
                    await new Promise((r) => setTimeout(r, 200));
                  }
                }
              } catch (e) { watch.error = String((e && e.message) || e); }
              // when no temp file could be prepared the functional loop is
              // skipped entirely — the stage degrades to a bridge-shape check
              // (a temp-dir failure must not fail the whole smoke)
              watch.allOk = WATCH_TMP_PATH
                ? watch.bridge === true && watch.opened === true && watch.bannerShown === true &&
                  watch.offerCleared === true && watch.reloaded === true && !watch.error
                : watch.bridge === true && !watch.error;
            } else {
              watch.allOk = true; // browser mode — no bridge, nothing to watch
            }
            // ── post-restore summary card ──────────────────────
            // a backup restore must surface the summary card (which replaced
            // the old one-line toast) with the counts that landed — and it
            // must auto-dismiss after a few seconds, not linger
            const rs = { error: null };
            try {
              const list = Volt.Ann.list;
              const json = JSON.stringify({ app: "volt", version: 5, file: Volt.App.currentDocInfo.name,
                fileSize: Volt.App.currentDocInfo.size, filePages: Volt.App.currentDocInfo.pages,
                fileFingerprint: Volt.App.currentDocInfo.fingerprint,
                annotations: list,
                aiSettings: { model: "sum-smoke-model", maxContextChars: 900, systemPrompt: "Summary smoke prompt." },
                chatHistory: [{ role: "user", content: "hi" }, { role: "assistant", content: "hello", sources: [], error: false }] });
              await Volt.App._restoreBackup(new File([json], "backup.json"));
              const rsEl = document.getElementById("restore-summary");
              const rs0 = Date.now();
              while (Date.now() - rs0 < 8000 && rsEl.hidden) await new Promise((r) => setTimeout(r, 100));
              const body = rsEl.querySelector(".rs-body").textContent;
              rs.shown = rsEl.hidden === false;
              rs.bodyHasCount = body.includes(list.length + " annotation");
              // assert the override ROW rendered with model + a context value.
              // The exact digit string is locale-fragile (the settings clamp
              // floors context at 1000, so any value ≥ 1000 gets a grouping
              // separator that differs per locale) — presence checks only
              rs.bodyHasOverride = body.includes("sum-smoke-model") &&
                body.includes("Context:") && body.includes("chars");
              rs.bodyHasChat = body.includes("2 messages");
              const rs1 = Date.now();
              // the card auto-dismisses at exactly 8s — a ~10s bound (not 12)
              // trims the worst case against the 60s smoke watchdog
              while (Date.now() - rs1 < 10000 && !rsEl.hidden) await new Promise((r) => setTimeout(r, 200));
              rs.autoDismissed = rsEl.hidden === true;
            } catch (e) { rs.error = String((e && e.message) || e); }
            rs.allOk = rs.shown === true && rs.bodyHasCount === true && rs.bodyHasOverride === true &&
              rs.bodyHasChat === true && rs.autoDismissed === true && !rs.error;
            // ── restore by URL ─────────────────────────────────
            // a fetched backup must run the SAME match-and-open flow as a
            // picked file: drive the URL modal in backup mode with a blob:
            // URL (same-origin, so fetch works with no CORS) and assert the
            // summary card lands with the fetched backup's model
            const rurl = { error: null };
            try {
              const list = Volt.Ann.list;
              const json = JSON.stringify({ app: "volt", version: 5, file: Volt.App.currentDocInfo.name,
                fileSize: Volt.App.currentDocInfo.size, filePages: Volt.App.currentDocInfo.pages,
                fileFingerprint: Volt.App.currentDocInfo.fingerprint,
                annotations: list, aiSettings: { model: "url-smoke-model", maxContextChars: 900, systemPrompt: "URL smoke prompt." },
                chatHistory: [] });
              const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
              Volt.App._openUrlModal("backup");
              Volt.App.elements.urlInput.value = url;
              await Volt.App._submitUrl();
              const rsEl = document.getElementById("restore-summary");
              const ru0 = Date.now();
              while (Date.now() - ru0 < 8000 && rsEl.hidden) await new Promise((r) => setTimeout(r, 100));
              const body = rsEl.querySelector(".rs-body").textContent;
              rurl.cardShown = rsEl.hidden === false;
              rurl.carriedModel = body.includes("url-smoke-model");
              rurl.urlModalClosed = document.getElementById("url-modal").hidden === true;
              URL.revokeObjectURL(url);
              Volt.App._hideRestoreSummary(); // skip the 8s auto-dismiss — the summary stage already covers it
              // negative: a non-backup body must toast the raw-link hint and
              // never import — then close the modal so the keyboard stage
              // (which opens the settings modal) isn't blocked by it
              const badUrl = URL.createObjectURL(new Blob(["<html>nope</html>"], { type: "text/html" }));
              Volt.App.elements.urlInput.value = badUrl;
              Volt.App._submitUrl();
              const rb0 = Date.now();
              while (Date.now() - rb0 < 4000 &&
                     ![...document.querySelectorAll(".toast")].some((t) => t.textContent.includes("raw/plain"))) {
                await new Promise((r) => setTimeout(r, 100));
              }
              rurl.badUrlHint = [...document.querySelectorAll(".toast")].some((t) => t.textContent.includes("raw/plain"));
              URL.revokeObjectURL(badUrl);
              Volt.App._closeModal(document.getElementById("url-modal"));
            } catch (e) { rurl.error = String((e && e.message) || e); }
            rurl.allOk = rurl.cardShown === true && rurl.carriedModel === true &&
              rurl.urlModalClosed === true && rurl.badUrlHint === true && !rurl.error;
            // ── text-highlight select-mode editing ─────────────────
            // underline/strike (quads) highlights get the area-style edit box
            // in select mode — but no resize handles: the move drag snaps the
            // quads to the nearest text line on release. Assert: click-select
            // shows a dashed handle-less box, a drag to an adjacent line
            // rebuilds the quads onto a real text line (x never widened), the
            // box re-glues, and undo restores the original geometry.
            const tlMove = { error: null };
            let l1 = null; // hoisted: tlMove.allOk below reads it (second text line, or null)
            try {
              const Ann = Volt.Ann;
              const wrap = [...document.querySelectorAll(".page-wrap")][0];
              const spans = [...wrap.querySelectorAll(".page-text-layer span")].filter((s) => s.textContent.trim());
              if (!spans.length) throw new Error("no text spans for the text-highlight move stage");
              const wrect = wrap.getBoundingClientRect();
              const spanRects = [];
              for (const s of spans) {
                const r = s.getBoundingClientRect();
                spanRects.push({ x1: r.left - wrect.left, y1: r.top - wrect.top, x2: r.left - wrect.left + r.width, y2: r.top - wrect.top + r.height });
              }
              const lines0 = Ann._groupSpansIntoLines(spanRects);
              const l0 = lines0[0];
              l1 = lines0[1] || null; // null = single-line page (degenerate: snap back to the same line)
              const PAD = 0.75;
              const quadOf = (ln) => {
                const tl = Ann._localToPdf(wrap, ln.x1 - PAD, ln.y1 - PAD);
                const tr = Ann._localToPdf(wrap, ln.x2 + PAD, ln.y1 - PAD);
                const br = Ann._localToPdf(wrap, ln.x2 + PAD, ln.y2 + PAD);
                const bl = Ann._localToPdf(wrap, ln.x1 - PAD, ln.y2 + PAD);
                return [{ x: tl[0], y: tl[1] }, { x: tr[0], y: tr[1] }, { x: br[0], y: br[1] }, { x: bl[0], y: bl[1] }];
              };
              const origQuad = quadOf(l0);
              const ann = { id: Utils.uid(), type: "underline", page: Number(wrap.dataset.page),
                quads: [origQuad], text: "smoke underline", color: "#4cc9f0", createdAt: Date.now() };
              Ann._mutate(() => { Ann.list.push(ann); });
              const cy0 = (l0.y1 + l0.y2) / 2;
              const cy1 = l1 ? (l1.y1 + l1.y2) / 2 : cy0 + 30; // single line: drag down ~30px, snap must return
              const cx = (l0.x1 + l0.x2) / 2;
              const mk = (x, y) => ({ clientX: x + wrect.left, clientY: y + wrect.top, preventDefault() {} });
              Ann._selectArea(ann.id, wrap);
              tlMove.boxShown = !!Ann._selectionBox;
              tlMove.noHandles = Ann._selectionBox ? Ann._selectionBox.el.querySelectorAll(".area-handle").length === 0 : false;
              tlMove.dashedBox = Ann._selectionBox ? Ann._selectionBox.el.classList.contains("is-quads") : false;
              const topBefore = Ann._selectionBox ? parseFloat(Ann._selectionBox.el.style.top) : 0;
              Ann._beginEditDrag(mk(cx, cy0), wrap, "move", null);
              Ann._moveEditDrag(mk(cx, cy0 + (cy1 - cy0)));
              tlMove.boxFollowed = Ann._selectionBox ? Math.abs(parseFloat(Ann._selectionBox.el.style.top) - topBefore) > 1 : false;
              Ann._endEditDrag(true);
              const moved = Ann.list.find((a) => a.id === ann.id);
              const qCy = (q) => (Math.min(...q.map((p) => p.y)) + Math.max(...q.map((p) => p.y))) / 2;
              const movedCy = moved ? qCy(moved.quads[0]) : NaN;
              tlMove.yChanged = !!l1 && Math.abs(movedCy - qCy(origQuad)) > 0.5;
              // the moved quad's y-center must sit on a REAL text line (the
              // snap runs in local coords, so compare against the local index)
              const linesNow = Ann._lineIndexLocal(wrap);
              let lmy1 = Infinity, lmy2 = -Infinity;
              for (const p of moved.quads[0]) { const l = Ann._pdfToLocal(wrap, p.x, p.y); if (l.y < lmy1) lmy1 = l.y; if (l.y > lmy2) lmy2 = l.y; }
              const movedCyLocal = (lmy1 + lmy2) / 2;
              tlMove.snappedToLine = linesNow.some((ln) => movedCyLocal >= ln.y1 - 1.5 && movedCyLocal <= ln.y2 + 1.5);
              // the horizontal extent must never widen past the original
              const xW = (q) => Math.max(...q.map((p) => p.x)) - Math.min(...q.map((p) => p.x));
              const xL = (q) => Math.min(...q.map((p) => p.x));
              tlMove.xKept = moved && xL(moved.quads[0]) >= xL(origQuad) - 0.75 &&
                xW(moved.quads[0]) <= xW(origQuad) + 0.75;
              const topAfter = Ann._selectionBox ? parseFloat(Ann._selectionBox.el.style.top) : 0;
              tlMove.boxReglued = !l1 || Math.abs(topAfter - topBefore) > 1;
              Ann.undo(); // pops the move — the original geometry must come back
              const undone = Ann.list.find((a) => a.id === ann.id);
              tlMove.undoRestores = !!undone && Math.abs(qCy(undone.quads[0]) - qCy(origQuad)) < 0.01;
              // rotation regression guard: R must actually rotate (a _docReady
              // rotDelta reset once made it a silent no-op) and round-trip
              const rot0 = Volt.App.getViewportForPage(1) ? Volt.App.getViewportForPage(1).rotation : 0;
              Volt.App.rotate();
              // the 1-page sample re-renders in well under a second — a 3s cap
              // keeps the worst-case rotate-back waits inside the 60s watchdog
              const rt0 = Date.now();
              while (Date.now() - rt0 < 3000 && Volt.App.rendered.size === 0) await new Promise((r) => setTimeout(r, 200));
              tlMove.rotates = Volt.App.getViewportForPage(1) ? Volt.App.getViewportForPage(1).rotation === ((rot0 + 90) % 360) : false;
              // rotate (at most 4 times) back to the starting rotation
              let rtg = 0;
              const waitRender = () => new Promise((res) => { const w0 = Date.now(); (function poll() { if (Volt.App.rendered.size > 0 || Date.now() - w0 > 3000) res(); else setTimeout(poll, 200); })(); });
              do { Volt.App.rotate(); await waitRender(); rtg++; } while (rtg < 4 && (Volt.App.getViewportForPage(1)?.rotation || 0) !== rot0);
              tlMove.rotBack = Volt.App.getViewportForPage(1) ? Volt.App.getViewportForPage(1).rotation === rot0 : false;
            } catch (e) { tlMove.error = String((e && e.message) || e); }
            tlMove.allOk = tlMove.boxShown === true && tlMove.noHandles === true && tlMove.dashedBox === true &&
              tlMove.boxFollowed === true && tlMove.snappedToLine === true && tlMove.xKept === true &&
              tlMove.undoRestores === true && tlMove.boxReglued === true &&
              tlMove.rotates === true && tlMove.rotBack === true &&
              (!l1 || tlMove.yChanged === true) && !tlMove.error;
            // ── line-by-line highlight selection ──────────────────
            // drags must select EXACTLY the lines the cursor crossed. pdf.js
            // span boxes of adjacent lines overlap by a pixel or two (glyph
            // boxes touch), so the old box-vs-box test bled into the neighbor:
            // a one-line drag produced TWO highlights and a 3-line sweep FOUR.
            // Line membership is now by the drag covering a line's CENTER, and
            // the outer edges clip to the drag's endpoints in reading order —
            // a mid-line start no longer extends to the line's left edge.
            const lineSel = { error: null };
            try {
              const Ann = Volt.Ann;
              const wrap = [...document.querySelectorAll(".page-wrap")][0];
              const wrect = wrap.getBoundingClientRect();
              const mk = (x, y) => ({ clientX: x + wrect.left, clientY: y + wrect.top, button: 0, preventDefault() {} });
              const spans = [...wrap.querySelectorAll(".page-text-layer span")].filter((s) => s.textContent.trim());
              if (spans.length < 3) throw new Error("need ≥3 text lines for the lineSel stage");
              const rows = spans.map((s) => {
                const r = s.getBoundingClientRect();
                return { x1: r.left - wrect.left, y1: r.top - wrect.top, x2: r.left - wrect.left + r.width, y2: r.top - wrect.top + r.height };
              });
              rows.sort((a, b) => a.y1 - b.y1);
              const L2 = rows[1], L3 = rows[2], L4 = rows[3] || L3;
              const drag = (x1, y1, x2, y2) => {
                Ann.beginDrag(mk(x1, y1), wrap);
                window.dispatchEvent(new MouseEvent("mousemove", mk(x2, y2)));
                window.dispatchEvent(new MouseEvent("mouseup", mk(x2, y2)));
              };
              const vp1 = Volt.App.getViewportForPage(1);
              const qXs = (ann0) => ann0.quads[0].map((p) => vp1.convertToViewportPoint(p.x, p.y)[0]);
              const annsBefore = Ann.list.length;
              Ann.setMode("highlight");
              // one-line drag across the MIDDLE of line 3 → exactly one quad,
              // clipped to the drag's x-range (the old code grabbed line 2 too)
              drag(250, L3.y1 + 4, 450, L3.y2 - 4);
              const h1 = Ann.list.slice(annsBefore).find((a) => a.type === "highlight" && a.quads);
              lineSel.singleQuad = !!h1 && h1.quads.length === 1;
              const sXs = h1 ? qXs(h1) : [];
              lineSel.singleClipped = !!h1 && Math.min(...sXs) > 245 && Math.min(...sXs) < 260 &&
                Math.max(...sXs) > 445 && Math.max(...sXs) < 460;
              // multi-line sweep line 2 → line 4, full width: exactly 3 quads,
              // the middle one full-width (not clipped), the last ends flush
              drag(L2.x1 + 5, L2.y1 + 4, L4.x2 - 5, L4.y2 - 4);
              const h3 = Ann.list.slice(annsBefore).find((a) => a !== h1 && a.type === "highlight" && a.quads);
              lineSel.multiQuads = !!h3 && h3.quads.length === 3;
              const midXs = h3 ? h3.quads[1].map((p) => vp1.convertToViewportPoint(p.x, p.y)[0]) : [];
              const lastXs = h3 ? h3.quads[2].map((p) => vp1.convertToViewportPoint(p.x, p.y)[0]) : [];
              lineSel.multiMiddleFull = !!h3 && Math.min(...midXs) < L2.x1 + 8 && Math.max(...midXs) > L4.x2 - 8;
              lineSel.multiEndsFlush = !!h3 && Math.max(...lastXs) > L4.x2 - 8;
              // a drag through the interline GAP (span boxes touch here, but
              // no line's center is covered) selects NO text → the area
              // highlight fallback, never a stray text quad
              drag(80, L3.y2 - 2, 400, L4.y1 + 2);
              const hGap = Ann.list.slice(annsBefore).find((a) => a !== h1 && a !== h3 && a.type === "highlight");
              lineSel.gapIsArea = !!hGap && !!hGap.rect && !hGap.quads;
              // ── live drag preview: line-snapped, never a block ────
              // the highlight tool's mid-drag preview must show exactly the
              // lines that will be selected (one block per line) instead of a
              // whole-section rectangle, keep the covered lines lit when the
              // cursor crosses the interline gap (no flash, no size-badge
              // pop), match the created quads, and be removed on mouseup
              Ann.beginDrag(mk(L2.x1 + 10, L2.y1 + 4), wrap);
              window.dispatchEvent(new MouseEvent("mousemove", mk(L4.x2 - 40, L4.y2 - 4)));
              const pv1 = wrap.querySelector(".drag-text-preview");
              lineSel.previewShown = !!pv1;
              lineSel.previewLines = pv1 ? pv1.children.length : 0;
              lineSel.previewNoRect = !wrap.querySelector(".drag-rect");
              lineSel.previewNoBadge = !wrap.querySelector(".area-size-badge");
              // cursor crosses into the L3-L4 gap: the covered lines (2,3)
              // stay lit — nothing flashes, no area fallback appears
              const gapMid = Math.round((L3.y2 + L4.y1) / 2);
              window.dispatchEvent(new MouseEvent("mousemove", mk(300, gapMid)));
              const pv2 = wrap.querySelector(".drag-text-preview");
              lineSel.previewGapKept = !!pv2 && pv2.children.length === 2;
              lineSel.previewGapNoRect = !wrap.querySelector(".drag-rect");
              lineSel.previewGapNoBadge = !wrap.querySelector(".area-size-badge");
              // release in the gap: preview removed, the created highlight
              // has exactly the lines the preview showed (WYSIWYG)
              window.dispatchEvent(new MouseEvent("mouseup", mk(300, gapMid)));
              const hPv = Ann.list.slice(annsBefore).find((a) => a.type === "highlight" && a.quads && a !== h1 && a !== h3 && a !== hGap);
              lineSel.previewCleaned = !wrap.querySelector(".drag-text-preview") && !wrap.querySelector(".drag-rect") && !wrap.querySelector(".area-size-badge");
              lineSel.previewMatches = !!hPv && hPv.quads.length === 2 && pv2 && pv2.children.length === hPv.quads.length;
              // ── low-zoom contract (the scale-factor regression) ─────
              // pdf.js 4.x sizes its spans via the --scale-factor CSS var,
              // which the INTEGRATOR must set on the layer container to the
              // viewport scale. Volt never set it, so the font-size calc was
              // invalid → spans inherited the body's constant 13.5px font
              // while positions still scaled with zoom; at zoom < ~0.8 the
              // adjacent line boxes overlapped by >2px and _groupSpansIntoLines
              // merged two physical lines into one group — a two-line drag
              // highlighted as a single block. Assert the var is set AND that
              // a two-line drag at zoom 0.5 yields two line-shaped quads.
              const layer1 = wrap.querySelector(".page-text-layer");
              const vpScale = vp1 && vp1.scale ? vp1.scale : null;
              lineSel.scaleVarSet = !!layer1 && layer1.style.getPropertyValue("--scale-factor") === String(vpScale);
              const savedZoom = Volt.App.zoom;
              Volt.App.setZoom(0.5);
              for (let i = 0; i < 40; i++) {
                await new Promise((r) => setTimeout(r, 120));
                const w = document.querySelector(".page-wrap");
                if (w && Math.abs(w.getBoundingClientRect().width - 612 * 0.5) < 3) break;
              }
              // the zoom re-render REPLACES the wrap — rebuild the drag helper
              // against the fresh wrap so coordinates stay exact
              const wrapZ = document.querySelector(".page-wrap");
              const wz = wrapZ ? wrapZ.getBoundingClientRect() : null;
              const dragZ = (x1, y1, x2, y2) => {
                Ann.beginDrag({ clientX: x1 + wz.left, clientY: y1 + wz.top, button: 0, preventDefault() {} }, wrapZ);
                window.dispatchEvent(new MouseEvent("mousemove", { clientX: x2 + wz.left, clientY: y2 + wz.top, button: 0 }));
                window.dispatchEvent(new MouseEvent("mouseup", { clientX: x2 + wz.left, clientY: y2 + wz.top, button: 0 }));
              };
              const spansZ = wrapZ ? [...wrapZ.querySelectorAll(".page-text-layer span")].filter((s) => s.textContent.trim()) : [];
              const rowsZ = spansZ.map((s) => {
                const r = s.getBoundingClientRect();
                return { x1: r.left - wz.left, y1: r.top - wz.top, x2: r.left - wz.left + r.width, y2: r.top - wz.top + r.height };
              }).sort((a, b) => a.y1 - b.y1);
              if (rowsZ.length >= 3) {
                const z1 = rowsZ[1], z2 = rowsZ[2], z3 = rowsZ[3] || z2;
                const beforeZ = Ann.list.length;
                // end the drag just past line 2's CENTER (at line 3's top edge)
                // so exactly two line-centers are covered — ending precisely on
                // line 2's center would let a sub-pixel rect drift exclude it
                const zFrom = { x: (z1.x1 + z1.x2) / 2, y: (z1.y1 + z1.y2) / 2 };
                const zTo = { x: (z2.x1 + z2.x2) / 2, y: z3.y1 + 1 };
                dragZ(zFrom.x, zFrom.y, zTo.x, zTo.y);
                const hZ = Ann.list.slice(beforeZ).find((a) => a.type === "highlight" && a.quads);
                lineSel.lowZoomTwoLines = !!hZ && hZ.quads.length === 2;
                lineSel.lowZoomNotMerged = !!hZ && hZ.quads.length === 2 &&
                  (hZ.text || "").split(" ").length >= 8;
                Ann.list = Ann.list.filter((a) => a !== hZ);
              } else {
                lineSel.lowZoomTwoLines = false;
                lineSel.lowZoomNotMerged = false;
              }
              Volt.App.setZoom(savedZoom);
              for (let i = 0; i < 40; i++) {
                await new Promise((r) => setTimeout(r, 120));
                const w = document.querySelector(".page-wrap");
                if (w && Math.abs(w.getBoundingClientRect().width - 612 * savedZoom) < 3) break;
              }
              // ── overlay pixels: the marks must be VISIBLE on screen at the
              // right place (the user-visible contract) — not just stored with
              // correct quads. Sample the page-overlay canvas on a CLEAN page
              // (snapshot the list, drop it, restore after): a fresh highlight
              // must fill the dragged line's center and NOTHING 6px below the
              // quad (an offset highlight paints there instead); a fresh
              // underline must stroke its bottom edge with the cyan color. A
              // future dpr/scale/transform regression breaks this instantly.
              lineSel.renderPx = {};
              try {
                const snap = Ann.list;
                Ann.list = [];
                Ann._afterChange();
                const wrapR = document.querySelector(".page-wrap");
                const wr = wrapR.getBoundingClientRect();
                const vpNow = Volt.App.getViewportForPage(1);
                const ovl = wrapR.querySelector(".page-overlay");
                const octx = ovl.getContext("2d");
                const dprOv = ovl.width / vpNow.width;
                const pxAt = (x, y) => octx.getImageData(Math.round(x * dprOv), Math.round(y * dprOv), 1, 1).data;
                const dragR = (x1, y1, x2, y2) => {
                  Ann.beginDrag({ clientX: x1 + wr.left, clientY: y1 + wr.top, button: 0, preventDefault() {} }, wrapR);
                  window.dispatchEvent(new MouseEvent("mousemove", { clientX: x2 + wr.left, clientY: y2 + wr.top, button: 0 }));
                  window.dispatchEvent(new MouseEvent("mouseup", { clientX: x2 + wr.left, clientY: y2 + wr.top, button: 0 }));
                };
                const spansR = [...wrapR.querySelectorAll(".page-text-layer span")].filter((s) => s.textContent.trim());
                const t = spansR[1].getBoundingClientRect();
                const tx1 = t.left - wr.left, ty = t.top - wr.top, th = t.height;
                const beforeR = Ann.list.length;
                Ann.setMode("highlight");
                dragR(tx1 + 10, ty + th / 2 - 3, tx1 + 150, ty + th / 2 + 3);
                const hR = Ann.list.slice(beforeR).find((a) => a.type === "highlight" && a.quads);
                const dQ = hR ? hR.quads[0].map((p) => Ann._pdfToLocal(wrapR, p.x, p.y)) : null;
                // sample the QUAD's own center (the span is far wider than the
                // drag, so its center lies outside this clipped quad) and the
                // span's line CENTER Y, which the quad must cover
                const qCx = dQ ? (dQ[0].x + dQ[1].x) / 2 : 0;
                const spanCy = ty + th / 2;
                const inFill = dQ ? pxAt(qCx, spanCy)[3] : 0;
                const below = dQ ? pxAt(qCx, dQ[3].y + 6)[3] : 255; // 6px under the quad — must be clear
                lineSel.renderPx.hlCoversSpan = inFill > 60;
                lineSel.renderPx.hlNotOffsetBelow = below < 20;
                // underline: stroke at the quad's bottom edge, cyan, visible
                Ann.setMode("underline");
                const beforeU = Ann.list.length;
                dragR(tx1 + 10, ty + th / 2 - 3, tx1 + 150, ty + th / 2 + 3);
                const uR = Ann.list.slice(beforeU).find((a) => a.type === "underline" && a.quads);
                const uQ = uR ? uR.quads[0].map((p) => Ann._pdfToLocal(wrapR, p.x, p.y)) : null;
                const ux = uQ ? (uQ[0].x + uQ[1].x) / 2 : 0;
                const uy = uQ ? (uQ[3].y + uQ[2].y) / 2 - 0.8 : 0;
                const uv = uQ ? pxAt(ux, uy) : null;
                lineSel.renderPx.ulStrokeVisible = !!uv && uv[3] > 150 && uv[2] > 150 && uv[2] > uv[0];
                Ann.list = snap;
                Ann._afterChange();
              } catch (e) { lineSel.renderPx.error = String((e && e.message) || e); }
              lineSel.renderPx.allOk = lineSel.renderPx.hlCoversSpan === true &&
                lineSel.renderPx.hlNotOffsetBelow === true &&
                lineSel.renderPx.ulStrokeVisible === true && !lineSel.renderPx.error;
              // cleanup: drop this stage's annotations and restore select mode
              Ann.list = Ann.list.filter((a) => a !== h1 && a !== h3 && a !== hGap && a !== hPv);
              Ann._afterChange();
              Ann.setMode("select");
              lineSel.cleaned = true;
            } catch (e) { lineSel.error = String((e && e.message) || e); }
            lineSel.allOk = lineSel.singleQuad === true && lineSel.singleClipped === true &&
              lineSel.multiQuads === true && lineSel.multiMiddleFull === true &&
              lineSel.multiEndsFlush === true && lineSel.gapIsArea === true &&
              lineSel.scaleVarSet === true && lineSel.lowZoomTwoLines === true &&
              lineSel.lowZoomNotMerged === true &&
              lineSel.previewShown === true && lineSel.previewLines === 3 &&
              lineSel.previewNoRect === true && lineSel.previewNoBadge === true &&
              lineSel.previewGapKept === true && lineSel.previewGapNoRect === true && lineSel.previewGapNoBadge === true &&
              lineSel.previewCleaned === true && lineSel.previewMatches === true &&
              lineSel.renderPx.allOk === true &&
              lineSel.cleaned === true && !lineSel.error;
            // ── notes pane deletion ──────────────────────────────
            // deleting a card from the notes pane must remove the annotation
            // AND the card immediately — a lingering card (until a tab
            // switch) reads as "can't delete". Seeded via the same API the
            // pane's own delete button calls (removeById), then re-rendered.
            const notesDel = { error: null };
            try {
              const Ann2 = Volt.Ann;
              const pre = Ann2.list.length;
              const wrapN = document.querySelector(".page-wrap");
              Ann2._addNote(wrapN, { x: 90, y: 300 }, "notesDel-seed");
              await new Promise((r) => setTimeout(r, 150));
              const seeded = Ann2.list.find((a) => a.type === "note" && a.text === "notesDel-seed");
              // open the notes tab so the card exists in the DOM
              const notesTab = [...document.querySelectorAll(".side-tab")].find((t) => t.dataset.tab === "notes");
              if (notesTab) notesTab.click();
              await new Promise((r) => setTimeout(r, 150));
              const card = seeded ? document.querySelector('.note-card[data-id="' + seeded.id + '"]') : null;
              notesDel.cardShown = !!card;
              if (card) {
                const del = card.querySelector(".note-del");
                del.click(); // the pane's own delete button → removeById
                await new Promise((r) => setTimeout(r, 300));
                notesDel.removedFromList = !Ann2.list.some((a) => a.id === seeded.id);
                notesDel.cardGone = !document.querySelector('.note-card[data-id="' + seeded.id + '"]');
              }
              notesDel.countRestored = Ann2.list.length === pre;
              // restore the sidebar to the PAGES tab — the page-manager stages
              // that follow measure #thumb-grid positions, which read as 0s
              // while the notes panel hides them
              const pagesTab = [...document.querySelectorAll(".side-tab")].find((t) => t.dataset.tab === "pages");
              if (pagesTab) pagesTab.click();
              await new Promise((r) => setTimeout(r, 150));
            } catch (e) { notesDel.error = String((e && e.message) || e); }
            notesDel.allOk = notesDel.cardShown === true && notesDel.removedFromList === true &&
              notesDel.cardGone === true && notesDel.countRestored === true && !notesDel.error;
            // ── voice (read-aloud + voice input) and AI tools ─────
            // read-aloud: the shipped engine is the platform's built-in
            // voices (Web Speech API — local, zero download). Headless-safe:
            // we assert the SURFACES and the state machine, not audio. The AI
            // tools (function calling over the PDF) are exercised end-to-end
            // through a FAKE streamed tool_call — the harness must execute the
            // tool, feed the result back, and answer — plus the direct
            // executor for every tool.
            const voice = { error: null };
            try {
              const V = Volt.Voice;
              voice.module = !!V;
              voice.speechSynth = typeof window.speechSynthesis !== "undefined" && !!window.speechSynthesis && typeof SpeechSynthesisUtterance !== "undefined";
              voice.readBtnVisible = !document.getElementById("btn-readaloud").hidden;
              voice.micBtn = !!document.getElementById("ai-mic");
              // read-aloud lifecycle: start on the sample → bar + chunks,
              // stop → bar gone
              const started = await V.startReadAloud(1);
              voice.barShown = !document.getElementById("read-bar").hidden && V.readAloud.active;
              voice.chunks = Array.isArray(V.readAloud.chunks) && V.readAloud.chunks.length > 0;
              // pause/resume return nothing — assert the state machine
              // (paused flag + bar play glyph) after each call instead
              V.pauseReadAloud();
              voice.pauseWorks = V.readAloud.paused === true && document.getElementById("read-play").textContent === "▶";
              V.resumeReadAloud();
              voice.resumeWorks = V.readAloud.paused === false;
              V.stopReadAloud();
              voice.barHidden = document.getElementById("read-bar").hidden === true && V.readAloud.active === false;
              // ── talk mode: the AI-reply speaker + pause/stop/resume ──
              // the toggle in the input row arms speakReplies (same setting
              // the ⚙ modal exposes); while a reply is being spoken the
              // floating talk-bar shows with pause/stop, the play glyph
              // flips to ▶ while paused, and stop hides it. Headless-safe:
              // we assert the surfaces + state machine, not audio.
              const talkOrig = V.settings.speakReplies;
              const talkStored = localStorage.getItem("volt:voice:settings");
              try {
                const talkBtn = document.getElementById("ai-talk");
                voice.talkToggle = !!talkBtn && talkBtn.getAttribute("aria-pressed") === "false";
                V.toggleTalk();
                voice.talkOn = V.settings.speakReplies === true &&
                  talkBtn.getAttribute("aria-pressed") === "true" && talkBtn.classList.contains("on");
                // speakReply with talk on → bar shows, info "Speaking…"
                const spoke = V.speakReply("Hello, this is Volt speaking to you.");
                voice.talkSpoke = spoke === true && V.talk.active === true;
                voice.talkBarShown = document.getElementById("talk-bar").hidden === false &&
                  document.getElementById("talk-info").textContent.indexOf("Speaking") >= 0;
                // pause → paused flag + play glyph ▶ ; resume → back to ⏸
                V.pauseTalk();
                voice.talkPause = V.talk.paused === true && document.getElementById("talk-play").textContent === "▶" &&
                  document.getElementById("talk-info").textContent === "Paused";
                V.resumeTalk();
                voice.talkResume = V.talk.paused === false && document.getElementById("talk-play").textContent === "⏸";
                // stop → active false + bar hidden
                V.stopTalk();
                voice.talkStop = V.talk.active === false && document.getElementById("talk-bar").hidden === true;
                // talk OFF → speakReply is a no-op (no bar, no speech)
                V.toggleTalk();
                voice.talkOff = V.settings.speakReplies === false &&
                  talkBtn.getAttribute("aria-pressed") === "false";
                const silent = V.speakReply("Should not speak.");
                voice.talkSilent = silent === false && V.talk.active === false &&
                  document.getElementById("talk-bar").hidden === true;
                // turning talk OFF mid-speech stops the voice + hides the bar
                V.settings.speakReplies = true;
                V._syncTalkToggle();
                V.speakReply("Interrupt me.");
                V.toggleTalk(); // off while speaking
                voice.talkInterrupts = V.settings.speakReplies === false && V.talk.active === false &&
                  document.getElementById("talk-bar").hidden === true;
              } catch (e) { voice.talkError = String((e && e.message) || e); }
              V.settings.speakReplies = talkOrig;
              if (talkStored) localStorage.setItem("volt:voice:settings", talkStored);
              else localStorage.removeItem("volt:voice:settings");
              V._syncTalkToggle();
              voice.talkAllOk = voice.talkToggle === true && voice.talkOn === true && voice.talkSpoke === true &&
                voice.talkBarShown === true && voice.talkPause === true && voice.talkResume === true &&
                voice.talkStop === true && voice.talkOff === true && voice.talkSilent === true &&
                voice.talkInterrupts === true && !voice.talkError;
              // the voice-input wiring must exist and degrade gracefully —
              // whether Chromium ships speech recognition is informational
              // (some builds don't; the external endpoint covers that)
              voice.sttSurface = typeof V.speechRecAvailable === "function" && typeof V.startListening === "function";
              voice.webSpeechApi = V.speechRecAvailable() === true;
              // ── audio device selection (⚙ → Voice) ─────────────────
              // enumerateDevices + getUserMedia are stubbed (headless has no
              // real devices): the pickers must populate with the fake names,
              // a chosen mic/speaker persists to volt:voice:settings, and the
              // custom-STT path must request THAT exact device through
              // getUserMedia's deviceId constraint (the speaker sink is
              // Chromium's setSinkId on the custom-TTS audio element).
              const devOrigGum = navigator.mediaDevices ? navigator.mediaDevices.getUserMedia : null;
              const devOrigEnum = navigator.mediaDevices ? navigator.mediaDevices.enumerateDevices : null;
              const devStored = localStorage.getItem("volt:voice:settings");
              const devSett = { ...V.settings };
              let devConstraints = null;
              try {
                if (navigator.mediaDevices) {
                  navigator.mediaDevices.getUserMedia = async (c) => {
                    devConstraints = c;
                    const err = new Error("smoke: mic blocked");
                    err.name = "NotAllowedError";
                    throw err;
                  };
                  navigator.mediaDevices.enumerateDevices = async () => [
                    { kind: "audioinput", deviceId: "mic-1", label: "Headset Microphone" },
                    { kind: "audioinput", deviceId: "mic-2", label: "USB Webcam Mic" },
                    { kind: "audiooutput", deviceId: "spk-1", label: "Headphones" },
                    { kind: "audiooutput", deviceId: "spk-2", label: "Desktop Speakers" },
                  ];
                }
                Volt.App._openModal(Volt.App.elements.settingsModal);
                const tDev = Date.now();
                let micSel = null;
                while (Date.now() - tDev < 8000) {
                  micSel = document.getElementById("set-stt-mic");
                  if (micSel && micSel.options.length >= 3) break;
                  await new Promise((r) => setTimeout(r, 100));
                }
                const sinkSel = document.getElementById("set-tts-sink");
                const micTexts = micSel ? [...micSel.options].map((o) => o.textContent) : [];
                const sinkTexts = sinkSel ? [...sinkSel.options].map((o) => o.textContent) : [];
                voice.micListed = !!micSel && micTexts.some((t) => t === "Headset Microphone") &&
                  micTexts.some((t) => t === "USB Webcam Mic");
                voice.sinkListed = !!sinkSel && sinkTexts.some((t) => t === "Headphones") &&
                  sinkTexts.some((t) => t === "Desktop Speakers");
                voice.deviceDefault = !!micSel && micSel.options[0].textContent === "Default microphone";
                if (micSel && sinkSel) {
                  micSel.value = "mic-2";
                  sinkSel.value = "spk-1";
                  V._saveSettings();
                }
                const savedDev = JSON.parse(localStorage.getItem("volt:voice:settings") || "{}");
                voice.micPersisted = savedDev.sttMicId === "mic-2";
                voice.sinkPersisted = savedDev.ttsSinkId === "spk-1";
                // custom STT must request the exact chosen mic
                V.settings.sttEngine = "custom";
                V.settings.sttUrl = "http://localhost:9000/v1";
                await V._startCustomStt();
                voice.micInConstraints = !!devConstraints && !!devConstraints.audio &&
                  typeof devConstraints.audio === "object" && !!devConstraints.audio.deviceId &&
                  devConstraints.audio.deviceId.exact === "mic-2";
                // close the settings modal — later stages open their own
                Volt.App._closeModal(Volt.App.elements.settingsModal);
              } catch (e) { voice.devError = String((e && e.message) || e); }
              if (navigator.mediaDevices) {
                if (devOrigGum) navigator.mediaDevices.getUserMedia = devOrigGum;
                if (devOrigEnum) navigator.mediaDevices.enumerateDevices = devOrigEnum;
              }
              V.settings = devSett;
              if (devStored) localStorage.setItem("volt:voice:settings", devStored);
              else localStorage.removeItem("volt:voice:settings");
              voice.devAllOk = voice.micListed === true && voice.sinkListed === true &&
                voice.deviceDefault === true && voice.micPersisted === true &&
                voice.sinkPersisted === true && voice.micInConstraints === true && !voice.devError;
              // direct executor: every tool returns sane JSON
              const tInfo = JSON.parse(await Volt.AI._runTool("get_document_info", {}));
              voice.toolInfo = tInfo.pages === Volt.App.currentDoc.numPages;
              const tSearch = JSON.parse(await Volt.AI._runTool("search_text", { query: "quiet engine" }));
              voice.toolSearch = tSearch.matches > 0;
              const tHl = JSON.parse(await Volt.AI._runTool("add_highlight", { page: 1, text: "quiet engine" }));
              voice.toolHighlight = tHl.ok === true && Volt.Ann.list.some((a) => a.type === "highlight" && /quiet engine/i.test(a.text || ""));
              const tNote = JSON.parse(await Volt.AI._runTool("add_note", { page: 1, text: "smoke voice note" }));
              voice.toolNote = tNote.ok === true && Volt.Ann.list.some((a) => a.type === "note" && a.text === "smoke voice note");
              const tAnns = JSON.parse(await Volt.AI._runTool("get_annotations", {}));
              voice.toolAnns = tAnns.annotations.length >= 2;
              const tNav = JSON.parse(await Volt.AI._runTool("navigate_to_page", { page: 1 }));
              voice.toolNav = tNav.ok === true;
              // the AI text-edit tool: 'change X to Y' must land a text
              // annotation through the same path as the Text tool, and undo
              // right away (proving the edit is on the user's undo stack)
              const tEdit = JSON.parse(await Volt.AI._runTool("edit_text", { page: 1, find: "quiet engine", replace: "quiet motor" }));
              voice.toolEdit = tEdit.ok === true && Volt.Ann.list.some((a) => a.type === "text" && /quiet motor/.test(a.text || ""));
              Volt.Ann.undo();
              voice.toolEditUndone = tEdit.ok === true && !Volt.Ann.list.some((a) => a.type === "text");
              // a replacement LONGER than the line must wrap: the committed
              // edit carries a wrap layout with the overflow lines' geometry
              const tWrap = JSON.parse(await Volt.AI._runTool("edit_text", { page: 1, find: "quiet engine", replace: "quiet engine with a long replacement phrase that will definitely wrap across several lines on this page" }));
              const wrapAnn = Volt.Ann.list.filter((x) => x.type === "text").pop();
              voice.toolWrap = tWrap.ok === true && !!wrapAnn && Array.isArray(wrapAnn.wrap) && wrapAnn.wrap.length >= 2 && wrapAnn.wrap[1].y < wrapAnn.wrap[0].y;
              Volt.Ann.undo();
              voice.toolWrapUndone = !Volt.Ann.list.some((a) => a.type === "text");
              // ── the tool-call LOOP through a fake streamed response ──
              // the model asks to add_highlight; the harness must execute it,
              // append the tool result to the messages, and stream a final
              // answer (2 request rounds)
              const realFetch = window.fetch;
              const reqBodies = [];
              const sseResp = (chunks) => {
                const enc = new TextEncoder();
                const stream = new ReadableStream({
                  start(controller) {
                    for (const c of chunks) controller.enqueue(enc.encode(c));
                    controller.close();
                  },
                });
                return { ok: true, body: stream };
              };
              window.fetch = async (_url, init) => {
                reqBodies.push(JSON.parse(init.body));
                const n = reqBodies.length;
                if (n === 1) {
                  return sseResp([
                    "data: " + JSON.stringify({ choices: [{ delta: { role: "assistant", content: "" } }] }) + "\\n\\n",
                    "data: " + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_smoke", function: { name: "add_highlight", arguments: "{\\\"page\\\":1,\\\"text\\\":\\\"quiet engine\\\"}" } }] } }] }) + "\\n\\n",
                    "data: [DONE]\\n\\n",
                  ]);
                }
                return sseResp([
                  "data: " + JSON.stringify({ choices: [{ delta: { content: "Done — I highlighted it." } }] }) + "\\n\\n",
                  "data: [DONE]\\n\\n",
                ]);
              };
              const am = { role: "assistant", content: "", sources: [], error: false };
              try {
                await Volt.AI._stream([{ role: "user", content: "highlight quiet engine" }], am);
              } finally {
                // ALWAYS restore the real fetch — if the harness throws, the
                // fake must not leak into later stages (it would corrupt the
                // OCR downloads / fingerprint network calls).
                window.fetch = realFetch;
              }
              voice.toolLoop = am.content.includes("highlighted") && reqBodies.length === 2;
              voice.toolLoopSentTool = !!(reqBodies[0] && Array.isArray(reqBodies[0].tools) && reqBodies[0].tools.length);
              voice.toolLoopResultFed = !!(reqBodies[1] && reqBodies[1].messages.some((m) => m.role === "tool"));
              voice.toolLoopCreated = Volt.Ann.list.some((a) => a.type === "highlight" && /quiet engine/i.test(a.text || ""));
              // cleanup: every AI-created annotation gone, chat message dropped
              const rmAll = JSON.parse(await Volt.AI._runTool("remove_annotations", { type: "all" }));
              voice.toolRemove = rmAll.ok === true && Volt.Ann.list.length === 0;
              Volt.AI.messages = Volt.AI.messages.filter((m) => m !== am);
              voice.cleaned = Volt.Ann.list.length === 0 && document.getElementById("read-bar").hidden === true;
            } catch (e) { voice.error = String((e && e.message) || e); }
            voice.allOk = voice.module === true && voice.speechSynth === true &&
              voice.readBtnVisible === true && voice.micBtn === true &&
              voice.barShown === true && voice.chunks === true &&
              voice.pauseWorks === true && voice.resumeWorks === true &&
              voice.barHidden === true && voice.talkAllOk === true &&
              voice.sttSurface === true && (voice.webSpeechApi === true || voice.webSpeechApi === false) &&
              voice.devAllOk === true &&
              voice.toolInfo === true && voice.toolSearch === true &&
              voice.toolHighlight === true && voice.toolNote === true &&
              voice.toolAnns === true && voice.toolNav === true &&
              voice.toolEdit === true && voice.toolEditUndone === true &&
              voice.toolWrap === true && voice.toolWrapUndone === true &&
              voice.toolLoop === true && voice.toolLoopSentTool === true &&
              voice.toolLoopResultFed === true && voice.toolLoopCreated === true &&
              voice.toolRemove === true && voice.cleaned === true && !voice.error;
            // ── first-run local-LLM bootstrap ─────────────────────
            // while no model is configured the AI panel offers the one-click
            // local setup. All HTTP is stubbed (a smoke can't install
            // Ollama): no-model → card appears + /api/tags probe, the pull of
            // qwen3:4b streams NDJSON progress and is applied as the default,
            // the already-installed path is one click ("Use"), "Not now"
            // persists a skip flag, and a configured model keeps the card
            // hidden. Settings are snapshotted and restored so later stages
            // see the pre-bootstrap configuration.
            const boot = { error: null };
            try {
              const AI = Volt.AI;
              const bootEl = document.getElementById("ai-bootstrap");
              const bootPrimary = document.getElementById("ai-bootstrap-primary");
              const bootDismiss = document.getElementById("ai-bootstrap-dismiss");
              const progEl = document.getElementById("ai-bootstrap-progress");
              const bar = document.getElementById("ai-bootstrap-progress-bar");
              const progLabel = document.getElementById("ai-bootstrap-progress-label");
              const origSettings = JSON.stringify(AI.settings);
              const origStored = localStorage.getItem("volt:ai:settings");
              // CORS probe stub: keep the whole stage hermetic — never hit the
              // real volt:check-ollama-cors IPC (which probes the user's live
              // Ollama) or the frozen contextBridge. Restored in the finally.
              const origProbeCors = AI._probeCors;
              AI._probeCors = async () => null;
              // a previous smoke run may have left per-document AI overrides in
              // the profile — those make configured() true even with the global
              // model cleared, so the bootstrap card (rightly) stays hidden.
              // Snapshot every volt:ai:doc:* key, drop them for the stage, and
              // restore them in the finally below.
              const docKeys = [];
              for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k && k.indexOf("volt:ai:doc:") === 0) docKeys.push([k, localStorage.getItem(k)]);
              }
              for (const pair of docKeys) localStorage.removeItem(pair[0]);
              const realFetch = window.fetch;
              const priorPanelHidden = document.body.classList.contains("ai-hidden");
              let tagsCalls = 0;
              let chatCalls = 0;
              const pullBodies = [];
              // what /api/tags reports — mutable per sub-stage; the auto-detect
              // and bootstrap-card flows decide on it (empty = nothing installed)
              let tagsModels = [];
              // models whose /api/chat verification ping must FAIL — the
              // auto-detect must then fall through to the next-best candidate
              const chatFailFor = new Set();
              const ndjsonStream = (lines) => {
                const enc = new TextEncoder();
                const stream = new ReadableStream({
                  start(controller) {
                    for (const l of lines) controller.enqueue(enc.encode(l + String.fromCharCode(10)));
                    controller.close();
                  },
                });
                return { ok: true, body: stream };
              };
              try {
                // a configured model must keep the card hidden (no nag)
                boot.hiddenWhenConfigured = bootEl.hidden === true;
                // simulate a first run: no model, panel open
                AI.settings = Object.assign({}, AI.settings, { model: "" });
                localStorage.removeItem("volt:ai:settings");
                localStorage.removeItem("volt:ai:bootstrap-skip");
                AI._autoDetected = false; // let the detect pass run (re-entrant)
                window.fetch = async (url, init) => {
                  const u = String(url);
                  if (u.indexOf("/api/tags") >= 0) {
                    tagsCalls += 1;
                    return { ok: true, json: async () => ({ models: tagsModels }) };
                  }
                  if (u.indexOf("/api/chat") >= 0) {
                    // the tiny verification ping — fails for models in chatFailFor
                    chatCalls += 1;
                    const model = (() => { try { return JSON.parse((init && init.body) || "{}").model; } catch (e) { return ""; } })();
                    if (chatFailFor.has(model)) return { ok: false, status: 404, json: async () => ({}) };
                    return { ok: true, json: async () => ({ message: { content: "ok" } }) };
                  }
                  if (u.indexOf("/api/pull") >= 0) {
                    pullBodies.push(JSON.parse(init.body));
                    return ndjsonStream([
                      JSON.stringify({ status: "pulling manifest" }),
                      JSON.stringify({ status: "downloading", completed: 25, total: 100 }),
                      JSON.stringify({ status: "downloading", completed: 60, total: 100 }),
                      JSON.stringify({ status: "success" }),
                    ]);
                  }
                  return realFetch(url, init);
                };
                Volt.App.toggleAI(true); // the card only shows with the panel open

                // ── first-run AUTO-DETECT: adopt the best installed model ──
                // the whole point of the default: no qwen3:4b assumption — the
                // app probes /api/tags, ranks what's there, verifies the top
                // candidate responds, and sets it as the default automatically.
                tagsModels = [{ name: "qwen3:8b" }, { name: "qwen3:4b" }, { name: "llama3.2:3b" }];
                chatFailFor.clear();
                await AI._autoDetectDefault();
                boot.autoBest = AI.settings.model === "qwen3:8b" && AI.settings.provider === "ollama" &&
                  pullBodies.length === 0; // adopted what exists — NO download
                boot.autoPersisted = localStorage.getItem("volt:ai:settings") !== null;
                boot.autoCardHidden = bootEl.hidden === true; // configured now
                // ranking: with only lesser models installed, the best available
                // is chosen (not a fixed qwen3:4b)
                tagsModels = [{ name: "llama3.2:3b" }];
                AI.settings = Object.assign({}, AI.settings, { model: "" });
                localStorage.removeItem("volt:ai:settings");
                AI._autoDetected = false;
                await AI._autoDetectDefault();
                boot.autoRanked = AI.settings.model === "llama3.2:3b";
                // verification: a broken top model is skipped for the next-best
                tagsModels = [{ name: "qwen3:8b" }, { name: "qwen3:4b" }];
                chatFailFor.add("qwen3:8b");
                AI.settings = Object.assign({}, AI.settings, { model: "" });
                localStorage.removeItem("volt:ai:settings");
                AI._autoDetected = false;
                await AI._autoDetectDefault();
                boot.autoSkipsBroken = AI.settings.model === "qwen3:4b" && chatCalls >= 2;
                // nothing installed: stays unconfigured, the card takes over
                tagsModels = [];
                AI.settings = Object.assign({}, AI.settings, { model: "" });
                localStorage.removeItem("volt:ai:settings");
                AI._autoDetected = false;
                await AI._autoDetectDefault();
                boot.autoEmptySilent = AI.settings.model === "" &&
                  localStorage.getItem("volt:ai:settings") === null;

                // ── bootstrap CARD: the empty case → one-click pull ──
                // _refreshBootstrap owns the card's hidden state (a detect pass
                // alone only renders); re-arm it now that we're unconfigured
                AI._bootstrap = null;
                AI._refreshBootstrap();
                await AI._bootstrapDetect();
                boot.cardShown = bootEl.hidden === false;
                boot.detectedMissing = AI._bootstrap && AI._bootstrap.phase === "ready" && tagsCalls >= 1;
                boot.primaryPull = bootPrimary.textContent.indexOf("Download qwen3:4b") >= 0;
                // pull flow → applied as the default model (the button is still
                // ENABLED at this point — the ready render just ran)
                bootPrimary.click();
                let t0 = Date.now();
                while (Date.now() - t0 < 8000 && AI.settings.model !== "qwen3:4b") {
                  await new Promise((r) => setTimeout(r, 60));
                }
                boot.pulled = AI.settings.model === "qwen3:4b" && AI.settings.provider === "ollama" &&
                  pullBodies.length === 1 && pullBodies[0].model === "qwen3:4b";
                boot.cardHiddenAfterApply = bootEl.hidden === true;
                // progress rendering: 42% shows in the bar and the label (after
                // the click — the pulling render disables the button, which
                // would otherwise swallow the click)
                AI._bootstrap = { phase: "pulling", pct: 42, label: "Downloading qwen3:4b… 42%" };
                AI._bootstrapRender();
                boot.progressShown = progEl.hidden === false && bar.style.width === "42%" &&
                  progLabel.textContent.indexOf("42%") >= 0 && bootPrimary.disabled === true;
                // already-installed path: one click "Use" the BEST available
                // (ranked — with the full set present that's qwen3:8b) — no pull
                tagsModels = [{ name: "qwen3:1.7b" }, { name: "qwen3:4b" }, { name: "qwen3:8b" }, { name: "llama3.2:3b" }];
                chatFailFor.clear();
                AI.settings = Object.assign({}, AI.settings, { model: "" });
                localStorage.removeItem("volt:ai:settings");
                AI._autoDetected = true; // the card path, not re-detect
                await AI._bootstrapDetect();
                boot.primaryUse = bootPrimary.textContent.indexOf("Use qwen3:8b") >= 0;
                bootPrimary.click();
                t0 = Date.now();
                while (Date.now() - t0 < 8000 && AI.settings.model !== "qwen3:8b") {
                  await new Promise((r) => setTimeout(r, 60));
                }
                boot.used = AI.settings.model === "qwen3:8b" && pullBodies.length === 1;
                // "Not now": persisted skip flag, card hidden
                tagsModels = [];
                AI.settings = Object.assign({}, AI.settings, { model: "" });
                localStorage.removeItem("volt:ai:settings");
                AI._autoDetected = true;
                await AI._bootstrapDetect();
                bootDismiss.click();
                boot.dismissed = bootEl.hidden === true && localStorage.getItem("volt:ai:bootstrap-skip") === "1";
                // ── model-quality tier picker (⚙ settings) ─────
                // the row shows only for the Ollama provider, marks installed
                // tiers from /api/tags, and the action button installs (pull)
                // or applies (use) the chosen tier — all with the same stub.
                boot.tier = {};
                try {
                  const tierEl = document.getElementById("model-quality-block");
                  const tierBtn = document.getElementById("tier-install");
                  const tierDesc = document.getElementById("tier-desc");
                  const tierOf = (model) => {
                    for (const c of document.querySelectorAll(".tier-preset")) {
                      if (c.dataset.tier === model) return c;
                    }
                    return null;
                  };
                  // non-Ollama provider → row hidden
                  AI.settings = Object.assign({}, AI.settings, { provider: "openai", model: "gpt-4o-mini" });
                  await AI._refreshQualityBlock();
                  boot.tier.hiddenHosted = tierEl.hidden === true;
                  // Ollama, nothing installed → three chips + install flow
                  AI.settings = Object.assign({}, AI.settings, { provider: "ollama", model: "" });
                  tagsModels = [];
                  await AI._refreshQualityBlock();
                  boot.tier.chips = document.querySelectorAll(".tier-preset").length === 3;
                  boot.tier.blockShown = tierEl.hidden === false;
                  tierOf("qwen3:4b").click();
                  boot.tier.selectArms = tierBtn.disabled === false &&
                    tierBtn.textContent.indexOf("Install qwen3:4b") >= 0 && tierDesc.textContent.length > 20;
                  const pullsBefore = pullBodies.length;
                  tierBtn.click();
                  t0 = Date.now();
                  while (Date.now() - t0 < 8000 && AI.settings.model !== "qwen3:4b") {
                    await new Promise((r) => setTimeout(r, 60));
                  }
                  boot.tier.installed = AI.settings.model === "qwen3:4b" &&
                    pullBodies.length === pullsBefore + 1 && pullBodies[pullsBefore].model === "qwen3:4b";
                  // already-installed path: "Use qwen3:8b" — no new pull
                  AI.settings = Object.assign({}, AI.settings, { model: "" });
                  tagsModels = [{ name: "qwen3:1.7b" }, { name: "qwen3:4b" }, { name: "qwen3:8b" }, { name: "llama3.2:3b" }];
                  await AI._refreshQualityBlock();
                  tierOf("qwen3:8b").click();
                  const pullsBefore2 = pullBodies.length;
                  boot.tier.useLabel = tierBtn.textContent.indexOf("Use qwen3:8b") >= 0;
                  tierBtn.click();
                  t0 = Date.now();
                  while (Date.now() - t0 < 8000 && AI.settings.model !== "qwen3:8b") {
                    await new Promise((r) => setTimeout(r, 60));
                  }
                  boot.tier.used = AI.settings.model === "qwen3:8b" && pullBodies.length === pullsBefore2;
                } catch (e) { boot.tier.error = String((e && e.message) || e); }
                boot.tier.allOk = boot.tier.hiddenHosted === true && boot.tier.chips === true &&
                  boot.tier.blockShown === true && boot.tier.selectArms === true &&
                  boot.tier.installed === true && boot.tier.useLabel === true &&
                  boot.tier.used === true && !boot.tier.error;
                // ── private Ollama instance (⚙ settings, desktop only) ─
                // Volt can spawn its OWN 'ollama serve' on a private loopback
                // port with OLLAMA_ORIGINS pinned to Volt and a dedicated model
                // store — nothing else on the machine can reach the model. The
                // renderer's spawn/stop are stubbed (a smoke can never spawn
                // real servers); the flow asserted: hidden for hosted
                // providers, the toggle arms for Ollama, enabling adopts the
                // returned port into the baseUrl and pins the origins, private
                // mode short-circuits the CORS probe to safe WITHOUT the
                // bridge, probes now target the private port, and disabling
                // stops the instance and reverts the baseUrl. Browser mode has
                // no bridge to spawn anything — the stage degrades to the
                // desktop-only status surface (same pattern as the watch stage).
                boot.private = {};
                if (window.voltDesktop) {
                  try {
                    const pblock = document.getElementById("private-ollama-block");
                    const ptoggle = document.getElementById("private-ollama-toggle");
                    const pstatus = document.getElementById("private-ollama-status");
                    const origSpawn = AI._spawnPrivate;
                    const origStop = AI._stopPrivate;
                    let stopped = false;
                    let spawnedWith = null;
                    AI._spawnPrivate = async (origins) => { spawnedWith = origins; return { ok: true, port: 11435, pid: 9999 }; };
                    AI._stopPrivate = async () => { stopped = true; return { ok: true }; };
                    try {
                      // hosted provider → block hidden
                      AI.settings = Object.assign({}, AI.settings, { provider: "openai", model: "gpt-4o-mini", privateOllama: false, privatePort: null });
                      await AI._refreshQualityBlock();
                      boot.private.hiddenHosted = pblock.hidden === true;
                      // Ollama → block shows, toggle arms
                      AI.settings = Object.assign({}, AI.settings, { provider: "ollama", model: "", privateOllama: false, privatePort: null });
                      await AI._refreshQualityBlock();
                      boot.private.blockShown = pblock.hidden === false;
                      boot.private.armed = ptoggle.textContent.indexOf("Enable private instance") >= 0 &&
                        ptoggle.getAttribute("aria-pressed") === "false";
                      // enable → spawn called with the pinned origins, settings
                      // adopt the port + private baseUrl, status shows running
                      await AI._enablePrivate();
                      boot.private.enabled = AI.settings.privateOllama === true && AI.settings.privatePort === 11435 &&
                        AI.settings.baseUrl === "http://127.0.0.1:11435/v1" &&
                        typeof spawnedWith === "string" && spawnedWith.indexOf("http://localhost:8421") >= 0 &&
                        spawnedWith.indexOf("file://") === -1; // file:// panics Ollama — never in the pin
                      boot.private.statusRunning = pstatus.textContent.indexOf("11435") >= 0 &&
                        ptoggle.textContent.indexOf("Disable") >= 0 && ptoggle.getAttribute("aria-pressed") === "true";
                      // private mode short-circuits the CORS probe to safe — the
                      // REAL _probeCors runs here (private returns without the
                      // bridge, so this stays hermetic)
                      const prevProbe = AI._probeCors;
                      AI._probeCors = origProbeCors;
                      const corsState = await AI._probeCors();
                      AI._probeCors = prevProbe;
                      boot.private.corsSafe = !!corsState && corsState.wildcard === false;
                      // probes target the private port now
                      boot.private.probePort = AI._ollamaPort() === 11435 && AI._ollamaBase() === "http://127.0.0.1:11435";
                      // disable → stop called, baseUrl reverts to the shared instance
                      await AI._disablePrivate();
                      boot.private.disabled = AI.settings.privateOllama === false && AI.settings.privatePort === null &&
                        AI.settings.baseUrl === "http://localhost:11434/v1" && stopped === true;
                      boot.private.armedAgain = ptoggle.textContent.indexOf("Enable private instance") >= 0;
                    } finally {
                      AI._spawnPrivate = origSpawn;
                      AI._stopPrivate = origStop;
                      // leave the settings in a sane ollama state for the cors
                      // block below (provider ollama, private off)
                      AI.settings = Object.assign({}, AI.settings, { provider: "ollama", privateOllama: false, privatePort: null });
                    }
                  } catch (e) { boot.private.error = String((e && e.message) || e); }
                  boot.private.allOk = boot.private.hiddenHosted === true && boot.private.blockShown === true &&
                    boot.private.armed === true && boot.private.enabled === true && boot.private.statusRunning === true &&
                    boot.private.corsSafe === true && boot.private.probePort === true && boot.private.disabled === true &&
                    boot.private.armedAgain === true && !boot.private.error;
                } else {
                  boot.private.allOk = true; // browser mode — no bridge, nothing to spawn
                }
                // ── Ollama CORS drive-by guard ─────────────
                // OLLAMA_ORIGINS=* answers Access-Control-Allow-Origin: * —
                // the probe must surface the warning in the panel AND the
                // settings row, the Restrict action must pin Volt's origins
                // through the bridge (stubbed — a smoke never writes the real
                // user env), the safe case stays silent, and the warning can
                // be dismissed per session.
                boot.cors = {};
                try {
                  const corsBar = document.getElementById("ai-cors-warn");
                  const corsMsg = document.getElementById("ai-cors-msg");
                  const corsFix = document.getElementById("ai-cors-fix");
                  const corsLine = document.getElementById("tier-cors-warn");
                  // The real probe is the MAIN-process volt:check-ollama-cors
                  // (the renderer can't see Access-Control-Allow-Origin — the
                  // browser CORS model filters it out of page JS). The smoke
                  // stubs _probeCors per scenario instead: the AI object is
                  // mutable, unlike the frozen contextBridge — a bridge stub
                  // would no-op and the REAL IPC would probe (or worse, setx
                  // via the restrict path) the user's actual Ollama/env.
                  const origProbe = AI._probeCors;
                  const origRestrict = AI._restrictOllamaOrigins;
                  let corsSet = null;
                  try {
                    // wildcard → both surfaces warn with the OLLAMA_ORIGINS=* text
                    AI._probeCors = async () => ({ wildcard: true, acao: "*" });
                    AI._corsProbed = false;
                    await AI._checkCors(true);
                    boot.cors.warnShown = corsBar.hidden === false && corsLine.hidden === false &&
                      corsMsg.textContent.indexOf("OLLAMA_ORIGINS=*") >= 0 && corsFix.hidden === false;
                    // Restrict → the stub records the exact value the real
                    // method would hand to the bridge (the same _corsOrigins
                    // list: just localhost:8421 — file:// would panic Ollama)
                    AI._restrictOllamaOrigins = async () => {
                      corsSet = AI._corsOrigins().join(",");
                      AI._corsFixed = true;
                      AI._corsProbed = false;
                      AI._renderCorsWarning();
                    };
                    corsFix.click();
                    await new Promise((r) => setTimeout(r, 150));
                    // file:// is asserted ABSENT — Ollama's OLLAMA_ORIGINS
                    // parser panics on it, so re-adding it is a smoke failure
                    boot.cors.restrictCalls = typeof corsSet === "string" &&
                      corsSet.indexOf("http://localhost:8421") >= 0 && corsSet.indexOf("file://") === -1;
                    boot.cors.fixedMsg = corsMsg.textContent.indexOf("restart Ollama") >= 0 &&
                      corsFix.hidden === true;
                    // safe posture (specific origin / 403 rejection) → no warning
                    AI._probeCors = async () => ({ wildcard: false, acao: "http://localhost:8421" });
                    AI._corsProbed = false;
                    await AI._checkCors(true);
                    boot.cors.safeHidden = corsBar.hidden === true && corsLine.hidden === true;
                    // session dismiss hides the bar
                    AI._probeCors = async () => ({ wildcard: true, acao: "*" });
                    AI._corsProbed = false;
                    await AI._checkCors(true);
                    document.getElementById("ai-cors-dismiss").click();
                    boot.cors.dismissed = corsBar.hidden === true;
                  } finally {
                    AI._probeCors = origProbe;
                    AI._restrictOllamaOrigins = origRestrict;
                    AI._corsProbed = true; // don't re-probe in later stages
                    AI._cors = null;
                    AI._corsFixed = false;
                    AI._corsDismissed = false;
                  }
                } catch (e) { boot.cors.error = String((e && e.message) || e); }
                boot.cors.allOk = boot.cors.warnShown === true && boot.cors.restrictCalls === true &&
                  boot.cors.fixedMsg === true && boot.cors.safeHidden === true &&
                  boot.cors.dismissed === true && !boot.cors.error;
              } finally {
                // ALWAYS restore: fetch, settings, per-doc overrides, panel, skip
                window.fetch = realFetch;
                AI._probeCors = origProbeCors;
                AI.settings = JSON.parse(origSettings);
                if (origStored) localStorage.setItem("volt:ai:settings", origStored);
                else localStorage.removeItem("volt:ai:settings");
                for (const pair of docKeys) localStorage.setItem(pair[0], pair[1]);
                localStorage.removeItem("volt:ai:bootstrap-skip");
                AI._bootstrap = null;
                AI._bootstrapBusy = false;
                AI._bootstrapDismissed = false;
                Volt.App.toggleAI(!priorPanelHidden);
              }
            } catch (e) { boot.error = String((e && e.message) || e); }
            boot.allOk = boot.hiddenWhenConfigured === true && boot.cardShown === true &&
              boot.detectedMissing === true && boot.primaryPull === true &&
              boot.progressShown === true && boot.pulled === true &&
              boot.cardHiddenAfterApply === true && boot.primaryUse === true &&
              boot.used === true && boot.dismissed === true &&
              boot.autoBest === true && boot.autoPersisted === true && boot.autoCardHidden === true &&
              boot.autoRanked === true && boot.autoSkipsBroken === true && boot.autoEmptySilent === true &&
              boot.tier.allOk === true && boot.private.allOk === true && boot.cors.allOk === true && !boot.error;
            // ── duplicate selected highlight (Ctrl+D) ──────────────
            // duplicating copies the selected annotation with a slight downward
            // offset, keeps the copy selected (repeated presses stamp a column),
            // clamps inside the page, and each press is one undoable step.
            // Assert both the API path and the REAL Ctrl+D keydown path.
            const dup = { error: null };
            try {
              const Ann = Volt.Ann;
              Ann.mode = "select";
              Ann._deselectArea();
              const area = { id: Utils.uid(), type: "highlight", page: 1, rect: { x: 60, y: 100, w: 80, h: 30 }, text: "", color: "#fde047", createdAt: Date.now() };
              Ann._mutate(() => { Ann.list.push(area); });
              Ann._selectArea(area.id, (Volt.App.rendered.get(1) || {}).wrap || null);
              const before = Ann.list.length;
              dup.apiCopy = Ann.duplicateSelected() === true;
              dup.countPlusOne = Ann.list.length === before + 1;
              const copy = Ann.list.find((a) => a.id !== area.id && a.rect && a.rect.x === 60 && Math.abs(a.rect.y - 88) < 0.01);
              dup.offsetDown = !!copy;
              dup.newSelection = !!copy && Ann._selectedId === copy.id;
              dup.boxOnCopy = !!copy && !!Ann._selectionBox && Ann._selectionBox.el.dataset.annId === copy.id;
              // the real keydown path: Ctrl+D again → another copy stacked below
              document.dispatchEvent(new KeyboardEvent("keydown", { key: "d", ctrlKey: true, bubbles: true, cancelable: true }));
              dup.keyCreated = Ann.list.length === before + 2;
              // each press is its own undo step — two undos return to the start
              Ann.undo();
              dup.undoOne = Ann.list.length === before + 1;
              Ann.undo();
              dup.undoTwo = Ann.list.length === before;
              // the keydown with nothing selected must toast a hint, not crash
              Ann._deselectArea();
              document.dispatchEvent(new KeyboardEvent("keydown", { key: "d", ctrlKey: true, bubbles: true, cancelable: true }));
              dup.emptyHint = [...document.querySelectorAll(".toast")].some((t) => t.textContent.includes("Nothing selected"));
              // quads copies clamp too: a text-highlight duplicate near the
              // page bottom must stay in-page (never export negative PDF y)
              const ph = Volt.App.pageDims[0].h;
              const qBottom = [{ x: 100, y: ph - 4 }, { x: 200, y: ph - 4 }, { x: 200, y: ph + 2 }, { x: 100, y: ph + 2 }];
              Ann._mutate(() => { Ann.list.push({ id: Utils.uid(), type: "underline", page: 1, quads: [qBottom], text: "", color: "#4cc9f0", createdAt: Date.now() }); });
              const qq = Ann.list[Ann.list.length - 1];
              Ann._selectArea(qq.id, (Volt.App.rendered.get(1) || {}).wrap || null);
              Ann.duplicateSelected();
              const qc = Ann.list.find((a) => a.id !== qq.id && a.quads && a.quads[0][0].x === 100);
              let qMin = Infinity, qMax = -Infinity;
              if (qc) { for (const p of qc.quads[0]) { if (p.y < qMin) qMin = p.y; if (p.y > qMax) qMax = p.y; } }
              dup.quadsClamped = qc ? qMin >= -0.01 && qMax <= ph + 0.01 : false;
              // cleanup: drop the stage's annotations (undo already removed the copies)
              Ann.list = Ann.list.filter((a) => a.id !== area.id && a.id !== qq.id && a.id !== (qc && qc.id));
              Ann._afterChange();
              Ann._deselectArea();
            } catch (e) { dup.error = String((e && e.message) || e); }
            dup.allOk = dup.apiCopy === true && dup.countPlusOne === true && dup.offsetDown === true &&
              dup.newSelection === true && dup.boxOnCopy === true && dup.keyCreated === true &&
              dup.undoOne === true && dup.undoTwo === true && dup.emptyHint === true &&
              dup.quadsClamped === true && !dup.error;
            // ── arrow-key nudge (pixel-level placement) ──────────
            // with a highlight selected, arrow keys translate it 1pt in PDF
            // space (Shift = 10pt), clamped to the page; a burst of presses
            // coalesces into ONE undo entry. Assert the API path, the REAL
            // keydown path, the Shift multiplier, the clamp, the burst
            // coalescing + break, the quads clamp, and the no-selection no-op.
            const nudge = { error: null };
            try {
              const Ann = Volt.Ann;
              Ann.mode = "select";
              Ann._deselectArea();
              Ann._nudgeBurstUntil = 0;
              const area = { id: Utils.uid(), type: "highlight", page: 1, rect: { x: 100, y: 300, w: 80, h: 30 }, text: "", color: "#fde047", createdAt: Date.now() };
              Ann._mutate(() => { Ann.list.push(area); });
              Ann._selectArea(area.id, (Volt.App.rendered.get(1) || {}).wrap || null);
              const orig = { x: area.rect.x, y: area.rect.y };
              nudge.apiRight = Ann.nudgeSelected(1, 0) === true && area.rect.x === orig.x + 1 && area.rect.y === orig.y;
              document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
              nudge.keyDown = area.rect.y === orig.y - 1; // y-up: down = -1pt
              document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", shiftKey: true, bubbles: true, cancelable: true }));
              nudge.shiftTen = area.rect.x === orig.x + 11;
              // shove it far off the right and bottom edges → clamped in-page
              for (let i = 0; i < 20; i++) Ann.nudgeSelected(50, -50);
              const dims = Volt.App.pageDims[0];
              nudge.clamped = area.rect.x === dims.w - area.rect.w && area.rect.y === 0;
              // undo swaps in a snapshot whose annotations are CLONES — the
              // captured area reference goes stale after the first undo, so
              // every post-undo position read re-finds the live list entry
              const cur = () => Ann.list.find((a) => a.id === area.id);
              // burst coalescing: two rapid nudges = ONE undo entry
              Ann._nudgeBurstUntil = 0;
              const snap = { x: cur().rect.x, y: cur().rect.y };
              Ann.nudgeSelected(-1, 0);
              Ann.nudgeSelected(-1, 0);
              Ann.undo();
              nudge.coalescedUndo = cur().rect.x === snap.x; // one undo removed BOTH
              // burst break: after the 500ms window a new press starts its own entry
              Ann.nudgeSelected(-1, 0);
              await new Promise((r) => setTimeout(r, 600));
              Ann.nudgeSelected(-1, 0);
              nudge.twoBursts = cur().rect.x === snap.x - 2;
              Ann.undo();
              nudge.undoOneBurst = cur().rect.x === snap.x - 1;
              Ann.undo();
              nudge.undoTwoBursts = cur().rect.x === snap.x;
              // nudge → undo → immediate nudge must open a FRESH burst entry:
              // undo pops the burst's entry and resets the window, so the next
              // press (even within the old 500ms window) is undoable on its own.
              // Nudge LEFT here — the rect sits at the right-edge clamp, and a
              // +1 press would clamp to the same spot (a no-op, not a fresh entry)
              const snap2 = { x: cur().rect.x, y: cur().rect.y };
              Ann.nudgeSelected(-1, 0);
              Ann.undo();
              Ann.nudgeSelected(-1, 0);
              nudge.postUndoNudge = cur().rect.x === snap2.x - 1;
              Ann.undo();
              nudge.postUndoNudgeUndoable = cur().rect.x === snap2.x;
              // selection change mid-burst must start a FRESH entry: nudge A,
              // then (within the window) select B and nudge B — one undo must
              // revert ONLY B, leaving A's nudge in place (the burst entry
              // tracks its annotation id, so clicking another highlight never
              // merges into the previous entry)
              const a2 = { id: Utils.uid(), type: "highlight", page: 1, rect: { x: 60, y: 700, w: 80, h: 30 }, text: "", color: "#fde047", createdAt: Date.now() };
              const b2 = { id: Utils.uid(), type: "highlight", page: 1, rect: { x: 200, y: 700, w: 80, h: 30 }, text: "", color: "#86efac", createdAt: Date.now() };
              Ann._mutate(() => { Ann.list.push(a2, b2); });
              Ann._selectArea(a2.id, (Volt.App.rendered.get(1) || {}).wrap || null);
              const a0 = { x: a2.rect.x, y: a2.rect.y };
              Ann.nudgeSelected(1, 0); // opens a burst on A
              Ann._selectArea(b2.id, (Volt.App.rendered.get(1) || {}).wrap || null); // selection change within the window
              const b0 = { x: b2.rect.x, y: b2.rect.y };
              Ann.nudgeSelected(-1, 0); // must push a FRESH entry (different annotation)
              Ann.undo(); // one undo reverts only B
              const aCur = Ann.list.find((x) => x.id === a2.id);
              const bCur = Ann.list.find((x) => x.id === b2.id);
              nudge.selChangeFreshEntry = bCur.rect.x === b0.x && aCur.rect.x === a0.x + 1;
              Ann.undo(); // now A's nudge undoes too
              const aCur2 = Ann.list.find((x) => x.id === a2.id);
              nudge.selChangeUndoAll = aCur2.rect.x === a0.x;
              Ann.list = Ann.list.filter((x) => x.id !== a2.id && x.id !== b2.id);
              // quads nudge clamps too (never exports negative PDF y)
              const ph = dims.h;
              const qBottom = [{ x: 100, y: ph - 4 }, { x: 200, y: ph - 4 }, { x: 200, y: ph + 2 }, { x: 100, y: ph + 2 }];
              Ann._mutate(() => { Ann.list.push({ id: Utils.uid(), type: "underline", page: 1, quads: [qBottom], text: "", color: "#4cc9f0", createdAt: Date.now() }); });
              const qq = Ann.list[Ann.list.length - 1];
              Ann._selectArea(qq.id, (Volt.App.rendered.get(1) || {}).wrap || null);
              Ann.nudgeSelected(0, -1);
              let qMin = Infinity, qMax = -Infinity;
              for (const p of qq.quads[0]) { if (p.y < qMin) qMin = p.y; if (p.y > qMax) qMax = p.y; }
              nudge.quadsClamped = qMin >= -0.01 && qMax <= ph + 0.01;
              // nothing selected → nudge is a no-op
              Ann._deselectArea();
              nudge.noopWhenNone = Ann.nudgeSelected(1, 0) === false;
              // cleanup: drop the stage's annotations
              Ann.list = Ann.list.filter((a) => a.id !== area.id && a.id !== qq.id);
              Ann._afterChange();
              Ann._deselectArea();
            } catch (e) { nudge.error = String((e && e.message) || e); }
            nudge.allOk = nudge.apiRight === true && nudge.keyDown === true && nudge.shiftTen === true &&
              nudge.clamped === true && nudge.coalescedUndo === true && nudge.twoBursts === true &&
              nudge.undoOneBurst === true && nudge.undoTwoBursts === true &&
              nudge.postUndoNudge === true && nudge.postUndoNudgeUndoable === true &&
              nudge.selChangeFreshEntry === true && nudge.selChangeUndoAll === true &&
              nudge.quadsClamped === true && nudge.noopWhenNone === true && !nudge.error;
            // ── rotate area highlight (⤾ knob / Ctrl+drag) ──────────
            // a rotate handle above the box's top edge (plus Ctrl+drag anywhere
            // on the box) spins the highlight around its center. The rotation
            // is stored in PDF space (y-up, CCW degrees), rendered by BOTH the
            // canvas overlay and the pdf-lib export from the same corner math,
            // and survives hit-testing, nudging, moving, resizing, and undo.
            const rotArea = { error: null };
            try {
              const Ann = Volt.Ann;
              Ann.mode = "select";
              Ann._deselectArea();
              const wrap = [...document.querySelectorAll(".page-wrap")][0];
              const wrect = wrap.getBoundingClientRect();
              // events carry page-wrap-local coords; mk adds the wrap offset
              const mk = (x, y, extra) => ({ clientX: x + wrect.left, clientY: y + wrect.top, button: 0, preventDefault() {}, ...(extra || {}) });
              // a 100x50 rect centered at (150, 225) PDF — rotated 90° its
              // corners land at (175,175),(175,275),(125,275),(125,175): the
              // AABB swaps to 50x100. Assert the corner math itself, since the
              // overlay and export both consume it.
              const rect = { id: Utils.uid(), type: "highlight", page: 1, rect: { x: 100, y: 200, w: 100, h: 50 }, text: "", color: "#fde047", createdAt: Date.now() };
              Ann._mutate(() => { Ann.list.push(rect); });
              rect.rotation = 90;
              Ann._afterChange();
              Ann._selectArea(rect.id, wrap);
              rotArea.cornerMath = (() => {
                const c = Ann._rectCornersPdf(rect);
                const xs = c.map((p) => p.x).sort((a, b) => a - b);
                const ys = c.map((p) => p.y).sort((a, b) => a - b);
                return Math.abs(xs[0] - 125) < 0.01 && Math.abs(xs[3] - 175) < 0.01 &&
                  Math.abs(ys[0] - 175) < 0.01 && Math.abs(ys[3] - 275) < 0.01;
              })();
              // the rotate handle is only on area rects, not text-highlight boxes
              rotArea.knobOnRect = !!Ann._selectionBox && Ann._selectionBox.el.querySelector(".area-rot") !== null;
              // box transform: the selection box turns with the rect (transform
              // was applied by _positionSelectionBox during _refreshSelection)
              rotArea.boxRotates = (Ann._selectionBox.el.style.transform || "").includes("rotate(-90deg)");
              // hit-testing follows the ROTATED shape: the OLD corner position is
              // now empty; the rect CENTER (rotated or not) stays hittable. (A
              // rotated corner lands exactly on the shape's edge — the local→PDF
              // round-trip epsilon would flip an edge comparison, so the center
              // is the robust positive case.)
              const oldCornerLocal = Ann._pdfToLocal(wrap, 100, 200);
              const centerLocal = Ann._pdfToLocal(wrap, 150, 225);
              const hitOldCorner = (() => {
                const ev = mk(oldCornerLocal.x, oldCornerLocal.y); // unrotated corner — outside the 90° shape
                return Ann._areaAt(ev, wrap) !== rect;
              })();
              const hitRotatedCenter = (() => {
                const ev = mk(centerLocal.x, centerLocal.y);
                return Ann._areaAt(ev, wrap) === rect;
              })();
              rotArea.hitTest = hitOldCorner === true && hitRotatedCenter === true;
              // rotate drag: begin with the pointer above the center (PDF angle
              // +90° → rotation 0), drag to the right (angle 0° → -90 → 270).
              // The viewport round-trip carries sub-point noise, so compare with
              // a small tolerance rather than exact equality.
              const center = Ann._pdfToLocal(wrap, 150, 225);
              const above = Ann._pdfToLocal(wrap, 150, 260);
              const right = Ann._pdfToLocal(wrap, 190, 225);
              Ann._beginEditDrag(mk(center.x, center.y), wrap, "rotate", null);
              Ann._moveEditDrag(mk(above.x, above.y));
              rotArea.dragToAbove = Math.abs((rect.rotation || 0)) < 0.5;
              Ann._moveEditDrag(mk(right.x, right.y));
              rotArea.dragToRight = Math.abs((rect.rotation || 0) - 270) < 0.5; // -90 normalized
              Ann._endEditDrag(true);
              // Shift snaps to 15°
              const snapAng = 12 * Math.PI / 180; // 12° above the x-axis
              const snapPt = Ann._pdfToLocal(wrap, 150 + 80 * Math.cos(snapAng), 225 + 80 * Math.sin(snapAng));
              Ann._beginEditDrag(mk(center.x, center.y), wrap, "rotate", null);
              Ann._moveEditDrag(mk(snapPt.x, snapPt.y, { shiftKey: true }));
              rotArea.shiftSnap = (rect.rotation || 0) === 285; // 12-90 = -78 → rounds to -75 → 285
              Ann._endEditDrag(true);
              // Ctrl+drag anywhere on the box rotates too
              Ann._selectArea(rect.id, wrap);
              const ctrlEv = mk(center.x, center.y, { ctrlKey: true, target: Ann._selectionBox.el });
              Ann.onAreaMouseDown(ctrlEv, wrap);
              rotArea.ctrlDrag = !!Ann._editDrag && Ann._editDrag.mode === "rotate";
              Ann._endEditDrag(true);
              // undo restores the rotation: two explicit _mutate entries, undo pops one.
              // NOTE: undo swaps the list for a deep-cloned snapshot, so the rect
              // reference goes stale — re-find the live entry before mutating it.
              Ann._mutate(() => { rect.rotation = 0; });
              Ann._mutate(() => { rect.rotation = 45; });
              Ann.undo();
              let live = Ann.list.find((x) => x.id === rect.id);
              rotArea.undoRestores = live.rotation === 0;
              // nudge/duplicate of a rotated rect clamp its ROTATED AABB, and
              // duplicate keeps the rotation
              const dims = Volt.App.pageDims[0];
              live.rotation = 45;
              Ann._afterChange();
              Ann._nudgeBurstUntil = 0;
              Ann.nudgeSelected(0, -500); // shove far down — the 45° AABB must clamp to the page
              const aabbAfter = (() => {
                const c = Ann._rectCornersPdf(live);
                const xs = c.map((p) => p.x).sort((a, b) => a - b);
                const ys = c.map((p) => p.y).sort((a, b) => a - b);
                return { x1: xs[0], y1: ys[0], x2: xs[3], y2: ys[3] };
              })();
              rotArea.clampedAabb = aabbAfter.x1 >= -0.01 && aabbAfter.y1 >= -0.01 &&
                aabbAfter.x2 <= dims.w + 0.01 && aabbAfter.y2 <= dims.h + 0.01 && aabbAfter.y1 <= 0.01;
              const before = Ann.list.length;
              Ann.duplicateSelected();
              const copy = Ann.list.find((x) => x.id !== live.id && x.rect);
              rotArea.dupKeepsRotation = !!copy && copy.rotation === 45;
              rotArea.dupCount = Ann.list.length === before + 1;
              // cleanup
              Ann.list = [];
              Ann.history = [];
              Ann.redoStack = [];
              Ann._afterChange();
              Ann._deselectArea();
              // export round-trip: a rotated rect must survive into the PDF.
              // Build a clean list, export, reload with pdf.js, and find the
              // path operators (m/l — a rotated rect exports as an SVG path,
              // not a bare re) at the expected rotated corners.
              const rot2 = { id: Utils.uid(), type: "highlight", page: 1, rect: { x: 100, y: 200, w: 100, h: 50 }, rotation: 90, text: "", color: "#fde047", createdAt: Date.now() };
              Ann._mutate(() => { Ann.list.push(rot2); });
              const pdfBytes = await Ann.toAnnotatedPdf();
              rotArea.exported = pdfBytes && pdfBytes.byteLength > 1000;
              const pdfDoc = await pdfjsLib.getDocument({ data: pdfBytes }).promise;
              rotArea.exportReloads = pdfDoc.numPages >= 1;
              const exportPage = await pdfDoc.getPage(1); // getPage returns a PROMISE
              const ops = await exportPage.getOperatorList();
              const corners = Ann._rectCornersPdf(rot2);
              // pdf-lib draws the SVG path as ONE constructPath op whose args are
              // [fnCodes, xs, ys] — the rotated corners must appear in its xs/ys.
              const cpCode = pdfjsLib.OPS ? pdfjsLib.OPS.constructPath : undefined;
              let foundPath = false;
              if (cpCode !== undefined) {
                for (let i = 0; i < ops.fnArray.length; i++) {
                  if (ops.fnArray[i] !== cpCode || !ops.argsArray[i]) continue;
                  // pdf.js packs the path as [opCodes, coords] where coords is a
                  // FLAT [x0,y0,x1,y1,...] list — check every pair against the
                  // rotated corners (any array arg that holds the coordinates)
                  for (const arg of ops.argsArray[i]) {
                    if (!Array.isArray(arg)) continue;
                    for (let k = 0; k + 1 < arg.length; k += 2) {
                      const px = arg[k], py = arg[k + 1];
                      if (typeof px !== "number" || typeof py !== "number") continue;
                      if (corners.some((c) => Math.abs(c.x - px) < 2 && Math.abs(c.y - py) < 2)) { foundPath = true; break; }
                    }
                    if (foundPath) break;
                  }
                  if (foundPath) break;
                }
              }
              rotArea.exportHasRotatedPath = foundPath;
              Ann.list = [];
              Ann.history = [];
              Ann.redoStack = [];
              Ann._afterChange();
              Ann._deselectArea();
            } catch (e) { rotArea.error = String((e && e.message) || e); }
            rotArea.allOk = rotArea.cornerMath === true && rotArea.knobOnRect === true &&
              rotArea.boxRotates === true && rotArea.hitTest === true &&
              rotArea.dragToAbove === true && rotArea.dragToRight === true &&
              rotArea.shiftSnap === true && rotArea.ctrlDrag === true &&
              rotArea.undoRestores === true && rotArea.clampedAabb === true &&
              rotArea.dupKeepsRotation === true && rotArea.dupCount === true &&
              rotArea.exported === true && rotArea.exportReloads === true &&
              rotArea.exportHasRotatedPath === true && !rotArea.error;
            // live size readout: creating an area highlight over BLANK space —
            // and resizing one via a handle — shows a "W × H in" badge next to
            // the drag rect that updates per frame and disappears at drag end
            const sizeBadge = { error: null };
            try {
              const Ann = Volt.Ann;
              const wrap = [...document.querySelectorAll(".page-wrap")][0];
              const wrect = wrap.getBoundingClientRect();
              const mk = (x, y) => ({ clientX: x + wrect.left, clientY: y + wrect.top, button: 0, preventDefault() {} });
              // ── creation: highlight-mode drag across a blank region ──
              // a grid scan finds real whitespace (page margins / below text) —
              // robust to sample drift. 80x80 gives a wide drag range so two
              // different rects round to clearly different inch readouts.
              Ann.setMode("highlight");
              let b = null;
              for (let gy = 20; gy + 80 <= wrap.clientHeight && !b; gy += 40) {
                for (let gx = 20; gx + 80 <= wrap.clientWidth; gx += 40) {
                  if (!Ann._spansInRect(wrap, gx, gy, gx + 80, gy + 80).length) { b = { x1: gx, y1: gy, x2: gx + 80, y2: gy + 80 }; break; }
                }
              }
              sizeBadge.foundBlank = !!b;
              if (b) {
                Ann.beginDrag(mk(b.x1 + 10, b.y1 + 10), wrap);
                window.dispatchEvent(new MouseEvent("mousemove", mk(b.x1 + 70, b.y1 + 70)));
                const badge = wrap.querySelector(".area-size-badge");
                sizeBadge.badgeShown = !!badge;
                sizeBadge.formatOk = badge ? /^[0-9]+[.][0-9] \u00d7 [0-9]+[.][0-9] in$/.test(badge.textContent.trim()) : false;
                const firstText = badge ? badge.textContent.trim() : null;
                // a second move INSIDE the blank region (any different size
                // proves the readout updates live without hitting a column)
                window.dispatchEvent(new MouseEvent("mousemove", mk(b.x1 + 20, b.y1 + 20)));
                sizeBadge.updatesLive = !!badge && badge.textContent.trim() !== firstText;
                window.dispatchEvent(new MouseEvent("mouseup", mk(b.x1 + 20, b.y1 + 20)));
                sizeBadge.badgeRemoved = !wrap.querySelector(".area-size-badge");
                sizeBadge.areaCreated = Ann.list.some((a) => a.type === "highlight" && a.rect);
                Ann.list = Ann.list.filter((a) => !(a.type === "highlight" && a.rect));
              }
              // ── resize: SE-handle drag on a selected area grows the badge ──
              Ann.setMode("select");
              Ann._deselectArea();
              const area = { id: Utils.uid(), type: "highlight", page: 1, rect: { x: 80, y: 120, w: 80, h: 40 }, text: "", color: "#fde047", createdAt: Date.now() };
              Ann._mutate(() => { Ann.list.push(area); });
              Ann._selectArea(area.id, wrap);
              const se = Ann._selectionBox && Ann._selectionBox.el.querySelector(".area-handle.se");
              if (se) {
                const sr = se.getBoundingClientRect();
                const sx = sr.left + sr.width / 2 - wrect.left, sy = sr.top + sr.height / 2 - wrect.top;
                Ann._beginEditDrag(mk(sx, sy), wrap, "resize", "se");
                window.dispatchEvent(new MouseEvent("mousemove", mk(sx + 60, sy + 40)));
                const badge2 = wrap.querySelector(".area-size-badge");
                sizeBadge.resizeShown = !!badge2;
                sizeBadge.resizeFormat = badge2 ? /^[0-9]+[.][0-9] \u00d7 [0-9]+[.][0-9] in$/.test(badge2.textContent.trim()) : false;
                sizeBadge.resizeGrew = Ann.list.find((a) => a.id === area.id).rect.w > 80;
                window.dispatchEvent(new MouseEvent("mouseup", mk(sx + 60, sy + 40)));
                sizeBadge.goneAfterResize = !wrap.querySelector(".area-size-badge");
              } else {
                sizeBadge.resizeShown = false;
                sizeBadge.goneAfterResize = false;
              }
              Ann.list = Ann.list.filter((a) => a.id !== area.id);
              Ann.history = [];
              Ann.redoStack = [];
              Ann._afterChange();
              Ann._deselectArea();
            } catch (e) { sizeBadge.error = String((e && e.message) || e); }
            sizeBadge.allOk = sizeBadge.foundBlank === true && sizeBadge.badgeShown === true &&
              sizeBadge.formatOk === true && sizeBadge.updatesLive === true &&
              sizeBadge.badgeRemoved === true && sizeBadge.areaCreated === true &&
              sizeBadge.resizeShown === true && sizeBadge.resizeFormat === true &&
              sizeBadge.resizeGrew === true && sizeBadge.goneAfterResize === true && !sizeBadge.error;
            // dedicated Rectangle tool: a click places a default-size rect even
            // ON TEXT (the highlight tool's click needs blank space), a drag
            // ALWAYS draws an area rect (never a text-quads fallback or a "no
            // text" toast), and the default size from volt:app:settings is
            // honored and applies immediately when the two ⚙ fields change
            const rectTool = { error: null };
            try {
              const Ann = Volt.Ann;
              const wrap = [...document.querySelectorAll(".page-wrap")][0];
              const wrect = wrap.getBoundingClientRect();
              const mk = (x, y) => ({ clientX: x + wrect.left, clientY: y + wrect.top, button: 0, preventDefault() {} });
              const span = [...wrap.querySelectorAll(".page-text-layer span")].find((s) => s.textContent.trim());
              const sr = span ? span.getBoundingClientRect() : null;
              rectTool.foundTextSpan = !!span;
              // start from the built-in default (the smoke profile is isolated,
              // but be explicit): write the ⚙ fields and dispatch change — the
              // same path a user's edit takes, so wiring is exercised too
              const rw = document.getElementById("set-rect-w");
              const rh = document.getElementById("set-rect-h");
              if (rw) { rw.value = 160; rw.dispatchEvent(new Event("change")); }
              if (rh) { rh.value = 64; rh.dispatchEvent(new Event("change")); }
              const dflt = Ann._rectSize();
              rectTool.defaultSizeOk = dflt.w === 160 && dflt.h === 64;
              Ann.setMode("rect");
              if (sr) {
                const cx = sr.left - wrect.left + sr.width / 2;
                const cy = sr.top - wrect.top + sr.height / 2;
                // click ON TEXT → a default-size rect, not a text highlight
                Ann.beginDrag(mk(cx, cy), wrap);
                window.dispatchEvent(new MouseEvent("mouseup", mk(cx, cy)));
                const rects = Ann.list.filter((a) => a.type === "rect");
                const r = rects.length === 1 && rects[0].rect;
                rectTool.clickOnTextPlaced = rects.length === 1 && !!r;
                rectTool.clickSizeIsDefault = !!(r && Math.round(r.w) === 160 && Math.round(r.h) === 64);
                const dims = Volt.App.pageDims[0] || { w: 1e9, h: 1e9 };
                rectTool.clickRectOnPage = !!(r && r.x >= 0 && r.y >= 0 && r.x + r.w <= dims.w + 1 && r.y + r.h <= dims.h + 1);
                // drag OVER the same text → still a rect (area, no quads)
                Ann.beginDrag(mk(cx - 20, cy - 10), wrap);
                window.dispatchEvent(new MouseEvent("mousemove", mk(cx + 30, cy + 10)));
                window.dispatchEvent(new MouseEvent("mouseup", mk(cx + 30, cy + 10)));
                const rects2 = Ann.list.filter((a) => a.type === "rect");
                const last = rects2[rects2.length - 1];
                rectTool.dragOverTextMadeRect = rects2.length === 2 && !!(last && last.rect && !last.quads);
                // change the default via the same ⚙ fields → next click is 120×80
                if (rw) { rw.value = 120; rw.dispatchEvent(new Event("change")); }
                if (rh) { rh.value = 80; rh.dispatchEvent(new Event("change")); }
                const sized = Ann._rectSize();
                rectTool.settingsHonored = sized.w === 120 && sized.h === 80;
                Ann.beginDrag(mk(cx, cy + 30), wrap);
                window.dispatchEvent(new MouseEvent("mouseup", mk(cx, cy + 30)));
                const rects3 = Ann.list.filter((a) => a.type === "rect");
                const last3 = rects3[rects3.length - 1];
                const r3 = rects3.length === 3 && last3.rect;
                rectTool.changedSizeApplied = !!(r3 && Math.round(r3.w) === 120 && Math.round(r3.h) === 80);
                // preset chips: one click on the 2×1 in chip applies 144×72
                // through the same persist path, highlights it, and the next
                // click places that size; typing a custom size clears it
                const chip = document.querySelector('.rect-preset[data-w="144"][data-h="72"]');
                if (chip) {
                  chip.click();
                  const ps = Ann._rectSize();
                  rectTool.chipApplied = ps.w === 144 && ps.h === 72;
                  rectTool.chipHighlighted = chip.classList.contains("active");
                  Ann.beginDrag(mk(cx, cy + 60), wrap);
                  window.dispatchEvent(new MouseEvent("mouseup", mk(cx, cy + 60)));
                  const rects4 = Ann.list.filter((a) => a.type === "rect");
                  const last4 = rects4[rects4.length - 1];
                  const r4 = rects4.length === 4 && last4.rect;
                  rectTool.chipPlacedRect = !!(r4 && Math.round(r4.w) === 144 && Math.round(r4.h) === 72);
                  if (rw) { rw.value = 200; rw.dispatchEvent(new Event("change")); }
                  if (rh) { rh.value = 100; rh.dispatchEvent(new Event("change")); }
                  rectTool.customClearsChip = !chip.classList.contains("active");
                } else {
                  rectTool.chipApplied = false;
                  rectTool.chipHighlighted = false;
                  rectTool.chipPlacedRect = false;
                  rectTool.customClearsChip = false;
                }
              }
              // ── Alt+drag: the drag start is the CENTER ────────────────
              // the stored rect must span ±delta about the start point (PDF
              // coords — the affine viewport map preserves midpoints), and
              // Alt+Shift snaps it to a centered square. A grid scan finds a
              // real blank 120×120 region so the ±40/±30 drag stays clear.
              Ann.setMode("rect");
              let bb = null;
              for (let gy = 20; gy + 120 <= wrap.clientHeight && !bb; gy += 40) {
                for (let gx = 20; gx + 120 <= wrap.clientWidth; gx += 40) {
                  if (!Ann._spansInRect(wrap, gx, gy, gx + 120, gy + 120).length) { bb = { x: gx + 60, y: gy + 60 }; break; }
                }
              }
              rectTool.altFoundBlank = !!bb;
              if (bb) {
                // fresh wrap rect + ROUNDED client coords: MouseEvent coerces
                // clientX/clientY to integers, so if the factory sends fractions
                // (wrap.left is often fractional), beginDrag (plain object, full
                // precision) and _endDrag (coerced) would disagree by the
                // rounding error — skewing the simulated drag delta. Real events
                // are integer pixels, so round to match reality.
                const wr2 = wrap.getBoundingClientRect();
                const mk2 = (x, y) => ({ clientX: Math.round(x + wr2.left), clientY: Math.round(y + wr2.top), button: 0, preventDefault() {} });
                const C = bb, E = { x: C.x + 40, y: C.y + 30 };
                Ann.beginDrag(mk2(C.x, C.y), wrap);
                window.dispatchEvent(new MouseEvent("mousemove", { ...mk2(E.x, E.y), altKey: true }));
                window.dispatchEvent(new MouseEvent("mouseup", { ...mk2(E.x, E.y), altKey: true }));
                const altLast = Ann.list[Ann.list.length - 1];
                const cPt = Ann._localToPdf(wrap, C.x, C.y);
                const ePt = Ann._localToPdf(wrap, E.x, E.y);
                const hw = Math.abs(ePt[0] - cPt[0]), hh = Math.abs(ePt[1] - cPt[1]);
                rectTool.altCentered = !!(altLast && altLast.type === "rect" && altLast.rect &&
                  Math.abs(altLast.rect.x - (cPt[0] - hw)) < 0.5 && Math.abs(altLast.rect.y - (cPt[1] - hh)) < 0.5 &&
                  Math.abs(altLast.rect.w - 2 * hw) < 1 && Math.abs(altLast.rect.h - 2 * hh) < 1);
                // Alt+Shift: a centered square — both dims = 2× the max delta
                Ann.beginDrag(mk2(C.x, C.y), wrap);
                window.dispatchEvent(new MouseEvent("mousemove", { ...mk2(C.x + 30, C.y + 20), altKey: true, shiftKey: true }));
                window.dispatchEvent(new MouseEvent("mouseup", { ...mk2(C.x + 30, C.y + 20), altKey: true, shiftKey: true }));
                const altSq = Ann.list[Ann.list.length - 1];
                const e2Pt = Ann._localToPdf(wrap, C.x + 30, C.y + 20);
                const side = Math.max(Math.abs(e2Pt[0] - cPt[0]), Math.abs(e2Pt[1] - cPt[1]));
                rectTool.altShiftSquare = !!(altSq && altSq.rect &&
                  Math.abs(altSq.rect.w - 2 * side) < 1 && Math.abs(altSq.rect.h - 2 * side) < 1 &&
                  Math.abs((altSq.rect.x + altSq.rect.w / 2) - cPt[0]) < 0.5 &&
                  Math.abs((altSq.rect.y + altSq.rect.h / 2) - cPt[1]) < 0.5);
                // Alt-resize: dragging the SE handle mirrors the opposite edge
                // about the rect's center — center kept, size grew
                Ann.setMode("select");
                Ann._deselectArea();
                const areaR = { id: Utils.uid(), type: "rect", page: 1, rect: { x: 80, y: 120, w: 80, h: 40 }, text: "", color: "#a78bfa", createdAt: Date.now() };
                Ann._mutate(() => { Ann.list.push(areaR); });
                Ann._selectArea(areaR.id, wrap);
                const seH = Ann._selectionBox && Ann._selectionBox.el.querySelector(".area-handle.se");
                if (seH) {
                  const shr = seH.getBoundingClientRect();
                  const sx = shr.left + shr.width / 2 - wr2.left, sy = shr.top + shr.height / 2 - wr2.top;
                  const bC = { x: areaR.rect.x + areaR.rect.w / 2, y: areaR.rect.y + areaR.rect.h / 2 };
                  Ann._beginEditDrag(mk2(sx, sy), wrap, "resize", "se");
                  window.dispatchEvent(new MouseEvent("mousemove", { ...mk2(sx + 60, sy + 40), altKey: true }));
                  window.dispatchEvent(new MouseEvent("mouseup", { ...mk2(sx + 60, sy + 40), altKey: true }));
                  const after = Ann.list.find((a) => a.id === areaR.id);
                  const aC = { x: after.rect.x + after.rect.w / 2, y: after.rect.y + after.rect.h / 2 };
                  rectTool.altResizeCenterKept = Math.abs(aC.x - bC.x) < 1 && Math.abs(aC.y - bC.y) < 1;
                  rectTool.altResizeGrew = after.rect.w > 80 + 20;
                  rectTool.altResizeOppositeMoved = after.rect.x < 80 - 10 && after.rect.y < 120 - 5;
                } else {
                  rectTool.altResizeCenterKept = false;
                  rectTool.altResizeGrew = false;
                  rectTool.altResizeOppositeMoved = false;
                }
                Ann.list = Ann.list.filter((a) => a.id !== areaR.id);
                Ann.history = [];
                Ann.redoStack = [];
                Ann._afterChange();
                Ann._deselectArea();
                Ann.setMode("select");
              } else {
                rectTool.altCentered = false;
                rectTool.altShiftSquare = false;
                rectTool.altResizeCenterKept = false;
                rectTool.altResizeGrew = false;
                rectTool.altResizeOppositeMoved = false;
              }
              Ann.list = [];
              Ann.history = [];
              Ann.redoStack = [];
              Ann._afterChange();
              Ann.setMode("select");
            } catch (e) { rectTool.error = String((e && e.message) || e); }
            rectTool.allOk = rectTool.foundTextSpan === true && rectTool.defaultSizeOk === true &&
              rectTool.clickOnTextPlaced === true && rectTool.clickSizeIsDefault === true &&
              rectTool.clickRectOnPage === true && rectTool.dragOverTextMadeRect === true &&
              rectTool.settingsHonored === true && rectTool.changedSizeApplied === true &&
              rectTool.chipApplied === true && rectTool.chipHighlighted === true &&
              rectTool.chipPlacedRect === true && rectTool.customClearsChip === true &&
              rectTool.altFoundBlank === true && rectTool.altCentered === true &&
              rectTool.altShiftSquare === true && rectTool.altResizeCenterKept === true &&
              rectTool.altResizeGrew === true && rectTool.altResizeOppositeMoved === true && !rectTool.error;
            // the trap tests gate into ok too: a broken trap (or a removed
            // _openModal inert line) must fail the smoke, not just report data
            modal.allOk = !modal.error &&
              modal.openedFocus !== null &&
              modal.shiftQuestionIgnored === true &&
              modal.shiftTabWrappedToLast === true &&
              modal.tabWrappedToFirst === true &&
              modal.escapeClosed === true &&
              modal.focusRestored === true &&
              modal.inertCleared === true;
            probeHidden("afterModal"); // the just-closed modal must obey the hidden contract again
            // ── modal open/close cycle (dynamic hidden contract) ────────
            // beyond the static [hidden] check: toggle EVERY modal open and
            // closed through the real _openModal/_closeModal paths and assert
            // each one's hidden ATTRIBUTE and computed display are restored
            // after closing — catches JS paths that un-hide without the
            // attribute (e.g. an inline display:block !important that defeats
            // the [hidden] rule, or a close path that never sets hidden=true)
            const modalCycle = { error: null, results: {} };
            try {
              const ids = ["settings-modal", "help-modal", "url-modal", "export-modal", "restore-modal", "persona-modal", "pages-modal"];
              for (const id of ids) {
                const m = document.getElementById(id);
                Volt.App._closeModal(m); // idempotent when already closed
                Volt.App._openModal(m);
                const opened = m.hidden === false;
                const visible = getComputedStyle(m).display !== "none";
                Volt.App._closeModal(m);
                const closed = m.hidden === true;
                const displayNone = getComputedStyle(m).display === "none";
                modalCycle.results[id] = { opened, visible, closed, displayNone };
              }
            } catch (e) { modalCycle.error = String((e && e.message) || e); }
            modalCycle.allOk = !modalCycle.error && Object.values(modalCycle.results).every((r) =>
              r.opened === true && r.visible === true && r.closed === true && r.displayNone === true);
            probeHidden("afterCycle"); // all six modals closed again — the contract must hold across every one
            probeVisible("afterCycle"); // and the app UI must still be visible after every modal toggle
            // ── help center (Volt ▾ → Help & guides…) ─────────
            // the help modal is now a tabbed guide: a left nav toggles the
            // active section, the toolbar ? button lands on Shortcuts, an
            // unknown section id falls back to Getting started, and the
            // shortcuts pane still holds the kbd rows. Reuse the cycle
            // assertions: every open must close cleanly.
            const helpC = { error: null };
            try {
              const sections = [...document.querySelectorAll(".help-section")];
              const navItems = [...document.querySelectorAll(".help-nav-item")];
              helpC.navCount = sections.length === navItems.length && navItems.length === 10;
              Volt.App._openHelp("annotating");
              const h1 = document.getElementById("help-modal");
              helpC.opensOnSection = h1.hidden === false &&
                document.querySelector('.help-section[data-help="annotating"]').classList.contains("active") &&
                document.querySelector('.help-nav-item[data-help="annotating"]').classList.contains("active");
              // clicking a nav item switches the visible section
              document.querySelector('.help-nav-item[data-help="shortcuts"]').click();
              helpC.navSwitches = document.querySelector('.help-section[data-help="annotating"]').classList.contains("active") === false &&
                document.querySelector('.help-section[data-help="shortcuts"]').classList.contains("active") &&
                document.getElementById("kbd-list").querySelectorAll(".kbd-row").length > 10;
              // unknown id → lands on Getting started, modal still opens
              Volt.App._closeModal(h1);
              Volt.App._openHelp("does-not-exist");
              helpC.unknownFallsBack = h1.hidden === false &&
                document.querySelector('.help-section[data-help="getting-started"]').classList.contains("active");
              Volt.App._closeModal(h1);
              helpC.closesClean = h1.hidden === true && getComputedStyle(h1).display === "none";
            } catch (e) { helpC.error = String((e && e.message) || e); }
            helpC.allOk = helpC.navCount === true && helpC.opensOnSection === true &&
              helpC.navSwitches === true && helpC.unknownFallsBack === true &&
              helpC.closesClean === true && !helpC.error;
            // ── setup wizard (first run / Volt ▾ → Setup wizard…) ──
            // the one-time installer: a banner offers it on first run (Not
            // now marks setup answered so it never nags again), the wizard
            // walks four steps, the AI step reflects the configured model,
            // and finishing applies the skin + marks volt:setup-done. The
            // desktop shortcut/association checkbox is UNCHECKED here so the
            // real PowerShell script never runs during the self-test.
            const setup = { error: null };
            const setupPrevTheme = localStorage.getItem("volt:theme");
            const setupPrevAi = { baseUrl: Volt.AI.settings.baseUrl, model: Volt.AI.settings.model };
            const setupPrevStub = Volt.AI._bootstrapDetect;
            const setupPrevEff = Volt.AI._effective;
            const setupPrevSetup = localStorage.getItem("volt:setup-done");
            try {
              const S = Volt.App;
              const sBanner = document.getElementById("setup-banner");
              // smoke runs with ?smoke=1 → the banner must NOT auto-show
              setup.bannerSuppressed = new URLSearchParams(location.search).has("smoke") && sBanner.hidden === true;
              // force-show the first-run offer; Not now answers it + hides
              localStorage.removeItem("volt:setup-done");
              S._maybeShowSetupBanner(true);
              setup.bannerShows = sBanner.hidden === false;
              document.getElementById("setup-banner-later").click();
              setup.bannerLater = sBanner.hidden === true &&
                JSON.parse(localStorage.getItem("volt:setup-done") || "{}").done === false;
              // the wizard itself: open → step 0, walk to step 2 with a
              // configured model, finish → summary + flag, Start reading closes
              S.openSetup();
              const sModal = document.getElementById("setup-modal");
              setup.opens = sModal.hidden === false &&
                document.querySelector('.setup-step[data-step="0"]').hidden === false &&
                document.querySelectorAll(".setup-dot").length === 4;
              document.getElementById("setup-next-0").click();
              setup.step2 = document.querySelector('.setup-step[data-step="1"]').hidden === false &&
                document.querySelector('.setup-step[data-step="0"]').hidden === true;
              // desktop app: the shortcut/association checkbox is offered;
              // browser: it's hidden and the note explains why
              const setupDesktopBridge = typeof window.voltDesktop !== "undefined" && !!window.voltDesktop;
              setup.desktopOption = setupDesktopBridge
                ? document.getElementById("setup-desktop-opt").hidden === false &&
                  !!document.getElementById("setup-desktop") &&
                  document.querySelectorAll('input[name="setup-skin"]').length === 2
                : document.getElementById("setup-desktop-opt").hidden === true &&
                  document.getElementById("setup-desktop-note").hidden === false &&
                  document.querySelectorAll('input[name="setup-skin"]').length === 2;
              // AI step: stub detection + _effective (an earlier stage restored
              // a url-smoke-model OVERRIDE onto the sample — _effective prefers
              // doc overrides, so the deterministic seed must be the stub)
              Volt.AI._bootstrapDetect = async () => {};
              Volt.AI._effective = () => ({ model: "qwen3:4b", baseUrl: "http://localhost:11434/v1", provider: "ollama", maxContextChars: 8000, systemPrompt: "" });
              document.getElementById("setup-next-1").click();
              const tAi = Date.now();
              while (Date.now() - tAi < 4000 &&
                     document.getElementById("setup-ai-status").textContent.indexOf("qwen3:4b") < 0) {
                await new Promise((r) => setTimeout(r, 100));
              }
              setup.aiShowsModel = document.getElementById("setup-ai-status").textContent.indexOf("qwen3:4b") >= 0 &&
                document.querySelector('.setup-step[data-step="2"]').hidden === false;
              // finish: desktop task unchecked (no real script), dark skin default
              const sDesk = document.getElementById("setup-desktop");
              if (sDesk && sDesk.checked) sDesk.click();
              document.getElementById("setup-next-2").click();
              const tFin = Date.now();
              while (Date.now() - tFin < 4000 &&
                     document.querySelector('.setup-step[data-step="3"]').hidden) {
                await new Promise((r) => setTimeout(r, 100));
              }
              const summary = document.getElementById("setup-summary").textContent;
              setup.summary = document.querySelector('.setup-step[data-step="3"]').hidden === false &&
                summary.indexOf("Skin — Dark") >= 0 && summary.indexOf("AI — qwen3:4b") >= 0;
              setup.flagDone = JSON.parse(localStorage.getItem("volt:setup-done") || "{}").done === true;
              document.getElementById("setup-finish").click();
              setup.closes = sModal.hidden === true;
              // the menu item reopens the wizard
              document.getElementById("btn-menu-setup").click();
              setup.menuReopens = sModal.hidden === false &&
                document.querySelector('.setup-step[data-step="0"]').hidden === false;
              S._closeModal(sModal);
            } catch (e) { setup.error = String((e && e.message) || e); }
            // restore everything the stage touched
            Volt.AI._bootstrapDetect = setupPrevStub;
            if (setupPrevEff) Volt.AI._effective = setupPrevEff;
            Volt.AI.settings.baseUrl = setupPrevAi.baseUrl;
            Volt.AI.settings.model = setupPrevAi.model;
            if (setupPrevTheme !== null) localStorage.setItem("volt:theme", setupPrevTheme);
            else localStorage.removeItem("volt:theme");
            if (setupPrevSetup !== null) localStorage.setItem("volt:setup-done", setupPrevSetup);
            else localStorage.removeItem("volt:setup-done");
            setup.allOk = setup.bannerSuppressed === true && setup.bannerShows === true &&
              setup.bannerLater === true && setup.opens === true && setup.step2 === true &&
              setup.desktopOption === true && setup.aiShowsModel === true &&
              setup.summary === true && setup.flagDone === true &&
              setup.closes === true && setup.menuReopens === true && !setup.error;
            // ── page manager ───────────────────────────────────
            // exercises add / delete / reorder and the Apply flow end-to-end:
            // the modal opens showing the sample's 3 pages, deleting page 2 +
            // appending a blank reorders the plan, buildEditedPdf produces the
            // expected page set, and Apply swaps the OPEN doc to the rebuilt
            // PDF with annotations renumbered (the page-1 note survives, the
            // page-2 highlight drops with its page). Runs LAST on purpose: it
            // replaces the open document, so nothing after it may depend on
            // the sample. skipDownload keeps the probe from dropping a file
            // into the user's Downloads folder.
            const pageMgr = { error: null };
            const ctrlA = {}; // shared with the allOk check below (outside the try)
            const bsel = {};  // boundary text selection (Ctrl+Shift+Home/End/Space)
            const bhl = {};   // boundary selections offer the Highlight-all toast action
            const hlAll = {}; // Ctrl+A → "Highlight all" toast action
            const wsel = {};  // quick actions label a Ctrl+A selection "whole page"
            const aaa = {};   // Ctrl+A+A selects the whole document when fully rendered
            const clr = {};    // "Clear highlights" quick action on the conversion toast
            const ch = {};     // AI quick row 'Copy highlights' → Markdown notes export
            const aiW = {};    // AI pane: quick row removed, foot actions + stretchable width
            const recent = {}; // home screen: recents dedupe/render/click-reopen
            try {
              const Ann2 = Volt.Ann;
              const App2 = Volt.App;
              // ── Ctrl+A: select all text on the current page ──────────
              // standard-PDF-reader behavior: one native Range covering every
              // text node of the CURRENT page's text layer (not the browser's
              // whole-DOM select-all). Force select mode + page 1 so the test
              // is deterministic regardless of what earlier stages left behind.
              try {
                Volt.Ann.setMode("select");
                App2.goToPage(1, false);
                await new Promise((r) => setTimeout(r, 150));
                const curPage = App2._currentPageNum();
                window.dispatchEvent(new KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true, cancelable: true }));
                const cs = window.getSelection();
                ctrlA.nonEmpty = !!cs && cs.toString().trim().length > 100;
                const layer = App2.rendered.get(curPage) && App2.rendered.get(curPage).textLayer;
                ctrlA.layerOnCurrent = !!layer;
                const r = cs && cs.rangeCount === 1 ? cs.getRangeAt(0) : null;
                ctrlA.singleRange = !!r;
                ctrlA.insideCurrentPage = !!r && !!layer &&
                  layer.contains(r.startContainer) && layer.contains(r.endContainer);
                // the range must span from the FIRST non-whitespace text node
                // to the LAST — i.e. it really covers the whole page's text,
                // not just part of it
                const texts = [];
                if (layer) {
                  const w = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
                  let n; while ((n = w.nextNode())) { if (n.textContent && n.textContent.trim()) texts.push(n); }
                }
                ctrlA.coversWholeLayer = !!r && texts.length > 0 &&
                  r.startContainer === texts[0] && r.startOffset === 0 &&
                  r.endContainer === texts[texts.length - 1] &&
                  r.endOffset === texts[texts.length - 1].length;
                ctrlA.pageStayed = App2._currentPageNum() === 1;
                // ── Highlight all (Ctrl+A → toast action) ──────────────
                // the whole-page selection must surface a "Highlight all"
                // action button in a toast; clicking it converts the selection
                // into ONE highlight annotation on the page (drag geometry
                // quads spanning the selected text, text captured), clears the
                // selection, and undo restores the prior annotation list — the
                // PDF-editor flow without a re-drag.
                try {
                  hlAll.before = Ann2.list.length;
                  const beforeIds = new Set(Ann2.list.map((a) => a.id));
                  const ts = document.querySelectorAll("#toasts .toast");
                  const lastToast = ts.length ? ts[ts.length - 1] : null;
                  const actBtn = lastToast && lastToast.querySelector(".toast-action");
                  hlAll.toastAction = !!actBtn && actBtn.textContent === "Highlight all";
                  if (hlAll.toastAction) {
                    actBtn.click(); // dismisses the toast, then runs onClick synchronously
                    const added = Ann2.list.filter((a) => !beforeIds.has(a.id));
                    hlAll.created = added.length === 1 && added[0].type === "highlight" &&
                      added[0].page === 1 && added[0].quads && added[0].quads.length > 0 &&
                      !!added[0].text && added[0].text.length > 50;
                    const selAfter = window.getSelection();
                    hlAll.selCleared = !selAfter || selAfter.rangeCount === 0 || selAfter.isCollapsed;
                    // the SINGLE-page conversion toast's revert is page-scoped:
                    // the button reads "Clear page 1" (not document-wide), and
                    // clicking it removes ONLY page 1's highlights — the one
                    // just created — with one undo restoring it, so reverting a
                    // stray whole-PAGE highlight never touches other pages.
                    const tsPC = document.querySelectorAll("#toasts .toast");
                    const lastPC = tsPC.length ? tsPC[tsPC.length - 1] : null;
                    const actPC = lastPC && lastPC.querySelector(".toast-action");
                    hlAll.clearPageBtn = !!actPC && actPC.textContent === "Clear page 1";
                    const beforePageClear = Ann2.list.length;
                    // the clear carries the 3-second confirm step: the FIRST
                    // click only arms (label flips to "Really …?", the toast
                    // stays up, NOTHING clears), and only a second click on
                    // the same button runs it
                    if (actPC) {
                      actPC.click(); // 1st click ARMS
                      hlAll.clearPageArmed = actPC.textContent === "Really clear page 1?" &&
                        actPC.classList.contains("armed");
                      hlAll.noClearOnArm = Ann2.list.length === beforePageClear;
                      actPC.click(); // 2nd click on the SAME button decides
                    } else {
                      hlAll.clearPageArmed = false; hlAll.noClearOnArm = false;
                    }
                    hlAll.pageCleared = Ann2.list.length === beforePageClear - 1 &&
                      !Ann2.list.some((a) => a.type === "highlight" && a.page === 1);
                    const tsPCT = document.querySelectorAll("#toasts .toast");
                    const lastPCT = tsPCT.length ? tsPCT[tsPCT.length - 1] : null;
                    hlAll.clearPageToast = !!lastPCT && /Cleared 1 highlight on page 1/.test(lastPCT.textContent);
                    Ann2.undo(); // restores the cleared page-1 highlight
                    hlAll.clearPageUndo = Ann2.list.length === beforePageClear;
                    const beforeUndo = Ann2.list.length;
                    Ann2.undo();
                    hlAll.undoRestores = Ann2.list.length === hlAll.before && beforeUndo === hlAll.before + 1;
                  } else {
                    hlAll.created = false; hlAll.selCleared = false; hlAll.undoRestores = false;
                  }
                } catch (e) { hlAll.error = String((e && e.message) || e); }
                // ── quick actions label a Ctrl+A selection "whole page" ──
                // the Explain selection / Rewrite selection / Translate flows
                // must detect the whole-page selection (Ctrl+A) and embed a
                // short "whole page" label instead of echoing the full page
                // text into the chat; a partial selection keeps the excerpt
                // path. Asserted on the built prompt (no model request fired).
                try {
                  // wait out the Ctrl+A+A double-press window so this is a
                  // FRESH single press (a quick second press would select the
                  // whole document instead of the page)
                  await new Promise((r) => setTimeout(r, 700));
                  window.dispatchEvent(new KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true, cancelable: true }));
                  wsel.wholeDetected = Volt.AI._wholePageSelection() === true;
                  const wholePrompt = Volt.AI._quickPrompt("explain") || "";
                  const selText = (window.getSelection() || {}).toString ? window.getSelection().toString() : "";
                  wsel.wholeLabeled = /whole page/.test(wholePrompt) && wholePrompt.length < 400;
                  wsel.wholeNotEmbedded = !!selText.trim() && !wholePrompt.includes(selText.trim().slice(0, 80));
                  // a partial selection (first two word spans of page 1) must
                  // keep the excerpt-embedding path
                  window.getSelection().removeAllRanges();
                  const layer1 = App2.rendered.get(1) && App2.rendered.get(1).textLayer;
                  const sp = layer1 && layer1.querySelectorAll("span");
                  if (sp && sp.length > 2) {
                    const rr = document.createRange();
                    rr.setStart(sp[0].firstChild, 0);
                    rr.setEndAfter(sp[1]);
                    window.getSelection().addRange(rr);
                  }
                  wsel.partialDetected = Volt.AI._wholePageSelection() === false;
                  const partPrompt = Volt.AI._quickPrompt("rewrite") || "";
                  wsel.partialEmbedded = partPrompt.includes('"""') && partPrompt.length > 60;
                  window.getSelection().removeAllRanges();
                } catch (e) { wsel.error = String((e && e.message) || e); }
                // ── Ctrl+A+A: whole document when fully rendered ──────
                // a second Ctrl+A within 600ms (Ctrl held) selects ACROSS ALL
                // pages when every page is already rendered (small PDFs — the
                // sample's 3 pages), falling back to the current-page
                // selection otherwise. The range must start in page 1's layer
                // and end in page 3's; with a page removed from the render
                // window the double press must stay on the current page.
                try {
                  await new Promise((r) => setTimeout(r, 700)); // fresh gesture
                  // simulate a fully-rendered small PDF: bring every page
                  // into the render window first (the virtualization window
                  // alone keeps ~2 of the sample's 3 pages)
                  await App2._ensurePage(2);
                  await App2._ensurePage(3);
                  await new Promise((r) => setTimeout(r, 150));
                  aaa.allRendered = App2.rendered.size === App2.pageLayout.length && App2.pageLayout.length > 1;
                  window.dispatchEvent(new KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true, cancelable: true }));
                  await new Promise((r) => setTimeout(r, 50));
                  window.dispatchEvent(new KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true, cancelable: true }));
                  await new Promise((r) => setTimeout(r, 100));
                  const sA = window.getSelection();
                  const rA = sA && sA.rangeCount === 1 ? sA.getRangeAt(0) : null;
                  const la1 = App2.rendered.get(1) && App2.rendered.get(1).textLayer;
                  const la3 = App2.rendered.get(3) && App2.rendered.get(3).textLayer;
                  aaa.spansAll = !!rA && !!la1 && !!la3 &&
                    la1.contains(rA.startContainer) && la3.contains(rA.endContainer);
                  aaa.textBig = !!sA && sA.toString().trim().length > 3000;
                  // the Ctrl+A+A status toast mirrors the Ctrl+A toast: it must
                  // say how many pages were selected (with the char count) and
                  // carry the same Highlight-all affordance
                  const tsA = document.querySelectorAll("#toasts .toast");
                  const lastA = tsA.length ? tsA[tsA.length - 1] : null;
                  aaa.toastPages = !!lastA && /Selected all text across 3 pages/.test(lastA.textContent);
                  aaa.toastChars = !!lastA && /chars/.test(lastA.textContent);
                  const actA = lastA && lastA.querySelector(".toast-action");
                  aaa.toastAction = !!actA && actA.textContent === "Highlight all";
                  // clicking the action on the WHOLE-DOCUMENT selection must
                  // create ONE highlight per page (the multi-page path of
                  // highlightSelection — pages 1..3, quads present, selection
                  // cleared) and one undo must restore the prior list
                  const beforeAAA = Ann2.list.length;
                  const aaaIds = new Set(Ann2.list.map((a) => a.id));
                  if (actA) actA.click();
                  const addedAAA = Ann2.list.filter((a) => !aaaIds.has(a.id));
                  aaa.hlAllPages = addedAAA.length === 3 &&
                    addedAAA.every((a) => a.type === "highlight" && a.quads && a.quads.length > 0) &&
                    new Set(addedAAA.map((a) => a.page)).size === 3;
                  // the "Highlighted text on N pages" toast carries a per-page
                  // line-count breakdown ("p.1: 23 lines · p.2: 18 · p.3: 12")
                  const tsH = document.querySelectorAll("#toasts .toast");
                  const lastH = tsH.length ? tsH[tsH.length - 1] : null;
                  // double-escaped on purpose: this probe is a template literal
                  // in main.js, so a single backslash would be eaten and the
                  // regex would silently match nothing (\d -> d, \. -> .)
                  aaa.breakdownShown = !!lastH &&
                    /Highlighted text on 3 pages: p\\.1: \\d+ lines? · p\\.2: \\d+ · p\\.3: \\d+ — Ctrl\\+Z to undo/.test(lastH.textContent);
                  aaa.hlAllUndo = Ann2.list.length === beforeAAA + 3;
                  Ann2.undo();
                  aaa.hlAllUndoRestores = Ann2.list.length === beforeAAA;
                  // "Clear highlights" quick action on the conversion toast:
                  // a stray whole-document highlight is reverted with ONE
                  // click (no Ctrl+Z walk) — re-run the conversion, click the
                  // confirmation toast's Clear button, and verify the list is
                  // back to the pre-conversion state while a single undo
                  // restores ALL of them (the clear is one grouped step).
                  window.getSelection().removeAllRanges();
                  window.dispatchEvent(new KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true, cancelable: true }));
                  await new Promise((r) => setTimeout(r, 100));
                  window.dispatchEvent(new KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true, cancelable: true }));
                  await new Promise((r) => setTimeout(r, 150));
                  const tsCL = document.querySelectorAll("#toasts .toast");
                  const lastCL = tsCL.length ? tsCL[tsCL.length - 1] : null;
                  const actCL = lastCL && lastCL.querySelector(".toast-action");
                  if (actCL) actCL.click(); // conversion toast replaces the selection toast
                  const tsC2 = document.querySelectorAll("#toasts .toast");
                  const lastC2 = tsC2.length ? tsC2[tsC2.length - 1] : null;
                  const actC2 = lastC2 && lastC2.querySelector(".toast-action");
                  clr.btnShown = !!actC2 && actC2.textContent === "Clear highlights";
                  const beforeCLR = Ann2.list.length;
                  // the 3-second 'Really clear?' confirm (the pages-manager
                  // Delete guard, at toast level): one accidental click must
                  // NEVER clear — the first click only arms (label flips,
                  // toast stays up, list untouched), the 3s window expiring
                  // restores the label with the list still untouched (the
                  // arm-then-walk-away path), and only a second click on the
                  // SAME button within the window actually runs the clear.
                  if (actC2) {
                    actC2.click(); // 1st click ARMS
                    clr.armedLabel = actC2.textContent === "Really clear all?" &&
                      actC2.classList.contains("armed");
                    clr.noClearOnArm = Ann2.list.length === beforeCLR;
                    clr.toastStays = actC2.isConnected;
                    await new Promise((r) => setTimeout(r, 3200)); // let the window expire
                    clr.expiryDisarms = actC2.textContent === "Clear highlights" &&
                      !actC2.classList.contains("armed") && Ann2.list.length === beforeCLR;
                    actC2.click(); // re-arm for the deciding click
                    clr.reArmed = actC2.textContent === "Really clear all?" &&
                      actC2.classList.contains("armed");
                    actC2.click(); // 2nd click on the SAME button decides
                  } else {
                    clr.armedLabel = false; clr.noClearOnArm = false; clr.toastStays = false;
                    clr.expiryDisarms = false; clr.reArmed = false;
                  }
                  // the count drops by EXACTLY 3 — all three conversion
                  // highlights gone, nothing else touched (clearHighlights
                  // only removes type "highlight", so a pre-existing
                  // highlight from an earlier stage would make the delta
                  // larger and fail this)
                  clr.cleared = Ann2.list.length === beforeCLR - 3;
                  const tsC3 = document.querySelectorAll("#toasts .toast");
                  const lastC3 = tsC3.length ? tsC3[tsC3.length - 1] : null;
                  clr.toast = !!lastC3 && /Cleared 3 highlights/.test(lastC3.textContent);
                  Ann2.undo();
                  clr.undoRestores = Ann2.list.length === beforeCLR;
                  Ann2.undo(); // back to beforeAAA so later stages start clean
                  // ── clearHighlights(range) — page-scoped API ──────────
                  // the core clear accepts an optional page scope: a number
                  // (single page), an inclusive {from, to}, or a Set of
                  // pages — only those pages' highlights are removed (the
                  // rest keep their marks), each clear is one grouped undo,
                  // and the toast names the scope.
                  Ann2._mutate(() => {
                    for (let p = 1; p <= 3; p++) {
                      Ann2.list.push({
                        id: "seed-clr-" + p, type: "highlight", page: p,
                        quads: [[{ x: 10, y: 10 }, { x: 30, y: 10 }, { x: 30, y: 15 }, { x: 10, y: 15 }]],
                        text: "seeded page " + p, color: "#fde047", createdAt: Date.now(),
                      });
                    }
                  });
                  const seededCount = Ann2.list.length;
                  clr.apiSeed = seededCount === beforeAAA + 3 &&
                    Ann2.list.filter((a) => a.type === "highlight").length === 3;
                  const nPage = Ann2.clearHighlights(2);
                  clr.apiPage = nPage === 1 &&
                    !Ann2.list.some((a) => a.type === "highlight" && a.page === 2) &&
                    Ann2.list.filter((a) => a.type === "highlight").length === 2;
                  const nRange = Ann2.clearHighlights({ from: 1, to: 2 });
                  clr.apiRange = nRange === 1 &&
                    !Ann2.list.some((a) => a.type === "highlight" && (a.page === 1 || a.page === 2)) &&
                    Ann2.list.filter((a) => a.type === "highlight").length === 1;
                  const nSet = Ann2.clearHighlights(new Set([3]));
                  clr.apiSet = nSet === 1 && Ann2.list.filter((a) => a.type === "highlight").length === 0;
                  Ann2.undo(); Ann2.undo(); Ann2.undo(); // un-clear in reverse
                  clr.apiUndo = Ann2.list.length === seededCount;
                  Ann2.undo(); // un-seed
                  clr.apiBackToBefore = Ann2.list.length === beforeAAA;
                  // ── manager surface: 'Clear hl' on the selected pages ──
                  // re-seed one highlight per page, open the manager, select
                  // pages 2–3, click the button — only those pages' marks are
                  // removed (page 1 keeps its highlight), the toast names the
                  // scope, and one undo restores everything.
                  Ann2._mutate(() => {
                    for (let p = 1; p <= 3; p++) {
                      Ann2.list.push({
                        id: "seed-mgr-" + p, type: "highlight", page: p,
                        quads: [[{ x: 10, y: 10 }, { x: 30, y: 10 }, { x: 30, y: 15 }, { x: 10, y: 15 }]],
                        text: "mgr page " + p, color: "#fde047", createdAt: Date.now(),
                      });
                    }
                  });
                  App2.openPagesManager();
                  await new Promise((r) => setTimeout(r, 200));
                  let mgrBefore = -1;
                  try {
                    const mgrGrid = document.getElementById("pages-plan-grid");
                    // native .click() on a FRESH node each time: every plain
                    // click re-renders the grid (_togglePageSel), detaching
                    // stale item references — a second dispatch on a cached
                    // node would silently no-op, so re-query per click
                    const mClick = (pi) => {
                      const it = mgrGrid && mgrGrid.querySelector('.pages-plan-item[data-pi="' + pi + '"]');
                      if (it) it.click();
                    };
                    mClick(1); // select page 2
                    mClick(2); // add page 3 (fresh node after the re-render)
                    mgrBefore = Ann2.list.length;
                    document.getElementById("btn-pages-clear-hl").click();
                    clr.mgrSel = !!App2._pageSel && App2._pageSel.has(1) && App2._pageSel.has(2);
                    clr.mgrCleared = Ann2.list.length === mgrBefore - 2 &&
                      !Ann2.list.some((a) => a.type === "highlight" && (a.page === 2 || a.page === 3)) &&
                      Ann2.list.filter((a) => a.type === "highlight" && a.page === 1).length === 1;
                    const tsM = document.querySelectorAll("#toasts .toast");
                    const lastM = tsM.length ? tsM[tsM.length - 1] : null;
                    clr.mgrToast = !!lastM && /Cleared 2 highlights on pages 2, 3/.test(lastM.textContent);
                    // the modal MUST be closed before later stages run (they
                    // dispatch Ctrl+A etc. on the viewer) — a failure above
                    // must never leave it open, so the close is unconditional
                    // and the assertions below run outside the try
                  } finally {
                    if (!document.getElementById("pages-modal").hidden) {
                      document.getElementById("pages-cancel").click();
                      await new Promise((r) => setTimeout(r, 150));
                    }
                  }
                  clr.mgrClosed = document.getElementById("pages-modal").hidden === true;
                  Ann2.undo(); // restores the manager clear
                  clr.mgrUndoRestores = Ann2.list.length === mgrBefore;
                  Ann2.undo(); // un-seed
                  clr.mgrBackToBefore = Ann2.list.length === beforeAAA;
                  // ── AI quick action: 'Clear highlights' from chat ──
                  // the quick row carries a danger button that shares
                  // clearHighlights() and its grouped undo, gated by the
                  // SAME 3-second confirm: the first click arms ("Really
                  // clear all?", list untouched) and only the second click
                  // runs the clear.
                  Ann2._mutate(() => {
                    for (let p = 1; p <= 3; p++) {
                      Ann2.list.push({
                        id: "seed-qa-" + p, type: "highlight", page: p,
                        quads: [[{ x: 10, y: 10 }, { x: 30, y: 10 }, { x: 30, y: 15 }, { x: 10, y: 15 }]],
                        text: "qa page " + p, color: "#fde047", createdAt: Date.now(),
                      });
                    }
                  });
                  const qaBtn = document.querySelector('.quick-btn[data-action="clear-hl"]');
                  clr.qaShown = !!qaBtn && qaBtn.textContent === "Clear highlights" &&
                    qaBtn.classList.contains("danger");
                  const qaBefore = Ann2.list.length;
                  if (qaBtn) {
                    qaBtn.click(); // 1st click ARMS
                    clr.qaArmed = qaBtn.textContent === "Really clear all?" &&
                      qaBtn.classList.contains("armed");
                    clr.qaNoClear = Ann2.list.length === qaBefore;
                    qaBtn.click(); // 2nd click on the SAME button decides
                  } else {
                    clr.qaArmed = false; clr.qaNoClear = false;
                  }
                  clr.qaCleared = Ann2.list.length === qaBefore - 3 &&
                    !Ann2.list.some((a) => a.type === "highlight");
                  Ann2.undo();
                  clr.qaUndoRestores = Ann2.list.length === qaBefore;
                  Ann2.undo();
                  clr.qaBackToBefore = Ann2.list.length === beforeAAA;
                  // ── AI quick action: 'Copy highlights' (Markdown notes) ──
                  // the symmetric, non-destructive companion to the clear:
                  // exports every TEXT highlight (quads + text only — the
                  // blank-space area fallback and Rectangle shapes carry no
                  // text and must be skipped) grouped by page with a
                  // '## Page N' header each, passages in reading order
                  // (top-to-bottom within a page). The clipboard write is
                  // stubbed and captured; the list must be UNTOUCHED by the
                  // copy. Two phases: the empty case first (nothing seeded
                  // yet, so the button toasts instead of copying), then
                  // with seeds.
                  const chBtn = document.querySelector('.quick-btn[data-action="copy-hl"]');
                  ch.shown = !!chBtn && chBtn.textContent === "Copy highlights" &&
                    !chBtn.classList.contains("danger");
                  window.__copiedHls = null;
                  let chBefore = 0;
                  const origWriteCh = App2._writeClipboard;
                  App2._writeClipboard = async (txt) => { window.__copiedHls = txt; return true; };
                  try {
                    if (chBtn) {
                      chBtn.click(); // empty case — the list has no highlights here
                      await new Promise((r) => setTimeout(r, 150));
                      const tsE = document.querySelectorAll("#toasts .toast");
                      const lastE = tsE.length ? tsE[tsE.length - 1] : null;
                      ch.emptyToast = !!lastE && /No text highlights to copy/.test(lastE.textContent);
                      ch.emptyNoCopy = window.__copiedHls === null;
                      // seed: page 1 (one), page 2 (two, out of reading
                      // order), page 3 (one) — plus an empty-text area
                      // fallback and a Rectangle shape, both of which the
                      // export must skip
                      Ann2._mutate(() => {
                        const mk = (p, y, text) => ({ id: "seed-ch-" + text, type: "highlight", page: p,
                          quads: [[{ x: 10, y }, { x: 30, y }, { x: 30, y: y + 5 }, { x: 10, y: y + 5 }]],
                          text, color: "#fde047", createdAt: Date.now() });
                        Ann2.list.push(mk(1, 10, "ch first passage"));
                        Ann2.list.push(mk(2, 100, "ch lower passage"));
                        Ann2.list.push(mk(2, 300, "ch upper passage"));
                        Ann2.list.push(mk(3, 10, "ch last passage"));
                        Ann2.list.push({ id: "seed-ch-empty", type: "highlight", page: 2,
                          rect: { x: 10, y: 10, w: 20, h: 20 }, text: "", color: "#fde047", createdAt: Date.now() });
                        Ann2.list.push({ id: "seed-ch-rect", type: "rect", page: 2,
                          rect: { x: 10, y: 10, w: 20, h: 20 }, text: "", color: "#fde047", createdAt: Date.now() });
                      });
                      chBefore = Ann2.list.length;
                      chBtn.click(); // seeded case
                      const tCH = Date.now();
                      while (Date.now() - tCH < 8000 && !window.__copiedHls) await new Promise((r) => setTimeout(r, 100));
                      // the capture is set synchronously by the stub, but the
                      // success toast fires in the awaited continuation — give
                      // the microtask a beat before reading the toast list
                      await new Promise((r) => setTimeout(r, 100));
                    } else {
                      ch.emptyToast = false; ch.emptyNoCopy = false;
                    }
                  } finally {
                    App2._writeClipboard = origWriteCh;
                  }
                  const chText = window.__copiedHls || "";
                  ch.copied = !!window.__copiedHls && chText.length > 0;
                  const i1 = chText.indexOf("## Page 1");
                  const i2 = chText.indexOf("## Page 2");
                  const i3 = chText.indexOf("## Page 3");
                  ch.hasHeaders = i1 >= 0 && i2 > i1 && i3 > i2;
                  ch.hasPassages = chText.indexOf("ch first passage") >= 0 &&
                    chText.indexOf("ch upper passage") >= 0 &&
                    chText.indexOf("ch lower passage") >= 0 &&
                    chText.indexOf("ch last passage") >= 0;
                  // reading order within page 2: the upper passage (y=300,
                  // PDF y-up) must come before the lower one (y=100)
                  const iU = chText.indexOf("ch upper passage");
                  const iL = chText.indexOf("ch lower passage");
                  ch.order = iU >= 0 && iL > iU;
                  // exactly the 4 text passages — the empty-text area
                  // fallback and the Rectangle shape are excluded
                  ch.passageCount = (chText.match(/^> /gm) || []).length === 4;
                  ch.excludesEmpty = chText.indexOf("seed-ch") < 0;
                  ch.noMutate = chBefore > 0 && Ann2.list.length === chBefore;
                  const tsCH = document.querySelectorAll("#toasts .toast");
                  const lastCH = tsCH.length ? tsCH[tsCH.length - 1] : null;
                  ch.countToast = !!lastCH && /Copied 4 highlights from 3 pages/.test(lastCH.textContent);
                  Ann2.undo(); // removes the whole seed group (one grouped step)
                  ch.undoRestores = Ann2.list.length === beforeAAA;
                  // ── AI pane: quick row gone + stretchable width ───────
                  // the quick-prompt row is removed so the input area stays
                  // one row tall (more room to type); only the two utility
                  // actions survive, relocated into the foot line with the
                  // same handlers. The pane itself is user-stretchable via
                  // the #ai-resize handle: drag LEFT to grow / right to
                  // shrink (persisted to volt:ai:panel-w), arrow keys once
                  // focused, double-click resets to the default width.
                  aiW.noQuickRow = !document.querySelector(".ai-quick");
                  aiW.quickPromptsGone = !document.querySelector('.quick-btn[data-action="summarize"]');
                  const aiWClear = document.querySelector("#ai-foot-clear-hl");
                  const aiWCopy = document.querySelector("#ai-foot-copy-hl");
                  aiW.footClear = !!aiWClear && aiWClear.textContent === "Clear highlights" &&
                    aiWClear.classList.contains("danger");
                  aiW.footCopy = !!aiWCopy && aiWCopy.textContent === "Copy highlights";
                  const aiWHandle = document.querySelector("#ai-resize");
                  aiW.handleThere = !!aiWHandle;
                  const curW = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--ai-w")) || 340;
                  const defW = curW();
                  if (aiWHandle) {
                    const rect = document.getElementById("ai-panel").getBoundingClientRect();
                    aiWHandle.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, clientX: rect.left }));
                    window.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: rect.left - 120 }));
                    window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
                    await new Promise((r) => setTimeout(r, 30));
                    aiW.dragGrew = curW() === defW + 120 &&
                      !document.body.classList.contains("resizing-ai");
                    aiW.persisted = localStorage.getItem("volt:ai:panel-w") === String(defW + 120);
                    aiWHandle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
                    aiW.arrowShrinks = curW() === defW + 100;
                    aiWHandle.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
                    await new Promise((r) => setTimeout(r, 30));
                    aiW.dblReset = curW() === defW && !localStorage.getItem("volt:ai:panel-w");
                  } else {
                    aiW.dragGrew = false; aiW.persisted = false; aiW.arrowShrinks = false; aiW.dblReset = false;
                  }
                  // ── home screen: recent documents ────────────────────
                  // the welcome state is productivity-first: recently opened
                  // documents (paths / URLs) are tracked under
                  // volt:recent-docs, rendered into the grid, and a click
                  // reopens the right source. Assert the loop with stubs.
                  const prevRecent = localStorage.getItem("volt:recent-docs");
                  let App3 = null;
                  try {
                    localStorage.removeItem("volt:recent-docs");
                    App3 = Volt.App;
                    App3._pushRecent({ name: "one.pdf", path: "C:\\docs\\one.pdf" });
                    App3._pushRecent({ name: "two.pdf", path: "C:\\docs\\two.pdf" });
                    App3._pushRecent({ name: "one.pdf", path: "C:\\docs\\one.pdf" }); // dedupe → back to front
                    let list = JSON.parse(localStorage.getItem("volt:recent-docs") || "[]");
                    recent.deduped = list.length === 2 && list[0].path === "C:\\docs\\one.pdf";
                    App3._renderRecents();
                    const rGrid = document.getElementById("recent-grid");
                    const rItems = rGrid ? [...rGrid.querySelectorAll(".recent-item")] : [];
                    recent.rendered = rItems.length === 2 && rItems[0].textContent.includes("one.pdf") &&
                      rItems[0].textContent.includes("C:\\docs");
                    recent.sectionShown = document.getElementById("recent-docs").hidden === false;
                    const rOrigOpen = App3.openPath;
                    App3.openPath = async (p) => { window.__recentOpened = p; return true; };
                    try {
                      if (rItems.length) rItems[0].click();
                    } finally { App3.openPath = rOrigOpen; }
                    recent.clickOpens = window.__recentOpened === "C:\\docs\\one.pdf";
                    // a URL entry renders with its host and stays reopenable
                    App3._pushRecent({ name: "web.pdf", url: "https://example.com/web.pdf" });
                    App3._renderRecents();
                    recent.urlEntry = [...document.getElementById("recent-grid").querySelectorAll(".recent-item")]
                      .some((i) => i.textContent.includes("web.pdf") && i.textContent.includes("example.com"));
                    // the empty state itself: the primary CTA up top, the old
                    // marketing copy + feature badges gone
                    recent.primaryCta = document.getElementById("btn-open-empty").textContent === "Open a PDF";
                    recent.noMarketing = !document.querySelector(".empty-badges") &&
                      !/Read\. Annotate\. Ask/.test(document.getElementById("empty-state").textContent);
                    delete window.__recentOpened;
                  } finally {
                    if (prevRecent) localStorage.setItem("volt:recent-docs", prevRecent);
                    else localStorage.removeItem("volt:recent-docs");
                    App3 && App3._renderRecents();
                  }
                  recent.allOk = recent.deduped === true && recent.rendered === true &&
                    recent.sectionShown === true && recent.clickOpens === true &&
                    recent.urlEntry === true && recent.primaryCta === true && recent.noMarketing === true;
                  // on-demand render: with a page un-rendered, the same
                  // double press must render it ON THE SPOT (the
                  // Ctrl+Shift+Space behavior) and select across ALL pages
                  // again — not fall back to the current page. The range must
                  // span pages 1→3 and page 2 must be re-rendered.
                  window.getSelection().removeAllRanges();
                  App2._disposePage(2);
                  await new Promise((r) => setTimeout(r, 700)); // fresh gesture again
                  window.dispatchEvent(new KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true, cancelable: true }));
                  await new Promise((r) => setTimeout(r, 50));
                  window.dispatchEvent(new KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true, cancelable: true }));
                  // the selection lands after page 2 renders on demand — poll
                  const t0 = Date.now();
                  let sF = null, rF = null, lF1 = null, lF3 = null;
                  while (Date.now() - t0 < 8000) {
                    sF = window.getSelection();
                    rF = sF && sF.rangeCount === 1 ? sF.getRangeAt(0) : null;
                    lF1 = App2.rendered.get(1) && App2.rendered.get(1).textLayer;
                    lF3 = App2.rendered.get(3) && App2.rendered.get(3).textLayer;
                    if (rF && lF1 && lF3 && lF1.contains(rF.startContainer) && lF3.contains(rF.endContainer)) break;
                    await new Promise((r) => setTimeout(r, 100));
                  }
                  aaa.rendersOnDemand = !!rF && !!lF1 && !!lF3 &&
                    lF1.contains(rF.startContainer) && lF3.contains(rF.endContainer) &&
                    !!sF && sF.toString().trim().length > 3000;
                  aaa.reRendered = App2.rendered.has(2) && !!(App2.rendered.get(2) && App2.rendered.get(2).textLayer);
                  // keep-all render pin: after the on-demand pass the freshly
                  // rendered pages must SURVIVE the next scroll (the disposal
                  // pass _renderVisible runs on every scroll) instead of being
                  // re-disposed by the virtualization window. Prove the gate
                  // is real: with a synthetic far-page entry the window WOULD
                  // dispose, the pin must keep it — and clearing the pin must
                  // dispose it (the 3-page sample's window always covers the
                  // whole doc, so the far page is what distinguishes the two).
                  aaa.pinned = App2._keepAllRendered === true;
                  const fakeWrap = document.createElement("div");
                  App2.rendered.set(9, { wrap: fakeWrap, canvas: null, textLayer: null, overlay: null, viewport: null });
                  App2._renderVisible(); // the exact scroll path (_onScroll)
                  aaa.pagesSurviveScroll = App2.rendered.has(1) && App2.rendered.has(2) &&
                    App2.rendered.has(3) && App2.rendered.has(9);
                  App2._keepAllRendered = false;
                  App2._renderVisible();
                  aaa.gateIsReal = !App2.rendered.has(9); // cleared pin → far page disposed
                  App2._keepAllRendered = true; // restore for the later stages
                  // the on-demand Ctrl+A+A render ALSO touches the sidebar
                  // thumbnails: the gesture must re-paint the Pages panel so
                  // it shows every page the toast counts. Clear the sidebar's
                  // grid + rendered-set, run the gesture, and poll until the
                  // grid holds one thumb per page again (the shared thumb
                  // cache blits the doc-open pass's bitmaps, so this is fast
                  // and deterministic — nothing else repopulates the grid
                  // between the clear and the poll).
                  window.getSelection().removeAllRanges();
                  const tGrid = document.getElementById("thumb-grid");
                  tGrid.innerHTML = "";
                  App2.thumbRendered.clear();
                  await new Promise((r) => setTimeout(r, 700)); // fresh gesture
                  window.dispatchEvent(new KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true, cancelable: true }));
                  await new Promise((r) => setTimeout(r, 50));
                  window.dispatchEvent(new KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true, cancelable: true }));
                  await new Promise((r) => setTimeout(r, 120));
                  const tT0 = Date.now();
                  let thumbsTouched = false;
                  while (Date.now() - tT0 < 8000) {
                    if (tGrid.querySelectorAll(".thumb-item").length >= 3 && App2.thumbRendered.size >= 3) {
                      thumbsTouched = true;
                      break;
                    }
                    await new Promise((r) => setTimeout(r, 100));
                  }
                  aaa.thumbsTouched = thumbsTouched;
                  aaa.thumbsMatchToast = tGrid.querySelectorAll(".thumb-item").length === 3 &&
                    App2.thumbRendered.size === 3;
                  // Escape-to-cancel: with the pages disposed and a per-page
                  // delay injected, the same double press starts an on-demand
                  // render and Escape aborts it mid-flight — no selection is
                  // built, the cancel toast fires, and the cancel flag clears
                  // so the next render works normally.
                  window.getSelection().removeAllRanges();
                  App2._disposePage(2);
                  App2._disposePage(3);
                  window.__voltRangeRenderDelay = 60; // slow the render enough to catch
                  await new Promise((r) => setTimeout(r, 700)); // fresh gesture
                  window.dispatchEvent(new KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true, cancelable: true }));
                  await new Promise((r) => setTimeout(r, 50));
                  window.dispatchEvent(new KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true, cancelable: true }));
                  await new Promise((r) => setTimeout(r, 80)); // page 2's render + delay in flight
                  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
                  await new Promise((r) => setTimeout(r, 250)); // let the abort land
                  aaa.escFlagCleared = App2._rangeRenderCancel === null;
                  const sE = window.getSelection();
                  aaa.escNoSelect = !sE || sE.rangeCount === 0 || sE.isCollapsed;
                  const tsE = document.querySelectorAll("#toasts .toast");
                  const lastE = tsE.length ? tsE[tsE.length - 1] : null;
                  aaa.escToast = !!lastE && /[Cc]ancel/.test(lastE.textContent);
                  delete window.__voltRangeRenderDelay;
                  window.getSelection().removeAllRanges();
                  // restore the render window for the following stages
                  await App2._ensurePage(2);
                  await App2._ensurePage(3);
                  await new Promise((r) => setTimeout(r, 150));
                  aaa.renderedRestored = App2.rendered.has(1) && App2.rendered.has(2) && App2.rendered.has(3);
                  // the selection toast PERSISTS until dismissed (sticky — no
                  // auto-expire timer, dismissable) so a long selection's page
                  // count stays visible while reviewing; a fresh Ctrl+A+A
                  // re-creates it, and a pointerdown anywhere outside the
                  // toast clears it (fade + remove from the DOM).
                  window.getSelection().removeAllRanges();
                  await new Promise((r) => setTimeout(r, 700)); // fresh gesture
                  window.dispatchEvent(new KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true, cancelable: true }));
                  await new Promise((r) => setTimeout(r, 50));
                  window.dispatchEvent(new KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true, cancelable: true }));
                  await new Promise((r) => setTimeout(r, 150));
                  const tsP = document.querySelectorAll("#toasts .toast");
                  const lastP = tsP.length ? tsP[tsP.length - 1] : null;
                  aaa.persistSticky = !!lastP && /Selected all text across/.test(lastP.textContent) && !lastP._timer;
                  aaa.persistDismissable = !!lastP && typeof lastP._dismiss === "function";
                  document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
                  await new Promise((r) => setTimeout(r, 450)); // fade (320ms) + remove
                  aaa.outsideDismisses = !!lastP && !lastP.isConnected;
                  // status-bar range readout: while a whole-document selection
                  // is active #sb-sel shows the spanned pages ("· Sel p.1–3"),
                  // narrowing LIVE when the range changes (Ctrl+Shift+End from
                  // page 2 → p.2–3) and hiding when the selection is cleared.
                  const sbSelEl = document.getElementById("sb-sel");
                  window.getSelection().removeAllRanges();
                  await new Promise((r) => setTimeout(r, 700)); // fresh gesture
                  window.dispatchEvent(new KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true, cancelable: true }));
                  await new Promise((r) => setTimeout(r, 50));
                  window.dispatchEvent(new KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true, cancelable: true }));
                  await new Promise((r) => setTimeout(r, 150));
                  aaa.selRangeShown = !sbSelEl.hidden && /Sel p\.1–3/.test(sbSelEl.textContent);
                  App2.goToPage(2, false);
                  await new Promise((r) => setTimeout(r, 200));
                  window.getSelection().removeAllRanges();
                  await new Promise((r) => setTimeout(r, 700)); // fresh gesture
                  window.dispatchEvent(new KeyboardEvent("keydown", { key: "End", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
                  await new Promise((r) => setTimeout(r, 150));
                  aaa.selRangeNarrows = !sbSelEl.hidden && /Sel p\.2–3/.test(sbSelEl.textContent);
                  window.getSelection().removeAllRanges();
                  await new Promise((r) => setTimeout(r, 120));
                  aaa.selRangeClears = sbSelEl.hidden === true;
                  // Copy w/ citations: the persistent toast now carries a
                  // SECOND action that copies each page's text under a
                  // "— p. N" header. Stub the clipboard write, click it, and
                  // verify the captured text spans pages 1→3 in order with
                  // the em-dash headers and real page text.
                  window.getSelection().removeAllRanges();
                  await new Promise((r) => setTimeout(r, 700)); // fresh gesture
                  window.dispatchEvent(new KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true, cancelable: true }));
                  await new Promise((r) => setTimeout(r, 50));
                  window.dispatchEvent(new KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true, cancelable: true }));
                  await new Promise((r) => setTimeout(r, 150));
                  const tsC = document.querySelectorAll("#toasts .toast");
                  const lastC = tsC.length ? tsC[tsC.length - 1] : null;
                  const actsC = lastC ? [...lastC.querySelectorAll(".toast-action")] : [];
                  aaa.copyBtnShown = actsC.length === 2 &&
                    actsC[0].textContent === "Highlight all" && /Copy.*citations/.test(actsC[1].textContent);
                  window.__copiedCites = null;
                  const origWrite = App2._writeClipboard;
                  App2._writeClipboard = async (txt) => { window.__copiedCites = txt; return true; };
                  try {
                    if (actsC[1]) actsC[1].click();
                    const tC0 = Date.now();
                    while (Date.now() - tC0 < 8000 && !window.__copiedCites) await new Promise((r) => setTimeout(r, 100));
                  } finally {
                    App2._writeClipboard = origWrite;
                  }
                  const cc = window.__copiedCites || "";
                  // String.fromCharCode(10) instead of a backslash-n escape —
                  // this whole probe is a template literal in main.js, so an
                  // escape sequence in the source would collapse to a real
                  // newline and break the probe's own string literals
                  const NL = String.fromCharCode(10);
                  aaa.copyHasHeaders = cc.includes("— p. 1" + NL) && cc.includes("— p. 2" + NL) && cc.includes("— p. 3" + NL);
                  aaa.copyInOrder = cc.indexOf("— p. 1" + NL) < cc.indexOf("— p. 2" + NL) &&
                    cc.indexOf("— p. 2" + NL) < cc.indexOf("— p. 3" + NL);
                  aaa.copyHasText = cc.length > 3000;
                  const tsCC = document.querySelectorAll("#toasts .toast");
                  const lastCC = tsCC.length ? tsCC[tsCC.length - 1] : null;
                  aaa.copyToast = !!lastCC && /Copied 3 pages with citations/.test(lastCC.textContent);
                  window.getSelection().removeAllRanges();
                } catch (e) { aaa.error = String((e && e.message) || e); }
                // inside a text field Ctrl+A keeps its native select-all-text
                // meaning — the app must NOT hijack it into a page selection.
                // Focusing an input already clears the document selection
                // (native focus behavior), so after dispatching Ctrl+A on the
                // focused input the app must leave the document selection empty
                const search = document.getElementById("search-input");
                search.focus();
                search.dispatchEvent(new KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true, cancelable: true }));
                ctrlA.inputNotHijacked = !window.getSelection() ||
                  window.getSelection().rangeCount === 0 ||
                  window.getSelection().toString().trim().length === 0;
                search.blur();
                // clean up so no later stage sees the selection
                window.getSelection().removeAllRanges();
              } catch (e) { ctrlA.error = String((e && e.message) || e); }
              // ── Ctrl+Shift+Home/End/Space: select text to the boundary ──
              // the whole-document analog of Ctrl+A (mirroring editors):
              // Ctrl+Shift+End from page 1 must produce ONE range that starts
              // in page 1's text layer and ENDS in the last page's layer,
              // Ctrl+Shift+Home from the last page must span back to page 1,
              // and the requested Ctrl+Shift+Space key must do the End
              // behavior. selectTextRange renders any pages outside the
              // viewport window first, so the assertions poll for the async
              // selection to land.
              try {
                const layerOf = (p) => { const rr = App2.rendered.get(p); return rr && rr.textLayer; };
                const rangeNow = () => {
                  const s = window.getSelection();
                  const r = s && s.rangeCount === 1 ? s.getRangeAt(0) : null;
                  return r;
                };
                const waitSel = async (startPage, endPage) => {
                  const t0 = Date.now();
                  while (Date.now() - t0 < 8000) {
                    const r = rangeNow();
                    const ls = layerOf(startPage), le = layerOf(endPage);
                    if (r && ls && le && ls.contains(r.startContainer) && le.contains(r.endContainer)) return true;
                    await new Promise((rr) => setTimeout(rr, 100));
                  }
                  return false;
                };
                Volt.Ann.setMode("select");
                App2.goToPage(1, false);
                await new Promise((r) => setTimeout(r, 150));
                window.dispatchEvent(new KeyboardEvent("keydown", { key: "End", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
                bsel.endOk = await waitSel(1, 3);
                // the range must START at page 1's FIRST text node, offset 0
                // (whole-range coverage, not a partial page)
                const rEnd = rangeNow();
                const l1 = layerOf(1);
                if (rEnd && l1) {
                  const w1 = document.createTreeWalker(l1, NodeFilter.SHOW_TEXT);
                  let f1 = null; while ((f1 = w1.nextNode())) { if (f1.textContent && f1.textContent.trim()) break; }
                  bsel.endStartsAtFirst = !!f1 && rEnd.startContainer === f1 && rEnd.startOffset === 0;
                } else bsel.endStartsAtFirst = false;
                // Ctrl+Shift+Home from the LAST page spans back to page 1
                App2.goToPage(3, false);
                await new Promise((r) => setTimeout(r, 150));
                window.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
                bsel.homeOk = await waitSel(1, 3);
                // the requested Ctrl+Shift+Space (current page → end): back on
                // page 1, it must produce the same bottom selection
                App2.goToPage(1, false);
                await new Promise((r) => setTimeout(r, 150));
                window.dispatchEvent(new KeyboardEvent("keydown", { key: " ", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
                bsel.spaceOk = await waitSel(1, 3);
                // boundary selections offer the SAME Highlight-all action as
                // Ctrl+A+A: the persistent toast shows "Selected text across 3
                // pages" with both action buttons, and clicking Highlight all
                // converts the whole range into one highlight per page with a
                // single undo restoring the prior list
                const beforeBhl = Ann2.list.length;
                const bhlIds = new Set(Ann2.list.map((a) => a.id));
                const tsB = document.querySelectorAll("#toasts .toast");
                const lastB = tsB.length ? tsB[tsB.length - 1] : null;
                const actsB = lastB ? [...lastB.querySelectorAll(".toast-action")] : [];
                bhl.toastOffered = !!lastB && /Selected text across 3 pages/.test(lastB.textContent) &&
                  actsB.length === 2 && actsB[0].textContent === "Highlight all" && /Copy/.test(actsB[1].textContent);
                if (actsB[0]) actsB[0].click();
                const addedB = Ann2.list.filter((a) => !bhlIds.has(a.id));
                bhl.created = addedB.length === 3 &&
                  addedB.every((a) => a.type === "highlight" && a.quads && a.quads.length > 0) &&
                  new Set(addedB.map((a) => a.page)).size === 3;
                const beforeBhlUndo = Ann2.list.length;
                Ann2.undo();
                bhl.undoRestores = Ann2.list.length === beforeBhl && beforeBhlUndo === beforeBhl + 3;
                window.getSelection().removeAllRanges();
              } catch (e) { bsel.error = String((e && e.message) || e); }
              // seed the sample with a note on page 1 and a highlight on page 2
              Ann2.list = [];
              Ann2.history = [];
              Ann2.redoStack = [];
              const seedNote = { id: Utils.uid(), type: "note", page: 1, point: { x: 100, y: 100 }, text: "p1 note", color: "#fde047", createdAt: Date.now() };
              // NOTE: quads must be an array of QUADS (each a 4-point polygon),
              // not a flat point list — renderOverlay maps over each element
              const seedHi = { id: Utils.uid(), type: "highlight", page: 2, quads: [[{ x: 10, y: 10 }, { x: 30, y: 10 }, { x: 30, y: 15 }, { x: 10, y: 15 }]], text: "", color: "#fde047", createdAt: Date.now() };
              Ann2._mutate(() => { Ann2.list.push(seedNote, seedHi); });
              // ── sidebar thumbnails share the manager's rasterizer + badges ──
              // the seeding above triggered _afterChange → refreshThumbBadges,
              // so the ALREADY-RENDERED sidebar thumb for page 1 gained its ann
              // badge in place (no re-rasterization)
              const sgrid = document.getElementById("thumb-grid");
              const side0 = sgrid.querySelector('.thumb-item[data-page="1"]');
              const sann0 = side0 && side0.querySelector(".pages-ann");
              pageMgr.sideLiveBadge = !!(sann0 && sann0.textContent === "1");
              pageMgr.sideLiveTitle = !!(sann0 && sann0.title === "1 annotation on this page");
              // count AND tooltip must track changes in place (no re-render):
              // a second page-1 note moves the badge 1→2, removing it brings
              // it back 2→1 — a stale title after an update is a real bug
              const seedNote2 = { id: Utils.uid(), type: "note", page: 1, point: { x: 200, y: 200 }, text: "p1 note 2", color: "#fde047", createdAt: Date.now() };
              Ann2._mutate(() => { Ann2.list.push(seedNote2); });
              const sannUpd = side0 && side0.querySelector(".pages-ann");
              pageMgr.sideLiveUpdate = !!(sannUpd && sannUpd.textContent === "2" &&
                sannUpd.title === "2 annotations on this page");
              Ann2._mutate(() => { Ann2.list = Ann2.list.filter((a) => a.id !== seedNote2.id); });
              const sannRev = side0 && side0.querySelector(".pages-ann");
              pageMgr.sideLiveRevert = !!(sannRev && sannRev.textContent === "1" &&
                sannRev.title === "1 annotation on this page");
              // fresh render: same badges as the manager, and the shared cache
              // must warm ("d:1") so the manager's grid blits it instead of
              // re-rasterizing
              App2._renderThumbs();
              await new Promise((r) => setTimeout(r, 700));
              const sitems = [...sgrid.querySelectorAll(".thumb-item")];
              const s1 = sitems[0] || sgrid.querySelector('.thumb-item[data-page="1"]');
              const s1sz = s1 && s1.querySelector(".pages-size");
              const s1ann = s1 && s1.querySelector(".pages-ann");
              const sdm0 = App2.pageDims[0];
              const sszm = s1sz && s1sz.textContent.match(/^([0-9.]+) \\u00d7 ([0-9.]+) in$/);
              pageMgr.sideThumbs = sitems.length === 3;
              pageMgr.sideSizeBadge = !!(s1sz && sszm);
              pageMgr.sideSizeAccurate = !!(sdm0 && sszm &&
                Math.abs(parseFloat(sszm[1]) * 72 - sdm0.w) < 1 && Math.abs(parseFloat(sszm[2]) * 72 - sdm0.h) < 1);
              pageMgr.sideAnnBadge = !!(s1ann && s1ann.textContent === "1");
              const s3 = sitems[2] || sgrid.querySelector('.thumb-item[data-page="3"]');
              pageMgr.sideAnnNone = !!s3 && !s3.querySelector(".pages-ann");
              pageMgr.sideWarmsCache = App2._pageThumbCache.has("d:1") &&
                App2._pageThumbCache.get("d:1").width > 100;
              // removing the last page-1 annotation drops the badge IN PLACE on
              // the fresh thumbs too (then restore it for the manager tests)
              Ann2._mutate(() => { Ann2.list = Ann2.list.filter((a) => a.id !== seedNote.id); });
              pageMgr.sideRemoval = !sgrid.querySelector('.thumb-item[data-page="1"] .pages-ann');
              Ann2._mutate(() => { Ann2.list.push(seedNote); });
              // ── 'Select annotated' in the sidebar (no manager needed) ──
              // the same set the manager picks — currently pages 1 (note) and
              // 2 (highlight). Clicking the sidebar button builds the page set
              // (the sidebar's page-number selection model), shows the
              // block-actions row like a hand-made selection, and toasts.
              App2._thumbSel = null;
              App2._thumbSelAnchor = null;
              App2._applyThumbSel();
              document.getElementById("btn-thumb-select-ann").click();
              pageMgr.sideSelAnnSet = !!(App2._thumbSel && App2._thumbSel.size === 2 &&
                App2._thumbSel.has(1) && App2._thumbSel.has(2));
              pageMgr.sideSelAnnAnchor = App2._thumbSelAnchor === 1;
              pageMgr.sideSelAnnClasses = [1, 2].every((p) =>
                sgrid.querySelector('.thumb-item[data-page="' + p + '"]').classList.contains("sel")) &&
                !sgrid.querySelector('.thumb-item[data-page="3"]').classList.contains("sel");
              pageMgr.sideSelAnnRow = document.getElementById("thumb-block-actions").hidden === false;
              pageMgr.sideSelAnnToast = [...document.querySelectorAll(".toast")].some((t) =>
                t.textContent.includes("Selected 2 annotated pages"));
              // the set TRACKS the annotation list: add a page-3 note → all
              // three pages; drop it AND the page-2 highlight → back to {1}
              const seedNote3 = { id: Utils.uid(), type: "note", page: 3, point: { x: 300, y: 300 }, text: "p3 note", color: "#fde047", createdAt: Date.now() };
              Ann2._mutate(() => { Ann2.list.push(seedNote3); });
              document.getElementById("btn-thumb-select-ann").click();
              pageMgr.sideSelAnnGrows = !!(App2._thumbSel && App2._thumbSel.size === 3 &&
                App2._thumbSel.has(3));
              Ann2._mutate(() => {
                Ann2.list = Ann2.list.filter((a) => a.id !== seedNote3.id && a.id !== seedHi.id);
              });
              document.getElementById("btn-thumb-select-ann").click();
              pageMgr.sideSelAnnShrinks = !!(App2._thumbSel && App2._thumbSel.size === 1 &&
                App2._thumbSel.has(1));
              pageMgr.sideSelAnnToast1 = [...document.querySelectorAll(".toast")].some((t) =>
                t.textContent.includes("Selected 1 annotated page"));
              // no annotations at all → honest toast, selection untouched
              // (the same early-return the manager's button makes)
              Ann2._mutate(() => { Ann2.list = Ann2.list.filter((a) => a.id !== seedNote.id); });
              document.getElementById("btn-thumb-select-ann").click();
              pageMgr.sideSelAnnNone = [...document.querySelectorAll(".toast")].some((t) =>
                t.textContent.includes("No annotated pages in this document"));
              pageMgr.sideSelAnnKept = !!(App2._thumbSel && App2._thumbSel.size === 1 &&
                App2._thumbSel.has(1)); // {1} still selected — early return
              // restore the exact seeding for the manager tests below, and
              // clear the sidebar selection so nothing bleeds into them
              Ann2._mutate(() => { Ann2.list.push(seedNote, seedHi); });
              App2._thumbSel = null;
              App2._thumbSelAnchor = null;
              App2._applyThumbSel();
              App2.openPagesManager();
              const pm = document.getElementById("pages-modal");
              const grid = document.getElementById("pages-plan-grid");
              await new Promise((r) => setTimeout(r, 250));
              pageMgr.opened = pm.hidden === false;
              pageMgr.initialThumbs = grid.querySelectorAll(".pages-plan-item").length;
              pageMgr.initialPlan = (App2._pagePlan || []).length;
              // redo starts empty in a fresh session (nothing has been undone)
              pageMgr.redoInitialDisabled = document.getElementById("btn-pages-redo").disabled === true;
              // the selection line surfaces the staged-undo shortcut: with no
              // edits staged it teaches the key (discoverability)
              pageMgr.selInfoText0 = document.getElementById("pages-sel-info").textContent;
              // NOTE: use includes(), not a regex literal — the injected probe is a
              // template literal, and \+ would cook to + (quantifier) and silently
              // break the match. Plain string checks are immune.
              pageMgr.selHintDiscover = pageMgr.selInfoText0.includes("Ctrl+Z undoes edits");
              // thumbnails rasterize async — give the canvases time to paint,
              // then assert they REALLY painted (a regression that silently
              // breaks the rasterizer must fail here, not just look blank)
              await new Promise((r) => setTimeout(r, 700));
              const item0 = grid.querySelector('[data-pi="0"]');
              const cv0 = item0 && item0.querySelector("canvas");
              const sz0 = item0 && item0.querySelector(".pages-size");
              const ann0 = item0 && item0.querySelector(".pages-ann");
              pageMgr.thumbRendered = !!(cv0 && cv0.width > 100);
              pageMgr.sizeBadge = !!(sz0 && /^[0-9]+([.][0-9]+)? \\u00d7 [0-9]+([.][0-9]+)? in$/.test(sz0.textContent));
              const dm0 = App2.pageDims[0];
              const szm = sz0 && sz0.textContent.match(/^([0-9.]+) \\u00d7 ([0-9.]+) in$/);
              pageMgr.sizeAccurate = !!(dm0 && szm &&
                Math.abs(parseFloat(szm[1]) * 72 - dm0.w) < 1 && Math.abs(parseFloat(szm[2]) * 72 - dm0.h) < 1);
              // page 1 holds the seeded note → count badge "1"; page 3 has
              // none → no badge at all
              pageMgr.annBadge = !!(ann0 && ann0.textContent === "1");
              const item2 = grid.querySelector('[data-pi="2"]');
              pageMgr.annNone = !!item2 && !item2.querySelector(".pages-ann");
              const docSizeLabel = sz0 ? sz0.textContent : "";
              // select page 2 (plan index 1) — it carries the seeded
              // highlight, so Delete arms a 3-second 'Really delete 1
              // annotated page?' confirm instead of staging immediately
              const p2 = grid.querySelector('[data-pi="1"]');
              if (p2) p2.click();
              pageMgr.selected = (App2._pageSel && App2._pageSel.size) === 1;
              const delBtn = document.getElementById("btn-pages-del");
              delBtn.click();
              pageMgr.delArmed = (App2._pagePlan || []).length === 3 &&
                delBtn.textContent === "Really delete 1 annotated page?" &&
                delBtn.classList.contains("armed") && !delBtn.classList.contains("danger");
              // a state change (End moves the selection; the re-render
              // invalidates the armed step) must revert the button — the
              // confirm referred to the OLD selection
              window.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true }));
              pageMgr.delDisarmedBySel = (App2._pageSel && App2._pageSel.size === 1 && App2._pageSel.has(2)) &&
                (App2._pagePlan || []).length === 3 &&
                delBtn.textContent === "🗑 Delete" && !delBtn.classList.contains("armed") &&
                delBtn.classList.contains("danger");
              // restore the {1} selection and complete the two-step delete
              const p3dis = grid.querySelector('[data-pi="2"]');
              if (p3dis) p3dis.click(); // {2} → {1,2}
              const p2dis = grid.querySelector('[data-pi="1"]');
              if (p2dis) p2dis.click(); // {1,2} → {1}
              delBtn.click(); // arms again after the disarm
              pageMgr.delReArmed = delBtn.classList.contains("armed");
              delBtn.click(); // decides — stages
              pageMgr.afterDelete = (App2._pagePlan || []).length === 2 &&
                grid.querySelectorAll(".pages-plan-item").length === 2;
              // undo the delete: doc2 comes back (plan + selection restored)
              // and the button disables once the stack empties
              document.getElementById("btn-pages-undo").click();
              const planUndo = App2._pagePlan || [];
              pageMgr.undoRestores = planUndo.length === 3 && planUndo[0].kind === "doc" && planUndo[0].oldPage === 1 &&
                planUndo[1].kind === "doc" && planUndo[1].oldPage === 2 && planUndo[2].kind === "doc" && planUndo[2].oldPage === 3;
              pageMgr.undoSel = !!(App2._pageSel && App2._pageSel.size === 1 && App2._pageSel.has(1));
              pageMgr.undoBtnDisabled = document.getElementById("btn-pages-undo").disabled === true;
              // the gate distinguishes annotated from not: page 3 has no
              // seeded annotations, so a one-click delete stages immediately
              // with no confirm ceremony
              const p1off = grid.querySelector('[data-pi="1"]');
              if (p1off) p1off.click(); // {1} → {} (toggle the restored selection off)
              const p3on = grid.querySelector('[data-pi="2"]');
              if (p3on) p3on.click(); // {} → {2}
              pageMgr.noAnnSel = !!(App2._pageSel && App2._pageSel.size === 1 && App2._pageSel.has(2));
              delBtn.click();
              pageMgr.noAnnImmediate = (App2._pagePlan || []).length === 2 &&
                delBtn.textContent === "🗑 Delete" && !delBtn.classList.contains("armed");
              document.getElementById("btn-pages-undo").click(); // restore [1,2,3]
              // re-do the delete (the undo brought back selection {2}, so
              // restore {1} first) so the rest of the flow sees the same
              // post-delete state as before — two clicks again: arm, confirm
              const p2redo1 = grid.querySelector('[data-pi="1"]');
              if (p2redo1) p2redo1.click(); // {2} → {1,2}
              const p2redo2 = grid.querySelector('[data-pi="2"]');
              if (p2redo2) p2redo2.click(); // {1,2} → {1}
              delBtn.click(); // arm
              delBtn.click(); // confirm
              pageMgr.redidDelete = (App2._pagePlan || []).length === 2 &&
                grid.querySelectorAll(".pages-plan-item").length === 2;
              // append a blank page
              document.getElementById("btn-pages-blank").click();
              pageMgr.blankAdded = (App2._pagePlan || []).length === 3 && App2._pagePlan[2].kind === "blank";
              // the blank page is sized like the last doc page → same size badge
              const pb0 = document.getElementById("pages-plan-grid").querySelector('[data-pi="2"]');
              const pb0sz = pb0 && pb0.querySelector(".pages-size");
              pageMgr.blankSize = !!(pb0sz && pb0sz.textContent === docSizeLabel);
              // select the blank (index 2) and move it up → [doc1, blank, doc3]
              const pb = document.getElementById("pages-plan-grid").querySelector('[data-pi="2"]');
              if (pb) pb.click();
              document.getElementById("btn-pages-up").click();
              const planAfter = App2._pagePlan || [];
              pageMgr.reordered = planAfter.length === 3 && planAfter[0].kind === "doc" && planAfter[0].oldPage === 1 &&
                planAfter[1].kind === "blank" && planAfter[2].kind === "doc" && planAfter[2].oldPage === 3;
              // first/last shortcuts + move-to-position form. Plan is
              // [doc1, blank, doc3] with the blank selected; every edit below
              // is undone so the drag test still starts from that exact state.
              document.getElementById("btn-pages-first").click();
              const planF = App2._pagePlan || [];
              pageMgr.moveFirst = planF.length === 3 && planF[0].kind === "blank" &&
                planF[1].kind === "doc" && planF[1].oldPage === 1 && planF[2].kind === "doc" && planF[2].oldPage === 3;
              pageMgr.moveFirstSel = !!(App2._pageSel && App2._pageSel.size === 1 && App2._pageSel.has(0));
              document.getElementById("btn-pages-undo").click();
              document.getElementById("btn-pages-last").click();
              const planL = App2._pagePlan || [];
              pageMgr.moveLast = planL.length === 3 && planL[0].kind === "doc" && planL[0].oldPage === 1 &&
                planL[1].kind === "doc" && planL[1].oldPage === 3 && planL[2].kind === "blank";
              pageMgr.moveLastSel = !!(App2._pageSel && App2._pageSel.size === 1 && App2._pageSel.has(2));
              document.getElementById("btn-pages-undo").click();
              // Home/End move the SELECTION to the extent (unlike the First/Last
              // buttons above, which reorder — the plan must stay untouched).
              // From the blank (idx 1): Home selects the first page, End the
              // last, mirroring the viewer's own Home/End navigation. With the
              // move-to input focused, Home keeps its native caret-to-start
              // meaning instead (keydown dispatched on the input, the same path
              // a real keypress takes, so the field guard is exercised).
              const fireKey = (key) => window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
              fireKey("Home");
              pageMgr.homeSel = !!(App2._pageSel && App2._pageSel.size === 1 && App2._pageSel.has(0));
              pageMgr.homePlan = (App2._pagePlan || []).length === 3 &&
                App2._pagePlan[0].kind === "doc" && App2._pagePlan[0].oldPage === 1; // plan untouched
              fireKey("End");
              pageMgr.endSel = !!(App2._pageSel && App2._pageSel.size === 1 && App2._pageSel.has(2));
              pageMgr.endPlan = (App2._pagePlan || []).length === 3 &&
                App2._pagePlan[2].kind === "doc" && App2._pagePlan[2].oldPage === 3;
              const posInput = document.getElementById("pages-move-pos");
              posInput.focus();
              posInput.value = "2";
              posInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true }));
              pageMgr.homeInFieldKept = (App2._pageSel && App2._pageSel.size === 1 && App2._pageSel.has(2)) &&
                posInput.value === "2"; // selection unchanged, caret action untouched
              posInput.blur();
              // Shift+click RANGE selection: End above left the anchor at
              // idx 2, so Shift+clicking page 1 (idx 0) selects the whole
              // contiguous block 1-3 without touching each thumb. Selection-
              // only: the plan itself must stay untouched.
              const fireShiftClick = (el0) => el0.dispatchEvent(new MouseEvent("click", {
                bubbles: true, cancelable: true, shiftKey: true,
              }));
              const rgrid = document.getElementById("pages-plan-grid");
              fireShiftClick(rgrid.querySelector('[data-pi="0"]'));
              const selR1 = App2._pageSel;
              pageMgr.rangeBack = !!(selR1 && selR1.size === 3 && selR1.has(0) && selR1.has(1) && selR1.has(2));
              pageMgr.rangeBackPlan = (App2._pagePlan || []).length === 3 &&
                App2._pagePlan[0].kind === "doc" && App2._pagePlan[0].oldPage === 1 &&
                App2._pagePlan[1].kind === "blank" && App2._pagePlan[2].kind === "doc" && App2._pagePlan[2].oldPage === 3;
              pageMgr.rangeBackClasses = ["0", "1", "2"].every((p) =>
                rgrid.querySelector('[data-pi="' + p + '"]').classList.contains("sel"));
              // a plain click still TOGGLES (the manager's long-standing
              // convention): {0,1,2} → {0,2}, and it re-anchors at the clicked
              // index (1) for the next Shift+click
              rgrid.querySelector('[data-pi="1"]').click();
              pageMgr.rangeReanchor = !!(App2._pageSel && App2._pageSel.size === 2 &&
                App2._pageSel.has(0) && App2._pageSel.has(2) && App2._pageSelAnchor === 1);
              // forward range from the new anchor: Shift+click idx 2 → {1,2}
              fireShiftClick(rgrid.querySelector('[data-pi="2"]'));
              pageMgr.rangeForward = !!(App2._pageSel && App2._pageSel.size === 2 && App2._pageSel.has(1) && App2._pageSel.has(2));
              // extending backwards from the range's new far end covers all 3
              fireShiftClick(rgrid.querySelector('[data-pi="0"]'));
              pageMgr.rangeExtendBack = !!(App2._pageSel && App2._pageSel.size === 3 &&
                App2._pageSel.has(0) && App2._pageSel.has(1) && App2._pageSel.has(2));
              // the selection line reports the block
              pageMgr.rangeInfo = document.getElementById("pages-sel-info").textContent.includes("3 of 3 pages selected");
              // a range selected via Shift+click drags as ONE block: dragstart
              // on any member carries the whole set into _pageDrag (with the
              // dragging classes), and dragend cleans it all up
              const fireDragR = (el0, ev) => el0.dispatchEvent(new DragEvent(ev, {
                bubbles: true, cancelable: true, clientX: 0, clientY: 0, dataTransfer: new DataTransfer(),
              }));
              fireDragR(rgrid.querySelector('[data-pi="0"]'), "dragstart");
              pageMgr.rangeDragSet = !!(App2._pageDrag && App2._pageDrag.size === 3 &&
                App2._pageDrag.has(0) && App2._pageDrag.has(1) && App2._pageDrag.has(2));
              pageMgr.rangeDragClasses = ["0", "1", "2"].every((p) =>
                rgrid.querySelector('[data-pi="' + p + '"]').classList.contains("dragging"));
              rgrid.dispatchEvent(new DragEvent("dragend", { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }));
              pageMgr.rangeDragCleaned = !App2._pageDrag;
              // restore the ENTRY selection ({2}, End's) so the block below
              // still starts from the exact state its comments describe:
              // {0,1,2} → {1,2} → {2} (re-query; every toggle re-renders)
              rgrid.querySelector('[data-pi="0"]').click();
              rgrid.querySelector('[data-pi="1"]').click();
              pageMgr.rangeRestored = !!(App2._pageSel && App2._pageSel.size === 1 && App2._pageSel.has(2));
              // ── Shift+arrow / Shift+Home / Shift+End range selection ──
              // the keyboard twin of Shift+click, with Explorer's anchor/focus
              // model: a sequence fixes the BASE edge and a tracked FOCUS edge
              // moves one step per press — so reversing direction SHRINKS the
              // range toward the base and then grows past it, Home/End jump the
              // focus straight to the boundary, and the selection line + .sel
              // classes follow each press. The sequence self-heals: any
              // selection that isn't exactly [base, focus] (a plain click…)
              // re-anchors from the current edges. Dispatched on window (the
              // real keydown path) so e.target is never a field.
              const kbd = (key, shift) => window.dispatchEvent(new KeyboardEvent("keydown",
                { key, bubbles: true, cancelable: true, shiftKey: shift }));
              rgrid.querySelector('[data-pi="1"]').click(); // {2} → {1,2}
              rgrid.querySelector('[data-pi="2"]').click(); // {1,2} → {1}
              pageMgr.kbRangeAnchor = !!(App2._pageSel && App2._pageSel.size === 1 && App2._pageSel.has(1));
              kbd("ArrowDown", true); // {1} → {1,2} (base 1, focus 2)
              pageMgr.kbRangeDown = !!(App2._pageSel && App2._pageSel.size === 2 &&
                App2._pageSel.has(1) && App2._pageSel.has(2));
              pageMgr.kbRangeDownAnchor = App2._pageSelAnchor === 2;
              pageMgr.kbRangeInfo = document.getElementById("pages-sel-info").textContent.includes("2 of 3 pages selected");
              pageMgr.kbRangeClasses = ["1", "2"].every((p) =>
                rgrid.querySelector('[data-pi="' + p + '"]').classList.contains("sel")) &&
                !rgrid.querySelector('[data-pi="0"]').classList.contains("sel");
              kbd("ArrowDown", true); // focus already at the last page → no-op
              pageMgr.kbRangeDownClamp = !!(App2._pageSel && App2._pageSel.size === 2 &&
                App2._pageSel.has(1) && App2._pageSel.has(2));
              // reversing direction now SHRINKS: focus 2 → 1 → back to {1}
              kbd("ArrowUp", true);
              pageMgr.kbRangeShrink = !!(App2._pageSel && App2._pageSel.size === 1 &&
                App2._pageSel.has(1));
              pageMgr.kbRangeShrinkClasses = !rgrid.querySelector('[data-pi="2"]').classList.contains("sel") &&
                rgrid.querySelector('[data-pi="1"]').classList.contains("sel");
              // …and keeps going PAST the base to grow the other side: {0,1}
              kbd("ArrowUp", true);
              pageMgr.kbRangeGrowPast = !!(App2._pageSel && App2._pageSel.size === 2 &&
                App2._pageSel.has(0) && App2._pageSel.has(1));
              // reversing again retracts back onto the base: {0,1} → {1}
              kbd("ArrowDown", true);
              pageMgr.kbRangeFlip = !!(App2._pageSel && App2._pageSel.size === 1 &&
                App2._pageSel.has(1));
              // Shift+End/Home jump the focus to the boundary: from {1}
              // (base 1, focus 1) Shift+End → {1,2}, then Shift+Home → {0,1}
              kbd("End", true);
              pageMgr.kbRangeEnd = !!(App2._pageSel && App2._pageSel.size === 2 &&
                App2._pageSel.has(1) && App2._pageSel.has(2));
              kbd("Home", true);
              pageMgr.kbRangeHome = !!(App2._pageSel && App2._pageSel.size === 2 &&
                App2._pageSel.has(0) && App2._pageSel.has(1) && App2._pageSelAnchor === 0);
              // a plain click invalidates the sequence: {0,1} → click 0 → {1}
              rgrid.querySelector('[data-pi="0"]').click();
              pageMgr.kbRangeMid = !!(App2._pageSel && App2._pageSel.size === 1 && App2._pageSel.has(1));
              kbd("End", true); // fresh sequence: base 1, focus 1 → focus 2 → {1,2}
              pageMgr.kbRangeMidEnd = !!(App2._pageSel && App2._pageSel.size === 2 &&
                App2._pageSel.has(1) && App2._pageSel.has(2));
              kbd("Home", true); // valid sequence: focus → 0 → {0,1}
              pageMgr.kbRangeMidHome = !!(App2._pageSel && App2._pageSel.size === 2 &&
                App2._pageSel.has(0) && App2._pageSel.has(1));
              // with NO selection Shift+↓ anchors the FIRST page and Shift+↑
              // the LAST (both grow from there on repeat)
              App2._pageSel = new Set();
              App2._pageSelAnchor = null;
              App2._pageSelBase = null;
              App2._pageSelFocus = null;
              App2._renderPagePlan();
              kbd("ArrowDown", true);
              pageMgr.kbRangeFreshDown = !!(App2._pageSel && App2._pageSel.size === 1 && App2._pageSel.has(0));
              App2._pageSel = new Set();
              App2._pageSelAnchor = null;
              App2._pageSelBase = null;
              App2._pageSelFocus = null;
              App2._renderPagePlan();
              kbd("ArrowUp", true);
              pageMgr.kbRangeFreshUp = !!(App2._pageSel && App2._pageSel.size === 1 && App2._pageSel.has(2));
              // inside a text field Shift+arrows keep their native caret
              // meaning — the selection must be left untouched
              posInput.focus();
              posInput.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true, shiftKey: true }));
              pageMgr.kbRangeInField = !!(App2._pageSel && App2._pageSel.size === 1 && App2._pageSel.has(2));
              posInput.blur();
              // state is exactly the {2} selection the block below expects
              pageMgr.kbRangeRestored = !!(App2._pageSel && App2._pageSel.size === 1 && App2._pageSel.has(2));
              // restore the single blank selection (idx 1) the move-form tests
              // expect: selection is {2} now, so two toggles through the real
              // click path ({2} → {1,2} → {1}); re-query after each click
              // because every toggle re-renders the grid
              const pbHomeEnd = grid.querySelector('[data-pi="1"]');
              if (pbHomeEnd) pbHomeEnd.click();
              const pbHomeEnd2 = grid.querySelector('[data-pi="2"]');
              if (pbHomeEnd2) pbHomeEnd2.click();
              // ── Ctrl+A (select all) + 'Select annotated' ──────────────
              // selection is {1} (the blank); Ctrl+A selects every staged page
              // without touching the plan, moves the Shift+click anchor to the
              // first page, and re-renders the .sel classes
              window.dispatchEvent(new KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true, cancelable: true }));
              pageMgr.ctrlAll = !!(App2._pageSel && App2._pageSel.size === 3 &&
                App2._pageSel.has(0) && App2._pageSel.has(1) && App2._pageSel.has(2));
              pageMgr.ctrlAllAnchor = App2._pageSelAnchor === 0;
              pageMgr.ctrlAllPlan = (App2._pagePlan || []).length === 3 &&
                App2._pagePlan[0].kind === "doc" && App2._pagePlan[0].oldPage === 1 &&
                App2._pagePlan[1].kind === "blank" && App2._pagePlan[2].kind === "doc" && App2._pagePlan[2].oldPage === 3;
              pageMgr.ctrlAllClasses = ["0", "1", "2"].every((p) =>
                grid.querySelector('[data-pi="' + p + '"]').classList.contains("sel"));
              pageMgr.ctrlAllInfo = document.getElementById("pages-sel-info").textContent.includes("3 of 3 pages selected");
              // inside a text field Ctrl+A keeps its native select-all-text
              // meaning: collapse to {0,1} first so a leaked select-all would
              // be visible, focus the move-to input, dispatch on the INPUT
              // (the same bubbling path a real keypress takes), then blur
              grid.querySelector('[data-pi="2"]').click(); // {0,1,2} → {0,1}
              posInput.focus();
              posInput.dispatchEvent(new KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true, cancelable: true }));
              pageMgr.ctrlInFieldKept = !!(App2._pageSel && App2._pageSel.size === 2 &&
                App2._pageSel.has(0) && App2._pageSel.has(1)); // selection untouched
              posInput.blur();
              window.dispatchEvent(new KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true, cancelable: true }));
              pageMgr.ctrlAll2 = !!(App2._pageSel && App2._pageSel.size === 3);
              // 'Select annotated' picks the doc pages that actually carry
              // annotations — the exact set the Delete confirm warns about.
              // Page 1 has the seeded note; page 3 has none, so seed one to
              // prove the button sees BOTH doc pages, then remove it and
              // re-click to prove the set tracks the annotation list.
              Volt.Ann._mutate(() => {
                if (!Volt.Ann.list.some((a) => a.id === "probe-sel-ann-3")) {
                  Volt.Ann.list.push({ id: "probe-sel-ann-3", type: "note", page: 3,
                    point: { x: 40, y: 40 }, text: "sel ann", color: "#60a5fa", createdAt: Date.now() });
                }
              });
              document.getElementById("btn-pages-select-ann").click();
              pageMgr.selAnnBoth = !!(App2._pageSel && App2._pageSel.size === 2 &&
                App2._pageSel.has(0) && App2._pageSel.has(2)); // doc1 + doc3, blank excluded
              pageMgr.selAnnInfo = document.getElementById("pages-sel-info").textContent.includes("2 of 3 pages selected");
              pageMgr.selAnnToast = [...document.querySelectorAll(".toast")].some((t) =>
                t.textContent.includes("Selected 2 annotated pages"));
              Volt.Ann._mutate(() => {
                Volt.Ann.list = Volt.Ann.list.filter((a) => a.id !== "probe-sel-ann-3");
              });
              document.getElementById("btn-pages-select-ann").click();
              pageMgr.selAnnReacts = !!(App2._pageSel && App2._pageSel.size === 1 && App2._pageSel.has(0));
              // restore the {1} (blank) selection the move-form tests expect
              grid.querySelector('[data-pi="0"]').click(); // {0} → {}
              grid.querySelector('[data-pi="1"]').click(); // {} → {1}
              pageMgr.selAnnRestored = !!(App2._pageSel && App2._pageSel.size === 1 && App2._pageSel.has(1));
              // ── Invert selection ───────────────────────────────────────
              // selection is {1} (the blank); Invert selects the complement
              // {0,2} — the "pick the pages to KEEP, delete the rest" flow —
              // and the anchor moves to the lowest newly-selected page so a
              // following Shift+click extends from there
              document.getElementById("btn-pages-invert").click();
              pageMgr.invCompl = !!(App2._pageSel && App2._pageSel.size === 2 &&
                App2._pageSel.has(0) && App2._pageSel.has(2));
              pageMgr.invAnchor = App2._pageSelAnchor === 0;
              pageMgr.invInfo = document.getElementById("pages-sel-info").textContent.includes("2 of 3 pages selected");
              pageMgr.invToast = [...document.querySelectorAll(".toast")].some((t) =>
                t.textContent.includes("Inverted selection — 2 of 3 pages selected"));
              pageMgr.invClasses = ["0", "2"].every((p) =>
                grid.querySelector('[data-pi="' + p + '"]').classList.contains("sel")) &&
                !grid.querySelector('[data-pi="1"]').classList.contains("sel");
              // invert again → back to exactly {1} (idempotent round-trip)
              document.getElementById("btn-pages-invert").click();
              pageMgr.invBack = !!(App2._pageSel && App2._pageSel.size === 1 && App2._pageSel.has(1));
              // Ctrl+I via the real keydown path inverts the same way
              window.dispatchEvent(new KeyboardEvent("keydown", { key: "i", ctrlKey: true, bubbles: true, cancelable: true }));
              pageMgr.invKb = !!(App2._pageSel && App2._pageSel.size === 2 &&
                App2._pageSel.has(0) && App2._pageSel.has(2));
              // inside a text field Ctrl+I is ignored (same guard as Ctrl+A)
              posInput.focus();
              posInput.dispatchEvent(new KeyboardEvent("keydown", { key: "i", ctrlKey: true, bubbles: true, cancelable: true }));
              pageMgr.invInFieldKept = !!(App2._pageSel && App2._pageSel.size === 2 &&
                App2._pageSel.has(0) && App2._pageSel.has(2));
              posInput.blur();
              // restore the {1} (blank) selection the move-form tests expect
              grid.querySelector('[data-pi="0"]').click(); // {0,2} → {2}
              grid.querySelector('[data-pi="2"]').click(); // {2} → {}
              grid.querySelector('[data-pi="1"]').click(); // {} → {1}
              pageMgr.invRestored = !!(App2._pageSel && App2._pageSel.size === 1 && App2._pageSel.has(1));
              // move-to form: open, check the hint, move the blank to position 3
              document.getElementById("btn-pages-move").click();
              const mf = document.getElementById("pages-move-form");
              pageMgr.moveFormShown = mf.hidden === false;
              pageMgr.moveHint = /before 4/.test(document.getElementById("pages-move-hint").textContent);
              document.getElementById("pages-move-pos").value = "3";
              document.getElementById("pages-move-go").click();
              const planM = App2._pagePlan || [];
              pageMgr.moveToPos = planM.length === 3 && planM[0].kind === "doc" && planM[0].oldPage === 1 &&
                planM[1].kind === "doc" && planM[1].oldPage === 3 && planM[2].kind === "blank";
              pageMgr.moveFormHidden = mf.hidden === true;
              document.getElementById("btn-pages-undo").click();
              // invalid position (7 > 3 pages) → rejected, plan untouched, form open
              document.getElementById("btn-pages-move").click();
              document.getElementById("pages-move-pos").value = "7";
              document.getElementById("pages-move-go").click();
              const planBad = App2._pagePlan || [];
              pageMgr.moveInvalid = planBad.length === 3 && planBad[0].kind === "doc" && planBad[0].oldPage === 1 &&
                planBad[1].kind === "blank" && planBad[2].kind === "doc" && planBad[2].oldPage === 3;
              pageMgr.moveFormKept = mf.hidden === false;
              document.getElementById("pages-move-cancel").click();
              // relative + list moves (the form now speaks the drag indicator's
              // language). Plan is [doc1, blank, doc3], blank selected.
              // "before 3" starts the block at position 3 — same as move-to-3,
              // but reading like the drag bar; selection follows the block.
              document.getElementById("btn-pages-move").click();
              document.getElementById("pages-move-pos").value = "before 3";
              document.getElementById("pages-move-go").click();
              const planB = App2._pagePlan || [];
              pageMgr.moveBefore = planB.length === 3 && planB[0].kind === "doc" && planB[0].oldPage === 1 &&
                planB[1].kind === "doc" && planB[1].oldPage === 3 && planB[2].kind === "blank";
              pageMgr.moveBeforeSel = !!(App2._pageSel && App2._pageSel.size === 1 && App2._pageSel.has(2));
              document.getElementById("btn-pages-undo").click();
              // "after 1" = the block starts right after page 1 (position 2),
              // where the blank already sits → a no-op that must close the
              // form without churning the undo stack
              document.getElementById("btn-pages-move").click();
              document.getElementById("pages-move-pos").value = "after 1";
              document.getElementById("pages-move-go").click();
              const planA = App2._pagePlan || [];
              pageMgr.moveAfterNoop = planA.length === 3 && planA[0].kind === "doc" && planA[0].oldPage === 1 &&
                planA[1].kind === "blank" && planA[2].kind === "doc" && planA[2].oldPage === 3;
              pageMgr.moveAfterFormClosed = mf.hidden === true;
              // (no undo here: the "after 1" no-op pushed NO snapshot, so an
              // undo would rewind an earlier real edit — the plan is already
              // back to [doc1, blank, doc3] with the blank selected)
              // comma-separated: select TWO pages (doc1 + blank — state set
              // directly so the list test is deterministic regardless of the
              // inherited selection) and place them at positions 1 and 3
              // → [doc1, doc3, blank]
              App2._pageSel = new Set([0, 1]);
              App2._renderPagePlan();
              pageMgr.moveListTwo = !!(App2._pageSel && App2._pageSel.size === 2);
              document.getElementById("btn-pages-move").click();
              document.getElementById("pages-move-pos").value = "1,3";
              document.getElementById("pages-move-go").click();
              const planL2 = App2._pagePlan || [];
              pageMgr.moveList = planL2.length === 3 && planL2[0].kind === "doc" && planL2[0].oldPage === 1 &&
                planL2[1].kind === "doc" && planL2[1].oldPage === 3 && planL2[2].kind === "blank";
              pageMgr.moveListSel = !!(App2._pageSel && App2._pageSel.size === 2 &&
                App2._pageSel.has(0) && App2._pageSel.has(2));
              // count mismatch (3 positions for 2 pages) → rejected, plan
              // untouched, form stays open for correction
              document.getElementById("btn-pages-move").click();
              document.getElementById("pages-move-pos").value = "1,2,3";
              document.getElementById("pages-move-go").click();
              pageMgr.moveListMismatch = mf.hidden === false && (App2._pagePlan || []).length === 3 &&
                App2._pagePlan[1].kind === "doc" && App2._pagePlan[1].oldPage === 3;
              document.getElementById("pages-move-cancel").click();
              document.getElementById("btn-pages-undo").click(); // back to [doc1, blank, doc3]
              // per-row reorder indices: every thumbnail carries an editable
              // position input renumbered with the plan. Enter in row 1 moves
              // THAT page (doc1) to position 3 → [blank, doc3, doc1], and the
              // inputs renumber to 1,2,3 again; undo restores.
              pageMgr.posInputs = [...grid.querySelectorAll(".pages-pos")].map((i) => i.value).join(",") === "1,2,3";
              const pos0 = grid.querySelector('[data-pi="0"] .pages-pos');
              if (pos0) {
                pos0.value = "3";
                pos0.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
              }
              const planP = App2._pagePlan || [];
              pageMgr.posMove = planP.length === 3 && planP[0].kind === "blank" &&
                planP[1].kind === "doc" && planP[1].oldPage === 3 && planP[2].kind === "doc" && planP[2].oldPage === 1;
              pageMgr.posRenumbered = [...grid.querySelectorAll(".pages-pos")].map((i) => i.value).join(",") === "1,2,3";
              document.getElementById("btn-pages-undo").click();
              // Escape in an edited index reverts the edit WITHOUT moving or
              // closing the modal
              const pos1 = grid.querySelector('[data-pi="1"] .pages-pos');
              if (pos1) {
                pos1.value = "99";
                pos1.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
              }
              pageMgr.posEscReverts = (grid.querySelector('[data-pi="1"] .pages-pos') || {}).value === "2";
              pageMgr.posEscKeepsModal = pm.hidden === false;
              // drag-reorder via real DragEvents (DataTransfer works in Chromium):
              // plan is [doc1, blank, doc3]; grab doc3 (idx 2) and drop it
              // BEFORE doc1 (idx 0) → [doc3, doc1, blank], selection follows
              const fireDrag = (el0, ev, x, y) => el0.dispatchEvent(new DragEvent(ev, {
                bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: new DataTransfer(),
              }));
              const src2 = grid.querySelector('[data-pi="2"]');
              fireDrag(src2, "dragstart", 0, 0);
              pageMgr.dragClass = !!src2 && src2.classList.contains("dragging");
              const t0 = grid.querySelector('[data-pi="0"]');
              const r0 = t0.getBoundingClientRect();
              fireDrag(t0, "dragover", r0.left + 2, r0.top + 40);
              pageMgr.dragIndicator = t0.classList.contains("drag-before");
              // live numbering while hovering: dragging doc3 before doc1 shows
              // the would-be order [doc3, doc1, blank] → indices 1,2,3
              pageMgr.dragLiveNumbers = [...grid.querySelectorAll(".pages-pos")].map((i) => i.value).join(",") === "2,3,1";
              fireDrag(t0, "drop", r0.left + 2, r0.top + 40);
              grid.dispatchEvent(new DragEvent("dragend", { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }));
              const planD1 = App2._pagePlan || [];
              pageMgr.dragOrder = planD1.length === 3 && planD1[0].kind === "doc" && planD1[0].oldPage === 3 &&
                planD1[1].kind === "doc" && planD1[1].oldPage === 1 && planD1[2].kind === "blank";
              pageMgr.dragSel = !!(App2._pageSel && App2._pageSel.size === 1 && App2._pageSel.has(0));
              // after the drop the re-render renumbers the real order
              pageMgr.dragNumbersRestored = [...grid.querySelectorAll(".pages-pos")].map((i) => i.value).join(",") === "1,2,3";
              // drag it back: grab doc3 (idx 0) and drop AFTER blank (idx 2)
              // → [doc1, blank, doc3] restored, so build/apply assertions below
              // still exercise the exact plan the earlier checks verified
              fireDrag(grid.querySelector('[data-pi="0"]'), "dragstart", 0, 0);
              const t2b = grid.querySelector('[data-pi="2"]');
              const r2b = t2b.getBoundingClientRect();
              fireDrag(t2b, "dragover", r2b.right - 2, r2b.top + 40);
              pageMgr.dragIndicatorAfter = t2b.classList.contains("drag-after");
              fireDrag(t2b, "drop", r2b.right - 2, r2b.top + 40);
              grid.dispatchEvent(new DragEvent("dragend", { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }));
              const planD2 = App2._pagePlan || [];
              pageMgr.dragRestored = planD2.length === 3 && planD2[0].kind === "doc" && planD2[0].oldPage === 1 &&
                planD2[1].kind === "blank" && planD2[2].kind === "doc" && planD2[2].oldPage === 3;
              pageMgr.dragSelRestored = !!(App2._pageSel && App2._pageSel.size === 1 && App2._pageSel.has(2));
              // multi-level undo: step back through BOTH drags — first to the
              // pre-restore plan [doc3, doc1, blank], then to the pre-drag
              // plan [doc1, blank, doc3]; the stack is still live
              document.getElementById("btn-pages-undo").click();
              const planU1 = App2._pagePlan || [];
              pageMgr.undoDrag = planU1.length === 3 && planU1[0].kind === "doc" && planU1[0].oldPage === 3 &&
                planU1[1].kind === "doc" && planU1[1].oldPage === 1 && planU1[2].kind === "blank";
              document.getElementById("btn-pages-undo").click();
              const planU2 = App2._pagePlan || [];
              pageMgr.undoDragRestores = planU2.length === 3 && planU2[0].kind === "doc" && planU2[0].oldPage === 1 &&
                planU2[1].kind === "blank" && planU2[2].kind === "doc" && planU2[2].oldPage === 3;
              pageMgr.undoStackLive = document.getElementById("btn-pages-undo").disabled === false;
              // ── redo stack ───────────────────────────────────────
              // the two drag undos above left the redo stack populated: redo
              // reapplies the last undone edit (button), and a NEW edit after
              // an undo clears the redo stack — both before Apply. Plan is
              // [doc1, blank, doc3]; redo stack = [P0, drag1-undo].
              const redoBtn = document.getElementById("btn-pages-redo");
              pageMgr.redoEnabled = redoBtn.disabled === false;
              document.getElementById("btn-pages-redo").click(); // redo drag2-undo → [doc3, doc1, blank]
              document.getElementById("btn-pages-redo").click(); // redo drag1-undo → [doc1, blank, doc3]
              const planRe = App2._pagePlan || [];
              pageMgr.redoRestores = planRe.length === 3 && planRe[0].kind === "doc" && planRe[0].oldPage === 1 &&
                planRe[1].kind === "blank" && planRe[2].kind === "doc" && planRe[2].oldPage === 3;
              pageMgr.redoDrained = redoBtn.disabled === true;
              // a NEW edit after an undo invalidates the redo stack
              document.getElementById("btn-pages-undo").click(); // → [doc3, doc1, blank]
              pageMgr.redoEnabled2 = redoBtn.disabled === false;
              // …and the hint names BOTH keys once undo and redo are live
              pageMgr.selInfoTextR = document.getElementById("pages-sel-info").textContent;
              pageMgr.selHintRedo = pageMgr.selInfoTextR.includes("Ctrl+Z undo") &&
                pageMgr.selInfoTextR.includes("Ctrl+Shift+Z redo");
              document.getElementById("btn-pages-blank").click(); // new edit → redo cleared
              pageMgr.redoClearedByEdit = redoBtn.disabled === true;
              // walk back to [doc1, blank, doc3] for the build step below:
              // undo the blank, redo it, undo it, then undo the drag-restore
              document.getElementById("btn-pages-undo").click(); // → [doc3, doc1, blank]
              document.getElementById("btn-pages-redo").click(); // → [doc3, doc1, blank, blank]
              document.getElementById("btn-pages-undo").click(); // → [doc3, doc1, blank]
              document.getElementById("btn-pages-undo").click(); // → [doc1, blank, doc3]
              const planRe2 = App2._pagePlan || [];
              pageMgr.redoWalkRestored = planRe2.length === 3 && planRe2[0].kind === "doc" && planRe2[0].oldPage === 1 &&
                planRe2[1].kind === "blank" && planRe2[2].kind === "doc" && planRe2[2].oldPage === 3;
              // keyboard: Ctrl+Shift+Z redoes through the same handler
              document.getElementById("btn-pages-undo").click(); // → [doc3, doc1, blank]
              window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
              const planRe3 = App2._pagePlan || [];
              pageMgr.redoKey = planRe3.length === 3 && planRe3[0].kind === "doc" && planRe3[0].oldPage === 1 &&
                planRe3[1].kind === "blank" && planRe3[2].kind === "doc" && planRe3[2].oldPage === 3;
              // ── row-aware drop indicator (wrap boundary) ──────────────
              // with the grid narrowed so thumbnails wrap into rows, "after"
              // the LAST item of a row is the same linear slot as "before" the
              // first item of the NEXT row — the indicator (and the drop) must
              // snap to the next row's start, or the bar reads off by a row
              grid.style.width = "270px"; // force 2 thumbnails per row
              for (let k = 0; k < 4; k++) document.getElementById("btn-pages-blank").click();
              await new Promise((r) => setTimeout(r, 400));
              const wr1 = grid.querySelector('[data-pi="1"]').getBoundingClientRect();
              const wr2 = grid.querySelector('[data-pi="2"]').getBoundingClientRect();
              pageMgr.wrapRows = wr2.top > wr1.top + wr1.height / 2; // the grid REALLY wraps here
              fireDrag(grid.querySelector('[data-pi="6"]'), "dragstart", 0, 0);
              const wTarget = grid.querySelector('[data-pi="1"]');
              const wRect = wTarget.getBoundingClientRect();
              fireDrag(wTarget, "dragover", wRect.right - 2, wRect.top + 40); // right half of the last row-1 item
              const wSnap = grid.querySelector('[data-pi="2"]');
              pageMgr.wrapIndicator = !!(wSnap && wSnap.classList.contains("drag-before") &&
                !wTarget.classList.contains("drag-after") && !wTarget.classList.contains("drag-before"));
              pageMgr.wrapTarget = !!(App2._pageDropTarget && App2._pageDropTarget.index === 2 &&
                App2._pageDropTarget.pos === "before");
              fireDrag(wTarget, "drop", wRect.right - 2, wRect.top + 40);
              grid.dispatchEvent(new DragEvent("dragend", { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }));
              const planW = App2._pagePlan || [];
              // the dragged page lands at the NEXT ROW's start (plan index 2)
              pageMgr.wrapDrop = planW.length === 7 && planW[0].kind === "doc" && planW[0].oldPage === 1 &&
                planW[1].kind === "blank" && planW[2].kind === "blank" &&
                planW[3].kind === "doc" && planW[3].oldPage === 3;
              // undo back to [doc1, blank, doc3] and restore the grid width
              for (let k = 0; k < 5; k++) document.getElementById("btn-pages-undo").click();
              grid.style.width = "";
              const planW2 = App2._pagePlan || [];
              pageMgr.wrapRestored = planW2.length === 3 && planW2[0].kind === "doc" && planW2[0].oldPage === 1 &&
                planW2[1].kind === "blank" && planW2[2].kind === "doc" && planW2[2].oldPage === 3;
              // ── multi-selection block drag ─────────────────────────
              // select doc1 + blank (indices 0,1), then grab the blank — a
              // page that IS already selected — so dragstart drags the WHOLE
              // selection as a block (app.js: "grabbing a selected page drags
              // the whole selection, matching the Move up/down semantics").
              // Drop after doc3 → [doc3, doc1, blank]: relative order of the
              // block preserved, selection follows the moved pages.
              // (The wrap test leaves its own selection behind, so clear it
              // deterministically first — toggle each leftover off.)
              const preSel = [...(App2._pageSel || [])];
              pageMgr.blockSelBefore = JSON.stringify(preSel);
              for (const idx of preSel) {
                const it = grid.querySelector('[data-pi="' + idx + '"]');
                if (it) it.click();
              }
              const bi0 = grid.querySelector('[data-pi="0"]');
              if (bi0) bi0.click(); // {} → {0}
              const bi1 = grid.querySelector('[data-pi="1"]');
              if (bi1) bi1.click(); // {0} → {0,1}
              pageMgr.blockSel = !!(App2._pageSel && App2._pageSel.size === 2 &&
                App2._pageSel.has(0) && App2._pageSel.has(1));
              fireDrag(grid.querySelector('[data-pi="1"]'), "dragstart", 0, 0); // grab a SELECTED page → block
              const bDrag = App2._pageDrag || new Set();
              const b0drag = grid.querySelector('[data-pi="0"]');
              const b1drag = grid.querySelector('[data-pi="1"]');
              pageMgr.blockDragCarries = bDrag.size === 2 && bDrag.has(0) && bDrag.has(1) &&
                !!b0drag && b0drag.classList.contains("dragging") &&
                !!b1drag && b1drag.classList.contains("dragging");
              const bt = grid.querySelector('[data-pi="2"]');
              const btr = bt.getBoundingClientRect();
              fireDrag(bt, "dragover", btr.right - 2, btr.top + 40); // after doc3
              pageMgr.blockIndicator = !!App2._pageDropTarget && App2._pageDropTarget.index === 2 &&
                App2._pageDropTarget.pos === "after" && bt.classList.contains("drag-after");
              fireDrag(bt, "drop", btr.right - 2, btr.top + 40);
              grid.dispatchEvent(new DragEvent("dragend", { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }));
              const blkPlan = App2._pagePlan || [];
              // the block moved as a unit and kept its internal order: doc1
              // (oldPage 1) still sits BEFORE blank in the result
              pageMgr.blockDropOrder = blkPlan.length === 3 && blkPlan[0].kind === "doc" && blkPlan[0].oldPage === 3 &&
                blkPlan[1].kind === "doc" && blkPlan[1].oldPage === 1 && blkPlan[2].kind === "blank";
              // selection followed the block into its new slots (1,2) — and the
              // grid's selected items really are the moved pages
              pageMgr.blockSelFollows = !!(App2._pageSel && App2._pageSel.size === 2 &&
                App2._pageSel.has(1) && App2._pageSel.has(2) &&
                grid.querySelectorAll(".pages-plan-item.sel").length === 2);
              document.getElementById("btn-pages-undo").click();
              const blkPlan2 = App2._pagePlan || [];
              pageMgr.blockUndoRestores = blkPlan2.length === 3 && blkPlan2[0].kind === "doc" && blkPlan2[0].oldPage === 1 &&
                blkPlan2[1].kind === "blank" && blkPlan2[2].kind === "doc" && blkPlan2[2].oldPage === 3;
              // insert-from-PDF: the source's OWN annotations (stored under the
              // source file's identity key, as if it had been opened and
              // annotated in Volt) surface as badges on the "from …" pages
              const srcPdf = await window.PDFLib.PDFDocument.create();
              srcPdf.addPage([200, 300]);
              srcPdf.addPage([200, 300]);
              const srcBytes = await srcPdf.save();
              const srcKey = "volt:ann:" + Utils.hash("src.pdf:" + srcBytes.byteLength + ":2");
              localStorage.setItem(srcKey, JSON.stringify([{ id: Utils.uid(), type: "note", page: 1, point: { x: 50, y: 50 }, text: "src note", color: "#fde047", createdAt: Date.now() }]));
              await App2._beginInsertPdf(new File([srcBytes], "src.pdf"));
              pageMgr.srcInsertPrepared = App2._insertCount === 2 &&
                document.getElementById("pages-insert-form").hidden === false;
              App2._confirmInsertPdf();
              const planIns = App2._pagePlan || [];
              const srcFrom = grid.querySelectorAll(".pages-src-badge:not(.blank)").length;
              const src1 = grid.querySelector('[data-pi="3"]');
              const src1ann = src1 && src1.querySelector(".pages-ann");
              const srcPg2 = grid.querySelector('[data-pi="4"]');
              pageMgr.srcInsertStaged = planIns.length === 5 && planIns[3].kind === "other" && planIns[4].kind === "other" &&
                srcFrom === 2;
              pageMgr.srcAnnBadge = !!(src1ann && src1ann.textContent === "1" &&
                /in the source file/.test(src1ann.title));
              pageMgr.srcAnnNone = !!srcPg2 && !srcPg2.querySelector(".pages-ann");
              document.getElementById("btn-pages-undo").click();
              pageMgr.srcInsertUndo = (App2._pagePlan || []).length === 3 &&
                grid.querySelectorAll(".pages-src-badge:not(.blank)").length === 0;
              // build-from-plan: [orig1, blank, orig3] → a 3-page PDF
              const built = await Volt.Ann.buildEditedPdf(App2._pagePlan);
              const builtPdf = await window.PDFLib.PDFDocument.load(built);
              pageMgr.buildCount = builtPdf.getPageCount() === 3;
              // Apply (no download): the OPEN doc becomes the rebuild
              await App2._applyPagePlan(true);
              await new Promise((r) => setTimeout(r, 300));
              pageMgr.applyOpened = !!(App2.currentDoc && App2.currentDoc.numPages === 3);
              pageMgr.applyName = !!(App2.currentDocInfo && App2.currentDocInfo.name.includes("-edited.pdf"));
              pageMgr.applyModalClosed = pm.hidden === true;
              pageMgr.annCarried = Ann2.list.some((a) => a.id === seedNote.id && a.page === 1);
              pageMgr.annDropped = !Ann2.list.some((a) => a.id === seedHi.id);
              // ── sidebar drag-reorder (direct, undoable) ─────────────
              // the doc is now the rebuilt [orig1, blank, orig3] and the
              // sidebar shows 3 thumbs. Dropping a thumb at another position
              // rebuilds the DOCUMENT with that order right away (no modal),
              // annotations remap, and an 'Undo reorder' toast restores the
              // pre-reorder bytes + state. Drag thumb 1 (orig1) AFTER thumb 2
              // (blank) → [blank, orig1, orig3]: the note on orig1 follows to
              // page 2, and the undo puts everything back.
              await new Promise((r) => setTimeout(r, 500)); // sidebar re-rendered post-apply
              pageMgr.reorderHint = (sgrid.querySelector(".thumb-item") || {}).title
                ? sgrid.querySelector(".thumb-item").title.includes("drag to reorder") : false;
              const rNote = { id: Utils.uid(), type: "note", page: 1, point: { x: 60, y: 60 }, text: "reorder probe", color: "#fde047", createdAt: Date.now() };
              Ann2._mutate(() => { Ann2.list.push(rNote); }); // page 1 now carries seedNote + rNote
              pageMgr.reorderSeedBadge = !!sgrid.querySelector('.thumb-item[data-page="1"] .pages-ann');
              const rsrc = sgrid.querySelector('.thumb-item[data-page="1"]');
              fireDrag(rsrc, "dragstart", 0, 0);
              pageMgr.reorderDragging = App2._thumbDragPage === 1 && rsrc.classList.contains("dragging");
              const rtarget = sgrid.querySelector('.thumb-item[data-page="2"]');
              const rr = rtarget.getBoundingClientRect();
              fireDrag(rtarget, "dragover", rr.left + 5, rr.bottom - 2); // bottom half → after
              pageMgr.reorderIndicator = rtarget.classList.contains("drag-after") &&
                !rtarget.classList.contains("drag-before") &&
                !!App2._thumbDrop && App2._thumbDrop.page === 2 && App2._thumbDrop.pos === "after";
              // the dragover shows a live WOULD-BE order pill — nothing committed yet
              const pill1 = document.querySelector(".thumb-drag-preview");
              pageMgr.reorderPreviewPill = !!pill1 && pill1.textContent === "2 → 1 → 3";
              const preDropName = App2.currentDocInfo && App2.currentDocInfo.name;
              fireDrag(rtarget, "drop", rr.left + 5, rr.bottom - 2);
              sgrid.dispatchEvent(new DragEvent("dragend", { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }));
              // the drop does NOT rebuild — it arms a confirm toast with the
              // previewed order; the doc is untouched until Apply is clicked
              const confirm1 = [...document.querySelectorAll(".toast")].find((t) => t.textContent.includes("apply?"));
              pageMgr.reorderConfirmShown = !!confirm1 &&
                confirm1.textContent.includes("2 → 1 → 3") && confirm1.textContent.includes("apply?");
              // the doc must be untouched at THIS point (before Apply is clicked)
              pageMgr.reorderNotCommitted = !App2._reorderUndo && App2.currentDocInfo &&
                App2.currentDocInfo.name === preDropName; // exactly the doc the drag started on
              pageMgr.reorderPreviewCleaned = !document.querySelector(".thumb-drag-preview");
              const apply1 = confirm1 ? [...confirm1.querySelectorAll(".toast-action")].find((b) => b.textContent === "Apply") : null;
              pageMgr.reorderApplyBtn = !!apply1 && apply1.classList.contains("armed");
              if (apply1) apply1.click();
              await new Promise((r) => setTimeout(r, 900)); // rebuild + reopen + sidebar re-render
              pageMgr.reorderCommitted = !!(App2.currentDoc && App2.currentDoc.numPages === 3) &&
                sgrid.querySelectorAll(".thumb-item").length === 3 && !!App2._reorderUndo;
              pageMgr.reorderDragCleaned = App2._thumbDragPage === null && App2._thumbDrop === null;
              // new order [blank, orig1, orig3]: page 1 is the blank (no ann),
              // page 2 is orig1 → the notes followed it
              const nr1 = sgrid.querySelector('.thumb-item[data-page="1"]');
              const nr2 = sgrid.querySelector('.thumb-item[data-page="2"]');
              pageMgr.reorderAnnFollowed = !!nr2 && !!nr2.querySelector(".pages-ann") &&
                !!nr1 && !nr1.querySelector(".pages-ann");
              pageMgr.reorderAnnRemapped = Ann2.list.some((a) => a.id === rNote.id && a.page === 2) &&
                Ann2.list.some((a) => a.id === seedNote.id && a.page === 2);
              // undo via the toast action → back to [orig1, blank, orig3],
              // both notes on page 1 under the ORIGINAL identity
              const reorderUndoBtn = [...document.querySelectorAll(".toast-action")].pop();
              pageMgr.reorderUndoOffered = !!reorderUndoBtn && reorderUndoBtn.textContent === "Undo reorder";
              if (reorderUndoBtn) reorderUndoBtn.click();
              await new Promise((r) => setTimeout(r, 900));
              const ur1 = sgrid.querySelector('.thumb-item[data-page="1"]');
              pageMgr.reorderUndone = !!(App2.currentDoc && App2.currentDoc.numPages === 3) &&
                !!ur1 && !!ur1.querySelector(".pages-ann") &&
                Ann2.list.some((a) => a.id === rNote.id && a.page === 1) &&
                Ann2.list.some((a) => a.id === seedNote.id && a.page === 1);
              // ── sidebar Shift+arrow / Shift+Home / Shift+End range selection ──
              // keyboard-only multi-select on the thumbnails, the SAME
              // anchor/focus model as the manager (page numbers, 1-based):
              // Ctrl+click page 2 anchors {2}, Shift+↓ grows to {2,3} and
              // clamps at the boundary, Shift+↑ SHRINKS back to {2}, keeps
              // going past the base to {1,2}, and a Shift+↓ retracts onto the
              // base; Shift+End/Home jump the focus to the boundary; an empty
              // selection anchors at page 1 for ↓ and the last for ↑. The
              // selection renders on the thumbs (.sel) and drives the
              // block-actions row exactly like a click-made one.
              const sKb = (key) => window.dispatchEvent(new KeyboardEvent("keydown",
                { key, bubbles: true, cancelable: true, shiftKey: true }));
              const thumbCtrl = (el0) => el0.dispatchEvent(new MouseEvent("click",
                { bubbles: true, cancelable: true, ctrlKey: true }));
              App2._thumbSel = null;
              App2._thumbSelAnchor = null;
              App2._thumbSelBase = null;
              App2._thumbSelFocus = null;
              App2._applyThumbSel();
              thumbCtrl(sgrid.querySelector('.thumb-item[data-page="2"]')); // {2}
              pageMgr.sideKbCtrlBase = !!(App2._thumbSel && App2._thumbSel.size === 1 && App2._thumbSel.has(2));
              sKb("ArrowDown"); // {2} → {2,3}
              pageMgr.sideKbDown = !!(App2._thumbSel && App2._thumbSel.size === 2 &&
                App2._thumbSel.has(2) && App2._thumbSel.has(3));
              pageMgr.sideKbDownAnchor = App2._thumbSelAnchor === 3;
              pageMgr.sideKbRow = document.getElementById("thumb-block-actions").hidden === false;
              pageMgr.sideKbClasses = sgrid.querySelector('.thumb-item[data-page="2"]').classList.contains("sel") &&
                sgrid.querySelector('.thumb-item[data-page="3"]').classList.contains("sel") &&
                !sgrid.querySelector('.thumb-item[data-page="1"]').classList.contains("sel");
              sKb("ArrowDown"); // focus already at the last page → no-op
              pageMgr.sideKbClamp = !!(App2._thumbSel && App2._thumbSel.size === 2 &&
                App2._thumbSel.has(2) && App2._thumbSel.has(3));
              sKb("ArrowUp"); // SHRINK → {2}
              pageMgr.sideKbShrink = !!(App2._thumbSel && App2._thumbSel.size === 1 && App2._thumbSel.has(2));
              sKb("ArrowUp"); // grow PAST the base → {1,2}
              pageMgr.sideKbGrowPast = !!(App2._thumbSel && App2._thumbSel.size === 2 &&
                App2._thumbSel.has(1) && App2._thumbSel.has(2));
              sKb("ArrowDown"); // retract onto the base → {2}
              pageMgr.sideKbFlip = !!(App2._thumbSel && App2._thumbSel.size === 1 && App2._thumbSel.has(2));
              sKb("End"); // focus → last page → {2,3}
              pageMgr.sideKbEnd = !!(App2._thumbSel && App2._thumbSel.size === 2 &&
                App2._thumbSel.has(2) && App2._thumbSel.has(3));
              sKb("Home"); // focus → first page → {1,2}
              pageMgr.sideKbHome = !!(App2._thumbSel && App2._thumbSel.size === 2 &&
                App2._thumbSel.has(1) && App2._thumbSel.has(2) && App2._thumbSelAnchor === 1);
              // with NO selection Shift+↓ anchors the FIRST page and Shift+↑
              // the LAST (both grow from there on repeat)
              App2._thumbSel = null;
              App2._thumbSelAnchor = null;
              App2._thumbSelBase = null;
              App2._thumbSelFocus = null;
              App2._applyThumbSel();
              sKb("ArrowDown"); // → {1}
              pageMgr.sideKbFreshDown = !!(App2._thumbSel && App2._thumbSel.size === 1 && App2._thumbSel.has(1));
              App2._thumbSel = null;
              App2._thumbSelAnchor = null;
              App2._thumbSelBase = null;
              App2._thumbSelFocus = null;
              App2._applyThumbSel();
              sKb("ArrowUp"); // → {3}
              pageMgr.sideKbFreshUp = !!(App2._thumbSel && App2._thumbSel.size === 1 && App2._thumbSel.has(3));
              // clean up so the block-drag tests below start from their own state
              App2._thumbSel = null;
              App2._thumbSelAnchor = null;
              App2._thumbSelBase = null;
              App2._thumbSelFocus = null;
              App2._applyThumbSel();
              // ── sidebar BLOCK drag-reorder (Shift+click range / Ctrl+click toggle) ──
              // the doc is back to [orig1, blank, orig3]. Shift+click now
              // selects a CONTIGUOUS range anchored like the manager's grid:
              // plain-click page 1 (navigates + anchors), Shift+click page 3
              // → the whole block 1-3 in one gesture, no navigation. Ctrl+click
              // then toggles page 2 OFF — leaving the non-contiguous {1,3}
              // pair the straddling drag below needs (block members on both
              // sides of the target). Dragging BEFORE page 2 yields
              // [orig1, orig3, blank], the selection follows to the block's
              // new positions, annotations remap, and the same undo toast
              // restores everything.
              const b1 = sgrid.querySelector('.thumb-item[data-page="1"]');
              const b2 = sgrid.querySelector('.thumb-item[data-page="2"]');
              const b3 = sgrid.querySelector('.thumb-item[data-page="3"]');
              const bNote = { id: Utils.uid(), type: "note", page: 3, point: { x: 60, y: 60 }, text: "block probe", color: "#60a5fa", createdAt: Date.now() };
              Ann2._mutate(() => { Ann2.list.push(bNote); }); // orig3 now carries its own note
              const plainClick = (el0) => el0.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
              const shiftClick = (el0) => el0.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, shiftKey: true }));
              const ctrlClick = (el0) => el0.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true }));
              plainClick(b1);
              shiftClick(b3);
              pageMgr.thumbRangeSel = !!(App2._thumbSel && App2._thumbSel.size === 3 &&
                App2._thumbSel.has(1) && App2._thumbSel.has(2) && App2._thumbSel.has(3) &&
                App2._thumbSelAnchor === 3) &&
                b1.classList.contains("sel") && b2.classList.contains("sel") && b3.classList.contains("sel") &&
                !b2.classList.contains("active"); // the range must NOT navigate
              ctrlClick(b2); // {1,2,3} → {1,3} — toggle ONE thumb out
              pageMgr.thumbCtrlToggle = !!(App2._thumbSel && App2._thumbSel.size === 2 &&
                App2._thumbSel.has(1) && App2._thumbSel.has(3) && !App2._thumbSel.has(2) &&
                App2._thumbSelAnchor === 2) &&
                !b2.classList.contains("sel");
              const bsrc = b1;
              fireDrag(bsrc, "dragstart", 0, 0);
              pageMgr.blockDragSet = !!(App2._thumbDragSet && App2._thumbDragSet.size === 2 &&
                App2._thumbDragSet.has(1) && App2._thumbDragSet.has(3)) &&
                b1.classList.contains("dragging") && b3.classList.contains("dragging");
              const bbr = b2.getBoundingClientRect();
              fireDrag(b2, "dragover", bbr.left + 5, bbr.top + 2); // top half → before
              pageMgr.blockIndicator = b2.classList.contains("drag-before") &&
                !!App2._thumbDrop && App2._thumbDrop.page === 2 && App2._thumbDrop.pos === "before";
              fireDrag(b2, "drop", bbr.left + 5, bbr.top + 2);
              sgrid.dispatchEvent(new DragEvent("dragend", { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }));
              // the block drop also previews + confirms: the toast must show
              // the straddling result (1 → 3 → 2) and the doc must be
              // untouched until Apply is clicked
              const confirm2 = [...document.querySelectorAll(".toast")].pop();
              pageMgr.blockConfirmShown = !!confirm2 && confirm2.textContent.includes("1 → 3 → 2");
              const apply2 = confirm2 ? [...confirm2.querySelectorAll(".toast-action")].find((b) => b.textContent === "Apply") : null;
              pageMgr.blockApplyBtn = !!apply2;
              if (apply2) apply2.click();
              await new Promise((r) => setTimeout(r, 900)); // rebuild + reopen + sidebar re-render
              pageMgr.blockCommitted = !!(App2.currentDoc && App2.currentDoc.numPages === 3) &&
                !!App2._reorderUndo;
              pageMgr.blockOrder = (() => {
                const names = [];
                for (const it of sgrid.querySelectorAll(".thumb-item")) {
                  const hasAnn = !!it.querySelector(".pages-ann");
                  names.push(parseInt(it.dataset.page, 10) + (hasAnn ? "(ann)" : ""));
                }
                return names.join(",");
              })();
              // expected: page1 (orig1, ann), page2 (orig3, ann), page3 (blank)
              pageMgr.blockOrderOk = pageMgr.blockOrder === "1(ann),2(ann),3";
              pageMgr.blockSelFollowed = !!(App2._thumbSel && App2._thumbSel.size === 2 &&
                App2._thumbSel.has(1) && App2._thumbSel.has(2)) &&
                sgrid.querySelector('.thumb-item[data-page="1"]').classList.contains("sel") &&
                sgrid.querySelector('.thumb-item[data-page="2"]').classList.contains("sel") &&
                !sgrid.querySelector('.thumb-item[data-page="3"]').classList.contains("sel");
              pageMgr.blockAnnFollowed = Ann2.list.some((a) => a.id === rNote.id && a.page === 1) &&
                Ann2.list.some((a) => a.id === seedNote.id && a.page === 1) &&
                Ann2.list.some((a) => a.id === bNote.id && a.page === 2);
              const blockUndoBtn = [...document.querySelectorAll(".toast-action")].pop();
              pageMgr.blockUndoOffered = !!blockUndoBtn && blockUndoBtn.textContent === "Undo reorder";
              if (blockUndoBtn) blockUndoBtn.click();
              await new Promise((r) => setTimeout(r, 900));
              const bu1 = sgrid.querySelector('.thumb-item[data-page="1"]');
              pageMgr.blockUndone = !!(App2.currentDoc && App2.currentDoc.numPages === 3) &&
                !!bu1 && !!bu1.querySelector(".pages-ann") &&
                Ann2.list.some((a) => a.id === rNote.id && a.page === 1) &&
                !App2._thumbSel; // the undo restores the pre-reorder state — selection cleared
              // ── sidebar reorder PERSISTS TO DISK (path-opened PDF) ──
              // the reorders above rebuilt in-memory docs. A PDF opened from a
              // real path must be written BACK to that same file: after Apply,
              // the file's bytes on disk carry the new order, currentPath stays
              // set (the file is still watched), and undo restores the original
              // bytes.
              const disk = {};
              if (DISK_TMP_PATH && window.voltDesktop && typeof window.voltDesktop.writeFile === "function") {
                const diskBytes = (await window.voltDesktop.readFile(DISK_TMP_PATH)).data;
                await Volt.App.openPath(DISK_TMP_PATH);
                const dt0 = Date.now();
                while (Date.now() - dt0 < 8000 &&
                       !(Volt.App.currentDocInfo && Volt.App.currentDocInfo.name === DISK_TMP)) {
                  await new Promise((r) => setTimeout(r, 200));
                }
                disk.openedByPath = !!(Volt.App.currentDocInfo && Volt.App.currentDocInfo.name === DISK_TMP &&
                  Volt.App.currentPath === DISK_TMP_PATH);
                const lgrid = document.getElementById("thumb-grid"); // the LIVE grid — sgrid may be detached by now
                await new Promise((r) => setTimeout(r, 400)); // thumbs rasterize async after the open
                const dg = lgrid.querySelector('.thumb-item[data-page="1"]');
                const dg2 = lgrid.querySelector('.thumb-item[data-page="2"]');
                disk.thumbCount = lgrid.querySelectorAll(".thumb-item").length;
                disk.docName = Volt.App.currentDocInfo && Volt.App.currentDocInfo.name;
                disk.currentPath = Volt.App.currentPath;
                if (!dg2) throw new Error("disk stage: no page-2 thumb (thumbs=" + disk.thumbCount + ", doc=" + disk.docName + ")");
                const dgr = dg2.getBoundingClientRect();
                fireDrag(dg, "dragstart", 0, 0);
                fireDrag(dg2, "dragover", dgr.left + 5, dgr.bottom - 2); // after page 2
                fireDrag(dg2, "drop", dgr.left + 5, dgr.bottom - 2);
                lgrid.dispatchEvent(new DragEvent("dragend", { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }));
                const diskConfirm = [...document.querySelectorAll(".toast")].find((t) => t.textContent.includes("apply?"));
                const diskApply = diskConfirm ? [...diskConfirm.querySelectorAll(".toast-action")].find((b) => b.textContent === "Apply") : null;
                if (diskApply) diskApply.click();
                await new Promise((r) => setTimeout(r, 1000)); // write + reopen + re-render
                disk.reordered = !!(Volt.App.currentDoc && Volt.App.currentDoc.numPages === 3) && !!Volt.App._reorderUndo;
                // the file ON DISK must now be the rebuilt doc (pages 2,1,3 —
                // same page count; verified structurally by re-opening it)
                const diskBack = (await window.voltDesktop.readFile(DISK_TMP_PATH)).data;
                const diskReopen = await window.pdfjsLib.getDocument({ data: diskBack.slice(0) }).promise.catch(() => null);
                disk.fileRewritten = !!diskReopen && diskReopen.numPages === 3;
                disk.fileDiffers = diskBack.byteLength !== diskBytes.byteLength;
                disk.pathKept = Volt.App.currentPath === DISK_TMP_PATH; // still watched
                // undo restores the ORIGINAL bytes on disk
                const diskUndoBtn = [...document.querySelectorAll(".toast-action")].pop();
                disk.undoOffered = !!diskUndoBtn && diskUndoBtn.textContent === "Undo reorder";
                disk.undoPath = Volt.App._reorderUndo ? Volt.App._reorderUndo.path : null;
                if (diskUndoBtn) diskUndoBtn.click();
                await new Promise((r) => setTimeout(r, 1000));
                const diskBack2 = (await window.voltDesktop.readFile(DISK_TMP_PATH)).data;
                disk.fileRestored = diskBack2.byteLength === diskBytes.byteLength;
                disk.allOk = disk.openedByPath === true && disk.reordered === true &&
                  disk.fileRewritten === true && disk.pathKept === true &&
                  disk.undoOffered === true && disk.fileRestored === true;
                // back to the sample for the rest of the probe
                Volt.App.openSample();
                const dt1 = Date.now();
                while (Date.now() - dt1 < 8000 &&
                       (!Volt.App.currentDocInfo || Volt.App.currentDocInfo.name !== "The Quiet Engine — sample.pdf")) {
                  await new Promise((r) => setTimeout(r, 200));
                }
              } else {
                disk.allOk = true; // browser mode / no temp — nothing to assert
              }
              pageMgr.disk = disk;
              // ── keyboard / menu block move (sidebar multi-selection) ──
              // the manager's First / Last / Move-to form, for the SIDEBAR's
              // Shift+click block: the block-action row appears when pages
              // are selected, First / Last / Move to… / Clear all work, and
              // the global Ctrl+Home / Ctrl+End / Ctrl+M shortcuts commit
              // through the same path as the drag (rebuild + 'Undo reorder').
              // The sample here is [orig1, blank, orig3] — pages 1 and 3
              // carry annotations, page 2 (the blank) doesn't, so the ann
              // pattern traces the block's position through every move.
              const kbMove = {};
              try {
                const kg = document.getElementById("thumb-grid");
                const kbT0 = Date.now();
                while (Date.now() - kbT0 < 8000 && !kg.querySelector('.thumb-item[data-page="3"]')) {
                  await new Promise((r) => setTimeout(r, 100));
                }
                // make the annotation state fully deterministic for THIS stage:
                // the shared smoke profile accumulates annotations across runs
                // (the earlier probe stages seed notes AND area highlights on
                // the sample identity), and a rebuild burns ALL of them — one
                // malformed straggler from a prior run would fail the commit.
                // Replace the list with two fresh notes (pages 1 and 3) so the
                // badge pattern traces the block's position and every rebuild
                // below is clean.
                Ann2._mutate(() => {
                  Ann2.list = [
                    { id: Utils.uid(), type: "note", page: 1, point: { x: 40, y: 40 }, text: "kb probe 1", color: "#60a5fa", createdAt: Date.now() },
                    { id: Utils.uid(), type: "note", page: 3, point: { x: 40, y: 40 }, text: "kb probe 3", color: "#60a5fa", createdAt: Date.now() },
                  ];
                });
                // persist NOW — _afterChange's save is debounced 400ms, and by
                // then the first move's rebuild will have switched the doc
                // identity, saving the clean list to the wrong key (the sample
                // key would keep the accumulated junk for the real-key stage)
                Ann2._save();
                await new Promise((r) => setTimeout(r, 200)); // badges render
                const k1 = kg.querySelector('.thumb-item[data-page="1"]');
                const k3 = kg.querySelector('.thumb-item[data-page="3"]');
                // Ctrl+click toggles each thumb in — Shift+click now RANGES
                // (anchored), so the non-contiguous {1,3} pair the block-move
                // tests need (exactly two pages, the blank excluded) comes
                // from two Ctrl+clicks
                const kClick = (el0) => el0.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true }));
                kClick(k1);
                kClick(k3);
                const kbRow = document.getElementById("thumb-block-actions");
                const kbOrder = () => [...kg.querySelectorAll(".thumb-item")]
                  .map((it) => parseInt(it.dataset.page, 10) + (it.querySelector(".pages-ann") ? "(ann)" : "")).join(",");
                kbMove.rowShown = kbRow.hidden === false && !!App2._thumbSel && App2._thumbSel.size === 2 &&
                  k1.classList.contains("sel") && k3.classList.contains("sel");
                // Move to… → inline form, focused input; "2" starts the block at page 2
                document.getElementById("thumb-move-to").click();
                const kbForm = document.getElementById("thumb-move-form");
                kbMove.formShown = kbForm.hidden === false &&
                  document.activeElement === document.getElementById("thumb-move-pos") &&
                  document.getElementById("thumb-move-hint").textContent.includes("before 4");
                document.getElementById("thumb-move-pos").value = "2";
                document.getElementById("thumb-move-go").click();
                await new Promise((r) => setTimeout(r, 900));
                kbMove.movedTo2 = kbOrder() === "1,2(ann),3(ann)"; // blank, orig1, orig3
                kbMove.selTo2 = !!(App2._thumbSel && App2._thumbSel.size === 2 && App2._thumbSel.has(2) && App2._thumbSel.has(3)) &&
                  kg.querySelector('.thumb-item[data-page="2"]').classList.contains("sel") &&
                  kg.querySelector('.thumb-item[data-page="3"]').classList.contains("sel");
                // First button → block to the front
                document.getElementById("thumb-move-first").click();
                await new Promise((r) => setTimeout(r, 900));
                kbMove.firstOk = kbOrder() === "1(ann),2(ann),3" &&
                  !!(App2._thumbSel && App2._thumbSel.size === 2 && App2._thumbSel.has(1) && App2._thumbSel.has(2));
                // synthetic Ctrl+End → block to the back (the real-key stage
                // re-checks the same binding with NATIVE input later)
                document.dispatchEvent(new KeyboardEvent("keydown", { key: "End", ctrlKey: true, bubbles: true, cancelable: true }));
                await new Promise((r) => setTimeout(r, 900));
                kbMove.ctrlEndOk = kbOrder() === "1,2(ann),3(ann)";
                // Ctrl+M opens the move form; "before 1" sends the block to the front again
                document.dispatchEvent(new KeyboardEvent("keydown", { key: "m", ctrlKey: true, bubbles: true, cancelable: true }));
                kbMove.ctrlMForm = document.getElementById("thumb-move-form").hidden === false;
                document.getElementById("thumb-move-pos").value = "before 1";
                document.getElementById("thumb-move-go").click();
                await new Promise((r) => setTimeout(r, 900));
                kbMove.before1Ok = kbOrder() === "1(ann),2(ann),3" &&
                  !!(App2._thumbSel && App2._thumbSel.size === 2 && App2._thumbSel.has(1) && App2._thumbSel.has(2));
                // Last button → block to the back; Clear empties the selection
                document.getElementById("thumb-move-last").click();
                await new Promise((r) => setTimeout(r, 900));
                kbMove.lastOk = kbOrder() === "1,2(ann),3(ann)" &&
                  !!(App2._thumbSel && App2._thumbSel.size === 2 && App2._thumbSel.has(2) && App2._thumbSel.has(3));
                document.getElementById("thumb-move-clear").click();
                kbMove.clearOk = !App2._thumbSel && kbRow.hidden === true && kbForm.hidden === true;
                // undo restores the pre-Last state (order back, selection gone)
                const kbUndo = [...document.querySelectorAll(".toast-action")].pop();
                kbMove.undoOffered = !!kbUndo && kbUndo.textContent === "Undo reorder";
                if (kbUndo) kbUndo.click();
                await new Promise((r) => setTimeout(r, 900));
                kbMove.undone = kbOrder() === "1(ann),2(ann),3" && !App2._thumbSel && kbRow.hidden === true;
                kbMove.allOk = kbMove.rowShown === true && kbMove.formShown === true &&
                  kbMove.movedTo2 === true && kbMove.selTo2 === true &&
                  kbMove.firstOk === true && kbMove.ctrlEndOk === true &&
                  kbMove.ctrlMForm === true && kbMove.before1Ok === true &&
                  kbMove.lastOk === true && kbMove.clearOk === true &&
                  kbMove.undoOffered === true && kbMove.undone === true;
              } catch (e) { kbMove.error = String((e && e.message) || e); }
              pageMgr.kbMove = kbMove;
            } catch (e) { pageMgr.error = String((e && e.message) || e); }
            pageMgr.ctrlA = ctrlA; // carry the sub-stage into the result for diagnosis
            pageMgr.bsel = bsel;  // boundary text selection — same
            pageMgr.bhl = bhl;    // boundary selections offer the Highlight-all toast action
            pageMgr.hlAll = hlAll; // Ctrl+A → "Highlight all" toast action
            pageMgr.wsel = wsel;  // quick actions label a Ctrl+A selection "whole page"
            pageMgr.aaa = aaa;    // Ctrl+A+A selects the whole document when fully rendered
            pageMgr.clr = clr;    // "Clear highlights" quick action on the conversion toast
            pageMgr.ch = ch;     // AI quick row 'Copy highlights' → Markdown notes export
            pageMgr.aiW = aiW;   // AI pane resize + quick-row removal
            pageMgr.recent = recent; // home screen recents
            pageMgr.allOk =              pageMgr.opened === true && pageMgr.initialThumbs === 3 && pageMgr.initialPlan === 3 &&
              pageMgr.thumbRendered === true && pageMgr.sizeBadge === true && pageMgr.sizeAccurate === true &&
              pageMgr.annBadge === true && pageMgr.annNone === true &&
              pageMgr.sideLiveBadge === true && pageMgr.sideLiveTitle === true &&
              pageMgr.sideLiveUpdate === true && pageMgr.sideLiveRevert === true &&
              pageMgr.sideThumbs === true &&
              pageMgr.sideSizeBadge === true && pageMgr.sideSizeAccurate === true &&
              pageMgr.sideAnnBadge === true && pageMgr.sideAnnNone === true &&
              pageMgr.sideWarmsCache === true && pageMgr.sideRemoval === true &&
              pageMgr.sideSelAnnSet === true && pageMgr.sideSelAnnAnchor === true &&
              pageMgr.sideSelAnnClasses === true && pageMgr.sideSelAnnRow === true &&
              pageMgr.sideSelAnnToast === true && pageMgr.sideSelAnnGrows === true &&
              pageMgr.sideSelAnnShrinks === true && pageMgr.sideSelAnnToast1 === true &&
              pageMgr.sideSelAnnNone === true && pageMgr.sideSelAnnKept === true &&
              ctrlA.nonEmpty === true && ctrlA.layerOnCurrent === true && ctrlA.singleRange === true &&
              ctrlA.insideCurrentPage === true && ctrlA.coversWholeLayer === true &&
              ctrlA.pageStayed === true && ctrlA.inputNotHijacked === true && !ctrlA.error &&
              hlAll.toastAction === true && hlAll.created === true && hlAll.selCleared === true &&
              hlAll.undoRestores === true && !hlAll.error &&
              wsel.wholeDetected === true && wsel.wholeLabeled === true &&
              wsel.wholeNotEmbedded === true && wsel.partialDetected === true &&
              wsel.partialEmbedded === true && !wsel.error &&
              aaa.allRendered === true && aaa.spansAll === true && aaa.textBig === true &&
              aaa.toastPages === true && aaa.toastChars === true && aaa.toastAction === true &&
              aaa.hlAllPages === true && aaa.hlAllUndo === true && aaa.hlAllUndoRestores === true &&
              aaa.rendersOnDemand === true && aaa.reRendered === true &&
              aaa.pinned === true && aaa.pagesSurviveScroll === true && aaa.gateIsReal === true &&
              aaa.thumbsTouched === true && aaa.thumbsMatchToast === true &&
              aaa.escFlagCleared === true && aaa.escNoSelect === true && aaa.escToast === true &&
              aaa.renderedRestored === true &&
              aaa.persistSticky === true && aaa.persistDismissable === true && aaa.outsideDismisses === true &&
              aaa.selRangeShown === true && aaa.selRangeNarrows === true && aaa.selRangeClears === true &&
              aaa.copyBtnShown === true && aaa.copyHasHeaders === true && aaa.copyInOrder === true &&
              aaa.copyHasText === true && aaa.copyToast === true &&
              aaa.breakdownShown === true &&
              clr.btnShown === true && clr.armedLabel === true && clr.noClearOnArm === true &&
              clr.toastStays === true && clr.expiryDisarms === true && clr.reArmed === true &&
              clr.cleared === true && clr.toast === true && clr.undoRestores === true &&
              clr.apiSeed === true && clr.apiPage === true && clr.apiRange === true && clr.apiSet === true &&
              clr.apiUndo === true && clr.apiBackToBefore === true &&
              clr.mgrSel === true && clr.mgrCleared === true && clr.mgrToast === true &&
              clr.mgrClosed === true && clr.mgrUndoRestores === true && clr.mgrBackToBefore === true &&
              clr.qaShown === true && clr.qaArmed === true && clr.qaNoClear === true &&
              clr.qaCleared === true && clr.qaUndoRestores === true && clr.qaBackToBefore === true &&
              ch.shown === true && ch.emptyToast === true && ch.emptyNoCopy === true &&
              ch.copied === true && ch.hasHeaders === true && ch.hasPassages === true &&
              ch.order === true && ch.passageCount === true && ch.excludesEmpty === true &&
              ch.countToast === true && ch.noMutate === true && ch.undoRestores === true &&
              aiW.noQuickRow === true && aiW.quickPromptsGone === true &&
              aiW.footClear === true && aiW.footCopy === true && aiW.handleThere === true &&
              aiW.dragGrew === true && aiW.persisted === true && aiW.arrowShrinks === true &&
              aiW.dblReset === true &&
              recent.allOk === true && recent.deduped === true && recent.rendered === true &&
              recent.sectionShown === true && recent.clickOpens === true &&
              recent.urlEntry === true && recent.primaryCta === true && recent.noMarketing === true &&
              hlAll.clearPageBtn === true && hlAll.clearPageArmed === true && hlAll.noClearOnArm === true &&
              hlAll.pageCleared === true && hlAll.clearPageToast === true && hlAll.clearPageUndo === true &&
              !aaa.error &&
              bsel.endOk === true && bsel.endStartsAtFirst === true &&
              bsel.homeOk === true && bsel.spaceOk === true &&
              bhl.toastOffered === true && bhl.created === true && bhl.undoRestores === true &&
              !bsel.error &&
              pageMgr.selected === true && pageMgr.delArmed === true && pageMgr.delDisarmedBySel === true &&
              pageMgr.delReArmed === true && pageMgr.afterDelete === true && pageMgr.undoRestores === true &&
              pageMgr.undoSel === true && pageMgr.undoBtnDisabled === true && pageMgr.noAnnSel === true &&
              pageMgr.noAnnImmediate === true && pageMgr.redidDelete === true &&
              pageMgr.blankAdded === true && pageMgr.blankSize === true &&
              pageMgr.reordered === true &&              pageMgr.moveFirst === true && pageMgr.moveFirstSel === true &&              pageMgr.moveLast === true &&
              pageMgr.moveLastSel === true && pageMgr.homeSel === true && pageMgr.homePlan === true &&
              pageMgr.endSel === true && pageMgr.endPlan === true && pageMgr.homeInFieldKept === true &&
              pageMgr.rangeBack === true && pageMgr.rangeBackPlan === true && pageMgr.rangeBackClasses === true &&
              pageMgr.rangeReanchor === true && pageMgr.rangeForward === true && pageMgr.rangeExtendBack === true &&
              pageMgr.rangeInfo === true && pageMgr.rangeDragSet === true && pageMgr.rangeDragClasses === true &&
              pageMgr.rangeDragCleaned === true && pageMgr.rangeRestored === true &&
              pageMgr.kbRangeAnchor === true && pageMgr.kbRangeDown === true &&
              pageMgr.kbRangeDownAnchor === true && pageMgr.kbRangeInfo === true &&
              pageMgr.kbRangeClasses === true && pageMgr.kbRangeDownClamp === true &&
              pageMgr.kbRangeShrink === true && pageMgr.kbRangeShrinkClasses === true &&
              pageMgr.kbRangeGrowPast === true && pageMgr.kbRangeFlip === true &&
              pageMgr.kbRangeEnd === true && pageMgr.kbRangeHome === true &&
              pageMgr.kbRangeMid === true && pageMgr.kbRangeMidEnd === true &&
              pageMgr.kbRangeMidHome === true && pageMgr.kbRangeFreshDown === true &&
              pageMgr.kbRangeFreshUp === true && pageMgr.kbRangeInField === true &&
              pageMgr.kbRangeRestored === true &&
              pageMgr.ctrlAll === true && pageMgr.ctrlAllAnchor === true && pageMgr.ctrlAllPlan === true &&
              pageMgr.ctrlAllClasses === true && pageMgr.ctrlAllInfo === true &&
              pageMgr.ctrlInFieldKept === true && pageMgr.ctrlAll2 === true &&
              pageMgr.selAnnBoth === true && pageMgr.selAnnInfo === true && pageMgr.selAnnToast === true &&
              pageMgr.selAnnReacts === true && pageMgr.selAnnRestored === true &&
              pageMgr.invCompl === true && pageMgr.invAnchor === true && pageMgr.invInfo === true &&
              pageMgr.invToast === true && pageMgr.invClasses === true && pageMgr.invBack === true &&
              pageMgr.invKb === true && pageMgr.invInFieldKept === true && pageMgr.invRestored === true &&
              pageMgr.moveFormShown === true && pageMgr.moveHint === true &&
              pageMgr.moveToPos === true && pageMgr.moveFormHidden === true && pageMgr.moveInvalid === true &&
              pageMgr.moveFormKept === true && pageMgr.moveBefore === true && pageMgr.moveBeforeSel === true &&
              pageMgr.moveAfterNoop === true && pageMgr.moveAfterFormClosed === true &&
              pageMgr.moveListTwo === true && pageMgr.moveList === true && pageMgr.moveListSel === true &&
              pageMgr.moveListMismatch === true && pageMgr.posInputs === true && pageMgr.posMove === true &&
              pageMgr.posRenumbered === true && pageMgr.posEscReverts === true && pageMgr.posEscKeepsModal === true &&
              pageMgr.dragClass === true && pageMgr.dragIndicator === true &&
              pageMgr.dragLiveNumbers === true && pageMgr.dragNumbersRestored === true &&
              pageMgr.dragOrder === true && pageMgr.dragSel === true && pageMgr.dragIndicatorAfter === true &&
              pageMgr.dragRestored === true && pageMgr.dragSelRestored === true &&
              pageMgr.undoDrag === true && pageMgr.undoDragRestores === true && pageMgr.undoStackLive === true &&
              pageMgr.redoInitialDisabled === true && pageMgr.selHintDiscover === true &&
              pageMgr.redoEnabled === true &&
              pageMgr.redoRestores === true && pageMgr.redoDrained === true && pageMgr.selHintRedo === true &&
              pageMgr.redoEnabled2 === true && pageMgr.redoClearedByEdit === true &&
              pageMgr.redoWalkRestored === true && pageMgr.redoKey === true &&
              pageMgr.wrapRows === true && pageMgr.wrapIndicator === true &&
              pageMgr.wrapTarget === true && pageMgr.wrapDrop === true && pageMgr.wrapRestored === true &&
              pageMgr.blockSel === true && pageMgr.blockDragCarries === true &&
              pageMgr.blockIndicator === true && pageMgr.blockDropOrder === true &&
              pageMgr.blockSelFollows === true && pageMgr.blockUndoRestores === true &&
              pageMgr.srcInsertPrepared === true && pageMgr.srcInsertStaged === true &&
              pageMgr.srcAnnBadge === true && pageMgr.srcAnnNone === true && pageMgr.srcInsertUndo === true &&
              pageMgr.buildCount === true && pageMgr.applyOpened === true &&
              pageMgr.applyName === true && pageMgr.applyModalClosed === true &&
              pageMgr.annCarried === true && pageMgr.annDropped === true &&
              pageMgr.reorderHint === true && pageMgr.reorderSeedBadge === true &&
              pageMgr.reorderDragging === true && pageMgr.reorderIndicator === true &&
              pageMgr.reorderPreviewPill === true && pageMgr.reorderConfirmShown === true &&
              pageMgr.reorderNotCommitted === true && pageMgr.reorderPreviewCleaned === true &&
              pageMgr.reorderApplyBtn === true &&
              pageMgr.reorderCommitted === true && pageMgr.reorderDragCleaned === true &&
              pageMgr.reorderAnnFollowed === true && pageMgr.reorderAnnRemapped === true &&
              pageMgr.reorderUndoOffered === true && pageMgr.reorderUndone === true &&
              pageMgr.sideKbCtrlBase === true && pageMgr.sideKbDown === true &&
              pageMgr.sideKbDownAnchor === true && pageMgr.sideKbRow === true &&
              pageMgr.sideKbClasses === true && pageMgr.sideKbClamp === true &&
              pageMgr.sideKbShrink === true && pageMgr.sideKbGrowPast === true &&
              pageMgr.sideKbFlip === true && pageMgr.sideKbEnd === true &&
              pageMgr.sideKbHome === true && pageMgr.sideKbFreshDown === true &&
              pageMgr.sideKbFreshUp === true &&
              pageMgr.thumbRangeSel === true && pageMgr.thumbCtrlToggle === true && pageMgr.blockDragSet === true &&
              pageMgr.blockIndicator === true && pageMgr.blockConfirmShown === true &&
              pageMgr.blockApplyBtn === true &&
              pageMgr.blockCommitted === true && pageMgr.blockOrderOk === true &&
              pageMgr.blockSelFollowed === true && pageMgr.blockAnnFollowed === true &&
              pageMgr.blockUndoOffered === true && pageMgr.blockUndone === true &&
              pageMgr.disk && pageMgr.disk.allOk === true &&
              pageMgr.kbMove && pageMgr.kbMove.allOk === true && !pageMgr.error;
            const hiddenOk = hiddenProbe.boot.pass && hiddenProbe.afterModal.pass && hiddenProbe.afterCycle.pass && hiddenProbe.calibration.caught;
            const visibleOk = visibleProbe.boot.pass && visibleProbe.afterCycle.pass && visibleProbe.calibration.caught;
            // a vendored library whose module evaluation threw (even a trailing
            // throw V8 defers for namespace imports) must fail the gate — the
            // recorder in index.html captures window error events sourced from
            // /vendor/ so a broken pdf.js/pdf-lib can't sneak past "but the app
            // rendered fine"
            const bootErrs = (Array.isArray(window.__voltBootErrors) ? window.__voltBootErrors : []);
            const vendorBootErrors = { count: bootErrs.length, errors: bootErrs.slice(0, 5), allOk: bootErrs.length === 0 };
            // ── OCR stage (vendored Tesseract.js — the LOCAL engine) ────
            // a scanned PDF — a page whose ONLY content is an image, with no
            // embedded text — exercises the whole pipeline: runDoc() renders
            // it through pdf.js and recognizes it with the vendored engine,
            // the per-doc store persists it (a reopen loads the cache),
            // App.runSearch falls back to OCR word boxes, and the AI chat
            // reads the recognized text. Runs LAST (nothing after it depends
            // on the open document) and restores the sample before returning.
            const ocr = { error: null };
            try {
              ocr.engine = !!(window.Volt.OCR && Volt.OCR.available);
              // canvas → PNG → image-only PDF via pdf-lib: exactly what a
              // scanner produces (a "scanned" document has no text layer)
              const oc2 = document.createElement("canvas");
              oc2.width = 900; oc2.height = 260;
              const og = oc2.getContext("2d");
              og.fillStyle = "#fff"; og.fillRect(0, 0, 900, 260);
              og.fillStyle = "#000"; og.font = "bold 84px sans-serif";
              og.fillText("VOLT OCR 42", 40, 170);
              const oPng = Uint8Array.from(atob(oc2.toDataURL("image/png").split(",")[1]), (ch) => ch.charCodeAt(0));
              const oPdf = await window.PDFLib.PDFDocument.create();
              const oPage = oPdf.addPage([620, 200]);
              const oImg = await oPdf.embedPng(oPng);
              oPage.drawImage(oImg, { x: 10, y: 10, width: 600, height: 180 });
              const oBytes = await oPdf.save();
              ocr.docBuilt = oBytes.byteLength > 1000;
              const oOpened = await Volt.App.openBuffer(oBytes.slice(0), "scanned-ocr.pdf", oBytes.byteLength);
              await new Promise((r) => setTimeout(r, 400));
              ocr.opened = !!oOpened && !!Volt.App.currentDoc && Volt.App.currentDoc.numPages === 1;
              ocr.buttonShown = document.getElementById("btn-ocr").hidden === false;
              const oRes = await Volt.OCR.runDoc();
              await new Promise((r) => setTimeout(r, 300));
              ocr.recognized = !!oRes && oRes.pages === 1 && /VOLT/.test(Volt.OCR.pageText(1));
              // the recognized text is VISIBLE and selectable: real spans in
              // the page's text layer, positioned from the OCR bboxes through
              // the page viewport (the half of OCR a user can actually see)
              const oWrap = document.querySelector('.page-wrap[data-page="1"]');
              const oLayer = oWrap && oWrap.querySelector(".page-text-layer");
              const oSpans = oLayer ? [...oLayer.querySelectorAll("span")] : [];
              ocr.textLayer = oSpans.length >= 1 &&
                oSpans.some((sp) => /VOLT/.test(sp.textContent)) &&
                oSpans.every((sp) => parseFloat(sp.style.left || "0") >= 0 && parseFloat(sp.style.top || "0") >= 0 &&
                  parseFloat(sp.style.width || "0") > 0);
              // and a re-render (fitWidth → _buildTextLayer) keeps them — the
              // layer is glued to the page, not a one-shot artifact
              await Volt.App.fitWidth();
              await new Promise((r) => setTimeout(r, 500));
              const oLayer2 = document.querySelector('.page-wrap[data-page="1"] .page-text-layer');
              ocr.textLayerSurvives = !!oLayer2 && oLayer2.querySelectorAll("span").length >= oSpans.length &&
                [...oLayer2.querySelectorAll("span")].some((sp) => /VOLT/.test(sp.textContent));
              // ── Highlight all on the scanned page ───────────────────
              // Ctrl+A selects the OCR text layer; the toast's "Highlight all"
              // must convert it into LINE-SIZED quads aligned with the OCR
              // spans — the regression class that produced a solid merged
              // block shifted off the visible text (the pixel-sampled
              // complaint: a giant yellow rectangle per page instead of
              // line highlights). Assert the quads (a) stay near the span
              // height (never a multi-line merged block) and (b) sit within
              // padding of the spans' x-range (never shifted off the text),
              // then undo so the store is as it was.
              try {
                const oHlBefore = Volt.Ann.list.length;
                Volt.Ann.setMode("select");
                Volt.App.goToPage(1, false);
                await new Promise((r) => setTimeout(r, 150));
                window.dispatchEvent(new KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true, cancelable: true }));
                await new Promise((r) => setTimeout(r, 120));
                const oActA = [...document.querySelectorAll("#toasts .toast-action")]
                  .filter((a) => a.textContent === "Highlight all");
                ocr.hlToast = oActA.length >= 1;
                if (oActA.length) oActA[oActA.length - 1].click();
                await new Promise((r) => setTimeout(r, 150));
                const oHlAdded = Volt.Ann.list.slice(oHlBefore);
                const oHlAnn = oHlAdded.filter((a) => a.type === "highlight" && a.page === 1);
                ocr.hlCreated = oHlAnn.length === 1 && Array.isArray(oHlAnn[0].quads) && oHlAnn[0].quads.length >= 1;
                const oWrapA = document.querySelector('.page-wrap[data-page="1"]');
                if (ocr.hlCreated && oWrapA) {
                  const oSpansA = [...oWrapA.querySelectorAll(".ocr-span")];
                  const oWrA = oWrapA.getBoundingClientRect();
                  const oBoxA = oSpansA.map((s) => {
                    const b = s.getBoundingClientRect();
                    return { x1: b.left - oWrA.left, x2: b.left - oWrA.left + b.width, y1: b.top - oWrA.top, y2: b.top - oWrA.top + b.height };
                  });
                  const oMedH = oBoxA.length ? [...oBoxA.map((b) => b.y2 - b.y1)].sort((a, b) => a - b)[Math.floor(oBoxA.length / 2)] : 0;
                  const oLocalA = oHlAnn[0].quads.map((q) => q.map((pt) => Volt.Ann._pdfToLocal(oWrapA, pt.x, pt.y)));
                  const oQH = oLocalA.map((q) => Math.max(...q.map((p) => p.y)) - Math.min(...q.map((p) => p.y)));
                  // a merged block spans many lines, so its quad height is
                  // many multiples of the median span height; line highlights
                  // are ≈ the span height (+ the 0.75pt padding) with at most
                  // the page's title-style oversize
                  ocr.hlLineSized = oMedH > 0 && oQH.every((h) => h < Math.max(oMedH * 3, oMedH + 20));
                  // every quad must overlap the spans' column horizontally
                  // (padding 1.5pt) — a shifted block sits beside the text
                  const oSpanX = oBoxA.length ? [Math.min(...oBoxA.map((b) => b.x1)), Math.max(...oBoxA.map((b) => b.x2))] : null;
                  ocr.hlAligned = !!oSpanX && oLocalA.every((q) => {
                    const qx1 = Math.min(...q.map((p) => p.x)) + 1.5, qx2 = Math.max(...q.map((p) => p.x)) - 1.5;
                    return qx2 > oSpanX[0] && qx1 < oSpanX[1];
                  });
                } else { ocr.hlLineSized = false; ocr.hlAligned = false; }
                if (oHlAdded.length) Volt.Ann.undo(); // revert so the store is untouched
                ocr.hlReverted = Volt.Ann.list.length === oHlBefore;
              } catch (e) { ocr.hlError = String((e && e.message) || e); ocr.hlToast = false; ocr.hlCreated = false; ocr.hlLineSized = false; ocr.hlAligned = false; ocr.hlReverted = false; }
              // search fallback: Ctrl+F for the OCR'd word finds it via word
              // boxes (an image-only page would otherwise have zero results)
              await Volt.App.runSearch("volt");
              const oSearch = Volt.App.search;
              ocr.searchFound = !!oSearch && oSearch.results.length === 1 &&
                oSearch.results[0].page === 1 && oSearch.results[0].rects.length >= 1;
              Volt.App.clearSearch();
              // AI fallback: grounded chat reads the scanned page's text
              const oTexts = await Volt.AI.ensurePageTexts();
              ocr.aiReads = !!oTexts && oTexts.pages.length === 1 && /VOLT/.test(oTexts.pages[0].text);
              // persistence: reopening the same bytes loads the cached store
              await Volt.App.openBuffer(oBytes.slice(0), "scanned-ocr.pdf", oBytes.byteLength);
              await new Promise((r) => setTimeout(r, 400));
              ocr.cached = /VOLT/.test(Volt.OCR.pageText(1));
              // ── per-document OCR language (searchable status popover) ──
              // the Tools-menu item must be visible with the doc open and show
              // the current language; the popover lists 20+ languages, each row
              // with its availability status (built in / cached / on demand),
              // search narrows the list, Esc closes and returns focus to the
              // item, and a row click applies the language. Switching language
              // is per-document, invalidates the old store, and downloads +
              // caches the traineddata — exercised OFFLINE by pointing
              // downloadLang at the vendored eng file (fetch → gunzip →
              // IndexedDB, no network), then recognizing with a custom code.
              const oLangBtn = document.getElementById("btn-ocr-lang");
              const oLangCur = document.getElementById("ocr-lang-cur");
              const oLangPop = document.getElementById("ocr-lang-pop");
              const oLangList = document.getElementById("ocr-lang-list");
              const oLangSearch = document.getElementById("ocr-lang-search");
              ocr.langPicker = !!oLangBtn && oLangBtn.hidden === false &&
                !!oLangPop && oLangPop.hidden === true && !!oLangList &&
                !!oLangCur && oLangCur.textContent === "English";
              // realistic flow: the user opens the Tools menu, then the item
              // (a programmatic click on a hidden-panel item is not a path a
              // real user can take, and it changes where Esc restores focus)
              document.getElementById("btn-tools").click();
              oLangBtn.click();
              await new Promise((r) => setTimeout(r, 120));
              const oStatus0 = {};
              for (const r of oLangList.querySelectorAll(".ol-row")) oStatus0[r.dataset.code] = r.querySelector(".ol-status").textContent;
              ocr.popOpens = oLangPop.hidden === false && oLangBtn.getAttribute("aria-expanded") === "true" &&
                [...oLangList.querySelectorAll(".ol-row")].length >= 20 && oStatus0["eng"] === "Built in";
              oLangSearch.value = "fren";
              oLangSearch.dispatchEvent(new Event("input", { bubbles: true }));
              await new Promise((r) => setTimeout(r, 60));
              const oFiltered = [...oLangList.querySelectorAll(".ol-row")].filter((r) => !r.hidden).map((r) => r.dataset.code);
              ocr.popSearch = oFiltered.length === 1 && oFiltered[0] === "fra";
              oLangSearch.focus();
              oLangSearch.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
              await new Promise((r) => setTimeout(r, 60));
              ocr.popEsc = oLangPop.hidden === true && oLangBtn.getAttribute("aria-expanded") === "false" &&
                document.activeElement === oLangBtn;
              const oDl = await Volt.OCR.downloadLang("x-scan-test", { url: "/vendor/tesseract/tessdata/eng.traineddata.gz" });
              const oCachedAfter = await Volt.OCR._cached("x-scan-test");
              ocr.langDownload = oDl.ok === true && oCachedAfter === true &&
                oDl.stored > oDl.bytes; // the gunzip actually ran (decompressed > gz)
              const oLangKey = Volt.OCR._langKey();
              const oBeforeLang = Volt.OCR.pageText(1);
              await Volt.OCR.setLang("x-scan-test");
              ocr.langSet = !!oLangKey && localStorage.getItem(oLangKey) === "x-scan-test" &&
                oBeforeLang !== "" && Volt.OCR.pageText(1) === "" &&
                oLangCur.textContent === "x-scan-test" &&
                !!oLangList.querySelector('.ol-row[data-code="x-scan-test"]');
              // re-run OCR with the new language — the worker reloads from cache
              const oRes2 = await Volt.OCR.runDoc();
              await new Promise((r) => setTimeout(r, 300));
              ocr.langRecognized = !!oRes2 && oRes2.pages === 1 && /VOLT/.test(Volt.OCR.pageText(1));
              // the per-doc language survives a reopen
              await Volt.App.openBuffer(oBytes.slice(0), "scanned-ocr.pdf", oBytes.byteLength);
              await new Promise((r) => setTimeout(r, 400));
              ocr.langPersists = Volt.OCR.lang() === "x-scan-test";
              // restore the default and remove the seeded cache key
              await Volt.OCR.setLang("eng");
              const oIdb = await Volt.OCR._idb();
              await oIdb.del(Volt.OCR._cacheKey("x-scan-test"));
              // ── OCR text-layer toggle + transcript export ──
              // setLang just cleared the store, so re-run OCR first (eng), then:
              // the eye button must be visible and ON; toggling it OFF strips
              // the .ocr-span elements (and a re-render must NOT re-inject them),
              // ON brings them back. The transcript builders must produce
              // .txt/.md output with per-page blocks, and the export modal must
              // offer the two OCR items only while OCR text exists.
              const oRes3 = await Volt.OCR.runDoc();
              await new Promise((r) => setTimeout(r, 300));
              ocr.reRecognized = !!oRes3 && oRes3.pages === 1;
              const oEye = document.getElementById("btn-ocr-layer");
              ocr.layerOn = !!oEye && oEye.hidden === false && oEye.classList.contains("active") === true;
              const oLayerBefore = document.querySelector('.page-wrap[data-page="1"] .page-text-layer');
              const oSpanCountOn = oLayerBefore ? oLayerBefore.querySelectorAll(".ocr-span").length : 0;
              Volt.OCR.setLayer(false);
              const oLayerOff = document.querySelector('.page-wrap[data-page="1"] .page-text-layer');
              const oSpanCountOff = oLayerOff ? oLayerOff.querySelectorAll(".ocr-span").length : -1;
              await Volt.App.fitWidth();
              await new Promise((r) => setTimeout(r, 400));
              const oLayerAfterRender = document.querySelector('.page-wrap[data-page="1"] .page-text-layer');
              const oSpanCountRerender = oLayerAfterRender ? oLayerAfterRender.querySelectorAll(".ocr-span").length : -1;
              Volt.OCR.setLayer(true);
              const oLayerBack = document.querySelector('.page-wrap[data-page="1"] .page-text-layer');
              const oSpanCountBack = oLayerBack ? oLayerBack.querySelectorAll(".ocr-span").length : -1;
              ocr.layerToggle = oSpanCountOn >= 1 && oSpanCountOff === 0 && oSpanCountRerender === 0 && oSpanCountBack >= oSpanCountOn;
              const oTxt = Volt.OCR.toText();
              const oMd = Volt.OCR.toMarkdown();
              ocr.transcripts = oTxt.indexOf("Page 1") !== -1 && oTxt.indexOf("VOLT") !== -1 &&
                oMd.indexOf("## Page 1") !== -1 && oMd.indexOf("VOLT") !== -1;
              // ── OCR-first text layer (misaligned embedded text) ────────
              // the regression class the user hit twice: a scan whose baked-in
              // text layer is INVISIBLE and offset from the visible page —
              // highlights/selection follow the embedded spans and land beside
              // the visible text (the pixel-sampled complaint: solid yellow
              // blocks over blank paper). Build exactly that document (the
              // scanned image + invisible white text pushed right), seed the
              // already-recognized words under its identity, and assert (a)
              // _embeddedMisaligned detects the offset, (b) the popover
              // checkbox + setPreferLayer replace the layer with the aligned
              // OCR spans, (c) Ctrl+A → Highlight all then lands on those
              // spans, and (d) flipping the preference restores the embedded
              // layer — plus no false positive on a doc with no embedded text.
              try {
                const oScanStore = (Volt.OCR._store && Volt.OCR._store()) || [];
                const oPdf2 = await window.PDFLib.PDFDocument.create();
                const oPage2 = oPdf2.addPage([620, 200]);
                const oImg2 = await oPdf2.embedPng(oPng);
                oPage2.drawImage(oImg2, { x: 10, y: 10, width: 600, height: 180 });
                const oFont2 = await oPdf2.embedFont(window.PDFLib.StandardFonts.Helvetica);
                // invisible (white) embedded text, pushed RIGHT of the visible glyphs
                oPage2.drawText("VOLT OCR 42", { x: 300, y: 40, size: 84, font: oFont2, color: window.PDFLib.rgb(1, 1, 1) });
                const oBytes2 = await oPdf2.save();
                await Volt.App.openBuffer(oBytes2.slice(0), "offset-embed.pdf", oBytes2.byteLength);
                await new Promise((r) => setTimeout(r, 400));
                if (Volt.OCR._save && oScanStore.length) Volt.OCR._save(oScanStore); // same image → same words, new identity
                ocr.preferDetect = (await Volt.OCR._embeddedMisaligned(1)) === true;
                const oPreferBox = document.getElementById("ocr-prefer");
                ocr.preferControl = !!oPreferBox && oPreferBox.type === "checkbox";
                // embedded spans are present before the toggle (the invisible layer)
                const oEmbLayer = document.querySelector('.page-wrap[data-page="1"] .page-text-layer');
                const oEmbSpans = oEmbLayer ? [...oEmbLayer.querySelectorAll("span")].filter((s) => s.textContent.trim()) : [];
                ocr.preferHadEmbedded = oEmbSpans.some((s) => !s.classList.contains("ocr-span"));
                Volt.OCR.setPreferLayer(true);
                await new Promise((r) => setTimeout(r, 500));
                const oPfLayer = document.querySelector('.page-wrap[data-page="1"] .page-text-layer');
                const oPfSpans = oPfLayer ? [...oPfLayer.querySelectorAll("span")].filter((s) => s.textContent.trim()) : [];
                ocr.preferLayerOn = !!oPreferBox && oPreferBox.checked === true &&
                  oPfSpans.length >= 1 && oPfSpans.every((s) => s.classList.contains("ocr-span")) &&
                  oPfSpans.some((s) => /VOLT/.test(s.textContent));
                // Highlight all on the OCR-first layer: quads must overlap the
                // OCR span boxes (they are the visible text's positions now)
                try {
                  const oH2Before = Volt.Ann.list.length;
                  Volt.Ann.setMode("select");
                  Volt.App.goToPage(1, false);
                  await new Promise((r) => setTimeout(r, 150));
                  window.dispatchEvent(new KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true, cancelable: true }));
                  await new Promise((r) => setTimeout(r, 120));
                  const oAct2 = [...document.querySelectorAll("#toasts .toast-action")]
                    .filter((a) => a.textContent === "Highlight all");
                  if (oAct2.length) oAct2[oAct2.length - 1].click();
                  await new Promise((r) => setTimeout(r, 150));
                  const oH2Added = Volt.Ann.list.slice(oH2Before);
                  const oH2Ann = oH2Added.filter((a) => a.type === "highlight" && a.page === 1);
                  const oWrap2 = document.querySelector('.page-wrap[data-page="1"]');
                  if (oH2Ann.length && oWrap2) {
                    const oSpans2 = [...oWrap2.querySelectorAll(".ocr-span")];
                    const oWr2 = oWrap2.getBoundingClientRect();
                    const oBox2 = oSpans2.map((s) => {
                      const b = s.getBoundingClientRect();
                      return { x1: b.left - oWr2.left, x2: b.left - oWr2.left + b.width, y1: b.top - oWr2.top, y2: b.top - oWr2.top + b.height };
                    });
                    const oLocal2 = oH2Ann[0].quads.map((q) => q.map((pt) => Volt.Ann._pdfToLocal(oWrap2, pt.x, pt.y)));
                    const oSpanX2 = oBox2.length ? [Math.min(...oBox2.map((b) => b.x1)), Math.max(...oBox2.map((b) => b.x2))] : null;
                    ocr.preferHlAligned = !!oSpanX2 && oLocal2.every((q) => {
                      const qx1 = Math.min(...q.map((p) => p.x)) + 1.5, qx2 = Math.max(...q.map((p) => p.x)) - 1.5;
                      return qx2 > oSpanX2[0] && qx1 < oSpanX2[1];
                    });
                  } else { ocr.preferHlAligned = false; }
                  if (oH2Added.length) Volt.Ann.undo();
                } catch (e2) { ocr.preferHlAligned = false; }
                // flipping back restores the embedded (invisible) spans
                Volt.OCR.setPreferLayer(false);
                await new Promise((r) => setTimeout(r, 500));
                const oPfLayer2 = document.querySelector('.page-wrap[data-page="1"] .page-text-layer');
                const oPfSpans2 = oPfLayer2 ? [...oPfLayer2.querySelectorAll("span")].filter((s) => s.textContent.trim()) : [];
                ocr.preferReverted = !!oPreferBox && oPreferBox.checked === false &&
                  oPfSpans2.some((s) => !s.classList.contains("ocr-span"));
                try { localStorage.removeItem(Volt.OCR._preferKey()); } catch (e3) { /* ignore */ }
                // a document with NO embedded text must not be flagged (false
                // positive guard — the plain scanned page has only the image)
                await Volt.App.openBuffer(oBytes.slice(0), "scanned-ocr.pdf", oBytes.byteLength);
                await new Promise((r) => setTimeout(r, 400));
                ocr.preferNoFalse = (await Volt.OCR._embeddedMisaligned(1)) === false;
                await Volt.App.openBuffer(oBytes.slice(0), "scanned-ocr.pdf", oBytes.byteLength);
                await new Promise((r) => setTimeout(r, 300));
              } catch (e4) {
                ocr.preferError = String((e4 && e4.message) || e4);
                ocr.preferDetect = false; ocr.preferControl = false; ocr.preferHadEmbedded = false;
                ocr.preferLayerOn = false; ocr.preferHlAligned = false; ocr.preferReverted = false; ocr.preferNoFalse = false;
              }
              document.getElementById("btn-export").click();
              await new Promise((r) => setTimeout(r, 250));
              ocr.exportItemsShown = document.getElementById("export-ocr-txt").hidden === false &&
                document.getElementById("export-ocr-md").hidden === false;
              document.getElementById("export-close").click();
              // ── OCR content fingerprint ──
              // a scanned doc gets a content fingerprint only once OCR has run
              // (its pages have no embedded text): assert it is a stable
              // 16-hex hash, that a RENAMED copy of the same bytes recomputes
              // to the SAME hash (the name is not consulted — the fingerprint
              // recognizes the sample pages on demand for the new identity),
              // and that a doctored same-size fingerprint is rejected
              const ofp1 = (Volt.App.currentDocInfo && Volt.App.currentDocInfo.fingerprint) || null;
              ocr.fpShape = typeof ofp1 === "string" && ofp1.length === 16;
              await Volt.App.recomputeFingerprint();
              const ofp2 = (Volt.App.currentDocInfo && Volt.App.currentDocInfo.fingerprint) || null;
              ocr.fpStable = typeof ofp2 === "string" && ofp2 === ofp1;
              await Volt.App.openBuffer(oBytes.slice(0), "renamed-scan.pdf", oBytes.byteLength);
              await Volt.App._fpPromise;
              const ofpRenamed = (Volt.App.currentDocInfo && Volt.App.currentDocInfo.fingerprint) || null;
              ocr.fpRenamedMatches = typeof ofpRenamed === "string" && ofpRenamed === ofp1;
              ocr.fpDoctoredRejected = Volt.App._matchesBackup(
                { file: "renamed-scan.pdf", fileSize: Volt.App.currentDocInfo.size, filePages: Volt.App.currentDocInfo.pages,
                  fileFingerprint: Utils.fp64(Utils.fpNormalize("doctored scan content")) },
                "renamed-scan.pdf", Volt.App.currentDocInfo.name) === false;
              // back on the original scanned identity (same bytes, same name)
              await Volt.App.openBuffer(oBytes.slice(0), "scanned-ocr.pdf", oBytes.byteLength);
              await new Promise((r) => setTimeout(r, 300));
              // back to the sample so the probe ends where it began (guarded:
              // a hung openSample must never hang the whole smoke)
              Volt.App.openSample();
              const oT = Date.now();
              while (Date.now() - oT < 8000 && (!Volt.App.currentDocInfo || Volt.App.currentDocInfo.name !== "The Quiet Engine — sample.pdf")) {
                await new Promise((r) => setTimeout(r, 200));
              }
              ocr.restored = !!Volt.App.currentDocInfo && Volt.App.currentDocInfo.name === "The Quiet Engine — sample.pdf";
              // a document WITHOUT OCR data (the sample has embedded text only)
              // must not offer the OCR transcript items
              document.getElementById("btn-export").click();
              await new Promise((r) => setTimeout(r, 250));
              ocr.exportItemsHiddenNoData = document.getElementById("export-ocr-txt").hidden === true &&
                document.getElementById("export-ocr-md").hidden === true;
              document.getElementById("export-close").click();
            } catch (e) { ocr.error = String((e && e.message) || e); }
            // ── office export stage (last — opens its own table document) ──
            // builds a small PDF with a title, a prose line, an embedded
            // picture and a 4x3 text-drawn table; the collectors must detect
            // the table and image, the .docx/.xlsx must be written to disk,
            // and main validates them with the real zipfile module
            const office = { error: null };
            try {
              // the Word/Excel/PowerPoint/TSV items are always offered in the
              // export modal
              document.getElementById("btn-export").click();
              await new Promise((r) => setTimeout(r, 250));
              office.modalItems = document.getElementById("export-docx").hidden === false &&
                document.getElementById("export-xlsx").hidden === false &&
                document.getElementById("export-pptx").hidden === false &&
                document.getElementById("export-tsv").hidden === false;
              document.getElementById("export-close").click();
              const oCanvas = document.createElement("canvas");
              oCanvas.width = 200; oCanvas.height = 60;
              const og = oCanvas.getContext("2d");
              og.fillStyle = "#4a6cf7"; og.fillRect(0, 0, 200, 60);
              og.fillStyle = "#fff"; og.font = "bold 28px sans-serif"; og.fillText("CHART", 55, 38);
              const oPng = Uint8Array.from(atob(oCanvas.toDataURL("image/png").split(",")[1]), (ch) => ch.charCodeAt(0));
              const oPdf = await window.PDFLib.PDFDocument.create();
              const oPage = oPdf.addPage([612, 792]);
              const oHelv = await oPdf.embedFont(window.PDFLib.StandardFonts.Helvetica);
              oPage.drawText("Quarterly Sales", { x: 60, y: 750, size: 20, font: oHelv });
              oPage.drawText("A normal paragraph describing the numbers in prose form.", { x: 60, y: 726, size: 12, font: oHelv });
              const oImg = await oPdf.embedPng(oPng);
              oPage.drawImage(oImg, { x: 60, y: 640, width: 200, height: 60 });
              const oCols = [60, 220, 380], oRows = [590, 570, 550, 530];
              const oHeader = ["Item", "Qty", "Price"];
              const oData = [["Apples", "3", "2.50"], ["Pears", "7", "1.10"], ["Total", "10", "3.60"]];
              for (let c = 0; c < 3; c++) oPage.drawText(oHeader[c], { x: oCols[c], y: oRows[0], size: 12, font: oHelv });
              for (let r = 1; r < oRows.length; r++) for (let c = 0; c < 3; c++) oPage.drawText(oData[r - 1][c], { x: oCols[c], y: oRows[r], size: 12, font: oHelv });
              // a gridlines-only table: 3 cols x 2 rows of stroked rects, NO
              // text — the vector-grid detector must see it (blank forms)
              const oBorder = window.PDFLib.rgb(0.2, 0.2, 0.25);
              for (let r = 0; r < 2; r++) for (let c = 0; c < 3; c++)
                oPage.drawRectangle({ x: 60 + c * 160, y: 420 - r * 40, width: 160, height: 40, borderColor: oBorder, borderWidth: 1 });
              // a merged-cell table: a full-width header cell + 3 body cells,
              // header text spanning columns 1-2 — the grid flattens it to one
              // cell with empty neighbors
              oPage.drawRectangle({ x: 60, y: 290, width: 480, height: 40, borderColor: oBorder, borderWidth: 1 });
              for (let c = 0; c < 3; c++) oPage.drawRectangle({ x: 60 + c * 160, y: 250, width: 160, height: 40, borderColor: oBorder, borderWidth: 1 });
              oPage.drawText("Combined", { x: 70, y: 302, size: 12, font: oHelv });
              oPage.drawText("Alpha", { x: 70, y: 262, size: 12, font: oHelv });
              oPage.drawText("Beta", { x: 230, y: 262, size: 12, font: oHelv });
              oPage.drawText("Gamma", { x: 390, y: 262, size: 12, font: oHelv });
              const oBytes = await oPdf.save();
              await Volt.App.openBuffer(oBytes.slice(0), "office-table.pdf", oBytes.byteLength);
              await new Promise((r) => setTimeout(r, 500));
              const coll = await window.OfficeExport.collect(Volt.App);
              office.collected = !!coll && coll.pages.length === 1 && !!coll.title;
              const oPg = coll && coll.pages[0];
              const oTabs = (oPg && oPg.tables) || [];
              office.tableCount = oTabs.length;
              // the text-gap table (4 x 3) must still be found, the drawn grid
              // table must appear as a blank 2 x 3 grid, and the merged table
              // must flatten to its first column with empty neighbors
              office.hasTextTable = oTabs.some((t) => t.length === 4 && t[0] && t[0].length === 3 &&
                t[0][0] === "Item" && t[3][2] === "3.60");
              office.hasGridTable = oTabs.some((t) => t.length === 2 && t[0] && t[0].length === 3 &&
                t.every((r) => r.every((c) => !String(c || "").trim())));
              const mergedT = oTabs.find((t) => t.some((r) => r.some((c) => /Combined/.test(String(c || "")))));
              office.hasMergedTable = !!mergedT && mergedT[0][0] === "Combined" &&
                !String(mergedT[0][1] || "").trim() && !String(mergedT[0][2] || "").trim() &&
                mergedT[1][0] === "Alpha" && mergedT[1][1] === "Beta" && mergedT[1][2] === "Gamma";
              office.imageCount = oPg ? oPg.images.length : 0;
              office.titleFound = !!(oPg && oPg.paragraphs.some((p) => /Quarterly Sales/.test(p.text)));
              // table lines must NOT also appear as paragraphs (no doubling)
              office.paraExcludesTable = !!(oPg && oPg.paragraphs.some((p) => /normal paragraph/.test(p.text)) &&
                !oPg.paragraphs.some((p) => /Apples/.test(p.text)));
              // the merged header is table text, not prose
              office.mergedNotProse = !(oPg && oPg.paragraphs.some((p) => /Combined/.test(p.text)));
              // the spreadsheet/TSV samples come from the text table (the
              // grid-only table is blank, so it would make a useless sample)
              const oTabT = oTabs.find((t) => t.length === 4);
              const oDocx = window.OfficeExport.docx(coll);
              const oXlsx = window.OfficeExport.xlsx({ sheets: [{ name: "Table 1", rows: oTabT }] });
              office.docxSize = oDocx.length; office.xlsxSize = oXlsx.length;
              // desktop-bridge checks (temp-file writes + 'Open with…'):
              // Electron-only — browser/PWA mode has no preload bridge, so
              // these become N/A there (the detection assertions above are the
              // real content checks and run in both modes). main skips the
              // python zip validation when this flag says the bridge was
              // absent, so no phantom missing-file failure.
              // deck = title slide + per page (prose slide + table slide(s) +
              // image slide(s)); the 1-page test doc has 1 prose + 3 tables
              // (text-gap + drawn grid + merged) + 1 image, so the whole deck
              // must be exactly 6 slides — python re-counts the zip to verify
              const oPptx = window.OfficeExport.pptx(coll);
              office.pptxSize = oPptx.length;
              // the builder reports its REAL slide count (prose slides chunk
              // when a page's text is long, so it can exceed the simple
              // formula) — python must find exactly this many in the zip
              office.expectedSlides = oPptx.slideCount;
              const oTsv = window.OfficeExport.tsv(oTabT);
              // String.fromCharCode keeps the probe template single-line — a
              // backslash-n escape would become a real newline in the output
              office.tsvShape = oTsv.includes(String.fromCharCode(9)) && oTsv.includes(String.fromCharCode(10));
              // desktop-bridge checks (temp-file writes + 'Open with…'):
              // Electron-only — browser/PWA mode has no preload bridge, so
              // these become N/A there (the detection assertions above are the
              // real content checks and run in both modes). main skips the
              // python zip validation when this flag says the bridge was
              // absent, so no phantom missing-file failure.
              office.desktopSkipped = !window.voltDesktop ||
                typeof window.voltDesktop.writeFile !== "function";
              if (!office.desktopSkipped) {
                // 'Open with…' bridge: the renderer hands the bytes to the OS
                // default handler — under --smoke main writes the temp file
                // and reports the path WITHOUT launching Word/Excel, so
                // assert the round-trip (ok + a .docx temp path) here
                const openR = await window.voltDesktop.openWith("office-open-test.docx", oDocx);
                office.openWithOk = !!(openR && openR.ok && /office-open-test\.docx$/i.test(openR.path || ""));
                const w1 = await window.voltDesktop.writeFile(OFFICE_TMP1, oDocx);
                const w2 = await window.voltDesktop.writeFile(OFFICE_TMP2, oXlsx);
                const w3 = await window.voltDesktop.writeFile(OFFICE_TMP3, oPptx);
                office.written = !!(w1 && w1.ok) && !!(w2 && w2.ok) && !!(w3 && w3.ok);
              } else {
                office.openWithOk = true; // N/A — no shell to hand files to
                office.written = true;
              }
              // back to the sample so the probe ends where the realKeys stage
              // expects it (3 pages — the kb sub-stage seeds pages 1 and 3 and
              // clicks thumb-grid items for them; leaving the 1-page
              // office-table.pdf open makes q(3) null and the stage throws)
              Volt.App.openSample();
              const oT2 = Date.now();
              while (Date.now() - oT2 < 8000 && (!Volt.App.currentDocInfo || Volt.App.currentDocInfo.name !== "The Quiet Engine — sample.pdf")) {
                await new Promise((r) => setTimeout(r, 200));
              }
              office.restoredSample = !!Volt.App.currentDocInfo && Volt.App.currentDocInfo.name === "The Quiet Engine — sample.pdf";
              // ── selection-aware office exports ──────────────────────
              // a live Pages-manager selection must drive the office exports:
              // seed one on the sample (plan indexes 0 and 2 = pages 1 and 3),
              // then verify the helper maps it, the collectors honor the page
              // list (actual page numbers preserved), and the deck shrinks to
              // match. Also: a whole-document selection is no filter, and a
              // dirty plan (staged blank) maps the doc pages with the
              // insertion counted as skipped.
              Volt.App._pagePlanDoc = Volt.App.currentDoc;
              Volt.App._pagePlan = [{ kind: "doc", oldPage: 1 }, { kind: "doc", oldPage: 2 }, { kind: "doc", oldPage: 3 }];
              Volt.App._pageSel = new Set([0, 2]);
              const selA = Volt.App._pagesSelectedForExport();
              office.selPages = selA ? selA.pages : null;
              office.selSkipped = selA ? selA.skipped : -1;
              const collSel = await window.OfficeExport.collect(Volt.App, selA && selA.pages);
              office.selCollected = !!collSel && collSel.pages.length === 2 &&
                collSel.pages[0].num === 1 && collSel.pages[1].num === 3;
              const selPptx = window.OfficeExport.pptx(collSel);
              office.selPptxBytes = selPptx.length;
              office.selExpectedSlides = selPptx.slideCount; // the deck's real size
              office.selWritten = office.desktopSkipped ? true :
                !!(await window.voltDesktop.writeFile(OFFICE_TMP4, selPptx) || {}).ok;
              // whole-document selection → null (normal whole-doc export)
              Volt.App._pageSel = new Set([0, 1, 2]);
              office.selWholeIsNull = Volt.App._pagesSelectedForExport() === null;
              // dirty plan: the staged blank can't be exported from the open
              // document, so it counts as skipped and the doc pages still map
              Volt.App._pagePlan = [{ kind: "doc", oldPage: 1 }, { kind: "blank", w: 612, h: 792 }, { kind: "doc", oldPage: 3 }];
              Volt.App._pageSel = new Set([0, 1, 2]);
              const selB = Volt.App._pagesSelectedForExport();
              office.selDirtyPages = selB ? selB.pages : null;
              office.selDirtySkipped = selB ? selB.skipped : -1;
              // clean up — later stages (realKeys) must start from a fresh
              // manager state
              Volt.App._pageSel = null; Volt.App._pagePlan = null; Volt.App._pagePlanDoc = null;
            } catch (e) { office.error = String((e && e.message) || e); }
            office.selPagesListOk = !!office.selPages && office.selPages.length === 2 &&
              office.selPages[0] === 1 && office.selPages[1] === 3 && office.selSkipped === 0;
            office.selDirtyOk = !!office.selDirtyPages && office.selDirtyPages.length === 2 &&
              office.selDirtyPages[0] === 1 && office.selDirtyPages[1] === 3 && office.selDirtySkipped === 1;
            // the subset deck must actually cover the 2 selected pages: at
            // least title + 2 prose slides (prose pages chunk, so it can be
            // more — python asserts the exact count on the written file)
            office.selAllOk = office.selPagesListOk === true && office.selCollected === true &&
              office.selPptxBytes > 1500 && office.selExpectedSlides >= 3 &&
              office.selWritten === true && office.selWholeIsNull === true && office.selDirtyOk === true;
            office.allOk = office.modalItems === true && office.collected === true &&
              office.tableCount === 3 && office.hasTextTable === true &&
              office.hasGridTable === true && office.hasMergedTable === true &&
              office.imageCount >= 1 && office.titleFound === true &&
              office.paraExcludesTable === true && office.mergedNotProse === true &&
              office.docxSize > 3000 && office.xlsxSize > 1500 &&
              office.pptxSize > 3000 && office.expectedSlides === 6 &&
              office.tsvShape === true && office.written === true &&
              office.selAllOk === true && office.openWithOk === true && !office.error;
            ocr.allOk = ocr.engine === true && ocr.docBuilt === true && ocr.opened === true &&
              ocr.buttonShown === true && ocr.recognized === true && ocr.textLayer === true &&
              ocr.textLayerSurvives === true && ocr.searchFound === true &&
              ocr.aiReads === true && ocr.cached === true && ocr.langPicker === true &&
              ocr.popOpens === true && ocr.popSearch === true && ocr.popEsc === true &&
              ocr.langDownload === true && ocr.langSet === true &&
              ocr.langRecognized === true && ocr.langPersists === true &&
              ocr.reRecognized === true && ocr.layerOn === true && ocr.layerToggle === true &&
              ocr.transcripts === true && ocr.exportItemsShown === true &&
              ocr.exportItemsHiddenNoData === true &&
              ocr.hlToast === true && ocr.hlCreated === true &&
              ocr.hlLineSized === true && ocr.hlAligned === true && ocr.hlReverted === true &&
              ocr.preferDetect === true && ocr.preferControl === true && ocr.preferHadEmbedded === true &&
              ocr.preferLayerOn === true && ocr.preferHlAligned === true &&
              ocr.preferReverted === true && ocr.preferNoFalse === true && !ocr.preferError &&
              ocr.fpShape === true && ocr.fpStable === true &&
              ocr.fpRenamedMatches === true && ocr.fpDoctoredRejected === true &&
              ocr.restored === true && !ocr.error;
            return {
              ok: hiddenOk && visibleOk && vendorBootErrors.allOk && modal.allOk && modalCycle.allOk && helpC.allOk && setup.allOk && watch.allOk && fpStage.allOk && rs.allOk && rurl.allOk && tlMove.allOk && lineSel.allOk && notesDel.allOk && voice.allOk && boot.allOk && dup.allOk && nudge.allOk && rotArea.allOk && sizeBadge.allOk && rectTool.allOk && pageMgr.allOk && swCache.allOk && htmlCache.allOk && verBanner.allOk && ocr.allOk && office.allOk,
              voice,
              bootstrap: boot,
              ocr,
              hiddenProbe,
              visibleProbe,
              vendorBootErrors,
              modalCycle,
              helpCenter: helpC,
              setupWizard: setup,
              fingerprint: fpStage,
              restoreSummary: rs,
              restoreUrl: rurl,
              textHighlightMove: tlMove,
              lineSel,
              duplicate: dup,
              nudge,
              rotateArea: rotArea,
              sizeBadge,
              rectTool,
              pageMgr,
              serviceWorkerCache: swCache,
              indexHtmlCache: htmlCache,
              versionBanner: verBanner,
              renderedPages: wraps,
              textSpans,
              doc: document.getElementById("sb-file").textContent,
              zoom: document.getElementById("sb-zoom").textContent,
              annLoaded: typeof Volt.Ann.toJSON === "function",
              aiLoaded: typeof Volt.AI.send === "function",
              desktop,
              modal,
              watch,
              office,
              stages: out,
            };
          }
          await new Promise((r) => setTimeout(r, 400));
        }
        const wraps = document.querySelectorAll(".page-wrap").length;
        const textSpans = document.querySelectorAll(".page-text-layer span").length;
        const textLayer = document.querySelector(".page-text-layer");
        const toast = document.querySelector(".toast");
        return {
          ok: false,
          error: "no render in 20s",
          expected: EXPECT_DOC,
          doc: document.getElementById("sb-file").textContent,
          desktop,
          wraps,
          textSpans,
          textLayerHtmlLen: textLayer ? textLayer.innerHTML.length : -1,
          toast: toast ? toast.textContent : null,
          renderedKeys: [...window.Volt.App.rendered.keys()],
          stages: out,
        };
      })()`);
      // the renderer is done with the watch temp file — stop the touch poller
      // and reclaim the temp dir now
      if (watchReadyPoller) { clearInterval(watchReadyPoller); watchReadyPoller = null; }
      if (watchTmp) { try { rmSync(watchTmp.dir, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
      if (!result.ok) return report(false, result);
      // office-export ground truth: the renderer wrote the .docx/.xlsx/.pptx
      // (plus the Pages-selection subset deck) to disk — validate them with
      // the real zipfile module (integrity + CRC, OOXML/PresentationML parts,
      // the content the collector detected, and both decks' slide counts).
      // Browser/PWA smoke has no preload bridge, so nothing was written and
      // the python stage is skipped there (the renderer-side detection
      // assertions already ran in both modes).
      const officeDesktopSkipped = !!(result.office && result.office.desktopSkipped);
      let officeValidate = { ok: true, pptxSlides: null, subsetSlides: null, skipped: officeDesktopSkipped };
      if (!officeDesktopSkipped) {
        officeValidate = await validateOfficeStage(officeTmp1, officeTmp2, officeTmp3, officeTmp4, result.office && result.office.selExpectedSlides);
      }
      // the decks must contain exactly the slides the renderer computed: the
      // full deck (title + prose + table slides + image for the test doc: 6)
      // and the subset deck from the selection (title + 2 pages' prose)
      const officeSlidesOk = officeDesktopSkipped || (
        officeValidate.pptxSlides === (result.office && result.office.expectedSlides) &&
        officeValidate.subsetSlides === (result.office && result.office.selExpectedSlides));
      if (!officeSlidesOk) {
        return report(false, { ...result, error: "pptx slide count mismatch: python found " + officeValidate.pptxSlides + "/" + officeValidate.subsetSlides + ", renderer expected " + (result.office && result.office.expectedSlides) + "/" + (result.office && result.office.selExpectedSlides) });
      }
      // pin the smoke's context invariant: Electron modes must have the preload
      // bridge, browser mode must NOT — a future change that flips either
      // (e.g. re-adding the preload to --smoke-browser) fails loudly instead of
      // silently changing what the run actually validated
      const bridgeOk = SMOKE_BROWSER
        ? !!(result.desktop && result.desktop.bridge === false)
        : !!(result.desktop && result.desktop.bridge === true);
      if (!bridgeOk) {
        return report(false, { ...result, error: "bridge mismatch for this smoke mode (browser mode must have NO preload; Electron modes must have it)" });
      }
      // wiring guard: the background updater's "updated" IPC must reach the
      // renderer and produce its toast (main → preload → app.js → Volt.App.toast).
      // Electron-only — browser mode has no preload to receive the IPC, so the
      // guard (and its toast) are skipped there.
      if (!SMOKE_BROWSER) {
        w.webContents.send("volt:vendor-updated", { pdfjs: "9.9.9" });
        await new Promise((r) => setTimeout(r, 400));
        const updateToastOk = await w.webContents.executeJavaScript(
          `[...document.querySelectorAll(".toast")].some((t) => t.textContent.includes("updated pdf.js to 9.9.9"))`);
        if (!updateToastOk) return report(false, { ...result, updateToast: false });
        // app auto-update wiring: the updater's "update-downloaded" IPC must
        // surface the version banner, marked desktop-pending (so the SW check
        // can't hide it) and carrying the downloaded version. Then stop the
        // live countdown and restore state so the rest of the run stays
        // deterministic — a 15s auto-restart must never fire mid-smoke.
        w.webContents.send("volt:update-downloaded", { version: "9.9.9" });
        // poll for the banner instead of a fixed sleep — IPC + render latency
        // jitters under load and fixed waits were tipping over (same class as
        // the bootstrap-tier flake). The assertions are unchanged.
        let dlSeen = false;
        for (let i = 0; i < 40 && !dlSeen; i++) {
          await new Promise((r) => setTimeout(r, 100));
          dlSeen = await w.webContents.executeJavaScript(
            `document.getElementById("ver-banner").hidden === false`);
        }
        if (!dlSeen) return report(false, { ...result, updateBanner: { shown: false, pollTimeout: true } });
        const updateBanner = await w.webContents.executeJavaScript(`(() => {
          const V = window.Volt.App;
          const vb = document.getElementById("ver-banner");
          const shown = !!vb && vb.hidden === false;
          const pending = V._verDesktopPending === true;
          const servedVer = V._verServedVersion === "9.9.9";
          // also assert the packaged-mode suppression decided CORRECTLY for
          // this run: packaged runs must skip the SW check (updater owns it),
          // unpackaged runs must keep it (dev flow) — a flip either way fails
          const suppress = V._packaged === true;
          const desktopSuppressOk = typeof V._packaged === "boolean";
          V._stopVerCountdown();
          V._hideVersionBanner();
          V._verDesktopPending = false;
          delete V._verServed;
          return { shown, pending, servedVer, suppress, desktopSuppressOk };
        })()`);
        if (!(updateBanner.shown && updateBanner.pending && updateBanner.servedVer &&
              updateBanner.desktopSuppressOk && updateBanner.suppress === app.isPackaged)) {
          return report(false, { ...result, updateBanner });
        }
        // suppressed-downloads path: volt:update-available must show the
        // banner in 'available' mode (Download visible, Restart hidden, NO
        // countdown — nothing downloaded yet), and a Download click must
        // round-trip through the bridge. The smoke's updater is disabled, so
        // the IPC answers { ok:false, error:'updater disabled' } — the button
        // re-arms and the failure is toasted, which is exactly the wiring we
        // assert (a real run downloads instead).
        w.webContents.send("volt:update-available", { version: "9.9.9" });
        // poll for the banner (and later the click round-trip) — same
        // load-jitter hardening as the downloaded-banner stage above.
        let availSeen = false;
        for (let i = 0; i < 40 && !availSeen; i++) {
          await new Promise((r) => setTimeout(r, 100));
          availSeen = await w.webContents.executeJavaScript(
            `document.getElementById("ver-banner").hidden === false`);
        }
        if (!availSeen) return report(false, { ...result, updateAvail: { shown: false, pollTimeout: true } });
        const updateAvail = await w.webContents.executeJavaScript(`(async () => {
          const V = window.Volt.App;
          const vb = document.getElementById("ver-banner");
          const dlBtn = document.getElementById("ver-download");
          const shown = !!vb && vb.hidden === false;
          const dlVisible = !!dlBtn && dlBtn.hidden === false && getComputedStyle(dlBtn).display !== "none";
          const restartHidden = document.getElementById("ver-restart").hidden === true;
          const noCountdown = !V._verTimer;
          const text = document.getElementById("ver-banner-text").textContent;
          const hasVersion = text.includes("9.9.9") && text.includes("available");
          if (dlBtn) dlBtn.click();
          for (let i = 0; i < 40; i++) {
            await new Promise((r) => setTimeout(r, 100));
            if (dlBtn && dlBtn.disabled === false && dlBtn.hidden === false) break;
          }
          const dlReEnabled = !!dlBtn && dlBtn.disabled === false && dlBtn.hidden === false;
          const errToast = [...document.querySelectorAll(".toast")].some((t) =>
            t.textContent.includes("Update download failed"));
          V._stopVerCountdown();
          V._hideVersionBanner();
          V._verDesktopPending = false;
          delete V._verServed;
          return { shown, dlVisible, restartHidden, noCountdown, hasVersion, dlReEnabled, errToast };
        })()`);
        if (!(updateAvail.shown && updateAvail.dlVisible && updateAvail.restartHidden &&
              updateAvail.noCountdown && updateAvail.hasVersion && updateAvail.dlReEnabled &&
              updateAvail.errToast)) {
          return report(false, { ...result, updateAvail });
        }
      }
      // responsive-toolbar stage: resize the window across the CSS breakpoints
      // and assert the right-end controls stay on-screen (pure layout check —
      // runs in --smoke-no-focus too, no focus/flash involved)
      const toolbarResize = await toolbarResizeStage(w);
      // launcher-integrity gate: .cmd launchers must pass static parse-hazard
      // checks + real sandboxed cmd.exe runs (the start-volt-app.cmd crash
      // class). Pure child-process work, runs in --smoke-no-focus too.
      const launcherGate = await launcherGateStage();
      // --smoke-no-focus (the background auto-update gate) skips the
      // real-keyboard stage: it shows + focuses the window, which would flash
      // and steal focus during a background update. The render probe above
      // still covers the full render chain + hidden contract + modal trap.
      if (!SMOKE_FOCUS_STAGE) return report(result.ok && officeValidate.ok && officeSlidesOk && toolbarResize.ok && launcherGate.ok, { ...result, officeValidate, officeSlidesOk, toolbarResize, launcherGate, updateToast: SMOKE_BROWSER ? "skipped-browser" : true });
      // real-keyboard stage: drive Tab/Shift+Tab/Escape through Chromium's
      // native input pipeline (sendInputEvent) instead of synthetic dispatch,
      // so mid-modal focus navigation is verified with real key events
      const realKeys = await realKeyStage(w);
      // gate the overall result on ALL stages: a renderer-probe failure must
      // not be masked by a passing keyboard stage (or vice versa)
      report(result.ok && officeValidate.ok && officeSlidesOk && toolbarResize.ok && launcherGate.ok && realKeys.ok, { ...result, officeValidate, officeSlidesOk, toolbarResize, launcherGate, realKeys, updateToast: SMOKE_BROWSER ? "skipped-browser" : true });
    } catch (e) {
      if (watchReadyPoller) { clearInterval(watchReadyPoller); watchReadyPoller = null; }
      if (watchTmp) { try { rmSync(watchTmp.dir, { recursive: true, force: true }); } catch (err) { /* ignore */ } }
      report(false, { error: String((e && e.message) || e) });
    }
  };

  w.webContents.once("did-finish-load", () => setTimeout(probe, 800));
}

/** Release-feed round-trip self-test (--smoke-feed, packaged build only).
    The REAL electron-updater chain runs against a scratch feed served at
    VOLT_UPDATE_URL (generic provider): startup check → update found →
    background download → volt:update-downloaded → the version banner. This
    is the CI release-feed gate's in-app half — the harness
    (scripts/test-release-feed.mjs) builds the app, publishes the feed
    (latest.yml + installer), launches it with --smoke-feed, and asserts the
    SMOKE_RESULT. Nothing is stubbed: updaterEnabled and pendingUpdateVersion
    come from the live autoUpdater in this process. */
function runSmokeFeedTest(w) {
  const expected = process.env.VOLT_FEED_EXPECT_VERSION || "";
  const deadline = Date.now() + 75 * 1000; // check (2.5s) + download + banner

  // watchdog: never hang a CI run — hard-exit if nothing reports
  setTimeout(() => {
    console.log("SMOKE_RESULT " + JSON.stringify({ ok: false, error: "feed watchdog timeout" }));
    cleanupSmokeProfile();
    if (process.platform === "win32") {
      try { require("node:child_process").execSync("taskkill /F /T /PID " + process.pid); } catch (e) { /* already gone */ }
    }
    app.exit(2);
  }, 90000).unref();

  const report = (ok, extra) => {
    console.log("SMOKE_RESULT " + JSON.stringify({ ...extra, ok }));
    cleanupSmokeProfile();
    setTimeout(() => app.exit(ok ? 0 : 1), 300);
  };

  w.webContents.on("console-message", (e) => {
    if (e.level >= 1) console.log("[renderer] " + e.message);
  });
  w.webContents.on("did-fail-load", (_e, code, desc) => {
    console.log("[did-fail-load] " + code + " " + desc);
  });

  const poll = async () => {
    try {
      const state = await w.webContents.executeJavaScript(`(() => {
        const V = window.Volt && window.Volt.App;
        const vb = document.getElementById("ver-banner");
        const restart = document.getElementById("ver-restart");
        const dlBtn = document.getElementById("ver-download");
        return {
          bannerHidden: vb ? vb.hidden : "no-element",
          pending: !!(V && V._verDesktopPending),
          served: V ? V._verServedVersion : null,
          restartVisible: !!restart && restart.hidden === false,
          downloadHidden: !dlBtn || dlBtn.hidden === true,
          countdown: !!(V && V._verTimer),
        };
      })()`);
      const bannerUp = state.bannerHidden === false && state.pending && state.served === expected;
      if (bannerUp) {
        // downloaded mode: Restart visible, Download gone, countdown running.
        // Stop the 15s auto-restart BEFORE it fires quitAndInstall — the feed
        // points at a real installer and we don't want this run installing it.
        const ok = state.restartVisible && state.downloadHidden && state.countdown &&
          updaterEnabled && pendingUpdateVersion === expected;
        await w.webContents.executeJavaScript(`(() => {
          const V = window.Volt.App;
          V._stopVerCountdown();
          V._hideVersionBanner();
          V._verDesktopPending = false;
          delete V._verServed;
          return true;
        })()`);
        return report(ok, { feed: { updaterEnabled, pendingVersion: pendingUpdateVersion,
          expected, bannerShown: true, restartVisible: state.restartVisible,
          downloadHidden: state.downloadHidden, countdown: state.countdown } });
      }
      if (Date.now() > deadline) {
        return report(false, { feed: { updaterEnabled, pendingVersion: pendingUpdateVersion,
          expected, ...state, timedOut: true } });
      }
      setTimeout(poll, 300);
    } catch (e) {
      report(false, { error: "feed probe error: " + String((e && e.message) || e) });
    }
  };
  w.webContents.once("did-finish-load", () => setTimeout(poll, 1500));
}

/* ── file-change watch (renderer-driven) ─────────────────────────────
   The renderer tells us which PDF is open (volt:watch-file) and we poll
   it on disk; when the author re-exports or replaces it, the renderer is
   offered a reload. One watcher at a time — the open document. */
function stopFileWatch() {
  if (fileWatcher) {
    try { fileWatcher.stop(); } catch (e) { /* ignore */ }
    fileWatcher = null;
  }
}

/* ── OS file handoff ────────────────────────────────────────────────
   Double-clicking a .pdf (or dragging one onto the app) delivers a
   path to the main process. We keep a single instance: a second launch
   forwards its file to the running window instead of starting a second
   app. The renderer pulls the bytes itself via the IPC read bridge —
   the sandboxed renderer has no direct disk access. */
let pendingFiles = [];
let rendererReady = false;

/** Pick a real .pdf path out of an argv.
    Dev: [electron.exe, appDir, file.pdf] — the app dir fails the .pdf check.
    Packaged: [Volt.exe, file.pdf] — scan everything after the executable. */
function findPdfArgv(argv) {
  for (const arg of (argv || []).slice(1)) {
    if (!arg || arg.startsWith("-")) continue;      // flags (--smoke, …)
    if (!/\.pdf$/i.test(arg)) continue;
    try { if (!statSync(arg).isFile()) continue; } catch (e) { continue; }
    return arg;
  }
  return null;
}

function queueFile(path) {
  if (!path) return;
  pendingFiles.push(path);
  flushPendingFiles();
}

function flushPendingFiles() {
  // rendererReady is the authoritative signal: the renderer calls ready()
  // only AFTER registering its onOpenPath listener, so nothing more to wait
  // for (isLoading() would be wrong — it's still true while subresources load)
  if (!win || win.isDestroyed() || !rendererReady) return;
  const files = pendingFiles;
  pendingFiles = [];
  for (const p of files) win.webContents.send("volt:open-path", p);
}

/* ── bundle-version tracking (the single-instance stale trap) ──────
   Volt holds a single-instance lock: clicking the desktop shortcut while
   the app is already running only FOCUSES the old window (second-instance),
   so an update to the on-disk files never reaches the running process — the
   classic "I restarted but still see the old behavior". The main process
   remembers the bundle hash (the service worker's CACHE name, which the
   generator bumps whenever app files change) it launched the window with;
   when a second launch arrives and the on-disk hash differs, a relaunch is
   the user's real intent (they started Volt to get the current version) —
   the fresh process picks up the new files AND the queued PDF. When the
   hashes match, focus the running window as before. */
let launchedBundleHash = null;

function readBundleHashSync() {
  try {
    const sw = readFileSync(join(APP_ROOT, "sw.js"), "utf8");
    const m = /const\s+CACHE\s*=\s*"([^"]+)"/.exec(sw);
    return m && m[1].startsWith("volt-") ? m[1] : null;
  } catch (e) { return null; }
}

const gotLock = SMOKE || app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    const queuedPdf = findPdfArgv(argv);
    queueFile(queuedPdf);
    // a NEWER bundle is on disk than the one this window launched with — the
    // running process is stale, and the user starting Volt wants the current
    // version: relaunch (the fresh process re-reads the lock, serves the new
    // files, and opens the queued PDF). app.relaunch() re-runs the ORIGINAL
    // command line, so carry the double-clicked file over explicitly — the
    // new process would otherwise miss it. Otherwise surface the running
    // window as before.
    const diskHash = readBundleHashSync();
    if (launchedBundleHash && diskHash && diskHash !== launchedBundleHash) {
      const relaunchArgs = process.argv.slice(1);
      if (queuedPdf && !relaunchArgs.includes(queuedPdf)) relaunchArgs.push(queuedPdf);
      app.relaunch({ args: relaunchArgs });
      app.exit(0);
      return;
    }
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });
  app.on("open-file", (_event, path) => queueFile(path)); // macOS style

  app.whenReady().then(async () => {
    try {
      ipcMain.handle("volt:read-file", async (_event, path) => {
        // defense in depth: the bridge only ever opens PDFs — reject anything
        // else so a renderer XSS couldn't use it to read arbitrary local files
        if (typeof path !== "string" || !/\.pdf$/i.test(path)) throw new Error("not a pdf");
        const data = await readFile(path);
        return { name: basename(path), size: data.byteLength, data: new Uint8Array(data).buffer };
      });
      // volt:pick-pdf — the home screen's "Open a PDF" uses the NATIVE open
      // dialog in the desktop app, so the chosen file comes back as a real
      // path (feeding Recent documents and the disk watcher) instead of a
      // path-less File from the HTML picker. Returns null when cancelled.
      ipcMain.handle("volt:pick-pdf", async () => {
        if (!win || win.isDestroyed()) return null;
        const r = await dialog.showOpenDialog(win, {
          title: "Open a PDF",
          filters: [{ name: "PDF documents", extensions: ["pdf"] }],
          properties: ["openFile"],
        });
        return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
      });
      // volt:setup-tasks — the Setup wizard's desktop step: create the
      // desktop shortcut + register .pdf → Volt. Packaged installs already
      // handled both, so that path just reports skipped; dev/portable runs
      // invoke the same PowerShell script the launcher uses. Never prompts
      // (the wizard checkbox is the consent) and never blocks the UI.
      ipcMain.handle("volt:setup-tasks", async () => {
        if (app.isPackaged) return { ok: true, skipped: "installer" };
        const script = join(APP_ROOT, "..", "scripts", "create-volt-shortcut.ps1");
        if (!existsSync(script)) return { ok: false, error: "setup script not bundled" };
        const { spawn } = require("node:child_process");
        return new Promise((resolve) => {
          const child = spawn("powershell.exe",
            ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script],
            { windowsHide: true });
          let out = "", err = "";
          child.stdout.on("data", (d) => { out += String(d); });
          child.stderr.on("data", (d) => { err += String(d); });
          child.on("error", (e) => resolve({ ok: false, error: String((e && e.message) || e) }));
          child.on("close", (code) => {
            resolve(code === 0 ? { ok: true, output: out.trim() } : { ok: false, error: (err || out).trim() || "script failed (" + code + ")" });
          });
        });
      });
      // volt:write-file — the renderer persists a rebuilt document back to
      // the path it came from (sidebar reorder with currentPath set). Same
      // .pdf-only guard so a renderer XSS couldn't overwrite arbitrary files.
      // Accepts Uint8Array OR ArrayBuffer (the read bridge hands the renderer
      // an ArrayBuffer, and the undo snapshot keeps it as-is).
      ipcMain.handle("volt:write-file", async (_event, path, buffer) => {
        // PDF rebuilds plus the office-export formats (docx/xlsx/pptx) — the
        // renderer-generated files a user may want persisted to disk
        if (typeof path !== "string" || !/\.(pdf|docx|xlsx|pptx)$/i.test(path)) throw new Error("not a persistable file");
        const bytes = buffer instanceof Uint8Array ? buffer
          : (buffer instanceof ArrayBuffer ? new Uint8Array(buffer)
            : (buffer && buffer.buffer instanceof ArrayBuffer ? new Uint8Array(buffer.buffer) : null));
        if (!bytes || !bytes.length) throw new Error("no bytes");
        await writeFile(path, bytes);
        return { ok: true, size: bytes.length };
      });
      // volt:open-with — the renderer hands a freshly exported office file
      // (docx/xlsx/pptx) to the OS DEFAULT handler (Word/Excel/PowerPoint):
      // the bytes are written to a temp file and shell.openPath opens it,
      // exactly like double-clicking the file in Explorer. The name is
      // basename()-sanitized and extension-restricted so a renderer bug can't
      // make the app open arbitrary paths; under --smoke the OS open is
      // skipped (launching Word/Excel on the test machine would be rude) and
      // only the write + path are verified.
      ipcMain.handle("volt:open-with", async (_event, name, buffer) => {
        if (typeof name !== "string" || !/\.(docx|xlsx|pptx)$/i.test(name)) throw new Error("not an office file");
        const bytes = buffer instanceof Uint8Array ? buffer
          : (buffer instanceof ArrayBuffer ? new Uint8Array(buffer)
            : (buffer && buffer.buffer instanceof ArrayBuffer ? new Uint8Array(buffer.buffer) : null));
        if (!bytes || !bytes.length) throw new Error("no bytes");
        const file = join(app.getPath("temp"), "Volt-" + basename(name).replace(/[^\w.()-]/g, "_"));
        await writeFile(file, bytes);
        if (SMOKE) return { ok: true, path: file, smoke: true }; // no OS launch in tests
        const err = await shell.openPath(file);
        if (err) throw new Error("open failed: " + err);
        return { ok: true, path: file };
      });
      ipcMain.handle("volt:watch-file", (_event, path) => {
        if (typeof path !== "string" || !/\.pdf$/i.test(path)) return { ok: false, error: "not a pdf" };
        stopFileWatch(); // one watcher at a time — the open document
        try {
          const w = new FileWatcher(path, (data) => {
            if (win && !win.isDestroyed()) win.webContents.send("volt:file-changed", { path, missing: !!data.missing });
          });
          w.start();
          fileWatcher = w;
          return { ok: true };
        } catch (e) {
          return { ok: false, error: String((e && e.message) || e) };
        }
      });
      ipcMain.handle("volt:unwatch-file", () => {
        stopFileWatch();
        return { ok: true };
      });
      // volt:install-ollama — the first-run local-LLM bootstrap's one-click
      // install: download the official per-user Ollama installer (progress
      // streams back as volt:ollama-install events) and run it silently
      // (NSIS /S). Never auto-triggered — only from the bootstrap card's
      // explicit click. The smoke NEVER exercises this (a smoke run can't
      // install software); the renderer-side flow is covered by the boot
      // stage's stubbed fetch instead. `origins` (Volt's own origins, from
      // the renderer) is pinned into the user env BEFORE the installer
      // starts the service — a freshly installed Ollama never serves
      // OLLAMA_ORIGINS=*.
      ipcMain.handle("volt:install-ollama", async (_event, origins) => {
        const send = (data) => {
          if (win && !win.isDestroyed()) win.webContents.send("volt:ollama-install", data);
        };
        const dest = join(app.getPath("userData"), "OllamaSetup.exe");
        try {
          send({ phase: "download", pct: 0 });
          await downloadFile(OLLAMA_SETUP_URL, dest, (pct) => send({ phase: "download", pct }));
          send({ phase: "install", pct: 100 });
          // enforce-on-spawn: pin the CORS posture for the install that's
          // about to start its service (best-effort — non-fatal on failure)
          if (typeof origins === "string" && origins.length && origins.length <= 500) {
            try { await setUserEnv("OLLAMA_ORIGINS", origins); } catch (e) { /* non-fatal */ }
          }
          await new Promise((resolve, reject) => {
            const child = spawn(dest, ["/S"], { windowsHide: true, stdio: "ignore" });
            child.once("error", reject);
            child.once("close", (code) => (code === 0 ? resolve() : reject(new Error("installer exited " + code))));
          });
          send({ phase: "done" });
          return { ok: true };
        } catch (e) {
          send({ phase: "error", error: String((e && e.message) || e) });
          return { ok: false, error: String((e && e.message) || e) };
        }
      });
      // volt:set-ollama-origins — the CORS drive-by guard's "Restrict origins":
      // pin the per-user OLLAMA_ORIGINS to Volt's own origins (the app's real
      // origin + localhost:8421 — file:// would panic Ollama's env parser).
      // The running Ollama keeps the old value until restarted — the
      // renderer's warning says so. Only reachable
      // through the warning's explicit button; the smoke stubs the bridge so
      // it never writes the real user env.
      ipcMain.handle("volt:set-ollama-origins", async (_event, value) => {
        if (typeof value !== "string" || !value || value.length > 500) return { ok: false, error: "bad value" };
        try {
          await setUserEnv("OLLAMA_ORIGINS", value);
          return { ok: true };
        } catch (e) {
          return { ok: false, error: String((e && e.message) || e) };
        }
      });
      // volt:check-ollama-cors — the CORS drive-by guard's probe. Main process
      // because browser CORS hides Access-Control-Allow-Origin from page JS;
      // here the raw header is read with a spoofed evil Origin, so the renderer
      // can warn exactly when it comes back "*" (OLLAMA_ORIGINS=*). Read-only
      // against the loopback Ollama — never writes anything.
      ipcMain.handle("volt:check-ollama-cors", async () => probeOllamaCors());
      // volt:spawn-private-ollama / volt:stop-private-ollama — the private
      // Ollama instance (⚙ settings toggle, desktop only). `origins` is Volt's
      // own pin from the renderer; the process answers on its own loopback
      // port with OLLAMA_ORIGINS locked to Volt and a dedicated model store.
      // Idempotent spawn (returns the live instance), killed on app quit.
      // The smoke NEVER exercises these (a smoke can't spawn servers) — the
      // renderer-side flow is covered by the boot stage's stubbed methods.
      ipcMain.handle("volt:spawn-private-ollama", async (_event, origins, preferredPort) => {
        try {
          return await spawnPrivateOllama(
            typeof origins === "string" && origins.length ? origins : null,
            typeof preferredPort === "number" && preferredPort > 0 ? preferredPort : null
          );
        } catch (e) {
          return { ok: false, error: String((e && e.message) || e) };
        }
      });
      ipcMain.handle("volt:stop-private-ollama", async () => stopPrivateOllama());
      // volt:restart — the version-ready banner's Restart button. When an
      // auto-update has been downloaded, restarting INSTALLS it (quitAndInstall
      // — the fresh process boots the new version directly). Otherwise a full
      // relaunch is the only way a running (possibly stale) process reaches
      // the current bundle; a reload would just re-serve the same old code.
      ipcMain.handle("volt:restart", () => {
        if (pendingUpdateVersion) {
          try { autoUpdater.quitAndInstall(); return { ok: true }; }
          catch (e) { /* fall through to a plain relaunch */ }
        }
        app.relaunch();
        app.exit(0);
        return { ok: true };
      });
      // volt:check-for-updates — the Volt ▾ menu's "Check for updates".
      // electron-updater is authoritative in the packaged desktop app (a
      // release bumps the package version, which the SW comparison can't
      // see). Maps the updater's result to a small status object; the
      // renderer toasts accordingly. Returns { status: "disabled" } in
      // dev/unpackaged runs so the renderer falls back to its SW check.
      ipcMain.handle("volt:check-for-updates", async () => {
        if (!updaterEnabled) return { status: "disabled" };
        try {
          const r = await autoUpdater.checkForUpdates();
          if (!r || !r.updateInfo) return { status: "error", error: "no result from updater" };
          const status = String(r.status || "");
          const version = r.updateInfo.version;
          if (status.includes("not-available")) return { status: "not-available" };
          if (status.includes("downloaded")) return { status: "update-downloaded", version };
          if (status.includes("available") || status.includes("downloading")) {
            return { status: pendingUpdateVersion ? "update-downloaded" : "available", version };
          }
          return { status: "error", error: "unexpected updater status: " + status };
        } catch (e) {
          return { status: "error", error: String((e && e.message) || e) };
        }
      });
      // volt:update-prefs — the renderer pushes its update preferences (and
      // its NetworkInformation-based metered read, which main can't see).
      // Applied live: checkOnStartup gates the startup check, allowDownload
      // flips autoUpdater.autoDownload so a metered connection + the 'off'
      // setting means Volt detects but never silently downloads.
      ipcMain.handle("volt:update-prefs", (_event, p) => {
        if (!p || typeof p !== "object") return { ok: false };
        updatePrefs.checkOnStartup = p.checkOnStartup !== false;
        updatePrefs.allowDownload = p.allowDownload !== false;
        if (updaterEnabled) {
          try { autoUpdater.autoDownload = updatePrefs.allowDownload; } catch (e) { /* non-fatal */ }
        }
        return { ok: true };
      });
      // volt:download-update — the 'available' banner's Download button
      // (shown when background downloads are suppressed). Starts the explicit
      // download; the update-downloaded event then drives the normal
      // restart-banner flow. Returns { ok:false, error } on failure so the
      // button can re-arm and the failure is surfaced.
      ipcMain.handle("volt:download-update", async () => {
        if (!updaterEnabled) return { ok: false, error: "updater disabled" };
        try {
          await autoUpdater.downloadUpdate();
          return { ok: true };
        } catch (e) {
          return { ok: false, error: String((e && e.message) || e) };
        }
      });
      // volt:app-info — the renderer needs a few main-process facts the
      // sandboxed preload can't derive (is the app a packaged build? which
      // version is installed?). The SW-based version check is suppressed in
      // packaged builds — those get their updates from electron-updater —
      // so the renderer must KNOW it's packaged before it decides.
      ipcMain.handle("volt:app-info", () => ({
        version: app.getVersion(),
        isPackaged: app.isPackaged,
        updaterEnabled,
      }));
      // volt:quit — the Volt ▾ menu's Exit item (desktop only; the item is
      // hidden in the browser where there is nothing to quit)
      ipcMain.handle("volt:quit", () => {
        app.quit();
        return { ok: true };
      });
      ipcMain.on("volt:renderer-ready", () => {
        rendererReady = true;
        flushPendingFiles();
      });
      // crash recovery: an interrupted vendor update (app quit mid smoke-gate)
      // must not leave the app to boot against half-swapped pdf.js — restore
      // the previous vendor BEFORE the renderer loads any module.
      // CRITICAL: never in a smoke instance. The background updater sets
      // .update-pending + .backup, then spawns the app itself as the smoke
      // gate — if THAT launch ran recovery, it would restore the old files
      // over the freshly-swapped ones, and the gate would validate (and
      // commit against) the previous vendor instead of the new one.
      if (!SMOKE) {
        try {
          if (recoverInterruptedVendorUpdate(APP_ROOT)) console.log("recovered an interrupted vendor update");
        } catch (e) { console.error("vendor recovery failed: " + ((e && e.message) || e)); }
      }
      allowMicPermission(); // voice input (getUserMedia) — local app, no prompt
      // The app has its own File/View/Tools toolbar menus, so Alt+F / Alt+V /
      // Alt+T are app shortcuts — but the default Electron menu bar (hidden by
      // autoHideMenuBar) reveals on Alt and would swallow those keystrokes.
      // Remove the native bar entirely on Windows/Linux so the accelerators
      // reach the renderer; macOS keeps its conventional global menu. (The
      // dev conveniences the default menu offered — Ctrl+Shift+I devtools,
      // Ctrl+R reload — are re-added per-window in createWindow.)
      if (process.platform !== "darwin") Menu.setApplicationMenu(null);
      const port = await startServer();
      await createWindow(port);
      // a .pdf was passed at launch — never in browser mode: without the
      // preload there is no volt:renderer-ready IPC to flush the queue
      if (!SMOKE_BROWSER) queueFile(findPdfArgv(process.argv));
      scheduleVendorAutoUpdate(win); // background vendor check (once/day)
      initAppAutoUpdater(); // app self-update (packaged builds only)
    } catch (e) {
      console.error("Volt failed to start: " + ((e && e.stack) || e));
      app.exit(1);
    }
  });

  app.on("window-all-closed", () => app.quit());
  app.on("will-quit", () => {
    if (vendorUpdater) { try { vendorUpdater.kill(); } catch (e) { /* gone */ } }
    vendorUpdater = null;
    stopFileWatch(); // the poller must never outlive the app
    if (privateOllamaChild) { // the private instance must never outlive the app
      try { privateOllamaChild.kill(); } catch (e) { /* already gone */ }
      privateOllamaChild = null;
      privateOllamaPort = 0;
    }
  });
}
