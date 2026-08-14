// Minimal static file server (no dependencies).
// Usage: node serve.mjs [port]
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { renderSw, cacheName, renderIndexHtml, writeArtifacts } from "./scripts/gen-sw.mjs";

const root = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.argv[2]) || 8421;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".pdf": "application/pdf",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

// Keep the on-disk derived artifacts (sw.js + stamped index.html) fresh for
// packaged/Electron/static use whenever the dev server runs — cheap to
// regenerate, and the smoke's artifact-contract stages depend on them.
try {
  writeArtifacts(); // index.html first (stamps feed the shell hash), then sw.js
  console.log("sw.js + index.html regenerated — cache " + cacheName());
} catch (e) {
  console.log("! could not regenerate sw.js/index.html: " + ((e && e.message) || e));
}

createServer(async (req, res) => {
  try {
    let path = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (path === "/") path = "/index.html";
    // sw.js is rendered on EVERY request from the current files on disk, with
    // no caching headers, so the browser's worker-update check always sees the
    // latest cache name — a dev edit to app.js takes effect on the next reload
    // instead of serving the stale cached copy.
    if (path === "/sw.js") {
      const sw = renderSw();
      res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-cache, no-store" });
      res.end(sw);
      return;
    }
    // index.html is rendered on EVERY request too: the ?v= stamps are recomputed
    // from the current files on disk, so a dev edit to app.js/css lands on the
    // next reload (fresh stamps → the browser refetches), and the no-cache
    // header keeps the shell itself from being heuristically cached — the same
    // freshness contract sw.js has. The stamped copy is also written to disk at
    // startup (above) so static/packaged deployments carry it.
    if (path === "/" || path === "/index.html") {
      const html = renderIndexHtml();
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache, no-store" });
      res.end(html);
      return;
    }
    const file = normalize(join(root, path));
    if (!file.startsWith(root)) throw Object.assign(new Error("forbidden"), { code: 403 });
    const data = await readFile(file);
    res.writeHead(200, { "Content-Type": MIME[extname(file)] || "application/octet-stream" });
    res.end(data);
  } catch (e) {
    res.writeHead(e.code === 403 ? 403 : 404);
    res.end(e.code === 403 ? "forbidden" : "not found");
  }
}).listen(port, () => {
  console.log(`Volt → http://localhost:${port}`);
});
