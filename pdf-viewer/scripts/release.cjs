#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════
   Volt — signed release wrapper (npm run release)

   Releasing unsigned is exactly how SmartScreen warnings start — and
   once a cert is configured, `verifyUpdateCodeSignature` makes the
   auto-updater REJECT any update not signed by the same publisher, so
   a release must always be signed. This wrapper therefore:
     1. requires a code-signing certificate (CSC_LINK / WIN_CSC_LINK
        + CSC_KEY_PASSWORD / WIN_CSC_KEY_PASSWORD),
     2. refuses SELF-SIGNED / expired / keyless certs (signing-setup
        check-release) — publishing with a dev cert would SmartScreen
        every user AND break their auto-updates (untrusted chain),
     3. builds + publishes with electron-builder (`--win nsis
        --publish always` — extra CLI args pass through, e.g.
        `-c.publish.provider=generic -c.publish.url=https://…`),
     4. runs scripts/check-signing.cjs and exits non-zero unless the
        artifacts verify as signed by the configured publisher.

   CSC_LINK may be a path to a .pfx OR a base64-encoded .pfx (handy
   for CI secrets). Without a cert, `npm run dist` still works for
   dev/private builds.

   Usage:  npm run release [electron-builder args…]
   ═══════════════════════════════════════════════════════════════ */
"use strict";
const { spawnSync } = require("node:child_process");
const { join } = require("node:path");
require("./load-env.cjs")(); // CSC_LINK/CSC_KEY_PASSWORD from .env (env vars win)

const cscLink = (process.env.WIN_CSC_LINK || process.env.CSC_LINK || "").trim();
if (!cscLink) {
  console.error("❌ release requires a code-signing certificate (SmartScreen + updater signature verification).\n" +
    "   Set CSC_LINK (path or base64 of the .pfx) and CSC_KEY_PASSWORD, e.g.:\n" +
    "     CSC_LINK=C:\\certs\\volt.pfx CSC_KEY_PASSWORD=*** npm run release\n" +
    "   For unsigned dev/private builds use `npm run dist` instead.");
  process.exit(1);
}

// A configured cert is not enough: refuse to publish with a SELF-SIGNED
// certificate (SmartScreen for every user + the updater rejects untrusted
// chains, so every auto-update would fail), an expired cert, or one without
// a private key — see signing-setup.cjs check-release.
const certCheck = spawnSync(process.execPath, [join(__dirname, "signing-setup.cjs"), "check-release"], { stdio: "inherit" });
if (certCheck.status !== 0) {
  console.error("❌ release aborted by the certificate guard.");
  process.exit(certCheck.status === null ? 1 : certCheck.status);
}

const extraArgs = process.argv.slice(2);
console.log("· signing release with certificate from CSC_LINK (publisher verification will be active)");

// shell:true on win32 — spawning npx.cmd directly EINVALs on modern Node
const r = spawnSync(process.platform === "win32" ? "npx.cmd" : "npx",
  ["electron-builder", "--win", "nsis", "--publish", "always", ...extraArgs],
  { stdio: "inherit", timeout: 15 * 60 * 1000, shell: process.platform === "win32" });
if (r.status !== 0) {
  console.error("❌ electron-builder failed (status " + r.status + ")");
  process.exit(r.status === null ? 1 : r.status);
}

const check = spawnSync(process.execPath, [join(__dirname, "check-signing.cjs")], { stdio: "inherit" });
process.exit(check.status === 0 ? 0 : 1);
