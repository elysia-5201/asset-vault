/**
 * schema 测试公共工具（verifier / task-4）
 * 只读 schema.sql，在临时目录建真实 SQLite 库（better-sqlite3），不做任何桩替身。
 */
import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

export const SCHEMA_PATH = fileURLToPath(new URL("../../apps/server/src/db/schema.sql", import.meta.url));

export interface TempDb { db: Database.Database; dir: string; file: string; close: () => void }

export function openTempDb(): TempDb {
  const dir = mkdtempSync(join(tmpdir(), "av-schema-"));
  const file = join(dir, "test.db");
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(readFileSync(SCHEMA_PATH, "utf8"));
  return {
    db, dir, file,
    close: () => { try { db.close(); } catch { /* already closed */ } rmSync(dir, { recursive: true, force: true }); },
  };
}

/** 断言语句因约束失败。kind 可选，用于区分 UNIQUE / FOREIGNKEY / PRIMARYKEY。 */
export function expectConstraint(fn: () => unknown, kind?: string): { code: string; message: string } {
  let err: unknown = null;
  try { fn(); } catch (e) { err = e; }
  assert.ok(err, "期望违反约束被拒绝，但语句成功了（约束缺失＝反例缺口）");
  const code = String((err as { code?: string }).code ?? "");
  const message = String((err as Error).message ?? "");
  assert.ok(code.startsWith("SQLITE_CONSTRAINT"), `期望 SQLITE_CONSTRAINT*，实际 ${code}: ${message}`);
  if (kind) {
    // SQLite 对 ON DELETE RESTRICT 报 SQLITE_CONSTRAINT_TRIGGER，对即时 FK 校验报 SQLITE_CONSTRAINT_FOREIGNKEY
    const acceptable = kind === "FOREIGNKEY" ? ["FOREIGNKEY", "TRIGGER"] : [kind];
    assert.ok(acceptable.some((k) => code.endsWith(k)), `期望 ${acceptable.join("|")}，实际 ${code}: ${message}`);
  }
  return { code, message };
}

/** 断言语句可以执行（正向对照）。 */
export function expectOk<T>(fn: () => T): T { return fn(); }

export const NOW = "2026-10-04T00:00:00.000Z";

export function addRoot(db: Database.Database, pathNorm: string, path = pathNorm): number {
  return Number(db.prepare("INSERT INTO library_roots(path, path_norm, created_at) VALUES (?,?,?)").run(path, pathNorm, NOW).lastInsertRowid);
}

export function addItem(db: Database.Database, o: Partial<Record<string, unknown>> = {}): number {
  const cols: Record<string, unknown> = {
    uid: "uid-" + Math.random().toString(36).slice(2), source_site: "booth", source_item_id: null,
    title: "t", created_at: NOW, updated_at: NOW, ...o,
  };
  const keys = Object.keys(cols);
  const sql = `INSERT INTO items(${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`;
  return Number(db.prepare(sql).run(...keys.map((k) => cols[k] as never)).lastInsertRowid);
}

export function addAsset(db: Database.Database, itemId: number, rootId: number, pathNorm: string, o: Partial<Record<string, unknown>> = {}): number {
  const cols: Record<string, unknown> = {
    item_id: itemId, kind: "archive", container: "zip", path: pathNorm, path_norm: pathNorm,
    root_id: rootId, discovered_by: "scan", first_seen: NOW, ...o,
  };
  const keys = Object.keys(cols);
  return Number(db.prepare(`INSERT INTO assets(${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...keys.map((k) => cols[k] as never)).lastInsertRowid);
}

export function addAvatar(db: Database.Database, name: string, o: Partial<Record<string, unknown>> = {}): number {
  const cols: Record<string, unknown> = { name, name_norm: name.toLowerCase(), created_at: NOW, updated_at: NOW, ...o };
  const keys = Object.keys(cols);
  return Number(db.prepare(`INSERT INTO avatars(${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...keys.map((k) => cols[k] as never)).lastInsertRowid);
}

export function addImage(db: Database.Database, itemId: number, o: Partial<Record<string, unknown>> = {}): number {
  const cols: Record<string, unknown> = { item_id: itemId, role: "cover", origin: "booth", position: 0, created_at: NOW, ...o };
  const keys = Object.keys(cols);
  return Number(db.prepare(`INSERT INTO item_images(${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...keys.map((k) => cols[k] as never)).lastInsertRowid);
}

export function addJob(db: Database.Database, itemId: number | null, kind: string, state = "queued", o: Partial<Record<string, unknown>> = {}): number {
  const cols: Record<string, unknown> = { kind, item_id: itemId, state, created_at: NOW, ...o };
  const keys = Object.keys(cols);
  return Number(db.prepare(`INSERT INTO jobs(${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...keys.map((k) => cols[k] as never)).lastInsertRowid);
}

export function count(db: Database.Database, table: string, where = "1=1", ...args: unknown[]): number {
  return Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get(...(args as never[])) as { n: number }).n);
}
