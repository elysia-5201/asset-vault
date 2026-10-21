/**
 * v0.6.1 FIX-02（task-29）：index_tasks 租约围栏测试
 * 覆盖：v7 迁移、claim owner/token、接管后旧 update/finish/retry 全拒、旧 failed 不覆盖新 done、
 *       recover/resetRunningTasksForJob、reap 同事务重置子任务、runner/pipeline 的 job_id 透传。
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTempDb, addItem, addRoot, addAsset, addJob, type TempDb } from "../schema/_db";
import { Repo } from "../../apps/server/src/db/repo";
import { applyColumnMigrations, SCHEMA_VERSION } from "../../apps/server/src/db/migrate";
import { IndexPipeline } from "../../apps/server/src/services/pipeline/pipeline";
import { resolveLimits } from "../../apps/server/src/services/pipeline/limits";
import { runJob, type JobDeps } from "../../apps/server/src/jobs/runner";

let t: TempDb; let repo: Repo; let itemId: number; let rootId: number; let assetSeq = 0;
beforeEach(() => {
  t = openTempDb(); repo = new Repo(t.db); itemId = addItem(t.db); rootId = addRoot(t.db, "/lib");
  assetSeq = 0;
});
afterEach(() => t.close());
const newAsset = () => { assetSeq++; return addAsset(t.db, itemId, rootId, "/lib/a" + assetSeq + ".zip"); };
const task = (id: number) => repo.getIndexTask(id) as any;
const enqueue = (assetId: number, jobId?: number | null) => repo.enqueueIndexTask({ assetId, stage: "hash", priority: 50, jobId });

describe("v7 迁移", () => {
  test("SCHEMA_VERSION=8；v6 老表补 owner/lease_token/job_id 且幂等；新索引可建", () => {
    assert.equal(SCHEMA_VERSION, 8);
    const dir = mkdtempSync(join(tmpdir(), "av-v7-"));
    const db = new Database(join(dir, "v6.db"));
    try {
      db.exec(`CREATE TABLE index_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT, asset_id INTEGER NOT NULL, item_id INTEGER, stage TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'queued', priority INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3, depends_on INTEGER, fingerprint TEXT, version_key TEXT,
        bytes_done INTEGER NOT NULL DEFAULT 0, bytes_total INTEGER NOT NULL DEFAULT 0,
        items_done INTEGER NOT NULL DEFAULT 0, items_total INTEGER NOT NULL DEFAULT 0,
        error_code TEXT, error TEXT, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, next_retry_at TEXT)`);
      db.prepare("INSERT INTO index_tasks(asset_id,stage,created_at) VALUES (1,'hash','2026-01-01T00:00:00.000Z')").run();
      const added = applyColumnMigrations(db);
      assert.deepEqual(added.filter((x) => x.startsWith("index_tasks.")).sort(), ["index_tasks.job_id", "index_tasks.lease_token", "index_tasks.owner"]);
      assert.deepEqual(applyColumnMigrations(db), []);
      const row = db.prepare("SELECT owner, lease_token, job_id FROM index_tasks WHERE id=1").get() as any;
      assert.deepEqual(row, { owner: null, lease_token: 0, job_id: null });
      db.exec(readFileSync(join(process.cwd(), "apps/server/src/db/schema.sql"), "utf8"));
      const idx = (db.prepare("PRAGMA index_list(index_tasks)").all() as any[]).map((r) => r.name);
      assert.ok(idx.includes("ix_index_task_job"));
    } finally { try { db.close(); } catch { /* */ } rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("claim / 围栏", () => {
  test("claim 写 owner 且 token 每次 +1；未传 owner 仍有兼容 owner", () => {
    const a = newAsset();
    const id = enqueue(a);
    const c1 = repo.claimIndexTask("hash", "A");
    assert.equal(c1.id, id);
    assert.equal(c1.owner, "A");
    assert.equal(c1.lease_token, 1);
    // 模拟被接管（直接换租约），再 claim 另一条应从当前 token 继续递增
    t.db.prepare("UPDATE index_tasks SET state='queued', owner=NULL WHERE id=?").run(id);
    const c2 = repo.claimIndexTask("hash", "B");
    assert.equal(c2.id, id);
    assert.equal(c2.owner, "B");
    assert.equal(c2.lease_token, 2);
    const legacy = repo.claimIndexTask("hash"); // 无 owner 调用（测试/诊断兼容）
    assert.equal(legacy, null);
  });

  test("接管后旧持有者 update/finish/retry 全部 0 行/null；新持有者正常", () => {
    const a = newAsset();
    const id = enqueue(a);
    const c = repo.claimIndexTask("hash", "A");
    const fenceA = { owner: "A", leaseToken: c.lease_token };
    // 接管：B 拿到 token+1
    t.db.prepare("UPDATE index_tasks SET owner='B', lease_token=?, state='running' WHERE id=?").run(c.lease_token + 1, id);
    const fenceB = { owner: "B", leaseToken: c.lease_token + 1 };
    assert.equal(repo.updateIndexTask(id, { itemsDone: 9 }, fenceA), false, "旧 update 必须被拒");
    assert.equal((task(id).items_done ?? 0), 0, "旧 update 不得落库");
    assert.equal(repo.finishIndexTask(id, "done", {}, { requireRunning: true, ...fenceA }), null, "旧 finish 必须被拒");
    assert.equal(task(id).state, "running");
    assert.equal(repo.retryIndexTask(id, { errorCode: "E", error: "x" }, fenceA), null, "旧 retry 必须被拒");
    assert.equal(task(id).state, "running");
    // 新持有者可以写
    assert.equal(repo.updateIndexTask(id, { itemsDone: 7 }, fenceB), true);
    const done = repo.finishIndexTask(id, "done", {}, { requireRunning: true, ...fenceB });
    assert.ok(done);
    assert.equal(done.state, "done");
  });

  test("旧 failed 不能覆盖新 done（终态 CAS）", () => {
    const a = newAsset();
    const id = enqueue(a);
    const c = repo.claimIndexTask("hash", "A");
    const fenceA = { owner: "A", leaseToken: c.lease_token };
    t.db.prepare("UPDATE index_tasks SET owner='B', lease_token=? WHERE id=?").run(c.lease_token + 1, id);
    const fenceB = { owner: "B", leaseToken: c.lease_token + 1 };
    assert.ok(repo.finishIndexTask(id, "done", {}, { requireRunning: true, ...fenceB }));
    assert.equal(repo.finishIndexTask(id, "failed", { errorCode: "OLD", error: "stale" }, { requireRunning: true, ...fenceA }), null);
    const row = task(id);
    assert.equal(row.state, "done");
    assert.equal(row.error_code, null, "旧 failed 的 error_code 不得写入");
  });

  test("recoverIndexTasks：running → queued 且 owner=NULL、token+1", () => {
    const a = newAsset();
    const id = enqueue(a);
    const c = repo.claimIndexTask("hash", "A");
    assert.equal(repo.recoverIndexTasks(), 1);
    const row = task(id);
    assert.equal(row.state, "queued");
    assert.equal(row.owner, null);
    assert.equal(row.lease_token, c.lease_token + 1);
  });
});

describe("job 级重置", () => {
  test("resetRunningTasksForJob 只重置该 job 的 running 子任务（owner 清空、token+1）", () => {
    const a1 = newAsset(); const a2 = newAsset();
    const id1 = enqueue(a1, 100);
    const id2 = enqueue(a2, 200);
    repo.claimIndexTask("hash", "A"); // 领走 id1（优先级/id 顺序）
    repo.claimIndexTask("hash", "A"); // 领走 id2
    assert.equal(repo.resetRunningTasksForJob(100), 1);
    const r1 = task(id1); const r2 = task(id2);
    assert.equal(r1.state, "queued");
    assert.equal(r1.owner, null);
    assert.equal(r1.lease_token, 2);
    assert.equal(r2.state, "running", "别的 job 不受影响");
    assert.equal(r2.owner, "A");
  });

  test("reapExpiredLeases 回收 job 时同事务把其 running 子任务退回 queued", () => {
    const a = newAsset();
    const jobId = addJob(t.db, null, "scan", "resolving", { holder: "A", lease_until: "2020-01-01T00:00:00.000Z" });
    const id = enqueue(a, jobId);
    const c = repo.claimIndexTask("hash", "A");
    const n = repo.reapExpiredLeases({ now: "2026-10-21T00:00:00.000Z", protectHolder: "B" });
    assert.equal(n, 1);
    assert.equal(repo.getJob(jobId)!.state, "queued");
    const row = task(id);
    assert.equal(row.state, "queued");
    assert.equal(row.owner, null);
    assert.equal(row.lease_token, c.lease_token + 1);
  });
});

describe("job_id 透传", () => {
  test("pipeline.enqueueAsset(opts.jobId) 写入 index_tasks.job_id", () => {
    const a = newAsset();
    const pipeline = new IndexPipeline({ repo, media: {} as any, cache: { pruneTemp: () => 0 } as any, limits: resolveLimits({}), log: () => {} });
    pipeline.enqueueAsset(a, { jobId: 4242 });
    const rows = repo.listIndexTasks({ assetId: a });
    assert.ok(rows.length > 0);
    assert.ok(rows.every((r: any) => Number(r.job_id) === 4242), "该资产所有子任务都必须带 job_id");
  });

  test("runner 入队时把当前 jobId 透传给 pipeline", async () => {
    const dir = mkdtempSync(join(tmpdir(), "av-jobid-"));
    try {
      mkdirSync(join(dir, "d0"), { recursive: true });
      writeFileSync(join(dir, "d0", "a.zip"), Buffer.alloc(1, 7));
      const captured: any[] = [];
      const pipeline: any = { enqueueAssets(ids: number[], opts: any) { captured.push(opts); return ids.length; }, enqueueAsset() { return []; }, async drainAssets() { return true; }, start() {}, stop() {} };
      const deps: JobDeps = { repo, media: {} as any, booth: {} as any, log: () => {}, pipeline, limits: resolveLimits({ maxScanFiles: 10, registerBatchSize: 10 }) };
      const job = repo.createJob("scan", null, { path: dir, deep: true, indexWaitMs: 0 }, 5);
      await runJob(deps, job.id);
      assert.equal(repo.getJob(job.id)!.state, "done");
      assert.ok(captured.length >= 1);
      assert.ok(captured.every((o) => Number(o?.jobId) === job.id), "runner 必须透传 jobId，实际 " + JSON.stringify(captured));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
