/**
 * 整理待办 HTTP 端点（cleanup-todos spec §6.1/§6.2/§6.3，P4-T3）。
 *
 * 真实 Fastify.inject + 真实临时 SQLite（schema.sql 建库），不 listen、不碰生产库/7317。
 * 断言真实 DTO/计数/策略/resolved/幂等/CAS，不只 statusCode。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { openTempDb, addItem, addAvatar, addImage, addAsset, addRoot, count, type TempDb } from "../schema/_db";
import { Repo } from "../../apps/server/src/db/repo";
import { registerCleanupRoutes } from "../../apps/server/src/http/routes/cleanup";

function setup() {
  const t = openTempDb();
  const repo = new Repo(t.db);
  const app = Fastify({ logger: false });
  registerCleanupRoutes(app, { repo, log: () => {} });
  return { t, repo, app };
}

const json = (r: { body: string }): any => JSON.parse(r.body);

const linkAvatar = (db: TempDb["db"], itemId: number, avatarId: number, match = "any") =>
  db.prepare("INSERT INTO item_avatars(item_id,avatar_id,match,confidence,source) VALUES (?,?,?,1,'manual')").run(itemId, avatarId, match);

const snapshot = (db: TempDb["db"]) => ({
  items: db.prepare("SELECT * FROM items ORDER BY id").all(),
  assets: db.prepare("SELECT * FROM assets ORDER BY id").all(),
  images: db.prepare("SELECT * FROM item_images ORDER BY id").all(),
  avatars: db.prepare("SELECT * FROM item_avatars ORDER BY item_id, avatar_id").all(),
});

test("三个必填策略入口缺策略一律 400 LOCAL_POLICY_REQUIRED，且零写", async () => {
  const { t, app } = setup();
  const item = addItem(t.db, { title: "x" });
  const before = snapshot(t.db);
  const writes = () => ({ ignores: count(t.db, "cleanup_ignores"), filters: count(t.db, "cleanup_saved_filters") });
  const w0 = writes();

  for (const url of ["/api/cleanup/todos", "/api/cleanup/ignores"]) {
    const r = await app.inject({ method: "GET", url });
    assert.equal(r.statusCode, 400);
    assert.equal(json(r).error.code, "INVALID_INPUT");
    assert.equal(json(r).error.details.code, "LOCAL_POLICY_REQUIRED");
  }

  const post = await app.inject({ method: "POST", url: "/api/cleanup/filters", payload: { name: "f", filter: { rule: "missing_cover" } } });
  assert.equal(post.statusCode, 400);
  assert.equal(json(post).error.details.code, "LOCAL_POLICY_REQUIRED");

  const patch = await app.inject({ method: "PATCH", url: "/api/cleanup/filters/1", payload: { filter: { rule: "missing_cover" }, expectedVersion: 1 } });
  assert.equal(patch.statusCode, 400);
  assert.equal(json(patch).error.details.code, "LOCAL_POLICY_REQUIRED");

  const bogus = await app.inject({ method: "GET", url: "/api/cleanup/todos?localSourcePolicy=bogus" });
  assert.equal(bogus.statusCode, 400);
  assert.equal(json(bogus).error.details.code, "LOCAL_POLICY_REQUIRED");

  assert.deepEqual(writes(), w0);
  assert.deepEqual(snapshot(t.db), before);

  const ok = await app.inject({ method: "GET", url: "/api/cleanup/todos?localSourcePolicy=include_local" });
  assert.equal(ok.statusCode, 200);
  const body = json(ok);
  assert.ok(Array.isArray(body.items));
  assert.equal(body.total, 3); // missing_cover + missing_source + unlinked_model
  assert.equal(body.counts.total, 3);
  assert.equal(body.items[0].item.id, item);
  t.close();
});

test("两策略正反例：local 条目进/不进 missing_source，resolved 随策略变化", async () => {
  const { t, app } = setup();
  const av = addAvatar(t.db, "A");
  const local = addItem(t.db, { title: "local", source_site: "local", source_url: null });
  addImage(t.db, local); linkAvatar(t.db, local, av);
  const booth = addItem(t.db, { title: "booth", source_site: "booth", source_url: null });
  addImage(t.db, booth); linkAvatar(t.db, booth, av);
  const clean = addItem(t.db, { title: "clean", source_site: "booth", source_url: "https://example.test/x" });
  addImage(t.db, clean); linkAvatar(t.db, clean, av);

  const exc = json(await app.inject({ method: "GET", url: "/api/cleanup/todos?localSourcePolicy=exclude_local" }));
  assert.equal(exc.total, 1);
  assert.equal(exc.counts.missing_source.total, 1);
  assert.equal(exc.counts.missing_source.localExcluded, 1);
  assert.equal(exc.items[0].item.id, booth);

  const inc = json(await app.inject({ method: "GET", url: "/api/cleanup/todos?localSourcePolicy=include_local" }));
  assert.equal(inc.total, 2);
  assert.equal(inc.counts.missing_source.total, 2);
  assert.equal(inc.counts.missing_source.localExcluded, 0);

  const ignored = await app.inject({ method: "POST", url: "/api/cleanup/ignore", payload: { itemId: local, rule: "missing_source" } });
  assert.equal(ignored.statusCode, 200);
  assert.equal(json(ignored).ignore.itemId, local);
  assert.equal(json(ignored).ignore.resolved, false); // POST 视图按 include_local 求值

  const excIgnores = json(await app.inject({ method: "GET", url: "/api/cleanup/ignores?localSourcePolicy=exclude_local" }));
  assert.equal(excIgnores.total, 1);
  assert.equal(excIgnores.ignores[0].resolved, true);
  const incIgnores = json(await app.inject({ method: "GET", url: "/api/cleanup/ignores?localSourcePolicy=include_local" }));
  assert.equal(incIgnores.ignores[0].resolved, false);

  const onlyInc = json(await app.inject({ method: "GET", url: "/api/cleanup/todos?localSourcePolicy=include_local&ignored=only" }));
  assert.equal(onlyInc.total, 1);
  assert.equal(onlyInc.items[0].resolved, false);
  assert.equal(onlyInc.items[0].ignored, true);
  const onlyExc = json(await app.inject({ method: "GET", url: "/api/cleanup/todos?localSourcePolicy=exclude_local&ignored=only" }));
  assert.equal(onlyExc.total, 1);
  assert.equal(onlyExc.items[0].resolved, true);

  const hide = json(await app.inject({ method: "GET", url: "/api/cleanup/todos?localSourcePolicy=include_local" }));
  assert.equal(hide.total, 1);
  assert.equal(hide.items[0].item.id, booth);
  const show = json(await app.inject({ method: "GET", url: "/api/cleanup/todos?localSourcePolicy=include_local&ignored=show" }));
  assert.equal(show.total, 2);
  assert.equal(show.items.some((r: any) => r.item.id === local && r.ignored === true), true);
  t.close();
});

test("忽略/恢复幂等；归档条目在管理可见、todos only 不可见；物料零写", async () => {
  const { t, app } = setup();
  const av = addAvatar(t.db, "A");
  const item = addItem(t.db, { title: "coverless", source_url: "https://example.test/a" });
  linkAvatar(t.db, item, av);
  const archived = addItem(t.db, { title: "archived", status: "archived", source_url: "https://example.test/b" });
  linkAvatar(t.db, archived, av);
  const before = snapshot(t.db);

  const first = await app.inject({ method: "POST", url: "/api/cleanup/ignore", payload: { itemId: item, rule: "missing_cover", note: "n1" } });
  assert.equal(first.statusCode, 200);
  assert.equal(json(first).ignore.note, "n1");
  assert.equal(json(first).ignore.resolved, false);
  assert.equal(count(t.db, "cleanup_ignores"), 1);

  const second = await app.inject({ method: "POST", url: "/api/cleanup/ignore", payload: { itemId: item, rule: "missing_cover", note: "n2" } });
  assert.equal(second.statusCode, 200);
  assert.equal(json(second).ignore.note, "n2");
  assert.equal(count(t.db, "cleanup_ignores"), 1);

  const hide = json(await app.inject({ method: "GET", url: "/api/cleanup/todos?localSourcePolicy=include_local" }));
  assert.equal(hide.total, 0);
  const show = json(await app.inject({ method: "GET", url: "/api/cleanup/todos?localSourcePolicy=include_local&ignored=show" }));
  assert.equal(show.total, 1);
  assert.equal(show.items[0].ignored, true);
  const only = json(await app.inject({ method: "GET", url: "/api/cleanup/todos?localSourcePolicy=include_local&ignored=only" }));
  assert.equal(only.total, 1);
  assert.equal(only.items[0].resolved, false);

  const arch = await app.inject({ method: "POST", url: "/api/cleanup/ignore", payload: { itemId: archived, rule: "missing_cover" } });
  assert.equal(arch.statusCode, 200);
  const ignores = json(await app.inject({ method: "GET", url: "/api/cleanup/ignores?localSourcePolicy=include_local" }));
  assert.equal(ignores.total, 2);
  assert.equal(ignores.ignores.some((r: any) => r.itemId === archived && r.item.status === "archived"), true);
  const only2 = json(await app.inject({ method: "GET", url: "/api/cleanup/todos?localSourcePolicy=include_local&ignored=only" }));
  assert.equal(only2.total, 1);
  assert.equal(only2.items[0].item.id, item);

  const del1 = await app.inject({ method: "DELETE", url: "/api/cleanup/ignore/" + item + "/missing_cover" });
  assert.equal(del1.statusCode, 200);
  assert.deepEqual(json(del1), { removed: 1 });
  const del2 = await app.inject({ method: "DELETE", url: "/api/cleanup/ignore/" + item + "/missing_cover" });
  assert.deepEqual(json(del2), { removed: 0 });

  assert.deepEqual(snapshot(t.db), before);
  const back = json(await app.inject({ method: "GET", url: "/api/cleanup/todos?localSourcePolicy=include_local" }));
  assert.equal(back.total, 1);
  assert.equal(back.items[0].item.id, item);
  t.close();
});

test("保存筛选 CRUD/CAS/非法字段；name-only PATCH 不要求策略，替换 filter 缺策略 400", async () => {
  const { t, app } = setup();
  const created = await app.inject({ method: "POST", url: "/api/cleanup/filters", payload: { name: "f1", filter: { localSourcePolicy: "include_local", rule: "missing_cover", q: "ab" } } });
  assert.equal(created.statusCode, 201);
  const f = json(created).filter;
  assert.equal(f.name, "f1");
  assert.equal(f.version, 1);
  assert.equal(f.filter.localSourcePolicy, "include_local");
  assert.equal(f.filter.rule, "missing_cover");
  assert.equal(f.filter.q, "ab");
  assert.equal(typeof f.createdAt, "string");

  const dup = await app.inject({ method: "POST", url: "/api/cleanup/filters", payload: { name: "f1", filter: { localSourcePolicy: "include_local" } } });
  assert.equal(dup.statusCode, 409);
  assert.equal(json(dup).error.code, "CONFLICT");

  const badFilters = [
    { localSourcePolicy: "include_local", includeArchived: true },
    { localSourcePolicy: "include_local", includeTrashed: true },
    { localSourcePolicy: "include_local", rule: "bogus" },
    { localSourcePolicy: "include_local", limit: 201 },
    { localSourcePolicy: "include_local", avatarIds: [1, "2"] },
  ];
  for (let i = 0; i < badFilters.length; i++) {
    const r = await app.inject({ method: "POST", url: "/api/cleanup/filters", payload: { name: "bad-" + i, filter: badFilters[i] } });
    assert.equal(r.statusCode, 400);
    assert.equal(json(r).error.code, "INVALID_INPUT");
  }

  const list = json(await app.inject({ method: "GET", url: "/api/cleanup/filters" }));
  assert.equal(list.filters.length, 1);
  assert.equal(list.filters[0].id, f.id);

  const renamed = await app.inject({ method: "PATCH", url: "/api/cleanup/filters/" + f.id, payload: { name: "f2", expectedVersion: 1 } });
  assert.equal(renamed.statusCode, 200);
  assert.equal(json(renamed).filter.name, "f2");
  assert.equal(json(renamed).filter.version, 2);
  assert.equal(json(renamed).filter.filter.rule, "missing_cover");

  const replaced = await app.inject({ method: "PATCH", url: "/api/cleanup/filters/" + f.id, payload: { filter: { localSourcePolicy: "exclude_local" }, expectedVersion: 2 } });
  assert.equal(replaced.statusCode, 200);
  assert.equal(json(replaced).filter.version, 3);
  assert.equal(json(replaced).filter.filter.localSourcePolicy, "exclude_local");
  assert.equal(json(replaced).filter.filter.rule, undefined);

  const noPolicy = await app.inject({ method: "PATCH", url: "/api/cleanup/filters/" + f.id, payload: { filter: { rule: "missing_cover" }, expectedVersion: 3 } });
  assert.equal(noPolicy.statusCode, 400);
  assert.equal(json(noPolicy).error.details.code, "LOCAL_POLICY_REQUIRED");

  const stale = await app.inject({ method: "PATCH", url: "/api/cleanup/filters/" + f.id, payload: { name: "f3", expectedVersion: 1 } });
  assert.equal(stale.statusCode, 409);
  assert.equal(json(stale).error.code, "CONFLICT");

  const missing = await app.inject({ method: "PATCH", url: "/api/cleanup/filters/999", payload: { name: "x", expectedVersion: 1 } });
  assert.equal(missing.statusCode, 404);

  const del1 = await app.inject({ method: "DELETE", url: "/api/cleanup/filters/" + f.id });
  assert.deepEqual(json(del1), { deleted: 1 });
  const del2 = await app.inject({ method: "DELETE", url: "/api/cleanup/filters/" + f.id });
  assert.deepEqual(json(del2), { deleted: 0 });
  assert.equal(json(await app.inject({ method: "GET", url: "/api/cleanup/filters" })).filters.length, 0);
  t.close();
});

test("真实 query 与 DTO：rule/q/avatar/category/sort/limit/offset，GET 纯读", async () => {
  const { t, app } = setup();
  const av1 = addAvatar(t.db, "A1");
  const av2 = addAvatar(t.db, "A2");
  const root = addRoot(t.db, "/lib");
  const i1 = addItem(t.db, { title: "Alpha skirt", source_url: "https://example.test/1", cat_id: "clothing", cat_sub_id: "clothing.tops" });
  linkAvatar(t.db, i1, av1);
  const i2 = addItem(t.db, { title: "Beta shoes", source_url: "https://example.test/2", cat_id: "shoes" });
  linkAvatar(t.db, i2, av2);
  const i3 = addItem(t.db, { title: "Gamma hat", source_url: "https://example.test/3", cat_id: "clothing" });
  linkAvatar(t.db, i3, av1);
  const i4 = addItem(t.db, { title: "Delta file", source_url: "https://example.test/4" });
  addImage(t.db, i4); linkAvatar(t.db, i4, av1);
  addAsset(t.db, i4, root, "/lib/delta.zip", { status: "missing" });

  const before = snapshot(t.db);
  const all = json(await app.inject({ method: "GET", url: "/api/cleanup/todos?localSourcePolicy=include_local&rule=missing_cover&sort=title&limit=2&offset=0" }));
  assert.equal(all.total, 3);
  assert.equal(all.items.length, 2);
  assert.equal(all.items[0].item.title, "Alpha skirt");
  assert.equal(all.items[1].item.title, "Beta shoes");
  assert.equal(all.items[0].rule, "missing_cover");
  assert.equal(all.items[0].ignored, false);
  assert.equal(all.items[0].resolved, null);
  assert.equal(all.items[0].evidence.imageCount, 0);
  assert.equal(all.items[0].item.id, i1);
  assert.equal(all.items[0].item.coverUrl, null);
  assert.equal(all.items[0].item.imageCount, 0);
  assert.equal(all.items[0].item.status, "inbox");
  assert.equal(all.counts.missing_cover.total, 3);
  assert.equal(all.counts.total, 4); // counts 不受 rule 过滤：3 missing_cover + 1 missing_file

  const page2 = json(await app.inject({ method: "GET", url: "/api/cleanup/todos?localSourcePolicy=include_local&rule=missing_cover&sort=title&limit=2&offset=2" }));
  assert.equal(page2.items.length, 1);
  assert.equal(page2.items[0].item.title, "Gamma hat");

  const byAvatar = json(await app.inject({ method: "GET", url: "/api/cleanup/todos?localSourcePolicy=include_local&rule=missing_cover&avatar=" + av1 }));
  assert.equal(byAvatar.total, 2);
  assert.deepEqual(byAvatar.items.map((r: any) => r.item.id).sort(), [i1, i3].sort());

  const byCategory = json(await app.inject({ method: "GET", url: "/api/cleanup/todos?localSourcePolicy=include_local&rule=missing_cover&category=clothing" }));
  assert.equal(byCategory.total, 2);

  const byQ = json(await app.inject({ method: "GET", url: "/api/cleanup/todos?localSourcePolicy=include_local&rule=missing_cover&q=Al" }));
  assert.equal(byQ.total, 1);
  assert.equal(byQ.items[0].item.id, i1);

  const injection = json(await app.inject({ method: "GET", url: "/api/cleanup/todos?localSourcePolicy=include_local&q=" + encodeURIComponent("' OR 1=1 --") }));
  assert.equal(injection.total, 0);

  const missingFile = json(await app.inject({ method: "GET", url: "/api/cleanup/todos?localSourcePolicy=include_local&rule=missing_file" }));
  assert.equal(missingFile.total, 1);
  assert.equal(missingFile.items[0].item.id, i4);
  assert.equal(missingFile.items[0].evidence.missingAssetCount, 1);

  for (const url of [
    "/api/cleanup/todos?localSourcePolicy=include_local&rule=bogus",
    "/api/cleanup/todos?localSourcePolicy=include_local&ignored=bogus",
    "/api/cleanup/todos?localSourcePolicy=include_local&sort=bogus",
    "/api/cleanup/todos?localSourcePolicy=include_local&limit=abc",
  ]) {
    const r = await app.inject({ method: "GET", url });
    assert.equal(r.statusCode, 400);
    assert.equal(json(r).error.code, "INVALID_INPUT");
  }

  assert.deepEqual(snapshot(t.db), before);
  t.close();
});
