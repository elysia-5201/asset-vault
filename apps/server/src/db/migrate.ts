import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DEFAULT_TAXONOMY } from "../../../../packages/core/src/categories/taxonomy";

/** 数据库结构版本。v1 = 15 张核心表；v2 = 物品分类（categories 表 + items 分类列）。 */
export const SCHEMA_VERSION = 2;

/** 默认路径基于 import.meta.url；打包成单文件 bundle 后需由调用方显式传入 schemaFile。 */
const defaultSchemaPath = fileURLToPath(new URL("./schema.sql", import.meta.url));

/**
 * 加列迁移（幂等）。
 *
 * 为什么需要它：schema.sql 用的是 CREATE TABLE IF NOT EXISTS，对**已存在**的表不会补列。
 * 而 schema.sql 里针对新列建的索引又必须能执行 → 所以顺序必须是：先补列，再执行 schema.sql。
 * 表还不存在时跳过（新库交给 schema.sql 一次建全）。
 */
const COLUMN_MIGRATIONS: ReadonlyArray<{ table: string; column: string; ddl: string }> = [
  { table: "items", column: "cat_id", ddl: "TEXT" },
  { table: "items", column: "cat_sub_id", ddl: "TEXT" },
  { table: "items", column: "cat_source", ddl: "TEXT" },
  { table: "items", column: "cat_confidence", ddl: "REAL" },
  { table: "items", column: "cat_reason", ddl: "TEXT" },
  { table: "items", column: "cat_evidence", ddl: "TEXT" },
  { table: "items", column: "cat_assigned_at", ddl: "TEXT" },
  { table: "items", column: "cat_suggest_id", ddl: "TEXT" },
  { table: "items", column: "cat_suggest_sub_id", ddl: "TEXT" },
  { table: "items", column: "cat_suggest_confidence", ddl: "REAL" },
  { table: "items", column: "cat_suggest_reason", ddl: "TEXT" },
  { table: "items", column: "cat_suggest_evidence", ddl: "TEXT" },
  { table: "items", column: "cat_suggest_at", ddl: "TEXT" },
];

function tableColumns(db: Database.Database, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

export function applyColumnMigrations(db: Database.Database): string[] {
  const added: string[] = [];
  for (const m of COLUMN_MIGRATIONS) {
    const cols = tableColumns(db, m.table);
    if (cols.size === 0) continue; // 表还不存在 → 交给 schema.sql
    if (cols.has(m.column)) continue;
    db.exec(`ALTER TABLE ${m.table} ADD COLUMN ${m.column} ${m.ddl}`);
    added.push(`${m.table}.${m.column}`);
  }
  return added;
}

/**
 * 分类树播种（幂等）：只补缺失的 ID，**不覆盖**用户改过的名字/排序/停用状态。
 * 因此"内置分类被用户改名"不会在下次启动被改回去。
 */
export function seedCategories(db: Database.Database): number {
  const ins = db.prepare(`INSERT INTO categories(id, name, parent_id, sort, enabled, builtin, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`);
  const t = new Date().toISOString();
  let added = 0;
  const tx = db.transaction(() => {
    for (const d of DEFAULT_TAXONOMY) {
      added += ins.run(d.id, d.name, d.parentId, d.sort, d.enabled ? 1 : 0, d.builtin ? 1 : 0, t, t).changes;
    }
  });
  tx();
  return added;
}

/** Apply the schema (idempotent) and record the schema version. */
export function migrate(db: Database.Database, schemaFile?: string): void {
  const addedColumns = applyColumnMigrations(db);
  const sql = readFileSync(schemaFile ?? defaultSchemaPath, "utf8");
  db.exec(sql);
  const addedCategories = seedCategories(db);
  db.prepare("INSERT INTO schema_meta(key, value) VALUES ('version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(String(SCHEMA_VERSION));
  if (addedColumns.length || addedCategories) {
    // 迁移痕迹留档，便于事后核对（启动日志里也能看到）
    db.prepare("INSERT INTO schema_meta(key, value) VALUES ('migrated_v2', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(JSON.stringify({ at: new Date().toISOString(), columns: addedColumns, categories: addedCategories }));
  }
}

export function openDatabase(file: string, schemaFile?: string): Database.Database {
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  migrate(db, schemaFile);
  return db;
}
