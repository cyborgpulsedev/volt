// Unit tests for utils.js pure logic (chunking, scoring, markdown, tokenize,
// and the modal focus-trap wrap decision). Usage: node scripts/test-utils.mjs
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// Load utils.js in a Node context (it attaches to globalThis)
const src = readFileSync(join(__dirname, "..", "js", "utils.js"), "utf8");
const fn = new Function("window", src);
fn(globalThis);
const U = globalThis.Utils;

let pass = 0, fail = 0;
function t(name, cond) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name); }
}

console.log("utils.js unit tests");

// hash
t("hash is stable", U.hash("abc") === U.hash("abc"));
t("hash differs", U.hash("abc") !== U.hash("abd"));

// document fingerprints (backup matching)
t("fpNormalize collapses whitespace + lowercases", U.fpNormalize("  Hello   World\n\nAgain  ") === "hello world again");
t("fp64 is stable", U.fp64("The Quiet Engine") === U.fp64("The Quiet Engine"));
t("fp64 differs on content", U.fp64("The Quiet Engine") !== U.fp64("The Quiet Enginr"));
t("fp64 is 16 hex digits", /^[0-9a-f]{16}$/.test(U.fp64("anything")));
t("fp64 differs on case", U.fp64("Hello world") !== U.fp64("hello world"));

// tokenize
t("tokenize words+numbers", JSON.stringify(U.tokenize("Hello, 2 fast dogs!")) === JSON.stringify(["hello", "2", "fast", "dogs"]));

// chunkText
const long = Array(300).fill("word").join(" ") + ". ".repeat(0);
const chunks = U.chunkText("a ".repeat(4000));
t("chunkText produces multiple chunks", chunks.length > 2);
t("chunkText chunks under ~size", chunks.every((c) => c.length <= 1300));
t("chunkText keeps content", chunks.join("").replace(/ /g, "").includes("aaa"));

// scoreChunk — relevant chunk scores higher
const q = U.tokenize("quiet engine principles attention");
const docFreq = { quiet: 3, engine: 2, principles: 1, attention: 1 };
const relevant = "The quiet engine respects attention. Principles of attention.";
const irrelevant = "Cooking pasta requires boiling water and salt.";
const s1 = U.scoreChunk(q, relevant, docFreq, 10);
const s2 = U.scoreChunk(q, irrelevant, docFreq, 10);
t("scoring prefers relevant chunk", s1 > s2);

// markdown
t("md escapes html", U.markdown("<script>alert(1)</script>").includes("&lt;script&gt;"));
t("md bold", U.markdown("**bold**").includes("<strong>bold</strong>"));
t("md code fence", U.markdown("```\nconst a = 1\n```").includes("<pre><code>"));
t("md list", U.markdown("- one\n- two").includes("<li>one</li>"));
t("md heading", U.markdown("## Hi").includes("<h2>Hi</h2>"));
t("md link", U.markdown("[x](https://example.com)").includes('href="https://example.com"'));

// clamp / fmtBytes
t("clamp", U.clamp(50, 0, 10) === 10 && U.clamp(-5, 0, 10) === 0);
t("fmtBytes", U.fmtBytes(2048) === "2.0 KB");

// ── modal focus trap (pure wrap decision + selector contract) ──
// the decision logic behind _trapTab in app.js — extracted so a regression in
// the wrap-around rules is caught here, in the fast suite, not only by the
// Electron/browser smoke's real-keyboard stage
const A = { id: "a" }, B = { id: "b" }, C = { id: "c" };
const trap3 = [A, B, C];
// re-entry: focus outside the modal jumps to the far end in the travel direction
t("trap: focus outside → first on Tab", U.focusTrapMove(trap3, null, { containsActive: false }) === A);
t("trap: focus outside → last on Shift+Tab", U.focusTrapMove(trap3, null, { containsActive: false, shiftKey: true }) === C);
// boundary wrap
t("trap: Shift+Tab on first wraps to last", U.focusTrapMove(trap3, A, { containsActive: true, shiftKey: true }) === C);
t("trap: Tab on last wraps to first", U.focusTrapMove(trap3, C, { containsActive: true }) === A);
// interior: no wrap — native Tab continues in document order
t("trap: Tab on first stays native (null)", U.focusTrapMove(trap3, A, { containsActive: true }) === null);
t("trap: Shift+Tab on last stays native (null)", U.focusTrapMove(trap3, C, { containsActive: true, shiftKey: true }) === null);
t("trap: Tab on middle stays native (null)", U.focusTrapMove(trap3, B, { containsActive: true }) === null);
// degenerate cases
t("trap: empty list → null (caller swallows Tab separately)", U.focusTrapMove([], A, { containsActive: true }) === null);
t("trap: single element wraps to itself both ways", U.focusTrapMove([A], A, { containsActive: true }) === A &&
  U.focusTrapMove([A], A, { containsActive: true, shiftKey: true }) === A);
t("trap: non-array input → null", U.focusTrapMove(null, A, {}) === null);
// selector contract: every focusable kind is in tab order, tabindex=-1 is out
t("trap: selector covers all focusable types", ["button", "[href]", "input", "select", "textarea", "[tabindex]"].every((s) => U.FOCUSABLE_SELECTOR.includes(s)));
t("trap: selector excludes [tabindex=\"-1\"] via :not()", U.FOCUSABLE_SELECTOR.includes(':not([tabindex="-1"])'));

// ── toolbar-menu navigation (pure wrap decision) ──
// the decision logic behind the _wireMenus keyboard nav — extracted so a
// regression in the wrap-around rules is caught in the fast suite, not only
// by the Electron smoke's real-keyboard stage
const M1 = { id: "m1" }, M2 = { id: "m2" }, M3 = { id: "m3" };
const menu3 = [M1, M2, M3];
// focus outside the panel (on the trigger) → the direction selects the far end
t("menu: focus outside → first on next", U.menuNavMove(menu3, null, "next") === M1);
t("menu: focus outside → last on prev", U.menuNavMove(menu3, null, "prev") === M3);
// forward traversal + wrap
t("menu: next advances", U.menuNavMove(menu3, M1, "next") === M2);
t("menu: next wraps last → first", U.menuNavMove(menu3, M3, "next") === M1);
// backward traversal + wrap
t("menu: prev retreats", U.menuNavMove(menu3, M2, "prev") === M1);
t("menu: prev wraps first → last", U.menuNavMove(menu3, M1, "prev") === M3);
// Home / End
t("menu: Home → first", U.menuNavMove(menu3, M3, "first") === M1);
t("menu: End → last", U.menuNavMove(menu3, M1, "last") === M3);
// degenerate cases
t("menu: empty list → null (caller focuses the trigger)", U.menuNavMove([], M1, "next") === null);
t("menu: single element wraps to itself both ways", U.menuNavMove([M2], M2, "next") === M2 &&
  U.menuNavMove([M2], M2, "prev") === M2);
t("menu: non-array input → null", U.menuNavMove(null, M1, "next") === null);

// ── page-management helpers (parsePageRange / remapAnnotations) ──
t("range: all → 1..max", JSON.stringify(U.parsePageRange("all", 4)) === JSON.stringify([1, 2, 3, 4]));
t("range: single", JSON.stringify(U.parsePageRange("2", 4)) === JSON.stringify([2]));
t("range: span", JSON.stringify(U.parsePageRange("2-4", 5)) === JSON.stringify([2, 3, 4]));
t("range: mixed list", JSON.stringify(U.parsePageRange("1,3-4,2", 5)) === JSON.stringify([1, 2, 3, 4]));
t("range: whitespace tolerated", JSON.stringify(U.parsePageRange(" 1 , 3 - 5 ", 6)) === JSON.stringify([1, 3, 4, 5]));
t("range: all with spaces", JSON.stringify(U.parsePageRange(" ALL ", 2)) === JSON.stringify([1, 2]));
t("range: dedupes", JSON.stringify(U.parsePageRange("2,2-3", 4)) === JSON.stringify([2, 3]));
t("range: rejects descending span", U.parsePageRange("5-2", 6) === null);
t("range: rejects zero", U.parsePageRange("0-2", 4) === null);
t("range: rejects out-of-range", U.parsePageRange("1-9", 3) === null);
t("range: rejects garbage", U.parsePageRange("a-b", 4) === null && U.parsePageRange("", 4) === null && U.parsePageRange(null, 4) === null);

// ── move-to form targets (parseMoveTargets) — block vs per-page placement ──
t("move: plain position → block", JSON.stringify(U.parseMoveTargets("3", 5)) === JSON.stringify({ kind: "block", pos: 3 }));
t("move: before N → block at N", JSON.stringify(U.parseMoveTargets("before 3", 5)) === JSON.stringify({ kind: "block", pos: 3 }));
t("move: before page N keyword tolerated", JSON.stringify(U.parseMoveTargets("before page 3", 5)) === JSON.stringify({ kind: "block", pos: 3 }));
t("move: after N → block at N+1", JSON.stringify(U.parseMoveTargets("after 2", 5)) === JSON.stringify({ kind: "block", pos: 3 }));
t("move: after last page → end", JSON.stringify(U.parseMoveTargets("after 5", 5)) === JSON.stringify({ kind: "block", pos: 6 }));
t("move: before first → start", JSON.stringify(U.parseMoveTargets("before 1", 5)) === JSON.stringify({ kind: "block", pos: 1 }));
t("move: list preserves typed order", JSON.stringify(U.parseMoveTargets("3,1", 5)) === JSON.stringify({ kind: "list", targets: [3, 1] }));
t("move: list with range expands in order", JSON.stringify(U.parseMoveTargets("1,3-4", 5)) === JSON.stringify({ kind: "list", targets: [1, 3, 4] }));
t("move: whitespace tolerated", JSON.stringify(U.parseMoveTargets(" 1 , 3 - 5 ", 6)) === JSON.stringify({ kind: "list", targets: [1, 3, 4, 5] }));
t("move: case-insensitive before/after", JSON.stringify(U.parseMoveTargets("Before Page 2", 5)) === JSON.stringify({ kind: "block", pos: 2 }));
t("move: duplicate targets rejected (ambiguous)", U.parseMoveTargets("3,3", 5) === null);
t("move: out-of-range rejected", U.parseMoveTargets("7", 3) === null && U.parseMoveTargets("before 4", 3) === null && U.parseMoveTargets("1,4", 3) === null);
t("move: zero rejected", U.parseMoveTargets("0", 5) === null && U.parseMoveTargets("before 0", 5) === null && U.parseMoveTargets("after 0", 5) === null);
t("move: descending range rejected", U.parseMoveTargets("5-2", 6) === null);
t("move: garbage rejected", U.parseMoveTargets("abc", 5) === null && U.parseMoveTargets("", 5) === null && U.parseMoveTargets("before", 5) === null && U.parseMoveTargets("1,", 5) === null && U.parseMoveTargets(null, 5) === null);

const anns = [
  { id: "a", page: 1, type: "highlight" },
  { id: "b", page: 2, type: "note" },
  { id: "c", page: 3, type: "rect" },
  { id: "d", page: 4, type: "underline" },
];
// delete page 2, swap 3↔4 → a:1, c:2, d:3
t("remap: deletes + renumbers", JSON.stringify(U.remapAnnotations(anns, { 1: 1, 3: 2, 4: 3 }).map((x) => x.id + ":" + x.page)) === JSON.stringify(["a:1", "c:2", "d:3"]));
t("remap: keeps annotation payload", (() => { const r = U.remapAnnotations(anns, { 1: 2 }); return r.length === 1 && r[0].id === "a" && r[0].type === "highlight" && r[0].page === 2; })());
t("remap: empty map drops everything", U.remapAnnotations(anns, {}).length === 0);
t("remap: non-array input → []", U.remapAnnotations(null, { 1: 1 }).length === 0);

t("remap: original list untouched", anns.length === 4 && anns[1].page === 2);

// ── window-state persistence (scripts/window-state.cjs) ──
// the pure validation behind main.js's "remember window size/position": the
// saved bounds must survive a relaunch but never restore a window that is
// off-screen (monitor layout changed) or below the resizable floor
const winState = require(join(__dirname, "window-state.cjs"));
const launchCheck = require(join(__dirname, "..", "..", "scripts", "check-launchers.cjs"));
const disp = [{ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }];
const full = { x: 100, y: 80, width: 1280, height: 900 };
t("wstate: valid bounds pass through", JSON.stringify(winState.normalizeState(full, disp)) === JSON.stringify({ ...full, maximized: false }));
t("wstate: maximized flag carried", winState.normalizeState({ ...full, maximized: true }, disp).maximized === true);
t("wstate: fractional bounds round", (() => { const r = winState.normalizeState({ ...full, x: 100.6, y: 80.4 }, disp); return r.x === 101 && r.y === 80; })());
t("wstate: width below floor rejected", winState.normalizeState({ ...full, width: 800 }, disp) === null);
t("wstate: height below floor rejected", winState.normalizeState({ ...full, height: 500 }, disp) === null);
t("wstate: non-numeric bounds rejected", winState.normalizeState({ ...full, x: "abc" }, disp) === null && winState.normalizeState({ ...full, width: NaN }, disp) === null);
t("wstate: off-screen position rejected", winState.normalizeState({ ...full, x: -5000, y: 5000 }, disp) === null && winState.normalizeState({ ...full, x: 1900, y: 1000 }, disp) === null);
t("wstate: partially on-screen still valid", winState.normalizeState({ ...full, x: -80, y: -30 }, disp) !== null);
t("wstate: non-object / array / null rejected", winState.normalizeState("5", disp) === null && winState.normalizeState([1, 2], disp) === null && winState.normalizeState(null, disp) === null);
t("wstate: empty display list rejected", winState.normalizeState(full, []) === null);
t("wstate: missing file loads as null", winState.loadState(join(__dirname, "definitely-not-here.json"), disp) === null);
t("wstate: corrupt file loads as null", (() => { const p = join(__dirname, "__wstate-tmp.json"); const { writeFileSync, rmSync } = require("node:fs"); writeFileSync(p, "not json{"); const r = winState.loadState(p, disp); rmSync(p, { force: true }); return r === null; })());

// ── .cmd launcher integrity (scripts/check-launchers.cjs) ──
// every launcher must be ASCII + CRLF and free of the cmd.exe block-parse
// hazards that once killed start-volt-app.cmd ("… was unexpected at this
// time."). Rules were verified against real cmd.exe behavior.
t("launcher: all 5 .cmd files pass static checks", launchCheck.LAUNCHERS.every((f) => launchCheck.staticCheckLauncher(f).length === 0));
t("launcher: clean baseline has no errors", launchCheck.staticCheckText("@echo off\r\nset \"X=1\"\r\necho done\r\n").length === 0);
t("launcher: UTF-8 bytes rejected", launchCheck.staticCheckText("@echo off\r\necho caf\u00e9\r\n").some((e) => /non-ASCII/i.test(e)));
t("launcher: LF-only endings rejected", launchCheck.staticCheckText("@echo off\nset \"X=1\"\n").some((e) => /LF-only/i.test(e)));
t("launcher: parens in block echo rejected (the shipped bug)", launchCheck.staticCheckText("@echo off\r\nif not exist \"x\" (\r\n  echo downloading (Electron)...\r\n)\r\n").some((e) => /echo.*block/i.test(e)));
t("launcher: text after block close rejected", launchCheck.staticCheckText("@echo off\r\nif 1==1 (\r\n  echo hi\r\n) echo after\r\n").some((e) => /after the block-closing/i.test(e)));
t("launcher: unbalanced block rejected", launchCheck.staticCheckText("@echo off\r\nif 1==1 (\r\n  echo hi\r\n").some((e) => /unbalanced/i.test(e)));
t("launcher: undefined label rejected", launchCheck.staticCheckText("@echo off\r\ncall :nope\r\n").some((e) => /never defined/i.test(e)));
t("launcher: rem parens in a block are inert", launchCheck.staticCheckText("@echo off\r\nif 1==1 (\r\n  rem (fine)\r\n  echo ok\r\n)\r\n").length === 0);
t("launcher: for-set parens are inert", launchCheck.staticCheckText("@echo off\r\nfor /l %%i in (1,1,3) do (\r\n  echo %%i\r\n)\r\n").length === 0);
t("launcher: echo trailing block-close tolerated", launchCheck.staticCheckText("@echo off\r\nif 1==1 (\r\n  echo hi )\r\n)\r\n").length === 0);
t("launcher: quoted arg parens not flagged", launchCheck.staticCheckText("@echo off\r\nstart \"\" powershell -Command \"$u='x'; if($u -eq 'x'){ Start-Process $u }\"\r\n").length === 0);
t("launcher: redirection after block close allowed", launchCheck.staticCheckText("@echo off\r\nif 1==1 (\r\n  echo hi\r\n)>> out.txt\r\n").length === 0);

// ── hidden-console VBS launcher (scripts/start-volt-app-hidden.vbs) ──
// the desktop shortcut runs wscript.exe + this file so the app starts with
// NO cmd prompt. The checker must be strict about the two properties that
// make that guarantee true: referencing the real .cmd and window style 0.
// the shipped hidden-console launcher must be clean
const shippedVbs = (() => { try { return require("node:fs").readFileSync(launchCheck.VBS_LAUNCHER, "latin1"); } catch (e) { return ""; } })();
t("vbs: shipped launcher is clean", launchCheck.checkVbsLauncher(shippedVbs).length === 0);
t("vbs: shipped launcher references the .cmd", /start-volt-app\.cmd/.test(shippedVbs));
t("vbs: clean text passes", launchCheck.checkVbsLauncher("Option Explicit\r\nDim s\r\nSet s = CreateObject(\"WScript.Shell\")\r\ns.Run \"start-volt-app.cmd\", 0, False\r\n").length === 0);
t("vbs: visible console (style 1) rejected", launchCheck.checkVbsLauncher("Option Explicit\r\nDim s\r\nSet s = CreateObject(\"WScript.Shell\")\r\ns.Run \"start-volt-app.cmd\", 1, False\r\n").some((e) => /window style 0/i.test(e)));
t("vbs: wrong target rejected", launchCheck.checkVbsLauncher("Option Explicit\r\nDim s\r\nSet s = CreateObject(\"WScript.Shell\")\r\ns.Run \"other.cmd\", 0, False\r\n").some((e) => /start-volt-app\.cmd/i.test(e)));
t("vbs: non-ASCII rejected", launchCheck.checkVbsLauncher("Option Explicit\r\ns.Run \"start-volt-app.cmd\", 0, False \u2014 em dash\r\n").some((e) => /non-ASCII/i.test(e)));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
