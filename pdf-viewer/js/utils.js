/* ═══════════════════════════════════════════════════════════════
   utils.js — pure helpers (DOM-free so they can be unit tested)
   ═══════════════════════════════════════════════════════════════ */
(function (global) {
  "use strict";

  const Utils = {
    /** HTML-escape a string */
    esc(s) {
      return String(s == null ? "" : s)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    },

    /** debounce */
    debounce(fn, ms) {
      let t;
      return function (...args) {
        clearTimeout(t);
        t = setTimeout(() => fn.apply(this, args), ms);
      };
    },

    /** throttle (leading edge) */
    throttle(fn, ms) {
      let last = 0;
      return function (...args) {
        const now = Date.now();
        if (now - last >= ms) { last = now; fn.apply(this, args); }
      };
    },

    /** simple string hash → stable id for localStorage keys */
    hash(str) {
      let h = 5381;
      for (let i = 0; i < str.length; i++) {
        h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
      }
      return h.toString(36);
    },

    /** Normalize text for fingerprinting: lowercase, collapse whitespace. */
    fpNormalize(text) {
      return String(text || "").toLowerCase().replace(/\s+/g, " ").trim();
    },

    /** 64-bit FNV-1a hash → a stable 16-hex-digit fingerprint of a string.
        Pure JS (BigInt) — no crypto API dependency — so it runs identically
        in the browser, Electron, and Node unit tests. Used to fingerprint a
        document's text so backups match CONTENT, not filenames. */
    fp64(str) {
      let h = 0xcbf29ce484222325n;
      const prime = 0x100000001b3n;
      const mask = 0xffffffffffffffffn;
      const s = String(str || "");
      for (let i = 0; i < s.length; i++) {
        h ^= BigInt(s.charCodeAt(i));
        h = (h * prime) & mask;
      }
      return h.toString(16).padStart(16, "0");
    },

    uid() {
      return "a" + Math.random().toString(36).slice(2, 9) + Date.now().toString(36);
    },

    /** tokenize for search / RAG scoring */
    tokenize(text) {
      return String(text || "").toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
    },

    /** Simple token-overlap scorer with inverse-frequency weighting (BM25-lite).
        Returns score for a chunk given the query tokens. */
    scoreChunk(queryTokens, chunkText, docFreq, totalChunks) {
      const chunkTokens = Utils.tokenize(chunkText);
      if (!chunkTokens.length) return 0;
      const freq = {};
      for (const t of chunkTokens) freq[t] = (freq[t] || 0) + 1;
      let score = 0;
      for (const t of queryTokens) {
        if (!freq[t]) continue;
        const df = docFreq[t] || 1;
        const idf = Math.log(1 + (totalChunks - df + 0.5) / (df + 0.5));
        score += freq[t] * idf;
      }
      return score;
    },

    /** Split a text into overlapping chunks of ~chars, preferring paragraph breaks. */
    chunkText(text, size = 1200, overlap = 150) {
      const chunks = [];
      let i = 0;
      const clean = String(text || "").replace(/\s+/g, " ").trim();
      while (i < clean.length) {
        let end = Math.min(i + size, clean.length);
        // Try to cut at a sentence/paragraph boundary near the end
        if (end < clean.length) {
          const window = clean.slice(end - 120, end);
          const cut = window.search(/[.!?…]\s/);
          if (cut !== -1) end = end - 120 + cut + 1;
        }
        chunks.push(clean.slice(i, end).trim());
        if (end >= clean.length) break;
        i = end - overlap;
      }
      return chunks.filter((c) => c.length > 40);
    },

    /** Format bytes for display */
    fmtBytes(n) {
      if (n < 1024) return n + " B";
      if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
      return (n / (1024 * 1024)).toFixed(1) + " MB";
    },

    /** clamp */
    clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); },

    /** Async sleep */
    sleep(ms) { return new Promise((r) => setTimeout(r, ms)); },

    /** Deep-ish clone of annotations (plain JSON-safe) */
    clone(o) { return JSON.parse(JSON.stringify(o)); },

    /** download a Blob with a filename */
    download(blob, filename) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 400);
    },

    /** read a File/Blob → ArrayBuffer */
    fileToBuffer(file) {
      return file.arrayBuffer();
    },

    /* ── page management helpers (pure — unit-tested) ──────── */
    /** Parse a page-range string like "all", "1-3", "1,3,5", "1-3,5" into a
        sorted, deduped list of 1-based page numbers clamped to 1..max.
        Returns null when the string is invalid (garbage, out-of-order ranges
        like "5-2", or a page number above max). */
    parsePageRange(str, max) {
      if (!str || typeof str !== "string") return null;
      const s = str.trim().toLowerCase();
      if (!s) return null;
      if (s === "all") return Array.from({ length: max }, (_, i) => i + 1);
      const out = [];
      for (const part of s.split(",")) {
        const p = part.trim();
        if (!p) return null;
        const m = p.match(/^(\d+)(?:\s*-\s*(\d+))?$/);
        if (!m) return null;
        const a = parseInt(m[1], 10);
        const b = m[2] !== undefined ? parseInt(m[2], 10) : a;
        if (a < 1 || b < a || b > max) return null; // reject zero/descending/out-of-range
        for (let n = a; n <= b; n++) if (!out.includes(n)) out.push(n);
      }
      return out.length ? out.sort((a, b) => a - b) : null;
    },

    /** Parse the Pages manager's move-to form into a placement spec. Unlike
        parsePageRange this is ORDER-PRESERVING ("3,1" means first page to 3,
        second to 1) and does not dedupe ("3,3" is ambiguous → null). Returns
        null on invalid input (garbage, zero, out-of-range, descending ranges).
        Result shapes:
          { kind: "block", pos }  — "3", "before 3", "before page 3",
                                    "after 2" (pos = N+1): the whole selected
                                    block starts at 1-based `pos`
          { kind: "list", targets } — "1,3,5", "1,3-5": each selected page
                                    lands at the corresponding position
    */
    parseMoveTargets(str, max) {
      if (!str || typeof str !== "string") return null;
      const s = str.trim().toLowerCase();
      if (!s) return null;
      // "before page N" / "before N" / "after page N" / "after N" — reads
      // like the drag-drop indicator ("before page 3"); a block action.
      const rel = s.match(/^(before|after)\s+(?:page\s+)?(\d+)$/);
      if (rel) {
        const n = parseInt(rel[2], 10);
        if (n < 1 || n > max) return null;
        return { kind: "block", pos: rel[1] === "after" ? n + 1 : n };
      }
      // plain single position → the block starts there (backward compatible)
      if (/^\d+$/.test(s)) {
        const n = parseInt(s, 10);
        if (n < 1 || n > max) return null;
        return { kind: "block", pos: n };
      }
      // comma-separated list, optionally with ranges: "1,3,5", "1,3-5"
      const targets = [];
      for (const part of s.split(",")) {
        const p = part.trim();
        if (!p) return null;
        const m = p.match(/^(\d+)(?:\s*-\s*(\d+))?$/);
        if (!m) return null;
        const a = parseInt(m[1], 10);
        const b = m[2] !== undefined ? parseInt(m[2], 10) : a;
        if (a < 1 || b < a || b > max) return null; // reject zero/descending/out-of-range
        for (let n = a; n <= b; n++) targets.push(n);
      }
      if (!targets.length) return null;
      if (new Set(targets).size !== targets.length) return null; // duplicates are ambiguous
      return { kind: "list", targets };
    },

    /** Renumber a list of annotations after pages were removed/reordered.
        map: old page number (1-based) → new page number (1-based). Annotations
        on pages absent from the map are dropped (the page was deleted). Pure. */
    remapAnnotations(anns, map) {
      if (!Array.isArray(anns) || !map) return [];
      const out = [];
      for (const a of anns) {
        const np = map[a.page];
        if (np === undefined) continue; // page deleted — drop the annotation
        out.push({ ...a, page: np });
      }
      return out;
    },

    /** Renumber a list of bookmarks after pages were removed/reordered — the
        bookmark twin of remapAnnotations (bookmarks carry the same 1-based
        `page` field). Bookmarks on pages absent from the map are dropped
        (the page was deleted). Pure. */
    remapBookmarks(bms, map) {
      if (!Array.isArray(bms) || !map) return [];
      const out = [];
      for (const b of bms) {
        const np = map[b.page];
        if (np === undefined) continue; // page deleted — drop the bookmark
        out.push({ ...b, page: np });
      }
      return out;
    },

    /* ── modal focus trap ───────────────────────────────────── */
    /** Elements that can hold focus inside a modal. querySelectorAll's
        document order IS the tab order the trap cycles in. */
    FOCUSABLE_SELECTOR: 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',

    /** The modal focus trap's pure wrap-around decision. Given the modal's
        focusable elements (in tab order — the order _focusablesIn returns them)
        and the currently-focused element, decide where Tab/Shift+Tab moves
        focus. PURE: no DOM access, so the wrap rules are unit-testable without
        a browser.
          focusables    ordered list of focusable elements in the modal
          active        the currently focused element (or null/anything not in
                        the list when focus sits outside the trap)
          containsActive true when the active element lives inside the modal
                        (caller computes root.contains(document.activeElement))
        Returns:
          null              → no wrapping needed; native Tab continues in order
          focusables[0]     → first element (focus re-entered the trap)
          focusables[n-1]   → last element (Shift+Tab from the first / re-entry)
        Callers must preventDefault() themselves only when a target is returned
        (an empty trap keeps its own guard: Tab is swallowed so focus can't
        leave a modal that has nothing focusable inside). */
    focusTrapMove(focusables, active, opts) {
      const o = opts || {};
      const list = Array.isArray(focusables) ? focusables : [];
      if (!list.length) return null;
      const first = list[0];
      const last = list[list.length - 1];
      // focus is outside the trap (re-entry) — jump to the far end so the
      // direction of travel is preserved
      if (!o.containsActive) return o.shiftKey ? last : first;
      // at the boundaries the trap wraps to the opposite end
      if (o.shiftKey && active === first) return last;
      if (!o.shiftKey && active === last) return first;
      // anywhere in the middle — let native Tab continue in document order
      return null;
    },

    /* ── toolbar-menu keyboard navigation ─────────────────── */
    /** The toolbar-menu navigation pure decision. Given the open panel's
        focusable items (in display order — the order _menuItems returns them,
        hidden items already excluded) and the currently-focused element,
        decide where an arrow / Home / End key moves focus. PURE: no DOM
        access, so the wrap rules are unit-testable without a browser.
          items     ordered list of focusable elements in the open panel
          active    the currently focused element, or null/anything not in
                    the list when focus sits outside the panel (e.g. on the
                    menu trigger — the direction then selects the far end,
                    Windows-style)
          dir       "next" | "prev" | "first" | "last"
        Returns the target element; null only when the list is empty (the
        caller then focuses the trigger instead). A non-empty list ALWAYS
        yields a wrap target, so arrow navigation can never strand focus on
        the trigger. */
    menuNavMove(items, active, dir) {
      const list = Array.isArray(items) ? items : [];
      if (!list.length) return null;
      const first = list[0];
      const last = list[list.length - 1];
      if (dir === "first") return first;
      if (dir === "last") return last;
      const i = list.indexOf(active);
      if (dir === "next") return i === -1 ? first : i === list.length - 1 ? first : list[i + 1];
      return i === -1 ? last : i === 0 ? last : list[i - 1];
    },

    /* ── tiny Markdown renderer (safe: escapes first) ────────────── */
    markdown(md) {
      if (!md) return "";
      let src = Utils.esc(md);
      const lines = src.split("\n");
      let out = "";
      let inCode = false;
      let listTag = "";
      let codeLang = "";
      // Track WHICH list is open, not just that one is: closing always with
      // </ul> left every ordered list unterminated, and a bulleted list
      // followed directly by a numbered one never switched tags.
      const closeList = () => { if (listTag) { out += `</${listTag}>`; listTag = ""; } };

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // fenced code block
        if (/^```/.test(line)) {
          if (!inCode) {
            closeList();
            inCode = true;
            codeLang = line.replace(/^```\s*/, "");
            out += `<pre><code${codeLang ? ` data-lang="${codeLang}"` : ""}>`;
          } else {
            out += "</code></pre>\n";
            inCode = false;
          }
          continue;
        }
        if (inCode) { out += line + "\n"; continue; }

        const t = line.trim();
        if (!t) { closeList(); out += "\n"; continue; }

        // headings
        const hm = t.match(/^(#{1,6})\s+(.*)$/);
        if (hm) {
          closeList();
          const lvl = hm[1].length;
          out += `<h${lvl}>${Utils.inline(hm[2])}</h${lvl}>\n`;
          continue;
        }
        // hr
        if (/^([-*_])\s*\1\s*\1+$/.test(t)) { closeList(); out += "<hr>\n"; continue; }
        // blockquote
        if (/^&gt;\s?/.test(t)) { closeList(); out += `<blockquote>${Utils.inline(t.replace(/^&gt;\s?/, ""))}</blockquote>\n`; continue; }
        // lists
        const ul = t.match(/^[-*+]\s+(.*)$/);
        const ol = t.match(/^\d+[.)]\s+(.*)$/);
        if (ul) {
          if (listTag !== "ul") { closeList(); out += "<ul>"; listTag = "ul"; }
          out += `<li>${Utils.inline(ul[1])}</li>`;
          continue;
        }
        if (ol) {
          if (listTag !== "ol") { closeList(); out += "<ol>"; listTag = "ol"; }
          out += `<li>${Utils.inline(ol[1])}</li>`;
          continue;
        }
        closeList();
        out += `<p>${Utils.inline(t)}</p>\n`;
      }
      if (inCode) out += "</code></pre>\n";
      closeList();
      return out;
    },

    /** Greedy word-wrap for text edits: split `text` into lines that each
        fit `budget`, measuring every word with the caller-supplied `widthOf`
        (which must return the width of a string in the same units as
        budget). Whitespace is collapsed first; a word longer than the budget
        gets its own line rather than being split mid-word. Pure — no DOM, so
        it's unit-testable. Returns an array of line strings ([] for empty
        input). */
    wrapText(text, widthOf, budget) {
      const words = String(text || "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
      if (!words.length) return [];
      const lines = [];
      let line = "", lineW = 0;
      for (const w of words) {
        const wW = widthOf(w);
        if (line && lineW + widthOf(" ") + wW > budget) {
          lines.push(line);
          line = "";
          lineW = 0;
        }
        if (line) {
          line += " " + w;
          lineW += widthOf(" ") + wW;
        } else {
          line = w;
          lineW = wW;
        }
      }
      if (line) lines.push(line);
      return lines;
    },

    /* ── version / changelog helpers (pure — unit-tested) ──── */
    /** Semantic x.y.z version comparator: returns <0 / 0 / >0. Missing or
        non-numeric parts compare as 0, so malformed strings never throw. */
    cmpVersions(a, b) {
      const pa = String(a == null ? "" : a).split(".").map(Number);
      const pb = String(b == null ? "" : b).split(".").map(Number);
      for (let i = 0; i < 3; i++) {
        const x = pa[i] || 0, y = pb[i] || 0;
        if (x !== y) return x - y;
      }
      return 0;
    },

    /** Split a CHANGELOG.md into (version, body) pairs on `## x.y.z` headings
        (the format gen-sw.mjs stamps and the version banner diffs). Returns
        [{ ver, body }] in document order; [] for empty input or no headings. */
    changelogSections(md) {
      if (!md) return [];
      const sections = [];
      const re = /^##\s+(\d+\.\d+\.\d+)\s*$/gm;
      let m, lastIdx = -1, lastVer = null;
      while ((m = re.exec(md))) {
        if (lastVer) sections.push({ ver: lastVer, body: md.slice(lastIdx, m.index) });
        lastVer = m[1];
        lastIdx = re.lastIndex;
      }
      if (lastVer) sections.push({ ver: lastVer, body: md.slice(lastIdx) });
      return sections;
    },

    /** Extract the bullet items from a changelog body: trimmed lines starting
        with "- " or "* ", returned WITHOUT the marker. The caller decides how
        to render them (the version banner / About modal escape + wrap). */
    bulletItems(body) {
      return String(body == null ? "" : body).split(/\r?\n/).map((l) => l.trim())
        .filter((l) => /^[-*]\s+/.test(l)).map((l) => l.replace(/^[-*]\s+/, ""));
    },

    /** Shared bullet-list HTML for a changelog section body: escaped <li>
        items in a <ul>, or "" when the body has no bullets. Both the version
        banner's tooltip and the About modal render through this — one path,
        so escaping and markup can't drift between the two views. */
    _changelogBulletList(body) {
      const items = Utils.bulletItems(body);
      if (!items.length) return "";
      return "<ul>" + items.map((i) => "<li>" + Utils.esc(i) + "</li>").join("") + "</ul>";
    },

    /** Build the version-banner tooltip's HTML: the CHANGELOG sections newer
        than `current` and not newer than `served`, escaped, as <li> bullets.
        PURE — callers read window.__VOLT_VERSION / the served version and pass
        them in. On a downgrade (or unknown current) falls back to the served
        section. Never throws (the tooltip must never break the app). */
    changelogHtml(md, current, served) {
      if (!md) return "";
      const sections = Utils.changelogSections(md);
      if (!sections.length) return "";
      const cur = (typeof current === "string" && /^\d+\.\d+\.\d+$/.test(current)) ? current : null;
      const svd = (typeof served === "string" && /^\d+\.\d+\.\d+$/.test(served)) ? served : null;
      let wanted = sections.filter((s) =>
        (cur ? Utils.cmpVersions(s.ver, cur) > 0 : true) &&
        (svd ? Utils.cmpVersions(s.ver, svd) <= 0 : true));
      if (!wanted.length && svd) {
        // e.g. a downgrade or the current version unknown — show the served one
        const exact = sections.find((s) => s.ver === svd);
        if (exact) wanted = [exact];
      }
      if (!wanted.length) return "";
      return wanted.map((s) =>
        (wanted.length === 1
          ? '<div class="ver-tip-title">What\'s new in v' + Utils.esc(s.ver) + "</div>"
          : '<div class="ver-tip-sec"><b>v' + Utils.esc(s.ver) + "</b>") + Utils._changelogBulletList(s.body) +
        (wanted.length > 1 ? "</div>" : "")).join("");
    },

    /** The About modal's "what this version changed" HTML: the CHANGELOG
        section for `version` (falling back to the first section when the
        version is unknown, e.g. "dev" builds) rendered as
        '<h4>What\'s new in vX</h4>' + the shared bullet list. Returns "" when
        there is nothing to show (empty changelog, or the section has no
        bullets). PURE — the caller fetches the markdown and reads the version.
        Never throws (the modal must never break the app). */
    aboutChangelogHtml(md, version) {
      if (!md) return "";
      const sections = Utils.changelogSections(md);
      if (!sections.length) return "";
      const cur = (typeof version === "string" && /^\d+\.\d+\.\d+$/.test(version)) ? version : null;
      const idx = sections.findIndex((s) => s.ver === cur);
      const sec = (idx >= 0 ? sections[idx] : sections[0]);
      const list = Utils._changelogBulletList(sec.body);
      if (!list) return "";
      return '<h4>What\'s new in v' + Utils.esc(sec.ver) + "</h4>" + list;
    },

    /* ── page-selection + thumbnails + restore-summary (pure — unit-tested) ── */
    /** The lo/hi of an inclusive contiguous selection [anchor, current],
        clamped to [min, max] and ordered — the shared math behind Shift+click
        range selection in the Pages manager (0-based) and the sidebar
        thumbnails (1-based). A stale anchor outside the bounds clamps to the
        edge; an anchor and target BOTH outside the same edge yield lo > hi,
        an empty range — matching the original loops exactly. */
    clampedRange(anchor, current, min, max) {
      const lo = Math.max(min, Math.min(anchor, current));
      const hi = Math.min(max, Math.max(anchor, current));
      return { lo, hi };
    },

    /** Parse a page number (string or number) and clamp it into [1, max] —
        the shared rule behind the move-to-position forms and range selection,
        so bad input (empty, non-numeric, out of bounds) always lands on a
        real page: 0 / NaN → 1, above max → max, fractions round. `max` must
        be a real page count (≥ 1). */
    clampPage(value, max) {
      return Math.max(1, Math.min(max, Math.round(Number(value) || 1)));
    },

    /** Thumbnail render scale: the pdf.js scale that fits a page `pageWidth`
        points wide into the ~120px thumb column — a width-ratio capped at
        0.22 so narrow pages don't get oversized thumbs. Unknown / zero
        widths fall back to 600pt (a letter-ish page). */
    thumbScale(pageWidth, cap = 0.22, target = 120, fallback = 600) {
      return Math.min(cap, target / (pageWidth || fallback));
    },

    /** The post-restore summary card's rows (what the restore actually
        landed), given the plain facts — the DOM / Volt module reads stay in
        app.js. Returns [{k, v, title}] in display order. PURE — never throws.
        annCount is the total annotation count, notes the note-annotations
        among them (marks = annCount - notes); `ai` is the EFFECTIVE doc
        settings ({model, maxContextChars, systemPrompt}) shown when the
        backup carried aiSettings; chatCount is the live message count when
        the backup carried chatHistory. */
    restoreSummaryRows({ annCount = 0, notes = 0, ai = null, aiInBackup = false, chatInBackup = false, chatCount = 0 } = {}) {
      const p = (n) => (n === 1 ? "" : "s");
      const marks = annCount - notes;
      let annTxt = annCount + " annotation" + p(annCount);
      if (annCount) {
        annTxt += " — " + marks + " mark" + p(marks);
        if (notes) annTxt += " · " + notes + " note" + p(notes);
      }
      const rows = [{ k: "Annotations", v: annTxt, title: annTxt }];
      if (aiInBackup) {
        const eff = (ai && typeof ai === "object") ? ai : {};
        const parts = [];
        if (eff.model) parts.push("Model: " + eff.model);
        if (eff.maxContextChars) parts.push("Context: " + Number(eff.maxContextChars).toLocaleString() + " chars");
        if (eff.systemPrompt) parts.push("Prompt: “" + Utils.trunc(eff.systemPrompt, 64) + "”");
        const v = parts.length ? parts.join(" · ") : "None in this backup";
        rows.push({ k: "AI overrides", v, title: parts.join("\n") || v });
      } else {
        rows.push({ k: "AI overrides", v: "Not in this backup", title: "This backup didn't include AI overrides" });
      }
      if (chatInBackup) {
        rows.push({ k: "Chat", v: chatCount + " message" + p(chatCount), title: chatCount + " message" + p(chatCount) });
      } else {
        rows.push({ k: "Chat", v: "Not in this backup", title: "This backup didn't include chat history" });
      }
      return rows;
    },

    /* ── small display helpers (pure — unit-tested) ────────── */
    /** "report.PDF" → "report" — the document-name base used for export
        filenames; returns the input unchanged without a .pdf suffix. */
    stripPdfExt(name) {
      return String(name == null ? "" : name).replace(/\.pdf$/i, "");
    },

    /** PDF points → "W × H in" label (72pt = 1in), trailing zeros trimmed.
        Returns "" when either dimension is missing. */
    pageSizeLabel(w, h) {
      if (!w || !h) return "";
      const f = (pt) => (Math.round((pt / 72) * 100) / 100).toString().replace(/\.?0+$/, "");
      return f(w) + " × " + f(h) + " in";
    },

    /** "long text" → "long te…" when longer than n chars. */
    trunc(s, n) {
      const str = String(s == null ? "" : s);
      return str.length > n ? str.slice(0, n).trimEnd() + "…" : str;
    },

    /** inline markdown: bold, italic, code, links */
    inline(s) {
      return s
        .replace(/`([^`]+)`/g, "<code>$1</code>")
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/\*([^*]+)\*/g, "<em>$1</em>")
        .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
        .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
    },

    /* ── PDF security + redaction (pure; used by Volt.Secure and the
           redact tool's export path) ─────────────────────────────── */

    /** MD5 (RFC 1321) over bytes → 16-byte Uint8Array. Self-contained so the
        PDF standard security handler needs no crypto dependency. */
    md5(bytes) {
      const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      const s = (n) => Math.sin(n) * 4294967296;
      const K = new Uint32Array(64);
      for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(s(i + 1)));
      const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
        5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
        4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
        6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
      const rol = (x, n) => (x << n) | (x >>> (32 - n));
      const le = (n) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
      const buf = new Uint8Array(b.length + 8 + 64 - ((b.length + 8) % 64 || 64));
      buf.set(b);
      const bitLen = b.length * 8;
      buf[b.length] = 0x80;
      const lenBytes = le(bitLen >>> 0); // low 32 bits of the bit length
      buf.set([lenBytes[0], lenBytes[1], lenBytes[2], lenBytes[3], 0, 0, 0, 0], buf.length - 8); // + high 32 (0 for small inputs)
      let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
      const M = new Uint32Array(16);
      for (let off = 0; off < buf.length; off += 64) {
        for (let i = 0; i < 16; i++) {
          M[i] = buf[off + i * 4] | (buf[off + i * 4 + 1] << 8) | (buf[off + i * 4 + 2] << 16) | (buf[off + i * 4 + 3] << 24);
        }
        let A = a0, B = b0, C = c0, D = d0;
        for (let i = 0; i < 64; i++) {
          let F, g;
          if (i < 16) { F = (B & C) | (~B & D); g = i; }
          else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
          else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
          else { F = C ^ (B | ~D); g = (7 * i) % 16; }
          F = (F + A + K[i] + M[g]) >>> 0;
          A = D; D = C; C = B;
          B = (B + rol(F, S[i])) >>> 0;
        }
        a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
      }
      return new Uint8Array([...le(a0), ...le(b0), ...le(c0), ...le(d0)]);
    },

    /** RC4 over bytes → same-length Uint8Array (the PDF standard security
        handler's stream/string cipher). */
    rc4(key, data) {
      const k = new Uint8Array(key);
      const S = new Uint8Array(256);
      for (let i = 0; i < 256; i++) S[i] = i;
      let j = 0;
      for (let i = 0; i < 256; i++) {
        j = (j + S[i] + k[i % k.length]) & 255;
        const t = S[i]; S[i] = S[j]; S[j] = t;
      }
      const out = new Uint8Array(data.length);
      let i = 0; j = 0;
      for (let n = 0; n < data.length; n++) {
        i = (i + 1) & 255;
        j = (j + S[i]) & 255;
        const t = S[i]; S[i] = S[j]; S[j] = t;
        out[n] = data[n] ^ S[(S[i] + S[j]) & 255];
      }
      return out;
    },

    /** The 32-byte pad string every PDF security algorithm pads passwords
        with (ISO 32000-1 §7.6.3.3). */
    PDF_PAD: new Uint8Array([0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
      0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a]),

    _pdfPad(pw) {
      const s = new TextEncoder().encode(String(pw == null ? "" : pw));
      if (s.length >= 32) return s.slice(0, 32);
      const out = new Uint8Array(32);
      out.set(s);
      out.set(this.PDF_PAD.subarray(s.length));
      return out;
    },

    /** Compute the PDF standard security handler's encryption dict values
        (R=2, V=1, RC4-40) — the classic "lock this PDF" mechanism every
        reader implements. Pure: returns {O, U, P, key} from the two
        passwords and the permission flags.
        permissions: {printing, modifying, copying, annotations} booleans
        (true = ALLOWED). id0: the 16-byte first file-identifier element. */
    pdfSecurityKeys(userPassword, ownerPassword, permissions, id0) {
      const perms = permissions || {};
      // P bit layout (ISO 32000-1 §7.6.3.2): bit 3 (value 4) print, bit 4
      // (8) modify, bit 5 (16) copy, bit 6 (32) annotations/form. Set = the
      // operation is ALLOWED; every other bit is reserved and shall be 1.
      let P = 0xffffffff;
      if (!perms.printing) P &= ~4;
      if (!perms.modifying) P &= ~8;
      if (!perms.copying) P &= ~16;
      if (!perms.annotations) P &= ~32;
      P = P >>> 0;
      const user = this._pdfPad(userPassword);
      const owner = String(ownerPassword == null ? "" : ownerPassword).length
        ? this._pdfPad(ownerPassword)
        : user; // no owner password → the user password IS the owner password
      // O (Algorithm 3, R=2): RC4(MD5(padded owner), padded user)
      const O = this.rc4(this.md5(owner), user);
      // encryption key (Algorithm 2, R=2): first 5 bytes of MD5(user+O+P+ID0)
      const keyInput = new Uint8Array(user.length + O.length + 4 + (id0 ? id0.length : 0));
      keyInput.set(user); keyInput.set(O, 32);
      const ple = new Uint8Array([P & 255, (P >>> 8) & 255, (P >>> 16) & 255, (P >>> 24) & 255]);
      keyInput.set(ple, 64);
      if (id0) keyInput.set(id0, 68);
      const key = this.md5(keyInput).slice(0, 5); // 40-bit
      // U (Algorithm 4, R=2): RC4(encryption key, padding string)
      const U = this.rc4(key, this.PDF_PAD);
      return { O, U, P, key };
    },

    /** The per-object encryption key (Algorithm 1, R=2): first 10 bytes of
        MD5(encryption key + object number LE + generation number LE). */
    _pdfObjectKey(key, objNum, genNum) {
      const input = new Uint8Array(key.length + 5);
      input.set(key);
      input[key.length] = objNum & 255;
      input[key.length + 1] = (objNum >>> 8) & 255;
      input[key.length + 2] = (objNum >>> 16) & 255;
      input[key.length + 3] = genNum & 255;
      input[key.length + 4] = (genNum >>> 8) & 255;
      return this.md5(input).slice(0, 10);
    },

    /** Remove text-showing operators covered by redaction rectangles from a
        PDF content stream. Pure string → string: parses the operator stream,
        tracks the text state (BT/ET, Tf font size, Tm/Td/T* text matrix, and
        the show operators Tj / TJ / ' / "),
        and drops every show op whose baseline position intersects
        one of the redaction rects (PDF page coords, y-up). A removed show op
        leaves its BT/ET block and operands in place — valid PDF, draws
        nothing. Slightly over-removes on partial lines (the whole op goes);
        that is the safe direction for redaction. */
    pdfRedactContent(content, rects) {
      if (!content || !Array.isArray(rects) || !rects.length) return content;
      const toks = this._pdfContentTokens(content);
      let inText = false;
      let fontSize = 1;
      // text matrix: [a b c d e f] — e/f = the baseline origin in page space
      let tm = [1, 0, 0, 1, 0, 0];
      let tlm = [1, 0, 0, 1, 0, 0];
      let leading = 0;
      const drop = new Set();
      // a removed show op takes its operand token(s) with it — a bare literal
      // with no operator would be malformed content. Tj/TJ/' take ONE operand
      // (the string/array straight before the keyword); '" takes three (word
      // spacing, char spacing, string). Never cross a keyword boundary, so a
      // preceding Td/Tf's own operands stay put.
      const dropWithOperands = (k, count) => {
        drop.add(k);
        let j = k - 1, taken = 0;
        while (j >= 0 && taken < count) {
          const t = toks[j];
          if (t.kw !== undefined) break;
          drop.add(j);
          taken++;
          j--;
        }
      };
      const inside = (x, y, w) => rects.some((r) => {
        // the glyph box from the baseline: descenders ≈0.3em below, ascenders
        // ≈0.85em above — tight enough that a bar over one line does NOT catch
        // the line next to it
        const y0 = y - fontSize * 0.3, y1 = y + fontSize * 0.85;
        const yHit = y0 <= r.y + r.h && y1 >= r.y;
        if (!yHit) return false;
        const pad = fontSize * 0.5;
        // horizontal overlap of the estimated extent (≈0.5em per char)
        return x <= r.x + r.w + pad && x + w + pad >= r.x;
      });
      for (let k = 0; k < toks.length; k++) {
        const t = toks[k];
        const kw = t.kw;
        if (kw === "BT") { inText = true; tm = [1, 0, 0, 1, 0, 0]; tlm = [1, 0, 0, 1, 0, 0]; continue; }
        if (kw === "ET") { inText = false; continue; }
        if (kw === "Tf") {
          // the size operand is the last NUM token before this keyword
          const sizeTok = this._pdfPrevNum(toks, k - 1);
          if (sizeTok) fontSize = sizeTok.num;
          continue;
        }
        if (kw === "Tm") {
          const a = this._pdfPrevNums(toks, k - 1, 6);
          if (a && a.length === 6) tm = [a[0], a[1], a[2], a[3], a[4], a[5]];
          tlm = tm;
          continue;
        }
        if (kw === "Td" || kw === "TD") {
          const a = this._pdfPrevNums(toks, k - 1, 2);
          if (a && a.length === 2) {
            tlm = [1, 0, 0, 1, tlm[4] + a[0], tlm[5] + a[1]];
            tm = tlm;
            if (kw === "TD") leading = -a[1];
          }
          continue;
        }
        if (kw === "T*") { tlm = [1, 0, 0, 1, tlm[4], tlm[5] - leading]; tm = tlm; continue; }
        if (kw === "'" || kw === '"') {
          if (kw === "'") tlm = [1, 0, 0, 1, tlm[4], tlm[5] - leading];
          else {
            const a = this._pdfPrevNums(toks, k - 1, 2);
            if (a && a.length === 2) leading = a[1];
            tlm = [1, 0, 0, 1, tlm[4], tlm[5] - leading];
          }
          tm = tlm;
          if (inText) {
            const strTok = this._pdfPrevStr(toks, k - 1);
            const w = (strTok ? strTok.str.length : 0) * fontSize * 0.5;
            if (inside(tm[4], tm[5], w)) dropWithOperands(k, 3);
          }
          continue;
        }
        if (kw === "Tj" || kw === "TJ") {
          if (inText) {
            const strTok = this._pdfPrevStr(toks, k - 1);
            const len = strTok ? strTok.str.length : this._pdfArrayStringLen(toks, k - 1);
            const w = len * fontSize * 0.5;
            if (inside(tm[4], tm[5], w)) dropWithOperands(k, 1);
          }
          continue;
        }
      }
      // rebuild from the ORIGINAL byte ranges: kept tokens keep their exact
      // spacing (whitespace between tokens is untouched), dropped tokens are
      // excised by range
      const kept = [];
      let prevEnd = 0;
      for (const t of toks) {
        if (drop.has(t.index)) { prevEnd = t.end; continue; }
        kept.push(content.slice(prevEnd, t.end));
        prevEnd = t.end;
      }
      kept.push(content.slice(prevEnd));
      return kept.join("");
    },

    /** Tokenize a PDF content stream into {index, start, end, raw, kw?,
        num?, str?} in original order (used by pdfRedactContent). Handles
        numbers, names, literal strings, hex strings, arrays, dicts, comments
        and keywords. */
    _pdfContentTokens(content) {
      const toks = [];
      let i = 0;
      const n = content.length;
      const ws = (c) => c === " " || c === "\t" || c === "\r" || c === "\n" || c === "\f" || c === "\0";
      const numRe = /^-?\d+(\.\d+)?([eE][-+]?\d+)?/;
      while (i < n) {
        const c = content[i];
        if (ws(c)) { i++; continue; }
        if (c === "%") { while (i < n && content[i] !== "\n" && content[i] !== "\r") i++; continue; }
        const start = i;
        const idx = toks.length;
        if (c === "<" && content[i + 1] === "<") {
          let depth = 0;
          while (i < n) {
            if (content[i] === "<" && content[i + 1] === "<") depth++;
            else if (content[i] === ">" && content[i + 1] === ">") { depth--; i += 2; if (depth <= 0) break; continue; }
            i++;
          }
          toks.push({ index: idx, start, end: i, raw: content.slice(start, i) });
          continue;
        }
        if (c === "<") {
          while (i < n && content[i] !== ">") i++;
          if (i < n) i++;
          const hex = content.slice(start + 1, i - 1).replace(/\s+/g, "");
          toks.push({ index: idx, start, end: i, raw: content.slice(start, i), str: this._pdfHexToString(hex) });
          continue;
        }
        if (c === "[") {
          let depth = 0;
          while (i < n) {
            if (content[i] === "[") depth++;
            else if (content[i] === "]") { depth--; i++; if (depth <= 0) break; continue; }
            i++;
          }
          toks.push({ index: idx, start, end: i, raw: content.slice(start, i) });
          continue;
        }
        if (c === "(") {
          let depth = 1; i++;
          while (i < n && depth > 0) {
            if (content[i] === "\\") { i += 2; continue; }
            if (content[i] === "(") depth++;
            else if (content[i] === ")") depth--;
            i++;
          }
          toks.push({ index: idx, start, end: i, raw: content.slice(start, i), str: this._pdfUnescapeLiteral(content.slice(start + 1, i - 1)) });
          continue;
        }
        if (c === "/") {
          i++;
          while (i < n && !ws(content[i]) && !"()<>[]{}/%".includes(content[i])) i++;
          toks.push({ index: idx, start, end: i, raw: content.slice(start, i) });
          continue;
        }
        const m = numRe.exec(content.slice(i));
        if (m && m[0]) {
          i += m[0].length;
          toks.push({ index: idx, start, end: i, raw: content.slice(start, i), num: parseFloat(m[0]) });
          continue;
        }
        while (i < n && !ws(content[i]) && !"()<>[]{}/%".includes(content[i])) i++;
        toks.push({ index: idx, start, end: i, raw: content.slice(start, i), kw: content.slice(start, i) });
      }
      return toks;
    },

    _pdfPrevNum(toks, from) {
      for (let j = from; j >= 0; j--) if (toks[j].num !== undefined && toks[j].kw === undefined) return toks[j];
      return null;
    },
    _pdfPrevNums(toks, from, count) {
      const out = [];
      for (let j = from; j >= 0 && out.length < count; j--) {
        if (toks[j].num !== undefined && toks[j].kw === undefined) out.unshift(toks[j].num);
      }
      return out;
    },
    _pdfPrevStr(toks, from) {
      for (let j = from; j >= 0; j--) {
        if (toks[j].str !== undefined && toks[j].kw === undefined && toks[j].num === undefined) return toks[j];
      }
      return null;
    },
    _pdfArrayStringLen(toks, from) {
      // the operand is the array token immediately before the keyword
      const t = from >= 0 ? toks[from] : null;
      if (!t || !/^\[/.test(t.raw)) return 0;
      // count characters in the TJ array's string items (heuristic)
      let len = 0;
      const m = /(\(([^)]*)\)|<([0-9a-fA-F\s]*)>)/g;
      let mm;
      while ((mm = m.exec(t.raw))) {
        len += mm[2] !== undefined ? mm[2].length : Math.floor(mm[3].replace(/\s+/g, "").length / 2);
      }
      return len;
    },

    _pdfHexToString(hex) {
      const clean = (hex || "").replace(/\s+/g, "");
      if (clean.length % 2) clean += "0";
      let out = "";
      for (let i = 0; i < clean.length; i += 2) out += String.fromCharCode(parseInt(clean.slice(i, i + 2), 16));
      return out;
    },

    _pdfUnescapeLiteral(s) {
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
          let v = ""; let j = i + 1;
          for (let q = 0; q < 3 && j < s.length && s[j] >= "0" && s[j] <= "7"; q++, j++) v += s[j];
          out += String.fromCharCode(parseInt(v, 8));
          i = j - 1;
        }
        else { out += c; i++; }
      }
      return out;
    },

    /* ── ISO PDF standards (PDF/A-1b, ISO 19005-1) ────────────── */

    /** Build a minimal-but-VALID sRGB ICC v2 matrix profile (the
        DestOutputProfile a PDF/A-1 OutputIntent requires). Constructed
        byte-by-byte so there is no huge base64 blob in the bundle and the
        structure is unit-testable: ICC header (128 bytes) + tag table
        (8 tags) + tag data (text description, D50 white point, the three
        sRGB primaries as XYZ, and linear tone curves). Pure: no DOM, no
        random state. */
    buildSrgbIcc() {
      const u32 = (v) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
      const u16 = (v) => [(v >>> 8) & 255, v & 255];
      const s15 = (v) => Math.round(v * 65536); // s15Fixed16
      const tag = (sig, data) => ({ sig, data });
      const chunks = [];
      const push = (arr) => { chunks.push(Uint8Array.from(arr)); };

      // header (128 bytes)
      const header = new Uint8Array(128);
      const w = (off, bytes) => { header.set(bytes, off); };
      // size + CMM ('none' — no color engine) set after the tag table is
      // laid out (size known then); fill everything else now.
      w(8, u32(0x02100000)); // version 2.1
      w(12, u32(0x6d6e7472)); // device class 'mntr'
      w(16, u32(0x52474220)); // color space 'RGB '
      w(20, u32(0x58595a20)); // PCS 'XYZ '
      // date/time (12 bytes): 2026-01-01 00:00:00
      w(24, u16(2026)); w(26, u16(1)); w(28, u16(1)); w(30, u16(0)); w(32, u16(0)); w(34, u16(0));
      w(36, u32(0x61637370)); // 'acsp'
      w(40, u32(0)); // platform
      w(44, u32(0)); // flags
      w(48, u32(0)); w(52, u32(0)); // manufacturer, model
      w(56, u32(0)); w(60, u32(0)); // attributes (64-bit, zero)
      w(64, u32(0)); // perceptual intent
      // PCS illuminant D50
      w(68, u32(s15(0.9642))); w(72, u32(s15(1.0))); w(76, u32(s15(0.8249)));
      w(80, u32(0)); // creator

      // tag data (4-byte aligned)
      const desc = (() => {
        const s = "sRGB IEC61966-2.1";
        const b = new Uint8Array(4 + 4 + 4 + s.length);
        b.set(u32(0x64657363), 0); // 'desc'
        b.set(u32(0), 4); // reserved
        b.set(u32(s.length), 8);
        for (let i = 0; i < s.length; i++) b[12 + i] = s.charCodeAt(i);
        return b;
      })();
      const xyz = (x, y, z) => {
        const b = new Uint8Array(4 + 4 + 12);
        b.set(u32(0x58595a20), 0); // 'XYZ '
        b.set(u32(0), 4);
        b.set(u32(s15(x)), 8); b.set(u32(s15(y)), 12); b.set(u32(s15(z)), 16);
        return b;
      };
      const curve = (gamma) => {
        const b = new Uint8Array(4 + 4 + 4 + 2);
        b.set(u32(0x63757276), 0); // 'curv'
        b.set(u32(0), 4);
        b.set(u32(1), 8); // one entry
        b.set(u16(gamma), 12);
        return b;
      };
      const tags = [
        tag(0x64657363, desc), // 'desc'
        tag(0x77747074, xyz(0.9642, 1.0, 0.8249)), // 'wtpt'
        tag(0x7258595a, xyz(0.4361, 0.2225, 0.0139)), // 'rXYZ'
        tag(0x6758595a, xyz(0.3851, 0.7169, 0.0971)), // 'gXYZ'
        tag(0x6258595a, xyz(0.1431, 0.0606, 0.7141)), // 'bXYZ'
        tag(0x72545243, curve(0x0100)), // 'rTRC' (gamma 1.0)
        tag(0x67545243, curve(0x0100)), // 'gTRC'
        tag(0x62545243, curve(0x0100)), // 'bTRC'
      ];
      // tag table
      const table = new Uint8Array(4 + tags.length * 12);
      table.set(u32(tags.length), 0);
      let off = 128 + table.length;
      const pad = (n) => (n + 3) & ~3;
      for (let i = 0; i < tags.length; i++) {
        const base = 4 + i * 12;
        table.set(u32(tags[i].sig), base);
        table.set(u32(off), base + 4);
        table.set(u32(tags[i].data.length), base + 8);
        off += pad(tags[i].data.length);
      }
      const size = off;
      header.set(u32(size), 0);
      header.set(u32(0x6e6f6e65), 4); // 'none' CMM (no color engine)
      push(header);
      push(table);
      for (const tg of tags) { push(tg.data); if (tg.data.length % 4) push(new Uint8Array(4 - (tg.data.length % 4))); }
      const out = new Uint8Array(size);
      let o = 0;
      for (const c of chunks) { out.set(c, o); o += c.length; }
      return out;
    },

    /** Build the XMP metadata packet a PDF/A-1 document must carry (ISO
        19005-1 §6.7.3): the pdfaid part/conformance pair plus the core
        dc/pdf/xmp properties. Returns the XML string — the exporter wraps it
        in a /Metadata stream (UNcompressed: PDF/A forbids filters on the
        metadata stream). Pure; escapes the text fields for XML. */
    pdfA1bXmp(opts) {
      const o = opts || {};
      const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      const iso = (d) => (d instanceof Date && !isNaN(d.getTime())) ? d.toISOString().replace(/\.\d{3}Z$/, "Z") : "";
      const title = esc(o.title || "");
      const producer = esc(o.producer || "");
      const creator = esc(o.creator || "");
      const created = iso(o.created);
      const modified = iso(o.modified);
      let x = '<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>\n';
      x += '<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Volt">\n';
      x += ' <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n';
      x += '  <rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">\n';
      x += '   <dc:format>application/pdf</dc:format>\n';
      if (title) x += '   <dc:title><rdf:Alt><rdf:li xml:lang="x-default">' + title + '</rdf:li></rdf:Alt></dc:title>\n';
      if (creator) x += '   <dc:creator><rdf:Seq><rdf:li>' + creator + '</rdf:li></rdf:Seq></dc:creator>\n';
      x += '  </rdf:Description>\n';
      x += '  <rdf:Description rdf:about="" xmlns:pdf="http://ns.adobe.com/pdf/1.3/">\n';
      if (producer) x += '   <pdf:Producer>' + producer + '</pdf:Producer>\n';
      x += '  </rdf:Description>\n';
      x += '  <rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/">\n';
      if (created) x += '   <xmp:CreateDate>' + created + '</xmp:CreateDate>\n';
      if (modified) x += '   <xmp:ModifyDate>' + modified + '</xmp:ModifyDate>\n';
      x += '   <xmp:CreatorTool>Volt</xmp:CreatorTool>\n';
      x += '  </rdf:Description>\n';
      x += '  <rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/">\n';
      x += '   <pdfaid:part>1</pdfaid:part>\n';
      x += '   <pdfaid:conformance>B</pdfaid:conformance>\n';
      x += '  </rdf:Description>\n';
      x += ' </rdf:RDF>\n';
      x += '</x:xmpmeta>\n';
      x += '<?xpacket end="w"?>\n';
      return x;
    },

    /** Inject a trailer /ID pair into pdf-lib's classic-xref output (which
        omits it) — PDF/A-1 requires a file identifier (ISO 19005-1 §6.1.3).
        Pure string → string: finds the last `trailer << … >>` block and
        inserts `/ID [<id> <id>]` before its closing `>>`; leaves the bytes
        untouched when an /ID is already present. idHex: the 32-hex-char
        (16-byte) identifier, or the string "RANDOM" to derive one from the
        source's own hash. */
    injectPdfTrailerId(src, idHex) {
      if (!src || !/\/ID\s*\[/.test(src)) {
        const tail = src.lastIndexOf("trailer");
        if (tail < 0) return src;
        const close = src.indexOf(">>", tail);
        if (close < 0) return src;
        let id = idHex;
        if (id === "RANDOM") id = this.hash(src).replace(/[^0-9a-f]/gi, "").slice(0, 32).padEnd(32, "0");
        const clean = String(id || "").replace(/[^0-9a-fA-F]/g, "");
        if (clean.length !== 32) return src;
        const pair = " /ID [<" + clean.toLowerCase() + "> <" + clean.toLowerCase() + ">] ";
        return src.slice(0, close) + pair + src.slice(close);
      }
      return src;
    },
  };

  global.Utils = Utils;
})(typeof window !== "undefined" ? window : globalThis);
