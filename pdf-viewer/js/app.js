/* ═══════════════════════════════════════════════════════════════
   app.js — Volt.App
   Viewer core: pdf.js rendering, continuous scroll, zoom, rotate,
   search, thumbnails, outline, keyboard, and app wiring.
   ═══════════════════════════════════════════════════════════════ */
(function (global) {
  "use strict";

  const Volt = global.Volt = global.Volt || {};
  const $ = (id) => document.getElementById(id);
  // home screen recents: documents opened from a reopenable source (a real
  // disk path in the desktop app, or a URL) so "get back to my document" is
  // one click — capped, deduped, most-recent-first.
  const RECENTS_KEY = "volt:recent-docs";
  const RECENTS_MAX = 8;
  // first-run setup wizard: absent = never answered (the banner offers it);
  // present = answered (done:true ran it, done:false was skipped/not-now'd)
  const SETUP_KEY = "volt:setup-done";

  Volt.App = {
    /* ── state ─────────────────────────────────────────────── */
    currentDoc: null,       // pdf.js document
    currentDocBytes: null,  // original ArrayBuffer (for export)
    currentDocInfo: null,   // {name, size, pages}
    currentDocId: null,     // cache key
    zoom: 1,                // current scale
    zoomMode: "fit-width",  // fit-width | fit-page | custom
    rotDelta: 0,            // 0/90/180/270
    pageDims: [],           // [{w, h}] base dims at scale 1
    pageLayout: [],         // [{top, height}] in CSS px
    rendered: new Map(),    // pageNum -> {wrap, canvas, ctx, textLayer, overlay, viewport}
    thumbRendered: new Set(),
    _keepAllRendered: false, // a Ctrl+A+A whole-document selection pins the full render
    _wheelAnchor: null,     // {pageNum, x, y, clientX, clientY} — pending Ctrl+wheel zoom anchor
    search: null,           // {query, results, current}
    pendingRender: new Map(),
    _pendingBackup: null,   // parsed backup JSON awaiting the right document to open
    _fpPromise: null,       // resolves when the open document's content fingerprint is computed
    currentPath: null,      // absolute path of the open PDF (Electron path-opens)
    _reloading: false,      // a disk reload is in flight — swallow watch events
    _restoreState: null,    // captured per-doc state for a disk reload
    _restoreView: null,     // zoom/rotation/scroll/AI-panel to reapply after the reload
    _restoreSummaryTimer: null, // auto-dismiss timer for the post-restore summary card
    // page manager state (pages modal): the STAGED page plan (what Apply & save
    // builds), the selected plan indices, and caches so re-rendering the plan
    // after each edit doesn't re-rasterize thumbnails
    _pagePlan: null,        // [{kind:"doc",oldPage} | {kind:"blank",w,h} | {kind:"other",bytes,page,name}]
    _pagePlanDoc: null,     // the currentDoc this plan was built for (stale-plan guard)
    _pageSel: null,         // Set<plan index>
    _pageSelAnchor: null,   // plan index anchoring Shift+click range selection
    _pageSelBase: null,     // fixed end of an active Shift+arrow sequence (Explorer-style)
    _pageSelFocus: null,    // moving end of an active Shift+arrow sequence
    _pageConfirmArmed: null, // {btn, timer} — Delete in its 'Really …?' step
    _pageDrag: null,        // Set<plan index> being dragged (drag-reorder)
    _pageDropTarget: null,  // {index,pos} hovered during drag (indicator)
    _pageUndo: [],          // stack of {plan, sel} snapshots before each staged edit
    _pageRedo: [],          // stack of {plan, sel} snapshots of undone edits (re-appliable)
    _pageThumbCache: new Map(),
    // sidebar thumb drag-reorder (direct, undoable): the page being dragged,
    // the hovered drop target, and the pending 'Undo reorder' (pre-reorder
    // bytes + captured state) offered after a commit
    _thumbSel: null,        // Set<page number> — Shift+click multi-select (block drag)
    _thumbSelAnchor: null,  // page number anchoring Shift+click range selection (like the manager)
    _thumbSelBase: null,    // fixed end of an active Shift+arrow thumb sequence (anchor/focus model)
    _thumbSelFocus: null,   // moving end of an active Shift+arrow thumb sequence
    _thumbDragPage: null,   // page number being dragged from the sidebar
    _thumbDragSet: null,    // Set<page number> — the whole block being dragged (selection or just the grabbed thumb)
    _thumbDrop: null,       // {page, pos} hovered during the drag (indicator)
    _thumbDragPreview: null, // the floating "would-be order" pill shown while hovering a drop target
    _thumbReorderPending: null, // {dragPage, dragSet, targetPage, pos} awaiting the confirm toast's Apply
    _reorderUndo: null,     // {bytes, name, size, state} — 'Undo reorder' target
    _reorderUndoToastEl: null, // the live 'Undo reorder' toast (dismissed on a newer doc)
    _otherPdfId: 0,         // increments per picked file → per-file pdf.js doc cache
    _otherPdfDocs: new Map(), // fileId → pdf.js doc (a plan can mix several files)
    _otherAnns: new Map(),  // fileId → the source PDF's own annotations (read at insert time,
                            //   so "from …" pages can show their source annotation counts)
    _insertBytes: null,     // bytes of the PDF being inserted
    _insertCount: 0,        // its page count
    _insertName: "",        // its file name

    /* ── elements ──────────────────────────────────────────── */
    elements: null,

    async init() {
      if (!global.pdfjsLib) {
        // pdf.js failed to load — almost always index.html opened via file://,
        // where ES module scripts are blocked. Point the user at a launcher.
        const note = document.getElementById("file-note");
        const close = document.getElementById("file-note-close");
        if (note) {
          note.hidden = false;
          if (close) close.addEventListener("click", () => { note.hidden = true; });
        }
        return;
      }
      // pdf.js worker: relative path; falls back to fake worker automatically
      pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.mjs";

      this.elements = {
        app: $("app"), scroller: $("scroller"), pages: $("pages"),
        emptyState: $("empty-state"), recentDocs: $("recent-docs"), recentGrid: $("recent-grid"),
        fileInput: $("file-input"), importInput: $("import-input"), restoreInput: $("restore-input"),
        btnOpen: $("btn-open"), btnOpenEmpty: $("btn-open-empty"), btnOpenUrl: $("btn-open-url"),
        btnSampleEmpty: $("btn-sample-empty"), btnRestoreEmpty: $("btn-restore-empty"), btnExport: $("btn-export"),
        btnZoomOut: $("btn-zoom-out"), btnZoomIn: $("btn-zoom-in"), btnFitWidth: $("btn-fit-width"),
        btnFitPage: $("btn-fit-page"), btnRotate: $("btn-rotate"), zoomLabel: $("zoom-label"),
        fabZoomOut: $("fab-zoom-out"), fabZoomIn: $("fab-zoom-in"), fabZoomLabel: $("fab-zoom-label"), zoomFab: $("zoom-fab"),
        btnSidebar: $("btn-sidebar"), btnAi: $("btn-ai"), btnSettings: $("btn-settings"), btnHelp: $("btn-help"),
        btnMenuSettings: $("btn-menu-settings"), btnMenuHelp: $("btn-menu-help"), btnMenuSetup: $("btn-menu-setup"),
        btnCheckUpdates: $("btn-check-updates"), btnAbout: $("btn-about"), btnSavePdf: $("btn-save-pdf"), btnExit: $("btn-exit"),
        aboutModal: $("about-modal"), aboutVersion: $("about-version"), aboutEngine: $("about-engine"), aboutChangelog: $("about-changelog"), aboutClose: $("about-close"),
        sigModal: $("sig-modal"), sigSaved: $("sig-saved"), sigTabDraw: $("sig-tab-draw"), sigTabType: $("sig-tab-type"),
        sigCanvas: $("sig-canvas"), sigDrawWrap: $("sig-draw-wrap"), sigTypeWrap: $("sig-type-wrap"),
        sigTypeInput: $("sig-type-input"), sigTypePreview: $("sig-type-preview"),
        sigClear: $("sig-clear"), sigCancel: $("sig-cancel"), sigSave: $("sig-save"),
        formModal: $("form-modal"), formType: $("form-type"), formName: $("form-name"), formValue: $("form-value"),
        formValueField: $("form-value-field"), formCancel: $("form-cancel"), formPlace: $("form-place"),
        btnThemeLight: $("btn-theme-light"), btnThemeDark: $("btn-theme-dark"),
        verBanner: $("ver-banner"), verBannerText: $("ver-banner-text"), verRestart: $("ver-restart"), verCancel: $("ver-cancel"), verDownload: $("ver-download"), verDismiss: $("ver-dismiss"), verTip: $("ver-tip"),
        setUpdateStartup: $("set-update-startup"), setUpdateMetered: $("set-update-metered"),
        btnOcr: $("btn-ocr"), btnOcrLang: $("btn-ocr-lang"), ocrLangCur: $("ocr-lang-cur"),
        btnSig: $("btn-sig"), btnDate: $("btn-date"), btnForm: $("btn-form"),
        ocrLangPop: $("ocr-lang-pop"), ocrLangSearch: $("ocr-lang-search"), ocrLangList: $("ocr-lang-list"),
        btnOcrLayer: $("btn-ocr-layer"), ocrPrefer: $("ocr-prefer"),
        btnReadaloud: $("btn-readaloud"),
        searchInput: $("search-input"), searchCount: $("search-count"),
        searchPrev: $("search-prev"), searchNext: $("search-next"), searchClear: $("search-clear"),
        modeGroup: $("menu-markup-panel"), modeTip: $("mode-tip"),
        sidebar: $("sidebar"), sideTabs: document.querySelectorAll(".side-tab"),
        panelPages: $("panel-pages"), panelOutline: $("panel-outline"), panelNotes: $("panel-notes"),
        thumbGrid: $("thumb-grid"), outlineTree: $("outline-tree"), notesList: $("notes-list"),
        thumbBlockActions: $("thumb-block-actions"),
        thumbMoveFirst: $("thumb-move-first"), thumbMoveLast: $("thumb-move-last"),
        thumbMoveTo: $("thumb-move-to"), thumbMoveClear: $("thumb-move-clear"),
        thumbMoveForm: $("thumb-move-form"), thumbMovePos: $("thumb-move-pos"),
        thumbMoveHint: $("thumb-move-hint"), thumbMoveGo: $("thumb-move-go"), thumbMoveCancel: $("thumb-move-cancel"),
        notesBadge: $("notes-badge"), btnClearNotes: $("btn-clear-notes"), btnManagePages: $("btn-manage-pages"),
        btnThumbSelAnn: $("btn-thumb-select-ann"),
        pagesModal: $("pages-modal"), pagesModalSub: $("pages-modal-sub"), pagesPlanGrid: $("pages-plan-grid"),
        pagesSelInfo: $("pages-sel-info"), pagesEditNote: $("pages-edit-note"),
        btnPagesSelAnn: $("btn-pages-select-ann"), btnPagesClearHl: $("btn-pages-clear-hl"), btnPagesInvert: $("btn-pages-invert"),
        btnPagesUndo: $("btn-pages-undo"), btnPagesRedo: $("btn-pages-redo"), btnPagesBlank: $("btn-pages-blank"), btnPagesUp: $("btn-pages-up"), btnPagesDown: $("btn-pages-down"),
        btnPagesFirst: $("btn-pages-first"), btnPagesLast: $("btn-pages-last"), btnPagesMove: $("btn-pages-move"),
        btnPagesDel: $("btn-pages-del"), btnPagesInsert: $("btn-pages-insert"), btnPagesExportSel: $("btn-pages-export-sel"),
        pagesMoveForm: $("pages-move-form"), pagesMovePos: $("pages-move-pos"), pagesMoveHint: $("pages-move-hint"),
        pagesMoveGo: $("pages-move-go"), pagesMoveCancel: $("pages-move-cancel"),
        pagesInsertForm: $("pages-insert-form"), pagesInsertInfo: $("pages-insert-info"),
        pagesInsertRange: $("pages-insert-range"), pagesInsertPos: $("pages-insert-pos"),
        pagesInsertGo: $("pages-insert-go"), pagesInsertCancel: $("pages-insert-cancel"),
        pagesInsertInput: $("pages-insert-input"),
        pagesCancel: $("pages-cancel"), pagesApply: $("pages-apply"),
        aiPanel: $("ai-panel"), aiResize: $("ai-resize"), aiClose: $("ai-close"), aiMessages: $("ai-messages"),
        aiInput: $("ai-input"), aiSend: $("ai-send"), aiStop: $("ai-stop"),
        aiModelLine: $("ai-model-line"), aiModelPicker: $("ai-model-picker"), aiModelGlobal: $("ai-model-global"),
        aiTemp: $("ai-temp"), aiTempVal: $("ai-temp-val"), aiTempUp: $("ai-temp-up"), aiTempDown: $("ai-temp-down"),
        aiDocMarker: $("ai-doc-marker"), aiMarkerTip: $("ai-marker-tip"),
        aiHeader: $("ai-header"), aiPersonaRow: $("ai-persona-row"), aiPromptPreset: $("ai-prompt-preset"),
        aiPersonaGlobalRow: $("ai-persona-global-row"), aiPromptGlobal: $("ai-prompt-global"),
        aiDocSettings: $("ai-doc-settings"), aiDocPopover: $("ai-doc-popover"),
        aiDocPopBody: $("ai-doc-pop-body"), aiDocPopEdit: $("ai-doc-pop-edit"), aiDocPopReset: $("ai-doc-pop-reset"), aiDocPopClearChat: $("ai-doc-pop-clear-chat"),
        aiGlobalPop: $("ai-global-pop"), aiGlobalInput: $("ai-global-input"),
        aiGlobalSave: $("ai-global-save"), aiGlobalCancel: $("ai-global-cancel"),
        aiContextLine: $("ai-context-line"), aiFootRight: $("ai-foot-right"),
        aiBootstrap: $("ai-bootstrap"), aiBootstrapTitle: $("ai-bootstrap-title"), aiBootstrapBody: $("ai-bootstrap-body"),
        aiBootstrapPrimary: $("ai-bootstrap-primary"), aiBootstrapSettings: $("ai-bootstrap-settings"), aiBootstrapDismiss: $("ai-bootstrap-dismiss"),
        aiBootstrapProgress: $("ai-bootstrap-progress"), aiBootstrapProgressBar: $("ai-bootstrap-progress-bar"), aiBootstrapProgressLabel: $("ai-bootstrap-progress-label"),
        notePopover: $("note-popover"), noteInput: $("note-input"),
        noteSave: $("note-save"), noteDelete: $("note-delete"), noteCancel: $("note-cancel"),
        areaMenu: $("area-menu"), areaMenuDelete: $("area-menu-delete"), areaMenuDup: $("area-menu-dup"), areaMenuClose: $("area-menu-close"),
        textEditPop: $("text-edit-pop"), textEditInput: $("text-edit-input"), textEditFont: $("text-edit-font"),
        textEditBold: $("text-edit-bold"), textEditItalic: $("text-edit-italic"),
        textEditSize: $("text-edit-size"), textEditColor: $("text-edit-color"),
        textEditHint: $("text-edit-hint"), textEditCancel: $("text-edit-cancel"), textEditApply: $("text-edit-apply"),
        urlModal: $("url-modal"), urlModalTitle: $("url-modal-title"), urlInput: $("url-input"), urlGo: $("url-go"), urlCancel: $("url-cancel"),
        btnRestoreUrlEmpty: $("btn-restore-url-empty"),
        reloadBanner: $("reload-banner"), reloadNow: $("reload-now"), reloadDismiss: $("reload-dismiss"),
        exportModal: $("export-modal"), exportClose: $("export-close"), exportSelNote: $("export-sel-note"),
        exportOcrTxt: $("export-ocr-txt"), exportOcrMd: $("export-ocr-md"),
        expAnn: $("exp-ann"), expAi: $("exp-ai"), expChat: $("exp-chat"),
        restoreModal: $("restore-modal"), restoreMsg: $("restore-msg"),
        restoreOpen: $("restore-open"), restoreAnyway: $("restore-anyway"), restoreCancel: $("restore-cancel"),
        settingsModal: $("settings-modal"), setProvider: $("set-provider"), setBaseurl: $("set-baseurl"),
        setModel: $("set-model"), setApikey: $("set-apikey"), setTemperature: $("set-temperature"),
        setTemperatureVal: $("set-temperature-val"), setMaxctx: $("set-maxctx"),
        setHistory: $("set-history"), setNoAutoRestart: $("set-no-auto-restart"),
        setSysprompt: $("set-sysprompt"), setSave: $("set-save"), setCancel: $("set-cancel"), setTest: $("set-test"),
        setRectW: $("set-rect-w"), setRectH: $("set-rect-h"),
        modelQualityBlock: $("model-quality-block"), tierPresets: $("tier-presets"), tierDesc: $("tier-desc"),
        tierInstall: $("tier-install"), tierHint: $("tier-hint"),
        tierProgress: $("tier-progress"), tierProgressBar: $("tier-progress-bar"), tierProgressLabel: $("tier-progress-label"),
        aiCorsWarn: $("ai-cors-warn"), aiCorsMsg: $("ai-cors-msg"), aiCorsFix: $("ai-cors-fix"), aiCorsDismiss: $("ai-cors-dismiss"),
        tierCorsWarn: $("tier-cors-warn"), tierCorsMsg: $("tier-cors-msg"), tierCorsFix: $("tier-cors-fix"),
        privateOllamaBlock: $("private-ollama-block"), privateOllamaToggle: $("private-ollama-toggle"),
        privateOllamaStatus: $("private-ollama-status"), privateOllamaHint: $("private-ollama-hint"),
        modelSuggestions: $("model-suggestions"),
        docOverrideBlock: $("doc-override-block"), setDocOverride: $("set-doc-override"),
        setDocModel: $("set-doc-model"), setDocMaxctx: $("set-doc-maxctx"), setDocSysprompt: $("set-doc-sysprompt"),
        helpModal: $("help-modal"), helpClose: $("help-close"), kbdList: $("kbd-list"),
        setupModal: $("setup-modal"), setupBanner: $("setup-banner"),
        setupBannerGo: $("setup-banner-go"), setupBannerLater: $("setup-banner-later"),
        setupSteps: $("setup-steps"), setupSkip: $("setup-skip"),
        setupNext0: $("setup-next-0"), setupNext1: $("setup-next-1"), setupNext2: $("setup-next-2"),
        setupFinish: $("setup-finish"), setupDesktop: $("setup-desktop"),
        setupDesktopOpt: $("setup-desktop-opt"), setupDesktopNote: $("setup-desktop-note"),
        setupAiStatus: $("setup-ai-status"), setupSummary: $("setup-summary"),
        personaModal: $("persona-modal"), personaList: $("persona-list"),
        personaAdd: $("persona-add"), personaReset: $("persona-reset"),
        personaSave: $("persona-save"), personaCancel: $("persona-cancel"),
        toasts: $("toasts"),
        restoreSummary: $("restore-summary"), restoreSummaryBody: $("restore-summary-body"), restoreSummaryClose: $("restore-summary-close"),
        sbFile: $("sb-file"), sbPage: $("sb-page"), sbZoom: $("sb-zoom"), sbSel: $("sb-sel"), sbAi: $("sb-ai"), sbHint: $("sb-hint"),
      };

      this._wireToolbar();
      this._wireSearch();
      this._wireSidebar();
      this._wirePagesManager();
      this._wireModals();
      this._wireDragDrop();
      this._wireScroll();
      this._wireKeyboard();
      this._buildHelp();
      this._wireHelpNav();
      this._wireSetupWizard();
      this._maybeShowSetupBanner();

      Volt.Ann.init();
      Volt.AI.init();
      if (Volt.Voice) Volt.Voice.init(); // read-aloud + voice input (never blocks)

      // desktop bridge (Electron): files handed off by the OS — double-click
      // association, or drag onto a running app window
      if (global.voltDesktop) {
        global.voltDesktop.onOpenPath((path) => this.openPath(path));
        // background vendor self-update (Electron only): toast when the smoke-
        // gated check applied a newer pdf.js — every other outcome stays silent
        if (global.voltDesktop.onVendorUpdated) {
          global.voltDesktop.onVendorUpdated((d) => {
            const v = d && d.pdfjs ? d.pdfjs : "a newer version";
            this.toast("updated pdf.js to " + v, "ok");
          });
        }
        // the open PDF changed on disk (the author re-exported it) — offer a
        // reload that preserves annotations, AI overrides, chat, zoom, and
        // scroll position
        if (global.voltDesktop.onFileChanged) {
          global.voltDesktop.onFileChanged((d) => this._fileChanged(d));
        }
        // desktop app self-update: electron-updater finished downloading a
        // newer release in the background — surface the version banner (its
        // Restart button installs it; the countdown/Cancel/never-auto-restart
        // settings all apply). The SW-based check is dormant while one is
        // pending so it can't hide this banner.
        if (global.voltDesktop.onUpdateDownloaded) {
          global.voltDesktop.onUpdateDownloaded((d) => this._onDesktopUpdateDownloaded(d));
        }
        // an update is AVAILABLE but background downloads are suppressed
        // (metered connection + the 'off' preference) — offer the download
        // instead of silently skipping it
        if (global.voltDesktop.onUpdateAvailable) {
          global.voltDesktop.onUpdateAvailable((d) => {
            const v = d && d.version;
            if (v) this._showUpdateAvailable(String(v));
          });
        }
        // packaged builds get their updates from electron-updater, so the
        // SW-based version check is suppressed there (see _checkNewVersion).
        // Ask once at init — a few ms, well before the first check at 4s.
        if (global.voltDesktop.appInfo) {
          global.voltDesktop.appInfo().then((i) => {
            this._packaged = !!(i && i.isPackaged);
          }).catch(() => {});
        }
        // push update preferences (check-on-startup, metered-download) to main
        // and re-push whenever the browser's connectivity read changes — the
        // app then flips its background-download policy live (moving off a
        // metered network re-enables silent updates without a restart)
        this._pushUpdatePrefs();
        try {
          const conn = navigator.connection;
          if (conn && typeof conn.addEventListener === "function") {
            conn.addEventListener("change", () => this._pushUpdatePrefs());
          }
        } catch (e) { /* never break init */ }
        global.voltDesktop.ready(); // unblock any file queued at launch
      }

      this._updateStatus();
      this.elements.zoomLabel.title = "Click to reset to Fit Width";
      this.elements.zoomLabel.addEventListener("click", () => this.fitWidth());

      // sample document
      if (global.SAMPLE_PDF_B64) {
        this.elements.btnSampleEmpty.addEventListener("click", () => this.openSample());
        if (new URLSearchParams(location.search).has("sample")) this.openSample();
      } else {
        this.elements.btnSampleEmpty.hidden = true;
      }
    },

    /* ── toolbar ───────────────────────────────────────────── */
    _wireToolbar() {
      const el = this.elements;
      // Open a PDF — the desktop app uses the native open dialog (which
      // returns a real path, so the open lands in Recent documents); the
      // browser falls back to the hidden <input type=file>.
      el.btnOpen.addEventListener("click", () => this._pickPdf());
      el.btnOpenEmpty.addEventListener("click", () => this._pickPdf());
      el.fileInput.addEventListener("change", () => {
        const f = el.fileInput.files[0];
        if (f) this.openFile(f);
        el.fileInput.value = "";
      });
      el.importInput.addEventListener("change", () => {
        const f = el.importInput.files[0];
        if (f) this._importAnnotations(f);
        el.importInput.value = "";
      });
      // "Restore backup…" — pick a .json; Volt matches it to the right PDF by
      // its `file` field and guides the user to open that document first
      el.restoreInput.addEventListener("change", () => {
        const f = el.restoreInput.files[0];
        if (f) this._restoreBackup(f);
        el.restoreInput.value = "";
      });
      el.btnRestoreEmpty.addEventListener("click", () => el.restoreInput.click());
      el.btnRestoreUrlEmpty.addEventListener("click", () => this._openUrlModal("backup"));
      el.restoreOpen.addEventListener("click", () => el.fileInput.click()); // open the matching PDF
      el.restoreAnyway.addEventListener("click", () => this._applyPendingBackup());
      el.restoreCancel.addEventListener("click", () => this._closeModal(el.restoreModal));
      el.btnOpenUrl.addEventListener("click", () => this._openUrlModal("pdf"));
      el.urlGo.addEventListener("click", () => this._submitUrl());
      el.urlInput.addEventListener("keydown", (e) => { if (e.key === "Enter") this._submitUrl(); });
      el.urlCancel.addEventListener("click", () => this._closeModal(el.urlModal));

      this._renderRecents(); // home screen: recently opened documents

      el.btnZoomOut.addEventListener("click", () => this.setZoom(this.zoom / 1.2));
      el.btnZoomIn.addEventListener("click", () => this.setZoom(this.zoom * 1.2));
      el.fabZoomOut.addEventListener("click", () => this.setZoom(this.zoom / 1.2));
      el.fabZoomIn.addEventListener("click", () => this.setZoom(this.zoom * 1.2));
      el.btnFitWidth.addEventListener("click", () => this.fitWidth());
      el.btnFitPage.addEventListener("click", () => this.fitPage());
      el.btnRotate.addEventListener("click", () => this.rotate());

      el.btnSidebar.addEventListener("click", () => this.toggleSidebar());
      el.btnAi.addEventListener("click", () => this.toggleAI());
      el.aiClose.addEventListener("click", () => this.toggleAI(false));
      el.btnSettings.addEventListener("click", () => Volt.AI.openSettings());
      // the toolbar ? button is a shortcut to the shortcuts page; the Volt
      // menu's Help & guides… opens the guide itself
      el.btnHelp.addEventListener("click", () => this._openHelp("shortcuts"));
      // the Volt-logo menu duplicates the settings / shortcuts actions and
      // adds app-level ones (updates, about, save, exit)
      if (el.btnMenuSettings) el.btnMenuSettings.addEventListener("click", () => Volt.AI.openSettings());
      if (el.btnMenuSetup) el.btnMenuSetup.addEventListener("click", () => this.openSetup());
      if (el.btnMenuHelp) el.btnMenuHelp.addEventListener("click", () => this._openHelp("getting-started"));
      if (el.btnAbout) el.btnAbout.addEventListener("click", () => this._openAbout());
      if (el.btnCheckUpdates) el.btnCheckUpdates.addEventListener("click", () => this._checkForUpdates());
      if (el.btnSavePdf) el.btnSavePdf.addEventListener("click", () => this._savePdf());
      if (el.btnExit) el.btnExit.addEventListener("click", () => this._quitApp());
      if (el.aboutClose) el.aboutClose.addEventListener("click", () => this._closeModal(el.aboutModal));
      // Exit only makes sense in the desktop app (a browser tab has nothing
      // to quit); the item ships hidden and is revealed by the bridge
      if (el.btnExit) el.btnExit.hidden = !global.voltDesktop;
      // skin: View ▸ Light skin / Dark skin — chrome AND document theme
      if (el.btnThemeLight) el.btnThemeLight.addEventListener("click", () => this._setTheme("light"));
      if (el.btnThemeDark) el.btnThemeDark.addEventListener("click", () => this._setTheme("dark"));
      this._applyTheme(this._theme());

      // ── AI panel width — user-stretchable ─────────────────────────────
      // Drag the handle on the panel's left edge to resize (persisted per
      // user); double-click / Home resets to the default. The width drives
      // the --ai-w variable that the panel's width/flex-basis AND the
      // hidden-slide margin both read, so one value keeps every layout in
      // sync. Also arrow-key adjustable once the handle has focus.
      const AI_W_KEY = "volt:ai:panel-w";
      const AI_W_MIN = 260, AI_W_MAX = 760;
      const applyAiW = (w) => {
        document.documentElement.style.setProperty("--ai-w", Math.round(w) + "px");
      };
      const setAiW = (w) => {
        const c = Math.min(AI_W_MAX, Math.max(AI_W_MIN, w));
        applyAiW(c);
        try { localStorage.setItem(AI_W_KEY, String(c)); } catch { /* private mode */ }
        this._reflowAfterPaneResize();
      };
      const resetAiW = () => {
        document.documentElement.style.removeProperty("--ai-w");
        try { localStorage.removeItem(AI_W_KEY); } catch { /* private mode */ }
        this._reflowAfterPaneResize();
      };
      try {
        const saved = parseFloat(localStorage.getItem(AI_W_KEY));
        if (saved && saved >= AI_W_MIN && saved <= AI_W_MAX) applyAiW(saved);
      } catch { /* private mode */ }
      if (el.aiResize) {
        let aiDrag = null;
        el.aiResize.addEventListener("mousedown", (e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          aiDrag = { startX: e.clientX, startW: el.aiPanel.getBoundingClientRect().width };
          el.aiResize.classList.add("active");
          document.body.classList.add("resizing-ai");
        });
        window.addEventListener("mousemove", (e) => {
          if (!aiDrag) return;
          // left-edge drag: moving right shrinks, moving left grows
          setAiW(aiDrag.startW - (e.clientX - aiDrag.startX));
        });
        window.addEventListener("mouseup", () => {
          if (!aiDrag) return;
          aiDrag = null;
          el.aiResize.classList.remove("active");
          document.body.classList.remove("resizing-ai");
        });
        el.aiResize.addEventListener("dblclick", (e) => { e.preventDefault(); resetAiW(); });
        el.aiResize.addEventListener("keydown", (e) => {
          if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
            e.preventDefault();
            const cur = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--ai-w")) || 340;
            // the handle sits on the panel's LEFT edge, so the arrows mirror
            // the drag: Left grows the pane, Right shrinks it
            setAiW(cur + (e.key === "ArrowLeft" ? 20 : -20));
          } else if (e.key === "Home") {
            e.preventDefault();
            resetAiW();
          }
        });
      }

      // ── Sidebar width — same contract as the AI panel ─────────────────
      // Handle on the sidebar's RIGHT edge, so the arrows read naturally
      // (Right grows, Left shrinks) — the mirror of the AI panel's mapping.
      // Persisted per user; double-click / Home resets. --sidebar-w drives
      // both the width and the collapse slide, so one value stays in sync.
      const SB_W_KEY = "volt:sidebar:w";
      const SB_W_MIN = 150, SB_W_MAX = 520;
      const applySbW = (w) => {
        document.documentElement.style.setProperty("--sidebar-w", Math.round(w) + "px");
      };
      const setSbW = (w) => {
        const c = Math.min(SB_W_MAX, Math.max(SB_W_MIN, w));
        applySbW(c);
        try { localStorage.setItem(SB_W_KEY, String(c)); } catch { /* private mode */ }
        this._reflowAfterPaneResize();
      };
      const resetSbW = () => {
        document.documentElement.style.removeProperty("--sidebar-w");
        try { localStorage.removeItem(SB_W_KEY); } catch { /* private mode */ }
        this._reflowAfterPaneResize();
      };
      try {
        const saved = parseFloat(localStorage.getItem(SB_W_KEY));
        if (saved && saved >= SB_W_MIN && saved <= SB_W_MAX) applySbW(saved);
      } catch { /* private mode */ }
      const sbResize = document.getElementById("sidebar-resize");
      if (sbResize) {
        let sbDrag = null;
        sbResize.addEventListener("mousedown", (e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          sbDrag = { startX: e.clientX, startW: el.sidebar ? el.sidebar.getBoundingClientRect().width : 224 };
          sbResize.classList.add("active");
          document.body.classList.add("resizing-sidebar");
        });
        window.addEventListener("mousemove", (e) => {
          if (!sbDrag) return;
          // right-edge drag: moving right grows, moving left shrinks
          setSbW(sbDrag.startW + (e.clientX - sbDrag.startX));
        });
        window.addEventListener("mouseup", () => {
          if (!sbDrag) return;
          sbDrag = null;
          sbResize.classList.remove("active");
          document.body.classList.remove("resizing-sidebar");
        });
        sbResize.addEventListener("dblclick", (e) => { e.preventDefault(); resetSbW(); });
        sbResize.addEventListener("keydown", (e) => {
          if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
            e.preventDefault();
            const cur = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--sidebar-w")) || 224;
            setSbW(cur + (e.key === "ArrowRight" ? 20 : -20));
          } else if (e.key === "Home") {
            e.preventDefault();
            resetSbW();
          }
        });
      }
      // markup insertions (Markup ▸ Signature… / Date stamp / Form field…)
      if (el.btnSig) el.btnSig.addEventListener("click", () => Volt.Ann.openSignature());
      if (el.btnDate) el.btnDate.addEventListener("click", () => Volt.Ann.armDate());
      if (el.btnForm) el.btnForm.addEventListener("click", () => Volt.Ann.openFormEditor());
      el.btnOcr.addEventListener("click", () => { if (this.currentDoc) Volt.OCR.runDoc(); });
      this._wireOcrLangPopover();
      el.btnOcrLayer.addEventListener("click", () => {
        if (Volt.OCR && Volt.OCR.toggleLayer) Volt.OCR.toggleLayer();
      });

      el.reloadNow.addEventListener("click", () => this._reloadFromDisk());
      el.reloadDismiss.addEventListener("click", () => { el.reloadBanner.hidden = true; });
      el.restoreSummaryClose.addEventListener("click", () => this._hideRestoreSummary());

      el.btnExport.addEventListener("click", () => {
        if (!this.currentDoc) return;
        // each open resets the backup layers to the full set — a marks-only
        // choice from last week must not silently shrink this week's backup
        el.expAi.checked = true;
        el.expChat.checked = true;
        // OCR transcript export only makes sense when this document has
        // recognized text (a fresh scan shows the items only after OCR runs)
        const hasOcr = !!(Volt.OCR && Volt.OCR.available && Volt.OCR.hasText && Volt.OCR.hasText());
        el.exportOcrTxt.hidden = !hasOcr;
        el.exportOcrMd.hidden = !hasOcr;
        // the office exports cover the Pages manager's live selection when
        // one exists (a selection made in the manager survives an Escape-close
        // so it can drive an export); the note makes that visible before the
        // user clicks an export item
        const selPages = this._pagesSelectedForExport();
        if (selPages) {
          el.exportSelNote.textContent = "Office exports will cover " + this._officeExportScope(selPages) +
            (selPages.skipped ? " — inserted pages can't be exported until applied" : "") +
            ". Select differently in the Pages manager to change this.";
          el.exportSelNote.hidden = false;
        } else {
          el.exportSelNote.hidden = true;
        }
        this._openModal(el.exportModal);
      });
      el.exportClose.addEventListener("click", () => this._closeModal(el.exportModal));
      el.exportModal.querySelectorAll(".export-item").forEach((item) => {
        item.addEventListener("click", () => this._doExport(item.dataset.export));
      });

      this._wireMenus();

      // ── version-ready banner (stale-bundle guard) ─────────────
      // a running window can be STALE while the files on disk have moved on:
      // the desktop app holds a single-instance lock (re-clicking the
      // shortcut only focuses the old process — the recurring "I restarted
      // but still see the old behavior"), and a PWA can serve a cached
      // bundle. Detect it by comparing the SERVED sw.js cache name with the
      // caches installed under this origin; when they disagree, a real
      // restart is offered (desktop: relaunch; browser: reload applies the
      // staged worker). Checks at startup (once the SW has registered),
      // whenever the window regains focus (the single-instance focus path),
      // and on a slow interval for long-lived windows.
      if (el.verRestart) {
        el.verRestart.addEventListener("click", () => {
          this._stopVerCountdown(); // an explicit click always wins over the countdown
          this._restartApp();
        });
      }
      if (el.verCancel) {
        el.verCancel.addEventListener("click", () => {
          this._verManual[this._verServed] = true; // this version stays manual — no auto-restart nag
          this._stopVerCountdown();
        });
      }
      // the 'available' banner's Download button (shown when background
      // downloads are suppressed — metered connection + pref off). Kicks off
      // the explicit download; update-downloaded then takes over the banner.
      if (el.verDownload) {
        el.verDownload.addEventListener("click", () => this._downloadUpdate());
      }
      if (el.verDismiss) {
        el.verDismiss.addEventListener("click", () => {
          const served = this._verServed;
          if (served) { try { localStorage.setItem("volt:ver:dismiss:" + served, "1"); } catch (e) { /* ignore */ } }
          this._hideVersionBanner();
        });
      }
      // what's-new tooltip: hover the banner to see the changelog of the
      // pending version(s). Only ever shown when a newer version is actually
      // detected (the content is empty otherwise), so a fresh bundle never
      // pops anything.
      if (el.verBanner) {
        el.verBanner.addEventListener("mouseenter", () => this._showVerTip());
        el.verBanner.addEventListener("mouseleave", () => this._hideVerTip());
      }
      window.addEventListener("focus", () => this._checkNewVersion());
      setInterval(() => this._checkNewVersion(), 60000);
      setTimeout(() => this._checkNewVersion(), 4000); // after the SW registers
    },

    /* ── version-ready detection ──────────────────────────────
       The served sw.js carries `const CACHE = "volt-<hash>"` — the content
       hash of the CURRENT files (gen-sw.mjs bumps it whenever app files
       change). The installed caches under this origin are the bundle the
       RUNNING page was served from. When the served name isn't among them,
       a newer version is staged and this window is stale. First run / no SW
       yet → nothing installed → silent skip. Never throws. */
    async _checkNewVersion() {
      try {
        // packaged desktop builds get their updates from electron-updater, and
        // a downloaded update is already surfacing the banner — the SW-based
        // check would either never fire (the asar bundle can't change under
        // the running app) or, right after an update installs, show a stale
        // "new version" banner that makes the user restart a second time.
        if (this._verDesktopPending || this._packaged) return;
        if (!("serviceWorker" in navigator) || !("caches" in window)) return;
        const sw = await fetch("sw.js?_t=" + Date.now())
          .then((r) => (r.ok ? r.text() : "")).catch(() => "");
        const m = /const\s+CACHE\s*=\s*"([^"]+)"/.exec(sw);
        if (!m) return;
        const served = m[1];
        if (!served.startsWith("volt-")) return;
        const vm = /const\s+VERSION\s*=\s*"([^"]+)"/.exec(sw);
        const servedVersion = vm && /^\d+\.\d+\.\d+$/.test(vm[1]) ? vm[1] : null;
        const keys = await caches.keys().catch(() => []);
        const voltCaches = keys.filter((k) => k.startsWith("volt-"));
        if (!voltCaches.length) return; // SW not installed yet — first run
        if (voltCaches.includes(served)) { this._hideVersionBanner(); return; } // fresh
        this._showVersionBanner(served, servedVersion);
      } catch (e) { /* the guard must never break the app */ }
    },

    _showVersionBanner(served, version) {
      this._verServed = served;
      this._verServedVersion = version || served;
      this._verManual = this._verManual || {};
      try {
        if (localStorage.getItem("volt:ver:dismiss:" + served)) return; // dismissed for this version
      } catch (e) { /* ignore */ }
      const el = this.elements;
      if (!el.verBanner) return;
      if (el.verBanner.hidden === false && this._verTimer) return; // already counting down — don't reset it
      el.verBanner.hidden = false;
      // if the 'available' mode was showing (Download instead of Restart),
      // switch back to the restart mode — the download just completed
      if (el.verDownload) el.verDownload.hidden = true;
      if (el.verRestart) el.verRestart.hidden = false;
      // kick off the what's-new tooltip in the background — never blocks the
      // banner or the app; an empty result keeps the tooltip hidden.
      this._loadVerChangelog();
      // no auto-restart when the user cancelled this version, chose 'never
      // auto-restart' in settings, or has a modal open (a restart would lose
      // unsaved work such as a staged pages plan) — the banner just asks.
      if (this._verManual[served] || this._noAutoRestart() || this._openModalEl()) {
        this._stopVerCountdown();
        return;
      }
      this._startVerCountdown();
    },

    _hideVersionBanner() {
      this._stopVerCountdown();
      this._hideVerTip();
      const el = this.elements;
      if (el.verBanner) el.verBanner.hidden = true;
    },

    /* ── what's-new tooltip (pending-update changelog) ─────────
       The banner diffs the SERVED version (from sw.js) against the version
       this page was built as (window.__VOLT_VERSION, stamped by gen-sw.mjs)
       and renders the CHANGELOG.md sections in between. A hover shows them;
       a fresh bundle has no pending sections, so the tooltip stays empty and
       hidden. Never throws — the tooltip must never break the app. */
    async _loadVerChangelog() {
      const myToken = (this._verChangelogToken = (this._verChangelogToken || 0) + 1);
      try {
        const md = await fetch("CHANGELOG.md?_t=" + Date.now())
          .then((r) => (r.ok ? r.text() : "")).catch(() => "");
        // only the LATEST request may paint — an earlier fetch (e.g. from a
        // banner shown then replaced) resolving later must not clobber it
        if (myToken !== this._verChangelogToken) return;
        this._verChangelogHtml = this._changelogHtml(md, this._verServedVersion);
      } catch (e) {
        if (myToken !== this._verChangelogToken) return;
        this._verChangelogHtml = "";
      }
      const el = this.elements;
      if (el.verTip) el.verTip.innerHTML = this._verChangelogHtml || "";
    },

    /** Markdown → the tooltip's innerHTML: the CHANGELOG sections whose version
        is newer than the running bundle and not newer than the served one.
        Pure logic lives in Utils.changelogHtml (unit-tested); this reads the
        running version and delegates. */
    _changelogHtml(md, servedVersion) {
      return Utils.changelogHtml(md, window.__VOLT_VERSION, servedVersion);
    },

    _showVerTip() {
      const el = this.elements;
      if (!el.verTip || !this._verChangelogHtml) return; // nothing new → stay hidden
      el.verTip.hidden = false;
    },

    _hideVerTip() {
      const el = this.elements;
      if (el.verTip) el.verTip.hidden = true;
    },

    /** Seconds the banner counts down before restarting Volt on its own. */
    _AUTO_RESTART_SECONDS: 15,

    /** The 'never auto-restart' setting lives in the shared volt:ai:settings
        object (toggled in the settings modal). Never throws. */
    _noAutoRestart() {
      try {
        const s = JSON.parse(localStorage.getItem("volt:ai:settings") || "{}");
        return !!s.noAutoRestart;
      } catch (e) { return false; }
    },

    _startVerCountdown() {
      this._stopVerCountdown(); // never two timers
      this._verCountdown = this._AUTO_RESTART_SECONDS;
      this._renderVerCountdown();
      this._verTimer = setInterval(() => {
        this._verCountdown--;
        if (this._verCountdown <= 0) {
          this._stopVerCountdown();
          if (this._openModalEl()) {
            // a modal opened during the countdown — restarting now would lose
            // unsaved work (e.g. a staged pages plan). Fall back to manual for
            // this version; the user restarts when they're ready.
            this._verManual[this._verServed] = true;
            return;
          }
          this._restartApp(); // fires exactly once
          return;
        }
        this._renderVerCountdown();
      }, 1000);
    },

    _renderVerCountdown() {
      const el = this.elements;
      const n = this._verCountdown;
      if (el.verBannerText) el.verBannerText.textContent = "Volt updated — restarting in " + n + "s…";
      if (el.verRestart) el.verRestart.textContent = "Restart now (" + n + "s)";
      if (el.verCancel) el.verCancel.hidden = false;
    },

    _stopVerCountdown() {
      if (this._verTimer) { clearInterval(this._verTimer); this._verTimer = null; }
      const el = this.elements;
      // the canonical 'downloaded' mode: Restart visible, Download/Cancel gone
      if (el.verBannerText) el.verBannerText.textContent = "Volt updated — restart to apply the new version";
      if (el.verRestart) { el.verRestart.hidden = false; el.verRestart.textContent = "Restart now"; }
      if (el.verCancel) el.verCancel.hidden = true;
      if (el.verDownload) el.verDownload.hidden = true;
    },

    /** The banner's Restart button: desktop relaunches the whole process
        (the only way a stale single-instance process reaches the current
        bundle); the browser/PWA reloads, which applies the staged worker. */
    _restartApp() {
      if (global.voltDesktop && typeof global.voltDesktop.restart === "function") {
        global.voltDesktop.restart().catch(() => location.reload());
      } else {
        location.reload();
      }
    },

    /* ── skin (View ▸ Light / Dark) ───────────────────────────
       The theme is applied via body[data-theme] (CSS overrides the palette
       and, in dark mode, inverts the rendered pages) and persisted per user
       in localStorage. The View menu items show a ✓ on the active skin. */
    _theme() {
      try {
        const t = localStorage.getItem("volt:theme");
        return t === "light" ? "light" : "dark";
      } catch (e) { return "dark"; }
    },

    _applyTheme(t) {
      document.body.dataset.theme = t;
      const el = this.elements;
      if (el.btnThemeLight) el.btnThemeLight.classList.toggle("checked", t === "light");
      if (el.btnThemeDark) el.btnThemeDark.classList.toggle("checked", t !== "light");
    },

    _setTheme(t) {
      try { localStorage.setItem("volt:theme", t === "light" ? "light" : "dark"); } catch (e) { /* ignore */ }
      this._applyTheme(t === "light" ? "light" : "dark");
      this.toast(t === "light" ? "Light skin — document restored to normal" : "Dark skin — document shown in night mode", "ok");
    },

    /* ── About (Volt ▾ → About Volt…) ──────────────────────── */
    _openAbout() {
      const el = this.elements;
      if (!el.aboutModal) return;
      el.aboutVersion.textContent = window.__VOLT_VERSION || "dev";
      const cache = (this._verServed && this._verServed.startsWith("volt-")) ? this._verServed : null;
      el.aboutEngine.textContent = (global.voltDesktop ? "Electron desktop" : "Browser / PWA") + (cache ? " · " + cache : "");
      // the installed release's changelog section (what THIS version changed) —
      // the same pure rendering path as the banner tooltip (Utils, unit-tested),
      // so parsing/escaping can't drift between the two views
      try {
        const box = el.aboutChangelog;
        fetch("CHANGELOG.md?_t=" + Date.now()).then((r) => (r.ok ? r.text() : "")).catch(() => "")
          .then((md) => {
            if (!box) return;
            const html = Utils.aboutChangelogHtml(md, window.__VOLT_VERSION);
            box.hidden = !html;
            if (html) box.innerHTML = html;
          });
      } catch (e) { /* the About modal must never break */ }
      this._openModal(el.aboutModal);
    },

    /* ── desktop auto-update banner (electron-updater) ────────
       main told us a newer release finished downloading. Show the same
       version banner the SW path uses — Restart installs it (volt:restart
       routes to quitAndInstall), the 15s auto-restart countdown, Cancel
       and 'never auto-restart' all apply, and the what's-new tooltip diffs
       the changelog. While one is pending the SW check is dormant so it
       can't hide the banner mid-update. Never throws. */
    _onDesktopUpdateDownloaded(d) {
      const version = (d && /^\d+\.\d+\.\d+$/.test(String(d.version))) ? String(d.version) : null;
      if (!version) return;
      this._verDesktopPending = true;
      this._showVersionBanner("volt-update-" + version, version);
    },

    /* ── update available (downloads suppressed) ──────────────
       electron-updater found a newer release but background downloads are
       off (metered connection + the preference). Show the banner in a
       'Download' mode: no countdown, a Download button, and the same
       what's-new tooltip + per-version dismiss as the downloaded banner.
       When the download finishes, update-downloaded replaces it with the
       normal restart banner. Never throws. */
    _showUpdateAvailable(version) {
      this._verServed = "volt-update-" + version;
      this._verServedVersion = version;
      try {
        if (localStorage.getItem("volt:ver:dismiss:" + this._verServed)) return;
      } catch (e) { /* ignore */ }
      const el = this.elements;
      if (!el.verBanner) return;
      this._stopVerCountdown(); // resets text/buttons — overridden just below
      el.verBanner.hidden = false;
      if (el.verBannerText) el.verBannerText.textContent = "Update v" + version + " is available";
      if (el.verRestart) el.verRestart.hidden = true;
      if (el.verCancel) el.verCancel.hidden = true;
      if (el.verDownload) {
        el.verDownload.hidden = false;
        el.verDownload.disabled = false;
        el.verDownload.textContent = "Download";
      }
      this._loadVerChangelog(); // what's-new tooltip, like the downloaded banner
    },

    /** The 'available' banner's Download button: ask main to fetch the
        update explicitly. On success the update-downloaded event swaps the
        banner to the restart mode; on failure the button re-arms and the
        failure is toasted. */
    async _downloadUpdate() {
      const el = this.elements;
      if (el.verDownload) { el.verDownload.disabled = true; el.verDownload.textContent = "Downloading…"; }
      try {
        if (global.voltDesktop && typeof global.voltDesktop.downloadUpdate === "function") {
          const r = await global.voltDesktop.downloadUpdate();
          if (!r || !r.ok) {
            if (el.verDownload) { el.verDownload.disabled = false; el.verDownload.textContent = "Download"; }
            this.toast("Update download failed" + (r && r.error ? ": " + r.error : ""), "error");
            return;
          }
        }
      } catch (e) {
        if (el.verDownload) { el.verDownload.disabled = false; el.verDownload.textContent = "Download"; }
        this.toast("Update download failed", "error");
      }
    },

    /* ── update preferences (desktop) ────────────────────────
       Push check-on-startup + the metered-download decision to main, which
       owns the actual updater. The metered read comes from the browser's
       NetworkInformation API — the only place it's visible — so the renderer
       decides and main just applies autoUpdater.autoDownload. Re-pushed on
       settings save and on connection change. Never throws. */
    _pushUpdatePrefs() {
      if (!global.voltDesktop || typeof global.voltDesktop.updatePrefs !== "function") return;
      const ai = Volt.AI && Volt.AI.settings;
      const checkOnStartup = !ai || ai.updateCheckStartup !== false;
      const downloadOnMetered = !!(ai && ai.updateDownloadMetered);
      const allowDownload = !this._isMeteredConnection() || downloadOnMetered;
      this._allowDownload = allowDownload;
      global.voltDesktop.updatePrefs({ checkOnStartup, allowDownload }).catch(() => {});
    },

    /** True when the current connection looks metered or slow: the OS-level
        'data saver' flag, a slow effective type, or a very low downlink —
        approximations, since Chromium can't read Windows' per-adapter
        metered flag. Unknown → false (assume unmetered). */
    _isMeteredConnection() {
      try {
        const c = navigator.connection;
        if (!c) return false;
        if (c.saveData === true) return true;
        const t = String(c.effectiveType || "").toLowerCase();
        if (["slow-2g", "2g", "3g"].includes(t)) return true;
        if (typeof c.downlink === "number" && c.downlink > 0 && c.downlink < 0.5) return true;
        return false;
      } catch (e) { return false; }
    },

    /* ── Check for updates (Volt ▾) ───────────────────────────
       Desktop: electron-updater is authoritative (a release bumps the
       package version, invisible to the SW comparison) — ask it and toast
       the outcome; when it's disabled (dev/unpackaged) fall through to the
       SW check below. Browser/PWA: the served-vs-installed sw.js comparison;
       a pending update surfaces the banner, a fresh bundle says so. */
    async _checkForUpdates() {
      if (global.voltDesktop && typeof global.voltDesktop.checkForUpdates === "function") {
        try {
          const r = await global.voltDesktop.checkForUpdates();
          if (r && r.status !== "disabled") {
            if (r.status === "available" || r.status === "downloading") {
              if (this._allowDownload === false) {
                // background downloads suppressed — offer the download instead
                this._showUpdateAvailable(r.version);
              } else {
                this.toast("Update " + (r.version || "") + " is downloading — you'll be asked to restart", "ok");
              }
            } else if (r.status === "update-downloaded") {
              this.toast("Update " + (r.version || "") + " is ready — restart to install it", "ok");
            } else if (r.status === "not-available") {
              this.toast("Volt is up to date" + (window.__VOLT_VERSION ? " (v" + window.__VOLT_VERSION + ")" : ""), "ok");
            } else if (r.status === "error") {
              this.toast("Update check failed" + (r.error ? ": " + r.error : ""), "error");
            }
            return;
          }
          // disabled (dev) — fall through to the SW comparison
        } catch (e) {
          this.toast("Update check failed", "error");
          return;
        }
      }
      const before = this._verServed || null;
      await this._checkNewVersion();
      const after = this._verServed || null;
      if (before && after && before !== after) {
        this.toast("New version available — restart to apply it", "ok");
        return;
      }
      if (this.elements.verBanner && this.elements.verBanner.hidden === false) {
        this.toast("New version available — restart to apply it", "ok");
        return;
      }
      this.toast("Volt is up to date" + (window.__VOLT_VERSION ? " (v" + window.__VOLT_VERSION + ")" : ""), "ok");
    },

    /* ── Save PDF (Volt ▾ → Save PDF…) ───────────────────────
       Writes the annotated PDF back over the open file on disk (desktop,
       when the doc came from a path); otherwise it downloads a copy. */
    async _savePdf() {
      if (!this.currentDoc) { this.toast("Open a document first", "error"); return; }
      const base = Utils.stripPdfExt(this.currentDocInfo?.name || "document");
      try {
        const bytes = await Volt.Ann.toAnnotatedPdf();
        if (this.currentPath && global.voltDesktop && typeof global.voltDesktop.writeFile === "function") {
          if (typeof global.voltDesktop.unwatchFile === "function") {
            await global.voltDesktop.unwatchFile().catch(() => {});
          }
          await global.voltDesktop.writeFile(this.currentPath, bytes);
          if (typeof global.voltDesktop.watchFile === "function") {
            global.voltDesktop.watchFile(this.currentPath).catch(() => {});
          }
          this.toast("Saved to " + base + ".pdf", "ok");
        } else {
          Utils.download(new Blob([bytes], { type: "application/pdf" }), base + "-annotated.pdf");
          this.toast("Annotated PDF saved", "ok");
        }
      } catch (e) {
        this.toast("Couldn't save: " + ((e && e.message) || e), "error", true);
      }
    },

    /* ── Exit (Volt ▾, desktop only) ───────────────────────── */
    _quitApp() {
      if (global.voltDesktop && typeof global.voltDesktop.quit === "function") {
        global.voltDesktop.quit();
      } else {
        this.toast("This is a browser tab — close it to exit", "error");
      }
    },

    /* ── dropdown menus (File / View / Tools) ────────────────
       One trigger toggles its panel; opening one closes the others; a click
       outside any menu (or Esc, or activating a menu item) closes them all.
       The panels use the [hidden] attribute, so the global display contract
       and the hiddenProbe smoke guard apply unchanged. */
    _wireMenus() {
      const menus = [...document.querySelectorAll(".tb-menu")];
      // one place owns the open/close visual state: the .open class AND the
      // trigger's aria-expanded always flip together, on every code path
      // (click, Alt+letter, arrow switching, Escape, outside click, item
      // activation, modal opening) — a screen reader must never hear a menu
      // is open when its panel is hidden or vice versa.
      const setOpen = (m, on) => {
        const panel = m.querySelector(".tb-menu-panel");
        const trig = m.querySelector(".tb-menu-trigger");
        if (panel) panel.hidden = !on;
        if (trig) {
          trig.classList.toggle("open", on);
          trig.setAttribute("aria-expanded", on ? "true" : "false");
        }
      };
      const closeAll = () => {
        for (const m of menus) setOpen(m, false);
        // the OCR-language popover hangs off the Tools menu — it must never
        // survive a menu close (outside click, item activation, modal open)
        if (this.elements.ocrLangPop) this.elements.ocrLangPop.hidden = true;
        if (this.elements.btnOcrLang) this.elements.btnOcrLang.setAttribute("aria-expanded", "false");
      };
      this._closeMenus = closeAll; // _openModal calls it so a menu never floats over a modal backdrop
      // the open panel's keyboard-navigable items, in display order (hidden
      // items excluded — the OCR/read-aloud items only exist with a document
      // open, and getComputedStyle covers any CSS-hidden rows)
      this._menuItems = (panel) =>
        [...panel.querySelectorAll(".tb-menu-item")]
          .filter((el) => !el.hidden && getComputedStyle(el).display !== "none");
      const openMenu = () => menus.find((m) => !m.querySelector(".tb-menu-panel").hidden) || null;
      document.addEventListener("click", (e) => {
        // clicks inside the OCR-language popover belong to the popover (its
        // search input, its rows) — never let them close the Tools menu
        if (e.target.closest && e.target.closest("#ocr-lang-pop")) return;
        const trig = e.target.closest ? e.target.closest(".tb-menu-trigger") : null;
        if (trig) {
          const menu = trig.closest(".tb-menu");
          const panel = menu.querySelector(".tb-menu-panel");
          const wasOpen = !panel.hidden;
          closeAll();
          if (!wasOpen) setOpen(menu, true);
          return; // never let the outside-click path re-close it
        }
        if (e.target.closest && e.target.closest(".tb-menu-panel")) {
          // inside a panel: let the select work (its clicks don't hit a
          // .tb-menu-item button); close only when a real item was activated
          if (e.target.closest(".tb-menu-item")) {
            const menu = e.target.closest(".tb-menu");
            const trig = menu.querySelector(".tb-menu-trigger");
            closeAll();
            // keyboard polish: the activated item just went hidden, so Chromium
            // evicts focus to <body> (asynchronously) — hand it back to the
            // trigger UNLESS the action moved it elsewhere itself (e.g. Export/
            // Open opened a modal or file picker, which grab focus in the
            // item's own handler). "Elsewhere" = focus that survived outside
            // the hidden panel (body after eviction, a modal field, a future
            // item that focuses its own control…).
            if (!this._openModalEl()) {
              const a = document.activeElement;
              const gone = !a || a === document.body || a === document.documentElement ||
                !!(a.closest && a.closest(".tb-menu-panel"));
              if (gone) trig.focus();
            }
          }
          return;
        }
        closeAll();
      });
      document.addEventListener("keydown", (e) => {
        // Alt+F / Alt+V / Alt+T toggle their menu (and jump to it when
        // another is open). A modal owns the keyboard while it is up, so the
        // accelerators stay quiet then. Enter on the trigger and item clicks
        // are left native — the button's own activation closes the menu via
        // the click path above.
        if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
          const want = ({ b: "menu-brand", v: "menu-view", t: "menu-tools", m: "menu-markup" })[e.key.toLowerCase()];
          if (want) {
            if (this._openModalEl()) return;
            const menu = document.getElementById(want);
            if (!menu) return;
            const panel = menu.querySelector(".tb-menu-panel");
            const trig = menu.querySelector(".tb-menu-trigger");
            if (!panel) return;
            const wasOpen = !panel.hidden;
            closeAll();
            e.preventDefault();
            if (wasOpen) { trig.focus(); return; } // toggle closed — return to the trigger
            setOpen(menu, true);
            const items = this._menuItems(panel);
            (items[0] || trig).focus();
            return;
          }
        }
        // while a panel is open the menu owns the keyboard: arrows / Home /
        // End / Tab cycle its items (wrapping), ← / → switch menus, Esc
        // closes — and none of it leaks to the viewer's global handlers
        // (preventDefault + stopPropagation, so e.g. ArrowDown never also
        // pages the document). When focus sits on the trigger, the first
        // arrow enters the panel from the correct end.
        const menu = openMenu();
        if (!menu) return;
        const panel = menu.querySelector(".tb-menu-panel");
        const trig = menu.querySelector(".tb-menu-trigger");
        const items = this._menuItems(panel);
        const active = document.activeElement;
        const inList = items.includes(active);
        const focusItem = (el) => {
          e.preventDefault();
          e.stopPropagation();
          if (el) el.focus();
        };
        const switchTo = (next) => {
          e.preventDefault();
          e.stopPropagation();
          const np = next.querySelector(".tb-menu-panel");
          const nt = next.querySelector(".tb-menu-trigger");
          if (!np) return;
          closeAll();
          setOpen(next, true);
          const ni = this._menuItems(np);
          (ni[0] || nt).focus();
        };
        switch (e.key) {
          case "ArrowDown": focusItem(inList ? Utils.menuNavMove(items, active, "next") : items[0]); return;
          case "ArrowUp": focusItem(inList ? Utils.menuNavMove(items, active, "prev") : items[items.length - 1]); return;
          case "Home": focusItem(items[0]); return;
          case "End": focusItem(items[items.length - 1]); return;
          case "Tab":
            // Tab/Shift+Tab cycle inside the panel while focus is on an item;
            // from the trigger native Tab continues in document order
            if (inList) focusItem(Utils.menuNavMove(items, active, e.shiftKey ? "prev" : "next"));
            return;
          case "ArrowLeft": case "ArrowRight": {
            const step = e.key === "ArrowRight" ? 1 : -1;
            switchTo(menus[(menus.indexOf(menu) + step + menus.length) % menus.length]);
            return;
          }
          case "Escape":
            e.preventDefault();
            e.stopPropagation();
            closeAll();
            trig.focus(); // keyboard users stay at the menu they were using
            return;
        }
      });
    },

    /* ── OCR language popover (searchable, status-aware) ────
       The Tools menu's "OCR language" item opens a small popover (inside
       #menu-tools, so it anchors to the trigger) with a live search filter
       over the language list and a per-language availability status. Keys
       inside the popover are owned by the popover (stopPropagation), so the
       menu keyboard nav and the viewer shortcuts never fire while typing or
       walking the list; Esc closes it and returns focus to the item. */
    _wireOcrLangPopover() {
      const el = this.elements;
      const pop = el.ocrLangPop;
      const list = el.ocrLangList;
      const search = el.ocrLangSearch;
      const visibleRows = () => [...list.querySelectorAll(".ol-row")].filter((r) => !r.hidden);
      const closePop = (restoreFocus) => {
        pop.hidden = true;
        if (el.btnOcrLang) el.btnOcrLang.setAttribute("aria-expanded", "false");
        if (restoreFocus) {
          // back to the picker item when its menu is still open; otherwise the
          // item is hidden (a hidden panel can't hold focus), so hand focus to
          // the Tools trigger instead
          const target = (el.btnOcrLang && !el.btnOcrLang.hidden && el.btnOcrLang.getClientRects().length > 0)
            ? el.btnOcrLang : el.btnTools;
          if (target) target.focus();
        }
      };
      const openPop = () => {
        if (!Volt.OCR || !Volt.OCR.renderLangList) return;
        Volt.OCR.renderLangList(list);
        search.value = "";
        for (const r of list.querySelectorAll(".ol-row")) r.hidden = false;
        pop.hidden = false;
        if (el.btnOcrLang) el.btnOcrLang.setAttribute("aria-expanded", "true");
        if (Volt.OCR._syncPreferUI) Volt.OCR._syncPreferUI(); // the checkbox reflects THIS document
        search.focus();
      };
      const selectRow = (row) => {
        if (!row || !row.dataset.code) return;
        const code = row.dataset.code;
        closePop(false);
        if (Volt.OCR && Volt.OCR.setLang) Volt.OCR.setLang(code);
      };
      el.btnOcrLang.addEventListener("click", (e) => {
        e.stopPropagation(); // the Tools menu must stay open while the popover is up
        if (pop.hidden) openPop(); else closePop(true);
      });
      // OCR-first layer checkbox: flips the per-document preference and
      // rebuilds the on-screen text layers (the aligned OCR words replace the
      // embedded — possibly offset — layer, so highlights/selection/search
      // follow the visible text)
      if (el.ocrPrefer) {
        el.ocrPrefer.addEventListener("change", (e) => {
          if (Volt.OCR && Volt.OCR.setPreferLayer) Volt.OCR.setPreferLayer(e.target.checked);
        });
      }
      search.addEventListener("input", () => {
        const q = search.value.trim().toLowerCase();
        for (const r of list.querySelectorAll(".ol-row")) {
          r.hidden = !q || !r.dataset.search.includes(q);
        }
      });
      list.addEventListener("click", (e) => {
        const row = e.target.closest ? e.target.closest(".ol-row") : null;
        if (row) selectRow(row);
      });
      pop.addEventListener("keydown", (e) => {
        const nav = e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Home" || e.key === "End";
        const act = e.key === "Enter";
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          closePop(true);
          return;
        }
        if (!nav && !act) return;
        const rows = visibleRows();
        if (!rows.length) return;
        const a = document.activeElement;
        if (a === search) {
          if (e.key === "ArrowDown") { e.preventDefault(); e.stopPropagation(); rows[0].focus(); return; }
          if (e.key === "ArrowUp") { e.preventDefault(); e.stopPropagation(); rows[rows.length - 1].focus(); return; }
          if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); selectRow(rows[0]); return; }
          return; // Home/End keep their native caret meaning inside the input
        }
        e.preventDefault();
        e.stopPropagation();
        const i = rows.indexOf(a);
        if (e.key === "ArrowDown") rows[(i + 1) % rows.length].focus();
        else if (e.key === "ArrowUp") rows[(i - 1 + rows.length) % rows.length].focus();
        else if (e.key === "Home") rows[0].focus();
        else if (e.key === "End") rows[rows.length - 1].focus();
        else if (e.key === "Enter" && i >= 0) selectRow(rows[i]);
      });
    },

    /* ── search ────────────────────────────────────────────── */
    _wireSearch() {
      const el = this.elements;
      el.searchInput.addEventListener("input", Utils.debounce(() => {
        const q = el.searchInput.value.trim();
        if (q) this.runSearch(q);
        else this.clearSearch();
      }, 250));
      el.searchInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          if (e.shiftKey) this.searchPrev(); else this.searchNext();
        } else if (e.key === "Escape") {
          this.clearSearch();
          el.searchInput.blur();
        }
      });
      el.searchPrev.addEventListener("click", () => this.searchPrev());
      el.searchNext.addEventListener("click", () => this.searchNext());
      el.searchClear.addEventListener("click", () => { this.clearSearch(); el.searchInput.value = ""; });
    },

    /* ── sidebar ───────────────────────────────────────────── */
    _wireSidebar() {
      const el = this.elements;
      el.sideTabs.forEach((tab) => {
        tab.addEventListener("click", () => {
          el.sideTabs.forEach((t) => t.classList.toggle("active", t === tab));
          el.panelPages.hidden = tab.dataset.tab !== "pages";
          el.panelOutline.hidden = tab.dataset.tab !== "outline";
          el.panelNotes.hidden = tab.dataset.tab !== "notes";
          if (tab.dataset.tab === "notes") Volt.Ann.refreshNotesList();
          if (tab.dataset.tab === "pages") this._renderThumbs();
        });
      });
      el.thumbGrid.addEventListener("click", (e) => {
        const t = e.target.closest(".thumb-item");
        if (!t) return;
        const page = parseInt(t.dataset.page, 10);
        const n = this.currentDoc ? this.currentDoc.numPages : 0;
        // Shift+click extends from the anchor — the whole CONTIGUOUS range
        // from the last plain/Ctrl click (or a prior range's far end) to this
        // page replaces the selection, exactly like the manager's grid, so a
        // block for drag/delete doesn't need per-thumb clicking. Never
        // navigates. Bounds clamp to the doc, so a stale anchor can't select
        // ghost pages.
        if (e.shiftKey && this._thumbSelAnchor != null) {
          const { lo, hi } = Utils.clampedRange(this._thumbSelAnchor, page, 1, n);
          this._thumbSel = new Set();
          for (let p = lo; p <= hi; p++) this._thumbSel.add(p);
          this._thumbSelAnchor = page; // the far end anchors the next range
          this._applyThumbSel();
          return;
        }
        // Ctrl+click toggles ONE thumb in/out — the non-contiguous
        // multi-select (the sidebar's plain click navigates, so Ctrl takes
        // the manager's plain-click-toggle role) — and re-anchors the next
        // Shift+click range here. Never navigates.
        if (e.ctrlKey || e.metaKey) {
          if (!this._thumbSel) this._thumbSel = new Set();
          if (this._thumbSel.has(page)) this._thumbSel.delete(page);
          else this._thumbSel.add(page);
          this._thumbSelAnchor = page;
          this._applyThumbSel();
          return;
        }
        // Shift+click with no anchor (fresh doc / cleared selection): fall
        // back to a toggle and anchor here — mirrors the manager's else-branch.
        if (e.shiftKey) {
          if (!this._thumbSel) this._thumbSel = new Set();
          if (this._thumbSel.has(page)) this._thumbSel.delete(page);
          else this._thumbSel.add(page);
          this._thumbSelAnchor = page;
          this._applyThumbSel();
          return;
        }
        // plain click: navigate, clear the selection, and anchor the next
        // Shift+click range at the page you landed on
        this._thumbSel = null;
        this._thumbSelAnchor = page;
        this._applyThumbSel();
        this.goToPage(page);
      });
      // drag-reorder the document DIRECTLY from the sidebar: grabbing a thumb
      // (or a Shift+click multi-selected BLOCK) and dropping it at another
      // position rebuilds the doc with that page order (the same machinery as
      // the manager's Apply — annotations remap, scroll/zoom carry over) and
      // offers an 'Undo reorder' toast. Clicking still navigates: Chromium
      // suppresses click after a real drag.
      el.thumbGrid.addEventListener("dragstart", (e) => {
        const item = e.target.closest(".thumb-item");
        const page = item ? parseInt(item.dataset.page, 10) : 0;
        if (!item || !page) { e.preventDefault(); return; }
        // grabbing a selected thumb drags the whole block; grabbing an
        // unselected one selects just it (same rule as the manager's grid)
        if (!this._thumbSel) this._thumbSel = new Set();
        if (!this._thumbSel.has(page)) {
          this._thumbSel = new Set([page]);
          this._thumbSelAnchor = page; // the grab anchors the next Shift+click range
          this._applyThumbSel();
        }
        this._thumbDragPage = page;
        this._thumbDragSet = new Set(this._thumbSel);
        for (const it of this.elements.thumbGrid.querySelectorAll(".thumb-item")) {
          if (this._thumbDragSet.has(parseInt(it.dataset.page, 10))) it.classList.add("dragging");
        }
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", String(page)); // Firefox needs data set
      });
      el.thumbGrid.addEventListener("dragover", (e) => {
        if (!this._thumbDragPage) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        const item = e.target.closest(".thumb-item");
        this._clearThumbDrop();
        if (!item) return;
        const page = parseInt(item.dataset.page, 10);
        if (!page || this._thumbDragSet.has(page)) return; // hovering a dragged thumb — no indicator
        const r = item.getBoundingClientRect();
        // the sidebar is a vertical list: the top half means "before", the
        // bottom half "after" (matching the manager's left/right split)
        const pos = e.clientY < r.top + r.height / 2 ? "before" : "after";
        item.classList.add(pos === "before" ? "drag-before" : "drag-after");
        this._thumbDrop = { page, pos };
        // live preview: a floating pill shows the WOULD-BE page order for
        // this drop, so nothing commits until the user confirms
        const order = this._computeThumbOrder(this._thumbDragSet, page, pos);
        if (order && !order.every((p, i) => p === i + 1)) {
          this._showThumbDragPreview(order, e.clientX, e.clientY);
        }
      });
      el.thumbGrid.addEventListener("drop", (e) => {
        const dragPage = this._thumbDragPage;
        const dragSet = this._thumbDragSet;
        const t = this._thumbDrop;
        if (!dragPage) return;
        e.preventDefault();
        this._clearThumbDrag();
        if (!t || dragSet.has(t.page)) return;
        // preview, don't commit: the drop arms a confirm toast showing the
        // new order — Apply rebuilds the document, Cancel (or 8s of inaction)
        // leaves it untouched
        this._confirmThumbReorder(dragPage, dragSet, t.page, t.pos);
      });
      el.thumbGrid.addEventListener("dragend", () => this._clearThumbDrag());
      // block actions (First / Last / Move to… / Clear) — the keyboard/menu
      // way to move the Shift+click multi-selection, mirroring the manager's
      // buttons and move-to form but committing DIRECTLY through the same
      // path as the drag (rebuild + 'Undo reorder' toast)
      el.thumbMoveFirst.addEventListener("click", () => this._moveThumbBlockTo(1));
      el.thumbMoveLast.addEventListener("click", () => this._moveThumbBlockTo("last"));
      el.thumbMoveTo.addEventListener("click", () => this._showThumbMoveForm());
      el.thumbMoveClear.addEventListener("click", () => {
        this._thumbSel = null;
        this._thumbSelAnchor = null; // a cleared selection has no range anchor
        this._applyThumbSel();
      });
      el.thumbMoveGo.addEventListener("click", () => this._confirmThumbMove());
      el.thumbMoveCancel.addEventListener("click", () => this._hideThumbMoveForm());
      el.thumbMovePos.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); this._confirmThumbMove(); }
      });
      // 'Select annotated' for the sidebar: pick every page that carries
      // annotations in the CURRENT document — the same set the manager's
      // button selects and the Delete confirm warns about — so a cleanup
      // flow (select → block-move or drag to another PDF) works without
      // opening the manager.
      el.btnThumbSelAnn.addEventListener("click", () => this._selectAnnotatedThumbs());
    },

    /* ── page manager (add / delete / reorder / insert / extract) ──
       The Pages tab's "Manage pages…" opens a modal that stages page edits:
       the grid shows the planned order, actions mutate the plan, and only
       Apply & save (or Export selected) actually rebuilds a PDF — the open
       document is never touched until then. Rebuilds go through
       Volt.Ann.buildEditedPdf (pdf-lib copyPages + annotation burn-in), so
       surviving pages keep their vector content AND their annotations. */
    _wirePagesManager() {
      const el = this.elements;
      el.btnManagePages.addEventListener("click", () => this.openPagesManager());
      el.pagesCancel.addEventListener("click", () => {
        this._resetPageManager();
        this._closeModal(el.pagesModal);
      });
      el.pagesApply.addEventListener("click", () => this._applyPagePlan(false));
      el.btnPagesUndo.addEventListener("click", () => this._undoPagePlan());
      el.btnPagesRedo.addEventListener("click", () => this._redoPagePlan());
      el.btnPagesBlank.addEventListener("click", () => this._addBlankPage());
      el.btnPagesUp.addEventListener("click", () => this._moveSelected(-1));
      el.btnPagesDown.addEventListener("click", () => this._moveSelected(1));
      el.btnPagesFirst.addEventListener("click", () => this._moveSelectedTo(1));
      el.btnPagesLast.addEventListener("click", () => this._moveSelectedTo((this._pagePlan || []).length));
      el.btnPagesMove.addEventListener("click", () => {
        if (this.elements.pagesMoveForm.hidden) this._showMoveForm();
        else this._hideMoveForm();
      });
      el.pagesMoveGo.addEventListener("click", () => this._confirmMove());
      el.pagesMoveCancel.addEventListener("click", () => this._hideMoveForm());
      el.pagesMovePos.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); this._confirmMove(); }
      });
      el.btnPagesDel.addEventListener("click", () => this._deleteSelected());
      el.btnPagesSelAnn.addEventListener("click", () => this._selectAnnotatedPages());
      el.btnPagesClearHl.addEventListener("click", () => this._clearHighlightsOnSelected());
      el.btnPagesInvert.addEventListener("click", () => this._invertPageSelection());
      // a Delete confirm armed on the danger button disarms on ANY other click
      // — one click arms, a second click on the SAME button within 3s decides
      document.addEventListener("click", (e) => {
        if (this._pageConfirmArmed && !e.target.closest("#btn-pages-del")) this._disarmPageDeleteConfirm();
      });
      el.btnPagesExportSel.addEventListener("click", () => this._exportSelectedPages());
      el.btnPagesInsert.addEventListener("click", () => el.pagesInsertInput.click());
      el.pagesInsertInput.addEventListener("change", () => {
        const f = el.pagesInsertInput.files[0];
        if (f) this._beginInsertPdf(f);
        el.pagesInsertInput.value = "";
      });
      el.pagesInsertGo.addEventListener("click", () => this._confirmInsertPdf());
      el.pagesInsertCancel.addEventListener("click", () => this._hidePagesInsertForm());
      el.pagesInsertRange.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); this._confirmInsertPdf(); }
      });
      el.pagesPlanGrid.addEventListener("click", (e) => {
        if (e.target.closest(".pages-pos")) return; // the reorder index is its own control
        const item = e.target.closest(".pages-plan-item");
        if (!item) return;
        const i = parseInt(item.dataset.pi, 10);
        if (e.shiftKey && this._pageSelAnchor != null) {
          // Shift+click extends the selection to the clicked page — the whole
          // contiguous range replaces the selection (the standard file-manager
          // gesture, so a block for Delete/drag/insert doesn't need per-thumb
          // clicking). The anchor becomes the far end, so repeated Shift+clicks
          // keep extending from the last range. Bounds are clamped to the plan,
          // so a stale anchor can never select ghost pages.
          const n = (this._pagePlan || []).length;
          const { lo, hi } = Utils.clampedRange(this._pageSelAnchor, i, 0, n - 1);
          this._pageSel = new Set();
          for (let k = lo; k <= hi; k++) this._pageSel.add(k);
          this._pageSelAnchor = i;
          this._renderPagePlan();
          const hit = this.elements.pagesPlanGrid.querySelector('.pages-plan-item[data-pi="' + i + '"]');
          if (hit && hit.scrollIntoView) hit.scrollIntoView({ block: "nearest" });
        } else {
          this._togglePageSel(i);
          this._pageSelAnchor = i; // anchor the next Shift+click range here
        }
      });
      // per-row reorder index: type a position + Enter to move THAT page there
      // (undoable, like every edit); Escape reverts the edit without closing
      // the modal. Single-page by design — the move-to form handles blocks.
      el.pagesPlanGrid.addEventListener("keydown", (e) => {
        const input = e.target.closest(".pages-pos");
        if (!input) return;
        const item = input.closest(".pages-plan-item");
        if (!item) return;
        const idx = parseInt(item.dataset.pi, 10);
        const n = (this._pagePlan || []).length;
        if (e.key === "Enter") {
          e.preventDefault();
          e.stopPropagation();
          const raw = input.value.trim();
          const pos = parseInt(raw, 10);
          if (!/^\d+$/.test(raw) || pos < 1 || pos > n) {
            this.toast("Enter a position 1-" + n, "error");
            input.value = String(idx + 1); // revert
            return;
          }
          if (pos === idx + 1) { input.blur(); return; } // already there
          this._pageSel = new Set([idx]);
          this._moveSelectedToTargets([pos]); // renders + selects the moved page
          const moved = this.elements.pagesPlanGrid.querySelector('.pages-plan-item[data-pi="' + (pos - 1) + '"] .pages-pos');
          if (moved) moved.focus();
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation(); // revert the edit — do NOT close the modal
          input.value = String(idx + 1);
          input.blur();
        }
      });
      // drag-and-drop reorder: grabbing an unselected page selects just it
      // (so the drag carries the visible selection); grabbing a selected page
      // drags the whole selection, matching the Move up/down semantics.
      el.pagesPlanGrid.addEventListener("dragstart", (e) => {
        if (e.target.closest(".pages-pos")) { e.preventDefault(); return; } // the index input isn't a drag handle
        const item = e.target.closest(".pages-plan-item");
        if (!item) { e.preventDefault(); return; }
        const pi = parseInt(item.dataset.pi, 10);
        if (!this._pageSel) this._pageSel = new Set();
        if (!this._pageSel.has(pi)) {
          // select just the grabbed page — update classes in place, never
          // re-render mid-drag (rebuilding the grid would detach the drag source)
          this._pageSel = new Set([pi]);
          for (const it of el.pagesPlanGrid.querySelectorAll(".pages-plan-item")) {
            it.classList.toggle("sel", parseInt(it.dataset.pi, 10) === pi);
          }
        }
        this._pageDrag = new Set(this._pageSel);
        for (const it of el.pagesPlanGrid.querySelectorAll(".pages-plan-item")) {
          if (this._pageDrag.has(parseInt(it.dataset.pi, 10))) it.classList.add("dragging");
        }
        this._updatePagesSelInfo();
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", String(pi)); // Firefox needs data set
        }
      });
      el.pagesPlanGrid.addEventListener("dragover", (e) => {
        e.preventDefault(); // allow the drop
        if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
        const item = e.target.closest(".pages-plan-item");
        for (const it of el.pagesPlanGrid.querySelectorAll(".drag-before, .drag-after")) {
          it.classList.remove("drag-before", "drag-after");
        }
        this._pageDropTarget = null;
        if (!item || !this._pageDrag) { this._updatePagesPosPreview(null); return; }
        const pi = parseInt(item.dataset.pi, 10);
        if (this._pageDrag.has(pi)) { this._updatePagesPosPreview(null); return; } // hovering a dragged page — no indicator
        const r = item.getBoundingClientRect();
        const pos = e.clientX < r.left + r.width / 2 ? "before" : "after";
        // row-aware: "after" the LAST item of a row is the same linear slot as
        // "before" the first item of the NEXT row — snap the indicator (and
        // the drop) there, so the bar sits where the block will actually render
        const t = this._snapDropTarget(pi, pos);
        if (this._pageDrag.has(t.index)) { this._updatePagesPosPreview(null); return; } // snapped onto a dragged page — no indicator
        const targetEl = el.pagesPlanGrid.querySelector('.pages-plan-item[data-pi="' + t.index + '"]');
        if (targetEl) targetEl.classList.add(t.pos === "before" ? "drag-before" : "drag-after");
        this._pageDropTarget = { index: t.index, pos: t.pos };
        // live renumber: show where every page WOULD sit if dropped here, so
        // long-document drags have a numeric reference while hovering
        const preview = this._previewPlanAfterDrag([...this._pageDrag].sort((a, b) => a - b), t.index, t.pos);
        this._updatePagesPosPreview(preview.plan);
      });
      el.pagesPlanGrid.addEventListener("drop", (e) => {
        e.preventDefault();
        if (!this._pageDrag) return;
        const plan = this._pagePlan;
        const item = e.target.closest(".pages-plan-item");
        if (!plan || !item) { this._clearPageDragUI(); return; }
        const dragged = [...this._pageDrag].sort((a, b) => a - b);
        const j = parseInt(item.dataset.pi, 10);
        const r = item.getBoundingClientRect();
        const pos = e.clientX < r.left + r.width / 2 ? "before" : "after";
        // same row-aware snap as the dragover indicator, so the drop lands
        // exactly where the bar showed
        const t = this._snapDropTarget(j, pos);
        const preview = this._previewPlanAfterDrag(dragged, t.index, t.pos);
        const { plan: newPlan, insertAt } = preview;
        const unchanged = newPlan.length === plan.length && newPlan.every((en, i) => en === plan[i]);
        this._clearPageDragUI();
        if (unchanged) return; // dropped back where it was — no churn
        this._snapshotPagePlan(); // pre-drag plan + selection
        this._pagePlan = newPlan;
        this._pageSel = new Set(Array.from({ length: dragged.length }, (_, k) => insertAt + k));
        this._renderPagePlan();
      });
      el.pagesPlanGrid.addEventListener("dragend", (e) => {
        if (!this._pageDrag) return; // drop already cleaned up
        this._clearPageDragUI();
        this._renderPagePlan();
      });
    },

    /** Map a hovered item + before/after to the DROP slot, snapping across
        wrap boundaries: "after" the LAST item of a row is the same linear slot
        as "before" the first item of the NEXT row — but the block renders at
        the next row's start, so the indicator (and the drop) must sit there
        too, or the bar looks off by a row. Non-boundary hovers pass through. */
    _snapDropTarget(pi, pos) {
      if (pos !== "after") return { index: pi, pos };
      const items = [...this.elements.pagesPlanGrid.querySelectorAll(".pages-plan-item")];
      const el = items[pi];
      if (!el) return { index: pi, pos };
      const next = items[pi + 1];
      if (!next) return { index: pi, pos }; // last of the grid — append stays put
      const r = el.getBoundingClientRect();
      const nr = next.getBoundingClientRect();
      if (nr.top > r.top + r.height / 2) {
        return { index: pi + 1, pos: "before" }; // wrapped: snap to the next row's start
      }
      return { index: pi, pos };
    },

    /** Drop/drag cleanup — reset drag state, restore the real order's numbers,
        and strip drag classes in place. */
    _clearPageDragUI() {
      this._pageDrag = null;
      this._pageDropTarget = null;
      const grid = this.elements.pagesPlanGrid;
      this._updatePagesPosPreview(null); // drop the live drag numbering
      for (const it of grid.querySelectorAll(".pages-plan-item")) {
        it.classList.remove("dragging", "drag-before", "drag-after");
      }
    },

    /** The plan (and insertion slot) that would result from dropping the
        dragged block before/after the item at plan index `j` — shared by the
        drop handler (applies it) and the dragover handler (live numbering). */
    _previewPlanAfterDrag(dragged, j, pos) {
      const plan = this._pagePlan;
      // the insertion slot is how many NON-dragged pages precede the target
      // in the original order (plus 1 after). Counting non-dragged pages —
      // not `base - dragged before base` — is what makes a block that
      // straddles the target land right (e.g. dragging {1,3} before index 1
      // must yield [1,3,2], not [2,1,3]).
      let insertAt = 0;
      for (let i = 0; i < j; i++) if (!this._pageDrag.has(i)) insertAt++;
      if (pos === "after") insertAt++;
      const entries = dragged.map((d) => plan[d]);
      const newPlan = plan.filter((_, i) => !this._pageDrag.has(i));
      newPlan.splice(insertAt, 0, ...entries);
      return { plan: newPlan, insertAt };
    },

    /** Renumber the per-row position inputs WITHOUT touching the plan — the
        live drag preview. The DOM rows keep their data-pi (old order); the
        preview plan holds the same entry objects in would-be order, so each
        row's number is its entry's index there + 1. Pass null to restore the
        current order's numbers. */
    _updatePagesPosPreview(previewPlan) {
      const grid = this.elements.pagesPlanGrid;
      for (const it of grid.querySelectorAll(".pages-plan-item")) {
        const input = it.querySelector(".pages-pos");
        if (!input) continue;
        const idx = parseInt(it.dataset.pi, 10);
        let p = -1;
        if (previewPlan) p = previewPlan.indexOf(this._pagePlan[idx]);
        input.value = String(p >= 0 ? p + 1 : idx + 1);
      }
    },

    /* ── staged-edit undo / redo ────────────────────────────
       Every mutation of the plan (blank, delete, move, insert, drag-drop)
       pushes a snapshot BEFORE applying, so undo restores the exact prior
       plan AND selection — an accidental Delete or Insert is one click (or
       Ctrl+Z) away from never having happened, without touching Apply.
       Undo pushes the CURRENT state onto the redo stack, so a mistaken undo
       is one click (or Ctrl+Shift+Z / Ctrl+Y) from being reapplied; a NEW
       edit clears the redo stack (standard semantics). */
    _snapshotPagePlan() {
      const plan = this._pagePlan;
      if (!Array.isArray(plan)) return;
      this._pageUndo.push({ plan: plan.map((e) => ({ ...e })), sel: new Set(this._pageSel || []) });
      if (this._pageUndo.length > 50) this._pageUndo.shift();
      this._pageRedo = []; // a fresh edit invalidates everything that was undone
      this._updatePagesUndoRedoBtns();
    },

    _undoPagePlan() {
      const snap = this._pageUndo.pop();
      if (!snap) { this.toast("Nothing to undo"); return; }
      this._pageRedo.push({ plan: this._pagePlan.map((e) => ({ ...e })), sel: new Set(this._pageSel || []) });
      this._pagePlan = snap.plan;
      this._pageSel = snap.sel;
      this._renderPagePlan();
      this._updatePagesUndoRedoBtns();
      this.toast("Undid last page edit", "ok");
    },

    _redoPagePlan() {
      const snap = this._pageRedo.pop();
      if (!snap) { this.toast("Nothing to redo"); return; }
      // the pre-redo state goes back onto the undo stack, so the redo itself
      // is undoable — undo ⇄ redo cycle cleanly without losing history
      this._pageUndo.push({ plan: this._pagePlan.map((e) => ({ ...e })), sel: new Set(this._pageSel || []) });
      this._pagePlan = snap.plan;
      this._pageSel = snap.sel;
      this._renderPagePlan();
      this._updatePagesUndoRedoBtns();
      this.toast("Redid last page edit", "ok");
    },

    _updatePagesUndoRedoBtns() {
      const u = this.elements.btnPagesUndo;
      if (u) {
        u.disabled = this._pageUndo.length === 0;
        u.title = this._pageUndo.length
          ? "Undo the last staged page edit (Ctrl+Z)"
          : "Nothing to undo yet — staged edits land here";
      }
      const r = this.elements.btnPagesRedo;
      if (r) {
        r.disabled = this._pageRedo.length === 0;
        r.title = this._pageRedo.length
          ? "Redo the last undone page edit (Ctrl+Shift+Z)"
          : "Nothing to redo — an undo (or an edit that clears it) empties this";
      }
    },

    openPagesManager() {
      const el = this.elements;
      if (!this.currentDoc) { this.toast("Open a document first", "error"); return; }
      if (this._openModalEl()) return; // one modal at a time
      // start each session from a clean slate (a stale plan/cache must never
      // leak across opens — e.g. an Escape-close leaves the old plan behind)
      this._resetPageManager(); // destroys any prior inserted-file docs too
      this._pagePlan = Array.from({ length: this.currentDoc.numPages }, (_, i) => ({ kind: "doc", oldPage: i + 1 }));
      this._pagePlanDoc = this.currentDoc; // the plan belongs to THIS document
      this._pageSel = new Set();
      el.pagesModalSub.textContent = this.currentDocInfo.name + " — " + this.currentDoc.numPages + " pages";
      this._hidePagesInsertForm();
      this._hideMoveForm();
      this._openModal(el.pagesModal);
      this._renderPagePlan();
    },

    _resetPageManager() {
      this._pagePlan = null;
      this._pagePlanDoc = null;
      this._pageSel = null;
      this._pageSelAnchor = null; // a stale anchor must never leak across sessions
      this._disarmPageDeleteConfirm(); // a stale armed Delete must never survive a reopen
      this._pageUndo = [];
      this._pageRedo = [];
      this._pageThumbCache = new Map();
      this._pageSizeCache = new Map();
      for (const doc of this._otherPdfDocs.values()) { try { doc.destroy(); } catch (e) { /* ignore */ } }
      this._otherPdfDocs.clear();
      this._otherAnns.clear();
      this._insertBytes = null;
      this._insertCount = 0;
      this._insertName = "";
    },

    _hidePagesInsertForm() {
      this.elements.pagesInsertForm.hidden = true;
    },

    /** Re-render the staged grid. Thumbnails come from a cache keyed by
        source+page, so reorders/deletes only re-draw cached bitmaps. */
    _renderPagePlan() {
      const grid = this.elements.pagesPlanGrid;
      const plan = this._pagePlan || [];
      this._disarmPageDeleteConfirm(); // a re-render means state changed (selection, undo, reorder) — the armed 'Really …?' referred to the OLD state
      grid.innerHTML = "";
      this._fillPagesPosSelect();
      for (let i = 0; i < plan.length; i++) {
        const e = plan[i];
        const item = document.createElement("div");
        item.className = "thumb-item pages-plan-item" + (this._pageSel && this._pageSel.has(i) ? " sel" : "");
        item.dataset.pi = i;
        item.draggable = true;
        item.title = "Drag to reorder · click to select · Shift+click a range";
        // per-row reorder index: a live position input that renumbers as the
        // plan changes (and during a drag preview). Enter moves this page to
        // the typed position; Escape reverts.
        const pos = document.createElement("input");
        pos.type = "text";
        pos.inputMode = "numeric";
        pos.className = "pages-pos";
        pos.value = String(i + 1);
        pos.setAttribute("aria-label", "Position of this page in the plan — type a number and press Enter to move it");
        pos.title = "Position — type a number + Enter to move this page here";
        item.appendChild(pos);
        // page size (in) — bottom-left; synchronous for doc/blank pages, async
        // for inserted pages (needs the other PDF's page dimensions)
        const size = document.createElement("span");
        size.className = "pages-size";
        item.appendChild(size);
        if (e.kind === "blank") {
          size.textContent = this._pageSizeLabel(e.w, e.h);
          const box = document.createElement("div");
          box.className = "pages-blank-box";
          box.style.aspectRatio = e.w + " / " + e.h;
          item.appendChild(box);
          const tag = document.createElement("span");
          tag.className = "pages-src-badge blank";
          tag.textContent = "blank";
          item.appendChild(tag);
        } else if (e.kind === "other") {
          const tag = document.createElement("span");
          tag.className = "pages-src-badge";
          tag.title = e.name;
          tag.textContent = "from " + (e.name || "pdf");
          item.appendChild(tag);
          const sizeKey = "o:" + e.fid + ":" + e.page;
          const cachedSize = this._pageSizeCache.get(sizeKey);
          if (cachedSize) size.textContent = cachedSize;
          // annotation count FROM THE SOURCE FILE — read at insert time (the
          // source doc can't be open while this manager session lives). Only
          // informational: these annotations stay with the source document,
          // so deleting the page from the plan loses nothing.
          const srcAnns = this._otherAnns.get(e.fid);
          const srcCount = srcAnns ? srcAnns.filter((a) => a.page === e.page).length : 0;
          if (srcCount > 0) {
            const ann = document.createElement("span");
            ann.className = "pages-ann";
            ann.textContent = String(srcCount);
            ann.title = srcCount + " annotation" + (srcCount === 1 ? "" : "s") + " in the source file on this page";
            item.appendChild(ann);
          }
          this._renderPlanThumb(item, sizeKey, (cv) => this._renderOtherThumbCanvas(cv, e, size));
        } else {
          const d = this.pageDims[e.oldPage - 1];
          size.textContent = this._pageSizeLabel(d && d.w, d && d.h);
          const was = document.createElement("span");
          was.className = "pages-was";
          was.textContent = "was p." + e.oldPage;
          item.appendChild(was);
          // annotation count — only when > 0, so annotated pages stand out
          // before you select them for deletion
          const annCount = (Volt.Ann && Volt.Ann.list)
            ? Volt.Ann.list.filter((a) => a.page === e.oldPage).length
            : 0;
          if (annCount > 0) {
            const ann = document.createElement("span");
            ann.className = "pages-ann";
            ann.textContent = String(annCount);
            ann.title = annCount + " annotation" + (annCount === 1 ? "" : "s") + " on this page — deleting it drops them";
            item.appendChild(ann);
          }
          this._renderPlanThumb(item, "d:" + e.oldPage, (cv) => this._renderDocThumbCanvas(cv, e.oldPage));
        }
        grid.appendChild(item);
      }
      this._updatePagesSelInfo();
      this._updatePagesUndoRedoBtns();
    },

    /** PDF points → "W × H in" label (72pt = 1in), trailing zeros trimmed. */
    _pageSizeLabel(w, h) {
      return Utils.pageSizeLabel(w, h);
    },

    /** Shared thumbnail plumbing: append a canvas, then either blit the cached
        bitmap (cache key) or run the provided rasterizer and cache its output. */
    _renderPlanThumb(item, key, rasterize) {
      const cv = document.createElement("canvas");
      item.appendChild(cv);
      const cached = this._pageThumbCache.get(key);
      if (cached) {
        cv.width = cached.width;
        cv.height = cached.height;
        cv.getContext("2d").drawImage(cached, 0, 0);
        return;
      }
      Promise.resolve().then(async () => {
        try {
          await rasterize(cv);
          this._pageThumbCache.set(key, cv);
        } catch (e) { /* a failed thumbnail shouldn't break the manager */ }
      });
    },

    async _renderDocThumbCanvas(cv, oldPage) {
      const doc = this.currentDoc;
      if (!doc) return;
      const p = await doc.getPage(oldPage);
      const d = this.pageDims[oldPage - 1];
      const scale = Utils.thumbScale(d && d.w);
      const vp = p.getViewport({ scale, rotation: this.rotDelta });
      cv.width = Math.floor(vp.width);
      cv.height = Math.floor(vp.height);
      cv.style.width = "100%";
      cv.style.height = "auto";
      await p.render({ canvasContext: cv.getContext("2d"), viewport: vp }).promise;
    },

    async _renderOtherThumbCanvas(cv, entry, sizeEl) {
      let doc = this._otherPdfDocs.get(entry.fid);
      if (!doc) {
        // pdf.js transfers/detaches the buffer — keep the plan entry's copy
        // for the pdf-lib rebuild
        doc = await pdfjsLib.getDocument({
          data: entry.bytes.slice(0),
          isEvalSupported: false,
          useSystemFonts: true,
        }).promise;
        this._otherPdfDocs.set(entry.fid, doc);
      }
      const p = await doc.getPage(entry.page);
      const vp0 = p.getViewport({ scale: 1 });
      const vp = p.getViewport({ scale: Utils.thumbScale(vp0.width), rotation: 0 });
      cv.width = Math.floor(vp.width);
      cv.height = Math.floor(vp.height);
      cv.style.width = "100%";
      cv.style.height = "auto";
      await p.render({ canvasContext: cv.getContext("2d"), viewport: vp }).promise;
      if (sizeEl) {
        const label = this._pageSizeLabel(vp0.width, vp0.height);
        sizeEl.textContent = label;
        this._pageSizeCache.set("o:" + entry.fid + ":" + entry.page, label);
      }
    },

    _togglePageSel(i) {
      if (this._pageSel.has(i)) this._pageSel.delete(i);
      else this._pageSel.add(i);
      this._renderPagePlan();
    },

    /** Select a single plan page at an extent index (Home → 0, End → last)
        and bring it into view — mirrors the viewer's own Home/End navigation,
        but over the staged grid instead of the document. Selection-only: the
        plan is never mutated, so no undo snapshot is needed. */
    _selectPageExtent(idx) {
      const plan = this._pagePlan;
      if (!plan || !plan.length) return;
      const i = Math.max(0, Math.min(plan.length - 1, idx));
      this._pageSel = new Set([i]);
      this._pageSelAnchor = i; // Home/End re-anchor Shift+click ranges like a plain click
      this._renderPagePlan();
      const item = this.elements.pagesPlanGrid.querySelector('.pages-plan-item[data-pi="' + i + '"]');
      if (item && item.scrollIntoView) item.scrollIntoView({ block: "nearest" });
    },

    /** Shift+↓ / Shift+↑ / Shift+Home / Shift+End: extend OR SHRINK the
        staged-page selection — the keyboard twin of Shift+click, using the
        file-manager anchor/focus model. The first press of a sequence fixes
        the BASE end (the selection edge opposite the travel direction) and a
        tracked FOCUS end moves one step per press (or straight to the
        document boundary with Home/End), so the selection is always the
        contiguous [base, focus] range. Reversing direction therefore
        RETRACTS toward the base — the range shrinks instead of only growing —
        and keeps going past it to grow the other side, exactly like
        Shift+arrow in Explorer or a text editor. The sequence self-heals:
        any selection that isn't exactly the tracked [base, focus] range (a
        plain click, Ctrl+A, invert, a drag, an applied plan…) invalidates
        it, and the next press re-anchors from the current selection's edges.
        With no selection the first press anchors at the page in the travel
        direction (first for ↓/Home, last for ↑/End). Selection-only: the
        plan is never mutated, so no undo snapshot is needed. */
    _extendPageSelection(step) {
      const plan = this._pagePlan;
      if (!plan || !plan.length) return;
      const n = plan.length;
      const sel = this._pageSel;
      const has = !!sel && sel.size > 0;
      const b = this._pageSelBase, f = this._pageSelFocus;
      // the tracked sequence is only valid while the selection IS exactly the
      // contiguous [base, focus] range — anything else means a click / select
      // / apply happened, so the next press re-anchors from the current state
      const valid = b !== null && f !== null && b >= 0 && b < n && f >= 0 && f < n &&
        has && sel.size === Math.abs(b - f) + 1 &&
        sel.has(Math.min(b, f)) && sel.has(Math.max(b, f));
      let base, focus;
      if (valid) { base = b; focus = f; }
      else if (has) {
        // fresh sequence from a selection: the base is the edge OPPOSITE the
        // travel direction, the focus the edge in it — the first press then
        // extends by one, and every later press retracts or grows from focus
        base = (step === 1 || step === "end") ? Math.min(...sel) : Math.max(...sel);
        focus = (step === 1 || step === "end") ? Math.max(...sel) : Math.min(...sel);
      } else {
        // no selection: the first press just anchors at the direction's edge
        base = focus = (step === -1 || step === "end") ? n - 1 : 0;
        this._pageSelBase = base;
        this._pageSelFocus = focus;
        this._pageSel = new Set([base]);
        this._pageSelAnchor = base;
        this._renderPagePlan();
        const hit = this.elements.pagesPlanGrid.querySelector('.pages-plan-item[data-pi="' + base + '"]');
        if (hit && hit.scrollIntoView) hit.scrollIntoView({ block: "nearest" });
        return;
      }
      if (step === 1) focus = Math.min(n - 1, focus + 1);
      else if (step === -1) focus = Math.max(0, focus - 1);
      else if (step === "end") focus = n - 1;
      else focus = 0; // "start"
      const nlo = Math.min(base, focus), nhi = Math.max(base, focus);
      const size = nhi - nlo + 1;
      const same = sel && sel.size === size && sel.has(nlo) && sel.has(nhi);
      this._pageSelBase = base;
      this._pageSelFocus = focus;
      if (same) return; // focus didn't move (boundary clamp) — no churn
      const next = new Set();
      for (let k = nlo; k <= nhi; k++) next.add(k);
      this._pageSel = next;
      // the moved (focus) edge anchors the next Shift+click range, matching
      // the click model's "the far end anchors the next range" convention
      this._pageSelAnchor = focus;
      this._renderPagePlan();
      const moved = this.elements.pagesPlanGrid.querySelector('.pages-plan-item[data-pi="' + focus + '"]');
      if (moved && moved.scrollIntoView) moved.scrollIntoView({ block: "nearest" });
    },

    /** Ctrl+A: select every staged page at once (the plan is never touched,
        so no undo snapshot is needed). The anchor moves to the first page so
        a subsequent Shift+click extends from there. */
    _selectAllPages() {
      const plan = this._pagePlan;
      if (!plan || !plan.length) return;
      this._pageSel = new Set(plan.map((_, i) => i));
      this._pageSelAnchor = 0;
      this._renderPagePlan();
    },

    /** 'Select annotated' quick action: select every doc page that carries
        annotations in the CURRENT document — exactly the set the Delete
        confirm warns about and the badges surface, so a cleanup flow reads
        "Select annotated → Delete" with no surprises. Blank and inserted
        pages never carry annotations here (the source file's annotations
        stay with the source), so they're excluded. */
    _selectAnnotatedPages() {
      const plan = this._pagePlan;
      if (!plan || !plan.length) return;
      const list = (Volt.Ann && Volt.Ann.list) || [];
      const idx = [];
      plan.forEach((e, i) => {
        if (e && e.kind === "doc" && list.some((a) => a.page === e.oldPage)) idx.push(i);
      });
      if (!idx.length) {
        this.toast("No annotated pages in this document");
        return;
      }
      this._pageSel = new Set(idx);
      this._pageSelAnchor = idx[0];
      this._renderPagePlan();
      this.toast("Selected " + idx.length + " annotated page" + (idx.length === 1 ? "" : "s"), "ok");
    },

    /** 'Clear highlights on selected': run clearHighlights() scoped to the
        selected DOC pages — the range-twin of the conversion toast's
        page-scoped clear, so a cleanup flow ("Select annotated → Clear hl")
        removes only the marks on the pages you picked while the rest of the
        document keeps its highlights. Blank/inserted pages map to no source
        page and are skipped. One grouped undo (Ctrl+Z in the main viewer)
        restores everything. */
    _clearHighlightsOnSelected() {
      const plan = this._pagePlan;
      if (!plan || !this._pageSel || !this._pageSel.size) {
        this.toast("Select the pages whose highlights to clear first");
        return;
      }
      const pages = [];
      plan.forEach((e, i) => {
        if (e && e.kind === "doc" && this._pageSel.has(i)) pages.push(e.oldPage);
      });
      const ann = Volt.Ann;
      if (ann && ann.clearHighlights) ann.clearHighlights(pages);
    },

    /** Invert the selection: every unselected page becomes selected and every
        selected page is deselected — pick the pages to KEEP, hit Invert, and
        everything else is selected for Delete in one click (the complement of
        'Select annotated' is the classic cleanup flow: keep these, delete the
        rest). Selection-only, so no undo snapshot is needed; the anchor moves
        to the lowest newly-selected page so a following Shift+click extends
        from there. An empty result clears the selection (deselect-all). */
    _invertPageSelection() {
      const plan = this._pagePlan;
      if (!plan || !plan.length) return;
      const was = this._pageSel || new Set();
      const inv = [];
      plan.forEach((_, i) => { if (!was.has(i)) inv.push(i); });
      this._pageSel = new Set(inv);
      this._pageSelAnchor = inv.length ? inv[0] : null;
      this._renderPagePlan();
      if (inv.length) this.toast("Inverted selection — " + inv.length + " of " + plan.length + " pages selected", "ok");
      else this.toast("Inverted selection — nothing selected");
    },

    _updatePagesSelInfo() {
      const plan = this._pagePlan || [];
      const sel = this._pageSel ? [...this._pageSel].sort((a, b) => a - b) : [];
      const base = sel.length
        ? sel.length + " of " + plan.length + " pages selected"
        : "Click to select · Shift+click a range · drag to reorder · Ctrl+A selects all · Ctrl+I inverts";
      // surface the staged-undo shortcut right where the user is looking,
      // state-aware: name undo/redo only when they're actually available,
      // and teach the key when nothing is staged yet
      const undoable = this._pageUndo.length > 0;
      const redoable = this._pageRedo.length > 0;
      const hint = undoable && redoable
        ? " · Ctrl+Z undo · Ctrl+Shift+Z redo"
        : undoable
          ? " · Ctrl+Z undo"
          : redoable
            ? " · Ctrl+Shift+Z redo"
            : " · Ctrl+Z undoes edits";
      this.elements.pagesSelInfo.textContent = base + hint;
      this.elements.pagesEditNote.textContent = sel.length
        ? "Selection: " + sel.map((i) => i + 1).join(", ")
        : "";
    },

    /** Append a blank page, sized like the selected doc page (or the last one). */
    _addBlankPage() {
      const plan = this._pagePlan;
      if (!plan) return;
      let ref = null;
      if (this._pageSel && this._pageSel.size === 1) {
        const e = plan[[...this._pageSel][0]];
        if (e && e.kind === "doc") ref = e.oldPage;
      }
      if (ref === null) {
        for (let i = plan.length - 1; i >= 0; i--) {
          if (plan[i].kind === "doc") { ref = plan[i].oldPage; break; }
        }
      }
      let w = 612, h = 792; // US Letter
      if (ref) {
        const d = this.pageDims[ref - 1];
        if (d) { w = d.w; h = d.h; }
      }
      this._snapshotPagePlan(); // pre-blank plan + selection
      plan.push({ kind: "blank", w, h });
      this._renderPagePlan();
    },

    /** Move the selected pages up (-1) or down (+1) — each selected page swaps
        with its neighbor in the travel direction (gaps preserved; selection
        follows the moved pages). */
    _moveSelected(dir) {
      const plan = this._pagePlan;
      if (!plan) return;
      const sel = this._pageSel ? [...this._pageSel].sort((a, b) => a - b) : [];
      if (!sel.length) { this.toast("Select pages first"); return; }
      const n = plan.length;
      const newPlan = plan.slice();
      const order = dir === -1 ? sel : [...sel].reverse();
      let moved = false;
      for (const i of order) {
        const j = i + dir;
        if (j < 0 || j >= n) continue; // at the edge — can't move this one
        const t = newPlan[j];
        newPlan[j] = newPlan[i];
        newPlan[i] = t;
        moved = true;
      }
      if (!moved) return;
      this._snapshotPagePlan(); // pre-move plan + selection
      this._pagePlan = newPlan;
      this._pageSel = new Set(sel.map((i) => {
        const j = i + dir;
        return (j >= 0 && j < n) ? j : i; // edge-blocked pages keep their index
      }));
      this._renderPagePlan();
    },

    /** Move the selected pages as a block so it STARTS at 1-based position
        `pos` in the resulting plan (1 = first, plan.length = last). Clamped;
        a no-op when the order wouldn't change. Undoable like every edit. */
    _moveSelectedTo(pos) {
      const plan = this._pagePlan;
      if (!plan) return;
      const sel = this._pageSel ? [...this._pageSel].sort((a, b) => a - b) : [];
      if (!sel.length) { this.toast("Select pages first"); return; }
      const n = plan.length;
      const target = Utils.clampPage(pos, n);
      const insertAt = Math.max(0, Math.min(n - sel.length, target - 1));
      const entries = sel.map((i) => plan[i]);
      const newPlan = plan.filter((_, i) => !this._pageSel.has(i));
      newPlan.splice(insertAt, 0, ...entries);
      const unchanged = newPlan.length === plan.length && newPlan.every((en, i) => en === plan[i]);
      if (unchanged) return; // already there
      this._snapshotPagePlan();
      this._pagePlan = newPlan;
      this._pageSel = new Set(Array.from({ length: sel.length }, (_, k) => insertAt + k));
      this._renderPagePlan();
    },

    /* ── move-to-position inline form (long documents) ── */
    _showMoveForm() {
      const el = this.elements;
      this._hidePagesInsertForm(); // one inline form at a time
      // the form speaks the drag-drop indicator's language: a plain position
      // ("3"), relative to a specific page ("before 4" / "after 2"), or a
      // comma-separated placement ("1,3,5") for one-position-per-page moves
      el.pagesMoveHint.textContent = "3 · before 4 · after 2 · list 1,3,5";
      const firstSel = this._pageSel && this._pageSel.size ? [...this._pageSel][0] + 1 : 1;
      el.pagesMovePos.value = String(Math.min(firstSel, (this._pagePlan || []).length));
      el.pagesMoveForm.hidden = false;
      el.pagesMovePos.focus();
      el.pagesMovePos.select();
    },

    _hideMoveForm() {
      this.elements.pagesMoveForm.hidden = true;
    },

    _confirmMove() {
      const el = this.elements;
      const raw = el.pagesMovePos.value.trim();
      const n = (this._pagePlan || []).length;
      const spec = Utils.parseMoveTargets(raw, n);
      if (!spec) {
        this.toast("Enter a position 1-" + n + " — e.g. 3, before 4, after 2, or a list like 1,3", "error");
        return; // keep the form open for correction
      }
      if (spec.kind === "block") {
        this._moveSelectedTo(spec.pos); // N / before N / after N — whole block
      } else {
        const selCount = this._pageSel ? this._pageSel.size : 0;
        if (!selCount) { this.toast("Select pages first"); return; }
        if (spec.targets.length !== selCount) {
          this.toast(spec.targets.length + " position" + (spec.targets.length === 1 ? "" : "s") +
            " for " + selCount + " selected page" + (selCount === 1 ? "" : "s") + " — one position per page", "error");
          return; // keep the form open for correction
        }
        this._moveSelectedToTargets(spec.targets);
      }
      this._hideMoveForm();
    },

    /** Place each selected page at its given 1-based position (the move
        form's comma-separated mode — "3,1" sends the first selected page to
        position 3, the second to position 1). targets.length must equal the
        selection size; positions are distinct and in range (parser-validated).
        The other pages keep their relative order in the remaining slots.
        Undoable like every edit. */
    _moveSelectedToTargets(targets) {
      const plan = this._pagePlan;
      if (!plan || !Array.isArray(targets)) return;
      const sel = this._pageSel ? [...this._pageSel].sort((a, b) => a - b) : [];
      if (!sel.length) { this.toast("Select pages first"); return; }
      if (targets.length !== sel.length) return; // caller validates + explains
      const n = plan.length;
      const entries = sel.map((i) => plan[i]);
      const rest = plan.filter((_, i) => !this._pageSel.has(i));
      // final arrangement: each selected entry owns its target slot; the
      // remaining pages fill the other slots in their original relative order
      const result = new Array(n).fill(null);
      for (let k = 0; k < targets.length; k++) result[targets[k] - 1] = entries[k];
      let r = 0;
      for (let i = 0; i < n; i++) if (result[i] === null) result[i] = rest[r++];
      const unchanged = result.every((en, i) => en === plan[i]);
      if (unchanged) return; // already there — no churn, no snapshot
      this._snapshotPagePlan();
      this._pagePlan = result;
      this._pageSel = new Set(targets.map((t) => t - 1));
      this._renderPagePlan();
    },

    /** Selected DOC pages that carry annotations — the loss a Delete would
        silently cause. The per-thumbnail badge already surfaces it; the
        delete confirm makes it explicit before staging. Blank/inserted pages
        are new pages and never carry annotations. */
    _countAnnotatedSelected() {
      const plan = this._pagePlan;
      if (!plan || !this._pageSel) return 0;
      const list = (Volt.Ann && Volt.Ann.list) || [];
      let n = 0;
      for (const i of this._pageSel) {
        const e = plan[i];
        if (e && e.kind === "doc" && list.some((a) => a.page === e.oldPage)) n++;
      }
      return n;
    },

    /** Delete gate: selections that carry annotations step through a 3-second
        'Really delete N annotated pages?' confirm (mirrors the AI panel's
        danger-button pattern — the badge already shows what would be lost, so
        one accidental click must not stage it). Selections without annotations
        delete immediately — no ceremony. */
    _deleteSelected() {
      const plan = this._pagePlan;
      if (!plan) return;
      if (!this._pageSel || !this._pageSel.size) { this.toast("Select pages first"); return; }
      if (this._pageConfirmArmed) { // already confirming — this click means yes
        this._disarmPageDeleteConfirm();
        this._stageDeleteSelected();
        return;
      }
      const annotated = this._countAnnotatedSelected();
      if (annotated > 0) {
        this._armPageDeleteConfirm(this.elements.btnPagesDel,
          "Really delete " + annotated + " annotated page" + (annotated === 1 ? "" : "s") + "?");
        return;
      }
      this._stageDeleteSelected();
    },

    _stageDeleteSelected() {
      const plan = this._pagePlan;
      const sel = this._pageSel;
      const deleted = sel.size;
      this._snapshotPagePlan(); // pre-delete plan + selection
      this._pagePlan = plan.filter((_, i) => !sel.has(i));
      this._pageSel = new Set();
      this._renderPagePlan();
      this.toast("Staged " + deleted + " page" + (deleted === 1 ? "" : "s") + " for deletion — Apply & save to write the new PDF", "ok");
    },

    _armPageDeleteConfirm(btn, label) {
      this._disarmPageDeleteConfirm(); // only one danger button armed at a time
      btn.dataset.origLabel = btn.textContent;
      btn.dataset.armed = "1";
      btn.textContent = label;
      btn.classList.remove("danger");
      btn.classList.add("armed");
      this._pageConfirmArmed = {
        btn,
        timer: setTimeout(() => this._disarmPageDeleteConfirm(), 3000),
      };
    },

    _disarmPageDeleteConfirm() {
      const a = this._pageConfirmArmed;
      this._pageConfirmArmed = null;
      if (!a) return;
      clearTimeout(a.timer);
      if (a.btn.dataset.armed === "1") {
        delete a.btn.dataset.armed;
        a.btn.textContent = a.btn.dataset.origLabel;
        a.btn.classList.add("danger");
      }
      delete a.btn.dataset.origLabel;
      a.btn.classList.remove("armed");
    },

    /** Pick another PDF: parse it (pdf-lib, for the page count) and show the
        inline page-range + position form. */
    async _beginInsertPdf(file) {
      try {
        const buf = await Utils.fileToBuffer(file);
        const { PDFDocument } = global.PDFLib;
        const d = await PDFDocument.load(buf, { ignoreEncryption: true });
        const count = d.getPageCount();
        if (!count) { this.toast("That PDF has no pages", "error"); return; }
        this._insertBytes = buf;
        this._insertCount = count;
        this._insertName = file.name || "inserted.pdf";
        this._otherPdfId++; // new file → fresh per-file doc cache key
        this._insertFid = this._otherPdfId;
        // the source PDF's OWN annotations (if it was ever opened and
        // annotated in Volt): read them now under the same identity key the
        // app uses for the open document, so each inserted "from …" page can
        // show how many annotations its source page carries. Static within
        // this manager session — the plan can't outlive it.
        const srcKey = "volt:ann:" + Utils.hash(file.name + ":" + buf.byteLength + ":" + count);
        let srcAnns = [];
        try { const raw = localStorage.getItem(srcKey); if (raw) srcAnns = JSON.parse(raw); } catch (e) { srcAnns = []; }
        this._otherAnns.set(this._insertFid, srcAnns);
        this.elements.pagesInsertInfo.textContent = file.name + " — " + count + (count === 1 ? " page" : " pages");
        this.elements.pagesInsertRange.value = "all";
        this._fillPagesPosSelect();
        this.elements.pagesInsertForm.hidden = false;
        this.elements.pagesInsertRange.focus();
      } catch (e) {
        this.toast("Could not read that PDF: " + (e.message || e), "error");
      }
    },

    _fillPagesPosSelect() {
      const sel = this.elements.pagesInsertPos;
      const n = (this._pagePlan || []).length;
      const opts = [["0", "At the very start"]];
      for (let i = 1; i <= n; i++) opts.push([String(i), "After page " + i]);
      opts.push([String(n + 1), "At the very end"]);
      sel.innerHTML = opts.map(([v, l]) => `<option value="${v}">${l}</option>`).join("");
      sel.value = String(n + 1); // default: append at the end
    },

    _confirmInsertPdf() {
      const range = Utils.parsePageRange(this.elements.pagesInsertRange.value, this._insertCount);
      if (!range) { this.toast("Invalid page range — try e.g. \"1-3, 5\" or \"all\"", "error"); return; }
      const pos = parseInt(this.elements.pagesInsertPos.value, 10);
      const entries = range.map((p) => ({
        kind: "other", bytes: this._insertBytes, page: p, name: this._insertName, fid: this._insertFid,
      }));
      const plan = this._pagePlan.slice();
      plan.splice(pos, 0, ...entries);
      this._snapshotPagePlan(); // pre-insert plan + selection
      this._pagePlan = plan;
      this._pageSel = new Set();
      this._hidePagesInsertForm();
      this._insertBytes = null;
      this._insertCount = 0;
      this._insertName = "";
      this._renderPagePlan();
      this.toast("Staged " + entries.length + " page" + (entries.length === 1 ? "" : "s") + " from " + entries[0].name, "ok");
    },

    /** Build + download a NEW PDF from just the selected pages (no doc change). */
    /** The actual document pages (1-based, in the plan's order) covered by the
        Pages manager's current selection — for the office exports (docx/xlsx/
        pptx/tsv), which read the OPEN document rather than the staged plan.
        Returns { pages, skipped } or null (no live selection / covers the
        whole document / belongs to a different document).
        - The plan is kept after an Escape-close, so a selection made in the
          manager can drive an export afterwards; it is cleared by Cancel,
          Apply, or reopening the manager, and _pagePlanDoc guards against a
          selection left over from a DIFFERENT document (a normal open doesn't
          reset the manager).
        - Staged insertions (blank / from-other-PDF pages) don't exist in the
          open document, so they are counted in `skipped` and dropped; a
          selection with nothing exportable returns null (whole document). */
    _pagesSelectedForExport() {
      const plan = this._pagePlan, sel = this._pageSel;
      if (!Array.isArray(plan) || !plan.length || !sel || !sel.size) return null;
      if (this._pagePlanDoc !== this.currentDoc) return null; // stale plan
      const n = this.currentDoc ? this.currentDoc.numPages : 0;
      if (!n) return null;
      const pages = [], seen = new Set();
      let skipped = 0;
      for (let i = 0; i < plan.length; i++) {
        if (!sel.has(i)) continue;
        const e = plan[i];
        if (e && e.kind === "doc" && e.oldPage >= 1 && e.oldPage <= n) {
          if (!seen.has(e.oldPage)) { seen.add(e.oldPage); pages.push(e.oldPage); }
        } else {
          skipped++; // staged insertion — not in the open document
        }
      }
      if (!pages.length) return null;
      // a whole-document selection is just the normal export — no filter
      if (pages.length === n && pages.slice().sort((a, b) => a - b).every((p, i) => p === i + 1)) return null;
      return { pages, skipped };
    },

    /** Human label for an export scope: "" for the whole document (no page
        list needed — the toast stays as before), "pages 2, 3" for a live
        Pages-manager selection, plus a note when staged insertions had to be
        skipped. error = true swaps the whole-doc label for the error toasts
        ("in the whole document"). */
    _officeExportScope(sel, error) {
      if (!sel) return error ? "the whole document" : "";
      let s = "pages " + sel.pages.join(", ");
      if (sel.skipped) s += " (" + sel.skipped + " inserted page" + (sel.skipped === 1 ? "" : "s") + " not in the open file)";
      return s;
    },

    /** 'Open with…' toast action for a freshly exported office file: hands the
        bytes to the OS default handler (Word/Excel/PowerPoint) through the
        desktop bridge, which writes them to a temp file and opens it — the
        same as double-clicking the file in Explorer. Returns null outside the
        desktop app, so the PWA keeps the plain toast (no shell to open with). */
    _openWithAction(bytes, fileName) {
      if (!(global.voltDesktop && typeof global.voltDesktop.openWith === "function")) return null;
      return {
        label: "Open with…",
        onClick: async () => {
          try {
            const r = await global.voltDesktop.openWith(fileName, bytes);
            if (r && r.ok) this.toast("Opened " + fileName + " with your default handler", "ok");
            else this.toast("Couldn't open " + fileName + " — no default handler for it?", "error");
          } catch (e) {
            this.toast("Couldn't open " + fileName + " — " + ((e && e.message) || e), "error");
          }
        },
      };
    },

    async _exportSelectedPages() {
      const sel = this._pageSel ? [...this._pageSel].sort((a, b) => a - b) : [];
      if (!sel.length) { this.toast("Select pages first"); return; }
      const plan = sel.map((i) => this._pagePlan[i]);
      try {
        const bytes = await Volt.Ann.buildEditedPdf(plan);
        const base = Utils.stripPdfExt(this.currentDocInfo?.name || "document");
        Utils.download(new Blob([bytes], { type: "application/pdf" }), base + "-pages-" + plan.length + ".pdf");
        this.toast("New PDF from " + plan.length + " page" + (plan.length === 1 ? "" : "s") + " exported", "ok");
      } catch (e) {
        this.toast("Export failed: " + (e.message || e), "error");
      }
    },

    /** Apply & save: rebuild the PDF from the staged plan, download it, and
        open the result in the viewer — annotations renumber to their pages'
        new positions (deleted pages' annotations are dropped), and the rest of
        the per-doc state (AI overrides, chat, zoom, rotation, scroll) carries
        over exactly like a disk reload.
        skipDownload is an internal hook the smoke probe uses to validate the
        apply path without dropping a file into the user's Downloads folder. */
    async _applyPagePlan(skipDownload) {
      const plan = this._pagePlan;
      if (!Array.isArray(plan) || !plan.length) { this.toast("Nothing to apply", "error"); return; }
      try {
        const bytes = await Volt.Ann.buildEditedPdf(plan);
        const base = Utils.stripPdfExt(this.currentDocInfo?.name || "document");
        if (!skipDownload) {
          Utils.download(new Blob([bytes], { type: "application/pdf" }), base + "-edited.pdf");
        }
        await this._openRebuiltPdf(plan, bytes, base + "-edited.pdf",
          "Edited PDF saved & opened — " + plan.length + " pages, annotations carried over");
      } catch (e) {
        this._restoreState = null;
        this.toast("Apply failed: " + (e.message || e), "error");
      }
    },

    /** Shared rebuild core (the manager's Apply and the sidebar's drag-reorder
        both commit through here): open a pdf-lib-rebuilt PDF (pre-built by the
        caller) in the viewer — annotations renumber to their pages' new
        positions (pages absent from the map were deleted), and the rest of the
        per-doc state (AI overrides, chat, zoom, rotation, scroll) carries over
        exactly like a disk reload.
        diskPath: when set (the sidebar reorder of a file opened from disk),
        the rebuilt bytes are written BACK to that path first and the file is
        reopened from disk — so the edit persists, the file-watch stays live,
        and the identity/name are the on-disk ones. Without a write bridge
        (browser/PWA), it degrades to the in-memory open + an informational
        toast (the page manager's Apply still downloads a new file either way). */
    async _openRebuiltPdf(plan, bytes, name, toastMsg, action, diskPath) {
      // old page → new page (1-based among ALL output pages)
      const map = {};
      let pos = 0;
      for (const e of plan) { pos++; if (e.kind === "doc") map[e.oldPage] = pos; }
      const s = this._captureDocState();
      if (s && Array.isArray(s.ann)) s.ann = Utils.remapAnnotations(s.ann, map);
      this._restoreState = s;
      this._resetPageManager();
      this._closeModal(this.elements.pagesModal);
      let ok = false;
      if (diskPath && global.voltDesktop && typeof global.voltDesktop.writeFile === "function") {
        // unwatch before the write so the watcher can't fire on OUR change
        // (the watch loop's reload offer is for the AUTHOR's edits, not ours)
        if (typeof global.voltDesktop.unwatchFile === "function") {
          await global.voltDesktop.unwatchFile().catch(() => {});
        }
        try {
          await global.voltDesktop.writeFile(diskPath, bytes);
          // reopen FROM the path: the name/identity are the on-disk ones, the
          // file-watch re-arms (openPath → _syncFileWatch), and the rebuilt
          // doc is exactly what is now on disk — no in-memory drift
          this.currentPath = diskPath;
          await this.openPath(diskPath);
          ok = !!this.currentDoc;
        } catch (e) {
          this._restoreState = null;
          this.currentPath = null;
          this.toast("Couldn't write the reorder back to disk — opened in memory instead: " + (e.message || e), "error", true);
          ok = await this.openBuffer(bytes, name, bytes.byteLength);
        }
      } else {
        this.currentPath = null; // the rebuilt doc is in-memory — nothing to watch
        ok = await this.openBuffer(bytes, name, bytes.byteLength);
      }
      if (ok) {
        // returns the toast element so the sidebar reorder can track its
        // 'Undo reorder' action (dismissed when a newer doc supersedes it)
        return action ? this.toast(toastMsg, "ok", false, action) : this.toast(toastMsg, "ok");
      }
      this._restoreState = null; // a failed open must never leak captured state
      return null;
    },

    /** The page order that would result from moving a drag set before/after
        the target — shared by the live drag preview pill, the drop's confirm
        toast, and the commit itself. Pure: never touches the document. */
    _computeThumbOrder(dragSet, targetPage, pos) {
      const doc = this.currentDoc;
      if (!doc) return null;
      const n = doc.numPages;
      const dragged = [...dragSet].sort((a, b) => a - b);
      // the insertion slot is how many NON-dragged pages precede the target
      // in the original order (plus 1 after). Counting non-dragged pages —
      // not `base - dragged before base` — is what makes a block that
      // straddles the target land right (e.g. {1,3} before page 2 must yield
      // [1,3,2], not [2,1,3]).
      let insertAt = 0;
      for (let p = 1; p < targetPage; p++) if (!dragSet.has(p)) insertAt++;
      if (pos === "after") insertAt++;
      const order = [];
      for (let p = 1; p <= n; p++) if (!dragSet.has(p)) order.push(p);
      order.splice(insertAt, 0, ...dragged);
      return order;
    },

    /* ── sidebar drag-reorder (direct page-order change) ───────
       A drop does NOT rebuild the document — it arms a confirm toast that
       PREVIEWS the would-be page order ("1 → 3 → 2"): clicking Apply runs
       this commit (same machinery as the manager's Apply — annotations
       remap, scroll/zoom carry over), Cancel or 8s of inaction leaves the
       document untouched, and the commit offers an 'Undo reorder' toast
       that restores the pre-reorder bytes + state. */
    async _reorderFromThumbs(dragPage, dragSet, targetPage, pos) {
      const doc = this.currentDoc;
      if (!doc) return;
      const set = dragSet && dragSet.size ? dragSet : new Set([dragPage]);
      const order = this._computeThumbOrder(set, targetPage, pos);
      if (!order || order.every((p, i) => p === i + 1)) { this.toast("Pages already in that order"); return; }
      // the drop handler already cleared _thumbSel (the old page numbers are
      // dead) — the block is re-derived from the drag set that committed;
      // keep the selection only for a multi-page block (drag semantics)
      await this._commitThumbOrder(set, order, set.size > 1);
    },

    /** The shared commit behind EVERY sidebar reorder — the drag's confirm
        toast AND the keyboard/menu block move (_moveThumbBlockTo). Snapshot
        the pre-reorder document, rebuild the PDF, reopen it (disk-persisted
        when the doc has a path), offer 'Undo reorder', and remap the block
        selection to its new positions. keepSel: whether _thumbSel survives
        (multi-page drags, and all keyboard/menu moves — a single selected
        thumb stays selected so it can be moved again). */
    async _commitThumbOrder(set, order, keepSel) {
      const doc = this.currentDoc;
      const info = this.currentDocInfo;
      if (!doc || !info) return;
      const n = doc.numPages;
      const dragged = [...set].sort((a, b) => a - b);
      // path: when the commit wrote the rebuilt doc back to disk, the undo
      // writes the original bytes back to that SAME path (a disk-persisted
      // reorder must be undone on disk too, not just in memory).
      const undo = {
        bytes: this.currentDocBytes ? this.currentDocBytes.slice(0) : null,
        name: info.name,
        size: info.size,
        path: this.currentPath || null,
        state: this._captureDocState(),
      };
      const plan = order.map((p) => ({ kind: "doc", oldPage: p }));
      try {
        const bytes = await Volt.Ann.buildEditedPdf(plan);
        // the single success toast carries the undo action; arm the undo ONLY
        // after the open actually succeeded (a failed open must not offer it)
        // When the PDF came from disk (currentPath), pass it through so the
        // rebuilt file is written back to that same path — the reorder then
        // persists on disk, not just in memory.
        const t = await this._openRebuiltPdf(plan, bytes, info.name,
          "Pages reordered — " + n + " pages, annotations carried over",
          { label: "Undo reorder", onClick: () => this._undoThumbReorder() },
          this.currentPath || undefined);
        this._reorderUndo = undo;
        this._reorderUndoToastEl = t;
        if (keepSel) {
          // remap the multi-selection to the block's NEW positions so the
          // moved pages stay highlighted in the rebuilt sidebar. order is
          // 1-based page numbers; the selection is a Set of PAGE numbers (the
          // thumbs' data-page), so +1 converts the 0-based slot. The classes
          // are NOT applied here: _openRebuiltPdf re-rendered the sidebar,
          // and _renderThumbs is async — it applies the pending selection
          // once the new thumbs exist (see _renderThumbs).
          const first = order.indexOf(dragged[0]) + 1;
          this._thumbSel = new Set(Array.from({ length: dragged.length }, (_, k) => first + k));
          this._thumbSelAnchor = first; // the block's first page anchors the next range
        } else {
          this._thumbSel = null;
          this._thumbSelAnchor = null;
        }
      } catch (e) {
        this._restoreState = null;
        this.toast("Reorder failed: " + (e.message || e), "error");
      }
    },

    /** Move the selected sidebar block so it STARTS at 1-based position `pos`
        (1 = first; "last" = the last slot the block fits). Mirrors the
        manager's _moveSelectedTo but commits DIRECTLY (no staged plan): the
        rebuilt doc opens with 'Undo reorder', so a mistyped position costs
        one click. Returns true when a selection existed (whether or not the
        order changed). */
    async _moveThumbBlockTo(pos) {
      const sel = this._thumbSel;
      const doc = this.currentDoc;
      if (!doc || !sel || !sel.size) return false;
      const n = doc.numPages;
      const set = new Set(sel);
      const dragged = [...set].sort((a, b) => a - b);
      const maxStart = n - dragged.length + 1;
      const target = pos === "last" ? maxStart : Utils.clampPage(pos, maxStart);
      // the block occupies [target, target+len); every non-dragged page keeps
      // its relative order in the remaining slots — same rule as the manager
      const rest = [];
      for (let p = 1; p <= n; p++) if (!set.has(p)) rest.push(p);
      const insertAt = Math.max(0, Math.min(rest.length, target - 1));
      const order = [...rest.slice(0, insertAt), ...dragged, ...rest.slice(insertAt)];
      if (order.every((p, i) => p === i + 1)) { this.toast("Pages already in that order"); return true; }
      // keyboard/menu moves keep the selection (single pages included) so the
      // block can be moved again without re-selecting
      await this._commitThumbOrder(set, order, true);
      return true;
    },

    /** The drop's confirm step: a toast previewing the would-be page order
        with Apply / Cancel. The document is NOT rebuilt until Apply is
        clicked; 8s of inaction (or Cancel) discards the pending reorder. */
    _confirmThumbReorder(dragPage, dragSet, targetPage, pos) {
      const order = this._computeThumbOrder(dragSet, targetPage, pos);
      if (!order || order.every((p, i) => p === i + 1)) return;
      this._thumbReorderPending = { dragPage, dragSet, targetPage, pos };
      const preview = order.join(" → ");
      const t = document.createElement("div");
      t.className = "toast reorder-confirm";
      t.textContent = "New page order: " + preview + " — apply?";
      const apply = document.createElement("button");
      apply.type = "button";
      apply.className = "toast-action armed";
      apply.textContent = "Apply";
      apply.addEventListener("click", () => {
        clearTimeout(t._timer);
        // NOTE: the pending params live in this CLOSURE — the drop's
        // _clearThumbDrag() nulls the instance field, but Apply must still
        // commit the exact drop that armed this toast
        this._thumbReorderPending = null;
        t.style.opacity = "0"; t.style.transform = "translateY(6px)"; t.style.transition = "all .3s";
        setTimeout(() => t.remove(), 320);
        this._reorderFromThumbs(dragPage, dragSet, targetPage, pos);
      });
      t.appendChild(apply);
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "toast-action";
      cancel.textContent = "Cancel";
      cancel.addEventListener("click", () => {
        clearTimeout(t._timer);
        this._thumbReorderPending = null;
        t.style.opacity = "0"; t.style.transform = "translateY(6px)"; t.style.transition = "all .3s";
        setTimeout(() => t.remove(), 320);
      });
      t.appendChild(cancel);
      this.elements.toasts.appendChild(t);
      const dismiss = () => {
        if (this._thumbReorderPending) this._thumbReorderPending = null;
        t.style.opacity = "0"; t.style.transform = "translateY(6px)"; t.style.transition = "all .3s";
        setTimeout(() => t.remove(), 320);
      };
      t._timer = setTimeout(dismiss, 8000); // actionable toast — longer lifetime
    },

    /** The live drag preview: a small pill near the drop target showing the
        WOULD-BE page order for this drop, so the order is visible BEFORE the
        drop (the confirm toast repeats it after). */
    _showThumbDragPreview(order, x, y) {
      let pill = this._thumbDragPreview;
      if (!pill) {
        pill = document.createElement("div");
        pill.className = "thumb-drag-preview";
        document.body.appendChild(pill);
        this._thumbDragPreview = pill;
      }
      pill.textContent = order.join(" → ");
      // float just above the cursor so the order is readable while hovering
      pill.style.left = (x + 14) + "px";
      pill.style.top = (y - 30) + "px";
    },
    _clearThumbDragPreview() {
      if (this._thumbDragPreview) {
        this._thumbDragPreview.remove();
        this._thumbDragPreview = null;
      }
    },

    /** Mirror the manager's .sel affordance on the sidebar thumbs — Shift+click
        toggles membership; dragging a selected thumb moves the whole block.
        Also drives the block-action row (First / Last / Move to… / Clear):
        it appears exactly when a block is selected, and any empty selection
        hides it (and the move form) again. */
    _applyThumbSel() {
      const grid = this.elements.thumbGrid;
      if (!grid) return;
      const hasSel = !!this._thumbSel && this._thumbSel.size > 0;
      for (const it of grid.querySelectorAll(".thumb-item")) {
        const page = parseInt(it.dataset.page, 10);
        it.classList.toggle("sel", hasSel && this._thumbSel.has(page));
      }
      const row = this.elements.thumbBlockActions;
      if (row) row.hidden = !hasSel;
      if (!hasSel) this._hideThumbMoveForm();
    },

    /** Shift+↓ / Shift+↑ / Shift+Home / Shift+End on the sidebar's page
        thumbnails: keyboard-only multi-select with the SAME anchor/focus
        model as the manager's grid — the first press fixes the BASE edge,
        a tracked FOCUS edge moves one page per press (or straight to the
        document boundary with Home/End), and the selection is always the
        contiguous [base, focus] range, so reversing direction retracts
        toward the base and then grows past it. Page numbers (1-based,
        mirroring _extendPageSelection's plan indices); the sequence
        self-heals — any selection that isn't exactly [base, focus] (a
        plain/Ctrl/Shift click, a drag, a rebuild…) re-anchors from the
        current edges. Selection-only: the document is never touched, so
        nothing here is undoable. */
    _extendThumbSelection(step) {
      const doc = this.currentDoc;
      if (!doc || !doc.numPages) return;
      const n = doc.numPages;
      const sel = this._thumbSel;
      const has = !!sel && sel.size > 0;
      const b = this._thumbSelBase, f = this._thumbSelFocus;
      const valid = b !== null && f !== null && b >= 1 && b <= n && f >= 1 && f <= n &&
        has && sel.size === Math.abs(b - f) + 1 &&
        sel.has(Math.min(b, f)) && sel.has(Math.max(b, f));
      let base, focus;
      if (valid) { base = b; focus = f; }
      else if (has) {
        base = (step === 1 || step === "end") ? Math.min(...sel) : Math.max(...sel);
        focus = (step === 1 || step === "end") ? Math.max(...sel) : Math.min(...sel);
      } else {
        base = focus = (step === -1 || step === "end") ? n : 1;
        this._thumbSelBase = base;
        this._thumbSelFocus = focus;
        this._thumbSel = new Set([base]);
        this._thumbSelAnchor = base;
        this._applyThumbSel();
        const hit = this.elements.thumbGrid.querySelector('.thumb-item[data-page="' + base + '"]');
        if (hit && hit.scrollIntoView) hit.scrollIntoView({ block: "nearest" });
        return;
      }
      if (step === 1) focus = Math.min(n, focus + 1);
      else if (step === -1) focus = Math.max(1, focus - 1);
      else if (step === "end") focus = n;
      else focus = 1; // "start"
      const nlo = Math.min(base, focus), nhi = Math.max(base, focus);
      const size = nhi - nlo + 1;
      const same = sel && sel.size === size && sel.has(nlo) && sel.has(nhi);
      this._thumbSelBase = base;
      this._thumbSelFocus = focus;
      if (same) return; // focus didn't move (boundary clamp) — no churn
      const next = new Set();
      for (let k = nlo; k <= nhi; k++) next.add(k);
      this._thumbSel = next;
      // the moved (focus) edge anchors the next Shift+click range
      this._thumbSelAnchor = focus;
      this._applyThumbSel();
      const moved = this.elements.thumbGrid.querySelector('.thumb-item[data-page="' + focus + '"]');
      if (moved && moved.scrollIntoView) moved.scrollIntoView({ block: "nearest" });
    },

    /** 'Select annotated' for the sidebar: select every CURRENT-document page
        that carries annotations — the same set the manager's button picks
        and the Delete confirm warns about — so a cleanup flow works without
        opening the manager. The sidebar's selection model is PAGE NUMBERS
        (not plan indices), so the set is built straight from the annotation
        list, clamped to the open document, and handed to _applyThumbSel,
        which shows the block-actions row (First / Last / Move to… / Clear)
        exactly like a hand-made Shift+click/Ctrl+click selection. */
    _selectAnnotatedThumbs() {
      if (!this.currentDoc) return;
      const list = (Volt.Ann && Volt.Ann.list) || [];
      const pages = new Set();
      for (const a of list) {
        if (a && a.page >= 1 && a.page <= this.currentDoc.numPages) pages.add(a.page);
      }
      if (!pages.size) {
        this.toast("No annotated pages in this document");
        return;
      }
      this._thumbSel = new Set([...pages].sort((a, b) => a - b));
      this._thumbSelAnchor = Math.min(...pages);
      this._applyThumbSel();
      this.toast("Selected " + pages.size + " annotated page" + (pages.size === 1 ? "" : "s"), "ok");
    },

    /* ── sidebar move-to-position form (mirrors the manager's) ── */
    _showThumbMoveForm() {
      const el = this.elements;
      if (!this.currentDoc || !this._thumbSel || !this._thumbSel.size) return;
      // make sure the form is actually visible: sidebar open, Pages tab active
      document.body.classList.remove("sidebar-hidden");
      el.btnSidebar.classList.add("active");
      // switch to the Pages tab EXPLICITLY — a forEach over the tabs would
      // clobber panelPages.hidden on every iteration (the last tab wins),
      // leaving the panel (and with it the move form) hidden
      el.sideTabs.forEach((tab) => tab.classList.toggle("active", tab.dataset.tab === "pages"));
      el.panelPages.hidden = false;
      el.panelOutline.hidden = true;
      el.panelNotes.hidden = true;
      this._renderThumbs();
      // the form speaks the drag-drop indicator's language (like the manager's)
      el.thumbMoveHint.textContent = "3 · before 4 · after 2 — the block starts there";
      const firstSel = Math.min(...this._thumbSel);
      el.thumbMovePos.value = String(Utils.clampPage(firstSel, this.currentDoc.numPages));
      el.thumbMoveForm.hidden = false;
      el.thumbMovePos.focus();
      el.thumbMovePos.select();
    },

    _hideThumbMoveForm() {
      if (this.elements.thumbMoveForm) this.elements.thumbMoveForm.hidden = true;
    },

    _confirmThumbMove() {
      const el = this.elements;
      const n = this.currentDoc ? this.currentDoc.numPages : 0;
      const raw = el.thumbMovePos.value.trim();
      const spec = Utils.parseMoveTargets(raw, n);
      if (!spec) {
        this.toast("Enter a position 1-" + n + " — e.g. 3, before 4, or after 2", "error");
        return; // keep the form open for correction
      }
      if (spec.kind === "list") {
        this.toast("The sidebar moves the whole block — use the Pages manager for one-position-per-page lists", "error");
        return; // keep the form open
      }
      this._hideThumbMoveForm();
      this._moveThumbBlockTo(spec.pos); // N / before N / after N — whole block
    },

    _dismissReorderUndo() {
      const prev = this._reorderUndoToastEl;
      this._reorderUndo = null;
      if (prev) {
        clearTimeout(prev._timer);
        prev.style.opacity = "0"; prev.style.transform = "translateY(6px)"; prev.style.transition = "all .3s";
        setTimeout(() => prev.remove(), 320);
        this._reorderUndoToastEl = null;
      }
    },
    async _undoThumbReorder() {
      const u = this._reorderUndo;
      if (!u || !u.bytes) return;
      this._dismissReorderUndo();
      this._restoreState = u.state; // pre-reorder annotations + AI/chat/view state
      let ok;
      if (u.path && global.voltDesktop && typeof global.voltDesktop.writeFile === "function") {
        // the commit persisted to disk — undo must write the ORIGINAL bytes
        // back to that same path and reopen from it (watcher re-arms)
        if (typeof global.voltDesktop.unwatchFile === "function") {
          await global.voltDesktop.unwatchFile().catch(() => {});
        }
        try {
          await global.voltDesktop.writeFile(u.path, u.bytes);
          this.currentPath = u.path;
          ok = await this.openPath(u.path);
        } catch (e) {
          this.toast("Couldn't restore the file on disk: " + (e.message || e), "error", true);
          ok = await this.openBuffer(u.bytes, u.name, u.size);
        }
      } else {
        ok = await this.openBuffer(u.bytes, u.name, u.size);
      }
      if (ok) this.toast("Reorder undone — original page order restored", "ok");
      else this._restoreState = null; // a failed open must never leak captured state
    },
    _clearThumbDrag() {
      this._thumbDragPage = null;
      this._thumbDragSet = null;
      this._thumbReorderPending = null; // a drag that ends without Apply discards the pending reorder
      this._clearThumbDrop();
      this._clearThumbDragPreview();
      for (const it of this.elements.thumbGrid.querySelectorAll(".thumb-item")) it.classList.remove("dragging");
    },
    _clearThumbDrop() {
      this._thumbDrop = null;
      for (const it of this.elements.thumbGrid.querySelectorAll(".thumb-item")) it.classList.remove("drag-before", "drag-after");
    },

    /* ── modals ────────────────────────────────────────────── */
    _wireModals() {
      const el = this.elements;
      el.helpClose.addEventListener("click", () => this._closeModal(el.helpModal));
      for (const m of [el.helpModal, el.settingsModal, el.urlModal, el.exportModal, el.restoreModal, el.personaModal, el.pagesModal]) {
        m.addEventListener("click", (e) => { if (e.target === m) this._closeModal(m); });
      }
      // focus trap: intercept Tab (capture phase) while a modal is open so
      // focus cycles inside the modal instead of escaping into the app
      window.addEventListener("keydown", (e) => {
        if (e.key === "Tab") this._trapTab(e);
      }, true);
    },

    /* ── modal focus management ───────────────────────────────
       Every modal open/close goes through _openModal/_closeModal so focus
       can't escape: the opener's element is remembered, focus jumps to the
       modal's first focusable, the app UI is made inert while the modal is
       up (Tab/Shift+Tab physically cannot reach it), and focus returns to
       the opener on close. */
    _modals() {
      return [this.elements.helpModal, this.elements.settingsModal, this.elements.urlModal, this.elements.exportModal, this.elements.restoreModal, this.elements.personaModal, this.elements.pagesModal, this.elements.aboutModal];
    },
    _openModalEl() { return this._modals().find((m) => !m.hidden) || null; },
    _focusablesIn(m) {
      // the selector is shared with the unit-tested trap logic (utils.js) —
      // document order is the tab order the trap cycles in
      return [...m.querySelectorAll(Utils.FOCUSABLE_SELECTOR)]
        .filter((el) => !el.disabled && el.getClientRects().length > 0);
    },
    _openModal(m) {
      if (!m || this._openModalEl()) return; // one modal at a time
      if (this._closeMenus) this._closeMenus(); // a toolbar menu must not float over a modal backdrop
      if (global.Volt.AI) { global.Volt.AI._closeDocPopover(); if (global.Volt.AI._closeGlobalPop) global.Volt.AI._closeGlobalPop(); if (global.Volt.AI._hideMarkerTip) global.Volt.AI._hideMarkerTip(); } // never float over a modal backdrop
      if (global.Volt.Ann && global.Volt.Ann._areaMenuOpen) global.Volt.Ann._closeAreaMenu();
      this._hideRestoreSummary(); // a modal outranks a transient status card
      this._lastFocus = document.activeElement;
      m.hidden = false;
      const f = this._focusablesIn(m);
      // first text field when there is one (URL modal), else the first button.
      // Focus the target BEFORE inerting #app — belt and braces: the modals sit
      // outside #app so they are never inerted themselves, but this order keeps
      // focus unambiguous on every code path.
      const target = f.find((el) => el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT") || f[0];
      if (target) target.focus();
      this.elements.app.inert = true; // background unreachable by Tab or click
    },
    _closeModal(m) {
      if (!m || m.hidden) return;
      m.hidden = true;
      this.elements.app.inert = false;
      if (m === this.elements.restoreModal) this._pendingBackup = null; // a dismissed prompt must not auto-apply later
      const back = this._lastFocus;
      this._lastFocus = null;
      if (back && back.isConnected && back.getClientRects().length > 0) {
        try { back.focus(); } catch (e) { /* ignore */ }
      }
    },
    _trapTab(e) {
      const m = this._openModalEl();
      if (!m) { if (this.elements.app.inert) this.elements.app.inert = false; return; } // self-heal, see _wireKeyboard
      const f = this._focusablesIn(m);
      if (!f.length) { e.preventDefault(); return; } // nothing focusable inside — swallow Tab so focus can't leave
      // the wrap decision is pure logic (unit-tested in test-utils.mjs):
      // boundary wrap + re-entry direction, computed from the trap's ordered
      // list and the active element — no DOM in the decision itself
      const active = document.activeElement;
      const target = Utils.focusTrapMove(f, active, {
        shiftKey: e.shiftKey,
        containsActive: m.contains(active),
      });
      if (!target) return; // native Tab continues in document order
      e.preventDefault();
      // The modals live OUTSIDE #app (see index.html), so they are never part
      // of the inert subtree — focusing them works even while the app UI is
      // inert. (A focus() inside an inert ancestor is silently swallowed and
      // Chromium evicts focus to <body> — that bug is why they moved out.)
      target.focus();
    },

    _buildHelp() {
      const rows = [
        ["Open PDF", "Ctrl+O"],
        ["Focus search", "Ctrl+F"],
        ["Next / previous match", "Enter / Shift+Enter"],
        ["Toggle sidebar", "Ctrl+B"],
        ["Toggle AI chat", "Ctrl+J"],
        ["Manage pages", "Ctrl+Shift+P"],
        ["Open Volt / View / Tools / Markup menu", "Alt+B / Alt+V / Alt+T / Alt+M"],
        ["Navigate menu items · switch menu", "↑ / ↓ / ← / → · Enter"],
        ["Zoom in / out", "Ctrl + / Ctrl −"],
        ["Fit width / fit page", "W / P"],
        ["Rotate", "R"],
        ["Prev / next page", "↑ / ↓ or PgUp / PgDn"],
        ["First / last page", "Home / End"],
        ["Highlight / underline / strike / note", "H / U / S / N"],
        ["Select mode", "Esc"],
        ["Undo / redo annotation", "Ctrl+Z / Ctrl+Shift+Z"],
        ["Move / resize area highlight", "Click it · drag · handles"],
        ["Duplicate selected highlight", "Ctrl+D"],
        ["Nudge selected highlight", "Arrows 1pt · Shift+arrows 10pt"],
        ["Select all text on page", "Ctrl+A"],
        ["Select all text in document", "Ctrl+A, A (second A within a second)"],
        ["Select text to document start / end", "Ctrl+Shift+Home / End · Ctrl+Shift+Space"],
      ];
      this.elements.kbdList.innerHTML = rows.map(([k, v]) =>
        `<div class="kbd-row"><span>${k}</span><span class="kbd">${v}</span></div>`).join("");
    },

    /* ── Help & guides (Volt ▾ → Help & guides…, or the ? button) ────
       The modal holds a left nav of sections; only the .active section is
       visible. _openHelp(section) opens the modal on a specific section,
       falling back to Getting started for an unknown id. */
    _wireHelpNav() {
      document.querySelectorAll(".help-nav-item").forEach((nav) => {
        nav.addEventListener("click", () => {
          document.querySelectorAll(".help-section")
            .forEach((s) => s.classList.toggle("active", s.dataset.help === nav.dataset.help));
          document.querySelectorAll(".help-nav-item")
            .forEach((n) => n.classList.toggle("active", n === nav));
        });
      });
    },
    _openHelp(section) {
      const el = this.elements;
      section = section || "getting-started";
      const hit = [...document.querySelectorAll(".help-section")].find((s) => s.dataset.help === section);
      if (!hit) section = "getting-started"; // unknown id → land on the intro
      document.querySelectorAll(".help-section")
        .forEach((s) => s.classList.toggle("active", s.dataset.help === section));
      document.querySelectorAll(".help-nav-item")
        .forEach((n) => n.classList.toggle("active", n.dataset.help === section));
      this._openModal(el.helpModal);
    },

    /* ── Setup wizard (first run, or Volt ▾ → Setup wizard…) ───────
       Four steps: welcome → desktop & appearance → AI → done. Completing
       marks volt:setup-done so the banner never nags; skipping / Not now
       marks it done:false (the wizard stays reachable from the menu). The
       desktop step runs the shortcut/association script through the bridge
       (packaged installs already handled it — the IPC reports that). */
    _wireSetupWizard() {
      const el = this.elements;
      if (!el.setupModal) return;
      // desktop integration availability shapes step 2 BEFORE it's shown
      const desktopOk = !!(global.voltDesktop && typeof global.voltDesktop.runSetupTasks === "function");
      if (!desktopOk) {
        if (el.setupDesktopOpt) el.setupDesktopOpt.hidden = true;
        if (el.setupDesktopNote) {
          el.setupDesktopNote.hidden = false;
          el.setupDesktopNote.textContent = "You're using the browser version — shortcuts and .pdf file association are part of the desktop app. Install Volt for Windows to enable them.";
        }
      }
      const go = (step) => this._setupShow(step);
      el.setupBannerGo.addEventListener("click", () => { el.setupBanner.hidden = true; this.openSetup(); });
      el.setupBannerLater.addEventListener("click", () => this._dismissSetupBanner());
      el.setupSkip.addEventListener("click", () => { this._markSetupDone(false); this._closeModal(el.setupModal); });
      el.setupNext0.addEventListener("click", () => go(1));
      el.setupNext1.addEventListener("click", () => go(2));
      el.setupNext2.addEventListener("click", () => this._setupFinish()); // AI → run everything → summary
      el.setupFinish.addEventListener("click", () => this._setupDoneClose()); // 'Start reading'
      el.setupModal.querySelectorAll("[data-setup-back]").forEach((b) => {
        b.addEventListener("click", () => go(Number(b.dataset.setupBack) - 1));
      });
    },

    /** First-run offer: show the banner only when setup was never answered
        (force bypasses the smoke suppression so the self-test can probe it). */
    _maybeShowSetupBanner(force) {
      const el = this.elements;
      if (!el.setupBanner) return;
      if (!force && new URLSearchParams(location.search).has("smoke")) return;
      try { if (localStorage.getItem(SETUP_KEY) !== null) return; } catch (e) { return; }
      el.setupBanner.hidden = false;
    },
    _dismissSetupBanner() {
      this._markSetupDone(false);
      this.elements.setupBanner.hidden = true;
    },
    _markSetupDone(done) {
      try { localStorage.setItem(SETUP_KEY, JSON.stringify({ done: !!done, ts: Date.now() })); } catch (e) { /* ignore */ }
    },

    /** Open the wizard (menu item / banner) at the first step. */
    openSetup() {
      const el = this.elements;
      if (!el.setupModal) return;
      this._setupShow(0);
      this._openModal(el.setupModal);
    },
    _setupShow(step) {
      const el = this.elements;
      const sections = [...el.setupModal.querySelectorAll(".setup-step")];
      sections.forEach((s, i) => { s.hidden = i !== step; });
      const dots = [...el.setupSteps.querySelectorAll(".setup-dot")];
      dots.forEach((d, i) => {
        d.classList.toggle("on", i === step);
        d.classList.toggle("done", i < step);
      });
      if (step === 2) this._setupAiStatus();
    },

    async _setupAiStatus() {
      const el = this.elements;
      const AI = Volt.AI;
      if (!AI) {
        el.setupAiStatus.textContent = "AI isn't available in this build — set it up from the AI panel (Ctrl+J).";
        return;
      }
      try { await AI._bootstrapDetect().catch(() => {}); } catch (e) { /* advisory — fall back */ }
      const eff = AI._effective ? AI._effective() : null;
      const model = eff && eff.model ? eff.model : (AI.settings && AI.settings.model) || "";
      if (model && eff && eff.baseUrl) {
        el.setupAiStatus.textContent = "AI is ready — Volt will use " + model +
          (eff.provider ? " (" + eff.provider + ")" : "") + ".";
      } else {
        const b = AI._bootstrap;
        const best = (b && b.phase === "ready" && AI._pickBestModel) ? AI._pickBestModel(b.models || []) : null;
        el.setupAiStatus.textContent = best
          ? "Volt found " + best + " installed — open the AI panel (Ctrl+J) to make it the default."
          : "No local model found yet — you can set one up anytime from the AI panel (Ctrl+J).";
      }
    },

    async _setupFinish() {
      const el = this.elements;
      const lines = [];
      const desktopOk = !!(global.voltDesktop && typeof global.voltDesktop.runSetupTasks === "function");
      if (desktopOk && el.setupDesktop && el.setupDesktop.checked) {
        try {
          const r = await global.voltDesktop.runSetupTasks();
          lines.push(r && r.skipped === "installer"
            ? "Desktop shortcut & .pdf association — already handled by the installer"
            : (r && r.ok ? "Desktop shortcut & .pdf association — done" : "Desktop setup failed — you can re-run scripts/create-volt-shortcut.ps1"));
        } catch (e) {
          lines.push("Desktop setup failed — you can re-run scripts/create-volt-shortcut.ps1");
        }
      } else if (desktopOk) {
        lines.push("Desktop shortcut & .pdf association — skipped");
      } else {
        lines.push("Desktop shortcut & .pdf association — not available in the browser");
      }
      const skin = el.setupModal.querySelector("input[name=setup-skin]:checked");
      const skinVal = skin ? skin.value : "dark";
      if (this._setTheme) this._setTheme(skinVal);
      lines.push("Skin — " + (skinVal === "light" ? "Light" : "Dark"));
      const eff = Volt.AI && Volt.AI._effective ? Volt.AI._effective() : null;
      const model = eff && eff.model ? eff.model : "";
      lines.push(model ? "AI — " + model : "AI — set up later from the AI panel (Ctrl+J)");
      el.setupSummary.innerHTML = lines.map((l) => `<li>${Utils.esc(l)}</li>`).join("");
      this._markSetupDone(true);
      this._setupShow(3);
      // give the summary a beat to render before the user reads it — stay open
    },

    /** The Done step's action: close and land back on the app. */
    _setupDoneClose() {
      this._closeModal(this.elements.setupModal);
    },

    /* ── drag & drop ───────────────────────────────────────── */
    _wireDragDrop() {
      let depth = 0;
      window.addEventListener("dragenter", (e) => {
        e.preventDefault();
        if (![...e.dataTransfer.items].some((i) => i.kind === "file")) return;
        depth++;
        document.body.classList.add("drag-over");
      });
      window.addEventListener("dragleave", () => {
        depth = Math.max(0, depth - 1);
        if (!depth) document.body.classList.remove("drag-over");
      });
      window.addEventListener("dragover", (e) => e.preventDefault());
      window.addEventListener("drop", (e) => {
        e.preventDefault();
        depth = 0;
        document.body.classList.remove("drag-over");
        const file = [...(e.dataTransfer.files || [])].find((f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name));
        if (file) this.openFile(file);
        else if (e.dataTransfer.files.length) this.toast("Only PDF files are supported", "error");
      });
    },

    /* ── scroll / virtualization ───────────────────────────── */
    _wireScroll() {
      const el = this.elements;
      el.scroller.addEventListener("scroll", Utils.throttle(() => this._onScroll(), 50), { passive: true });
      // Ctrl+wheel / Cmd+wheel zooms around the cursor, like every PDF reader:
      // the PDF point under the pointer is captured, the zoom applies, and the
      // scroll is re-anchored so that point stays under the cursor when its
      // page finishes re-rendering (pages re-render async after a zoom). Plain
      // wheel keeps scrolling as usual. Never passive — preventDefault keeps
      // the browser from also zooming the whole page.
      el.scroller.addEventListener("wheel", (e) => {
        if (!e.ctrlKey && !e.metaKey) return;
        if (!this.currentDoc || !this.pageLayout.length) return;
        e.preventDefault();
        const anchor = this._clientToPdfAnchor(e.clientX, e.clientY);
        if (anchor) this._wheelAnchor = { ...anchor, clientX: e.clientX, clientY: e.clientY };
        this.setZoom(this.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
      }, { passive: false });
      window.addEventListener("resize", Utils.debounce(() => {
        if (!this.currentDoc) return;
        if (this.zoomMode !== "custom") this._applyFitZoom();
        this._layoutPages();
        this._onScroll();
      }, 150));
    },

    /** The PDF point (page + page-space coords) under a client-space cursor,
        via the rendered page that contains it. Returns null over blank
        space — the wheel handler then falls back to center-anchored zoom. */
    _clientToPdfAnchor(cx, cy) {
      for (const [n, r] of this.rendered) {
        const wr = r.wrap.getBoundingClientRect();
        if (cx >= wr.left && cx <= wr.right && cy >= wr.top && cy <= wr.bottom) {
          try {
            const pt = r.viewport.convertToPdfPoint(cx - wr.left, cy - wr.top);
            return { pageNum: n, x: pt[0], y: pt[1] };
          } catch (e) { return null; }
        }
      }
      return null;
    },

    /** Called when the anchor page's new wrap lands after a wheel-zoom render:
        scroll so the captured PDF point returns to the cursor's position. */
    _applyWheelAnchor(pageNum) {
      const a = this._wheelAnchor;
      if (!a || a.pageNum !== pageNum) return;
      this._wheelAnchor = null;
      const r = this.rendered.get(pageNum);
      if (!r) return;
      try {
        const pt = r.viewport.convertToViewportPoint(a.x, a.y);
        const scroller = this.elements.scroller;
        const srect = scroller.getBoundingClientRect();
        const wr = r.wrap.getBoundingClientRect();
        scroller.scrollLeft += wr.left + pt[0] - (a.clientX - srect.left);
        scroller.scrollTop += wr.top + pt[1] - (a.clientY - srect.top);
      } catch (e) { /* anchoring is best-effort — never break the render */ }
    },

    _onScroll() {
      if (!this.currentDoc) return;
      this._renderVisible();
      this._updateStatus();
    },

    /* ── document lifecycle ────────────────────────────────── */
    async openFile(file) {
      try {
        const buf = await Utils.fileToBuffer(file);
        this.currentPath = null; // a picked File has no disk path to watch
        this.openBuffer(buf, file.name, file.size);
      } catch (e) {
        this.toast("Could not read file: " + e.message, "error");
      }
    },

    /** Open a PDF by absolute path (Electron: OS file association / drag handoff). */
    async openPath(path) {
      try {
        const { name, size, data } = await global.voltDesktop.readFile(path);
        this.currentPath = path; // watch this file on disk for re-exports
        const ok = await this.openBuffer(data, name, size);
        if (ok) this._pushRecent({ name, path }); // home screen: reopenable
        return ok;
      } catch (e) {
        this.toast("Could not open “" + path + "”: " + (e.message || e), "error");
        return false;
      }
    },

    /** Open a PDF — native dialog on the desktop (returns a real path so the
        open lands in Recent documents), hidden file input in the browser. */
    async _pickPdf() {
      if (global.voltDesktop && typeof global.voltDesktop.pickPdf === "function") {
        try {
          const path = await global.voltDesktop.pickPdf();
          if (path) this.openPath(path);
        } catch (e) {
          this.toast("Could not open file: " + (e.message || e), "error");
        }
        return;
      }
      this.elements.fileInput.click();
    },

    /* ── home screen: recent documents ──────────────────────── */
    _recentDocs() {
      try {
        const list = JSON.parse(localStorage.getItem(RECENTS_KEY) || "[]");
        return Array.isArray(list) ? list.filter((r) => r && (r.path || r.url)) : [];
      } catch (e) { return []; }
    },
    _pushRecent(rec) {
      if (!rec || (!rec.path && !rec.url)) return;
      const key = rec.path || rec.url;
      let list = this._recentDocs().filter((r) => (r.path || r.url) !== key);
      list.unshift({ name: rec.name || "document.pdf", path: rec.path || "", url: rec.url || "", ts: Date.now() });
      if (list.length > RECENTS_MAX) list = list.slice(0, RECENTS_MAX);
      try { localStorage.setItem(RECENTS_KEY, JSON.stringify(list)); } catch (e) { /* quota */ }
      this._renderRecents();
    },
    _renderRecents() {
      const el = this.elements;
      if (!el.recentGrid) return;
      const recents = this._recentDocs();
      el.recentDocs.hidden = !recents.length;
      el.recentGrid.innerHTML = "";
      for (const rec of recents) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "recent-item";
        btn.title = rec.path || rec.url || "";
        let meta = "";
        if (rec.path) meta = rec.path.split(/[\\/]/).slice(0, -1).join("\\") || rec.path;
        else if (rec.url) { try { meta = new URL(rec.url).host; } catch (e) { meta = rec.url; } }
        btn.innerHTML = `<span class="recent-name">${Utils.esc(rec.name || "document.pdf")}</span>` +
          (meta ? `<span class="recent-meta">${Utils.esc(meta)}</span>` : "");
        btn.addEventListener("click", () => this._recentClick(rec));
        el.recentGrid.appendChild(btn);
      }
    },
    _recentClick(rec) {
      if (rec.path) this.openPath(rec.path);
      else if (rec.url) this._openUrlFrom(rec.url);
    },

    async openBuffer(buffer, name, size) {
      // a new document supersedes a pending 'Undo reorder' (the commit offers
      // its own undo only AFTER this call returns, so it is never self-dismissed)
      this._dismissReorderUndo();
      this._loadingToast = this.toast("Opening " + (name || "document") + "…");
      try {
        // pdf.js transfers/detaches the buffer — keep a private copy for export first
        this.currentDocBytes = buffer.slice(0);
        const loadingTask = pdfjsLib.getDocument({
          data: buffer,
          isEvalSupported: false,
          useSystemFonts: true,
        });
        const doc = await loadingTask.promise;
        this._loadingDoc = this.currentDoc; // will be destroyed by _docReady
        this.currentDoc = doc;
        this.currentDocInfo = { name: name || "document.pdf", size: size || buffer.byteLength, pages: doc.numPages };
        this.currentDocId = Utils.hash(name + ":" + size + ":" + doc.numPages);
        // content fingerprint for Restore backup matching (filled in async below)
        this.currentDocInfo.fingerprint = null;
        this._fpPromise = this._computeDocFingerprint();
        this.rotDelta = 0; // a fresh document always opens unrotated
        this._docReady();
        this._loadingDoc = null;
        return true;
      } catch (e) {
        this.toast("Failed to open PDF: " + (e.message || e), "error", true);
        return false;
      }
    },

    openSample() {
      if (!global.SAMPLE_PDF_B64) return;
      this.currentPath = null; // the sample is in-memory — nothing to watch
      const bin = atob(global.SAMPLE_PDF_B64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      this.openBuffer(bytes.buffer, "The Quiet Engine — sample.pdf", bytes.length);
    },

    /** Sample the document's text (first, middle, last pages) and hash it into
        a content fingerprint — the identity Restore backup matches against. A
        renamed copy of the same PDF still matches (the name isn't consulted),
        while a doctored file with identical size does not (its text changed,
        so the hash differs). Scanned pages have no embedded text, so the OCR
        store's text is used instead — and when even that is missing (a scan
        never OCR'd), the sample page is recognized ON DEMAND (recognizePage)
        so image-only documents still get a content fingerprint. Only a fully
        un-OCRable document stays null (matching then falls back to name +
        size + pages). */
    async _computeDocFingerprint() {
      const doc = this.currentDoc;
      if (!doc) return null;
      const ocr = global.Volt.OCR;
      // the sampled pages recognize as ONE block: hold _fpBusy for the whole
      // loop so a user clicking OCR waits instead of colliding mid-page
      const ocrHeld = !!(ocr && ocr.available && !ocr._busy && !ocr._fpBusy);
      if (ocrHeld) ocr._fpBusy = true;
      try {
        const nums = [];
        if (doc.numPages >= 1) nums.push(1);
        if (doc.numPages >= 3) nums.push(Math.max(2, Math.round(doc.numPages / 2)));
        if (doc.numPages >= 2 && !nums.includes(doc.numPages)) nums.push(doc.numPages);
        let text = "";
        for (const n of nums) {
          if (this.currentDoc !== doc) return null; // a newer document opened mid-scan
          const page = await doc.getPage(n);
          const tc = await page.getTextContent();
          let pt = (tc.items || []).map((i) => i.str || "").join(" ");
          // scanned pages have no embedded text — use the stored OCR text, or
          // recognize the page on demand so a scan still hashes by content
          if (!pt.trim() && ocr && ocr.available) {
            const stored = ocr.pageText ? (ocr.pageText(n) || "") : "";
            pt = stored.trim() ? stored : (ocrHeld ? ((await ocr.recognizePage(n)) || "") : "");
          }
          text += pt;
        }
        const norm = Utils.fpNormalize(text);
        const fp = norm ? Utils.fp64(norm) : null; // no text → no meaningful fingerprint
        if (this.currentDoc === doc && this.currentDocInfo) this.currentDocInfo.fingerprint = fp;
        return fp;
      } catch (e) {
        if (this.currentDoc === doc && this.currentDocInfo) this.currentDocInfo.fingerprint = null;
        return null;
      } finally {
        if (ocrHeld) ocr._fpBusy = false;
      }
    },

    /** Re-run the content fingerprint for the CURRENT document and refresh
        _fpPromise so later exports/restores await the upgraded value — a
        scanned document's fingerprint is null until OCR has run (or is
        computed on demand), so Volt.OCR calls this after a recognition pass. */
    recomputeFingerprint() {
      this._fpPromise = this._computeDocFingerprint();
      return this._fpPromise;
    },

    _docReady() {
      this._dismissToast();
      // release the previous document (worker + parsed pages) to avoid leaks
      try { if (this._loadingDoc) this._loadingDoc.destroy(); } catch (e) { /* ignore */ }
      this._loadingDoc = null;
      this.elements.app.classList.remove("no-doc");
      this.elements.app.classList.add("has-doc");
      this.rendered.clear();
      this.thumbRendered.clear();
      this._keepAllRendered = false; // a new doc (or a rotate) re-renders from the viewport
      this._clearSelToast(); // a stale "Selected …" count from the previous doc shouldn't linger
      this._thumbSel = null; // a new document invalidates the multi-selection
      this._thumbSelAnchor = null; // …and its range anchor with it
      this._thumbReorderPending = null;
      this._applyThumbSel(); // …and that hides the block-action row + move form with it
      this._clearThumbDragPreview();
      this.elements.pages.innerHTML = "";
      this.elements.thumbGrid.innerHTML = "";
      this.elements.outlineTree.innerHTML = "";
      this.search = null;
      this.elements.searchInput.value = "";
      this.elements.searchCount.textContent = "";
      this.zoom = 1;
      this.zoomMode = "fit-width";
      // rotDelta is deliberately NOT reset here: rotate() calls _docReady to
      // re-render, and a disk reload restores the captured rotation AFTER this
      // point (see _restoreDocState) — zeroing it here made R / the rotate
      // button a silent no-op. New documents reset it in openBuffer instead.

      this.elements.sbFile.textContent = this.currentDocInfo.name;
      this.elements.sbHint.textContent = "H to highlight · N for a note · Ctrl+J for AI";
      // the previous document's selection (a live DOM Range) means nothing in
      // the new one — drop it so the status-bar range readout can't show a
      // stale page span (and the AI selection flow can't read old text)
      const _sel = window.getSelection(); if (_sel) _sel.removeAllRanges();
      this._updateSelStatus();
      // OCR button + its language picker: only meaningful with a document
      // open and only when the vendored engine is present (a stripped
      // deployment just hides them)
      const ocrOn = !!(Volt.OCR && Volt.OCR.available);
      if (this.elements.btnOcr) this.elements.btnOcr.hidden = !ocrOn;
      // read-aloud: available whenever a document is open (voices load on demand)
      if (this.elements.btnReadaloud) {
        this.elements.btnReadaloud.hidden = !this.currentDoc;
        if (Volt.Voice && Volt.Voice.readAloud && !this.currentDoc) Volt.Voice.stopReadAloud();
      }
      if (this.elements.btnOcrLayer) {
        const layerOn = ocrOn && Volt.OCR.showLayer ? Volt.OCR.showLayer() : false;
        this.elements.btnOcrLayer.hidden = !ocrOn;
        this.elements.btnOcrLayer.classList.toggle("active", layerOn);
        this.elements.btnOcrLayer.title = layerOn
          ? "Show recognized OCR text layer"
          : "OCR text layer hidden — click to show";
      }
      if (this.elements.btnOcrLang) {
        this.elements.btnOcrLang.hidden = !ocrOn;
        if (this.elements.ocrLangPop) this.elements.ocrLangPop.hidden = true; // never float over a new document
        if (Volt.OCR && Volt.OCR._syncLangUI) Volt.OCR._syncLangUI(Volt.OCR.lang());
      }
      Volt.Ann.loadForDoc(this.currentDocInfo);
      Volt.AI._pageTexts = null;
      Volt.AI._closeDocPopover();
      this._hideRestoreSummary(); // a stale summary from a previous restore must not linger on a new doc
      if (Volt.AI._closeGlobalPop) Volt.AI._closeGlobalPop();
      // (the marker tip needs no explicit reset here: the _renderModelLine below
      // already refreshes it with the new doc's overrides when hovered, or hides
      // it otherwise)
      Volt.AI._restoreChat();
      Volt.AI._renderModelLine(); // reflect this document's AI overrides
      // a disk reload: re-apply the captured per-doc state onto the NEW identity
      // (a re-exported file has a new size, so its annotation/AI/chat keys would
      // otherwise orphan — this is what keeps them alive across the reload)
      this._restoreDocState();
      // a pending restore is applied once the matching (or any chosen) PDF
      // opens — but ONLY if the identity checks out: the fingerprint must be
      // computed first, then _matchesBackup decides. A doctored same-size file
      // opened after "Restore backup…" (with no doc open at selection time)
      // must prompt, not silently import.
      if (this._pendingBackup) this._deferredApplyPendingBackup();

      this._loadBaseDims().then(() => {
        this._loadOutline();
        this._renderThumbs();
        this.fitWidth();
        this._applyRestoredView();
      });
      this._syncFileWatch(); // watch (or unwatch) the file now that a doc is set
    },

    /* ── file-change watch (Electron) ───────────────────────────
       The main process polls the open PDF on disk; when the author re-exports
       it we offer a reload that carries annotations, AI overrides, chat, zoom,
       rotation and scroll position across — the file's new size would otherwise
       give it a fresh identity and orphan every piece of per-doc state. */
    _syncFileWatch() {
      if (!global.voltDesktop || typeof global.voltDesktop.watchFile !== "function") return;
      if (this.currentPath && this.currentDoc) {
        global.voltDesktop.watchFile(this.currentPath).catch(() => {});
      } else if (typeof global.voltDesktop.unwatchFile === "function") {
        global.voltDesktop.unwatchFile().catch(() => {});
      }
    },

    _fileChanged(d) {
      if (!d || !this.currentPath || d.path !== this.currentPath) return; // a different doc is open
      if (this._reloading || !this.currentDoc) return; // a reload is in flight — the offer already cleared
      this.elements.reloadBanner.querySelector(".reload-msg").textContent = d.missing
        ? "This file was removed from disk."
        : "This file changed on disk (the author may have re-exported it).";
      this.elements.reloadBanner.hidden = false;
    },

    /** Snapshot everything that keys on the doc's (name:size:pages) identity so
        it can be re-applied after a disk reload re-identifies the file. */
    _captureDocState() {
      if (!this.currentDoc) return null;
      return {
        ann: Volt.Ann.list ? Utils.clone(Volt.Ann.list) : [],
        ai: Volt.AI._docSettings ? Volt.AI._docSettings() : null,
        chat: Array.isArray(Volt.AI.messages) ? Utils.clone(Volt.AI.messages.slice(-Volt.AI._historyLimit())) : [],
        zoom: this.zoom,
        zoomMode: this.zoomMode,
        rotDelta: this.rotDelta,
        anchor: this._viewportAnchorToPdf(),
        aiOpen: !document.body.classList.contains("ai-hidden"),
      };
    },

    /** Re-apply the captured state onto the freshly-opened (new-identity) doc.
        Called from _docReady after the per-doc stores have been loaded fresh. */
    _restoreDocState() {
      const s = this._restoreState;
      this._restoreState = null;
      if (!s) return;
      // annotations → the NEW identity's storage key + live list
      if (Array.isArray(s.ann)) {
        Volt.Ann.list = s.ann;
        Volt.Ann._afterChange(); // saves to the new volt:ann: key, re-renders
      }
      // AI overrides + chat → the new volt:ai:doc: / volt:ai:chat: keys
      if (s.ai && (s.ai.model || s.ai.maxContextChars || s.ai.systemPrompt)) {
        Volt.AI._applyDocOverride(s.ai.model || "", s.ai.maxContextChars || 0, s.ai.systemPrompt || "");
      }
      if (Array.isArray(s.chat)) Volt.AI.importChatFromBackup(s.chat);
      // rotation must be set before _loadBaseDims reads it; the rest is applied
      // after layout via _applyRestoredView
      if (s.rotDelta) this.rotDelta = s.rotDelta;
      this._restoreView = { zoom: s.zoom, zoomMode: s.zoomMode, anchor: s.anchor, aiOpen: s.aiOpen };
    },

    /** After the reloaded doc has laid out, restore zoom/rotation/scroll and
        the AI panel state. Scroll is anchored to the same document point. */
    _applyRestoredView() {
      const v = this._restoreView;
      this._restoreView = null;
      if (!v) return;
      if (v.aiOpen) this.toggleAI(true);
      if (!v.zoomMode) return;
      this.zoomMode = v.zoomMode;
      if (v.zoomMode === "custom") {
        this.zoom = Utils.clamp(v.zoom, 0.15, 5);
        this._layoutPages();
        for (const [n, r] of [...this.rendered]) { r.wrap.style.width = ""; this._disposePage(n); }
        this.pendingRender.clear();
        this._renderVisible();
        this._updateZoomLabel();
      } else {
        this._applyFitZoom();
      }
      if (v.anchor) {
        const page = Math.min(v.anchor.page, this.pageLayout.length);
        const p = this.pageLayout[page - 1];
        if (p) {
          const scroller = this.elements.scroller;
          const frac = page === v.anchor.page ? v.anchor.frac : 0;
          scroller.scrollTop = p.top + p.height * frac - scroller.clientHeight / 2;
        }
      }
    },

    /** "Reload now": re-read the file from disk and swap it in, preserving
        annotations / AI overrides / chat / zoom / rotation / scroll. */
    async _reloadFromDisk() {
      const path = this.currentPath;
      if (!path || !global.voltDesktop) return;
      this._reloading = true;
      this.elements.reloadBanner.hidden = true; // the offer clears immediately
      try {
        const { name, size, data } = await global.voltDesktop.readFile(path);
        this._restoreState = this._captureDocState();
        const ok = await this.openBuffer(data, name, size); // _docReady applies the restore
        if (ok) this.toast("Reloaded — your annotations and chat are intact", "ok");
        else this._restoreState = null; // a failed open must never leak captured state into the next document
      } catch (e) {
        this._restoreState = null; // same guard for the read-error path
        this.toast("Reload failed: " + (e.message || e), "error");
      } finally {
        this._reloading = false;
      }
    },

    async _loadBaseDims() {
      const doc = this.currentDoc;
      this.pageDims = [];
      for (let n = 1; n <= doc.numPages; n++) {
        const page = await doc.getPage(n);
        const vp = page.getViewport({ scale: 1, rotation: this.rotDelta });
        this.pageDims.push({ w: vp.width, h: vp.height, rot: vp.rotation });
      }
    },

    /* ── layout ────────────────────────────────────────────── */
    _layoutPages() {
      if (!this.currentDoc || !this.pageDims.length) return;
      const GAP = 30; // px between pages incl. label
      let top = 18;
      this.pageLayout = [];
      for (let n = 0; n < this.pageDims.length; n++) {
        const h = this.pageDims[n].h * this.zoom;
        this.pageLayout.push({ top, height: h });
        top += h + GAP;
      }
      this.elements.pages.style.height = (top + 40) + "px";
    },

    getViewportForPage(pageNum) {
      const r = this.rendered.get(Number(pageNum));
      return r ? r.viewport : null;
    },

    /* ── rendering ─────────────────────────────────────────── */
    _visibleRange() {
      const scroller = this.elements.scroller;
      const top = scroller.scrollTop - 60;
      const bottom = scroller.scrollTop + scroller.clientHeight + 60;
      let start = null, end = null;
      for (let n = 0; n < this.pageLayout.length; n++) {
        const p = this.pageLayout[n];
        if (p.top + p.height >= top && start === null) start = n + 1;
        if (p.top <= bottom) end = n + 1;
      }
      if (start === null) start = 1;
      if (end === null) end = this.pageLayout.length;
      return { start, end };
    },

    _renderVisible() {
      const { start, end } = this._visibleRange();
      for (let n = start; n <= end; n++) this._ensurePage(n);
      // dispose far-away pages — unless a Ctrl+A+A whole-document selection
      // pinned the full render (see selectAllText): the on-demand pass just
      // rendered every page for the selection, and the next scroll must not
      // throw that work away, so the whole document stays visibly rendered.
      // Cleared by _docReady (a new document or a rotation re-renders from
      // the viewport anyway) and made moot by a zoom change (which disposes
      // everything to re-render at the new scale).
      if (!this._keepAllRendered) {
        for (const key of [...this.rendered.keys()]) {
          if (key < start - 2 || key > end + 2) this._disposePage(key);
        }
      }
      this._updateThumbActive();
    },

    async _ensurePage(pageNum) {
      if (this.rendered.has(pageNum)) return;
      if (this.pendingRender.has(pageNum)) return;
      const doc = this.currentDoc;
      if (!doc) return;
      this.pendingRender.set(pageNum, true);

      try {
        const page = await doc.getPage(pageNum);
        const vp = page.getViewport({ scale: this.zoom, rotation: this.rotDelta });
        const dpr = window.devicePixelRatio || 1;

        // wrap
        const wrap = document.createElement("div");
        wrap.className = "page-wrap";
        wrap.dataset.page = pageNum;
        wrap.style.width = vp.width + "px";
        wrap.style.height = vp.height + "px";
        wrap.dataset.label = pageNum;
        this._insertWrap(wrap, pageNum);

        // canvas
        const canvas = document.createElement("canvas");
        canvas.className = "page-canvas";
        canvas.width = Math.floor(vp.width * dpr);
        canvas.height = Math.floor(vp.height * dpr);
        canvas.style.width = vp.width + "px";
        canvas.style.height = vp.height + "px";
        wrap.appendChild(canvas);

        // text layer
        const textLayer = document.createElement("div");
        textLayer.className = "page-text-layer";
        wrap.appendChild(textLayer);

        // overlay (annotations + search)
        const overlay = document.createElement("canvas");
        overlay.className = "page-overlay";
        wrap.appendChild(overlay);

        const ctx = canvas.getContext("2d");
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        await page.render({ canvasContext: ctx, viewport: vp }).promise;
        // register the page BEFORE building the text layer — _buildTextLayer
        // re-applies text edits, whose geometry helpers (_pdfToLocal /
        // _spanBboxPdf) resolve the page's viewport through this.rendered,
        // which is otherwise empty mid re-render (zoom / rotate / open)
        this.rendered.set(pageNum, { wrap, canvas, textLayer, overlay, viewport: vp });
        // abandon if the page was disposed while rendering (zoom change / scroll-away / new doc)
        if (!wrap.isConnected) { this.pendingRender.delete(pageNum); this.rendered.delete(pageNum); return; }
        await this._buildTextLayer(page, vp, textLayer, pageNum);
        if (!wrap.isConnected) { this.pendingRender.delete(pageNum); this.rendered.delete(pageNum); return; }

        this._updatePagePosition(wrap, pageNum);
        this._applyWheelAnchor(pageNum); // re-anchor the Ctrl+wheel zoom to the cursor
        this._drawOverlay(wrap, pageNum);
        if (Volt.Ann && Volt.Ann.refreshSelection) Volt.Ann.refreshSelection(); // re-glue the editing box after re-render
        this.pendingRender.delete(pageNum);
      } catch (e) {
        this.pendingRender.delete(pageNum);
        if (!/was destroyed/.test(e.message)) {
          this.toast("Page " + pageNum + " render failed: " + e.message, "error");
        }
      }
    },

    _insertWrap(wrap, pageNum) {
      // insert in order
      let inserted = false;
      for (const [n, r] of this.rendered) {
        if (n > pageNum) {
          this.elements.pages.insertBefore(wrap, r.wrap);
          inserted = true;
          break;
        }
      }
      if (!inserted) this.elements.pages.appendChild(wrap);
    },

    _updatePagePosition(wrap, pageNum) {
      const p = this.pageLayout[pageNum - 1];
      if (!p) return;
      wrap.style.marginTop = (p.top - (pageNum > 1 ? this.pageLayout[pageNum - 2].top + this.pageLayout[pageNum - 2].height : 0)) + "px";
    },

    _disposePage(pageNum) {
      const r = this.rendered.get(pageNum);
      if (r) {
        try { r.canvas.width = 0; } catch (e) { /* ignore */ }
        r.wrap.remove();
      }
      this.rendered.delete(pageNum);
    },

    /* ── text layer ────────────────────────────────────────── */
    async _buildTextLayer(page, vp, container, pageNum) {
      // pdf.js 4.x sizes its spans (font-size, left/top) and the layer itself
      // via the `--scale-factor` CSS variable, which the INTEGRATOR must set
      // on the container to the viewport scale (the official viewer does
      // `container.style.setProperty("--scale-factor", viewport.scale)`).
      // Without it the font-size calc is invalid and falls back to the
      // inherited body font — constant at every zoom while the positions
      // still scale — so at zoom < ~0.8 adjacent line boxes overlap by more
      // than the 2px grouping tolerance, adjacent lines merged into one
      // "line" in _groupSpansIntoLines, and a two-line drag highlighted as a
      // single block instead of line-by-line.
      container.style.setProperty("--scale-factor", vp.scale);
      // OCR-first mode: the ALIGNED OCR words replace the embedded layer for
      // this page — a scan's baked-in text can be invisible and systematically
      // offset from the visible page, so selecting/highlighting it would paint
      // marks over blank space. Only applies when the per-doc preference is on
      // AND the page has recognized words; before OCR runs (or on documents
      // without the preference) the embedded layer is used as usual.
      if (Volt.OCR && Volt.OCR.preferFor && Volt.OCR.preferFor(pageNum)) {
        Volt.OCR.renderTextLayer(pageNum, container, vp);
        return;
      }
      const textContent = await page.getTextContent();
      const layer = new pdfjsLib.TextLayer({ textContentSource: textContent, container, viewport: vp });
      await layer.render();
      // text editing support: remember the page's textContent and map each
      // span to its font (PostScript name via page.commonObjs) + size, then
      // re-apply any stored text edits — pdf.js rebuilds the spans
      // deterministically per page, so edits survive zoom / scroll / rotate.
      container._voltTC = textContent;
      if (Volt.Ann && Volt.Ann.annotateLayerFonts) Volt.Ann.annotateLayerFonts(page, container, textContent);
      if (Volt.Ann && Volt.Ann.applyTextEditsToLayer) Volt.Ann.applyTextEditsToLayer(container, pageNum);
      // an image-only (scanned) page renders NO spans — overlay the stored OCR
      // words as real selectable text, positioned from their PDF-space bboxes
      // through the page's current viewport. Runs on every render (zoom,
      // rotation, scroll-away-and-back), so the layer stays glued to the page.
      if (!container.querySelector("span") && Volt.OCR && Volt.OCR.available && Volt.OCR.showLayer()) {
        Volt.OCR.renderTextLayer(pageNum, container, vp);
      }
    },

    /** Sync the on-screen OCR text spans with the store: drop spans whose
        words are no longer there (a language change clears the store, and the
        old language's spans must leave the page), then inject fresh ones into
        every rendered page whose layer is still empty (after an OCR run — the
        pages are already on screen and were rendered before the store
        existed). */
    renderOcrTextLayers() {
      if (!Volt.OCR || !Volt.OCR.available) return;
      const show = Volt.OCR.showLayer ? Volt.OCR.showLayer() : true;
      for (const [n, r] of this.rendered) {
        const layer = r.wrap.querySelector(".page-text-layer");
        if (!layer) continue;
        // OCR-first pages: the embedded layer is replaced wholesale by the
        // aligned OCR words (it can be offset from the visible page) — keep
        // the on-screen layer in sync after a run or the layer toggle
        if (Volt.OCR.preferFor && Volt.OCR.preferFor(n)) {
          layer.innerHTML = "";
          if (show) Volt.OCR.renderTextLayer(n, layer, r.viewport);
          continue;
        }
        if (!Volt.OCR.hasPage(n) || !show) {
          layer.querySelectorAll(".ocr-span").forEach((sp) => sp.remove());
        } else if (!layer.querySelector("span")) {
          Volt.OCR.renderTextLayer(n, layer, r.viewport);
        }
      }
    },

    /** Rebuild the on-screen text layers from scratch — used when the
        OCR-first layer preference flips, so pages rendered under the old
        mode switch immediately (embed → OCR or the reverse). Rebuilds only
        the text layer, never the page canvas. */
    /** Serialize text-layer rebuilds. RebuildTextLayers is fire-and-forget
        from _syncTextEdits (an AI text edit + immediate undo) and the OCR
        layer-preference flips — two CONCURRENT passes interleave their
        per-page layer.innerHTML = "" with pdf.js's async span build, and one
        pass's spans can land after the other pass wiped the layer, leaving a
        page with DOUBLED spans (the text visibly overlapping). Each call
        waits for the previous pass to settle and then runs again, so the
        layers always converge on the latest annotation state. */
    _rebuildChain: null,
    rebuildTextLayers() {
      const run = () => this._doRebuildTextLayers();
      this._rebuildChain = (this._rebuildChain || Promise.resolve()).then(run, run);
      return this._rebuildChain;
    },
    async _doRebuildTextLayers() {
      const doc = this.currentDoc;
      if (!doc) return;
      const pages = [...this.rendered.entries()];
      for (const [n, r] of pages) {
        const layer = r.wrap && r.wrap.querySelector(".page-text-layer");
        if (!layer || !r.viewport) continue;
        try {
          const page = await doc.getPage(n);
          layer.innerHTML = "";
          await this._buildTextLayer(page, r.viewport, layer, n);
        } catch (e) { /* page disposed mid-rebuild */ }
      }
    },

    /* ── annotations overlay ───────────────────────────────── */
    _drawOverlay(wrap, pageNum) {
      Volt.Ann.renderOverlay(wrap, pageNum);
      this._drawSearchHighlights(wrap, pageNum);
    },
    renderAllAnnotations() {
      for (const [n, r] of this.rendered) this._drawOverlay(r.wrap, n);
      Volt.Ann.renderAllPins();
    },

    /* ── zoom / rotate ─────────────────────────────────────── */
    fitWidth() {
      if (!this.pageDims.length) return;
      this.zoomMode = "fit-width";
      this._applyFitZoom();
    },
    fitPage() {
      if (!this.pageDims.length) return;
      this.zoomMode = "fit-page";
      this._applyFitZoom();
    },
    /** A pane resize changes the viewer's available width exactly like a
        window resize does — in fit-width/fit-page the zoom must recompute or
        the page renders at a stale scale (and every annotation overlay is then
        drawn against a viewport that no longer matches the DOM box). Same body
        as the window "resize" handler, called from the sidebar/AI drag. */
    _reflowAfterPaneResize() {
      if (!this.currentDoc) return;
      if (this._paneReflow) return; // coalesce to one reflow per frame during a drag
      this._paneReflow = requestAnimationFrame(() => {
        this._paneReflow = null;
        if (!this.currentDoc) return;
        if (this.zoomMode !== "custom") this._applyFitZoom();
        this._layoutPages();
        this._onScroll();
      });
    },

    _applyFitZoom() {
      const scroller = this.elements.scroller;
      const pad = 60;
      const w = Math.max(200, scroller.clientWidth - pad);
      const h = Math.max(200, scroller.clientHeight - pad);
      const maxW = Math.max(...this.pageDims.map((d) => d.w));
      const maxH = Math.max(...this.pageDims.map((d) => d.h));
      let z = 1;
      if (this.zoomMode === "fit-width") z = w / maxW;
      else if (this.zoomMode === "fit-page") z = Math.min(w / maxW, h / maxH);
      this._setZoom(z, false);
    },
    setZoom(z) {
      this.zoomMode = "custom";
      this._setZoom(z, true);
    },
    _setZoom(z, keepFocus) {
      const old = this.zoom;
      z = Utils.clamp(z, 0.15, 5);
      this.zoom = z;
      if (global.Volt.Ann && global.Volt.Ann._areaMenuOpen) global.Volt.Ann._closeAreaMenu(); // stale fixed position after zoom
      // keep the same document point under the viewport center
      const scroller = this.elements.scroller;
      const anchorPdf = keepFocus ? this._viewportAnchorToPdf() : null;

      this._layoutPages();
      // re-render visible pages at new scale
      for (const [n, r] of [...this.rendered]) {
        r.wrap.style.width = "";
        this._disposePage(n);
      }
      this.pendingRender.clear();
      this._renderVisible();

      this._updateZoomLabel();
      if (anchorPdf) this._scrollToPdfPoint(anchorPdf);
    },
    rotate() {
      this.rotDelta = (this.rotDelta + 90) % 360;
      this._docReady();
    },

    _viewportAnchorToPdf() {
      const scroller = this.elements.scroller;
      const midTop = scroller.scrollTop + scroller.clientHeight / 2;
      for (let n = 0; n < this.pageLayout.length; n++) {
        const p = this.pageLayout[n];
        if (midTop >= p.top && midTop <= p.top + p.height) {
          const r = this.rendered.get(n + 1);
          if (!r) return null;
          const frac = (midTop - p.top) / p.height;
          return { page: n + 1, frac };
        }
      }
      return null;
    },
    _scrollToPdfPoint(anchor) {
      const p = this.pageLayout[anchor.page - 1];
      if (!p) return;
      const scroller = this.elements.scroller;
      scroller.scrollTop = p.top + p.height * anchor.frac - scroller.clientHeight / 2;
    },

    _updateZoomLabel() {
      const pct = Math.round(this.zoom * 100);
      this.elements.zoomLabel.textContent = pct + "%";
      this.elements.fabZoomLabel.textContent = pct + "%";
      this.elements.fabZoomLabel.title = "Click to reset to Fit Width";
      this.elements.zoomFab.hidden = this.zoomMode === "fit-width" && this.elements.scroller.clientWidth > 700;
      this.elements.sbZoom.textContent = pct + "%";
    },

    /* ── navigation ────────────────────────────────────────── */
    goToPage(pageNum, smooth = true) {
      pageNum = Utils.clamp(pageNum, 1, this.pageLayout.length || 1);
      const p = this.pageLayout[pageNum - 1];
      if (!p) return;
      this.elements.scroller.scrollTo({ top: p.top, behavior: smooth ? "smooth" : "auto" });
      this._updateThumbActive();
    },
    nextPage() { this.goToPage(this._currentPageNum() + 1); },
    prevPage() { this.goToPage(this._currentPageNum() - 1); },
    firstPage() { this.goToPage(1); },
    lastPage() { this.goToPage(this.pageLayout.length); },
    _currentPageNum() {
      const scroller = this.elements.scroller;
      const mid = scroller.scrollTop + scroller.clientHeight / 2;
      for (let n = 0; n < this.pageLayout.length; n++) {
        const p = this.pageLayout[n];
        if (mid >= p.top && mid <= p.top + p.height) return n + 1;
      }
      return this.pageLayout.length ? 1 : 0;
    },

    /** Ctrl+A: select ALL searchable text on the current page, mirroring
        standard PDF readers (Chrome's viewer and Acrobat select the current
        page, not the whole document). The selection is one real DOM Range
        over every text node of the page's text layer — the pdf.js spans AND
        any OCR word spans — so it renders as a normal selection highlight
        (the layer's ::selection color), copies with Ctrl+C, feeds the AI
        panel's "ask about selected text" flow, and converts to a highlight
        if the user then drags with a text tool. A page with no selectable
        text (a scan with the OCR layer off) clears any stale selection and
        toasts instead of pretending. */
    async selectAllText() {
      if (!this.currentDoc || !this.pageLayout.length) return;
      // Ctrl+A twice within 600ms (Ctrl held — "Ctrl+A, A") selects across
      // ALL pages — the PDF reader's "select everything" gesture. Pages
      // outside the virtualized viewport are rendered on the spot, exactly
      // like Ctrl+Shift+Space (progress toast on long documents), so the
      // gesture works whether or not the document is fully rendered. A slow
      // second press (>600ms later) is a fresh gesture and just re-selects
      // the page, as before.
      const now = Date.now();
      const secondPress = this._lastSelectAllAt && now - this._lastSelectAllAt < 600;
      this._lastSelectAllAt = now;
      if (secondPress && this.pageLayout.length > 1) {
        // selectTextRange renders any pages outside the viewport (or resolves
        // synchronously when everything is already rendered)
        const count = await this.selectTextRange(1, this.pageLayout.length);
        // status toast mirroring the Ctrl+A one: how many pages were
        // selected, with the same Highlight-all affordance (highlightSelection
        // already handles a multi-page selection, one annotation per page)
        if (count > 0) {
          // persistent (sticky) review toast: the page count stays up until
          // dismissed — a click on the toast, any action, or anywhere outside
          // — so a long selection can be reviewed calmly
          this._showRangeActionsToast("Selected all text across " + count + " pages — ",
            1, this.pageLayout.length);
          // the on-demand render just made the whole doc selectable — also
          // paint the sidebar's Pages-panel thumbnails for every page (the
          // grid paints lazily at doc open / tab switch, so without this the
          // panel could show fewer painted thumbs than the toast counts).
          // Fire-and-forget: it's async with per-page breathing on big docs,
          // the toast must land now, and _renderThumbs is generation-guarded
          // against a newer document starting mid-pass. Blits the shared
          // _pageThumbCache when warm, so the pages manager warms too.
          this._renderThumbs();
          // PIN the full render: the freshly rendered pages must survive the
          // next scroll (the virtualization window would otherwise dispose
          // everything outside the viewport ± 2 on the first _renderVisible).
          // Sticky until the document changes or rotates — _docReady clears
          // it; a zoom change re-renders everything anyway.
          this._keepAllRendered = true;
        }
        return;
      }
      const pageNum = this._currentPageNum();
      const rendered = this.rendered.get(pageNum);
      const layer = rendered && rendered.textLayer;
      const sel = window.getSelection();
      const clear = () => { if (sel) sel.removeAllRanges(); };
      if (!layer) { clear(); return; }
      const texts = [];
      const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        if (node.textContent && node.textContent.trim()) texts.push(node);
      }
      if (!texts.length) {
        clear();
        this.toast("No searchable text on this page — try OCR (Tools ▸ OCR this document)");
        return;
      }
      const range = document.createRange();
      range.setStart(texts[0], 0);
      const last = texts[texts.length - 1];
      range.setEnd(last, last.length);
      clear();
      sel.addRange(range);
      // quick affordance: one click turns the whole selection into a single
      // highlight annotation spanning the page (no re-drag), using the exact
      // drag geometry — the PDF-editor "Highlight all" flow
      // persistent (sticky) review toast, same dismissal rules as the
      // Ctrl+A+A one — the page count stays visible while reviewing
      this._showRangeActionsToast("Selected the whole page — ", pageNum, pageNum);
    },

    /** Persistent review toast for a whole-page multi-page selection (Ctrl+A,
        Ctrl+A+A and the boundary gestures): "… — N chars" plus the two
        actions (Highlight all + Copy w/ citations). Sticky until dismissed —
        a click on the toast, an action, or anywhere outside — and replaced by
        the next selection's toast. `from`/`to` feed the char tally. */
    _showRangeActionsToast(msg, from, to) {
      this._clearSelToast();
      this._selToast = this.toast(msg + this._layerChars(from, to) + " chars", "ok", true, [
        {
          label: "Highlight all",
          onClick: () => { if (global.Volt && Volt.Ann) Volt.Ann.highlightSelection(); },
        },
        {
          label: "Copy w/ citations",
          onClick: () => this._copyWithCitations(),
        },
      ]);
      return this._selToast;
    },

    /** Boundary-selection helper (Ctrl+Shift+Space / Home / End): select the
        page range a..b and offer the same persistent review toast on success —
        the keyboard twin of the Ctrl+A+A toast, so a boundary selection gets
        the Highlight-all conversion (and Copy w/ citations) too. */
    _selectRangeActions(a, b) {
      const last = this.pageLayout.length;
      const from = Utils.clampPage(a, last);
      const to = Utils.clampPage(b, last);
      const n = to - from + 1;
      const label = "Selected text across " + (n === 1 ? "1 page" : n + " pages") + " — ";
      this.selectTextRange(from, to).then((count) => {
        if (count > 0) this._showRangeActionsToast(label, from, to);
      });
    },

    /** Build "— p. N\n<full page text>" for every page the selection spans
        (whole-page selections: Ctrl+A, Ctrl+A+A, the boundary gestures).
        Uses the AI panel's cached per-page extraction (pdf.js text content
        with the OCR fallback, whitespace-normalized) so the copy matches what
        chat reads — and reads pages the virtualization has disposed, since
        the Range retains its text nodes. Falls back to walking the rendered
        text layers. Returns null when nothing is selectable. */
    async _buildCitationsText() {
      const r = this._selectionPageRange();
      if (!r) return null;
      const ai = global.Volt && Volt.AI;
      if (ai && typeof ai.ensurePageTexts === "function") {
        const cache = await ai.ensurePageTexts();
        const pages = (cache && cache.pages) || [];
        const parts = [];
        for (let p = r.from; p <= r.to; p++) {
          const hit = pages.find((e) => e.page === p);
          const text = (hit && hit.text || "").replace(/\s+/g, " ").trim();
          if (text) parts.push("— p. " + p + "\n" + text);
        }
        return parts.length ? parts.join("\n\n") : null;
      }
      const parts = [];
      for (let p = r.from; p <= r.to; p++) {
        const rend = this.rendered.get(p);
        if (!rend || !rend.textLayer) continue;
        const texts = [];
        const walker = document.createTreeWalker(rend.textLayer, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
          if (node.textContent && node.textContent.trim()) texts.push(node.textContent);
        }
        const text = texts.join(" ").replace(/\s+/g, " ").trim();
        if (text) parts.push("— p. " + p + "\n" + text);
      }
      return parts.length ? parts.join("\n\n") : null;
    },

    /** The "Copy w/ citations" action: copy the selection's pages under
        "— p. N" headers. Reads the page range from the live selection, so it
        works from the persistent toast even after the view scrolled. */
    async _copyWithCitations() {
      const text = await this._buildCitationsText();
      if (!text) {
        this.toast("No selectable text in that selection — try OCR (Tools ▸ OCR this document)", "error");
        return;
      }
      const ok = await this._writeClipboard(text);
      const count = (text.match(/^— p\. /gm) || []).length;
      if (ok) {
        this.toast("Copied " + count + " page" + (count === 1 ? "" : "s") + " with citations — Ctrl+V to paste", "ok");
      } else {
        this.toast("Copy failed — clipboard unavailable", "error");
      }
    },

    /** Write to the clipboard: navigator.clipboard where available, else the
        hidden-textarea execCommand fallback (Electron file:// and localhost
        are secure contexts, so the async API normally works). */
    async _writeClipboard(text) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        try { await navigator.clipboard.writeText(text); return true; }
        catch (e) { /* fall through to execCommand */ }
      }
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      ta.style.top = "0";
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
      ta.remove();
      return ok;
    },

    /** Select all searchable text from page `a` through page `b` (inclusive) —
        the whole-document analog of Ctrl+A, mirroring Ctrl+Shift+Home/End in
        editors (Ctrl+Shift+Space is the "current page → end" binding). Pages
        outside the virtualized render window are rendered first (with a
        progress toast for long ranges — the selection needs their text nodes
        in the DOM), then ONE DOM Range is built from the first text node of
        `a` to the last text node of `b`, covering pdf.js spans and OCR word
        spans alike. It renders as a selection, copies with Ctrl+C, and feeds
        the AI panel's "ask about selected text" flow. The viewport is left
        where it is (like Ctrl+A, the selection extends off-screen). Returns
        the page count covered, or 0 when nothing was selectable. */
    async selectTextRange(a, b) {
      if (!this.currentDoc || !this.pageLayout.length) return 0;
      const n = this.pageLayout.length;
      const from = Utils.clampPage(a, n);
      const to = Utils.clampPage(b, n);
      const sel = window.getSelection();
      const clear = () => { if (sel) sel.removeAllRanges(); };
      if (from > to) { clear(); return 0; }
      // virtualization only keeps the viewport window rendered — the range
      // needs every page's text nodes, so render the gaps (they'd render on
      // scroll anyway; this just makes the selection honest)
      const missing = [];
      for (let p = from; p <= to; p++) if (!this.rendered.has(p)) missing.push(p);
      if (missing.length) {
        const rangeN = to - from + 1;
        this.toast("Selecting text across " + rangeN + (rangeN === 1 ? " page…" : " pages…"));
        // Escape-to-cancel: the token is the single cancel channel — the
        // keydown handler flips `cancelled` on Escape, and the loop checks it
        // after every page, so a long on-demand render (Ctrl+A+A,
        // Ctrl+Shift+Space/Home/End on a big document) aborts mid-flight
        // instead of grinding through every page. Only exists while a render
        // is actually in progress — the fully-rendered path skips it entirely.
        const token = { cancelled: false };
        this._rangeRenderCancel = token;
        for (let i = 0; i < missing.length; i++) {
          await this._ensurePage(missing[i]);
          // the smoke injects a per-page delay here so it can catch Escape
          // mid-render on the tiny sample document
          if (global.__voltRangeRenderDelay) {
            await new Promise((r) => setTimeout(r, global.__voltRangeRenderDelay));
          }
          if (token.cancelled) {
            clear();
            this.toast("Selection cancelled — nothing selected");
            this._rangeRenderCancel = null;
            return 0;
          }
          // keep the progress toast alive on long renders (it auto-dismisses)
          if (i > 0 && (i % 15 === 0 || i === missing.length - 1)) {
            this.toast("Selecting text across " + rangeN + " pages — " + (i + 1) + "/" + missing.length);
          }
        }
        if (this._rangeRenderCancel === token) this._rangeRenderCancel = null;
      }
      const firsts = [], lasts = [];
      for (let p = from; p <= to; p++) {
        const r = this.rendered.get(p);
        if (!r || !r.textLayer) continue;
        const texts = [];
        const walker = document.createTreeWalker(r.textLayer, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
          if (node.textContent && node.textContent.trim()) texts.push(node);
        }
        if (texts.length) { firsts.push(texts[0]); lasts.push(texts[texts.length - 1]); }
      }
      if (!firsts.length) {
        clear();
        this.toast("No searchable text in this range — try OCR (Tools ▸ OCR this document)");
        return 0;
      }
      const range = document.createRange();
      range.setStart(firsts[0], 0);
      const lastNode = lasts[lasts.length - 1];
      range.setEnd(lastNode, lastNode.length);
      clear();
      sel.addRange(range);
      return to - from + 1;
    },

    /** Count selectable chars across rendered pages `a`..`b` (0 when none) —
        the whole-document analog of the single-page char tally used by the
        Ctrl+A toast, so the Ctrl+A+A status toast can report both the page
        count and the selected text size. */
    _layerChars(a, b) {
      let total = 0;
      for (let p = a; p <= b; p++) {
        const r = this.rendered.get(p);
        if (!r || !r.textLayer) continue;
        const walker = document.createTreeWalker(r.textLayer, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
          if (node.textContent && node.textContent.trim()) total += node.length;
        }
      }
      return total;
    },

    /* ── thumbnails (lazy: only renders when the Pages tab is shown) ──
       Rasterized through the SAME path as the pages-manager thumbnails
       (_renderDocThumbCanvas + the shared _pageThumbCache under "d:N"), so a
       page seen here warms the manager's grid and vice versa — and each thumb
       carries the same size badge (bottom-left) and, when the page has
       annotations, the warm count badge (top-right). */
    async _renderThumbs() {
      const grid = this.elements.thumbGrid;
      const doc = this.currentDoc;
      if (!doc) return;
      // clear existing
      grid.innerHTML = "";
      this.thumbRendered.clear();
      const gen = (this._thumbGen = (this._thumbGen || 0) + 1);
      for (let n = 1; n <= doc.numPages; n++) {
        if (gen !== this._thumbGen) return; // a newer document started
        if (this.thumbRendered.has(n)) continue;
        const item = document.createElement("div");
        item.className = "thumb-item";
        item.dataset.page = n;
        item.draggable = true; // drag to reorder the document's pages directly
        item.title = "Go to page " + n + " · drag to reorder · Shift+click to multi-select";
        const canvas = document.createElement("canvas");
        item.appendChild(canvas);
        const num = document.createElement("span");
        num.className = "thumb-num";
        num.textContent = n;
        item.appendChild(num);
        // size badge — bottom-left, same as the manager's doc pages
        const size = document.createElement("span");
        size.className = "pages-size";
        item.appendChild(size);
        const d = this.pageDims[n - 1];
        size.textContent = this._pageSizeLabel(d && d.w, d && d.h);
        // annotation count — top-right, only when > 0
        const annCount = (Volt.Ann && Volt.Ann.list) ? Volt.Ann.list.filter((a) => a.page === n).length : 0;
        if (annCount > 0) {
          const ann = document.createElement("span");
          ann.className = "pages-ann";
          ann.textContent = String(annCount);
          ann.title = annCount + " annotation" + (annCount === 1 ? "" : "s") + " on this page";
          item.appendChild(ann);
        }
        grid.appendChild(item);

        // shared rasterizer + cache: blit if the manager (or a prior pass)
        // already painted this page, else render and store for both grids
        const key = "d:" + n;
        const cached = this._pageThumbCache.get(key);
        if (cached) {
          canvas.width = cached.width;
          canvas.height = cached.height;
          canvas.getContext("2d").drawImage(cached, 0, 0);
        } else {
          try {
            await this._renderDocThumbCanvas(canvas, n);
            this._pageThumbCache.set(key, canvas);
          } catch (e) { /* page render failed — skip */ }
        }
        this.thumbRendered.add(n);
        // let the UI breathe between pages on big docs
        if (n % 5 === 0) await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      }
      if (gen === this._thumbGen) {
        this._updateThumbActive();
        // a block drag-reorder set _thumbSel to the block's NEW page numbers;
        // apply them now that the rebuilt sidebar actually exists (the remap
        // happens inside _reorderFromThumbs, which must NOT touch the DOM
        // itself — _renderThumbs is async and would race it)
        this._applyThumbSel();
      }
    },

    /** Keep the sidebar's per-page annotation badges live as annotations are
        added/removed (size is static per page; only the count moves). In-place
        — no re-rasterization — cheap enough to run on every _afterChange. */
    refreshThumbBadges() {
      const grid = this.elements.thumbGrid;
      if (!grid) return;
      const anns = (Volt.Ann && Volt.Ann.list) || [];
      grid.querySelectorAll(".thumb-item[data-page]").forEach((item) => {
        const n = parseInt(item.dataset.page, 10);
        if (!n) return;
        const count = anns.filter((a) => a.page === n).length;
        let el = item.querySelector(".pages-ann");
        if (count > 0 && !el) {
          el = document.createElement("span");
          el.className = "pages-ann";
          el.title = count + " annotation" + (count === 1 ? "" : "s") + " on this page";
          item.appendChild(el);
        }
        if (el) {
          el.textContent = String(count);
          el.title = count + " annotation" + (count === 1 ? "" : "s") + " on this page";
          if (count === 0) el.remove();
        }
      });
    },
    _updateThumbActive() {
      const cur = this._currentPageNum();
      this.elements.thumbGrid.querySelectorAll(".thumb-item").forEach((t) => {
        t.classList.toggle("active", parseInt(t.dataset.page, 10) === cur);
      });
    },

    /* ── outline ───────────────────────────────────────────── */
    async _loadOutline() {
      const doc = this.currentDoc;
      if (!doc) return;
      const outline = await doc.getOutline();
      const tree = this.elements.outlineTree;
      tree.innerHTML = "";
      if (!outline || !outline.length) {
        tree.innerHTML = '<div class="notes-empty">This document has no outline.</div>';
        return;
      }
      const walk = (items, depth) => {
        for (const it of items) {
          const div = document.createElement("div");
          div.className = `outline-item indent-${Math.min(depth, 3)}`;
          div.textContent = it.title;
          div.addEventListener("click", async () => {
            try {
              const dest = it.dest ? await doc.getDestination(it.dest) : null;
              const ref = dest && dest[0];
              const idx = ref ? await doc.getPageIndex(ref) : -1;
              this.goToPage(idx + 1);
            } catch (e) { /* ignore */ }
          });
          tree.appendChild(div);
          if (it.items && it.items.length) walk(it.items, depth + 1);
        }
      };
      walk(outline, 0);
    },

    /* ── search implementation ─────────────────────────────── */
    async runSearch(query) {
      const doc = this.currentDoc;
      if (!doc) return;
      const q = query.toLowerCase();
      const results = [];
      let total = 0;
      for (let n = 1; n <= doc.numPages; n++) {
        const page = await doc.getPage(n);
        // OCR-first pages: search the ALIGNED recognized words, never the
        // embedded layer (which the preference replaced because it can be
        // offset from the visible page)
        if (Volt.OCR && Volt.OCR.preferFor && Volt.OCR.preferFor(n)) {
          const ocrRects = Volt.OCR.searchRects(n, q);
          if (ocrRects.length) {
            results.push({ page: n, rects: ocrRects });
            total += ocrRects.length;
          }
          continue;
        }
        const tc = await page.getTextContent();
        const items = tc.items.filter((i) => i.str);
        // an image-only (scanned) page has no embedded text for pdf.js — fall
        // back to the OCR store's word boxes so search finds scanned pages
        if (!items.length && Volt.OCR && Volt.OCR.available) {
          const ocrRects = Volt.OCR.searchRects(n, q);
          if (ocrRects.length) {
            results.push({ page: n, rects: ocrRects });
            total += ocrRects.length;
          }
          continue;
        }
        const rects = [];
        for (const item of items) {
          const str = item.str.toLowerCase();
          // find every occurrence within this item (not just the first)
          let from = 0;
          while (true) {
            const idx = str.indexOf(q, from);
            if (idx === -1) break;
            // item.width/height are in PDF units; the transform includes the font
            // scale — normalize so the text-space box maps to PDF correctly.
            const s = Math.hypot(item.transform[0], item.transform[1]) || 1;
            const w = (item.width || 0) / s;
            const h = (item.height || 0) / s;
            const perChar = w / Math.max(str.length, 1);
            const x0 = idx * perChar;
            const x1 = Math.min(w, (idx + q.length) * perChar);
            const corners = [
              [x0, h], [x1, h], [x1, 0], [x0, 0],
            ];
            const pdfPts = corners.map(([x, y]) => {
              const m = pdfjsLib.Util.applyTransform([x, y], item.transform);
              return { x: m[0], y: m[1] };
            });
            rects.push({ pts: pdfPts });
            total++;
            from = idx + 1;
          }
        }
        if (rects.length) results.push({ page: n, rects });
      }
      this.search = { query, results, current: 0 };
      this.elements.searchCount.textContent = total ? `1/${total}` : "0";
      this.renderAllAnnotations();
      if (total) {
        this.goToPage(results[0].page, false);
        this._flashMatch(results[0].page, 0);
      } else {
        this.toast("No matches for “" + query + "”", "error");
      }
    },

    searchNext() {
      const s = this.search;
      if (!s || !s.results.length) return;
      const total = s.results.reduce((a, r) => a + r.rects.length, 0);
      s.current = (s.current + 1) % total;
      this._navigateSearch(s.current);
    },
    searchPrev() {
      const s = this.search;
      if (!s || !s.results.length) return;
      const total = s.results.reduce((a, r) => a + r.rects.length, 0);
      s.current = (s.current - 1 + total) % total;
      this._navigateSearch(s.current);
    },
    _navigateSearch(idx) {
      const s = this.search;
      let seen = 0;
      for (const r of s.results) {
        for (let i = 0; i < r.rects.length; i++) {
          if (seen === idx) {
            const total = s.results.reduce((a, rr) => a + rr.rects.length, 0);
            this.elements.searchCount.textContent = `${idx + 1}/${total}`;
            this.goToPage(r.page, false);
            this._flashMatch(r.page, i);
            return;
          }
          seen++;
        }
      }
    },
    clearSearch() {
      this.search = null;
      this.elements.searchCount.textContent = "";
      this.renderAllAnnotations();
    },
    _drawSearchHighlights(wrap, pageNum) {
      if (!this.search) return;
      const overlay = wrap.querySelector(".page-overlay");
      const vp = this.rendered.get(pageNum)?.viewport;
      if (!overlay || !vp) return;
      const ctx = overlay.getContext("2d");
      // find rects for this page
      const pageRes = this.search.results.find((r) => r.page === pageNum);
      if (!pageRes) return;
      let seen = 0;
      for (const r of this.search.results) {
        for (const rect of r.rects) {
          const isCurrent = r.page === pageNum && seen === this.search.current;
          if (r.page === pageNum) {
            const pts = rect.pts.map((p) => vp.convertToViewportPoint(p.x, p.y));
            const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
            const x = Math.min(...xs), y = Math.min(...ys);
            const w = Math.max(...xs) - x, h = Math.max(...ys) - y;
            ctx.fillStyle = isCurrent ? "rgba(76,201,240,0.45)" : "rgba(253,224,71,0.32)";
            ctx.fillRect(x, y, w, h);
          }
          seen++;
        }
      }
    },
    _flashMatch(pageNum, rectIdx) {
      setTimeout(() => {
        const r = this.rendered.get(pageNum);
        if (!r) return;
        const overlay = r.wrap.querySelector(".page-overlay");
        overlay.style.outline = "3px solid rgba(76,201,240,0.8)";
        overlay.style.outlineOffset = "-3px";
        setTimeout(() => { overlay.style.outline = ""; }, 1200);
      }, 50);
    },

    /* ── export ────────────────────────────────────────────── */
    async _doExport(kind) {
      const el = this.elements;
      const base = (this.currentDocInfo?.name || "document").replace(/\.pdf$/i, "");
      try {
        if (kind === "pdf") {
          const bytes = await Volt.Ann.toAnnotatedPdf();
          Utils.download(new Blob([bytes], { type: "application/pdf" }), base + "-annotated.pdf");
          this.toast("Annotated PDF exported", "ok");
        } else if (kind === "md") {
          Utils.download(new Blob([Volt.Ann.toMarkdown()], { type: "text/markdown" }), base + "-notes.md");
          this.toast("Markdown notes exported", "ok");
        } else if (kind === "chat") {
          if (!Volt.AI.messages.length) {
            this.toast("No chat history to export yet", "error");
          } else {
            Utils.download(new Blob([Volt.AI.toMarkdown()], { type: "text/markdown" }), base + "-chat.md");
            this.toast("Chat transcript exported", "ok");
          }
        } else if (kind === "ocr-txt") {
          if (!(Volt.OCR && Volt.OCR.hasText && Volt.OCR.hasText())) {
            this.toast("No OCR text for this document yet — run OCR first", "error");
          } else {
            Utils.download(new Blob([Volt.OCR.toText()], { type: "text/plain" }), base + "-ocr.txt");
            this.toast("OCR text exported", "ok");
          }
        } else if (kind === "ocr-md") {
          if (!(Volt.OCR && Volt.OCR.hasText && Volt.OCR.hasText())) {
            this.toast("No OCR text for this document yet — run OCR first", "error");
          } else {
            Utils.download(new Blob([Volt.OCR.toMarkdown()], { type: "text/markdown" }), base + "-ocr.md");
            this.toast("OCR text exported (Markdown)", "ok");
          }
        } else if (kind === "docx") {
          // Word / Google Docs / LibreOffice: the document's text (with
          // text-edit annotations applied), detected tables as real tables,
          // and embedded pictures as images — collected page by page. When
          // the Pages manager has a live selection, only those pages are
          // collected; otherwise the whole document (as before).
          const sel = this._pagesSelectedForExport();
          this.toast("Preparing Word document…", "ok");
          const doc = await global.OfficeExport.collect(this, sel && sel.pages);
          const bytes = global.OfficeExport.docx(doc);
          Utils.download(new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }), base + ".docx");
          this.toast("Word document exported" + (sel ? " — " + this._officeExportScope(sel) : "") + " · opens in Word, Google Docs & LibreOffice", "ok", false, this._openWithAction(bytes, base + ".docx"));
        } else if (kind === "xlsx") {
          const sel = this._pagesSelectedForExport();
          const tables = await global.OfficeExport.collectTables(this, sel && sel.pages);
          if (!tables.length) {
            this.toast("No tables detected in " + this._officeExportScope(sel, true) + " — try a table-heavy PDF", "error");
            return;
          }
          const bytes = global.OfficeExport.xlsx({ sheets: tables.map((t, i) => ({ name: "Table " + (i + 1) + (t.page ? " (p." + t.page + ")" : ""), rows: t.rows })) });
          Utils.download(new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), base + ".xlsx");
          this.toast("Spreadsheet exported — " + tables.length + " table" + (tables.length === 1 ? "" : "s") + (sel ? " from " + this._officeExportScope(sel) : "") + " · opens in Excel, Google Sheets & LibreOffice", "ok", false, this._openWithAction(bytes, base + ".xlsx"));
        } else if (kind === "pptx") {
          // PowerPoint / Google Slides / LibreOffice: the document as a
          // deck — a title slide, each page's prose, then one slide per
          // detected table and one per picture (same collectors as docx)
          const sel = this._pagesSelectedForExport();
          this.toast("Preparing PowerPoint…", "ok");
          const doc = await global.OfficeExport.collect(this, sel && sel.pages);
          const bytes = global.OfficeExport.pptx(doc);
          Utils.download(new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.presentationml.presentation" }), base + ".pptx");
          this.toast("PowerPoint exported" + (sel ? " — " + this._officeExportScope(sel) : " — tables & pictures as slides") + " · opens in PowerPoint, Google Slides & LibreOffice", "ok", false, this._openWithAction(bytes, base + ".pptx"));
        } else if (kind === "tsv") {
          const sel = this._pagesSelectedForExport();
          const tables = await global.OfficeExport.collectTables(this, sel && sel.pages);
          if (!tables.length) {
            this.toast("No tables detected in " + this._officeExportScope(sel, true) + " — nothing to copy", "error");
            return;
          }
          const tsv = global.OfficeExport.tsv(tables[0].rows);
          const ok = await this._writeClipboard(tsv);
          this.toast(ok
            ? "First table copied as TSV" + (sel ? " (" + this._officeExportScope(sel) + ")" : "") + " — paste into Google Sheets or Excel"
            : "Copy failed — clipboard unavailable", ok ? "ok" : "error");
        } else if (kind === "json") {
          // the backup carries exactly the layers the dialog's checkboxes
          // selected (annotations are always included; expAnn is locked), and
          // the document fingerprint is written only once it's computed — an
          // export in the first instants after opening waits for it
          await (this._fpPromise || Promise.resolve());
          const flags = { aiOverrides: el.expAi.checked, chatHistory: el.expChat.checked };
          Utils.download(new Blob([Volt.Ann.toJSON(flags)], { type: "application/json" }), base + "-annotations.json");
          const parts = ["annotations"];
          if (flags.aiOverrides) parts.push("AI overrides");
          if (flags.chatHistory) parts.push("chat history");
          this.toast("Backup exported (" + parts.join(" + ") + ")", "ok");
        } else if (kind === "import") {
          el.importInput.click();
        } else if (kind === "restore") {
          el.restoreInput.click();
        } else if (kind === "restore-url") {
          // the URL modal is one-at-a-time — close the export menu first
          this._closeModal(el.exportModal);
          this._openUrlModal("backup");
        }
      } catch (e) {
        this.toast("Export failed: " + (e.message || e), "error");
      }
      this._closeModal(el.exportModal);
    },

    async _importAnnotations(file) {
      try {
        const text = await file.text();
        Volt.Ann.importFromJSON(text);
        this.toast("Imported " + Volt.Ann.list.length + " annotations", "ok");
      } catch (e) {
        this.toast("Import failed: " + e.message, "error");
      }
    },

    /* ── restore backup (match a .json to its PDF) ─────────── */
    _namesMatch(a, b) {
      return String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();
    },
    /** Strong match: content fingerprint when BOTH sides have one (v5+ backups
        and open documents) — a renamed copy of the same PDF still matches (the
        name isn't consulted), while a doctored file with identical size does
        not (its text changed, so the hash differs). Text-less documents can't
        be fingerprinted, so those fall back to name + size + pages, and older
        backups (name only) to the name heuristic. */
    _matchesBackup(data, backupName, current) {
      const bf = data && typeof data === "object" && !Array.isArray(data) ? data.fileFingerprint : undefined;
      const cf = this.currentDocInfo ? this.currentDocInfo.fingerprint : undefined;
      if (typeof bf === "string" && typeof cf === "string") {
        return bf === cf;
      }
      if (data && typeof data === "object" && !Array.isArray(data) &&
          data.fileSize !== undefined && data.filePages !== undefined && this.currentDocInfo) {
        return this._namesMatch(backupName, current) &&
          Number(data.fileSize) === Number(this.currentDocInfo.size) &&
          Number(data.filePages) === Number(this.currentDocInfo.pages);
      }
      return this._namesMatch(backupName, current);
    },
    async _restoreBackup(file) {
      try {
        await this._matchAndApplyBackup(this._parseBackup(await file.text()));
      } catch (e) {
        this.toast("Restore failed: " + (e.message || e), "error");
      }
    },
    _showRestorePrompt(backupName, currentName) {
      const el = this.elements;
      const esc = Utils.esc;
      el.restoreMsg.innerHTML = currentName
        ? `This backup is for <b>${esc(backupName)}</b>, but <b>${esc(currentName)}</b> is open.<br><br>Open the matching PDF to restore its annotations, AI overrides, and chat there — or import into the current document anyway.`
        : `This backup is for <b>${esc(backupName)}</b>.<br><br>Open that PDF to restore its annotations, AI overrides, and chat — nothing is applied until a document is open.`;
      el.restoreAnyway.hidden = !currentName;
      this._openModal(el.restoreModal);
    },
    /** Await the just-opened document's fingerprint, then apply the pending
        backup only when the identity matches (or the backup is legacy — name
        only). Mismatches go through the normal prompt instead of importing a
        backup for a different/doctored document. Only ever called from
        _docReady (a document is open, so current is always set) — which makes
        this exactly _matchAndApplyBackup; the dismissal guard is the only
        difference. */
    async _deferredApplyPendingBackup() {
      await (this._fpPromise || Promise.resolve());
      if (!this._pendingBackup) return; // the user dismissed the prompt meanwhile
      await this._matchAndApplyBackup(this._pendingBackup);
    },
    _applyPendingBackup() {
      const data = this._pendingBackup;
      if (!data) return;
      this._pendingBackup = null; // clear FIRST: a prompt may never have opened, so _closeModal alone wouldn't run
      this._closeModal(this.elements.restoreModal);
      try {
        Volt.Ann.importFromJSON(JSON.stringify(data));
        this._showRestoreSummary(data); // the card replaces the old one-line toast
      } catch (e) {
        this.toast("Restore failed: " + (e.message || e), "error");
      }
    },
    /** Post-restore summary card — after "Restore backup…" the user may want
        to double-check what landed, so instead of a single toast line Volt
        shows a compact card for a few seconds: the annotation count (with
        mark/note split), the applied AI override values, and the restored
        chat length. Rows reflect what the backup actually carried — a layer
        left unticked at export reads "Not in this backup". Auto-dismisses
        after 8s; the close button (or any modal / new document) dismisses
        sooner. */
    _showRestoreSummary(data) {
      const el = this.elements;
      const esc = Utils.esc;
      // the row-building is pure (Utils.restoreSummaryRows, unit-tested) —
      // this reads the live Volt/DOM state and hands it the plain facts
      const ann = Volt.Ann.list;
      const notes = ann.filter((a) => a.type === "note").length;
      const aiInBackup = !!(data && data.aiSettings && typeof data.aiSettings === "object" && !Array.isArray(data.aiSettings));
      const eff = (Volt.AI._docSettings && Volt.AI._docSettings()) || {};
      const chatInBackup = !!(data && Array.isArray(data.chatHistory));
      const chatCount = chatInBackup
        ? (Array.isArray(Volt.AI.messages) ? Volt.AI.messages.length : data.chatHistory.length)
        : 0;
      const rows = Utils.restoreSummaryRows({
        annCount: ann.length,
        notes,
        ai: aiInBackup ? eff : null,
        aiInBackup,
        chatInBackup,
        chatCount,
      });
      clearTimeout(this._restoreSummaryTimer);
      // un-hide BEFORE writing the rows: a live region (role="status") only
      // announces mutations that happen while it is visible — writing while
      // hidden would silently skip the screen-reader announcement. The two
      // statements are in the same synchronous block, so there is no paint
      // between them and no empty-card flash.
      el.restoreSummary.hidden = false;
      el.restoreSummaryBody.innerHTML = rows.map((r) =>
        `<div class="rs-row"><span class="rs-k">${esc(r.k)}</span><span class="rs-v" title="${esc(r.title)}">${esc(r.v)}</span></div>`).join("");
      this._restoreSummaryTimer = setTimeout(() => this._hideRestoreSummary(), 8000);
    },
    _hideRestoreSummary() {
      clearTimeout(this._restoreSummaryTimer);
      this._restoreSummaryTimer = null;
      this.elements.restoreSummary.hidden = true;
    },

    /* ── URL open / restore ────────────────────────────────── */
    /** The URL modal is dual-purpose: "Open PDF from URL" (pdf) and
        "Restore backup from URL" (backup). The mode rides on the modal's
        data-mode so Enter / Fetch route to the right handler. */
    _openUrlModal(mode) {
      const el = this.elements;
      const backup = mode === "backup";
      el.urlModal.dataset.mode = backup ? "backup" : "pdf";
      el.urlModalTitle.textContent = backup ? "Restore backup from URL" : "Open PDF from URL";
      el.urlInput.placeholder = backup ? "https://example.com/backup.json" : "https://example.com/doc.pdf";
      el.urlInput.value = "";
      this._openModal(el.urlModal);
    },
    _submitUrl() {
      if (this.elements.urlModal.dataset.mode === "backup") this._restoreFromUrl();
      else this._openUrl();
    },
    /** Restore backup from a URL: fetch the .json (or a direct link to one)
        and run the exact same match-and-open flow as a picked file. The fetch
        happens in the renderer, so the host must allow CORS — the same
        constraint as open-from-URL; a failed fetch says so, and a non-backup
        body (e.g. an HTML page) points at the raw/plain download link. */
    async _restoreFromUrl() {
      const el = this.elements;
      const url = el.urlInput.value.trim();
      if (!url) return;
      // http(s) for user-pasted links; blob: is also accepted — a same-origin
      // fetch target (used by the smoke test), never a security surface. Note
      // a blob: URL is "blob:http://…/uuid" — the prefix is NOT followed by //
      if (!/^(https?:\/\/|blob:https?:\/\/)/i.test(url)) {
        this.toast("Enter a full URL to the backup .json (https://…)", "error");
        return;
      }
      let data = null;
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error("HTTP " + res.status);
        data = this._parseBackup(await res.text());
      } catch (e) {
        // a body that isn't a backup (invalid JSON or wrong shape — e.g. an
        // HTML page) deserves the raw-link hint; HTTP statuses are the server's
        // answer; anything else is a network/CORS failure
        const badBody = e instanceof SyntaxError || /not a Volt backup/.test(e.message);
        const httpErr = !badBody && e.message && /^HTTP /.test(e.message);
        this.toast(badBody
          ? "That URL didn't return a Volt backup (.json with annotations). For a hosted page, use the raw/plain download link."
          : httpErr
            ? "Backup URL error: " + e.message
            : "Could not fetch backup URL (CORS or network): " + (e.message || e), "error");
        return;
      }
      this._closeModal(el.urlModal);
      el.urlInput.value = ""; // don't leave a fetchable URL sitting in the box
      await this._matchAndApplyBackup(data);
    },
    /** Parse a Volt backup string and validate its shape (annotations array). */
    _parseBackup(text) {
      const data = JSON.parse(text);
      const list = Array.isArray(data) ? data : data.annotations;
      if (!Array.isArray(list)) throw new Error("not a Volt backup (.json with annotations)");
      return data;
    },
    /** Shared restore tail: with the backup JSON in hand, wait for the open
        document's fingerprint, then match (fingerprint / size+pages / name)
        and either apply it or prompt the user to open the matching PDF. */
    async _matchAndApplyBackup(data) {
      this._pendingBackup = data;
      // the open document's fingerprint must be computed before matching —
      // otherwise a renamed copy would fall back to the weaker name/size
      // checks and be prompted for instead of auto-matched
      await (this._fpPromise || Promise.resolve());
      const backupName = (data && typeof data === "object" && !Array.isArray(data) && data.file) ? String(data.file) : "";
      const current = this.currentDocInfo ? this.currentDocInfo.name : "";
      if (!backupName || (current && this._matchesBackup(data, backupName, current))) {
        this._applyPendingBackup(); // same document (or a legacy backup) — import right away
      } else {
        this._showRestorePrompt(backupName, current);
      }
    },
    async _openUrl() {
      const url = this.elements.urlInput.value.trim();
      if (!url) return;
      const ok = await this._openUrlFrom(url);
      if (ok) {
        this._closeModal(this.elements.urlModal);
        this.elements.urlInput.value = ""; // don't leave a fetchable URL sitting in the box
      }
    },
    /** Open a PDF by URL — shared by the URL modal and the home screen's
        Recent documents (a recent URL entry refetches the same file). */
    async _openUrlFrom(url) {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error("HTTP " + res.status);
        const buf = await res.arrayBuffer();
        const name = decodeURIComponent(url.split("/").pop() || "document.pdf");
        this.currentPath = null; // a fetched URL has no local path to watch
        const ok = await this.openBuffer(buf, name, buf.byteLength);
        if (ok) this._pushRecent({ name, url }); // home screen: reopenable
        return ok;
      } catch (e) {
        this.toast("Could not fetch URL (CORS or network): " + e.message, "error");
        return false;
      }
    },

    /* ── sidebar / AI panel toggles ────────────────────────── */
    toggleSidebar() {
      document.body.classList.toggle("sidebar-hidden");
      this.elements.btnSidebar.classList.toggle("active");
      setTimeout(() => {
        if (this.zoomMode !== "custom") this._applyFitZoom();
        this._layoutPages();
        this._onScroll();
      }, 260);
    },
    toggleAI(force) {
      const show = force !== undefined ? force : document.body.classList.contains("ai-hidden");
      document.body.classList.toggle("ai-hidden", !show);
      this.elements.btnAi.classList.toggle("active", show);
      if (show) Volt.AI._renderModelLine();
      setTimeout(() => { if (this.zoomMode !== "custom") this._applyFitZoom(); this._onScroll(); }, 260);
    },

    /* ── status bar ────────────────────────────────────────── */
    _updateStatus() {
      const page = this._currentPageNum();
      this.elements.sbPage.textContent = page ? `p.${page} / ${this.pageLayout.length}` : "—";
      this.elements.sbZoom.textContent = Math.round(this.zoom * 100) + "%";
      this._updateSelStatus();
      if (this.search) {
        // update count to current
      }
    },

    /** Page range spanned by the current text selection (null when none, or
        when the selection isn't inside the page text layers — e.g. a chat
        input). Computed from the Range's endpoints via the `.page-wrap` they
        live in, so it survives virtualization: the range holds its text nodes
        even when far pages are disposed, keeping the readout truthful. */
    _selectionPageRange() {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
      const r = sel.getRangeAt(0);
      const pageOf = (node) => {
        if (!node) return null;
        const el = node.nodeType === Node.ELEMENT_NODE ? node : (node.parentElement || null);
        if (!el || typeof el.closest !== "function") return null;
        const wrap = el.closest(".page-wrap");
        const n = wrap ? parseInt(wrap.dataset.page, 10) : NaN;
        return Number.isFinite(n) ? n : null;
      };
      const a = pageOf(r.startContainer);
      const b = pageOf(r.endContainer);
      if (!a || !b) return null;
      return { from: Math.min(a, b), to: Math.max(a, b) };
    },

    /** Live status-bar readout of the selection's page range (e.g. "· Sel
        p.1–3"): hidden while no text selection is active, updated on every
        selectionchange and re-run on scroll / page nav via _updateStatus. */
    _updateSelStatus() {
      const el = this.elements.sbSel;
      const r = this.currentDoc ? this._selectionPageRange() : null;
      if (r) {
        el.hidden = false;
        el.textContent = "· Sel p." + r.from + (r.to !== r.from ? "–" + r.to : "");
      } else {
        el.hidden = true;
        el.textContent = "";
      }
    },

    refreshNotesBadge() {
      const n = Volt.Ann.list.length;
      this.elements.notesBadge.hidden = n === 0;
      this.elements.notesBadge.textContent = n;
    },

    /* ── keyboard ──────────────────────────────────────────── */
    _wireKeyboard() {
      window.addEventListener("keydown", (e) => {
        const modal = this._openModalEl();
        if (!modal && this.elements.app.inert) this.elements.app.inert = false; // self-heal: never let #app stay stuck inert
        if (modal) {
          // while a modal is open it owns the keyboard: Escape closes it and
          // everything else (shortcuts, page nav, Shift+?) is ignored — Tab is
          // already trapped by _trapTab in _wireModals. Exceptions (pages
          // manager only): Ctrl+Z / Ctrl+Shift+Z are lent to the STAGED
          // PLAN (annotation undo is meaningless while the plan is on screen,
          // so an accidental Delete/Insert is one key from never happening),
          // and Home/End move the plan SELECTION to the first/last page —
          // mirroring the viewer's own Home/End navigation — except when the
          // focus is in a text field, where they keep their native
          // start/end-of-text meaning.
          if (e.key === "Escape") {
            e.preventDefault();
            this._disarmPageDeleteConfirm(); // Escape cancels an armed 'Really …?' step too
            this._closeModal(modal);
          }
          if (modal === this.elements.pagesModal) {
            if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key.toLowerCase() === "z" || e.key.toLowerCase() === "y")) {
              e.preventDefault();
              if (e.shiftKey || e.key.toLowerCase() === "y") this._redoPagePlan();
              else this._undoPagePlan();
            } else if (e.key === "Home" || e.key === "End") {
              const t = e.target;
              const inField = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT");
              if (!inField) {
                e.preventDefault();
                // Shift+Home / Shift+End EXTEND the selection to the document
                // boundary (the keyboard twin of Shift+click); plain Home/End
                // keep their existing move-the-selection-to-first/last meaning
                if (e.shiftKey) this._extendPageSelection(e.key === "Home" ? "start" : "end");
                else this._selectPageExtent(e.key === "Home" ? 0 : (this._pagePlan || []).length - 1);
              }
            } else if (e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
              // Shift+↓ / Shift+↑ extend the selection one page in the travel
              // direction (grow-only and always contiguous, so a repeat never
              // drops already-selected pages) — same field guard as the other
              // selection shortcuts, so the move/insert inputs keep their
              // native caret meaning
              const t = e.target;
              const inField = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT");
              if (!inField) {
                e.preventDefault();
                this._extendPageSelection(e.key === "ArrowDown" ? 1 : -1);
              }
            } else if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "a") {
              // Ctrl+A selects every staged page — except inside a text field,
              // where it keeps its native select-all-text meaning
              const t = e.target;
              const inField = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT");
              if (!inField) {
                e.preventDefault();
                this._selectAllPages();
              }
            } else if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "i") {
              // Ctrl+I inverts the staged-page selection — same field guard
              // as Ctrl+A, so typing in the move/insert forms is never hijacked
              const t = e.target;
              const inField = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT");
              if (!inField) {
                e.preventDefault();
                this._invertPageSelection();
              }
            }
          }
          return;
        }
        // Escape cancels an in-flight range-render pass (Ctrl+A+A or
        // Ctrl+Shift+Space/Home/End on a long document) — the long op yields
        // to Escape BEFORE the normal Escape chain (deselect / menu-close)
        // runs, so a big selection can be aborted mid-render. Only active
        // while a render is actually in progress; otherwise Escape keeps its
        // usual behavior in the switch below.
        if (e.key === "Escape" && this._rangeRenderCancel) {
          e.preventDefault();
          this._rangeRenderCancel.cancelled = true;
          return;
        }
        const target = e.target;
        const inInput = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA");
        const mod = e.ctrlKey || e.metaKey;

        // don't hijack typing in inputs — except a few safe global ones.
        // Ctrl+D is deliberately NOT in that list: duplicating a highlight is
        // a viewer action, and in the browser Ctrl+D is the bookmark shortcut
        // (same trade every other shortcut already makes inside inputs).
        if (inInput) {
          if (mod && !e.altKey) {
            const k = e.key.toLowerCase();
            if (k === "o") { e.preventDefault(); this.elements.fileInput.click(); return; }
            if (k === "j") { e.preventDefault(); this.toggleAI(); return; }
            if (k === "b") { e.preventDefault(); this.toggleSidebar(); return; }
            if (k === "p" && e.shiftKey) { e.preventDefault(); this.openPagesManager(); return; }
          }
          if (e.key === "Escape" && target.id === "search-input") { this.clearSearch(); target.value = ""; target.blur(); }
          // Escape in the sidebar's move-form input closes the form (the
          // global Escape case below only runs OUTSIDE inputs)
          if (e.key === "Escape" && target.id === "thumb-move-pos") { this._hideThumbMoveForm(); target.blur(); }
          return;
        }

        // global shortcuts (outside inputs)
        if (mod && !e.altKey) {
          const k = e.key.toLowerCase();
          if (k === "o") { e.preventDefault(); this.elements.fileInput.click(); return; }
          if (k === "a") {
            // Ctrl+A selects ALL searchable text on the current page (like
            // standard PDF readers) instead of the browser's whole-DOM
            // select-all, which would grab the toolbar, status bar, page
            // labels — everything but the text. The Range lives in the page's
            // text layer, so it renders as a selection and copies cleanly.
            if (this.currentDoc) { e.preventDefault(); this.selectAllText(); }
            return;
          }
          if (k === "f") {
            if (this.currentDoc) { e.preventDefault(); this.elements.searchInput.focus(); this.elements.searchInput.select(); }
            return;
          }
          if (k === "j") { e.preventDefault(); this.toggleAI(); return; }
          if (k === "b") { e.preventDefault(); this.toggleSidebar(); return; }
          if (k === "d" && !e.shiftKey) {
            // duplicate the selected highlight (area or text) with a slight
            // offset — repeated presses stamp a column for form repetition.
            // (shiftKey excluded so Ctrl+Shift+D — the browser's "bookmark all
            // tabs" — isn't swallowed as a duplicate)
            e.preventDefault();
            if (!Volt.Ann.duplicateSelected()) {
              this.toast("Nothing selected — click a highlight, then Ctrl+D duplicates it");
            }
            return;
          }
          if (k === "=" || k === "+") { e.preventDefault(); this.setZoom(this.zoom * 1.2); return; }
          if (k === "-") { e.preventDefault(); this.setZoom(this.zoom / 1.2); return; }
          if (k === "0") { e.preventDefault(); this.fitWidth(); return; }
          if (k === "p" && e.shiftKey) { e.preventDefault(); this.openPagesManager(); return; }
          if (k === "z") { e.preventDefault(); if (e.shiftKey) Volt.Ann.redo(); else Volt.Ann.undo(); return; }
          // move the selected sidebar BLOCK to the start / end (Ctrl+Home /
          // Ctrl+End) or to a typed position (Ctrl+M opens the sidebar's
          // move-to form) — the keyboard path of the First / Last / Move to…
          // buttons, committing directly with 'Undo reorder' like the drag.
          // No selection: Home/End stay silent (plain Home/End still navigate
          // pages); Ctrl+M hints at the affordance.
          if (k === " " && e.shiftKey) {
            // Ctrl+Shift+Space: select ALL searchable text from the current
            // page to the END of the document — the whole-doc analog of
            // Ctrl+A, bound to the Space key's "forward" metaphor. Offers the
            // same persistent review toast (Highlight all + Copy w/ citations)
            // as Ctrl+A+A.
            e.preventDefault();
            if (this.currentDoc) {
              this._selectRangeActions(this._currentPageNum(), this.pageLayout.length);
            }
            return;
          }
          if (k === "home" || k === "end") {
            e.preventDefault();
            // Ctrl+Shift+Home / Ctrl+Shift+End: select all searchable text
            // from the current page to the document start / end — the
            // editor-standard mirrors of the Ctrl+Shift+Space selection.
            // (The non-shift Ctrl+Home/Ctrl+End keep moving the sidebar
            // block to the start/end below.)
            if (e.shiftKey && this.currentDoc) {
              const cur = this._currentPageNum();
              if (k === "home") this._selectRangeActions(1, cur);
              else this._selectRangeActions(cur, this.pageLayout.length);
              return;
            }
            if (this.currentDoc && this._thumbSel && this._thumbSel.size) {
              this._moveThumbBlockTo(k === "home" ? 1 : "last");
            }
            return;
          }
          if (k === "m") {
            e.preventDefault();
            if (this.currentDoc && this._thumbSel && this._thumbSel.size) this._showThumbMoveForm();
            else this.toast("Select a block in the sidebar (Shift+click pages) first");
            return;
          }
        }

        // Shift+arrow / Shift+Home / Shift+End with the sidebar's page thumbs:
        // keyboard-only multi-select, the SAME anchor/focus model as the
        // manager (page numbers, 1-based). Active while a thumb selection
        // exists OR the Pages panel is showing (so a keyboard-only start is
        // possible without a click); a selected highlight keeps priority
        // (the arrows nudge it in the switch below). With no selection the
        // first press anchors at the boundary page in the travel direction.
        if (e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey &&
            (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Home" || e.key === "End")) {
          const sideOpen = this.elements.sidebar && !document.body.classList.contains("sidebar-hidden") &&
            this.elements.panelPages && !this.elements.panelPages.hidden;
          if (((this._thumbSel && this._thumbSel.size) || sideOpen) && !Volt.Ann._selectedId) {
            e.preventDefault();
            this._extendThumbSelection(
              e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : e.key === "Home" ? "start" : "end");
            return;
          }
        }

        const isButton = target && target.closest && target.closest("button, .tb-btn, [role=button], textarea, select, input");
        switch (e.key) {
          case "ArrowDown":
            // with a highlight selected, arrows NUDGE it (1pt; Shift = 10pt)
            // instead of paging — pixel-level placement without mouse precision
            if (Volt.Ann._selectedId) { e.preventDefault(); Volt.Ann.nudgeSelected(0, -(e.shiftKey ? 10 : 1)); }
            else { if (!isButton) e.preventDefault(); this.nextPage(); }
            break;
          case "PageDown": if (!isButton) e.preventDefault(); this.nextPage(); break;
          case " ": if (!isButton) { e.preventDefault(); this.nextPage(); } break;
          case "ArrowUp":
            if (Volt.Ann._selectedId) { e.preventDefault(); Volt.Ann.nudgeSelected(0, e.shiftKey ? 10 : 1); }
            else { if (!isButton) e.preventDefault(); this.prevPage(); }
            break;
          case "PageUp": if (!isButton) e.preventDefault(); this.prevPage(); break;
          case "Home": e.preventDefault(); this.firstPage(); break;
          case "End": e.preventDefault(); this.lastPage(); break;
          case "ArrowRight":
            if (Volt.Ann._selectedId) { e.preventDefault(); Volt.Ann.nudgeSelected(e.shiftKey ? 10 : 1, 0); }
            else if (this.search) { e.preventDefault(); this.searchNext(); }
            break;
          case "ArrowLeft":
            if (Volt.Ann._selectedId) { e.preventDefault(); Volt.Ann.nudgeSelected(-(e.shiftKey ? 10 : 1), 0); }
            else if (this.search) { e.preventDefault(); this.searchPrev(); }
            break;
          case "+": case "=": this.setZoom(this.zoom * 1.2); break;
          case "-": case "_": this.setZoom(this.zoom / 1.2); break;
          case "w": case "W": this.fitWidth(); break;
          case "p": case "P": this.fitPage(); break;
          case "r": case "R": this.rotate(); break;
          case "h": case "H": Volt.Ann.setMode("highlight"); break;
          case "u": case "U": Volt.Ann.setMode("underline"); break;
          case "s": case "S": Volt.Ann.setMode("strike"); break;
          case "n": case "N": Volt.Ann.setMode("note"); break;
          case "Escape":
            if (Volt.Ann.mode !== "select") Volt.Ann.setMode("select");
            else if (Volt.Ann._closeAreaMenu()) { /* edit menu closed */ }
            else if (Volt.Ann._selectedId) Volt.Ann._deselectArea();
            else if (!this.elements.notePopover.hidden) Volt.Ann._closeNote();
            else if (!this.elements.aiDocPopover.hidden) Volt.AI._closeDocPopover();
            else if (global.Volt.AI._closeGlobalPop && !this.elements.aiGlobalPop.hidden) Volt.AI._closeGlobalPop();
            else if (!this.elements.thumbMoveForm.hidden) this._hideThumbMoveForm();
            else this.clearSearch();
            break;
          case "?": if (e.shiftKey) { e.preventDefault(); this._openModal(this.elements.helpModal); } break;
        }
      });

      // page pointer capture: annotation drags in annotate modes; area-highlight
      // selection / move / resize in select mode
      this.elements.pages.addEventListener("mousedown", (e) => {
        const wrap = e.target.closest(".page-wrap");
        if (!wrap) return;
        if (Volt.Ann.mode === "select") {
          Volt.Ann.onAreaMouseDown(e, wrap);
          return;
        }
        // annotation modes: text selection is disabled; drag draws
        if (e.button !== 0) return;
        Volt.Ann.beginDrag(e, wrap);
      });
      // right-click an area highlight (select mode) for the edit menu
      this.elements.pages.addEventListener("contextmenu", (e) => {
        const wrap = e.target.closest(".page-wrap");
        if (!wrap) return;
        if (Volt.Ann.onAreaContextMenu(e, wrap)) e.preventDefault();
      });
      // the status-bar page-range readout tracks the text selection LIVE —
      // selectionchange fires on every mutation (mouse drags, the Ctrl+A / A
      // and boundary-selection gestures, programmatic clears), and
      // _updateStatus re-runs it on scroll / page nav
      document.addEventListener("selectionchange", () => {
        if (this.currentDoc) this._updateSelStatus();
      });
    },

    /* ── toasts ──────────────────────────────────────────────
       toast(msg, type, sticky, action) — `action` is a {label, onClick}
       button, or an ARRAY of them (the selection toasts carry two: Highlight
       all + Copy w/ citations). Actionable toasts live longer (8s) so the
       user has time to click; clicking any action dismisses the toast first,
       then runs its onClick. */
    toast(msg, type = "", sticky = false, action = null) {
      const t = document.createElement("div");
      t.className = "toast " + type;
      t.textContent = msg;
      const actions = Array.isArray(action) ? action : (action ? [action] : []);
      for (const a of actions) {
        if (!a || !a.label) continue;
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "toast-action";
        btn.textContent = a.label;
        btn.addEventListener("click", () => {
          if (a.confirm && btn.dataset.armed !== "1") {
            // confirm step (the pages-manager Delete guard, at toast level):
            // the first click ARMS — the label flips to the confirm text for
            // 3s and the toast stays up; a second click on the SAME button
            // within the window decides. Any other click dismisses the toast
            // (sticky review toasts), and the timer expiry restores the
            // label with the toast still up — so one accidental click never
            // runs a destructive action, and walking away leaves no armed
            // state behind.
            btn.dataset.origLabel = a.label;
            btn.dataset.armed = "1";
            btn.textContent = a.confirm;
            btn.classList.add("armed");
            clearTimeout(t._timer); // the confirm window replaces the auto-expire
            if (a._confirmTimer) clearTimeout(a._confirmTimer);
            a._confirmTimer = setTimeout(() => {
              if (btn.dataset.armed === "1") {
                delete btn.dataset.armed;
                btn.textContent = btn.dataset.origLabel;
                btn.classList.remove("armed");
                delete btn.dataset.origLabel;
              }
            }, 3000);
            return; // this click only armed the confirm — the toast stays up
          }
          clearTimeout(t._timer);
          if (a._confirmTimer) clearTimeout(a._confirmTimer);
          t.style.opacity = "0"; t.style.transform = "translateY(6px)"; t.style.transition = "all .3s";
          setTimeout(() => t.remove(), 320);
          if (typeof a.onClick === "function") a.onClick();
        });
        t.appendChild(btn);
      }
      this.elements.toasts.appendChild(t);
      if (!sticky) {
        const dismiss = () => {
          t.style.opacity = "0"; t.style.transform = "translateY(6px)"; t.style.transition = "all .3s";
          setTimeout(() => t.remove(), 320);
        };
        t._timer = setTimeout(dismiss, actions.length ? 8000 : 3200);
      } else if (actions.length) {
        // persistent REVIEW toast (the Ctrl+A / Ctrl+A+A "Selected …" toasts
        // with their action buttons): no auto-expire — the page count must
        // stay visible while the user reviews a long selection. Dismissed by
        // clicking the toast body, any action button (its own handler), or
        // ANYWHERE outside the toast (pointerdown). Sticky progress toasts
        // (OCR etc.) have no action, so they keep their explicit lifecycle.
        const dismiss = () => {
          if (!t.isConnected) return; // idempotent — an action may have cleared it first
          clearTimeout(t._timer);
          document.removeEventListener("pointerdown", onOutside);
          t.style.opacity = "0"; t.style.transform = "translateY(6px)"; t.style.transition = "all .3s";
          setTimeout(() => t.remove(), 320);
        };
        const onOutside = (e) => { if (!t.contains(e.target)) dismiss(); };
        document.addEventListener("pointerdown", onOutside);
        t.addEventListener("click", (e) => {
          if (e.target && e.target.tagName === "BUTTON") return; // action buttons dismiss + run themselves
          dismiss();
        });
        t._dismiss = dismiss; // callers (the next selection, a doc open) can clear it
      }
      return t;
    },
    /** Clear the current selection toast (Ctrl+A / Ctrl+A+A) so a new one
        replaces it instead of stacking — the latest selection's count wins. */
    _clearSelToast() {
      if (this._selToast) {
        try { if (this._selToast._dismiss) this._selToast._dismiss(); } catch (e) { /* ignore */ }
        this._selToast = null;
      }
    },
    _dismissToast() {
      if (this._loadingToast) { this._loadingToast.remove(); this._loadingToast = null; }
    },
  };

  // boot
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => Volt.App.init());
  } else {
    Volt.App.init();
  }
})(window);






// volt:artifact-regression-marker (harmless trailing comment)

// volt:artifact-regression-marker (harmless trailing comment)

// volt:artifact-regression-marker (harmless trailing comment)
