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
  };

  global.Utils = Utils;
})(typeof window !== "undefined" ? window : globalThis);
