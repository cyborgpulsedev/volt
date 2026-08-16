#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════
   Volt — code-signing certificate flow (npm run sign:setup)

   One entry point for everything around the signing certificate:

     node scripts/signing-setup.cjs                     # = status
     node scripts/signing-setup.cjs status [--json]     # cert + toolchain state
     node scripts/signing-setup.cjs dev-cert [--password <pw>] [--force]
                                        # generate a SELF-SIGNED dev cert
                                        # (exercises the whole pipeline; NOT
                                        #  trusted by SmartScreen/users)
     node scripts/signing-setup.cjs import <pfx> [password]
                                        # adopt a real cert (PFX) from a CA
     node scripts/signing-setup.cjs trust              # trust the dev cert in
                                        # CurrentUser\Root (only needed to
                                        # exercise the UPDATER's runtime
                                        # signature verification locally)
     node scripts/signing-setup.cjs untrust            # remove that trust
     node scripts/signing-setup.cjs clear              # drop signing config

   Config lives in <pdf-viewer>/.env (gitignored) and is picked up by
   npm run dist / dist:dir / release / sign:check / test:release-feed
   via scripts/load-env.cjs — real environment variables always win
   over the file (CI/export > local .env).

   Windows-only for the cert operations (PowerShell: New-SelfSigned-
   Certificate / X509Certificate2 / Get-AuthenticodeSignature).
   ═══════════════════════════════════════════════════════════════ */
"use strict";
const { spawnSync } = require("node:child_process");
const { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } = require("node:fs");
const { join, resolve, basename } = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const loadEnv = require("./load-env.cjs");

const ROOT = join(__dirname, "..");
const CERTS = join(ROOT, "certs");
const ENV_FILE = loadEnv.ENV_FILE;
const DIST = join(ROOT, "dist");
const DEV_JSON = join(CERTS, "volt-dev.json");

const isWin = process.platform === "win32";
const sq = (s) => String(s).replace(/'/g, "''");
// set in main(): whether CSC_LINK was in the REAL environment (vs .env)
let cscCameFromEnv = false;

/* ── PowerShell runner: prints __ERR__ + message on failure ────── */
function ps(script, timeoutMs = 120000) {
  if (!isWin) throw new Error("this operation needs Windows PowerShell (New-SelfSignedCertificate / cert stores)");
  const r = spawnSync("powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
  const out = String(r.stdout || "").trim();
  if (r.status !== 0 || out.startsWith("__ERR__")) {
    const msg = out.startsWith("__ERR__") ? out.slice(7)
      : String(r.stderr || "").trim() || ("PowerShell exit " + r.status);
    throw new Error(msg);
  }
  return out;
}

function psJson(script) {
  const raw = ps(script);
  try { return JSON.parse(raw); } catch (e) { throw new Error("unparseable PowerShell output: " + raw.slice(0, 200)); }
}

/* ── certificate helpers ───────────────────────────────────────── */
function inspectPfx(path, pw) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$path = '${sq(path)}'`,
    `$pw = '${sq(pw || "")}'`,
    "$flags = [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::DefaultKeySet",
    "$cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2",
    "try {",
    "  if ($pw -eq '') { $cert.Import($path, $null, $flags) } else { $cert.Import($path, $pw, $flags) }",
    "} catch {",
    "  Write-Output ('__ERR__' + $_.Exception.Message)",
    "  exit 1",
    "}",
    "$days = ($cert.NotAfter - (Get-Date)).TotalDays",
    "[pscustomobject]@{",
    "  Subject = $cert.Subject",
    "  Issuer = $cert.Issuer",
    "  Thumbprint = $cert.Thumbprint",
    "  NotAfter = $cert.NotAfter.ToString('yyyy-MM-dd')",
    "  HasPrivateKey = $cert.HasPrivateKey",
    "  SelfSigned = ($cert.Issuer -eq $cert.Subject)",
    "  Expired = ($days -lt 0)",
    "  ExpiringSoon = ($days -lt 30)",
    "} | ConvertTo-Json -Compress",
  ].join("\n");
  return psJson(script);
}

function certConfigured() {
  return Boolean((process.env.WIN_CSC_LINK || process.env.CSC_LINK || "").trim());
}

function linkKind(link) {
  if (!link) return "none";
  if (/^data:.*;base64,/i.test(link) || link.startsWith("https://")) return link.startsWith("https://") ? "url" : "base64";
  if (link.length > 2048 || link.endsWith("=")) return "base64";
  return "path";
}

function resolveLinkToFile(link) {
  // returns { file, kind } for a CSC_LINK — path stays, base64/url are
  // materialized to a temp file so the cert can be inspected.
  const kind = linkKind(link);
  if (kind === "path") {
    const abs = resolve(ROOT, link.replace(/^~\//, os.homedir() + "/"));
    return { file: abs, kind };
  }
  if (kind === "url") return { file: null, kind };
  mkdirSync(CERTS, { recursive: true });
  const tmp = join(CERTS, ".tmp-" + crypto.randomBytes(6).toString("hex") + ".pfx");
  const b64 = link.replace(/^data:.*;base64,/i, "");
  writeFileSync(tmp, Buffer.from(b64, "base64"));
  return { file: tmp, kind };
}

function findSigntool() {
  const cache = join(os.homedir(), "AppData", "Local", "electron-builder", "Cache", "winCodeSign");
  if (!existsSync(cache)) return null;
  const hits = [];
  (function walk(dir, depth) {
    if (depth > 5) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (/^signtool\.exe$/i.test(e.name)) hits.push(p);
    }
  })(cache, 0);
  return hits.find((p) => /(x64|amd64)/i.test(p)) || hits[0] || null;
}

/* ── artifact signature state (informational) ──────────────────── */
function exeSignature() {
  const exe = join(DIST, "win-unpacked", "Volt.exe");
  if (!existsSync(exe)) return null;
  try {
    const d = psJson([
      "$ErrorActionPreference = 'SilentlyContinue'",
      `Get-AuthenticodeSignature -LiteralPath '${sq(exe)}' | ConvertTo-Json -Compress`,
    ].join("\n"));
    return {
      status: d.Status,
      subject: d.SignerCertificate ? d.SignerCertificate.Subject : null,
      message: String(d.StatusMessage || ""),
    };
  } catch (e) { return { error: String(e.message) }; }
}

/* ── .env read/write ───────────────────────────────────────────── */
function readEnvLines() {
  if (!existsSync(ENV_FILE)) return [];
  return readFileSync(ENV_FILE, "utf8").split(/\r?\n/);
}

// Quoting that matches scripts/load-env.cjs: values are wrapped in double
// quotes only when they need it; embedded double quotes become \" (load-env
// unescapes those). Backslashes are LITERAL throughout — Windows paths and
// hex passwords stay single-backslash (load-env does no \ escape processing).
function envQuote(val) {
  if (val === "") return '""';
  if (/[ #"']/.test(val)) return '"' + String(val).replace(/"/g, '\\"') + '"';
  return val;
}

function writeEnv(entries) {
  let lines = readEnvLines();
  const keys = new Set(entries.map((e) => e.key));
  lines = lines.filter((l) => {
    const k = l.trim().split("=")[0];
    return k && !keys.has(k);
  });
  if (!lines.some((l) => l.trim().startsWith("# Volt"))) {
    lines.unshift("# Volt code-signing configuration — written by node scripts/signing-setup.cjs");
  }
  for (const e of entries) lines.push(`${e.key}=${envQuote(e.value)}`);
  writeFileSync(ENV_FILE, lines.join("\n") + "\n");
}

function clearEnvKeys(keys) {
  if (!existsSync(ENV_FILE)) { console.log("· no .env — nothing to clear"); return; }
  const lines = readEnvLines().filter((l) => {
    const k = l.trim().split("=")[0];
    return !k || !keys.includes(k);
  });
  writeFileSync(ENV_FILE, lines.join("\n") + "\n");
  console.log("✅ removed " + keys.join(", ") + " from " + ENV_FILE);
}

/* ── commands ──────────────────────────────────────────────────── */
function cmdStatus(showJson) {
  const csc = certConfigured();
  const info = { configured: csc };
  let pw = "";
  if (csc) {
    const link = (process.env.WIN_CSC_LINK || process.env.CSC_LINK || "").trim();
    pw = (process.env.WIN_CSC_KEY_PASSWORD || process.env.CSC_KEY_PASSWORD || "");
    const { file, kind } = resolveLinkToFile(link);
    info.linkKind = kind;
    info.linkSource = cscCameFromEnv ? "environment" : ".env";
    if (kind === "path" || kind === "base64") {
      try {
        const c = inspectPfx(file, pw);
        info.cert = { subject: c.Subject, notAfter: c.NotAfter, hasPrivateKey: c.HasPrivateKey, expired: c.Expired, expiringSoon: c.ExpiringSoon };
      } catch (e) {
        info.cert = { error: String(e.message) };
      }
    }
    if (kind === "base64" && file) { try { rmSync(file, { force: true }); } catch (e) {} }
  }
  info.signtool = findSigntool();
  const sig = exeSignature();
  if (sig) {
    info.artifacts = sig.status === 2 || sig.status === 3
      ? { signed: false, note: "not signed (status " + sig.status + ")" }
      : { signed: true, status: sig.status, subject: sig.subject || null };
  }

  if (showJson) { console.log(JSON.stringify(info, null, 2)); return; }

  console.log("── Volt code-signing state ──────────────────────────────");
  if (!csc) {
    console.log("  certificate : NOT configured — builds are UNSIGNED");
    console.log("  · get a real cert from a CA and run:");
    console.log("      npm run sign:setup import <your.pfx> [password]");
    console.log("    or generate a self-signed TEST cert:");
    console.log("      npm run sign:setup dev-cert");
  } else {
    const link = (process.env.WIN_CSC_LINK || process.env.CSC_LINK || "").trim();
    console.log(`  certificate : configured (${info.linkKind} form, from ${info.linkSource})`);
    console.log(`                CSC_LINK=${link.length > 80 ? link.slice(0, 40) + "…" + link.slice(-40) : link}`);
    if (info.cert) {
      if (info.cert.error) console.log("  cert file   : ⚠ could not read: " + info.cert.error);
      else {
        console.log("  subject     : " + info.cert.subject);
        console.log("  expires     : " + info.cert.notAfter + (info.cert.expired ? "  (EXPIRED — cannot sign!)" : info.cert.expiringSoon ? "  (⚠ <30 days left)" : ""));
        console.log("  private key : " + (info.cert.hasPrivateKey ? "present ✅" : "MISSING — cannot sign ❌"));
      }
    }
  }
  console.log("  signtool    : " + (info.signtool ? info.signtool : "not found (electron-builder will fetch winCodeSign at build time)"));
  if (info.artifacts) {
    console.log("  dist artifacts: " + (info.artifacts.signed
      ? "signed (" + (info.artifacts.subject || "subject unknown") + ")"
      : info.artifacts.note));
  }
  console.log("  .env file   : " + (existsSync(ENV_FILE) ? ENV_FILE + " (gitignored)" : "none — config can also come from environment variables"));
  console.log("──────────────────────────────────────────────────────────");
}

function cmdDevCert(password, force) {
  if (!password) password = crypto.randomBytes(12).toString("hex");
  mkdirSync(CERTS, { recursive: true });
  const pfx = join(CERTS, "volt-dev.pfx");
  const cer = join(CERTS, "volt-dev.cer");
  if (existsSync(pfx) || existsSync(cer)) {
    if (!force) {
      console.error("❌ " + pfx + " already exists — re-running would overwrite your dev cert. Pass --force to regenerate.");
      process.exit(1);
    }
    for (const f of [pfx, cer, DEV_JSON]) { try { rmSync(f, { force: true }); } catch (e) {} }
  }
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$pfx = '${sq(pfx)}'`,
    `$cer = '${sq(cer)}'`,
    `$pw = '${sq(password)}'`,
    "$thumb = $null",
    "$cert = $null",
    "try {",
    "  $cert = New-SelfSignedCertificate -Subject 'CN=Volt Dev Signing, O=Volt' -Type CodeSigningCert -KeyAlgorithm RSA -KeyLength 2048 -CertStoreLocation Cert:\\CurrentUser\\My -NotAfter (Get-Date).AddYears(1)",
    "  $thumb = $cert.Thumbprint",
    "  $secure = ConvertTo-SecureString -String $pw -AsPlainText -Force",
    "  Export-PfxCertificate -Cert $cert -FilePath $pfx -Password $secure | Out-Null",
    "  Export-Certificate -Cert $cert -FilePath $cer | Out-Null",
    "} catch {",
    "  if ($thumb) { try { Remove-Item ('Cert:\\CurrentUser\\My\\' + $thumb) -Force -ErrorAction SilentlyContinue } catch {} }",
    "  Write-Output ('__ERR__' + $_.Exception.Message)",
    "  exit 1",
    "}",
    "# keep the machine clean — the PFX (with key) and CER (public only) are the copies",
    "try { Remove-Item ('Cert:\\CurrentUser\\My\\' + $thumb) -Force -ErrorAction SilentlyContinue } catch {}",
    "[pscustomobject]@{",
    "  Subject = $cert.Subject",
    "  Thumbprint = $thumb",
    "  NotAfter = $cert.NotAfter.ToString('yyyy-MM-dd')",
    "  Pfx = $pfx",
    "  Cer = $cer",
    "} | ConvertTo-Json -Compress",
  ].join("\n");
  const c = psJson(script);

  writeFileSync(DEV_JSON, JSON.stringify({
    subject: c.Subject, thumbprint: c.Thumbprint, notAfter: c.NotAfter,
    pfx: c.Pfx, cer: c.Cer, created: new Date().toISOString(),
  }, null, 2) + "\n");

  writeEnv([
    { key: "CSC_LINK", value: pfx },
    { key: "CSC_KEY_PASSWORD", value: password },
  ]);

  console.log("✅ self-signed DEV signing cert created and configured:");
  console.log("   subject  : " + c.Subject);
  console.log("   expires  : " + c.NotAfter);
  console.log("   pfx      : " + c.Pfx + "  (written to .env as CSC_LINK)");
  console.log("   cer      : " + c.Cer);
  console.log("");
  console.log("⚠  THIS IS A TEST CERT — treat it as such:");
  console.log("   • it signs the artifacts and arms the updater's publisherName");
  console.log("     check, but Windows/SmartScreen will NOT trust it, and end");
  console.log("     users would still get the unknown-publisher warning.");
  console.log("   • for production, buy a real code-signing cert from a CA and");
  console.log("     run:  npm run sign:setup import <your.pfx> [password]");
  console.log("");
  console.log("Next:  npm run dist            # signed build");
  console.log("       npm run sign:check      # gate: artifacts signed by this publisher");
  console.log("       npm run sign:setup trust  # optional: trust the dev root so the");
  console.log("                                  # updater's RUNTIME signature check can be");
  console.log("                                  # exercised locally (npm run test:release-feed)");
}

function cmdImport(pfxArg, password) {
  if (!pfxArg) {
    console.error("❌ usage: node scripts/signing-setup.cjs import <path-to.pfx> [password]");
    process.exit(1);
  }
  if (!existsSync(pfxArg)) {
    console.error("❌ not found: " + pfxArg);
    process.exit(1);
  }
  const pfx = resolve(pfxArg);
  let c;
  try {
    c = inspectPfx(pfx, password || "");
  } catch (e) {
    console.error("❌ could not read the PFX: " + e.message);
    console.error("   (if it is password-protected, pass the password as the second argument)");
    process.exit(1);
  }
  if (!c.HasPrivateKey) {
    console.error("❌ " + basename(pfx) + " has NO private key — a code-signing PFX must include it.");
    process.exit(1);
  }
  if (c.Expired) {
    console.error("❌ this certificate expired " + c.NotAfter + " — expired certs cannot sign.");
    process.exit(1);
  }
  if (c.ExpiringSoon) console.log("⚠ certificate expires " + c.NotAfter + " (< 30 days) — plan a renewal soon.");
  writeEnv([
    { key: "CSC_LINK", value: pfx },
    { key: "CSC_KEY_PASSWORD", value: password || "" },
  ]);
  console.log("✅ certificate configured:");
  console.log("   subject : " + c.Subject);
  console.log("   expires : " + c.NotAfter);
  console.log("   .env    : " + ENV_FILE);
  console.log("   Next: npm run dist  →  npm run sign:check");
}

function cmdTrust() {
  if (!existsSync(DEV_JSON)) {
    console.error("❌ no certs/volt-dev.json — generate the dev cert first: npm run sign:setup dev-cert");
    process.exit(1);
  }
  const dev = JSON.parse(readFileSync(DEV_JSON, "utf8"));
  if (!existsSync(dev.cer)) {
    console.error("❌ missing " + dev.cer + " — regenerate with npm run sign:setup dev-cert --force");
    process.exit(1);
  }
  const c = psJson([
    "$ErrorActionPreference = 'Stop'",
    `$cer = '${sq(dev.cer)}'`,
    `$tp = '${sq(dev.thumbprint)}'`,
    "$existing = Get-ChildItem Cert:\\CurrentUser\\Root | Where-Object { $_.Thumbprint -eq $tp }",
    "if ($existing) { Write-Output '{\"already\": true}'; exit 0 }",
    "$imported = Import-Certificate -FilePath $cer -CertStoreLocation Cert:\\CurrentUser\\Root",
    "[pscustomobject]@{ Thumbprint = $imported.Thumbprint } | ConvertTo-Json -Compress",
  ].join("\n"));
  console.log("✅ dev root '" + dev.subject + "' installed in CurrentUser\\Root" + (c.already ? " (was already there)" : "") + ".");
  console.log("   Get-AuthenticodeSignature now reports Valid for files signed by it, so the");
  console.log("   updater's runtime check passes — npm run test:release-feed can prove it.");
  console.log("   Remove with:  npm run sign:setup untrust");
}

function cmdUntrust() {
  let tp = null;
  if (existsSync(DEV_JSON)) tp = JSON.parse(readFileSync(DEV_JSON, "utf8")).thumbprint;
  if (!tp) {
    console.error("❌ no certs/volt-dev.json thumbprint — nothing to remove by that key.");
    process.exit(1);
  }
  psJson([
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$tp = '${sq(tp)}'`,
    "Get-ChildItem Cert:\\CurrentUser\\Root | Where-Object { $_.Thumbprint -eq $tp } | Remove-Item -Force",
    "Write-Output '{\"removed\": true}'",
  ].join("\n"));
  console.log("✅ dev root removed from CurrentUser\\Root.");
}

/* ── release guard ────────────────────────────────────────────── */
// Called by scripts/release.cjs BEFORE publishing: refuses to ship with a
// certificate that would produce a broken release for end users — a
// SELF-SIGNED cert (SmartScreen warning for everyone + the updater's runtime
// check rejects untrusted chains, so every user's auto-update breaks), an
// expired cert, or one without a private key. Warns (does not fail) on <30
// days to expiry.
function cmdCheckRelease() {
  const link = (process.env.WIN_CSC_LINK || process.env.CSC_LINK || "").trim();
  const pw = (process.env.WIN_CSC_KEY_PASSWORD || process.env.CSC_KEY_PASSWORD || "");
  if (!link) {
    console.error("❌ no certificate configured — release requires one.");
    process.exit(1);
  }
  const { file, kind } = resolveLinkToFile(link);
  let c;
  try {
    c = inspectPfx(file, pw);
  } catch (e) {
    console.error("❌ cannot read the signing certificate: " + e.message);
    process.exit(1);
  } finally {
    // base64 CSC_LINKs were materialized to a temp file — clean up
    if (kind === "base64" && file) {
      try { rmSync(file, { force: true }); } catch (e) {}
    }
  }
  if (!c.HasPrivateKey) {
    console.error("❌ signing certificate has no private key — cannot sign.");
    process.exit(1);
  }
  if (c.Expired) {
    console.error("❌ signing certificate expired " + c.NotAfter + " — cannot sign.");
    process.exit(1);
  }
  if (c.SelfSigned) {
    console.error(
      "❌ REFUSING to release with a SELF-SIGNED certificate (" + c.Subject + ").\n" +
      "   Self-signed builds show SmartScreen warnings for every user AND the updater's\n" +
      "   signature verification rejects untrusted chains — every installed copy's\n" +
      "   auto-update would break. Get a real code-signing cert from a CA (DigiCert,\n" +
      "   Sectigo, …) and import it with:  npm run sign:setup import <your.pfx> [password]\n" +
      "   (the dev cert is for pipeline testing only — `npm run dist` signs with it fine).");
    process.exit(1);
  }
  if (c.ExpiringSoon) {
    console.log("⚠ certificate expires " + c.NotAfter + " (<30 days) — renew before it lapses.");
  }
  console.log("✅ release certificate OK: " + c.Subject + " (expires " + c.NotAfter + ")");
  process.exit(0);
}

/* ── dispatch ──────────────────────────────────────────────────── */
function main() {
  cscCameFromEnv = Boolean(process.env.WIN_CSC_LINK || process.env.CSC_LINK);
  loadEnv();
  const args = process.argv.slice(2);
  const cmd = args[0] || "status";

  switch (cmd) {
    case "status":
    case "--status": {
      const json = args.includes("--json");
      cmdStatus(json);
      break;
    }
    case "dev-cert": {
      let password = null;
      const pi = args.indexOf("--password");
      if (pi >= 0 && args[pi + 1]) password = args[pi + 1];
      cmdDevCert(password, args.includes("--force"));
      break;
    }
    case "import": {
      const password = args[2] !== undefined ? args[2] : null;
      cmdImport(args[1], password || "");
      break;
    }
    case "trust": cmdTrust(); break;
    case "untrust": cmdUntrust(); break;
    case "check-release": cmdCheckRelease(); break;
    case "clear": {
      clearEnvKeys(["CSC_LINK", "CSC_KEY_PASSWORD", "WIN_CSC_LINK", "WIN_CSC_KEY_PASSWORD"]);
      break;
    }
    case "-h": case "--help": {
      console.log("Volt signing setup — see the header of scripts/signing-setup.cjs for usage.");
      break;
    }
    default:
      console.error("❌ unknown command: " + cmd);
      console.error("   commands: status | dev-cert | import <pfx> [password] | trust | untrust | check-release | clear");
      process.exit(1);
  }
}

main();
