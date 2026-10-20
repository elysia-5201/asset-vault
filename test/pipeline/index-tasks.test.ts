/**
 * v0.6.0 流水线契约测试 —— index_tasks / repo 持久任务（verifier）
 * 覆盖：幂等入队、CAS 领取、优先级、依赖门控(done/skipped)、退避、恢复、取消、
 *       countActiveIndexTasks 分块（>1000）、markAssetsMissing 33k（SQL 变量上限回归）、
 *       依赖跳过/优先级提升/失败诊断/事件流/FK 级联。
 * 实现：apps/server/src/db/repo.ts（不改实现）
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { openPipelineDb, oneAsset, bulkAssets, activeTaskCount, taskById, eventTypes, type PipelineDb } from "./_helpers";
import { addAsset } from "../schema/_db";

let p: PipelineDb;
beforeEach(() => { p = openPipelineDb(); });
afterEach(() => p.t.close());

const past = () => new Date(Date.now() - 60_000).toISOString();
const future = () => new Date(Date.now() + 60_000).toISOString();

describe("enqueueIndexTask（幂等）", () => {
  test("新建任务默认 queued/attempts=0/max_attempts=3", () => {
    const a = oneAsset(p);
    const id = p.repo.enqueueIndexTask({ assetId: a, itemId: p.itemId, stage: "hash" });
    const row = taskById(p.t.db, id);
    assert.equal(row.state, "queued");
    assert.equal(row.attempts, 0);
    assert.equal(row.max_attempts, 3);
    assert.equal(row.asset_id, a);
    assert.equal(row.stage, "hash");
    assert.equal(activeTaskCount(p.t.db), 1);
  });

  test("同 asset+stage 重复入队只保留 1 条活跃任务（返回同 id）", () => {
    const a = oneAsset(p);
    const id1 = p.repo.enqueueIndexTask({ assetId: a, stage: "hash", priority: 1 });
    const id2 = p.repo.enqueueIndexTask({ assetId: a, stage: "hash", priority: 9 });
    assert.equal(id2, id1);
    assert.equal((p.t.db.prepare("SELECT COUNT(*) c FROM index_tasks").get() as { c: number }).c, 1);
    assert.equal(taskById(p.t.db, id1).priority, 9, "重复入队可提升优先级");
  });

  test("任务 done 后可再入队（新 id，旧记录保留）", () => {
    const a = oneAsset(p);
    const id1 = p.repo.enqueueIndexTask({ assetId: a, stage: "hash" });
    p.repo.finishIndexTask(id1, "done");
    const id2 = p.repo.enqueueIndexTask({ assetId: a, stage: "hash" });
    assert.notEqual(id2, id1);
    assert.equal((p.t.db.prepare("SELECT COUNT(*) c FROM index_tasks").get() as { c: number }).c, 2);
    assert.equal(activeTaskCount(p.t.db), 1);
  });

  test("不同 stage 互不去重", () => {
    const a = oneAsset(p);
    const h = p.repo.enqueueIndexTask({ assetId: a, stage: "hash" });
    const arc = p.repo.enqueueIndexTask({ assetId: a, stage: "archive" });
    assert.notEqual(h, arc);
    assert.equal(activeTaskCount(p.t.db), 2);
  });
});

describe("claimIndexTask（CAS / 优先级 / attempts）", () => {
  test("优先级高者先领取；同优先级按 id（FIFO）", () => {
    const a1 = oneAsset(p, "p1.zip"), a2 = oneAsset(p, "p2.zip"), a3 = oneAsset(p, "p3.zip");
    const low = p.repo.enqueueIndexTask({ assetId: a1, stage: "hash", priority: 0 });
    const high = p.repo.enqueueIndexTask({ assetId: a2, stage: "hash", priority: 10 });
    const mid = p.repo.enqueueIndexTask({ assetId: a3, stage: "hash", priority: 5 });
    assert.equal(p.repo.claimIndexTask("hash").id, high);
    assert.equal(p.repo.claimIndexTask("hash").id, mid);
    assert.equal(p.repo.claimIndexTask("hash").id, low);
  });

  test("CAS：只有一条可领取时，第二次 claim 返回 null（模拟两个 runner 竞争）", () => {
    const a = oneAsset(p);
    p.repo.enqueueIndexTask({ assetId: a, stage: "hash" });
    const first = p.repo.claimIndexTask("hash");
    const second = p.repo.claimIndexTask("hash");
    assert.ok(first);
    assert.equal(first.state, "running");
    assert.equal(second, null, "第二条 claim 必须拿不到（CAS WHERE state='queued'）");
    assert.equal((p.t.db.prepare("SELECT COUNT(*) c FROM index_tasks WHERE state='running'").get() as { c: number }).c, 1);
  });

  test("两条任务时两个 claim 各拿一条，不会重复领取", () => {
    const a1 = oneAsset(p, "c1.zip"), a2 = oneAsset(p, "c2.zip");
    const t1 = p.repo.enqueueIndexTask({ assetId: a1, stage: "hash" });
    const t2 = p.repo.enqueueIndexTask({ assetId: a2, stage: "hash" });
    const got = [p.repo.claimIndexTask("hash"), p.repo.claimIndexTask("hash")];
    assert.deepEqual(got.map((x: any) => x.id).sort((x: number, y: number) => x - y), [t1, t2].sort((x, y) => x - y));
    assert.equal(p.repo.claimIndexTask("hash"), null);
  });

  test("领取会：state=running、attempts+1、started_at 写值", () => {
    const a = oneAsset(p);
    const id = p.repo.enqueueIndexTask({ assetId: a, stage: "hash" });
    const claimed = p.repo.claimIndexTask("hash");
    assert.equal(claimed.id, id);
    assert.equal(claimed.state, "running");
    assert.equal(claimed.attempts, 1);
    assert.ok(claimed.started_at);
  });

  test("stage 隔离：claim('archive') 不会领走 hash 任务", () => {
    const a = oneAsset(p);
    p.repo.enqueueIndexTask({ assetId: a, stage: "hash" });
    assert.equal(p.repo.claimIndexTask("archive"), null);
    assert.ok(p.repo.claimIndexTask("hash"));
  });
});

describe("依赖门控", () => {
  test("depends_on 未完成 → 不可领取；done 后可领取", () => {
    const a = oneAsset(p);
    const parent = p.repo.enqueueIndexTask({ assetId: a, stage: "hash" });
    const b = addAsset(p.t.db, p.itemId, p.rootId, "/lib/dep.zip");
    const child = p.repo.enqueueIndexTask({ assetId: b, stage: "hash", dependsOn: parent });
    assert.equal(p.repo.claimIndexTask("hash").id, parent, "先领父任务");
    assert.equal(p.repo.claimIndexTask("hash"), null, "父未完成时子不可领");
    p.repo.finishIndexTask(parent, "done");
    assert.equal(p.repo.claimIndexTask("hash").id, child);
  });

  test("父 skipped 也算满足依赖", () => {
    const a = oneAsset(p, "s1.zip"), b = oneAsset(p, "s2.zip");
    const parent = p.repo.enqueueIndexTask({ assetId: a, stage: "thumb" });
    const child = p.repo.enqueueIndexTask({ assetId: b, stage: "thumb", dependsOn: parent });
    p.repo.finishIndexTask(parent, "skipped");
    assert.equal(p.repo.claimIndexTask("thumb").id, child);
  });

  test("父 failed / cancelled 不满足依赖（子保持 queued，可被 skipDependentTasks 收尾）", () => {
    const a = oneAsset(p, "f1.zip"), b = oneAsset(p, "f2.zip");
    const parent = p.repo.enqueueIndexTask({ assetId: a, stage: "thumb" });
    const child = p.repo.enqueueIndexTask({ assetId: b, stage: "thumb", dependsOn: parent });
    p.repo.finishIndexTask(parent, "failed", { errorCode: "E_PARSE", error: "bad" });
    assert.equal(p.repo.claimIndexTask("thumb"), null);
    assert.equal(taskById(p.t.db, child).state, "queued");
  });
});

describe("退避 / 重试 / 人工重排", () => {
  test("retry 后立即不可领取；到退避时间后可领取且 attempts 递增", () => {
    const a = oneAsset(p);
    const id = p.repo.enqueueIndexTask({ assetId: a, stage: "hash" });
    p.repo.claimIndexTask("hash");
    p.repo.retryIndexTask(id, { errorCode: "E_BUSY", error: "locked", backoffMs: 60_000 });
    const row = taskById(p.t.db, id);
    assert.equal(row.state, "waiting_retry");
    assert.ok(row.next_retry_at);
    assert.equal(p.repo.claimIndexTask("hash"), null, "退避未到期不可领取");
    // waiting_retry → queued 由 recoverIndexTasks 负责（worker 只 claim queued）
    assert.equal(p.repo.recoverIndexTasks(), 0, "退避未到期时不应被恢复");
    p.t.db.prepare("UPDATE index_tasks SET next_retry_at=? WHERE id=?").run(past(), id);
    assert.equal(p.repo.recoverIndexTasks(), 1, "到期后恢复为 queued");
    const claimed = p.repo.claimIndexTask("hash");
    assert.equal(claimed.id, id);
    assert.equal(claimed.attempts, 2);
  });

  test("requeueIndexTask：清空 attempts/error/退避，立即可领（attempts 从 1 重新计数）", () => {
    const a = oneAsset(p);
    const id = p.repo.enqueueIndexTask({ assetId: a, stage: "hash" });
    p.repo.claimIndexTask("hash");
    p.repo.retryIndexTask(id, { errorCode: "E", error: "x", backoffMs: 60_000 });
    assert.equal(taskById(p.t.db, id).attempts, 1);
    const q = p.repo.requeueIndexTask(id);
    assert.equal(q.state, "queued");
    assert.equal(q.attempts, 0);
    assert.equal(q.error, null);
    assert.equal(q.next_retry_at, null);
    assert.equal(p.repo.claimIndexTask("hash").attempts, 1);
  });

  test("retry 到 max_attempts 后由调用方判 failed（本层只负责状态与计数）", () => {
    const a = oneAsset(p);
    const id = p.repo.enqueueIndexTask({ assetId: a, stage: "hash", maxAttempts: 2 });
    p.repo.claimIndexTask("hash");
    p.repo.retryIndexTask(id, { backoffMs: 0 });
    p.repo.recoverIndexTasks();               // 退避到期 → 排回 queued
    p.repo.claimIndexTask("hash");
    const row = taskById(p.t.db, id);
    assert.equal(row.attempts, 2);
    assert.equal(row.max_attempts, 2);
    const failed = p.repo.finishIndexTask(id, "failed", { errorCode: "E_MAX", error: "exhausted" });
    assert.equal(failed.state, "failed");
    assert.ok(failed.finished_at);
  });
});

describe("取消 / 恢复", () => {
  test("cancelIndexTask 只取消 queued/waiting_retry；running 不受影响（已知语义）", () => {
    const a1 = oneAsset(p, "x1.zip"), a2 = oneAsset(p, "x2.zip");
    const q = p.repo.enqueueIndexTask({ assetId: a1, stage: "hash" });
    const r = p.repo.enqueueIndexTask({ assetId: a2, stage: "hash" });
    assert.equal(p.repo.claimIndexTask("hash").id, q); // q → running
    p.repo.cancelIndexTask(q);
    assert.equal(taskById(p.t.db, q).state, "running", "running 不能被 DB 直接取消（需内存 abort）");
    p.repo.cancelIndexTask(r);
    assert.equal(taskById(p.t.db, r).state, "cancelled");
    assert.equal(activeTaskCount(p.t.db), 1);
  });

  test("recoverIndexTasks：running→queued、到期 waiting_retry→queued、未来退避保持；写 recovered 事件", () => {
    const a1 = oneAsset(p, "r1.zip"), a2 = oneAsset(p, "r2.zip"), a3 = oneAsset(p, "r3.zip");
    const running = p.repo.enqueueIndexTask({ assetId: a1, stage: "hash" });
    const due = p.repo.enqueueIndexTask({ assetId: a2, stage: "hash" });
    const later = p.repo.enqueueIndexTask({ assetId: a3, stage: "hash" });
    p.repo.claimIndexTask("hash");                       // running
    p.repo.claimIndexTask("hash");                       // due → running
    p.repo.retryIndexTask(due, { backoffMs: 0 });        // waiting_retry（已到期）
    p.repo.claimIndexTask("hash");                       // later → running
    p.repo.retryIndexTask(later, { backoffMs: 60_000 }); // 未到期
    const n = p.repo.recoverIndexTasks();
    assert.equal(n, 2, "running + 到期 waiting_retry = 2");
    assert.equal(taskById(p.t.db, running).state, "queued");
    assert.equal(taskById(p.t.db, due).state, "queued");
    assert.equal(taskById(p.t.db, later).state, "waiting_retry");
    assert.deepEqual(eventTypes(p.t.db, running), ["recovered"]);
    assert.deepEqual(eventTypes(p.t.db, due), ["recovered"]);
    assert.equal(taskById(p.t.db, running).attempts, 1, "恢复不增加 attempts");
  });
});

describe("批量/上限回归", () => {
  test("countActiveIndexTasks：1200 资产分块统计不炸变量上限", () => {
    const ids = bulkAssets(p.t.db, p.itemId, p.rootId, 1200, "bulk");
    // 每条资产一个 stage 任务
    p.t.db.transaction(() => {
      for (const id of ids) p.repo.enqueueIndexTask({ assetId: id, stage: "hash" });
    })();
    assert.equal(p.repo.countActiveIndexTasks(ids), 1200);
    // 完成 200 条后减少；重复 id 去重
    p.t.db.transaction(() => {
      const rows = p.t.db.prepare("SELECT id FROM index_tasks WHERE stage='hash' LIMIT 200").all() as any[];
      for (const r of rows) p.repo.finishIndexTask(r.id, "done");
    })();
    assert.equal(p.repo.countActiveIndexTasks(ids), 1000);
    // 前 200 条已 done；用仍活跃的 id 验证去重与计数
    assert.equal(p.repo.countActiveIndexTasks([ids[1000]!, ids[1000]!]), 1, "重复 id 必须去重");
    assert.equal(p.repo.countActiveIndexTasks([ids[1000]!, ids[1001]!]), 2);
    assert.equal(p.repo.countActiveIndexTasks([ids[0]!]), 0, "已 done 的不计入活跃");
  });

  test("markAssetsMissing：33,000 个 id 不抛 too many SQL variables（A4 回归）", () => {
    const ids = bulkAssets(p.t.db, p.itemId, p.rootId, 33000, "missing");
    assert.equal(ids.length, 33000);
    assert.doesNotThrow(() => p.repo.markAssetsMissing(ids));
    const missing = Number((p.t.db.prepare("SELECT COUNT(*) c FROM assets WHERE status='missing'").get() as { c: number }).c);
    assert.equal(missing, 33000, "全部标 missing");
    // 幂等 + 空数组 + 重复 id 不抛
    assert.doesNotThrow(() => p.repo.markAssetsMissing([]));
    assert.doesNotThrow(() => p.repo.markAssetsMissing([ids[0]!, ids[0]!, -1, NaN]));
  });
});

describe("依赖跳过 / 优先级提升 / 诊断 / 事件", () => {
  test("skipDependentTasks：只跳过直接依赖它的 queued/waiting_retry，running/孙任务不动", () => {
    const a1 = oneAsset(p, "d1.zip"), a2 = oneAsset(p, "d2.zip"), a3 = oneAsset(p, "d3.zip"), a4 = oneAsset(p, "d4.zip");
    const parent = p.repo.enqueueIndexTask({ assetId: a1, stage: "archive" });
    const direct = p.repo.enqueueIndexTask({ assetId: a2, stage: "archive", dependsOn: parent });
    const runningChild = p.repo.enqueueIndexTask({ assetId: a3, stage: "archive", dependsOn: parent });
    const grandchild = p.repo.enqueueIndexTask({ assetId: a4, stage: "archive", dependsOn: direct });
    // 让 runningChild 处于 running（先领 parent？不行——依赖 parent 被领走后 runningChild 仍不可领）
    // 直接改状态模拟"另一个 worker 已领走"：
    p.t.db.prepare("UPDATE index_tasks SET state='running' WHERE id=?").run(runningChild);
    const n = p.repo.skipDependentTasks(parent, "E_UPSTREAM", "upstream failed");
    assert.equal(n, 1);
    assert.equal(taskById(p.t.db, direct).state, "skipped");
    assert.equal(taskById(p.t.db, direct).error_code, "E_UPSTREAM");
    assert.equal(taskById(p.t.db, runningChild).state, "running", "已运行的不动");
    assert.equal(taskById(p.t.db, grandchild).state, "queued", "孙任务不直接跳过");
  });

  test("boostIndexTasks：queued/waiting_retry 提升到更高优先级；running/done 不动；只升不降", () => {
    const a1 = oneAsset(p, "b1.zip"), a2 = oneAsset(p, "b2.zip"), a3 = oneAsset(p, "b3.zip");
    const q = p.repo.enqueueIndexTask({ assetId: a1, stage: "hash", priority: 1 });
    const r = p.repo.enqueueIndexTask({ assetId: a2, stage: "hash", priority: 1 });
    const d = p.repo.enqueueIndexTask({ assetId: a3, stage: "hash", priority: 1 });
    const claimed = p.repo.claimIndexTask("hash");   // 按 id 先领 q → running
    assert.equal(claimed.id, q);
    p.repo.finishIndexTask(d, "done");
    assert.equal(p.repo.boostIndexTasks(a1, 9), 0, "running 不提升");
    assert.equal(taskById(p.t.db, q).priority, 1);
    assert.equal(p.repo.boostIndexTasks(a2, 3), 1);
    assert.equal(taskById(p.t.db, r).priority, 3);
    assert.equal(p.repo.boostIndexTasks(a2, 9), 1);
    assert.equal(taskById(p.t.db, r).priority, 9, "可继续提升");
    assert.equal(p.repo.boostIndexTasks(a2, 2), 1, "UPDATE 命中但 MAX 保持 9");
    assert.equal(taskById(p.t.db, r).priority, 9, "只升不降");
    assert.equal(p.repo.boostIndexTasks(a3, 9), 0, "done 不提升");
  });

  test("recentIndexFailures 带资产路径；listIndexTasks 过滤", () => {
    const a = oneAsset(p, "fail.zip");
    const id = p.repo.enqueueIndexTask({ assetId: a, stage: "archive" });
    p.repo.finishIndexTask(id, "failed", { errorCode: "E_ZIP", error: "bad archive" });
    const fails = p.repo.recentIndexFailures(5);
    assert.equal(fails.length, 1);
    assert.equal(fails[0].id, id);
    assert.equal(fails[0].path, "/lib/fail.zip");
    assert.equal(fails[0].error_code, "E_ZIP");
    assert.equal(p.repo.listIndexTasks({ state: "failed" }).length, 1);
    assert.equal(p.repo.listIndexTasks({ state: "queued" }).length, 0);
  });

  test("logPipelineEvent/listPipelineEvents：倒序、afterId 增量", () => {
    p.repo.logPipelineEvent({ event: "a", stage: "hash" });
    p.repo.logPipelineEvent({ event: "b", stage: "hash" });
    const latest = p.repo.listPipelineEvents(10, 0);
    assert.deepEqual(latest.map((e: any) => e.event), ["b", "a"]);
    assert.deepEqual(p.repo.listPipelineEvents(10, latest[0]!.id).map((e: any) => e.event), [], "after 最新 id → 空");
    assert.deepEqual(p.repo.listPipelineEvents(10, latest[latest.length - 1]!.id).map((e: any) => e.event), ["b"], "after 最早 id → 只到 b");
  });

  test("updateIndexTask：进度字段落库且负数被钳为 0", () => {
    const a = oneAsset(p, "prog.zip");
    const id = p.repo.enqueueIndexTask({ assetId: a, stage: "hash" });
    p.repo.updateIndexTask(id, { bytesDone: -5, bytesTotal: 100, itemsDone: 3, itemsTotal: 10, error: "warn", errorCode: "E_W" });
    const row = taskById(p.t.db, id);
    assert.equal(row.bytes_done, 0);
    assert.equal(row.bytes_total, 100);
    assert.equal(row.items_done, 3);
    assert.equal(row.error, "warn");
    assert.equal(row.error_code, "E_W");
  });
});

describe("已知实现缺口（TODO：不弄红套件，证据已报 lead）", () => {
  test("[BUG] 到期的 waiting_retry 在服务运行期间无法被重新领取", { todo: "pipeline.ts:78 只在 start() 调 recoverIndexTasks；loop 只 claimIndexTask('queued') → 退避到期后没有任何组件把 waiting_retry 排回 queued" }, () => {
    const a = oneAsset(p, "bug-retry.zip");
    const id = p.repo.enqueueIndexTask({ assetId: a, stage: "hash" });
    p.repo.claimIndexTask("hash");
    p.repo.retryIndexTask(id, { errorCode: "E_BUSY", error: "locked", backoffMs: 1 });
    // 等到退避时间已过（不 sleep：直接把 next_retry_at 置为过去）
    p.t.db.prepare("UPDATE index_tasks SET next_retry_at=? WHERE id=?").run(past(), id);
    // 期望：到期任务可被重新领取（实现里需要 recoverIndexTasks 或等价的"到期提升"）
    const claimed = p.repo.claimIndexTask("hash");
    assert.ok(claimed, "退避已到期，却没有可领取的任务 → 重试永远不会发生（直到进程重启）");
    assert.equal(claimed.id, id);
  });
});

describe("FK / 诊断保留", () => {
  test("删除 asset 级联删除它的 index_tasks；pipeline_events 保留（无 FK，只增不改）", () => {
    const a = oneAsset(p, "cascade.zip");
    const id = p.repo.enqueueIndexTask({ assetId: a, stage: "hash" });
    p.repo.logPipelineEvent({ taskId: id, assetId: a, event: "enqueued", stage: "hash" });
    p.t.db.prepare("DELETE FROM assets WHERE id=?").run(a);
    assert.equal((p.t.db.prepare("SELECT COUNT(*) c FROM index_tasks WHERE asset_id=?").get(a) as { c: number }).c, 0, "index_tasks 必须级联删除");
    assert.equal((p.t.db.prepare("SELECT COUNT(*) c FROM pipeline_events WHERE asset_id=?").get(a) as { c: number }).c, 1, "诊断事件应保留");
  });
});
