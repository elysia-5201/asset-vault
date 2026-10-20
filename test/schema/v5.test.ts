/**
 * schema v5 契约测试（verifier）
 * 覆盖：SCHEMA_VERSION=5、index_tasks / pipeline_events / cache_entries 三表与索引、
 *       assets 四个新列与默认值、唯一活跃任务索引、FK 级联、诊断事件保留、
 *       以及"v4 旧库 → openDatabase → v5"的实迁移（数据不丢、幂等）。
 * 实现：apps/server/src/db/schema.sql + migrate.ts（不改实现）
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTempDb, expectConstraint, addRoot, addItem, addAsset, count } from "./_db";
import { openDatabase, SCHEMA_VERSION, applyColumnMigrations } from "../../apps/server/src/db/migrate";
import { Repo } from "../../apps/server/src/db/repo";

const NOW = "2026-10-04T00:00:00.000Z";
const cols = (db: any, table: string): string[] => (db.prepare("PRAGMA table_info(" + table + ")").all() as any[]).map((r) => r.name);
const hasTable = (db: any, name: string): boolean => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
const hasIndex = (db: any, name: string): boolean => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?").get(name);

describe("SCHEMA_VERSION 与表结构", () => {
  test("SCHEMA_VERSION = 5", () => {
    assert.equal(SCHEMA_VERSION, 5);
  });

  test("三张新表 + 关键索引存在", () => {
    const t = openTempDb();
    try {
      for (const tb of ["index_tasks", "pipeline_events", "cache_entries"]) assert.ok(hasTable(t.db, tb), "缺表 " + tb);
      for (const ix of ["ux_index_task_active", "ix_index_task_pick", "ix_index_task_asset", "ix_index_task_dep", "ix_pipeline_events_at", "ix_pipeline_events_asset", "ix_cache_kind"]) {
        assert.ok(hasIndex(t.db, ix), "缺索引 " + ix);
      }
    } finally { t.close(); }
  });

  test("assets 四个新列存在，index_state 默认 pending（老行/新行都成立）", () => {
    const t = openTempDb();
    try {
      const c = cols(t.db, "assets");
      for (const col of ["index_state", "index_error", "indexed_at", "content_version"]) assert.ok(c.includes(col), "缺列 " + col);
      const rootId = addRoot(t.db, "/v5");
      const itemId = addItem(t.db, { uid: "u-v5" });
      const assetId = addAsset(t.db, itemId, rootId, "/v5/a.zip");
      const row = t.db.prepare("SELECT index_state, index_error, indexed_at, content_version FROM assets WHERE id=?").get(assetId) as any;
      assert.equal(row.index_state, "pending");
      assert.equal(row.index_error, null);
      assert.equal(row.indexed_at, null);
      assert.equal(row.content_version, null);
    } finally { t.close(); }
  });
});

describe("index_tasks 约束", () => {
  const addTask = (db: any, assetId: number, stage: string, state = "queued") =>
    db.prepare("INSERT INTO index_tasks(asset_id, stage, state, created_at) VALUES (?,?,?,?)").run(assetId, stage, state, NOW);

  test("同一 asset+stage 只允许一条活跃任务（queued/running/waiting_retry 都算活跃）", () => {
    const t = openTempDb();
    try {
      const rootId = addRoot(t.db, "/u");
      const itemId = addItem(t.db, { uid: "u-unique" });
      const a = addAsset(t.db, itemId, rootId, "/u/a.zip");
      addTask(t.db, a, "hash", "queued");
      expectConstraint(() => addTask(t.db, a, "hash", "queued"), "UNIQUE");
      expectConstraint(() => addTask(t.db, a, "hash", "running"), "UNIQUE");
      expectConstraint(() => addTask(t.db, a, "hash", "waiting_retry"), "UNIQUE");
      // 不同 stage 可以并存
      addTask(t.db, a, "archive", "queued");
      assert.equal(count(t.db, "index_tasks", "asset_id=?", a), 2);
    } finally { t.close(); }
  });

  test("非活跃终态（done/skipped/failed/cancelled）不占用唯一槽位", () => {
    const t = openTempDb();
    try {
      const rootId = addRoot(t.db, "/t");
      const itemId = addItem(t.db, { uid: "u-terminals" });
      const a = addAsset(t.db, itemId, rootId, "/t/a.zip");
      for (const st of ["done", "skipped", "failed", "cancelled"]) {
        addTask(t.db, a, "stage_" + st, st);
        addTask(t.db, a, "stage_" + st, "queued");
        t.db.prepare("UPDATE index_tasks SET state=? WHERE asset_id=? AND stage=?").run(st, a, "stage_" + st);
        // 再次置回 queued 不冲突（此时同一 stage 只有一条活跃）
        assert.equal((t.db.prepare("SELECT COUNT(*) c FROM index_tasks WHERE asset_id=? AND stage=?").get(a, "stage_" + st) as { c: number }).c, 2);
      }
    } finally { t.close(); }
  });

  test("FK：删除 asset 级联删除其 index_tasks", () => {
    const t = openTempDb();
    try {
      const rootId = addRoot(t.db, "/c");
      const itemId = addItem(t.db, { uid: "u-cascade" });
      const a = addAsset(t.db, itemId, rootId, "/c/a.zip");
      addTask(t.db, a, "hash");
      addTask(t.db, a, "archive");
      assert.equal(count(t.db, "index_tasks", "asset_id=?", a), 2);
      t.db.prepare("DELETE FROM assets WHERE id=?").run(a);
      assert.equal(count(t.db, "index_tasks", "asset_id=?", a), 0);
    } finally { t.close(); }
  });

  test("index_tasks.item_id 无外键（历史条目删除后任务仍可保留 item 线索）", () => {
    const t = openTempDb();
    try {
      const rootId = addRoot(t.db, "/i");
      const itemId = addItem(t.db, { uid: "u-itemfk" });
      const a = addAsset(t.db, itemId, rootId, "/i/a.zip");
      assert.doesNotThrow(() => t.db.prepare("INSERT INTO index_tasks(asset_id, item_id, stage, created_at) VALUES (?,?,?,?)").run(a, 999999, "hash", NOW));
    } finally { t.close(); }
  });
});

describe("pipeline_events / cache_entries", () => {
  test("pipeline_events 无外键：可写任意实体 id，且资产删除后事件保留（诊断只增不改）", () => {
    const t = openTempDb();
    try {
      const rootId = addRoot(t.db, "/e");
      const itemId = addItem(t.db, { uid: "u-events" });
      const a = addAsset(t.db, itemId, rootId, "/e/a.zip");
      t.db.prepare("INSERT INTO pipeline_events(at, task_id, asset_id, stage, event) VALUES (?,?,?,?,?)").run(NOW, 999999, 999999, "hash", "orphan");
      t.db.prepare("INSERT INTO pipeline_events(at, asset_id, stage, event) VALUES (?,?,?,?)").run(NOW, a, "hash", "enqueued");
      t.db.prepare("DELETE FROM assets WHERE id=?").run(a);
      assert.equal(count(t.db, "pipeline_events", "event='enqueued'"), 1, "资产删除后事件必须保留");
    } finally { t.close(); }
  });

  test("cache_entries.key 是主键：裸重复插入被拒；repo.upsertCacheEntry 幂等更新", () => {
    const t = openTempDb();
    try {
      t.db.prepare("INSERT INTO cache_entries(key, kind, version_key, file_path, bytes, state, created_at, last_used_at) VALUES ('k1','archive','v1','/tmp/f1',10,'ready',?,?)").run(NOW, NOW);
      expectConstraint(() => t.db.prepare("INSERT INTO cache_entries(key, kind, version_key, file_path, bytes, state, created_at, last_used_at) VALUES ('k1','archive','v1','/tmp/f2',20,'ready',?,?)").run(NOW, NOW), "PRIMARYKEY");
      const repo = new Repo(t.db);
      repo.upsertCacheEntry({ key: "k1", kind: "archive", versionKey: "v2", filePath: "/tmp/f3", bytes: 30 });
      const row = repo.getCacheEntry("k1");
      assert.equal(row.version_key, "v2");
      assert.equal(row.file_path, "/tmp/f3");
      assert.equal(row.bytes, 30);
      assert.equal(row.state, "ready");
      assert.equal(count(t.db, "cache_entries"), 1);
    } finally { t.close(); }
  });
});

describe("迁移：v4 旧库 → v5（真实 openDatabase）", () => {
  const dir = mkdtempSync(join(tmpdir(), "av-v5-mig-"));
  const file = join(dir, "vault.db");

  test("新库首开：version=5 且三表/四列齐备", () => {
    const db = openDatabase(file);
    try {
      assert.equal(String((db.prepare("SELECT value FROM schema_meta WHERE key='version'").get() as any).value), "5");
      for (const tb of ["index_tasks", "pipeline_events", "cache_entries"]) assert.ok(hasTable(db, tb));
      assert.deepEqual(applyColumnMigrations(db), [], "新库不应再有列需要补");
    } finally { db.close(); }
  });

  test("模拟 v4：删三表+四列并回写 version=4 → 再 open 自动补回，数据不丢、幂等", () => {
    let db = openDatabase(file);
    const rootId = addRoot(db, "/m");
    const itemId = addItem(db, { uid: "u-mig" });
    const assetId = addAsset(db, itemId, rootId, "/m/keep.zip");
    const before = { items: count(db, "items"), assets: count(db, "assets") };
    db.prepare("UPDATE schema_meta SET value='4' WHERE key='version'").run();
    db.prepare("UPDATE assets SET index_state='done', content_version='size:mtime' WHERE id=?").run(assetId);
    for (const tb of ["index_tasks", "pipeline_events", "cache_entries"]) db.exec("DROP TABLE " + tb);
    for (const col of ["index_state", "index_error", "indexed_at", "content_version"]) db.exec("ALTER TABLE assets DROP COLUMN " + col);
    assert.equal(hasTable(db, "index_tasks"), false);
    assert.ok(!cols(db, "assets").includes("index_state"));
    db.close();

    db = openDatabase(file); // ← 迁移在这里发生
    try {
      assert.equal(String((db.prepare("SELECT value FROM schema_meta WHERE key='version'").get() as any).value), "5");
      for (const tb of ["index_tasks", "pipeline_events", "cache_entries"]) assert.ok(hasTable(db, tb), "迁移后缺表 " + tb);
      for (const col of ["index_state", "index_error", "indexed_at", "content_version"]) assert.ok(cols(db, "assets").includes(col), "迁移后缺列 " + col);
      assert.deepEqual({ items: count(db, "items"), assets: count(db, "assets") }, before, "迁移不得丢数据");
      const row = db.prepare("SELECT index_state, content_version FROM assets WHERE id=?").get(assetId) as any;
      assert.equal(row.index_state, "pending", "重建列使用默认值（旧状态无法恢复，这符合预期）");
      assert.equal(row.content_version, null);
      assert.deepEqual(applyColumnMigrations(db), [], "迁移后不应重复补列");
    } finally { db.close(); }

    // 第三次打开：完全幂等
    db = openDatabase(file);
    try {
      assert.equal(String((db.prepare("SELECT value FROM schema_meta WHERE key='version'").get() as any).value), "5");
      assert.deepEqual(applyColumnMigrations(db), []);
      assert.equal(count(db, "assets"), before.assets);
    } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
