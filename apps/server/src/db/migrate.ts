import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const SCHEMA_VERSION = 1;

/** 默认路径基于 import.meta.url；打包成单文件 bundle 后需由调用方显式传入 schemaFile。 */
const defaultSchemaPath = fileURLToPath(new URL("./schema.sql", import.meta.url));

/** Apply the schema (idempotent) and record the schema version. */
export function migrate(db: Database.Database, schemaFile?: string): void {
  const sql = readFileSync(schemaFile ?? defaultSchemaPath, "utf8");
  db.exec(sql);
  db.prepare("INSERT INTO schema_meta(key, value) VALUES ('version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(String(SCHEMA_VERSION));
}

export function openDatabase(file: string, schemaFile?: string): Database.Database {
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  migrate(db, schemaFile);
  return db;
}
