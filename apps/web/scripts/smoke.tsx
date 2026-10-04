/**
 * 自测：① 内置 mock 路由的形状是否严格同 docs/api.md ② App 能否无异常渲染（SSR 冒烟）。
 * 运行：npx tsx apps/web/scripts/smoke.tsx
 */
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import App from "../src/App";
import { mockHandle, MockHttpError } from "../src/mock";

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
has(items.body.items[0], ["id", "title", "sourceSite", "status", "favorite", "coverImageId", "coverUrl", "imageCount", "assetCount", "totalBytes", "avatars", "tags", "compatDeclaredCount", "updatedAt"], "ItemCard");

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

// ---- ② SSR 冒烟 ----
let html = "";
try {
  html = renderToString(createElement(App));
  oks.push("renderToString(App) 成功，" + html.length + " 字节");
} catch (e) {
  fails.push("renderToString 抛异常：" + (e instanceof Error ? e.stack ?? e.message : String(e)));
}
for (const needle of ["头像轨", "AssetVault", "搜索", "导入", "作业", "已拥有"]) {
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
