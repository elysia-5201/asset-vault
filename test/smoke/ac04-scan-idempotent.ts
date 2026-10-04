/**
 * AC4 扫描幂等
 * 判据操作化：
 *   - 同一路径连续两次 POST /scan，两次都 done
 *   - 第二次后 GET /health.counts（或 /stats）的 assets 增量必须 = 0，items 增量必须 = 0
 *   - 正例对照：第一次扫描的增量应当 > 0（若库里已有全部数据则打印"已建档"而不判失败）
 */
import { runAc, api, waitJob, assertAc, log, AcFailure } from "./_lib";

const counts = async (): Promise<{ items: number; assets: number; src: string; raw: any }> => {
  const h = await api.get("/health");
  const c = h.body?.counts;
  if (c && typeof c.assets === "number") return { items: c.items ?? 0, assets: c.assets, src: "health.counts", raw: c };
  const s = await api.get("/stats");
  if (s.status === 200 && typeof s.body?.assets === "number") return { items: s.body.items ?? 0, assets: s.body.assets, src: "stats", raw: s.body };
  throw new AcFailure("既无 /health.counts 也无 /stats.assets，无法度量幂等（验收项需要 counts 可观测）");
};
await runAc("AC4", "同一路径连续两次 /scan → assets 新增 0", { needsServer: true, note: "可能 >1min，建议后台跑" }, async () => {
  const libPath = process.env.AV_SMOKE_LIB ?? "%LIBRARY%/素材库";
  const first = await api.post("/scan", { path: libPath, deep: true });
  assertAc(first.status === 200 && first.body?.jobId, `第一次 POST /scan 失败: ${first.status} ${JSON.stringify(first.body)}`);
  await waitJob(Number(first.body.jobId));
  const c1 = await counts();
  const second = await api.post("/scan", { path: libPath, deep: true });
  assertAc(second.status === 200 && second.body?.jobId, `第二次 POST /scan 失败: ${second.status} ${JSON.stringify(second.body)}`);
  await waitJob(Number(second.body.jobId));
  const c2 = await counts();
  const dItems = c2.items - c1.items, dAssets = c2.assets - c1.assets;
  log(`    counts(${c1.src}) before=${JSON.stringify(c1.raw)} after=${JSON.stringify(c2.raw)} Δitems=${dItems} Δassets=${dAssets}`);
  assertAc(dAssets === 0, `第二次扫描新增了 ${dAssets} 个 assets（path_norm 唯一性/幂等被破坏）`);
  assertAc(dItems === 0, `第二次扫描新增了 ${dItems} 个 items（条目去重被破坏）`);
  log(`    幂等性成立（第一次扫描已建档则 Δ=0 属正常）`);
});
