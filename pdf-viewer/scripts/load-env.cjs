#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════
   Volt — shared .env loader (CommonJS)

   electron-builder does NOT read a project .env by itself, so every
   script that needs signing credentials (or any other secret) loads
   them from <pdf-viewer>/.env through this module. Rules:

     • The file is optional — missing/empty is fine (unsigned dev).
     • Real environment variables WIN over .env entries (so CI/export
       beats a local file, and one .env can't leak into another
       context).
     • Only keys matching /^[A-Za-z_][A-Za-z0-9_]*$/ are applied;
       comments (#) and blank lines are skipped; surrounding quotes
       are stripped; CRLF is tolerated.
     • .env is gitignored (see the repo root .gitignore) and must
       never be committed — it holds the signing key password.

   Usage (CommonJS):   require("./load-env.cjs")();
   Usage (ESM):        createRequire(import.meta.url)("./load-env.cjs")();
   ═══════════════════════════════════════════════════════════════ */
"use strict";
const { existsSync, readFileSync } = require("node:fs");
const { join } = require("node:path");

const ENV_FILE = join(__dirname, "..", ".env");

/** @returns {number} how many keys were applied from .env */
function loadEnv() {
  if (!existsSync(ENV_FILE)) return 0;
  let applied = 0;
  for (const raw of readFileSync(ENV_FILE, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (process.env[key] !== undefined) continue; // real env wins
    let val = line.slice(eq + 1).trim();
    if (val.length >= 2) {
      const q = val[0];
      if ((q === '"' || q === "'") && val[val.length - 1] === q) {
        val = val.slice(1, -1).replace(/\\"/g, '"');
      }
    }
    process.env[key] = val;
    applied++;
  }
  return applied;
}

module.exports = loadEnv;
module.exports.loadEnv = loadEnv;
module.exports.ENV_FILE = ENV_FILE;

// NOTE: do NOT add a CLI mode that promises `node load-env.cjs && …` —
// environment variables do NOT cross process boundaries in a shell chain,
// so the next command would never see them. Wrap the child instead:
// scripts/run-builder.cjs loads .env then spawns electron-builder as a
// CHILD of the same process, which inherits process.env.
