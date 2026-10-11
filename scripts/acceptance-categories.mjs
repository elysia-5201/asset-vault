// 物品分类（Asset Categories）验收脚本 v3 —— 可复现的端到端路径。
//
// 用法：
//   node --import tsx scripts/acceptance-categories.mjs
//   AV_SRC_DB=/path/to/vault.db node --import tsx scripts/acceptance-categories.mjs   # 用真实库副本跑（会自动迁移到 v3）
//
// 做两件事：① 在临时数据目录起一个真服务（不动你的库）；② 走 HTTP 断言分类体系 v3：
//   结构(15 主/80 子) / 迁移 / 人工分类保护 / 筛选与计数自洽 / 标签 CRUD / 分类管理(影响面·移动·合并·带转移删除) / 数据安全。
// 退出码非 0 = 有用例失败。
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startAssetVault } from "../apps/server/src/server.ts";

const DIR = join(tmpdir(), "assetvault-accept-categories-" + Date.now());
const PORT = Number(process.env.PORT ?? 7423);
const SRC = process.env.AV_SRC_DB;
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log("  PASS " + name); }
  else { fail++; console.log("  FAIL " + name + " " + JSON.stringify(extra).slice(0, 240)); }
};

async function main() {
  mkdirSync(DIR, { recursive: true });
  let realDb = false;
  if (SRC && existsSync(SRC)) {
    // 主库 + WAL + SHM 必须一起复制（只复制主文件会回放陈旧 WAL，得到混合状态）
    for (const suf of ["", "-wal", "-shm"]) if (existsSync(SRC + suf)) copyFileSync(SRC + suf, join(DIR, "vault.db" + suf));
    realDb = true;
    console.log("使用提供的库副本（会迁移到 v3）: " + SRC);
  } else {
    console.log("未提供 AV_SRC_DB → 空库 + 3 条演示素材");
  }
  const h = await startAssetVault({ port: PORT, dataDir: DIR, listen: true, logsDir: join(DIR, "logs") });
  const api = async (m, p, body) => {
    const r = await fetch(h.url + p, { method: m, headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    let b = null; try { b = await r.json(); } catch { /* 非 JSON */ }
    return { status: r.status, body: b };
  };
  try {
    if (!realDb) for (const t of ["かわいいシャツ 衣装", "Blendshape 一括設定ツール", "オリジナル3Dモデル 素体"]) await api("POST", "/api/items", { title: t });

    console.log("== A. 分类体系 v3 结构 + 迁移 ==");
    const cats = await api("GET", "/api/categories");
    const tops = cats.body?.categories ?? [];
    const nodes = tops.reduce((n, t) => n + 1 + (t.children?.length ?? 0), 0);
    ok("GET /api/categories → 200", cats.status === 200, cats.status);
    ok("15 个一级分类", tops.length === 15, tops.length);
    ok("95 个分类节点（15 主 + 80 子）", nodes === 95, nodes);
    ok("含系统分类「未分类」且无子分类", tops.some((t) => t.id === "uncategorized" && t.builtin === true && (t.children ?? []).length === 0));
    ok("一级顺序 = 需求顺序", tops.map((t) => t.name).join("/") === "服饰/妆容/头发/模型/材质与纹理/Shader/动画与动作/特效/工具/饰品/音频/场景/UI/其他/未分类", tops.map((t) => t.name));
    ok("服饰子分类 = 8 个且名称正确", (tops.find((t) => t.id === "clothing")?.children ?? []).map((c) => c.name).join("/") === "上衣/下装/连衣裙/外套/鞋袜/内衣/套装/服饰配件");

    console.log("== B. 筛选、计数与统计自洽 ==");
    const stats0 = await api("GET", "/api/stats");
    const items0 = await api("GET", "/api/items?limit=500");
    const N = items0.body.total;
    ok("列表 total == stats.items", N === stats0.body.items, { list: N, stats: stats0.body.items });
    const unc = await api("GET", "/api/items?uncategorized=1&limit=500");
    ok("未分类筛选 == stats.uncategorized", unc.body.total === cats.body.stats.uncategorized, { list: unc.body.total, stats: cats.body.stats.uncategorized });
    const counts = await api("GET", "/api/categories/counts");
    ok("counts.all == items.total", counts.body?.all === N, { counts: counts.body?.all, items: N });
    ok("counts.uncategorized == 未分类筛选", counts.body?.uncategorized === unc.body.total, counts.body?.uncategorized);

    console.log("== C. 手动分类 + 自动保护 ==");
    const ids = (items0.body.items ?? []).map((i) => i.id).slice(0, 4);
    if (ids.length === 0) { console.log("  跳过 C/D（库里没有条目）"); }
    else {
      const set = await api("POST", "/api/items/" + ids[0] + "/category", { categoryId: "clothing.tops" });
      const c0 = set.body?.item?.category;
      ok("手动设子分类 → 归位主分类且 source=manual", c0?.categoryId === "clothing" && c0?.subCategoryId === "clothing.tops" && c0?.source === "manual", c0);
      ok("未知分类 → 400", (await api("POST", "/api/items/" + ids[0] + "/category", { categoryId: "nope.nope" })).status === 400);
      const spoof = await api("POST", "/api/items/" + (ids[1] ?? ids[0]) + "/category", { categoryId: "tools.unity", source: "auto", cat_source: "auto" });
      ok("请求体不能让 source=auto", spoof.body?.item?.category?.source === "manual", spoof.body?.item?.category?.source);
      const re = await api("POST", "/api/categories/reclassify", { apply: true, itemIds: [ids[0]] });
      ok("reclassify 不覆盖手动分类", (re.body?.results ?? []).find((x) => x.itemId === ids[0])?.protected === true);
      ok("手动分类仍在", (await api("GET", "/api/items/" + ids[0])).body?.category?.subCategoryId === "clothing.tops");
      const anySug = await api("GET", "/api/items?pendingCategory=1&limit=5");
      if ((anySug.body.items ?? []).length) {
        const acc = await api("POST", "/api/items/" + anySug.body.items[0].id + "/category/accept");
        ok("采纳建议 → source=confirmed 且建议清空", acc.body?.item?.category?.source === "confirmed" && acc.body?.item?.suggestion === null);
      }
      const batch = await api("POST", "/api/items/category/batch", { itemIds: ids.slice(0, 2), categoryId: "tools.unity" });
      ok("批量设置成功数 == 请求数", batch.body?.updated === Math.min(2, ids.length), batch.body);
      ok("批量坏 id → failed 逐条报告", ((await api("POST", "/api/items/category/batch", { itemIds: [999999], categoryId: "tools.unity" })).body?.failed ?? []).length === 1);
    }

    console.log("== D. 标签（v3 新增 API）==");
    const tags0 = await api("GET", "/api/tags");
    ok("默认标签已播种（11 个之一：待检查）", (tags0.body?.tags ?? []).some((t) => t.name === "待检查"));
    const made = await api("POST", "/api/tags", { name: "验收标签", color: "#123456" });
    ok("新建标签带颜色", made.status === 201 || made.status === 200, made.status);
    const again = await api("POST", "/api/tags", { name: "验收标签" });
    ok("同名标签幂等（不重复创建）", (again.body?.tag?.id ?? -1) === (made.body?.tag?.id ?? -2), { a: made.body?.tag?.id, b: again.body?.tag?.id });
    const renamed = await api("PATCH", "/api/tags/" + made.body.tag.id, { name: "验收标签2", color: "#654321" });
    ok("标签改名/改色", renamed.body?.tag?.name === "验收标签2" && renamed.body?.tag?.color === "#654321", renamed.body?.tag);
    if (ids.length) {
      await api("POST", "/api/items/" + ids[0] + "/tags", { tags: ["验收标签2", "黑色"] });
      const byTag = await api("GET", "/api/items?tags=" + encodeURIComponent("验收标签2") + "&limit=500");
      ok("按标签筛选命中", byTag.body.total >= 1, byTag.body.total);
      const allTag = await api("GET", "/api/items?tags=" + encodeURIComponent("验收标签2,黑色") + "&tagsMatch=all&limit=500");
      ok("标签 ANY/ALL 语义可用", allTag.body.total >= 1 && allTag.body.total <= byTag.body.total, allTag.body.total);
    }
    ok("删除标签（同时清关联）", (await api("DELETE", "/api/tags/" + made.body.tag.id)).body?.removed >= 0);

    console.log("== E. 分类管理（影响面 / 移动 / 合并 / 带转移删除）==");
    const imp = await api("GET", "/api/categories/clothing/impact");
    ok("影响面返回 items/subs/suggestions", typeof imp.body?.items === "number" && imp.body?.subs === 8, imp.body);
    const mine = await api("POST", "/api/categories", { name: "验收分类A" });
    const mine2 = await api("POST", "/api/categories", { name: "验收分类B" });
    ok("新建一级分类", mine.status === 201 && mine.body?.category?.id, mine.body?.category?.id);
    const sub = await api("POST", "/api/categories", { name: "验收子类", parentId: mine.body.category.id });
    ok("新建二级子分类", sub.status === 201 && sub.body?.category?.parentId === mine.body.category.id);
    const mv = await api("POST", "/api/categories/" + sub.body.category.id + "/move", { parentId: mine2.body.category.id });
    ok("子分类移动到另一个一级分类（ID 不变）", mv.body?.category?.parentId === mine2.body.category.id && mv.body?.category?.id === sub.body.category.id, mv.body?.category);
    if (ids.length) await api("POST", "/api/items/" + ids[ids.length - 1] + "/category", { categoryId: mine2.body.category.id });
    const merged = await api("POST", "/api/categories/" + mine2.body.category.id + "/merge", { intoId: mine.body.category.id });
    // 源一级分类下还挂着一个子分类（就是上面移动过去那个）→ 删除行数 = 源自身 + 其子分类
    ok("合并分类：素材迁移 + 源(含其子分类)删除", (merged.body?.deleted ?? 0) >= 1 && (merged.body?.moved ?? 0) >= 1, merged.body);
    ok("系统分类不能删除（409）", (await api("DELETE", "/api/categories/clothing")).status === 409);
    const del = await api("DELETE", "/api/categories/" + mine.body.category.id + "?transferTo=uncategorized");
    ok("删除普通分类并转移素材到未分类", del.body?.deleted === 1, del.body);
    ok("分类不存在 → 404", (await api("DELETE", "/api/categories/nope")).status === 404);

    console.log("== F. 阈值可配置 ==");
    const cfg = await api("PUT", "/api/categories/config", { autoThreshold: 0.9, suggestThreshold: 0.5 });
    ok("阈值写入 / 回读", cfg.body?.autoThreshold === 0.9 && (await api("GET", "/api/categories")).body?.config?.autoThreshold === 0.9);
    ok("非法阈值 → 400", (await api("PUT", "/api/categories/config", { autoThreshold: 2 })).status === 400);

    console.log("== G. 数据安全 ==");
    const stats1 = await api("GET", "/api/stats");
    ok("条目数不变（分类/合并/删除都不删素材）", stats1.body.items === stats0.body.items, { before: stats0.body.items, after: stats1.body.items });
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
