/**
 * 物品分类 — DB v1 → v2 迁移测试
 *
 * 被测：apps/server/src/db/migrate.ts + apps/server/src/db/schema.sql（FROZEN，见 docs/categories.md §1）
 * 方法：用 schema.sql **去掉 v2 内容**（items 的 13 个 cat_* 列、categories 表、分类索引）得到真实 v1 结构，
 *       建库 → 写入一条 v1 老数据 → migrate() → 逐项断言。
 * 关键点：
 *  - 老数据一字不改，且迁移后 cat_id IS NULL（历史素材 = 未分类）；
 *  - 幂等：连跑两次不报错、不重复播种、行数不变、列不再重复添加；
 *  - 播种 ON CONFLICT DO NOTHING：不覆盖用户改过的 name/sort/enabled，也不删用户自建分类。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate, applyColumnMigrations, seedCategories, SCHEMA_VERSION } from "../../apps/server/src/db/migrate";
import { DEFAULT_TAXONOMY, topCategories, validateTaxonomy } from "../../packages/core/src/categories/taxonomy";

const SCHEMA_PATH = fileURLToPath(new URL("../../apps/server/src/db/schema.sql", import.meta.url));
const NOW = "2026-10-01T00:00:00.000Z";

/** v2 新增列（docs/categories.md §1），逐字列出以便断言"齐全"。 */
const V2_ITEM_COLUMNS = [
  "cat_id", "cat_sub_id", "cat_source", "cat_confidence", "cat_reason", "cat_evidence", "cat_assigned_at",
  "cat_suggest_id", "cat_suggest_sub_id", "cat_suggest_confidence", "cat_suggest_reason", "cat_suggest_evidence", "cat_suggest_at",
];

/**
 * 把当前 schema.sql 还原成 v1：去掉 categories 表、items 的 cat_* 列与相关索引/注释。
 * 这样"旧库"与线上 v1 库结构一致，而不是手抄一份可能失真的 DDL。
 */
function v1Schema(sql: string): string {
  const V2_COLUMN_LINE = new RegExp("\\bcat_(id|sub_id|source|confidence|reason|evidence|assigned_at|suggest_id|suggest_sub_id|suggest_confidence|suggest_reason|suggest_evidence|suggest_at)\\b");
  const out: string[] = [];
  let inCategoriesTable = false;
  for (const line of sql.split(/\r?\n/)) {
    if (/^CREATE TABLE IF NOT EXISTS categories\b/.test(line)) { inCategoriesTable = true; continue; }
    if (inCategoriesTable) { if (line.trim() === ");") inCategoriesTable = false; continue; }
    if (/ix_categories_parent/.test(line)) continue;
    if (/物品分类/.test(line)) continue;
    if (V2_COLUMN_LINE.test(line)) continue;
    out.push(line);
  }
  return out.join("\n");
}

interface Fixture {
  db: Database.Database;
  dir: string;
  file: string;
  itemId: number;
  /** v1 时 items 的全部列名（迁移后用它取"老数据"快照，新列不参与比较）。 */
  columns: string[];
  rowBefore: Record<string, unknown>;
  close: () => void;
}

/** 建一个真实 v1 库（文件库，含 WAL）+ 一行老数据。 */
function openV1(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "av-cat-mig-"));
  const file = join(dir, "v1.db");
  const db = new Database(file);
  db.pragma("foreign_keys = ON");
  db.exec(v1Schema(readFileSync(SCHEMA_PATH, "utf8")));
  db.prepare("INSERT INTO schema_meta(key, value) VALUES ('version', '1')").run();
  const columns = (db.prepare("PRAGMA table_info(items)").all() as { name: string }[]).map((r) => r.name);
  const info = db.prepare(`INSERT INTO items(uid, source_site, source_item_id, source_url, canonical_url, title, title_ja,
      shop_name, shop_subdomain, author, price_text, price_yen, purchased, published_at, category_name, category_parent,
      description, adult, status, rating, favorite, notes, compat_declared_count, id_confidence, id_match_method,
      source_gone, last_checked_at, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run("uid-v1-legacy-1", "booth", "6115428", "https://booth.pm/ja/items/6115428", "https://booth.pm/ja/items/6115428",
      "真実の穴 V2 対応衣装セット", "真実の穴 V2 衣装", "サンプルショップ", "sample", "サンプル作者", "¥1,500", 1500, 1,
      "2026-09-01T00:00:00.000Z", "衣装", "3Dモデル", "説明文", 1, "stored", 5, 1, "備考メモ", 12, 0.9, "booth-id",
      0, NOW, NOW, NOW);
  const itemId = Number(info.lastInsertRowid);
  const rowBefore = db.prepare(`SELECT ${columns.join(",")} FROM items WHERE id = ?`).get(itemId) as Record<string, unknown>;
  return {
    db, dir, file, itemId, columns, rowBefore,
    close: () => { try { db.close(); } catch { /* already closed */ } rmSync(dir, { recursive: true, force: true }); },
  };
}

const snapshot = (f: Fixture): Record<string, unknown> =>
  JSON.parse(JSON.stringify(f.db.prepare(`SELECT ${f.columns.join(",")} FROM items WHERE id = ?`).get(f.itemId))) as Record<string, unknown>;

const itemColumns = (db: Database.Database): string[] =>
  (db.prepare("PRAGMA table_info(items)").all() as { name: string }[]).map((r) => r.name);

const count = (db: Database.Database, sql: string): number => (db.prepare(sql).get() as { n: number }).n;

describe("v1 旧库夹具本身是 v1（防止夹具就带着 v2 结构导致假绿）", () => {
  test("夹具 schema 里没有 categories 表、没有 13 个 cat_* 列，schema_meta.version='1'", () => {
    const v1 = v1Schema(readFileSync(SCHEMA_PATH, "utf8"));
    assert.equal(/CREATE TABLE IF NOT EXISTS categories/.test(v1), false, "v1 不应有 categories 表");
    for (const c of V2_ITEM_COLUMNS) assert.equal(v1.includes(c), false, "v1 不应有列 " + c);
    assert.equal(/ix_items_cat/.test(v1), false, "v1 不应有分类索引");
    // 保留 v1 原有结构
    for (const t of ["schema_meta", "library_roots", "items", "assets", "avatars", "tags", "jobs"]) assert.ok(v1.includes(t), "v1 必须仍有 " + t);

    const f = openV1();
    try {
      assert.equal(itemColumns(f.db).filter((n) => n.startsWith("cat_")).length, 0, "v1 items 不得有 cat_* 列");
      assert.equal(count(f.db, "SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='categories'"), 0);
      assert.equal((f.db.prepare("SELECT value FROM schema_meta WHERE key='version'").get() as { value: string }).value, "1");
      assert.equal(count(f.db, "SELECT COUNT(*) n FROM items"), 1);
      assert.equal(f.rowBefore.title, "真実の穴 V2 対応衣装セット");
    } finally { f.close(); }
  });
});

describe("migrate()：v1 → v2", () => {
  test("schema_meta.version='2'，items 13 个 cat_* 列齐全，categories 93 行（14 主 + 79 子）", () => {
    const f = openV1();
    try {
      migrate(f.db);
      assert.equal(SCHEMA_VERSION, 2);
      assert.equal((f.db.prepare("SELECT value FROM schema_meta WHERE key='version'").get() as { value: string }).value, "2");

      const cols = itemColumns(f.db);
      for (const c of V2_ITEM_COLUMNS) assert.ok(cols.includes(c), "缺少新列 " + c);
      assert.deepEqual(cols.filter((n) => n.startsWith("cat_")).sort(), [...V2_ITEM_COLUMNS].sort(), "cat_* 列集合必须恰好是这 13 个");

      assert.equal(count(f.db, "SELECT COUNT(*) n FROM categories"), 93);
      assert.equal(count(f.db, "SELECT COUNT(*) n FROM categories WHERE parent_id IS NULL"), 14);
      assert.equal(count(f.db, "SELECT COUNT(*) n FROM categories WHERE parent_id IS NOT NULL"), 79);
      assert.equal(DEFAULT_TAXONOMY.length, 93);
      assert.equal(topCategories().length, 14);
      // 播种结果自身合法（两层、父存在、ID 唯一）
      const defs = (f.db.prepare("SELECT id, name, parent_id AS parentId, sort, enabled, builtin FROM categories").all() as any[])
        .map((r) => ({ id: r.id, name: r.name, parentId: r.parentId ?? null, sort: r.sort, enabled: r.enabled !== 0, builtin: r.builtin !== 0 }));
      assert.deepEqual(validateTaxonomy(defs), []);

      // 迁移痕迹留档
      const mig = f.db.prepare("SELECT value FROM schema_meta WHERE key='migrated_v2'").get() as { value: string } | undefined;
      assert.ok(mig, "应写入 migrated_v2");
      const parsed = JSON.parse(mig!.value) as { columns: string[]; categories: number };
      assert.equal(parsed.columns.length, 13, "migrated_v2 记录 13 个新列");
      assert.equal(parsed.categories, 93);
    } finally { f.close(); }
  });

  test("旧行数据一字不改，且迁移后 cat_id IS NULL（历史素材 = 未分类）", () => {
    const f = openV1();
    try {
      migrate(f.db);
      const after = snapshot(f);
      assert.deepEqual(after, JSON.parse(JSON.stringify(f.rowBefore)), "v1 每一列都必须保持不变");
      assert.equal(count(f.db, "SELECT COUNT(*) n FROM items"), 1, "迁移不得增删条目");

      const nulls = f.db.prepare(`SELECT ${V2_ITEM_COLUMNS.join(",")} FROM items WHERE id = ?`).get(f.itemId) as Record<string, unknown>;
      for (const c of V2_ITEM_COLUMNS) assert.equal(nulls[c], null, c + " 迁移后必须为 NULL");
      assert.equal((f.db.prepare("SELECT cat_id FROM items WHERE id=?").get(f.itemId) as any).cat_id, null, "cat_id IS NULL = 未分类");
    } finally { f.close(); }
  });

  test("幂等：连跑两次不报错、不重复播种、行数不变、不再重复加列", () => {
    const f = openV1();
    try {
      migrate(f.db);
      const afterFirst = snapshot(f);
      assert.doesNotThrow(() => migrate(f.db));
      assert.equal(count(f.db, "SELECT COUNT(*) n FROM categories"), 93, "第二次 migrate 不得重复播种");
      assert.equal(count(f.db, "SELECT COUNT(*) n FROM items"), 1);
      assert.deepEqual(snapshot(f), afterFirst, "第二次 migrate 后老行仍不变");
      assert.deepEqual(applyColumnMigrations(f.db), [], "列已存在 → 不再 ALTER（幂等）");
      assert.equal(seedCategories(f.db), 0, "第二次播种新增 0 行");
      assert.equal((f.db.prepare("SELECT value FROM schema_meta WHERE key='version'").get() as { value: string }).value, "2");
    } finally { f.close(); }
  });

  test("播种不覆盖用户改动：改名 / 排序 / 停用后再次 migrate 仍然保留", () => {
    const f = openV1();
    try {
      migrate(f.db);
      f.db.prepare("UPDATE categories SET name='服装（我的叫法）', sort=999, enabled=0 WHERE id='clothing'").run();
      f.db.prepare("UPDATE categories SET name='上衣改' WHERE id='clothing.tops'").run();
      migrate(f.db);
      const row = f.db.prepare("SELECT name, sort, enabled FROM categories WHERE id='clothing'").get() as any;
      assert.equal(row.name, "服装（我的叫法）", "不得把用户改的名字改回去");
      assert.equal(row.sort, 999);
      assert.equal(row.enabled, 0, "用户停用不得被复位");
      assert.equal((f.db.prepare("SELECT name FROM categories WHERE id='clothing.tops'").get() as any).name, "上衣改");
      assert.equal(count(f.db, "SELECT COUNT(*) n FROM categories"), 93, "行数不变");
    } finally { f.close(); }
  });

  test("播种只补缺失 ID：删掉一个内置分类后 migrate 会补回默认定义", () => {
    const f = openV1();
    try {
      migrate(f.db);
      f.db.prepare("DELETE FROM categories WHERE id='hair.texture'").run();
      assert.equal(count(f.db, "SELECT COUNT(*) n FROM categories"), 92);
      migrate(f.db);
      assert.equal(count(f.db, "SELECT COUNT(*) n FROM categories"), 93, "缺失的内置分类应被补回");
      const row = f.db.prepare("SELECT name, parent_id AS parentId FROM categories WHERE id='hair.texture'").get() as any;
      assert.deepEqual(row, { name: "发型贴图", parentId: "hair" });
    } finally { f.close(); }
  });

  test("用户自建分类（builtin=0）迁移后保留，且不被覆盖", () => {
    const f = openV1();
    try {
      migrate(f.db);
      f.db.prepare(`INSERT INTO categories(id, name, parent_id, sort, enabled, builtin, created_at, updated_at)
        VALUES ('my.custom', '我的自建分类', NULL, 5000, 1, 0, ?, ?)`).run(NOW, NOW);
      f.db.prepare(`INSERT INTO categories(id, name, parent_id, sort, enabled, builtin, created_at, updated_at)
        VALUES ('my.custom.sub', '自建子分类', 'my.custom', 10, 0, 0, ?, ?)`).run(NOW, NOW);
      migrate(f.db);
      const rows = f.db.prepare("SELECT id, name, parent_id AS parentId, sort, enabled, builtin FROM categories WHERE id LIKE 'my.custom%' ORDER BY id").all() as any[];
      assert.equal(rows.length, 2, "自建分类必须保留");
      assert.deepEqual(rows[0], { id: "my.custom", name: "我的自建分类", parentId: null, sort: 5000, enabled: 1, builtin: 0 });
      assert.deepEqual(rows[1], { id: "my.custom.sub", name: "自建子分类", parentId: "my.custom", sort: 10, enabled: 0, builtin: 0 });
      assert.equal(count(f.db, "SELECT COUNT(*) n FROM categories"), 95, "93 内置 + 2 自建");
    } finally { f.close(); }
  });
});
