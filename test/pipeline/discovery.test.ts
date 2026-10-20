/**
 * v0.6.1-G2 发现集成测试（task-18）
 * 覆盖：TEMP 清单（addMany 批边界、NOT EXISTS 判缺、幂等）、批次事务回滚（无孤儿条目）、
 *       runner 流式消费（filesOut 不累积、批量入队、旧 seen 路径零调用）、取消（CANCELLED 且清单不 finish）、
 *       背压 throttled 落 job event。
 * 实现：apps/server/src/{jobs/runner.ts,db/repo.ts}（测试不改实现）
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTempDb, addRoot, addItem, addAsset, count, type TempDb } from "../schema/_db";
import { Repo } from "../../apps/server/src/db/repo";
import { runJob, type JobDeps } from "../../apps/server/src/jobs/runner";
import { walkCandidates, createMemoryManifest } from "../../apps/server/src/services/scan";
import { resolveLimits } from "../../apps/server/src/services/pipeline/limits";

/** 造一棵全是 .zip 的临时树（候选数 = n）。 */
function makeTree(n: number): string {
  const root = mkdtempSync(join(tmpdir(), "av-discovery-"));
  const dir = join(root, "d0");
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < n; i++) writeFileSync(join(dir, "item_" + i + "_素材.zip"), Buffer.alloc(1, 7));
  return root;
}

function fakePipeline() {
  const calls = { bulk: 0, bulkIds: 0, single: 0, drain: 0 };
  const pipeline: any = {
    enqueueAssets(ids: number[]) { calls.bulk++; calls.bulkIds += (ids ?? []).length; return (ids ?? []).length; },
    enqueueAsset() { calls.single++; return []; },
    async drainAssets() { calls.drain++; return true; },
    start() {}, stop() {},
  };
  return { pipeline, calls };
}

const tempRows = (db: any, name: string): number | null => {
  try { return Number(db.prepare("SELECT COUNT(*) c FROM \"" + name + "\"").get().c); } catch { return null; }
};

describe("R5：背压只看本轮扫描资产", () => {
  test("countQueuedScanAssets 只统计 scan_assets 里的 queued 任务，历史积压不计入", () => {
    const t = openTempDb();
    try {
      const repo = new Repo(t.db);
      const itemId = addItem(t.db); const rootId = addRoot(t.db, "/lib");
      const a1 = addAsset(t.db, itemId, rootId, "/lib/x1.zip");
      const a2 = addAsset(t.db, itemId, rootId, "/lib/x2.zip");
      const a3 = addAsset(t.db, itemId, rootId, "/lib/x3.zip");
      repo.resetScanSeen();
      repo.insertScanAssetsBatch([a1, a2]);
      repo.enqueueIndexTask({ assetId: a1, stage: "hash", priority: 50 });
      repo.enqueueIndexTask({ assetId: a2, stage: "hash", priority: 50 });
      repo.enqueueIndexTask({ assetId: a3, stage: "hash", priority: 50 }); // 历史/别的扫描：不计入
      assert.equal(repo.countQueuedScanAssets(), 2);
      const task = repo.claimIndexTask("hash");
      assert.equal(repo.countQueuedScanAssets(), 1);
      repo.finishIndexTask(task.id, "done");
      assert.equal(repo.countQueuedScanAssets(), 1, "另一条本轮任务仍 queued");
    } finally { t.close(); }
  });
});

describe("TEMP 扫描清单（repo）", () => {
  let t: TempDb; let repo: Repo; let itemId: number; let rootId: number;
  beforeEach(() => {
    t = openTempDb(); repo = new Repo(t.db);
    itemId = addItem(t.db); rootId = addRoot(t.db, "/lib");
    repo.resetScanSeen();
  });
  afterEach(() => t.close());

  const asset = (p: string) => repo.upsertAsset({ item_id: itemId, kind: "archive", container: "zip", path: p, path_norm: p, root_id: rootId, size: 1, mtime: "2026-10-01T00:00:00.000Z", discovered_by: "scan" });

  test("addMany 一条多行落账、去重；has/size 与实际行数一致", () => {
    repo.insertScanSeenBatch(["/lib/a.zip", "/lib/sub/b.zip", "/lib/a.zip"]);
    assert.equal(repo.scanSeenCount(), 2);
    assert.equal(repo.scanSeenHas("/lib/a.zip"), true);
    assert.equal(repo.scanSeenHas("/lib/nope.zip"), false);
    repo.resetScanSeen();
    assert.equal(repo.scanSeenCount(), 0);
  });

  test("判缺 = present − 清单（NOT EXISTS）；路径段边界不误伤 sibling 前缀", () => {
    asset("/lib/a.zip"); asset("/lib/sub/b.zip"); asset("/lib/c.zip"); asset("/library/x.zip"); asset("/lib2/y.zip");
    repo.insertScanSeenBatch(["/lib/a.zip", "/lib/sub/b.zip"]);
    const missing = repo.listMissingUnderPath("/lib").map((a) => a.path_norm).sort();
    assert.deepEqual(missing, ["/lib/c.zip"], "只应报告本根下真正未见的资产");
    assert.equal(repo.countMissingUnderPath("/lib"), 1);
    // 正例对照：全部写进清单后判缺为 0
    repo.insertScanSeenBatch(["/lib/c.zip"]);
    assert.equal(repo.listMissingUnderPath("/lib").length, 0);
  });
});

describe("批次事务（repo.transaction）", () => {
  test("批内抛错整批回滚：不留孤儿 local 条目/资产", () => {
    const t = openTempDb();
    try {
      const repo = new Repo(t.db);
      const before = { items: count(t.db, "items"), assets: count(t.db, "assets") };
      assert.throws(() => repo.transaction(() => {
        repo.createItem({ title: "orphan", source_site: "local" });
        throw new Error("boom");
      }), /boom/);
      assert.deepEqual({ items: count(t.db, "items"), assets: count(t.db, "assets") }, before);
    } finally { t.close(); }
  });
});

describe("runner 流式消费（批量 + 不累积 + 可重放）", () => {
  test("扫描 5 个包：批量入队 1 次、旧 seen 路径 0 调用、清单行数=候选数；重放幂等", async () => {
    const t = openTempDb();
    const root = makeTree(5);
    try {
      const repo = new Repo(t.db);
      let legacySeenCalls = 0;
      const orig = repo.listPresentAssetsUnderPath.bind(repo);
      (repo as any).listPresentAssetsUnderPath = (...a: any[]) => { legacySeenCalls++; return (orig as any)(...a); };
      const { pipeline, calls } = fakePipeline();
      const deps: JobDeps = { repo, media: {} as any, booth: {} as any, log: () => {}, pipeline, limits: resolveLimits({ maxScanFiles: 100, registerBatchSize: 2, queueHighWater: 1e9, queueLowWater: 1e9 }) };

      const job = repo.createJob("scan", null, { path: root, deep: true, indexWaitMs: 0 }, 5);
      await runJob(deps, job.id);
      assert.equal(repo.getJob(job.id)!.state, "done");
      assert.equal(count(t.db, "assets"), 5);
      assert.equal(count(t.db, "items"), 5);
      assert.equal(tempRows(t.db, "scan_seen"), 5, "TEMP 清单行数必须=候选数（批边界落账）");
      assert.equal(tempRows(t.db, "scan_assets"), 5);
      assert.equal(tempRows(t.db, "scan_items"), 0, "条目清单必须分批消费后清空（不再保留 10 万 itemIds 的 Set）");
      assert.equal(legacySeenCalls, 0, "旧 listPresentAssetsUnderPath/seen 路径必须不再被调用");
      assert.equal(calls.bulk, 3, "5 个文件 batch=2 → 3 批，每批一次批量入队");
      assert.equal(calls.bulkIds, 5);
      assert.equal(calls.single, 0, "不得逐条 enqueue");

      // 重放：同一路径再扫一遍 → 不新增条目/资产，全部 created=0（幂等）
      const job2 = repo.createJob("scan", null, { path: root, deep: true, indexWaitMs: 0 }, 5);
      await runJob(deps, job2.id);
      assert.equal(repo.getJob(job2.id)!.state, "done");
      assert.equal(count(t.db, "items"), 5, "重放不得产生孤儿/重复本地条目");
      assert.equal(count(t.db, "assets"), 5);
      assert.equal(tempRows(t.db, "scan_seen"), 5);
      assert.equal(calls.bulk, 3, "未变化的资产不重复入队");
    } finally { t.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test("取消：walk 抛 CANCELLED，清单不 finish、未提交批次不记", async () => {
    const root = makeTree(6);
    try {
      const ac = new AbortController();
      const mem = createMemoryManifest();
      let finishCalls = 0;
      const manifest = {
        add: (p: string) => mem.add(p),
        addMany: (ps: string[]) => mem.addMany(ps),
        get size() { return mem.size; },
        has: (p: string) => mem.has(p),
        finish: () => { finishCalls++; },
      };
      let batches = 0;
      await assert.rejects(
        walkCandidates(root, {
          batchSize: 2, manifest, signal: ac.signal,
          onBatch: async () => { batches++; ac.abort(); },
        }),
        (e: any) => e.code === "CANCELLED"
      );
      assert.equal(batches, 1, "第一批回调后立即取消");
      assert.equal(finishCalls, 0, "取消时清单绝不 finish");
      assert.ok(mem.size <= 2, "只允许已成功提交的第一批落账，实际 " + mem.size);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("R2：批次入队抛错 → 整批回滚（无资产/条目）；重放后正常创建并入队", async () => {
    const t = openTempDb();
    const root = makeTree(2);
    try {
      const repo = new Repo(t.db);
      const broken = {
        enqueueAssets() { throw new Error("enqueue boom"); },
        enqueueAsset() { throw new Error("enqueue boom"); },
        async drainAssets() { return true; }, start() {}, stop() {},
      };
      const depsBad: JobDeps = { repo, media: {} as any, booth: {} as any, log: () => {}, pipeline: broken as any, limits: resolveLimits({ maxScanFiles: 10, registerBatchSize: 10 }) };
      const job = repo.createJob("scan", null, { path: root, deep: true, indexWaitMs: 0 }, 5);
      await runJob(depsBad, job.id);
      assert.equal(repo.getJob(job.id)!.state, "failed", "入队失败必须让整批作业失败，而不是静默成功");
      assert.equal(count(t.db, "assets"), 0, "批次事务必须回滚已登记的资产");
      assert.equal(count(t.db, "items"), 0, "批次事务必须回滚已创建的条目");
      assert.equal(tempRows(t.db, "scan_assets"), 0);

      // 重放：正常 pipeline → 能重新创建并批量入队（created 不再被"已提交但未入队"卡住）
      const { pipeline, calls } = fakePipeline();
      const depsOk: JobDeps = { repo, media: {} as any, booth: {} as any, log: () => {}, pipeline, limits: resolveLimits({ maxScanFiles: 10, registerBatchSize: 10 }) };
      const job2 = repo.createJob("scan", null, { path: root, deep: true, indexWaitMs: 0 }, 5);
      await runJob(depsOk, job2.id);
      assert.equal(repo.getJob(job2.id)!.state, "done");
      assert.equal(count(t.db, "assets"), 2);
      assert.equal(count(t.db, "items"), 2);
      assert.equal(calls.bulk, 1);
      assert.equal(calls.bulkIds, 2, "重放必须把资产重新批量入队，而不是 created=0 直接跳过");
    } finally { t.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test("背压 throttled：超过 maxWait 放行并写 discovery_throttled 事件", async () => {
    const t = openTempDb();
    const root = makeTree(1);
    try {
      const repo = new Repo(t.db);
      const origCount = repo.countQueuedScanAssets.bind(repo);
      (repo as any).countQueuedScanAssets = () => 999;
      process.env.ASSETVAULT_SCAN_GATE_MAX_WAIT_MS = "80";
      const { pipeline } = fakePipeline();
      const deps: JobDeps = { repo, media: {} as any, booth: {} as any, log: () => {}, pipeline, limits: resolveLimits({ maxScanFiles: 10, registerBatchSize: 1, queueHighWater: 1, queueLowWater: 1 }) };
      const job = repo.createJob("scan", null, { path: root, deep: true, indexWaitMs: 0 }, 5);
      try { await runJob(deps, job.id); } finally {
        (repo as any).countQueuedScanAssets = origCount;
        delete process.env.ASSETVAULT_SCAN_GATE_MAX_WAIT_MS;
      }
      assert.equal(repo.getJob(job.id)!.state, "done");
      const ev = (repo.listJobEvents(job.id) as any[]).find((e) => e.event === "discovery_throttled");
      assert.ok(ev, "必须写 discovery_throttled，实际事件：" + (repo.listJobEvents(job.id) as any[]).map((e) => e.event).join(","));
      const detail = JSON.parse(ev.detail);
      assert.equal(detail.depth, 999);
      assert.ok(detail.waitedMs >= 80);
    } finally { t.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test("R4：预览分支透传 limit（超出候选数 → 只扫前 N 个，scan_json 记录 limit）", async () => {
    const t = openTempDb();
    const root = makeTree(5);
    try {
      const repo = new Repo(t.db);
      const preview = repo.createScanPreview({ rootId: null, path: root, deep: true });
      const deps: JobDeps = { repo, media: {} as any, booth: {} as any, log: () => {}, limits: resolveLimits({ maxScanFiles: 2, registerBatchSize: 2 }) };
      const job = repo.createJob("scan", null, { path: root, deep: true, mode: "preview", previewId: preview.id }, 5);
      await runJob(deps, job.id);
      assert.equal(repo.getJob(job.id)!.state, "done");
      const p = repo.getScanPreview(preview.id);
      assert.ok(Number(p.files) <= 2, "预览候选必须被 limit 截断，实际 files=" + p.files);
      const scanJson = JSON.parse(String(p.scan_json));
      assert.equal(scanJson.limit, 2);
      assert.ok(scanJson.limitNote, "被截断时必须给出 limitNote");
    } finally { t.close(); rmSync(root, { recursive: true, force: true }); }
  });
});
