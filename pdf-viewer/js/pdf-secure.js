/* ═══════════════════════════════════════════════════════════════
   pdf-secure.js — Volt.Secure
   Locks a Volt-produced PDF with the PDF standard security handler
   (R=2, V=1, RC4-40) — the classic "open password / owner password /
   copy-print-modify permissions" mechanism every PDF reader
   implements. pdf-lib cannot WRITE encryption (it only reads it), so
   this module does the byte-level work itself over pdf-lib's clean
   output (classic xref table, no object streams — Volt controls the
   bytes it locks): it encrypts every string literal and stream with
   the per-object key (Algorithm 1), injects the /Encrypt dictionary,
   and rebuilds the xref + trailer so the result is a normal,
   standards-compliant encrypted PDF.

   The crypto itself (MD5, RC4, key derivation) lives in Utils as pure
   functions with unit tests; this module is the PDF-syntax walker
   that applies it. Verified end-to-end by the smoke's `secure` stage,
   which opens the locked file through pdf.js (the app's own reader).
   ═══════════════════════════════════════════════════════════════ */
(function (global) {
  "use strict";

  const Volt = global.Volt = global.Volt || {};

  Volt.Secure = {
    /** Lock PDF bytes (pdf-lib output) with the standard security handler.
        opts: { userPassword, ownerPassword,
                permissions: { printing, modifying, copying, annotations } }
        → a NEW Uint8Array that is a valid encrypted PDF. Pure-ish (no DOM). */
    lock(bytes, opts) {
      const o = opts || {};
      const perms = o.permissions || {};
      const src = this._latin1(bytes);
      const id = this._trailerId(src, bytes);
      const keys = Utils.pdfSecurityKeys(o.userPassword, o.ownerPassword, perms, id);
      const out = this._rebuildEncrypted(src, bytes, keys, id);
      return out;
    },

    /* ── document walk ──────────────────────────────────────── */

    /** Extract the trailer's first /ID element (16 bytes) — required by the
        security algorithms. Falls back to MD5 of the file when absent. */
    _trailerId(src, bytes) {
      const m = /\/ID\s*\[\s*<([0-9a-fA-F]+)>\s*<[0-9a-fA-F]*>\s*\]/.exec(src);
      if (m) {
        const b = this._hexToBytes(m[1]);
        if (b.length >= 16) return b.slice(0, 16);
      }
      return Utils.md5(bytes);
    },

    /** Rebuild the whole PDF: encrypt every object's strings/streams, append
        the /Encrypt dictionary, and rewrite xref/trailer/startxref so the
        result opens as a normal encrypted file. */
    _rebuildEncrypted(src, bytes, keys, id0) {
      // ── split: header | objects | xref+trailer+startxref ──
      const objRe = /(\d+)\s+(\d+)\s+obj[\r\n]/g;
      const objs = [];
      let m, lastEnd = 0;
      while ((m = objRe.exec(src))) {
        const bodyStart = objRe.lastIndex;
        const endRel = src.indexOf("\nendobj", bodyStart);
        const end = endRel < 0 ? src.length : endRel + 1; // include the "\n"
        objs.push({ num: parseInt(m[1], 10), gen: parseInt(m[2], 10), bodyStart, end });
        lastEnd = Math.max(lastEnd, end);
      }
      if (!objs.length) throw new Error("No PDF objects found — cannot lock");
      // the xref/trailer tail starts after the last object's endobj
      const tail = src.slice(lastEnd);
      // ── header: everything up to the FIRST object's start ──
      objRe.lastIndex = 0;
      const first = objRe.exec(src);
      const headEnd = first ? first.index : 0;
      const head = src.slice(0, headEnd);

      // ── encrypt each object, tracking its new byte offset ──
      let out = head;
      const offsets = {}; // objNum → byte offset
      for (const ob of objs) {
        offsets[ob.num] = out.length;
        const body = src.slice(ob.bodyStart, ob.end);
        const encBody = this._encryptObjectBody(body, ob.num, ob.gen, keys.key);
        out += ob.num + " " + ob.gen + " obj\n" + encBody + "\nendobj\n";
      }
      const maxNum = Math.max(...objs.map((o) => o.num));
      const encNum = maxNum + 1;
      const encDict = encNum + " 0 obj\n<< /Filter /Standard /V 1 /R 2 /O <" +
        this._toHex(keys.O) + "> /U <" + this._toHex(keys.U) + "> /P " +
        (keys.P >>> 0) + " /Length 40 >>\nendobj\n";
      offsets[encNum] = out.length;
      out += encDict;

      // ── xref table (classic, 20-byte rows, object-number order) ──
      const xrefOff = out.length;
      const size = maxNum + 2; // entry 0 + objects 1..maxNum+1
      let xref = "xref\n0 " + size + "\n0000000000 65535 f \n";
      for (let n = 1; n <= maxNum + 1; n++) {
        const off = offsets[n];
        xref += (off === undefined ? "0000000000" : String(off).padStart(10, "0")) + " 00000 n \n";
      }
      out += xref;

      // ── trailer: preserve Root/Info/ID, add /Encrypt, bump /Size, and
      //     guarantee the /ID the security algorithms (and readers) expect ──
      const trM = /trailer\s*<<([\s\S]*?)>>/.exec(tail);
      let inner = trM ? trM[1] : "";
      inner = inner.replace(/\/Size\s+\d+/, "");
      inner = inner.replace(/\/Encrypt\s+\d+\s+\d+\s+R/, "");
      if (!/\/ID\s*\[/.test(inner)) {
        const idHex = this._toHex(id0 || Utils.md5(bytes));
        inner += " /ID [<" + idHex + "> <" + idHex + ">]";
      }
      out += "trailer\n<< /Size " + size + " /Encrypt " + encNum + " 0 R" + inner + " >>\n";
      out += "startxref\n" + xrefOff + "\n%%EOF\n";
      return this._latin1ToBytes(out);
    },

    /* ── per-object string/stream encryption (Algorithm 1) ──── */

    /** Encrypt every string literal and stream in ONE object body with the
        object's key (Algorithm 1: MD5(key + objNum + genNum) → first 10
        bytes). Stream data is located via /Length (unchanged by RC4), so
        binary can never be mistaken for strings. */
    _encryptObjectBody(body, num, gen, key) {
      const oKey = Utils._pdfObjectKey(key, num, gen);
      // ── locate stream data spans (skip their binary) ──
      const masked = [];
      const streamRe = /stream[\r\n]/g;
      let m;
      while ((m = streamRe.exec(body))) {
        const after = m.index + m[0].length;
        const lenM = /\/Length\s+(\d+)/.exec(body.slice(Math.max(0, m.index - 240), m.index));
        let end;
        if (lenM) {
          end = after + parseInt(lenM[1], 10);
        } else {
          const em = /\r?\nendstream/.exec(body.slice(after));
          end = em ? after + em.index : body.length;
        }
        masked.push([after, end]);
      }
      const isMasked = (p) => { for (const [a, b] of masked) if (p >= a && p < b) return true; return false; };
      // ── walk: encrypt literal + hex strings and stream data (all outside
      //     the masked spans are verbatim; stream spans are RC4'd in place,
      //     same length so /Length stays valid) ──
      const parts = [];
      let i = 0;
      const bl = body.length;
      while (i < bl) {
        let maskEnd = -1;
        for (const [a, b] of masked) if (i >= a && i < b) { maskEnd = b; break; }
        if (maskEnd >= 0) {
          // stream data → encrypt in place (raw bytes, same length)
          const data = body.slice(i, maskEnd);
          const enc = Utils.rc4(oKey, this._latin1ToBytes(data));
          parts.push(this._latin1(enc));
          i = maskEnd;
          continue;
        }
        const c = body[i];
        if (c === "(") {
          let j = i + 1, depth = 1;
          while (j < bl && depth > 0) {
            if (body[j] === "\\") { j += 2; continue; }
            if (body[j] === "(") depth++;
            else if (body[j] === ")") depth--;
            j++;
          }
          const raw = this._unescapeLiteral(body.slice(i + 1, Math.max(i + 1, j - 1)));
          parts.push(this._escapeLiteralBytes(Utils.rc4(oKey, this._latin1ToBytes(raw))));
          i = j;
          continue;
        }
        if (c === "<" && body[i + 1] === "<") {
          // a dict opener — copy both chars, keep scanning INSIDE (its string
          // values still get encrypted)
          parts.push("<<");
          i += 2;
          continue;
        }
        if (c === ">" && body[i + 1] === ">") {
          parts.push(">>");
          i += 2;
          continue;
        }
        if (c === "<") {
          let j = i + 1;
          while (j < bl && body[j] !== ">") j++;
          const hex = body.slice(i + 1, j).replace(/\s+/g, "");
          const raw = this._hexToBytes(hex);
          parts.push("<" + this._toHex(Utils.rc4(oKey, raw)) + ">");
          i = Math.min(j + 1, bl);
          continue;
        }
        // copy verbatim until the next '(' / '<' / '>' / masked span
        let j = i;
        while (j < bl) {
          const c2 = body[j];
          if (c2 === "(" || c2 === "<" || c2 === ">" || isMasked(j)) break;
          j++;
        }
        parts.push(body.slice(i, j));
        i = j;
      }
      return parts.join("");
    },

    /* ── byte-string helpers ────────────────────────────────── */

    _unescapeLiteral(s) {
      let out = "";
      for (let i = 0; i < s.length; i++) {
        if (s[i] !== "\\") { out += s[i]; continue; }
        const c = s[i + 1];
        if (c === "n") { out += "\n"; i++; }
        else if (c === "r") { out += "\r"; i++; }
        else if (c === "t") { out += "\t"; i++; }
        else if (c === "b") { out += "\b"; i++; }
        else if (c === "f") { out += "\f"; i++; }
        else if (c === "(") { out += "("; i++; }
        else if (c === ")") { out += ")"; i++; }
        else if (c === "\\") { out += "\\"; i++; }
        else if (c >= "0" && c <= "7") {
          let v = "", j = i + 1;
          for (let q = 0; q < 3 && j < s.length && s[j] >= "0" && s[j] <= "7"; q++, j++) v += s[j];
          out += String.fromCharCode(parseInt(v, 8));
          i = j - 1;
        }
        else { out += c; i++; }
      }
      return out;
    },

    /** Escape arbitrary bytes as a PDF literal string body "(...)" — RC4
        output is opaque, so every byte is written safely (octal for
        non-printables). */
    _escapeLiteralBytes(bytes) {
      let out = "(";
      for (const b of bytes) {
        if (b === 40) out += "\\(";
        else if (b === 41) out += "\\)";
        else if (b === 92) out += "\\\\";
        else if (b === 13) out += "\\r";
        else if (b === 10) out += "\\n";
        else if (b === 9) out += "\\t";
        else if (b < 32 || b > 126) out += "\\" + b.toString(8).padStart(3, "0");
        else out += String.fromCharCode(b);
      }
      return out + ")";
    },

    _hexToBytes(hex) {
      const h = String(hex || "").replace(/\s+/g, "");
      const out = new Uint8Array(Math.ceil(h.length / 2));
      for (let i = 0; i < out.length; i++) {
        out[i] = parseInt(h.slice(i * 2, i * 2 + 2) || "0", 16) || 0;
      }
      return out;
    },

    _toHex(bytes) {
      return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
    },

    _latin1(bytes) {
      const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      let s = "";
      for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
      return s;
    },

    _latin1ToBytes(s) {
      const out = new Uint8Array(s.length);
      for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 255;
      return out;
    },
  };
})(window);
