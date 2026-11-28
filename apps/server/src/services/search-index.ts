import Database from "better-sqlite3";
import { parentPort, Worker } from "node:worker_threads";
import { normalizeSearch, normalizeSearchName } from "../../../../packages/core/src/search-query";
import { SEARCH_LEXICON_VERSION } from "../../../../packages/core/src/search-lexicon";

export const SEARCH_INDEX_VERSION = 1;
export const SEARCH_PAUSE_KEY = "search_index_paused";
const MAX_META_CHARS = 48_000;
const MAX_PATH_CHARS = 512_000;
const MAX_PATHS = 2500;

export function searchToken(value: string): string {
  return "x" + Array.from(value, (c) => c.codePointAt(0)!.toString(16).padStart(6, "0")).join("");
}

export function typoKeys(word: string): string[] {
  if (!/^[a-z][a-z0-9]{3,23}$/u.test(word)) return [];
  return [...new Set([word, ...Array.from(word, (_, i) => word.slice(0, i) + word.slice(i + 1))])].map(searchToken);
}

function shortTerms(value: string): string {
  const keys = new Set<string>();
  for (const run of value.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]+|[a-z0-9]+/gu) ?? []) {
    if (/^[a-z0-9]+$/u.test(run)) {
      if (run.length < 3) keys.add(searchToken(run));
      continue;
    }
    const chars = Array.from(run);
    for (let i = 0; i < chars.length; i++) {
      keys.add(searchToken(chars[i]!));
      if (chars[i + 1]) keys.add(searchToken(chars[i]! + chars[i + 1]));
    }
  }
  return [...keys].join(" ");
}

function variants(text: string): string {
  const plain = normalizeSearch(text.replace(/\\/gu, "/"));
  const split = normalizeSearchName(text);
  return plain === split ? plain : plain + "\n" + split;
}

interface SearchIndexDoc {
  title: string;
  title_ja: string | null;
  author: string | null;
  shop_name: string | null;
  description: string | null;
  notes: string | null;
}

export function enqueueSearchBackfill(db: Database.Database, rebuild = false, verify = false): void {
  db.prepare("INSERT INTO search_dirty(item_id,refresh_only) SELECT i.id,? FROM items i WHERE ?=1 OR NOT EXISTS "
    + "(SELECT 1 FROM search_documents d WHERE d.item_id=i.id AND d.version=?"
    + (verify ? " AND EXISTS (SELECT 1 FROM search_text_fts f WHERE f.rowid=d.item_id) AND EXISTS (SELECT 1 FROM search_terms_fts f WHERE f.rowid=d.item_id)" : "")
    + ") ON CONFLICT(item_id) DO NOTHING")
    .run(rebuild ? 1 : 0, rebuild ? 1 : 0, SEARCH_INDEX_VERSION);
  if (rebuild) db.prepare("UPDATE search_dirty SET failures=0,error=NULL WHERE failures>0").run();
}

export function searchIndexStatus(db: Database.Database) {
  const { total, indexed, pending, failed } = db.prepare("SELECT (SELECT count(*) FROM items WHERE status<>'trashed') total,"
    + "(SELECT count(*) FROM search_documents d JOIN items i ON i.id=d.item_id WHERE d.version=? AND i.status<>'trashed'"
    + " AND NOT EXISTS (SELECT 1 FROM search_dirty w WHERE w.item_id=d.item_id AND w.refresh_only=0)) AS \"indexed\","
    + "(SELECT count(*) FROM search_dirty d JOIN items i ON i.id=d.item_id WHERE d.failures=0 AND i.status<>'trashed') pending,"
    + "(SELECT count(*) FROM search_dirty d JOIN items i ON i.id=d.item_id WHERE d.failures>0 AND i.status<>'trashed') failed")
    .get(SEARCH_INDEX_VERSION) as { total: number; indexed: number; pending: number; failed: number };
  const content = db.prepare("SELECT a.index_state state,count(*) n FROM assets a JOIN items i ON i.id=a.item_id"
    + " WHERE a.status<>'trashed' AND i.status<>'trashed' GROUP BY a.index_state").all() as { state: string; n: number }[];
  const classifications = db.prepare("SELECT count(*) FROM search_documents WHERE path_limited=1").pluck().get() as number;
  return { version: SEARCH_INDEX_VERSION, lexiconVersion: SEARCH_LEXICON_VERSION, total, indexed, pending, failed,
    contentPending: content.filter((row) => ["pending", "queued", "running", "partial"].includes(row.state)).reduce((n, row) => n + row.n, 0),
    contentFailed: content.find((row) => row.state === "failed")?.n ?? 0,
    contentLimited: content.find((row) => row.state === "limited")?.n ?? 0,
    pathLimitedItems: classifications };
}

const writers = new WeakMap<Database.Database, (itemId: number) => void>();
function indexWriter(db: Database.Database): (itemId: number) => void {
  const existing = writers.get(db);
  if (existing) return existing;
  const doc = db.prepare("SELECT title,title_ja,author,shop_name,description,notes FROM items WHERE id=?");
  const tags = db.prepare("SELECT t.name FROM item_tags it JOIN tags t ON t.id=it.tag_id WHERE it.item_id=? ORDER BY t.id").pluck();
  const files = db.prepare("SELECT path FROM assets WHERE item_id=? AND status<>'trashed' ORDER BY id LIMIT ?").pluck();
  const archives = db.prepare("SELECT e.entry_path FROM assets a JOIN archive_entries e ON e.asset_id=a.id "
    + "WHERE a.item_id=? AND a.status<>'trashed' AND e.is_dir=0 ORDER BY a.id,e.id LIMIT ?").pluck();
  const unity = db.prepare("SELECT u.asset_path FROM assets a JOIN unitypackage_assets u ON u.asset_id=a.id "
    + "WHERE a.item_id=? AND a.status<>'trashed' ORDER BY a.id,u.id LIMIT ?").pluck();
  const units = db.prepare("SELECT u.rel_path FROM assets a JOIN asset_units u ON u.asset_id=a.id WHERE a.item_id=? "
    + "AND a.status<>'trashed' ORDER BY a.id,u.id LIMIT ?").pluck();
  const clearFull = db.prepare("DELETE FROM search_text_fts WHERE rowid=?");
  const clearTerms = db.prepare("DELETE FROM search_terms_fts WHERE rowid=?");
  const addFull = db.prepare("INSERT INTO search_text_fts(rowid,title,tags,author,description,files,contents) VALUES (?,?,?,?,?,?,?)");
  const addTerms = db.prepare("INSERT INTO search_terms_fts(rowid,title,tags,author,description,files,contents,typos,formats) VALUES (?,?,?,?,?,?,?,?,?)");
  const manifest = db.prepare("INSERT INTO search_documents(item_id,title_key,path_limited,version) VALUES (?,?,?,?) "
    + "ON CONFLICT(item_id) DO UPDATE SET title_key=excluded.title_key,path_limited=excluded.path_limited,version=excluded.version");
  const done = db.prepare("DELETE FROM search_dirty WHERE item_id=?");
  const queued = db.prepare("SELECT 1 FROM search_dirty WHERE item_id=? AND failures=0");
  const writer = db.transaction((itemId: number) => {
    if (!queued.get(itemId)) return;
    const row = doc.get(itemId) as SearchIndexDoc | undefined;
    if (!row) { done.run(itemId); return; }
    const outer = files.all(itemId, MAX_PATHS) as string[];
    const pathGroups = [unity.all(itemId, MAX_PATHS), archives.all(itemId, MAX_PATHS), units.all(itemId, MAX_PATHS)] as string[][];
    const inner = [...new Set(pathGroups.flat())].filter(Boolean);
    const outerText = outer.join("\n");
    const innerText = inner.join("\n");
    const limited = [outer, ...pathGroups].some((paths) => paths.length >= MAX_PATHS) || outerText.length > MAX_PATH_CHARS || innerText.length > MAX_PATH_CHARS;
    const title = [row.title, row.title_ja].filter(Boolean).join("\n");
    const text = [
      variants(title), variants((tags.all(itemId) as string[]).join("\n").slice(0, MAX_META_CHARS)),
      variants([row.author, row.shop_name].filter(Boolean).join("\n")),
      variants([row.description, row.notes].filter(Boolean).join("\n").slice(0, MAX_META_CHARS)),
      variants(outerText.slice(0, MAX_PATH_CHARS)), variants(innerText.slice(0, MAX_PATH_CHARS)),
    ];
    const words = new Set(text[0]!.match(/[a-z][a-z0-9]{3,23}/gu) ?? []);
    const typos = [...new Set([...words].flatMap(typoKeys))].join(" ");
    const formats = [...new Set([...outer, ...inner].flatMap((path) => {
      const ext = /\.([a-z0-9]{1,20})$/iu.exec(path);
      return ext ? [ext[1]!.toLowerCase()] : [];
    }))].map(searchToken).join(" ");
    clearFull.run(itemId);
    clearTerms.run(itemId);
    addFull.run(itemId, ...text);
    addTerms.run(itemId, ...text.map(shortTerms), typos, formats);
    manifest.run(itemId, normalizeSearch(row.title), limited ? 1 : 0, SEARCH_INDEX_VERSION);
    done.run(itemId);
  }).immediate;
  writers.set(db, writer);
  return writer;
}

export function drainSearchIndex(db: Database.Database, limit = 16, timeBudgetMs = 15): number {
  const ids = db.prepare("SELECT item_id FROM search_dirty WHERE failures=0 ORDER BY item_id LIMIT ?").pluck().all(limit) as number[];
  if (!ids.length) return 0;
  const apply = indexWriter(db);
  const start = performance.now();
  let visited = 0;
  for (const id of ids) {
    try { apply(id); }
    catch (error) {
      if ((error as { code?: string }).code === "SQLITE_BUSY") throw error;
      db.prepare("UPDATE search_dirty SET failures=failures+1,error=? WHERE item_id=?")
        .run(String((error as Error).message ?? error).slice(0, 512), id);
    }
    visited++;
    if (performance.now() - start >= timeBudgetMs) break;
  }
  return visited;
}

export function runSearchIndexWorker(file: string): void {
  const db = new Database(file, { fileMustExist: true, timeout: 250 });
  db.pragma("foreign_keys=ON");
  const paused = db.prepare("SELECT value FROM settings WHERE key=?").pluck();
  let ready = false;
  let timer: NodeJS.Timeout;
  let reportedError = "";
  const tick = () => {
    let processed = 0;
    try {
      if (!ready) { enqueueSearchBackfill(db); ready = true; }
      if (paused.get(SEARCH_PAUSE_KEY) !== "1") processed = drainSearchIndex(db, 12, 20);
      reportedError = "";
    } catch (error) {
      const message = String((error as Error).message);
      if ((error as { code?: string }).code !== "SQLITE_BUSY" && reportedError !== message) {
        parentPort?.postMessage(message);
        reportedError = message;
      }
    }
    timer = setTimeout(tick, processed ? 45 : 450);
  };
  parentPort?.once("message", () => {
    clearTimeout(timer);
    db.close();
    parentPort?.close();
  });
  tick();
}

export function createSearchWorker(entry: string, file: string, action: "runSearchIndexWorker" | "runSearchReadWorker"): Worker {
  const bootstrap = String.raw`
    const { workerData } = require("node:worker_threads");
    const { createRequire } = require("node:module");
    const { dirname, join } = require("node:path");
    const { fileURLToPath } = require("node:url");
    async function load() {
      if (!workerData.entry.endsWith(".ts")) return import(workerData.entry);

      // Source mode builds just the worker entry in memory. The shipped .mjs uses its existing bundle.
      const localRequire = createRequire(workerData.entry);
      const target = workerData.action === "runSearchReadWorker" ? "search-reader" : "search-index";
      const { outputFiles } = await localRequire("esbuild").build({
        stdin: { contents: "export { " + workerData.action + " } from './" + target + "'",
          resolveDir: join(dirname(fileURLToPath(workerData.entry)), "services"), loader: "ts" },
        bundle: true, packages: "external", write: false, format: "cjs", platform: "node", target: "node20",
        define: { "import.meta.url": JSON.stringify(workerData.entry) },
      });
      const mod = { exports: {} };
      new Function("require", "module", "exports", outputFiles[0].text)(localRequire, mod, mod.exports);
      return mod.exports;
    }
    void load().then((mod) => mod[workerData.action](workerData.file)).catch((error) => { throw error; });
  `;
  return new Worker(bootstrap, {
    eval: true, workerData: { entry, file, action }, execArgv: [],
  });
}

export function startSearchIndexWorker(entry: string, file: string, log: (message: string) => void): Worker {
  const worker = createSearchWorker(entry, file, "runSearchIndexWorker");
  worker.on("message", (message) => log("search index: " + message));
  worker.on("error", (error) => log("search index worker: " + error.message));
  worker.unref();
  return worker;
}
