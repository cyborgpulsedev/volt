# Volt changelog

Each release is a `## x.y.z` section. The version banner tooltip shows the
sections newer than the installed bundle, so a pending update tells you what
changed before you restart.

## 1.0.1

- Security & stability: upgraded the Electron runtime (33 → 43, a 10-major
  jump covering 16 high-severity advisories) and the build toolchain
  (electron-builder 26) — `npm audit` is now clean at 0 vulnerabilities
- Release hardening: releases are only cut from the current tip of `main`
  with fresh generated assets, so updates always ship the latest fixes
- Smoother window-resize handling in the packaged smoke tests

## 1.0.0

- OCR-first text layer: scans whose invisible embedded text sits offset from
  the visible page can switch to Volt's own OCR text (highlights, selection,
  search and the AI then follow the visible text)
- Version-ready banner with a 15s auto-restart countdown, Cancel, and a
  "never auto-restart" setting — plus automatic relaunch when the desktop
  shortcut is clicked while a stale instance is running
- What's-new tooltips: the banner now shows this changelog for the pending
  version
- Per-document AI overrides (model, context, system prompt) with one-click
  persona presets (Legal, Beginner, Concise) and custom personas
- Global model + temperature controls right in the AI panel header
- Restore backup with content fingerprints (renamed copies still match),
  restore-by-URL, and a post-restore summary card
- Pages manager: add/delete/reorder/insert, drag-and-drop reordering with
  undo/redo, keyboard range selection, and a move-to-position form
- Area highlights: rotate, duplicate (Ctrl+D), nudge with arrow keys, and a
  live size readout while dragging
- Built-in local LLM bootstrap (one-click Ollama install + qwen3 pull) and a
  private app-owned Ollama instance with origins locked to Volt
- Read-aloud with local voices, external TTS/STT endpoints, and voice chat
  with the AI
- Rectangle tool with click-to-place and configurable default size

## 0.9.0

- Toolbar dropdown menus (File / View / Tools) with full keyboard support
- OCR with on-demand language downloads and a searchable language picker
- Ctrl+A / Ctrl+A+A whole-document selection, "Highlight all", per-page
  highlight breakdowns and copy-with-citations
- Focus trap for every modal, with real-keyboard Tab/Shift+Tab smoke coverage
- Stale-bundle detection: served sw.js cache name vs installed caches

## 0.8.0

- First release: fast local PDF reader with highlights, underlines, notes and
  area highlights; AI chat grounded in the document with page citations;
  PWA install; desktop Electron packaging with file association
