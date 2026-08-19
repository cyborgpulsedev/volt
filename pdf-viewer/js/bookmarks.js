/* ═══════════════════════════════════════════════════════════════
   bookmarks.js — Volt.Bm
   Per-document bookmarks: jump marks with an optional label, stored
   in localStorage under the SAME (name:size:pages) identity scheme
   the annotations use, so a bookmark set follows its document across
   reloads and re-exports exactly like the notes do.
   ═══════════════════════════════════════════════════════════════ */
(function (global) {
  "use strict";

  const Volt = global.Volt = global.Volt || {};

  const MARKER_SVG =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1z"/></svg>';

  Volt.Bm = {
    list: [],           // [{id, page, label, createdAt, updatedAt}] for current doc
    fileKey: null,      // localStorage key
    docInfo: null,      // {name, size, pages}
    _savedTimer: null,
    _filter: "",        // live find-text, applied by refreshList

    init() {
      const app = this._app();
      if (app.elements.btnBm) {
        app.elements.btnBm.addEventListener("click", () => app.openBookmarksPanel());
      }
      const filter = app.elements.bmFilter;
      if (filter) {
        filter.addEventListener("input", () => {
          this._filter = filter.value.trim().toLowerCase();
          this.refreshList();
        });
        filter.addEventListener("keydown", (e) => {
          if (e.key === "Escape") { this._filter = ""; filter.value = ""; this.refreshList(); filter.blur(); }
        });
      }
      if (app.elements.btnBmAdd) {
        app.elements.btnBmAdd.addEventListener("click", () => this.addBookmark());
      }
      if (app.elements.btnBmClear) {
        app.elements.btnBmClear.addEventListener("click", () => {
          if (!this.list.length) return;
          if (confirm("Clear all bookmarks for this document?")) this.clear();
        });
      }
      app.elements.bmList.addEventListener("click", (e) => {
        const card = e.target.closest(".bm-card");
        if (!card) return;
        const id = card.dataset.id;
        if (e.target.closest(".bm-del")) { this.remove(id); return; }
        if (e.target.closest(".bm-edit")) { this._beginEdit(card, id); return; }
        if (e.target.closest(".bm-save")) { this._saveEdit(card, id); return; }
        if (e.target.closest(".bm-cancel")) { this._cancelEdit(card, id); return; }
        // clicking the card body jumps to the page (edit/delete buttons swallow their own clicks)
        const bm = this.list.find((b) => b.id === id);
        if (bm) {
          this._app().goToPage(bm.page);
          const mk = document.querySelector(`.bm-marker[data-id="${CSS.escape(id)}"]`);
          if (mk) { mk.style.outline = "3px solid #4cc9f0"; setTimeout(() => mk.style.outline = "", 900); }
        }
      });
    },

    _app() { return global.Volt.App; },

    /* ── document lifecycle ─────────────────────────────────── */
    loadForDoc(docInfo) {
      this.docInfo = docInfo;
      this.fileKey = docInfo ? `volt:bm:${Utils.hash(docInfo.name + ":" + docInfo.size + ":" + docInfo.pages)}` : null;
      this.list = [];
      this._filter = "";
      const filter = this._app().elements.bmFilter;
      if (filter) filter.value = "";
      if (this.fileKey) {
        try {
          const raw = localStorage.getItem(this.fileKey);
          if (raw) this.list = JSON.parse(raw);
        } catch (e) { this.list = []; }
      }
      this.refreshAll();
    },

    /* ── mutations ──────────────────────────────────────────── */
    /** Add a bookmark for a page (default label "Page N" when none given).
        Double-adding the same page is allowed — each is its own jump mark —
        but the common case (Ctrl+Shift+B on an already-bookmarked page)
        toasts the existing count instead of stacking silently. */
    add(page, label) {
      const app = this._app();
      page = Utils.clamp(Math.round(Number(page) || 1), 1, app.pageLayout.length || 1);
      const id = "bm_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      const text = (label != null ? String(label) : "").trim();
      const bm = { id, page, label: text, createdAt: Date.now(), updatedAt: Date.now() };
      this.list.push(bm);
      this._save();
      this.refreshAll();
      app.toast("Bookmarked page " + page + (text ? " — “" + text + "”" : ""), "ok");
      return bm;
    },
    /** Toolbar/panel convenience: bookmark the page currently in view. */
    addBookmark() {
      const app = this._app();
      if (!app.currentDoc) { app.toast("Open a document first, then bookmark a page", "error"); return; }
      this.add(app._currentPageNum());
    },

    rename(id, label) {
      const bm = this.list.find((b) => b.id === id);
      if (!bm) return;
      bm.label = (label != null ? String(label) : "").trim();
      bm.updatedAt = Date.now();
      this._save();
      this.refreshAll();
    },

    remove(id) {
      const before = this.list.length;
      this.list = this.list.filter((b) => b.id !== id);
      if (this.list.length === before) return;
      this._save();
      this.refreshAll();
      this._app().toast("Bookmark removed", "ok");
    },

    clear() {
      if (!this.list.length) return;
      this.list = [];
      this._save();
      this.refreshAll();
      this._app().toast("All bookmarks cleared", "ok");
    },

    /** Remove every bookmark on one page (thumbnail right-click menu). */
    removePageBookmarks(page) {
      const before = this.list.length;
      this.list = this.list.filter((b) => b.page !== page);
      if (this.list.length === before) return;
      this._save();
      this.refreshAll();
      this._app().toast("Bookmarks removed from page " + page, "ok");
    },

    /* ── inline edit (rename the label in the list card) ────── */
    _beginEdit(card, id) {
      const bm = this.list.find((b) => b.id === id);
      if (!bm) return;
      card.classList.add("editing");
      const body = card.querySelector(".bm-card-body");
      body.innerHTML = `
        <input class="bm-edit-input" type="text" value="${Utils.esc(bm.label)}" placeholder="Bookmark label…" maxlength="200" spellcheck="false" aria-label="Bookmark label">
        <div class="bm-edit-row">
          <button class="mini-btn primary bm-save" type="button">Save</button>
          <button class="mini-btn bm-cancel" type="button">Cancel</button>
        </div>`;
      const inp = body.querySelector(".bm-edit-input");
      inp.focus();
      inp.select();
      const commit = () => this._saveEdit(card, id);
      inp.addEventListener("keydown", (e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") this._cancelEdit(card, id);
      });
    },
    _saveEdit(card, id) {
      const inp = card.querySelector(".bm-edit-input");
      this.rename(id, inp ? inp.value : "");
      this.refreshList();
      this._app().toast("Bookmark updated", "ok");
    },
    _cancelEdit(card, id) {
      card.classList.remove("editing");
      this.refreshList();
    },

    /* ── render: sidebar list + find + badge + page markers ── */
    refreshAll() {
      this.refreshBadge();
      this.refreshList();
      this.renderAllMarkers();
      // keep the "Bookmarked pages" section pinned atop the Outline tree in sync
      const app = this._app();
      if (app && typeof app._refreshOutlineBookmarks === "function") app._refreshOutlineBookmarks();
    },

    refreshBadge() {
      const n = this.list.length;
      const el = this._app().elements.bmBadge;
      if (!el) return;
      el.hidden = n === 0;
      el.textContent = n;
    },

    /** The "find them/list them" surface: every bookmark as a card sorted by
        page, filtered live by label text (or page number) typed in the panel's
        find box. The card body jumps to the page; Edit renames inline; ✕ deletes. */
    refreshList() {
      const el = this._app().elements.bmList;
      if (!this.list.length) {
        el.innerHTML = '<div class="notes-empty">No bookmarks yet.<br>Bookmark this page and it will appear here.</div>';
        return;
      }
      let items = [...this.list].sort((a, b) => (a.page - b.page) || (a.createdAt - b.createdAt));
      if (this._filter) {
        items = items.filter((b) =>
          (b.label || "").toLowerCase().includes(this._filter) ||
          String(b.page).includes(this._filter));
      }
      if (!items.length) {
        el.innerHTML = '<div class="notes-empty">No bookmarks match “' + Utils.esc(this._filter) + '”.</div>';
        return;
      }
      el.innerHTML = "";
      for (const bm of items) {
        const card = document.createElement("div");
        card.className = "bm-card";
        card.dataset.id = bm.id;
        card.title = "Jump to page " + bm.page;
        card.innerHTML = `
          <div class="bm-card-head">
            <span class="bm-ribbon" aria-hidden="true">${MARKER_SVG}</span>
            <span class="bm-page">p.${bm.page}</span>
            <button class="tb-btn tb-btn-icon bm-edit" title="Rename this bookmark" style="width:22px;height:22px">
              <svg viewBox="0 0 24 24"><path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/></svg>
            </button>
            <button class="tb-btn tb-btn-icon bm-del" title="Remove this bookmark" style="width:22px;height:22px">
              <svg viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>
            </button>
          </div>
          <div class="bm-card-body">${Utils.esc(bm.label || "Page " + bm.page)}</div>`;
        el.appendChild(card);
      }
    },

    /** A small ribbon in the top-right corner of every rendered page that has
        bookmarks — the at-a-glance "this page is bookmarked" indicator. Click
        opens the Bookmarks panel (edit/remove live there). */
    renderMarkers(wrap, pageNum) {
      if (!wrap) return;
      wrap.querySelectorAll(".bm-marker").forEach((m) => m.remove());
      const bms = this.list.filter((b) => b.page === pageNum);
      if (!bms.length) return;
      for (const bm of bms) {
        const mk = document.createElement("button");
        mk.type = "button";
        mk.className = "bm-marker";
        mk.dataset.id = bm.id;
        mk.title = "Bookmarked" + (bm.label ? ": " + bm.label : "") + " (p." + bm.page + ") — click to open Bookmarks";
        mk.setAttribute("aria-label", "Bookmarked page " + bm.page);
        mk.innerHTML = MARKER_SVG;
        mk.addEventListener("click", (e) => {
          e.stopPropagation();
          this._app().openBookmarksPanel();
        });
        wrap.appendChild(mk);
      }
    },

    renderAllMarkers() {
      const app = this._app();
      app.elements.pages.querySelectorAll(".page-wrap").forEach((wrap) => {
        const page = Number(wrap.dataset.page);
        if (page) this.renderMarkers(wrap, page);
      });
    },

    _save() {
      if (!this.fileKey) return;
      try { localStorage.setItem(this.fileKey, JSON.stringify(this.list)); } catch (e) { /* quota */ }
    },
  };
})(window);
