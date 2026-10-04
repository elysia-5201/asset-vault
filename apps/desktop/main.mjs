// AssetVault 桌面壳（Electron 主进程）。
// 顺序很重要：①单实例锁（第二实例只转交 URL 后立刻退出，绝不再起服务/DB）②起 HTTP 服务 ③等 GUI ready 再建窗口。
import { app, BrowserWindow, Menu, Notification, dialog, shell } from "electron";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync, mkdirSync, appendFileSync } from "node:fs";

const PROTOCOL = "booth-library-manager";
const SERVER_ONLY = process.argv.includes("--server-only");
const here = dirname(fileURLToPath(import.meta.url));
const isPackaged = app.isPackaged;

function pickDataDir() {
  if (process.env.ASSETVAULT_DATA) return process.env.ASSETVAULT_DATA;
  const exeDir = dirname(app.getPath("exe"));
  for (const c of [join(exeDir, "data"), join(exeDir, "..", "..", "data")]) { try { if (existsSync(c)) return c; } catch { /* ignore */ } }
  const portable = join(exeDir, "data");
  try { mkdirSync(portable, { recursive: true }); return portable; } catch { return join(app.getPath("userData"), "data"); }
}

const dataDir = pickDataDir();
const logsDir = join(dirname(app.getPath("exe")), "logs");
try { mkdirSync(logsDir, { recursive: true }); } catch { /* ignore */ }
function logLine(s) { const line = "[" + new Date().toISOString() + "] " + s; try { appendFileSync(join(logsDir, "desktop.log"), line + "\n"); } catch { /* ignore */ } if (process.env.ASSETVAULT_VERBOSE) console.log(line); }

/** 从命令行参数里挑出协议 URL（Windows 部分调用路径会带外围引号，先剥掉）。 */
function protocolUrlFromArgv(argv) {
  return (argv || []).map((a) => String(a).replace(/^"+|"+$/g, "").trim())
    .find((a) => a.toLowerCase().startsWith(PROTOCOL + "://")) ?? null;
}

// ① 单实例锁必须在起服务之前：第二实例只负责让系统把 URL 转发给已运行实例
const isFirstInstance = SERVER_ONLY ? true : app.requestSingleInstanceLock();
logLine("booting; packaged=" + isPackaged + " serverOnly=" + SERVER_ONLY + " firstInstance=" + isFirstInstance + " data=" + dataDir + " argv=" + JSON.stringify(process.argv.slice(1)));
if (!isFirstInstance) {
  logLine("second instance: handing off and exiting (no server, no db)");
  app.quit();
} else {
  if (isPackaged && !SERVER_ONLY) {
    try {
      if (process.defaultApp && process.argv.length >= 2) app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [here]);
      else app.setAsDefaultProtocolClient(PROTOCOL);
      logLine("protocol registered: " + PROTOCOL);
    } catch (e) { logLine("protocol registration failed: " + String((e && e.message) || e)); }
  }

  let win = null;
  let handle = null;
  let pendingUrl = null;

  async function startServer() {
    const mod = await import(pathToFileURL(join(here, "build", "server.mjs")).href);
    const appRoot = app.getAppPath();
    let lastErr = null;
    for (const port of [7317, 7318, 7319, 7320, 7321]) {
      try {
        return await mod.startAssetVault({
          port, host: "127.0.0.1", dataDir, version: app.getVersion(), onLog: logLine, logsDir,
          webDistDir: join(appRoot, "apps", "web", "dist"),
          seedFile: join(appRoot, "config", "avatars.seed.json"),
          schemaFile: join(here, "build", "schema.sql"),
        });
      } catch (e) { lastErr = e; logLine("port " + port + " failed: " + String((e && e.message) || e)); }
    }
    throw lastErr ?? new Error("no free port");
  }

  function createWindow(url) {
    win = new BrowserWindow({
      width: 1560, height: 980, minWidth: 1100, minHeight: 700, backgroundColor: "#0f1115",
      title: "AssetVault 资源库", webPreferences: { contextIsolation: true, nodeIntegration: false },
    });
    win.loadURL(url);
    win.on("closed", () => { win = null; });
    win.webContents.setWindowOpenHandler(({ url: u }) => { void shell.openExternal(u); return { action: "deny" }; });
    logLine("window created");
  }

  function buildMenu() {
    try {
      Menu.setApplicationMenu(Menu.buildFromTemplate([
        { label: "文件", submenu: [
          { label: "打开数据目录", click: () => void shell.openPath(dataDir) },
          { label: "打开下载目录", click: async () => { try { const r = await fetch(handle.url + "/api/settings"); const s = await r.json(); void shell.openPath(s.downloadRoot); } catch { /* ignore */ } } },
          { type: "separator" }, { role: "reload" }, { role: "toggleDevTools" }, { type: "separator" }, { role: "quit", label: "退出" },
        ] },
        { label: "帮助", submenu: [{ label: "关于", click: () => void dialog.showMessageBox({ message: "AssetVault", detail: "数据目录: " + dataDir + "\n服务: " + (handle ? handle.url : "-") }) }] },
      ]));
    } catch { /* ignore */ }
  }

  function notify(title, body) { try { new Notification({ title, body }).show(); } catch { /* ignore */ } logLine("notify: " + title + " | " + body); }

  async function handleProtocolImport(rawUrl) {
    if (!handle) { pendingUrl = rawUrl; return; }
    logLine("protocol import: " + String(rawUrl).slice(0, 140));
    try {
      const res = await fetch(handle.url + "/api/import/download", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ protocolUrl: rawUrl }) });
      const json = await res.json();
      if (!res.ok) { notify("导入失败", (json.error && json.error.message) || ("HTTP " + res.status)); return; }
      notify("已下载并入库", json.fileName + " (" + Math.round(json.bytes / 1048576) + " MB)");
      if (win) win.webContents.reload();
    } catch (e) { notify("导入失败", String((e && e.message) || e)); }
  }

  if (!SERVER_ONLY) {
    app.on("second-instance", (_e, argv) => {
      logLine("second-instance argv=" + JSON.stringify(argv));
      const url = protocolUrlFromArgv(argv);
      if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
      if (url) void handleProtocolImport(url);
    });
    app.on("open-url", (e, url) => { e.preventDefault(); void handleProtocolImport(url); });
  }

  // ② 先起服务（不依赖 GUI）
  const serverPromise = startServer();
  serverPromise.then((h) => {
    handle = h;
    logLine("server up: " + h.url);
    const u = pendingUrl ?? protocolUrlFromArgv(process.argv);
    pendingUrl = null;
    if (u) void handleProtocolImport(u);
  }).catch((e) => { logLine("server startup failed: " + String((e && e.stack) || e)); if (!SERVER_ONLY) dialog.showErrorBox("AssetVault 启动失败", String((e && e.message) || e)); app.quit(); });

  // ③ 等 GUI ready 再建窗口（这台机器冷启动约 20-50s，属正常）
  if (!SERVER_ONLY) {
    const readyTimeout = setTimeout(() => logLine("WARN: app ready not reached in 20s (window not shown yet; server keeps running)"), 20000);
    app.whenReady().then(() => {
      clearTimeout(readyTimeout);
      logLine("app ready");
      serverPromise.then(() => { try { if (!win) { createWindow(handle.url); buildMenu(); } } catch (e) { logLine("window failed: " + String((e && e.message) || e)); } });
    }).catch((e) => logLine("whenReady rejected: " + String((e && e.stack) || e)));
  }

  app.on("window-all-closed", () => { void shutdown(); });
  let shuttingDown = false;
  async function shutdown() {
    if (shuttingDown) return; shuttingDown = true;
    try { const h = await serverPromise; await h.close(); } catch { /* ignore */ }
    app.quit();
  }
}
