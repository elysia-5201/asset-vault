/**
 * ② 不变量测试：路径搜索穷举（verifier / task-4）
 *
 * 断言（不是抽样，是对有限状态空间的穷举可达性分析）：
 *   I1  done 的每一条路径都必须经过 commit → index_ok → match_ok（有序）且以 succeed 收尾。
 *   I2  failed / cancelled / paused / abandoned-by-give_up 的每一条路径都必须经过 stop。
 *   I3  attempts 只增，且 retry 至多 MAX_ATTEMPTS-1 次后必转 abandoned（见 transitions.test.ts）。
 *
 * 方法：把 (状态, 已见事件位掩码) 作为节点做 BFS——掩码单调增，故可达集是闭包、不是采样；
 *      有序性用"进度自动机"（progress 0..3）再做一次 BFS。13×2^15 量级，秒级跑完。
 *
 * 反例对照（防退化度量）：本文件同时断言若干 **故意为假** 的命题可以被证伪（找到反例掩码），
 *      否则说明检查器恒真、上面的"通过"没有信息量。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { resolveTransition, MAX_ATTEMPTS, type JobState, type JobEvent } from "../../packages/core/src/contracts";

const STATES: JobState[] = [
  "queued", "resolving", "fetching", "materializing", "indexing", "matching",
  "releasing", "releasing_done", "paused", "done", "failed", "cancelled", "abandoned",
];
const EVENTS: JobEvent[] = [
  "start", "resolve_ok", "fetch_ok", "commit", "index_ok", "match_ok", "stop",
  "fail", "hold", "cancel_apply", "give_up", "succeed", "resume", "retry", "abandon",
];
const INITIAL: JobState = "queued";
const BIT = new Map<JobEvent, number>(EVENTS.map((e, i) => [e, 1 << i]));
const bitOf = (e: JobEvent) => BIT.get(e)!;

interface Edge { to: JobState; event: JobEvent }
/** 全部出边：attempts=0 与 attempts=MAX_ATTEMPTS 各取一次（覆盖 guard 两侧）。 */
const EDGES = new Map<JobState, Edge[]>();
for (const s of STATES) {
  const out: Edge[] = [];
  for (const e of EVENTS) {
    for (const a of [0, MAX_ATTEMPTS]) {
      const to = resolveTransition(s, e, { attempts: a });
      if (to && !out.some((x) => x.to === to && x.event === e)) out.push({ to, event: e });
    }
  }
  EDGES.set(s, out);
}

/** BFS over (state, mask[, progress])；返回每状态可达掩码集合与全部已访问节点键。 */
function explore(order?: JobEvent[]) {
  const seen = new Set<string>([INITIAL + "|0|0"]);
  const byState = new Map<JobState, Set<number>>();
  const bump = (s: JobState, m: number) => {
    if (!byState.has(s)) byState.set(s, new Set());
    byState.get(s)!.add(m);
  };
  bump(INITIAL, 0);
  let frontier: Array<{ s: JobState; m: number; p: number }> = [{ s: INITIAL, m: 0, p: 0 }];
  while (frontier.length) {
    const next: typeof frontier = [];
    for (const n of frontier) {
      for (const ed of EDGES.get(n.s)!) {
        let p = n.p;
        if (order && p < order.length && ed.event === order[p]) p++;
        const m = n.m | bitOf(ed.event);
        const key = `${ed.to}|${m}|${p}`;
        if (seen.has(key)) continue;
        seen.add(key);
        next.push({ s: ed.to, m, p });
        bump(ed.to, m);
      }
    }
    frontier = next;
  }
  return { byState, seen };
}

/** 最短见证路径（事件序列），独立于上面的 BFS，仅用于日志与顺序断言。 */
function shortestPath(target: JobState): { events: JobEvent[]; states: JobState[] } {
  const q: Array<{ s: JobState; events: JobEvent[]; states: JobState[] }> =
    [{ s: INITIAL, events: [], states: [INITIAL] }];
  const vis = new Set<JobState>([INITIAL]);
  while (q.length) {
    const n = q.shift()!;
    if (n.s === target) return { events: n.events, states: n.states };
    for (const ed of EDGES.get(n.s)!) {
      if (vis.has(ed.to)) continue;
      vis.add(ed.to);
      q.push({ s: ed.to, events: [...n.events, ed.event], states: [...n.states, ed.to] });
    }
  }
  throw new Error("unreachable " + target);
}

describe("I1：DONE 前必过 commit / index_ok / match_ok（有序）", () => {
  test("穷举可达集：任何到达 done 的路径，掩码必含三个必需事件", () => {
    const { byState } = explore();
    const masks = byState.get("done");
    assert.ok(masks && masks.size > 0, "done 必须可达（否则断言退化）");
    const need = bitOf("commit") | bitOf("index_ok") | bitOf("match_ok");
    const bad = [...masks!].filter((m) => (m & need) !== need);
    assert.deepEqual(bad, [], `存在绕过必需事件的 done 路径：${bad.length} 个掩码`);
  });

  test("有序性：进度自动机 [commit, index_ok, match_ok] 在 done 处必须满进度", () => {
    const { seen } = explore(["commit", "index_ok", "match_ok"]);
    const doneKeys = [...seen].filter((k) => k.startsWith("done|"));
    assert.ok(doneKeys.length > 0);
    for (const k of doneKeys) {
      const p = Number(k.split("|")[2]);
      assert.equal(p, 3, `done 路径事件顺序错误（进度 ${p}/3）：${k}`);
    }
  });

  test("succeed 是 done 的必要前驱（每个 done 掩码都含 succeed）", () => {
    const { byState } = explore();
    for (const m of byState.get("done")!) assert.ok((m & bitOf("succeed")) !== 0, "存在未经 succeed 的 done");
  });

  test("见证路径：最短 done 路径的事件序列满足顺序", () => {
    const { events, states } = shortestPath("done");
    assert.deepEqual(events, ["start", "resolve_ok", "fetch_ok", "commit", "index_ok", "match_ok", "succeed"]);
    assert.deepEqual(states, ["queued", "resolving", "fetching", "materializing", "indexing", "matching", "releasing_done", "done"]);
    console.log("      witness → done:", events.join(" → "));
  });
});

describe("I2：FAILED / CANCELLED / PAUSED / give_up-ABANDONED 前必过 stop", () => {
  for (const target of ["failed", "cancelled", "paused", "abandoned"] as JobState[]) {
    test(`任何到达 ${target} 的路径都经过 stop`, () => {
      const { byState } = explore();
      const masks = byState.get(target);
      assert.ok(masks && masks.size > 0, `${target} 必须可达`);
      const bad = [...masks!].filter((m) => (m & bitOf("stop")) === 0);
      assert.deepEqual(bad, [], `存在不经 stop 到达 ${target} 的路径`);
    });
  }

  test("见证路径：到 failed / paused 的最短路径含 stop", () => {
    const wf = shortestPath("failed");
    const wp = shortestPath("paused");
    assert.deepEqual(wf.events, ["stop", "fail"]);
    assert.deepEqual(wp.events, ["stop", "hold"]);
    console.log("      witness → failed:", wf.events.join(" → "));
    console.log("      witness → paused:", wp.events.join(" → "));
  });

  test("恢复路径：done 可以经过 stop/fail（stop→releasing→fail→failed→retry→…→done）", () => {
    const { byState } = explore();
    const viaStop = [...byState.get("done")!].find((m) => (m & bitOf("stop")) !== 0 && (m & bitOf("fail")) !== 0);
    assert.notEqual(viaStop, undefined, "机器必须允许'回收入口失败后重试并成功'的恢复路径");
    // 而非退化的另一侧：最短路径（不复访）不含 stop/fail
    const sp = shortestPath("done");
    assert.ok(!sp.events.includes("stop") && !sp.events.includes("fail"));
  });
});

describe("反例对照（证明以上检查器不是恒真）", () => {
  test("故意为假的命题可被证伪：不是每条到 releasing 的路径都经过 fail", () => {
    const { byState } = explore();
    const counter = [...byState.get("releasing")!].find((m) => (m & bitOf("fail")) === 0);
    assert.notEqual(counter, undefined, "若找不到反例，说明掩码检查恒真 → I1/I2 无信息量");
  });

  test("同一检查器给出一真一假：failed 路径必有 fail；而经 stop 的直接路径 was 无 fail", () => {
    const { byState } = explore();
    for (const m of byState.get("failed")!) assert.ok((m & bitOf("fail")) !== 0, "failed 路径必含 fail");
    // releasing 的最短路径（stop 直达）不含 fail —— 同一掩码集合里既有"必含"也有"不含"
    const sp = shortestPath("releasing");
    assert.deepEqual(sp.events, ["stop"]);
    const noFail = [...byState.get("releasing")!].find((m) => (m & bitOf("fail")) === 0);
    assert.notEqual(noFail, undefined);
  });

  test("故意为假的命题可被证伪：不是每条到 match_ok 的路径都经过 commit", () => {
    const { byState } = explore();
    const m = [...byState.get("matching")!].find((x) => (x & bitOf("commit")) === 0);
    assert.equal(m, undefined, "到 matching 的路径全部必须经过 commit（I1 的一部分）");
    // 反向：到 fetching 的路径确实可以不含 commit → 掩码不是"处处全 1"
    const f = [...byState.get("fetching")!].find((x) => (x & bitOf("commit")) === 0);
    assert.notEqual(f, undefined, "掩码退化为全 1，I1 无信息量");
  });

  test("可达性非退化：13 个状态全部从 queued 可达；伪造状态不可达", () => {
    const { byState } = explore();
    assert.deepEqual(STATES.filter((s) => !byState.has(s)), [], "存在不可达状态");
    assert.ok(!byState.has("bogus_state" as JobState));
  });
});

describe("路径搜索本身的自检", () => {
  test("出边表与 resolveTransition 双向一致", () => {
    for (const s of STATES) {
      const want = new Set<string>();
      for (const e of EVENTS) for (const a of [0, MAX_ATTEMPTS]) {
        const to = resolveTransition(s, e, { attempts: a });
        if (to) want.add(to + "|" + e);
      }
      const got = new Set(EDGES.get(s)!.map((x) => x.to + "|" + x.event));
      assert.deepEqual([...got].sort(), [...want].sort(), s);
    }
  });

  test("BFS 在有限状态空间内终止且规模有界", () => {
    const { seen } = explore();
    assert.ok(seen.size > 0 && seen.size <= 13 * (1 << 15) * 4, "可达集规模异常：" + seen.size);
    console.log("      reachable nodes (state|mask|progress):", seen.size);
  });
});
