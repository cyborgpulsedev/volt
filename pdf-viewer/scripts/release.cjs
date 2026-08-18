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

   SCRATCH UNSIGNED RELEASES (feed-mechanics testing only): set
   VOLT_ALLOW_UNSIGNED=1 to skip the certificate requirement, the
   self-signed guard, and the sign:check gate, publishing an UNSIGNED
   build. This is the deliberate escape hatch behind the release
   workflow's scratch_unsigned input — the ONLY legitimate use is
   proving the publish/feed pipeline works before a real cert lands
   (e.g. that the auto-update feed URL serves a real latest.yml). An
   unsigned release means SmartScreen warnings for every user and NO
   updater signature verification — delete the scratch release after
   verifying.

   Usage:  npm run release [electron-builder args…]
   ═══════════════════════════════════════════════════════════════ */
"use strict";
const { spawnSync } = require("node:child_process");
const { join } = require("node:path");
require("./load-env.cjs")(); // CSC_LINK/CSC_KEY_PASSWORD from .env (env vars win)

// SCRATCH UNSIGNED releases: VOLT_ALLOW_UNSIGNED=1 skips the certificate
// requirement, the cert guard, and the sign:check gate — the deliberate
// escape hatch behind the release workflow's scratch_unsigned input. The
// ONLY legitimate use is proving the publish/feed pipeline before a real
// cert lands; an unsigned release means SmartScreen warnings and NO updater
// signature verification for every user.
const allowUnsigned = process.env.VOLT_ALLOW_UNSIGNED === "1";

const cscLink = (process.env.WIN_CSC_LINK || process.env.CSC_LINK || "").trim();
if (!cscLink && !allowUnsigned) {
  console.error("❌ release requires a code-signing certificate (SmartScreen + updater signature verification).\n" +
    "   Set CSC_LINK (path or base64 of the .pfx) and CSC_KEY_PASSWORD, e.g.:\n" +
    "     CSC_LINK=C:\\certs\\volt.pfx CSC_KEY_PASSWORD=*** npm run release\n" +
    "   For unsigned dev/private builds use `npm run dist` instead.");
  process.exit(1);
}

if (allowUnsigned) {
  console.warn("⚠ SCRATCH UNSIGNED RELEASE (VOLT_ALLOW_UNSIGNED=1) — publishing an UNSIGNED build.\n" +
    "   SmartScreen will warn every user and the updater's signature verification is OFF.\n" +
    "   Feed-mechanics testing only — delete this release after verifying.");
} else {
  // A configured cert is not enough: refuse to publish with a SELF-SIGNED
  // certificate (SmartScreen for every user + the updater rejects untrusted
  // chains, so every auto-update would fail), an expired cert, or one without
  // a private key — see signing-setup.cjs check-release.
  const certCheck = spawnSync(process.execPath, [join(__dirname, "signing-setup.cjs"), "check-release"], { stdio: "inherit" });
  if (certCheck.status !== 0) {
    console.error("❌ release aborted by the certificate guard.");
    process.exit(certCheck.status === null ? 1 : certCheck.status);
  }
}

const extraArgs = process.argv.slice(2);
console.log(allowUnsigned
  ? "· building UNSIGNED (scratch mode — no publisher verification will be active)"
  : "· signing release with certificate from CSC_LINK (publisher verification will be active)");

// shell:true on win32 — spawning npx.cmd directly EINVALs on modern Node
const r = spawnSync(process.platform === "win32" ? "npx.cmd" : "npx",
  ["electron-builder", "--win", "nsis", "--publish", "always", ...extraArgs],
  { stdio: "inherit", timeout: 15 * 60 * 1000, shell: process.platform === "win32" });
if (r.status !== 0) {
  console.error("❌ electron-builder failed (status " + r.status + ")");
  process.exit(r.status === null ? 1 : r.status);
}

if (allowUnsigned) {
  console.log("⚠ scratch unsigned build published — sign:check skipped by design.");
  process.exit(0);
}

const check = spawnSync(process.execPath, [join(__dirname, "check-signing.cjs")], { stdio: "inherit" });
process.exit(check.status === 0 ? 0 : 1);
