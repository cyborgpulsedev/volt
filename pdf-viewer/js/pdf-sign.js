/* ═══════════════════════════════════════════════════════════════
   pdf-sign.js — Volt.Sign
   Real digital signatures (e-sign): sign a PDF with an X.509
   certificate from a PKCS#12 (.pfx / .p12) file, producing a
   standards-compliant /Sig field that Adobe Acrobat, pdf.js and
   independent verifiers accept:

     • /Filter /Adobe.PPKLite, /SubFilter /adbe.pkcs7.detached
     • a /ByteRange covering everything but the signature hex, and
       /Contents holding a PKCS#7 (CMS) SignedData over the digest of
       that byte range (RFC 5652, detached, SHA-256 / RSA — the
       signature is over the signed attributes, as Adobe requires)
     • the signer certificate (+ chain) embedded in the CMS

   Everything is self-contained: ASN.1 DER, PKCS#12 decryption
   (PBES1-3DES and PBES2-AES, with the MAC verified so a wrong
   password fails cleanly), TripleDES in pure JS (Web Crypto has no
   3DES — verified against Node's crypto in the unit tests), and the
   byte surgery that patches the ByteRange + Contents in place without
   moving a single offset. Runs entirely in the renderer via Web
   Crypto (or Node's crypto in tests). Pure-ish: no DOM.
   ═══════════════════════════════════════════════════════════════ */
(function (global) {
  "use strict";

  /* ── ASN.1 DER ─────────────────────────────────────────────── */
  const _d = {
    len(n) {
      if (n < 0x80) return [n];
      const b = [];
      let v = n;
      while (v > 0) { b.unshift(v & 0xff); v >>>= 8; }
      return [0x80 | b.length, ...b];
    },
    tlv(tag, body) { return [tag, ...this.len(body.length), ...body]; },
    seq(...items) { return this.tlv(0x30, items.flat()); },
    setOf(...items) { return this.tlv(0x31, items.flat()); },
    oct(bytes) { return this.tlv(0x04, [...bytes]); },
    int(bytes) {
      let b = [...bytes];
      while (b.length > 1 && b[0] === 0 && !(b[1] & 0x80)) b.shift();
      if (b[0] & 0x80) b.unshift(0);
      return this.tlv(0x02, b);
    },
    oid(str) {
      const parts = String(str).split(".").map(Number);
      const body = [parts[0] * 40 + parts[1]];
      for (let i = 2; i < parts.length; i++) {
        let v = parts[i];
        const stack = [v & 0x7f];
        v >>>= 7;
        while (v > 0) { stack.unshift((v & 0x7f) | 0x80); v >>>= 7; }
        body.push(...stack);
      }
      return this.tlv(0x06, body);
    },
    nullv() { return [0x05, 0x00]; },
    utcTime(d) {
      const p = (n) => String(n).padStart(2, "0");
      const s = p(d.getUTCFullYear() % 100) + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) +
        p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds()) + "Z";
      return this.tlv(0x17, [...s].map((c) => c.charCodeAt(0)));
    },
    alg(oidStr, params) { return this.seq(this.oid(oidStr), ...(params ? [params] : [this.nullv()])); },

    /** Parse one TLV at offset; returns { tag, len, value (Uint8Array of the
        content), next (offset after this TLV) }. Definite lengths only. */
    read(u8, off) {
      let o = off;
      const tag = u8[o++];
      let len = u8[o++];
      if (len & 0x80) {
        const n = len & 0x7f;
        len = 0;
        for (let i = 0; i < n; i++) len = (len << 8) | u8[o++];
      }
      return { tag, len, value: u8.subarray(o, o + len), next: o + len };
    },
    /** Walk a SEQUENCE/context-of-TLVs; returns [{tag, value, next}]. */
    children(u8, start, end) {
      const out = [];
      let o = start;
      while (o < end) {
        const t = this.read(u8, o);
        out.push(t);
        o = t.next;
      }
      return out;
    },
    seqAt(u8, off) { return this.read(u8, off); }, // alias for clarity
  };

  /* ── TripleDES (pure JS — Web Crypto has no 3DES) ──────────── */
  const _des3 = (() => {
    const IP = [58, 50, 42, 34, 26, 18, 10, 2, 60, 52, 44, 36, 28, 20, 12, 4, 62, 54, 46, 38, 30, 22, 14, 6, 64, 56, 48, 40, 32, 24, 16, 8, 57, 49, 41, 33, 25, 17, 9, 1, 59, 51, 43, 35, 27, 19, 11, 3, 61, 53, 45, 37, 29, 21, 13, 5, 63, 55, 47, 39, 31, 23, 15, 7];
    const FP = [40, 8, 48, 16, 56, 24, 64, 32, 39, 7, 47, 15, 55, 23, 63, 31, 38, 6, 46, 14, 54, 22, 62, 30, 37, 5, 45, 13, 53, 21, 61, 29, 36, 4, 44, 12, 52, 20, 60, 28, 35, 3, 43, 11, 51, 19, 59, 27, 34, 2, 42, 10, 50, 18, 58, 26, 33, 1, 41, 9, 49, 17, 57, 25];
    const E = [32, 1, 2, 3, 4, 5, 4, 5, 6, 7, 8, 9, 8, 9, 10, 11, 12, 13, 12, 13, 14, 15, 16, 17, 16, 17, 18, 19, 20, 21, 20, 21, 22, 23, 24, 25, 24, 25, 26, 27, 28, 29, 28, 29, 30, 31, 32, 1];
    const P = [16, 7, 20, 21, 29, 12, 28, 17, 1, 15, 23, 26, 5, 18, 31, 10, 2, 8, 24, 14, 32, 27, 3, 9, 19, 13, 30, 6, 22, 11, 4, 25];
    const PC1 = [57, 49, 41, 33, 25, 17, 9, 1, 58, 50, 42, 34, 26, 18, 10, 2, 59, 51, 43, 35, 27, 19, 11, 3, 60, 52, 44, 36, 63, 55, 47, 39, 31, 23, 15, 7, 62, 54, 46, 38, 30, 22, 14, 6, 61, 53, 45, 37, 29, 21, 13, 5, 28, 20, 12, 4];
    const PC2 = [14, 17, 11, 24, 1, 5, 3, 28, 15, 6, 21, 10, 23, 19, 12, 4, 26, 8, 16, 7, 27, 20, 13, 2, 41, 52, 31, 37, 47, 55, 30, 40, 51, 45, 33, 48, 44, 49, 39, 56, 34, 53, 46, 42, 50, 36, 29, 32];
    const SHIFTS = [1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1];
    // prettier-ignore
    const S = [
      [14,4,13,1,2,15,11,8,3,10,6,12,5,9,0,7,0,15,7,4,14,2,13,1,10,6,12,11,9,5,3,8,4,1,14,8,13,6,2,11,15,12,9,7,3,10,5,0,15,12,8,2,4,9,1,7,5,11,3,14,10,0,6,13],
      [15,1,8,14,6,11,3,4,9,7,2,13,12,0,5,10,3,13,4,7,15,2,8,14,12,0,1,10,6,9,11,5,0,14,7,11,10,4,13,1,5,8,12,6,9,3,2,15,13,8,10,1,3,15,4,2,11,6,7,12,0,5,14,9],
      [10,0,9,14,6,3,15,5,1,13,12,7,11,4,2,8,13,7,0,9,3,4,6,10,2,8,5,14,12,11,15,1,13,6,4,9,8,15,3,0,11,1,2,12,5,10,14,7,1,10,13,0,6,9,8,7,4,15,14,3,11,5,2,12],
      [7,13,14,3,0,6,9,10,1,2,8,5,11,12,4,15,13,8,11,5,6,15,0,3,4,7,2,12,1,10,14,9,10,6,9,0,12,11,7,13,15,1,3,14,5,2,8,4,3,15,0,6,10,1,13,8,9,4,5,11,12,7,2,14],
      [2,12,4,1,7,10,11,6,8,5,3,15,13,0,14,9,14,11,2,12,4,7,13,1,5,0,15,10,3,9,8,6,4,2,1,11,10,13,7,8,15,9,12,5,6,3,0,14,11,8,12,7,1,14,2,13,6,15,0,9,10,4,5,3],
      [12,1,10,15,9,2,6,8,0,13,3,4,14,7,5,11,10,15,4,2,7,12,9,5,6,1,13,14,0,11,3,8,9,14,15,5,2,8,12,3,7,0,4,10,1,13,11,6,4,3,2,12,9,5,15,10,11,14,1,7,6,0,8,13],
      [4,11,2,14,15,0,8,13,3,12,9,7,5,10,6,1,13,0,11,7,4,9,1,10,14,3,5,12,2,15,8,6,1,4,11,13,12,3,7,14,10,15,6,8,0,5,9,2,6,11,13,8,1,4,10,7,9,5,0,15,14,2,3,12],
      [13,2,8,4,6,15,11,1,10,9,3,14,5,0,12,7,1,15,13,8,10,3,7,4,12,5,6,11,0,14,9,2,7,11,4,1,9,12,14,2,0,6,10,13,15,3,5,8,2,1,14,7,4,10,8,13,15,12,9,0,3,5,6,11],
    ];
    const permute = (bits, table) => table.map((p) => bits[p - 1]);
    const rol = (arr, n) => arr.slice(n).concat(arr.slice(0, n));

    function subkeys(key) {
      const k = permute(key, PC1);
      let c = k.slice(0, 28), d = k.slice(28);
      const keys = [];
      for (let i = 0; i < 16; i++) {
        c = rol(c, SHIFTS[i]); d = rol(d, SHIFTS[i]);
        keys.push(permute(c.concat(d), PC2));
      }
      return keys;
    }
    function f(r, k) {
      const e = permute(r, E);
      const x = e.map((b, i) => (b ^ k[i]) >>> 0);
      let out = [];
      for (let s = 0; s < 8; s++) {
        const chunk = x.slice(s * 6, s * 6 + 6);
        const row = (chunk[0] << 1) | chunk[5];
        const col = (chunk[1] << 3) | (chunk[2] << 2) | (chunk[3] << 1) | chunk[4];
        const v = S[s][row * 16 + col];
        out = out.concat([(v >> 3) & 1, (v >> 2) & 1, (v >> 1) & 1, v & 1]);
      }
      return permute(out, P);
    }
    function desBlock(input, keys, encrypt) {
      const ip = permute(input, IP);
      let l = ip.slice(0, 32), r = ip.slice(32);
      const ks = encrypt ? keys : keys.slice().reverse();
      for (let i = 0; i < 16; i++) {
        const nl = r;
        const nr = l.map((b, j) => (b ^ f(r, ks[i])[j]) >>> 0);
        l = nl; r = nr;
      }
      return permute(r.concat(l), FP);
    }
    const bytesToBits = (u8) => { const b = []; for (const x of u8) for (let i = 7; i >= 0; i--) b.push((x >> i) & 1); return b; };
    const bitsToBytes = (bits) => { const u = new Uint8Array(bits.length / 8); for (let i = 0; i < u.length; i++) { let v = 0; for (let j = 0; j < 8; j++) v = (v << 1) | bits[i * 8 + j]; u[i] = v; } return u; };

    /** CBC decrypt with a 3-key 3DES. key: 24 bytes, iv: 8 bytes. */
    function cbcDecrypt(key, iv, data) {
      const s1 = subkeys(bytesToBits(key.subarray(0, 8)));
      const s2 = subkeys(bytesToBits(key.subarray(8, 16)));
      const s3 = subkeys(bytesToBits(key.subarray(16, 24)));
      const out = new Uint8Array(data.length);
      let prev = bytesToBits(iv); // the CBC chain is 64 BITS (the IV is 8 bytes)
      for (let o = 0; o < data.length; o += 8) {
        const block = bytesToBits(data.subarray(o, o + 8));
        // 3DES-EDE decrypt = D(K1) · E(K2) · D(K3) — each a full 16-round
        // Feistel, applied in the OUTER-first order (K3, then K2, then K1)
        const d3 = desBlock(block, s3, false);
        const e2 = desBlock(d3, s2, true);
        const d1 = desBlock(e2, s1, false);
        const plain = d1.map((b, i) => (b ^ prev[i]) >>> 0);
        out.set(bitsToBytes(plain), o);
        prev = block;
      }
      return out;
    }
    return { cbcDecrypt, subkeys };
  })();

  /* ── PKCS#12 ───────────────────────────────────────────────── */
  const OID = {
    data: "1.2.840.113549.1.7.1",
    signedData: "1.2.840.113549.1.7.2",
    encryptedData: "1.2.840.113549.1.7.6",
    rsaEncryption: "1.2.840.113549.1.1.1",
    sha256: "2.16.840.1.101.3.4.2.1",
    sha256WithRSA: "1.2.840.113549.1.1.11",
    contentType: "1.2.840.113549.1.9.3",
    messageDigest: "1.2.840.113549.1.9.4",
    signingTime: "1.2.840.113549.1.9.5",
    pbes2: "1.2.840.113549.1.5.13",
    pbkdf2: "1.2.840.113549.1.5.12",
    hmacWithSHA1: "1.2.840.113549.2.7",
    pbe3des: "1.2.840.113549.1.12.1.3",
    keyBag: "1.2.840.113549.1.12.10.1.1",
    pkcs8ShroudedKeyBag: "1.2.840.113549.1.12.10.1.2",
    certBag: "1.2.840.113549.1.12.10.1.3",
    x509Cert: "1.2.840.113549.1.9.22.1",
  };
  const _oidStr = (u8) => {
    let s = String(Math.floor(u8[0] / 40)) + "." + String(u8[0] % 40);
    let v = 0;
    for (let i = 1; i < u8.length; i++) {
      v = (v << 7) | (u8[i] & 0x7f);
      if (!(u8[i] & 0x80)) { s += "." + v; v = 0; }
    }
    return s;
  };

  /** PKCS#12 password → UTF-16BE bytes with the 0x0000 terminator. */
  function _pwBytes(password) {
    const s = String(password || "");
    const out = [];
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      out.push((c >> 8) & 0xff, c & 0xff);
    }
    out.push(0, 0);
    return new Uint8Array(out);
  }

  /** RFC 7292 §B.2 key/IV derivation (SHA-1: u = 20, v = 64). */
  async function _pkcs12Kdf(subtle, password, salt, iterations, n, id) {
    const u = 20, v = 64;
    const pw = _pwBytes(password); // UTF-16BE + 0x0000 terminator (B.1)
    // 1. D = v/8 copies of ID
    const D = new Uint8Array(v).fill(id);
    // 2. S = salt repeated to a v multiple; P = password repeated likewise
    const sl = Math.ceil(salt.length / v) * v;
    const pl = Math.ceil(pw.length / v) * v;
    const S = new Uint8Array(sl), P = new Uint8Array(pl);
    for (let i = 0; i < sl; i++) S[i] = salt[i % salt.length];
    for (let i = 0; i < pl; i++) P[i] = pw[i % pw.length];
    // 3. I = S || P
    const I = new Uint8Array(sl + pl);
    I.set(S, 0); I.set(P, sl);
    const k = I.length / v; // number of v-octet blocks in I
    const out = new Uint8Array(n);
    const digest = async (bytes) => new Uint8Array(await subtle.digest("SHA-1", bytes));
    // 4. c = ceil(n / u)
    const c = Math.ceil(n / u);
    for (let i = 0; i < c; i++) {
      // 5A. A_i = H^r(D || I), r = iteration count
      const block = new Uint8Array(v + I.length);
      block.set(D, 0); block.set(I, v);
      let Ai = block;
      for (let r = 0; r < iterations; r++) Ai = await digest(Ai);
      // 5B. B = A_i repeated to v octets (v·ceil(u/v) = v, truncated)
      const B = new Uint8Array(v);
      for (let j = 0; j < v; j++) B[j] = Ai[j % u];
      // 5C. I_j = (I_j + B + 1) mod 2^(8v), big-endian per block
      for (let j = 0; j < k; j++) {
        let carry = 1;
        for (let t = v - 1; t >= 0; t--) {
          const s = I[j * v + t] + B[t] + carry;
          I[j * v + t] = s & 0xff;
          carry = s >> 8;
        }
      }
      // accumulate A_1 || A_2 || … into the output
      const need = Math.min(n - i * u, u);
      out.set(Ai.subarray(0, need), i * u);
    }
    return out;
  }

  function _x509Parse(certDer) {
    // Certificate ::= SEQUENCE { tbs, sigAlg, sig }
    const cert = _d.read(certDer, 0);
    const tbs = _d.read(cert.value, 0);
    const tbsChildren = _d.children(tbs.value, 0, tbs.value.length);
    // [0] version (optional), serialNumber, signature, issuer, validity, subject…
    let idx = 0;
    if (tbsChildren[0] && tbsChildren[0].tag === 0xa0) idx = 1;
    const serial = tbsChildren[idx];      // INTEGER (raw content bytes)
    const issuer = tbsChildren[idx + 2];  // Name SEQUENCE (raw DER incl. header)
    const subject = tbsChildren[idx + 4];
    const spki = tbsChildren[idx + 5];    // subjectPublicKeyInfo SEQUENCE
    return {
      serialContent: new Uint8Array(serial.value),
      serialRaw: _d.int([...serial.value]), // DER INTEGER for the CMS sid
      issuerRaw: _derRawOf(tbsChildren[idx + 2]),
      subjectRaw: _derRawOf(subject),
      spkiRaw: _derRawOf(spki),
    };
  }

  /** Raw DER bytes (tag + length + content) of a parsed TLV. */
  function _derRawOf(t) {
    const h = _d.len(t.len);
    const out = new Uint8Array(1 + h.length + t.len);
    let o = 0;
    out[o++] = t.tag;
    for (const b of h) out[o++] = b;
    out.set(t.value, o);
    return out;
  }

  const Sign = {
    /** Parse a PKCS#12 container (openssl/Windows export). Verifies the MAC
        so a wrong password fails with a clear error. Returns
        { key (PKCS#8 DER), certs (DER array), signer (leaf cert DER) }. */
    async parsePfx(pfxBytes, password) {
      const subtle = global.crypto && global.crypto.subtle;
      if (!subtle) throw new Error("Web Crypto unavailable");
      const pfx = _d.read(pfxBytes, 0);
      const [version, authSafeCI, macData] = _d.children(pfx.value, 0, pfx.value.length);
      void version;
      // authSafe: ContentInfo { data → [0] EXPLICIT OCTET STRING (AuthenticatedSafe) }
      const authSafeParts = _d.children(authSafeCI.value, 0, authSafeCI.value.length);
      const authSafeContent = authSafeParts[1]; // [0] EXPLICIT
      const octStr = _d.read(authSafeContent.value, 0);       // OCTET STRING
      const macSource = octStr.value;                          // its content (the MAC input)
      const authSafe = _d.read(octStr.value, 0);              // AuthenticatedSafe SEQUENCE
      const safeCIs = _d.children(authSafe.value, 0, authSafe.value.length);

      // MAC check FIRST (when present): the integrity gate — a wrong password
      // fails here cleanly, before we try to interpret (possibly garbage)
      // decrypted bags. HMAC-SHA1 over the authSafe content bytes.
      if (macData) {
        const macParts = _d.children(macData.value, 0, macData.value.length);
        const digestInfo = macParts[0];
        const di = _d.children(digestInfo.value, 0, digestInfo.value.length);
        const macDigest = di[1]; // OCTET STRING
        const salt = macParts[1].value;
        const iter = this._intOf(macParts[2].value);
        const key = await _pkcs12Kdf(subtle, password, salt, iter, 20, 3);
        const hk = await subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
        const mac = new Uint8Array(await subtle.sign("HMAC", hk, macSource));
        if (!this._bytesEq(mac, macDigest.value)) {
          throw new Error("Incorrect PFX password (MAC verification failed)");
        }
      }

      const keys = [];
      const certs = [];
      for (const ci of safeCIs) {
        const parts = _d.children(ci.value, 0, ci.value.length);
        const type = _oidStr(parts[0].value);
        const content = parts[1]; // [0] EXPLICIT
        if (type === OID.data) {
          const oct = _d.read(content.value, 0); // OCTET STRING (SafeContents)
          await this._readSafeContents(oct.value, keys, certs, subtle, password);
        } else if (type === OID.encryptedData) {
          const encData = _d.read(content.value, 0); // EncryptedData
          const encParts = _d.children(encData.value, 0, encData.value.length);
          const eci = encParts[1]; // encryptedContentInfo
          const eciParts = _d.children(eci.value, 0, eci.value.length);
          const encAlg = eciParts[1]; // AlgorithmIdentifier
          const encrypted = eciParts[2]; // OCTET STRING
          const decrypted = await this._decryptSafeBag(subtle, encAlg, encrypted.value, password);
          await this._readSafeContents(decrypted, keys, certs, subtle, password);
        }
      }
      if (!keys.length || !certs.length) {
        throw new Error("The PFX holds no usable key + certificate pair");
      }
      // the leaf signer is the first certificate whose SPKI matches the key —
      // otherwise the FIRST cert is the best guess (openssl lists leaf first)
      let signer = certs[0];
      if (keys.length === 1 && certs.length > 1) {
        const keySpki = await this._spkiFromPkcs8(subtle, keys[0]);
        for (const c of certs) {
          const spki = _x509Parse(c).spkiRaw;
          if (this._bytesEq(keySpki, spki)) { signer = c; break; }
        }
      }
      return { key: keys[0], certs, signer };
    },

    _bytesEq(a, b) {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
      return true;
    },

    _intOf(u8) {
      let v = 0;
      for (const b of u8) v = v * 256 + b;
      return v;
    },

    async _readSafeContents(u8, keys, certs, subtle, password) {
      const safe = _d.read(u8, 0);
      const bags = _d.children(safe.value, 0, safe.value.length);
      for (const bag of bags) {
        const parts = _d.children(bag.value, 0, bag.value.length);
        const bagId = _oidStr(parts[0].value);
        const val = parts[1]; // [0] EXPLICIT
        if (bagId === OID.keyBag) {
          keys.push(new Uint8Array(val.value));
        } else if (bagId === OID.pkcs8ShroudedKeyBag) {
          // EncryptedPrivateKeyInfo ::= SEQUENCE { algorithm, encryptedData }
          const epki = _d.read(val.value, 0);
          const epkiParts = _d.children(epki.value, 0, epki.value.length);
          const algId = epkiParts[0];
          const encKey = epkiParts[1]; // OCTET STRING
          const pkcs8 = await this._decryptSafeBag(subtle, algId, encKey.value, password);
          keys.push(new Uint8Array(pkcs8));
        } else if (bagId === OID.certBag) {
          const cb = _d.read(val.value, 0);
          const cbParts = _d.children(cb.value, 0, cb.value.length);
          const certVal = cbParts[1]; // [0] EXPLICIT → OCTET STRING (DER cert)
          const oct = _d.read(certVal.value, 0);
          certs.push(new Uint8Array(oct.value));
        }
      }
    },

    async _decryptSafeBag(subtle, algIdTlv, encrypted, password) {
      // algIdTlv is the AlgorithmIdentifier SEQUENCE — walk its content
      const algParts = _d.children(algIdTlv.value, 0, algIdTlv.value.length);
      const oid = _oidStr(algParts[0].value);
      const params = algParts[1];
      if (oid === OID.pbe3des) {
        const pp = _d.children(params.value, 0, params.value.length);
        const salt = pp[0].value;
        const iter = this._intOf(pp[1].value);
        const key = await _pkcs12Kdf(subtle, password, salt, iter, 24, 1);
        const iv = await _pkcs12Kdf(subtle, password, salt, iter, 8, 2);
        const plain = _des3.cbcDecrypt(key, iv, encrypted);
        return this._unpad(plain);
      }
      if (oid === OID.pbes2) {
        const pp = _d.children(params.value, 0, params.value.length);
        const kdfParts = _d.children(pp[0].value, 0, pp[0].value.length);
        const kdfOid = _oidStr(kdfParts[0].value);
        if (kdfOid !== OID.pbkdf2) throw new Error("Unsupported PBES2 KDF: " + kdfOid);
        const kpp = _d.children(kdfParts[1].value, 0, kdfParts[1].value.length);
        const salt = kpp[0].value;
        const iter = this._intOf(kpp[1].value);
        const prf = kpp[2] ? _oidStr(kpp[2].value) : null;
        const encParts = _d.children(pp[1].value, 0, pp[1].value.length);
        const encOid = _oidStr(encParts[0].value);
        const iv = encParts[1].value;
        const keyLen = { "2.16.840.1.101.3.4.1.2": 16, "2.16.840.1.101.3.4.1.22": 24, "2.16.840.1.101.3.4.1.42": 32 }[encOid];
        if (!keyLen) throw new Error("Unsupported PBES2 cipher: " + encOid);
        const prfName = prf && prf !== OID.hmacWithSHA1 ? (prf === "1.2.840.113549.2.9" ? "SHA-256" : prf === "1.2.840.113549.2.10" ? "SHA-384" : prf === "1.2.840.113549.2.11" ? "SHA-512" : "SHA-1") : "SHA-1";
        const pwKey = await subtle.importKey("raw", _pwBytes(password), { name: "PBKDF2" }, false, ["deriveBits"]);
        const bits = await subtle.deriveBits({ name: "PBKDF2", salt: salt, iterations: iter, hash: prfName }, pwKey, keyLen * 8);
        const key = new Uint8Array(bits);
        const ck = await subtle.importKey("raw", key, { name: "AES-CBC" }, false, ["decrypt"]);
        const plain = new Uint8Array(await subtle.decrypt({ name: "AES-CBC", iv: iv }, ck, encrypted));
        return this._unpad(plain);
      }
      throw new Error("Unsupported PFX encryption: " + oid);
    },

    /** PKCS#7 padding removal. */
    _unpad(u8) {
      if (!u8.length) return u8;
      const n = u8[u8.length - 1];
      if (n >= 1 && n <= 16 && n <= u8.length) return u8.subarray(0, u8.length - n);
      return u8;
    },

    async _spkiFromPkcs8(subtle, pkcs8Der) {
      const k = await subtle.importKey("pkcs8", pkcs8Der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, true, ["sign"]);
      const spki = await subtle.exportKey("spki", k);
      return new Uint8Array(spki);
    },

    /* ── CMS (RFC 5652, detached) ────────────────────────────── */
    /** Build a detached PKCS#7 SignedData over a content digest.
        opts: { key (PKCS#8 DER), signerCert (DER), chain (DER[]), time (Date) }
        Returns the CMS DER bytes (Uint8Array). */
    async buildCms(messageDigest, opts) {
      const subtle = global.crypto && global.crypto.subtle;
      const certInfo = _x509Parse(opts.signerCert);
      const time = opts.time || new Date();

      // signed attributes (DER-sorted: contentType, messageDigest, signingTime)
      const attrContentType = _d.seq(_d.oid(OID.contentType), _d.setOf(_d.oid(OID.data)));
      const attrMessageDigest = _d.seq(_d.oid(OID.messageDigest), _d.setOf(_d.oct(messageDigest)));
      const attrSigningTime = _d.seq(_d.oid(OID.signingTime), _d.setOf(_d.utcTime(time)));
      const signedAttrs = _d.setOf(attrContentType, attrMessageDigest, attrSigningTime);

      // sign the DER of the signed attrs with the private key
      const key = await subtle.importKey("pkcs8", opts.key, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
      const sig = new Uint8Array(await subtle.sign({ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, key, new Uint8Array(signedAttrs)));

      const signerInfo = _d.seq(
        _d.int([1]),
        _d.seq(certInfo.issuerRaw, certInfo.serialRaw),
        _d.alg(OID.sha256),
        _d.tlv(0xa0, signedAttrs),
        _d.alg(OID.sha256WithRSA),
        _d.oct(sig),
      );

      const certs = [opts.signerCert, ...(opts.chain || [])];
      const certSet = _d.tlv(0xa0, _d.setOf(...certs.map((c) => [...c])));

      const signedData = _d.seq(
        _d.int([1]),
        _d.setOf(_d.alg(OID.sha256)),
        _d.seq(_d.oid(OID.data)), // encapContentInfo, NO eContent (detached)
        certSet,
        _d.setOf(signerInfo),
      );
      const contentInfo = _d.seq(_d.oid(OID.signedData), _d.tlv(0xa0, signedData));
      return new Uint8Array(contentInfo);
    },

    /* ── PDF /Sig field + ByteRange surgery ──────────────────── */
    /** Sign PDF bytes with a certificate from a PFX.
        opts: { pfxBytes, password, page (1-based), reason, x, y, w, h }
        → a NEW Uint8Array with a real /Sig field. */
    async signPdf(pdfBytes, opts) {
      const o = opts || {};
      const { PDFDocument, PDFName, PDFHexString } = global.PDFLib;
      const pdf = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
      const pageNum = Math.max(1, Math.min(pdf.getPageCount(), parseInt(o.page, 10) || 1));
      const page = pdf.getPage(pageNum - 1);
      const size = page.getSize();
      const w = o.w || 200, h = o.h || 60;
      const x = o.x != null ? o.x : size.width - w - 40;
      const y = o.y != null ? o.y : 40;

      const pfx = await this.parsePfx(o.pfxBytes, o.password);
      const ctx = pdf.context;
      const sigName = "Volt-Signature-" + (Date.now() % 100000);

      // /ByteRange placeholder is `[0 0 0 0]` — the patcher splices the real
      // numbers in with a known width delta, so no offsets are guessed.
      // /Contents is a fixed-width zero HEX run (PDFHexString writes the
      // string verbatim between <>) that later holds the CMS hex + zero pad.
      const HEX_CAP = 0x4000; // 16384 bytes of signature capacity (Adobe's default)
      const sigRef = ctx.register(ctx.obj({
        Type: PDFName.of("Sig"),
        Filter: PDFName.of("Adobe.PPKLite"),
        SubFilter: PDFName.of("adbe.pkcs7.detached"),
        M: "D:" + this._pdfDate(o.time || new Date()),
        Reason: String(o.reason || "Signed in Volt"),
        ByteRange: [0, 0, 0, 0],
        Contents: new PDFHexString("0".repeat(HEX_CAP)),
      }));

      // AcroForm: create if absent, add the field + SigFlags
      let acro = pdf.catalog.get(PDFName.of("AcroForm"));
      if (!acro) {
        const acroDict = ctx.obj({ Fields: [], SigFlags: 3 });
        const acroRef = ctx.register(acroDict);
        pdf.catalog.set(PDFName.of("AcroForm"), acroRef);
        acro = acroDict;
      } else {
        acro = ctx.lookup(acro);
      }
      const fields = acro.get(PDFName.of("Fields"));
      const field = ctx.obj({ FT: PDFName.of("Sig"), T: sigName, V: sigRef, F: 132 });
      const fieldRef = ctx.register(field);
      if (fields && typeof fields.push === "function") fields.push(fieldRef);
      else acro.set(PDFName.of("Fields"), ctx.obj([fieldRef]));
      try { acro.set(PDFName.of("SigFlags"), ctx.obj(3)); } catch (e) { /* optional */ }

      // the widget annotation on the page
      const widget = ctx.obj({
        Type: PDFName.of("Annot"),
        Subtype: PDFName.of("Widget"),
        FT: PDFName.of("Sig"),
        T: sigName,
        V: sigRef,
        P: ctx.register(page.node),
        Rect: [x, y, x + w, y + h],
        F: 132,
      });
      const widgetRef = ctx.register(widget);
      const annots = page.node.get(PDFName.of("Annots"));
      if (annots && typeof annots.push === "function") annots.push(widgetRef);
      else page.node.set(PDFName.of("Annots"), ctx.obj([widgetRef]));

      // ── save + patch ──
      const saved = await pdf.save({ useObjectStreams: false });
      return this._patchSignature(saved, o, pfx, HEX_CAP);
    },

    _pdfDate(d) {
      const p = (n) => String(n).padStart(2, "0");
      return p(d.getUTCFullYear()) + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) +
        p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds());
    },

    /** Fill the ByteRange + Contents placeholders. The placeholder file has
        `/ByteRange [0 0 0 0]` (9 bytes) and a zero hex run of `hexCap` chars.
        The final ByteRange block is 36 bytes (`[0 <10d> <10d> <10d>]`), so
        everything after the block shifts by a KNOWN delta (+27); the real a,
        b and n' are exact, the final file is assembled by splicing the block,
        the digest covers [0,a) ∪ [b,n') of the FINAL file, and the CMS hex
        (padded to the run width) goes into the excluded gap. */
    async _patchSignature(saved, o, pfx, hexCap) {
      const src = this._latin1(saved);
      const n = saved.length;

      // locate /ByteRange [0 0 0 0]
      const br = src.indexOf("/ByteRange");
      if (br < 0) throw new Error("Signature dict missing /ByteRange");
      const lb = src.indexOf("[", br);
      const rb = src.indexOf("]", lb);
      const brText = src.slice(lb, rb + 1);
      if (!/^\[\s*0\s+0\s+0\s+0\s*\]$/.test(brText)) throw new Error("Unexpected ByteRange placeholder: " + brText);

      // locate /Contents <0…0> — the page's own content stream is also a
      // /Contents, so search only AFTER the Sig dict's /ByteRange
      const cIdx = src.indexOf("/Contents", br);
      if (cIdx < 0) throw new Error("Signature dict missing /Contents");
      const lt = src.indexOf("<", cIdx);
      if (lt < 0) throw new Error("Signature /Contents malformed");
      const hexStart = lt + 1;
      const hexEnd = src.indexOf(">", hexStart);
      if (hexEnd < 0) throw new Error("Signature /Contents unclosed");
      if (hexEnd - hexStart !== hexCap || /[^0]/.test(src.slice(hexStart, hexEnd))) {
        throw new Error("Signature placeholder hex run unexpected");
      }

      // widths: placeholder block (9 or 11/13 bytes) → final 36 bytes. The
      // final form `[0 <10d> <10d> <10d>]` is exactly 36 bytes (the leading
      // 0 stays unpadded), so every byte after the block shifts by DELTA.
      const DELTA = 36 - brText.length;
      const a0 = hexStart, b0 = hexEnd;
      const a = a0 + DELTA, b = b0 + DELTA, nf = n + DELTA;

      const brFinal = "[0 " + [a, b, nf].map((v) => String(v).padStart(10, "0")).join(" ") + "]";
      let out = new Uint8Array(n + DELTA);
      out.set(saved.subarray(0, lb), 0);
      for (let i = 0; i < brFinal.length; i++) out[lb + i] = brFinal.charCodeAt(i);
      out.set(saved.subarray(rb + 1), lb + brFinal.length);

      // the splice shifts every byte after lb by DELTA, so the classic xref's
      // object offsets (and the startxref pointer) are stale — patch them in
      // place BEFORE the digest is taken (the xref lives inside the covered
      // range, so fixing it after signing would break the signature). pdf-lib
      // reloads tolerate stale offsets via repair mode; pdf.js / Acrobat don't.
      out = this._fixXrefOffsets(out, lb, DELTA);

      // digest of the FINAL file's covered ranges [0,a) ∪ [b,nf)
      const subtle = global.crypto && global.crypto.subtle;
      const part1 = out.subarray(0, a);
      const part2 = out.subarray(b, nf);
      const joined = new Uint8Array(part1.length + part2.length);
      joined.set(part1, 0); joined.set(part2, part1.length);
      const digest = new Uint8Array(await subtle.digest("SHA-256", joined));

      const cms = await this.buildCms(digest, {
        key: pfx.key, signerCert: pfx.signer, chain: pfx.certs.filter((c) => c !== pfx.signer),
        time: o.time || new Date(),
      });
      let hex = "";
      for (let i = 0; i < cms.length; i++) hex += cms[i].toString(16).padStart(2, "0");
      if (hex.length > hexCap) throw new Error("Signature too large for the placeholder (" + hex.length + " > " + hexCap + ")");
      const pad = hexCap - hex.length;
      const write = (off, str) => { for (let i = 0; i < str.length; i++) out[off + i] = str.charCodeAt(i); };
      write(a, hex + "0".repeat(pad));
      return out;
    },

    _latin1(bytes) {
      let s = "";
      for (let i = 0; i < bytes.length; i += 0x8000) {
        s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      }
      return s;
    },

    /** Rewrite a classic xref table after a byte splice: every object offset
        greater than the splice point moves by the delta, and so does the
        startxref pointer. Returns a NEW Uint8Array. */
    _fixXrefOffsets(bytes, afterOffset, delta) {
      let s = this._latin1(bytes);
      const xrefI = s.indexOf("xref\n");
      if (xrefI < 0) return bytes; // xref stream (shouldn't happen: we save classic)
      const trailerI = s.indexOf("trailer", xrefI);
      if (trailerI < 0) return bytes;
      const section = s.slice(xrefI + 5, trailerI);
      const lines = section.split("\n");
      // join with "\n" (NOT per-line "+ \\n") so trailing empty lines from the
      // split are preserved exactly — adding one byte here would shift the
      // ByteRange and break the digest
      const fixedLines = lines.map((line) => {
        const m = /^(\d{10}) (\d{5}) (n|f) /.exec(line);
        if (m && m[3] === "n") {
          const off = parseInt(m[1], 10);
          if (off > afterOffset) return line.replace(/^\d{10}/, String(off + delta).padStart(10, "0"));
        }
        return line;
      });
      let out2 = s.slice(0, xrefI + 5) + fixedLines.join("\n");
      // the trailer dict, startxref and %%EOF follow the xref section — keep them
      out2 += s.slice(trailerI);
      const sxI = out2.indexOf("startxref\n");
      if (sxI >= 0) {
        const after = out2.slice(sxI + 10);
        const nl = after.indexOf("\n");
        if (nl > 0) {
          const val = parseInt(after.slice(0, nl), 10);
          if (!isNaN(val)) {
            out2 = out2.slice(0, sxI + 10) + String(val + delta) + after.slice(nl);
          }
        }
      }
      const fixed = new Uint8Array(out2.length);
      for (let i = 0; i < out2.length; i++) fixed[i] = out2.charCodeAt(i) & 0xff;
      return fixed;
    },
  };

  const Volt = global.Volt = global.Volt || {};
  Volt.Sign = Sign;
  // expose internals for the unit tests (pure-JS 3DES verified against Node)
  Sign._des3 = _des3;
  Sign._d = _d;
  Sign._pkcs12Kdf = _pkcs12Kdf;
  Sign._x509Parse = _x509Parse;
  if (typeof module !== "undefined" && module.exports) module.exports = Sign;
})(typeof window !== "undefined" ? window : globalThis);
