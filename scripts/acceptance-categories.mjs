// 物品分类（Asset Categories）验收脚本 —— 可复现的端到端路径。
//
// 用法：
//   node --import tsx scripts/acceptance-categories.mjs
//   AV_SRC_DB=/path/to/vault.db node --import tsx scripts/acceptance-categories.mjs   # 用真实库副本跑
//
// 做两件事：① 在临时数据目录起一个真服务（不动你的库）；② 走 HTTP 断言分类功能的
// 结构/保护/筛选/统计/批量/阈值/数据安全。退出码非 0 = 有用例失败。
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startAssetVault } from "../apps/server/src/server.ts";

const DIR = join(tmpdir(), "assetvault-accept-categories-" + Date.now());
const PORT = Number(process.env.PORT ?? 7423);
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log("  PASS " + name); }
  else { fail++; console.log("  FAIL " + name + " " + JSON.stringify(extra).slice(0, 240)); }
};

async function main() {
  mkdirSync(DIR, { recursive: true });
  const src = process.env.AV_SRC_DB;
  let realDb = false;
  if (src && existsSync(src)) {
    for (const suf of ["", "-wal", "-shm"]) if (existsSync(src + suf)) copyFileSync(src + suf, join(DIR, "vault.db" + suf));
    realDb = true;
    console.log("使用提供的库副本: " + src);
  } else {
    console.log("未提供 AV_SRC_DB → 用空库 + 3 条演示素材");
  }

  const h = await startAssetVault({ port: PORT, dataDir: DIR, listen: true, logsDir: join(DIR, "logs") });
  const api = async (m, p, body) => {
    const r = await fetch(h.url + p, { method: m, headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    let b = null; try { b = await r.json(); } catch { /* 非 JSON */ }
    return { status: r.status, body: b };
  };
  try {
    if (!realDb) {
      for (const t of ["かわいいシャツ 衣装", "Blendshape 一括設定ツール", "オリジナル3Dモデル 素体"]) {
        await api("POST", "/api/items", { title: t });
      }
    }
    console.log("== A. 分类树 + 迁移 ==");
    const cats = await api("GET", "/api/categories");
    ok("GET /api/categories → 200", cats.status === 200, cats.status);
    ok("14 个主分类", (cats.body?.categories ?? []).length === 14, cats.body?.categories?.length);
    ok("93 个分类节点", (cats.body?.categories ?? []).reduce((n, t) => n + 1 + (t.children?.length ?? 0), 0) === 93);
    ok("阈值默认 0.75 / 0.4", cats.body?.config?.autoThreshold === 0.75 && cats.body?.config?.suggestThreshold === 0.4, cats.body?.config);

    console.log("== B. 筛选与统计自洽 ==");
    const stats0 = await api("GET", "/api/stats");
    const items0 = await api("GET", "/api/items?limit=500");
    const N = items0.body.total;
    ok("列表 total == stats.items", N === stats0.body.items, { list: N, stats: stats0.body.items });
    const unc = await api("GET", "/api/items?uncategorized=1&limit=500");
    ok("uncategorized 筛选 == stats.uncategorized", unc.body.total === cats.body.stats.uncategorized, { list: unc.body.total, stats: cats.body.stats.uncategorized });

    console.log("== C. 手动分类 + 自动保护（§6）==");
    const ids = (items0.body.items ?? []).map((i) => i.id).slice(0, 3);
    if (ids.length === 0) { console.log("  跳过 C/D（库里没有条目）"); }
    else {
      const set = await api("POST", "/api/items/" + ids[0] + "/category", { categoryId: "clothing.tops" });
      const c = set.body?.item?.category;
      ok("手动设子分类 → 归位到主分类且 source=manual", c?.categoryId === "clothing" && c?.subCategoryId === "clothing.tops" && c?.source === "manual", c);
      const bad = await api("POST", "/api/items/" + ids[0] + "/category", { categoryId: "nope.nope" });
      ok("未知分类 → 400", bad.status === 400, bad);
      const spoof = await api("POST", "/api/items/" + (ids[1] ?? ids[0]) + "/category", { categoryId: "tools.unity", source: "auto", cat_source: "auto" });
      ok("请求体不能让 source=auto", spoof.body?.item?.category?.source === "manual", spoof.body?.item?.category?.source);
      const re = await api("POST", "/api/categories/reclassify", { apply: true, itemIds: [ids[0]] });
      const row = (re.body?.results ?? []).find((x) => x.itemId === ids[0]);
      ok("reclassify 不覆盖手动分类", row?.protected === true, row);
      const still = await api("GET", "/api/items/" + ids[0]);
      ok("手动分类仍在", still.body?.category?.subCategoryId === "clothing.tops", still.body?.category);

      console.log("== D. 建议：采纳 / 忽略 ==");
      await api("POST", "/api/categories/reclassify", { apply: false, itemIds: ids.slice(1) });
      const anySug = (await api("GET", "/api/items?pendingCategory=1&limit=5")).body.items ?? [];
      if (anySug.length) {
        const acc = await api("POST", "/api/items/" + anySug[0].id + "/category/accept");
        ok("采纳建议 → source=confirmed 且建议清空", acc.body?.item?.category?.source === "confirmed" && acc.body?.item?.suggestion === null, acc.body?.item?.category);
      } else { ok("apply:false 应至少产生一条建议", false); }
      const dis = await api("POST", "/api/items/" + ids[1] + "/category/dismiss");
      ok("忽略建议 → 200", dis.status === 200, dis.status);

      console.log("== E. 批量 ==");
      const batch = await api("POST", "/api/items/category/batch", { itemIds: ids.slice(0, 2), categoryId: "tools.unity" });
      ok("批量设置成功数 == 请求数", batch.body?.updated === Math.min(2, ids.length), batch.body);
      const batchBad = await api("POST", "/api/items/category/batch", { itemIds: [999999], categoryId: "tools.unity" });
      ok("批量坏 id → failed 逐条报告", (batchBad.body?.failed ?? []).length === 1, batchBad.body);
    }

    console.log("== F. 阈值可配置 ==");
    const cfg = await api("PUT", "/api/categories/config", { autoThreshold: 0.9, suggestThreshold: 0.5 });
    ok("阈值写入", cfg.body?.autoThreshold === 0.9 && cfg.body?.suggestThreshold === 0.5, cfg.body);
    ok("非法阈值 → 400", (await api("PUT", "/api/categories/config", { autoThreshold: 2 })).status === 400);
    ok("阈值回读", (await api("GET", "/api/categories")).body?.config?.autoThreshold === 0.9);

    console.log("== G. 数据安全 ==");
    const stats1 = await api("GET", "/api/stats");
    ok("条目数不变（分类不删素材）", stats1.body.items === stats0.body.items, { before: stats0.body.items, after: stats1.body.items });
    ok("资产数不变", stats1.body.assets === stats0.body.assets, { before: stats0.body.assets, after: stats1.body.assets });
    ok("health 正常", (await api("GET", "/api/health")).status === 200);
  } finally {
    await h.close();
    rmSync(DIR, { recursive: true, force: true });
  }
  console.log("\n===== 验收: pass=" + pass + " fail=" + fail + " =====");
  if (fail > 0) process.exitCode = 1;
}
main().catch((e) => { console.error("ERROR", e); process.exit(1); });
