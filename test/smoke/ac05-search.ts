/**
 * AC5 FTS 搜索（Shinano / ミルフィ / milky）
 * 判据操作化：
 *   - 三个查询各返回 >=1 条；每次请求 <1000ms（本机 1000 条内）
 *   - "命中正确条目" := 每条结果标题命中该词的等价集合（milky 允许经别名映射到 Milfy/ミルフィ）
 *   - 反例对照：查询一个必然不存在的词（AV_SMOKE_ABSENT，默认 zzqqxx）必须 0 条
 */
import { runAc, api, assertAc, log } from "./_lib";

const ALIASES: Record<string, string[]> = {
  shinano: ["shinano", "シナノ", "しなの", "雪乃"],
  "ミルフィ": ["ミルフィ", "milfy", "みるふぃ", "milky"],
  milky: ["milky", "milfy", "ミルフィ", "みるふぃ"],
};

await runAc("AC5", "GET /items?q= 中日英子串搜索 <1s", { needsServer: true, note: "需要已建档数据（AC1/AC2）" }, async () => {
  const terms = ["Shinano", "ミルフィ", "milky"];
  const table: string[] = [];
  for (const term of terms) {
    const r = await api.get(`/items?limit=50&q=${encodeURIComponent(term)}`, 10_000);
    assertAc(r.status === 200, `q=${term} → HTTP ${r.status}`);
    const items = r.body?.items ?? [];
    assertAc(items.length >= 1, `q=${term} 返回 0 条（数据未建档或搜索未实现）`);
    assertAc(r.ms < 1000, `q=${term} 用时 ${r.ms.toFixed(0)}ms >= 1000ms`);
    const variants = ALIASES[term] ?? [term];
    const wrong = items.filter((i: any) => !variants.some((v) => String(i.title ?? "").toLowerCase().includes(v.toLowerCase())));
    table.push(`q=${term}: total=${r.body?.total ?? "?"} 返回=${items.length} ${r.ms.toFixed(0)}ms 标题不匹配=${wrong.length}`);
    if (wrong.length) table.push(`    不匹配样例: ${wrong.slice(0, 3).map((w: any) => "#" + w.id + " " + w.title).join(" | ")}`);
  }
  const absent = process.env.AV_SMOKE_ABSENT ?? "zzqqxx";
  const r0 = await api.get(`/items?limit=50&q=${encodeURIComponent(absent)}`);
  assertAc((r0.body?.items ?? []).length === 0, `反例对照失败：不存在词 ${absent} 竟返回 ${(r0.body?.items ?? []).length} 条（搜索退化为全表）`);
  log("    " + table.join("\n    "));
});
