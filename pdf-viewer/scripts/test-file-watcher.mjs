// Unit tests for scripts/file-watcher.cjs — the poll-based watcher behind
// Volt's "file changed on disk" reload offer.
// Usage: node scripts/test-file-watcher.mjs
import { mkdtempSync, writeFileSync, rmSync, renameSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const { createRequire } = await import("node:module");
const require = createRequire(import.meta.url);
const FileWatcher = require(join(dirname(fileURLToPath(import.meta.url)), "file-watcher.cjs"));

let pass = 0, fail = 0;
function t(name, cond) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log("file-watcher.cjs unit tests");

const dir = mkdtempSync(join(tmpdir(), "volt-watch-"));
const file = join(dir, "doc.pdf");
writeFileSync(file, "v1");
const INTERVAL = 50;

// 1. baseline: no fire for the initial state
{
  const events = [];
  const w = new FileWatcher(file, (e) => events.push(e), { intervalMs: INTERVAL });
  w.start();
  await sleep(INTERVAL * 3);
  t("no fire on baseline", events.length === 0);
  w.stop();
}

// 2. content change fires (with the stability delay)
{
  const events = [];
  const w = new FileWatcher(file, (e) => events.push(e), { intervalMs: INTERVAL });
  w.start();
  await sleep(INTERVAL); // baseline settled
  writeFileSync(file, "v2 - a re-export");
  await sleep(INTERVAL * 4); // detect + one stability interval
  t("fires on content change", events.length === 1 && events[0].missing === false);
  await sleep(INTERVAL * 2);
  t("does not re-fire while unchanged", events.length === 1);
  w.stop();
}

// 3. deletion fires missing:true once
{
  const events = [];
  const w = new FileWatcher(file, (e) => events.push(e), { intervalMs: INTERVAL });
  w.start();
  await sleep(INTERVAL); // baseline settled
  rmSync(file);
  await sleep(INTERVAL * 3);
  t("fires on deletion (missing)", events.length === 1 && events[0].missing === true);
  w.stop();
}

// 4. recreation after deletion fires as a change
{
  const events = [];
  const w = new FileWatcher(file, (e) => events.push(e), { intervalMs: INTERVAL });
  w.start();
  await sleep(INTERVAL); // baseline (file absent) settled
  writeFileSync(file, "recreated");
  await sleep(INTERVAL * 4);
  t("fires on recreation", events.length === 1 && events[0].missing === false);
  w.stop();
}

// 5. mid-write churn does not fire until the file settles
{
  const events = [];
  const w = new FileWatcher(file, (e) => events.push(e), { intervalMs: INTERVAL });
  w.start();
  await sleep(INTERVAL);
  // simulate a slow export: three writes a few ms apart
  writeFileSync(file, "chunk1...........");
  await sleep(INTERVAL / 2);
  writeFileSync(file, "chunk2.....................");
  await sleep(INTERVAL / 2);
  writeFileSync(file, "chunk3..........................");
  await sleep(INTERVAL / 2);
  await sleep(INTERVAL * 3);
  t("mid-write churn fires exactly once after settling", events.length === 1 && events[0].missing === false);
  w.stop();
}

// 6. stop() halts notifications
{
  const events = [];
  const w = new FileWatcher(file, (e) => events.push(e), { intervalMs: INTERVAL });
  w.start();
  await sleep(INTERVAL);
  w.stop();
  writeFileSync(file, "after-stop");
  await sleep(INTERVAL * 3);
  t("stop() halts notifications", events.length === 0);
}

// 7. rename-save (temp file swap) — the classic editor save pattern:
// write a .tmp next to the target, then atomically replace the target with
// it (some editors also unlink the target first, so the poller may see the
// file vanish and reappear). Either way the final event must be a change.
{
  const tmp = join(dir, "doc.pdf.tmp");
  const events = [];
  const w = new FileWatcher(file, (e) => events.push(e), { intervalMs: INTERVAL });
  w.start();
  await sleep(INTERVAL);
  writeFileSync(tmp, "new generation");
  if (existsSync(file)) rmSync(file); // the original may briefly vanish
  renameSync(tmp, file); // …before the rename lands over it
  await sleep(INTERVAL * 4);
  t("rename-save swap fires", events.length >= 1 && events[events.length - 1].missing === false);
  w.stop();
}

// 8. missing file at start: appearing fires (watcher on a not-yet-existing doc)
{
  const fresh = join(dir, "later.pdf");
  const events = [];
  const w = new FileWatcher(fresh, (e) => events.push(e), { intervalMs: INTERVAL });
  w.start();
  await sleep(INTERVAL); // baseline: file absent
  writeFileSync(fresh, "hello");
  await sleep(INTERVAL * 4);
  t("absent-at-start fires on appearance", events.length === 1 && events[0].missing === false);
  w.stop();
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
