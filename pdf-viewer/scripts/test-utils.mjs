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
t("md bullet list closes with </ul>", U.markdown("- one\n- two").includes("</ul>"));
t("md ordered list opens <ol>", U.markdown("1. one\n2. two").includes("<ol>"));
t("md ordered list closes with </ol>", U.markdown("1. one\n2. two").includes("</ol>"));
t("md ordered list never emits </ul>", !U.markdown("1. one\n2. two").includes("</ul>"));
t("md switches ul -> ol", U.markdown("- a\n1. b").includes("</ul><ol>"));
t("md switches ol -> ul", U.markdown("1. a\n- b").includes("</ol><ul>"));
t("md text after list is outside it", /<\/ol>\s*<p>after<\/p>/.test(U.markdown("1. one\n\nafter")));
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

// ── text-edit word-wrap (pure greedy algorithm, width injected) ──
const cw = (s) => s.length * 10; // 10 width units per character
const cw2 = (s) => (s === " " ? 3 : s.length * 8); // narrower separator
const linesOf = (text, budget, wfn = cw) => U.wrapText(text, wfn, budget);
t("wrap: fits on one line", JSON.stringify(linesOf("hello world", 300)) === JSON.stringify(["hello world"]));
t("wrap: splits at the budget", JSON.stringify(linesOf("hello world test", 150)) === JSON.stringify(["hello world", "test"]));
t("wrap: a word longer than the budget gets its own line", JSON.stringify(linesOf("a bbbbbbbbbbbbbbb c", 100)) === JSON.stringify(["a", "bbbbbbbbbbbbbbb", "c"]));
t("wrap: collapses whitespace", JSON.stringify(linesOf("a   b\n\n c", 500)) === JSON.stringify(["a b c"]));
t("wrap: empty / blank input yields []", JSON.stringify(linesOf("", 100)) === "[]" && JSON.stringify(linesOf("   ", 100)) === "[]");
t("wrap: separator width is honored (narrow sep keeps more words)", JSON.stringify(linesOf("aa bb cc", 40, cw2)) === JSON.stringify(["aa bb", "cc"]));

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

const bms = [
  { id: "x", page: 1, label: "Intro" },
  { id: "y", page: 3, label: "Figures" },
  { id: "z", page: 5, label: "References" },
];
// delete page 3, renumber 5→3 → x:1, z:3 (label kept)
t("bm-remap: deletes + renumbers", JSON.stringify(U.remapBookmarks(bms, { 1: 1, 5: 3 }).map((x) => x.id + ":" + x.page)) === JSON.stringify(["x:1", "z:3"]));
t("bm-remap: keeps bookmark payload", (() => { const r = U.remapBookmarks(bms, { 1: 2 }); return r.length === 1 && r[0].id === "x" && r[0].label === "Intro" && r[0].page === 2; })());
t("bm-remap: empty map drops everything", U.remapBookmarks(bms, {}).length === 0);
t("bm-remap: non-array input → []", U.remapBookmarks(null, { 1: 1 }).length === 0);
t("bm-remap: original list untouched", bms.length === 3 && bms[1].page === 3);

// ── PDF security + redaction (md5 / rc4 / security keys / content redact) ──
const hex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, "0")).join("");
t("md5: RFC 1321 vector (empty)", hex(U.md5(new Uint8Array(0))) === "d41d8cd98f00b204e9800998ecf8427e");
t("md5: RFC 1321 vector (abc)", hex(U.md5(new TextEncoder().encode("abc"))) === "900150983cd24fb0d6963f7d28e17f72");
t("md5: vector (message digest)", hex(U.md5(new TextEncoder().encode("message digest"))) === "f96b697d7cb7938d525a2f31aaf161d0");
t("rc4: 3-byte key vector", hex(U.rc4(new TextEncoder().encode("Key"), new TextEncoder().encode("Plaintext"))).toUpperCase() === "BBF316E8D940AF0AD3");
t("rc4: round-trips", (() => {
  const msg = new TextEncoder().encode("Volt redaction test");
  const enc = U.rc4(new Uint8Array([1, 2, 3, 4, 5]), msg);
  const dec = U.rc4(new Uint8Array([1, 2, 3, 4, 5]), enc);
  return hex(dec) === hex(msg);
})());

t("sec-keys: shape (O/U 32B, key 5B, P integer)", (() => {
  const k = U.pdfSecurityKeys("open", "owner", { printing: true, copying: false }, new Uint8Array(16).fill(7));
  return k.O.length === 32 && k.U.length === 32 && k.key.length === 5 && Number.isInteger(k.P);
})());
t("sec-keys: copying denied clears bit 5 (value 16)", (() => {
  const deny = U.pdfSecurityKeys("u", "o", { printing: true, modifying: true, copying: false, annotations: true }, new Uint8Array(16));
  const allow = U.pdfSecurityKeys("u", "o", { printing: true, modifying: true, copying: true, annotations: true }, new Uint8Array(16));
  return (deny.P & 16) === 0 && (allow.P & 16) === 16;
})());
t("sec-keys: deterministic for same inputs", (() => {
  const a = U.pdfSecurityKeys("pw", "ow", { copying: false }, new Uint8Array(16).fill(3));
  const b = U.pdfSecurityKeys("pw", "ow", { copying: false }, new Uint8Array(16).fill(3));
  return hex(a.O) === hex(b.O) && hex(a.U) === hex(b.U) && hex(a.key) === hex(b.key);
})());

// content-stream redaction: a stream with two text lines, one inside a rect
const redactStream = [
  "BT /F1 12 Tf 72 700 Td (CONFIDENTIAL) Tj 0 -16 Td (public note) Tj ET",
  "\nBT /F1 10 Tf 100 100 Td (keep me) Tj ET",
].join("");
// rect covers the FIRST line's glyph box (baseline 700, box ≈696–710)
t("redact: drops Tj whose baseline is inside the rect", !U.pdfRedactContent(redactStream, [{ x: 60, y: 696, w: 240, h: 15 }]).includes("CONFIDENTIAL"));
t("redact: keeps text outside the rect", (() => {
  const out = U.pdfRedactContent(redactStream, [{ x: 60, y: 696, w: 240, h: 15 }]);
  return out.includes("public note") && out.includes("keep me");
})());
t("redact: no rects → unchanged", U.pdfRedactContent(redactStream, []) === redactStream);
t("redact: Tj before BT is untouched", (() => {
  const s = "0 0 m (not text) Tj BT /F1 12 Tf 72 700 Td (SECRET) Tj ET";
  const out = U.pdfRedactContent(s, [{ x: 60, y: 696, w: 240, h: 15 }]);
  return out.includes("(not text) Tj") && !out.includes("SECRET");
})());
t("redact: TJ array inside the rect is dropped", (() => {
  const s = "BT /F1 12 Tf 72 700 Td [(TOP) 2 (SECRET)] TJ ET";
  return !U.pdfRedactContent(s, [{ x: 60, y: 696, w: 240, h: 15 }]).includes("TJ");
})());
t("redact: line moved by Td stays tracked", (() => {
  const s = "BT /F1 12 Tf 72 700 Td (line one) Tj 0 -16 Td (line two) Tj ET";
  // rect covering ONLY the second line (baseline 684, box ≈680–694)
  const out = U.pdfRedactContent(s, [{ x: 60, y: 680, w: 240, h: 15 }]);
  return out.includes("line one") && !out.includes("line two");
})());
t("redact: stream stays balanced (no dangling operands)", (() => {
  const s = "BT /F1 12 Tf 72 700 Td (SECRET A) Tj (SECRET B) Tj ET";
  const out = U.pdfRedactContent(s, [{ x: 0, y: 0, w: 800, h: 800 }]);
  return !out.includes("SECRET") && !out.includes("Tj") && !/\([^)]*\)/.test(out.replace(/\/F1|12|72|700|Td|BT|ET/g, " "));
})());

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

// ── version / changelog helpers ──
t("cmpVersions: equal", U.cmpVersions("1.2.3", "1.2.3") === 0);
t("cmpVersions: greater / less", U.cmpVersions("2.0.0", "1.9.9") > 0 && U.cmpVersions("0.9.0", "1.0.0") < 0);
t("cmpVersions: major beats minor (1.10.0 > 1.9.9)", U.cmpVersions("1.10.0", "1.9.9") > 0);
t("cmpVersions: malformed treated as 0 parts (never throws)", U.cmpVersions("", "0.0.0") === 0 && U.cmpVersions("x.y.z", "0.0.0") === 0);
t("cmpVersions: antisymmetric", U.cmpVersions("1.0.0", "1.0.1") < 0 && U.cmpVersions("1.0.1", "1.0.0") > 0);

t("changelogSections: parses ## x.y.z pairs in order", (() => {
  const s = U.changelogSections("intro\n\n## 1.1.0\n- a\n\n## 1.0.0\n- b\n");
  return s.length === 2 && s[0].ver === "1.1.0" && /- a/.test(s[0].body) && s[1].ver === "1.0.0" && /- b/.test(s[1].body);
})());
t("changelogSections: empty / no headings → []", U.changelogSections("").length === 0 && U.changelogSections("just text\nno versions").length === 0);

t("bulletItems: strips - and * markers, trims", JSON.stringify(U.bulletItems("  - first\n* second\nplain\n  -  third  ")) === JSON.stringify(["first", "second", "third"]));
t("bulletItems: empty / bullet-less body → []", U.bulletItems("").length === 0 && U.bulletItems("no bullets here").length === 0);

// changelogHtml — the version-banner tooltip builder (pure; current/served
// are passed in, so the window.__VOLT_VERSION read stays in app.js)
const CH = "## 2.0.0\n- big rewrite\n\n## 1.1.0\n- list fix\n\n## 1.0.0\n- initial\n";
t("changelogHtml: newer than current, ≤ served, excludes current", (() => {
  const h = U.changelogHtml(CH, "1.0.0", "2.0.0");
  return h.includes("v1.1.0") && h.includes("v2.0.0") && h.includes("list fix") && h.includes("big rewrite") && !h.includes("v1.0.0");
})());
t("changelogHtml: escapes bullet content", (() => {
  const h = U.changelogHtml("## 2.0.0\n- <script>alert(1)</script>\n", "1.0.0", "2.0.0");
  return h.includes("&lt;script&gt;") && !h.includes("<script>");
})());
t("changelogHtml: downgrade falls back to the served section", (() => {
  const h = U.changelogHtml(CH, "3.0.0", "2.0.0");
  return h.includes("v2.0.0") && h.includes("big rewrite") && !h.includes("v1.1.0");
})());
t("changelogHtml: at current == served, the served section still shows (original fallback)", U.changelogHtml(CH, "2.0.0", "2.0.0").includes("v2.0.0"));
t("changelogHtml: served version absent from changelog → empty", U.changelogHtml(CH, "2.0.0", "9.9.9") === "");
t("changelogHtml: empty md → empty", U.changelogHtml("", "1.0.0", "2.0.0") === "");
t("changelogHtml: unknown current shows all ≤ served", (() => {
  const h = U.changelogHtml(CH, "garbage", "1.1.0");
  return h.includes("v1.1.0") && h.includes("v1.0.0") && !h.includes("v2.0.0");
})());

// aboutChangelogHtml — the About modal's "what this version changed" (pure;
// same bullet-rendering path as changelogHtml)
t("aboutChangelogHtml: renders the section matching the version", (() => {
  const h = U.aboutChangelogHtml(CH, "1.1.0");
  return h.includes("What's new in v1.1.0") && h.includes("list fix") && !h.includes("big rewrite");
})());
t("aboutChangelogHtml: unknown version falls back to the first section", (() => {
  const h = U.aboutChangelogHtml(CH, "dev");
  return h.includes("v2.0.0") && h.includes("big rewrite");
})());
t("aboutChangelogHtml: escapes the version and bullet content", (() => {
  const h = U.aboutChangelogHtml("## 2.0.0\n- <script>alert(1)</script>\n", "2.0.0");
  return h.includes("&lt;script&gt;") && !h.includes("<script>");
})());
t("aboutChangelogHtml: section without bullets → empty", U.aboutChangelogHtml("## 2.0.0\nplain text, no bullets\n", "2.0.0") === "");
t("aboutChangelogHtml: empty md → empty", U.aboutChangelogHtml("", "1.0.0") === "" && U.aboutChangelogHtml(null, "1.0.0") === "");

// ── page-selection range math (lo/hi clamping) ──
t("clampedRange: ordered and reversed give the same lo/hi", (() => {
  const a = U.clampedRange(2, 5, 1, 6), b = U.clampedRange(5, 2, 1, 6);
  return a.lo === 2 && a.hi === 5 && b.lo === 2 && b.hi === 5;
})());
t("clampedRange: stale anchor below clamps to min", (() => {
  const r = U.clampedRange(0, 3, 1, 6);
  return r.lo === 1 && r.hi === 3;
})());
t("clampedRange: stale anchor above clamps to max", (() => {
  const r = U.clampedRange(7, 3, 1, 6);
  return r.lo === 3 && r.hi === 6;
})());
t("clampedRange: single page", (() => {
  const r = U.clampedRange(4, 4, 1, 6);
  return r.lo === 4 && r.hi === 4;
})());
t("clampedRange: 0-based manager bounds", (() => {
  const r = U.clampedRange(2, 0, 0, 3);
  return r.lo === 0 && r.hi === 2;
})());
t("clampedRange: both out of bounds → empty range (lo > hi)", (() => {
  const r = U.clampedRange(9, 9, 0, 3);
  return r.lo > r.hi;
})());

// clampPage — the move-to-position / range-selection page-number clamp
t("clampPage: string and number inputs clamp into [1, max]", U.clampPage("3", 10) === 3 && U.clampPage(3, 10) === 3);
t("clampPage: above max clamps to max", U.clampPage("12", 10) === 10);
t("clampPage: 0 / empty / non-numeric / null all land on page 1", U.clampPage("0", 10) === 1 && U.clampPage("", 10) === 1 && U.clampPage("abc", 10) === 1 && U.clampPage(null, 10) === 1);
t("clampPage: fractions round", U.clampPage("3.7", 10) === 4 && U.clampPage("2.4", 10) === 2);
t("clampPage: max = 1 (single-page doc)", U.clampPage("1", 1) === 1 && U.clampPage("5", 1) === 1);

// ── thumbnail scale ──
t("thumbScale: letter page (612pt) fits the 120px target", U.thumbScale(612) === Math.min(0.22, 120 / 612));
t("thumbScale: wide page scales below the cap", U.thumbScale(2000) === 0.06);
t("thumbScale: narrow page hits the 0.22 cap", U.thumbScale(300) === 0.22);
t("thumbScale: zero / missing width falls back to 600pt", U.thumbScale(0) === 0.2 && U.thumbScale(null) === 0.2);
t("thumbScale: custom target honored (and cap still wins)", U.thumbScale(1200, 0.22, 240) === 0.2 && U.thumbScale(612, 0.22, 240) === 0.22);

// ── restore-summary rows ──
t("restoreSummaryRows: annotation line with marks + notes", (() => {
  const rows = U.restoreSummaryRows({ annCount: 3, notes: 1 });
  return rows[0].k === "Annotations" && rows[0].v === "3 annotations — 2 marks · 1 note";
})());
t("restoreSummaryRows: single annotation, no notes", (() => {
  const r = U.restoreSummaryRows({ annCount: 1, notes: 0 }).find((x) => x.k === "Annotations");
  return r.v === "1 annotation — 1 mark";
})());
t("restoreSummaryRows: zero annotations", U.restoreSummaryRows({ annCount: 0 }).find((x) => x.k === "Annotations").v === "0 annotations");
t("restoreSummaryRows: AI row builds from effective settings", (() => {
  const rows = U.restoreSummaryRows({
    annCount: 0, aiInBackup: true,
    ai: { model: "qwen3", maxContextChars: 8000, systemPrompt: "Be brief." },
  });
  const ai = rows.find((x) => x.k === "AI overrides");
  return ai.v.includes("Model: qwen3") && ai.v.includes("Context: 8,000 chars") && ai.v.includes("Be brief.") &&
    ai.title.includes("Model: qwen3");
})());
t("restoreSummaryRows: AI row with no effective values", (() => {
  const rows = U.restoreSummaryRows({ annCount: 0, aiInBackup: true, ai: {} });
  return rows.find((x) => x.k === "AI overrides").v === "None in this backup";
})());
t("restoreSummaryRows: AI not in backup", U.restoreSummaryRows({ annCount: 0 }).find((x) => x.k === "AI overrides").v === "Not in this backup");
t("restoreSummaryRows: chat in backup (plural + singular)", (() => {
  const rows = U.restoreSummaryRows({ annCount: 0, chatInBackup: true, chatCount: 2 });
  return rows.find((x) => x.k === "Chat").v === "2 messages" &&
    U.restoreSummaryRows({ annCount: 0, chatInBackup: true, chatCount: 1 }).find((x) => x.k === "Chat").v === "1 message";
})());
t("restoreSummaryRows: chat not in backup", U.restoreSummaryRows({ annCount: 0 }).find((x) => x.k === "Chat").v === "Not in this backup");

// ── small display helpers ──
t("stripPdfExt: strips .pdf case-insensitively, once", U.stripPdfExt("report.PDF") === "report" && U.stripPdfExt("doc.pdf.pdf") === "doc.pdf");
t("stripPdfExt: no suffix unchanged", U.stripPdfExt("notes") === "notes" && U.stripPdfExt("") === "");
t("pageSizeLabel: 612×792pt → 8.5 × 11 in", U.pageSizeLabel(612, 792) === "8.5 × 11 in");
t("pageSizeLabel: trailing zeros trimmed", U.pageSizeLabel(72, 144) === "1 × 2 in");
t("pageSizeLabel: missing dims → empty", U.pageSizeLabel(0, 792) === "" && U.pageSizeLabel(null, 792) === "");
t("trunc: short passes through", U.trunc("short", 10) === "short");
t("trunc: long gets ellipsis", U.trunc("abcdefghij", 5) === "abcde…");
t("trunc: trims trailing whitespace before the ellipsis", U.trunc("ab cd  ", 3) === "ab…");

// ── ISO PDF standards (PDF/A-1b) ──
t("buildSrgbIcc: header size field matches actual length", (() => {
  const icc = U.buildSrgbIcc();
  const size = (icc[0] << 24) | (icc[1] << 16) | (icc[2] << 8) | icc[3];
  return size === icc.length && icc.length > 300 && icc.length < 600;
})());
t("buildSrgbIcc: magic + class + space + version", (() => {
  const icc = U.buildSrgbIcc();
  const str = (off, n) => String.fromCharCode(...icc.slice(off, off + n));
  return str(36, 4) === "acsp" && str(12, 4) === "mntr" && str(16, 4) === "RGB " &&
    ((icc[8] << 24) | (icc[9] << 16) | (icc[10] << 8) | icc[11]) >= 0x02100000;
})());
(() => {
  const icc = U.buildSrgbIcc();
  const count = (icc[128] << 24) | (icc[129] << 16) | (icc[130] << 8) | icc[131];
  let ok = count === 8;
  const sigs = new Set();
  for (let i = 0; i < count; i++) {
    const base = 132 + i * 12;
    const sig = String.fromCharCode(...icc.slice(base, base + 4));
    const off = (icc[base + 4] << 24) | (icc[base + 5] << 16) | (icc[base + 6] << 8) | icc[base + 7];
    const len = (icc[base + 8] << 24) | (icc[base + 9] << 16) | (icc[base + 10] << 8) | icc[base + 11];
    sigs.add(sig);
    if (off + len > icc.length) ok = false; // every tag must fit in the file
  }
  return ok && ["desc", "wtpt", "rXYZ", "gXYZ", "bXYZ", "rTRC", "gTRC", "bTRC"].every((s) => sigs.has(s));
})() ? t("buildSrgbIcc: 8 tags with all required sigs in-bounds", true) : t("buildSrgbIcc: 8 tags with all required sigs in-bounds", false);
t("pdfA1bXmp: carries pdfaid part + conformance", (() => {
  const x = U.pdfA1bXmp({ title: "T", producer: "P" });
  return x.includes("<pdfaid:part>1</pdfaid:part>") && x.includes("<pdfaid:conformance>B</pdfaid:conformance>");
})());
t("pdfA1bXmp: escapes title/producer, omits empty fields", (() => {
  const x = U.pdfA1bXmp({ title: "A <B> & C", producer: "" });
  return x.includes("A &lt;B&gt; &amp; C") && !x.includes("<pdf:Producer>") &&
    !x.includes("<xmp:CreateDate>") &&
    !U.pdfA1bXmp({}).includes("<dc:title>");
})());
t("pdfA1bXmp: xpacket wrapper present, dates ISO", (() => {
  const d = new Date("2026-08-19T10:20:30.123Z");
  const x = U.pdfA1bXmp({ title: "T", created: d, modified: d });
  return x.startsWith('<?xpacket begin="\uFEFF"') && x.trimEnd().endsWith('<?xpacket end="w"?>') &&
    x.includes("<xmp:CreateDate>2026-08-19T10:20:30Z</xmp:CreateDate>");
})());
t("injectPdfTrailerId: inserts /ID before trailer close", (() => {
  const src = "trailer\n<<\n/Size 7\n/Root 2 0 R\n>>\nstartxref\n1129\n%%EOF";
  const out = U.injectPdfTrailerId(src, "a1b2c3d4e5f60718293a4b5c6d7e8f90");
  return out.includes("/ID [<a1b2c3d4e5f60718293a4b5c6d7e8f90> <a1b2c3d4e5f60718293a4b5c6d7e8f90>]") &&
    out.includes("/Size 7") && out.includes("startxref\n1129\n%%EOF");
})());
t("injectPdfTrailerId: skips when /ID already present", (() => {
  const src = "trailer\n<< /ID [<aa> <aa>] /Size 7 >>";
  return U.injectPdfTrailerId(src, "a1b2c3d4e5f60718293a4b5c6d7e8f90") === src;
})());
t("injectPdfTrailerId: RANDOM derives a 32-hex id from the source", (() => {
  const src = "trailer\n<<\n/Size 7\n>>";
  const out = U.injectPdfTrailerId(src, "RANDOM");
  const m = /\/ID \[<([0-9a-f]{32})>/.exec(out);
  return !!m;
})());

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
