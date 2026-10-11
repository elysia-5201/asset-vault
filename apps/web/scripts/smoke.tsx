/**
 * 自测：① 内置 mock 路由的形状是否严格同 docs/api.md ② App 能否无异常渲染（SSR 冒烟）。
 * 运行：npx tsx apps/web/scripts/smoke.tsx
 */
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import App from "../src/App";
import { mockHandle, MockHttpError } from "../src/mock";
import { ItemCardView } from "../src/components/ItemCardView";
import { SearchBar } from "../src/components/SearchBar";
import { CategoryEditor } from "../src/components/CategoryEditor";

type Fail = string;
const fails: Fail[] = [];
const oks: string[] = [];

function req(method: string, path: string, body?: unknown): { status: number; body: any } {
  const qi = path.indexOf("?");
  const p = qi < 0 ? path : path.slice(0, qi);
  const q = new URLSearchParams(qi < 0 ? "" : path.slice(qi + 1));
  return mockHandle(method, p, q, body) as { status: number; body: any };
}
function has(obj: unknown, keys: string[], label: string): void {
  if (!obj || typeof obj !== "object") { fails.push(label + ": 不是对象"); return; }
  const rec = obj as Record<string, unknown>;
  const missing = keys.filter((k) => !(k in rec));
  if (missing.length) fails.push(label + ": 缺字段 " + missing.join(","));
  else oks.push(label + " ✓ " + keys.join(","));
}
function expect(cond: boolean, label: string): void {
  if (cond) oks.push(label); else fails.push(label);
}

// ---- ① 形状检查（严格同 docs/api.md） ----
const health = req("GET", "/health");
expect(health.status === 200 && health.body.ok === true && typeof health.body.dbPath === "string", "GET /health → {ok,dbPath}");
has(health.body, ["ok", "version", "dbPath", "roots", "counts"], "HealthResponse");

const items = req("GET", "/items?limit=5");
has(items.body, ["total", "items"], "GET /items → {total,items}");
expect(Array.isArray(items.body.items) && items.body.items.length > 0, "GET /items 有数据");
has(items.body.items[0], ["id", "title", "sourceSite", "status", "favorite", "coverImageId", "coverUrl", "imageCount", "assetCount", "totalBytes", "avatars", "tags", "compatDeclaredCount", "updatedAt", "category", "suggestion"], "ItemCard");

const one = req("GET", "/items/1");
has(one.body, ["item", "images", "assets", "avatars", "tags", "notes", "description"], "ItemDetail");

const filtered = req("GET", "/items?q=%E3%82%BB%E3%83%BC%E3%83%A9%E3%83%BC"); // セーラー
expect(filtered.body.total === 1, "中日文子串 q=セーラー 命中 1（实际 " + filtered.body.total + "）");
const atBoth = req("GET", "/items?avatar=1&avatar=4&avatarMatch=any");
const atAll = req("GET", "/items?avatar=1&avatar=4&avatarMatch=all");
expect(atAll.body.total >= 1 && atBoth.body.total > atAll.body.total, "ANY/ALL 语义：all 是 any 的子集（any=" + atBoth.body.total + " all=" + atAll.body.total + "）");
const owned = req("GET", "/items?ownedOnly=1");
expect(owned.body.total > 0 && owned.body.total <= items.body.total, "ownedOnly 过滤生效");

const avs = req("GET", "/avatars");
has(avs.body, ["avatars"], "GET /avatars → {avatars}");
has(avs.body.avatars[0], ["id", "name", "kind", "owned", "coverPath", "itemCount", "aliases", "boothItemId"], "AvatarCard");

const item1 = req("GET", "/items/1").body;
const archiveId = item1.assets.find((a: any) => a.container === "zip" || a.container === "7z").id;
const tree = req("GET", "/assets/" + archiveId + "/tree");
has(tree.body, ["container", "entries"], "GET /assets/:id/tree");
has(tree.body.entries[0], ["path", "size", "isDir"], "ArchiveEntry");

const upId = req("GET", "/items/2").body.assets.find((a: any) => a.container === "unitypackage").id;
const up = req("GET", "/assets/" + upId + "/unitypackage");
has(up.body, ["assets"], "GET /assets/:id/unitypackage");
expect(Object.keys(up.body.assets[0] ?? {}).length > 0, "unitypackage assets 非空");
has(up.body.assets[0], ["guid", "assetPath", "type", "size", "hasPreview"], "UnityPackageAsset");

const peek = req("GET", "/booth/peek?url=" + encodeURIComponent("https://booth.pm/ja/items/6115428"));
has(peek.body, ["itemId", "title", "description", "priceText", "priceYen", "publishedAt", "isAdult", "url", "shop", "tags", "category", "images", "variations"], "BoothPeek（BoothItemMeta）");

const imp = req("POST", "/import/url", { url: "https://booth.pm/ja/items/999999" });
has(imp.body, ["jobId", "itemId"], "POST /import/url → {jobId,itemId}");
const scan = req("POST", "/scan", { rootId: 1, deep: true });
has(scan.body, ["jobId"], "POST /scan → {jobId}");
const dry = req("POST", "/scan", { rootId: 1, deep: true, dryRun: true });
has(dry.body, ["items"], "POST /scan {dryRun:true} → {items}");
has(dry.body.items[0], ["title", "sourceSite", "sourceItemId", "confidence", "assets"], "ScanPlanItem");

// ---- 作业状态机（真实 409） ----
const jobsBefore = req("GET", "/jobs");
has(jobsBefore.body, ["jobs"], "GET /jobs → {jobs}");
has(jobsBefore.body.jobs[0], ["id", "kind", "state", "attempts", "priority", "error", "created_at"], "JobRow");
const doneJob = jobsBefore.body.jobs.find((j: any) => j.state === "done");
const bad = (() => { try { req("POST", "/jobs/" + doneJob.id + "/pause"); return null; } catch (e) { return e as MockHttpError; } })();
expect(bad !== null && bad.code === "INVALID_TRANSITION" && bad.status === 409, "done 上 pause → 409 INVALID_TRANSITION（可读：" + (bad ? bad.message : "无") + "）");
const pausedJob = jobsBefore.body.jobs.find((j: any) => j.state === "paused");
const resumed = req("POST", "/jobs/" + pausedJob.id + "/resume");
expect(resumed.body.job.state === "queued", "paused --resume--> queued");
const failedMax = jobsBefore.body.jobs.find((j: any) => j.state === "failed" && j.attempts >= 5);
const retried = req("POST", "/jobs/" + failedMax.id + "/retry");
expect(retried.body.job.state === "abandoned", "attempts>=5 的 failed --retry--> abandoned（guard 生效）");

// ---- api.md v1.1 新增端点 ----
const t1 = req("POST", "/items/1/tags", { tags: ["__smoke_tag"] });
expect(Array.isArray(t1.body.tags) && t1.body.tags.includes("__smoke_tag"), "POST /items/:id/tags 追加标签（" + JSON.stringify(t1.body.tags) + "）");
const t2 = req("DELETE", "/items/1/tags/" + encodeURIComponent("__smoke_tag"));
expect(!t2.body.tags.includes("__smoke_tag"), "DELETE /items/:id/tags/:tagId 删除标签");
const t3 = req("PATCH", "/items/1", { tags: ["x1", "x2"] });
expect(JSON.stringify(t3.body.tags) === JSON.stringify(["x1", "x2"]), "PATCH /items/:id {tags} 全量替换");
const ordIds = req("GET", "/items/1").body.images.map((i: any) => i.id).reverse();
const ro = req("POST", "/items/1/images/reorder", { imageIds: ordIds });
expect(JSON.stringify(ro.body.images.map((i: any) => i.id)) === JSON.stringify(ordIds), "POST /items/:id/images/reorder 顺序落库");
const imp0 = req("GET", "/items?imported=0");
const imp1 = req("GET", "/items?imported=1");
expect(imp0.body.total > 0 && imp1.body.total === 0, "imported=0/1 过滤（0→" + imp0.body.total + " 1→" + imp1.body.total + "）");
req("POST", "/projects/1/imports", { itemId: 1 });
const imp1b = req("GET", "/items?imported=1");
expect(imp1b.body.total === 1 && imp1b.body.items[0].id === 1, "登记 imports 后 imported=1 命中 1 条");

// ---- ③ 物品分类（docs/categories.md §4） ----
const cats = req("GET", "/categories");
has(cats.body, ["categories", "stats", "config"], "GET /categories → {categories,stats,config}");
has(cats.body.categories[0], ["id", "name", "parentId", "sort", "enabled", "builtin", "itemCount", "children"], "CategoryNode（含 itemCount/children）");
has(cats.body.stats, ["counts", "uncategorized", "pending", "total", "missingFiles"], "CategoryStats");
has(cats.body.config, ["autoThreshold", "suggestThreshold"], "CategoryConfig");
// 验收 #7：分类计数必须与真实查询一致（每个节点的 itemCount == /items?catIds=<id> 的 total）
const catMismatch: string[] = [];
let catNodes = 0;
for (const top of cats.body.categories) {
  for (const node of [top, ...(top.children ?? [])]) {
    catNodes += 1;
    const q = req("GET", "/items?catIds=" + encodeURIComponent(node.id));
    if (q.body.total !== node.itemCount) catMismatch.push(node.id + "（树 " + node.itemCount + " ≠ 查询 " + q.body.total + "）");
  }
}
expect(catMismatch.length === 0, "分类 itemCount 与 /items?catIds= 查询一致（" + catNodes + " 个节点）" + (catMismatch.length ? " 不一致：" + catMismatch.join("；") : ""));
expect(req("GET", "/items?uncategorized=1").body.total === cats.body.stats.uncategorized, "stats.uncategorized 与 uncategorized=1 查询一致（" + cats.body.stats.uncategorized + "）");
expect(req("GET", "/items?pendingCategory=1").body.total === cats.body.stats.pending, "stats.pending 与 pendingCategory=1 查询一致（" + cats.body.stats.pending + "）");
const catItems = req("GET", "/items?catIds=clothing");
expect(catItems.body.total > 0, "catIds=clothing 过滤命中 " + catItems.body.total + " 条");
expect(catItems.body.items.every((i: any) => i.category && (i.category.categoryId === "clothing" || i.category.subCategoryId === "clothing.tops")), "catIds 过滤结果都真的属于 clothing");
const catOne = req("GET", "/items?catIds=hair.texture");
expect(catOne.body.total === 1 && catOne.body.items[0].id === 3, "子分类 catIds=hair.texture 命中 1 条（已停用的分类仍能按归属筛出）");
const un = req("GET", "/items?uncategorized=1");
expect(un.body.total > 0 && un.body.items.every((i: any) => i.category === null), "uncategorized=1 → 全部 category=null（" + un.body.total + " 条）");
const pend = req("GET", "/items?pendingCategory=1");
expect(pend.body.total > 0 && pend.body.items.every((i: any) => i.suggestion !== null), "pendingCategory=1 → 都有 suggestion（" + pend.body.total + " 条）");

const set1 = req("POST", "/items/9/category", { categoryId: "shaders", subCategoryId: "shaders.shader" });
expect(set1.body.item.cat_id === "shaders" && set1.body.item.cat_sub_id === "shaders.shader" && set1.body.item.cat_source === "manual", "POST /items/:id/category 写入归属（source=manual）");
const badCat = (() => { try { req("POST", "/items/9/category", { categoryId: "__nope__" }); return null; } catch (e) { return e as MockHttpError; } })();
expect(badCat !== null && badCat.status === 400, "非法 categoryId → 400（不静默）");
const mismatch = req("POST", "/items/9/category", { categoryId: "clothing", subCategoryId: "shaders.shader" });
expect(mismatch.body.item.cat_id === "clothing" && mismatch.body.item.cat_sub_id === null, "子分类不属于主分类 → 自动清空子分类");
const clear = req("POST", "/items/9/category", { categoryId: null });
expect(clear.body.item.cat_id === null && clear.body.item.cat_source === null, "categoryId=null → 清除归属（回到未分类）");

// 待确认建议：7 号未分类但有建议 → 批量重新生成；6 号 manual + 建议 → 采纳
const acc = req("POST", "/items/6/category/accept");
expect(acc.body.item.cat_source === "confirmed" && acc.body.item.cat_suggest_id === null, "accept → source=confirmed 且清空建议");
const dis = req("POST", "/items/7/category/dismiss");
expect(dis.body.item.cat_suggest_id === null && dis.body.item.cat_id === null, "dismiss → 只清建议，不动归属");
const disAgain = req("POST", "/items/7/category/dismiss");
expect(disAgain.status === 200, "无建议时 dismiss 幂等 → 200（对齐服务端 routes.ts:1071）");
const accNoSug = (() => { try { req("POST", "/items/7/category/accept"); return null; } catch (e) { return e as MockHttpError; } })();
expect(accNoSug !== null && accNoSug.status === 400, "无建议时 accept → 400 INVALID_INPUT（对齐服务端 routes.ts:1061）");

const rl = req("POST", "/categories/reclassify", { itemIds: [9], apply: false });
has(rl.body, ["scanned", "applied", "suggested", "cleared", "skipped", "protected", "results"], "POST /categories/reclassify 结果形状");
expect(rl.body.scanned === 1 && rl.body.results[0].itemId === 9, "reclassify(apply=false) 只对指定条目出建议（applied=" + rl.body.applied + " suggested=" + rl.body.suggested + "）");

const batch = req("POST", "/items/category/batch", { itemIds: [9, 10], categoryId: "shaders", subCategoryId: "shaders.shader", mode: "set" });
has(batch.body, ["updated", "failed", "requested"], "POST /items/category/batch → {updated,failed,requested}");
expect(batch.body.updated === 2 && batch.body.failed.length === 0, "批量设置分类 2 条成功");
const batchFail = req("POST", "/items/category/batch", { itemIds: [9, 99999], mode: "clear_sub" });
expect(batchFail.body.updated === 1 && batchFail.body.failed.length === 1 && batchFail.body.failed[0].itemId === 99999, "批量失败逐条反馈（" + JSON.stringify(batchFail.body.failed) + "）");
const batchBad = (() => { try { req("POST", "/items/category/batch", { itemIds: [9], mode: "__nope__" }); return null; } catch (e) { return e as MockHttpError; } })();
expect(batchBad !== null && batchBad.status === 400, "未知 batch mode → 400");

const cfg = req("PUT", "/categories/config", { autoThreshold: 0.8, suggestThreshold: 0.35 });
expect(cfg.body.autoThreshold === 0.8 && cfg.body.suggestThreshold === 0.35, "PUT /categories/config 生效");
const cfgBad = (() => { try { req("PUT", "/categories/config", { autoThreshold: 2 }); return null; } catch (e) { return e as MockHttpError; } })();
expect(cfgBad !== null && cfgBad.status === 400, "阈值越界 → 400");
const nw = req("POST", "/categories", { name: "__smoke_cat", parentId: "clothing" });
const newId = String(nw.body.category.id);
expect(nw.status === 201 && newId.startsWith("clothing."), "POST /categories 新建子分类 → 201（" + newId + "）");
const renamed = req("PATCH", "/categories/" + encodeURIComponent(newId), { enabled: false, name: "__smoke_cat2" });
expect(renamed.body.category.enabled === false && renamed.body.category.name === "__smoke_cat2", "PATCH /categories/:id 改名/停用生效");
const deleted = req("DELETE", "/categories/" + encodeURIComponent(newId));
has(deleted.body, ["moved", "movedSubs"], "DELETE /categories/:id → {moved,movedSubs}");
expect(req("GET", "/categories").body.categories.flatMap((t: any) => (t.children ?? []).map((c: any) => c.id)).includes(newId) === false, "删除后分类树里不再出现 " + newId);
const delTop = (() => { try { req("DELETE", "/categories/clothing"); return null; } catch (e) { return e as MockHttpError; } })();
expect(delTop !== null && delTop.status === 409, "删除有子分类的主分类 → 409 CONFLICT");
const miss = (() => { try { req("GET", "/categories/__nope__"); return null; } catch (e) { return e as MockHttpError; } })();
expect(miss !== null && miss.status === 404, "未知分类 → 404");

// ---- ④ 分类 UI 的真实数据 SSR 渲染（App 的 SSR 阶段 categories 还是空数组，这里带上数据单独渲染） ----
const render = (label: string, el: ReturnType<typeof createElement>): string => {
  try { const h = renderToString(el); oks.push(label + " renderToString 成功"); return h; }
  catch (e) { fails.push(label + " renderToString 抛异常：" + (e instanceof Error ? e.message : String(e))); return ""; }
};
// 用固定的分类/建议补丁渲染卡片（不依赖前面断言对 mock 数据的改动顺序）
const cardBase = req("GET", "/items/1").body;
const mkCard = (patch: Record<string, unknown>, extra: Record<string, unknown> = {}) => renderToString(createElement(ItemCardView, {
  item: { ...cardBase, ...patch }, onOpen: () => {}, onToggleFavorite: () => {}, imported: false, ...extra,
} as any));
const asg = (over: Record<string, unknown>) => ({
  categoryId: "clothing", categoryName: "服装", subCategoryId: "clothing.suit", subCategoryName: "套装",
  source: "manual", confidence: null, evidence: null, reason: null, assignedAt: null, ...over,
});
const cardCat = mkCard({ category: asg({}), suggestion: null });
expect(cardCat.includes("服装 › 套装") && cardCat.includes("手动设置"), "卡片：手动归属显示「主 › 子」分类徽章 + 来源");
const cardAuto = mkCard({ category: asg({ source: "auto", confidence: 0.82 }), suggestion: null });
expect(cardAuto.includes("服装 › 套装") && cardAuto.includes("自动推断"), "卡片：自动归属显示来源标签「自动推断」");
const cardTopOnly = mkCard({ category: asg({ subCategoryId: null, subCategoryName: null }), suggestion: null });
expect(cardTopOnly.includes(">服装<") && !cardTopOnly.includes("服装 › "), "卡片：只有主分类时不显示「主 › 子」");
const cardUncat = mkCard({ category: null, suggestion: null });
expect(cardUncat.includes("未分类") && cardUncat.includes("badge muted"), "卡片：未分类显示灰 chip「未分类」");
const cardSug = mkCard({ category: null, suggestion: { categoryId: "accessories", categoryName: "饰品", subCategoryId: "accessories.other", subCategoryName: "其他饰品", confidence: 0.61, reason: "标题命中", evidence: null, suggestedAt: null } });
const sugFrag = cardSug.slice(Math.max(0, cardSug.indexOf("badge warn") - 40), cardSug.indexOf("badge warn") + 180).replace(/\s+/g, " ");
expect(cardSug.includes("建议") && cardSug.includes("其他饰品") && cardSug.includes("badge-btn"), "卡片：有待确认建议时加可点提示 ｜ " + sugFrag);
const cardPick = mkCard({ category: null, suggestion: null }, { selectMode: true, selected: true, onToggleSelect: () => {} });
expect(cardPick.includes("card sel") && cardPick.includes('type="checkbox"') && cardPick.includes('class="pick on"'), "卡片：选择模式的复选框 + .card.sel 选中态渲染");
const cardNoPick = mkCard({ category: null, suggestion: null });
expect(!cardNoPick.includes('class="pick'), "卡片：非选择模式不渲染复选框（不复用整卡点击）");

const baseFilters = { site: "", status: "", container: "", tag: "", imported: "any", sort: "updated", catIds: [] as string[], catMatch: "any" as const, uncategorized: false, pendingCategory: false };
const sbProps = {
  text: "", onText: () => {}, atAvatars: [], unresolved: [], onRemoveAt: () => {}, tags: [], loading: false, total: 9,
  filters: baseFilters, onFilters: () => {}, categories: cats.body.categories, catStats: cats.body.stats, catErr: "",
};
const sb = render("SearchBar(categories)", createElement(SearchBar, sbProps as any));
expect(sb.includes("服装") && sb.includes("未分类") && sb.includes("待确认") && sb.includes("cat-filter"), "筛选：分类树 chip + 未分类/待确认 + 计数渲染");
const sbActive = renderToString(createElement(SearchBar, { ...sbProps, filters: { ...baseFilters, catIds: ["clothing"] } } as any));
expect(sbActive.includes("清除分类筛选") && sbActive.includes("tag-chip on"), "筛选：选中分类后出现「清除分类筛选」与 .on 态");
const sbErr = renderToString(createElement(SearchBar, { ...sbProps, categories: [], catStats: null, catErr: "加载分类失败：后端未提供分类接口（NOT_FOUND：mock 未实现）" } as any));
expect(sbErr.includes("后端未提供分类接口"), "筛选：分类接口 404 时显式提示（不静默）");

const editor = render("CategoryEditor", createElement(CategoryEditor, { detail: req("GET", "/items/6").body, onToast: () => {}, onSaved: () => {} } as any));
expect(editor.includes("主分类") === false && editor.includes("载入分类树"), "详情页分类编辑区：SSR 阶段（未跑 useEffect）渲染载入态而非报错");

// ---- ② SSR 冒烟 ----
let html = "";
try {
  html = renderToString(createElement(App));
  oks.push("renderToString(App) 成功，" + html.length + " 字节");
} catch (e) {
  fails.push("renderToString 抛异常：" + (e instanceof Error ? e.stack ?? e.message : String(e)));
}
for (const needle of ["头像轨", "AssetVault", "搜索", "导入", "作业", "已拥有", "分类", "未分类"]) {
  if (html.includes(needle)) oks.push("渲染包含「" + needle + "」");
  else fails.push("渲染缺少「" + needle + "」");
}

console.log("通过 " + oks.length + " 项：");
for (const o of oks) console.log("  ✓ " + o);
if (fails.length) {
  console.log("\n失败 " + fails.length + " 项：");
  for (const f of fails) console.log("  ✗ " + f);
  process.exit(1);
}
console.log("\n全部通过（mock 形状 + 状态机 409 + SSR 渲染）");
