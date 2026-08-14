/* ═══════════════════════════════════════════════════════════════
   ai.js — Volt.AI
   OpenAI-compatible chat client (Ollama, LM Studio, OpenAI, Groq,
   OpenRouter, or any compatible endpoint) + document grounding.
   ═══════════════════════════════════════════════════════════════ */
(function (global) {
  "use strict";

  const Volt = global.Volt = global.Volt || {};

  const PRESETS = {
    ollama: {
      baseUrl: "http://localhost:11434/v1",
      model: "llama3.2:3b",
      key: "",
      models: ["llama3.2:3b", "qwen3:8b", "deepseek-r1:8b", "granite3.3:8b", "gemma4:26b"],
    },
    lmstudio: {
      baseUrl: "http://localhost:1234/v1",
      model: "",
      key: "",
      models: [],
    },
    openai: {
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
      key: "",
      models: ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "gpt-4.1-mini", "o3-mini"],
    },
    openrouter: {
      baseUrl: "https://openrouter.ai/api/v1",
      model: "meta-llama/llama-3.3-70b-instruct:free",
      key: "",
      models: ["meta-llama/llama-3.3-70b-instruct:free", "anthropic/claude-3.5-sonnet", "openai/gpt-4o-mini"],
    },
    groq: {
      baseUrl: "https://api.groq.com/openai/v1",
      model: "llama-3.3-70b-versatile",
      key: "",
      models: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant", "gemma2-9b-it"],
    },
    custom: {
      baseUrl: "",
      model: "",
      key: "",
      models: [],
    },
  };

  // quick per-document system-prompt presets (the header "persona" picker).
  // Each is a complete standalone system prompt — it replaces the global one
  // for this document, exactly like a hand-typed override in ⚙.
  const PERSONA_PRESETS = {
    legal: {
      label: "Legal",
      prompt: "You are Volt, a precise legal assistant reviewing this document. Explain clauses in plain, unambiguous English; flag risky terms, obligations, deadlines, and anything missing. Cite page numbers like [p.3]. Never invent terms that aren't in the document — if something isn't there, say so.",
    },
    beginner: {
      label: "Beginner",
      prompt: "You are Volt, a patient teacher. Explain this document as if to a complete beginner: define every term of art, break ideas into small steps, and use simple everyday analogies. Cite page numbers like [p.3]. Offer to go deeper on any part.",
    },
    concise: {
      label: "Concise",
      prompt: "You are Volt, a ruthlessly concise assistant. Answer in the fewest words that are still complete: short sentences, no filler, no preamble. Cite page numbers like [p.3]. If the answer isn't in the document, say so in one line.",
    },
  };

  // Personas are editable per-user: the first read seeds localStorage, and
  // every picker/manager read after that uses the saved list, so renames,
  // rewording, additions, and deletions all persist (and survive app updates).
  const PERSONA_STORAGE_KEY = "volt:ai:personas";
  // Keys the pickers treat as actions, not personas — a hand-edited store
  // naming a persona like __manage__ or __none__ would shadow that option
  // (the model picker guards its own sentinels the same way)
  const PERSONA_RESERVED_KEYS = new Set(["__global__", "__custom__", "__manage__", "__none__"]);

  // first-run local-LLM bootstrap: while NO model is configured, the AI
  // panel offers a one-click path to a working local setup — detect Ollama
  // (http://localhost:11434), install it if missing (Electron bridge), pull
  // qwen3:4b with a live progress bar, and set it as the default model.
  const BOOTSTRAP_MODEL = "qwen3:4b";
  const BOOTSTRAP_SKIP_KEY = "volt:ai:bootstrap-skip"; // "Not now" — persisted so it never nags again

  // First-run detection ranking: when several models are installed, pick the
  // best-known one instead of assuming a fixed default. Preference order —
  // qwen3 tiers (the family Volt recommends; Apache-2.0, strong at small-size
  // tool calling), then other small capable instruct models, then anything
  // installed (a working unknown model beats an empty default). Exact tag
  // names; a tag like "qwen3" (no size) or "qwen3:latest" falls through to
  // the generic bucket below.
  const MODEL_PREFERENCE = [
    "qwen3:8b", "qwen3:4b", "qwen3:1.7b",
    "llama3.2:3b", "llama3.2:1b",
    "granite3.3:8b", "granite3.3:3b",
    "deepseek-r1:8b", "deepseek-r1:7b", "deepseek-r1:1.5b",
    "phi4-mini", "phi3:mini",
    "gemma3:4b", "gemma3:1b",
    "mistral:7b", "llama3.1:8b", "qwen2.5:7b", "qwen2.5:3b",
  ];

  // Model-quality tiers for the ⚙ settings row (Ollama only). Same family as
  // the bootstrap's default — qwen3 is Apache-2.0, strong at small-size tool
  // calling, and these three sizes cover most machines.
  const MODEL_TIERS = [
    {
      model: "qwen3:1.7b",
      name: "1.7b",
      size: "~1.2 GB",
      ram: "4–8 GB RAM",
      desc: "Fastest — runs on almost anything (even a 4 GB laptop, CPU-only). Best for short summaries and quick answers; tool use works but is less reliable than the tiers above.",
    },
    {
      model: "qwen3:4b",
      name: "4b",
      size: "~2.5 GB",
      ram: "8 GB RAM",
      desc: "The sweet spot — solid summaries and dependable tool calling on any 8 GB machine, CPU-only OK on a modern laptop. The default Volt recommends.",
    },
    {
      model: "qwen3:8b",
      name: "8b",
      size: "~5 GB",
      ram: "16 GB RAM",
      desc: "Best quality — noticeably sharper summaries and the most reliable tool use, at the cost of a bigger download and more RAM. Use it on 16 GB+ machines.",
    },
  ];

  const DEFAULT_SETTINGS = {
    provider: "ollama",
    baseUrl: PRESETS.ollama.baseUrl,
    // NO phantom default: a fresh install has no model configured until the
    // first-run probe finds what's actually installed (see _autoDetectDefault).
    // The old hardcoded llama3.2:3b made configured() true out of the box, so
    // chat pointed at a model that often wasn't installed and the bootstrap
    // card never had a chance to show.
    model: "",
    apiKey: "",
    temperature: 0.2,
    maxContextChars: 8000,
    privateOllama: false,       // app-owned private Ollama instance (own loopback port, origins pinned to Volt)
    privatePort: null,          // the private instance's port — persisted so the baseUrl stays stable across restarts
    historyLimit: 40,           // transcript cap per document (storage, backup, restore)
    noAutoRestart: false,       // version banner: count down and auto-restart, or always ask first
    systemPrompt: "You are Volt, an expert assistant inside a PDF reader. Ground every answer in the provided document excerpts and cite the page number like [p.3]. If the answer isn't in the excerpts, say so and suggest where to look. Be concise, clear, and honest.",
  };

  Volt.AI = {
    settings: { ...DEFAULT_SETTINGS },
    messages: [],            // [{role, content, sources, error}]
    streaming: false,
    abortCtrl: null,
    _pageTexts: null,        // cache [{page, text}] for current doc
    _chatHistory: null,      // per-file chat persistence key
    _pendingRestore: [],     // undo stack of doc-override snapshots (all-reset or per-field)
    _pendingChatRestore: [], // undo stack of transcript snapshots (Clear chat)
    _confirmArmed: null,     // {btn, timer} — a danger button in its 'Really …?' step
    _undoToastEl: null,      // the live 'Undo this change' toast (dismissed on a newer save)
    _bootstrap: null,        // first-run local-LLM bootstrap state {phase, pct, label, models}
    _bootstrapBusy: false,   // a detect/pull/install pass is in flight — don't re-enter
    _autoDetected: false,    // the first-run probe ran this session — don't re-probe
    _tier: null,             // model-quality tier state {model, installed, ollamaUp}
    _cors: null,             // Ollama CORS posture {wildcard, acao} — null = unknown/down
    _corsProbed: false,      // session flag: the posture was probed (panel open / settings open)
    _corsFixed: false,       // the user pinned OLLAMA_ORIGINS — warn 'restart to apply' instead
    _corsDismissed: false,   // session flag: the warning bar was dismissed
    _privateBusy: false,     // private-instance spawn/stop in flight — don't re-enter

    init() {
      const app = this._app();
      const els = app.elements;
      let everConfigured = false;
      try {
        const saved = localStorage.getItem("volt:ai:settings");
        if (saved) { everConfigured = true; this.settings = { ...DEFAULT_SETTINGS, ...JSON.parse(saved) }; }
      } catch (e) { /* ignore */ }
      this._syncPreset();
      // First run (no settings ever saved): probe Ollama for what's actually
      // installed and adopt the best verified model as the default, so the AI
      // never points at a phantom. Async + non-blocking: the probe is one
      // loopback GET; the bootstrap card still handles the nothing-installed
      // and no-Ollama cases when the panel opens.
      if (!everConfigured) this._autoDetectDefault();

      // settings modal
      els.setProvider.addEventListener("change", () => this._applyPreset());
      els.setTemperature.addEventListener("input", () => {
        els.setTemperatureVal.textContent = els.setTemperature.value;
      });
      els.setSave.addEventListener("click", () => this._saveSettings());
      els.setCancel.addEventListener("click", () => this._closeSettings());
      els.setTest.addEventListener("click", () => this._testConnection());
      els.setDocOverride.addEventListener("change", () => {
        const on = els.setDocOverride.checked;
        els.setDocModel.disabled = !on;
        els.setDocMaxctx.disabled = !on;
        els.setDocSysprompt.disabled = !on;
      });
      // header model pickers: per-document (doc open) and global (no doc) model
      // switching without opening the settings modal
      els.aiModelPicker.addEventListener("change", () => this._applyHeaderModel(els.aiModelPicker.value));
      els.aiModelGlobal.addEventListener("change", () => this._applyGlobalModel(els.aiModelGlobal.value));
      // header temperature stepper: global, same ±0.1 step as the ⚙ slider.
      // Note the finite check (not ||): temperature 0 is a valid value, and
      // `0 || 0.2` would make the 0-step bounce back up instead of clamping.
      const baseTemp = () => Number.isFinite(this.settings.temperature) ? this.settings.temperature : 0.2;
      els.aiTempDown.addEventListener("click", () => this._applyGlobalTemperature(baseTemp() - 0.1));
      els.aiTempUp.addEventListener("click", () => this._applyGlobalTemperature(baseTemp() + 0.1));
      // change-global-model popover (opened from the per-doc picker's
      // "✎ global default…" entry — the default model stays switchable with a
      // doc open). Enter saves, Escape closes, click-outside closes.
      els.aiGlobalSave.addEventListener("click", () => this._saveGlobalFromPop());
      els.aiGlobalCancel.addEventListener("click", () => this._closeGlobalPop());
      els.aiGlobalInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); this._saveGlobalFromPop(); }
        else if (e.key === "Escape") { e.preventDefault(); this._closeGlobalPop(); }
      });
      document.addEventListener("click", (e) => {
        // the picker is exempt: a native select's option click bubbles a click to
        // document AFTER the change event already opened the pop — treating it as
        // "outside" would close the pop the moment it opens
        if (!els.aiGlobalPop.hidden && !els.aiGlobalPop.contains(e.target) && !els.aiModelPicker.contains(e.target)) {
          this._closeGlobalPop();
        }
      });
      // header persona pickers: per-document presets for this doc, plus a
      // global persona picker that sets the global system prompt (applies to
      // every document without its own override)
      els.aiPromptPreset.addEventListener("change", () => this._applyPromptPreset(els.aiPromptPreset.value));
      els.aiPromptGlobal.addEventListener("change", () => this._applyGlobalPromptPreset(els.aiPromptGlobal.value));
      // persona manager: rename / reword / add the header presets (per-user,
      // stored under volt:ai:personas) — opened from the picker's manage entry.
      // The editor is a plain form: nothing is written until Save, so Cancel
      // (or a deleted row, or Restore defaults) never touches the saved list.
      els.personaSave.addEventListener("click", () => this._savePersonasFromEditor());
      els.personaCancel.addEventListener("click", () => this._closePersonaManager());
      els.personaAdd.addEventListener("click", () => this._addPersonaRow());
      els.personaReset.addEventListener("click", () => this._restoreDefaultPersonas());
      els.personaList.addEventListener("click", (e) => {
        const del = e.target.closest(".persona-del");
        if (!del) return;
        const row = del.closest(".persona-row");
        if (row) row.remove();
        if (!els.personaList.querySelector(".persona-row")) {
          els.personaList.innerHTML = '<div class="none">No personas yet — add one below.</div>';
        }
        els.personaAdd.focus(); // keep the keyboard flow inside the editor
      });
      // clickable "· this doc" marker — opens the doc-settings popover (the
      // summary + edit affordances live there; no modal to dismiss); hovering
      // it still shows the quick effective-prompt peek
      els.aiDocMarker.addEventListener("click", () => this._markerClick());
      els.aiDocMarker.addEventListener("mouseenter", () => this._scheduleMarkerTip(true));
      els.aiDocMarker.addEventListener("mouseleave", () => this._scheduleMarkerTip(false));
      els.aiDocMarker.addEventListener("focus", () => this._scheduleMarkerTip(true));
      els.aiDocMarker.addEventListener("blur", () => this._scheduleMarkerTip(false));
      els.aiMarkerTip.addEventListener("mouseenter", () => this._scheduleMarkerTip(true));
      els.aiMarkerTip.addEventListener("mouseleave", () => this._scheduleMarkerTip(false));
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
          this._hideMarkerTip();
          this._disarmConfirm(); // Escape cancels an armed 'Really …?' step
        }
      });
      // doc-settings popover: shows this document's active overrides, jumps to ⚙
      els.aiDocSettings.addEventListener("click", (e) => { e.stopPropagation(); this._toggleDocPopover(); });
      // 'Edit in settings…' jumps straight to the per-document override section
      // (scrolled, flashed, focused) — the path the marker used to take
      els.aiDocPopEdit.addEventListener("click", () => this.openSettings(true));
      els.aiDocPopReset.addEventListener("click", () => {
        if (this._pendingRestore && this._pendingRestore.length) {
          this._disarmConfirm(); // 'Undo reset' is restorative — never gated
          this._restoreDocOverrides();
        } else {
          this._confirmOrDo(els.aiDocPopReset, "Really reset?", () => this._resetDocOverrides());
        }
      });
      // per-field reset: the × on a Model / Context / Prompt row clears just
      // that override (keeping the others), undoable like the all-reset
      els.aiDocPopBody.addEventListener("click", (e) => {
        const x = e.target.closest(".row-x");
        if (x && x.dataset.field) {
          // _resetField re-renders the body, detaching this × mid-handler —
          // without stopping propagation the document outside-click handler
          // would see a detached target and close the popover (wiping the undo)
          e.stopPropagation();
          this._resetField(x.dataset.field);
        }
      });
      // 'Clear chat' in the same popover: wipes THIS document's conversation
      // (the volt:ai:chat: key + live transcript), undoable like the overrides
      els.aiDocPopClearChat.addEventListener("click", () => {
        if (this._pendingChatRestore && this._pendingChatRestore.length) {
          this._disarmConfirm(); // 'Undo clear chat' is restorative — never gated
          this._undoClearChat();
        } else {
          this._confirmOrDo(els.aiDocPopClearChat, "Really clear chat?", () => this._clearChatFromPop());
        }
      });
      document.addEventListener("click", (e) => {
        // `!isConnected` guards the detached-target trap: a handler that
        // re-renders the popover body mid-bubble (e.g. the per-field ×)
        // detaches its own target, making contains() lie about "outside"
        if (!els.aiDocPopover.hidden && !els.aiDocPopover.contains(e.target) && e.target !== els.aiDocSettings && e.target.isConnected !== false) {
          this._closeDocPopover();
        }
      });

      // chat input
      els.aiInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          this.send(els.aiInput.value);
        }
      });
      els.aiSend.addEventListener("click", () => this.send(els.aiInput.value));
      els.aiStop.addEventListener("click", () => this._stop());

      // quick actions — clear-hl / copy-hl are NOT prompts: they revert the
      // doc's highlights from chat (shared with the conversion toast's action)
      // and export the doc's highlighted passages as notes, so they route to
      // their own handlers instead of _quickAction
      els.aiPanel.querySelectorAll(".quick-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          if (btn.dataset.action === "clear-hl") this._quickClearHighlights(btn);
          else if (btn.dataset.action === "copy-hl") this._quickCopyHighlights();
          else this._quickAction(btn.dataset.action);
        });
      });

      // clickable source chips
      els.aiMessages.addEventListener("click", (e) => {
        const chip = e.target.closest(".src-chip");
        if (chip && chip.dataset.page) {
          this._app().goToPage(parseInt(chip.dataset.page, 10));
        }
      });

      // first-run local-LLM bootstrap: detect Ollama and offer the one-click
      // install/pull of qwen3:4b while no model is configured (see the
      // bootstrap section below for the full state machine)
      els.aiBootstrapPrimary.addEventListener("click", () => this._bootstrapPrimary());
      els.aiBootstrapSettings.addEventListener("click", () => { this._bootstrapDismiss(); this.openSettings(); });
      els.aiBootstrapDismiss.addEventListener("click", () => this._bootstrapDismiss());
      // model-quality tiers (⚙ settings, Ollama only): a chip picks the tier,
      // the action button installs it (one click) or applies it if present
      els.tierPresets.addEventListener("click", (e) => {
        const chip = e.target.closest(".tier-preset");
        if (chip) this._selectTier(chip.dataset.tier);
      });
      els.tierInstall.addEventListener("click", () => this._installTier());
      // Ollama CORS drive-by guard: wildcard OLLAMA_ORIGINS warns in the AI
      // panel and the ⚙ settings row, and "Restrict origins" pins the user
      // env to Volt's origins (Electron) or shows the command (browser)
      els.aiCorsFix.addEventListener("click", () => this._restrictOllamaOrigins());
      els.tierCorsFix.addEventListener("click", () => this._restrictOllamaOrigins());
      els.aiCorsDismiss.addEventListener("click", () => {
        this._corsDismissed = true;
        this._renderCorsWarning();
      });
      // private Ollama instance (⚙ settings, Ollama provider only): a
      // dedicated `ollama serve` on its own loopback port, origins pinned
      // to Volt — nothing else on the machine can reach the model
      els.privateOllamaToggle.addEventListener("click", () => this._togglePrivate());

      this._renderModelLine();
      this._restoreChat();
      // a saved private instance must be running for the saved baseUrl to
      // work — main re-spawns it (idempotent, same port when it's free)
      this._ensurePrivateOllama();
    },

    _app() { return global.Volt.App; },

    /* ── settings ───────────────────────────────────────────── */
    _syncPreset() {
      const sel = this._app().elements.setProvider;
      sel.value = this.settings.provider;
      this._fillFields();
    },
    _applyPreset() {
      const p = this._app().elements.setProvider.value;
      const preset = PRESETS[p];
      this._app().elements.setBaseurl.value = preset.baseUrl;
      this._app().elements.setModel.value = preset.model;
      if (preset.key) this._app().elements.setApikey.value = preset.key;
      this._fillModelSuggestions(preset.models);
      this._refreshQualityBlock(); // the tier row is Ollama-only
      this._corsProbed = false;   // a new provider gets a fresh CORS check
      this._renderCorsWarning();
    },
    _fillFields() {
      this._app().elements.setBaseurl.value = this.settings.baseUrl;
      this._app().elements.setModel.value = this.settings.model;
      this._app().elements.setApikey.value = this.settings.apiKey;
      this._app().elements.setTemperature.value = this.settings.temperature;
      this._app().elements.setTemperatureVal.textContent = this.settings.temperature;
      this._app().elements.setMaxctx.value = this.settings.maxContextChars;
      this._app().elements.setHistory.value = String(this.settings.historyLimit || 40);
      this._app().elements.setNoAutoRestart.checked = !!this.settings.noAutoRestart;
      this._app().elements.setSysprompt.value = this.settings.systemPrompt;
      const preset = PRESETS[this.settings.provider] || PRESETS.custom;
      this._fillModelSuggestions(preset.models);
    },
    _fillModelSuggestions(models) {
      const dl = this._app().elements.modelSuggestions;
      dl.innerHTML = "";
      for (const m of models || []) {
        const opt = document.createElement("option");
        opt.value = m;
        dl.appendChild(opt);
      }
      this._renderModelLine(); // keep the header picker's model list in sync
    },
    _saveSettings() {
      const els = this._app().elements;
      this.settings = {
        ...this.settings,
        provider: els.setProvider.value,
        baseUrl: els.setBaseurl.value.trim().replace(/\/+$/, ""),
        model: els.setModel.value.trim(),
        apiKey: els.setApikey.value.trim(),
        temperature: parseFloat(els.setTemperature.value),
        maxContextChars: parseInt(els.setMaxctx.value, 10) || 8000,
        historyLimit: this._historyLimit(parseInt(els.setHistory.value, 10)),
        noAutoRestart: !!els.setNoAutoRestart.checked,
        systemPrompt: els.setSysprompt.value,
      };
      // the private instance only makes sense for the Ollama provider — if the
      // saved provider isn't ollama, drop the private flag (and stop the
      // instance fire-and-forget so it isn't left running for nothing)
      if (this.settings.provider !== "ollama" && (this.settings.privateOllama || this.settings.privatePort)) {
        this.settings = { ...this.settings, privateOllama: false, privatePort: null };
        if (global.voltDesktop && global.voltDesktop.stopPrivateOllama) {
          try { this._stopPrivate(); } catch (e) { /* best-effort */ }
        }
      }
      try { localStorage.setItem("volt:ai:settings", JSON.stringify(this.settings)); } catch (e) { /* ignore */ }
      // per-document overrides ride with this PDF's data. Snapshot the OLD
      // override BEFORE applying — the modal closes on Save/Escape without
      // confirmation, so when the save actually changed this doc's override
      // we push that snapshot onto the same _pendingRestore stack the popover
      // uses and offer an 'Undo this change' toast (a fresh save supersedes
      // any earlier pending undo, like every other apply path).
      const prev = this._docSettings() || {};
      const prevHad = Boolean(prev.model || prev.maxContextChars || prev.systemPrompt);
      if (els.setDocOverride.checked) {
        const m = els.setDocModel.value.trim();
        const c = parseInt(els.setDocMaxctx.value, 10);
        const s = els.setDocSysprompt.value.trim();
        this._applyDocOverride(m, c, s);
        const changed = prevHad
          ? (prev.model || null) !== (m || null) ||
            (prev.maxContextChars || null) !== (c > 0 ? c : null) ||
            (prev.systemPrompt || null) !== (s || null)
          : Boolean(m || c > 0 || s);
        if (changed) {
          this._pushUndo(prevHad ? prev : null); // null snapshot = 'had no overrides'
          this._offerOverrideUndo();
        }
      } else {
        this._clearDocSettings();
        if (prevHad) {
          this._pushUndo(prev);
          this._offerOverrideUndo();
        }
      }
      this._closeSettings();
      this._renderModelLine();
      this._app().toast("AI settings saved", "ok");
    },
    /** Offer to revert the doc-override change just saved from the settings
        modal — the snapshot is already on the _pendingRestore stack; the toast
        button pops and restores it (the same restore the popover's Undo
        reset button performs). A NEW override save supersedes the previous
        one's undo, so any earlier undo toast is dismissed first — a stale one
        would otherwise linger and revert the newer change. */
    _offerOverrideUndo() {
      const prev = this._undoToastEl;
      if (prev) {
        clearTimeout(prev._timer);
        prev.style.opacity = "0"; prev.style.transform = "translateY(6px)"; prev.style.transition = "all .3s";
        setTimeout(() => prev.remove(), 320);
        this._undoToastEl = null;
      }
      this._undoToastEl = this._app().toast("This document's AI overrides were updated", "ok", false, {
        label: "Undo this change",
        onClick: () => { this._undoToastEl = null; this._restoreDocOverrides(); },
      });
    },
    _closeSettings() { this._app()._closeModal(this._app().elements.settingsModal); },
    openSettings(focusOverride = false) {
      this._closeDocPopover();
      this._syncPreset();
      this._refreshQualityBlock(); // re-probe installed tiers (Ollama row)
      const el = this._app().elements;
      const hasDoc = Boolean(this._app().currentDocInfo);
      el.docOverrideBlock.hidden = !hasDoc;
      if (hasDoc) {
        const d = this._docSettings() || {};
        const on = Boolean(d.model || d.maxContextChars || d.systemPrompt);
        el.setDocOverride.checked = on;
        el.setDocModel.value = d.model || "";
        el.setDocMaxctx.value = d.maxContextChars || "";
        el.setDocSysprompt.value = d.systemPrompt || "";
        el.setDocModel.disabled = !on;
        el.setDocMaxctx.disabled = !on;
        el.setDocSysprompt.disabled = !on;
      }
      this._app()._openModal(el.settingsModal);
      // opened from the "· this doc" marker: jump straight to the per-document
      // section — scroll it into view, flash it, and land focus on its checkbox
      if (focusOverride && hasDoc) {
        requestAnimationFrame(() => {
          const block = el.docOverrideBlock;
          block.scrollIntoView({ block: "center", behavior: "smooth" });
          block.classList.add("flash");
          setTimeout(() => block.classList.remove("flash"), 1400);
          // #app is inert while the modal is open, which swallows focus() —
          // release inert for the move, then re-apply (same workaround as
          // _trapTab's Tab cycling)
          const app = this._app().elements.app;
          app.inert = false;
          el.setDocOverride.focus();
          app.inert = true;
        });
      }
    },

    async _testConnection() {
      const btn = this._app().elements.setTest;
      const base = this._app().elements.setBaseurl.value.trim().replace(/\/+$/, "");
      const key = this._app().elements.setApikey.value.trim();
      btn.textContent = "Testing…";
      btn.disabled = true;
      try {
        const res = await fetch(base + "/models", {
          headers: key ? { Authorization: "Bearer " + key } : {},
        });
        if (!res.ok) throw new Error("HTTP " + res.status);
        const data = await res.json();
        const names = (data.data || []).map((m) => m.id).slice(0, 12);
        this._fillModelSuggestions(names);
        this._app().toast(`Connected ✓ ${names.length} models available`, "ok");
      } catch (e) {
        this._app().toast("Connection failed: " + (e.message || e), "error");
      } finally {
        btn.textContent = "Test connection";
        btn.disabled = false;
      }
    },

    /* ── per-document AI overrides ──────────────────────────── */
    _docSettingsKey() {
      const doc = this._app().currentDocInfo;
      return doc ? "volt:ai:doc:" + Utils.hash(doc.name + ":" + doc.size + ":" + doc.pages) : null;
    },
    _docSettings() {
      const key = this._docSettingsKey();
      if (!key) return null;
      try {
        const raw = localStorage.getItem(key);
        if (raw) return JSON.parse(raw);
      } catch (e) { /* ignore */ }
      return null;
    },
    /** Does the current document carry any AI overrides (model / context / prompt)? */
    _docHasOverrides() {
      const d = this._docSettings();
      return Boolean(d && (d.model || d.maxContextChars || d.systemPrompt));
    },
    _saveDocSettings(o) {
      const key = this._docSettingsKey();
      if (!key) return;
      try { localStorage.setItem(key, JSON.stringify(o)); } catch (e) { /* ignore */ }
    },
    /** Friendly provider label for hints (mirrors the status-bar wording). */
    _providerName(key) {
      return {
        ollama: "Ollama", lmstudio: "LM Studio", openai: "OpenAI", groq: "Groq",
        openrouter: "OpenRouter", custom: "a custom endpoint",
      }[key] || String(key || "?");
    },
    /** Provider + endpoint recorded alongside a model override, so the popover
        can warn when the model was chosen under a different provider than the
        one currently configured. Stamped only when the MODEL actually changes
        (a persona-preset or context edit must not rewrite the original
        provenance); restored verbatim from backups when passed in. */
    _docProvenance(prev, model, provider, endpoint) {
      const modelChanged = model !== (prev.model || null);
      const p = provider !== undefined ? provider
        : (modelChanged ? this.settings.provider : (prev.provider || null));
      const e = endpoint !== undefined ? endpoint
        : (modelChanged ? this.settings.baseUrl : (prev.endpoint || null));
      return model ? { provider: p, endpoint: e } : { provider: null, endpoint: null };
    },
    _clearDocSettings(keepUndo = false) {
      // any clear supersedes a pending popover undo — unless the caller (a
      // reset action) already pushed its own snapshot and asks to keep it
      if (!keepUndo) this._pendingRestore = [];
      const key = this._docSettingsKey();
      if (key) try { localStorage.removeItem(key); } catch (e) { /* ignore */ }
    },
    /* ── change-global-model popover ───────────────────────────
       Opened from the per-doc picker's "✎ global default…" entry: the global
       default stays editable even while a document is open (no settings modal).
       Positions like the doc-settings popover, anchored below the header. */
    _openGlobalPop() {
      const els = this._app().elements;
      this._closeDocPopover(); // only one floating panel at a time
      const hdr = this._app().elements.aiHeader;
      els.aiGlobalPop.style.top = (hdr ? hdr.offsetHeight + 8 : 58) + "px";
      els.aiGlobalInput.value = this.settings.model || "";
      els.aiGlobalPop.hidden = false;
      els.aiGlobalInput.focus();
      els.aiGlobalInput.select();
    },
    _closeGlobalPop() {
      const els = this._app().elements;
      if (els.aiGlobalPop) els.aiGlobalPop.hidden = true;
    },
    /** Save the popover's model as the new global default. */
    _saveGlobalFromPop() {
      const value = (this._app().elements.aiGlobalInput.value || "").trim();
      this._closeGlobalPop();
      if (!value) { this._app().toast("Model name can't be empty", "error"); return; }
      this._applyGlobalModel(value);
    },

    /** Set (or clear, via "__global__") this document's model from the header picker.
        Only the model field changes — any per-doc maxContext/systemPrompt are kept.
        "__global_edit__" instead opens the change-global-default popover.
        The provider active when the model is chosen is recorded alongside it. */
    _applyHeaderModel(value) {
      if (value === "__global_edit__") { // the entry is an action, not a choice
        this._openGlobalPop();
        this._renderModelLine(); // snap the picker back to the effective model
        return;
      }
      if (!this._docSettingsKey()) return;
      this._pendingRestore = []; // a fresh save supersedes any pending undo
      const d = this._docSettings() || {};
      const model = value === "__global__" ? null : value;
      if (model || d.maxContextChars || d.systemPrompt) {
        const prov = this._docProvenance(d, model); // the picker always means "set now"
        this._saveDocSettings({
          model,
          maxContextChars: d.maxContextChars || null,
          systemPrompt: d.systemPrompt || null,
          provider: prov.provider,
          endpoint: prov.endpoint,
        });
      } else {
        this._clearDocSettings();
      }
      this._renderModelLine();
      if (!this._app().elements.aiDocPopover.hidden) this._renderDocPopover();
      this._app().toast(model ? "This document now uses " + model : "This document now uses the global model", "ok");
    },

    /* ── doc-settings popover ───────────────────────────────── */
    _toggleDocPopover() {
      const pop = this._app().elements.aiDocPopover;
      this._closeGlobalPop(); // only one floating panel at a time
      if (pop.hidden) {
        // the header grows a persona row when a doc is open, so anchor the
        // popover below the header's live height instead of a fixed offset
        const hdr = this._app().elements.aiHeader;
        pop.style.top = (hdr ? hdr.offsetHeight + 8 : 58) + "px";
        this._renderDocPopover();
        pop.hidden = false;
        this._app().elements.aiDocSettings.setAttribute("aria-expanded", "true");
      } else {
        this._closeDocPopover(); // clears any pending undo, same as outside-click/Escape
      }
    },
    _closeDocPopover() {
      this._app().elements.aiDocPopover.hidden = true;
      this._app().elements.aiDocSettings.setAttribute("aria-expanded", "false");
      this._pendingRestore = []; // the undo affordances live in the popover
      this._pendingChatRestore = [];
      this._disarmConfirm();
    },

    /* ── clickable "· this doc" marker ────────────────────────
       Two states, one pill. With overrides it opens the doc-settings popover
       directly (the summary the marker-tip previews on hover, with per-field
       resets, Reset/Clear chat, and 'Edit in settings…') — no modal to
       dismiss for a quick look. Without overrides it is a dashed ghost pill
       that jumps straight to the ⚙ override section, so new users discover
       per-document settings without hunting for the gear. */
    _markerClick() {
      this._hideMarkerTip();
      if (this._docHasOverrides()) this._toggleDocPopover();
      else this.openSettings(true); // nothing to summarize — go set it up
    },
    _markerTipTimer: null,
    _markerHover: false,
    _scheduleMarkerTip(show) {
      clearTimeout(this._markerTipTimer);
      if (show) {
        this._markerHover = true;
        // even without an override the peek is meaningful: it shows what the
        // doc currently inherits (global model/context/prompt) and invites a
        // click to set one up
        this._markerTipTimer = setTimeout(() => { if (this._markerHover) this._showMarkerTip(); }, 250);
      } else {
        this._markerHover = false;
        this._markerTipTimer = setTimeout(() => { if (!this._markerHover) this._hideMarkerTip(); }, 150);
      }
    },
    _showMarkerTip() {
      const els = this._app().elements;
      const tip = els.aiMarkerTip, marker = els.aiDocMarker;
      if (marker.hidden) { this._hideMarkerTip(); return; }
      // never float the peek over the doc-settings popover — the popover IS
      // the summary now, so a lingering hover (e.g. after a Reset re-render)
      // must not show a duplicate stacked on top of it
      if (!els.aiDocPopover.hidden) { this._hideMarkerTip(); return; }
      const d = this._docSettings() || {};
      const eff = this._effective(d);
      const ctxNote = d.maxContextChars
        ? `<span class="tip-global"> (global: ${Number(this.settings.maxContextChars || 0).toLocaleString()})</span>`
        : "";
      const promptNote = d.systemPrompt ? "" : `<span class="tip-global"> using your global prompt</span>`;
      const prompt = d.systemPrompt || "—";
      const shown = prompt.length > 240 ? prompt.slice(0, 240).trimEnd() + "…" : prompt;
      tip.innerHTML =
        `<div class="tip-row"><span class="tip-k">Model</span><span class="tip-v">${Utils.esc(eff.model || "—")}${d.model ? ' <span class="tip-global">(override)</span>' : ""}</span></div>` +
        `<div class="tip-row"><span class="tip-k">Context</span><span class="tip-v">${Number(eff.maxContextChars || 0).toLocaleString()} chars${ctxNote}</span></div>` +
        `<div class="tip-row"><span class="tip-k">Prompt</span><span class="tip-v tip-prompt">${Utils.esc(shown)} ${promptNote}</span></div>` +
        `<div class="tip-hint">${this._docHasOverrides() ? "Click to open this document's AI settings" : "Click to set up this document's AI settings"}</div>`;
      const p = els.aiPanel.getBoundingClientRect();
      const r = marker.getBoundingClientRect();
      tip.hidden = false;
      tip.style.left = Math.max(0, Math.min(r.left - p.left, p.width - tip.offsetWidth - 8)) + "px";
      tip.style.top = (r.bottom - p.top + 6) + "px";
    },
    _hideMarkerTip() {
      clearTimeout(this._markerTipTimer);
      const tip = this._app().elements.aiMarkerTip;
      if (tip) tip.hidden = true;
    },
    /** Summarize this document's active overrides (only the fields actually set).
        When the override model was chosen under a DIFFERENT provider than the
        one currently configured (or a different custom endpoint), flag that it
        may not be reachable on the current endpoint — the request would still
        be sent there, and could 404 with a model-not-found. */
    _renderDocPopover() {
      this._disarmConfirm(); // re-rendering invalidates any armed confirm
      const body = this._app().elements.aiDocPopBody;
      const reset = this._app().elements.aiDocPopReset;
      const d = this._docSettings() || {};
      let html = "";
      // provider provenance check: model was set under provider A, the app now
      // points at provider B (or a different custom endpoint) — reachability is
      // not guaranteed. Legacy overrides without a provider stamp never warn.
      if (d.model && d.provider) {
        const provMismatch = d.provider !== this.settings.provider;
        const endpointMismatch = d.provider === "custom" && d.endpoint && d.endpoint !== this.settings.baseUrl;
        if (provMismatch || endpointMismatch) {
          const stored = d.provider === "custom" && d.endpoint
            ? "a custom endpoint (" + Utils.esc(d.endpoint) + ")"
            : this._providerName(d.provider);
          const now = this.settings.provider === "custom"
            ? "a custom endpoint (" + Utils.esc(this.settings.baseUrl) + ")"
            : this._providerName(this.settings.provider);
          html += `<div class="warn">⚠ This model was set under <b>${stored}</b>, but you're now on <b>${now}</b> — it may not be reachable on the current endpoint.</div>`;
        }
      }
      // each row carries its own × — clear just this field, undoable like the
      // all-reset button. Clearing the model also drops its provider/endpoint
      // stamp (those only describe where the model came from).
      if (d.model) {
        html += `<div class="row"><span class="k">Model</span><span class="v">${Utils.esc(d.model)} <span class="global">(global: ${Utils.esc(this.settings.model || "—")})</span></span><button class="row-x" data-field="model" title="Clear this document's model override" aria-label="Clear this document's model override">×</button></div>`;
      }
      if (d.maxContextChars) {
        html += `<div class="row"><span class="k">Context</span><span class="v">${Number(d.maxContextChars).toLocaleString()} chars <span class="global">(global: ${Number(this.settings.maxContextChars || 0).toLocaleString()})</span></span><button class="row-x" data-field="maxContextChars" title="Clear this document's context override" aria-label="Clear this document's context override">×</button></div>`;
      }
      if (d.systemPrompt) {
        const snippet = d.systemPrompt.length > 78 ? d.systemPrompt.slice(0, 78).trimEnd() + "…" : d.systemPrompt;
        html += `<div class="row"><span class="k">Prompt</span><span class="v">${Utils.esc(snippet)}</span><button class="row-x" data-field="systemPrompt" title="Clear this document's system prompt override" aria-label="Clear this document's system prompt override">×</button></div>`;
      }
      body.innerHTML = html || '<div class="none">No overrides — this document uses your global AI settings.</div>';
      // Reset ⇄ Undo reset (only meaningful when there is something to reset or restore)
      const hasOverrides = this._docHasOverrides();
      const pending = this._pendingRestore && this._pendingRestore.length ? this._pendingRestore.length : 0;
      reset.hidden = !hasOverrides && !pending;
      reset.textContent = pending ? (pending > 1 ? "Undo reset (" + pending + ")" : "Undo reset") : "Reset";
      reset.classList.toggle("danger", !pending);
      this._refreshChatPopBtn();
    },
    /* ── danger-button confirm step ────────────────────────────
       Destructive popover actions (Reset, Clear chat) arm a 3-second
       'Really …?' state: the first click only arms, the second click within
       the window (or any other interaction, which disarms) decides. Undo
       still covers the result — this just prevents one accidental click. */
    _confirmOrDo(btn, armedLabel, doAction) {
      if (btn.dataset.armed === "1") { // already confirming — this click means yes
        this._disarmConfirm();
        doAction();
        return;
      }
      this._armConfirm(btn, armedLabel);
    },
    _armConfirm(btn, armedLabel) {
      this._disarmConfirm(); // only one danger button armed at a time
      btn.dataset.origLabel = btn.textContent;
      btn.dataset.armed = "1";
      btn.textContent = armedLabel;
      btn.classList.remove("danger");
      btn.classList.add("armed");
      this._confirmArmed = {
        btn,
        timer: setTimeout(() => this._disarmConfirm(), 3000),
      };
    },
    _disarmConfirm() {
      const a = this._confirmArmed;
      this._confirmArmed = null;
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

    /** Sync the Clear chat button (label / visibility / danger) to the live
        transcript + undo state. Called on every popover render AND from the
        paths that replace the transcript outside the popover (send, import,
        restore, clear) so the button never shows a stale label. */
    _refreshChatPopBtn() {
      this._disarmConfirm(); // a state change invalidates any armed confirm
      const chatBtn = this._app().elements.aiDocPopClearChat;
      if (!chatBtn) return;
      const chatPending = this._pendingChatRestore && this._pendingChatRestore.length ? this._pendingChatRestore.length : 0;
      chatBtn.hidden = !this.messages.length && !chatPending;
      chatBtn.textContent = chatPending ? (chatPending > 1 ? "Undo clear chat (" + chatPending + ")" : "Undo clear chat") : "Clear chat";
      chatBtn.classList.toggle("danger", !chatPending);
    },
    /** Push a pre-reset snapshot onto the undo stack (each reset — whole or
        per-field — can be undone in order; a fresh save/clear still wipes it). */
    _pushUndo(d) {
      if (!Array.isArray(this._pendingRestore)) this._pendingRestore = [];
      this._pendingRestore.push(d); // freshly parsed object — no aliasing
      if (this._pendingRestore.length > 10) this._pendingRestore.shift();
    },
    /** Per-field reset: clear just one override (model / maxContextChars /
        systemPrompt), keeping the others, undoable like the all-reset. */
    _resetField(field) {
      const d = this._docSettings();
      if (!d || !d[field]) return;
      this._pushUndo(d);
      const next = { ...d, [field]: null };
      if (field === "model") { next.provider = null; next.endpoint = null; }
      if (next.model || next.maxContextChars || next.systemPrompt) this._saveDocSettings(next);
      else this._clearDocSettings(true); // last override gone — remove the entry, keep the undo
      this._renderModelLine();
      this._renderDocPopover();
      this._app().toast("Cleared this document's " + ({ model: "model", maxContextChars: "context", systemPrompt: "system prompt" }[field] || field) + " override", "ok");
    },
    /** Clear this document's overrides, pushing a snapshot so the popover can undo it. */
    _resetDocOverrides() {
      const d = this._docSettings();
      if (!d || (!d.model && !d.maxContextChars && !d.systemPrompt)) return;
      this._pushUndo(d);
      this._clearDocSettings(true); // remove the entry but keep the undo stack
      this._renderModelLine();
      this._renderDocPopover();
      this._app().toast("This document's AI overrides cleared", "ok");
    },
    _restoreDocOverrides() {
      const stack = Array.isArray(this._pendingRestore) ? this._pendingRestore : null;
      if (!stack || !stack.length) return;
      const snap = stack.pop();
      // a null snapshot means the previous state was 'no overrides' — remove
      // the entry (keepUndo so the rest of a multi-step stack survives)
      if (snap) this._saveDocSettings(snap);
      else this._clearDocSettings(true);
      this._renderModelLine();
      this._renderDocPopover();
      this._app().toast("Overrides restored", "ok");
    },
    /** Save-or-clear a doc override from sanitized values (m: model, c: maxContextChars,
        s: systemPrompt). provider/endpoint pin the provenance: passed from a backup
        restore they win verbatim; otherwise they are stamped (or preserved) by
        _docProvenance only when the model actually changes. */
    _applyDocOverride(m, c, s, provider, endpoint) {
      this._pendingRestore = []; // a fresh save supersedes any pending undo
      const d = this._docSettings() || {};
      const prov = this._docProvenance(d, m, provider, endpoint);
      if (m || c > 0 || s) {
        this._saveDocSettings({
          model: m || null,
          maxContextChars: c > 0 ? c : null,
          systemPrompt: s || null,
          provider: prov.provider,
          endpoint: prov.endpoint,
        });
      } else {
        this._clearDocSettings();
      }
    },

    /** Global settings merged with this document's overrides (model, maxContextChars, systemPrompt). */
    _effective(d) {
      d = d || this._docSettings();
      if (!d || (!d.model && !d.maxContextChars && !d.systemPrompt)) return this.settings;
      return {
        ...this.settings,
        model: d.model || this.settings.model,
        maxContextChars: d.maxContextChars || this.settings.maxContextChars,
        systemPrompt: d.systemPrompt || this.settings.systemPrompt,
      };
    },

    /* ── status ─────────────────────────────────────────────── */
    configured() {
      const e = this._effective();
      return Boolean(this.settings.baseUrl && e.model);
    },

    _renderModelLine() {
      const el = this._app().elements.aiModelLine;
      const foot = this._app().elements.aiFootRight;
      const d = this._docSettings();
      const eff = this._effective(d);
      const docOverride = this._docHasOverrides();
      // the "· this doc" marker is its own clickable control: a solid pill when
      // this doc has overrides (click → summary popover), a dashed ghost pill
      // when it has none (click → jump to the ⚙ setup section, so per-doc
      // settings are discoverable without hunting for the gear). It shows for
      // every open document, like the gear button. Hover shows the effective
      // prompt / context.
      const marker = this._app().elements.aiDocMarker;
      marker.hidden = !this._app().currentDocInfo;
      marker.classList.toggle("ghost", !docOverride);
      marker.title = docOverride
        ? "This document's AI overrides — click to view or edit"
        : "No per-document AI overrides yet — click to set one up";
      marker.setAttribute("aria-label", docOverride
        ? "This document's AI overrides — click to view or edit"
        : "Set up this document's AI settings");
      // keep a visible tooltip truthful: refresh it while hovered (its override
      // content may have changed), otherwise dismiss it
      if (this._markerHover) this._showMarkerTip();
      else this._hideMarkerTip();
      this._fillModelPicker(d, eff);
      this._fillGlobalPicker();
      this._fillPromptPreset();
      this._renderTemp();
      if (!this.configured()) {
        el.textContent = "not configured";
        foot.textContent = "no model — click ⚙ to connect";
        this._app().elements.sbAi.textContent = "AI off";
      } else {
        const who = this.settings.provider === "ollama" ? "Ollama" :
          this.settings.provider === "lmstudio" ? "LM Studio" :
          this.settings.provider === "openai" ? "OpenAI" :
          this.settings.provider === "groq" ? "Groq" :
          this.settings.provider === "openrouter" ? "OpenRouter" : this.settings.baseUrl.replace(/^https?:\/\//, "").split("/")[0];
        // with the header picker visible the line must stay short (the picker
        // already shows the model) — drop the provider suffix so "· this doc"
        // never gets ellipsized away in the narrow panel
      // the picker already shows the model — drop the provider suffix only when
      // the *per-doc* picker is visible, so the marker never gets ellipsized
      // away. The global picker keeps the provider on the line: the endpoint
      // identity matters most when no document is pinning a model.
      const pickerShown = !this._app().elements.aiModelPicker.hidden;
      el.textContent = `${eff.model}${pickerShown ? "" : " · " + who}`;
        foot.textContent = eff.model;
        this._app().elements.sbAi.textContent = `AI: ${eff.model}${docOverride ? " (doc)" : ""}`;
      }
      this._refreshBootstrap(); // no-model → offer the one-click local setup
      // Ollama CORS drive-by guard: probe once per session when the panel is
      // open with the Ollama provider, so a wildcard OLLAMA_ORIGINS surfaces
      // (the probe is cheap — one loopback GET, 2s cap — and _checkCors
      // guards re-entry)
      if (this.settings.provider === "ollama" && !document.body.classList.contains("ai-hidden") && !this._corsProbed) {
        this._checkCors();
      }
    },

    /* ── first-run local-LLM bootstrap ────────────────────────
       Shown in the AI panel while no model is configured: detect Ollama on
       this machine (localhost:11434), then offer one click to install it
       (Electron bridge) and pull qwen3:4b with a live progress bar — or a
       jump to ⚙ settings for any other provider. Everything runs locally
       and offline; nothing leaves the computer. */
    _refreshBootstrap() {
      const el = this._app().elements.aiBootstrap;
      if (!el) return;
      const panelHidden = document.body.classList.contains("ai-hidden");
      const dismissed = localStorage.getItem(BOOTSTRAP_SKIP_KEY) === "1";
      this._bootstrapDismissed = dismissed;
      if (this.configured() || panelHidden || dismissed) { el.hidden = true; return; }
      el.hidden = false;
      if (this._bootstrapBusy || this._bootstrap) { this._bootstrapRender(); return; }
      this._bootstrapDetect();
    },
    /** The active Ollama port: the private instance's own loopback port when
        private mode is on, else the default 11434. */
    _ollamaPort() {
      return this.settings.privateOllama && this.settings.privatePort ? this.settings.privatePort : 11434;
    },
    /** Loopback base for the raw /api/* endpoints (tags, pull) of whichever
        Ollama is active. */
    _ollamaBase() {
      return "http://127.0.0.1:" + this._ollamaPort();
    },
    /** The /v1 OpenAI-compatible base for chat — the private instance's URL
        when private mode is on, else the default localhost:11434. */
    _ollamaV1Base() {
      return this.settings.privateOllama && this.settings.privatePort
        ? "http://127.0.0.1:" + this.settings.privatePort + "/v1"
        : PRESETS.ollama.baseUrl;
    },
    /** Poll the active Ollama tags endpoint — null when unreachable. The
        CORS posture is probed separately via _probeCors (the browser CORS
        model hides Access-Control-Allow-Origin from page JS, so the header
        can't be read here — the desktop app probes from the main process). */
    async _probeOllama() {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 2000);
        const res = await fetch(this._ollamaBase() + "/api/tags", { signal: ctrl.signal });
        clearTimeout(t);
        if (!res.ok) return null;
        const data = await res.json();
        return { models: (data.models || []).map((m) => m.name) };
      } catch (e) {
        return null;
      }
    },
    /** The Ollama CORS posture — { wildcard, acao } or null when unreachable.
        The PRIVATE instance needs no probe: Volt spawned it with OLLAMA_ORIGINS
        pinned to its own origins, so it can never answer * — short-circuit to
        safe without touching the wire (and without the bridge, keeping the
        smoke hermetic). The shared-instance desktop app probes from the MAIN
        process (volt:check-ollama-cors):
        the browser CORS model hides Access-Control-Allow-Origin from page JS
        (res.headers.get() reads null even when the header is on the wire), so
        only the main process can read the raw header — and it sends the
        request with a spoofed evil Origin, making Ollama's own rejection
        (403 = safe, it actively blocks) or wildcard (ACAO:* = warn) directly
        observable. The PWA/browser can't see either signal (a filtered header
        reads as null, and a rejected origin is indistinguishable from a down
        server), so it stays silent there rather than false-alarm. */
    async _probeCors() {
      if (this.settings.privateOllama && this.settings.privatePort && global.voltDesktop) {
        return { wildcard: false, acao: null }; // pinned at spawn — by construction safe
      }
      if (global.voltDesktop && global.voltDesktop.checkOllamaCors) {
        try {
          const r = await global.voltDesktop.checkOllamaCors();
          if (!r || r.ok !== true) return null;
          return { wildcard: r.acao === "*", acao: r.acao };
        } catch (e) { return null; }
      }
      try {
        const state = await this._probeOllama();
        return state ? { wildcard: false, acao: null } : null;
      } catch (e) { return null; }
    },
    /* ── first-run model detection ──────────────────────────
       Default to something that WORKS: probe /api/tags for what's actually
       installed, rank it by MODEL_PREFERENCE, verify the top candidate
       responds to a tiny chat ping, and adopt it as the default model.
       Runs once, at first run (no saved settings); the result is persisted
       so later sessions load it from volt:ai:settings like any choice. */
    _rankModel(name) {
      const i = MODEL_PREFERENCE.indexOf(name);
      if (i >= 0) return MODEL_PREFERENCE.length - i;
      return 0; // any installed model beats an empty default
    },
    _pickBestModel(models) {
      let best = null, bestRank = -1;
      for (const m of models) {
        const r = this._rankModel(m);
        if (r > bestRank) { bestRank = r; best = m; }
      }
      return best;
    },
    /** Tiny chat ping against the raw /api/chat endpoint: does the model
        actually answer? Non-streaming, max 1 token, capped so a hung model
        can't block startup. True = usable; false = missing/broken/down. */
    async _verifyModelResponds(model) {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 8000);
        const res = await fetch(this._ollamaBase() + "/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            messages: [{ role: "user", content: "Reply with the single word: ok" }],
            stream: false,
            options: { num_predict: 1 },
          }),
          signal: ctrl.signal,
        });
        clearTimeout(t);
        if (!res.ok) return false;
        const j = await res.json();
        return !!(j && j.message && typeof j.message.content === "string" && j.message.content.trim().length > 0);
      } catch (e) {
        return false;
      }
    },
    /** Adopt a detected model as the global default (Ollama provider) and
        persist it — the same shape _bootstrapApplyModel uses, minus the
        qwen3:4b-specific copy. */
    _adoptModel(model) {
      this.settings = {
        ...this.settings,
        provider: "ollama",
        baseUrl: this._ollamaV1Base(),
        model,
        apiKey: "",
      };
      try { localStorage.setItem("volt:ai:settings", JSON.stringify(this.settings)); } catch (e) { /* ignore */ }
      this._bootstrap = null;
      this._bootstrapDismissed = false;
      try { localStorage.removeItem(BOOTSTRAP_SKIP_KEY); } catch (e) { /* ignore */ }
      this._renderModelLine();
      this._app().toast("Local AI ready — " + model + " (Ctrl+J to chat)", "ok");
    },
    /** First-run detection pass: probe tags, rank, verify, adopt. Only the
        best candidate needs to respond — a machine with a broken model falls
        back to the next-best that works. If nothing is installed or Ollama
        is down, stays silent: the bootstrap card handles those when the
        panel opens. */
    async _autoDetectDefault() {
      if (this._autoDetected) return;
      this._autoDetected = true;
      try {
        const state = await this._probeOllama();
        if (!state || !Array.isArray(state.models) || !state.models.length) return;
        const ranked = state.models.slice().sort((a, b) => this._rankModel(b) - this._rankModel(a));
        for (const m of ranked) {
          if (await this._verifyModelResponds(m)) { this._adoptModel(m); return; }
        }
      } catch (e) { /* stay unconfigured — the bootstrap card guides setup */ }
    },

    async _bootstrapDetect() {
      this._bootstrapBusy = true;
      this._bootstrap = { phase: "detecting" };
      this._bootstrapRender();
      const state = await this._probeOllama();
      this._bootstrap = state ? { phase: "ready", models: state.models } : { phase: "missing" };
      this._cors = await this._probeCors();
      this._renderCorsWarning();
      this._bootstrapBusy = false;
      this._bootstrapRender();
    },
    _bootstrapRender() {
      const els = this._app().elements;
      const b = this._bootstrap || { phase: "detecting" };
      const title = els.aiBootstrapTitle, body = els.aiBootstrapBody,
        primary = els.aiBootstrapPrimary, bar = els.aiBootstrapProgressBar,
        label = els.aiBootstrapProgressLabel, prog = els.aiBootstrapProgress;
      const desktop = !!global.voltDesktop;
      if (b.phase === "missing") {
        title.textContent = "One click to local AI";
        body.innerHTML = "Volt can install <b>Ollama</b> (free, private) and download <b>qwen3:4b</b> — a small model that handles document summaries and tool use on most machines. Everything runs locally and offline; nothing leaves your computer.";
        primary.textContent = desktop ? "Install Ollama + qwen3:4b" : "Install Ollama (opens download)";
        primary.disabled = false;
        primary.title = desktop ? "" : "The browser version can't install apps — open the Ollama download page, then come back to this panel";
        prog.hidden = true;
      } else if (b.phase === "ready") {
        // offer the BEST installed model (ranked) rather than always nagging
        // for qwen3:4b — a machine that already has llama3.2:3b is one click
        // from working instead of one download
        const best = this._pickBestModel(b.models || []);
        const has = !!best;
        title.textContent = has ? "Local AI ready to use" : "Local AI — one download away";
        body.innerHTML = has
          ? "<b>Ollama</b> is running and <b>" + (best === BOOTSTRAP_MODEL ? "qwen3:4b" : best) + "</b> is already installed. Make it the default model with one click."
          : "<b>Ollama</b> is running on this machine. Download <b>qwen3:4b</b> (~2.5 GB, once) and set it as the default model — it then works offline forever.";
        primary.textContent = has ? "Use " + (best === BOOTSTRAP_MODEL ? "qwen3:4b" : best) : "Download qwen3:4b";
        primary.disabled = false;
        primary.title = "";
        prog.hidden = true;
      } else if (b.phase === "installing" || b.phase === "pulling") {
        const installing = b.phase === "installing";
        title.textContent = installing ? "Installing Ollama…" : "Setting up your local model…";
        body.innerHTML = installing
          ? "Downloading and installing <b>Ollama</b> — one time only, per user, no admin rights. Then Volt pulls <b>qwen3:4b</b> automatically."
          : "Downloading <b>qwen3:4b</b> — one time, then it works offline forever. You can keep reading while this runs.";
        primary.textContent = installing ? "Installing…" : "Downloading qwen3:4b…";
        primary.disabled = true;
        prog.hidden = false;
        bar.style.width = (b.pct != null ? b.pct : 0) + "%";
        label.textContent = b.label || (installing ? "Downloading installer…" : "Downloading model…");
      } else {
        title.textContent = "Checking for a local model…";
        body.innerHTML = "Volt looks for <b>Ollama</b> on this machine — a free, private way to run AI locally.";
        primary.textContent = "Checking…";
        primary.disabled = true;
        prog.hidden = true;
      }
    },
    async _bootstrapPrimary() {
      const b = this._bootstrap;
      if (!b) return;
      if (b.phase === "missing") {
        if (global.voltDesktop && global.voltDesktop.installOllama) {
          await this._bootstrapInstall();
        } else {
          // browser/PWA: can't install apps — open the official download page
          // and re-detect when the user comes back
          window.open("https://ollama.com/download/windows", "_blank");
          this._app().toast("Install Ollama, then reopen this panel — Volt will detect it", "ok");
          this._bootstrap = null;
          setTimeout(() => this._refreshBootstrap(), 8000);
        }
        return;
      }
      if (b.phase === "ready") {
        const best = this._pickBestModel(b.models || []);
        if (best) { this._bootstrapApplyModel(best); return; }
        await this._bootstrapPull();
      }
    },
    /** Desktop: download + silently install the official per-user Ollama
        installer via the preload bridge (progress events stream back), wait
        for the server, then pull the model. */
    async _bootstrapInstall() {
      this._bootstrap = { phase: "installing", pct: 0, label: "Downloading installer…" };
      this._bootstrapRender();
      try {
        const result = await new Promise((resolve) => {
          let settled = false;
          global.voltDesktop.onOllamaInstall((d) => {
            if (!d) return;
            if (d.phase === "download" && d.pct != null) {
              this._bootstrap = { phase: "installing", pct: Math.round(d.pct), label: "Downloading installer… " + Math.round(d.pct) + "%" };
              this._bootstrapRender();
            } else if (d.phase === "install") {
              this._bootstrap = { phase: "installing", pct: 100, label: "Installing…" };
              this._bootstrapRender();
            } else if (d.phase === "done" && !settled) { settled = true; resolve({ ok: true }); }
            else if (d.phase === "error" && !settled) { settled = true; resolve({ ok: false, error: d.error }); }
          });
          global.voltDesktop.installOllama(this._corsOrigins().join(",")).then(
            (r) => { if (!settled) { settled = true; resolve({ ok: !!(r && r.ok !== false), error: r && r.error }); } },
            (e) => { if (!settled) { settled = true; resolve({ ok: false, error: String((e && e.message) || e) }); } }
          );
        });
        if (!result.ok) throw new Error(result.error || "install failed");
        this._bootstrap = { phase: "installing", pct: 100, label: "Starting Ollama…" };
        this._bootstrapRender();
        // wait for the server to answer (installer exits before the service
        // is up), then pull the model in the same one-click flow
        const t0 = Date.now();
        for (;;) {
          const state = await this._probeOllama();
          if (state) break;
          if (Date.now() - t0 > 45000) throw new Error("Ollama did not start");
          await new Promise((r) => setTimeout(r, 1000));
        }
        await this._bootstrapPull();
      } catch (e) {
        this._bootstrap = { phase: "missing" };
        this._bootstrapRender();
        this._app().toast("Ollama install failed: " + ((e && e.message) || e), "error");
      }
    },
    /** Stream the /api/pull NDJSON progress for qwen3:4b into the card, then
        apply it as the default model. */
    /** Shared Ollama pull core: stream /api/pull's NDJSON and report progress
        (pct 0-100, label) until the download completes. Used by both the
        first-run bootstrap card and the ⚙ model-quality tier picker. */
    async _pullOllamaModel(model, onProgress) {
      const res = await fetch(this._ollamaBase() + "/api/pull", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, stream: true }),
      });
      if (!res.ok || !res.body) throw new Error("HTTP " + res.status);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop();
        for (const line of lines) {
          const t = line.trim();
          if (!t) continue;
          let j;
          try { j = JSON.parse(t); } catch (e) { continue; }
          if (j.completed != null && j.total) {
            const pct = Math.min(99, Math.round((j.completed / j.total) * 100));
            if (onProgress) onProgress(pct, "Downloading " + model + "… " + pct + "%");
          } else if (j.status === "success") {
            if (onProgress) onProgress(100, "Done");
          }
        }
      }
    },
    async _bootstrapPull() {
      this._bootstrap = { phase: "pulling", pct: 0, label: "Downloading qwen3:4b…" };
      this._bootstrapRender();
      try {
        await this._pullOllamaModel(BOOTSTRAP_MODEL, (pct, label) => {
          this._bootstrap = { phase: "pulling", pct, label };
          this._bootstrapRender();
        });
        this._bootstrapApplyModel();
      } catch (e) {
        this._bootstrap = { phase: "ready", models: (this._bootstrap && this._bootstrap.models) || [] };
        this._bootstrapRender();
        this._app().toast("Model download failed: " + ((e && e.message) || e), "error");
      }
    },
    /** A model is local — set it as the default model (Ollama provider),
        clear the skip flag, and let _renderModelLine hide the card. */
    _bootstrapApplyModel(model) {
      this._adoptModel(model || BOOTSTRAP_MODEL);
    },
    /** "Not now" — persisted so the card never nags again (settings still
        offer every other provider; the card reappears only if the model is
        cleared AND the skip flag is removed). */
    _bootstrapDismiss() {
      this._bootstrapDismissed = true;
      try { localStorage.setItem(BOOTSTRAP_SKIP_KEY, "1"); } catch (e) { /* ignore */ }
      const el = this._app().elements.aiBootstrap;
      if (el) el.hidden = true;
    },

    /* ── model-quality tiers (⚙ settings, Ollama only) ──────
       qwen3 1.7b / 4b / 8b with RAM/quality guidance. The row shows only
       for the Ollama provider, probes /api/tags to mark which tiers are
       already installed, and the action button installs the chosen tier
       (one click, shared _pullOllamaModel progress) or just applies it
       when present — either way it becomes the default model. */
    _tierFor(model) {
      for (const t of MODEL_TIERS) if (t.model === model) return t;
      return null;
    },
    /** Show/hide the tier row by provider and (re)probe installed tiers.
        Called from openSettings, the provider preset change, and the tier
        actions — keeps the installed badges and the action label truthful. */
    async _refreshQualityBlock() {
      const el = this._app().elements;
      const block = el.modelQualityBlock;
      if (!block) return;
      const show = this.settings.provider === "ollama";
      block.hidden = !show;
      this._renderPrivateBlock(); // the private-instance row is Ollama-only too
      if (!show) return;
      const state = await this._probeOllama();
      this._cors = await this._probeCors();
      this._renderCorsWarning();
      this._tier = {
        model: this._tierFor(this.settings.model) ? this.settings.model : "",
        installed: new Set(state ? state.models : []),
        ollamaUp: !!state,
      };
      // installed badges + which chip the current model maps to
      for (const chip of el.tierPresets.querySelectorAll(".tier-preset")) {
        const t = this._tierFor(chip.dataset.tier);
        const st = chip.querySelector(".tier-state");
        st.textContent = this._tier.installed.has(t.model) ? "✓ installed" : "—";
        st.classList.toggle("offline", !this._tier.ollamaUp);
        const active = this._tier.model === t.model;
        chip.classList.toggle("active", active);
        chip.setAttribute("aria-pressed", active ? "true" : "false");
      }
      this._renderTierAction();
    },
    _renderTierAction() {
      const el = this._app().elements;
      const t = this._tier && this._tierFor(this._tier.model);
      const btn = el.tierInstall, hint = el.tierHint;
      if (!t) {
        btn.disabled = true;
        btn.textContent = "Pick a tier";
        hint.textContent = this._tier && !this._tier.ollamaUp ? "Ollama isn't running — start it (or use the AI panel's one-click setup)." : "";
        el.tierDesc.textContent = "Choose a size above — smaller runs on weaker machines, bigger writes better summaries.";
        return;
      }
      const installed = this._tier.installed.has(t.model);
      btn.disabled = !this._tier.ollamaUp;
      btn.textContent = installed ? "Use " + t.model : "Install " + t.model;
      hint.textContent = installed
        ? "Already on this machine — one click makes it the default."
        : (this._tier.ollamaUp ? t.size + " download · runs offline after" : "Ollama isn't running — start it first.");
      el.tierDesc.textContent = t.desc;
    },
    _selectTier(model) {
      if (!this._tier || !this._tierFor(model)) return;
      this._tier.model = model;
      const el = this._app().elements;
      for (const chip of el.tierPresets.querySelectorAll(".tier-preset")) {
        const active = chip.dataset.tier === model;
        chip.classList.toggle("active", active);
        chip.setAttribute("aria-pressed", active ? "true" : "false");
      }
      this._renderTierAction();
    },
    /* ── private Ollama instance (settings, desktop only) ─────
       Volt spawns its OWN `ollama serve` on a non-default loopback port with
       OLLAMA_ORIGINS pinned to Volt and a dedicated model store, so nothing
       else on the machine — other apps, websites — can reach the model at
       all. The main process picks the port, spawns the process, and waits
       for it to answer; this renderer just flips the setting, adopts the
       port into baseUrl, and points every probe/pull at it via _ollamaBase. */
    /** The two bridge calls are methods (not inline bridge calls) so the
        smoke can stub them — the contextBridge object is frozen. */
    _spawnPrivate(origins) {
      return global.voltDesktop.spawnPrivateOllama(origins, this.settings.privatePort || null);
    },
    _stopPrivate() {
      return global.voltDesktop.stopPrivateOllama();
    },
    _renderPrivateBlock() {
      const el = this._app().elements;
      const block = el.privateOllamaBlock;
      if (!block) return;
      const show = this.settings.provider === "ollama";
      block.hidden = !show;
      if (!show) return;
      const btn = el.privateOllamaToggle, status = el.privateOllamaStatus, hint = el.privateOllamaHint;
      if (this._privateBusy) {
        btn.disabled = true;
        btn.textContent = this.settings.privateOllama ? "Stopping…" : "Starting…";
        status.textContent = "";
        hint.textContent = "";
        return;
      }
      btn.disabled = false;
      const on = this.settings.privateOllama === true;
      btn.textContent = on ? "Disable private instance" : "Enable private instance";
      btn.setAttribute("aria-pressed", on ? "true" : "false");
      if (on && this.settings.privatePort) {
        status.textContent = "Running on 127.0.0.1:" + this.settings.privatePort + " — locked to Volt (origins pinned, own model store)";
        hint.textContent = "This instance is used only by Volt: no other app or website can reach it, and its models live in Volt's own folder.";
      } else if (!global.voltDesktop) {
        status.textContent = "Desktop app only — the browser version can't run a private instance";
        hint.textContent = "In the desktop app this spawns Volt's own Ollama on a private port — no other app or website can reach the model.";
      } else {
        status.textContent = "Uses the shared Ollama on 127.0.0.1:11434";
        hint.textContent = "A private instance isolates your model from every other app and website on this machine. First use pulls the chosen tier into Volt's own store.";
      }
    },
    async _enablePrivate() {
      if (this._privateBusy) return;
      if (!global.voltDesktop || !global.voltDesktop.spawnPrivateOllama) {
        this._app().toast("A private Ollama instance needs the desktop app — the browser version can't run one", "error");
        return;
      }
      this._privateBusy = true;
      this._renderPrivateBlock();
      try {
        const r = await this._spawnPrivate(this._corsOrigins().join(","));
        if (!r || r.ok !== true) throw new Error((r && r.error) || "failed to start");
        this.settings = {
          ...this.settings,
          privateOllama: true,
          privatePort: r.port,
          baseUrl: "http://127.0.0.1:" + r.port + "/v1",
        };
        try { localStorage.setItem("volt:ai:settings", JSON.stringify(this.settings)); } catch (e) { /* ignore */ }
        this._corsProbed = false;
        this._cors = await this._probeCors(); // private → safe, no wire probe
        this._renderCorsWarning();
        this._fillFields();
        this._renderModelLine();
        await this._refreshQualityBlock(); // re-probe the private instance
        this._app().toast("Private Ollama running on 127.0.0.1:" + r.port + " — locked to Volt", "ok");
      } catch (e) {
        this._app().toast("Could not start private Ollama: " + ((e && e.message) || e), "error");
      } finally {
        this._privateBusy = false;
        this._renderPrivateBlock();
      }
    },
    async _disablePrivate() {
      if (this._privateBusy) return;
      this._privateBusy = true;
      this._renderPrivateBlock();
      try {
        try { await this._stopPrivate(); } catch (e) { /* best-effort */ }
        this.settings = {
          ...this.settings,
          privateOllama: false,
          privatePort: null,
          baseUrl: PRESETS.ollama.baseUrl,
        };
        try { localStorage.setItem("volt:ai:settings", JSON.stringify(this.settings)); } catch (e) { /* ignore */ }
        this._corsProbed = false;
        this._cors = await this._probeCors();
        this._renderCorsWarning();
        this._fillFields();
        this._renderModelLine();
        await this._refreshQualityBlock();
        this._app().toast("Private Ollama stopped — back on the shared instance", "ok");
      } catch (e) {
        this._app().toast("Could not stop private Ollama: " + ((e && e.message) || e), "error");
      } finally {
        this._privateBusy = false;
        this._renderPrivateBlock();
      }
    },
    _togglePrivate() {
      if (this.settings.privateOllama) this._disablePrivate();
      else this._enablePrivate();
    },
    /** Boot: a saved private instance must be running for the saved baseUrl
        to work. The spawn IPC is idempotent (main returns the live one); if
        the old port got taken, adopt the new port so the baseUrl stays live. */
    async _ensurePrivateOllama() {
      if (!global.voltDesktop || !global.voltDesktop.spawnPrivateOllama || !this.settings.privateOllama) return;
      try {
        const r = await this._spawnPrivate(this._corsOrigins().join(","));
        if (r && r.ok && r.port && r.port !== this.settings.privatePort) {
          this.settings = {
            ...this.settings,
            privatePort: r.port,
            baseUrl: "http://127.0.0.1:" + r.port + "/v1",
          };
          try { localStorage.setItem("volt:ai:settings", JSON.stringify(this.settings)); } catch (e) { /* ignore */ }
        }
      } catch (e) { /* boot-time best-effort — the settings block shows the failure state */ }
    },
    /** One click: install the chosen tier (shared pull with live progress) —
        or, when it's already local, just apply it as the default model. */
    async _installTier() {
      const t = this._tier && this._tierFor(this._tier.model);
      if (!t || !this._tier.ollamaUp) return;
      if (this._tier.installed.has(t.model)) { this._applyTierModel(); return; }
      const el = this._app().elements;
      const prog = el.tierProgress, bar = el.tierProgressBar, label = el.tierProgressLabel;
      const btn = el.tierInstall;
      prog.hidden = false;
      btn.disabled = true;
      btn.textContent = "Installing…";
      try {
        await this._pullOllamaModel(t.model, (pct, l) => {
          bar.style.width = pct + "%";
          label.textContent = l;
        });
        this._tier.installed.add(t.model);
        prog.hidden = true;
        this._applyTierModel();
      } catch (e) {
        prog.hidden = true;
        btn.disabled = false;
        btn.textContent = "Install " + t.model;
        this._app().toast("Model download failed: " + ((e && e.message) || e), "error");
      }
    },
    /** Set the chosen tier as the default model (Ollama provider) — the same
        settings write the header pickers and the ⚙ model field read. */
    _applyTierModel() {
      const t = this._tier && this._tierFor(this._tier.model);
      if (!t) return;
      this.settings = {
        ...this.settings,
        provider: "ollama",
        baseUrl: this._ollamaV1Base(), // the private instance's URL when private mode is on
        model: t.model,
        apiKey: "",
      };
      try { localStorage.setItem("volt:ai:settings", JSON.stringify(this.settings)); } catch (e) { /* ignore */ }
      this._fillFields();
      this._renderModelLine();
      this._renderTierAction(); // the button now reads "Use qwen3:4b"
      this._app().toast("Model set to " + t.model + " — you're all set", "ok");
    },

    /* ── Ollama CORS drive-by guard ────────────────────────
       OLLAMA_ORIGINS=* lets ANY website open in a browser send prompts to
       the local Ollama (response reading is blocked, but the drive-by send
       isn't). Volt pins the per-user env to its own origins —       the app's real origin (127.0.0.1:<port> in the desktop app, localhost:8421 in
       the PWA) plus file:// — and warns when the main-process probe sees the
       running install answer with Access-Control-Allow-Origin: * instead of
       rejecting foreign origins or echoing a specific one. */
    _corsOrigins() {
      // The PWA dev origin — the one origin the app must be allowed from.
      // `file://` is deliberately NOT listed: Ollama's OLLAMA_ORIGINS parser
      // only accepts http(s)/extension schemes and PANICS on `file://` (a
      // pin like `…,file://` crashes the server at startup — verified live),
      // and the loopback/file defaults Ollama always appends
      // (http://localhost:*, http://127.0.0.1:*, file://* …) already cover
      // the desktop app's dynamic http://127.0.0.1:<port> origin and any
      // file-origin requests. So this single value is both sufficient and
      // safe — a future re-add of `file://` here is a smoke-failing bug.
      return ["http://localhost:8421"];
    },
    /** Probe once per session (or on demand) and surface the posture. */
    async _checkCors(force) {
      if (this._corsProbed && !force) return;
      this._corsProbed = true;
      this._cors = await this._probeCors();
      this._renderCorsWarning();
    },
    /** Drive both warning surfaces (AI panel bar + ⚙ settings line) from the
        one _cors state. Cheap — called on every _renderModelLine, renders
        nothing when there's nothing to say. */
    _renderCorsWarning() {
      const el = this._app().elements;
      const bar = el.aiCorsWarn;
      if (!bar) return;
      const show = this.settings.provider === "ollama" && !!this._cors && this._cors.wildcard === true && !this._corsDismissed;
      const fixed = this._corsFixed === true;
      bar.hidden = !show;
      const sline = el.tierCorsWarn;
      if (sline) sline.hidden = !show;
      if (!show) return;
      const msg = fixed
        ? "OLLAMA_ORIGINS has been pinned to Volt only — restart Ollama for it to take effect."
        : "⚠ Your Ollama lets ANY website use it (OLLAMA_ORIGINS=*). Restrict it to Volt only.";
      el.aiCorsMsg.textContent = msg;
      el.aiCorsFix.hidden = fixed;
      if (sline) {
        el.tierCorsMsg.textContent = msg;
        el.tierCorsFix.hidden = fixed;
      }
    },
    /** Pin OLLAMA_ORIGINS to Volt's origins. Desktop: the bridge writes the
        per-user env (no admin); the running Ollama picks it up on restart,
        so the warning flips to 'restart to apply' and the next panel open
        re-probes. Browser/PWA can't write the OS env — show the command. */
    async _restrictOllamaOrigins() {
      const value = this._corsOrigins().join(",");
      try {
        if (global.voltDesktop && global.voltDesktop.setOllamaOrigins) {
          const r = await global.voltDesktop.setOllamaOrigins(value);
          if (!r || r.ok !== true) throw new Error((r && r.error) || "failed to set");
          this._corsFixed = true;
          this._corsProbed = false; // re-probe after the user restarts Ollama
          this._renderCorsWarning();
          this._app().toast("OLLAMA_ORIGINS pinned to Volt — restart Ollama for it to take effect", "ok");
        } else {
          this._app().toast('Set OLLAMA_ORIGINS="' + value + '" in your shell, then restart Ollama', "ok");
        }
      } catch (e) {
        this._app().toast("Could not restrict Ollama: " + ((e && e.message) || e), "error");
      }
    },

    /** Populate the header model picker (per-document model, no settings modal). */
    _fillModelPicker(d, eff) {
      const el = this._app().elements;
      const picker = el.aiModelPicker;
      if (!picker) return;
      const hasDoc = Boolean(this._app().currentDocInfo);
      el.aiDocSettings.hidden = !hasDoc; // gear is useful even before a model is configured
      if (!hasDoc || !this.configured()) { picker.hidden = true; return; }
      // exclude the "__global__" sentinel so a real model of that name can't
      // shadow the clear-override option
      const known = new Set([...(el.modelSuggestions?.options || [])]
        .map((o) => o.value).filter((v) => v && v !== "__global__" && v !== "__global_edit__"));
      if (eff.model) known.add(eff.model);
      if (this.settings.model) known.add(this.settings.model);
      let opts = `<option value="__global__">(global: ${this.settings.model || "default"})</option>`;
      for (const m of known) opts += `<option value="${Utils.esc(m)}">${Utils.esc(m)}</option>`;
      // sibling affordance inside the same list: changing the global default
      // (which this doc falls back to) needs no settings modal
      opts += '<option value="__global_edit__">✎ global default…</option>';
      picker.innerHTML = opts;
      picker.value = (d && d.model) || "__global__";
      picker.hidden = false;
      picker.title = (d && d.model)
        ? "Model for this document — pick another, use the global, or change the global default"
        : "Pick a model for this document (overrides the global) — or change the global default";
    },

    /** Change the global default model from the header picker (shown when no doc is open).
        Persists to the same volt:ai:settings key the ⚙ modal writes. */
    _applyGlobalModel(value) {
      this.settings.model = (value || "").trim();
      try { localStorage.setItem("volt:ai:settings", JSON.stringify(this.settings)); } catch (e) { /* ignore */ }
      this._renderModelLine();
      this._app().toast("Global model set to " + this.settings.model, "ok");
    },

    /** Global temperature from the header stepper — same 0–1.5 / step-0.1 range
        as the ⚙ slider, persisted to the same volt:ai:settings key. The value is
        rounded to one decimal so repeated clicks never accumulate float noise. */
    _applyGlobalTemperature(value) {
      const v = Math.min(1.5, Math.max(0, Math.round((Number(value) || 0) * 10) / 10));
      this.settings.temperature = v;
      try { localStorage.setItem("volt:ai:settings", JSON.stringify(this.settings)); } catch (e) { /* ignore */ }
      // only the stepper label depends on temperature — a full _renderModelLine
      // (both pickers, persona row, marker tip) would be wasted work per click
      this._renderTemp();
    },

    /** Sync the header temperature stepper: shown whenever a model is configured
        (like the pickers), label always mirrors the live global setting. */
    _renderTemp() {
      const el = this._app().elements;
      if (!el.aiTemp) return;
      el.aiTemp.hidden = !this.configured();
      el.aiTempVal.textContent = String(Math.min(1.5, Math.max(0, Number(this.settings.temperature) || 0)));
    },

    /** Populate the header global-model picker (sibling of the per-doc picker,
        shown only when no document is open — a doc always sees its own picker). */
    _fillGlobalPicker() {
      const el = this._app().elements;
      const picker = el.aiModelGlobal;
      if (!picker) return;
      const show = !Boolean(this._app().currentDocInfo) && this.configured();
      picker.hidden = !show;
      if (!show) return;
      const known = new Set([...(el.modelSuggestions?.options || [])]
        .map((o) => o.value).filter((v) => v && v !== "__global__"));
      if (this.settings.model && this.settings.model !== "__global__") known.add(this.settings.model);
      let opts = "";
      for (const m of known) opts += `<option value="${Utils.esc(m)}">${Utils.esc(m)}</option>`;
      picker.innerHTML = opts;
      picker.value = this.settings.model || "";
    },

    /** Apply a persona to ALL documents: set the GLOBAL system prompt — the
        one every document without its own override uses. "(none)" restores the
        built-in default prompt; "Custom…" jumps to ⚙ to hand-tune it. */
    _applyGlobalPromptPreset(value) {
      const presets = this._personas();
      if (value === "__custom__") {
        this.openSettings(); // fine-tune the global prompt in ⚙
        this._renderModelLine();
        return;
      }
      if (value === "__none__") {
        this.settings.systemPrompt = DEFAULT_SETTINGS.systemPrompt;
        this._app().toast("Global persona cleared — back to the default system prompt", "ok");
      } else {
        const preset = presets[value];
        if (!preset) return;
        this.settings.systemPrompt = preset.prompt;
        this._app().toast("Global persona “" + preset.label + "” set — every document without its own override uses it", "ok");
      }
      try { localStorage.setItem("volt:ai:settings", JSON.stringify(this.settings)); } catch (e) { /* ignore */ }
      this._renderModelLine();
    },

    /** Apply a persona preset to THIS document's system prompt. The preset only
        touches the systemPrompt field — any per-doc model / maxContext are kept
        (mirroring how the header model picker only touches the model). */
    _applyPromptPreset(value) {
      if (!this._docSettingsKey()) return;
      const d = this._docSettings() || {};
      const m = d.model || null;
      const c = d.maxContextChars || 0;
      if (value === "__custom__") {
        this.openSettings(); // type your own in ⚙
        this._renderModelLine(); // snap the selection back until a custom prompt is actually saved
        return;
      }
      if (value === "__manage__") { // an action, not a persona — open the editor
        this.openPersonaManager();
        this._renderModelLine(); // snap the selection back
        return;
      }
      if (value === "__global__") {
        this._applyDocOverride(m, c, "");
        this._renderModelLine();
        if (!this._app().elements.aiDocPopover.hidden) this._renderDocPopover();
        this._app().toast("This document's system prompt cleared — using the global one", "ok");
        return;
      }
      const preset = this._personas()[value];
      if (!preset) return;
      this._applyDocOverride(m, c, preset.prompt);
      this._renderModelLine();
      if (!this._app().elements.aiDocPopover.hidden) this._renderDocPopover();
      this._app().toast("This document's persona set to " + preset.label, "ok");
    },

    /* ── persona commands in chat ────────────────────────────
       A persona line in the chat switches the active persona mid-conversation
       without touching the header — the same effect as the header pickers:
       with a document open it becomes that doc's persona; with none, it sets
       the GLOBAL persona. Deterministic form: /persona <name|none|list>. The
       natural form ('use the legal voice from now on') is recognized only
       when it is clearly a directive — a known persona label right before
       'voice'/'persona', no question mark, and nothing else substantive in
       the message — so a real question that mentions a voice is never
       hijacked (the slash form is always the reliable path). */
    _personaKeyByLabel(label) {
      const want = String(label || "").trim().toLowerCase();
      if (!want) return null;
      for (const [key, p] of Object.entries(this._personas())) {
        if (String(p.label || "").trim().toLowerCase() === want) return key;
      }
      return null;
    },
    /** Try to read a persona-switch directive out of a chat line. Returns null
        (a normal message) or {kind:'set',key} / {kind:'clear'} / {kind:'list'} /
        {kind:'unknown',arg}. */
    _personaCommand(text) {
      if (!text) return null;
      // deterministic slash form
      const slash = text.match(/^\/persona\b\s*(.*)$/i);
      if (slash) {
        const arg = slash[1].trim().toLowerCase();
        if (!arg || arg === "?" || arg === "help" || arg === "list") return { kind: "list" };
        if (arg === "none" || arg === "off" || arg === "default" || arg === "global") return { kind: "clear" };
        const key = this._personaKeyByLabel(arg);
        return key ? { kind: "set", key } : { kind: "unknown", arg };
      }
      // natural-language form — only when it clearly reads as a directive
      if (text.includes("?")) return null;
      const intent = /^(please|from now on|going forward|from here on(?: out)?|now|for the rest of this (?:chat|conversation|document)|thanks|thank you)$/i;
      // the clear check runs FIRST so 'the (default|global|normal|regular)
      // (voice|persona|prompt)' always clears — even if a persona happens to
      // be named 'Default'/'Global'/'None' (which the slash form also treats
      // as clear actions); a persona with such a name stays reachable via the
      // header picker, consistent with the reserved-key policy
      const clear = text.match(/\b(?:go|switch|change|set|use|back|return)(?:\s+back)?(?:\s+to)?\s+the\s+(?:default|global|normal|regular)\s+(?:voice|persona|prompt)\b/i);
      if (clear) {
        const rest = text.replace(clear[0], "").trim().replace(/[.,!;]+$/g, "").toLowerCase();
        if (!rest || intent.test(rest)) return { kind: "clear" };
      }
      const dir = text.match(/\b(?:please\s+)?(?:use|switch(?:\s+to)?|apply|set|change(?:\s+to)?)\s+(?:the\s+)?([a-z0-9][a-z0-9 \-'’]{0,38}?)\s*(?:voice|persona)\b/i);
      if (dir) {
        const key = this._personaKeyByLabel(dir[1]);
        if (key) {
          // the remainder after the directive must be empty or a trailing
          // intent phrase ('from now on'…) — anything else means it was a
          // real question about a voice, not a switch
          const rest = text.replace(dir[0], "").trim().replace(/[.,!;]+$/g, "").toLowerCase();
          if (!rest || intent.test(rest)) return { kind: "set", key };
        }
      }
      return null;
    },
    /** [key, persona] of the persona whose prompt is the global system prompt,
        or null. Single source for the picker value, the per-doc "(global: X)"
        fallback label, and the clear-ack's fallback mention. */
    _globalPersonaMatch() {
      const gsp = this.settings.systemPrompt || "";
      if (!gsp) return null;
      return Object.entries(this._personas()).find(([, p]) => p.prompt === gsp) || null;
    },
    _globalPersonaLabel() {
      const m = this._globalPersonaMatch();
      return m ? m[1].label : null;
    },
    /** A persona label as safe inline markdown — backticks stripped so a label
        containing one can't break out of the code span in a rendered ack. */
    _mdName(label) { return "`" + String(label || "").replace(/`/g, "") + "`"; },
    /** Execute a recognized persona command: apply the switch, land an
        acknowledgment in the transcript, sync the header. No API call. */
    _execPersonaCommand(cmd, rawText) {
      const presets = this._personas();
      const app = this._app();
      const hasDoc = Boolean(app.currentDocInfo);
      let ack = "";
      if (cmd.kind === "list") {
        const names = Object.values(presets).map((p) => this._mdName(p.label)).join(", ") || "(none yet)";
        ack = "Personas I know: " + names + ". Say `/persona <name>` (or *\"use the <name> voice\"*) to switch — `/persona none` clears it.";
      } else if (cmd.kind === "unknown") {
        const names = Object.values(presets).map((p) => this._mdName(p.label)).join(", ") || "(none yet)";
        ack = "I don't know a persona called `" + String(cmd.arg || "").replace(/`/g, "") + "`. Personas: " + names + ".";
      } else if (cmd.kind === "clear") {
        if (hasDoc) {
          const d = this._docSettings() || {};
          this._applyDocOverride(d.model || null, d.maxContextChars || 0, ""); // clears just the prompt
          const g = this._globalPersonaLabel();
          ack = "Cleared this document's persona — from now on I'll use the global prompt" + (g ? " (" + this._mdName(g) + ")" : "") + ".";
          if (!app.elements.aiDocPopover.hidden) this._renderDocPopover();
        } else {
          this.settings.systemPrompt = DEFAULT_SETTINGS.systemPrompt;
          try { localStorage.setItem("volt:ai:settings", JSON.stringify(this.settings)); } catch (e) { /* ignore */ }
          ack = "Cleared the global persona — back to the default system prompt.";
        }
      } else if (cmd.kind === "set") {
        const preset = presets[cmd.key];
        if (hasDoc) {
          const d = this._docSettings() || {};
          this._applyDocOverride(d.model || null, d.maxContextChars || 0, preset.prompt);
          ack = "Switched this document's persona to " + this._mdName(preset.label) + " — I'll answer in that voice from here on.";
          if (!app.elements.aiDocPopover.hidden) this._renderDocPopover();
        } else {
          this.settings.systemPrompt = preset.prompt;
          try { localStorage.setItem("volt:ai:settings", JSON.stringify(this.settings)); } catch (e) { /* ignore */ }
          ack = "Set " + this._mdName(preset.label) + " as the **global persona** — every document without its own override uses it from now on.";
        }
      }
      // the directive + acknowledgment become part of the transcript (saved,
      // backed up, and exported like any other exchange — no API round-trip)
      this.messages.push({ role: "user", content: rawText });
      this.messages.push({ role: "assistant", content: ack, sources: [], error: false });
      this._saveChat();
      this._renderMessages(true);
      this._renderModelLine(); // the header picker reflects the switch
      this._refreshChatPopBtn();
    },

    /** Fill the persona pickers: the per-document one (shown with a doc open)
        and the GLOBAL one (shown whenever a model is configured — with or
        without a document). The global picker sets the global system prompt,
        i.e. a persona applied to every document without its own override. */
    _fillPromptPreset() {
      const el = this._app().elements;
      const row = el.aiPersonaRow, sel = el.aiPromptPreset;
      const grow = el.aiPersonaGlobalRow, gsel = el.aiPromptGlobal;
      if (!sel || !gsel) return;
      const hasDoc = Boolean(this._app().currentDocInfo);
      const show = this.configured();
      row.hidden = !(show && hasDoc);
      grow.hidden = !show;
      if (!show) return;
      const presets = this._personas();

      // global persona picker — applies to ALL documents
      const gsp = this.settings.systemPrompt || "";
      const gmatch = this._globalPersonaMatch();
      const isDefault = !gsp || gsp === DEFAULT_SETTINGS.systemPrompt;
      let gopts = '<option value="__none__">(none — default prompt)</option>';
      for (const [key, p] of Object.entries(presets)) {
        gopts += `<option value="${key}">${Utils.esc(p.label)}</option>`;
      }
      if (!isDefault && !gmatch) gopts += '<option value="__custom__">Custom…</option>';
      gsel.innerHTML = gopts;
      gsel.value = isDefault ? "__none__" : (gmatch ? gmatch[0] : "__custom__");
      gsel.title = isDefault
        ? "Pick a global persona — every document without its own override uses it"
        : "Global system prompt — pick a persona for all documents, or (none) to use the default";

      if (!hasDoc) return;
      // per-document persona picker — a doc is open
      const d = this._docSettings() || {};
      const sp = d.systemPrompt || "";
      const match = sp ? Object.entries(presets).find(([, p]) => p.prompt === sp) : null;
      // the "(global)" option means "clear this doc's prompt, use the global"
      // — when a global persona is set, say which one it will fall back to
      const globalLabel = gmatch ? `(global: ${Utils.esc(gmatch[1].label)})` : "(global)";
      let opts = `<option value="__global__">${globalLabel}</option>`;
      for (const [key, p] of Object.entries(presets)) {
        opts += `<option value="${key}">${Utils.esc(p.label)}</option>`;
      }
      if (sp && !match) opts += '<option value="__custom__">Custom…</option>';
      // disabled divider, then the editor entry — an action, not a persona
      opts += '<option value="" disabled>────────────</option>';
      opts += '<option value="__manage__">⚙ Manage personas…</option>';
      sel.innerHTML = opts;
      sel.value = !sp ? "__global__" : (match ? match[0] : "__custom__");
      sel.title = sp
        ? "This document's system prompt — pick a preset, switch back to (global), or manage your personas"
        : "Pick a system-prompt preset for this document (overrides the global prompt) — or manage your personas";
    },

    /* ── persona manager (per-user presets) ─────────────────
       The header's persona presets live under volt:ai:personas, editable per-
       user: rename, reword, add, or delete. The editor is a plain form —
       changes apply only on Save; Cancel discards — so deleting a row or
       restoring defaults there is never destructive to the saved list. */
    _personas() {
      try {
        const raw = localStorage.getItem(PERSONA_STORAGE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === "object") {
            // drop reserved sentinels (hand-edited storage): a persona named
            // __global__ / __custom__ / __manage__ would shadow the picker's
            // action options and become unreachable
            const out = {};
            for (const [k, v] of Object.entries(parsed)) {
              if (!PERSONA_RESERVED_KEYS.has(k) && v && typeof v === "object") out[k] = v;
            }
            return out;
          }
        }
      } catch (e) { /* ignore */ }
      // first run: persist the built-ins so later renames/deletions stick
      try { localStorage.setItem(PERSONA_STORAGE_KEY, JSON.stringify(PERSONA_PRESETS)); } catch (e) { /* ignore */ }
      return { ...PERSONA_PRESETS };
    },
    openPersonaManager() {
      this._renderPersonaEditor();
      this._app()._openModal(this._app().elements.personaModal);
    },
    _closePersonaManager() { this._app()._closeModal(this._app().elements.personaModal); },
    _personaRowHtml(key, p) {
      return `<div class="persona-row" data-key="${Utils.esc(key)}">
        <div class="persona-row-head">
          <input class="persona-label" type="text" placeholder="Persona name (e.g. Legal)" value="${Utils.esc(p.label || "")}" spellcheck="false" aria-label="Persona name">
          <button class="persona-del" type="button" title="Delete this persona" aria-label="Delete this persona">×</button>
        </div>
        <textarea class="persona-prompt" rows="3" placeholder="System prompt — how this persona should answer…" spellcheck="false" aria-label="System prompt">${Utils.esc(p.prompt || "")}</textarea>
      </div>`;
    },
    _renderPersonaEditor() { this._renderPersonaEditorFrom(this._personas()); },
    _renderPersonaEditorFrom(presets) {
      const wrap = this._app().elements.personaList;
      const entries = Object.entries(presets);
      wrap.innerHTML = entries.length
        ? entries.map(([key, p]) => this._personaRowHtml(key, p)).join("")
        : '<div class="none">No personas yet — add one below.</div>';
    },
    _addPersonaRow() {
      const wrap = this._app().elements.personaList;
      const empty = wrap.querySelector(".none");
      if (empty) empty.remove();
      wrap.insertAdjacentHTML("beforeend", this._personaRowHtml("", { label: "", prompt: "" }));
      wrap.lastElementChild.querySelector(".persona-label").focus();
    },
    _restoreDefaultPersonas() {
      // form-only: rebuild the editor rows from the built-ins — the saved list
      // is touched only when the user hits Save, so Cancel keeps it intact
      this._renderPersonaEditorFrom(PERSONA_PRESETS);
    },
    /** Persist the editor form: unnamed rows are dropped, a row's existing key
        is kept when it has one (a rename keeps the key, so the header picker's
        selection stays matched to the doc's active prompt), and new rows get a
        fresh custom-N key. */
    _savePersonasFromEditor() {
      const wrap = this._app().elements.personaList;
      const out = {};
      const used = new Set();
      let n = 0;
      for (const row of wrap.querySelectorAll(".persona-row")) {
        const label = row.querySelector(".persona-label").value.trim();
        const prompt = row.querySelector(".persona-prompt").value.trim();
        if (!label) continue; // unnamed rows are dropped
        let key = (row.dataset.key || "").trim();
        if (!key || PERSONA_RESERVED_KEYS.has(key) || used.has(key)) {
          do { key = "custom-" + (++n); } while (used.has(key) || PERSONA_RESERVED_KEYS.has(key));
        }
        used.add(key);
        out[key] = { label, prompt };
      }
      if (!Object.keys(out).length) {
        this._app().toast("Add at least one persona to save", "error");
        return;
      }
      try { localStorage.setItem(PERSONA_STORAGE_KEY, JSON.stringify(out)); } catch (e) { /* ignore */ }
      this._closePersonaManager();
      this._renderModelLine(); // the header picker reflects the saved list
      this._app().toast("Personas saved", "ok");
    },

    /* ── chat persistence ───────────────────────────────────── */
    _chatKey() {
      const doc = this._app().currentDocInfo;
      return doc ? "volt:ai:chat:" + Utils.hash(doc.name + ":" + doc.size + ":" + doc.pages) : null;
    },
    _restoreChat() {
      this._pendingChatRestore = []; // a different doc's transcript supersedes any pending undo
      const key = this._chatKey();
      if (!key) { this._refreshChatPopBtn(); return; }
      try {
        const saved = localStorage.getItem(key);
        if (saved) {
          this.messages = JSON.parse(saved);
          this._renderMessages();
        }
      } catch (e) { this.messages = []; }
      this._refreshChatPopBtn();
    },
    /** The per-document transcript cap — one setting drives storage, backups,
        and restores so memory, disk, and what a backup carries always agree.
        Only the offered sizes are accepted (hand-edited settings fall back). */
    _historyLimit(v) {
      // one policy for storage and display: pass a candidate value (e.g. from
      // the settings select) to validate it, or omit to read the live setting
      const n = v !== undefined ? v : parseInt(this.settings.historyLimit, 10);
      return n === 40 || n === 100 || n === 250 ? n : 40;
    },
    _saveChat() {
      const key = this._chatKey();
      if (!key) return;
      try { localStorage.setItem(key, JSON.stringify(this.messages.slice(-this._historyLimit()))); } catch (e) { /* ignore */ }
    },
    /** Push a pre-clear transcript onto the chat-undo stack. Safe from
        aliasing: every wipe and new send replaces this.messages with a fresh
        array rather than mutating the pushed snapshot. */
    _pushChatUndo(msgs) {
      if (!Array.isArray(this._pendingChatRestore)) this._pendingChatRestore = [];
      this._pendingChatRestore.push(msgs);
      if (this._pendingChatRestore.length > 5) this._pendingChatRestore.shift();
    },
    /** Shared clear core (no undo bookkeeping — callers decide the policy). */
    _wipeChat() {
      this.messages = [];
      this._renderMessages();
      const key = this._chatKey();
      if (key) try { localStorage.removeItem(key); } catch (e) { /* ignore */ }
    },
    /** 'Clear chat' from the doc-settings popover — mirrors the override-reset
        pattern: snapshot the transcript, wipe it, and offer an undo there. */
    _clearChatFromPop() {
      if (!this.messages.length) return;
      this._pushChatUndo(this.messages);
      this._wipeChat();
      this._refreshChatPopBtn(); // only the chat button changes — no body rebuild
      this._app().toast("This document's chat cleared", "ok");
    },
    _undoClearChat() {
      const snap = Array.isArray(this._pendingChatRestore) ? this._pendingChatRestore.pop() : null;
      if (!snap) return;
      this.messages = snap;
      this._saveChat();
      this._renderMessages();
      this._refreshChatPopBtn();
      this._app().toast("Chat restored", "ok");
    },
    clearChat() {
      this._pendingChatRestore = []; // a fresh clear supersedes any pending undo
      this._wipeChat();
      this._refreshChatPopBtn();
    },

    /** Export this document's chat transcript as Markdown — question/answer
        pairs with page citations — for sharing the conversation outside Volt.
        Honors the same history cap as storage/backups, so the file never
        carries more than the app itself keeps. */
    toMarkdown() {
      const doc = this._app().currentDocInfo;
      const msgs = this.messages.filter(
        (m) => (m.role === "user" || m.role === "assistant") && String(m.content || "").trim()
      );
      if (!msgs.length) return "# Chat transcript\n\n_No conversation yet._\n";
      const out = [
        "# Chat transcript",
        `_Document: ${doc?.name || "untitled"}_`,
        `_Exported ${new Date().toLocaleString()} · model ${this._effective().model || "—"}_`,
        "",
      ];
      // each message is blockquoted (same convention as Volt.Ann.toMarkdown)
      // so model output containing `---` or headings can't visually collide
      // with the transcript's own structure; separators go between messages
      msgs.slice(-this._historyLimit()).forEach((m, i) => {
        if (i > 0) out.push("---", "");
        out.push(`## ${m.role === "user" ? "You" : "Volt"}`, "");
        out.push(m.content.trim().split("\n").map((ln) => "> " + ln).join("\n"), "");
        if (m.role === "assistant" && m.sources && m.sources.length) {
          out.push(`_↗ Sources: ${m.sources.map((p) => `[p.${p}]`).join(", ")}_`, "");
        }
        if (m.error) out.push("_⚠ answer errored — check AI settings (⚙)_", "");
      });
      return out.join("\n");
    },

    /** Restore a chat transcript from an annotations backup. Sanitizes each
        message (role / content / sources / error) so hand-edited JSON can't
        inject junk, then persists to the current document's chat key and
        re-renders the panel. */
    importChatFromBackup(raw) {
      this._pendingChatRestore = []; // a replaced transcript supersedes any pending undo
      if (!Array.isArray(raw)) { this._refreshChatPopBtn(); return; }
      const msgs = [];
      for (const m of raw) {
        if (!m || typeof m !== "object") continue;
        const role = (m.role === "user" || m.role === "assistant") ? m.role : null;
        const content = typeof m.content === "string" ? m.content : "";
        // whitespace-only content is dropped (like send()'s own trim) but the
        // original string is kept, so intentional leading newlines survive
        if (!role || !content.trim()) continue;
        const sources = Array.isArray(m.sources)
          ? m.sources.map((p) => parseInt(p, 10)).filter((p) => Number.isFinite(p) && p > 0 && p <= 10000).slice(0, 30)
          : [];
        msgs.push({ role, content, sources, error: Boolean(m.error) });
      }
      // match the app's own transcript window (the same cap _saveChat uses),
      // so memory, storage, and what a reload shows always agree — and a huge
      // hand-edited array can't balloon the DOM
      this.messages = msgs.slice(-this._historyLimit());
      this._saveChat();
      this._renderMessages();
      this._refreshChatPopBtn();
    },

    /* ── document text extraction (cached) ──────────────────── */
    async ensurePageTexts() {
      const app = this._app();
      if (this._pageTexts && this._pageTexts.docId === app.currentDocId) return this._pageTexts;
      const doc = app.currentDoc;
      if (!doc) return [];
      const out = [];
      for (let n = 1; n <= doc.numPages; n++) {
        try {
          const page = await doc.getPage(n);
          // OCR-first pages: the document's embedded layer was replaced (it
          // can be offset from the visible page) — read the aligned recognized
          // text so chat answers are grounded in what is actually on the page
          if (global.Volt.OCR && global.Volt.OCR.preferFor && global.Volt.OCR.preferFor(n)) {
            out.push({ page: n, text: global.Volt.OCR.pageText(n) });
            continue;
          }
          const tc = await page.getTextContent();
          let text = tc.items.map((it) => it.str).join(" ").replace(/\s+/g, " ").trim();
          // an image-only (scanned) page has no embedded text — use the OCR
          // store so grounded chat answers can read scanned documents too
          if (!text && global.Volt.OCR && global.Volt.OCR.available) {
            text = global.Volt.OCR.pageText(n);
          }
          out.push({ page: n, text });
        } catch (e) { out.push({ page: n, text: "" }); }
      }
      this._pageTexts = { docId: app.currentDocId, pages: out };
      return this._pageTexts;
    },

    /** Build grounded context: chunk + score top pages against the question. */
    async buildContext(question, extraText = "") {
      const cache = await this.ensurePageTexts();
      const pages = cache.pages.filter((p) => p.text.length > 40);
      if (!pages.length) return { context: extraText, sources: [] };

      const maxChars = this._effective().maxContextChars || 8000;
      const queryTokens = Utils.tokenize(question);
      const totalChunks = pages.reduce((n, p) => n + Utils.chunkText(p.text).length, 0) || 1;
      const docFreq = {};
      for (const p of pages) {
        const seen = new Set(Utils.tokenize(p.text));
        for (const t of seen) docFreq[t] = (docFreq[t] || 0) + 1;
      }

      // score each page by its best chunk
      const scored = [];
      for (const p of pages) {
        const chunks = Utils.chunkText(p.text);
        let best = 0;
        for (const c of chunks) best = Math.max(best, Utils.scoreChunk(queryTokens, c, docFreq, totalChunks));
        scored.push({ page: p.page, text: p.text, score: best });
      }
      scored.sort((a, b) => b.score - a.score);

      // take top pages until budget
      const picked = [];
      let budget = maxChars;
      for (const s of scored) {
        if (!s.score) break;
        if (s.text.length > budget) {
          picked.push({ page: s.page, text: s.text.slice(0, Math.floor(budget)) });
          budget = 0;
          break;
        }
        picked.push({ page: s.page, text: s.text });
        budget -= s.text.length;
      }

      let context = "";
      const sources = [];
      for (const p of picked) {
        context += `\n\n【Page ${p.page}】\n${p.text}`;
        sources.push(p.page);
      }
      if (extraText.trim()) {
        context += `\n\n【User selection】\n${extraText.trim()}`;
      }
      return { context, sources };
    },

    /* ── quick actions ──────────────────────────────────────── */
    /** Build the prompt a quick action will send. Split from _quickAction so
        the smoke can assert the text without firing a model request. The
        selection-slotting actions (explain / rewrite / translate) detect the
        Ctrl+A whole-page selection and embed a short "whole page" label
        instead of echoing the full page text into the chat — the page's text
        still reaches the model verbatim via the 【User selection】 context
        block that send() adds from the live selection. */
    _quickPrompt(action) {
      const sel = this._getSelection();
      const whole = this._wholePageSelection();
      const actions = {
        summarize: { text: "Summarize this document in a few clear paragraphs. Use bullet points for the key ideas.", needs: "doc" },
        keypoints: { text: "List the 5-8 most important points of this document as concise bullets, each with its page reference.", needs: "doc" },
        explain: { text: whole
          ? "Explain the whole page in plain language, as if to a curious friend. The full page text is provided in the document excerpts."
          : `Explain the following selected passage in plain language, as if to a curious friend:\n\n"""\n${sel || "(no text selected — explain the whole document instead)"}\n"""`, needs: "sel" },
        rewrite: { text: whole
          ? "Rewrite the whole page to be clearer and more concise, keeping the meaning identical. The full page text is provided in the document excerpts."
          : `Rewrite the following passage to be clearer and more concise, keeping the meaning identical:\n\n"""\n${sel || "(no text selected — rewrite the whole document as a summary)"}\n"""`, needs: "sel" },
        translate: { text: "Translate the whole document into clear, natural English. If it is already in English, translate it into Spanish. Keep the meaning precise." + (sel && !whole ? `\n\nPassage to translate instead:\n"""\n${sel}\n"""` : ""), needs: "doc" },
      };
      const a = actions[action];
      return a ? a.text : null;
    },

    _quickAction(action) {
      const text = this._quickPrompt(action);
      if (!text) return;
      this.send(text);
      // focus stays in chat
      this._app().elements.aiInput.focus();
    },

    /** Quick action 'Clear highlights': revert every text highlight in the
        document from chat, sharing Ann.clearHighlights() and its grouped
        undo (one Ctrl+Z restores them all). Destructive, so it arms the
        SAME 3-second 'Really …?' confirm the popover's Reset / Clear chat
        buttons use — the first click flips the button to "Really clear
        all?", the second click within the window decides. */
    _quickClearHighlights(btn) {
      const ann = Volt.Ann;
      if (!ann) { this._app().toast("No document open"); return; }
      this._confirmOrDo(btn, "Really clear all?", () => { ann.clearHighlights(); });
    },

    /** Quick action 'Copy highlights': the symmetric, non-destructive
        companion to 'Clear highlights' — exports every highlighted passage
        as Markdown notes to the clipboard, grouped by page with a
        '## Page N' header per page and passages in reading order
        (top-to-bottom), so the study workflow (highlight → collect as
        notes) closes the loop from chat. Same scope as the clear: text
        highlights only — the highlight tool's blank-space area fallback
        and the Rectangle tool's shapes carry no text and are skipped. */
    async _quickCopyHighlights() {
      const ann = Volt.Ann;
      const app = this._app();
      if (!ann) { app.toast("No document open"); return; }
      const hls = ann.list.filter((a) => a.type === "highlight" && a.text && a.text.trim());
      if (!hls.length) {
        app.toast("No text highlights to copy — drag over text to highlight it");
        return;
      }
      const byPage = new Map();
      for (const a of hls) {
        if (!byPage.has(a.page)) byPage.set(a.page, []);
        byPage.get(a.page).push(a);
      }
      const pages = [...byPage.keys()].sort((x, y) => x - y);
      // reading order within a page: highest quad edge first (PDF y-up)
      const topOf = (a) => (a.quads || []).reduce((m, q) => Math.max(m, ...q.map((p) => p.y)), 0);
      const docName = (app.currentPath || "").split(/[\\/]/).pop() || "Volt document";
      const lines = ["# Highlights — " + docName, ""];
      for (const p of pages) {
        lines.push("## Page " + p, "");
        const items = byPage.get(p).slice().sort((a, b) => topOf(b) - topOf(a));
        for (const a of items) lines.push("> " + a.text.trim(), "");
      }
      const ok = await app._writeClipboard(lines.join(String.fromCharCode(10)).trim() + String.fromCharCode(10));
      if (ok) {
        app.toast("Copied " + hls.length + " highlight" + (hls.length === 1 ? "" : "s") +
          " from " + pages.length + " page" + (pages.length === 1 ? "" : "s") + " — Ctrl+V to paste", "ok");
      } else {
        app.toast("Copy failed — clipboard unavailable", "error");
      }
    },

    _getSelection() {
      const sel = global.getSelection && global.getSelection().toString();
      return sel ? sel.trim() : "";
    },

    /** True when the current DOM selection covers the ENTIRE selectable text
        of one rendered page — i.e. the Ctrl+A whole-page selection (or a
        manual drag that happens to span every line). Compared by normalized
        text so partial selections never match, scans with no text layer (or
        no selection) return false, and the page is identified by content —
        so a selection made on one page still matches after the view scrolls
        past it. The AI panel labels such selections "whole page" instead of
        echoing the full page text into the chat. */
    _wholePageSelection() {
      const text = this._getSelection();
      if (!text) return false;
      const norm = text.replace(/\s+/g, " ").trim();
      for (const [, r] of this._app().rendered) {
        if (!r.textLayer) continue;
        const parts = [];
        const walker = document.createTreeWalker(r.textLayer, NodeFilter.SHOW_TEXT);
        let n;
        while ((n = walker.nextNode())) { if (n.textContent && n.textContent.trim()) parts.push(n.textContent); }
        const full = parts.join(" ").replace(/\s+/g, " ").trim();
        if (full && norm === full) return true;
      }
      return false;
    },

    /* ── send / stream ──────────────────────────────────────── */
    async send(rawText) {
      const app = this._app();
      const text = (rawText || "").trim();
      if (!text) return;
      if (!this.configured()) {
        this.openSettings();
        this._app().toast("Connect a model first (⚙ in the toolbar)", "error");
        return;
      }
      if (this.streaming) { this._app().toast("Already streaming — press stop first", "error"); return; }
      this._pendingChatRestore = []; // new activity supersedes any pending chat undo
      // persona commands: '/persona <name>' or a natural-language directive
      // ('use the legal voice from now on') switch the active persona without
      // leaving the chat — acknowledged in-thread, no API call
      const personaCmd = this._personaCommand(text);
      if (personaCmd) { this._execPersonaCommand(personaCmd, text); return; }

      // build grounded context
      const extra = this._getSelection();
      let context = "", sources = [];
      try {
        const built = await this.buildContext(text, extra);
        context = built.context;
        sources = built.sources;
      } catch (e) {
        this._app().toast("Could not extract document text: " + e.message, "error");
      }
      this._app().elements.aiContextLine.textContent = sources.length
        ? `Context: ${sources.map((p) => `p.${p}`).join(", ")}`
        : "Context: question only";

      this.messages.push({ role: "user", content: text });
      const assistantMsg = { role: "assistant", content: "", sources, error: false };
      this.messages.push(assistantMsg);
      this._renderMessages(true);
      this._app().elements.aiInput.value = "";
      this._autosizeInput();

      const contextBlock = context
        ? `Document excerpts (use these as your primary source; cite pages as [p.N]):\n${context}`
        : "";
      const userContent = contextBlock ? `${contextBlock}\n\nQuestion: ${text}` : text;

      const messages = [
        { role: "system", content: this._effective().systemPrompt },
        ...this.messages.filter((m) => m.role !== "assistant" || m.content).slice(-14).map((m) => ({
          role: m.role, content: m.content,
        })),
      ];
      // replace the just-added user message with the context-augmented one
      messages[messages.length - 1] = { role: "user", content: userContent };

      this.streaming = true;
      this._showStop(true);
      this.abortCtrl = new AbortController();

      try {
        await this._stream(messages, assistantMsg);
      } catch (e) {
        if (e.name === "AbortError") {
          assistantMsg.error = false;
          if (!assistantMsg.content) assistantMsg.content = "_(stopped)_";
        } else {
          assistantMsg.error = true;
          assistantMsg.content = `⚠ ${e.message}\n\nCheck your AI settings (⚙) — base URL, model name, and key.`;
          this._renderMessages();
        }
      } finally {
        this.streaming = false;
        this._showStop(false);
        this._saveChat();
        this._renderModelLine();
        this._refreshChatPopBtn(); // a new message supersedes any pending chat undo
        // conversation mode: read the answer aloud if the user enabled it
        // (never interrupts an active read-aloud; silent when voice is off)
        if (!assistantMsg.error && assistantMsg.content && global.Volt.Voice) {
          try { global.Volt.Voice.speakReply(assistantMsg.content); } catch (e) { /* voice is best-effort */ }
        }
      }
    },

    /* ── AI tools: let the model read & change the document ─────
       Native OpenAI-style function calling (tools) against the chat
       endpoint — Ollama, LM Studio, OpenAI, Groq, OpenRouter all accept it.
       The tools mirror what a user can do: read pages, search, list/add/
       remove annotations, navigate. Every mutation goes through Volt.Ann's
       undo stack, so anything the AI changes the user can undo. If the
       endpoint rejects tool calls (400 mentioning tools/function), the
       request is retried once without them — small local models that can't
       call functions still answer from the document context. */
    TOOLS: [
      { type: "function", function: { name: "get_document_info", description: "Return the open document's name, page count, file size, and current annotation count.", parameters: { type: "object", properties: {} } } },
      { type: "function", function: { name: "get_page_text", description: "Return the full text of one page (embedded text, or OCR text for scanned pages). Use this to read content you haven't seen yet.", parameters: { type: "object", properties: { page: { type: "integer", description: "1-based page number" } }, required: ["page"] } } },
      { type: "function", function: { name: "search_text", description: "Find which pages contain a phrase, with a short snippet of each match. Use before answering questions about specific terms.", parameters: { type: "object", properties: { query: { type: "string", description: "The phrase to search for" } }, required: ["query"] } } },
      { type: "function", function: { name: "get_annotations", description: "List the document's annotations (highlights, notes, rectangles) with page and text.", parameters: { type: "object", properties: {} } } },
      { type: "function", function: { name: "add_highlight", description: "Highlight the given phrase on a page, like the user dragging the highlight tool. The phrase must appear in the page's text.", parameters: { type: "object", properties: { page: { type: "integer", description: "1-based page number" }, text: { type: "string", description: "Exact phrase to highlight" } }, required: ["page", "text"] } } },
      { type: "function", function: { name: "add_note", description: "Attach a sticky note to a page.", parameters: { type: "object", properties: { page: { type: "integer", description: "1-based page number" }, text: { type: "string" } }, required: ["page", "text"] } } },
      { type: "function", function: { name: "remove_annotations", description: "Delete annotations. type can be 'all', 'highlight', 'note', or 'rect'.", parameters: { type: "object", properties: { type: { type: "string" } }, required: ["type"] } } },
      { type: "function", function: { name: "navigate_to_page", description: "Jump the viewer to a page; the user sees it scroll there.", parameters: { type: "object", properties: { page: { type: "integer", description: "1-based page number" } }, required: ["page"] } } },
    ],
    TOOL_MAX_ROUNDS: 4,

    /** Execute one tool call. Returns a JSON string for the model. */
    async _runTool(name, args = {}) {
      const app = this._app();
      const Ann = global.Volt.Ann;
      const out = (v) => JSON.stringify(v);
      switch (name) {
        case "get_document_info":
          return out({
            name: app.currentDocInfo ? app.currentDocInfo.name : null,
            pages: app.currentDoc ? app.currentDoc.numPages : 0,
            size: app.currentDocInfo ? app.currentDocInfo.size : 0,
            annotations: Ann.list.length,
          });
        case "get_page_text": {
          const page = Math.max(1, Number(args.page) || 1);
          const cache = await this.ensurePageTexts();
          const p = cache.pages.find((x) => x.page === page);
          const text = p ? p.text : "";
          return out({ page, found: text.length > 0, text: text.slice(0, 8000) });
        }
        case "search_text": {
          const q = String(args.query || "").toLowerCase();
          const cache = await this.ensurePageTexts();
          const results = [];
          for (const p of cache.pages) {
            const idx = p.text.toLowerCase().indexOf(q);
            if (idx >= 0) results.push({ page: p.page, snippet: p.text.slice(Math.max(0, idx - 70), Math.min(p.text.length, idx + q.length + 140)) });
          }
          return out({ query: args.query, matches: results.length, results: results.slice(0, 10) });
        }
        case "get_annotations":
          return out({ annotations: Ann.list.map((a) => ({ id: a.id, type: a.type, page: a.page, color: a.color, text: (a.text || "").slice(0, 160) })) });
        case "add_highlight": {
          const page = Math.max(1, Number(args.page) || 1);
          const text = String(args.text || "").trim();
          if (!text) return out({ ok: false, error: "text is required" });
          if (!app.currentDoc) return out({ ok: false, error: "no document open" });
          const wrap = await this._ensurePageWrap(page);
          if (!wrap) return out({ ok: false, error: `page ${page} is not available` });
          const spans = [...wrap.querySelectorAll(".page-text-layer span")].filter((s) => s.textContent.trim());
          if (!spans.length) return out({ ok: false, error: `page ${page} has no selectable text (try OCR first)` });
          const wrect = wrap.getBoundingClientRect();
          const boxes = spans.map((s) => {
            const r = s.getBoundingClientRect();
            return { x1: r.left - wrect.left, y1: r.top - wrect.top, x2: r.left - wrect.left + r.width, y2: r.top - wrect.top + r.height, text: s.textContent };
          });
          const lines = Ann._groupSpansIntoLines(boxes);
          const q = text.toLowerCase();
          const hits = lines.filter((ln) => ln.items.map((i) => i.text).join(" ").toLowerCase().includes(q));
          if (!hits.length) return out({ ok: false, error: `no text matching "${text}" on page ${page}` });
          const quads = hits.map((ln) => Ann._lineToQuad(wrap, ln));
          const ann = {
            id: Utils.uid(), type: "highlight", page, quads,
            text: hits.map((ln) => ln.items.map((i) => i.text).join(" ")).join(" ").replace(/\s+/g, " ").trim().slice(0, 400),
            color: "#fde047", createdAt: Date.now(),
          };
          Ann._mutate(() => Ann.list.push(ann));
          return out({ ok: true, page, matchedLines: quads.length, text: ann.text });
        }
        case "add_note": {
          const page = Math.max(1, Number(args.page) || 1);
          const text = String(args.text || "");
          if (!app.currentDoc) return out({ ok: false, error: "no document open" });
          const dims = app.pageDims[page - 1] || { w: 612, h: 792 };
          const ann = { id: Utils.uid(), type: "note", page, point: { x: dims.w / 2, y: dims.h / 2 }, text, color: "#f472b6", createdAt: Date.now() };
          Ann._mutate(() => Ann.list.push(ann));
          return out({ ok: true, page, noteId: ann.id });
        }
        case "remove_annotations": {
          const t = String(args.type || "all");
          if (t === "all") { Ann._mutate(() => { Ann.list = []; }); return out({ ok: true, removed: "all", count: 0 }); }
          const before = Ann.list.length;
          Ann._mutate(() => { Ann.list = Ann.list.filter((a) => a.type !== t); });
          return out({ ok: true, removed: t, count: before - Ann.list.length });
        }
        case "navigate_to_page": {
          const page = Math.max(1, Number(args.page) || 1);
          if (app.goToPage) app.goToPage(page, false);
          return out({ ok: true, page });
        }
        default:
          return out({ error: "unknown tool: " + name });
      }
    },

    /** Render a page's wrap on demand (pdf.js renders lazily), waiting up
        to ~4s so the AI can highlight a page the user hasn't scrolled to. */
    async _ensurePageWrap(page) {
      const app = this._app();
      let wrap = app.rendered.get(page)?.wrap;
      if (wrap) return wrap;
      if (app.goToPage) app.goToPage(page, false);
      const t0 = Date.now();
      while (Date.now() - t0 < 4000) {
        await new Promise((r) => setTimeout(r, 80));
        wrap = app.rendered.get(page)?.wrap;
        if (wrap) return wrap;
      }
      return null;
    },

    async _stream(messages, assistantMsg, opts = {}) {
      // standalone calls (e.g. the tool harness test path) may reach here
      // without send() having created a controller — make one lazily so the
      // abort signal always exists.
      if (!this.abortCtrl) this.abortCtrl = new AbortController();
      const url = this.settings.baseUrl + "/chat/completions";
      const body = {
        model: this._effective().model,
        messages,
        temperature: this.settings.temperature,
        stream: true,
      };
      if (opts.tools !== false) { body.tools = this.TOOLS; body.tool_choice = "auto"; }
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.settings.apiKey ? { Authorization: "Bearer " + this.settings.apiKey } : {}),
        },
        body: JSON.stringify(body),
        signal: this.abortCtrl.signal,
      });

      if (!res.ok) {
        let detail = "";
        try { const j = await res.json(); detail = j.error?.message || j.message || ""; } catch (e) { /* no body */ }
        // a small local model (or an older endpoint) that rejects function
        // calling — retry once without tools so chat still works
        if (opts.tools !== false && /tool|function/i.test(detail)) {
          return this._stream(messages, assistantMsg, { tools: false, round: opts.round });
        }
        throw new Error(`API error ${res.status}${detail ? ": " + detail : ""}`);
      }

      const toolCalls = {}; // index → {id, name, arguments}
      const absorb = (tc) => {
        for (const t of tc) {
          const slot = toolCalls[t.index] = toolCalls[t.index] || { id: "", name: "", arguments: "" };
          if (t.id) slot.id = t.id;
          if (t.function) {
            if (t.function.name) slot.name += t.function.name;
            if (t.function.arguments) slot.arguments += t.function.arguments;
          }
        }
      };

      if (!res.body) {
        const data = await res.json();
        assistantMsg.content = data.choices?.[0]?.message?.content || "";
        const calls = data.choices?.[0]?.message?.tool_calls;
        if (calls) absorb(calls.map((c, i) => ({ index: i, id: c.id, function: c.function })));
      } else {
        // SSE streaming
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let lastRender = 0;
        const msgBody = this._lastMsgBody();

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop();
          for (const line of lines) {
            const t = line.trim();
            if (!t.startsWith("data:")) continue;
            const payload = t.slice(5).trim();
            if (payload === "[DONE]") continue;
            try {
              const json = JSON.parse(payload);
              const delta = json.choices?.[0]?.delta || {};
              const content = delta.content || "";
              if (content) {
                assistantMsg.content += content;
                const now = performance.now();
                if (now - lastRender > 60 && msgBody) {
                  msgBody.innerHTML = Utils.markdown(assistantMsg.content);
                  this._scrollChat();
                  lastRender = now;
                }
              }
              if (opts.tools !== false && delta.tool_calls) absorb(delta.tool_calls);
            } catch (e) { /* partial json */ }
          }
        }
      }

      // the model asked to use tools — execute them, feed the results back,
      // and continue the conversation (up to TOOL_MAX_ROUNDS)
      const calls = Object.values(toolCalls).filter((c) => c.name);
      if (calls.length && (opts.round || 0) < this.TOOL_MAX_ROUNDS) {
        const norm = calls.map((c, i) => ({
          id: c.id || "call_" + i, type: "function",
          function: { name: c.name, arguments: c.arguments || "{}" },
        }));
        messages.push({ role: "assistant", content: assistantMsg.content || null, tool_calls: norm });
        for (const c of norm) {
          let result;
          try {
            let args = {};
            try { args = JSON.parse(c.function.arguments || "{}"); } catch (e) { args = { _raw: c.function.arguments }; }
            result = await this._runTool(c.function.name, args);
          } catch (e) { result = JSON.stringify({ error: String((e && e.message) || e) }); }
          assistantMsg.toolCalls = (assistantMsg.toolCalls || []).concat(c.function.name);
          messages.push({ role: "tool", tool_call_id: c.id, content: result });
        }
        return this._stream(messages, assistantMsg, { tools: opts.tools, round: (opts.round || 0) + 1 });
      }
      this._renderMessages();
    },

    _lastMsgBody() {
      const msgs = this._app().elements.aiMessages.querySelectorAll(".msg.assistant");
      return msgs[msgs.length - 1]?.querySelector(".msg-body") || null;
    },

    _stop() {
      if (this.abortCtrl) this.abortCtrl.abort();
    },

    /* ── rendering ──────────────────────────────────────────── */
    _renderMessages(focus = false) {
      const wrap = this._app().elements.aiMessages;
      // keep welcome
      const welcome = wrap.querySelector(".ai-welcome");
      wrap.innerHTML = "";
      if (welcome) wrap.appendChild(welcome);
      if (!this.messages.length) return;

      for (const m of this.messages) {
        const div = document.createElement("div");
        div.className = "msg " + m.role + (m.error ? " error" : "");
        const roleLabel = m.role === "user" ? "You" : "Volt";
        div.innerHTML = `
          <div class="msg-role">${roleLabel}</div>
          <div class="msg-body">${Utils.markdown(m.content || (m.role === "assistant" ? "…" : ""))}</div>`;
        if (m.sources && m.sources.length && m.role === "assistant" && m.content) {
          const chips = document.createElement("div");
          chips.className = "msg-sources";
          chips.innerHTML = m.sources.map((p) => `<span class="src-chip" data-page="${p}">↗ p.${p}</span>`).join("");
          div.appendChild(chips);
        }
        // a small note when the model used tools to read/change the document
        if (m.toolCalls && m.toolCalls.length && m.role === "assistant") {
          const chips = document.createElement("div");
          chips.className = "msg-sources msg-tools";
          chips.innerHTML = "⚙ tools: " + m.toolCalls.map((n) => `<span class="src-chip">${Utils.esc(n)}</span>`).join(" ");
          div.appendChild(chips);
        }
        wrap.appendChild(div);
      }
      this._scrollChat();
      if (focus) this._app().elements.aiInput.focus();
    },

    _scrollChat() {
      const wrap = this._app().elements.aiMessages;
      wrap.scrollTop = wrap.scrollHeight;
    },

    _showStop(show) {
      this._app().elements.aiSend.hidden = show;
      this._app().elements.aiStop.hidden = !show;
    },

    _autosizeInput() {
      const el = this._app().elements.aiInput;
      el.style.height = "auto";
      el.style.height = Math.min(el.scrollHeight, 120) + "px";
    },
  };
})(typeof window !== "undefined" ? window : globalThis);
