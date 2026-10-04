/**
 * ① 转移表穷举测试（verifier / task-4）
 *
 * 被测：packages/core/src/contracts.ts（FROZEN，verifier 只读）
 * 口径：13 状态 × 15 事件 = 195 个格子的全矩阵，逐格断言
 *       已定义 → 精确目标态；未定义 → null（调用方必须回 409）。
 *
 * 期望矩阵 **独立转写** 自 contracts.ts §TRANSITIONS 的冻结列表（21 行 / 20 个 (state,event) 格子），
 * 不是从实现反推：本文件里的 EXPECTED 是手写常量，一旦有人改了转移表而没改期望值，这里立刻红。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  TRANSITIONS, resolveTransition, MAX_ATTEMPTS, TERMINAL_STATES, IN_FLIGHT_STATES,
  type JobState, type JobEvent,
} from "../../packages/core/src/contracts";

const STATES: JobState[] = [
  "queued", "resolving", "fetching", "materializing", "indexing", "matching",
  "releasing", "releasing_done", "paused", "done", "failed", "cancelled", "abandoned",
];
const EVENTS: JobEvent[] = [
  "start", "resolve_ok", "fetch_ok", "commit", "index_ok", "match_ok", "stop",
  "fail", "hold", "cancel_apply", "give_up", "succeed", "resume", "retry", "abandon",
];

/** 手写期望矩阵。undefined = 未定义（必须返回 null）。failed+retry 的两次取值见 guard 测试。 */
const EXPECTED: Record<JobState, Partial<Record<JobEvent, JobState>>> = {
  queued: { start: "resolving", stop: "releasing" },
  resolving: { resolve_ok: "fetching", stop: "releasing" },
  fetching: { fetch_ok: "materializing", stop: "releasing" },
  materializing: { commit: "indexing", stop: "releasing" },
  indexing: { index_ok: "matching", stop: "releasing" },
  matching: { match_ok: "releasing_done", stop: "releasing" },
  releasing: { fail: "failed", hold: "paused", cancel_apply: "cancelled", give_up: "abandoned" },
  releasing_done: { succeed: "done" },
  paused: { resume: "queued" },
  done: {},
  failed: { retry: "queued", abandon: "abandoned" }, // retry 的守卫分支另测
  cancelled: {},
  abandoned: {},
};

const cell = (s: JobState, e: JobEvent) => EXPECTED[s][e];

describe("转移表全矩阵（13 状态 × 15 事件 = 195 格）", () => {
  test("矩阵规模与已知计数（防退化：不能是空表）", () => {
    assert.equal(STATES.length, 13);
    assert.equal(EVENTS.length, 15);
    assert.equal(STATES.length * EVENTS.length, 195);
    const defined = STATES.flatMap((s) => EVENTS.filter((e) => cell(s, e) !== undefined)).length;
    assert.equal(defined, 20, "已定义 (state,event) 格子数必须是 20（TRANSITIONS 21 行，failed+retry 占 2 行）");
    assert.equal(TRANSITIONS.length, 21, "TRANSITIONS 行数必须是 21（冻结）");
    assert.equal(195 - defined, 175, "未定义格子数必须是 175");
  });

  test("逐格：已定义 → 精确目标态；未定义 → null", () => {
    const mismatches: string[] = [];
    for (const s of STATES) {
      for (const e of EVENTS) {
        const want = cell(s, e) ?? null;
        // attempts=0 覆盖守卫为真的分支；未定义的格子与 attempts 无关
        const got = resolveTransition(s, e, { attempts: 0 });
        if (got !== want) mismatches.push(`${s}+${e}: want ${want} got ${got}`);
      }
    }
    assert.deepEqual(mismatches, [], "全矩阵偏差：\n" + mismatches.join("\n"));
  });

  test("反例对照：合法格子有非 null 返回，未定义格子返回 null（度量非退化）", () => {
    assert.equal(resolveTransition("queued", "start", { attempts: 0 }), "resolving"); // 正例
    assert.equal(resolveTransition("queued", "commit", { attempts: 0 }), null);       // 反例
    assert.equal(resolveTransition("done", "start", { attempts: 0 }), null);          // 终态无出边
  });

  test("每个已定义格子的结果都落在 13 状态集合内", () => {
    for (const s of STATES) {
      for (const e of EVENTS) {
        const to = resolveTransition(s, e, { attempts: 0 });
        if (to !== null) assert.ok(STATES.includes(to), `${s}+${e} → 未知状态 ${to}`);
      }
    }
  });

  test("拒绝语义：未定义格子一律 null（调用方据此回 409），绝不静默忽略", () => {
    let nulls = 0;
    for (const s of STATES) for (const e of EVENTS) if (resolveTransition(s, e, { attempts: 0 }) === null) nulls++;
    assert.equal(nulls, 175);
  });
});

describe("failed+retry 守卫（attempts 分支）", () => {
  test("attempts = 0..4 → queued；attempts = 5.. → abandoned", () => {
    for (const a of [0, 1, 2, 3, 4]) {
      assert.equal(resolveTransition("failed", "retry", { attempts: a }), "queued", `attempts=${a} 应重试`);
    }
    for (const a of [5, 6, 99]) {
      assert.equal(resolveTransition("failed", "retry", { attempts: a }), "abandoned", `attempts=${a} 应用尽放弃`);
    }
  });

  test("边界两侧：attempts=4 与 5 必须不同（这是唯一的分支点）", () => {
    const at4 = resolveTransition("failed", "retry", { attempts: 4 });
    const at5 = resolveTransition("failed", "retry", { attempts: 5 });
    assert.equal(at4, "queued");
    assert.equal(at5, "abandoned");
    assert.notEqual(at4, at5);
  });

  test("MAX_ATTEMPTS=5 且守卫用 < 比较（attempts=5 恰好用尽）", () => {
    assert.equal(MAX_ATTEMPTS, 5);
    assert.equal(resolveTransition("failed", "retry", { attempts: MAX_ATTEMPTS - 1 }), "queued");
    assert.equal(resolveTransition("failed", "retry", { attempts: MAX_ATTEMPTS }), "abandoned");
  });

  test("守卫只作用于 failed+retry：其它格子的结果与 attempts 无关", () => {
    for (const s of STATES) {
      for (const e of EVENTS) {
        if (s === "failed" && e === "retry") continue;
        const a = resolveTransition(s, e, { attempts: 0 });
        const b = resolveTransition(s, e, { attempts: 999 });
        assert.equal(a, b, `${s}+${e} 被 attempts 污染`);
      }
    }
  });

  test("failed+abandon 不受 attempts 影响", () => {
    assert.equal(resolveTransition("failed", "abandon", { attempts: 0 }), "abandoned");
    assert.equal(resolveTransition("failed", "abandon", { attempts: 999 }), "abandoned");
  });
});

describe("转移表结构不变量（出边/终态/在飞集合）", () => {
  test("TRANSITIONS 无重复 (from,event,guard) 行", () => {
    const seen = new Set<string>();
    for (const t of TRANSITIONS) {
      const k = `${t.from}|${t.event}|${t.guard ? "g" : "u"}`;
      assert.ok(!seen.has(k), "重复行: " + k);
      seen.add(k);
    }
  });

  test("每个 (state,event) 最多一个守卫行 + 一个默认行", () => {
    const g = new Map<string, number>();
    for (const t of TRANSITIONS) {
      const k = `${t.from}|${t.event}`;
      g.set(k, (g.get(k) ?? 0) + 1);
    }
    for (const [k, n] of g) assert.ok(n <= 2, `${k} 有 ${n} 行`);
  });

  test("终态 done/cancelled/abandoned 没有任何出边", () => {
    for (const s of TERMINAL_STATES) {
      for (const e of EVENTS) assert.equal(resolveTransition(s, e, { attempts: 0 }), null, `终态 ${s} 有出边 ${e}`);
    }
    assert.deepEqual([...TERMINAL_STATES].sort(), ["abandoned", "cancelled", "done"]);
  });

  test("所有 stop 边都汇入 releasing（stop = 唯一回收入口）", () => {
    const stops = TRANSITIONS.filter((t) => t.event === "stop");
    assert.equal(stops.length, 6);
    for (const t of stops) assert.equal(t.to, "releasing");
  });

  test("IN_FLIGHT_STATES 与 jobs 在飞索引口径一致（9 个，含 paused）", () => {
    assert.equal(IN_FLIGHT_STATES.length, 9);
    assert.deepEqual(
      [...IN_FLIGHT_STATES].sort(),
      ["fetching", "indexing", "matching", "materializing", "paused", "queued", "releasing", "releasing_done", "resolving"],
    );
  });
});

describe("attempts 单调性与上限（runner 语义：只有 retry 推进 attempts）", () => {
  /** 局部 runner 语义：retry 事件 attempts+1，其它事件不变（对应 JobRow.attempts 只增）。 */
  const step = (s: JobState, e: JobEvent, a: number): { to: JobState; attempts: number } | null => {
    const to = resolveTransition(s, e, { attempts: a });
    if (to === null) return null;
    return { to, attempts: e === "retry" ? a + 1 : a };
  };

  test("穷举 (state, attempts) 可达集：0 <= attempts <= MAX_ATTEMPTS+1，越限只能落终态 abandoned", () => {
    const seen = new Set<string>();
    let frontier: Array<{ s: JobState; a: number }> = [{ s: "queued", a: 0 }];
    seen.add("queued|0");
    let maxSeen = 0;
    while (frontier.length) {
      const next: Array<{ s: JobState; a: number }> = [];
      for (const n of frontier) {
        maxSeen = Math.max(maxSeen, n.a);
        for (const e of EVENTS) {
          const r = step(n.s, e, n.a);
          if (!r) continue;
          assert.ok(r.attempts >= n.a, "attempts 回退");
          if (r.attempts > MAX_ATTEMPTS) {
            // 唯一允许超过上限的语义：守卫为假的那次 retry 仍推进计数，但必须落到终态 abandoned
            assert.equal(r.to, "abandoned", `attempts=${n.a} 的 ${e} 越限却落到非终态 ${r.to}`);
          }
          const k = `${r.to}|${r.attempts}`;
          if (!seen.has(k)) { seen.add(k); next.push({ s: r.to, a: r.attempts }); }
        }
      }
      frontier = next;
    }
    assert.equal(maxSeen, MAX_ATTEMPTS + 1, "越限 retry 必须能到达 attempts=MAX_ATTEMPTS+1（否则上限从未生效＝退化度量）");
    assert.ok(seen.has(`abandoned|${MAX_ATTEMPTS + 1}`), "attempts 用尽后的 retry 必须落 abandoned");
    assert.ok(seen.has(`done|0`), "正常路径能到 done");
    // 而非退化的另一侧：不存在 attempts 无界增长（abandoned 无出边 → BFS 必然终止）
    assert.ok([...seen].every((k) => Number(k.split("|")[1]) <= MAX_ATTEMPTS + 1), "出现超过上限的 attempts");
  });

  test("反例对照：把上限改大即不成立（说明该断言对 MAX_ATTEMPTS 敏感）", () => {
    // 用 attempts=MAX_ATTEMPTS 调 retry 得到 abandoned，而 attempts=MAX_ATTEMPTS-1 得到 queued
    assert.equal(resolveTransition("failed", "retry", { attempts: MAX_ATTEMPTS }), "abandoned");
    assert.equal(resolveTransition("failed", "retry", { attempts: MAX_ATTEMPTS - 1 }), "queued");
  });

  test("retry 是唯一能把 attempts 推进的事件（其它事件 attempts 不变）", () => {
    for (const s of STATES) {
      for (const e of EVENTS) {
        if (e === "retry") continue;
        const r = step(s, e, 2);
        if (r) assert.equal(r.attempts, 2, `${s}+${e} 不应改 attempts`);
      }
    }
  });
});
