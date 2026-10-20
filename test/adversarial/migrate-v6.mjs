/**
 * v0.6.1-G G5：schema v5→v6 / 真实旧库→v6 迁移对抗（verifier / task-15）
 * 运行：node --import tsx test/adversarial/migrate-v6.mjs
 * 只用 os.tmpdir() 的一次性副本；不触碰 data/vault.db。
 */
import { mkdtempSync, copyFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, SCHEMA_VERSION } from "../../apps/server/src/db/migrate.ts";
import { Repo } from "../../apps/server/src/db/repo.ts";
import { addRoot, addItem, addAsset } from "../schema/_db.ts";

let pass = 0, fail = 0;
const check = (n, ok, extra = "") => { if (ok) { pass++; console.log("  ✓ " + n); } else { fail++; console.log("  ✗ " + n + (extra ? " — " + extra : "")); } };
const cols = (db, t) => db.prepare("PRAGMA table_info(" + t + ")").all().map((r) => r.name);
const hasIndex = (db, n) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?").get(n);

// ---------- A. 合成 v5 库 → v6 ----------
console.log("\n[A] 合成 v5 → v6（含索引重建）");
{
  const dir = mkdtempSync(join(tmpdir(), "av-mig-v5-"));
  const file = join(dir, "v5.db");
  let db = openDatabase(file);
  const root = addRoot(db, "/m");
  const item = addItem(db, { uid: "u-mig-v5", title: "keep-me" });
  const asset = addAsset(db, item, root, "/m/keep.zip");
  const job = Number(db.prepare("INSERT INTO jobs(kind,item_id,payload,state,attempts,priority,created_at) VALUES ('scan',NULL,'{}','done',0,0,?)").run(new Date().toISOString()).lastInsertRowid);
  db.prepare("INSERT INTO cache_entries(key,kind,version_key,file_path,bytes,state,created_at,last_used_at) VALUES ('k','archive','v1','/tmp/f',10,'ready',?,?)").run(new Date().toISOString(), new Date().toISOString());
  // 退回 v5：删索引 → 删 v6 列 → version=5
  db.exec("DROP INDEX IF EXISTS ix_jobs_lease");
  for (const c of ["holder", "lease_until", "lease_token", "heartbeat_at"]) db.exec("ALTER TABLE jobs DROP COLUMN " + c);
  db.exec("ALTER TABLE cache_entries DROP COLUMN weak");
  db.prepare("UPDATE schema_meta SET value='5' WHERE key='version'").run();
  check("合成库确实是 v5 形状（无 lease 列/weak）", !cols(db, "jobs").includes("lease_token") && !cols(db, "cache_entries").includes("weak"));
  const before = { items: db.prepare("SELECT COUNT(*) c FROM items").get().c, assets: db.prepare("SELECT COUNT(*) c FROM assets").get().c };
  db.close();

  db = openDatabase(file); // 迁移
  check("version=6", String(db.prepare("SELECT value FROM schema_meta WHERE key='version'").get().value) === String(SCHEMA_VERSION));
  for (const c of ["holder", "lease_until", "lease_token", "heartbeat_at"]) check("jobs 补列 " + c, cols(db, "jobs").includes(c));
  check("cache_entries 补列 weak（默认 0）", cols(db, "cache_entries").includes("weak") && Number(db.prepare("SELECT weak FROM cache_entries WHERE key='k'").get().weak) === 0);
  check("旧 job 的 lease_token 默认 0 / holder NULL", Number(db.prepare("SELECT lease_token FROM jobs WHERE id=?").get(job).lease_token) === 0 && db.prepare("SELECT holder FROM jobs WHERE id=?").get(job).holder === null);
  check("索引 ix_jobs_lease 已重建", hasIndex(db, "ix_jobs_lease"));
  check("数据不丢", db.prepare("SELECT COUNT(*) c FROM items").get().c === before.items && db.prepare("SELECT COUNT(*) c FROM assets").get().c === before.assets);
  check("旧 job 状态保持 done（迁移不复活/不改状态机）", db.prepare("SELECT state FROM jobs WHERE id=?").get(job).state === "done");
  const again = db.prepare("PRAGMA table_info(jobs)").all().filter((r) => r.name === "lease_token").length;
  db.close();
  db = openDatabase(file); // 二次打开幂等
  check("二次打开幂等（列不重复、version=6）", db.prepare("PRAGMA table_info(jobs)").all().filter((r) => r.name === "lease_token").length === again && String(db.prepare("SELECT value FROM schema_meta WHERE key='version'").get().value) === "6");
  db.close(); rmSync(dir, { recursive: true, force: true });
}

// ---------- B. 真实旧库副本（data/vault.db，v1 来源）→ v6 ----------
console.log("\n[B] 真实旧库副本 → v6");
{
  const src = "data/vault.db";
  if (!existsSync(src)) { console.log("  (skip: data/vault.db 不存在)"); }
  else {
    const dir = mkdtempSync(join(tmpdir(), "av-mig-real-"));
    const file = join(dir, "copy.db");
    copyFileSync(src, file);
    const before = new (await import("better-sqlite3")).default(file, { readonly: true, fileMustExist: true });
    const b = { items: before.prepare("SELECT COUNT(*) c FROM items").get().c, assets: before.prepare("SELECT COUNT(*) c FROM assets").get().c, ver: before.prepare("SELECT value FROM schema_meta WHERE key='version'").get()?.value };
    before.close();
    const db = openDatabase(file);
    check("真实库 version → 6", String(db.prepare("SELECT value FROM schema_meta WHERE key='version'").get().value) === "6", "was " + b.ver);
    check("真实库 items/assets 行数不变", db.prepare("SELECT COUNT(*) c FROM items").get().c === b.items && db.prepare("SELECT COUNT(*) c FROM assets").get().c === b.assets);
    check("真实库 integrity_check=ok", db.pragma("integrity_check", { simple: true }) === "ok");
    check("FTS 可用且行数=items", Number(db.prepare("SELECT COUNT(*) c FROM items_fts").get().c) === b.items);
    const repo = new Repo(db);
    check("Repo 可读（lease 列存在，不因旧行报错）", Array.isArray(repo.listJobs(undefined, 5)));
    db.close(); rmSync(dir, { recursive: true, force: true });
  }
}

console.log("\n" + (fail === 0 ? "PASS" : "FAIL") + " " + pass + " passed / " + fail + " failed");
process.exit(fail === 0 ? 0 : 1);
