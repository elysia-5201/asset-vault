/**
 * AC8 列表性能：1000 条目下 GET /items?limit=50 首屏 <1s
 * 判据操作化：
 *   - 数据量 >= 1000（不足则 PENDING 并给出两档命令：AV_SMOKE_SEED=1 现场造数，或先跑 AC1 建真实库）
 *   - 连续 5 次 GET /items?limit=50，报告 min/median/max；max < 1000ms 为通过（含最多 50 条 JSON 组装）
 */
import { runAc, api, assertAc, log, AcPending } from "./_lib";

await runAc("AC8", "1000 条目下 /items?limit=50 <1s", { needsServer: true }, async () => {
  let stats = (await api.get("/stats")).body ?? {};
  let n = Number(stats.items ?? (await api.get("/items?limit=1")).body?.total ?? 0);
  if (n < 1000 && process.env.AV_SMOKE_SEED === "1") {
    log(`    现场造数：items=${n} → 目标 1000（POST /items，前缀 SMOKE-AC8-）`);
    for (let i = n; i < 1000; i++) {
      const r = await api.post("/items", { title: `SMOKE-AC8-${i}` });
      if (r.status >= 400) throw new AcPending(`POST /items 失败 ${r.status}: ${JSON.stringify(r.body)}`);
    }
    stats = (await api.get("/stats")).body ?? {};
    n = Number(stats.items ?? 0);
  }
  if (n < 1000) throw new AcPending(`当前 items=${n} < 1000。可选：AV_SMOKE_SEED=1 node --import tsx test/smoke/ac08-list-perf.ts（现场造数）或先跑 AC1 建真实库`);

  const times: number[] = [];
  for (let i = 0; i < 5; i++) {
    const r = await api.get("/items?limit=50", 20_000);
    assertAc(r.status === 200, `GET /items?limit=50 → HTTP ${r.status}`);
    assertAc((r.body?.items ?? []).length <= 50, "limit=50 返回超过 50 条");
    times.push(r.ms);
    log(`    #${i + 1} ${r.ms.toFixed(0)}ms total=${r.body?.total}`);
  }
  const sorted = [...times].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  assertAc(Math.max(...times) < 1000, `首屏最慢 ${Math.max(...times).toFixed(0)}ms >= 1000ms（5 次: ${times.map((t) => t.toFixed(0)).join(", ")}）`);
  log(`    n=${n} min=${sorted[0]!.toFixed(0)}ms median=${median.toFixed(0)}ms max=${sorted[sorted.length - 1]!.toFixed(0)}ms`);
});
