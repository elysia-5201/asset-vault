// The sandboxed renderer can resolve dropped files or request a staged archive entry.
const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("assetVaultDesktop", {
  getPathForFile: (f) => {
    try {
      const p = webUtils.getPathForFile(f);
      return typeof p === "string" && p !== "" ? p : null;
    } catch {
      return null;
    }
  },
  prepareArchiveDrag: (entry) => ipcRenderer.invoke("archive-drag:prepare", entry),
  startArchiveDrag: (token) => ipcRenderer.invoke("archive-drag:start", token),
  chooseImportFolder: (defaultPath) => ipcRenderer.invoke("import-folder:choose", defaultPath),
});
