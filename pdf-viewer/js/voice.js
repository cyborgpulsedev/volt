/* ═══════════════════════════════════════════════════════════════
   voice.js — Volt.Voice
   Listen to a PDF (read-aloud) and talk to the AI in conversation.

   Shipped engines (nothing to download, app stays small):
     TTS  "web"  — the platform's built-in voices via the Web Speech API
                   (Windows: David/Zira/Mark … local, works offline)
     STT  "web"  — Chromium's speech recognition (network service)
   External engines (local server or hosted — pluggable, no bundling):
     TTS  "custom" — any OpenAI-compatible POST /audio/speech endpoint
                     (e.g. a local Piper/Coqui/Edge server, ElevenLabs…)
     STT  "custom" — any OpenAI-compatible POST /audio/transcriptions
                     endpoint (e.g. a local Whisper/sherpa server)
   All settings live under volt:voice:settings.
   ═══════════════════════════════════════════════════════════════ */
(function (global) {
  "use strict";

  const Volt = global.Volt = global.Volt || {};
  const $ = (id) => document.getElementById(id);

  const KEY = "volt:voice:settings";
  const DEFAULT_SETTINGS = {
    ttsEngine: "web",          // "web" | "custom"
    ttsVoice: "",              // web: voiceURI; custom: voice name sent to the endpoint
    ttsRate: 1,                // web only (0.5–2)
    speakReplies: false,       // AI conversation: speak assistant answers aloud
    ttsUrl: "", ttsApiKey: "", ttsModel: "", ttsVoiceName: "",
    sttEngine: "web",          // "web" | "custom"
    sttUrl: "", sttApiKey: "", sttModel: "",
    // audio device picks (⚙ → Voice): the built-in engines always use the
    // system default devices, so these only apply to the external paths —
    // sttMicId is requested via getUserMedia({deviceId}) for custom voice
    // input, ttsSinkId is set via HTMLMediaElement.setSinkId (Chromium) for
    // custom TTS playback. Empty = "Default device".
    sttMicId: "", ttsSinkId: "",
  };

  Volt.Voice = {
    settings: { ...DEFAULT_SETTINGS },
    readAloud: { active: false, paused: false, page: 1, chunks: [], idx: 0, speaking: false, cache: null },
    talk: { active: false, paused: false },  // AI replies read aloud (talk mode)
    _voices: [],        // [{voiceURI, name, lang, localService}]
    _voicesLoaded: false,
    _listening: false,  // STT in progress
    _onFinal: null,     // transcript callback for the active listening session
    _rec: null,         // webkitSpeechRecognition instance
    _micStream: null,   // MediaStream for custom-STT recording
    _recorder: null,    // MediaRecorder for custom-STT recording
    _recChunks: [],
    _audioEl: null,     // <audio> for custom TTS (pause/resume/stop)
    _settingsObserver: null,
    _micPermissionTried: false, // one-time getUserMedia so device labels populate

    init() {
      try {
        const saved = localStorage.getItem(KEY);
        if (saved) this.settings = { ...DEFAULT_SETTINGS, ...JSON.parse(saved) };
      } catch (e) { /* keep defaults */ }
      this._syncTalkToggle();
      this._bindControls();
      this._watchSettingsModal();
    },

    /* ── talk mode (AI replies read aloud) ────────────────────
       A speaker toggle in the AI input row arms/ disarms speakReplies
       (same setting the ⚙ modal exposes, so the two stay in sync); while
       talk mode is on AND the AI is speaking, the floating talk-bar shows
       pause / stop (and the play glyph flips to Resume while paused) so
       the user can always interrupt the voice. */
    _syncTalkToggle() {
      const btn = $("ai-talk");
      if (btn) {
        btn.setAttribute("aria-pressed", this.settings.speakReplies ? "true" : "false");
        btn.classList.toggle("on", !!this.settings.speakReplies);
      }
    },
    toggleTalk() {
      this.settings.speakReplies = !this.settings.speakReplies;
      try { localStorage.setItem(KEY, JSON.stringify(this.settings)); } catch (e) { /* ignore */ }
      const cb = $("set-speak-replies");
      if (cb) cb.checked = !!this.settings.speakReplies;
      this._syncTalkToggle();
      if (!this.settings.speakReplies && this.talk.active) this.stopTalk();
      this._app().toast(this.settings.speakReplies ? "Talk mode on — AI replies will be read aloud" : "Talk mode off", "ok");
    },
    pauseTalk() {
      if (!this.talk.active || this.talk.paused) return;
      this.talk.paused = true;
      this.pauseSpeaking();
      this._updateTalkBar();
    },
    resumeTalk() {
      const t = this.talk;
      if (!t.active || !t.paused) return;
      t.paused = false;
      this.resumeSpeaking();
      this._updateTalkBar();
    },
    stopTalk() {
      if (!this.talk.active) { this._showTalkBar(false); return; }
      this.talk.active = false;
      this.talk.paused = false;
      this.stopSpeaking();
      this._showTalkBar(false);
    },
    _showTalkBar(on) {
      const bar = $("talk-bar");
      if (bar) bar.hidden = !on;
    },
    _updateTalkBar() {
      const t = this.talk;
      const play = $("talk-play"), info = $("talk-info");
      if (play) {
        play.textContent = t.paused ? "▶" : "⏸";
        play.title = t.paused ? "Resume" : "Pause";
        play.setAttribute("aria-label", t.paused ? "Resume AI reply" : "Pause AI reply");
      }
      if (info) info.textContent = t.active ? (t.paused ? "Paused" : "Speaking…") : "";
    },

    _app() { return global.Volt.App; },

    /* ── settings UI (the ⚙ modal's Voice section) ───────────── */
    _watchSettingsModal() {
      const modal = $("settings-modal");
      if (!modal || this._settingsObserver) return;
      // refresh the Voice fields whenever the settings modal opens (the AI
      // fields are filled by Volt.AI; Voice owns its own section)
      this._settingsObserver = new MutationObserver(() => {
        if (!modal.hidden) this._refreshSettingsFields();
      });
      this._settingsObserver.observe(modal, { attributes: true, attributeFilter: ["hidden"] });
      const save = $("set-save");
      if (save) save.addEventListener("click", () => this._saveSettings());
    },

    async _refreshSettingsFields() {
      const s = this.settings;
      const eng = $("set-tts-engine"), stt = $("set-stt-engine");
      if (eng) eng.value = s.ttsEngine;
      if (stt) stt.value = s.sttEngine;
      const voice = $("set-tts-voice");
      if (voice) {
        const voices = await this.voices();
        const prev = voice.value || s.ttsVoice;
        voice.innerHTML = "";
        const en = voices.filter((v) => /^en/i.test(v.lang || ""));
        const list = en.length ? en : voices;
        if (!list.length) voice.innerHTML = '<option value="">No voices available</option>';
        for (const v of list) {
          const opt = document.createElement("option");
          opt.value = v.voiceURI;
          opt.textContent = `${v.name} (${v.lang})`;
          voice.appendChild(opt);
        }
        if (prev && [...voice.options].some((o) => o.value === prev)) voice.value = prev;
        else if (s.ttsVoice) voice.value = s.ttsVoice;
        // remember the choice so read-aloud uses the same voice
        s.ttsVoice = voice.value || "";
      }
      const rate = $("set-tts-rate");
      if (rate) rate.value = Number(s.ttsRate) || 1;
      const sr = $("set-speak-replies");
      if (sr) sr.checked = !!s.speakReplies;
      const vn = $("set-tts-voicename");
      if (vn) vn.value = s.ttsVoiceName || "";
      const tUrl = $("set-tts-url"), tKey = $("set-tts-key"), tModel = $("set-tts-model");
      if (tUrl) tUrl.value = s.ttsUrl || "";
      if (tKey) tKey.value = s.ttsApiKey || "";
      if (tModel) tModel.value = s.ttsModel || "";
      const sUrl = $("set-stt-url"), sKey = $("set-stt-key"), sModel = $("set-stt-model");
      if (sUrl) sUrl.value = s.sttUrl || "";
      if (sKey) sKey.value = s.sttApiKey || "";
      if (sModel) sModel.value = s.sttModel || "";
      // audio devices — the first call grants mic permission so the device
      // labels populate; both selects keep their current pick when re-opened
      const mic = $("set-stt-mic"), sink = $("set-tts-sink");
      if (mic) await this._fillDeviceSelect(mic, "audioinput", s.sttMicId, "Default microphone");
      if (sink) await this._fillDeviceSelect(sink, "audiooutput", s.ttsSinkId, "Default speaker");
      this._syncEngineVisibility();
      const test = $("set-tts-test");
      if (test) test.onclick = () => {
        this.speak("This is the voice Volt will read with.").then((ok) => {
          this._app().toast(ok ? "Speaking…" : "No speech engine available — check your Voice settings", ok ? "ok" : "error");
        });
      };
    },

    _syncEngineVisibility() {
      const eng = $("set-tts-engine");
      const custom = $("tts-custom-fields");
      const web = $("tts-web-fields");
      if (eng && custom && web) {
        custom.hidden = eng.value !== "custom";
        web.hidden = eng.value !== "web";
      }
      const stt = $("set-stt-engine");
      const sCustom = $("stt-custom-fields");
      if (stt && sCustom) sCustom.hidden = stt.value !== "custom";
    },

    _saveSettings() {
      const s = this.settings;
      const eng = $("set-tts-engine"), stt = $("set-stt-engine");
      if (eng) s.ttsEngine = eng.value;
      if (stt) s.sttEngine = stt.value;
      const voice = $("set-tts-voice");
      if (voice) s.ttsVoice = voice.value || "";
      const rate = $("set-tts-rate");
      if (rate) s.ttsRate = Math.min(2, Math.max(0.5, Number(rate.value) || 1));
      const sr = $("set-speak-replies");
      if (sr) s.speakReplies = sr.checked;
      this._syncTalkToggle();
      const vn = $("set-tts-voicename");
      if (vn) s.ttsVoiceName = vn.value || "";
      const tUrl = $("set-tts-url"), tKey = $("set-tts-key"), tModel = $("set-tts-model");
      if (tUrl) s.ttsUrl = (tUrl.value || "").trim().replace(/\/+$/, "");
      if (tKey) s.ttsApiKey = (tKey.value || "").trim();
      if (tModel) s.ttsModel = (tModel.value || "").trim();
      const sUrl = $("set-stt-url"), sKey = $("set-stt-key"), sModel = $("set-stt-model");
      if (sUrl) s.sttUrl = (sUrl.value || "").trim().replace(/\/+$/, "");
      if (sKey) s.sttApiKey = (sKey.value || "").trim();
      if (sModel) s.sttModel = (sModel.value || "").trim();
      const mic = $("set-stt-mic"), sink = $("set-tts-sink");
      if (mic) s.sttMicId = mic.value || "";
      if (sink) s.ttsSinkId = sink.value || "";
      try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) { /* quota */ }
    },

    /* ── audio device pickers (⚙ → Voice) ──────────────────────
       enumerateDevices lists microphones (audioinput) and speakers
       (audiooutput). Labels/ids only populate after mic permission, so the
       first call briefly opens (and immediately closes) the mic — the
       desktop app grants this silently, the browser prompts once. The picks
       persist as sttMicId / ttsSinkId and are honored by the EXTERNAL
       engines only (see _startCustomStt / _speakCustom) — the built-in Web
       Speech paths always use the system default devices. */
    async _deviceList(kind) {
      const md = navigator.mediaDevices;
      if (!md || !md.enumerateDevices) return [];
      try {
        if (!this._micPermissionTried) {
          this._micPermissionTried = true;
          try {
            const s = await md.getUserMedia({ audio: true });
            s.getTracks().forEach((t) => { try { t.stop(); } catch (e) { /* ignore */ } });
          } catch (e) { /* denied — labels stay anonymous, picker shows only named devices */ }
        }
        const list = await md.enumerateDevices();
        return list.filter((d) => d.kind === kind && d.deviceId && d.deviceId.trim());
      } catch (e) { return []; }
    },

    async _fillDeviceSelect(sel, kind, current, defaultLabel) {
      const devices = await this._deviceList(kind);
      const prev = sel.value || current || "";
      sel.innerHTML = "";
      const dflt = document.createElement("option");
      dflt.value = ""; dflt.textContent = defaultLabel;
      sel.appendChild(dflt);
      devices.forEach((d, i) => {
        const o = document.createElement("option");
        o.value = d.deviceId;
        o.textContent = (d.label && d.label.trim())
          ? d.label
          : (kind === "audioinput" ? "Microphone " : "Speaker ") + (i + 1);
        sel.appendChild(o);
      });
      if (prev && [...sel.options].some((o) => o.value === prev)) sel.value = prev;
      else if (current && [...sel.options].some((o) => o.value === current)) sel.value = current;
    },

    /* ── TTS: built-in voices ────────────────────────────────── */
    speechSynthOk() { return !!(global.speechSynthesis && global.SpeechSynthesisUtterance); },

    async voices() {
      const synth = global.speechSynthesis;
      if (!synth) return [];
      const grab = () => {
        const v = synth.getVoices() || [];
        if (v.length) { this._voices = v; this._voicesLoaded = true; }
        return v;
      };
      if (synth.getVoices && synth.getVoices().length) return grab();
      if (this._voicesLoaded) return this._voices;
      await new Promise((res) => {
        synth.addEventListener("voiceschanged", () => res(), { once: true });
        setTimeout(res, 1500);
      });
      return grab();
    },

    _pickVoice() {
      const want = this.settings.ttsVoice;
      if (want) {
        const hit = this._voices.find((v) => v.voiceURI === want);
        if (hit) return hit;
      }
      return this._voices.find((v) => /^en/i.test(v.lang || "")) || this._voices[0] || null;
    },

    /** Speak `text` with the configured engine. Returns true when an engine
        accepted the request (web) or a Promise<boolean> for custom. */
    speak(text, opts = {}) {
      if (this.settings.ttsEngine === "custom") return this._speakCustom(text, opts);
      return this._speakWeb(text, opts);
    },

    _speakWeb(text, opts = {}) {
      if (!this.speechSynthOk()) return false;
      const synth = global.speechSynthesis;
      synth.cancel(); // don't let previous chunks overlap
      const u = new SpeechSynthesisUtterance(String(text));
      const v = this._pickVoice();
      if (v) u.voice = v;
      u.rate = Number(this.settings.ttsRate) || 1;
      u.onend = () => { if (opts.onEnd) opts.onEnd(); };
      u.onerror = () => { if (opts.onError) opts.onError(); };
      synth.speak(u);
      return true;
    },

    async _speakCustom(text, opts = {}) {
      const url = (this.settings.ttsUrl || "").replace(/\/+$/, "");
      if (!url) {
        if (opts.onError) opts.onError();
        return false;
      }
      const res = await fetch(url + "/audio/speech", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.settings.ttsApiKey ? { Authorization: "Bearer " + this.settings.ttsApiKey } : {}),
        },
        body: JSON.stringify({
          model: this.settings.ttsModel || "tts-1",
          input: String(text),
          voice: this.settings.ttsVoiceName || this.settings.ttsVoice || "alloy",
          response_format: "mp3",
        }),
      });
      if (!res.ok) {
        let detail = "";
        try { const j = await res.json(); detail = j.error?.message || j.message || ""; } catch (e) { /* no body */ }
        if (opts.onError) opts.onError();
        throw new Error(`TTS endpoint error ${res.status}${detail ? ": " + detail : ""}`);
      }
      const blob = await res.blob();
      const el = new Audio(URL.createObjectURL(blob));
      this._audioEl = el;
      // a chosen speaker (⚙ → Voice) routes this element there — Chromium
      // only (setSinkId); a stale/removed device falls back to the default
      if (this.settings.ttsSinkId && typeof el.setSinkId === "function") {
        try { await el.setSinkId(this.settings.ttsSinkId); } catch (e) { /* default output */ }
      }
      el.onended = () => { if (opts.onEnd) opts.onEnd(); };
      el.onerror = () => { if (opts.onError) opts.onError(); };
      await el.play();
      return true;
    },

    stopSpeaking() {
      if (global.speechSynthesis) global.speechSynthesis.cancel();
      if (this._audioEl) { try { this._audioEl.pause(); } catch (e) { /* ignore */ } this._audioEl = null; }
    },
    pauseSpeaking() {
      if (global.speechSynthesis) global.speechSynthesis.pause();
      if (this._audioEl) try { this._audioEl.pause(); } catch (e) { /* ignore */ }
    },
    resumeSpeaking() {
      if (global.speechSynthesis) global.speechSynthesis.resume();
      if (this._audioEl) try { this._audioEl.play(); } catch (e) { /* ignore */ }
    },

    /** Strip markdown so spoken replies sound natural. */
    _plain(text) {
      return String(text || "")
        .replace(/```[\s\S]*?```/g, " ")
        .replace(/[*_~`#>|]/g, " ")
        .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/\[p\.\d+\]/g, "")
        .replace(/\s+/g, " ")
        .trim();
    },

    /** Speak an AI assistant reply (settings.speakReplies). Never interrupts
        an active read-aloud. Returns false when it shouldn't speak. While
        speaking, the talk-bar shows with pause/stop so the user can always
        interrupt the voice. A new reply supersedes one still being spoken. */
    speakReply(content) {
      if (!this.settings.speakReplies) return false;
      if (this.readAloud.active) return false;
      const text = this._plain(content);
      if (!text || /^_\(/.test(text) || /^⚠/.test(text)) return false;
      // supersede any previous reply still being spoken
      if (this.talk.active) this.stopSpeaking();
      this.talk = { active: true, paused: false };
      this._showTalkBar(true);
      this._updateTalkBar();
      const done = () => {
        if (!this.talk.active) return; // a stopTalk already cleaned up
        this.talk.active = false;
        this.talk.paused = false;
        this._showTalkBar(false);
      };
      try { this.speak(text, { onEnd: done, onError: done }); }
      catch (e) { done(); } // the custom path can throw synchronously
      return true;
    },

    /* ── STT: voice input ────────────────────────────────────── */
    speechRecAvailable() {
      return !!(global.SpeechRecognition || global.webkitSpeechRecognition);
    },

    /** True when a working path exists: built-in recognition OR a configured
        external endpoint. */
    sttConfigured() {
      return this.speechRecAvailable() || !!(this.settings.sttEngine === "custom" && this.settings.sttUrl);
    },

    /** Start listening. `onFinal(text)` fires once with the transcript.
        Returns true when a session started. */
    startListening(onFinal) {
      if (this._listening) return true;
      this._onFinal = onFinal || null;
      if (this.settings.sttEngine === "custom" && this.settings.sttUrl) {
        this._startCustomStt();
        return true;
      }
      const SR = global.SpeechRecognition || global.webkitSpeechRecognition;
      if (!SR) {
        this._app().toast("Voice input needs an external endpoint — set it in ⚙ → Voice", "error");
        return false;
      }
      const rec = new SR();
      rec.lang = "en-US";
      rec.interimResults = false;
      rec.maxAlternatives = 1;
      rec.onresult = (e) => {
        const res = e.results[e.results.length - 1];
        const text = res && res[0] ? res[0].transcript.trim() : "";
        if (text && this._onFinal) this._onFinal(text);
      };
      rec.onend = () => this._setListening(false);
      rec.onerror = (e) => {
        this._setListening(false);
        this._app().toast("Voice input error: " + (e.error || "unknown"), "error");
      };
      this._rec = rec;
      this._setListening(true);
      try { rec.start(); } catch (e) { this._setListening(false); return false; }
      return true;
    },

    stopListening() {
      if (this._rec) { try { this._rec.stop(); } catch (e) { /* ignore */ } this._rec = null; }
      if (this._recorder && this._recorder.state !== "inactive") { this._recorder.stop(); }
      if (this._micStream) { this._micStream.getTracks().forEach((t) => t.stop()); this._micStream = null; }
      this._setListening(false);
    },

    _setListening(on) {
      this._listening = on;
      const btn = $("ai-mic");
      if (btn) btn.classList.toggle("listening", on);
      if (on) this._app().toast("Listening… speak now (click the mic again to stop)", "ok");
    },

    async _startCustomStt() {
      this._setListening(true);
      try {
        // a chosen microphone (⚙ → Voice) is requested by its exact id;
        // empty = the browser's default input device
        const micId = this.settings.sttMicId;
        const audio = micId ? { deviceId: { exact: micId } } : true;
        const stream = await navigator.mediaDevices.getUserMedia({ audio });
        this._micStream = stream;
        const mr = new MediaRecorder(stream);
        this._recorder = mr;
        this._recChunks = [];
        mr.ondataavailable = (e) => { if (e.data && e.data.size) this._recChunks.push(e.data); };
        mr.onstop = async () => {
          const blob = new Blob(this._recChunks, { type: mr.mimeType || "audio/webm" });
          this._recChunks = [];
          stream.getTracks().forEach((t) => t.stop());
          this._micStream = null;
          this._setListening(false);
          try { await this._transcribe(blob); } catch (e) {
            this._app().toast("Transcription failed: " + String(e.message || e), "error");
          }
        };
        mr.start();
      } catch (e) {
        this._setListening(false);
        this._app().toast("Microphone unavailable: " + String(e.message || e), "error");
      }
    },

    async _transcribe(blob) {
      const url = (this.settings.sttUrl || "").replace(/\/+$/, "");
      const fd = new FormData();
      fd.append("file", blob, "recording.webm");
      fd.append("model", this.settings.sttModel || "whisper-1");
      fd.append("language", "en");
      const res = await fetch(url + "/audio/transcriptions", {
        method: "POST",
        headers: this.settings.sttApiKey ? { Authorization: "Bearer " + this.settings.sttApiKey } : {},
        body: fd,
      });
      if (!res.ok) {
        let detail = "";
        try { const j = await res.json(); detail = j.error?.message || j.message || ""; } catch (e) { /* no body */ }
        throw new Error(`STT endpoint error ${res.status}${detail ? ": " + detail : ""}`);
      }
      const j = await res.json();
      const text = (j.text || "").trim();
      if (text && this._onFinal) this._onFinal(text);
      else this._app().toast("Nothing recognized — try again", "error");
    },

    /* ── read-aloud controller ───────────────────────────────── */
    async startReadAloud(fromPage) {
      const app = this._app();
      if (!app.currentDoc || this.readAloud.active) return false;
      // read-aloud and talk-mode share the speech engine — starting one
      // must silence the other (speakReply already refuses during
      // read-aloud; this covers the reverse direction)
      if (this.talk.active) this.stopTalk();
      const cache = await global.Volt.AI.ensurePageTexts();
      if (!cache || !cache.pages.length) { app.toast("Nothing to read in this document", "error"); return false; }
      const start = fromPage || Math.max(1, app._currentPageNum ? app._currentPageNum() : 1);
      this.readAloud = { active: true, paused: false, page: Math.min(start, cache.pages.length), chunks: [], idx: 0, speaking: false, cache };
      this._loadPageChunks();
      this._showReadBar(true);
      this._updateReadBar();
      this._nextChunk();
      return true;
    },

    toggleReadAloud() {
      if (this.readAloud.active) {
        if (this.readAloud.paused) this.resumeReadAloud();
        else this.pauseReadAloud();
      } else {
        this.startReadAloud();
      }
    },

    pauseReadAloud() {
      if (!this.readAloud.active) return;
      this.readAloud.paused = true;
      this.pauseSpeaking();
      this._updateReadBar();
    },

    resumeReadAloud() {
      const r = this.readAloud;
      if (!r.active || !r.paused) return;
      r.paused = false;
      this.resumeSpeaking();
      this._updateReadBar();
    },

    stopReadAloud() {
      const was = this.readAloud.active;
      this.readAloud.active = false;
      this.readAloud.paused = false;
      this.stopSpeaking();
      this._showReadBar(false);
      if (was) this._app().toast("Read-aloud stopped", "ok");
    },

    _loadPageChunks() {
      const r = this.readAloud;
      const page = r.cache.pages.find((p) => p.page === r.page);
      r.chunks = page ? this._chunk(page.text) : [];
      r.idx = 0;
    },

    /** Split a page into sentence-ish chunks (≤ ~240 chars) so long lines
        don't stall the speech queue and the bar updates as it flows. */
    _chunk(text) {
      const t = String(text || "").replace(/\s+/g, " ").trim();
      if (!t) return [];
      const raw = t.split(/(?<=[.!?])\s+/);
      const out = [];
      let cur = "";
      for (const piece of raw) {
        if (cur && (cur + " " + piece).length > 240) { out.push(cur); cur = piece; }
        else cur = cur ? cur + " " + piece : piece;
      }
      if (cur) out.push(cur);
      return out;
    },

    async _nextChunk() {
      const r = this.readAloud;
      if (!r.active || r.paused) return;
      if (r.idx >= r.chunks.length) {
        // end of this page — move to the next one
        if (r.page < r.cache.pages.length) {
          r.page++;
          this._loadPageChunks();
          const app = this._app();
          if (app.goToPage) app.goToPage(r.page, false);
        } else {
          this.stopReadAloud();
          this._app().toast("Finished reading the document", "ok");
          return;
        }
      }
      const text = r.chunks[r.idx++];
      if (!text) { this._nextChunk(); return; }
      this._updateReadBar();
      r.speaking = true;
      const done = () => {
        r.speaking = false;
        if (r.active && !r.paused) this._nextChunk();
      };
      const err = (e) => {
        r.speaking = false;
        this.stopReadAloud();
        this._app().toast("Read-aloud failed: " + String((e && e.message) || e), "error");
      };
      try {
        const ok = this.speak(text, { onEnd: done, onError: () => done() });
        if (ok === false) { this.stopReadAloud(); this._app().toast("No speech engine available — check ⚙ → Voice", "error"); }
        else if (ok && ok.then) await ok.catch(err);
      } catch (e) { err(e); }
    },

    _showReadBar(on) {
      const bar = $("read-bar");
      if (bar) bar.hidden = !on;
    },

    _updateReadBar() {
      const r = this.readAloud;
      const play = $("read-play"), info = $("read-info"), pageEl = $("read-page"), rate = $("read-rate");
      if (play) {
        play.textContent = r.paused ? "▶" : "⏸";
        play.title = r.paused ? "Resume (Space)" : "Pause (Space)";
        play.setAttribute("aria-label", r.paused ? "Resume reading" : "Pause reading");
      }
      if (info) info.textContent = r.active
        ? (r.paused ? "Paused" : r.speaking ? "Reading…" : "Ready")
        : "";
      if (pageEl && r.cache) pageEl.textContent = `p.${r.page}/${r.cache.pages.length}`;
      if (rate) rate.textContent = "×" + (Number(this.settings.ttsRate) || 1).toFixed(1);
    },

    /* ── UI wiring ───────────────────────────────────────────── */
    _bindControls() {
      const read = $("btn-readaloud");
      if (read) read.addEventListener("click", () => this.startReadAloud());

      const play = $("read-play");
      if (play) play.addEventListener("click", () => this.toggleReadAloud());
      const stop = $("read-stop");
      if (stop) stop.addEventListener("click", () => this.stopReadAloud());
      const rp = $("read-rate-up");
      if (rp) rp.addEventListener("click", () => {
        this.settings.ttsRate = Math.min(2, (Number(this.settings.ttsRate) || 1) + 0.1);
        this._saveSettings();
        this._updateReadBar();
      });
      const rm = $("read-rate-down");
      if (rm) rm.addEventListener("click", () => {
        this.settings.ttsRate = Math.max(0.5, (Number(this.settings.ttsRate) || 1) - 0.1);
        this._saveSettings();
        this._updateReadBar();
      });

      // talk-mode toggle: read AI replies aloud (speaker button in the input row)
      const talk = $("ai-talk");
      if (talk) talk.addEventListener("click", () => this.toggleTalk());
      const talkPlay = $("talk-play");
      if (talkPlay) talkPlay.addEventListener("click", () => {
        if (this.talk.paused) this.resumeTalk(); else this.pauseTalk();
      });
      const talkStop = $("talk-stop");
      if (talkStop) talkStop.addEventListener("click", () => this.stopTalk());

      // mic button in the AI chat input row: click once to talk, again to stop
      const mic = $("ai-mic");
      if (mic) mic.addEventListener("click", () => {
        if (this._listening) { this.stopListening(); return; }
        if (!this.sttConfigured()) {
          this._app().toast("No voice input available — enable one in ⚙ → Voice (external endpoint if the browser has none)", "error");
          return;
        }
        const ok = this.startListening((text) => {
          const ai = global.Volt.AI;
          if (ai && ai.send) {
            const input = $("ai-input");
            if (input) input.value = text;
            ai.send(text);
          }
        });
        if (!ok) this.stopListening();
      });

      // keyboard: Space toggles pause while the read bar is open
      document.addEventListener("keydown", (e) => {
        if (e.code !== "Space" || e.repeat) return;
        const target = e.target;
        if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable)) return;
        if (this.readAloud.active) { e.preventDefault(); this.toggleReadAloud(); }
      });
    },
  };
})(typeof window !== "undefined" ? window : globalThis);
