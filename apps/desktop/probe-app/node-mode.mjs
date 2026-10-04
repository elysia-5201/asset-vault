// 用 ELECTRON_RUN_AS_NODE=1 跑：验证 Electron 运行时下原生模块与服务能否工作（不经 GUI）
const out = [];
const log = (s) => { out.push(s); };
log("electron=" + process.versions.electron + " node=" + process.versions.node + " modules=" + process.versions.modules);
try { const D = (await import("better-sqlite3")).default; const db = new D(":memory:"); db.exec("create table t(x)"); log("better-sqlite3: OK"); } catch (e) { log("better-sqlite3: FAIL " + String(e && e.message).slice(0, 160)); }
try { const s = (await import("sharp")).default; await s({ create: { width: 4, height: 4, channels: 3, background: "red" } }).jpeg().toBuffer(); log("sharp: OK"); } catch (e) { log("sharp: FAIL " + String(e && e.message).slice(0, 160)); }
try {
  const m = await import("../build/server.mjs");
  const h = await m.startAssetVault({ port: 7331, host: "127.0.0.1", dataDir: "%APP_DIR%\\data-probe" });
  const r = await fetch(h.url + "/api/health");
  const j = await r.json();
  log("server: OK " + h.url + " items=" + j.counts.items + " avatars=" + j.counts.avatars);
  await h.close();
} catch (e) { log("server: FAIL " + String((e && e.stack) || e).slice(0, 400)); }
console.log(out.join("\n"));
process.exit(0);
