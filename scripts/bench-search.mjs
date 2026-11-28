import { mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { cpus, release, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as wait } from "node:timers/promises";
import Database from "better-sqlite3";
import { Repo } from "../apps/server/src/db/repo.ts";
import { openDatabase } from "../apps/server/src/db/migrate.ts";
import { drainSearchIndex, enqueueSearchBackfill, searchIndexStatus, startSearchIndexWorker } from "../apps/server/src/services/search-index.ts";
import { runCachedSearchRead } from "../apps/server/src/services/search-reader.ts";

const [output = ".worktrees", sizes = "10000,50000,100000"] = process.argv.slice(2);
mkdirSync(resolve(output), { recursive: true });
const directory = mkdtempSync(join(resolve(output), "search-bench-"));
const seedDate = "2026-01-01T00:00:00.000Z";
const report = { node: process.version, os: process.platform + " " + release(), cpu: cpus()[0]?.model.trim(),
  logicalCpus: cpus().length, ramBytes: totalmem(), scenarios: [] };
const queryNames = ["7000041", "嵐の仕立屋 goth set 00041", "黑色", "goth", "avatar:Manuka type:clothing", "file:*.fbx", "file:layer_00041.mat"];

function stats(samples) {
  const sorted = samples.toSorted((a, b) => a - b);
  const quantile = (p) => +sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)].toFixed(3);
  return { samples: samples.length, p50Ms: quantile(0.5), p95Ms: quantile(0.95), p99Ms: quantile(0.99) };
}

function measure(call, repeats = 24) {
  const cpu = process.cpuUsage();
  const wall = performance.now();
  const rows = [];
  let previous, cacheHits = 0;
  for (let run = 0; run < repeats; run++) {
    const then = performance.now();
    const result = call();
    if (result === previous) cacheHits++;
    previous = result;
    rows.push({ ms: performance.now() - then, count: result.total ?? result.length });
  }
  return { ...stats(rows.map((r) => r.ms)), count: rows[0].count, cacheHits, wallMs: +(performance.now() - wall).toFixed(2),
    cpuMs: +(Object.values(process.cpuUsage(cpu)).reduce((a, b) => a + b, 0) / 1000).toFixed(2) };
}

for (const size of sizes.split(",").map(Number)) {
  if (!Number.isSafeInteger(size) || size < 100 || size > 100_000) throw new Error("Use 100–100000 items per scenario");
  const file = join(directory, "catalog-" + size + ".db");
  let db = openDatabase(file);
  db.pragma("synchronous=NORMAL");
  const repo = new Repo(db);
  const item = db.prepare("INSERT INTO items(id,uid,title,source_site,source_item_id,status,cat_id,created_at,updated_at) VALUES (?,?,?,'booth',?,'active',?,?,?)");
  const fts = db.prepare("INSERT INTO items_fts(rowid,title,shop_name,author,description,notes,tags_text) VALUES (?,?,'Studio','','','','')");
  const asset = db.prepare("INSERT INTO assets(id,item_id,kind,container,path,path_norm,root_id,size,status,first_seen,index_state,discovered_by) VALUES (?,?,'archive','zip',?,?,1,?,'present',?,'done','scan')");
  const entry = db.prepare("INSERT INTO archive_entries(asset_id,entry_path,entry_size,is_dir,ext) VALUES (?,?,1000,0,?)");
  db.prepare("INSERT INTO library_roots(id,path,path_norm,mode,created_at) VALUES (1,'/fixture','/fixture','index_in_place',?)").run(seedDate);
  const v = db.prepare("INSERT INTO avatars(name,name_norm,kind,created_at,updated_at) VALUES ('Manuka','manuka','avatar',?,?)").run(seedDate, seedDate);
  const link = db.prepare("INSERT INTO item_avatars(item_id,avatar_id,match,source) VALUES (?,?,'any','manual')");
  db.transaction(() => {
    for (let n = 1; n <= size; n++) {
      const key = String(n).padStart(5, "0");
      const subject = n % 5 === 1 ? "嵐の仕立屋 goth set " : n % 5 === 2 ? "黑色 Hair Style " : "Workshop material ";
      const title = subject + key;
      const path = "/fixture/" + key + "/package_" + key + ".zip";
      item.run(n, "bench-" + n, title, String(7000000 + n), n % 2 ? "clothing" : "hair", seedDate, seedDate);
      fts.run(n, title);
      asset.run(n, n, path, path, 5000000 + n * 100, seedDate);
      entry.run(n, "Assets/Layer/layer_" + key + ".mat", "mat");
      entry.run(n, "Assets/Model/model_" + key + ".fbx", "fbx");
      entry.run(n, "Assets/Textures/color_" + key + ".png", "png");
      if (n % 4 === 1) link.run(n, v.lastInsertRowid);
    }
  })();
  const legacy = (q) => {
    const phrase = '"' + q.replace(/"/gu, '""') + '"';
    const where = q.length >= 3 ? "id IN (SELECT rowid FROM items_fts WHERE items_fts MATCH ?)" : "title LIKE ? OR COALESCE(author,'') LIKE ?";
    const bound = q.length >= 3 ? [phrase] : ["%" + q + "%", "%" + q + "%"];
    const count = db.prepare("SELECT count(*) total FROM items WHERE " + where).get(...bound);
    db.prepare("SELECT id FROM items WHERE " + where + " ORDER BY updated_at DESC,id DESC LIMIT 24").all(...bound);
    return count;
  };
  const baseline = Object.fromEntries(queryNames.map((q) => [q, measure(() => legacy(q), 12)]));
  const buildStart = performance.now();
  enqueueSearchBackfill(db);
  while (db.transaction(() => drainSearchIndex(db, 250, 1000))()) { /* Batched writes in benchmark. */ }
  const buildMs = performance.now() - buildStart;
  db.pragma("wal_checkpoint(TRUNCATE)");
  db.exec("ANALYZE");
  const storageBytes = statSync(file).size;
  const indexBytes = db.prepare("SELECT sum(pgsize) n FROM dbstat WHERE name LIKE 'search_%' OR name LIKE 'ix_search_%'").get().n;
  const uncached = Object.fromEntries(queryNames.map((q) => [q, measure(() => repo.listItems({ q, limit: 24 }), 12)]));
  const hot = Object.fromEntries(queryNames.map((q) => [q, measure(() => runCachedSearchRead(repo, { kind: "items", query: { q, limit: 24 } }))]));
  const facets = measure(() => repo.searchFacets({ q: "goth" }, "avatar"), 16);
  const cold = Object.fromEntries(queryNames.map((q) => [q, measure(() => {
    const read = new Database(file, { readonly: true, fileMustExist: true });
    try { return new Repo(read).listItems({ q, limit: 24 }); }
    finally { read.close(); }
  }, 6)]));
  const explain = db.prepare("EXPLAIN QUERY PLAN SELECT rowid FROM search_terms_fts WHERE search_terms_fts MATCH ?")
    .all("title:x009ed1008272").map((r) => r.detail);
  enqueueSearchBackfill(db, true);
  const workerEntry = process.env.ASSETVAULT_BENCH_WORKER_ENTRY ?? "apps/server/src/server.ts";
  const worker = startSearchIndexWorker(pathToFileURL(resolve(workerEntry)).href, file, console.error);
  for (let n = 0; n < 30 && searchIndexStatus(db).pending === size; n++) await wait(90);
  const pendingBefore = searchIndexStatus(db).pending;
  const concurrent = Object.fromEntries(queryNames.map((q) => [q, measure(() =>
    runCachedSearchRead(repo, { kind: "items", query: { q, limit: 24 } }), 12)]));
  const pendingAfter = searchIndexStatus(db).pending;
  await worker.terminate();
  const result = { items: size, archivePaths: size * 3, storageBytes, indexBytes, buildMs: +buildMs.toFixed(1),
    indexedPerSecond: Math.round(size * 1000 / buildMs), rssBytes: process.memoryUsage().rss, baseline, hot, uncached, cold, concurrent,
    pendingBefore, pendingAfter, facets, explain };
  report.scenarios.push(result);
  console.log(JSON.stringify({ items: size, buildMs: result.buildMs, maxHotP95: Math.max(...Object.values(hot).map((r) => r.p95Ms)),
    facetsP95: facets.p95Ms, pendingBefore, pendingAfter }));
  db.close();
}
const path = join(directory, "results.json");
writeFileSync(path, JSON.stringify(report, null, 2) + "\n");
console.log(path);
