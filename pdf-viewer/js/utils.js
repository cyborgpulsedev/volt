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
