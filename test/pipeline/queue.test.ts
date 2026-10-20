/**
 * v0.6.0 流水线契约测试 —— BoundedQueue（verifier）
 * 覆盖：并发上限（计数证明）、FIFO/优先级、同 key 去重、背压(highWater)、暂停、关闭、
 *       queued/running 取消、drain(0/timeout)、失败计数、stats 字段。
 * 实现：apps/server/src/services/pipeline/queue.ts（不改实现）
 *
 * 确定性说明：不放长 sleep；用 setImmediate 让出微/宏任务，用"手动放行"的 gate 控制执行顺序。
 * 注意：queue 的超时定时器是 unref 的，测试在 await 超时分支时用 keepAlive 保持事件循环（模拟服务进程有常驻句柄）。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { BoundedQueue } from "../../apps/server/src/services/pipeline/queue";

const tick = () => new Promise<void>((r) => setImmediate(r));
async function withKeepAlive<T>(ms: number, fn: () => Promise<T>): Promise<T> {
  const t = setTimeout(() => {}, ms);
  try { return await fn(); } finally { clearTimeout(t); }
}

describe("并发上限", () => {
  test("严格 ≤ concurrency（用共享计数证明）", async () => {
    const q = new BoundedQueue("conc", { concurrency: 2 });
    let active = 0, max = 0;
    const resolvers = new Map<string, () => void>();
    const run = (k: string) => async () => {
      active++; max = Math.max(max, active);
      await new Promise<void>((res) => resolvers.set(k, res));
      active--;
    };
    for (let i = 0; i < 5; i++) assert.equal(q.push({ key: "k" + i, run: run("k" + i) }).accepted, true);
    assert.equal(q.active, 2, "同时只有 2 个在跑");
    assert.equal(q.depth, 3, "其余排队");
    assert.equal(max, 2);
    for (let i = 0; i < 5; i++) { const r = resolvers.get("k" + i); if (r) r(); await tick(); }
    assert.equal(await q.drain(2000), true);
    assert.ok(max <= 2, "峰值并发必须 <= 2，实际 " + max);
    assert.equal(q.stats().done, 5);
  });

  test("concurrency 非法值被钳到 1", () => {
    assert.equal(new BoundedQueue("c0", { concurrency: 0 }).concurrency, 1);
    assert.equal(new BoundedQueue("cneg", { concurrency: -7 }).concurrency, 1);
    assert.equal(new BoundedQueue("cf", { concurrency: 3.9 }).concurrency, 3);
  });
});

describe("调度顺序", () => {
  test("优先级高先跑；同优先级 FIFO", async () => {
    const q = new BoundedQueue("prio", { concurrency: 1 });
    const order: string[] = [];
    const resolvers = new Map<string, () => void>();
    const run = (k: string) => async () => {
      order.push(k);
      await new Promise<void>((res) => resolvers.set(k, res));
    };
    q.push({ key: "blocker", run: run("blocker") });
    q.push({ key: "low", priority: 0, run: run("low") });
    q.push({ key: "high", priority: 10, run: run("high") });
    q.push({ key: "mid", priority: 5, run: run("mid") });
    q.push({ key: "fifo1", priority: 0, run: run("fifo1") });
    q.push({ key: "fifo2", priority: 0, run: run("fifo2") });
    assert.deepEqual(order, ["blocker"]);
    const expected = ["blocker", "high", "mid", "low", "fifo1", "fifo2"];
    for (const k of expected) {
      const r = resolvers.get(k);
      assert.ok(r, "应轮到 " + k + "，实际已执行 " + JSON.stringify(order));
      r!();
      await tick();
    }
    assert.equal(await q.drain(2000), true);
    assert.deepEqual(order, expected);
  });
});

describe("去重 / 背压 / 暂停 / 关闭", () => {
  test("同 key 在 queued/running 期间只执行一次", async () => {
    const q = new BoundedQueue("dedupe", { concurrency: 1 });
    let runs = 0;
    const gates: Array<() => void> = [];
    const run = async () => { runs++; await new Promise<void>((r) => gates.push(r)); };
    assert.equal(q.push({ key: "same", run }).accepted, true);
    const second = q.push({ key: "same", run });
    assert.equal(second.accepted, true, "重复 key 视为已接收（复用）");
    assert.equal(q.depth, 0, "不会排第二条");
    gates.shift()!(); await tick();
    assert.equal(await q.drain(1000), true);
    assert.equal(runs, 1);
    assert.equal(q.stats().done, 1);
  });

  test("highWater 背压：满则 accepted=false reason=high_water（腾出后可再入队）", async () => {
    const q = new BoundedQueue("hw", { concurrency: 1, highWater: 2 });
    const gates: Array<() => void> = [];
    const run = async () => { await new Promise<void>((r) => gates.push(r)); };
    assert.equal(q.push({ key: "a", run }).accepted, true);   // running
    assert.equal(q.push({ key: "b", run }).accepted, true);   // pending → total 2
    const third = q.push({ key: "c", run });
    assert.equal(third.accepted, false);
    assert.equal((third as any).reason, "high_water");
    gates.shift()!(); await tick();                            // a 完成 → b 运行（total 1）
    assert.equal(q.push({ key: "c", run }).accepted, true, "腾出水位后可再接收");
    gates.shift()!(); await tick();                            // b 完成 → c 运行
    gates.shift()!(); await tick();                            // c 完成
    assert.equal(await q.drain(2000), true);
    assert.equal(q.stats().done, 3);
  });

  test("pause 时 push 被拒（reason=paused），resume 恢复", async () => {
    const q = new BoundedQueue("pause", { concurrency: 1 });
    q.pause();
    const r = q.push({ key: "x", run: async () => {} });
    assert.equal(r.accepted, false);
    assert.equal((r as any).reason, "paused");
    assert.equal(q.paused, true);
    q.resume();
    assert.equal(q.push({ key: "x", run: async () => {} }).accepted, true);
    assert.equal(await q.drain(1000), true);
  });

  test("close：排队任务标 skipped 不执行；运行中自然结束；之后 push 被拒", async () => {
    const q = new BoundedQueue("close", { concurrency: 1 });
    const ran: string[] = [];
    let release!: () => void;
    q.push({ key: "running", run: async () => { ran.push("running"); await new Promise<void>((r) => (release = r)); } });
    q.push({ key: "p1", run: async () => { ran.push("p1"); } });
    q.push({ key: "p2", run: async () => { ran.push("p2"); } });
    q.close();
    assert.equal(q.closed, true);
    assert.equal(q.depth, 0);
    assert.equal(q.stats().skipped, 2);
    const after = q.push({ key: "late", run: async () => {} });
    assert.equal(after.accepted, false);
    assert.equal((after as any).reason, "closed");
    release(); await tick();
    assert.equal(await q.drain(1000), true);
    assert.deepEqual(ran, ["running"]);
  });
});

describe("取消", () => {
  test("取消排队任务：移出队列、不执行、计数 +1；未知 key / 重复取消幂等", async () => {
    const q = new BoundedQueue("cancel-q", { concurrency: 1 });
    const ran: string[] = [];
    let release!: () => void;
    q.push({ key: "run", run: async () => { ran.push("run"); await new Promise<void>((r) => (release = r)); } });
    q.push({ key: "c1", run: async () => { ran.push("c1"); } });
    assert.equal(q.cancel("c1"), true);
    assert.equal(q.cancel("c1"), false, "重复取消幂等");
    assert.equal(q.cancel("never"), false);
    release(); await tick();
    assert.equal(await q.drain(1000), true);
    assert.deepEqual(ran, ["run"]);
    assert.equal(q.stats().cancelled, 1);
  });

  test("取消运行中任务：abort signal 生效，计 cancelled 而非 failed", async () => {
    const q = new BoundedQueue("cancel-r", { concurrency: 1 });
    const seen: string[] = [];
    q.push({
      key: "r",
      run: (signal) => new Promise<void>((_res, rej) => {
        signal.addEventListener("abort", () => { seen.push(String(signal.reason)); rej(new Error("aborted")); });
      }),
    });
    assert.equal(q.cancel("r"), true);
    assert.equal(await q.drain(1000), true);
    assert.deepEqual(seen, ["cancelled"]);
    const s = q.stats();
    assert.equal(s.cancelled, 1);
    assert.equal(s.failed, 0);
  });
});

describe("drain / waitForSpace / 失败", () => {
  test("drain 在全部终态后 resolve；有任务在跑时带超时返回 false", async () => {
    const q = new BoundedQueue("drain", { concurrency: 1 });
    let release!: () => void;
    q.push({ key: "slow", run: async () => { await new Promise<void>((r) => (release = r)); } });
    const timedOut = await withKeepAlive(120, () => q.drain(20));
    assert.equal(timedOut, false, "任务未完成时 drain(timeout) 必须返回 false（不能谎报完成）");
    release();
    assert.equal(await q.drain(1000), true);
    assert.equal(await q.drain(0), true, "空闲时 drain() 立即 true");
  });

  test("任务抛错 → failed 计数，drain 仍会结算（不会挂住）", async () => {
    const orig = console.error;
    console.error = () => {}; // 静音队列自身的失败日志，避免污染测试输出
    try {
      const q = new BoundedQueue("fail", { concurrency: 1 });
      q.push({ key: "boom", run: async () => { throw new Error("boom"); } });
      assert.equal(await q.drain(1000), true);
      assert.equal(q.stats().failed, 1);
      assert.equal(q.stats().done, 0);
    } finally { console.error = orig; }
  });

  test("waitForSpace：满时超时 false；空闲后 true", async () => {
    const q = new BoundedQueue("space", { concurrency: 1, highWater: 1, lowWater: 0 });
    let release!: () => void;
    q.push({ key: "one", run: async () => { await new Promise<void>((r) => (release = r)); } });
    assert.equal(await withKeepAlive(120, () => q.waitForSpace(20)), false);
    release();
    assert.equal(await q.drain(1000), true);
    assert.equal(await q.waitForSpace(20), true);
  });

  test("stats 字段齐全且类型正确", () => {
    const q = new BoundedQueue("stats", { concurrency: 2, highWater: 5 });
    const s = q.stats();
    for (const k of ["name", "concurrency", "queued", "running", "done", "failed", "cancelled", "skipped", "peakDepth", "highWater", "paused", "closed"]) {
      assert.ok(k in s, "stats 缺字段 " + k);
    }
    assert.equal(s.name, "stats");
    assert.equal(s.concurrency, 2);
    assert.equal(s.highWater, 5);
    assert.equal(s.paused, false);
    assert.equal(s.closed, false);
  });
});
