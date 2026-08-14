/* ═══════════════════════════════════════════════════════════════
   annotations.js — Volt.Ann
   Highlight / underline / strike / notes in PDF coordinates (y-up).
   ═══════════════════════════════════════════════════════════════ */
(function (global) {
  "use strict";

  const TYPES = {
    highlight: { color: "#fde047", alpha: 0.38, label: "Highlight" },
    rect: { color: "#a78bfa", alpha: 0.38, label: "Rectangle" },
    underline: { color: "#4cc9f0", alpha: 0.55, label: "Underline" },
    strike: { color: "#f87171", alpha: 0.55, label: "Strikethrough" },
    note: { color: "#f472b6", alpha: 1, label: "Note" },
    signature: { color: "#5b4fd6", alpha: 1, label: "Signature" },
    date: { color: "#334155", alpha: 1, label: "Date stamp" },
    form: { color: "#5b4fd6", alpha: 1, label: "Form field" },
  };

  const PALETTE = {
    highlight: ["#fde047", "#86efac", "#67e8f9", "#f9a8d4", "#fdba74"],
    rect: ["#a78bfa", "#67e8f9", "#fde047", "#f9a8d4"],
    underline: ["#4cc9f0", "#86efac", "#f9a8d4", "#fdba74"],
    strike: ["#f87171", "#fca5a5", "#fb7185"],
  };

  const Volt = global.Volt = global.Volt || {};

  Volt.Ann = {
    list: [],           // annotations for current doc
    mode: "select",     // select | highlight | rect | underline | strike | note
    colors: { highlight: "#fde047", rect: "#a78bfa", underline: "#4cc9f0", strike: "#f87171" },
    fileKey: null,      // localStorage key
    docInfo: null,      // {name, size, pages}
    appSettings: {},    // volt:app:settings — Rectangle tool defaults etc.
    history: [],        // undo stack (snapshots)
    redoStack: [],
    _savedTimer: null,

    init() {
      const app = this._app();
      app.elements.modeGroup.addEventListener("click", (e) => {
        const btn = e.target.closest(".mode-btn");
        if (!btn) return;
        const m = btn.dataset.mode;
        if (m === "select") this.setMode("select");
        else this.setMode(m, true); // re-click cycles color
      });

      // note popover
      // Rectangle tool default size (PDF points) — a small app-level settings
      // object (volt:app:settings) separate from the AI settings key; the two
      // number fields live in the ⚙ modal and apply immediately on change
      try { const s = JSON.parse(localStorage.getItem("volt:app:settings") || "{}"); this.appSettings = s && typeof s === "object" ? s : {}; } catch (e) { this.appSettings = {}; }
      const rw = app.elements.setRectW, rh = app.elements.setRectH;
      const rect = this.appSettings.rect || {};
      if (rw) rw.value = Number(rect.w) > 0 ? rect.w : 160;
      if (rh) rh.value = Number(rect.h) > 0 ? rect.h : 64;
      // one-click inch presets (each chip carries its W×H in PDF points): the
      // active chip is highlighted whenever the current size matches a preset,
      // and typing a custom size clears the highlight — presets are the quick
      // path, the fields are the exact path, both persist to the same key
      const syncRectChips = () => {
        const r = this.appSettings.rect || {};
        document.querySelectorAll(".rect-preset").forEach((c) => {
          // clamp the chip's own values to the same bounds saveRectSize uses, so
          // a preset that ever exceeds 24–1200 still highlights when it is stored
          // clamped (the fields and _rectSize always see the clamped size)
          const w = Utils.clamp(parseInt(c.dataset.w, 10) || 0, 24, 1200);
          const h = Utils.clamp(parseInt(c.dataset.h, 10) || 0, 24, 1200);
          c.classList.toggle("active", w === r.w && h === r.h);
        });
      };
      const saveRectSize = () => {
        if (!rw || !rh) return; // both fields ship together; guard the closure anyway
        const w = Utils.clamp(parseInt(rw.value, 10) || 160, 24, 1200);
        const h = Utils.clamp(parseInt(rh.value, 10) || 64, 24, 1200);
        this.appSettings.rect = { w, h };
        rw.value = w; rh.value = h; // normalize out-of-range input
        try { localStorage.setItem("volt:app:settings", JSON.stringify(this.appSettings)); } catch (e) { /* ignore */ }
        syncRectChips();
      };
      if (rw) rw.addEventListener("change", saveRectSize);
      if (rh) rh.addEventListener("change", saveRectSize);
      document.querySelectorAll(".rect-preset").forEach((c) => {
        c.addEventListener("click", () => {
          if (!rw || !rh) return;
          rw.value = c.dataset.w;
          rh.value = c.dataset.h;
          saveRectSize(); // clamps, persists, and highlights the chip
        });
      });
      syncRectChips(); // reflect a stored preset on launch

      app.elements.noteSave.addEventListener("click", () => this._saveNote());
      app.elements.noteCancel.addEventListener("click", () => this._closeNote());
      app.elements.noteDelete.addEventListener("click", () => this._deleteNote());
      app.elements.noteInput.addEventListener("keydown", (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === "Enter") this._saveNote();
        if (e.key === "Escape") this._closeNote();
      });
      app.elements.notesList.addEventListener("click", (e) => {
        const card = e.target.closest(".note-card");
        if (!card) return;
        const id = card.dataset.id;
        if (e.target.closest(".note-del")) {
          this.removeById(id);
          return;
        }
        const ann = this.list.find((a) => a.id === id);
        if (ann) {
          this._app().goToPage(ann.page);
          // flash the pin briefly
          const pin = document.querySelector(`.note-pin[data-id="${CSS.escape(id)}"]`);
          if (pin) { pin.style.outline = "3px solid #4cc9f0"; setTimeout(() => pin.style.outline = "", 900); }
        }
      });
      app.elements.btnClearNotes.addEventListener("click", () => {
        if (this.list.length && confirm("Clear all annotations for this document?")) {
          this._mutate(() => { this.list = []; });
        }
      });

      // area-highlight context menu (right-click an area highlight in select
      // mode: recolor or delete without leaving the page)
      const am = app.elements.areaMenu;
      am.querySelectorAll(".area-swatch").forEach((sw) => {
        sw.addEventListener("click", () => this._setAreaColor(sw.dataset.color));
      });
      app.elements.areaMenuDelete.addEventListener("click", () => this._deleteSelectedArea());
      app.elements.areaMenuDup.addEventListener("click", () => this.duplicateSelected());
      app.elements.areaMenuClose.addEventListener("click", () => this._closeAreaMenu());
      document.addEventListener("click", (e) => {
        if (this._areaMenuOpen && !am.contains(e.target)) this._closeAreaMenu();
      });
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && this._areaMenuOpen) this._closeAreaMenu();
      });
      app.elements.scroller.addEventListener("scroll", () => this._closeAreaMenu(), { passive: true });

      // overlay click handling for notes (via delegated click on pages container)
      app.elements.pages.addEventListener("click", (e) => {
        const pin = e.target.closest(".note-pin");
        if (pin && this.mode === "select") {
          const ann = this.list.find((a) => a.id === pin.dataset.id);
          if (ann) this._openNoteEditor(ann, pin);
          return;
        }
        // clicking a placed FORM FIELD in select mode opens its editor (a
        // drag would have moved it via the edit box instead; this only fires
        // when the mousedown/mouseup landed in the same spot)
        if (this.mode === "select") {
          const wrap = e.target.closest && e.target.closest(".page-wrap");
          if (wrap && !e.target.closest(".area-handle") && !e.target.closest(".area-del") && !e.target.closest(".area-select")) {
            const hit = this._areaAt(e, wrap);
            if (hit && hit.type === "form") this.openFormEditor(hit, wrap);
          }
        }
      });

      this._wireSignatureModal();
      this._wireFormModal();
    },

    _app() { return global.Volt.App; },

    setMode(mode, cycle = false) {
      // re-clicking an active annotation button cycles its color
      if (cycle && mode !== "select" && this.mode === mode) {
        const pal = PALETTE[mode] || [];
        if (pal.length > 1) {
          const i = pal.indexOf(this.colors[mode]);
          this.colors[mode] = pal[(i + 1) % pal.length];
          this._app().toast(TYPES[mode].label + " color → " + this.colors[mode], "ok");
        }
      }
      if (mode !== "select") { this._deselectArea(); this._closeAreaMenu(); } // editing is a select-mode activity
      this.mode = mode;
      const app = this._app();
      app.elements.modeGroup.querySelectorAll(".mode-btn").forEach((b) => {
        b.classList.toggle("active", b.dataset.mode === mode);
      });
      document.body.classList.toggle("annotating", mode !== "select");
      const tip = app.elements.modeTip;
      if (mode === "select") {
        tip.textContent = "Select";
        app.elements.scroller.style.cursor = "";
      } else {
        tip.textContent = (TYPES[mode]?.label || mode) + (mode === "highlight" ? " — drag over text · click = rect · Shift = square · Alt = from center"
          : mode === "rect" ? " — click or drag = rectangle · Shift = square · Alt = from center"
            : mode === "signature" ? " — click the page to place it"
              : mode === "date" ? " — click the page to stamp today's date"
                : mode === "form" ? " — drag on the page to draw the field" : " — drag over text");
        app.elements.scroller.style.cursor = "crosshair";
      }
      this._closeNote();
    },

    /* ── document lifecycle ─────────────────────────────────── */
    loadForDoc(docInfo) {
      this.docInfo = docInfo;
      this.fileKey = docInfo ? `volt:ann:${Utils.hash(docInfo.name + ":" + docInfo.size + ":" + docInfo.pages)}` : null;
      this.list = [];
      this.history = [];
      this.redoStack = [];
      this._deselectArea();
      this._closeAreaMenu();
      if (this.fileKey) {
        try {
          const raw = localStorage.getItem(this.fileKey);
          if (raw) this.list = JSON.parse(raw);
        } catch (e) { this.list = []; }
      }
      this._app().refreshNotesBadge();
      this._app().renderAllAnnotations();
    },

    /* ── mutation helpers with undo ─────────────────────────── */
    _mutate(fn) {
      this.history.push(Utils.clone(this.list));
      if (this.history.length > 100) this.history.shift();
      this.redoStack = [];
      this._nudgeBurstUntil = 0; // any explicit mutation ends a nudge burst (its entries were pushed here)
      this._nudgeBurstAnn = null;
      fn();
      this._afterChange();
    },
    _afterChange() {
      this._scheduleSave();
      this._app().refreshNotesBadge();
      this._app().refreshThumbBadges(); // sidebar page badges follow the live count
      this._app().renderAllAnnotations();
      this.refreshNotesList(); // the notes pane must reflect the change immediately (a deleted card can't linger)
      this._refreshSelection(); // keep the edit box glued to its highlight
    },
    _scheduleSave() {
      clearTimeout(this._savedTimer);
      this._savedTimer = setTimeout(() => this._save(), 400);
    },
    _save() {
      if (!this.fileKey) return;
      try { localStorage.setItem(this.fileKey, JSON.stringify(this.list)); } catch (e) { /* quota */ }
    },

    undo() {
      if (!this.history.length) return;
      this.redoStack.push(Utils.clone(this.list));
      this.list = this.history.pop();
      this._nudgeBurstUntil = 0; // the burst entry was popped — a next nudge must open a fresh one
      this._nudgeBurstAnn = null;
      this._afterChange();
    },
    redo() {
      if (!this.redoStack.length) return;
      this.history.push(Utils.clone(this.list));
      this.list = this.redoStack.pop();
      this._nudgeBurstUntil = 0;
      this._nudgeBurstAnn = null;
      this._afterChange();
    },

    /* ── pointer capture on pages ───────────────────────────── */
    _drag: null, // {wrap, mode, startX, startY, rectEl, spans}
    _onMoveRef: null,
    _onUpRef: null,

    beginDrag(e, wrap) {
      if (this.mode === "select") return;
      e.preventDefault();
      const rect = wrap.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      this._drag = { wrap, mode: this.mode, startX: x, startY: y, moved: false, rectEl: null, previewEl: null };
      this._showDragRect(x, y, x, y);
      this._onMoveRef = (ev) => this._moveDrag(ev, wrap);
      this._onUpRef = (ev) => this._endDrag(ev, wrap);
      window.addEventListener("mousemove", this._onMoveRef);
      window.addEventListener("mouseup", this._onUpRef);
    },

    _moveDrag(ev, wrap) {
      const d = this._drag;
      if (!d || d.wrap !== wrap) return;
      const rect = wrap.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      const y = ev.clientY - rect.top;
      if (Math.abs(x - d.startX) > 3 || Math.abs(y - d.startY) > 3) d.moved = true;
      const dx = x - d.startX, dy = y - d.startY;
      if (ev.altKey && (d.mode === "highlight" || d.mode === "rect")) {
        // Alt+drag: the drag start is the CENTER — the preview grows ±delta
        // both ways (Shift also snaps it to a centered square)
        let hw = Math.abs(dx), hh = Math.abs(dy);
        if (ev.shiftKey) { const s = Math.max(hw, hh); hw = s; hh = s; }
        this._showDragRect(d.startX - hw, d.startY - hh, d.startX + hw, d.startY + hh);
      } else if (ev.shiftKey && (d.mode === "highlight" || d.mode === "rect")) {
        // Shift+drag: show the square the area will snap to (live preview)
        const side = Math.max(Math.abs(dx), Math.abs(dy));
        this._showDragRect(d.startX, d.startY, d.startX + (dx < 0 ? -side : side), d.startY + (dy < 0 ? -side : side));
      } else if (d.mode === "highlight" || d.mode === "underline" || d.mode === "strike") {
        // the text tools (highlight/underline/strike) preview the ACTUAL lines
        // the drag will select (line-snapped), not a whole-section rectangle —
        // crossing the blank gap between lines keeps the already-covered lines
        // lit instead of flashing a block, so what you see is exactly what
        // gets created
        this._showDragTextPreview(d, x, y);
      } else {
        this._showDragRect(d.startX, d.startY, x, y);
      }
    },

    _endDrag(ev, wrap) {
      window.removeEventListener("mousemove", this._onMoveRef);
      window.removeEventListener("mouseup", this._onUpRef);
      const d = this._drag;
      this._drag = null;
      if (!d || d.wrap !== wrap) return;
      const rect = wrap.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      const y = ev.clientY - rect.top;
      const x1 = Math.min(d.startX, x), y1 = Math.min(d.startY, y);
      const x2 = Math.max(d.startX, x), y2 = Math.max(d.startY, y);
      // remove the drag rectangle + size badge + line preview (this._drag
      // is already null)
      if (d.rectEl) d.rectEl.remove();
      if (d.previewEl) d.previewEl.remove();
      this._removeSizeBadge(d);

      if (d.mode === "note") {
        // click (even small drag) places a note pin
        const pt = this._localToPdf(wrap, (x1 + x2) / 2, (y1 + y2) / 2);
        this._addNote(wrap, pt, null);
        return;
      }

      // signature / date / form-field placement: a click uses the default
      // size, a drag sizes the shape — both place in PDF coords, both are
      // rect annotations so the select-mode edit box can move/resize/rotate
      // them afterwards.
      if (d.mode === "signature" || d.mode === "date" || d.mode === "form") {
        this._placeStamp(wrap, d, x1, y1, x2, y2);
        return;
      }

      if (x2 - x1 < 3 || y2 - y1 < 3) {
        // a click without dragging: a PDF editor's rectangle tool places a
        // default-size rectangle at a click. The RECTANGLE tool does this on
        // text too (it is a dedicated shape tool); the highlight tool only
        // when the click landed on blank space (over text a click selects…
        // well, would be a text highlight — so it needs the blank check).
        if (d.mode === "rect") {
          this._placeClickRect(wrap, (x1 + x2) / 2, (y1 + y2) / 2, "rect");
        } else if (d.mode === "highlight" && !this._hasTextBoxNear(wrap, (x1 + x2) / 2, (y1 + y2) / 2)) {
          this._placeClickRect(wrap, (x1 + x2) / 2, (y1 + y2) / 2, "highlight");
        }
        return; // too small
      }

      if (d.mode === "rect") {
        // the Rectangle tool ALWAYS draws a rectangle — over text or blank
        // space; no text-quads fallback, no "no text" error
        this._makeAreaRect(wrap, d.startX, d.startY, x, y, ev.shiftKey, "rect", ev.altKey);
        return;
      }

      const lines = this._selectionLines(wrap, d.startX, d.startY, x, y);
      if (!lines || !lines.length) {
        if (d.mode === "highlight") {
          // drag on blank space: fall back to a rectangle highlight (PDF-editor
          // style) instead of doing nothing — area stored in PDF coords, y-up
          this._makeAreaRect(wrap, d.startX, d.startY, x, y, ev.shiftKey, "highlight", ev.altKey);
          return;
        }
        this._app().toast("No text in that selection — drag across words", "error");
        return;
      }
      const quads = lines.map((ln) => this._lineToQuad(wrap, ln));
      const text = this._spanText(wrap, lines);

      const ann = {
        id: Utils.uid(),
        type: d.mode,
        page: Number(wrap.dataset.page),
        quads,
        text,
        color: this.colors[d.mode],
        createdAt: Date.now(),
      };
      this._mutate(() => this.list.push(ann));
    },

    /** PDF-editor style click (no drag) in highlight mode: place a fixed-size
        rectangle highlight centered on the click, clamped inside the page. */
    /** The Rectangle tool's click size (PDF points) from volt:app:settings —
        defaults to 160×64 pt, clamped to a sane range and to the page when the
        rect is placed. */
    _rectSize() {
      const r = (this.appSettings && this.appSettings.rect) || {};
      return { w: Utils.clamp(Number(r.w) > 0 ? Number(r.w) : 160, 24, 1200), h: Utils.clamp(Number(r.h) > 0 ? Number(r.h) : 64, 24, 1200) };
    },

    _placeClickRect(wrap, cx, cy, mode = "highlight") {
      const dims = this._app().pageDims[Number(wrap.dataset.page) - 1];
      const pw = dims ? dims.w : Infinity, ph = dims ? dims.h : Infinity;
      const S = this._rectSize();
      const W = Math.min(S.w, pw), H = Math.min(S.h, ph); // never exceed the page
      const pt = this._localToPdf(wrap, cx, cy);
      const x = Utils.clamp(pt[0], W / 2, Math.max(W / 2, pw - W / 2));
      const y = Utils.clamp(pt[1], H / 2, Math.max(H / 2, ph - H / 2));
      const ann = {
        id: Utils.uid(),
        type: mode,
        page: Number(wrap.dataset.page),
        rect: { x: x - W / 2, y: y - H / 2, w: W, h: H },
        text: "",
        color: this.colors[mode] || this.colors.highlight,
        createdAt: Date.now(),
      };
      this._mutate(() => this.list.push(ann));
      this._app().toast((TYPES[mode]?.label || "Rectangle") + " added — drag a handle to resize (Shift = square) · ⤾ to rotate", "ok");
    },

    /* ── signatures, date stamps, form fields ────────────────
       Three insertable annotations, all stored as rect annotations (so the
       select-mode edit box gives them move/resize/rotate for free):
         signature — { image: dataURL }  drawn, typed, or reused from the
           device store; exports into the PDF as an embedded PNG image;
         date      — { text } today's date stamp; exports as drawn text;
         form      — { fieldType, name, value } a fillable field; exports as
           a REAL AcroForm widget (text/checkbox/date) or a baked image
           (signature), so the exported PDF is actually fillable elsewhere. */

    /** Click-or-drag placement shared by signature / date / form modes.
        A click (drag < 3px) uses the tool's default size; a drag sizes the
        shape. All three create a rect annotation in PDF coords, clamped to
        the page, and the gesture ends the placement mode (back to select). */
    _placeStamp(wrap, d, x1, y1, x2, y2) {
      const app = this._app();
      const page = Number(wrap.dataset.page);
      const dims = app.pageDims[page - 1];
      const pw = dims ? dims.w : Infinity, ph = dims ? dims.h : Infinity;
      const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
      const pt = this._localToPdf(wrap, cx, cy);
      const dragW = Math.abs(x2 - x1), dragH = Math.abs(y2 - y1);
      let W, H;
      if (dragW < 8 && dragH < 8) {
        // a click — use the default size
        if (d.mode === "signature") {
          const aspect = (this._pendingSig && this._pendingSig.aspect) || 3;
          H = 46; W = Math.round(H * aspect);
        } else if (d.mode === "date") {
          W = 96; H = 24;
        } else {
          W = 150; H = 26;
        }
      } else {
        // a drag sized the shape (local px → PDF pt via corner mapping)
        const p1 = this._localToPdf(wrap, x1, y1);
        const p2 = this._localToPdf(wrap, x2, y2);
        W = Math.abs(p2[0] - p1[0]); H = Math.abs(p2[1] - p1[1]);
        if (W < 6) W = 150; if (H < 6) H = 26;
      }
      W = Math.min(W, pw); H = Math.min(H, ph);
      const x = Utils.clamp(pt[0] - W / 2, 0, Math.max(0, pw - W));
      const y = Utils.clamp(pt[1] - H / 2, 0, Math.max(0, ph - H));
      const rect = { x, y, w: W, h: H };
      let ann;
      if (d.mode === "signature") {
        if (!this._pendingSig || !this._pendingSig.dataURL) {
          app.toast("Create a signature first — Markup ▸ Signature…", "error");
          return;
        }
        ann = { id: Utils.uid(), type: "signature", page, rect, image: this._pendingSig.dataURL, color: TYPES.signature.color, createdAt: Date.now() };
      } else if (d.mode === "date") {
        ann = { id: Utils.uid(), type: "date", page, rect, text: this._dateText || this._todayStamp(), color: TYPES.date.color, createdAt: Date.now() };
      } else {
        const draft = this._formDraft;
        if (!draft) {
          app.toast("Choose a field type first — Markup ▸ Form field…", "error");
          return;
        }
        ann = {
          id: Utils.uid(), type: "form", page, rect,
          fieldType: draft.type,
          name: draft.name || "volt_field_" + Utils.uid().slice(0, 8),
          value: draft.value || "",
          color: TYPES.form.color,
          createdAt: Date.now(),
        };
        this._formDraft = null;
      }
      this._mutate(() => this.list.push(ann));
      this.setMode("select");
      const msg = d.mode === "signature" ? "Signature placed — select it to move, resize or rotate"
        : d.mode === "date" ? "Date stamp placed — select it to move"
          : "Form field placed — click it in select mode to edit";
      app.toast(msg, "ok");
    },

    _todayStamp() {
      try { return new Date().toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }); }
      catch (e) { return new Date().toISOString().slice(0, 10); }
    },

    /* ── signature ─────────────────────────────────────────── */
    _pendingSig: null,      // { dataURL, aspect } — ready to place on the next click
    _sigDrawing: null,      // pointer state while drawing on the sig canvas

    /** Open the signature creator modal (Markup ▸ Signature…). */
    openSignature() {
      const app = this._app();
      const el = app.elements;
      if (!el.sigModal) return;
      this._sigMode = "draw";
      el.sigTabDraw.className = "mini-btn primary";
      el.sigTabType.className = "mini-btn";
      el.sigDrawWrap.hidden = false;
      el.sigTypeWrap.hidden = true;
      el.sigTypeInput.value = "";
      this._renderSigTypePreview();
      this._renderSavedSigs();
      this._clearSigCanvas();
      app._openModal(el.sigModal);
    },

    _renderSavedSigs() {
      const el = this._app().elements;
      const box = el.sigSaved;
      if (!box) return;
      let saved;
      try { saved = JSON.parse(localStorage.getItem("volt:signatures") || "[]"); } catch (e) { saved = []; }
      if (!Array.isArray(saved) || !saved.length) { box.hidden = true; return; }
      box.hidden = false;
      box.innerHTML = '<div class="sig-saved-title">Saved on this device</div>';
      for (const s of saved) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "sig-saved-item";
        b.title = s.name || "saved signature";
        b.innerHTML = '<img alt="saved signature" src="' + s.dataURL + '">';
        b.addEventListener("click", () => this._useSignature({ dataURL: s.dataURL }));
        box.appendChild(b);
      }
    },

    /** Arm placement with a signature image. aspect = w/h of the source. */
    _useSignature(sig) {
      this._pendingSig = { dataURL: sig.dataURL, aspect: sig.aspect || 3 };
      const app = this._app();
      app._closeModal(app.elements.sigModal);
      this.setMode("signature");
      app.toast("Click the page to place your signature", "ok");
    },

    /** Wire the signature modal's controls (called once at init). */
    _wireSignatureModal() {
      const app = this._app();
      const el = app.elements;
      if (!el.sigModal) return;
      el.sigCancel.addEventListener("click", () => app._closeModal(el.sigModal));
      el.sigClear.addEventListener("click", () => this._clearSigCanvas());
      el.sigTabDraw.addEventListener("click", () => {
        this._sigMode = "draw";
        el.sigTabDraw.className = "mini-btn primary";
        el.sigTabType.className = "mini-btn";
        el.sigDrawWrap.hidden = false;
        el.sigTypeWrap.hidden = true;
        this._clearSigCanvas();
      });
      el.sigTabType.addEventListener("click", () => {
        this._sigMode = "type";
        el.sigTabType.className = "mini-btn primary";
        el.sigTabDraw.className = "mini-btn";
        el.sigDrawWrap.hidden = true;
        el.sigTypeWrap.hidden = false;
        el.sigTypeInput.focus();
      });
      el.sigTypeInput.addEventListener("input", () => this._renderSigTypePreview());
      el.sigSave.addEventListener("click", () => this._saveSignature());

      // freehand drawing on the canvas
      const cv = el.sigCanvas;
      const pos = (ev) => {
        const r = cv.getBoundingClientRect();
        return { x: (ev.clientX - r.left) * (cv.width / r.width), y: (ev.clientY - r.top) * (cv.height / r.height) };
      };
      const down = (ev) => {
        ev.preventDefault();
        const p = pos(ev);
        this._sigDrawing = { drawing: true, x: p.x, y: p.y };
      };
      const move = (ev) => {
        if (!this._sigDrawing || !this._sigDrawing.drawing) return;
        const p = pos(ev);
        const ctx = cv.getContext("2d");
        ctx.strokeStyle = "#1a2333";
        ctx.lineWidth = 2.4;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.beginPath();
        ctx.moveTo(this._sigDrawing.x, this._sigDrawing.y);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
        this._sigDrawing.x = p.x; this._sigDrawing.y = p.y;
      };
      const up = () => { if (this._sigDrawing) this._sigDrawing.drawing = false; };
      cv.addEventListener("pointerdown", down);
      cv.addEventListener("pointermove", move);
      cv.addEventListener("pointerup", up);
      cv.addEventListener("pointerleave", up);
    },

    _clearSigCanvas() {
      const cv = this._app().elements.sigCanvas;
      if (!cv) return;
      const ctx = cv.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, cv.width, cv.height);
      this._sigDrawing = null;
    },

    _renderSigTypePreview() {
      const el = this._app().elements;
      if (!el.sigTypePreview) return;
      el.sigTypePreview.textContent = (el.sigTypeInput.value || "").trim() || "Your name";
    },

    /** Render the typed name onto a canvas (white bg + cursive ink) so the
        signature is a bitmap like a drawn one — same storage, same export. */
    _typedSigDataURL(name) {
      const cv = document.createElement("canvas");
      const scale = 2;
      cv.width = 520 * scale; cv.height = 160 * scale;
      const ctx = cv.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, cv.width, cv.height);
      ctx.fillStyle = "#1a2333";
      ctx.font = (76 * scale) + "px 'Segoe Script', 'Brush Script MT', cursive, 'Segoe UI'";
      ctx.textBaseline = "middle";
      const w = ctx.measureText(name).width;
      ctx.fillText(name, (cv.width - w) / 2, cv.height / 2);
      return cv.toDataURL("image/png");
    },

    _saveSignature() {
      const app = this._app();
      const el = app.elements;
      let dataURL, aspect = 520 / 160;
      if (this._sigMode === "type") {
        const name = (el.sigTypeInput.value || "").trim();
        if (!name) { app.toast("Type your name first", "error"); return; }
        dataURL = this._typedSigDataURL(name);
      } else {
        const cv = el.sigCanvas;
        const ctx = cv.getContext("2d");
        const data = ctx.getImageData(0, 0, cv.width, cv.height).data;
        let ink = false;
        for (let i = 3; i < data.length; i += 4) { if (data[i] > 0) { ink = true; break; } }
        if (!ink) { app.toast("Draw your signature first", "error"); return; }
        dataURL = cv.toDataURL("image/png");
      }
      // save to the device store for reuse (trimmed — a 520×160 PNG is small)
      let saved = [];
      try { saved = JSON.parse(localStorage.getItem("volt:signatures") || "[]"); } catch (e) { saved = []; }
      if (!Array.isArray(saved)) saved = [];
      const name0 = (el.sigTypeInput.value || "").trim();
      saved = [{ dataURL, name: name0 || ("signature " + (saved.length + 1)) }, ...saved.filter((s) => s.dataURL !== dataURL)].slice(0, 6);
      try { localStorage.setItem("volt:signatures", JSON.stringify(saved)); } catch (e) { /* ignore — placement still works */ }
      this._useSignature({ dataURL, aspect });
    },

    /* ── date stamp ────────────────────────────────────────── */
    _dateText: null,

    armDate() {
      this._dateText = this._todayStamp();
      this.setMode("date");
      this._app().toast("Click the page to stamp today's date — " + this._dateText, "ok");
    },

    /* ── form fields ───────────────────────────────────────── */
    _formDraft: null,     // { type, name, value } — next drag places the field

    /** Open the form-field editor (Markup ▸ Form field…). With an existing
        annotation, pre-fill it and switch the primary button to Update. */
    openFormEditor(ann, wrap) {
      const app = this._app();
      const el = app.elements;
      if (!el.formModal) return;
      this._formEditing = ann || null;
      if (ann) {
        el.formType.value = ann.fieldType || "text";
        el.formName.value = (ann.name || "").replace(/^volt_field_[0-9a-f]{8}$/, "");
        el.formValue.value = ann.value || "";
      } else {
        el.formType.value = "text";
        el.formName.value = "";
        el.formValue.value = "";
      }
      this._syncFormFields();
      app._openModal(el.formModal);
    },

    _syncFormFields() {
      const el = this._app().elements;
      if (!el.formType) return;
      const t = el.formType.value;
      el.formValueField.hidden = t === "checkbox"; // checkbox has no text value — it's checked or not
      el.formPlace.textContent = this._formEditing ? "Update field" : "Place on page…";
    },

    /** Wire the form-field modal (once at init). */
    _wireFormModal() {
      const app = this._app();
      const el = app.elements;
      if (!el.formModal) return;
      el.formCancel.addEventListener("click", () => { this._formEditing = null; app._closeModal(el.formModal); });
      el.formType.addEventListener("change", () => this._syncFormFields());
      el.formPlace.addEventListener("click", () => {
        const t = el.formType.value;
        if (this._formEditing) {
          // editing an EXISTING field: update name/value/type in place
          const a = this._formEditing;
          this._mutate(() => {
            a.fieldType = t;
            a.name = el.formName.value.trim() || a.name;
            a.value = t === "checkbox" ? a.value : el.formValue.value.trim();
          });
          this._formEditing = null;
          app._closeModal(el.formModal);
          app.toast("Form field updated", "ok");
          return;
        }
        const name = el.formName.value.trim();
        const value = el.formValue.value.trim();
        if (t !== "checkbox" && !value && !name) {
          app.toast("Give the field a name or default value (or just drag — it can be blank)", "error");
          return;
        }
        this._formDraft = { type: t, name, value };
        app._closeModal(el.formModal);
        this.setMode("form");
        app.toast("Drag on the page to draw the " + (t === "checkbox" ? "checkbox" : t === "date" ? "date field" : t === "signature" ? "signature field" : "text field"), "ok");
      });
    },

    /** Build an area-highlight rect (type "highlight" or the dedicated
        "rect") from a drag in local coords, with Shift-square and Alt-center
        snapping, then clamp to the page and create the annotation. Shared by
        the highlight tool's blank-space fallback and the Rectangle tool's
        always-area drags. */
    _makeAreaRect(wrap, startX, startY, x, y, shiftKey, type, altKey) {
      let sx1, sy1, sx2, sy2;
      if (altKey) {
        // Alt+drag: the drag start is the CENTER — the rect spans ±delta both
        // ways (Shift snaps it to a centered square)
        let hw = Math.abs(x - startX), hh = Math.abs(y - startY);
        if (shiftKey) { const s = Math.max(hw, hh); hw = s; hh = s; }
        sx1 = startX - hw; sy1 = startY - hh;
        sx2 = startX + hw; sy2 = startY + hh;
      } else {
        sx1 = Math.min(startX, x); sy1 = Math.min(startY, y); sx2 = Math.max(startX, x); sy2 = Math.max(startY, y);
        if (shiftKey) {
          // Shift+drag: snap the rectangle to a perfect square in the drag
          // direction (the pointer controls the side length)
          const dx = x - startX, dy = y - startY;
          const side = Math.max(Math.abs(dx), Math.abs(dy));
          const ex = startX + (dx < 0 ? -side : side);
          const ey = startY + (dy < 0 ? -side : side);
          sx1 = Math.min(startX, ex); sy1 = Math.min(startY, ey);
          sx2 = Math.max(startX, ex); sy2 = Math.max(startY, ey);
        }
      }
      const p1 = this._localToPdf(wrap, sx1, sy1);
      const p2 = this._localToPdf(wrap, sx2, sy2);
      // clamp to the page bounds — drags often run slightly past the edge,
      // and an out-of-bounds rect would be clipped on screen but written
      // off-page into the exported PDF
      const dims = this._app().pageDims[Number(wrap.dataset.page) - 1];
      const pw = dims ? dims.w : Infinity, ph = dims ? dims.h : Infinity;
      const cxs = (v) => Utils.clamp(v, 0, pw);
      const cys = (v) => Utils.clamp(v, 0, ph);
      const rx = Math.min(cxs(p1[0]), cxs(p2[0]));
      const ry = Math.min(cys(p1[1]), cys(p2[1]));
      const rw = Math.abs(cxs(p2[0]) - cxs(p1[0]));
      const rh = Math.abs(cys(p2[1]) - cys(p1[1]));
      if (rw < 0.5 || rh < 0.5) return; // drag landed entirely off-page
      const ann = {
        id: Utils.uid(),
        type,
        page: Number(wrap.dataset.page),
        rect: { x: rx, y: ry, w: rw, h: rh },
        text: "",
        color: this.colors[type] || this.colors.highlight,
        createdAt: Date.now(),
      };
      this._mutate(() => this.list.push(ann));
      this._app().toast(type === "rect"
        ? "Rectangle added — drag a handle to resize (Shift = square) · ⤾ to rotate"
        : "No text there — created an area highlight", "ok");
    },

    /* ── geometry helpers ───────────────────────────────────── */
    _localToPdf(wrap, lx, ly) {
      const vp = this._app().getViewportForPage(wrap.dataset.page);
      return vp.convertToPdfPoint(lx, ly); // [x, y] PDF pts, y-up
    },
    _pdfToLocal(wrap, px, py) {
      const vp = this._app().getViewportForPage(wrap.dataset.page);
      const pt = vp.convertToViewportPoint(px, py);
      return { x: pt[0], y: pt[1] };
    },

    _spansInRect(wrap, x1, y1, x2, y2) {
      const wrect = wrap.getBoundingClientRect();
      const out = [];
      const spans = wrap.querySelectorAll(".page-text-layer span");
      for (const s of spans) {
        if (!s.textContent.trim()) continue;
        const r = s.getBoundingClientRect();
        const sx1 = r.left - wrect.left, sy1 = r.top - wrect.top;
        const sx2 = sx1 + r.width, sy2 = sy1 + r.height;
        // LINE membership by vertical CENTER, not box overlap: adjacent pdf.js
        // span boxes overlap by a pixel or two (glyph boxes touch, line-height
        // < font box), so a box-vs-box test bleeds into the neighboring line
        // and a drag meant for one line silently grabs the ones above/below
        // it. A line belongs only when the drag covers its CENTER. Horizontal
        // membership stays box-intersection, so a word only partially covered
        // at the drag's edges is still included — the endpoint clipping in
        // _endDrag then trims the highlight to the exact drag points.
        const cx = (sx1 + sx2) / 2, cy = (sy1 + sy2) / 2;
        if (sx2 < x1 || sx1 > x2 || cy < y1 || cy > y2) continue;
        out.push({ el: s, x1: sx1, y1: sy1, x2: sx2, y2: sy2, text: s.textContent });
      }
      return out;
    },

    /** Box-overlap probe: is ANY text span's box within `pad` px of (x,y)?
        Used by the click-to-place blank check — a click's tiny probe must hit
        text near a line's EDGES too (where the line's center is far), which
        the center-based _spansInRect would miss. */
    _hasTextBoxNear(wrap, x, y, pad = 3) {
      const wrect = wrap.getBoundingClientRect();
      const spans = wrap.querySelectorAll(".page-text-layer span");
      for (const s of spans) {
        if (!s.textContent.trim()) continue;
        const r = s.getBoundingClientRect();
        const sx1 = r.left - wrect.left, sy1 = r.top - wrect.top;
        if (sx1 > x + pad || sx1 + r.width < x - pad || sy1 > y + pad || sy1 + r.height < y - pad) continue;
        return true;
      }
      return false;
    },

    _groupSpansIntoLines(spans) {
      const sorted = [...spans].sort((a, b) => (a.y1 - b.y1) || (a.x1 - b.x1));
      const lines = [];
      // Same-line membership by vertical CENTER proximity, not box overlap:
      // pdf.js span boxes can overlap between adjacent lines (tight leading,
      // or any zoom where the box height exceeds the line pitch), so a
      // box-vs-box test merges two physical lines into one group — a
      // two-line drag then highlights as a single block. Spans on the SAME
      // line share a baseline (their centers coincide), while adjacent lines'
      // centers are a full pitch apart, so center proximity separates them
      // no matter how the boxes overlap.
      for (const s of sorted) {
        const cy = (s.y1 + s.y2) / 2;
        const sh = Math.max(s.y2 - s.y1, 1);
        const hit = lines.find((ln) => Math.abs(cy - ln.cy) < Math.max(1.5, 0.45 * Math.min(ln.h, sh)));
        if (hit) {
          hit.x1 = Math.min(hit.x1, s.x1);
          hit.x2 = Math.max(hit.x2, s.x2);
          hit.y1 = Math.min(hit.y1, s.y1);
          hit.y2 = Math.max(hit.y2, s.y2);
          hit.cy = (hit.y1 + hit.y2) / 2;
          hit.h = Math.max(hit.h, sh);
          hit.items.push(s);
        } else {
          lines.push({ x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2, cy, h: sh, items: [s] });
        }
      }
      return lines;
    },

    _lineToQuad(wrap, ln) {
      // quad corners [tl, tr, br, bl] in PDF coords, with slight padding
      const PAD = 0.75;
      const tl = this._localToPdf(wrap, ln.x1 - PAD, ln.y1 - PAD);
      const tr = this._localToPdf(wrap, ln.x2 + PAD, ln.y1 - PAD);
      const br = this._localToPdf(wrap, ln.x2 + PAD, ln.y2 + PAD);
      const bl = this._localToPdf(wrap, ln.x1 - PAD, ln.y2 + PAD);
      return [{ x: tl[0], y: tl[1] }, { x: tr[0], y: tr[1] }, { x: br[0], y: br[1] }, { x: bl[0], y: bl[1] }];
    },

    /** The text lines a highlight drag from (sx,sy) to (ex,ey) will select:
        spans whose line CENTERS fall inside the drag rect, grouped into
        lines, with the OUTER edges clipped to the drag's endpoints in reading
        order (top-to-bottom, then left-to-right) — a mid-line start no longer
        extends to the line's left edge and a mid-line stop doesn't swallow
        the rest of the line, while middle lines stay full width. Returns null
        when the rect covers no text at all (the area-fallback case). Shared by
        _endDrag (final quads) and the live drag preview, so what the preview
        shows is exactly what gets created. */
    _selectionLines(wrap, sx, sy, ex, ey) {
      const x1 = Math.min(sx, ex), y1 = Math.min(sy, ey);
      const x2 = Math.max(sx, ex), y2 = Math.max(sy, ey);
      const spans = this._spansInRect(wrap, x1, y1, x2, y2);
      if (!spans.length) return null;
      const lines = this._groupSpansIntoLines(spans);
      let early = { x: sx, y: sy }, late = { x: ex, y: ey };
      if (late.y < early.y || (late.y === early.y && late.x < early.x)) {
        const t = early; early = late; late = t;
      }
      if (lines.length === 1) {
        lines[0].x1 = Math.max(lines[0].x1, early.x);
        lines[0].x2 = Math.min(lines[0].x2, late.x);
      } else {
        lines[0].x1 = Math.max(lines[0].x1, early.x);
        lines[lines.length - 1].x2 = Math.min(lines[lines.length - 1].x2, late.x);
      }
      // an endpoint landing on blank just past a line's content can invert a
      // clipped line (x1 > x2) — drop that degenerate line entirely
      return lines.filter((ln) => ln.x1 < ln.x2);
    },

    _spanText(wrap, lines) {
      const sorted = [...lines].sort((a, b) => (a.y1 - b.y1) || (a.x1 - b.x1));
      return sorted.map((ln) => ln.items.map((s) => s.text).join(" ")).join(" ").replace(/\s+/g, " ").trim();
    },

    /** Convert the current DOM selection (e.g. the Ctrl+A whole-page
        selection, or a Ctrl+Shift+Space/Home/End boundary selection) into
        highlight annotations — one per page involved, using the EXACT
        geometry a highlight drag over the same text would produce
        (_groupSpansIntoLines → _lineToQuad), so the result matches the
        line-snapped quads of a hand drag and exports identically. Each page
        gets its own annotation with the drag-style joined text; the
        selection is cleared afterwards. Returns the number of annotations
        created (0 when nothing selectable is selected). */
    highlightSelection() {
      const app = this._app();
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) {
        app.toast("Select text first — Ctrl+A selects the whole page", "error");
        return 0;
      }
      const range = sel.getRangeAt(0);
      // spans actually touched by the selection, grouped per rendered page.
      // Whole-span inclusion matches drag behavior: partially covering a word
      // highlights its full box (PDF readers do the same). Rendered pages only
      // — a boundary selection renders its pages first, so nothing selectable
      // is ever missed.
      const perWrap = new Map();
      for (const [, r] of app.rendered) {
        if (!r.textLayer) continue;
        const wr = r.wrap.getBoundingClientRect();
        const hits = [];
        for (const s of r.textLayer.querySelectorAll("span")) {
          if (!s.textContent.trim() || !range.intersectsNode(s)) continue;
          const b = s.getBoundingClientRect();
          hits.push({
            el: s,
            x1: b.left - wr.left, y1: b.top - wr.top,
            x2: b.left - wr.left + b.width, y2: b.top - wr.top + b.height,
            text: s.textContent,
          });
        }
        if (hits.length) perWrap.set(r.wrap, hits);
      }
      if (!perWrap.size) {
        app.toast("No selectable text in that selection", "error");
        return 0;
      }
      const made = [];
      for (const [wrap, spans] of perWrap) {
        const lines = this._groupSpansIntoLines(spans);
        if (!lines.length) continue;
        made.push({
          id: Utils.uid(),
          type: "highlight",
          page: Number(wrap.dataset.page),
          quads: lines.map((ln) => this._lineToQuad(wrap, ln)),
          text: this._spanText(wrap, lines),
          color: this.colors.highlight,
          createdAt: Date.now(),
        });
      }
      if (!made.length) {
        app.toast("Nothing to highlight in that selection", "error");
        return 0;
      }
      this._mutate(() => { this.list.push(...made); });
      sel.removeAllRanges();
      // the multi-page toast carries a per-page breakdown of line (quad)
      // counts, e.g. "p.1: 23 lines · p.2: 18 · p.3: 12" — the unit is named
      // on the first page only, like a terse table, so the whole span fits
      // one toast. `made` is ordered by page (perWrap iterates app.rendered),
      // so the header order always reads 1..N.
      // persistent (sticky) review toast carrying the one-click revert: a
      // stray whole-document highlight (N annotations from one conversion)
      // is cleared with a single click instead of a Ctrl+Z walk. Dismissed
      // by a click on the toast, the action, or anywhere outside; it lives
      // in the app's _selToast slot so the next selection (or doc open)
      // replaces/clears it instead of stacking.
      if (app._clearSelToast) app._clearSelToast();
      // the conversion toast's revert action is SCOPED: a single-page
      // conversion clears just that page ("Clear page N" → the page-scoped
      // clear), while a multi-page conversion keeps the document-wide
      // "Clear highlights" — so reverting a stray whole-PAGE highlight never
      // touches the marks on other pages.
      const single = made.length === 1 ? made[0].page : null;
      app._selToast = app.toast(made.length === 1
        ? "Highlighted " + made[0].text.length + " chars on page " + made[0].page + " — Ctrl+Z to undo"
        : "Highlighted text on " + made.length + " pages: " +
          made.map((a, i) => "p." + a.page + ": " + (a.quads ? a.quads.length : 0) +
            (i === 0 ? " line" + (a.quads && a.quads.length === 1 ? "" : "s") : ""))
            .join(" · ") + " — Ctrl+Z to undo", "ok", true, [
        // the clear is DESTRUCTIVE, so it carries the 3-second confirm step
        // (the pages-manager Delete guard, at toast level): the first click
        // flips the button to "Really …?" for 3s and only a second click on
        // the same button runs it — an accidental click never clears marks.
        { label: single ? "Clear page " + single : "Clear highlights",
          confirm: single ? "Really clear page " + single + "?" : "Really clear all?",
          onClick: () => this.clearHighlights(single || undefined) },
      ]);
      return made.length;
    },

    /** One-click revert for a stray highlight, scoped to an optional page
        range: remove text highlights (and the highlight tool's blank-space
        area fallback, which shares the "highlight" type) on just those
        pages — or the whole document when no range is given — in a single
        undoable step (one Ctrl+Z restores them all). Rectangle-tool "rect"
        shapes are a separate tool, so they are deliberately left alone.
        `range` may be a page number, an inclusive {from, to}, a Set or
        array of page numbers, or null/undefined for the whole document.
        Returns the count removed. */
    clearHighlights(range) {
      const app = this._app();
      const inRange = this._inPageRange(range);
      const hl = this.list.filter((a) => a.type === "highlight" && inRange(a.page));
      if (!hl.length) {
        app.toast("No highlights to clear");
        return 0;
      }
      const ids = new Set(hl.map((a) => a.id));
      this._mutate(() => { this.list = this.list.filter((a) => !ids.has(a.id)); });
      app.toast("Cleared " + hl.length + " highlight" + (hl.length === 1 ? "" : "s") +
        this._rangeLabel(range) + " — Ctrl+Z to undo", "ok");
      return hl.length;
    },

    /** Normalize a clear-highlights page scope into a page predicate.
        Accepts null/undefined (whole document), a page number, an inclusive
        {from, to}, or a Set/array of page numbers. */
    _inPageRange(range) {
      if (range == null) return () => true;
      if (typeof range === "number") { const p = range; return (pg) => pg === p; }
      if (range instanceof Set) return (pg) => range.has(pg);
      if (Array.isArray(range)) { const s = new Set(range); return (pg) => s.has(pg); }
      if (typeof range === "object" && range.from != null && range.to != null) {
        const f = range.from, t = range.to;
        return (pg) => pg >= f && pg <= t;
      }
      return () => true;
    },

    /** Human label for the scope of a page-scoped clear, appended to the
        "Cleared N highlight(s)" toast ("" for the whole document). */
    _rangeLabel(range) {
      if (range == null) return "";
      if (typeof range === "number") return " on page " + range;
      if (range instanceof Set || Array.isArray(range)) {
        const pages = [...range].sort((a, b) => a - b);
        return pages.length === 1 ? " on page " + pages[0] : " on pages " + pages.join(", ");
      }
      if (typeof range === "object" && range.from != null && range.to != null) {
        return range.from === range.to ? " on page " + range.from : " on pages " + range.from + "–" + range.to;
      }
      return "";
    },

    _showDragRect(x1, y1, x2, y2) {
      let el = this._drag.rectEl;
      if (!el) {
        el = document.createElement("div");
        el.className = "drag-rect";
        this._drag.wrap.appendChild(el);
        this._drag.rectEl = el;
      }
      const x = Math.min(x1, x2), y = Math.min(y1, y2);
      el.style.left = x + "px"; el.style.top = y + "px";
      el.style.width = Math.abs(x2 - x1) + "px";
      el.style.height = Math.abs(y2 - y1) + "px";
      // live size badge: the RECTANGLE tool always draws an area (badge always
      // on); the highlight tool only falls back to an area over BLANK space —
      // over text it becomes a text highlight, where a readout would mislead,
      // so the badge appears/disappears live as the drag moves between the two.
      const d = this._drag;
      if (d && (d.mode === "highlight" || d.mode === "rect")) {
        const w = Math.abs(x2 - x1), h = Math.abs(y2 - y1);
        const isArea = d.mode === "rect" || !this._spansInRect(d.wrap, x, y, x + w, y + h).length;
        if (w > 3 && h > 3 && isArea) {
          this._updateSizeBadge(d, d.wrap, x1, y1, x2, y2);
        } else {
          this._removeSizeBadge(d);
        }
      }
    },

    /** Live preview for the HIGHLIGHT tool: instead of a whole-section
        rectangle, show exactly the lines the current drag will select — the
        same geometry _selectionLines hands _endDrag — so crossing the gap
        between lines never flashes a block, and the preview matches the
        created highlight pixel-for-pixel. Falls back to the area rectangle
        only when the ENTIRE drag sits on blank space (the click→rect /
        blank-drag fallback). */
    _showDragTextPreview(d, x, y) {
      const lines = this._selectionLines(d.wrap, d.startX, d.startY, x, y);
      if (!lines || !lines.length) {
        this._showDragRect(d.startX, d.startY, x, y); // blank-space area preview
        return;
      }
      // the drag drifted off blank space onto text — drop any area rect/badge
      if (d.rectEl) { d.rectEl.remove(); d.rectEl = null; }
      this._removeSizeBadge(d);
      let el = d.previewEl;
      if (!el) {
        el = document.createElement("div");
        el.className = "drag-text-preview";
        d.wrap.appendChild(el);
        d.previewEl = el;
      }
      el.textContent = ""; // cheap clear; a few line divs at most
      const color = this.colors[d.mode] || this.colors.highlight || "#fde047";
      // slightly stronger than the final annotation so the preview reads as
      // "this is what you're about to select" without hiding the text
      const baseAlpha = (TYPES[d.mode] || TYPES.highlight).alpha;
      const alpha = Math.min(1, baseAlpha + 0.16);
      for (const ln of lines) {
        // map each line through _lineToQuad (0.75pt pad) so the preview box
        // matches the created quad exactly, even under page rotation
        const q = this._lineToQuad(d.wrap, ln);
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const p of q) {
          const L = this._pdfToLocal(d.wrap, p.x, p.y);
          if (L.x < minX) minX = L.x; if (L.x > maxX) maxX = L.x;
          if (L.y < minY) minY = L.y; if (L.y > maxY) maxY = L.y;
        }
        const div = document.createElement("div");
        div.className = "drag-text-preview-line";
        div.style.left = minX + "px";
        div.style.top = minY + "px";
        div.style.width = Math.max(0, maxX - minX) + "px";
        div.style.height = Math.max(0, maxY - minY) + "px";
        div.style.background = this._hexToRgba(color, alpha);
        el.appendChild(div);
      }
    },

    /* ── live size readout ("2.2 × 0.9 in") ───────────────────
       A small badge next to the drag rectangle while CREATING an area
       highlight over blank space, or RESIZING one via its handles. Sizes are
       the annotation's own PDF-space dimensions (72pt = 1in), so the readout
       matches what exports regardless of zoom or page rotation. One badge per
       drag — it lives on the drag state and is removed when the drag ends. */
    _ensureSizeBadge(state, wrap) {
      if (!state.sizeEl) {
        const b = document.createElement("div");
        b.className = "area-size-badge";
        b.setAttribute("aria-hidden", "true");
        wrap.appendChild(b);
        state.sizeEl = b;
      }
      return state.sizeEl;
    },
    _removeSizeBadge(state) {
      if (state && state.sizeEl) { state.sizeEl.remove(); state.sizeEl = null; }
    },
    _updateSizeBadge(state, wrap, x1, y1, x2, y2) {
      const b = this._ensureSizeBadge(state, wrap);
      // local rect → PDF points → inches (72pt = 1in), rounded to 0.1"
      const pA = this._localToPdf(wrap, Math.min(x1, x2), Math.min(y1, y2));
      const pB = this._localToPdf(wrap, Math.max(x1, x2), Math.max(y1, y2));
      const wIn = Math.abs(pB[0] - pA[0]) / 72, hIn = Math.abs(pB[1] - pA[1]) / 72;
      b.textContent = wIn.toFixed(1) + " \u00d7 " + hIn.toFixed(1) + " in";
      // anchor just outside the rect's bottom-right corner; flip above/left
      // when the badge would leave the page so it stays readable
      const pad = 6;
      let bx = Math.max(x1, x2) + pad;
      let by = Math.max(y1, y2) + pad;
      const bw = b.offsetWidth, bh = b.offsetHeight;
      if (by + bh > wrap.clientHeight) by = Math.min(y1, y2) - bh - pad;
      if (bx + bw > wrap.clientWidth) bx = Math.min(x1, x2) - bw - pad;
      b.style.left = Math.max(0, bx) + "px";
      b.style.top = Math.max(0, by) + "px";
    },
    /* ── annotation editing (select → move / resize / delete) ──────────
       Area highlights are free-form shapes, so they get a real editing box
       in select mode: click to select (drag to move, drag the handles to
       resize, ✕ to delete), right-click for color/delete. Text highlights
       (underline/strike — quads, no rect) get the same box WITHOUT resize
       handles: dragging moves them to an adjacent text line and the quads
       are rebuilt from the target line's geometry on release. All geometry
       is stored in PDF coords; the box is positioned from the stored rect /
       quad bounds each frame, so it survives zoom / rotate / re-render. */
    _selectedId: null,
    _selectionBox: null, // {wrap, el} — the live editing box on the page
    _editDrag: null,     // {wrap, mode, handle, ann, startX, startY, origLocal, moved}
    _editMoveRef: null,
    _editUpRef: null,
    _editBlurRef: null,
    _areaMenuOpen: false,
    _areaHintShown: false,

    _areaAt(e, wrap) {
      const rect = wrap.getBoundingClientRect();
      const pt = this._localToPdf(wrap, e.clientX - rect.left, e.clientY - rect.top);
      const anns = this.annotationsForPage(Number(wrap.dataset.page));
      for (let i = anns.length - 1; i >= 0; i--) {
        const a = anns[i];
        // rect-based shapes (area highlights, rectangles, signatures, date
        // stamps, form fields) are all selectable/movable/resizable
        if ((a.type === "highlight" || a.type === "rect" || a.type === "signature" || a.type === "date" || a.type === "form") && a.rect) {
          if (a.rotation) {
            // rotated area highlight: inverse-rotate the click into the rect's
            // own (unrotated) frame around its center, then test the bounds —
            // same math the overlay/export use, so what's hit is what's drawn
            const cx = a.rect.x + a.rect.w / 2, cy = a.rect.y + a.rect.h / 2;
            const rad = -a.rotation * Math.PI / 180;
            const dx = pt[0] - cx, dy = pt[1] - cy;
            const lx = dx * Math.cos(rad) - dy * Math.sin(rad) + cx;
            const ly = dx * Math.sin(rad) + dy * Math.cos(rad) + cy;
            if (lx >= a.rect.x && lx <= a.rect.x + a.rect.w && ly >= a.rect.y && ly <= a.rect.y + a.rect.h) return a;
          } else if (pt[0] >= a.rect.x && pt[0] <= a.rect.x + a.rect.w &&
                     pt[1] >= a.rect.y && pt[1] <= a.rect.y + a.rect.h) return a;
        }
        if (!a.rect && a.quads && a.quads.length) {
          // text highlight: hit-test the union of the quad bounds, padded —
          // the stroked underline/strike is a thin target
          const u = this._quadUnionPdf(a);
          if (pt[0] >= u.x1 - 4 && pt[0] <= u.x2 + 4 && pt[1] >= u.y1 - 4 && pt[1] <= u.y2 + 4) return a;
        }
      }
      return null;
    },

    /** Select-mode mousedown on a page: pick up an area highlight to move or
        resize it, hit the delete pill, or (blank space) clear the selection
        and let normal text selection proceed. */
    onAreaMouseDown(e, wrap) {
      if (this.mode !== "select" || e.button !== 0) return;
      if (e.target.closest && e.target.closest(".note-pin")) return; // pins own their clicks
      const handle = e.target.closest ? e.target.closest(".area-handle") : null;
      const rotHandle = e.target.closest ? e.target.closest(".area-rot") : null;
      const del = e.target.closest ? e.target.closest(".area-del") : null;
      const box = e.target.closest ? e.target.closest(".area-select") : null;

      if (del && this._selectedId) {
        e.preventDefault();
        this.removeById(this._selectedId);
        this._deselectArea();
        return;
      }
      if (handle && this._selectedId) {
        this._beginEditDrag(e, wrap, "resize", handle.dataset.handle);
        return;
      }
      if (rotHandle && this._selectedId) {
        this._beginEditDrag(e, wrap, "rotate", null);
        return;
      }
      const hit = this._areaAt(e, wrap);
      if (box || hit) {
        if (hit) this._selectArea(hit.id, wrap);
        // Ctrl+drag anywhere on the box rotates (same as the handle) — a move
        // needs no modifier, so rotate is the only Ctrl-accelerated gesture
        this._beginEditDrag(e, wrap, e.ctrlKey ? "rotate" : "move", null);
        return;
      }
      this._deselectArea(); // clicked blank text — clear the editing box
    },

    /** Right-click an area highlight in select mode: select it and show the
        edit menu. Returns true if the event was handled (browser menu stays
        closed). */
    onAreaContextMenu(e, wrap) {
      if (this.mode !== "select") return false;
      const ann = this._areaAt(e, wrap);
      if (!ann) { this._closeAreaMenu(); return false; }
      e.preventDefault();
      this._selectArea(ann.id, wrap);
      this._showAreaMenu(e, ann);
      return true;
    },

    _selectArea(id, wrap) {
      this._selectedId = id;
      this._refreshSelection();
      if (!this._areaHintShown) {
        this._areaHintShown = true;
        const ann = this.list.find((a) => a.id === id);
        const quadsOnly = !!(ann && ann.quads && !ann.rect);
        this._app().toast(
          quadsOnly ? "Drag to move to another line · right-click for color & delete"
                    : "Drag to move · handles to resize (Shift = square · Alt = from center) · ⤾ knob or Ctrl+drag to rotate · right-click for options", "ok");
      }
    },

    _deselectArea() {
      this._selectedId = null;
      this._removeSelectionBox();
    },

    /** Idempotent: called after every annotation change and after pages are
        (re)rendered, so the editing box always tracks its highlight. */
    refreshSelection() {
      this._refreshSelection(); // no-op (box removed) when nothing is selected
    },
    _refreshSelection() {
      if (!this._selectedId) { this._removeSelectionBox(); return; }
      const ann = this.list.find((a) => a.id === this._selectedId);
      if (!ann || !(ann.rect || (ann.quads && ann.quads.length))) { this._deselectArea(); return; }
      const wrap = this._app().rendered.get(ann.page)?.wrap;
      if (!wrap) { this._removeSelectionBox(); return; } // page not rendered yet
      let box = this._selectionBox;
      if (!box || box.wrap !== wrap) {
        this._removeSelectionBox();
        box = { wrap, el: this._buildSelectionBox(ann, wrap) };
        this._selectionBox = box;
      } else {
        box.el.dataset.annId = ann.id; // the reused box now belongs to the new selection
      }
      this._positionSelectionBox(ann, wrap, box.el);
    },

    _buildSelectionBox(ann, wrap) {
      const el = document.createElement("div");
      // text highlights (quads) get a dashed box WITHOUT resize handles — the
      // only edit is drag-to-adjacent-line, so handles would promise resizing
      // the line-snap rebuild doesn't support
      el.className = "area-select" + (ann.rect ? "" : " is-quads");
      el.dataset.annId = ann.id;
      const del = document.createElement("button");
      del.className = "area-del";
      del.title = "Delete highlight";
      del.setAttribute("aria-label", "Delete highlight");
      del.innerHTML = '<svg viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>';
      el.appendChild(del);
      if (ann.rect) {
        for (const h of ["nw", "n", "ne", "e", "se", "s", "sw", "w"]) {
          const hd = document.createElement("div");
          hd.className = "area-handle " + h;
          hd.dataset.handle = h;
          el.appendChild(hd);
        }
        // rotate handle: a small knob above the top edge. It lives INSIDE the
        // box, so when the box rotates (transform below) the knob rotates with
        // it and always sits above the rect's rotated top edge. Drag it (or
        // Ctrl+drag the box) to spin the highlight around its center.
        const rot = document.createElement("div");
        rot.className = "area-rot";
        rot.title = "Rotate (or Ctrl+drag the box)";
        rot.setAttribute("aria-label", "Rotate highlight");
        rot.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19.07 8.6A8 8 0 1 0 20 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M15 8.5h4v-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
        el.appendChild(rot);
      }
      wrap.appendChild(el);
      return el;
    },

    _positionSelectionBox(ann, wrap, el) {
      let a, b;
      if (ann.rect) {
        a = this._pdfToLocal(wrap, ann.rect.x, ann.rect.y);
        b = this._pdfToLocal(wrap, ann.rect.x + ann.rect.w, ann.rect.y + ann.rect.h);
      } else {
        const u = this._quadUnionPdf(ann);
        a = this._pdfToLocal(wrap, u.x1, u.y1);
        b = this._pdfToLocal(wrap, u.x2, u.y2);
      }
      const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
      el.style.left = x + "px";
      el.style.top = y + "px";
      el.style.width = Math.abs(b.x - a.x) + "px";
      el.style.height = Math.abs(b.y - a.y) + "px";
      // a rotated rect's box turns with it (around its own center), so the
      // handles and rotate knob stay glued to the rotated shape. The layout
      // box stays the unrotated bounds — the transform is purely visual.
      // PDF +θ is counter-clockwise; CSS rotate(+θ) is clockwise → negate.
      el.style.transform = ann.rect && ann.rotation ? `rotate(${-ann.rotation}deg)` : "";
      el.style.transformOrigin = "center center";
    },

    _removeSelectionBox() {
      if (this._selectionBox) {
        this._selectionBox.el.remove();
        this._selectionBox = null;
      }
    },

    /** Union bounding box of a text highlight's quads, in PDF coords. */
    _quadUnionPdf(ann) {
      let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
      for (const q of ann.quads || []) {
        for (const p of q) {
          if (p.x < x1) x1 = p.x; if (p.x > x2) x2 = p.x;
          if (p.y < y1) y1 = p.y; if (p.y > y2) y2 = p.y;
        }
      }
      return { x1, y1, x2, y2 };
    },

    /** The page's text lines as local-coord bounds [{x1,y1,x2,y2}], grouped
        by the same logic a fresh drag selection uses. Kept in LOCAL coords
        (not PDF): the rebuild maps the chosen line through _lineToQuad's
        four-corner conversion, which stays correct under page rotation. */
    _lineIndexLocal(wrap) {
      const wrect = wrap.getBoundingClientRect();
      const spans = [];
      for (const s of wrap.querySelectorAll(".page-text-layer span")) {
        if (!s.textContent.trim()) continue;
        const r = s.getBoundingClientRect();
        spans.push({ x1: r.left - wrect.left, y1: r.top - wrect.top, x2: r.left - wrect.left + r.width, y2: r.top - wrect.top + r.height, text: s.textContent });
      }
      return this._groupSpansIntoLines(spans);
    },

    /** The line whose [y1,y2] (local, y-down) is nearest to cy — a y-center
        that falls inside a line wins outright (distance 0). */
    _nearestLine(lines, cy) {
      let best = null, bestD = Infinity;
      for (const ln of lines) {
        const d = cy >= ln.y1 && cy <= ln.y2 ? 0 : Math.min(Math.abs(cy - ln.y1), Math.abs(cy - ln.y2));
        if (d < bestD) { bestD = d; best = ln; }
      }
      return best;
    },

    /** The four corners of an area-highlight rect, in PDF coords (y-up),
        after applying ann.rotation (degrees, counter-clockwise) around the
        rect's center. Rotation 0 returns the raw corners. Used by BOTH the
        on-screen overlay and the pdf-lib export, so what you rotate is
        exactly what exports — and it stays correct when the PAGE is rotated
        too (the corners are mapped through the viewport, not re-derived). */
    _rectCornersPdf(ann) {
      const r = ann.rect;
      const theta = (ann.rotation || 0) * Math.PI / 180;
      const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
      const cos = Math.cos(theta), sin = Math.sin(theta);
      const raw = [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]];
      return raw.map(([px, py]) => {
        const dx = px - cx, dy = py - cy;
        return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
      });
    },

    /** The same corners in local (page-wrap) coords, for canvas drawing. */
    _rectCornersLocal(wrap, ann) {
      return this._rectCornersPdf(ann).map((p) => this._pdfToLocal(wrap, p.x, p.y));
    },

    /** Translate an annotation's geometry by (dx, dy) PDF points (y-up), with
        the whole shape clamped inside its page — a nudge or duplicate copy
        near an edge must never end up off-page (off-page quads would export to
        negative coordinates). Shared by nudgeSelected and duplicateSelected. */
    _translateClamped(ann, dx, dy) {
      const dims = this._app().pageDims[ann.page - 1];
      const pw = dims ? dims.w : Infinity;
      const ph = dims ? dims.h : Infinity;
      if (ann.rect) {
        if (ann.rotation) {
          // rotated: clamp the AABB of the rotated corners (which grows as the
          // rect turns), not the raw unrotated w/h — a 45° highlight nudged to
          // the edge must stay fully on-page in its rotated footprint. The AABB
          // translates by exactly the same (dx, dy) as the rect, so compute the
          // allowed shift from the current corners.
          const pts = this._rectCornersPdf(ann);
          let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
          for (const p of pts) { if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x; if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y; }
          const aabbW = maxX - minX, aabbH = maxY - minY;
          const nx = Utils.clamp(minX + dx, 0, Math.max(0, pw - aabbW));
          const ny = Utils.clamp(minY + dy, 0, Math.max(0, ph - aabbH));
          ann.rect.x += nx - minX;
          ann.rect.y += ny - minY;
        } else {
          ann.rect.x = Utils.clamp(ann.rect.x + dx, 0, Math.max(0, pw - ann.rect.w));
          ann.rect.y = Utils.clamp(ann.rect.y + dy, 0, Math.max(0, ph - ann.rect.h));
        }
      } else if (ann.quads && ann.quads.length) {
        ann.quads = ann.quads.map((q) => q.map((p) => ({ x: p.x + dx, y: p.y + dy })));
        let xMin = Infinity, yMin = Infinity, xMax = -Infinity, yMax = -Infinity;
        for (const q of ann.quads) { for (const p of q) {
          if (p.x < xMin) xMin = p.x; if (p.x > xMax) xMax = p.x;
          if (p.y < yMin) yMin = p.y; if (p.y > yMax) yMax = p.y;
        } }
        const shiftX = Math.max(0, xMax - pw) - Math.max(0, -xMin);
        const shiftY = Math.max(0, yMax - ph) - Math.max(0, -yMin);
        if (shiftX || shiftY) ann.quads = ann.quads.map((q) => q.map((p) => ({ x: p.x - shiftX, y: p.y - shiftY })));
      } else if (ann.point) {
        ann.point.x = Utils.clamp(ann.point.x + dx, 0, Math.max(0, pw));
        ann.point.y = Utils.clamp(ann.point.y + dy, 0, Math.max(0, ph));
      }
      return ann;
    },

    /* ── move / resize drag ─────────────────────────────────── */
    _beginEditDrag(e, wrap, mode, handle) {
      if (this._editDrag) this._endEditDrag(); // a mouseup lost outside the window can't leak listeners
      const ann = this.list.find((a) => a.id === this._selectedId);
      if (!ann || !(ann.rect || (ann.quads && ann.quads.length))) return;
      e.preventDefault(); // block text selection while grabbing the shape
      const rect = wrap.getBoundingClientRect();
      const startX = e.clientX - rect.left;
      const startY = e.clientY - rect.top;
      if (ann.rect) {
        const a = this._pdfToLocal(wrap, ann.rect.x, ann.rect.y);
        const b = this._pdfToLocal(wrap, ann.rect.x + ann.rect.w, ann.rect.y + ann.rect.h);
        this._editDrag = {
          wrap, mode, handle, ann,
          startX, startY,
          origLocal: { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) },
          moved: false,
        };
      } else {
        // text highlight: snapshot the original quads and the page's text-line
        // index once — the release-snap rebuild reads only these, so it stays
        // stable no matter what re-renders during the drag
        const u = this._quadUnionPdf(ann);
        const a = this._pdfToLocal(wrap, u.x1, u.y1);
        const b = this._pdfToLocal(wrap, u.x2, u.y2);
        this._editDrag = {
          wrap, mode: "move", handle: null, ann,
          quads: Utils.clone(ann.quads),
          lineIndex: this._lineIndexLocal(wrap),
          startX, startY,
          origLocal: { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) },
          moved: false,
        };
      }
      this._editMoveRef = (ev) => this._moveEditDrag(ev);
      this._editUpRef = (ev) => this._endEditDrag(true); // only the real mouseup applies the rebuild
      this._editBlurRef = () => this._endEditDrag(); // releasing outside the window cancels the drag
      window.addEventListener("mousemove", this._editMoveRef);
      window.addEventListener("mouseup", this._editUpRef);
      window.addEventListener("blur", this._editBlurRef);
      this._closeAreaMenu();
    },

    _moveEditDrag(ev) {
      const d = this._editDrag;
      // Escape / mode switch / doc ops mid-drag must cancel the drag, never
      // keep silently moving a highlight that is no longer selected
      if (!d || !this._selectedId || this._selectedId !== d.ann.id) { this._endEditDrag(); return; }
      const rect = d.wrap.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      const y = ev.clientY - rect.top;
      if (!d.moved) {
        if (Math.abs(x - d.startX) <= 2 && Math.abs(y - d.startY) <= 2) return; // click, not a drag
        d.moved = true;
        if (!d.quads) {
          // area drags mutate live, so history is recorded once, before the
          // first real change; text-highlight drags mutate on release (the
          // _mutate there records their history)
          this.history.push(Utils.clone(this.list));
          if (this.history.length > 100) this.history.shift();
          this.redoStack = [];
        }
      }
      const o = d.origLocal;
      if (d.quads) {
        // text highlight: the box follows the pointer, but the quads are NOT
        // rebuilt mid-drag — release snaps them to the nearest text line, so
        // the highlight never renders half-snapped or floating over blank space
        d.endX = x; d.endY = y;
        const el = this._selectionBox && this._selectionBox.el;
        if (el) {
          el.style.left = (o.x + (x - d.startX)) + "px";
          el.style.top = (o.y + (y - d.startY)) + "px";
        }
        return;
      }
      // rotate mode: the rect's rotation (degrees, PDF y-up CCW) tracks the
      // angle of the pointer around the rect center, minus 90° — the handle
      // starts "above" the center, which is +90° in PDF space. The angle is
      // computed in PDF space through the viewport, so it's independent of
      // the page's own rotation. Shift snaps to 15° increments.
      if (d.mode === "rotate") {
        const r = d.ann.rect;
        const cPdf = { x: r.x + r.w / 2, y: r.y + r.h / 2 };
        const pPdf = this._localToPdf(d.wrap, x, y);
        let rot = Math.atan2(pPdf[1] - cPdf.y, pPdf[0] - cPdf.x) * 180 / Math.PI - 90;
        if (ev.shiftKey) rot = Math.round(rot / 15) * 15;
        d.ann.rotation = ((rot % 360) + 360) % 360; // normalize to [0, 360)
        this._afterChange(); // re-render + save + box re-glue (transform follows)
        return;
      }
      // a ROTATED rect's handles sit on the rotated shape, but the stored
      // rect is its unrotated frame — map the pointer into that frame first
      // (inverse-rotate around the rect center in PDF space), then the
      // move/resize math below runs axis-aligned on the unrotated bounds and
      // rotation is preserved untouched.
      let mx = x, my = y;
      if (d.ann.rect && (d.ann.rotation || 0)) {
        const r = d.ann.rect;
        const cPdf = { x: r.x + r.w / 2, y: r.y + r.h / 2 };
        const pPdf = this._localToPdf(d.wrap, x, y);
        const rad = -d.ann.rotation * Math.PI / 180;
        const dx = pPdf[0] - cPdf.x, dy = pPdf[1] - cPdf.y;
        const rx = dx * Math.cos(rad) - dy * Math.sin(rad) + cPdf.x;
        const ry = dx * Math.sin(rad) + dy * Math.cos(rad) + cPdf.y;
        const pl = this._pdfToLocal(d.wrap, rx, ry);
        mx = pl.x; my = pl.y;
      }
      const pw = d.wrap.clientWidth, ph = d.wrap.clientHeight;
      let x1 = o.x, y1 = o.y, x2 = o.x + o.w, y2 = o.y + o.h;
      if (d.mode === "move") {
        x1 = Utils.clamp(o.x + (mx - d.startX), 0, pw - o.w);
        y1 = Utils.clamp(o.y + (my - d.startY), 0, ph - o.h);
        x2 = x1 + o.w; y2 = y1 + o.h;
      } else {
        const cx = Utils.clamp(mx, 0, pw), cy = Utils.clamp(my, 0, ph);
        const MIN = 6; // min box size in screen px
        if (ev.altKey) {
          // Alt+drag a handle: resize symmetrically from the rect's CENTER —
          // the dragged edge sets the extent and the opposite edge mirrors
          // about the fixed center (Shift also snaps to a centered square).
          // The center is the unrotated-frame center, so rotated rects keep
          // their rotation and resize around their true middle.
          const cX = o.x + o.w / 2, cY = o.y + o.h / 2;
          if (d.handle.includes("e")) { x2 = Math.max(cx, cX + MIN / 2); x1 = 2 * cX - x2; }
          if (d.handle.includes("w")) { x1 = Math.min(cx, cX - MIN / 2); x2 = 2 * cX - x1; }
          if (d.handle.includes("s")) { y2 = Math.max(cy, cY + MIN / 2); y1 = 2 * cY - y2; }
          if (d.handle.includes("n")) { y1 = Math.min(cy, cY - MIN / 2); y2 = 2 * cY - y1; }
          if (ev.shiftKey) {
            const side = Math.max(x2 - x1, y2 - y1, MIN);
            x1 = cX - side / 2; x2 = cX + side / 2;
            y1 = cY - side / 2; y2 = cY + side / 2;
          }
        } else {
          if (d.handle.includes("e")) x2 = Math.max(cx, x1 + MIN);
          if (d.handle.includes("w")) x1 = Math.min(cx, x2 - MIN);
          if (d.handle.includes("s")) y2 = Math.max(cy, y1 + MIN);
          if (d.handle.includes("n")) y1 = Math.min(cy, y2 - MIN);
          if (ev.shiftKey) {
            // Shift+drag a handle: keep the box a perfect square, with the corner
            // opposite the dragged handle fixed (the dragged edge sets the side)
            const side = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1), MIN);
            if (d.handle.includes("w")) x1 = x2 - side; else x2 = x1 + side;
            if (d.handle.includes("n")) y1 = y2 - side; else y2 = y1 + side;
          }
        }
        x1 = Utils.clamp(x1, 0, pw - MIN);
        y1 = Utils.clamp(y1, 0, ph - MIN);
        x2 = Utils.clamp(x2, x1 + MIN, pw);
        y2 = Utils.clamp(y2, y1 + MIN, ph);
      }
      if (d.mode === "resize") this._updateSizeBadge(d, d.wrap, x1, y1, x2, y2); // live size readout on resize
      // convert the viewport-space box back to an axis-aligned PDF rect
      // (min/max over the mapped corners keeps this correct under rotation)
      const dims = this._app().pageDims[Number(d.wrap.dataset.page) - 1];
      const pdfW = dims ? dims.w : Infinity;
      const pdfH = dims ? dims.h : Infinity;
      const pA = this._localToPdf(d.wrap, x1, y1);
      const pB = this._localToPdf(d.wrap, x2, y2);
      // the viewport-space clamp can leave sub-point rounding outside the page
      // after the y-flip; clamp the final PDF rect so export never writes off-page
      let rx = Math.min(pA[0], pB[0]), ry = Math.min(pA[1], pB[1]);
      rx = Utils.clamp(rx, 0, Math.max(0, pdfW - Math.abs(pB[0] - pA[0])));
      ry = Utils.clamp(ry, 0, Math.max(0, pdfH - Math.abs(pB[1] - pA[1])));
      d.ann.rect.x = rx;
      d.ann.rect.y = ry;
      d.ann.rect.w = Math.min(Math.abs(pB[0] - pA[0]), pdfW - rx);
      d.ann.rect.h = Math.min(Math.abs(pB[1] - pA[1]), pdfH - ry);
      this._afterChange(); // live re-render + save + box re-glue
    },

    /** End an edit drag. apply=true only on the real mouseup: the area path
        has already mutated live, but a text-highlight drag only rebuilds its
        quads here, so the cancel paths (blur, selection lost, Escape, a lost
        mouseup) must NOT apply — a cancelled drag re-glues the box to the
        unmoved quads instead. */
    _endEditDrag(apply = false) {
      const d = this._editDrag;
      window.removeEventListener("mousemove", this._editMoveRef);
      window.removeEventListener("mouseup", this._editUpRef);
      window.removeEventListener("blur", this._editBlurRef);
      this._editMoveRef = null;
      this._editUpRef = null;
      this._editBlurRef = null;
      this._editDrag = null;
      this._removeSizeBadge(d); // the live size readout belongs to the drag
      if (!d || !d.quads) return;
      if (!apply || !d.moved || d.endX === undefined) {
        if (d.moved) this._refreshSelection(); // cancel: the box must snap back to the unmoved quads
        return;
      }
      // snap each quad to the text line nearest its dragged y-center and
      // rebuild it from that line's geometry — the highlight keeps its
      // original horizontal extent, clamped to the target line so it never
      // overhangs text that is shorter than the line it came from. The whole
      // rebuild runs in LOCAL coords and reuses _lineToQuad's four-corner
      // mapping, so it stays correct when the page is rotated.
      const dy = d.endY - d.startY; // local, y-down
      const PAD = 0.75;
      const newQuads = d.quads.map((q) => {
        let lx1 = Infinity, lx2 = -Infinity, ly1 = Infinity, ly2 = -Infinity;
        for (const p of q) {
          const l = this._pdfToLocal(d.wrap, p.x, p.y);
          if (l.x < lx1) lx1 = l.x; if (l.x > lx2) lx2 = l.x;
          if (l.y < ly1) ly1 = l.y; if (l.y > ly2) ly2 = l.y;
        }
        const line = this._nearestLine(d.lineIndex, (ly1 + ly2) / 2 + dy);
        if (!line) return q; // no text on this page — leave the quad where it is
        // strip the original 0.75 pad before intersecting so _lineToQuad's
        // re-pad reproduces the original extent exactly on an equal-length line
        const nx1 = Math.max(lx1 + PAD, line.x1);
        const nx2 = Math.min(lx2 - PAD, line.x2);
        const ax1 = nx2 > nx1 ? nx1 : lx1 + PAD; // no horizontal overlap with the
        const ax2 = nx2 > nx1 ? nx2 : lx2 - PAD; // target line → keep the width
        return this._lineToQuad(d.wrap, { x1: ax1, y1: line.y1, x2: ax2, y2: line.y2 });
      });
      // a drag that lands back on the same line produces identical quads —
      // don't burn a history entry + save on a no-op
      if (JSON.stringify(newQuads) === JSON.stringify(d.quads)) return;
      this._mutate(() => { d.ann.quads = newQuads; });
    },

    /* ── context menu actions ───────────────────────────────── */
    _showAreaMenu(e, ann) {
      const menu = this._app().elements.areaMenu;
      menu.querySelectorAll(".area-swatch").forEach((sw) => {
        sw.classList.toggle("active", String(sw.dataset.color).toLowerCase() === String(ann.color || "").toLowerCase());
      });
      // the menu doubles as the edit menu for text highlights — swap its
      // wording so it doesn't promise resize handles only area rects have
      const quadsOnly = !!(ann.quads && !ann.rect);
      const title = menu.querySelector(".area-menu-title");
      if (title) title.textContent = quadsOnly
        ? (TYPES[ann.type]?.label || "Highlight")
        : (ann.type === "rect" ? "Rectangle" : "Area highlight");
      const hint = menu.querySelector(".area-menu-hint");
      if (hint) hint.textContent = quadsOnly
        ? "Drag to move to another line · Esc to finish"
        : "Drag to move · handles to resize (Shift = square · Alt = from center) · ⤾ knob or Ctrl+drag to rotate · Esc to finish";
      menu.hidden = false;
      // clamp inside the window so the card never clips off-screen
      const mw = menu.offsetWidth || 240, mh = menu.offsetHeight || 130;
      menu.style.left = Math.max(8, Math.min(e.clientX, window.innerWidth - mw - 8)) + "px";
      menu.style.top = Math.max(8, Math.min(e.clientY, window.innerHeight - mh - 8)) + "px";
      this._areaMenuOpen = true;
    },
    _closeAreaMenu() {
      if (!this._areaMenuOpen) return false;
      this._areaMenuOpen = false;
      this._app().elements.areaMenu.hidden = true;
      return true;
    },
    _setAreaColor(color) {
      const ann = this.list.find((a) => a.id === this._selectedId);
      if (!ann) return;
      this._mutate(() => { ann.color = color; });
      this.colors[ann.type] = color; // new drags of the same type use the picked color
      this._closeAreaMenu();
    },
    _deleteSelectedArea() {
      const id = this._selectedId;
      if (!id) return;
      this.removeById(id);
      this._deselectArea();
      this._closeAreaMenu();
    },

    /** Duplicate the selected annotation, offset slightly downward — Ctrl+D
        or the context menu's Duplicate. Each press copies the CURRENT
        selection (the previous copy), so repeated presses stamp a column of
        identical highlights — one keystroke per copy for covering repeated
        regions on a form. The copy is clamped inside its page (via
        _translateClamped), becomes the new selection, and each press is its
        own undo entry (undo steps back one copy at a time). Returns false
        when nothing is selected. */

    _nudgeBurstUntil: 0,
    _nudgeBurstAnn: null, // the annotation this burst's undo entry belongs to

    /** Nudge the selected annotation by (dx, dy) PDF points — arrow keys
        (1pt, Shift+arrow = 10pt) for pixel-level placement without mouse
        precision. Clamped to the page. A burst of presses (a held key or
        rapid taps, < 500ms apart, on the SAME annotation) coalesces into ONE
        undo entry, so undoing removes the whole drift instead of one point at
        a time — but a selection change mid-burst (or an undo/redo/_mutate)
        starts a fresh entry, so undoing never reverts another annotation's
        nudge by accident. Returns false when nothing is selected. */
    nudgeSelected(dx, dy) {
      const src = this.list.find((a) => a.id === this._selectedId);
      if (!src) return false;
      const now = Date.now();
      // a fresh entry only when the window expired AND the selection is the
      // same annotation the burst started on — clicking another highlight
      // within 500ms must not merge its nudge into the previous entry
      if (now >= this._nudgeBurstUntil || src.id !== this._nudgeBurstAnn) {
        // first press of a burst: one fresh undo entry (redo cleared)
        this.history.push(Utils.clone(this.list));
        if (this.history.length > 100) this.history.shift();
        this.redoStack = [];
        this._nudgeBurstAnn = src.id;
      }
      this._nudgeBurstUntil = now + 500; // coalesce rapid presses into this entry
      this._closeAreaMenu(); // the floating menu would sit detached as the highlight moves
      this._translateClamped(src, dx, dy);
      this._afterChange(); // re-render + save; the edit box re-glues via _refreshSelection
      return true;
    },
    duplicateSelected() {
      const src = this.list.find((a) => a.id === this._selectedId);
      if (!src) return false;
      const copy = Utils.clone(src);
      copy.id = Utils.uid();
      copy.createdAt = Date.now();
      const OFF = 12; // PDF points ≈ one text line; y-up, so down = smaller y
      this._translateClamped(copy, 0, -OFF);
      this._mutate(() => { this.list.push(copy); });
      const wrap = (this._app().rendered.get(copy.page) || {}).wrap || null;
      this._selectArea(copy.id, wrap); // the copy takes the selection → next press offsets from it
      this._closeAreaMenu();
      return true;
    },

    /* ── notes ──────────────────────────────────────────────── */
    _activeNoteId: null,

    _addNote(wrap, pdfPt, text) {
      const ann = {
        id: Utils.uid(),
        type: "note",
        page: Number(wrap.dataset.page),
        point: { x: pdfPt[0], y: pdfPt[1] },
        text: text || "",
        color: "#f472b6",
        createdAt: Date.now(),
      };
      this._mutate(() => this.list.push(ann));
      const pin = this.renderNotePin(wrap, ann);
      this._openNoteEditor(ann, pin);
    },

    _openNoteEditor(ann, pinEl) {
      this._activeNoteId = ann.id;
      const app = this._app();
      const pop = app.elements.notePopover;
      const input = app.elements.noteInput;
      input.value = ann.text || "";
      pop.hidden = false;
      input.focus();
      // position near the pin
      if (pinEl) {
        const wrap = pinEl.closest(".page-wrap");
        const wrapRect = wrap.getBoundingClientRect();
        const scrollerRect = app.elements.scroller.getBoundingClientRect();
        const pinRect = pinEl.getBoundingClientRect();
        const left = pinRect.left - scrollerRect.left + app.elements.scroller.scrollLeft + 14;
        const top = pinRect.top - scrollerRect.top + app.elements.scroller.scrollTop + 14;
        pop.style.left = left + "px";
        pop.style.top = top + "px";
      }
      app.elements.noteDelete.hidden = !ann.text;
    },

    _saveNote() {
      const ann = this.list.find((a) => a.id === this._activeNoteId);
      if (ann) {
        const text = this._app().elements.noteInput.value.trim();
        this._mutate(() => { ann.text = text; });
      }
      this._closeNote();
    },
    _deleteNote() {
      if (this._activeNoteId) this.removeById(this._activeNoteId);
      this._closeNote();
    },
    _closeNote() {
      this._activeNoteId = null;
      this._app().elements.notePopover.hidden = true;
    },

    /* ── management ─────────────────────────────────────────── */
    removeById(id) {
      this._mutate(() => {
        this.list = this.list.filter((a) => a.id !== id);
      });
    },

    annotationsForPage(page) {
      return this.list.filter((a) => a.page === page);
    },

    /* ── rendering overlays ─────────────────────────────────── */
    renderOverlay(wrap, pageIndex) {
      const overlay = wrap.querySelector(".page-overlay");
      const vp = this._app().getViewportForPage(pageIndex);
      if (!overlay || !vp) return;
      const dpr = window.devicePixelRatio || 1;
      overlay.width = Math.floor(vp.width * dpr);
      overlay.height = Math.floor(vp.height * dpr);
      const ctx = overlay.getContext("2d");
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, vp.width, vp.height);

      for (const ann of this.annotationsForPage(pageIndex)) {
        if (ann.type === "note") continue; // notes render as pins (DOM)
        if (ann.type === "signature") { this._drawAnnImage(ctx, wrap, ann); continue; }
        if (ann.type === "date") { this._drawDateStamp(ctx, wrap, ann); continue; }
        if (ann.type === "form") { this._drawFormField(ctx, wrap, ann); continue; }
        // area highlights from BOTH the highlight tool's blank-space fallback
        // and the dedicated Rectangle tool draw the same filled rect
        if ((ann.type === "highlight" || ann.type === "rect") && ann.rect) {
          // area highlight (drag on blank space): fill the stored rectangle.
          // The corners go through the SAME _rectCornersPdf mapping the export
          // uses, so a rotated highlight renders exactly as it exports (and a
          // rotated page stays correct too).
          const pts = this._rectCornersLocal(wrap, ann);
          ctx.fillStyle = this._hexToRgba(ann.color || "#fde047", 0.38);
          ctx.beginPath();
          ctx.moveTo(pts[0].x, pts[0].y);
          ctx.lineTo(pts[1].x, pts[1].y);
          ctx.lineTo(pts[2].x, pts[2].y);
          ctx.lineTo(pts[3].x, pts[3].y);
          ctx.closePath();
          ctx.fill();
          continue;
        }
        const quads = ann.quads || [];
        for (const q of quads) {
          // a malformed quad (e.g. from a doctored backup: a flat point list
          // instead of an array of polygons) must skip, never abort the whole
          // page's overlay — every annotation after it would silently vanish
          if (!Array.isArray(q) || q.length < 4) continue;
          const pts = q.map((p) => this._pdfToLocal(wrap, p.x, p.y));
          if (ann.type === "highlight") {
            ctx.beginPath();
            ctx.moveTo(pts[0].x, pts[0].y);
            ctx.lineTo(pts[1].x, pts[1].y);
            ctx.lineTo(pts[2].x, pts[2].y);
            ctx.lineTo(pts[3].x, pts[3].y);
            ctx.closePath();
            ctx.fillStyle = this._hexToRgba(ann.color || "#fde047", 0.38);
            ctx.fill();
          } else if (ann.type === "underline") {
            ctx.beginPath();
            ctx.strokeStyle = this._hexToRgba(ann.color || "#4cc9f0", 0.9);
            ctx.lineWidth = 1.4;
            ctx.moveTo(pts[0].x, pts[3].y - 0.8);
            ctx.lineTo(pts[1].x, pts[2].y - 0.8);
            ctx.stroke();
          } else if (ann.type === "strike") {
            ctx.beginPath();
            ctx.strokeStyle = this._hexToRgba(ann.color || "#f87171", 0.9);
            ctx.lineWidth = 1.2;
            const my = (pts[0].y + pts[3].y) / 2;
            ctx.moveTo(pts[0].x, my);
            ctx.lineTo(pts[1].x, my);
            ctx.stroke();
          }
        }
      }
    },

    /* ── signature / date / form-field overlay drawing ───────── */
    _imgCache: new Map(), // dataURL → HTMLImageElement (lazy, rendered when ready)

    _imgFor(dataURL) {
      if (!dataURL) return null;
      let img = this._imgCache.get(dataURL);
      if (!img) {
        img = new Image();
        const self = this;
        img.onload = () => {
          // the image arrived after a first draw (a placed signature, or a
          // restored backup) — re-render the pages that show it
          const app = self._app();
          for (const ann of self.list) {
            if (ann.image === dataURL && ann.rect) {
              const wrap = (app.rendered.get(ann.page) || {}).wrap;
              if (wrap) self.renderOverlay(wrap, ann.page);
            }
          }
        };
        img.src = dataURL;
        this._imgCache.set(dataURL, img);
      }
      return img.complete && img.naturalWidth ? img : null;
    },

    /** The annotation's rect as {x,y,w,h} in LOCAL (page-wrap) coords. */
    _rectLocal(wrap, ann) {
      const a = this._pdfToLocal(wrap, ann.rect.x, ann.rect.y);
      const b = this._pdfToLocal(wrap, ann.rect.x + ann.rect.w, ann.rect.y + ann.rect.h);
      return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
    },

    _drawAnnImage(ctx, wrap, ann) {
      const img = this._imgFor(ann.image);
      const r = this._rectLocal(wrap, ann);
      if (img) {
        if (ann.rotation) {
          ctx.save();
          ctx.translate(r.x + r.w / 2, r.y + r.h / 2);
          ctx.rotate(-ann.rotation * Math.PI / 180);
          ctx.drawImage(img, -r.w / 2, -r.h / 2, r.w, r.h);
          ctx.restore();
        } else {
          ctx.drawImage(img, r.x, r.y, r.w, r.h);
        }
      } else {
        // placeholder until the bitmap loads (or a doctored backup)
        ctx.fillStyle = "rgba(124, 108, 255, 0.18)";
        ctx.fillRect(r.x, r.y, r.w, r.h);
        ctx.strokeStyle = "rgba(124, 108, 255, 0.6)";
        ctx.setLineDash([4, 3]);
        ctx.strokeRect(r.x, r.y, r.w, r.h);
        ctx.setLineDash([]);
      }
    },

    _drawDateStamp(ctx, wrap, ann) {
      const r = this._rectLocal(wrap, ann);
      ctx.fillStyle = "rgba(148, 163, 184, 0.14)";
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.fillStyle = "rgba(30, 41, 59, 0.9)";
      ctx.font = "600 " + Math.max(10, Math.round(r.h * 0.6)) + "px 'Segoe UI', system-ui, sans-serif";
      ctx.textBaseline = "middle";
      ctx.fillText(ann.text || "", r.x + 4, r.y + r.h / 2);
    },

    _drawFormField(ctx, wrap, ann) {
      const r = this._rectLocal(wrap, ann);
      const ink = "rgba(91, 79, 214, 0.85)";
      ctx.fillStyle = "rgba(91, 79, 214, 0.07)";
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.strokeStyle = ink;
      ctx.lineWidth = 1;
      ctx.setLineDash([5, 3]);
      ctx.strokeRect(r.x, r.y, r.w, r.h);
      ctx.setLineDash([]);
      if (ann.fieldType === "checkbox") {
        const s = Math.min(r.w, r.h);
        ctx.lineWidth = 1.5;
        ctx.setLineDash([]);
        ctx.strokeRect(r.x + 2, r.y + 2, s - 4, s - 4);
        if (ann.value && String(ann.value) !== "0" && String(ann.value).toLowerCase() !== "false") {
          ctx.beginPath();
          ctx.moveTo(r.x + 5, r.y + s / 2 + 1);
          ctx.lineTo(r.x + s / 2 - 1, r.y + s - 6);
          ctx.lineTo(r.x + s - 6, r.y + 5);
          ctx.stroke();
        }
      } else {
        const label = (ann.name || "").replace(/^volt_field_/, "") || (ann.fieldType === "date" ? "date" : "field");
        ctx.font = "10px 'Segoe UI', system-ui, sans-serif";
        ctx.textBaseline = "bottom";
        ctx.fillStyle = ink;
        ctx.fillText(label, r.x + 2, Math.max(8, r.y - 3));
        ctx.font = Math.max(10, Math.round(r.h * 0.55)) + "px 'Segoe UI', system-ui, sans-serif";
        ctx.textBaseline = "middle";
        ctx.fillStyle = "rgba(30, 41, 59, 0.85)";
        ctx.fillText(ann.value || "", r.x + 6, r.y + r.h / 2);
      }
    },

    renderNotePin(wrap, ann) {
      wrap.querySelectorAll(`.note-pin[data-id="${CSS.escape(ann.id)}"]`).forEach((p) => p.remove());
      const pt = this._pdfToLocal(wrap, ann.point.x, ann.point.y);
      const pin = document.createElement("div");
      pin.className = "note-pin" + (ann.text ? " has-note" : "");
      pin.dataset.id = ann.id;
      pin.title = ann.text ? ann.text : "Empty note — click to edit";
      pin.style.left = (pt.x - 9) + "px";
      pin.style.top = (pt.y - 9) + "px";
      wrap.appendChild(pin);
      return pin;
    },

    renderAllPins() {
      const app = this._app();
      app.elements.pages.querySelectorAll(".page-wrap").forEach((wrap) => {
        const page = Number(wrap.dataset.page);
        const vp = this._app().getViewportForPage(page);
        wrap.querySelectorAll(".note-pin").forEach((p) => p.remove());
        if (!vp) return;
        for (const ann of this.annotationsForPage(page)) {
          if (ann.type === "note") this.renderNotePin(wrap, ann);
        }
      });
    },

    _hexToRgba(hex, alpha) {
      const h = hex.replace("#", "");
      const r = parseInt(h.slice(0, 2), 16);
      const g = parseInt(h.slice(2, 4), 16);
      const b = parseInt(h.slice(4, 6), 16);
      return `rgba(${r},${g},${b},${alpha})`;
    },

    /* ── sidebar notes list ─────────────────────────────────── */
    refreshNotesList() {
      const el = this._app().elements.notesList;
      if (!this.list.length) {
        el.innerHTML = '<div class="notes-empty">No annotations yet.<br>Highlight text, underline it, or drop a note pin.</div>';
        return;
      }
      el.innerHTML = "";
      const sorted = [...this.list].sort((a, b) => (a.page - b.page) || (a.createdAt - b.createdAt));
      for (const ann of sorted) {
        const card = document.createElement("div");
        card.className = "note-card";
        card.dataset.id = ann.id;
        const typeLabel = TYPES[ann.type]?.label || ann.type;
        const text = ann.type === "note"
          ? (ann.text || "(empty note)")
          : ann.rect
            ? (ann.type === "rect" ? "(rectangle)"
              : ann.type === "form" ? "(" + (ann.fieldType || "text") + " field" + (ann.name ? " — " + ann.name.replace(/^volt_field_/, "") : "") + ")"
                : ann.type === "signature" ? "(signature)"
                  : ann.type === "date" ? (ann.text || "(date stamp)")
                    : "(area highlight)")
            : `“${ann.text || ""}”`;
        card.innerHTML = `
          <div class="note-card-head">
            <span class="note-color-dot" style="background:${ann.color || "#fde047"}"></span>
            <span>${typeLabel} · p.${ann.page}</span>
            <button class="tb-btn tb-btn-icon note-del" title="Delete" style="width:22px;height:22px;margin-left:auto">
              <svg viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>
            </button>
          </div>
          <div class="note-card-text ${ann.type === "note" ? "is-note" : ""}">${Utils.esc(text)}</div>`;
        el.appendChild(card);
      }
    },

    /* ── export ─────────────────────────────────────────────── */
    toMarkdown() {
      if (!this.list.length) return "# Annotations\n\n_No annotations._\n";
      let md = "# Annotations\n";
      md += `_Document: ${this.docInfo?.name || "untitled"}_\n\n`;
      const sorted = [...this.list].sort((a, b) => (a.page - b.page) || (a.createdAt - b.createdAt));
      for (const ann of sorted) {
        md += `## ${TYPES[ann.type]?.label || ann.type} — page ${ann.page}\n`;
        if (ann.text) md += `> ${ann.text}\n`;
        else if (ann.rect) {
          if (ann.type === "form") md += `> _(form field: ${ann.fieldType || "text"}${ann.name ? " — " + ann.name.replace(/^volt_field_/, "") : ""})_\n`;
          else if (ann.type === "signature") md += "> _(signature)_\n";
          else md += ann.type === "rect" ? "> _(rectangle)_\n" : "> _(area highlight)_\n";
        }
        md += "\n";
      }
      return md;
    },

    /** Serialize this document's backup. The export dialog lets the user
        choose its layers: annotations (always) plus, when ticked, the
        document's AI overrides and/or chat transcript. Unselected sections
        are OMITTED from the JSON entirely (not nulled) so a restore treats
        them as "not part of this backup" rather than "clear them".
        No options = everything (backwards compatible). */
    toJSON(opts = {}) {
      const withAi = opts.aiOverrides !== false;
      const withChat = opts.chatHistory !== false;
      const out = {
        app: "volt",
        version: 5, // v5 adds fileFingerprint — a content hash that hardens restore matching
        file: this.docInfo?.name,
        fileSize: this.docInfo?.size,   // lets Restore backup match more than the name alone
        filePages: this.docInfo?.pages,
        // hash of the document's sampled page text: a renamed copy of the same
        // PDF still matches on restore, while a doctored file with identical
        // size does not. Scanned documents use their OCR text (computed on
        // demand if needed), so they hash by content too; null only when
        // nothing was recognizable — matching then falls back to name + size
        // + pages.
        fileFingerprint: this.docInfo?.fingerprint || null,
        exportedAt: new Date().toISOString(),
        annotations: this.list,
      };
      if (withAi) {
        out.aiSettings = global.Volt.AI && global.Volt.AI._docSettings ? global.Volt.AI._docSettings() : null;
      }
      if (withChat) {
        // the transcript window follows the AI settings' history cap, so a
        // backup carries exactly as much as the app itself keeps
        const limit = global.Volt.AI._historyLimit();
        out.chatHistory = global.Volt.AI && Array.isArray(global.Volt.AI.messages) ? global.Volt.AI.messages.slice(-limit) : [];
      }
      return JSON.stringify(out, null, 2);
    },

    /** Burn ONE annotation onto an already-added output page (shared by the
        annotated-PDF export and the page-manager rebuild). Coordinates are
        page-space PDF points, so the same call works whether the page is the
        original, a blank, or copied from another PDF. Async because
        signatures embed a PNG (pdf-lib embedPng) and form fields need the
        document's AcroForm (`pdf` is the PDFDocument being written). */
    async _burnAnnotation(page, ann, helv, pdf) {
      const { rgb } = global.PDFLib;
      const { width, height } = page.getSize();
      const col = this._hexToRgb(ann.color);
      const c = rgb(col.r, col.g, col.b);
      if (ann.type === "highlight" || ann.type === "rect") {
        if (ann.rect) {
          // area highlight: stored directly in PDF coords. Rotated rects
          // are drawn as an SVG path through the same _rectCornersPdf the
          // overlay uses (drawRectangle can't rotate); unrotated ones keep
          // the cheap direct call.
          if (ann.rotation) {
            const corners = this._rectCornersPdf(ann);
            const path = "M " + corners.map((p) => p.x + " " + p.y).join(" L ") + " Z";
            page.drawSvgPath(path, { color: c, opacity: 0.35 });
          } else {
            page.drawRectangle({ x: ann.rect.x, y: ann.rect.y, width: ann.rect.w, height: ann.rect.h, color: c, opacity: 0.35 });
          }
        } else {
          for (const q of ann.quads || []) {
            const x = Math.min(q[0].x, q[3].x);
            const y = Math.min(q[3].y, q[2].y);
            const w = Math.abs(q[1].x - q[0].x);
            const h = Math.abs(q[0].y - q[3].y);
            if (w > 0.5 && h > 0.5) {
              page.drawRectangle({ x, y, width: w, height: h, color: c, opacity: 0.35 });
            }
          }
        }
      } else if (ann.type === "underline") {
        for (const q of ann.quads || []) {
          const y = Math.min(q[3].y, q[2].y) - 1;
          page.drawLine({ start: { x: q[0].x, y }, end: { x: q[1].x, y }, thickness: 1.2, color: c, opacity: 0.85 });
        }
      } else if (ann.type === "strike") {
        for (const q of ann.quads || []) {
          const y = (q[0].y + q[3].y) / 2;
          page.drawLine({ start: { x: q[0].x, y }, end: { x: q[1].x, y }, thickness: 1, color: c, opacity: 0.85 });
        }
      } else if (ann.type === "note" && ann.text) {
        // small pin + text near the point
        const px = ann.point.x, py = ann.point.y;
        page.drawCircle({ x: px, y: py, size: 4, color: c, opacity: 0.9 });
        page.drawText(ann.text, {
          x: Math.min(px + 8, width - 4),
          y: Math.min(py, height - 12),
          size: 8,
          font: helv,
          color: rgb(0.2, 0.2, 0.25),
          maxWidth: Math.max(120, width - 70),
          opacity: 0.95,
        });
      } else if (ann.type === "signature" && ann.image && ann.rect) {
        // embed the signature bitmap as a PNG image at the rect
        const bytes = this._dataUrlToBytes(ann.image);
        if (bytes) {
          try {
            const png = await pdf.embedPng(bytes);
            page.drawImage(png, { x: ann.rect.x, y: ann.rect.y, width: ann.rect.w, height: ann.rect.h, opacity: 0.96 });
          } catch (e) {
            // a corrupt image must never break the whole export — skip it
          }
        }
      } else if (ann.type === "date" && ann.text && ann.rect) {
        const r = ann.rect;
        const fs = Math.max(8, Math.min(r.h * 0.6, 20));
        page.drawText(ann.text, {
          x: r.x + 2,
          y: r.y + (r.h - fs) / 2,
          size: fs,
          font: helv,
          color: rgb(0.15, 0.2, 0.32),
          opacity: 0.95,
        });
      } else if (ann.type === "form" && ann.rect) {
        await this._burnFormField(pdf, page, ann, helv);
      }
    },

    /** Turn a placed form field into a REAL AcroForm widget on the exported
        PDF: text/date fields become fillable text fields, checkboxes become
        check boxes, signature fields bake the signature image. A failure
        (e.g. a duplicate field name on a re-export) degrades to drawing the
        value as plain text so the export always succeeds. */
    async _burnFormField(pdf, page, ann, helv) {
      const r = ann.rect;
      const { rgb } = global.PDFLib;
      const name = ann.name || ("volt_field_" + (ann.id || "f").slice(0, 8));
      const rect = { x: r.x, y: r.y, width: r.w, height: r.h };
      try {
        const form = pdf.getForm();
        if (ann.fieldType === "signature" && ann.image) {
          const bytes = this._dataUrlToBytes(ann.image);
          if (bytes) {
            try {
              const png = await pdf.embedPng(bytes);
              page.drawImage(png, { x: r.x, y: r.y, width: r.w, height: r.h, opacity: 0.96 });
            } catch (e) { /* skip */ }
          }
          return;
        }
        if (ann.fieldType === "checkbox") {
          let f;
          try { f = form.createCheckBox(name); }
          catch (e) { try { f = form.getCheckBox(name); } catch (e2) { throw e; } }
          const on = ann.value && String(ann.value) !== "" && String(ann.value) !== "0" && String(ann.value).toLowerCase() !== "false";
          if (on) f.check();
          f.addToPage(page, rect);
          return;
        }
        // text + date → a real text field (date widgets are just text fields
        // with a date value; no date-picker widget in pdf-lib)
        let f;
        try { f = form.createTextField(name); }
        catch (e) { try { f = form.getTextField(name); } catch (e2) { throw e; } }
        if (ann.value) f.setText(String(ann.value));
        try { f.setFontSize(Math.max(8, Math.round(r.h * 0.5))); } catch (e) { /* optional */ }
        f.addToPage(page, rect);
      } catch (e) {
        // fallback: draw the value as plain text so the field still shows
        try {
          page.drawText(String(ann.value || ""), {
            x: r.x + 2, y: r.y + 2, size: Math.max(8, r.h * 0.5),
            font: helv, color: rgb(0.2, 0.2, 0.3), opacity: 0.9,
          });
        } catch (e2) { /* never let a field failure break the export */ }
      }
    },

    _dataUrlToBytes(dataURL) {
      try {
        const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataURL || "");
        if (!m) return null;
        const bin = atob(m[1]);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return bytes;
      } catch (e) { return null; }
    },

    async toAnnotatedPdf() {
      const app = this._app();
      if (!app.currentDoc || !app.currentDocBytes) throw new Error("No document loaded");
      const { PDFDocument, StandardFonts } = global.PDFLib;
      const pdf = await PDFDocument.load(app.currentDocBytes, { ignoreEncryption: true });
      const helv = await pdf.embedFont(StandardFonts.Helvetica);

      const byPage = {};
      for (const ann of this.list) (byPage[ann.page] = byPage[ann.page] || []).push(ann);

      for (const pageNum of Object.keys(byPage)) {
        const page = pdf.getPage(parseInt(pageNum, 10) - 1);
        for (const ann of byPage[pageNum]) await this._burnAnnotation(page, ann, helv, pdf);
      }
      return pdf.save();
    },

    /** Build a new PDF from a page-management plan. plan entries:
          { kind: "doc",   oldPage }              — a page of the OPEN document
          { kind: "blank", w, h }                 — a fresh blank page
          { kind: "other", bytes, page, name }    — a page copied from another PDF
        Annotations are burned onto their pages at their NEW positions (a
        "doc" entry's annotations move with the page); blank and imported pages
        carry none. Returns the new PDF bytes. */
    async buildEditedPdf(plan) {
      const app = this._app();
      if (!app.currentDoc || !app.currentDocBytes) throw new Error("No document loaded");
      if (!Array.isArray(plan) || !plan.length) throw new Error("Nothing to build");
      const { PDFDocument, StandardFonts } = global.PDFLib;
      const src = await PDFDocument.load(app.currentDocBytes, { ignoreEncryption: true });
      const out = await PDFDocument.create();
      const helv = await out.embedFont(StandardFonts.Helvetica);

      const byPage = {};
      for (const ann of this.list) (byPage[ann.page] = byPage[ann.page] || []).push(ann);

      // external-PDF cache keyed by the bytes themselves (a plan can mix pages
      // from SEVERAL picked files — entries of one file share the same
      // ArrayBuffer, so a WeakMap is exact; pdf-lib may mutate/transfer the
      // buffer, hence the copy on load)
      const otherDocs = new WeakMap();
      for (const e of plan) {
        let page;
        if (e.kind === "doc") {
          const [p] = await out.copyPages(src, [e.oldPage - 1]);
          page = out.addPage(p);
        } else if (e.kind === "blank") {
          page = out.addPage([e.w, e.h]);
        } else if (e.kind === "other") {
          let od = otherDocs.get(e.bytes);
          if (!od) {
            od = await PDFDocument.load(e.bytes.slice(0), { ignoreEncryption: true });
            otherDocs.set(e.bytes, od);
          }
          const [p] = await out.copyPages(od, [e.page - 1]);
          page = out.addPage(p);
        } else {
          throw new Error("Unknown plan entry: " + e.kind);
        }
        if (e.kind === "doc") {
          for (const ann of byPage[e.oldPage] || []) await this._burnAnnotation(page, ann, helv, out);
        }
      }
      return out.save();
    },

    _hexToRgb(hex) {
      const h = (hex || "#fde047").replace("#", "");
      return {
        r: parseInt(h.slice(0, 2), 16) / 255,
        g: parseInt(h.slice(2, 4), 16) / 255,
        b: parseInt(h.slice(4, 6), 16) / 255,
      };
    },

    importFromJSON(str) {
      const data = JSON.parse(str);
      const list = Array.isArray(data) ? data : data.annotations;
      if (!Array.isArray(list)) throw new Error("Not a valid annotations file");
      this._mutate(() => { this.list = list; });
      // restore the document's AI overrides (if present)
      const hasAi = data && typeof data === "object" && !Array.isArray(data) && data.aiSettings && typeof data.aiSettings === "object";
      if (hasAi) {
        const m = typeof data.aiSettings.model === "string" ? data.aiSettings.model.trim() : "";
        const rawC = parseInt(data.aiSettings.maxContextChars, 10);
        // clamp to the same range the settings UI enforces — a huge hand-edited
        // value would silently balloon the context budget sent to the model
        const c = Number.isFinite(rawC) && rawC > 0 ? Utils.clamp(rawC, 1000, 60000) : 0;
        const s = typeof data.aiSettings.systemPrompt === "string" ? data.aiSettings.systemPrompt.trim() : "";
        // carry the recorded provider/endpoint so a transfer keeps the model's
        // provenance (and the popover's reachability hint stays accurate)
        // an empty/whitespace provider string (hand-edited backup) would be
        // falsy later and silently disable the reachability warning — treat it
        // as absent so the stamp is re-derived on the next model change instead
        const p = typeof data.aiSettings.provider === "string" && data.aiSettings.provider.trim() ? data.aiSettings.provider : undefined;
        const e = typeof data.aiSettings.endpoint === "string" ? data.aiSettings.endpoint : undefined;
        global.Volt.AI._applyDocOverride(m, c, s, p, e);
        global.Volt.AI._renderModelLine();
      }
      // restore the chat transcript (if present — an empty array clears the
      // chat, matching the backup-is-authoritative behavior of the annotations)
      const hasChat = data && typeof data === "object" && !Array.isArray(data) && Array.isArray(data.chatHistory);
      if (hasChat) global.Volt.AI.importChatFromBackup(data.chatHistory);
      // importing a backup for a different document is allowed (the annotations
      // land in the current doc too) — but say so, so the restored overrides
      // and/or chat aren't a silent surprise. A restore matched by fingerprint
      // (a renamed copy of the same PDF) is NOT a different document, so it
      // skips the warning.
      const fpMatch = typeof data.fileFingerprint === "string" && this.docInfo &&
        typeof this.docInfo.fingerprint === "string" &&
        data.fileFingerprint === this.docInfo.fingerprint;
      if (!fpMatch && data && typeof data === "object" && !Array.isArray(data) && data.file && this.docInfo && data.file !== this.docInfo.name) {
        const parts = [];
        if (hasAi) parts.push("AI overrides");
        if (hasChat) parts.push("chat history");
        if (parts.length) {
          const what = parts.join(" and ");
          this._app().toast("This backup is for “" + data.file + "” — its " + what + (what === "chat history" ? " was" : " were") + " applied to the current document", "error");
        }
      }
    },
  };

  Volt.Ann.TYPES = TYPES;
  Volt.Ann.PALETTE = PALETTE;
})(typeof window !== "undefined" ? window : globalThis);
