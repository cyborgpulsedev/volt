/* ═══════════════════════════════════════════════════════════════
   ocr.js — Volt.OCR
   Local OCR via vendored Tesseract.js (vendor/tesseract — worker,
   wasm core, eng traineddata; no CDN at runtime). Makes scanned /
   image-only pages searchable and readable by the AI chat:
     • per-document store  volt:ocr:{docKey}  (same identity key as
       annotations): [{page, text, words:[{text, bbox}]}] with bboxes
       in PDF units (y-up, unrotated) — so search highlights render
       through the same viewport mapping as pdf.js text content
     • runDoc() renders each page offscreen (2× = 144dpi) through
       pdf.js, recognizes it, saves incrementally (a cancel keeps
       finished pages), and clears the AI page-text cache so the new
       text feeds grounded chat answers
     • searchRects() feeds App.runSearch's per-page fallback when a
       page has NO embedded text (pure image page); pageText() feeds
       Volt.AI.ensurePageTexts the same way
     • PER-DOCUMENT LANGUAGE: the toolbar picker stores the language
       (volt:ocr-lang:{docKey}) alongside the store. Only English is
       vendored; any other language is DOWNLOADED on demand from
       tesseract.js's tessdata host and cached in the worker's own
       IndexedDB store (key `volt-tessdata/{lang}.traineddata` — the exact
       key tesseract.js v5's loadLanguage reads), so after one download
       the language works offline forever.
   available is false when the vendored files are missing (the OCR
   button hides, search/AI silently skip the fallback).
   ═══════════════════════════════════════════════════════════════ */
(function (global) {
  "use strict";

  const Volt = global.Volt = global.Volt || {};

  Volt.OCR = {
    available: typeof global.Tesseract !== "undefined",
    _worker: null,      // lazy singleton Tesseract worker
    _workerLangs: null, // the language set the current worker was built for
    _busy: false,       // one run at a time
    _fpBusy: false,     // the fingerprint computation's on-demand page OCR
    _cancelled: false,  // cancel() terminates the worker mid-run
    _progressEl: null,  // live "OCR: page N/M…" toast
    _idbPromise: null,  // lazy IndexedDB handle on tesseract's cache store

    /** The language picker's curated list. Only `eng` is vendored with
        Volt; the rest download from tesseract.js's tessdata host on demand
        and cache in the worker's IndexedDB store (offline afterwards). */
    LANGS: [
      { code: "eng", name: "English", en: "English" },
      { code: "fra", name: "Français", en: "French" },
      { code: "deu", name: "Deutsch", en: "German" },
      { code: "spa", name: "Español", en: "Spanish" },
      { code: "ita", name: "Italiano", en: "Italian" },
      { code: "por", name: "Português", en: "Portuguese" },
      { code: "nld", name: "Nederlands", en: "Dutch" },
      { code: "pol", name: "Polski", en: "Polish" },
      { code: "tur", name: "Türkçe", en: "Turkish" },
      { code: "swe", name: "Svenska", en: "Swedish" },
      { code: "rus", name: "Русский", en: "Russian" },
      { code: "ukr", name: "Українська", en: "Ukrainian" },
      { code: "ara", name: "العربية", en: "Arabic" },
      { code: "hin", name: "हिन्दी", en: "Hindi" },
      { code: "jpn", name: "日本語", en: "Japanese" },
      { code: "chi_sim", name: "简体中文", en: "Chinese (Simplified)" },
      { code: "chi_tra", name: "繁體中文", en: "Chinese (Traditional)" },
      { code: "kor", name: "한국어", en: "Korean" },
      { code: "vie", name: "Tiếng Việt", en: "Vietnamese" },
      { code: "ind", name: "Bahasa Indonesia", en: "Indonesian" },
      { code: "ces", name: "Čeština", en: "Czech" },
      { code: "ell", name: "Ελληνικά", en: "Greek" },
      { code: "heb", name: "עברית", en: "Hebrew" },
      { code: "tha", name: "ไทย", en: "Thai" },
    ],
    _defaultLang: "eng",

    _app() { return global.Volt.App; },

    /** Human label for a language code (or an eng+fra-style joined set). */
    _label(code) {
      if (!code) return "";
      return String(code).split("+").map((c) => {
        const e = this.LANGS.find((l) => l.code === c);
        return e ? e.name : c;
      }).join(" + ");
    },

    _fmtBytes(n) {
      if (!n || n <= 0) return "0 MB";
      return (n / 1048576).toFixed(1) + " MB";
    },

    /* ── per-document language ─────────────────────────────────────────── */

    /** The per-document language key — same identity hash as the OCR store,
        so a re-exported file (new size) starts fresh, like every other
        per-doc layer. */
    _langKey() {
      const info = this._app() && this._app().currentDocInfo;
      return info ? "volt:ocr-lang:" + Utils.hash(info.name + ":" + info.size + ":" + info.pages) : null;
    },

    /** The effective OCR language for the open document (per-doc override,
        or the vendored English default). */
    lang() {
      const k = this._langKey();
      if (!k) return this._defaultLang;
      try { return localStorage.getItem(k) || this._defaultLang; } catch (e) { return this._defaultLang; }
    },

    /** Switch the current document's OCR language: persists the per-doc
        override, invalidates the old-language store (pages recognized in the
        previous language would otherwise be stale), downloads + caches the
        new traineddata if needed, and re-arms the toolbar picker. Returns
        false on failure (offline / bad code). */
    async setLang(code) {
      const app = this._app();
      // tesseract codes are [a-z0-9_] (eng, chi_sim); hyphens are allowed
      // too so custom traineddata names (community packs, the smoke's fake
      // code) can be used — but nothing path-like, since the code becomes a
      // cache key AND a filename inside the worker's FS
      if (!code || !/^[a-z][a-z0-9_-]*$/.test(code)) {
        if (app) app.toast("Invalid OCR language code", "error");
        return false;
      }
      if (this._busy) this.cancel(); // a run in the old language is useless now
      const k = this._langKey();
      if (!k) { if (app) app.toast("Open a document first", "error"); return false; }
      try { localStorage.setItem(k, code); } catch (e) { /* quota */ }
      try { localStorage.removeItem(this._key()); } catch (e) { /* ignore */ }
      // the AI page-text cache and any on-screen OCR spans are stale now
      if (global.Volt.AI) global.Volt.AI._pageTexts = null;
      if (app && app.renderOcrTextLayers) app.renderOcrTextLayers();
      this._syncLangUI(code);
      const progToast = app && app.toast ? app.toast("Preparing " + this._label(code) + "…", "", true) : null;
      const prep = await this._ensureLangs(code, (received, total) => {
        if (progToast) progToast.textContent = "Downloading OCR language " + this._label(code) +
          "… " + this._fmtBytes(received) + (total ? " / " + this._fmtBytes(total) : "");
      });
      if (progToast) progToast.remove();
      if (prep.errors.length) {
        if (app) app.toast("OCR language " + this._label(code) + " can't be downloaded yet — " + prep.errors.join("; "), "error");
        return false;
      }
      const note = prep.downloaded.length ? " — downloaded & cached" : " — ready";
      if (app) {
        app.toast("OCR language set to " + this._label(code) + note + "; re-run OCR to recognize this document", "ok", false,
          app.currentDoc ? { label: "Run OCR now", onClick: () => { if (app.currentDoc) Volt.OCR.runDoc(); } } : null);
      }
      return true;
    },

    /* ── traineddata cache (the worker's own IndexedDB store) ──────────── */

    /** The worker's traineddata cache is idb-keyval's default database
        (keyval-store / keyval) — the SAME IndexedDB store tesseract.js v5's
        worker reads via its readCache adapter. Seeding it is the entire trick
        behind "download and cache on demand": downloadLang stores the
        decompressed traineddata under `${cachePath}/{lang}.traineddata` and
        the worker's loadLanguage finds it as a cache hit with zero network.
        (createWorker below passes cachePath "volt-tessdata", so the keys are
        deterministic and never collide with anything else.) */
    _cacheKey(lang) { return "volt-tessdata/" + lang + ".traineddata"; },

    _idb() {
      if (this._idbPromise) return this._idbPromise;
      this._idbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open("keyval-store");
        req.onupgradeneeded = () => { req.result.createObjectStore("keyval"); };
        req.onsuccess = () => {
          const db = req.result;
          const tx = (mode, fn) => new Promise((res, rej) => {
            const t = db.transaction("keyval", mode);
            fn(t.objectStore("keyval"), res, rej);
            t.onerror = () => rej(t.error || new Error("indexeddb error"));
            t.oncomplete = () => res();
          });
          resolve({
            get: (key) => tx("readonly", (s, res, rej) => {
              const r = s.get(key);
              r.onsuccess = () => res(r.result);
              r.onerror = () => rej(r.error);
            }),
            set: (key, val) => tx("readwrite", (s, res, rej) => {
              const r = s.put(val, key);
              r.onsuccess = () => res();
              r.onerror = () => rej(r.error);
            }),
            del: (key) => tx("readwrite", (s, res, rej) => {
              const r = s.delete(key);
              r.onsuccess = () => res();
              r.onerror = () => rej(r.error);
            }),
          });
        };
        req.onerror = () => reject(req.error);
      });
      return this._idbPromise;
    },

    /** Whether a language's traineddata is already in the worker's cache. */
    async _cached(lang) {
      try {
        const db = await this._idb();
        const v = await db.get(this._cacheKey(lang));
        return !!v && v.length > 1000;
      } catch (e) { return false; }
    },

    /** Download one traineddata file and store it (decompressed) into the
        worker's IndexedDB cache. opts.url overrides the CDN (the smoke
        points it at the vendored file to exercise the whole pipeline
        offline). Progress reports (received, total) bytes through
        opts.onProgress. Returns { ok, bytes, stored } or { ok:false, error }. */
    async downloadLang(lang, opts) {
      opts = opts || {};
      const url = opts.url || "https://tessdata.projectnaptha.com/4.0.0/" + lang + ".traineddata.gz";
      const onProgress = typeof opts.onProgress === "function" ? opts.onProgress : function () {};
      let resp;
      try { resp = await fetch(url); } catch (e) {
        return { ok: false, error: "network error — " + String((e && e.message) || e) };
      }
      if (!resp.ok) return { ok: false, error: "HTTP " + resp.status };
      const total = Number(resp.headers.get("Content-Length") || 0);
      const reader = resp.body && resp.body.getReader ? resp.body.getReader() : null;
      let bytes;
      if (reader) {
        const chunks = [];
        let received = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          received += value.length;
          onProgress(received, total);
        }
        bytes = new Uint8Array(received);
        let o = 0;
        for (const c of chunks) { bytes.set(c, o); o += c.length; }
      } else {
        bytes = new Uint8Array(await resp.arrayBuffer());
      }
      // gzip magic guard — the same check the vendored-file updater runs
      if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) {
        return { ok: false, error: "not a gzip stream (bad download?)" };
      }
      // Decompress so the cache holds the same canonical form tesseract
      // itself writes (it gunzips before writeCache). If DecompressionStream
      // is missing, the RAW gz bytes still work — the worker's loadLanguage
      // checks the gzip magic and decompresses cache hits too.
      let data = bytes;
      if (typeof DecompressionStream !== "undefined") {
        try {
          const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
          data = new Uint8Array(await new Response(stream).arrayBuffer());
        } catch (e) { data = bytes; }
      }
      try {
        const db = await this._idb();
        await db.set(this._cacheKey(lang), data);
      } catch (e) {
        return { ok: false, error: "could not cache — " + String((e && e.message) || e) };
      }
      return { ok: true, bytes: bytes.length, stored: data.length };
    },

    /** Make sure every language in an eng+fra-style set is available: vendored
        ones need nothing, cached ones are already in the worker's IndexedDB
        store, and anything else is downloaded now. Returns { downloaded,
        errors }. */
    async _ensureLangs(langsStr, onProgress) {
      const codes = String(langsStr || this._defaultLang).split("+").filter(Boolean);
      const missing = [];
      for (const c of codes) {
        if (c === this._defaultLang) continue;   // vendored locally
        if (await this._cached(c)) continue;     // already in the worker cache
        missing.push(c);
      }
      const out = { downloaded: [], errors: [] };
      for (const c of missing) {
        const r = await this.downloadLang(c, { onProgress });
        if (r.ok) out.downloaded.push(c);
        else out.errors.push(this._label(c) + (r.error ? " — " + r.error : ""));
      }
      return out;
    },

    /* ── language picker popover (searchable, status-aware) ────────────── */

    /** Availability of a language's traineddata: "builtin" (vendored with
        Volt — always there), "cached" (downloaded before, works offline), or
        "ondemand" (downloads when selected). Async only for the cache check. */
    async _langStatus(code) {
      if (code === this._defaultLang) return "builtin";
      return (await this._cached(code)) ? "cached" : "ondemand";
    },

    _statusText(status) {
      return status === "builtin" ? "Built in" : status === "cached" ? "Cached" : "On demand";
    },

    /** Render the language list inside the OCR-language popover (called on
        every open and after a language change). The current document's
        language is marked; every row carries its availability status — built
        in / cached (offline) / on demand — updated asynchronously from the
        worker's IndexedDB cache once the rows exist. A per-document language
        that isn't in the curated list (custom traineddata) gets a row of its
        own so the selection is always visible. */
    renderLangList(listEl) {
      if (!listEl) return;
      const cur = this.lang();
      const curated = this.LANGS.map((l) => l.code);
      const codes = (cur && !curated.includes(cur)) ? [cur, ...curated] : curated;
      listEl.innerHTML = "";
      for (const code of codes) {
        const l = this.LANGS.find((x) => x.code === code);
        const row = document.createElement("button");
        row.type = "button";
        row.className = "ol-row" + (code === cur ? " selected" : "");
        row.dataset.code = code;
        row.dataset.search = ((l ? l.name + " " + l.en + " " : "") + code).toLowerCase();
        row.setAttribute("aria-selected", code === cur ? "true" : "false");
        row.innerHTML = "<span class=\"ol-name\"></span><span class=\"ol-en\"></span><span class=\"ol-status\"></span>";
        row.querySelector(".ol-name").textContent = l ? l.name : code;
        if (l && l.en && l.en !== l.name) row.querySelector(".ol-en").textContent = l.en;
        listEl.appendChild(row);
        // built-in is synchronous (no cache check); cached/on-demand resolve
        // from IndexedDB a tick later
        const st = row.querySelector(".ol-status");
        if (code === this._defaultLang) {
          st.className = "ol-status builtin";
          st.textContent = this._statusText("builtin");
        } else {
          st.className = "ol-status";
          st.textContent = "…";
          this._langStatus(code).then((s) => {
            st.className = "ol-status " + s;
            st.textContent = this._statusText(s);
          });
        }
      }
    },

    /** Keep every language-picker surface in sync with the current document
        language: the Tools-menu item's label, the popover list's selected
        row, and (for custom codes) the row itself. */
    _syncLangUI(code) {
      const app = this._app();
      if (!app) return;
      const el = app.elements || {};
      if (el.ocrLangCur) el.ocrLangCur.textContent = this._label(code);
      if (el.btnOcrLang) {
        el.btnOcrLang.title = "OCR language for this document: " + this._label(code) + " — click to change";
      }
      if (el.ocrLangList) {
        let found = false;
        for (const row of [...el.ocrLangList.querySelectorAll(".ol-row")]) {
          const on = row.dataset.code === code;
          if (on) found = true;
          row.classList.toggle("selected", on);
          row.setAttribute("aria-selected", on ? "true" : "false");
        }
        // a custom language set programmatically (not in the curated list)
        // must still be visible as the current selection
        if (!found && code) {
          const row = document.createElement("button");
          row.type = "button";
          row.className = "ol-row selected";
          row.dataset.code = code;
          row.dataset.search = code.toLowerCase();
          row.setAttribute("aria-selected", "true");
          row.innerHTML = "<span class=\"ol-name\"></span><span class=\"ol-en\"></span><span class=\"ol-status\"></span>";
          row.querySelector(".ol-name").textContent = code;
          const st = row.querySelector(".ol-status");
          st.className = "ol-status";
          this._langStatus(code).then((s) => { st.className = "ol-status " + s; st.textContent = this._statusText(s); });
          el.ocrLangList.insertBefore(row, el.ocrLangList.firstChild);
        }
      }
    },

    /* ── text-layer visibility ────────────────────────────────────────── */

    /** Whether the selectable OCR text layer is shown — a GLOBAL view
        preference (volt:ocr:layer, default on). Only the on-page spans are
        affected; the store, search, and AI reads are untouched. */
    showLayer() {
      try { return localStorage.getItem("volt:ocr:layer") !== "0"; } catch (e) { return true; }
    },

    /* ── OCR-first text layer (scans with a misaligned embedded layer) ── */

    /** The per-document "OCR layer overrides embedded text" key — the same
        identity hash as the annotations/OCR store, so a re-exported file
        starts fresh. */
    _preferKey() {
      const info = this._app() && this._app().currentDocInfo;
      return info ? "volt:ocr:prefer:" + Utils.hash(info.name + ":" + info.size + ":" + info.pages) : null;
    },

    /** Whether the OCR text layer should REPLACE the embedded (pdf.js) text
        layer for the open document — a per-doc preference (default off).
        Scans often carry a baked-in, invisible text layer that is
        systematically offset from the visible page (a bad OCR embed — the
        classic "highlights land beside the text" complaint); Volt's own OCR
        measures the page as displayed at rotation 0, so its word boxes
        always sit on the visible glyphs. When enabled, the aligned OCR
        spans drive selection, drag-highlighting, Ctrl+A → Highlight all,
        search, and the AI's page reads. */
    preferLayer() {
      const k = this._preferKey();
      if (!k) return false;
      try { return localStorage.getItem(k) === "1"; } catch (e) { return false; }
    },

    /** Whether the OCR layer should drive the text layer FOR A GIVEN PAGE:
        the preference must be on AND the page must actually have recognized
        words (before OCR runs, the embedded layer stays in place). */
    preferFor(pageNum) {
      return this.preferLayer() && this.hasPage(pageNum);
    },

    /** Flip the OCR-first preference for the open document: persists it,
        syncs the popover checkbox, and rebuilds the on-screen text layers so
        the change applies immediately (pages rendered under the old mode
        switch on the spot). Returns the new state. */
    setPreferLayer(on) {
      const app = this._app();
      const k = this._preferKey();
      if (!k) { if (app) app.toast("Open a document first", "error"); return false; }
      try { localStorage.setItem(k, on ? "1" : "0"); } catch (e) { /* quota */ }
      this._syncPreferUI();
      if (app && app.rebuildTextLayers) app.rebuildTextLayers();
      if (app) {
        app.toast(on
          ? "OCR text layer now drives this document — highlights, selection & search follow the recognized text"
          : "Back to the document's embedded text layer", "ok");
      }
      return !!on;
    },

    /** Reflect the current document's preference in the popover checkbox. */
    _syncPreferUI() {
      const el = this._app() && this._app().elements;
      if (!el || !el.ocrPrefer) return;
      el.ocrPrefer.checked = this.preferLayer();
    },

    /** Whether a page's EMBEDDED text layer is plausibly misaligned with the
        visible page — compares the center of the embedded text (pdf.js text
        content) with the center of this run's OCR words on the same page. A
        scan whose baked-in OCR layer was systematically offset shows up as a
        large center gap (or zero overlap); a normal digital PDF's embedded
        text sits exactly where the OCR words are, so it is never flagged.
        Used AFTER a run to suggest the OCR-first layer, never to auto-enable
        it. Returns false when there is nothing to compare. */
    async _embeddedMisaligned(pageNum) {
      const app = this._app();
      const doc = app && app.currentDoc;
      if (!doc || !this.hasPage(pageNum)) return false;
      const e = (this._store() || []).find((x) => x.page === pageNum);
      if (!e || !Array.isArray(e.words) || !e.words.length) return false;
      const PJ = global.pdfjsLib;
      if (!PJ || !PJ.Util || !PJ.Util.applyTransform) return false;
      try {
        const page = await doc.getPage(pageNum);
        const tc = await page.getTextContent();
        const items = tc.items.filter((i) => i.str && i.str.trim());
        if (!items.length) return false; // no embedded text on this page
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const it of items) {
          const h = it.height || 0;
          const m = PJ.Util.applyTransform([0, h], it.transform);
          minX = Math.min(minX, it.transform[4]);
          maxX = Math.max(maxX, m[0]);
          minY = Math.min(minY, m[1]);
          maxY = Math.max(maxY, it.transform[5]);
        }
        let ominX = Infinity, ominY = Infinity, omaxX = -Infinity, omaxY = -Infinity;
        for (const w of e.words) {
          if (!w || !w.bbox) continue;
          ominX = Math.min(ominX, w.bbox.x0); omaxX = Math.max(omaxX, w.bbox.x1);
          ominY = Math.min(ominY, w.bbox.y0); omaxY = Math.max(omaxY, w.bbox.y1);
        }
        if (!isFinite(minX) || !isFinite(ominX)) return false;
        const ex = (minX + maxX) / 2, ey = (minY + maxY) / 2;
        const ox = (ominX + omaxX) / 2, oy = (ominY + omaxY) / 2;
        const w = Math.max(maxX - minX, 1), h = Math.max(maxY - minY, 1);
        // centers apart by more than ~6% of the embedded text's extent (with
        // a small absolute floor) → the embedded layer does not sit on the
        // visible page the way the OCR words do
        const dx = Math.abs(ex - ox), dy = Math.abs(ey - oy);
        return dx > 0.06 * w + 6 || dy > 0.06 * h + 6;
      } catch (e2) { return false; }
    },

    /** Set the layer visibility and sync every rendered page: OFF strips the
        .ocr-span elements (new renders skip injection too — _buildTextLayer
        checks this), ON re-injects them. Returns the new state. */
    setLayer(on) {
      try { localStorage.setItem("volt:ocr:layer", on ? "1" : "0"); } catch (e) { /* ignore */ }
      const app = this._app();
      if (app && app.renderOcrTextLayers) app.renderOcrTextLayers();
      if (app && app.elements && app.elements.btnOcrLayer) {
        app.elements.btnOcrLayer.classList.toggle("active", !!on);
        app.elements.btnOcrLayer.title = on
          ? "Show recognized OCR text layer"
          : "OCR text layer hidden — click to show";
      }
      return !!on;
    },

    toggleLayer() { return this.setLayer(!this.showLayer()); },

    /* ── transcript export (.txt / .md) ──────────────────────────────── */

    /** Whether the store has any recognized text (drives the export modal
        items' visibility). */
    hasText() {
      const s = this._store() || [];
      return s.some((e) => e && e.text);
    },

    /** The recognized text of every OCR'd page as a plain-text transcript:
        one block per page with a page number, headed by the doc name and the
        language it was recognized in. */
    toText() {
      const info = this._app() && this._app().currentDocInfo;
      const base = info ? String(info.name || "document").replace(/\.pdf$/i, "") : "document";
      const out = ["OCR text — " + base, "Language: " + this._label(this.lang())];
      const s = this._store() || [];
      for (const e of s) {
        if (!e || !e.text) continue;
        out.push("", "Page " + e.page, "", e.text);
      }
      return out.join("\n");
    },

    /** The same transcript as Markdown — per-page headings, ready for notes
        apps or a shared doc. */
    toMarkdown() {
      const info = this._app() && this._app().currentDocInfo;
      const base = info ? String(info.name || "document").replace(/\.pdf$/i, "") : "document";
      const out = ["# " + base + " — OCR text", "", "**Language:** " + this._label(this.lang()), ""];
      const s = this._store() || [];
      for (const e of s) {
        if (!e || !e.text) continue;
        out.push("## Page " + e.page, "", e.text, "");
      }
      return out.join("\n");
    },

    /** The per-document identity key — same hash as annotations, so OCR
        survives reopen (a re-exported file gets a new identity, like every
        other per-doc layer). */
    _key() {
      const info = this._app() && this._app().currentDocInfo;
      return info ? "volt:ocr:" + Utils.hash(info.name + ":" + info.size + ":" + info.pages) : null;
    },
    _store() {
      const k = this._key();
      if (!k) return null;
      try {
        const s = localStorage.getItem(k);
        return s ? JSON.parse(s) : [];
      } catch (e) { return []; }
    },
    _save(pages) {
      const k = this._key();
      if (!k) return;
      try { localStorage.setItem(k, JSON.stringify(pages)); } catch (e) { /* quota */ }
    },

    /** The recognized text of one page ("" when that page wasn't OCR'd yet). */
    pageText(pageNum) {
      const s = this._store() || [];
      const e = s.find((x) => x.page === pageNum);
      return e && e.text ? e.text : "";
    },

    /** Whether the store has recognized words for a page (the text-layer
        injection guard). */
    hasPage(pageNum) {
      const s = this._store() || [];
      const e = s.find((x) => x.page === pageNum);
      return !!e && Array.isArray(e.words) && e.words.length > 0;
    },

    /** Inject a page's recognized words into its text layer as REAL, selectable
        spans (positioned from the stored PDF-space bboxes through the page's
        current viewport) — the visible/copyable half of OCR. The layer's CSS
        already styles spans transparent-with-selection, so OCR text looks and
        behaves exactly like embedded text (and the same `body.annotating` rule
        disables it while a tool is active). Returns true when spans were added. */
    renderTextLayer(pageNum, container, vp) {
      if (!container || !vp || !this.hasPage(pageNum)) return false;
      const e = (this._store() || []).find((x) => x.page === pageNum);
      for (const w of e.words) {
        if (!w.text || !w.bbox) continue;
        const p0 = vp.convertToViewportPoint(w.bbox.x0, w.bbox.y0); // PDF bottom-left → CSS
        const p1 = vp.convertToViewportPoint(w.bbox.x1, w.bbox.y1); // PDF top-right → CSS
        const span = document.createElement("span");
        span.className = "ocr-span";
        // trailing space keeps cross-word copies readable (like pdf.js items)
        span.textContent = w.text + " ";
        span.style.left = p0[0] + "px";
        span.style.top = p1[1] + "px";
        span.style.width = Math.max(1, p1[0] - p0[0]) + "px";
        span.style.height = Math.max(1, p0[1] - p1[1]) + "px";
        span.style.fontSize = Math.max(4, p0[1] - p1[1]) + "px";
        container.appendChild(span);
      }
      return container.querySelector("span") !== null;
    },

    /** PDF-space quads (the shape App.runSearch expects) for every stored
        word containing the query — the per-page fallback for image-only
        pages that pdf.js's getTextContent() sees as empty. */
    searchRects(pageNum, q) {
      const s = this._store() || [];
      const e = s.find((x) => x.page === pageNum);
      if (!e || !Array.isArray(e.words)) return [];
      const rects = [];
      for (const w of e.words) {
        if (!w.text || !w.bbox || w.text.toLowerCase().indexOf(q) === -1) continue;
        const b = w.bbox;
        rects.push({
          pts: [
            { x: b.x0, y: b.y0 }, { x: b.x1, y: b.y0 },
            { x: b.x1, y: b.y1 }, { x: b.x0, y: b.y1 },
          ],
        });
      }
      return rects;
    },

    async _getWorker(langs) {
      const want = (langs || this._defaultLang);
      if (this._worker && this._workerLangs === want) return this._worker;
      // a different language set (or no worker yet): start clean — the worker
      // loads its languages at creation, and _ensureLangs has already seeded
      // the cache so every lang is a hit (only the vendored eng could ever
      // fall through to the local langPath). NOTE: the old worker is
      // terminated DIRECTLY, NOT via cancel() — cancel() sets the run's
      // _cancelled flag (a user abort), and a language swap between runs must
      // not poison the fresh run into breaking on its first page.
      if (this._worker) {
        const old = this._worker;
        this._worker = null;
        try { old.terminate(); } catch (e) { /* ignore */ }
      }
      this._workerLangs = want;
      // All-local, ROOT-RELATIVE paths. workerBlobURL must be OFF: the default
      // blob wrapper does importScripts(path), and Chromium cannot resolve a
      // path-absolute URL from inside a blob worker. The leading slash matters:
      // tesseract.js only absolutizes these via `new URL(path, location.href)`
      // when it detects a BROWSER environment — inside Electron (this app, and
      // Freebuff's preview shell) that resolution is skipped, and a bare
      // relative path would resolve against the WORKER's own directory (the
      // double vendor/tesseract/ prefix bug). Root-relative works in both.
      this._worker = await global.Tesseract.createWorker(want, 1, {
        workerPath: "/vendor/tesseract/worker.min.js",
        corePath: "/vendor/tesseract/core",
        langPath: "/vendor/tesseract/tessdata",
        cachePath: "volt-tessdata", // deterministic cache keys — Volt.OCR seeds this store
        workerBlobURL: false,
      });
      return this._worker;
    },

    /** Recognize ONE page on demand and save it into the per-doc store — used
        by App's fingerprint computation when a scanned page has no embedded
        text and no stored OCR, so a scan still gets a content fingerprint
        (a renamed copy hashes identically; a doctored file does not). Returns
        the page's text, or "" when OCR isn't possible right now (engine
        missing, a full run in progress, cancelled) or fails. The caller (the
        fingerprint) holds _fpBusy for the whole sample, so a concurrent
        runDoc waits instead of colliding. */
    async recognizePage(pageNum) {
      const app = this._app();
      const doc = app && app.currentDoc;
      if (!doc || !this.available || this._busy || this._cancelled) return "";
      const existing = this._store() || [];
      const known = existing.find((e) => e && e.page === pageNum);
      if (known && known.text) return known.text;
      try {
        const worker = await this._getWorker(this.lang());
        const { canvas, scale, pdfH } = await this._renderPage(doc, pageNum, 2);
        const { data } = await worker.recognize(canvas);
        const text = (data.text || "").replace(/\s+/g, " ").trim();
        const words = (data.words || [])
          .filter((w) => w && w.text && w.bbox)
          .map((w) => ({ text: w.text.trim(), bbox: this._bboxToPdf(w.bbox, scale, pdfH) }));
        const entry = { page: pageNum, text, words };
        const idx = existing.findIndex((x) => x.page === pageNum);
        if (idx >= 0) existing[idx] = entry; else existing.push(entry);
        this._save(existing);
        return text;
      } catch (e) {
        return "";
      }
    },

    /** Abort the current run: terminate the worker (its recognize promise
        rejects — swallowed by the per-page catch) and keep the pages that
        already finished. The next run lazily recreates the worker. */
    cancel() {
      this._cancelled = true;
      const w = this._worker;
      this._worker = null;
      if (w) { try { w.terminate(); } catch (e) { /* ignore */ } }
    },

    /** Render one page offscreen at `scale` (2× = 144dpi — the OCR sweet
        spot) with the rotation FIXED at 0 — the same display space the
        viewer uses (openBuffer forces rotDelta 0 and every render passes
        `rotation: this.rotDelta`). pdf.js's getViewport would otherwise
        default to the page's INHERENT /Rotate metadata, so a scan saved
        with /Rotate 90 (very common from scanners) would have its word
        boxes measured in the rotated space and then re-projected through
        the un-rotated display viewport — OCR highlights, search, and
        selection all landed offset from the visible text. Storing in the
        rotation-0 space keeps bboxes rotation-independent: renderTextLayer
        re-projects through the display viewport (rotDelta) at render time. */
    async _renderPage(doc, pageNum, scale) {
      const page = await doc.getPage(pageNum);
      const vp1 = page.getViewport({ scale: 1, rotation: 0 });
      const vp = page.getViewport({ scale, rotation: 0 });
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.ceil(vp.width));
      canvas.height = Math.max(1, Math.ceil(vp.height));
      const ctx = canvas.getContext("2d");
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      return { canvas, scale, pdfH: vp1.height, pdfW: vp1.width };
    },

    /** Tesseract bbox (canvas px, y-down) → PDF units (y-up, origin
        bottom-left) — the same convention pdf.js text content uses, so
        search highlights map through the page viewport identically. */
    _bboxToPdf(b, scale, pdfH) {
      return {
        x0: b.x0 / scale,
        y0: pdfH - b.y1 / scale,
        x1: b.x1 / scale,
        y1: pdfH - b.y0 / scale,
      };
    },

    /** OCR the open document (skipping pages already recognized in the
        store), saving each page as it finishes. Returns {pages, chars} or
        null on failure. Progress shows in a live toast; cancel() aborts. */
    async runDoc() {
      const app = this._app();
      const doc = app && app.currentDoc;
      const info = app && app.currentDocInfo;
      if (!doc || !info) { if (app) app.toast("Open a document first", "error"); return null; }
      if (!this.available) { if (app) app.toast("OCR engine not available (vendor/tesseract missing)", "error"); return null; }
      if (this._busy) { if (app) app.toast("OCR is already running", "error"); return null; }
      // a fingerprint computation's on-demand page OCR may be running (a
      // scanned doc's fingerprint recognizes its own sample pages at open) —
      // wait for it rather than erroring, so clicking OCR right after
      // opening a scan still starts a run
      const fpWait = Date.now();
      while (this._fpBusy && Date.now() - fpWait < 20000) {
        await new Promise((r) => setTimeout(r, 100));
      }
      if (this._fpBusy) { if (app) app.toast("OCR is busy fingerprinting this document — try again in a moment", "error"); return null; }
      this._busy = true;
      this._cancelled = false;
      this._progressEl = null;
      const langs = this.lang(); // per-document OCR language (eng by default)
      const out = (this._store() || []).slice();
      const done = new Set(out.filter((e) => e && e.text).map((e) => e.page));
      const n = doc.numPages;
      // pages already in the store (e.g. the fingerprint's on-demand page OCR
      // saved them while the doc was opening) count toward the total — the
      // run's job is to make the whole document searchable, not to re-pay
      // work that is already done
      let pages = done.size, chars = 0;
      for (const e of out) if (e && e.text) chars += e.text.length;
      const btn = app.elements && app.elements.btnOcr;
      if (btn) btn.disabled = true;
      // extra languages download + cache on demand (the vendored eng is always
      // present): a progress toast covers the fetch so a cold language doesn't
      // look frozen
      const prepToast = app.toast("Preparing OCR language…", "", true);
      try {
        const prep = await this._ensureLangs(langs, (received, total) => {
          prepToast.textContent = "Downloading OCR language " + this._label(langs) + "… " +
            this._fmtBytes(received) + (total ? " / " + this._fmtBytes(total) : "");
        });
        if (prep.errors.length) {
          prepToast.remove();
          app.toast("OCR language unavailable: " + prep.errors.join("; "), "error");
          return null;
        }
        if (prep.downloaded.length) prepToast.textContent = "Language ready — starting OCR…";
        const worker = await this._getWorker(langs);
        prepToast.remove();
        for (let p = 1; p <= n; p++) {
          if (this._cancelled) break;
          if (done.has(p)) continue;
          if (this._progressEl) this._progressEl.textContent = "OCR: page " + p + "/" + n + "…";
          else this._progressEl = app.toast("OCR: page " + p + "/" + n + "…", "", true);
          const { canvas, scale, pdfH } = await this._renderPage(doc, p, 2);
          const { data } = await worker.recognize(canvas);
          if (this._cancelled) break;
          const text = (data.text || "").replace(/\s+/g, " ").trim();
          const words = (data.words || [])
            .filter((w) => w && w.text && w.bbox)
            .map((w) => ({ text: w.text.trim(), bbox: this._bboxToPdf(w.bbox, scale, pdfH) }));
          const entry = { page: p, text, words };
          const idx = out.findIndex((x) => x.page === p);
          if (idx >= 0) out[idx] = entry; else out.push(entry);
          this._save(out); // incremental — a cancel keeps what finished
          pages++;
          chars += text.length;
          done.add(p);
        }
      } catch (e) {
        if (!this._cancelled) {
          if (this._progressEl) { this._progressEl.remove(); this._progressEl = null; }
          app.toast("OCR failed: " + (e && e.message ? e.message : e), "error");
          return null;
        }
      } finally {
        if (btn) btn.disabled = false;
        this._busy = false;
      }
      if (this._progressEl) { this._progressEl.remove(); this._progressEl = null; }
      // fresh OCR text must feed grounded chat answers immediately, and the
      // pages already on screen get their visible/selectable text layer
      if (global.Volt.AI) global.Volt.AI._pageTexts = null;
      if (global.Volt.App && global.Volt.App.renderOcrTextLayers) global.Volt.App.renderOcrTextLayers();
      // fresh OCR text can now fingerprint the document: a scanned doc gets a
      // content fingerprint only after recognition, so Restore backups can
      // match it by content (a renamed copy hashes identically) instead of
      // falling back to name + size + pages
      if (global.Volt.App && global.Volt.App.recomputeFingerprint) global.Volt.App.recomputeFingerprint();
      if (this._cancelled) {
        app.toast("OCR cancelled — " + pages + " page" + (pages === 1 ? "" : "s") + " already searchable");
      } else {
        // after a run, check whether the document's EMBEDDED text layer lines
        // up with what was just recognized: a scan with a baked-in, offset
        // OCR layer produces highlights/selection that sit beside the visible
        // text — and Volt's own OCR just proved where the visible text really
        // is. When they disagree, offer the OCR-first layer (never auto-enable
        // it — a normal digital PDF's embedded text is better than OCR).
        let misaligned = false;
        if (!this.preferLayer() && done.size) {
          const probePage = Math.min(...done);
          try { misaligned = await this._embeddedMisaligned(probePage); } catch (e2) { misaligned = false; }
        }
        const actions = misaligned ? [{
          label: "Use OCR text layer",
          onClick: () => { this.setPreferLayer(true); },
        }] : null;
        app.toast("OCR complete — " + n + " page" + (n === 1 ? "" : "s") + " searchable" +
          (pages !== n ? " (" + pages + " recognized this run)" : "") +
          (misaligned ? "; its embedded text layer is offset from the visible page" : ""),
          "ok", false, actions);
      }
      return { pages, chars };
    },
  };
})(window);
