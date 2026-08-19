// ═══════════════════════════════════════════════════════════════
//   Volt — preload bridge (Electron)
//   The renderer is sandboxed (no Node access), so files handed off
//   by the OS — double-clicking a .pdf, or dragging one onto a
//   running window — arrive as paths in the main process and are
//   pulled here over this narrow, explicit API:
//     readFile(path) → { name, size, data: ArrayBuffer }
//     onOpenPath(cb) → subscribe to files the OS hands to the app
//     ready()        → tell main the listener is live (flush queue)
//     onVendorUpdated(cb) → background updater applied a new vendored lib
//     watchFile(path) / unwatchFile() → watch the open PDF on disk; when it
//       changes (the author re-exported it) onFileChanged fires with
//       { path, missing } so the renderer can offer a reload
//   ═══════════════════════════════════════════════════════════════ */
"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("voltDesktop", {
  readFile: (path) => ipcRenderer.invoke("volt:read-file", path),
  writeFile: (path, buffer) => ipcRenderer.invoke("volt:write-file", path, buffer),
  openWith: (name, buffer) => ipcRenderer.invoke("volt:open-with", name, buffer),
  pickPdf: () => ipcRenderer.invoke("volt:pick-pdf"),
  pickPfx: () => ipcRenderer.invoke("volt:pick-pfx"),
  readPfx: (path) => ipcRenderer.invoke("volt:read-pfx", path),
  openUrl: (url) => ipcRenderer.invoke("volt:open-url", url),
  runSetupTasks: () => ipcRenderer.invoke("volt:setup-tasks"),
  onOpenPath: (callback) => ipcRenderer.on("volt:open-path", (_event, path) => callback(path)),
  onVendorUpdated: (callback) => ipcRenderer.on("volt:vendor-updated", (_event, data) => callback(data)),
  watchFile: (path) => ipcRenderer.invoke("volt:watch-file", path),
  unwatchFile: () => ipcRenderer.invoke("volt:unwatch-file"),
  onFileChanged: (callback) => ipcRenderer.on("volt:file-changed", (_event, data) => callback(data)),
  installOllama: (origins) => ipcRenderer.invoke("volt:install-ollama", origins),
  onOllamaInstall: (callback) => ipcRenderer.on("volt:ollama-install", (_event, data) => callback(data)),
  setOllamaOrigins: (value) => ipcRenderer.invoke("volt:set-ollama-origins", value),
  checkOllamaCors: () => ipcRenderer.invoke("volt:check-ollama-cors"),
  spawnPrivateOllama: (origins, port) => ipcRenderer.invoke("volt:spawn-private-ollama", origins, port),
  stopPrivateOllama: () => ipcRenderer.invoke("volt:stop-private-ollama"),
  restart: () => ipcRenderer.invoke("volt:restart"),
  quit: () => ipcRenderer.invoke("volt:quit"),
  checkForUpdates: () => ipcRenderer.invoke("volt:check-for-updates"),
  appInfo: () => ipcRenderer.invoke("volt:app-info"),
  updatePrefs: (prefs) => ipcRenderer.invoke("volt:update-prefs", prefs),
  downloadUpdate: () => ipcRenderer.invoke("volt:download-update"),
  onUpdateDownloaded: (callback) => ipcRenderer.on("volt:update-downloaded", (_event, data) => callback(data)),
  onUpdateAvailable: (callback) => ipcRenderer.on("volt:update-available", (_event, data) => callback(data)),
  ready: () => ipcRenderer.send("volt:renderer-ready"),
});
