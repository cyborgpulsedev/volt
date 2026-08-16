#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════
   Volt — electron-builder wrapper that honors .env

   npm run dist / dist:dir used to shell-chain `node load-env.cjs &&
   electron-builder …` — but the two are separate processes, so the
   .env-loaded CSC_LINK/CSC_KEY_PASSWORD never reached the builder
   (every build logged "signing is skipped cscInfo=null"). This
   wrapper loads .env INTO its own process, then spawns electron-
   builder as a CHILD of it — the child inherits process.env, so a
   configured certificate signs the build. Real environment variables
   still win over the file (load-env.cjs's rule).

   Usage:  node scripts/run-builder.cjs [electron-builder args…]
   ═══════════════════════════════════════════════════════════════ */
"use strict";
const { spawnSync } = require("node:child_process");
const { join } = require("node:path");
require("./load-env.cjs")();

const args = process.argv.slice(2);
if (!args.length) {
  console.error("❌ usage: node scripts/run-builder.cjs [electron-builder args…]");
  process.exit(1);
}

// shell:true on win32 — spawning npx.cmd directly EINVALs on modern Node
const r = spawnSync(process.platform === "win32" ? "npx.cmd" : "npx",
  ["electron-builder", ...args], { stdio: "inherit", timeout: 15 * 60 * 1000, shell: process.platform === "win32" });
process.exit(r.status === null ? 1 : r.status);
