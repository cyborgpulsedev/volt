#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════
   check-feed-drift.mjs — local feed-drift watcher

   The CI battery only notices feed drift on a push: the "Release feed
   reachability + version match" gate compares the live latest.yml to the
   tree's package.json version, but between pushes a leftover scratch
   release (or a manual publish of the wrong version) can silently point
   the auto-update feed at something main doesn't ship. This script polls
   the SAME URL every installed copy hits — releases/latest/download/
   latest.yml — and warns the moment its version stops matching the local
   tree, so drift is caught while you work, not on the next CI run.

   Usage (from pdf-viewer/):
     node scripts/check-feed-drift.mjs                # poll forever (5 min)
     node scripts/check-feed-drift.mjs --once         # single check, exit code
     node scripts/check-feed-drift.mjs --interval 60  # poll every 60s
     node scripts/check-feed-drift.mjs --repo owner/repo   # override repo
     node scripts/check-feed-drift.mjs --expect 1.0.1 # compare vs a fixed version
     node scripts/check-feed-drift.mjs --exit-on-drift   # exit 1 at first drift
     node scripts/check-feed-drift.mjs --selftest     # run the pure-helper tests

   Exit codes with --once (and --exit-on-drift in loop mode):
     0  feed version matches the expected version
     1  DRIFT — feed advertises a different version
     2  no release published yet (feed 404) — the expected pre-ship state
     3  fetch / parse / config error
   ═══════════════════════════════════════════════════════════════ */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(readFileSync(join(HERE, "..", "package.json"), "utf8"));

/* ── pure helpers (exported for tests / --selftest) ───────────── */

/** First `version:` line of a latest.yml body, stripped and de-quoted.
    Mirrors the CI gate's parsing exactly (grep ^version: → sed → strip
    quotes → trim). Returns null when the body has no parseable version. */
export function parseFeedVersion(yml) {
  if (typeof yml !== "string") return null;
  for (const line of yml.split(/\r?\n/)) {
    const m = /^version:[ \t]*(.*)$/.exec(line);
    if (m) {
      const v = m[1].trim().replace(/^["']|["']$/g, "").trim();
      return v || null;
    }
  }
  return null;
}

/** Turn a git remote URL into owner/repo. Handles https, ssh://, and
    the scp-style git@github.com:owner/repo.git form. Returns null when
    the URL isn't a GitHub repo. */
export function repoFromRemote(url) {
  if (typeof url !== "string") return null;
  const u = url.trim();
  let m = /^https?:\/\/(?:www\.)?github\.com\/(.+?)(?:\.git)?\/?$/.exec(u);
  if (!m) m = /^(?:ssh:\/\/)?git@github\.com[:/](.+?)(?:\.git)?\/?$/.exec(u);
  if (!m) return null;
  const pair = m[1].replace(/\/$/, "");
  return /^[^/]+\/[^/]+$/.test(pair) ? pair : null;
}

/* ── config ───────────────────────────────────────────────────── */

function argv() {
  const a = { once: false, interval: 300, repo: null, expect: null, exitOnDrift: false, selftest: false };
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--once") a.once = true;
    else if (arg === "--exit-on-drift") a.exitOnDrift = true;
    else if (arg === "--selftest") a.selftest = true;
    else if (arg === "--interval") a.interval = Math.max(5, parseInt(args[++i], 10) || 300);
    else if (arg === "--repo") a.repo = args[++i];
    else if (arg === "--expect") a.expect = args[++i];
    else { console.error("unknown flag: " + arg); process.exit(3); }
  }
  return a;
}

function resolveRepo(explicit) {
  if (explicit) return explicit;
  if (process.env.VOLT_REPO) return process.env.VOLT_REPO;
  try {
    const url = execFileSync("git", ["config", "--get", "remote.origin.url"], { encoding: "utf8" }).trim();
    const repo = repoFromRemote(url);
    if (repo) return repo;
  } catch { /* no git remote — fall through */ }
  return null;
}

/* ── feed check ───────────────────────────────────────────────── */

async function checkFeed(repo, expected) {
  const feedUrl = `https://github.com/${repo}/releases/latest/download/latest.yml`;
  let res;
  try {
    res = await fetch(feedUrl, { redirect: "follow" });
  } catch (e) {
    return { status: 3, msg: `feed fetch failed (${e.message})`, feedUrl };
  }
  if (res.status === 404) {
    return { status: 2, msg: "no release published yet — feed 404 (expected pre-ship state)", feedUrl };
  }
  if (!res.ok) {
    return { status: 3, msg: `feed HTTP ${res.status} (expected 200 with a release, or 404 with none)`, feedUrl };
  }
  const yml = await res.text();
  const feedVer = parseFeedVersion(yml);
  if (feedVer === null) {
    return { status: 3, msg: `feed has no parseable 'version:' field`, feedUrl };
  }
  if (feedVer === expected) {
    return { status: 0, msg: `feed advertises ${feedVer} — matches the expected version`, feedUrl };
  }
  return { status: 1, msg: `DRIFT: feed advertises ${feedVer}, expected ${expected} — the updater's "latest" is not what this tree ships`, feedUrl };
}

/* ── selftest ─────────────────────────────────────────────────── */

function selftest() {
  let fail = 0;
  const t = (name, ok) => { if (!ok) fail++; console.log((ok ? "PASS" : "FAIL") + "  " + name); };

  t("parse: plain version", parseFeedVersion("version: 1.0.1\nfiles:\n") === "1.0.1");
  t("parse: quoted + spaced", parseFeedVersion("version: \"1.0.2\"\n") === "1.0.2");
  t("parse: single-quoted", parseFeedVersion("version: '1.0.3'\n") === "1.0.3");
  t("parse: ignores non-version lines", parseFeedVersion("path: x\nsha512: y\nversion: 2.0.0\n") === "2.0.0");
  t("parse: CRLF body", parseFeedVersion("version: 1.0.1\r\nfiles:\r\n") === "1.0.1");
  t("parse: empty value → null", parseFeedVersion("version:\n") === null);
  t("parse: no version line → null", parseFeedVersion("path: x\nsha512: y\n") === null);
  t("parse: non-string → null", parseFeedVersion(null) === null);

  t("repo: https", repoFromRemote("https://github.com/cyborgpulsedev/volt.git") === "cyborgpulsedev/volt");
  t("repo: https no .git", repoFromRemote("https://github.com/cyborgpulsedev/volt") === "cyborgpulsedev/volt");
  t("repo: scp-style", repoFromRemote("git@github.com:cyborgpulsedev/volt.git") === "cyborgpulsedev/volt");
  t("repo: ssh://", repoFromRemote("ssh://git@github.com/cyborgpulsedev/volt.git") === "cyborgpulsedev/volt");
  t("repo: non-github → null", repoFromRemote("https://example.com/a/b.git") === null);
  t("repo: non-string → null", repoFromRemote(null) === null);

  console.log(fail ? `\n${fail} selftest(s) FAILED` : "\nselftest OK");
  process.exit(fail ? 3 : 0);
}

/* ── main ─────────────────────────────────────────────────────── */

async function main() {
  const a = argv();
  if (a.selftest) return selftest();

  const repo = resolveRepo(a.repo);
  if (!repo) {
    console.error("could not determine the GitHub repo — pass --repo owner/repo (or set VOLT_REPO, or run from a checkout with a GitHub origin)");
    process.exit(3);
  }
  const expected = a.expect !== null ? a.expect : PKG.version;
  const stamp = () => new Date().toISOString();

  const report = (r) => {
    if (r.status === 1) console.error(`[${stamp()}] ⚠ ${r.msg}`);
    else console.log(`[${stamp()}] ${r.msg}`);
  };

  if (a.once) {
    const r = await checkFeed(repo, expected);
    report(r);
    process.exit(r.status);
  }

  console.log(`watching ${repo} latest.yml for drift vs ${expected} — every ${a.interval}s (Ctrl+C to stop)`);
  for (;;) {
    const r = await checkFeed(repo, expected);
    report(r);
    if (a.exitOnDrift && r.status === 1) process.exit(1);
    await new Promise((res) => setTimeout(res, a.interval * 1000));
  }
}

main();
