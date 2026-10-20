/**
 * pipeline 测试公共工具（verifier）
 * 只用真实 schema 的临时库；批量插入走单事务，避免测试自己成为瓶颈。
 */
import type Database from "better-sqlite3";
import { addAsset, addItem, addRoot, openTempDb, NOW, type TempDb } from "../schema/_db";
import { Repo } from "../../apps/server/src/db/repo";

export interface PipelineDb { t: TempDb; repo: Repo; rootId: number; itemId: number }

export function openPipelineDb(): PipelineDb {
  const t = openTempDb();
  const repo = new Repo(t.db);
  const rootId = addRoot(t.db, "/lib");
  const itemId = addItem(t.db, { uid: "u-pipeline", title: "pipeline" });
  return { t, repo, rootId, itemId };
}

/** 批量建 assets（单事务）。返回 id 数组（按插入顺序）。 */
export function bulkAssets(db: Database.Database, itemId: number, rootId: number, n: number, tag: string, offset = 0): number[] {
  const ins = db.prepare(
    "INSERT INTO assets(item_id,kind,container,path,path_norm,root_id,size,sha256_state,status,discovered_by,first_seen) VALUES (?,'archive','zip',?,?,?,0,'pending','present','scan',?)"
  );
  const ids: number[] = [];
  db.transaction(() => {
    for (let i = 0; i < n; i++) {
      const idx = offset + i;
      const p = "/lib/" + tag + "/f" + idx + ".zip";
      ids.push(Number(ins.run(itemId, p, p, rootId, NOW).lastInsertRowid));
    }
  })();
  return ids;
}

export function oneAsset(pipe: PipelineDb, name = "one.zip"): number {
  return addAsset(pipe.t.db, pipe.itemId, pipe.rootId, "/lib/" + name);
}

export function activeTaskCount(db: Database.Database): number {
  return Number((db.prepare("SELECT COUNT(*) c FROM index_tasks WHERE state IN ('queued','running','waiting_retry')").get() as { c: number }).c);
}

export function taskById(db: Database.Database, id: number): any {
  return db.prepare("SELECT * FROM index_tasks WHERE id=?").get(id);
}

export function eventTypes(db: Database.Database, taskId?: number): string[] {
  const rows = taskId
    ? db.prepare("SELECT event FROM pipeline_events WHERE task_id=? ORDER BY id").all(taskId) as any[]
    : db.prepare("SELECT event FROM pipeline_events ORDER BY id").all() as any[];
  return rows.map((r) => r.event);
}
