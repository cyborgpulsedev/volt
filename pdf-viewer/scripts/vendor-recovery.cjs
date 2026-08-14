// ═══════════════════════════════════════════════════════════════
//   Volt — interrupted-vendor-update recovery
//   update-vendor.mjs sets vendor/.update-pending before swapping
//   files and clears it only after the smoke gate + commit finish
//   (or a rollback). If the app is quit or killed inside that window
//   — normal X-button quit while the background auto-update is mid
//   gate — the flag + the .backup dir survive, and the next launch
//   restores the previous (known-good) vendor BEFORE the renderer
//   ever loads, so the app can never boot against half-swapped files.
//   ═══════════════════════════════════════════════════════════════ */
"use strict";

const fs = require("node:fs");
const { join } = require("node:path");

const VENDOR_FILES = ["pdf.min.mjs", "pdf.worker.min.mjs", "pdf-lib.min.js"];

/** Restore the previous vendor if an update was interrupted. Returns true if
    a recovery happened. Idempotent; never throws (caller wraps anyway). */
function recoverInterruptedVendorUpdate(appRoot) {
  const vendorDir = join(appRoot, "vendor");
  const flag = join(vendorDir, ".update-pending");
  if (!fs.existsSync(flag)) return false;
  const backup = join(vendorDir, ".backup");
  try {
    if (fs.existsSync(backup)) {
      for (const f of VENDOR_FILES) {
        const bk = join(backup, f);
        if (fs.existsSync(bk)) fs.copyFileSync(bk, join(vendorDir, f));
      }
      fs.rmSync(backup, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(flag, { force: true });
  }
  return true;
}

module.exports = { recoverInterruptedVendorUpdate, VENDOR_FILES };
