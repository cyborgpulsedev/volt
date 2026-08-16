// Throwaway integration test for Volt's single-instance lock + file forwarding.
// Run:  electron scripts/test-second-instance.js              (instance A)
//       electron scripts/test-second-instance.js <some.pdf>   (instance B)
// A appends SECOND_INSTANCE pdf=<path> to /tmp/volt-inst-a.log and exits 0.
"use strict";
const { app } = require("electron");
const { appendFileSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");

const log = (s) => { try { appendFileSync(join(tmpdir(), "volt-inst-a.log"), s + "\n"); } catch (e) {} };

const got = app.requestSingleInstanceLock();
if (got) {
  log("A_READY");
  app.on("second-instance", (_e, argv) => {
    const f = (argv || []).find((a) => a && /\.pdf$/i.test(a));
    log("SECOND_INSTANCE pdf=" + (f || "(none)"));
    app.exit(f ? 0 : 1);
  });
  app.whenReady().then(() => setTimeout(() => { log("A_TIMEOUT"); app.exit(2); }, 20000));
} else {
  app.exit(1);
}
