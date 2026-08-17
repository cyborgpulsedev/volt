## Volt 1.0.0 — first stable release

Volt is a fast, private, ad-free PDF reader with AI built in — everything renders locally, and you bring your own LLM. No account, no telemetry, no upsells.

**Highlights**
- OCR-first text layer for scans with offset embedded text — highlights, selection, search and the AI follow what you actually see
- Read-aloud with local voices, external TTS/STT endpoints, and voice chat with the AI
- Area highlights (rotate, duplicate, nudge) and a rectangle tool
- Pages manager: add / delete / reorder / insert with drag-and-drop undo/redo
- Backup restore by content fingerprint, URL, or file, with a post-restore summary card
- Per-document AI overrides with persona presets, plus global model + temperature controls
- One-click local LLM bootstrap (Ollama install + qwen3 pull) with a private app-owned instance
- Version-ready banner with auto-restart countdown and a what's-new changelog

**Install**
- **New installs:** download `Volt-Setup-1.0.0.exe` and run it — per-user install, no admin needed, desktop + Start-menu shortcut, and `.pdf` files open in Volt automatically.
- **Existing installs:** updates apply automatically through the built-in updater.

**Requirements**
- Windows 10 or later, 64-bit
- ~98 MB installer; the app runs fully offline, nothing leaves your machine
- Local AI models (optional): qwen3 1.7b runs on 4–8 GB RAM, 4b needs ~8 GB, 8b ~16 GB
