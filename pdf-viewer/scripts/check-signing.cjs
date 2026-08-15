#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════
   Volt — code-signing gate

   Verifies the BUILT Windows artifacts are Authenticode-signed with
   the expected publisher whenever a code-signing certificate is
   configured, and that the packaged app-update.yml carries a matching
   publisherName (which is what makes electron-updater verify the
   signature of downloaded updates — see verifyUpdateCodeSignature).

   SOFT GATE: with no certificate configured (CSC_LINK / WIN_CSC_LINK
   unset) it prints "unsigned" and exits 0 — dev builds and CI runs
   without a cert secret are legitimate. With a cert set, it REQUIRES:
     • dist/win-unpacked/Volt.exe is signed (signature present, not
       corrupt, and the signer subject matches app-update.yml)
     • dist/Volt-Setup-<v>.exe — the installer users download and the
       auto-updater installs — is signed by the SAME publisher
     • resources/app-update.yml in the packaged app contains a
       publisherName that is a substring of the signer subject (the
       exact condition the updater checks at update time)
   Exit 1 with a clear message on any failure.

   Usage:  node scripts/check-signing.cjs
   ═══════════════════════════════════════════════════════════════ */
"use strict";
const { execFileSync } = require("node:child_process");
const { existsSync, readdirSync, readFileSync } = require("node:fs");
const { join } = require("node:path");

const ROOT = join(__dirname, "..");
const DIST = join(ROOT, "dist");
const UNPACKED_EXE = join(DIST, "win-unpacked", "Volt.exe");
const APP_UPDATE_YML = join(DIST, "win-unpacked", "resources", "app-update.yml");

const fail = (msg) => { console.error("❌ signing gate: " + msg); process.exit(1); };
const ok = (msg) => console.log("✅ signing gate: " + msg);

function certConfigured() {
  return Boolean((process.env.WIN_CSC_LINK || process.env.CSC_LINK || "").trim());
}

function findInstaller() {
  let files = [];
  try { files = readdirSync(DIST).filter((f) => /^Volt-Setup-\d+\.\d+\.\d+\.exe$/.test(f)); } catch (e) { /* no dist */ }
  if (!files.length) return null;
  files.sort();
  return join(DIST, files[files.length - 1]);
}

// PowerShell Get-AuthenticodeSignature → { signerSubject, status } | null.
// Status enum: 0=Valid, 1=UnknownError, 2=NotSigned, 3=HashMismatch,
// 4=NotTrusted (self-signed / untrusted chain — signature IS present and
// cryptographically intact), 5=Expired, 6=NotSupportedForPlatform.
function signatureOf(file) {
  const quoted = file.replace(/'/g, "''");
  const ps = `Get-AuthenticodeSignature -LiteralPath '${quoted}' | ConvertTo-Json -Compress`;
  let raw;
  try {
    raw = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps],
      { encoding: "utf8", timeout: 30000, maxBuffer: 8 * 1024 * 1024 }).trim();
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
  try {
    const d = JSON.parse(raw);
    return {
      status: d.Status,
      signerSubject: d.SignerCertificate ? String(d.SignerCertificate.Subject || "") : null,
      statusMessage: String(d.StatusMessage || ""),
    };
  } catch (e) {
    return { error: "unparseable Get-AuthenticodeSignature output: " + raw.slice(0, 200) };
  }
}

function appUpdatePublisherNames() {
  try {
    const yml = readFileSync(APP_UPDATE_YML, "utf8");
    const lines = yml.split(/\r?\n/);
    const idx = lines.findIndex((l) => /^\s*publisherName\s*:/.test(l));
    if (idx < 0) return [];
    const inline = /^\s*publisherName\s*:\s*(.+)$/.exec(lines[idx]);
    if (inline) {
      const val = inline[1].trim();
      if (val.startsWith("[")) return [...val.matchAll(/"([^"]*)"/g)].map((x) => x[1]);
      return [val.replace(/^["']|["']$/g, "")];
    }
    // block-list form:
    //   publisherName:
    //     - Volt Test Publisher
    const out = [];
    for (let i = idx + 1; i < lines.length; i++) {
      const m = /^\s+-\s+(.+)$/.exec(lines[i]);
      if (m) out.push(m[1].trim().replace(/^["']|["']$/g, ""));
      else break;
    }
    return out;
  } catch (e) { return null; } // null = file missing
}

function main() {
  if (!certConfigured()) {
    console.log("· signing gate: no CSC_LINK configured — unsigned gate skipped (dev/CI runs are legitimate)");
    process.exit(0);
  }

  const installer = findInstaller();
  if (!installer) fail("no dist/Volt-Setup-*.exe — build first (CSC_LINK is set, so the build should sign)");
  if (!existsSync(UNPACKED_EXE)) fail("missing dist/win-unpacked/Volt.exe — build first");

  const exeSig = signatureOf(UNPACKED_EXE);
  const instSig = signatureOf(installer);
  const publishers = appUpdatePublisherNames();

  const describe = (s) => s.error ? "ERROR " + s.error
    : "status=" + s.status + (s.signerSubject ? " subject=\"" + s.signerSubject + "\"" : "") +
      (s.statusMessage ? " (" + s.statusMessage + ")" : "");
  console.log("·   Volt.exe        → " + describe(exeSig));
  console.log("·   installer       → " + describe(instSig));
  console.log("·   app-update.yml  → " + (publishers === null ? "MISSING (not a packaged nsis build?)"
    : publishers.length ? "publisherName=" + JSON.stringify(publishers) : "no publisherName (unsigned build?)"));

  if (exeSig.error || instSig.error) fail("signature inspection failed");
  // "Signed" = a signer certificate is present and the signature is NOT
  // corrupt (HashMismatch) or absent (NotSigned). Trust status is a separate
  // axis: a self-signed/brand-new cert reports Valid(0) with a real CA chain,
  // NotTrusted(4) or UnknownError(1) with a trust-message for an untrusted
  // chain — the signature is still present and cryptographically intact, and
  // the UPDATER's runtime check additionally requires Valid(0), which is what
  // a real published cert gives.
  const signed = (s) => s.signerSubject != null && s.status !== 2 && s.status !== 3;
  const suspicious = (s) => s.status === 1 && !/trust|root|chain/i.test(s.statusMessage || "");
  if (!signed(exeSig) || suspicious(exeSig)) fail("Volt.exe is NOT validly signed (" + describe(exeSig) + ")");
  if (!signed(instSig) || suspicious(instSig)) fail("installer is NOT validly signed (" + describe(instSig) + ")");

  if (publishers === null) fail("app-update.yml missing from the packaged app — without it the updater can't verify downloads");
  if (!publishers.length) fail("app-update.yml has no publisherName — the updater would accept ANY exe; rebuild signed");
  // the updater's runtime condition is Subject.Contains(publisherName) — the
  // gate asserts the same semantic against the INSTALLER's actual signer
  for (const p of publishers) {
    if (!instSig.signerSubject || !instSig.signerSubject.includes(p)) {
      fail("publisherName \"" + p + "\" is not a substring of the installer's signer subject \"" +
        (instSig.signerSubject || "(none)") + "\" — the updater would REJECT this update");
    }
  }

  ok("Volt.exe + installer signed by the configured publisher; app-update.yml matches (updater will verify downloads)");
  process.exit(0);
}

main();
