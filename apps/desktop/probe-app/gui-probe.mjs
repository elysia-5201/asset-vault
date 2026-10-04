// GUI 模式启动探针：逐步写日志，定位 whenReady 卡点
import { app, BrowserWindow } from "electron";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
const LOG = "%APP_DIR%\\logs\\gui-probe.log";
try { mkdirSync(dirname(LOG), { recursive: true }); } catch { /* ignore */ }
const w = (s) => { try { appendFileSync(LOG, new Date().toISOString() + " " + s + "\n"); } catch { /* ignore */ } };
w("module loaded");
w("before whenReady; isReady=" + app.isReady());
app.on("ready", () => w("event: ready"));
app.whenReady().then(() => {
  w("whenReady resolved");
  try {
    const win = new BrowserWindow({ width: 700, height: 460, show: true });
    win.loadURL("data:text/html,<h1 style='font:2rem sans-serif'>AssetVault probe OK</h1>");
    w("window created");
  } catch (e) { w("window FAILED: " + String((e && e.message) || e).slice(0, 300)); }
  setTimeout(() => { w("exiting"); app.exit(0); }, 2500);
});
setTimeout(() => { w("TIMEOUT 25s: never ready"); app.exit(3); }, 25000);
