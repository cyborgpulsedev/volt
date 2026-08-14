// scripts/check-launchers.cjs
// ═══════════════════════════════════════════════════════════════════════════
//  Volt - .cmd launcher integrity gate
//
//  Catches the bug class that once killed start-volt-app.cmd: cmd.exe's
//  block parser is fragile, and a launcher that parses badly fails silently
//  (a console window that flashes and vanishes, or commands running as
//  garbage). Two layers:
//
//    1. STATIC rules (cross-platform, milliseconds):
//       - ASCII only        (UTF-8 multibyte text breaks the parser)
//       - CRLF line endings (LF-only files are a latent hazard)
//       - no ( ) inside an echo line that sits inside a parenthesized block
//         ("echo First run: downloading (Electron)..." was the exact crash)
//       - no text after a block-closing ')' unless it is a continuation
//         (& | > < else rem, or a quoted argument) — verified against real
//         cmd.exe: "echo was unexpected at this time."
//       - balanced blocks (a stray ')' with no open block is tolerated —
//         verified), every call/goto :label defined
//
//    2. REAL cmd.exe PARSE RUN (Windows only): the Volt launchers are
//       actually executed through cmd.exe in a throwaway sandbox — a temp
//       tree mirroring the repo layout, with node/npm/npx/powershell stubbed
//       on PATH so nothing real runs — and the exit code + output must show
//       no parse errors. This catches ANY parse hazard, not just the known
//       ones.
//
//  Usage:  node scripts/check-launchers.cjs
//  Exports: LAUNCHERS, staticCheckText, staticCheckLauncher, checkAllStatic,
//           realRunLaunchers  (used by test-utils.mjs and the Electron smoke)
// ═══════════════════════════════════════════════════════════════════════════
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const REPO_ROOT = path.resolve(__dirname, "..");

// every .cmd launcher the gate covers, relative to REPO_ROOT
const LAUNCHER_FILES = [
  "start-volt-app.cmd",
  "start-volt.cmd",
  path.join("pdf-viewer", "scripts", "vendor-weekly.cmd"),
];
const LAUNCHERS = LAUNCHER_FILES.map((rel) => path.join(REPO_ROOT, rel));

// the VBScript launcher the desktop shortcut targets (wscript.exe + this
// file): it starts start-volt-app.cmd with a HIDDEN console so the app
// behaves like a normal program. VBScript has its own parser, so the .cmd
// static rules don't apply — instead we verify the handful of properties
// that make it work (pure ASCII, Option Explicit, window style 0, and that
// it references the actual .cmd launcher).
const VBS_LAUNCHER = path.join(REPO_ROOT, "scripts", "start-volt-app-hidden.vbs");
const VBS_TARGET_REF = "start-volt-app.cmd";

// the subset that can be sandboxed and actually executed through cmd.exe
const REAL_RUN_FILES = [
  "start-volt-app.cmd",
  "start-volt.cmd",                                  // extra arg: a dead port
  path.join("pdf-viewer", "scripts", "vendor-weekly.cmd"),
];

/* ── static rules ─────────────────────────────────────────────────────── */

/** Scan one launcher's text; return an array of human-readable errors
    (empty = clean). text is a byte-preserving string ("latin1"). */
function staticCheckText(text) {
  const errors = [];

  // ASCII only — cmd.exe reads batch files with the OEM codepage; UTF-8
  // multibyte characters garble output and can derail block parsing
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 0x7f) {
      errors.push(`non-ASCII byte 0x${text.charCodeAt(i).toString(16)} at offset ${i} — .cmd files must be pure ASCII (UTF-8 text breaks cmd.exe's parser)`);
      break;
    }
  }

  // CRLF only — LF-only batch files are a latent parser hazard
  let lfOnly = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n" && (i === 0 || text[i - 1] !== "\r")) lfOnly++;
  }
  if (lfOnly) errors.push(`${lfOnly} LF-only line ending(s) — .cmd files must use CRLF (cmd.exe's block parser is line-ending sensitive)`);

  errors.push(...scanBatch(text));
  return errors;
}

/** Scan the file's paren/block structure and label references. */
function scanBatch(text) {
  const errors = [];
  const raw = text.split("\n").map((l) => l.replace(/\r$/, ""));

  // join caret line continuations (odd trailing ^ = continuation)
  const lines = [];
  for (let i = 0; i < raw.length; i++) {
    let l = raw[i];
    while (i + 1 < raw.length) {
      const m = l.match(/\^+$/);
      if (m && m[0].length % 2 === 1) l = l.slice(0, -m[0].length) + raw[++i];
      else break;
    }
    lines.push(l);
  }

  const depth = { v: 0 };
  const labels = new Set();
  const refs = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    // rem / :: lines are inert: cmd's parser consumes them, parens included
    if (trimmed === "" || /^rem(?:\s|$)/i.test(trimmed) || trimmed.startsWith("::")) continue;
    const lm = trimmed.match(/^:([A-Za-z0-9_]+)/);
    if (lm) { labels.add(lm[1].toUpperCase()); continue; }
    const rm = trimmed.match(/\b(?:call|goto)\s+:([A-Za-z0-9_]+)/i);
    if (rm) refs.push(rm[1].toUpperCase());
    scanLine(line, i + 1, depth, errors);
  }

  if (depth.v !== 0) errors.push(`unbalanced parentheses: ${depth.v} unclosed block(s) at end of file`);
  for (const r of refs) {
    if (r !== "EOF" && !labels.has(r)) errors.push(`label :${r} is referenced but never defined`);
  }
  return errors;
}

/** Paren/echo scan for one line. `depth` is shared block state across lines. */
function scanLine(line, lineNo, depth, errors) {
  // for-lines: the (set) between `in` and `do` is inert — only the block
  // opened by the `do (` counts. Start scanning at the LAST `do` token.
  let start = 0;
  if (/^\s*for\b/i.test(line)) {
    let last = -1, m;
    const re = /\bdo\b/gi;
    while ((m = re.exec(line))) last = m.index;
    if (last >= 0) start = last;
  }

  const isWord = (c) => c !== undefined && /[A-Za-z0-9_]/.test(c);
  let inEcho = false, echoDepth = 0, inQuote = false;
  let i = start;
  while (i < line.length) {
    const c = line[i];
    if (c === '"') { inQuote = !inQuote; i++; continue; }
    // mid-line rem: rest of the line is a comment, parens included
    if (!inEcho && (c === "r" || c === "R") && (i === 0 || !isWord(line[i - 1])) && /^rem(?=[\s]|$)/i.test(line.slice(i))) break;
    // echo keyword → the rest of the line is its argument
    if (!inEcho && (c === "e" || c === "E") && (i === 0 || !isWord(line[i - 1])) && /^echo(?=[\s.:/]|$)/i.test(line.slice(i))) {
      inEcho = true;
      echoDepth = depth.v;
      const arg = line.slice(i + 4);
      if (echoDepth >= 1) {
        // parens inside an echo arg while a block is open are parsed by cmd
        // as block delimiters. A lone trailing ')' that closes the block
        // ("echo hi )") is tolerated, but '(' anywhere, or a ')' followed by
        // more content, is the "… was unexpected at this time." crash.
        const t = arg.trimEnd();
        const onlyTrailingClose = t.endsWith(")") && !/\)\S/.test(arg);
        if (arg.includes("(") || (arg.includes(")") && !onlyTrailingClose)) {
          errors.push(`line ${lineNo}: 'echo' inside a block contains ( or ) — cmd.exe's parser treats them as block delimiters ("… was unexpected at this time."). Reword the message without parentheses.`);
        }
      }
      i += 4;
      continue;
    }
    if (c === "(") {
      if (!(inEcho && echoDepth === 0)) depth.v++;
    } else if (c === ")") {
      if (inEcho && echoDepth === 0) {
        // inert: top-level echo argument
      } else if (depth.v >= 1) {
        depth.v--;
        if (depth.v === 0 && !inQuote) {
          // content after a block-close is only a hazard OUTSIDE a quoted
          // argument — cmd passes quoted text through (e.g. a PowerShell
          // one-liner argument). In a block context quotes do NOT protect
          // parens (the echo ")" gotcha), so Rule A above stays quote-blind.
          const rest = line.slice(i + 1).trim();
          if (rest && !/^(?:[&|><]|else(?=[\s(])|rem(?=[\s]|$))/i.test(rest)) {
            errors.push(`line ${lineNo}: text after the block-closing ')' ("${rest.slice(0, 48)}") — cmd.exe parses it as a fresh command and errors ("was unexpected at this time."). Move it to its own line.`);
          }
        }
      }
      // a ')' with NO open block is tolerated by cmd.exe (verified: a lone
      // top-level ')' runs fine) — only ')' that closes a block is meaningful
    }
    i++;
  }
}

function staticCheckLauncher(absPath) {
  let text;
  try {
    text = fs.readFileSync(absPath, "latin1");
  } catch (e) {
    return [`unreadable: ${e.message}`];
  }
  return staticCheckText(text);
}

/** Static-check every launcher; [{ file, errors }] */
function checkAllStatic() {
  return LAUNCHERS.map((f) => ({ file: path.basename(f), errors: staticCheckLauncher(f) }));
}

/* ── real cmd.exe parse runs (Windows only) ───────────────────────────── */

/**
 * Execute the Volt launchers through cmd.exe in a throwaway sandbox: a temp
 * tree mirroring the repo layout, with node/npm/npx/powershell stubbed on
 * PATH (each exits 0 immediately) so nothing real ever runs. Any parse error
 * surfaces as a non-zero exit and/or "… was unexpected at this time."
 * Returns [{ file, ok, reason, output }].
 */
function realRunLaunchers() {
  if (process.platform !== "win32") return [{ file: "(not Windows)", ok: true, reason: "skipped" }];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "volt-launch-check-"));
  const results = [];
  try {
    // stubs: every external command the launchers invoke, shadowing real ones.
    // node/npm/npx are invoked with `call` (or bare), so they must end with
    // `exit /b` — plain `exit` would kill the CALLING shell. powershell is
    // `start`ed by start-volt.cmd, and `start` runs .cmd targets under
    // `cmd /K` (window stays open), which would hang the sandbox forever — a
    // plain `exit` terminates that /K shell so the window closes.
    const stubRet = "@echo off\r\nexit /b 0\r\n";
    const stubExit = "@echo off\r\nexit\r\n";
    for (const name of ["node.cmd", "npm.cmd", "npx.cmd"]) fs.writeFileSync(path.join(tmp, name), stubRet);
    fs.writeFileSync(path.join(tmp, "powershell.cmd"), stubExit);
    // context files the launchers probe (%~dp0pdf-viewer\serve.mjs etc.)
    fs.mkdirSync(path.join(tmp, "pdf-viewer"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "pdf-viewer", "serve.mjs"), "// sandbox stub\r\n");
    fs.mkdirSync(path.join(tmp, "scripts"), { recursive: true });
    for (const p of ["register-volt-file-assoc.ps1", "show-error.ps1"]) {
      fs.writeFileSync(path.join(tmp, "scripts", p), "# stub\r\n");
    }

    const env = { ...process.env, PATH: tmp + path.delimiter + (process.env.PATH || "") };
    for (const rel of REAL_RUN_FILES) {
      const dest = path.join(tmp, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(path.join(REPO_ROOT, rel), dest);
      const extra = rel === "start-volt.cmd" ? " 9871" : ""; // dead port: never hits a real server
      // invoke by ABSOLUTE path: cmd.exe does not reliably resolve a bare
      // filename even with the cwd set, and QUOTING the path makes cmd keep
      // the quotes — unquoted works (temp paths have no spaces here; if a
      // machine's temp root ever does, mkdtemp falls back to copying)
      // stdio goes to a FILE, not pipes: a detached grandchild (e.g. a
      // `start`ed window) inheriting a pipe would keep it open and make
      // spawnSync wait for EOF; with a file, spawnSync returns when the
      // direct cmd.exe exits and stragglers just append harmlessly
      const logPath = path.join(tmp, path.basename(dest) + ".log");
      const logFd = fs.openSync(logPath, "w");
      let r;
      try {
        r = spawnSync("cmd.exe", ["/d", "/c", dest + extra], {
          stdio: ["ignore", logFd, logFd], env, timeout: 15000, windowsHide: true,
        });
      } finally {
        try { fs.closeSync(logFd); } catch (e) { /* ignore */ }
      }
      const out = (() => { try { return fs.readFileSync(logPath, "utf8"); } catch (e) { return ""; } })().trim();
      const timedOut = !!(r.error && r.error.code === "ETIMEDOUT");
      const parseHazard = /was unexpected|is not recognized as an internal/.test(out);
      const ok = r.status === 0 && !parseHazard && !timedOut;
      results.push({
        file: path.basename(dest),
        ok,
        reason: ok ? null
          : timedOut ? "cmd.exe did not exit within 15s (the batch hung)"
          : `cmd.exe exit ${r.status}${parseHazard ? " with a parse error" : ""}`,
        output: out.slice(0, 400),
      });
    }
  } catch (e) {
    results.push({ file: "(sandbox)", ok: false, reason: String((e && e.message) || e) });
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
  return results;
}

/* ── VBS launcher sanity check ───────────────────────────────────────── */

/** Verify scripts/start-volt-app-hidden.vbs still does its one job: launch
    the app .cmd with a HIDDEN console. Returns an array of errors (empty =
    clean). */
function checkVbsLauncher(text) {
  if (text === undefined) {
    try {
      text = fs.readFileSync(VBS_LAUNCHER, "latin1");
    } catch (e) {
      return [`unreadable: ${e.message}`];
    }
  }
  const errors = [];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 0x7f) {
      errors.push(`non-ASCII byte 0x${text.charCodeAt(i).toString(16)} at offset ${i} — VBScript reads files with the system codepage, so the launcher must be pure ASCII`);
      break;
    }
  }
  if (!text.includes(VBS_TARGET_REF)) errors.push(`must reference ${VBS_TARGET_REF} (the real app launcher it hides)`);
  // window style 0 is THE point of this file: without it the shortcut shows
  // a cmd prompt (the exact bug this file exists to fix)
  if (!/\.Run\s+[^\r\n]*,\s*0\s*,\s*False/i.test(text)) errors.push("must call WshShell.Run with window style 0 and bWaitOnReturn False (hidden console, non-blocking)");
  if (!/\bOption\s+Explicit\b/i.test(text)) errors.push("missing 'Option Explicit' — VBScript fails silently on undeclared variables");
  return errors;
}

/* ── CLI ──────────────────────────────────────────────────────────────── */
if (require.main === module) {
  let failed = false;
  console.log("Volt launcher integrity check");
  for (const f of LAUNCHERS) {
    const errors = staticCheckLauncher(f);
    if (errors.length) {
      failed = true;
      console.log(`  ✗ ${path.relative(REPO_ROOT, f)}`);
      for (const e of errors) console.log(`      - ${e}`);
    } else {
      console.log(`  ✓ ${path.relative(REPO_ROOT, f)} (static)`);
    }
  }
  const vbsErrors = checkVbsLauncher();
  if (vbsErrors.length) {
    failed = true;
    console.log(`  ✗ ${path.relative(REPO_ROOT, VBS_LAUNCHER)}`);
    for (const e of vbsErrors) console.log(`      - ${e}`);
  } else {
    console.log(`  ✓ ${path.relative(REPO_ROOT, VBS_LAUNCHER)} (hidden-console launcher)`);
  }
  if (process.platform === "win32") {
    for (const r of realRunLaunchers()) {
      if (r.ok) console.log(`  ✓ ${r.file} (cmd.exe parse run)`);
      else { failed = true; console.log(`  ✗ ${r.file}: ${r.reason}`); if (r.output) console.log(`      ${r.output}`); }
    }
  } else {
    console.log("  - real cmd.exe parse runs skipped (not Windows)");
  }
  process.exit(failed ? 1 : 0);
}

module.exports = { LAUNCHERS, staticCheckText, staticCheckLauncher, checkAllStatic, realRunLaunchers, checkVbsLauncher, VBS_LAUNCHER };
