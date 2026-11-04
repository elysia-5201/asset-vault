/**
 * 整理待办四类规则（cleanup-todos spec §3/§6.1，P4-T1）。
 *
 * 全部用临时 SQLite fixture（test/schema/_db.ts 建真实 schema.sql），不碰生产库/素材/7317。
 * 口径：一行 = (item, rule)；counts 是规则命中计数（不受 ignored 过滤影响），
 * total 是当前列表行数（受 rule/q/avatar/category/ignored 影响）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { openTempDb, addRoot, addItem, addAsset, addAvatar, addImage, count, NOW, type TempDb } from "../schema/_db";
import { Repo } from "../../apps/server/src/db/repo";
import { listCleanupTodos, parseLocalSourcePolicy, type LocalSourcePolicy } from "../../apps/server/src/db/cleanup";

/** 缺参/非法 local 策略必须是 400 INVALID_INPUT + details.code=LOCAL_POLICY_REQUIRED（不静默默认）。 */
const isLocalPolicyRequired = (e: unknown): boolean => {
  const err = e as { code?: string; details?: { code?: string } };
  return err?.code === "INVALID_INPUT" && err?.details?.code === "LOCAL_POLICY_REQUIRED";
};

const linkAvatar = (db: TempDb["db"], itemId: number, avatarId: number, match = "any") =>
  db.prepare("INSERT INTO item_avatars(item_id,avatar_id,match,confidence,source) VALUES (?,?,?,1,'manual')").run(itemId, avatarId, match);

test("四类规则正反例", () => {
  const t = openTempDb(); const repo = new Repo(t.db); const rootId = addRoot(t.db, "/lib");
  const av = addAvatar(t.db, "A");
  const link = (id: number, match = "any") => linkAvatar(t.db, id, av, match);
  const noImg = addItem(t.db, { title: "noimg", source_site: "booth", source_url: "https://x" }); link(noImg);
  const hasImg = addItem(t.db, { title: "hasimg", source_site: "booth", source_url: "https://x" }); addImage(t.db, hasImg); link(hasImg);
  const tab = addItem(t.db, { title: "tab", source_site: "booth", source_url: "\t" }); addImage(t.db, tab); link(tab);
  const gone = addItem(t.db, { title: "gone", source_site: "booth", source_url: "https://x", source_gone: 1 }); addImage(t.db, gone); link(gone);
  const ex = addItem(t.db, { title: "ex", source_site: "booth", source_url: "https://x" }); addImage(t.db, ex); link(ex, "exclude");
  const miss = addItem(t.db, { title: "miss", source_site: "booth", source_url: "https://x" }); addImage(t.db, miss); link(miss);
  addAsset(t.db, miss, rootId, "/lib/m.zip", { status: "missing" });
  const r = listCleanupTodos(repo, { localSourcePolicy: "include_local" });
  const rules = (id: number) => r.items.filter((x) => x.item.id === id).map((x) => x.rule);
  assert.deepEqual(rules(noImg), ["missing_cover"]);
  assert.deepEqual(rules(hasImg), []);
  assert.ok(rules(tab).includes("missing_source"));
  assert.ok(!rules(gone).includes("missing_source"));
  assert.ok(rules(ex).includes("unlinked_model"));
  assert.ok(rules(miss).includes("missing_file"));
  assert.equal(r.counts.missing_cover.total, 1);
  t.close();
});

test("local 策略与缺参 400", () => {
  const t = openTempDb(); const repo = new Repo(t.db);
  const local = addItem(t.db, { title: "local", source_site: "local" });
  const inc = listCleanupTodos(repo, { localSourcePolicy: "include_local" });
  assert.ok(inc.items.some((x) => x.item.id === local && x.rule === "missing_source"));
  assert.equal(inc.counts.missing_source.localExcluded, 0);
  const exc = listCleanupTodos(repo, { localSourcePolicy: "exclude_local" });
  assert.ok(!exc.items.some((x) => x.item.id === local && x.rule === "missing_source"));
  assert.equal(exc.counts.missing_source.localExcluded, 1);
  assert.throws(() => parseLocalSourcePolicy(undefined), isLocalPolicyRequired);
  assert.throws(() => parseLocalSourcePolicy("bogus"), isLocalPolicyRequired);
  assert.throws(() => listCleanupTodos(repo, { localSourcePolicy: undefined as unknown as LocalSourcePolicy }), isLocalPolicyRequired);
  t.close();
});

test("missing_cover：cover 指向他人图不算缺；悬空 cover 算缺", () => {
  const t = openTempDb(); const repo = new Repo(t.db);
  const av = addAvatar(t.db, "A");
  const other = addItem(t.db, { title: "other", source_url: "https://x" }); linkAvatar(t.db, other, av);
  const img = addImage(t.db, other);
  const borrow = addItem(t.db, { title: "borrow", source_url: "https://x", cover_image_id: img }); linkAvatar(t.db, borrow, av);
  const dangling = addItem(t.db, { title: "dangling", source_url: "https://x" }); linkAvatar(t.db, dangling, av);
  // 悬空 cover 正常路径被 FK RESTRICT 挡住（spec §3.1 边界），这里临时关 FK 造出该行，验证规则按真实可见性判定。
  t.db.pragma("foreign_keys = OFF");
  t.db.prepare("UPDATE items SET cover_image_id = 999999 WHERE id = ?").run(dangling);
  t.db.pragma("foreign_keys = ON");
  const r = listCleanupTodos(repo, { rule: "missing_cover", localSourcePolicy: "include_local" });
  const ids = r.items.map((x) => x.item.id);
  assert.ok(!ids.includes(other), "有自己图片的条目不算缺封面");
  assert.ok(!ids.includes(borrow), "cover 指向他人图片时卡片有可见图，不算缺封面");
  assert.ok(ids.includes(dangling), "cover 悬空 = 没有可解析的图，算缺封面");
  t.close();
});

test("unlinked_model：any/all 不算，exclude 算，asset_avatars 不算", () => {
  const t = openTempDb(); const repo = new Repo(t.db); const rootId = addRoot(t.db, "/lib");
  const av = addAvatar(t.db, "A");
  const anyI = addItem(t.db, { title: "any", source_url: "https://x" }); linkAvatar(t.db, anyI, av, "any");
  const allI = addItem(t.db, { title: "all", source_url: "https://x" }); linkAvatar(t.db, allI, av, "all");
  const exI = addItem(t.db, { title: "ex", source_url: "https://x" }); linkAvatar(t.db, exI, av, "exclude");
  const assetOnly = addItem(t.db, { title: "asset-only", source_url: "https://x" });
  const assetId = addAsset(t.db, assetOnly, rootId, "/lib/a.zip");
  t.db.prepare("INSERT INTO asset_avatars(asset_id,avatar_id,confidence) VALUES (?,?,1)").run(assetId, av);
  const r = listCleanupTodos(repo, { rule: "unlinked_model", localSourcePolicy: "include_local" });
  const ids = r.items.map((x) => x.item.id);
  assert.ok(!ids.includes(anyI), "any 是正向关联");
  assert.ok(!ids.includes(allI), "all 是正向关联");
  assert.ok(ids.includes(exI), "exclude 不算已关联");
  assert.ok(ids.includes(assetOnly), "asset_avatars 不是条目级正向证据");
  const row = r.items.find((x) => x.item.id === assetOnly);
  assert.deepEqual(row?.evidence, { itemAvatarCount: 0, assetAvatarCount: 1 });
  t.close();
});

test("missing_file：只读 assets.status，置回 present 后自动消失", () => {
  const t = openTempDb(); const repo = new Repo(t.db); const rootId = addRoot(t.db, "/lib");
  const av = addAvatar(t.db, "A");
  const miss = addItem(t.db, { title: "miss", source_url: "https://x" }); linkAvatar(t.db, miss, av); addImage(t.db, miss);
  addAsset(t.db, miss, rootId, "/lib/miss.zip", { status: "missing" });
  const ok = addItem(t.db, { title: "ok", source_url: "https://x" }); linkAvatar(t.db, ok, av); addImage(t.db, ok);
  addAsset(t.db, ok, rootId, "/lib/ok.zip", { status: "present" });
  const r1 = listCleanupTodos(repo, { rule: "missing_file", localSourcePolicy: "include_local" });
  assert.deepEqual(r1.items.map((x) => x.item.id), [miss]);
  t.db.prepare("UPDATE assets SET status='present' WHERE item_id=?").run(miss);
  const r2 = listCleanupTodos(repo, { rule: "missing_file", localSourcePolicy: "include_local" });
  assert.equal(r2.total, 0);
  t.close();
});

test("missing_source 空白判定：charlist 覆盖 tab/CR/LF，普通 TRIM 不剥 tab（反例对照）", () => {
  const t = openTempDb(); const repo = new Repo(t.db);
  const av = addAvatar(t.db, "A");
  const blank = addItem(t.db, { title: "blank", source_url: " \t\r\n " }); linkAvatar(t.db, blank, av);
  const spaced = addItem(t.db, { title: "spaced", source_url: "  x  " }); linkAvatar(t.db, spaced, av);
  const r = listCleanupTodos(repo, { rule: "missing_source", localSourcePolicy: "include_local" });
  const ids = r.items.map((x) => x.item.id);
  assert.ok(ids.includes(blank), "只有空白字符（含 tab/CR/LF）应判缺来源");
  assert.ok(!ids.includes(spaced), "去掉首尾空格后仍有内容，不算缺来源");
  // 反例对照：SQLite 默认 TRIM(X) 只剥空格，不剥 tab —— 旧写法会漏掉 blank，本测试才有区分力。
  const old = t.db.prepare("SELECT TRIM(?) = '' AS hit").get("\t") as { hit: number };
  assert.equal(old.hit, 0, "普通 TRIM 不应剥 tab（否则本对照失去意义）");
  t.close();
});

test("基础范围排除 archived/trashed", () => {
  const t = openTempDb(); const repo = new Repo(t.db);
  const av = addAvatar(t.db, "A");
  const archived = addItem(t.db, { title: "archived", source_url: "https://x", status: "archived" }); linkAvatar(t.db, archived, av);
  const trashed = addItem(t.db, { title: "trashed", source_url: "https://x", status: "trashed" }); linkAvatar(t.db, trashed, av);
  const live = addItem(t.db, { title: "live", source_url: "https://x" }); linkAvatar(t.db, live, av);
  const r = listCleanupTodos(repo, { localSourcePolicy: "include_local" });
  assert.deepEqual(r.items.map((x) => x.item.id), [live]);
  assert.equal(r.counts.total, 1);
  t.close();
});

test("ignored=hide|show|only 与 counts 口径", () => {
  const t = openTempDb(); const repo = new Repo(t.db); const rootId = addRoot(t.db, "/lib");
  const av = addAvatar(t.db, "A");
  const A = addItem(t.db, { title: "A", source_url: "https://x" }); linkAvatar(t.db, A, av);
  const B = addItem(t.db, { title: "B", source_url: "https://x" }); linkAvatar(t.db, B, av);
  const C = addItem(t.db, { title: "C", source_url: "https://x" }); linkAvatar(t.db, C, av);
  const D = addItem(t.db, { title: "D", source_url: "https://x" }); linkAvatar(t.db, D, av); addImage(t.db, D);
  addAsset(t.db, D, rootId, "/lib/d.zip", { status: "missing" });
  const ignore = (id: number, rule: string) => t.db.prepare("INSERT INTO cleanup_ignores(item_id,rule,note,ignored_at) VALUES (?,?,?,?)").run(id, rule, null, NOW);
  ignore(A, "missing_cover"); ignore(D, "missing_file");
  addImage(t.db, A); // A 的缺封面已解决 → 该忽略行 resolved:true（粘性，不自动删）
  const hide = listCleanupTodos(repo, { localSourcePolicy: "include_local" });
  assert.deepEqual(hide.items.map((x) => x.item.id).sort((a, b) => a - b), [B, C]);
  assert.equal(hide.total, 2);
  assert.equal(hide.counts.total, 3, "counts 是规则命中行数，不受 ignored 过滤影响");
  assert.deepEqual(hide.counts.missing_cover, { total: 2, ignored: 0 });
  assert.deepEqual(hide.counts.missing_file, { total: 1, ignored: 1 });
  const show = listCleanupTodos(repo, { localSourcePolicy: "include_local", ignored: "show" });
  assert.deepEqual(show.items.map((x) => x.item.id).sort((a, b) => a - b), [B, C, D]);
  assert.equal(show.items.find((x) => x.item.id === D)?.ignored, true);
  assert.equal(show.items.find((x) => x.item.id === B)?.ignored, false);
  const only = listCleanupTodos(repo, { localSourcePolicy: "include_local", ignored: "only" });
  assert.equal(only.total, 2, "ignored=only 的 total 是忽略行数（含已解决）");
  assert.equal(only.counts.total, 3, "counts 仍是规则命中行数，与 total 口径不同");
  const aRow = only.items.find((x) => x.item.id === A);
  const dRow = only.items.find((x) => x.item.id === D);
  assert.equal(aRow?.rule, "missing_cover");
  assert.equal(aRow?.resolved, true, "问题已解决 → resolved:true");
  assert.equal(dRow?.rule, "missing_file");
  assert.equal(dRow?.resolved, false, "问题仍在 → resolved:false");
  assert.ok(only.items.every((x) => x.ignored === true && x.resolved !== null));
  t.close();
});

test("q：子串匹配、FTS/LIKE 两条路径、注入串参数化", () => {
  const t = openTempDb(); const repo = new Repo(t.db);
  const av = addAvatar(t.db, "A");
  const fts = repo.createItem({ title: "shinano 连衣裙", source_url: "https://x" }); linkAvatar(t.db, fts.id, av);
  const short = addItem(t.db, { title: "sh", source_url: "https://x" }); linkAvatar(t.db, short, av);
  const hitLong = listCleanupTodos(repo, { localSourcePolicy: "include_local", q: "shinano" });
  assert.ok(hitLong.items.some((x) => x.item.id === fts.id), ">=3 字符走 FTS 子串");
  const hitShort = listCleanupTodos(repo, { localSourcePolicy: "include_local", q: "sh" });
  assert.ok(hitShort.items.some((x) => x.item.id === short), "<3 字符回退 LIKE");
  const inj = listCleanupTodos(repo, { localSourcePolicy: "include_local", q: "' OR 1=1 --" });
  assert.equal(inj.total, 0, "注入串必须参数化，不能扩大结果集");
  t.close();
});

test("纯读：查询前后各表行数不变", () => {
  const t = openTempDb(); const repo = new Repo(t.db); const rootId = addRoot(t.db, "/lib");
  const av = addAvatar(t.db, "A");
  const a = addItem(t.db, { title: "a" }); linkAvatar(t.db, a, av); addImage(t.db, a);
  const b = addItem(t.db, { title: "b" }); addAsset(t.db, b, rootId, "/lib/b.zip", { status: "missing" });
  t.db.prepare("INSERT INTO cleanup_ignores(item_id,rule,note,ignored_at) VALUES (?,?,?,?)").run(b, "missing_file", null, NOW);
  const tables = ["items", "assets", "item_images", "item_avatars", "cleanup_ignores", "cleanup_saved_filters"];
  const snap = () => tables.map((tb) => count(t.db, tb)).join(",");
  const before = snap();
  listCleanupTodos(repo, { localSourcePolicy: "include_local" });
  listCleanupTodos(repo, { localSourcePolicy: "exclude_local", ignored: "only" });
  listCleanupTodos(repo, { localSourcePolicy: "include_local", ignored: "show", sort: "title" });
  assert.equal(snap(), before);
  t.close();
});

test("分页稳定、排序与 limit clamp", () => {
  const t = openTempDb(); const repo = new Repo(t.db);
  const av = addAvatar(t.db, "A");
  for (const title of ["c", "a", "b"]) { const id = addItem(t.db, { title }); linkAvatar(t.db, id, av); }
  const all = listCleanupTodos(repo, { localSourcePolicy: "include_local", limit: 200 });
  assert.equal(all.total, 6, "3 条 × (缺封面+缺来源)");
  const seen: string[] = [];
  for (let offset = 0; offset < 6; offset += 2) {
    const page = listCleanupTodos(repo, { localSourcePolicy: "include_local", limit: 2, offset });
    seen.push(...page.items.map((x) => x.item.id + ":" + x.rule));
  }
  assert.equal(seen.length, 6);
  assert.equal(new Set(seen).size, 6, "翻页重复或遗漏");
  const byTitle = listCleanupTodos(repo, { localSourcePolicy: "include_local", sort: "title", limit: 200 });
  const titles = byTitle.items.map((x) => x.item.title);
  assert.deepEqual([...titles].sort(), titles, "title 排序不是升序");
  const clamped = listCleanupTodos(repo, { localSourcePolicy: "include_local", limit: 0 });
  assert.equal(clamped.items.length, 1, "limit 下限 clamp 到 1");
  for (let i = 0; i < 201; i++) { const id = addItem(t.db, { title: "bulk-" + i, source_url: "https://x" }); linkAvatar(t.db, id, av); }
  const capped = listCleanupTodos(repo, { localSourcePolicy: "include_local", limit: 999 });
  assert.equal(capped.total, 207);
  assert.equal(capped.items.length, 200, "limit 上限 clamp 到 200");
  t.close();
});

test("avatarIds/categoryIds 过滤与 counts 同步", () => {
  const t = openTempDb(); const repo = new Repo(t.db);
  const av1 = addAvatar(t.db, "A1"); const av2 = addAvatar(t.db, "A2");
  const i1 = addItem(t.db, { title: "i1", source_url: "https://x", cat_id: "clothing" }); linkAvatar(t.db, i1, av1);
  const i2 = addItem(t.db, { title: "i2", source_url: "https://x", cat_id: "props" }); linkAvatar(t.db, i2, av2);
  const byAvatar = listCleanupTodos(repo, { localSourcePolicy: "include_local", avatarIds: [av1] });
  assert.deepEqual(byAvatar.items.map((x) => x.item.id), [i1]);
  assert.equal(byAvatar.counts.missing_cover.total, 1);
  const byCat = listCleanupTodos(repo, { localSourcePolicy: "include_local", categoryIds: ["props"] });
  assert.deepEqual(byCat.items.map((x) => x.item.id), [i2]);
  t.close();
});

test("ignored=only 列表套固定基础范围：归档/回收站忽略行不返回，resolved 仍按规则求值", () => {
  const t = openTempDb(); const repo = new Repo(t.db);
  const av = addAvatar(t.db, "A");
  const active = addItem(t.db, { title: "active", source_url: "https://x" }); linkAvatar(t.db, active, av);
  const activeFixed = addItem(t.db, { title: "active-fixed", source_url: "https://x" }); linkAvatar(t.db, activeFixed, av);
  const archived = addItem(t.db, { title: "archived", source_url: "https://x", status: "archived" }); linkAvatar(t.db, archived, av);
  const trashed = addItem(t.db, { title: "trashed", source_url: "https://x", status: "trashed" }); linkAvatar(t.db, trashed, av);
  const ignore = (id: number, rule: string) => t.db.prepare("INSERT INTO cleanup_ignores(item_id,rule,note,ignored_at) VALUES (?,?,?,?)").run(id, rule, null, NOW);
  ignore(active, "missing_cover"); ignore(activeFixed, "missing_cover");
  ignore(archived, "missing_cover"); ignore(trashed, "missing_cover");
  addImage(t.db, activeFixed); // activeFixed 的忽略已解决 → resolved:true（粘性行仍在）
  const ignoresBefore = count(t.db, "cleanup_ignores");
  const only = listCleanupTodos(repo, { localSourcePolicy: "include_local", ignored: "only" });
  // 列表套固定基础范围：只返回 active 条目的忽略行，归档/回收站不出现
  assert.deepEqual(only.items.map((x) => x.item.id).sort((a, b) => a - b), [active, activeFixed]);
  assert.equal(only.total, 2);
  assert.ok(!only.items.some((x) => x.item.id === archived || x.item.id === trashed));
  // resolved 仍按规则单条求值（不套基础范围）：active 未解决、activeFixed 已解决
  assert.equal(only.items.find((x) => x.item.id === active)?.resolved, false);
  assert.equal(only.items.find((x) => x.item.id === activeFixed)?.resolved, true);
  // counts 仍是规则命中计数（基础范围内）：active 命中且已忽略，activeFixed 已不命中
  assert.equal(only.counts.missing_cover.total, 1);
  assert.equal(only.counts.missing_cover.ignored, 1);
  assert.equal(only.counts.total, 1);
  // 纯读：忽略表零变化；归档/回收站的忽略行仍在（管理视图可见性/resolved 属 task31/32，本任务不实现、不声称已验证）
  assert.equal(count(t.db, "cleanup_ignores"), ignoresBefore);
  assert.equal(count(t.db, "cleanup_ignores", "item_id=?", archived), 1);
  assert.equal(count(t.db, "cleanup_ignores", "item_id=?", trashed), 1);
  t.close();
});
