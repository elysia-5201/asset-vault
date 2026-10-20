/**
 * v0.6.0 契约测试 —— jobs 状态机/事件原子性/领取/恢复（verifier）
 * 覆盖：转移恰好 1 条事件、非法转移 0 事件、DB 错误时状态回滚（原子性）、
 *       claimNextJob CAS（单/双 runner 模拟）、retry 守卫、recoverInFlight 与毒作业上限。
 * 实现：apps/server/src/db/repo.ts（不改实现）
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { openTempDb, addItem, addJob, type TempDb } from "../schema/_db";
import { Repo } from "../../apps/server/src/db/repo";

let t: TempDb;
let repo: Repo;
beforeEach(() => { t = openTempDb(); repo = new Repo(t.db); });
afterEach(() => t.close());

const events = (id: number) => repo.listJobEvents(id) as any[];
const mk = (kind = "scan", itemId: number | null = null) => addJob(t.db, itemId, kind, "queued");

describe("transitionJob：状态与事件", () => {
  test("一次合法转移 → 恰好 1 条事件，from/to/event/detail 正确，状态落库", () => {
    const id = mk();
    const j = repo.transitionJob(id, "start");
    assert.equal(j.state, "resolving");
    assert.ok(j.started_at);
    const ev = events(id);
    assert.equal(ev.length, 1);
    assert.deepEqual([ev[0].from_state, ev[0].to_state, ev[0].event], ["queued", "resolving", "start"]);
    assert.ok(ev[0].at);
  });

  test("detail 只写进事件；failed 时同时写 jobs.error，done 时清空 error", () => {
    const id = mk();
    repo.transitionJob(id, "start");
    repo.transitionJob(id, "stop");
    const failed = repo.transitionJob(id, "fail", "boom");
    assert.equal(failed.state, "failed");
    assert.equal(failed.error, "boom");
    assert.equal(events(id).at(-1).detail, "boom");
    const id2 = mk("reindex");
    for (const ev of ["start", "resolve_ok", "fetch_ok", "commit", "index_ok", "match_ok", "succeed"] as const) repo.transitionJob(id2, ev);
    assert.equal(repo.getJob(id2)!.state, "done");
    assert.equal(repo.getJob(id2)!.error, null);
  });

  test("非法转移 → 抛 INVALID_TRANSITION(409)，不写事件、状态不变（负例对照）", () => {
    const id = mk();
    const before = events(id).length;
    assert.throws(() => repo.transitionJob(id, "resolve_ok"), (e: any) => e.code === "INVALID_TRANSITION" && e.status === 409);
    assert.equal(events(id).length, before, "非法转移绝不能写事件");
    assert.equal(repo.getJob(id)!.state, "queued");
  });

  test("原子性：事件写入失败时状态回滚（注入 DB 错误）", () => {
    const id = mk();
    repo.transitionJob(id, "start");
    const before = events(id).length;
    t.db.exec("ALTER TABLE job_events RENAME TO job_events_bak");
    try {
      assert.throws(() => repo.transitionJob(id, "resolve_ok"), /no such table|SQLITE_ERROR/i);
      assert.equal(repo.getJob(id)!.state, "resolving", "事件写失败必须回滚状态（不能出现'状态前进但无事件'）");
      assert.equal((t.db.prepare("SELECT COUNT(*) c FROM job_events_bak").get() as any).c, before);
    } finally {
      t.db.exec("ALTER TABLE job_events_bak RENAME TO job_events");
    }
    assert.equal(events(id).length, before);
    assert.equal(repo.transitionJob(id, "resolve_ok").state, "fetching", "恢复后同一转移可正常完成");
  });

  test("logJobEvent 只追加诊断事件，不改状态", () => {
    const id = mk();
    repo.transitionJob(id, "start");
    repo.logJobEvent(id, null, "resolving", "partial_failures", "{\"count\":1}");
    assert.equal(repo.getJob(id)!.state, "resolving");
    const ev = events(id);
    assert.equal(ev.length, 2);
    assert.equal(ev[1].from_state, null);
    assert.equal(ev[1].event, "partial_failures");
  });
});

describe("claimNextJob（CAS）", () => {
  test("领取：queued→resolving、attempts+1、started_at、恰好 1 条 start 事件", () => {
    const id = mk();
    const j = repo.claimNextJob()!;
    assert.equal(j.id, id);
    assert.equal(j.state, "resolving");
    assert.equal(j.attempts, 1);
    assert.ok(j.started_at);
    assert.deepEqual(events(id).map((e) => e.event), ["start"]);
  });

  test("没有 queued → null，且不会凭空造事件", () => {
    assert.equal(repo.claimNextJob(), null);
    assert.equal((t.db.prepare("SELECT COUNT(*) c FROM job_events").get() as any).c, 0);
  });

  test("双 runner 抢同一条：第二个必须拿不到（不会重复执行/不写第二条 start）", () => {
    const id = mk();
    const first = repo.claimNextJob();
    const second = repo.claimNextJob();
    assert.equal(first!.id, id);
    assert.equal(second, null);
    assert.equal(events(id).filter((e) => e.event === "start").length, 1);
  });

  test("两条 queued：两个 claim 各拿一条（优先级高者先）", () => {
    const low = addJob(t.db, null, "scan", "queued", { priority: 0 });
    const high = addJob(t.db, null, "reindex", "queued", { priority: 9 });
    assert.equal(repo.claimNextJob()!.id, high);
    assert.equal(repo.claimNextJob()!.id, low);
    assert.equal(repo.claimNextJob(), null);
  });
});

describe("retry 守卫（attempts）", () => {
  test("attempts=4 → retry 回 queued 且 5；attempts=5 → retry 变 abandoned", () => {
    const a = addJob(t.db, null, "scan", "failed", { attempts: 4 });
    const b = addJob(t.db, null, "scan", "failed", { attempts: 5 });
    assert.equal(repo.transitionJob(a, "retry").state, "queued");
    assert.equal(repo.getJob(a)!.attempts, 5);
    assert.equal(repo.transitionJob(b, "retry").state, "abandoned");
    assert.equal(repo.getJob(b)!.attempts, 5, "放弃分支不额外增加 attempts");
  });
});

describe("recoverInFlight", () => {
  const inFlight = ["resolving", "fetching", "materializing", "indexing", "matching", "releasing", "releasing_done"];
  test("把全部在飞状态退回 queued 并写 recovered 事件；paused 保持", () => {
    const ids = inFlight.map((s, i) => addJob(t.db, null, "scan", s, { started_at: new Date().toISOString() }));
    const paused = addJob(t.db, null, "scan", "paused", { started_at: new Date().toISOString() });
    const n = repo.recoverInFlight();
    assert.equal(n, inFlight.length);
    for (const id of ids) {
      assert.equal(repo.getJob(id)!.state, "queued");
      assert.equal(repo.getJob(id)!.started_at, null);
      const ev = events(id);
      assert.deepEqual(ev.map((e) => e.event), ["recovered"]);
      assert.equal(ev[0].detail, "service restart");
    }
    assert.equal(repo.getJob(paused)!.state, "paused", "paused 不能被自动恢复（用户显式暂停）");
  });

  test("毒作业：同一作业已恢复 3 次 → 放弃为 failed（带原因），不再排回队列", () => {
    const id = addJob(t.db, null, "scan", "resolving", { started_at: new Date().toISOString() });
    for (let i = 0; i < 3; i++) repo.logJobEvent(id, "resolving", "queued", "recovered", "service restart");
    const n = repo.recoverInFlight();
    assert.equal(n, 0, "被放弃的毒作业不计入恢复数（只统计真正回到 queued 的）");
    const j = repo.getJob(id)!;
    assert.equal(j.state, "failed");
    assert.ok(j.finished_at);
    assert.match(String(j.error), /反复崩溃/);
    assert.deepEqual(events(id).slice(-1).map((e) => e.event), ["abandoned_after_recoveries"]);
  });

  test("毒作业被放弃后：后续 recover 不再重复处理（状态已是 failed）", () => {
    const id = addJob(t.db, null, "scan", "resolving", { started_at: new Date().toISOString() });
    for (let i = 0; i < 3; i++) repo.logJobEvent(id, "resolving", "queued", "recovered", "service restart");
    assert.equal(repo.recoverInFlight(), 0);
    assert.equal(repo.getJob(id)!.state, "failed");
    assert.equal(repo.recoverInFlight(), 0, "下一次启动不应再次计数/迁移它");
    assert.equal(repo.getJob(id)!.state, "failed");
  });

  test("恢复计数为 2 时仍按正常路径回 queued（边界对照）", () => {
    const id = addJob(t.db, null, "scan", "indexing", { started_at: new Date().toISOString() });
    for (let i = 0; i < 2; i++) repo.logJobEvent(id, "indexing", "queued", "recovered", "service restart");
    assert.equal(repo.recoverInFlight(), 1);
    assert.equal(repo.getJob(id)!.state, "queued");
  });
});
