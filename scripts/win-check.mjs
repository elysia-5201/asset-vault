// Windows 侧依赖自检：在 <drive>:\tool\asset-vault 下运行
const out = [];
const check = async (name, fn) => { try { out.push(`${name}: OK ${await fn()}`); } catch (e) { out.push(`${name}: FAIL ${String(e && e.message || e).slice(0, 240)}`); } };
await check("node", () => process.version);
await check("better-sqlite3", async () => {
  const { default: D } = await import("better-sqlite3");
  const db = new D(":memory:");
  db.pragma("journal_mode = WAL");
  db.exec("CREATE TABLE t(x); CREATE VIRTUAL TABLE ft USING fts5(a, tokenize=trigram)");
  db.prepare("INSERT INTO t VALUES (?)").run(1);
  db.prepare("INSERT INTO ft VALUES (?)").run("ミルフィ対応 テクスチャ");
  const hit = db.prepare("SELECT count(*) c FROM ft WHERE ft MATCH ?").get("ルフィ").c;
  const tx = db.transaction(() => { db.prepare("INSERT INTO t VALUES (?)").run(2); });
  tx();
  const n = db.prepare("SELECT count(*) c FROM t").get().c;
  db.close();
  return `sqlite ${n} rows, fts5(trigram) hit=${hit}`;
});
await check("sharp", async () => { const s = (await import("sharp")).default; const buf = await s({ create: { width: 8, height: 8, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 1 } } }).webp().toBuffer(); return `webp ${buf.length}B`; });
await check("7zip-bin", async () => { const b = (await import("7zip-bin")).default; return b.path7za; });
await check("node-unrar-js", async () => { const m = await import("node-unrar-js"); return typeof m.createExtractorFromData === "function" ? "createExtractorFromData" : Object.keys(m).join(","); });
await check("chokidar", async () => { const m = await import("chokidar"); return typeof m.watch === "function" ? "watch()" : "?"; });
await check("fastify", async () => { const m = await import("fastify"); return typeof m.default === "function" ? "factory ok" : "?"; });
console.log(out.join("\n"));
