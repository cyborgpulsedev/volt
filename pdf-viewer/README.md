# Volt — local PDF reader & AI editor

A fast, private, **ad-free, upsell-free** PDF reader with AI built in. Renders
100% locally in your browser (pdf.js is vendored — works fully offline, even
from `file://`). Chat with your document using **your own LLM**: Ollama or LM
Studio running on this machine (free, nothing leaves your computer), or any
OpenAI-compatible hosted API (OpenAI, Groq, OpenRouter, …).

## Quick start

### Option A — Desktop app (recommended)

**Double-click the “Volt PDF Reader” desktop shortcut** (created by
`scripts/create-volt-shortcut.ps1` — see “File association” below). The
shortcut runs `wscript.exe` on `scripts/start-volt-app-hidden.vbs`, which
starts the app with its console window **hidden** — so launching Volt behaves
like a normal program: only the app window and its taskbar icon appear, never
a command-prompt box. (Double-clicking `start-volt-app.cmd` directly still
shows the console — that entry point is for development and diagnostics.) The
first run downloads the Electron runtime (~110 MB, one time only); after that
it launches instantly.

- Self-test: `npm run smoke` (from `pdf-viewer/`) loads the app, opens the
  sample document, and reports what rendered. `npm run smoke:browser` runs the
  same self-test **without the desktop bridge** — the pure browser/PWA context
  — so the focus trap is verified there too, not just inside the Electron app.
- **Remembers its window** — resize, move, or maximize the window and the next
  launch reopens at the same size/position (`window-state.json` in the app's
  userData; the saved position is validated against the current monitor layout,
  so a window saved on a now-unplugged display falls back to the default
  instead of opening off-screen).
- **Failures are never silent** — if the launcher can't start the app (Node
  missing, the Electron runtime failed to install/download, or the app exited
  unexpectedly), it pops a native Windows error dialog with the reason
  (`scripts/show-error.ps1`) instead of a console window that closes without
  explanation.
- **No native menu bar** — the desktop app removes Electron's hidden menu bar
  on Windows/Linux (`Menu.setApplicationMenu(null)`), so **Alt+F / Alt+V /
  Alt+T** are the app's own File/View/Tools menus instead of revealing a
  native bar. The dev conveniences the default menu provided are kept as
  per-window shortcuts: `Ctrl+Shift+I` DevTools, `Ctrl+R` reload.

**Opening PDFs is effortless:** drag any `.pdf` from Explorer onto the window,
and double-clicking any `.pdf` on disk opens it in Volt (the launcher registers
`.pdf` → Volt automatically — see [File association](#file-association)).

### Option B — PWA (installable from the browser)

Run `node serve.mjs` (or `start-volt.cmd`), open `http://localhost:8421`, then
use the browser's **Install** button (Edge: ⋯ → Apps → *Install Volt*; Chrome:
the install icon in the address bar). Volt installs as its own app — separate
window, desktop/Start-menu icon, works fully **offline** after the first visit
(via its service worker).

### Option C — just a page

Double-click `index.html` (works fully offline), or `node serve.mjs` then open
`http://localhost:8421`.

To (re)create the desktop shortcut — or set up a fresh machine — run
`powershell -NoProfile -ExecutionPolicy Bypass -File scripts/create-volt-shortcut.ps1`.
That one script creates the shortcut **and** registers `.pdf` → Volt (the file
association), so a fresh machine gets both in a single step. If the Electron
runtime isn't installed yet, the shortcut is still created and the association
is finished automatically by the first app launch. Add `-SkipAssociation` for
the shortcut only (the `start-volt.cmd` web-server launcher is still there for
the browser version).

### Try it instantly
The home screen is built to get you straight to your document: one big
**Open a PDF** button (the desktop app uses the **native file dialog**, so
whatever you pick also lands in **Recent documents** for next time), a
**Recent documents** row of your last-opened files — one click reopens a
path (desktop) or refetches a URL — and a quiet drag-and-drop hint. The
extras sit underneath as small links: **Restore a backup…**, **Restore
backup from URL…**, and **Try the sample document** — a short essay
("The Quiet Engine") that ships inside the app, so you can test reading,
annotating, and AI chat with zero setup. Recents are per-user
(`volt:recent-docs`, capped at 8, deduped, most-recent-first) and only
record documents with a reopenable source.

### First-run hint
Opening Volt never greets you with a popup to dismiss — you can start
reading immediately. On a fresh profile (nothing saved under
`volt:setup-done`) a small pill quietly appears in the blank toolbar area:
**← Click here to get started or for help**. It fades in, holds, then
slides away behind the **Volt ▾** menu on its own — no buttons, nothing to
dismiss — and clicking it opens **Help & guides**. With
**prefers-reduced-motion** enabled it fades in and out instead of sliding.
Engaging with it (or finishing the wizard) marks setup as answered so the
hint doesn't replay.

The **Setup wizard** (four steps: *Welcome → Desktop & appearance → AI →
You're set*) stays reachable anytime from **Volt ▾ → Setup wizard…**. The
desktop step offers the **desktop shortcut + .pdf association** (one
checkbox; in the desktop app it runs the same PowerShell script the
launcher uses, and a packaged installer reports it as already handled) and
the **skin** (dark/light, applied immediately). The AI step detects Ollama
and shows which model Volt will use. **Finish** applies everything and
shows a summary (desktop / skin / AI lines). In the browser/PWA the
desktop checkbox is replaced by a note explaining that shortcuts and file
association belong to the desktop app.

## Connecting a local LLM (Ollama)

**No setup needed if you want it:** Volt's default model is **detected, not
assumed**. On first run (no saved settings) the app probes Ollama's
`/api/tags`, ranks what's actually installed by a preference list (qwen3
tiers first, then other small capable instruct models, then anything),
verifies the top candidate answers a tiny chat ping, and **adopts the best
working model as your default automatically** — so a fresh machine with,
say, only `llama3.2:3b` installed starts ready, never pointing at a model
that isn't there. If nothing is installed, the AI panel (**Ctrl+J**) shows
a one-click **local AI setup** card instead: it detects Ollama on this
machine, and one click **installs Ollama** (desktop app — the official
per-user installer is downloaded and run silently, no admin rights) and
**pulls `qwen3:4b`** with a live progress bar — a small model that handles
document summaries and tool use on most machines — then sets it as the
default. When models ARE installed but qwen3:4b isn't, the card offers the
**best available** one with a single "Use …" click instead of demanding a
download. Everything runs locally and offline; nothing leaves your
computer. In the browser/PWA version the same card opens the Ollama
download page instead (a browser can't install apps) and re-detects when
you come back. **Not now** dismisses it permanently (⚙ Settings still
offers every other provider); a configured model — local or hosted — never
shows the card.

For a fine-grained pick, the ⚙ **AI settings** modal adds a **Model quality**
row (Ollama provider only) — three qwen3 tiers with a RAM/quality
explanation: **1.7b** (~1.2 GB, 4–8 GB RAM, fastest), **4b** (~2.5 GB,
8 GB RAM, the sweet spot — Volt's default recommendation), and **8b**
(~5 GB, 16 GB RAM, best summaries). Each chip shows whether it's already
installed on this machine, and the row's button **installs the chosen tier
in one click** (same live progress bar as the bootstrap) or — when it's
already local — just makes it the default model. Other providers keep
using the generic model field.

**Drive-by protection:** Ollama answers browser requests with an
`Access-Control-Allow-Origin` header, and the dangerous configuration is
`OLLAMA_ORIGINS=*` — then *any* website open in a browser can send prompts
to your local model. The desktop app probes the running Ollama's CORS
posture from the **main process** (a page can't read the header — the
browser CORS model hides `Access-Control-Allow-Origin` from page JS), and
it sends the probe with a spoofed foreign `Origin`, so Ollama's own
rejection (403 = safe, it actively blocks) or wildcard (`*`) is directly
observable. A wildcard shows a warning (AI panel + ⚙ settings row) with a
**Restrict origins** button that pins the per-user `OLLAMA_ORIGINS` to
Volt's own origin — `localhost:8421` (Ollama always appends its loopback
defaults, so the desktop app's dynamic `127.0.0.1:<port>` origin stays
covered; `file://` is deliberately NOT in the pin because Ollama's env
parser panics on it — a pin containing `file://` crashes the server at
startup) — no admin needed. The running Ollama picks the value up on its
next restart, so the warning flips to "restart Ollama to apply" (the next
panel open re-checks). The same pin is written **before** a fresh
install's service starts, so a Volt-installed Ollama never serves `*`. In
the browser/PWA version, where a page can't write the OS environment AND
can't see the CORS header, the probe stays silent and the button shows
the `setx OLLAMA_ORIGINS="…"` command instead. The safe default (specific
or loopback origin, never `*`) stays silent.

**Private instance (desktop):** beyond pinning, Volt can spawn **its own
`ollama serve`** — a dedicated process on a non-default loopback port with
`OLLAMA_ORIGINS` locked to Volt's origin and a dedicated model store
under the app's data folder, so *nothing else on the machine* — other
apps, websites — can reach the model at all. The ⚙ AI settings show a
**Private instance** row (Ollama provider only): one click spawns it
(main process picks a free port, waits for it to answer, and the baseUrl
adopts the port; the same port is reused across restarts while it stays
free), and the private mode skips the CORS warning entirely (by
construction it can never serve `*`). First use of a tier pulls the model
into Volt's own store. The instance is killed when the app quits.

The manual path, if you prefer it:

1. Install [Ollama](https://ollama.com) and pull a model, e.g. `ollama pull llama3.2:3b`.
2. Start it: `ollama serve` (usually already running).
3. In Volt, click the **⚙** icon → provider **Ollama (local)** → model `llama3.2:3b` → **Save**.
   (Click **Test connection** to fetch the exact list of models installed on your machine.)
4. Open the AI panel (**Ctrl+J**) and ask anything. Answers are grounded in the
   document text with page citations like `[p.3]`.

> Verified on this machine: Ollama 0.31.1 at `http://localhost:11434` with models
> `llama3.2:3b`, `qwen3:8b`, `deepseek-r1:8b`, `granite3.3:8b`, `gemma4:26b` and
> more already installed — a PDF question is answered in ~5s with page citations.

Ollama exposes an OpenAI-compatible API at `http://localhost:11434/v1` — that's
all Volt needs. Same story for LM Studio (`http://localhost:1234/v1`), or any
custom endpoint that speaks OpenAI `chat/completions`.

### Using a hosted API (OpenAI / Groq / OpenRouter)
Pick the preset, paste your API key (stored only in your browser's
`localStorage`), choose a model, **Test connection**, and **Save**.

> Privacy note: for hosted models, whatever you ask and the matching document
> excerpts are sent to that API provider. Local models keep everything on your
> machine.

## Features

- **Reading** — continuous scroll, fit-width / fit-page / 15–500% zoom, rotate,
  page thumbnails, outline tree, clickable search with next/prev, full keyboard
  shortcuts (`?` to view them). **Ctrl+A selects all searchable text on the
  current page** like standard PDF readers (Chrome's viewer and Acrobat
  select the page, not the document): one native selection Range over every
  text  node of the page's layer — pdf.js spans and OCR word spans alike — so
  it renders as a real selection highlight, copies cleanly with Ctrl+C, and
  feeds the AI panel's "ask about selected text" flow. In a text field it
  keeps its native select-all-text meaning; on a page with no selectable
  text (a scan with the OCR layer off) it clears any stale selection and
  toasts the OCR hint instead of selecting invisible text. Press **Ctrl+A
  twice** (A again within a second, Ctrl held) and the selection extends
  across **all pages** — pages outside the virtualized viewport are
  rendered on the spot (progress toast on long documents, **Escape**
  aborts mid-render), the toast reports how many pages were selected, the
  sidebar's Pages-panel thumbnails are re-painted so they show every page
  the toast counts, and the full render stays PINNED: those freshly
  rendered pages survive the next scroll instead of being disposed by the
  virtualization window (until the document changes or rotates — a zoom
  change re-renders everything anyway). **Ctrl+Shift+Space** remains the
  whole-document gesture from the current page. Both selection toasts
  (the single Ctrl+A and the Ctrl+A+A count) are PERSISTENT review
  notices: they stay up until dismissed — a click on the toast, on any of
  its action buttons, or anywhere outside it — so the page count stays
  visible while you review a long selection, and the next selection's
  toast replaces the previous one instead of stacking. The toasts carry
  two actions: **Highlight all** (one highlight annotation per page, with
  a per-page line-count breakdown in the confirmation toast — e.g.
  "Highlighted text on 3 pages: p.1: 23 lines · p.2: 18 · p.3: 12 —
  Ctrl+Z to undo") and **Copy w/ citations**, which copies each page's
  full text under a "— p. N" header (e.g. `— p. 1` … `— p. 3`, blank-line
  separated, using the same whitespace-normalized text the AI chat reads)
  — the toast then confirms "Copied N pages with citations — Ctrl+V to
  paste". The confirmation toast also carries a **Clear highlights**
  quick action: one click removes every text highlight (and the highlight
  tool's blank-space area fallback) in the document in a single grouped,
  undoable step — so a stray whole-document highlight is reverted with
  one click and one Ctrl+Z instead of a long undo walk (Rectangle-tool
  shapes are a separate tool and are left alone). Because the clear is
  destructive, the toast button carries a 3-second **"Really …?"** confirm
  step (the pages-manager Delete guard, at toast level): the first click
  flips the button to "Really clear all?" / "Really clear page N?" for 3
  seconds and only a SECOND click on the same button runs it — one
  accidental click never clears marks, the toast stays up while armed,
  and letting the window expire restores the label with nothing touched.
  The AI panel's foot line carries the same **Clear highlights** danger
  button — reverting every highlight from chat with the identical
  two-click confirm and grouped undo (one shared `clearHighlights()`).
  Its non-destructive companion **Copy highlights** closes the study
  loop from chat: one click exports every text highlight (the same
  scope the clear removes — the blank-space area fallback and
  Rectangle shapes carry no text and are skipped) as Markdown notes to
  the clipboard, grouped by page under "## Page N" headers with
  passages in reading order (top-to-bottom), titled with the file name
  — the toast confirms "Copied N highlights from M pages — Ctrl+V to
  paste", and an empty document toasts "No text highlights to copy".
  The clear is **page-scoped**: a single-page conversion's button reads "Clear page N"
  (removing only that page's marks — reverting a stray whole-PAGE
  highlight never touches the other pages), and the Pages manager's
  **Clear hl** button clears just the highlights on the SELECTED pages
  (the "Select annotated → Clear hl" cleanup flow), while the underlying
  `clearHighlights()` accepts a page number, an inclusive `{from, to}`,
  or a Set/array of pages. Every scoped clear is one grouped undo. While
  any text selection is active the status bar shows its page range (e.g.
  **· Sel p.1–3**) next to the zoom, updating LIVE as the range changes
  (a Ctrl+Shift+End from page 2 narrows it to p.2–3, a partial drag on
  one page reads p.1, clearing the selection hides it). After a Ctrl+A
  selection a toast offers **Highlight all**: one click converts the whole
  selection into a single highlight annotation spanning the page — built
  with the exact line-snapped drag geometry (so it exports identically to a
  hand-drawn highlight), the selection is cleared, and one Ctrl+Z undoes it.
  The same selection extends to a **document boundary**: **Ctrl+Shift+Space** (and
  its editor-standard twins **Ctrl+Shift+End** / **Ctrl+Shift+Home**)
  selects all searchable text from the current page to the last / first
  page — the whole-document analog of Ctrl+A, mirroring Ctrl+Shift+Home/End
  in a text editor. Pages outside the virtualized render window are
  rendered first (with a progress toast for long documents, since the
  selection needs real text nodes), then ONE range spans every page in the
  direction; the viewport stays put and the selection extends off-screen.
  Boundary selections get the SAME persistent review toast as Ctrl+A+A
  ("Selected text across N pages — M chars" with the **Highlight all** and
  **Copy w/ citations** actions), so the multi-page highlight conversion
  and its single-undo revert work from the keyboard selection too.
- **Bookmarks** — mark pages to jump back to. The toolbar's bookmark button
  (or `Ctrl+Shift+B`) opens the sidebar's **Bookmarks** tab: **＋ Bookmark
  this page** drops a jump mark on the page you're reading (a small ribbon
  appears in that page's top-right corner), and every bookmark shows as a
  card with its page number and an optional label you can **rename**
  inline or **remove** with one click. You never need the panel to add one:
  **Markup ▸ Bookmark this page** bookmarks the page in view, and
  **right-clicking a page thumbnail** pops a menu to bookmark that page (or
  remove its bookmarks). The **Find bookmarks** box filters the list live by
  label or page number, clicking a card jumps straight to the page, and
  **Clear all** wipes the document's set after a confirm. Your bookmarks are
  also pinned as a **Bookmarked pages** section at the top of the sidebar's
  **Outline** tree — sorted by page, always above the document's own
  outline, live-updating as you add or remove bookmarks, and one click jumps
  to the page.
  Bookmarks follow their document through renames and re-exports (same
  `volt:bm:` identity scheme as annotations) and survive the **pages
  manager**: delete or reorder pages and bookmarks renumber with them,
  dropping only if their page is deleted.
- **A tidy toolbar** — secondary actions are grouped under three dropdowns:
  **Volt** (the logo button — Open PDF…, Open from URL…, Export / backup…, AI
  settings, App settings, Help &amp; guides…, Check for updates, About Volt…,
  Save PDF, Exit),  **Markup** (the annotate tools — Select, Highlight, Rectangle, Redact,
  Underline, Strikethrough, Note, Text — plus **Signature…**, **Date
  stamp**, and **Form field…**), **View** (Fit width, Fit page, Rotate
  clockwise, **Continuous scroll / One page / Two pages** — page modes,
  remembered per user: free scrolling column, one page per scroll (scrolling
  rests on page boundaries), or a book spread with pages side by side in
  pairs — **Ctrl+1 / Ctrl+2 / Ctrl+3** switch modes from the keyboard — each
  spread carries a **pair label** ("1–2", "3–4", …) centered under the row
  and the sidebar's Pages tab **highlights both pages of the visible spread**
  — and in Two pages, ← / →, PageUp/PageDown or clicks on the left /
  right margin **flip the spread like a book** with a page-turn animation —
  Light skin, Dark skin), and **Tools** (OCR this document, OCR
  language, OCR text layer, Read aloud). **OCR language** opens its own small popover —
  searchable (native name, English name, or code — e.g. “french” finds
  Français), with a per-language availability status (**Built in** for
  English, **Cached** once a language has downloaded, **On demand** for the
  rest — they download the first time you select them and work offline after;
  the popover is fully keyboard-driven: type to filter, ↑/↓ to walk the
  list, Enter to pick, Esc to close). One click opens a menu, another click (or a
  click elsewhere, or Esc) closes it — and the panels follow the app's
  `[hidden]` display contract like every other overlay. The menus are fully
  keyboard-driven too: **Alt+V / Alt+M / Alt+T** open them (focusing the
  first item), **↑/↓/Home/End** cycle the items (wrapping), **←/→** switch
  between the menus, **Enter** activates the highlighted item, and
  **Esc** closes and returns focus to the menu's button. While a menu is open
  it owns the arrow keys, so the viewer doesn't scroll underneath it. The
  menus are screen-reader accessible too: the triggers carry
  `aria-haspopup`/`aria-expanded`/`aria-controls` (kept in sync on every
  open/close path), the panels are `role="menu"` with `role="menuitem"`
  items, every control shows a keyboard focus ring (`:focus-visible`), and
  Esc — or activating an item that doesn't open its own dialog — returns
  focus to the menu's trigger. The essential one-click controls — zoom,
  search, sidebar / AI / settings / help — stay on the bar, which now fits
  every window size with room to spare.
- **Signatures, dates, and fillable forms (Markup ▸ …)** — the six annotate
  tools now live under the **Markup** menu together with three new
  insertable shapes. **Signature…** opens a modal where you draw a signature
  freehand or type a name (rendered in a handwriting face), saved on-device
  for reuse; **Date stamp** drops today's date at a click; **Form field…**
  builds a **real fillable field** — text, date, checkbox, or signature
  field — that you drag to size on the page. All three are stored as
  rect annotations (select to move/resize/rotate, with the usual undo),
  render on the page overlay, and **export into the PDF**: signatures bake
  as embedded PNGs and form fields become genuine **AcroForm widgets**
  (fillable in any PDF reader), with a plain-text fallback if a field name
  collides on re-export.
- **Light / dark skins (View ▸ …)** — the whole chrome re-themes through the
  variable set, and the **dark** skin also inverts the document itself
  (Firefox-style night reading): page canvas and text layer are
  inverted while the annotation overlay keeps true colors, so highlights
  stay recognizable over the dark page. The **light** skin renders
  documents normally. Choice persists per user (`volt:theme`).
- **Volt menu (logo button)** — Open PDF…, Open from URL…, Export /
  backup…, AI settings, App settings, **Help &amp; guides…**, Check for
  updates, **About Volt…** (version + build + changelog), **Save PDF**
  (write the edited file back to disk), and **Exit** (desktop only).
- **Help &amp; guides (Volt ▾ → Help &amp; guides…, or `?`)** — a tabbed help
  center instead of a bare shortcut list: ten sections (**Getting started**,
  Reading, Annotating, Pages, AI chat, OCR, Voice, Files &amp; backup,
  **Shortcuts**, Troubleshooting) with a left nav that switches the active
  guide in place. The toolbar `?` button lands straight on the Shortcuts
  page; the menu opens on Getting started. The shortcuts pane is still the
  full, live keyboard reference built by the app.
- **OCR (scanned documents)** — the toolbar's **OCR** button runs a fully
  **local** Tesseract.js engine (vendored in `vendor/tesseract/` — worker,
  wasm core, English traineddata; no CDN at runtime, works offline) over the
  open document: each page is re-rendered at 144dpi (with rotation pinned to
  0 — the same display space the viewer uses, so a scan saved with /Rotate
  metadata still has its word boxes measured where the text visibly is) and
  recognized, with a
  live "OCR: page N/M…" toast, per-page progress saved incrementally, and a
  cancel that keeps finished pages. The  result is stored per-document
  (`volt:ocr:` key, same identity as annotations — a re-opened scanned file
  loads instantly, no re-run) and wired into the three places text matters:
  the recognized words are injected into the page's **text layer as real,
  selectable spans** (positioned from the OCR bboxes through the page
  viewport, so you can select and copy a scan's text exactly like embedded
  text — the layer re-glues itself on every zoom/rotation), **search** falls
  back to the OCR word boxes for image-only pages (highlights land on the
  recognized words), and the **AI chat** reads the recognized text, so you
  can ask questions about a scan like any other document. A **per-document
  language picker** (Tools ▸ OCR language, saved under `volt:ocr-lang:`
  with the same identity key as the store) opens a searchable popover:
  English is built in, and any of ~20 other languages downloads on demand
  from tesseract.js's tessdata host into the engine's own IndexedDB cache —
  one download, then it works offline forever. The popover shows each
  language's status (Built in / Cached / On demand) so you can see at a
  glance what already works offline. Switching a doc's language invalidates
  its old-language OCR store (a "Run OCR now" toast offers the re-run). An
  **eye button**
  toggles the visible text layer on/off (a global view preference — only the
  on-page spans are affected, never the store, search, or AI), and the
  **Export** menu gains **OCR text (.txt)** and **OCR text (.md)** items
  (shown only when the document has recognized text) that download the
  transcript — one block per page, headed by the doc name and language. The
  button hides when the engine isn't vendored, and on narrow windows it
  sheds with the toolbar's other tier-2 extras. A scan's **invisible
  embedded text layer** can be systematically offset from the visible page
  (a bad OCR embed — highlights/selection then land beside the text). The
  OCR language popover's **"Use OCR text layer over embedded text"**
  checkbox (per-document, saved under `volt:ocr:prefer:`) makes Volt's own
  aligned OCR words drive the page's text layer instead — so highlights,
  drag selection, Ctrl+A → Highlight all, Ctrl+F, and the AI's page reads
  all follow the visible text. Off by default (a digital PDF's embedded
  text is better than OCR); after an OCR run, Volt **detects** when the
  embedded layer disagrees with the recognized words and offers the switch
  on the completion toast ("…its embedded text layer is offset from the
  visible page" → **Use OCR text layer**).
- **Annotating** — highlight, underline, strikethrough (drag over text),
  sticky-note pins (click on the page). Re-click an annotation tool to cycle
  its color. A drag selects **exactly the lines the cursor crossed** — line
  membership is by the drag covering a line's center (adjacent pdf.js span
  boxes overlap by a pixel or two, so box-vs-box tests bled into the
  neighboring line), and the highlight's outer edges clip to the drag's
  start/end in reading order: a mid-line drag highlights just the part you
  dragged, while a paragraph sweep still selects whole lines in between.
  Dragging a **highlight over blank space** creates an area
  highlight (a rectangle over that region), like classic PDF editors. A
  **single click** on blank space in highlight mode places a default-size
  rectangle immediately, and **Shift+drag** snaps any area rectangle (or its
  resize handles, in select mode) to a perfect square. A dedicated
  **Rectangle tool** in the toolbar places its default-size rectangle even on
  a click **over text** (no text-quads fallback), its drags always draw a
  rectangle, and the default size comes from the "Rectangle size" row in ⚙
  Settings — a preset chip row (½×¼, 1×½, 2×1, 3×1½, 4×6 in) for one-click
  sizing plus two exact PDF-point fields (default 160×64, applied
  immediately; the active chip highlights while the size matches a preset,
  and clears when you type a custom size). Everything persists to
  localStorage. Area highlights are
  fully editable after creation: click one in **select mode** to get a sizing
  box — drag it to move, drag its corner/edge handles to resize (clamped to
  the page),  use the ✕ pill to delete, and **rotate it** with the ⤾ knob
  above the box's top edge (or **Ctrl+drag** anywhere on the box) — the
  rotation is stored on the annotation, rendered live, and burned into the
  exported PDF at the exact same angle. **Alt** re-centers the geometry
  everywhere: **Alt+drag** creates the rectangle from its center point (the
  drag start is the center, the shape grows ±delta both ways — **Alt+Shift**
  makes it a centered square), and **Alt+dragging a resize handle** grows it
  symmetrically from its center by mirroring the opposite edge; the drag
  preview and live size badge follow the same center-anchored shape. While **creating** an area highlight
  over blank space or **resizing** one via its handles, a live badge next to
  the drag rectangle shows its size in inches (e.g. `2.2 × 0.9 in`, PDF
  points ÷ 72) — it updates every frame and disappears when the drag ends. Shift while rotating snaps to 15°;
  a rotated highlight still nudges, duplicates, and clamps with its rotated
  footprint. Right-click an area highlight to recolor it or delete it from a
  context menu. **Text highlights work the
  same way without the handles**: click an underline/strike (or a text
  highlight) in select mode to get a dashed box, then drag it up or down —
  on release the quads are rebuilt onto the **nearest text line** (the
  highlight keeps its width, clamped to that line), so moving a highlight to
  the line it belongs on is a single drag, and the right-click menu and ✕
  pill work there too. **Ctrl+D duplicates** the selected highlight with a
  slight downward offset — repeated presses stamp a column of identical
  copies, one keystroke per copy, for covering repeated regions on a form
  (each copy becomes the selection, stays clamped to the page, and every
  press is its own undo step). The right-click menu's **Duplicate** button
  does the same, and Ctrl+D with nothing selected says so. For **pixel-level
  placement**, arrow keys nudge the selected highlight 1pt in PDF space
  (`Shift+arrow` = 10pt) — clamped to the page, and a held-down key bursts
  into a single undo step so you can fine-tune freely and step back once.
  Everything is undoable with `Ctrl+Z`. Annotations autosave per document in
  your browser.
- **Page management** — **Manage pages…** (the Pages tab in the sidebar, or
  `Ctrl+Shift+P`) opens a page editor that stages edits on a thumbnail grid
  without touching the open document. The sidebar's own **page thumbnails**
  render through the same rasterizer and share the same thumbnail cache as
  the manager's grid (a page seen in one is never re-rendered for the other),
  and they carry the same **size badge** (bottom-left) and live **annotation
  count** (top-right, updating in place as you annotate):
  - **Add** — **＋ Blank** appends a blank page sized like the current one.
  - **Delete** — select pages and **🗑 Delete** (the plan drops them; their
    annotations go with them). Every thumbnail shows its **page size** (e.g.
    `8.5 × 11 in`, bottom-left) and, when the page has annotations, a warm
    **count badge** (top-right) — so it's obvious what a deletion would lose
    before you click. Selections that carry annotations step through a
    3-second **"Really delete N annotated page(s)?"** confirm first (one
    click arms, a second click within the window decides — any other
    interaction, or a selection/plan change, cancels it), so the badge's
    warning can't be undone by a single accidental click. Selections without
    annotations delete immediately, no ceremony.
  - **Undo / Redo** — every staged edit (blank, delete, move, insert,
    drag-drop) is snapshotted before it applies: **↩ Undo** (or **Ctrl+Z**
    while the manager is open) steps back through the whole plan history,
    restoring both the page order and the selection — so an accidental Delete
    or Insert is undone in one click, before Apply ever touches the file.
    A mistaken undo is equally one click away from being reapplied with
    **↩→ Redo** (or **Ctrl+Shift+Z** / **Ctrl+Y**), and a fresh edit clears
    the redo stack — standard undo/redo semantics, all still pre-Apply. The
    manager's selection line teaches the shortcut ("Ctrl+Z undoes edits")
    and names the keys as they become available, so staged undo is discoverable
    without opening Help.
  - **Reorder** — select pages and **↑ Move up / ↓ Move down** (each selected
    page swaps with its neighbor; selection follows the moved pages), or
    **drag the thumbnails directly**: grab a page (dragging an unselected page
    selects just it; dragging a selected one carries the whole selection) and
    an accent bar shows exactly where it will land before you release — across
    a row wrap the bar snaps to the next row's start, so the drop lands where
    the bar sits. For
    long documents there are also **⏮ First / ⏭ Last** shortcuts and a
    **Move to…** prompt speaks the drag bar's language: a plain position
    (`3`), relative to a page (`before 4` / `after 2`), or a comma-separated
    placement (`1,3,5` — one position per selected page) — every move is
    undoable with **↩ Undo** like any other staged edit. **Home / End** move
    the *selection* to the first/last page (mirroring the viewer's own
    Home/End navigation), so the extent is one keypress away in long
    documents — inside a text field they keep their normal caret meaning.
    **Shift+click** selects a contiguous range in one gesture: the block
    from the last plain click (or Home/End position) to the clicked page is
    selected wholesale — click page 1, Shift+click page 5, and 1-5 are
    selected for a block drag, Delete, or move. Repeated Shift+clicks keep
    extending from the new far end; a plain click still toggles and
    re-anchors, and the range drags as one block just like any other
    multi-selection. **Shift+↑/↓** (and **Shift+Home/End**) select with the
    keyboard using the file-manager anchor/focus model, the mouse-free twin
    of Shift+click: the first press fixes the BASE edge, a tracked FOCUS
    edge moves one page per press (or straight to the document boundary
    with Home/End), and the selection is always the contiguous range between
    them. Reversing direction therefore SHRINKS the range toward the base
    (like Explorer or a text editor) and keeps going past it to grow the
    other side; a boundary press is a no-op. With nothing selected the
    first press anchors at the first (↓/Home) or last (↑/End) page and
    grows from there, any non-Shift+arrow action (a plain click, Ctrl+A,
    Invert, a drag, an applied plan) re-anchors the sequence from the
    current selection, and inside a text field the keys keep their native
    caret meaning.
    **Ctrl+A** selects every staged page at once (the
    plan is untouched and the anchor moves to the first page, so a
    following Shift+click extends from there); inside a text field it
    keeps its native select-all-text meaning. A **Select annotated**
    button picks exactly the pages that carry annotations — the same set
    the Delete confirm warns about and the badges surface — so a cleanup
    reads "Select annotated → Delete" with no surprises, and it re-runs
    any time (the selection tracks the current annotation list, toasting
    the count). An **Invert** button (or **Ctrl+I**) flips the selection —
    pick the pages to KEEP, invert, and everything else is selected for
    Delete in one click (invert twice returns exactly to the original
    selection; with everything selected it acts as a deselect-all, and
    inside a text field Ctrl+I is ignored like Ctrl+A). The sidebar's
    **Pages tab** has its own **Select annotated** button (next to "Manage
    pages…") so the same cleanup flow — pick the annotated pages, then
    drag the block or move it with the First/Last/Move-to actions — works
    without opening the manager. It builds the sidebar's page-number
    selection straight from the annotation list (clamped to the open
    document), shows the block-actions row exactly like a hand-made
    selection, toasts the count, and re-runs any time so the set tracks
    the current annotations.
    Every thumbnail also carries a **live position index** (bottom-right):
    it renumbers as the plan changes and — while a drag hovers — previews
    where every page would land, so long-document reordering has a numeric
    reference. It's an input too: type a number + **Enter** to move *that*
    page there (undoable), **Esc** reverts without closing the modal.
  - **Sidebar keyboard multi-select** — the Pages tab's thumbnails support
    **Shift+↑/↓ / Shift+Home/End** exactly like the manager: the same
    anchor/focus model (a base edge fixed by the first press, a focus edge
    stepping one page per press or to the boundary, reversing direction
    shrinking then growing past the base), so a whole block can be built
    for a drag or the First/Last/Move-to actions without touching the
    mouse. The keys are live while the Pages panel is showing (or a thumb
    selection exists), a selected highlight keeps priority (arrows nudge
    it), and with no selection the first press anchors at the boundary page
    in the travel direction.
  - **Reorder from the sidebar** — the Pages tab's thumbnails are themselves
    draggable, and a drop **previews before it commits**: hovering a spot
    shows a floating pill with the *would-be* page order (`1 → 3 → 2`) next
    to the accent drop bar, and releasing arms a confirm toast —
    **"New page order: 1 → 3 → 2 — apply?"** with an **Apply / Cancel**
    pair. The document is **not rebuilt until Apply is clicked**; Cancel (or
    8s of inaction) leaves it exactly as it was — so a mis-drop costs
    nothing. Apply commits through the same machinery as the manager's
    Apply (annotations remap, scroll/zoom/AI state carry over), and — when
    the open PDF came from a real file path — the rebuilt document is
    **written back to that same file on disk**, so the reorder persists
    (the file-watch stays live; in the browser/PWA it falls back to the
    in-memory open). Every commit offers an **'Undo reorder'** toast that
    restores the pre-reorder document exactly — bytes on disk too, when the
    commit persisted them (bytes, identity, annotations). **Shift+click**
    now selects a **contiguous range**, anchored exactly like the manager's
    grid: plain-click a page (or Ctrl+click one) and Shift+click another to
    grab every thumb between them in one gesture, with repeated Shift+clicks
    extending from the range's new far end. **Ctrl+click** toggles a single
    thumb in/out for non-contiguous multi-select (the sidebar's plain click
    navigates, so Ctrl takes the manager's toggle role). Selected thumbs get
    a soft cyan halo — the "active" ring stays for the page you're on — and
    dragging any selected thumb carries the whole **block**, exactly like
    the manager's multi-drag; the selection follows to the block's new
    positions. Clicking a thumb still navigates; Chromium suppresses the
    click after a real drag.
  - **Insert from another PDF** — **⇪ Insert from PDF…** picks a file, then a
    page-range field (`all`, `1-3`, `1,3,5` — the same parser the unit tests
    cover) and an insertion point (start / after page N / end). If the source
    PDF was ever opened and annotated in Volt, its own annotations are read
    back at pick time and each inserted **"from …"** page shows a warm
    **count badge** for the annotations its source page carries (informational
    — those annotations stay with the source document, so deleting the page
    from the plan loses nothing).
  - **New PDF from selected** — **Export selected…** immediately builds and
    downloads a PDF containing just the selected pages (annotations burned in
    at their new positions), without changing the open document.
  - **Apply & save** — rebuilds the whole staged PDF, downloads it as
    `<name>-edited.pdf`, and **opens the result in Volt**: surviving pages keep
    their vector content and their annotations (renumbered to their new
    positions), deleted pages' annotations are dropped, and the rest of the
    per-document state (AI overrides, chat, zoom, rotation, scroll) carries
    over exactly like a disk reload. The original file is never modified.
  Rebuilds go through pdf-lib `copyPages`, so inserted pages keep their vector
  quality (no re-rasterization).
- **Exporting** — an **annotated PDF** (highlights/underlines/strikes/notes
  burned in via pdf-lib), a **Secure PDF…** (password-protect the exported
  file and restrict copying / printing / modifying — the PDF standard
  security handler; the exported file opens with the user **and** owner
  passwords in the vendored pdf.js, verified end-to-end by `npm run
  test:lock`), a
  **Send feedback…** (the Volt ▾ menu drafts a GitHub issue on the public
  repository with your message and an attached environment block — version,
  engine, OS, open document — so maintainers can reproduce it; it opens in
  the default browser for you to review and submit; the app never sends
  anything itself), and
  **Digitally sign PDF…** (attach a real certificate signature to the
  annotated export — an AcroForm `/Sig` field with a `/ByteRange` and a
  detached PKCS#7 (CMS) SignedData that Acrobat, pdf.js and independent
  verifiers validate; the certificate comes from a local PKCS#12
  `.pfx`/`.p12` file picked through the native dialog, everything runs
  in-process via Web Crypto and nothing leaves the machine — including
  pure-JS TripleDES for Windows-exported PFXes, verified against Node's
  crypto in the unit tests), a
  **PDF/A-1b (ISO 19005-1)** archival export (the ISO PDF/A standard: XMP
  metadata carrying the `pdfaid` part/conformance pair, an uncompressed
  `/Metadata` stream, an OutputIntent with an embedded sRGB ICC v2
  profile, document info, a trailer file identifier, embedded fonts and a
  classic xref — built on pure unit-tested helpers and asserted in the
  exported bytes by the smoke; the one thing a strict validator may still
  flag is semi-transparent annotation overlays, so run veraPDF or similar
  before shipping an audit file), a **Markdown** notes file (annotations
  plus your bookmarks, each with its page and label), a **Chat
  transcript** (Markdown — question/answer pairs with page citations, for
  sharing the conversation outside Volt), a portable **JSON backup**
  (export + re-import anywhere), or **Word / Excel / LibreOffice
  documents**: the
  export dialog also offers **.docx** (a real OOXML Word document — title,
  paragraphs, tables and images, each table rendered as a Word table),
  **.xlsx** (a real spreadsheet — every detected table becomes its own
  sheet with aligned columns, for pasting straight into Excel, Google
  Sheets or LibreOffice Calc), **.pptx** (a real presentation — a title
  slide, one slide per page's text, then each detected table and each
  picture as its own slide, for PowerPoint, Google Slides or LibreOffice
  Impress), and **.tsv** (plain tab-separated tables for any other tool).
  **Intelligent detection** reads each page's
  content streams to find tables and images. Tables come from two
  sources: the **text-gap detector** clusters lines by baseline and
  splits them into columns on real geometric gaps, and a **vector-grid
  detector** reads the page's path operators (every stroked
  rectangle/line, tracked through the current transform matrix) to
  recover grids that have *no text at all* — blank forms, ruled
  templates — plus merged cells: a wide header cell spanning columns
  flattens to its first column with empty neighbors, so "Combined"
  lands once instead of triplicating. The two detectors cooperate:
  table lines are excluded from the prose (nothing is doubled), and
  separate drawn grids are kept separate — a blank grid above a merged
  table at the same column positions stays two tables, because
  same-position line segments only merge when their spans actually
  touch. Images are embedded XObjects and inline images, re-encoded
  from the rendered page for clean embedding, and the title comes from
  the largest heading-styled line.  All four formats are built in-app with a small
  hand-rolled ZIP writer — no server, no cloud, nothing leaves the
  machine. The office exports are **selection-aware**: select pages in
  the Pages manager (its Escape-close keeps the selection live) and the
  Word/Excel/PowerPoint/TSV exports cover exactly those pages — the
  export dialog shows the note "Office exports will cover pages 2–3" —
  while an unchanged selection (or none) exports the whole document as
  before. Staged insertions (blank / from-another-PDF pages) can't be
  read from the open file and are reported as skipped in the toast.
  The Word/Excel/PowerPoint success toasts also carry an **Open with…**
  action (desktop app): one click writes the freshly built file to the
  temp folder and opens it in your default Word/Excel/PowerPoint
  handler — the same as double-clicking it in Explorer. (In the PWA the
  action is omitted; there is no shell to hand files to.) The backup dialog shows three
  checkboxes — **Annotations** (always included, and with them your
  **bookmarks**, which ride the same marks layer), **AI overrides** (model,
  max context, system prompt) and **Chat history** — so a backup can be
  marks-only, the full setup, or anything between, and a restore applies
  exactly the layers the file contains. **Restore backup…** (export menu, or
  the welcome screen) picks a `.json` and matches it to its PDF by the
  `file` field **plus a content fingerprint** — a hash of the document's
  opening/middle/final pages — so a renamed copy of the same PDF still
  matches, while a doctored file with identical size doesn't (its text
  changed, so the hash differs). **Scanned documents hash by their OCR
  text** — the fingerprint computes a recognition pass on the opening page
  on demand (or reuses the stored OCR store), so a renamed copy of a scan
  matches too; only a document nothing can be recognized from falls back
  to the size + page-count checks. The hash is computed with the current
  pdf.js build — a future vendor update could alter text extraction enough
  to break a rename-match (it fails closed to a prompt, never data loss).
  Volt prompts you to **open that document first** instead of importing
  into whatever happens to be open. After a restore, a **summary card**
  shows exactly what landed — the annotation count (marks vs notes), the
  bookmarks, the applied AI override values, and the chat length — staying
  up for a few seconds so you can double-check the import before moving on. For transfers,
  **Restore backup from URL…** (export menu, or the welcome screen) pastes a
  `.json` link and runs the identical match-and-open flow — the backup is
  fetched in the renderer, so the host must allow CORS (raw/plain download
  links from GitHub, gists, and most file hosts do).
- **AI chat** — streaming answers with automatic grounding: while no
  model is configured the panel's **one-click local AI setup**
  card installs Ollama and pulls `qwen3:4b` (or jumps to ⚙ for any other
  provider) — see “Connecting a local LLM” above.
  Volt picks the most relevant pages for each question and cites them. Click a
  `↗ p.N` chip to jump to that page. The input area is a single typing row
  (no quick-prompt chips eating vertical space — the pane is
  **user-stretchable**: drag the thin handle on its left edge to widen or
  narrow it, persisted across sessions; double-click the handle (or focus it
  and press Home) to reset to the default width). Asking about a selection
  still labels a **Ctrl+A whole-page selection** as *"whole page"* — the
  chat message shows the short label instead of echoing the full page text,
  while the page's text still reaches the model verbatim through the
  【User selection】 context block; partial selections keep the
  quoted-excerpt prompt. The per-document transcript is capped at
  **40 messages** by default — raise it to **100 or 250** in ⚙ (*Keep chat
  history*) for longer conversations; storage, backups, restores, and
  disk-reload carry-over all follow the same cap, so nothing silently truncates
  at a different window.
- **Listen & talk — voice** — the toolbar's **speaker** button reads the
  document aloud with your machine's **built-in voices** (Web Speech API —
  local, nothing to download, works offline), showing a floating read bar with
  pause/resume, speed ±0.1, and stop (**Space** toggles pause while reading).
  The AI chat's **mic** button takes voice input the same way — built-in
  recognition first, and a pluggable **external endpoint** for both directions
  when you want something better: in ⚙ → **Voice** you can point TTS at any
  OpenAI-compatible `POST /audio/speech` server and STT at any
  `POST /audio/transcriptions` server (a local Piper/Whisper/sherpa server,
  or hosted ElevenLabs/OpenAI, …), so the app itself stays small — it ships
  only the platform engines, never a bundled model. Toggle **speak AI replies
  aloud** to hear assistant answers in conversation mode — the same setting is
  a one-click **talk-mode speaker** in the AI input row, and while the AI is
  speaking a floating **talk bar** gives you **Pause / Stop** (the play glyph
  flips to ▶ while paused, so Resume is one click; turning talk mode off
  mid-speech stops the voice). Read-aloud and talk mode share the speech
  engine, so starting one always silences the other. ⚙ → **Voice** also has
  **Microphone** and **Speaker** pickers (enumerated live from your machine's
  audio devices): a chosen mic is requested by exact id for voice input, and a
  chosen speaker routes speech there via Chromium's `setSinkId` — both apply
  to the **external-endpoint** engines (the built-in Web Speech paths always
  use your system's default devices, per platform limits).
- **AI tools (agent harness)** — the chat can *act* on the document, not just
  answer: the model receives a tool set (document info, search text, read a
  page, add a highlight, add a note, list/remove annotations, navigate to a
  page, **edit text**) and Volt executes each call, feeds the result back, and
  continues the conversation — so you can say *"highlight every mention of
  the contract date"*, *"add a note on page 3 saying TBD"*, or *"change
  'quiet engine' to 'quiet motor' on page 1"* and the AI does it. The text
  edit goes through the exact same path as the **Markup ▸ Text** tool — it
  matches the phrase on the page (line-aware, so phrases split across word
  spans still work), preserves the rest of the line, and can restyle the
  changed text (font family, bold/italic, size, color). Tool calls appear as
  a small chip in the message, and every executed change is a normal
  annotation (undoable with Ctrl+Z, exportable into the saved PDF) — exactly
  what a user could do by hand. When a replacement is **longer than the
  line it lands on**, it wraps across the following lines instead of
  overflowing the page: the layout uses the following lines' own geometry
  (their indent, baseline and height), so an indented or right-aligned
  paragraph keeps its look, and each wrapped line is covered and re-drawn in
  the exported PDF the same way the on-screen layer shows it.
- **Per-document AI settings** — in ⚙, check *Customize AI for this document*
  to give a specific PDF its own model, max-context size, and even its own
  system prompt (e.g. *"answer in legal plain English"* for contracts, *"teach
  me like a beginner"* for textbooks). Saved alongside that document's
  annotations, so every PDF can remember its own setup. Each override also
  records the **provider (and endpoint, for custom) it was set under** — if a
  document's model was chosen on a different provider than the one currently
  configured, the doc-settings popover shows a hint that it may not be
  reachable on the current endpoint, and a backup/transfer carries that
  provenance along. The AI header shows a
  *· this doc* marker when active — hovering it previews the document's
  effective model/context/prompt, and **clicking it opens the doc-settings
  popover directly** (the same summary the small ⚙-sliders button shows), so
  you can see or tweak the setup without dismissing a modal — the
  popover's *Edit in settings…* jumps straight to the ⚙ override section
  when you need the full editor. When the document has **no overrides yet**
  the pill turns into a **dashed ghost** — clicking it jumps straight to the
  ⚙ override section, so new users discover per-document settings without
  hunting for the gear. Each override row carries
  its own **×** to clear just the model, context, or prompt — keeping the
  rest — and every reset, whole or per-field, is **undoable** from the
  popover. Saving doc overrides from the ⚙ modal (the marker flow) offers an
  **"Undo this change" toast** that reverts the save to the previous
  override snapshot — the modal closes without confirmation, so the revert
  lives in the toast. The popover's destructive actions (**Reset** and **Clear chat**)
  arm a 3-second **"Really …?"** confirm first — one accidental click never
  wipes anything; a second click within the window (or any other
  interaction, which cancels it) decides, and undo still covers the result.
  The popover also has a **Clear chat** action (below a divider)
  that wipes the document's conversation — transcript and its
  `volt:ai:chat:` storage — with the same undo pattern. The header also has a
  **persona picker** — quick system-prompt presets (**Legal**, **Beginner**,
  **Concise**, or *Custom…*) that switch a document's AI voice as fast as
  switching its model, preserving any per-doc model/context settings. A
  **"⚙ Manage personas…"** entry at the bottom of that picker opens a
  per-user editor: rename, reword, add, or delete presets, stored under
  `volt:ai:personas` (localStorage) so your header stays personalized — the
  built-in three seed it on first use, and *Restore defaults* brings them
  back. The editor is a plain form: only **Save** writes, so **Cancel** never
  touches the saved list. A **global persona** row sits below it and applies
  a preset to **every** document — it sets the global system prompt, so any
  PDF without its own override picks that voice, and it's visible even with
  no document open (choose **(none)** to return to the default prompt; a
  document whose persona row reads *(global: Legal)* is falling back to the
  global persona). Personas can also be switched **from inside the chat** —
  type `/persona <name>` (or e.g. *"use the legal voice from now on"*) and
  Volt acknowledges it in-thread and applies it without touching the header:
  this document's persona when a doc is open, the global persona otherwise.
  `/persona none` clears it, `/persona list` shows the names. The
  acknowledgment is a normal chat message — it counts toward the transcript
  cap and appears in exports/backups like any other exchange. The
  per-doc model picker also carries a **"✎ global default…"** entry that opens
  a tiny popover to change the **global default model** — so the default is
  switchable from anywhere, doc open or not, without opening ⚙. A compact
  **temperature stepper** (−/value/+) sits next to the model picker — same
  0–1.5 range and `volt:ai:settings` key as the ⚙ slider, so the whole
  conversation personality can be tuned from the header. When **no document is
  open**, the header shows a **global model picker** instead — switch the
  default model for all documents without opening ⚙.
- **Drag & drop + file association** — drag a `.pdf` from Explorer onto the
  window to open it, or simply double-click any `.pdf`: it opens in Volt.
  Volt keeps a single instance, so a second double-click while the app is
  running normally just focuses the window and opens the file there — BUT if
  the on-disk bundle has been updated since the running window started (the
  main process remembers the sw.js cache hash it launched with and re-reads
  it on every second launch), it **relaunches instead**, so a "restart"
  from the desktop always converges on the current version — never the old
  process. The same guard works in the window itself: when the served sw.js
  cache name no longer matches the installed cache, a persistent
  **"Volt updated — restart to apply"** banner offers **Restart now**
  (desktop: full relaunch; browser/PWA: reload applies the staged worker)
  and **Dismiss** (per version — a newer update surfaces the bar again).
  By default the banner **counts down from 15s and restarts on its own**
  (once — an explicit click always wins, **Cancel** keeps the banner in
  manual mode for that version, and a modal open when the countdown hits
  zero defers to manual rather than lose unsaved work such as a staged pages
  plan). Tick **"Never auto-restart — always ask before restarting"** under
  ⚙ Settings → Version updates to go back to a click-only restart. Hover the
  banner to see **what changed**: the tooltip shows the CHANGELOG.md sections
  newer than the installed bundle (the served sw.js carries a `VERSION`
  constant — from the `VERSION` file — and the banner diffs it against the
  version this page was built as).
  This closes the recurring "I restarted but still see the old behavior"
  trap that stale single-instance windows and cached PWA bundles cause.
- **Reload-on-change** (desktop app) — when the open PDF changes on disk
  (the author re-exported it from InDesign/Word, or a cloud folder synced a
  new version), Volt notices and offers **Reload now / Dismiss** in a small
  banner. Reloading re-reads the file **and carries everything across**: your
  annotations, per-document AI overrides, chat history, zoom, rotation, and
  scroll position all survive the new version (the file's new size would
  otherwise give it a fresh identity and orphan that state — the reload
  re-homes it). If the file is deleted entirely, the banner says so instead.
  The watcher is a small stat poller in the main process (polling, not
  `fs.watch` — editors that save via temp-file + rename, and cloud-synced
  folders, break watch handles; a stat loop behaves the same everywhere), and
  it waits for a write to settle so mid-write states are never offered.

## File association

The launcher (`start-volt-app.cmd`) and the setup script
(`scripts/create-volt-shortcut.ps1`) both automatically register `.pdf` → Volt
in the **per-user** registry (`HKCU\Software\Classes` — no admin rights
needed). `create-volt-shortcut.ps1` does the shortcut **and** the association
in one run — the one-step setup for a fresh machine:

- First run **backs up** whatever `.pdf` was previously associated with
  (stored under `HKCU\Software\Classes\Volt.PDF.Previous`).
- If you later re-associate `.pdf` with another program, Volt won't fight you
  — it leaves your choice alone.
- PDFs show the Volt icon in Explorer.

Manage it manually from the project root:

```powershell
# (re)register  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/register-volt-file-assoc.ps1
# undo          powershell -NoProfile -ExecutionPolicy Bypass -File scripts/register-volt-file-assoc.ps1 -Revert
```

## Keyboard shortcuts

| Action | Key |
| --- | --- |
| Open PDF | `Ctrl+O` |
| Search | `Ctrl+F` · next/prev `Enter`/`Shift+Enter` |
| Sidebar / AI panel | `Ctrl+B` / `Ctrl+J` |
| Bookmarks (add / edit / remove / find) | `Ctrl+Shift+B` — toolbar button or the sidebar's Bookmarks tab |
| Manage pages | `Ctrl+Shift+P` |
| Extend selection (pages manager · sidebar thumbs) | `Shift+↑/↓` one page · `Shift+Home/End` to the boundary |
| Open File / View / Tools menu | `Alt+F` / `Alt+V` / `Alt+T` |
| Open Volt / Markup / Tools menu | `Alt+V` (logo) / `Alt+M` / `Alt+T` |
| Navigate menu items · switch menu | `↑/↓/Home/End` · `←/→` · `Enter` |
| Zoom | `Ctrl++` / `Ctrl+−` · fit width `W` · fit page `P` |
| Rotate | `R` |
| Navigate | `↑ ↓ PgUp PgDn Home End` |
| Annotate | `H` highlight · `U` underline · `S` strike · `N` note |
| Signature / date / form field | Markup ▸ **Signature…** / **Date stamp** / **Form field…** — click or drag to place, then select to move/resize/rotate |
| Skin | View ▸ **Light skin** / **Dark skin** (persisted per user; dark also inverts the document for night reading) |
| Read aloud | Speaker button · `Space` pauses/resumes while reading |
| Talk mode (AI replies read aloud) | Speaker toggle in the AI input row — while speaking, the talk bar shows **Pause / Stop** (the play glyph flips to ▶ while paused, so Resume is one click); turning talk off mid-speech stops the voice |
| Voice input | Mic button in the AI row (built-in or external endpoint) |
| Select / exit tool | `Esc` |
| Move / resize highlights | Click it, then drag (text highlights snap to a line) · handles on area rects |
| Duplicate selected highlight | `Ctrl+D` |
| Nudge selected highlight | `← ↑ ↓ →` 1pt · `Shift+arrow` 10pt |
| Select all text on page | `Ctrl+A` |
| Select all text in document | `Ctrl+A`, then `A` again (Ctrl held) — renders un-viewed pages on the spot, toast reports the page count |
| Highlight the whole page | `Ctrl+A`, then the toast's **Highlight all** button |
| Select text to document start / end | `Ctrl+Shift+Home` / `Ctrl+Shift+End` · `Ctrl+Shift+Space` |
| Undo / redo annotation | `Ctrl+Z` / `Ctrl+Shift+Z` |
| Help &amp; guides | `?` (or Volt ▾ → **Help &amp; guides…**) — tabbed center: Getting started, Reading, Annotating, Pages, AI chat, OCR, Voice, Files &amp; backup, Shortcuts, Troubleshooting |

While a dialog is open it captures the keyboard: `Esc` closes it, `Tab`/
`Shift+Tab` cycle inside it, and app shortcuts (`?`, page nav, zoom, annotate)
are ignored until it closes — focus always returns to where you were.

## Files

```
Volt (repo root)
├── start-volt-app.cmd       desktop-app launcher (Electron)
├── start-volt.cmd           web launcher (starts server + opens browser)
├── scripts/                 launcher + dev support (repo root):
│     check-launchers.cjs (cmd.exe parse gate), create-volt-shortcut.ps1,
│     register-volt-file-assoc.ps1, show-error.ps1,
│     start-volt-app-hidden.vbs (hidden-console wrapper the desktop shortcut
│     targets — wscript launches the .cmd with window style 0, so no
│     command-prompt box appears), create-volt-pwa-icons.ps1,
│     make-sample.mjs, mock-llm.mjs, test-second-instance.js
└── pdf-viewer/               the app — run everything from here
      index.html        app shell
      css/style.css     styling
      js/utils.js       pure helpers + tiny markdown renderer + RAG chunking (unit-tested)
      js/annotations.js annotation engine + pdf-lib export
      js/ai.js          LLM client, grounding, chat UI, settings
      js/app.js         viewer core (pdf.js rendering, scroll, zoom, search, keyboard)
      js/sample-data.js embedded sample document (base64)
      manifest.json     PWA manifest (installable app)
      sw.js             service worker (offline caching for the PWA)
      main.js           Electron main process (embedded server + app window, file watcher, smoke test)
      preload.js        Electron bridge — OS file handoff (drag/drop + association) + file-watch API
      serve.mjs         dev server for the PWA / browser path (http://localhost:8421)
      package.json      Electron runtime + scripts (start / smoke / unit tests)
      vendor/           vendored pdf.js 4.8 (ESM) + pdf-lib 1.17 — no CDN needed
      scripts/          app-internal: update-vendor.mjs, auto-update.cjs, vendor-recovery.cjs,
                        gen-sw.mjs (sw.js generator), vendor-weekly.cmd + schedule-vendor-weekly.ps1
                        (weekly Scheduled Task), file-watcher.cjs + test-file-watcher.mjs,
                        test-utils.mjs, test-artifact-regression.mjs, window-state.cjs
      logs/             vendor-update.log (weekly scheduled run transcript, created on first run)
      samples/          sample.pdf (also embedded base64 in js/sample-data.js)
```

## Tech notes

- **pdf.js 4.8** (ESM, via a small module shim in `index.html`) — pdf.js 3.x
  hangs its paint loop on Chromium ≥ 142 (which is why the desktop app pins
  Electron 33 and newer browsers are covered too).
- In Electron, `requestAnimationFrame` can stall in windows that aren't actively
  compositing (VM/RDP sessions), which would freeze pdf.js's progressive render.
  A tiny shim in `index.html` (Electron-only) drives rAF from a 16ms timer so
  rendering always completes. Browsers use native rAF.
- The modals are **deliberately placed outside `#app`**: opening one sets
  `#app.inert = true`, and Chromium asynchronously evicts focus out of any
  inert subtree — a modal inside `#app` would lose focus on its own fields
  the moment it opened (the real-keyboard smoke stage caught this). With the
  dialogs outside the inert shell, `Tab`/`Shift+Tab` work natively, and the
  focus trap in `app.js` simply cycles focus within the open dialog. The
  **reload banner lives outside `#app` too**, for the same reason: it must
  stay clickable while a modal inerts the app UI.
- **Watching the open file** (desktop app): the main process polls the open
  PDF (`scripts/file-watcher.cjs`, mtime + size) and notifies the renderer
  through `volt:file-changed`. Reloads re-home per-document state to the new
  identity because annotations/AI overrides/chat all key on the document's
  `name:size:pages` — `_captureDocState`/`_restoreDocState` in `app.js`
  carry them across. The smoke test covers the whole loop: it opens a temp
  copy by path, watches it, rewrites it (same bytes, new mtime), and asserts
  the banner appears and *Reload now* clears it.
- The PWA's service-worker cache name is **derived from a SHA-256 of the app
  shell's actual file contents** (`scripts/gen-sw.mjs`): any edit to `app.js`,
  css, html, or a vendored library changes the name, so the worker reinstalls
  and re-precaches fresh — dev/preview edits never silently serve stale cached
  files. **`index.html` is stamped the same way and independently**: every
  external `<script src>`, the stylesheet `<link>`, and the pdf.js
  module-import specifier carries a `?v=<hash>` query of its own file's
  current bytes (SHA-256, first 8 hex) — so the browser's **plain HTTP cache
  drops stale JS/CSS even with no service worker**, and because the hashes are
  per-asset, editing css invalidates only css, never the ~1MB vendored pdf.js.
  The dev server (`serve.mjs`) renders `sw.js` *and* `index.html` fresh on
  every request with no-cache headers, so an edit is picked up on the next
  reload, and `npm run gen:sw` rewrites the checked-in `sw.js` **plus the
  stamped `index.html`** for static hosting (idempotent — existing stamps are
  replaced, never stacked).
- `npm run smoke` (from `pdf-viewer/`) is a headless self-test that opens the
  sample document and verifies the full render chain. It also guards the
  **`[hidden]` display contract** (modals, popovers, badges rely on
  `[hidden]{display:none !important}`): a `hiddenProbe` stage asserts every
  element carrying the `hidden` attribute computes `display:none` — at boot,
  after a modal open/close cycle, and after every modal has been toggled —
  and calibrates itself by deliberately breaking the  rule on a throwaway
  element, so a future display rule or `!important` slip fails the smoke
  instead of silently re-breaking the  hiding. The boot count can be pinned:
  `npm run smoke -- --expect-hidden=30` (or `VOLT_EXPECT_HIDDEN=30`) fails if
  the number of elements starting out `hidden` drifts from 30 — a deliberate
  shell change that adds or removes a hidden element must consciously bump the
  pin instead of silently shrinking the checked set. A sibling `modalCycle` stage
  goes beyond the static attribute check: it toggles **every** modal
  (settings, help, URL, export, restore, personas, pages) open and closed through
  the real `_openModal`/`_closeModal` paths and asserts each one's `hidden`
  attribute **and** computed display are restored on close — catching JS
  paths  that un-hide without the attribute (an inline `display:… !important`
  that defeats the rule, or a close path that never sets `hidden = true`),
  not just CSS regressions. Right after the cycle, a **help-center** stage
  (six assertions) verifies the tabbed help modal itself: ten nav items map
  one-to-one to ten guide sections, opening on a specific section shows it
  (nav highlighted in sync), clicking a nav item switches sections in place
  (with the shortcuts pane still holding its kbd rows), an unknown section
  id falls back to Getting started, and the modal closes cleanly. A
  **setup-wizard** stage (eleven assertions) covers the first-run
  installer end-to-end: with `?smoke=1` the banner is suppressed
  automatically, forcing it shows the offer, **Not now** answers it (flag
  saved, banner hidden, never nags), opening the wizard shows step 0 with
  four progress dots, Continue walks to the desktop/appearance step (the
  desktop checkbox + skin radios present in the desktop app; hidden with a
  browser note instead — the assertion branches on the bridge), the AI
  step reflects the configured model (detection stubbed for
  determinism), finishing produces the summary (skin + model lines) and
  marks `volt:setup-done`, **Start reading** closes the modal, and the
  menu item reopens it at step 0. State touched (theme, AI settings,
  setup flag) is snapshotted and restored. A mirror
  `visibleProbe` guards the **inverse
  contract**: the viewer-critical elements the UI structurally depends on
  (`#app`, `#toolbar`, `#main`, `#viewer`, `#scroller`, `#pages`,
  `#statusbar`, and the toolbar/status chrome, **plus the `html`/`body`
  roots** — `getComputedStyle` returns an element's own display, so an
  id-list alone could never catch a `body { display: none !important }`
  rule blanking everything) must **not** compute
  `display:none` — at boot and again after every modal has been toggled —
  so a future rule that hides the viewer itself (a `display:none
  !important` on `#pages`, the shell, or the roots) fails the smoke
  instead of silently blanking the whole app. It calibrates on a
  throwaway element hidden with `!important`, the same way the hidden
  probe does. A `swCache` stage fetches the **`/sw.js` the app actually
  serves** — the same bytes a static deployment hosts — and asserts its
  `CACHE` constant equals the hash the shell computes from the *current*
  files (via `scripts/gen-sw.mjs`): a stale checked-in `sw.js` (an asset
  edited but the artifact never regenerated) fails the smoke instead of
  silently precaching old files under an old name. A sibling `indexHtmlCache`
  stage fetches `/` and asserts **every** script/style tag (and the pdf.js
  module-import specifier) carries a `?v=` stamp equal to the asset's current
  content hash — so a stale checked-in `index.html` (asset edited, stamps
  never regenerated, or a tag added by hand without one) fails the smoke too,
  instead of the browser HTTP cache quietly serving old JS. A `toolbarResize`
  stage resizes the window through the CSS breakpoints (1280 / 1100 / 1000 /
  960 / 900, **plus 840 / 760 below the desktop minimum — narrow
  browser-window widths**, reached by relaxing the test window's min-size)
  and asserts the toolbar's right-end controls (the **File / View / Tools
  menu triggers** plus sidebar, AI, settings, help) stay on-screen at
  **every** size with **no toolbar overflow**, and that each collapse tier
  actually engages (brand + zoom readout and the menu labels, then the
  search count, then the search match buttons hide as the window shrinks) —
  the regression that made the app look like it "doesn't adjust to
  resizing" (a ~1270px fixed toolbar pushing those buttons off the window
  edge). The same stage opens and closes each dropdown menu and asserts its
  items are present and a real item click still reaches its action (File →
  Export opens the export modal). It runs in `--smoke-no-focus` too, and
  restores the original window size afterwards. A `launcherGate` stage keeps
  the `.cmd` launchers from silently dying again (the parse bug that once
  made double-clicking the desktop shortcut do nothing) — the gate covers
  the repo-root launchers `start-volt-app.cmd` / `start-volt.cmd` and
  `pdf-viewer/scripts/vendor-weekly.cmd`: every launcher must
  pass static cmd.exe parse-hazard checks (pure ASCII, CRLF, no parentheses
  inside block echo lines, no text after a block-close, balanced blocks,
  defined `call`/`goto` labels), and on Windows the Volt launchers are
  **actually executed through `cmd.exe`** in a throwaway sandbox (stubs on
  PATH, mirrored temp tree) so any parse error — the "… was unexpected at
  this time." class — fails the smoke. The gate also sanity-checks
  the repo-root `scripts/start-volt-app-hidden.vbs` (the hidden-console
  wrapper the desktop shortcut targets): pure ASCII, references `start-volt-app.cmd`, and calls
  `WshShell.Run` with window style 0 — so the “no command-prompt box”
  guarantee can't silently regress. Standalone: `npm run check:launchers`
  from `pdf-viewer/` — the gate itself is the repo-root
  `scripts/check-launchers.cjs`. An annotation-editing stage drags a text highlight onto an
  adjacent line and asserts the quads are rebuilt onto a real text line (box
  shown handle-less and dashed, x-extent never widened, undo restores the
  original geometry). A **line-selection stage** locks the drag semantics
  down: a drag across the middle of ONE line produces exactly one quad
  clipped to the drag's x-range (the old box-intersection test bled into the
  adjacent line — span boxes overlap by a pixel), a 3-line sweep produces
  exactly three quads with the middle one full-width and the ends flush, and
  a drag through the interline gap (boxes touch, no center covered) falls
  back to an area highlight instead of a stray text quad. The same stage
  verifies the **live drag preview**: while dragging the highlight tool, the
  preview element is the *line-snapped* set (one block per selected line,
  matching the created quads exactly — never a whole-section rectangle),
  the same two lines stay lit when the cursor crosses the interline gap
  (no flash, no size-badge flicker), and the preview is removed on mouseup.
  The same stage now also samples the **overlay canvas pixels** — the
  user-visible contract that stored quads are only half the story: on a
  clean page a fresh highlight must fill the dragged line's box (and paint
  NOTHING 6px below the quad, so an offset render fails instantly) and a
  fresh underline must stroke its bottom edge with the cyan color. A
  **notes-pane deletion stage** seeds a note, opens the Notes tab, clicks
  the card's own delete button, and asserts the annotation is removed from
  the list AND the card disappears from the pane immediately (not on the
  next tab switch) — the fix for a lingering-card bug that read as "can't
  delete". A final
  **real-keyboard stage** drives native `Tab`/`Shift+Tab`
  wrap-around and `Esc` inside the open settings modal through Chromium's
  real input pipeline (`sendInputEvent`) — the same path a physical keypress
  takes — so the focus trap is verified end-to-end, not just with synthetic
  events. The same native keys then drive the **restore-backup prompt**: with
  the sample open, a deliberately mismatched backup (different name, size,
  pages, and fingerprint) opens the prompt with all **three action buttons**
  (Cancel / Import into current doc / Open this PDF…), `Tab`/`Shift+Tab` must
  reach each one and wrap at both ends, and `Esc` must close the prompt and
  **cancel the pending backup** (`_pendingBackup` cleared — so a dismissed
  prompt can never auto-apply when the matching PDF opens later), returning
  focus to the opener. Native keys then drive the **pages manager**: two
  staged blank-page edits, a real `Ctrl+Z` (sendInputEvent, not synthetic
  dispatch) must revert the last edit — the plan, the undo/redo button
  states, and the redo stack all checked — and native `Esc` closes the
  manager again. Inside the manager, a dedicated sub-stage drives
  **Shift+click range selection** through real (shift-modified) click
  events: a backward range from the Home/End anchor selects pages 1-3 at
  once (the plan untouched, the `.sel` classes on every member, the
  selection line reporting "3 of 3"), a plain click re-anchors the next
  range, a forward range extends from the new anchor, extending backwards
  re-covers the whole block, and a `dragstart` on any member carries the
  full range into the drag set with the `dragging` classes (cleaned up by
  `dragend`). The same stage also covers the **Shift+arrow / Shift+Home /
  Shift+End** keyboard range (nineteen assertions) with the anchor/focus
  model: from a middle anchor Shift+↓ grows down one page and re-anchors
  the moved edge (selection line + `.sel` classes follow, the boundary
  clamps without churn), **reversing direction shrinks** — Shift+↑ retracts
  {1,2} back to {1}, keeps going past the base to {0,1}, and a further
  Shift+↓ retracts onto the base — Shift+End/Home jump the focus to the
  boundary in one press, a plain click invalidates the sequence and the
  next press re-anchors, a fresh (empty) selection anchors at the first
  page for ↓ and the last for ↑, and the keys are ignored inside a text
  field — and the **real-keyboard stage** (sendInputEvent) presses native
  Shift+↓ and Shift+End against the open manager to prove the same path a
  physical keyboard takes. The same stage covers **Ctrl+A** (select-all selects every
  staged page with the `.sel` classes and the "3 of 3" line, the plan
  untouched, the anchor re-seeded; dispatched on the focused move-to
  input it is *ignored* so text fields keep native select-all) and the
  **Select annotated** button (both doc pages selected when page 3 gains
  an annotation, the blank always excluded, the "Selected N annotated
  pages" toast shown, and the set tracking the annotation list when the
  note is removed). The sidebar's **Select annotated** button is covered
  too (ten assertions): from pages 1+2 annotated it builds the {1,2} page
  set with the anchor at 1, the `.sel` classes and block-actions row
  appear, the "Selected 2 annotated pages" toast fires, adding a page-3
  note grows the set to all three, dropping it plus the page-2 highlight
  shrinks back to {1}, no annotations at all toasts "No annotated pages"
  and leaves the selection untouched (the manager's early-return
  behavior), and the seeding is restored before the manager tests). The **Invert** button and **Ctrl+I** are covered the
  same way: from the {1} selection the complement {0,2} is selected with
  the anchor re-seeded to 0, the "2 of 3 pages selected" line and toast
  update, the `.sel` classes follow, a second invert round-trips back to
  {1}, Ctrl+I through the real keydown path inverts identically, and it is
  ignored inside the focused move-to input). The same stage covers the
  viewer's **Ctrl+A select-all-text** (seven assertions): with page 1
  forced current it produces one native Range covering every
  non-whitespace text node of that page's layer — from the first node at
  offset 0 through the last node to its end — non-empty, contained in the
  current page's layer, with no page navigation, and dispatched on the
  focused search input it is *not* hijacked into a page selection (the
  input's native select-all wins). The same stage also covers the
  **Highlight all** toast action (four more assertions): the toast's action
  button is present with the right label, clicking it creates exactly one
  highlight annotation on the page with quads + the full page text
  captured, the selection is cleared, and one undo restores the prior
  annotation list. The **quick-action whole-page label** follows (five
  assertions): after a fresh Ctrl+A, `_wholePageSelection` is true and the
  Explain prompt is the short "whole page" label (under 400 chars, page
  text *not* embedded), while a two-word selection is not detected as
  whole-page and keeps the quoted-excerpt Rewrite prompt. The **Ctrl+A+A
  whole-document selection** follows (eighty assertions): with every
  page force-rendered (the fully-rendered small-PDF state) a second Ctrl+A
  within 600ms produces one range starting in page 1's layer and ending in
  the last page's with the full ~4,100-char text, the status toast reads
  "Selected all text across N pages — M chars" (page count + char count,
  mirroring the Ctrl+A toast) and carries the same Highlight-all action
  button, and clicking it on the whole-document selection creates ONE
  highlight per page (three annotations across pages 1–3 with quads — the
  multi-page path of `highlightSelection` — with one undo restoring the
  prior list). With a page disposed from the render window the same double
  press renders it ON THE SPOT and selects across all pages again (range
  spans pages 1→3, page 2 re-rendered — no current-page fallback); the
  render is PINNED so the freshly rendered pages survive the next scroll
  (a synthetic far-page entry that the window WOULD dispose stays rendered
  while the pin is set and is disposed the moment it's cleared — proving
  the gate is real, not vacuous on the 3-page sample). The
  gesture ALSO re-paints the sidebar's Pages-panel thumbnails, so after
  clearing the sidebar's grid + rendered-set the double press repopulates
  it to one painted thumb per page — matching the page count the toast
  reports. **Escape cancels the on-demand render pass** mid-flight (with a
  per-page delay injected so the smoke can catch it): no selection is
  built, the "Selection cancelled" toast fires, and the cancel flag clears
  so the next render works normally — the render window is restored
  afterwards. The selection toast is PERSISTENT (three more assertions):
  it has no auto-expire timer and exposes its dismissal, stays up past the
  old expiry window, and a pointerdown anywhere outside it dismisses it
  (fade + removal from the DOM). The status bar's live selection-range
  readout is covered too (three more): after a whole-document Ctrl+A+A
  `#sb-sel` shows "· Sel p.1–3", a Ctrl+Shift+End from page 2 narrows it
  to p.2–3, and clearing the selection hides it. Boundary selections
  offer the same Highlight-all action (three more, in the bsel stage):
  after a Ctrl+Shift+Space the persistent toast reads "Selected text
  across 3 pages" with both action buttons, clicking Highlight all
  creates one highlight per page across 1–3, and one undo restores the
  prior list. The **Copy w/ citations**
  action is covered as well (five more): the toast carries exactly two
  action buttons (Highlight all + Copy w/ citations), and clicking the
  copy button — with the clipboard write stubbed — captures text that
  contains the "— p. 1/2/3" headers in order with the full page text
  (>3000 chars) and fires the "Copied 3 pages with citations" toast.
  The Highlight-all confirmation carries the per-page breakdown too (one
  more): after the multi-page click the toast matches
  "Highlighted text on 3 pages: p.1: <n> lines · p.2: <n> · p.3: <n> —
  Ctrl+Z to undo". The **Clear highlights**
  quick action on that confirmation toast is covered too (four more): the
  toast's action button is labeled "Clear highlights", clicking it drops
  the annotation count by EXACTLY three (all conversion highlights gone,
  nothing else touched), the "Cleared N highlights — Ctrl+Z to undo"
  toast fires, and one undo restores all of them (the clear is one
  grouped step). The confirm step itself is covered (two more in the
  hlAll stage + five in the clr stage): the first click on "Clear page 1"
  flips it to "Really clear page 1?" with the toast still up and the
  annotation count UNTOUCHED (one click never clears); for the
  document-wide button the whole arm → expire → re-arm → decide cycle is
  exercised — the label reverts after the 3s window with the list still
  intact (the walk-away path), and only the second click on the same
  button drops the count. The page-scoped forms are covered too (four
  more in the hlAll stage + twelve in the clr stage): a single-page
  conversion's toast button reads "Clear page 1" and clicking it removes
  ONLY page 1's highlights with the "Cleared 1 highlight on page 1"
  toast and one undo restoring it; `clearHighlights()` accepts a page
  number, an inclusive `{from, to}`, and a Set (each removes exactly
  that scope's marks, leaving the others, with undos unwinding in
  reverse); and the manager's **Clear hl** button — with pages 2–3
  selected — removes exactly those two pages' highlights (page 1 keeps
  its mark), names the scope in the toast, closes cleanly, and one undo
  restores everything. The AI quick action is covered too (six more in
  the clr stage): the foot line's danger button is present and labeled
  "Clear highlights", the first click flips it to "Really clear all?"
  (armed class on, annotation count UNTOUCHED), the second click removes
  exactly the seeded highlights, one undo restores them, and a final
  undo returns to the pre-seed state — the chat surface shares the same
  confirm + grouped undo as the toast.
  The **Copy highlights** quick action is covered too (twelve more in
  the clr stage): the foot line's non-danger button is present and
  labeled "Copy highlights", the empty case toasts "No text highlights to
  copy" without touching the clipboard, and with seeds the captured
  Markdown has the "## Page 1/2/3" headers in order, all four passage
  texts present, page 2's passages in reading order (upper before
  lower), exactly four quoted lines (the empty-text area fallback and
  Rectangle shape excluded), the "Copied 4 highlights from 3 pages"
  toast, the annotation list untouched by the copy, and one undo
  restoring the pre-seed state.
  The **AI pane** itself is covered right after (nine more in the aiW
  stage): the quick-prompt row is gone (no `.ai-quick`, no prompt chips),
  the two foot-line utility buttons are present and labeled, the resize
  handle exists, and a synthetic drag on it widens the pane by exactly the
  drag delta with `volt:ai:panel-w` persisted, ArrowLeft/Right on the
  focused handle resize by 20px steps, and double-click resets the width
  to the CSS default and clears the stored value.
  The **home screen** is covered right after (eight more in the recent
  stage): the recents list dedupes by path/URL (a re-pushed entry moves to
  the front without growing), renders name + folder/host into the grid and
  unhides the section, a click on a path entry reopens exactly that path,
  a URL entry shows its host, the primary "Open a PDF" CTA is present, and
  the old marketing copy + feature badges are gone.
  The **boundary
  selection** is covered
  right after it (four assertions): Ctrl+Shift+End from page 1 yields one
  range that starts at page 1's first text node (offset 0) and ends inside
  the last page's layer, Ctrl+Shift+Home from the last page spans back to
  page 1, and the requested Ctrl+Shift+Space from page 1 reproduces the
  End behavior — each polled until the async range-render lands. The pageMgr stage also drives a **sidebar drag-reorder**
  against the rebuilt document: a real drag of thumb 1 onto thumb 2 commits
  a direct page-order change (annotation remap verified in the live list and
  on the thumbnails), the 'Undo reorder' toast is offered, and clicking it
  restores the pre-reorder bytes + annotations exactly — and the **sidebar
  keyboard range** is covered first (thirteen assertions): Ctrl+click page 2
  anchors {2}, Shift+↓ grows to {2,3} and clamps at the boundary, Shift+↑
  shrinks back to {2} and grows past the base to {1,2}, a Shift+↓ retracts
  onto the base, Shift+End/Home jump the focus to the boundary (with the
  `.sel` classes and the block-actions row following every press), and an
  empty selection anchors at page 1 for ↓ and the last for ↑ — and then a
  **sidebar multi-select block drag**: a plain click + Shift+click builds
  the contiguous range 1-3 (`.sel` on every thumb, the anchor at the far
  end, no navigation), a Ctrl+click drops page 2 out — leaving pages 1 + 3,
  the non-contiguous pair dragged
  as one block before page 2 (a *straddling* drop — the block's members sit
  on both sides of the target, the case that exposed an insertion-slot bug
  in the block math), asserting the order lands `[1,3,2]`, the selection
  follows to the block's new positions, annotations remap, and the same
  undo restores everything. The drag stage also verifies the **preview
  contract**: the dragover shows the would-be order pill (`2 → 1 → 3`), the
  drop arms the confirm toast without touching the document (name and undo
  state unchanged), the Apply button is armed, and only clicking it commits
  — and a **disk-persist stage** proves the persistence half: a PDF opened
  by path is reordered through the same confirm flow, the file on disk is
  rewritten with the new order (read back and re-opened structurally),
  `currentPath` stays set (the file is still watched), and the 'Undo
  reorder' toast writes the ORIGINAL bytes back to that same file.
  A final **OCR stage**
  builds a genuine scanned PDF (an image-only page, no text layer, via
  pdf-lib), opens it, runs the vendored Tesseract engine, and asserts the
  whole pipeline: the OCR button appears, the page's text is recognized and
  stored per-document, **real selectable spans land in the page's text
  layer** (positioned, word-correct, and they survive a re-render),
  **search finds the OCR'd word** through the word-box fallback, the **AI
  chat reads the recognized text**, a reopen loads the cached store without
  re-running, and the sample is restored afterwards. The stage's final
  sub-stage covers the **per-document language**: the picker is populated
  and shows `eng`; `downloadLang` is exercised **offline** (pointed at the
  vendored `eng.traineddata.gz`, so the real fetch → gzip-magic check →
  gunzip → IndexedDB path runs without network); switching to a custom
  language code writes the per-doc key, clears the stale store, and
  re-arms the picker; a re-run recognizes with the new language (the worker
  reloads it from the seeded cache); and the language survives a reopen —
  then everything is restored to `eng` and the seeded cache entry deleted.
  A final  sub-stage covers the **layer toggle + transcript export**: the eye
  button is visible and ON, toggling it OFF strips every `.ocr-span` (and a
  re-render does NOT re-inject them), ON brings them back; `toText`/
  `toMarkdown` produce per-page blocks; and the export modal shows the two
  OCR items only while OCR text exists (hidden again on a text-only
  document like the sample).
  A **first-run LLM bootstrap stage** (`boot` in the probe) covers the
  default-model detection AND the one-click local-AI setup with ALL HTTP
  stubbed (a smoke can't install software). The new **auto-detect** path
  (six assertions) proves the default is found, not assumed: with
  `qwen3:8b / qwen3:4b / llama3.2:3b` installed the pass adopts the
  best-ranked `qwen3:8b` with NO download (adoption persisted, card
  hidden); with only `llama3.2:3b` it adopts that; a broken top candidate
  (its `/api/chat` ping fails) falls through to the next-best that works;
  and an empty install stays silent so the card can take over. The card
  flow then covers: a configured model keeps the card hidden (no nag), a
  cleared model + open panel shows the card after a `/api/tags` probe, the
  primary button reads "Download qwen3:4b" when NOTHING is installed, the
  click streams the `/api/pull` NDJSON and applies qwen3:4b as the default
  (Ollama provider, exactly one pull body) with the card hiding itself
  afterwards, the 42% progress render shows in the bar + label (button
  disabled), the already-installed path offers "Use qwen3:8b" (the
  best-ranked of the full set) and applies with NO second pull, and "Not
  now" persists the skip flag with the card hidden. Settings,
  per-document overrides, and the panel state are snapshotted and restored
  so later stages see the pre-bootstrap configuration. The same stubbed stage also covers the
  **model-quality tier picker** (seven more assertions, `boot.tier`): the
  ⚙ settings row is hidden for a non-Ollama provider, shows three qwen3
  chips (1.7b / 4b / 8b) with installed badges derived from `/api/tags`,
  selecting a tier arms the action button ("Install qwen3:4b" with the
  RAM/quality description), clicking it streams the pull and applies the
  tier as the default model (exactly one new pull body), and the
  already-installed path reads "Use qwen3:8b" and applies it with NO new
  pull. The **Ollama CORS drive-by guard** is covered too (five more
  assertions, `boot.cors`): a wildcard probe (`_probeCors` → `*`) surfaces
  the warning in the AI panel AND the settings row ("…lets ANY website use
  it (OLLAMA_ORIGINS=*)…"), the Restrict action records the exact value
  the real method hands to the bridge (`localhost:8421` — with `file://`
  asserted ABSENT, since Ollama's env parser panics on it) and flips the
  message to "restart Ollama", a safe posture (specific origin) stays
  silent, and the session dismiss hides the bar. The PROBE and the
  restrict METHOD are stubbed on the AI object rather than the bridge —
  the contextBridge object is frozen, so a bridge stub would silently
  no-op and the real IPC would probe the user's live Ollama (and, on the
  restrict path, write their actual environment), which a smoke must never
  do. The real probe runs in the MAIN process (`volt:check-ollama-cors`,
  a raw HTTP request with a spoofed foreign `Origin`) because browser CORS
  hides `Access-Control-Allow-Origin` from page JS — verified separately
  against a live Ollama (403 + no header = safe). A **private-instance
  stage** (nine more assertions, `boot.private`; spawn/stop stubbed — a
  smoke can never spawn real servers) covers the ⚙ toggle: hidden for
  hosted providers, arms for Ollama, enabling calls the spawn with the
  pinned origin (`file://` asserted absent) and adopts the returned port
  into the baseUrl, the status line reports it running, private mode
  short-circuits the real `_probeCors` to safe WITHOUT the bridge, probes
  target the private port, and disabling stops the instance and reverts
  the baseUrl. Browser mode degrades to a no-op (no bridge to spawn
  anything), matching the watch stage's pattern.
  The trap's **wrap-around decision and focusable
  selector are extracted into `utils.js`** (`Utils.focusTrapMove` +
  `Utils.FOCUSABLE_SELECTOR`) and unit-tested in `test-utils.mjs`, so a
  regression in the wrap rules is caught by the fast suite — the smoke's
  keyboard stage stays as the end-to-end tripwire, not the only one. A sibling `--smoke-browser` mode
  (`npm run smoke:browser`) reruns the whole probe **plus the real-keyboard
  stage against a window with no preload bridge** — exactly the context a
  browser/PWA tab gets (`window.voltDesktop` absent, app served over HTTP
  exactly as a static deployment would) — so the focus trap is verified in
  the browser path too, and every Electron-only stage (file watch,
  vendor-update toast wiring, OS handoff) degrades to its browser-mode
  expectation instead of failing.
- **Artifact-generator regression guard** — `npm run test:artifacts`
  (`scripts/test-artifact-regression.mjs`) proves the cache-name and `?v=`
  stamps are really derived from the shell's file contents, so a future
  generator regression can't hide: it edits `js/app.js`, asserts the
  generator's `cacheName()` and the `js/app.js` stamp **change**, runs the
  smoke against the **stale** disk artifact and asserts it **fails** on the
  `swCache`/`indexHtmlCache` gates, regenerates and asserts the smoke
  **passes**, and separately starts `serve.mjs` to verify the **served**
  `/sw.js` cache name changes on the wire when the file changes (the
  dev-server freshness path the Electron smoke doesn't cover). It restores
  `app.js` byte-for-byte and proves `sw.js` + `index.html` are byte-identical
  to baseline before exiting. Runs headless (`--smoke-no-focus` — the
  artifact stages are in the shared probe, and skipping the real-keyboard
  stage removes the OS-focus dependency, so it's stable in VM/CI sessions).
  The weekly Scheduled Task runs it too (logged to `logs\vendor-update.log`),
  so a derivation regression is caught even when no vendor update is
  available to trigger the pipeline's own gate.

## Updating the vendored libraries

pdf.js and pdf-lib are vendored in `vendor/` (no CDN at runtime). Keep them
current — new pdf.js releases routinely carry fixes for newer Chromium
versions — with the built-in updater:

**Volt also self-updates in the background.** A few seconds after the desktop
app starts, it checks the CDN **at most once per day** (`volt-vendor-check.json`
in the app's user-data dir). If a newer pdf.js exists, it downloads it, swaps
it in (with the same backup/rollback guard), and **gates it on the Electron
smoke test** — which now runs in a `--smoke-no-focus` mode that skips the
real-keyboard stage, so a background gate never shows or steals focus. Only on
a successful, smoke-verified apply does Volt toast *"updated pdf.js to X"*;
every other outcome — already current, offline, not writable, or the smoke
failing (the update rolls back and the old files are kept) — stays silent.
Packaged installs need the `vendor/**` `asarUnpack` rule (already set) so the
files are on disk and writable; if they aren't, the check skips silently.
Set `VOLT_NO_AUTO_UPDATE=1` (or pass `--no-auto-update`) to disable it.

**Crash recovery:** the swap sets a `vendor/.update-pending` flag, cleared only
when the smoke gate + commit finish (or a rollback). If the app is quit or
killed mid-gate, the next **normal** launch restores the previous vendor from
the backup before the renderer loads. The smoke-gate instance itself *never*
runs that recovery — it's part of the update and must validate the freshly
swapped files as-is (recovery running there would restore the old files and
make the gate approve the previous vendor instead of the new one).

### Weekly automated check (Scheduled Task)

The desktop app's background check is silent by design. For an **auditable**
safety net, register a weekly Windows Scheduled Task that runs the full
updater and logs every outcome:

```powershell
# register (per-user, no admin; runs Mon 09:00 while logged on)
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/schedule-vendor-weekly.ps1
# remove it later
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/schedule-vendor-weekly.ps1 -Unregister
```

The task runs `scripts\vendor-weekly.cmd` — `npm run update:vendor -- --no-focus`
with its transcript (downloads, API check, smoke gate, rollback messages, exit
code, plus the Electron pin-vs-latest status line) appended to
`logs\vendor-update.log` next to the app. The gate runs in
`--smoke-no-focus` mode, so the 09:00 run never flashes a window or steals
focus. A pdf.js regression (e.g. a major that hangs the pinned Electron) shows
up there the week it appears, with the previous files left working. A missed
run (PC off at 09:00) fires at the next logon. Manual runs accept args:
`vendor-weekly.cmd --dry-run` reports current vs latest without downloading
anything (drop `--no-focus` for the full keyboard-stage smoke).

Concurrency is safe: the updater takes an **exclusive lock** (`vendor/.update-pending`,
created atomically) around the swap→gate window, and the task itself skips when
that lock exists — so the weekly run and the app's built-in background check can
never interleave their file writes (whichever starts second logs "skipped" and
gets out of the way).

```bash
npm run update:vendor    # fetch latest pdf.js + pdf-lib + tesseract, verify, swap, smoke-test
npm run update:vendor -- --pin 4    # stay on the pdf.js 4.x line
npm run check:vendor     # just verify the current vendor + smoke (no downloads)
npm run update:vendor -- --check-electron   # test the latest Electron against the smoke gate
```

**Tesseract.js is included and pinned.** The OCR engine (`vendor/tesseract/`)
is version-locked (`5.1.1` API/worker, `5.1.0` core, `4.0.0` traineddata)
rather than floating, because the smoke's OCR stage gates on it — a bump is a
deliberate change, not a silent "latest". The updater re-downloads all of it
(API + worker, the four wasm core variants as **binary** fetches, and the
gzipped `eng.traineddata.gz` from the tessdata host), verifies sizes/markers
(gzip magic included), swaps it under the same backup/rollback lock, and the
pre-swap DOM-contract gate serves the staged tesseract files too. `check:vendor`
verifies presence + markers (the Node API check can't load the browser/worker
UMD bundle — the Electron smoke's OCR stage is the real gate).

**It also watches the Electron runtime.** Every run compares the pinned
Electron (`devDependencies.electron` in `package.json`) with the latest stable
and prints a suggestion when a newer one exists. Compatibility is determined by
the **smoke gate itself**, not a version heuristic: the rAF/compositing shim
keys on the Electron user-agent (so it applies on any version), and the smoke's
render-completes probe is the signal that a newer runtime still works.
`--check-electron` makes that real: it downloads the latest Electron into a
**temp directory**, runs the full smoke gate against that binary, and reports
*safe to bump* only if it passes — printing the exact command
(`npm install --save-dev electron@X && npx install-electron && npm run smoke`;
Electron ≥ 43 ships its binary as an explicit `install-electron` step rather
than an npm postinstall, so a bump needs it — the check handles both layouts
and runs the package's own installer when npm leaves no binary). It never
touches `package.json` or `node_modules` itself. Note: run it with **Volt
closed** — the gate uses the app's own user-data dir, so an open app can
contend on Chromium's disk-cache lock and skew the verdict. Combine with
`--check` to verify the vendor first, and `--dry-run` to see what it would do
without the ~110 MB download.

How it works — and why it's safe:

1. **Downloads** the newest builds to a staging area (unpkg with a jsDelivr
   fallback) and sanity-checks sizes + expected markers.
2. **Verifies the API surface** the app actually calls (`getDocument`,
   `TextLayer`, `GlobalWorkerOptions`, `Util`, `PDFDocument`) by loading the
   staged files in Node (with minimal DOM stubs — pdf.js's modern build needs
   them to even load outside a browser).
3. **Pre-swap DOM-contract gate** — the Node API check has no real DOM, so
   before anything is swapped the updater runs the **full smoke probe**
   (render, text layer, exports, and the `hiddenProbe`/`visibleProbe` DOM
   contracts) against the *staged* files via `--vendor-stage` — the embedded
   server serves `/vendor/*` from the staging dir. A bump that breaks the DOM
   contract fails the verification here, with **zero churn**: no swap, no
   backup, no pending flag, nothing to roll back. (Standalone form:
   `node scripts/update-vendor.mjs --verify-staged <dir>`.)
4. **Swaps** the files in, keeping the previous ones in a backup.
5. **Gates on the Electron smoke test** — a real Chromium render of the sample
   document. On any failure it **rolls back** to the previous files untouched.
6. **Commits**: records versions in `vendor/VERSIONS.json` and regenerates
   `sw.js` (`scripts/gen-sw.mjs`) so installed apps drop the stale files.

If the latest major breaks the app (e.g. pdf.js 6 renamed something or hangs on
the pinned Electron), the updater reports it loudly, **auto-retries on the
current major** (`4.x`, where Chromium-compat fixes usually land), and leaves
the working files in place. That's the point: a regression is caught the moment
it appears, never silently shipped.

> Heads-up: the smoke test's watchdog now takes down its own process tree on
> timeout (Windows), so a hung render — like pdf.js 6 in this app's pinned
> Electron — can't leave orphaned Chromium processes that poison the next run.

## Development

Every push (any branch) and every pull request runs ALL of the self-test
gates on Windows CI — see `.github/workflows/ci.yml` at the repo root:
`check:launchers`, `test:utils`, `test:office`, `test:watch`, `test:lock`
(secure exports: lock → open in the vendored pdf.js), `check:vendor`,
`smoke:browser:headless` (the PWA/no-preload render smoke, headless so the
VM-safe `--smoke-no-focus` mode is used), and `test:artifacts` (which itself
runs the Electron smoke headless, negative and positive) — plus the slower
`release-feed` job (the full auto-update round-trip — see "Auto-updates for
installed users"). The OS-focus-dependent real-keyboard stage is the one
thing CI can't do; it stays in the local `npm run smoke` / `smoke:browser`.

```bash
node scripts/make-sample.mjs   # regenerate the sample PDF + embedded copy (from the repo root: scripts/ is Volt/scripts)
node scripts/test-utils.mjs    # unit tests for utils (chunking, markdown, scoring, focus-trap wrap)
node scripts/test-lock.mjs     # secure export e2e: Volt.Secure-locked pdf-lib output must open in the vendored pdf.js
node scripts/test-file-watcher.mjs  # unit tests for the disk-change watcher
node scripts/test-artifact-regression.mjs  # generator regression guard (see tech notes)
node scripts/test-release-feed.mjs   # full auto-update round-trip (publishes a scratch feed, see below)
npm run test:watch / test:utils / test:lock / test:artifacts / test:release-feed  # the same, via npm
node scripts/mock-llm.mjs      # fake OpenAI-compatible endpoint for local testing (from the repo root, as above)
node serve.mjs                 # static server on :8421
node scripts/update-vendor.mjs # update vendored pdf.js/pdf-lib (see above)
node scripts/update-vendor.mjs --verify-staged <dir>  # pre-swap DOM-contract gate only
node scripts/gen-sw.mjs --write # regenerate sw.js + stamp index.html (?v= hashes)
node scripts/check-feed-drift.mjs   # watch the live latest.yml vs this tree (npm run feed:watch; --once = one-shot check)
```

## Releasing a version

1. Bump **both** version sources to the same `x.y.z` — `VERSION` (a single
   line, the app-shell source of truth for `window.__VOLT_VERSION`) **and**
   `version` in `package.json` (the installer name **and** the version
   electron-updater compares against the release feed) — and add a `## x.y.z`
   section to `CHANGELOG.md` (the version banner's tooltip shows exactly these
   sections to users with a pending update).
2. `node scripts/gen-sw.mjs --write` — regenerates sw.js (which carries the
   new `CACHE` **and** `VERSION` constants) and re-stamps index.html (whose
   `window.__VOLT_VERSION` tells a running page which version it is).
3. Run the suites (see Development) — the smoke's banner stage asserts the
   served `CHANGELOG.md` contains the current version's section, so a release
   that forgets its changelog entry fails the gate. `npm run check:sw`
   (`node scripts/gen-sw.mjs --check`) also verifies the checked-in `sw.js`
   and `index.html` match what the generator derives from the current files
   — a stale artifact fails here before any tag is cut.
4. Tag the **current** tip of `main` (`git tag -a v<x.y.z> … && git push
   origin v<x.y.z>`). The release workflow fails fast if the tag doesn't
   point at the current `origin/main` HEAD — re-tagging an old commit (e.g.
   re-pointing `v1.0.0` at a pre-upgrade SHA) would publish a release
   without the latest fixes, and the version-match guard alone can't catch
   it. Re-cut the tag at current main (or cut a new version) rather than
   force-pushing a stale tag. The workflow also re-runs the artifact-drift
   check above on the tag's own tree, so a tag can never ship a worker that
   precaches old files under an old name.

   **Alternative: release without a tag (manual dispatch).** The same
   workflow can be triggered from the Actions tab ("Run workflow"): leave
   `main_sha` empty to release the current tip of `origin/main` (no
   confirmation needed), or paste any full SHA that lies on `main`'s
   history to release that exact commit — that non-tip case requires
   checking `confirm_stale_ref`, e.g. an emergency hotfix off a previous
   line or retrying a publish after a failed run. Every other guard
   (on-main ancestry, artifact freshness, secrets, signed artifacts)
   applies identically. The published version is whatever the checked-out
   tree's `package.json` says; with no tag name to verify against, the
   version-match guard is push-only.

   **Scratch unsigned releases (testing only).** Set `scratch_unsigned`
   to publish an UNSIGNED build — the escape hatch for proving the
   publish/feed mechanics (e.g. that the auto-update feed URL serves a
   real `latest.yml`) before a real CA cert lands. It skips the
   certificate requirement, the cert guard, and `sign:check`, and needs
   only `GH_TOKEN`. An unsigned release means SmartScreen warnings and
   NO updater signature verification, so it becomes the "latest" release
   only until you delete it — `gh release delete v<version>` afterwards
   (keep the git tag; the real signed publish recreates the release).

   **Retrying a release.** A failed publish can simply be re-run (dispatch
   again, or re-push the same tag) — at any time, however long after the
   first attempt. The certificate guard (self-signed / expired / keyless)
   runs before the release is pre-created, so a run that fails the guard
   stops with NO release created — the feed is never polluted by an empty
   release. Only a run that passes the cert guard pre-creates the release
   (deduping
   electron-builder's two-publisher race: the blockmap and the installer
   resolve their release concurrently, and without this both would create
   one — seen live as two releases with split assets) and sets
   `EP_GH_IGNORE_TIME`, so the publisher reuses that same release at any
   age and re-uploads the fresh artifacts into it. Without that, a
   re-run past electron-builder's 2-hour reuse window would silently
   skip the upload and leave the release empty. One release per tag, ever
   — a re-run never creates a duplicate. The one reuse that is refused:
   a release that has **already shipped** — published, with the complete
   `latest.yml` + installer + `.blockmap` asset set — fails the run
   instead of being overwritten, because those are artifacts users have
   already downloaded (a re-tag, an accidental re-dispatch, or a leftover
   scratch release would otherwise silently replace them). Delete the
   release first (`gh release delete v<version>` — the git tag stays) to
   re-publish that version.

**Release pipeline at a glance.** The workflow (`.github/workflows/release.yml`,
`.github/workflows/ci.yml`) runs the release through five guards **before
anything is created or published**, then publishes through a race-free,
retry-safe path:

1. **Release ref is on main** — the release must be a commit on
   `origin/main`'s history; by default it must also be the *current* tip
   (tag pushes are strict — re-push a stale tag and it fails here). A
   `workflow_dispatch` may opt into an older main SHA only with
   `confirm_stale_ref=true`.
2. **Generated artifacts match the tree** — `npm run check:sw` re-derives
   sw.js + index.html from the current files; a stale worker (old cache
   name, old `window.__VOLT_VERSION`) fails before any tag is cut.
3. **Signing secrets configured** — `GH_TOKEN` always; `CSC_LINK` unless
   the scratch path is used.
4. **Tag matches `package.json` version** — push-only (a dispatch has no
   tag name; its version is whatever the tree says).
5. **Release certificate is a real CA cert** — `signing-setup.cjs
   check-release` refuses self-signed / expired / keyless certs. It runs
   **before** the release is pre-created, so a failed guard aborts with
   NO release created and the feed stays untouched.

After the guards: the workflow **pre-creates the GitHub release** (title +
`release-notes.md` as the body), then electron-builder builds, signs, and
publishes into it. The pre-create exists because electron-builder's GitHub
publisher races itself — the blockmap and installer artifacts resolve their
release concurrently, both see "doesn't exist", and both create one (seen
live as two releases with split assets). With one release pre-created, both
publishers reuse it; `EP_GH_IGNORE_TIME` makes retries reuse it at ANY age
(re-uploading fresh artifacts, never skipping past the 2-hour window and
never duplicating), and a stale draft is force-published so the feed can't
404. An existing release is reused only while it is empty, partial (a
crashed upload), or a draft — once it is **published with the full asset
set** (`latest.yml` + installer + `.blockmap`) it counts as genuinely
shipped and the run fails rather than overwrite artifacts users already
downloaded. `sign:check` then verifies the artifacts — a failure fails the
run (the upload already happened, so delete the release and investigate if
it ever trips). After every publish the workflow runs its own
**post-publish feed verification**: it polls the public auto-update feed
(`releases/latest/download/latest.yml` — the URL every installed copy
hits) until it answers 200 with the version that was just published, and
fails the run if it never does — a publish that reported success while
leaving the release empty or stale can't slip through unnoticed. Related
CI side: the `checks` job asserts the live feed answers 200 and — on main
pushes — that its advertised version equals the tree's `package.json`.

**The one deliberate exception — scratch unsigned releases.**
`scratch_unsigned=true` skips the certificate requirement, the cert guard,
and `sign:check` (needs only `GH_TOKEN`), publishing an UNSIGNED build to
prove the publish/feed mechanics before a real cert exists. SmartScreen
warnings + no updater signature verification, testing only — delete it
with `gh release delete v<version>` after verifying (keep the git tag).

**What still needs a real certificate.** Today `CSC_LINK` holds the
self-signed dev cert, so the pipeline is proven end-to-end up to guard 5:
live tag runs pass guards 1–4 and stop at the certificate guard with zero
releases created (the feed is still the pre-ship 404). Shipping needs a
CA-issued Authenticode cert (see `docs/signing-onboarding.md`): import it
locally with `npm run sign:setup import <your.pfx> [password]`, set the
base64 PFX + password as the `CSC_LINK` / `CSC_KEY_PASSWORD` secrets, then
re-push the `v1.0.1` tag (re-cut it at the current main tip first if main
has moved) or run the workflow from the Actions tab. That run passes all
five guards, publishes the signed `Volt-Setup-1.0.1.exe` + `latest.yml` +
`.blockmap` with the v1.0.1 notes as the release body, and the drift
check asserts the match (feed version == `package.json`) on the next main
push.

## Package release (Windows installer)

From `pdf-viewer/`, build the installer with electron-builder:

```bash
npm run dist         # full NSIS installer → dist/Volt-Setup-1.0.0.exe (+ blockmap)
npm run dist:dir     # unpacked app only → dist/win-unpacked/ (fast dev loop)
```

`npm run dist` produces a real Windows installer: `dist/Volt-Setup-<version>.exe`
— assisted install (directory choice, per-user, no admin), desktop + Start-menu
shortcuts, and the **`.pdf` file association** (electron-builder's
`build.fileAssociations` registers `Volt PDF` → the *installed* `Volt.exe`,
independent of the dev-mode registration the setup scripts make).

**Signing is automatic when a certificate is configured.** electron-builder
signs `Volt.exe`, the NSIS installer, and the uninstaller with the cert from
`CSC_LINK` — a `.pfx` path, a base64-encoded `.pfx`, or an `https://` URL —
plus `CSC_KEY_PASSWORD`; no build config needed. `WIN_CSC_LINK` /
`WIN_CSC_KEY_PASSWORD` are the Windows-specific aliases.

**The certificate flow is one command.** `npm run sign:setup`
(`scripts/signing-setup.cjs`) handles the whole lifecycle:

```bash
npm run sign:setup                        # status: configured? valid? signtool? artifacts signed?
npm run sign:setup import C:\certs\volt.pfx [password]  # adopt a real CA cert
npm run sign:setup dev-cert               # self-signed TEST cert (pipeline practice only)
npm run sign:setup trust | untrust        # trust / remove the dev root (updater runtime check)
npm run sign:setup clear                  # drop signing config
```

Credentials live in `pdf-viewer/.env` (gitignored, never commit it), which
`npm run dist` / `dist:dir` / `release` / `sign:check` / `test:release-feed`
all load through `scripts/load-env.cjs`. A real environment variable always
wins over the file, so CI secrets and one-liners (`CSC_LINK=… npm run dist`)
behave exactly as before — `.env` is just the convenient local home.

`npm run sign:check` (`scripts/check-signing.cjs`) gates the OUTPUT: with a
cert configured it fails unless `Volt.exe` **and** the installer are
Authenticode-signed by the configured publisher and the packaged
`app-update.yml` carries a matching `publisherName` (without a cert it
soft-skips — dev builds are fine unsigned). Run it after any signing build.

**To go live you still need a certificate from a CA** (DigiCert, Sectigo,
SSL.com, …) — that's an external purchase; nothing in this repo can mint a
trusted one. The full walkthrough — buying the cert, exporting the PFX,
`sign:setup import`, and pointing the CI secrets at it — lives in
[`docs/signing-onboarding.md`](../docs/signing-onboarding.md) at the repo
root. Until one is imported, builds are **unsigned**: they install and
update normally, but users see the SmartScreen "unrecognized app" warning on
first run and the updater does NOT verify signatures (no `publisherName` in
`app-update.yml`). `npm run release` refuses to run unsigned — and it also
refuses SELF-SIGNED certificates: publishing with the dev cert would hand
every user a SmartScreen warning *and* break their auto-updates (the updater
rejects untrusted chains), so `release` runs a certificate guard
(`signing-setup check-release`) that aborts on self-signed / expired /
keyless certs.

### Code signing & SmartScreen

An Authenticode signature from a real CA (DigiCert, Sectigo, …) removes the
"unknown publisher" block/warning on the installer, and — more importantly —
**arms the updater's signature verification**: the packaged `app-update.yml`
then carries the cert's `publisherName` (this is what
`win.verifyUpdateCodeSignature`, default true, does), so electron-updater
refuses to download-and-install any release *not* signed by the same
publisher (`ERR_UPDATER_INVALID_SIGNATURE`). The `release-feed` CI gate
covers exactly this: with a cert secret configured, the round-trip only
passes if the advertised installer verifies.

Honest expectations: a brand-new cert still gets a SmartScreen "unrecognized
app" warning for a while — reputation builds with consistent signed releases
and install counts. Signing also keeps signatures valid after cert expiry,
since electron-builder time-stamps every signature (RFC3161 → digicert,
pinned in `build.win.signtoolOptions`).

**Testing the whole flow without buying a cert:** `npm run sign:setup
dev-cert` mints a self-signed code-signing cert and points `.env` at it.
`npm run dist` then signs every artifact, `npm run sign:check` passes, and
the packaged `app-update.yml` carries the dev publisher — so the updater's
verification is ARMED (it rejects anything not signed by that publisher).
What a self-signed cert can't do: Windows/SmartScreen won't trust it, and the
updater's runtime check additionally requires a *trusted* chain, so `npm run
test:release-feed`'s download round-trip rejects a dev-signed exe unless you
first run `npm run sign:setup trust` (installs the dev root into
CurrentUser\Root — removable with `untrust`). That trust is local and
reversible; real users lose the SmartScreen warning only with a real CA cert.

**Current status (2026-08-16):** no production certificate is configured on
this build machine — `npm run sign:setup status` reports `NOT configured`, so
builds produced here are unsigned. The pipeline itself is fully wired and was
verified end-to-end with a self-signed dev certificate (signed build →
`sign:check` green → updater verification armed). Import a CA cert with
`npm run sign:setup import` to switch to production-signed builds.

For a modern, CI-friendly alternative to owning a PFX, **Azure Trusted
Signing** issues short-lived certs from an HSM with no password management
(electron-builder supports it via `win.azureSignOptions` + `AZURE_*` env) —
useful once distribution scales past a single release key.

**Always smoke the packaged app before distributing a build** — the asar build
is what users run, and it can fail where the dev tree passes:

```bash
# headless self-test of the packaged app (exit code is the verdict)
"./dist/win-unpacked/Volt.exe" --smoke
```

Trust the **process exit code** as the verdict (0 = pass). Capture output with
PowerShell if you want the transcript:
`Start-Process … -RedirectStandardOutput out.txt -Wait -PassThru` — note that
once the smoke *finishes* it prints `SMOKE_RESULT` and exits, so an **empty
log is a hang, not a pass**. If it hangs, first check for orphaned `Volt.exe`
processes — a killed smoke can leave Chromium children holding the disk-cache
lock that poison the next run: `taskkill /F /IM Volt.exe`.

## Auto-updates for installed users

Installed desktop builds update **themselves** — no reinstall, no manual
download. On startup (packaged builds only) `main.js` asks the release feed
whether a newer version exists; if so, it downloads it in the background and
surfaces the existing **version banner** (with the what's-new tooltip diffed
from `CHANGELOG.md`, the 15s auto-restart countdown, and the Cancel /
never-auto-restart settings). The banner's **Restart** installs and relaunches
(`autoUpdater.quitAndInstall`); simply quitting the app installs the pending
update too. The feed and updater come from `electron-updater` (a production
`dependencies` entry, so it ships inside the asar) and the `build.publish`
config, which electron-builder bakes into `app-update.yml`.

**Shipping a release to installed users:**

```bash
# from pdf-viewer/, with the version bumped (see Releasing a version).
# Once sign:setup has written .env, plain `npm run release` suffices; the
# explicit form (or CI secrets) always works too:
GH_TOKEN=$(gh auth token) CSC_LINK=C:\certs\volt.pfx CSC_KEY_PASSWORD=*** npm run release
#  → builds the installer, SIGNS it with the configured cert, PUBLISHES it +
#    latest.yml + the .blockmap to GitHub Releases. The blockmap is what
#    enables small differential updates (downloads only the changed bytes
#    instead of the whole ~120 MB app). Extra electron-builder args pass
#    through, e.g. -c.publish.provider=generic -c.publish.url=….
```

`npm run release` is `scripts/release.cjs`: it **refuses to release without a
certificate** (releasing unsigned is how SmartScreen warnings start), then
runs `electron-builder --win nsis --publish always` and exits non-zero unless
`npm run sign:check` verifies the artifacts came out signed. For unsigned
dev/private builds use `npm run dist` instead. The same artifacts land in
`dist/` for manual upload to any host.

**Distribution caveats:**

- **The repo must be readable by end users.** The GitHub provider fetches
  releases through the public GitHub API, so a *private* repo (like this one
  right now) needs either making it public, a dedicated public releases repo,
  or the generic provider. With any static web host (S3, Cloudflare, your own
  server) the publish config can be pointed at it per-build:
  `npx electron-builder --win nsis --publish always
  -c.publish.provider=generic -c.publish.url=https://your-host/volt/` — the
  client then checks `your-host/volt/latest.yml` instead of GitHub.
- `VOLT_UPDATE_URL` (an environment variable) overrides the feed at runtime
  with any generic URL — how the update flow is tested locally, and an
  enterprise escape hatch.
- **Unsigned installers trigger SmartScreen** when users first run them
  (the update download itself needs no elevation). `npm run release` now
  requires a code-signing certificate (see the Code signing section) — until
  one is configured, updates still install, users just click through the
  warning once, and the updater does NOT verify signatures (no
  `publisherName` in `app-update.yml`).
- The smoke's wiring guard sends a synthetic `volt:update-downloaded` and
  asserts the banner appears (desktop mode only), so the main→preload→
  renderer chain is regression-covered. In packaged builds the SW-based
  version check is suppressed — those apps get their updates from
  electron-updater, and the asar bundle can't change under a running app.
- **The release-feed round-trip gate** (`npm run test:release-feed`,
  `scripts/test-release-feed.mjs`) proves the REAL chain, not the stub: it
  builds the installer, publishes a scratch feed (latest.yml + the installer,
  sha512'd exactly as electron-builder writes a release), serves it over
  127.0.0.1, launches the packaged app with `--smoke-feed` and
  `VOLT_UPDATE_URL` pointing at the feed, and asserts the version banner
  appears — updater engaged, the advertised version downloaded, Restart
  visible, countdown running. The gate is headless, downloads into a
  throwaway profile (the updater cache is LOCALAPPDATA-based, so the feed
  mode re-points it there), and **never installs anything** —
  `autoInstallOnAppQuit` is disabled in feed mode, and the gate fails loudly
  if an install dir ever appears. CI runs it as the `release-feed` job;
  locally `node scripts/test-release-feed.mjs --build` (or without
  `--build` to reuse an existing `dist/`).
- **CI drift gate on the live feed.** The `checks` job's feed step verifies
  on every main push that the public feed's advertised `latest.yml` version
  equals the tree's `package.json` version (reachability HTTP 200 is
  checked on every run; the version match on main pushes only). A mismatch
  means the updater's "latest" is not what main ships — typically a
  leftover scratch release (`gh release delete v<version>`) or a version
  bump that was never tagged. Expected: CI goes red between bumping the
  version and shipping the tag, and green again once the release publishes.

Two build gotchas, both already handled in this repo — keep them in mind when
touching the build config:

1. **`scripts/**/*` must be in `build.files`.** `main.js` requires
   `scripts/file-watcher.cjs` and `scripts/vendor-recovery.cjs` at load; if
   the folder is missing from the asar, the packaged app dies silently at
   startup (before the smoke watchdog even arms) — it will not print anything,
   just sit there.
2. **winCodeSign extraction can fail on non-admin Windows** — app-builder
   extracts it with `7za -snld` and two darwin `.dylib` symlinks in the
   archive require `SeCreateSymbolicLinkPrivilege`, which a non-elevated
   session lacks ("Cannot create symbolic link…"). The fix needs no admin:
   extract the archive yourself without symlinks into the exact directory
   app-builder checks. First **run the build once** (it downloads the archive,
   then fails on extraction), then in `%LOCALAPPDATA%/electron-builder/Cache/`
   under `winCodeSign/` run
   `7za x -y -o<Cache>/winCodeSign/winCodeSign-<ver> <Cache>/winCodeSign/<hash>.7z`
   (any `7za.exe` works, e.g. `node_modules/7zip-bin/win/x64/7za.exe`; the
   `<ver>`/`<hash>` come from the just-downloaded files) — the archive's
   darwin symlinks become inert regular files, and app-builder's `os.Stat`
   cache check (directory-existence only) then skips its own failing
   extraction. Do not re-extract with `-snld`, and don't "fix" it by deleting
   the darwin folder or otherwise trimming the extracted tree — the cache
   check keys on the directory's presence, so keep the extraction intact.

