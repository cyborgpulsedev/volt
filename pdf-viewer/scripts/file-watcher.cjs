// ═══════════════════════════════════════════════════════════════
//   file-watcher.cjs — poll-based file watcher
//   Watches one file on disk and fires when its content changes
//   (mtime or size). Polling instead of fs.watch because editors
//   commonly "save" via temp-file + rename (which breaks fs.watch
//   handles) and network/cloud-synced folders report unreliable
//   watch events — a stat loop is the one mechanism that behaves
//   the same everywhere. The update the app cares about (the author
//   re-exported the PDF) is a write that settles in under a second.
//
//   Fires:
//     { missing: false }  — content changed (mtime/size) and the
//                           write is stable (unchanged across one
//                           full poll interval, so mid-write states
//                           are never reported)
//     { missing: true }   — the file disappeared (delete / rename
//                           away); reappearance is reported as a
//                           normal change
//   Notifications are never thrown from; stop() is idempotent.
//   ═══════════════════════════════════════════════════════════════ */
"use strict";

const { statSync } = require("node:fs");

class FileWatcher {
  /**
   * @param {string} path        file to watch
   * @param {(data: {missing: boolean}) => void} onChange
   * @param {{intervalMs?: number}} [opts]
   */
  constructor(path, onChange, opts = {}) {
    if (typeof path !== "string" || !path) throw new Error("FileWatcher: path required");
    this.path = path;
    this.onChange = onChange;
    this.intervalMs = opts.intervalMs || 800;
    this._timer = null;
    this._last = null;      // {mtimeMs, size} of the last reported state
    this._missing = false;  // currently absent from disk
    this._candidate = null; // a change awaiting stability confirmation
    this._running = false;
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._snapshot(); // baseline — never fires for the initial state
    this._timer = setInterval(() => this._poll(), this.intervalMs);
    if (this._timer.unref) this._timer.unref(); // never keep a process alive
  }

  stop() {
    this._running = false;
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    this._candidate = null;
  }

  _snapshot() {
    try {
      const s = statSync(this.path);
      this._last = { mtimeMs: s.mtimeMs, size: s.size };
      this._missing = false;
    } catch (e) {
      this._last = null;
      this._missing = true;
    }
  }

  _poll() {
    let cur = null;
    try {
      const s = statSync(this.path);
      cur = { mtimeMs: s.mtimeMs, size: s.size };
    } catch (e) { cur = null; }

    if (this._missing && cur) {
      // reappeared — a save-over via rename, or the file was re-created.
      // Arm the candidate and wait one full interval so a still-writing
      // re-creation settles before it is reported.
      this._missing = false;
      this._candidate = cur;
      return;
    }
    if (!this._missing && !cur) {
      // present → gone. Report once, immediately (no stability wait: a
      // missing file is already final).
      this._missing = true;
      this._last = null;
      this._candidate = null;
      this._notify({ missing: true });
      return;
    }
    if (this._candidate) {
      // a change is pending from a previous poll: either it has settled
      // (fresh read still matches the candidate → report it) or it is still
      // being written (supersede the candidate and restart the clock).
      if (this._sameStat(this._candidate, cur)) {
        const settled = this._candidate;
        this._candidate = null;
        this._last = settled;
        this._notify({ missing: false });
      } else {
        this._candidate = cur;
      }
      return;
    }
    if (this._last && (cur.mtimeMs !== this._last.mtimeMs || cur.size !== this._last.size)) {
      // changed from the last reported state — arm the candidate and return
      // for THIS poll: a candidate armed from this poll's stat must never be
      // confirmed against the same stat in the same poll (that would report
      // mid-write states immediately). Stability is only provable on a later
      // poll, when a fresh read still matches the candidate.
      this._candidate = cur;
    }
  }

  _sameStat(a, b) {
    return a && b && a.mtimeMs === b.mtimeMs && a.size === b.size;
  }

  _notify(data) {
    try { if (this.onChange) this.onChange(data); } catch (e) { /* a watcher callback must never throw */ }
  }
}

module.exports = FileWatcher;
module.exports.FileWatcher = FileWatcher;
