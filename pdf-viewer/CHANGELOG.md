# Volt changelog

Each release is a `## x.y.z` section. The version banner tooltip shows the
sections newer than the installed bundle, so a pending update tells you what
changed before you restart.

## 1.0.2

- **Secure PDF exports open again**: a locked file no longer rejects its
  own password. The password pad was corrupting the U/O values Volt wrote
  (the pad overwrote the password bytes, appended the wrong end of the pad
  string, and used UTF-8 where pdf.js reads low bytes; the owner-key hash
  was also untruncated) — every one of those is fixed, and the annotated
  export is now saved in classic form (no object streams) so the lock
  byte-walker can rebuild the file it encrypts. Verified end-to-end by a
  new gate (`npm run test:lock`) that locks real output and opens it in the
  vendored pdf.js with the user **and** owner passwords — ASCII, accented
  and CJK passwords, multi-page documents, wrong/empty rejection, and a
  loud failure if an unsupported object-stream PDF ever reaches the lock
  again.
- Bookmarks travel with your work: the **JSON backup** now carries them
  (backup version 6), so a restore lands your jump marks in the document
  they belong to (or the one you import into — pages are clamped to the
  target's page count), and the **Markdown notes export** includes a
  **Bookmarks** section with each page and label. The post-restore summary
  card reports how many bookmarks landed; a backup without a bookmarks
  layer (older files) leaves your bookmarks untouched.
- Bookmarks live in the Outline too: a **Bookmarked pages** section is
  pinned to the top of the sidebar's **Outline** tree (sorted by page,
  always above the document's own outline). It updates live as bookmarks
  come and go, and one click jumps to the page — bookmarks are reachable
  from the same navigation surface as the document's headings.
- Bookmarks without the panel: **Markup ▸ Bookmark this page** drops a jump
  mark on the page you're reading, and **right-clicking a sidebar page
  thumbnail** bookmarks that page (or removes its bookmarks) from a small
  context menu — both update the badge and the list instantly.
- Page modes: **View ▾** picks how you read — **Continuous scroll** (pages
  flow in one column, scroll freely), **One page** (scrolling rests on page
  boundaries — one page per scroll), or **Two pages** (a book spread: pages
  sit side by side in pairs, 1–2, 3–4, …, with fit-width/fit-page zoom
  recalculated for the pair). The choice is remembered per user and comes
  back on the next open — and **Ctrl+1 / Ctrl+2 / Ctrl+3** switch One page /
  Two pages / Continuous from the keyboard (also shown in the View menu
  tooltips and the in-app Shortcuts reference). In Two pages, each spread
  carries a **pair label** ("1–2", "3–4", …) centered under the whole row
  instead of a number under each page (a lone trailing page labels itself),
  and the sidebar's Pages tab **highlights both pages of the visible spread**
  together instead of a single page.
- Flip like a book: in **Two pages**, ← / →, PageUp/PageDown and clicks in
  the left/right margin turn the spread with a page-turn animation — the
  pair rotates away on the spine axis and the next one lands in.
- Opening Volt no longer greets you with a popup to dismiss. On a fresh
  profile a small pill appears in the blank toolbar area — **← Click here
  to get started or for help** — fades in, holds, then slides away behind
  the **Volt ▾** menu on its own (nothing to dismiss, reading is never
  blocked). With **prefers-reduced-motion** enabled the hint fades in and
  out instead of sliding. Clicking it opens **Help & guides**; engaging
  with it stops it from replaying, and the Setup wizard stays under
  **Volt ▾ → Setup wizard…**.
- Feedback: **Volt ▾ → Send feedback…** drafts a GitHub issue on the public
  repository with your message plus an attached environment block (version,
  engine, OS, open document), opening in the default browser for review
  before submitting — the app never transmits anything itself.
- E-sign: **Export ▸ Digitally sign PDF…** attaches a real certificate
  signature to the annotated export — an AcroForm `/Sig` field with a
  `/ByteRange` and a detached PKCS#7 (CMS) SignedData that Acrobat and
  pdf.js validate. The certificate comes from a local PKCS#12
  (`.pfx`/`.p12`) file picked via the native dialog (or a file input in
  the PWA); the whole chain runs in-process on Web Crypto — PKCS#12
  parsing with the MAC verified (PBES1-3DES + PBES2-AES, with a pure-JS
  TripleDES implementation checked against Node's crypto), CMS build,
  and the byte surgery that patches the ByteRange + xref in place. The
  smoke's `signProbe` signs with the dev certificate and re-verifies the
  signature cryptographically in the renderer.
- ISO PDF standards: **Export ▸ PDF/A-1b (ISO 19005-1)** produces an
  archival-standard PDF — XMP metadata with the pdfaid part/conformance
  pair, a /Metadata stream (uncompressed, as the standard demands), an
  OutputIntent with an embedded sRGB ICC v2 profile, document info, a
  trailer file identifier, embedded fonts and a classic xref. Built on
  pure, unit-tested helpers (`buildSrgbIcc`, `pdfA1bXmp`,
  `injectPdfTrailerId`), verified by the smoke's `isoProbe` (the required
  elements are asserted in the exported bytes and the file re-opens
  through pdf.js with its text intact). Semi-transparent annotation
  overlays are the one thing a strict validator may flag — see the README
- Bookmarks: mark any page to jump back to, with a per-document list in the
  sidebar — add from the toolbar or `Ctrl+Shift+B`, rename labels inline,
  remove one or clear all, and find them live by label or page number; a
  small ribbon marks bookmarked pages, and bookmarks renumber when pages
  are deleted or reordered

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
