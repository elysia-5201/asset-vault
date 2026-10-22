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
import { CategoryManager } from "../src/components/CategoryManager";
import { PipelinePanel } from "../src/components/PipelinePanel";
import { AvatarWorkbench, MIXED_WARNING, PLAN_STATE_LABEL, PlanPanel, SCAN_ALL_LABEL, UNIT_STATE_LABEL, UnitsEmptyState, fallbackAvatarOf, isRunBusy, pickAvatarId, sameSlot, togglePick } from "../src/components/AvatarWorkbench";
import { confirmImportPlan, executeImportPlan } from "../src/api";

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
/** React SSR 会在相邻动态文本之间插 <!-- -->，断言前先去掉（否则 "code：message" 永远匹配不上）。 */
function stripSsr(s: string): string { return s.replace(/<!-- -->/g, ""); }

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
const catOne = req("GET", "/items?catIds=hair.set");
expect(catOne.body.total === 1 && catOne.body.items[0].id === 2, "子分类 catIds=hair.set 命中 1 条（已停用的分类仍能按归属筛出）");
const un = req("GET", "/items?uncategorized=1");
expect(un.body.total > 0 && un.body.items.every((i: any) => i.category === null), "uncategorized=1 → 全部 category=null（" + un.body.total + " 条）");
const pend = req("GET", "/items?pendingCategory=1");
expect(pend.body.total > 0 && pend.body.items.every((i: any) => i.suggestion !== null), "pendingCategory=1 → 都有 suggestion（" + pend.body.total + " 条）");

const set1 = req("POST", "/items/9/category", { categoryId: "shaders", subCategoryId: "shaders.general" });
expect(set1.body.item.cat_id === "shaders" && set1.body.item.cat_sub_id === "shaders.general" && set1.body.item.cat_source === "manual", "POST /items/:id/category 写入归属（source=manual）");
const badCat = (() => { try { req("POST", "/items/9/category", { categoryId: "__nope__" }); return null; } catch (e) { return e as MockHttpError; } })();
expect(badCat !== null && badCat.status === 400, "非法 categoryId → 400（不静默）");
const mismatch = req("POST", "/items/9/category", { categoryId: "clothing", subCategoryId: "shaders.general" });
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

const batch = req("POST", "/items/category/batch", { itemIds: [9, 10], categoryId: "shaders", subCategoryId: "shaders.general", mode: "set" });
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

// ---- ③b v3 端点：筛选 / 计数 / 影响面 / 移动 / 合并 / 删除转移 / 标签 CRUD ----
const counts = req("GET", "/categories/counts");
has(counts.body, ["all", "uncategorized", "tops", "subs"], "GET /categories/counts → {all,uncategorized,tops,subs}");
expect(counts.body.all === req("GET", "/items?limit=999").body.total, "counts.all 与不带分类条件的 /items total 一致（" + counts.body.all + "）");
expect(counts.body.tops.clothing === req("GET", "/items?catIds=clothing").body.total, "counts.tops.clothing 与 catIds=clothing 一致");
expect(counts.body.subs["clothing.tops"] === req("GET", "/items?catIds=clothing.tops").body.total, "counts.subs[clothing.tops] 与 catIds=clothing.tops 一致");
expect(typeof counts.body.tops.uncategorized === "number" && counts.body.tops.uncategorized === counts.body.uncategorized, "counts.tops.uncategorized 与 counts.uncategorized 同源");
// 计数随其它筛选变化（分类条件本身不参与）
const fOnly = req("GET", "/categories/counts?favoriteOnly=1");
const favTotal = req("GET", "/items?favoriteOnly=1&limit=999").body.total;
expect(fOnly.body.all === favTotal && fOnly.body.all < counts.body.all, "counts 随其它筛选变化（favoriteOnly=1 → " + fOnly.body.all + " < " + counts.body.all + "）");
const qOnly = req("GET", "/categories/counts?q=" + encodeURIComponent("セーラー"));
expect(qOnly.body.all === req("GET", "/items?q=" + encodeURIComponent("セーラー")).body.total, "counts 支持关键词筛选（q=セーラー → " + qOnly.body.all + "）");

const impact = req("GET", "/categories/clothing/impact");
has(impact.body, ["items", "subs", "suggestions"], "GET /categories/:id/impact → {items,subs,suggestions}");
expect(impact.body.items === req("GET", "/items?catIds=clothing&limit=999").body.total, "impact.items 与 catIds=clothing 的 total 一致（" + impact.body.items + "）");
expect(impact.body.subs === cats.body.categories.find((t: any) => t.id === "clothing").children.length, "impact.subs = 子分类数");
const impact404 = (() => { try { req("GET", "/categories/__nope__/impact"); return null; } catch (e) { return e as MockHttpError; } })();
expect(impact404 !== null && impact404.status === 404, "未知分类 impact → 404");

// 移动子分类（ID 不变）
const beforeMove = cats.body.categories.find((t: any) => t.id === "other").children.map((c: any) => c.id);
const moved = req("POST", "/categories/other.unclassed/move", { parentId: "textures" });
expect(moved.body.category.parentId === "textures" && moved.body.category.id === "other.unclassed", "POST /categories/:id/move 换父且 ID 不变");
expect(req("GET", "/categories").body.categories.find((t: any) => t.id === "textures").children.some((c: any) => c.id === "other.unclassed"), "移动后出现在新父分类的子列表里");
const movedBack = req("POST", "/categories/other.unclassed/move", { parentId: "other" });
expect(movedBack.body.category.parentId === "other" && beforeMove.includes("other.unclassed"), "移回原父分类（ID 仍是 other.unclassed）");
const moveBad = (() => { try { req("POST", "/categories/clothing/move", { parentId: "other" }); return null; } catch (e) { return e as MockHttpError; } })();
expect(moveBad !== null && moveBad.status === 400, "一级分类不能移动 → 400");

// 删除：转移目标生效，系统分类 409，素材不丢
const beforeUncat = req("GET", "/items?uncategorized=1&limit=999").body.total;
const mk = req("POST", "/categories", { name: "__smoke_del", parentId: "clothing" });
const mkId = String(mk.body.category.id);
req("POST", "/items/9/category", { categoryId: "clothing", subCategoryId: mkId });
const delImpact = req("GET", "/categories/" + encodeURIComponent(mkId) + "/impact");
expect(delImpact.body.items === 1, "删除前影响面统计到 1 条素材（" + delImpact.body.items + "）");
const delOk = req("DELETE", "/categories/" + encodeURIComponent(mkId) + "?transferTo=none");
expect(delOk.body.movedSubs === 1 && delOk.body.moved === 0 && delOk.body.deleted === 1, "DELETE 子分类 ?transferTo=none → 该子分类下的素材整条回未分类并删分类（movedSubs=" + delOk.body.movedSubs + " moved=" + delOk.body.moved + "）");
expect(req("GET", "/items?uncategorized=1&limit=999").body.total === beforeUncat + 1, "被删分类的素材回到未分类（不删素材）");
const sysDel = (() => { try { req("DELETE", "/categories/clothing?transferTo=none"); return null; } catch (e) { return e as MockHttpError; } })();
expect(sysDel !== null && sysDel.status === 409, "删除系统分类 → 409 CONFLICT");

// 合并：同级、非系统源；素材迁到目标
const mkA = req("POST", "/categories", { name: "__smoke_merge_a", parentId: "textures" });
const mkB = req("POST", "/categories", { name: "__smoke_merge_b", parentId: "textures" });
const idA = String(mkA.body.category.id); const idB = String(mkB.body.category.id);
req("POST", "/items/10/category", { categoryId: "textures", subCategoryId: idA });
const merged = req("POST", "/categories/" + encodeURIComponent(idA) + "/merge", { intoId: idB });
expect(merged.body.moved === 1 && merged.body.deleted === 1, "POST /categories/:id/merge 迁移素材并删除源（moved=" + merged.body.moved + "）");
expect(req("GET", "/categories").body.categories.flatMap((t: any) => t.children ?? []).some((c: any) => c.id === idA) === false, "合并后源分类不再出现");
const mergeSys = (() => { try { req("POST", "/categories/clothing/merge", { intoId: "makeup" }); return null; } catch (e) { return e as MockHttpError; } })();
expect(mergeSys !== null && mergeSys.status === 409, "系统分类作为合并源 → 409");
req("DELETE", "/categories/" + encodeURIComponent(idB) + "?transferTo=none");

// 标签 CRUD（v3 §4）
const tagList = req("GET", "/tags");
has(tagList.body.tags[0], ["id", "name", "namespace", "color", "sort", "itemCount"], "GET /tags 含 color/sort/itemCount");
const tagNew = req("POST", "/tags", { name: "__smoke_tag_v3", color: "#ff00aa" });
expect(tagNew.status === 201 && tagNew.body.tag.color === "#ff00aa", "POST /tags → 201 {tag}（含颜色）");
const tagDup = req("POST", "/tags", { name: "__smoke_tag_v3" });
expect(tagDup.status === 200 && tagDup.body.tag.id === tagNew.body.tag.id, "POST /tags 同名幂等：返回已存在的那个，不重复创建（status=" + tagDup.status + "）");
req("POST", "/items/1/tags", { tags: ["__smoke_tag_v3"] });
const tagPatched = req("PATCH", "/tags/" + tagNew.body.tag.id, { name: "__smoke_tag_v3b", color: "#00ff00" });
expect(tagPatched.body.tag.name === "__smoke_tag_v3b" && tagPatched.body.tag.color === "#00ff00", "PATCH /tags/:id 改名改色");
expect((req("GET", "/items/1").body.tags as string[]).includes("__smoke_tag_v3b"), "改名后素材关联跟随（按 id 关联，不丢）");
const tagDel = req("DELETE", "/tags/" + tagNew.body.tag.id);
expect(tagDel.body.removed === 1, "DELETE /tags/:id → {removed:" + tagDel.body.removed + "}（只删关联，不删素材）");
expect(req("GET", "/items/1").body.item.title.length > 0 && (req("GET", "/items/1").body.tags as string[]).includes("__smoke_tag_v3b") === false, "删除标签后素材仍在，只是关联没了");
const tagBad = (() => { try { req("POST", "/tags", { name: "__smoke_tag_bad", color: "red" }); return null; } catch (e) { return e as MockHttpError; } })();
expect(tagBad !== null && tagBad.status === 400, "非法颜色 → 400");

// 组合筛选：标签 ANY/ALL + 收藏 + 分类叠加
const tagAny = req("GET", "/items?tags=" + encodeURIComponent("衣装") + "," + encodeURIComponent("無料"));
const tagAll = req("GET", "/items?tags=" + encodeURIComponent("衣装") + "," + encodeURIComponent("無料") + "&tagsMatch=all");
expect(tagAny.body.total > tagAll.body.total && tagAll.body.total >= 0, "API 仍支持 tags/tagsMatch（UI 已改为搜索命中标签；接口保留供脚本与兼容）");
const combo = req("GET", "/items?catIds=clothing&tags=" + encodeURIComponent("衣装") + "&favoriteOnly=1");
expect(combo.body.items.every((i: any) => i.favorite === 1 && (i.category?.categoryId === "clothing")), "组合筛选（分类+标签+收藏）结果同时满足全部条件（" + combo.body.total + " 条）");

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

const baseFilters = { site: "", status: "", container: "", imported: "any", sort: "updated", catTop: "", catSub: "", pendingCategory: false, favoriteOnly: false };
const catCounts = req("GET", "/categories/counts").body;
const tagRows = req("GET", "/tags").body.tags;
const sbProps = {
  text: "", onText: () => {}, atAvatars: [], unresolved: [], onRemoveAt: () => {}, loading: false, total: 9,
  filters: baseFilters, onFilters: () => {}, categories: cats.body.categories, catCounts, countsScope: "filtered" as const, catErr: "",
};
const sb = render("SearchBar(categories)", createElement(SearchBar, sbProps as any));
expect(sb.includes("服饰") && sb.includes("未分类") && sb.includes("待确认") && sb.includes("cat-chip"), "一级分类栏：一级 chip 渲染（服饰/未分类/待确认）");
expect(sb.includes("cat-chip-n") && sb.includes(String(catCounts.tops.clothing)), "一级分类栏显示当前筛选下的数量（clothing=" + catCounts.tops.clothing + "）");
const sbTop = renderToString(createElement(SearchBar, { ...sbProps, filters: { ...baseFilters, catTop: "clothing" } } as any));
expect(sbTop.includes("全部服饰") && sbTop.includes("cat-bar-sub") && sbTop.includes("上衣"), "二级分类栏：切一级后出现「全部服饰」+ 子分类（上衣）");
expect(sbTop.includes("清除分类筛选") && sbTop.includes("cat-chip on"), "筛选：选中分类后出现「清除分类筛选」与 .on（紫色）态");
const sbUncat = renderToString(createElement(SearchBar, { ...sbProps, filters: { ...baseFilters, catTop: "uncategorized" } } as any));
expect(!sbUncat.includes("cat-bar-sub"), "无子分类的一级（未分类）不渲染二级分类栏（不占位）");
// v3.1：标签不再单独筛选（改由搜索命中）——标签栏必须消失，但搜索框要提示可以搜标签
const sbNoTagBar = renderToString(createElement(SearchBar, { ...sbProps } as any));
expect(!sbNoTagBar.includes("tag-dot") && !sbNoTagBar.includes("清除标签（") && !sbNoTagBar.includes("标签（单值）"), "标签不再单独筛选：不渲染标签多选栏与单值下拉");
expect(sbNoTagBar.includes("标签"), "搜索框提示里包含「标签」（告诉用户可以直接搜标签）");
const sbErr = renderToString(createElement(SearchBar, { ...sbProps, categories: [], catCounts: null, catErr: "加载分类失败：后端未提供分类接口（NOT_FOUND：mock 未实现）" } as any));
expect(sbErr.includes("后端未提供分类接口"), "筛选：分类接口 404 时显式提示（不静默）");

// 卡片：标签最多 3 个 + “+N”
const cardTags = mkCard({ category: null, suggestion: null, tags: ["a", "b", "c", "d"] }, { tagColors: { a: "#111111" } });
const exactTagChips = (cardTags.match(/class="card-tag"/g) ?? []).length;
expect(exactTagChips === 3 && cardTags.includes("card-tag more") && cardTags.includes(">+1<"), "卡片：标签最多显示 3 个（实际 " + exactTagChips + "），其余“+N”");
expect(cardTags.includes("tag-dot") && cardTags.includes("#111111"), "卡片：标签带颜色点（从 GET /api/tags 的 color 来）");
const cardTitle = mkCard({ title: "很长的标题".repeat(20), category: null, suggestion: null });
expect(cardTitle.includes('title="' + "很长的标题".repeat(20) + '"'), "卡片：标题截断但 title 属性带完整标题");

// 分类管理浮层 / 标签管理（SSR 无 useEffect，只验证结构不抛错）
const mgr = render("CategoryManager", createElement(CategoryManager, {
  categories: cats.body.categories, catStats: cats.body.stats, catErr: "", tags: tagRows,
  onClose: () => {}, onToast: () => {}, onChanged: () => {},
} as any));
expect(mgr.includes("分类管理") && mgr.includes("新增一级") && mgr.includes("标签"), "分类管理浮层：左树 + 新增一级 + 标签页签渲染");
expect(mgr.includes("mark") && mgr.includes("系统") && mgr.includes("未分类"), "分类管理：系统标记（builtin）+ 未分类入口渲染");

const editor = render("CategoryEditor", createElement(CategoryEditor, { detail: req("GET", "/items/6").body, onToast: () => {}, onSaved: () => {} } as any));
expect(editor.includes("主分类") === false && editor.includes("载入分类树"), "详情页分类编辑区：SSR 阶段（未跑 useEffect）渲染载入态而非报错");

// ---- ③ 索引流水线（v0.6.0 §13）：mock 形状 + 状态迁移 + SSR ----
const pipe = req("GET", "/pipeline");
expect(pipe.status === 200, "GET /pipeline → 200");
has(pipe.body, ["started", "paused", "startedAt", "running", "queued", "waitingRetry", "failed", "done", "cancelled", "skipped", "stages", "cache", "memory", "processed", "failures", "lastError", "limits", "nonDefaultLimits"], "PipelineOverview");
expect(Array.isArray(pipe.body.stages) && pipe.body.stages.length === 7, "GET /pipeline：stages 是 7 个阶段（实际 " + (pipe.body.stages?.length ?? "?") + "）");
expect(pipe.body.stages.every((s: any) => ["stage", "queued", "running", "waitingRetry", "failed", "done", "skipped", "avgMs"].every((k) => k in s)), "stages[]：每行含 stage/queued/running/waitingRetry/failed/done/skipped/avgMs");
has(pipe.body.cache, ["entries", "bytes", "hits", "hitRate", "maxBytes"], "PipelineCache");
has(pipe.body.memory, ["rss", "heapUsed", "heapTotal", "external"], "PipelineMemory");

const pFailed = req("GET", "/pipeline/tasks?state=failed");
expect(pFailed.status === 200 && pFailed.body.tasks.length > 0, "GET /pipeline/tasks?state=failed → 有失败任务（" + pFailed.body.tasks.length + " 条）");
has(pFailed.body.tasks[0], ["id", "asset_id", "item_id", "stage", "state", "priority", "attempts", "max_attempts", "bytes_done", "bytes_total", "items_done", "items_total", "error_code", "error", "created_at", "started_at", "finished_at", "next_retry_at"], "PipelineTask");
expect(pFailed.body.tasks.every((t: any) => t.state === "failed"), "GET /pipeline/tasks?state=failed 只返回 failed");

const tasksAll = req("GET", "/pipeline/tasks?limit=50").body.tasks as any[];
const retryId = tasksAll.find((t) => t.state === "failed").id;
// 注意：mock 是就地改对象，必须先把 attempts 取成数字快照，否则读到的永远是改后的值
const beforeAttempts = (tasksAll.find((t) => t.id === retryId) as any)?.attempts ?? 0;
const plRetry = req("POST", "/pipeline/tasks/" + retryId + "/retry");
expect(plRetry.status === 200 && plRetry.body.task.state === "queued" && plRetry.body.task.attempts === beforeAttempts + 1, "POST /pipeline/tasks/:id/retry → {task} state=queued 且 attempts+1");
expect(req("GET", "/pipeline/tasks?state=queued").body.tasks.some((t: any) => t.id === retryId), "重试后该任务出现在 queued 列表");
const plCancel = req("POST", "/pipeline/tasks/" + retryId + "/cancel");
expect(plCancel.status === 200 && plCancel.body.task.state === "cancelled", "POST /pipeline/tasks/:id/cancel → {task} state=cancelled");

const pz = req("POST", "/pipeline/pause");
expect(pz.status === 200 && pz.body.paused === true && req("GET", "/pipeline").body.paused === true, "POST /pipeline/pause → {paused:true} 且总览跟随");
const rz = req("POST", "/pipeline/resume");
expect(rz.status === 200 && rz.body.paused === false, "POST /pipeline/resume → {paused:false}");

const reix = req("POST", "/pipeline/assets/3/reindex");
expect(reix.status === 200 && typeof reix.body.queued === "number" && reix.body.queued > 0, "POST /pipeline/assets/:id/reindex → {queued:" + reix.body.queued + "}");
const boost = req("POST", "/pipeline/assets/3/boost");
expect(boost.status === 200 && typeof boost.body.boosted === "number", "POST /pipeline/assets/:id/boost → {boosted:" + boost.body.boosted + "}");
const gc = req("POST", "/pipeline/gc");
expect(gc.status === 200 && typeof gc.body.removed === "number" && typeof gc.body.bytes === "number", "POST /pipeline/gc → {removed,bytes}");
const pev = req("GET", "/pipeline/events?limit=200");
expect(pev.status === 200 && Array.isArray(pev.body.events), "GET /pipeline/events → {events[]}");

const pipeHtml = render("PipelinePanel", createElement(PipelinePanel, { onToast: () => {} } as any));
for (const needle of ["阶段", "缓存 / 内存", "最近失败", "执行中", "等待重试", "哈希", "全文索引", "载入流水线"]) {
  expect(pipeHtml.includes(needle), "PipelinePanel SSR 含「" + needle + "」");
}

// ---- ④ Avatar 素材工作台（task-39） ----
const wbBase = {
  unitId: "u", itemId: 7, assetId: 3, title: "MANUKA 裙装", sourceSite: "booth", sourceItemId: "1234567",
  shopName: "citrus shop", coverImageId: null, packageName: "dress.zip", relPath: "Assets/dress.unitypackage",
  containerPath: "/lib/dress.zip", avatarId: 1, avatarName: "MANUKA", kind: "unitypackage",
  level: "strong", evidence: { level: "strong", summary: "包内路径命中 2 次", sources: ["archive_path"] },
  // v0.7.0 后端契约：policy 字面量 + importable 决定能不能进计划
  policy: "mixed_unitypackage", mixed: true, importable: true, parseState: "ok",
  suggested: false, confirmed: false, error: null,
};
const wbA = { ...wbBase, unitId: "a" } as any;
const wbB = { ...wbBase, unitId: "b", itemId: 8, assetId: 4 } as any;   // 同一压缩包 → 互斥
const wbC = { ...wbBase, unitId: "c", itemId: 9, assetId: 5, containerPath: "/lib/other.zip", packageName: "other.zip", policy: "single_unitypackage", mixed: false } as any;
const wbBlocked = { ...wbBase, unitId: "d", itemId: 10, assetId: 6, policy: "unknown_structure", importable: false, mixed: false } as any;

expect(sameSlot(wbA, wbB) === true, "工作台：同一压缩包里的单元判定为互斥");
expect(sameSlot(wbA, wbC) === false, "工作台：不同压缩包的单元不互斥");
let wbPlan = togglePick([], wbA);
expect(wbPlan.length === 1 && wbPlan[0].unitId === "a", "工作台：点卡片加入清单");
const afterBlocked = togglePick(wbPlan, wbBlocked);
expect(afterBlocked.length === 1 && afterBlocked[0].unitId === "a", "工作台：importable=false 的单元点不进清单（后端 policy=unknown_structure）");
wbPlan = togglePick(wbPlan, wbB);
expect(wbPlan.length === 1 && wbPlan[0].unitId === "b", "工作台清单互斥：选同包另一个会替换前一个");
wbPlan = togglePick(wbPlan, wbC);
expect(wbPlan.length === 2, "工作台清单：不同包可同时入清单");
wbPlan = togglePick(wbPlan, wbB);
expect(wbPlan.length === 1 && wbPlan[0].unitId === "c", "工作台清单：再次点击取消勾选");

const REQUIRED_UNIT_STATES = ["planned", "importing", "import_command_completed", "verifying", "verified", "partial_success", "failed", "unknown"];
expect(REQUIRED_UNIT_STATES.every((s) => !!UNIT_STATE_LABEL[s]) && UNIT_STATE_LABEL.import_command_completed === "导入命令已完成",
  "工作台：后端 8 个执行状态全部有中文标签（不新增状态）");
const mkRun = (states: string[]) => ({
  id: 1, planId: 1, state: "executing",
  units: states.map((s, i) => ({ unitId: "u" + i, itemId: i, title: "t" + i, state: s, error: null, startedAt: null, finishedAt: null })),
  error: null, startedAt: null, finishedAt: null,
}) as any;
expect(isRunBusy(mkRun(["planned", "verified"])) === true, "工作台：还有 planned 单元 → 继续轮询");
expect(isRunBusy(mkRun(["verified", "failed"])) === false, "工作台：全部终态 → 停止轮询");

// task-48：Avatar 列表为空 → 用 Unity 工程里认出的 projectAvatar 兜底并选中
expect(pickAvatarId([], { id: 5, name: "MANUKA" }) === 5, "工作台：avatars 为空时用 unityStatus.projectAvatar 兜底并选中");
expect(pickAvatarId([{ id: 7 }, { id: 8 }], { id: 5, name: "x" }) === 7, "工作台：有列表时优先列表第一条（不被兜底抢走）");
expect(pickAvatarId([], null) === null, "工作台：既没列表也没工程头像时保持未选中");
const fbAvatar = fallbackAvatarOf({ id: 5, name: "MANUKA" });
expect(fbAvatar.id === 5 && fbAvatar.name === "MANUKA" && fbAvatar.counts.total === 0, "工作台：兜底 Avatar 形状正确（计数全 0）");

// task-48：units=0 空态 + 「扫描全部结构」按钮
const emptyHtml = render("UnitsEmptyState", createElement(UnitsEmptyState, { scanning: false, onScanAll: () => {}, avatarName: "MANUKA", fallbackFromUnity: true } as any));
expect(emptyHtml.includes(SCAN_ALL_LABEL), "工作台空态：有「" + SCAN_ALL_LABEL + "」按钮");
expect(stripSsr(emptyHtml).includes("@MANUKA 名下还没有资源单元"), "工作台空态：点名当前 Avatar 没有单元");
expect(emptyHtml.includes("onlyMissing=true") && emptyHtml.includes("Unity 工程里认出来的"), "工作台空态：说明只补缺失 + 兜底来源");
const emptyScanning = render("UnitsEmptyState(scanning)", createElement(UnitsEmptyState, { scanning: true, onScanAll: () => {} } as any));
expect(emptyScanning.includes("扫描中…"), "工作台空态：扫描中按钮显示进度且禁用");

const wbHtml = render("AvatarWorkbench", createElement(AvatarWorkbench, { onClose: () => {}, onToast: () => {} } as any));
expect(wbHtml.includes(SCAN_ALL_LABEL), "工作台：工具栏有「" + SCAN_ALL_LABEL + "」入口");
for (const needle of ["Avatar 素材工作台", "选择 Avatar", "生成导入计划", "导入清单", "Unity 工程"]) {
  expect(wbHtml.includes(needle), "工作台面板 SSR 含「" + needle + "」");
}

const planFixture = {
  id: 12, state: "planned", avatarId: 1, avatarName: "MANUKA", projectPath: "E:/unity/P", projectName: "P",
  precheck: { ok: false, status: "has_warnings", warnings: ["工程里已有同名目录"], errors: [{ code: "PATH_MISSING", message: "路径不存在" }] },
  units: [
    { unitId: "a", itemId: 7, assetId: 3, title: "MANUKA 裙装", packagePath: "/lib/dress.zip", policy: "mixed", mixed: true, suggested: false, state: "planned", error: null },
    { unitId: "b", itemId: 8, assetId: 4, title: "建议项", packagePath: null, policy: "standalone", mixed: false, suggested: true, state: "planned", error: null },
  ],
  mixedWarning: null, runId: null, createdAt: null, error: null,
} as any;
const planHtml = render("PlanPanel", createElement(PlanPanel, { plan: planFixture, checks: { a: true, b: false }, onToggle: () => {}, onConfirm: () => {}, busy: false } as any));
expect(planHtml.includes(MIXED_WARNING), "工作台计划：mixed 整包风险文案出现");
expect(planHtml.includes("建议") && planHtml.includes("需你确认后才加入"), "工作台计划：suggested 需用户勾选才入计划");
expect(stripSsr(planHtml).includes("PATH_MISSING：路径不存在"), "工作台计划：precheck 错误显示 code + message");
expect(planHtml.includes("工程里已有同名目录"), "工作台计划：precheck 警告可见");
const planBoxes = (planHtml.match(/type="checkbox"/g) ?? []).length;
expect(planBoxes === 2, "工作台计划：每个单元一个复选框（实际 " + planBoxes + "）");
expect(stripSsr(planHtml).includes("确认并导入 1 个单元"), "工作台计划：确认按钮按勾选数计数（suggested 未勾选不计数）");

// task-42：execute → 202 {jobId, planId}，UI 显示 job 号并轮询 plan/run（不假设同步返回 run）
const planRunning = { ...planFixture, state: "running", jobId: 77 } as any;
const planRunningHtml = render("PlanPanel(running)", createElement(PlanPanel, {
  plan: planRunning, checks: { a: true, b: false }, onToggle: () => {}, onConfirm: () => {}, busy: false, jobId: 77,
} as any));
expect(planRunningHtml.includes("执行中"), "工作台计划：计划状态 running → 执行中（标签来自后端值）");
expect(stripSsr(planRunningHtml).includes("job #77"), "工作台计划：显示执行 job 号（202 {jobId, planId}）");
expect(typeof executeImportPlan === "function" && confirmImportPlan.length <= 1,
  "工作台：执行走独立 execute 端点（confirm 只做确认，不返回 run）");
expect(!!PLAN_STATE_LABEL.executed && !!PLAN_STATE_LABEL.blocked && !!PLAN_STATE_LABEL.failed,
  "工作台：计划终态标签齐全（executed / blocked / failed）");

// ---- ② SSR 冒烟 ----
let html = "";
try {
  html = renderToString(createElement(App));
  oks.push("renderToString(App) 成功，" + html.length + " 字节");
} catch (e) {
  fails.push("renderToString 抛异常：" + (e instanceof Error ? e.stack ?? e.message : String(e)));
}
expect(html.includes("素材工作台"), "工具栏有「素材工作台」入口（与扫描预览/批量分类同级）");
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
