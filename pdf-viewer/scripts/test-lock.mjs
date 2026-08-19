// End-to-end test for Volt.Secure (pdf-secure.js): locks REAL pdf-lib output
// and opens the locked bytes through the VENDORED pdf.js — the app's own
// reader and the exact path that used to reject its own password. Covers the
// 2026-08 regression (pad bytes, O-key truncation, low-byte password
// encoding, classic-xref requirement) so a locked export can never again
// refuse the correct password.
//
// Usage: node scripts/test-lock.mjs
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const root = join(__dirname, "..");

globalThis.window = globalThis;
globalThis.self = globalThis;

// utils.js + pdf-secure.js (browser IIFEs — run them against the global)
require(join(root, "js", "utils.js"));
const srcSecure = readFileSync(join(root, "js", "pdf-secure.js"), "utf8");
new Function("window", srcSecure)(globalThis);
const Secure = globalThis.Volt.Secure;

// vendored pdf-lib
const pdfLibSrc = readFileSync(join(root, "vendor", "pdf-lib.min.js"), "utf8");
const PDFLib = {};
new Function("exports", "module", pdfLibSrc)(PDFLib, { exports: PDFLib });

// vendored pdf.js (the app's reader)
const pdfjsLib = await import(pathToFileURL(join(root, "vendor", "pdf.min.mjs")).href);
pdfjsLib.GlobalWorkerOptions.workerSrc = pathToFileURL(join(root, "vendor", "pdf.worker.min.mjs")).href;

let pass = 0, fail = 0;
const t = (name, cond) => { if (cond) { pass++; console.log("  ✓ " + name); } else { fail++; console.log("  ✗ " + name); } };
console.log("Volt.Secure → vendored pdf.js end-to-end tests");

async function buildDoc(opts = {}) {
  const doc = await PDFLib.PDFDocument.create();
  for (let i = 0; i < (opts.pages || 1); i++) {
    const p = doc.addPage([opts.w || 300, opts.h || 300]);
    p.drawText(opts.text || ("page " + (i + 1)), { x: 20, y: 250, size: 16 });
  }
  return doc.save({ useObjectStreams: false });
}

async function tryOpen(bytes, password) {
  try {
    const task = pdfjsLib.getDocument({ data: bytes.slice(0), password, isEvalSupported: false, useSystemFonts: true });
    const d = await task.promise;
    const p = await d.getPage(1);
    const txt = (await p.getTextContent()).items.map((it) => it.str).join(" ");
    const pages = d.numPages;
    await d.destroy();
    return { ok: true, txt, pages };
  } catch (e) {
    return { ok: false, error: e.name + ": " + e.message };
  }
}

let allOk = true;

(async () => {
  // 1. the reported bug: correct ASCII password rejected → must now open
  {
    const bytes = await buildDoc({ text: "Hello locked world" });
    const locked = Secure.lock(bytes, {
      userPassword: "hunter2",
      ownerPassword: "owner-hunter2",
      permissions: { copying: false, printing: false, modifying: false, annotations: false },
    });
    const u = await tryOpen(locked, "hunter2");
    t("ASCII user password opens the locked PDF", u.ok && u.txt.includes("Hello locked world"));
    const o = await tryOpen(locked, "owner-hunter2");
    t("ASCII owner password opens the locked PDF", o.ok && o.txt.includes("Hello locked world"));
    const w = await tryOpen(locked, "wrong");
    t("wrong password is rejected", !w.ok && /Incorrect Password/.test(w.error));
    const e = await tryOpen(locked, "");
    t("empty password is rejected when one was set", !e.ok);
  }

  // 2. non-ASCII passwords (low-byte encoding must match pdf.js stringToBytes)
  {
    const bytes = await buildDoc({ text: "accented" });
    const locked = Secure.lock(bytes, {
      userPassword: "pässwörd",
      ownerPassword: "own-пароль",
      permissions: {},
    });
    const u = await tryOpen(locked, "pässwörd");
    t("non-ASCII user password opens the locked PDF", u.ok && u.txt.includes("accented"));
    const o = await tryOpen(locked, "own-пароль");
    t("non-ASCII owner password opens the locked PDF", o.ok);
  }

  // 3. the app's real usage: owner == user
  {
    const bytes = await buildDoc({ text: "app pattern" });
    const locked = Secure.lock(bytes, {
      userPassword: "secret",
      ownerPassword: "secret",
      permissions: { copying: false, printing: true, modifying: true, annotations: true },
    });
    const u = await tryOpen(locked, "secret");
    t("app pattern (owner==user): password opens", u.ok && u.txt.includes("app pattern"));
  }

  // 4. restrictions without a password still opens (empty pad path)
  {
    const bytes = await buildDoc({ text: "no pw" });
    const locked = Secure.lock(bytes, {
      userPassword: "",
      ownerPassword: "",
      permissions: { copying: false, printing: true, modifying: true, annotations: true },
    });
    const u = await tryOpen(locked, "");
    t("restrictions-only (empty password) opens", u.ok && u.txt.includes("no pw"));
  }

  // 5. multi-page document: every page decrypts
  {
    const bytes = await buildDoc({ pages: 3 });
    const locked = Secure.lock(bytes, {
      userPassword: "pw123",
      ownerPassword: "ow123",
      permissions: {},
    });
    const d = await (async () => {
      try {
        const task = pdfjsLib.getDocument({ data: locked.slice(0), password: "pw123", isEvalSupported: false, useSystemFonts: true });
        const doc = await task.promise;
        const t1 = (await (await doc.getPage(1)).getTextContent()).items.map((it) => it.str).join(" ");
        const t3 = (await (await doc.getPage(3)).getTextContent()).items.map((it) => it.str).join(" ");
        const pages = doc.numPages;
        await doc.destroy();
        return { ok: true, pages, t1, t3 };
      } catch (e) { return { ok: false, error: e.message }; }
    })();
    t("multi-page locked PDF: 3 pages, pages 1+3 decrypt", d.ok && d.pages === 3 && d.t1.includes("page 1") && d.t3.includes("page 3"));
  }

  // 6. the ObjStm guard: pdf-lib DEFAULT output must fail loudly, not export a broken lock
  {
    const doc = await PDFLib.PDFDocument.create();
    const p = doc.addPage([200, 200]);
    p.drawText("default save", { x: 20, y: 150, size: 14 });
    const bytes = await doc.save(); // object streams + xref stream
    let threw = "";
    try {
      Secure.lock(bytes, { userPassword: "x", ownerPassword: "y", permissions: {} });
    } catch (e) {
      threw = e.message || String(e);
    }
    t("object-stream input fails loudly with an actionable error", /useObjectStreams/.test(threw));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("test-lock crashed: " + (e && e.stack || e));
  process.exit(1);
});
