/**
 * v0.6.1 task-13 事件保留（job_events / pipeline_events）测试
 * 覆盖：配置 clamp、终态边界保护（failed/paused/在飞不删）、有界批次、条数上限与 blocked、
 *       pipeline 活跃任务保护、失败可重试（state.error/failures）、discovery_throttled 合并、只删事件表。
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { openTempDb, addJob, addItem, addRoot, addAsset, count, type TempDb } from "../schema/_db";
import { Repo, normalizeEventRetention, DEFAULT_EVENT_RETENTION } from "../../apps/server/src/db/repo";
import { IndexPipeline } from "../../apps/server/src/services/pipeline/pipeline";
import { resolveLimits } from "../../apps/server/src/services/pipeline/limits";

const OLD = "2020-01-01T00:00:00.000Z";
const NOW = "2026-10-20T00:00:00.000Z";
let t: TempDb; let repo: Repo;
beforeEach(() => { t = openTempDb(); repo = new Repo(t.db); });
afterEach(() => t.close());

const jobEventCount = (jobId: number) => (repo.listJobEvents(jobId) as any[]).length;
const insertJobEvent = (jobId: number, at = OLD, event = "recovered", detail: string | null = null): number =>
  Number(t.db.prepare("INSERT INTO job_events(job_id, at, from_state, to_state, event, detail) VALUES (?,?,?,?,?,?)")
    .run(jobId, at, "resolving", "queued", event, detail).lastInsertRowid);
const insertPipelineEvent = (o: { at?: string; taskId?: number | null; assetId?: number | null; event?: string } = {}): number =>
  Number(t.db.prepare("INSERT INTO pipeline_events(at, task_id, asset_id, item_id, stage, event, detail) VALUES (?,?,?,?,?,?,?)")
    .run(o.at ?? OLD, o.taskId ?? null, o.assetId ?? null, null, "hash", o.event ?? "stale", null).lastInsertRowid);
const setCfg = (cfg: Record<string, unknown>) => repo.setSetting("event_retention", JSON.stringify(cfg));
const makePipeline = (log: (m: string) => void = () => {}) =>
  new IndexPipeline({
    repo, media: {} as any, cache: { pruneTemp: () => 0 } as any,
    limits: resolveLimits({}), log,
  });

describe("配置归一化（clamp）", () => {
  test("缺省/非法/越界都收敛；batchSize ≤500、天数≥0、窗口≤1d", () => {
    const d = normalizeEventRetention(null);
    assert.deepEqual(d, { ...DEFAULT_EVENT_RETENTION });
    const c = normalizeEventRetention({ jobDays: -5, pipelineDays: "x", batchSize: 999, jobMaxRows: -1, coalesceWindowMs: 999_999_999 });
    assert.equal(c.jobDays, 0);
    assert.equal(c.pipelineDays, DEFAULT_EVENT_RETENTION.pipelineDays);
    assert.equal(c.batchSize, 500);
    assert.equal(c.jobMaxRows, 0);
    assert.equal(c.coalesceWindowMs, 24 * 3600_000);
    // settings 覆盖生效
    setCfg({ jobDays: 3, jobMaxRows: 42, batchSize: 7 });
    const got = repo.getEventRetentionConfig();
    assert.equal(got.jobDays, 3);
    assert.equal(got.jobMaxRows, 42);
    assert.equal(got.batchSize, 7);
  });
});

describe("删除边界：terminal-only（failed/paused/在飞绝不删）", () => {
  test("旧事件：done/cancelled/abandoned 可删；failed（可 retry）/paused/resolving 保留", () => {
    const ids: Record<string, number> = {};
    for (const state of ["done", "cancelled", "abandoned", "failed", "paused", "resolving", "queued"]) {
      ids[state] = addJob(t.db, null, "scan", state);
      insertJobEvent(ids[state]);
    }
    setCfg({ jobDays: 1, jobMaxRows: 0, batchSize: 200, pipelineDays: 0, pipelineMaxRows: 0 });
    const p = makePipeline();
    return p.runRetention().then((state) => {
      assert.equal(state.deletedJobEvents, 3, "只有 3 个终态作业的事件可删");
      assert.equal(jobEventCount(ids.done), 0);
      assert.equal(jobEventCount(ids.cancelled), 0);
      assert.equal(jobEventCount(ids.abandoned), 0);
      for (const s of ["failed", "paused", "resolving", "queued"]) assert.equal(jobEventCount(ids[s]), 1, s + " 的事件必须保留");
      assert.equal(state.blocked.job, false);
    });
  });
});

describe("有界批次与幂等", () => {
  test("1200 条过期 terminal 事件：单批 ≤120，逐批收敛，最后幂等为 0", () => {
    const job = addJob(t.db, null, "scan", "done");
    for (let i = 0; i < 1200; i++) insertJobEvent(job);
    assert.equal(repo.countPrunableJobEvents(), 1200);
    let total = 0;
    for (let i = 0; i < 20; i++) {
      const n = repo.pruneJobEventsBatch({ cutoff: NOW, limit: 120 });
      assert.ok(n <= 120, "单批不得超过 limit");
      total += n;
      if (n === 0) break;
    }
    assert.equal(total, 1200);
    assert.equal(repo.pruneJobEventsBatch({ cutoff: NOW, limit: 120 }), 0, "幂等：再次调用 0 删除");
  });
});

describe("条数上限（保护优先，不达标就 blocked）", () => {
  test("500 条 terminal 事件 + jobMaxRows=300：删最老 200 条、保留最新 300 条", async () => {
    const job = addJob(t.db, null, "scan", "done");
    const ids: number[] = [];
    for (let i = 0; i < 500; i++) ids.push(insertJobEvent(job));
    setCfg({ jobDays: 0, jobMaxRows: 300, batchSize: 200, pipelineDays: 0, pipelineMaxRows: 0 });
    const state = await makePipeline().runRetention();
    assert.equal(state.deletedJobEvents, 200);
    assert.equal(repo.countJobEvents(), 300);
    const left = t.db.prepare("SELECT id FROM job_events ORDER BY id").all() as any[];
    assert.equal(left[0].id, ids[200], "删的是最老的 200 条");
    assert.equal(state.blocked.job, false);
    assert.equal(repo.getRetentionState()?.consecutiveFailures, 0);
  });

  test("可删集合已空仍超上限：停止并标 blocked，不删 failed/受保护事件", async () => {
    const done = addJob(t.db, null, "scan", "done");
    const failed = addJob(t.db, null, "scan", "failed");
    for (let i = 0; i < 100; i++) insertJobEvent(done);
    for (let i = 0; i < 50; i++) insertJobEvent(failed);
    setCfg({ jobDays: 0, jobMaxRows: 20, batchSize: 200, pipelineDays: 0, pipelineMaxRows: 0 });
    const state = await makePipeline().runRetention();
    assert.equal(jobEventCount(failed), 50, "failed 事件绝不为了条数上限被删");
    assert.equal(jobEventCount(done), 20, "terminal 事件降到上限即停");
    assert.equal(repo.countJobEvents(), 70);
    assert.equal(state.blocked.job, true, "总数仍超上限但可删集合已空 → blocked");
  });
});

describe("pipeline_events 活跃任务保护", () => {
  test("在飞任务（及其资产）的旧事件保留；终态任务/无任务事件可删", () => {
    const itemId = addItem(t.db);
    const rootId = addRoot(t.db, "/lib");
    const aActive = addAsset(t.db, itemId, rootId, "/lib/a.zip");
    const aDone = addAsset(t.db, itemId, rootId, "/lib/b.zip");
    const activeTask = repo.enqueueIndexTask({ assetId: aActive, stage: "hash", priority: 50 });
    const doneTask = repo.enqueueIndexTask({ assetId: aDone, stage: "hash", priority: 50 });
    repo.finishIndexTask(doneTask, "done");
    insertPipelineEvent({ taskId: activeTask, assetId: aActive });
    insertPipelineEvent({ taskId: null, assetId: aActive }); // 同资产的无任务事件也必须保护
    insertPipelineEvent({ taskId: doneTask, assetId: aDone });
    insertPipelineEvent({});
    assert.equal(repo.countPrunablePipelineEvents(), 2);
    setCfg({ jobDays: 0, jobMaxRows: 0, pipelineDays: 1, pipelineMaxRows: 0, batchSize: 200 });
    const n = repo.prunePipelineEventsBatch({ cutoff: NOW, limit: 200 });
    assert.equal(n, 2);
    const left = t.db.prepare("SELECT task_id, asset_id FROM pipeline_events").all() as any[];
    assert.equal(left.length, 2);
    assert.ok(left.every((r) => r.asset_id === aActive), "活跃资产的事件一条都不能删");
  });
});

describe("失败可重试 + 诊断", () => {
  test("删除失败不抛给定时器、state 记录 error/failures；恢复后下一轮成功并清零", async () => {
    const job = addJob(t.db, null, "scan", "done");
    for (let i = 0; i < 10; i++) insertJobEvent(job);
    setCfg({ jobDays: 1, jobMaxRows: 0, pipelineDays: 0, pipelineMaxRows: 0, batchSize: 10 });
    const p = makePipeline();
    t.db.exec("ALTER TABLE job_events RENAME TO job_events_bak");
    try {
      const bad = await p.runRetention();
      assert.ok(bad.error, "必须记录错误");
      assert.equal(bad.consecutiveFailures, 1);
      assert.equal(bad.deletedJobEvents, 0);
    } finally {
      t.db.exec("ALTER TABLE job_events_bak RENAME TO job_events");
    }
    const ok = await p.runRetention();
    assert.equal(ok.error, null);
    assert.equal(ok.consecutiveFailures, 0);
    assert.equal(ok.deletedJobEvents, 10);
    assert.equal(repo.getRetentionState()?.consecutiveFailures, 0);
  });
});

describe("discovery_throttled 合并（同 job+event，窗口内）", () => {
  test("窗口内合并为 1 行 detail.count=2/lastAt；跨 job、跨窗口、非 throttle 不合并", () => {
    const j1 = addJob(t.db, null, "scan", "resolving");
    const j2 = addJob(t.db, null, "scan", "resolving");
    assert.equal(repo.logJobEvent(j1, null, "resolving", "discovery_throttled", JSON.stringify({ batch: 1, depth: 5 })), true);
    assert.equal(repo.logJobEvent(j1, null, "resolving", "discovery_throttled", JSON.stringify({ batch: 2, depth: 6 })), true);
    let rows = repo.listJobEvents(j1) as any[];
    assert.equal(rows.length, 1, "窗口内同一 job+event 只保留 1 行");
    let d = JSON.parse(rows[0].detail);
    assert.equal(d.count, 2);
    assert.equal(d.depth, 6, "更新为最新 detail");
    assert.ok(d.lastAt);

    repo.logJobEvent(j2, null, "resolving", "discovery_throttled", JSON.stringify({ batch: 1, depth: 1 }));
    assert.equal((repo.listJobEvents(j2) as any[]).length, 1, "绝不跨 job 合并");

    // 跨窗口：把 j1 的事件挪到 10 分钟前 → 新调用必须新增一行
    t.db.prepare("UPDATE job_events SET at=? WHERE job_id=?").run("2020-01-01T00:00:00.000Z", j1);
    repo.logJobEvent(j1, null, "resolving", "discovery_throttled", JSON.stringify({ batch: 3, depth: 7 }));
    assert.equal((repo.listJobEvents(j1) as any[]).length, 2, "超出窗口不合并");

    // 非 throttle 诊断不合并
    repo.logJobEvent(j1, null, "resolving", "partial_failures", '{"count":1}');
    repo.logJobEvent(j1, null, "resolving", "partial_failures", '{"count":2}');
    assert.equal((repo.listJobEvents(j1) as any[]).filter((e) => e.event === "partial_failures").length, 2);
  });
});

describe("隔离与定时器 wiring", () => {
  test("只删事件表：assets/items 行数不变", async () => {
    const itemId = addItem(t.db); const rootId = addRoot(t.db, "/lib");
    addAsset(t.db, itemId, rootId, "/lib/a.zip");
    const job = addJob(t.db, null, "scan", "done");
    for (let i = 0; i < 5; i++) insertJobEvent(job);
    setCfg({ jobDays: 1, jobMaxRows: 0, pipelineDays: 0, pipelineMaxRows: 0 });
    const before = { assets: count(t.db, "assets"), items: count(t.db, "items") };
    await makePipeline().runRetention();
    assert.deepEqual({ assets: count(t.db, "assets"), items: count(t.db, "items") }, before);
  });

  test("start() 装配首跑/周期定时器，stop() 清理（不依赖真实到期）", async () => {
    const p = makePipeline();
    p.start();
    assert.ok((p as any).retentionInitial, "首跑定时器应存在");
    assert.ok((p as any).retentionTimer, "周期定时器应存在");
    await p.stop();
    assert.equal((p as any).retentionInitial, null);
    assert.equal((p as any).retentionTimer, null);
  });
});
