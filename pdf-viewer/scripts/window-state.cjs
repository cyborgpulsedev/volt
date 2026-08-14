// Window-bounds persistence for the Volt desktop window — pure Node (no
// Electron imports) so the validation logic is unit-testable in plain Node.
//
// The main process saves the window's normal bounds plus its maximized flag
// on resize/move (debounced) and on close, and restores them on the next
// launch instead of always resetting to the default 1280x900. The saved
// position is validated against the CURRENT display layout: a window saved
// on a monitor that has since been unplugged must not be restored off-screen
// where it can never be reached again.
"use strict";

const { readFileSync, writeFileSync } = require("node:fs");

const MIN_W = 900;     // must match BrowserWindow minWidth in main.js
const MIN_H = 600;     // must match BrowserWindow minHeight in main.js
const MIN_VIS_W = 100; // at least this much of the window must land on a display
const MIN_VIS_H = 40;

/** Validate a parsed window-state object against the current display layout.
    Returns { x, y, width, height, maximized } or null when unusable — null
    means "fall back to the default window". */
function normalizeState(raw, displays) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const x = Math.round(Number(raw.x));
  const y = Math.round(Number(raw.y));
  const width = Math.round(Number(raw.width));
  const height = Math.round(Number(raw.height));
  if (![x, y, width, height].every(Number.isFinite)) return null; // NaN / non-numeric
  if (width < MIN_W || height < MIN_H) return null;               // below the resizable floor
  if (!Array.isArray(displays) || displays.length === 0) return null;
  const onScreen = displays.some((d) => {
    const wa = d.workArea;
    if (!wa || !Number.isFinite(wa.x) || !Number.isFinite(wa.y) ||
        !Number.isFinite(wa.width) || !Number.isFinite(wa.height)) return false;
    const vw = Math.min(x + width, wa.x + wa.width) - Math.max(x, wa.x);
    const vh = Math.min(y + height, wa.y + wa.height) - Math.max(y, wa.y);
    return vw >= MIN_VIS_W && vh >= MIN_VIS_H;
  });
  if (!onScreen) return null; // monitor layout changed — position unreachable
  return { x, y, width, height, maximized: !!raw.maximized };
}

/** Load + validate a saved window-state file. Missing, corrupt, or unusable
    state → null (the caller falls back to the default window). */
function loadState(file, displays) {
  try {
    return normalizeState(JSON.parse(readFileSync(file, "utf8")), displays);
  } catch (e) {
    return null;
  }
}

/** Persist the current window state: the NORMAL (un-maximized) bounds — the
    correct restore size even while the window is maximized — plus the flag.
    A failed write is swallowed: it must never block the app or a quit. */
function saveState(file, win) {
  try {
    const b = win.getNormalBounds();
    writeFileSync(file, JSON.stringify({
      x: Math.round(b.x), y: Math.round(b.y),
      width: Math.round(b.width), height: Math.round(b.height),
      maximized: !!win.isMaximized(),
    }));
  } catch (e) { /* best effort — never block on a state write */ }
}

module.exports = { normalizeState, loadState, saveState, MIN_W, MIN_H };
