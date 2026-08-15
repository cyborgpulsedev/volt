# Weekly Review — 2026-08-15

First review of this file. No prior delta to report.

## Verdict

**Shippable core, one packaging landmine, test debt concentrated in one file.**
All work through today is committed (`2fcdaca`, 21 files / +4,351 — office export,
release+signing pipeline, CI workflow, annotations, markdown list fix). Tree clean.

## Verified this session

| Claim | Check | Result |
|---|---|---|
| Unit gates | `npm run test:utils` | 118/118 (incl. 7 new markdown-list regressions) |
| Office export | `npm run test:office` | 53/53 |
| SW/artifact freshness | `npm run test:artifacts` (Electron smoke ×3) | 17/17 |
| File watcher | `npm run test:watch` | 9/9 |
| Auto-update | `npm run test:release-feed` | full round-trip: feed → download 2.0.0 → banner |
| OCR / voice / office wired | index.html script stamps | reachable (ocr.js:1574, voice.js:1575, office-export.js) |

DRIFT 0 · HALLUCINATION 0 · BROKEN 1 (markdown `</ul>`-always bug — **fixed + committed today**).

## Findings → queued work

1. **[blocker-at-package-time] `pdf-viewer/CON` exists on disk** — a reserved Windows
   device name. `electron-builder`/NSIS packaging and plain `Copy-Item` recursion choke
   on it. It is gitignored but still present. Delete via extended-length path:
   `cmd /c del "\\?\C:\Users\bbhat\Freebuff\Volt\pdf-viewer\CON"`. Verify `npm run dist:dir`
   completes afterward.
2. **[test-debt] `js/app.js` is 5,228 lines with zero direct tests** — the tested code
   (utils/office/watcher) is the code that stayed correct; the untested monolith is where
   the markdown bug lived. Don't chase coverage %: extract the next 3 pure functions you
   touch into `utils.js` (tested) as you go. Convention, not campaign.
3. **[verify-before-claiming] README claims signed releases** — `check:signing` exists but
   no cert is configured on this machine; `npm run sign:check` should be run and its
   honest result recorded in README (unsigned dev builds are fine — claiming otherwise isn't).

## Plan-defect note (why the bug survived)

No plan/criteria system exists in this repo (no `.planning/`). The `</ul>` bug survived
because "markdown renders" was never a falsifiable criterion anywhere. The artifact-test
pattern (test:artifacts fails on stale sw.js) is the house standard — extend that reflex:
**any user-visible behavior claimed in README gets one runnable check.**

## Forecast

No deadline. v1.0.0 is honestly releasable as unsigned dev build once finding 1 is
cleared (minutes). **On track.**

## Next actions (executor-ready, in order)

1. Delete `CON` (finding 1), run `npm run dist:dir`, confirm it packages.
2. Run `npm run sign:check`; record result in README's release section.
3. Adopt finding 2's extraction convention on the next app.js touch.

---

## 2026-08-15 execution (overnight session)

Three user-reported problems fixed and committed (`4a08ed9`).

**Annotations landed off the text they marked.** Root cause was not the quad
math (that measured correct to 0.8px). A `<canvas>` is a *replaced* element, so
`inset: 0` positions but cannot stretch it — its CSS size came from the
width/height *attributes*, which `renderOverlay` set to viewport × dpr. At
devicePixelRatio 1 that was right by coincidence; on a scaled Windows display
(125%/150%) the overlay rendered dpr× too large while the canvas context drew
into it 1:1. Measured at dpr 1.5: a highlight expected at (169.7, 308.6) drew at
(254.6, 462.9) — **+85px right, +154px down mid-page, worsening downward**.
The overlay now sets its CSS size explicitly like `.page-canvas` always has.
Verified 0.0px error at dpr 1 / 1.25 / 1.5 / 2.

**Chrome off-screen even maximized.** Collapsed panes slide out on a negative
margin and nothing clipped them, so a hidden AI panel left the document 340px
wider than the viewport. `#main` now clips — with **`overflow: clip`, not
`hidden`**: `hidden` also makes the element a scroll container, which let a
focus/scrollIntoView scroll the pane and shift every page-local coordinate
(that variant broke the smoke's area-highlight stage, which is how the
distinction surfaced).

**Sidebar resizing** added, mirroring the AI panel exactly (drag / arrows /
double-click reset / persisted / hidden while collapsed). Both panes now
recompute fit-width zoom on resize. The separate "Volt." wordmark is gone.

**New regression gate:** the smoke asserts the overlay's CSS box equals the
wrap's box at simulated dpr 1/1.25/1.5/2 — CI runs at dpr 1 and could never
have caught this class otherwise.

**Open item:** `test:artifacts` reports 16/17, failing on the auto-update stage
(`updateAvail.dlReEnabled` / `errToast`). A boolean-level diff of the full smoke
result against HEAD found **no field that passed before and fails now**, and that
stage is download/toast-timing sensitive while this machine was running a
local-LLM job all night. Re-run `npm run test:artifacts` on an idle machine and
confirm 17/17 before cutting a release.
