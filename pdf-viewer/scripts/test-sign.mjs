// Unit tests for pdf-sign.js (Volt.Sign): the pure-JS TripleDES against
// Node's crypto, PKCS#12 parsing + the full sign → re-verify chain against
// the LOCAL dev signing PFX (certs/volt-dev.pfx — gitignored, so the suite
// soft-skips the cert-dependent half on machines without it; CI stays green
// either way). Usage: node scripts/test-sign.mjs
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const src = readFileSync(join(__dirname, "..", "js", "pdf-sign.js"), "utf8");
const fn = new Function("window", "global", "Utils", src);
fn(globalThis, globalThis, globalThis.Utils);
const Sign = globalThis.Volt.Sign;

let pass = 0, fail = 0, skip = 0;
const t = (name, cond) => { if (cond) { pass++; console.log("  ✓ " + name); } else { fail++; console.log("  ✗ " + name); } };
const tSkip = (name) => { skip++; console.log("  ⤼ " + name + " (skipped)"); };

console.log("pdf-sign.js unit tests");

// ── TripleDES vs Node crypto ──
(() => {
  const key = crypto.randomBytes(24);
  const iv = crypto.randomBytes(8);
  const data = crypto.randomBytes(64);
  const cipher = crypto.createCipheriv("des-ede3-cbc", key, iv);
  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
  const mine = Sign._unpad(Sign._des3.cbcDecrypt(new Uint8Array(key), new Uint8Array(iv), new Uint8Array(encrypted)));
  t("3DES-CBC decrypt matches Node crypto", Buffer.compare(Buffer.from(mine), data) === 0);
  // empty-padding boundary: a full-block plaintext (padding adds a block)
  const data2 = crypto.randomBytes(8);
  const c2 = crypto.createCipheriv("des-ede3-cbc", key, iv);
  const enc2 = Buffer.concat([c2.update(data2), c2.final()]);
  const dec2 = Sign._unpad(Sign._des3.cbcDecrypt(new Uint8Array(key), new Uint8Array(iv), new Uint8Array(enc2)));
  t("3DES-CBC decrypt full-block matches", Buffer.compare(Buffer.from(dec2), data2) === 0);
})();

// ── PKCS#12 + full signing chain (needs the local dev PFX) ──
const certsDir = join(__dirname, "..", "certs");
const pfxPath = join(certsDir, "volt-dev.pfx");
if (!existsSync(pfxPath)) {
  tSkip("parsePfx on certs/volt-dev.pfx (not present)");
  tSkip("signPdf → /Sig + /ByteRange + cryptographic re-verify (not present)");
  tSkip("wrong PFX password is rejected (not present)");
} else {
  const env = readFileSync(join(__dirname, "..", ".env"), "utf8");
  const pwMatch = /^CSC_KEY_PASSWORD=(.*)$/m.exec(env);
  const password = pwMatch ? pwMatch[1].trim() : "";

  (async () => {
    const pfxBytes = new Uint8Array(readFileSync(pfxPath));
    let parsed;
    try {
      parsed = await Sign.parsePfx(pfxBytes, password);
    } catch (e) {
      t("parsePfx on certs/volt-dev.pfx", false);
      console.log("      error: " + e.message);
      finish();
      return;
    }
    t("parsePfx returns a PKCS#8 key + certs", !!parsed.key && Array.isArray(parsed.certs) && parsed.certs.length >= 1 && !!parsed.signer);
    t("parsed key imports as RSASSA key (Node)", (() => {
      try { crypto.createPrivateKey({ key: Buffer.from(parsed.key), format: "der", type: "pkcs8" }); return true; } catch (e) { return false; }
    })());
    t("signer cert parses as X.509 (Node)", (() => {
      try { const c = new crypto.X509Certificate(Buffer.from(parsed.signer)); return c.subject && c.serialNumber; } catch (e) { return false; }
    })());

    // wrong password must fail cleanly via the MAC check
    let wrongRejected = false;
    try { await Sign.parsePfx(pfxBytes, "definitely-wrong"); } catch (e) { wrongRejected = /password/i.test(e.message); }
    t("wrong PFX password is rejected (MAC)", wrongRejected);

    // ── full sign → verify round-trip ──
    const mLib = await import("file:///" + join(__dirname, "..", "vendor", "pdf-lib.min.js").replace(/\\/g, "/") + "?t=sign1");
    const PDFLib = mLib.default || mLib;
    globalThis.PDFLib = PDFLib;
    const doc = await PDFLib.PDFDocument.create();
    const helv = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
    doc.addPage([400, 300]).drawText("E-SIGN PROBE LINE", { x: 40, y: 220, size: 14, font: helv });
    const srcBytes = await doc.save({ useObjectStreams: false });

    let signed;
    try {
      signed = await Sign.signPdf(srcBytes, { pfxBytes, password, page: 1, reason: "Unit test" });
    } catch (e) {
      t("signPdf produces a signed PDF", false);
      console.log("      error: " + e.message + "\n" + (e.stack || "").split("\n").slice(0, 4).join("\n"));
      finish();
      return;
    }
    t("signPdf produces a signed PDF", !!signed && signed.byteLength > srcBytes.byteLength);
    const src = Buffer.from(signed).toString("latin1");
    t("contains /Filter /Adobe.PPKLite", src.includes("/Adobe.PPKLite"));
    t("contains /SubFilter /adbe.pkcs7.detached", src.includes("/adbe.pkcs7.detached"));
    t("contains /Sig field", src.includes("/Subtype /Widget") && src.includes("/FT /Sig"));

    // re-verify the signature cryptographically: parse the CMS out of
    // /Contents, walk it with a minimal DER reader, recompute the digest over
    // the /ByteRange, and check BOTH the RSA signature (over the signed
    // attributes, with the leaf cert from the CMS) and the messageDigest
    // attribute value.
    let verify = { ok: false };
    try {
      const br = /\/ByteRange \[(\d+) (\d+) (\d+) (\d+)\]/.exec(src);
      const ct = /\/Contents <([0-9a-fA-F]+)>/.exec(src);
      if (br && ct) {
        // /ByteRange [start1 len1 start2 len2] — covered = [start1,start1+len1) ∪ [start2,start2+len2)
        const s1 = Number(br[1]), l1 = Number(br[2]), s2 = Number(br[3]), l2 = Number(br[4]);
        const walk = (buf, off = 0) => {
          const tag = buf[off];
          let len = buf[off + 1], o = off + 2;
          if (len & 0x80) { const n = len & 0x7f; len = 0; for (let i = 0; i < n; i++) len = (len << 8) | buf[o++]; }
          return { tag, len, content: buf.subarray(o, o + len), next: o + len };
        };
        const kidsOf = (u8) => { const out = []; let p = 0; while (p < u8.length) { const k = walk(u8.subarray(p), 0); out.push(k); p += k.next; } return out; };
        const cms = Buffer.from(ct[1], "hex");
        const ci = walk(cms);                              // ContentInfo
        const sd = kidsOf(ci.content).find((k) => k.tag === 0xa0); // [0] EXPLICIT SignedData
        const sdInner = walk(sd.content, 0);               // the SignedData SEQUENCE itself
        const sdKids = kidsOf(sdInner.content);            // version, algs, encap, [0]certs, SET signerInfos
        const certBlock = sdKids.find((k) => k.tag === 0xa0);
        const signerInfos = sdKids.filter((k) => k.tag === 0x31).pop(); // LAST 0x31 = signerInfos (first is digestAlgorithms)
        const certSet = kidsOf(certBlock.content).find(() => true); // the SET of certs
        const leaf = kidsOf(certSet.content).find(() => true);      // first cert TLV
        // the full cert DER = tag + length + content (content alone won't parse)
        const leafDer = certSet.content.subarray(0, leaf.next);
        const xcert = new crypto.X509Certificate(Buffer.from(leafDer));
        const si = kidsOf(signerInfos.content).find((k) => k.tag === 0x30);
        const siKids = kidsOf(si.content);
        const signedAttrs = siKids.find((k) => k.tag === 0xa0);
        const signature = siKids.find((k) => k.tag === 0x04);
        const covered = Buffer.concat([signed.subarray(s1, s1 + l1), signed.subarray(s2, s2 + l2)]);
        const digest = crypto.createHash("sha256").update(covered).digest();
        const okSig = crypto.verify("sha256", signedAttrs.content, xcert.publicKey, Buffer.from(signature.content));
        let mdOk = false;
        const attrSet = kidsOf(signedAttrs.content).find(() => true); // the SET OF attributes (0x31)
        for (const attr of kidsOf(attrSet.content)) {
          for (const part of kidsOf(attr.content)) {
            const values = part.tag === 0x31 ? kidsOf(part.content) : [part]; // descend into the SET OF values
            for (const inner of values) {
              if (inner.tag === 0x04 && inner.len === 32 && Buffer.compare(Buffer.from(inner.content), digest) === 0) mdOk = true;
            }
          }
        }
        verify = { ok: okSig && mdOk, sigOk: okSig, mdOk };
      }
    } catch (e) {
      verify = { ok: false, err: e.message };
    }
    t("signature cryptographically verifies (RSA + messageDigest)", verify.ok === true);

    // the signed file still loads through pdf-lib + pdf.js
    let reloads = false;
    try {
      const re = await PDFLib.PDFDocument.load(signed, { ignoreEncryption: true });
      reloads = re.getPageCount() === 1;
    } catch (e) { reloads = false; }
    t("signed PDF reloads via pdf-lib", reloads);

    finish();
  })().catch((e) => { t("signing chain runs without throwing", false); console.log("      error: " + e.message); finish(); });
}

function finish() {
  console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped`);
  process.exit(fail ? 1 : 0);
}
if (!existsSync(pfxPath)) finish();
