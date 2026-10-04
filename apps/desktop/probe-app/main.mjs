import { app } from "electron";
import { appendFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const LOG = "%APP_DIR%\\logs\\probe.log";
try { mkdirSync(dirname(LOG), { recursive: true }); } catch {}
const w = (s) => { try { appendFileSync(LOG, new Date().toISOString() + " " + s + "\n"); } catch {} };
w("module loaded; electron=" + process.versions.electron + " node=" + process.versions.node + " modules=" + process.versions.modules);
await app.whenReady();
w("app ready");
try {
  const m = await import(join(here, "..", "build", "server.mjs"));
  w("server bundle imported: " + Object.keys(m).join(","));
  try {
    const h = await m.startAssetVault({ port: 7317, host: "127.0.0.1", dataDir: "%APP_DIR%\\data-probe", onLog: (l) => w("srv " + l) });
    w("server up: " + h.url);
  } catch (e) { w("startAssetVault FAILED: " + String((e && e.stack) || e).slice(0, 900)); }
} catch (e) { w("import FAILED: " + String((e && e.stack) || e).slice(0, 900)); }
setTimeout(() => app.exit(0), 1500);
