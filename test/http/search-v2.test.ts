import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { addAsset, addRoot, NOW, openTempDb } from "../schema/_db";
import { Repo } from "../../apps/server/src/db/repo";
import { migrate, SCHEMA_VERSION } from "../../apps/server/src/db/migrate";
import { registerRoutes } from "../../apps/server/src/http/routes";
import { resolveLimits } from "../../apps/server/src/services/pipeline/limits";
import { drainSearchIndex, enqueueSearchBackfill, searchIndexStatus } from "../../apps/server/src/services/search-index";
import { parseSearchQuery } from "../../packages/core/src/search-query";

test("search parser preserves residual text, scoped negatives, and quoted values", () => {
  const parsed = parseSearchQuery('Manuka 黑色哥特长裙 未知词 -type:shoes author:"Foo Studio" size:50MB..1GB');
  assert.deepEqual(parsed.terms.map((v) => v.text), ["manuka", "黑色", "哥特", "长裙", "未知词"]);
  assert.deepEqual(parsed.filters.map(({ field, value, exclude }) => [field, value, exclude]), [
    ["type", "shoes", true], ["author", "foo studio", false], ["size", "50mb..1gb", false],
  ]);
  const clauses = parseSearchQuery("支持多个 Avatar 的衣服 超过 1GB 的素材");
  assert.deepEqual(clauses.filters.map((v) => [v.field, v.value]), [["size", ">1GB"], ["supports", "multiple"]]);
  assert.ok(clauses.terms.some((v) => v.text === "衣服"));
  assert.equal(parseSearchQuery("https://example-shop.booth.pm/items/1234567").exactId, "1234567");
  for (const invalid of ['"incomplete', "badfield:value", "size:1VB", "added:2026-02-31", "color:", "foo\u0000bar"]) {
    assert.throws(() => parseSearchQuery(invalid), { code: "INVALID_INPUT" });
  }
});

test("search migration, ranked recall, facets, deep evidence, and incremental update", async (t) => {
  const temp = openTempDb();
  const { db } = temp;
  migrate(db);
  const repo = new Repo(db);
  const app = Fastify();
  registerRoutes(app, {
    repo, media: {} as never, booth: {} as never, runner: {} as never,
    version: "test", dbPath: temp.file, dataDir: temp.dir, log: () => {}, limits: resolveLimits({}),
  });
  t.after(async () => { await app.close(); temp.close(); });
  const root = addRoot(db, "/fixture");
  const manuka = repo.createAvatar({ name: "Manuka", aliases: ["マヌカ"] });
  const kikyo = repo.createAvatar({ name: "Kikyo", aliases: ["桔梗"] });
  const dress = repo.createItem({ title: "Nocturne ワンピース", description: "夜の衣装", source_site: "booth", source_item_id: "2222221", status: "active" });
  const shoes = repo.createItem({ title: "Nocturne Boots", source_site: "booth", source_item_id: "2222222", status: "active" });
  const audio = repo.createItem({ title: "星空のなでなで サウンドシステム", source_site: "booth", source_item_id: "2222223", status: "active" });
  const hair = repo.createItem({ title: "夜明けのロングヘア", status: "active" });
  const makeup = repo.createItem({ title: "Quiet Harbor メイク", status: "active" });
  repo.setItemCategory(dress.id, { categoryId: "clothing.dress", source: "manual" });
  repo.setItemCategory(shoes.id, { categoryId: "clothing.shoes_socks", source: "manual" });
  repo.setItemCategory(audio.id, { categoryId: "audio.sfx", source: "manual" });
  repo.setItemCategory(hair.id, { categoryId: "hair.long", source: "manual" });
  repo.setItemTags(dress.id, ["黑色", "ゴシック"], "manual");
  repo.setItemAvatars(dress.id, [manuka.id], "manual");
  repo.setItemAvatars(shoes.id, [manuka.id], "auto");
  repo.setItemAvatars(hair.id, [kikyo.id], "manual");
  repo.setItemAvatars(makeup.id, [manuka.id], "manual");
  const fullPath = "/fixture/Nocturne_Manuka.zip";
  const asset = addAsset(db, dress.id, root, fullPath.toLowerCase(), { path: fullPath, size: 2_400_000_000, index_state: "done" });
  const entry = db.prepare("INSERT INTO archive_entries(asset_id,entry_path,entry_size,is_dir,ext) VALUES (?,?,64,0,?)");
  entry.run(asset, "Assets/Clothing/StarRibbon.fbx", "fbx");
  db.prepare("INSERT INTO unitypackage_assets(asset_id,guid,asset_path,type) VALUES (?,'b','Assets/Meshes/NocturneBeauty.mat','Material')").run(asset);

  db.prepare("UPDATE schema_meta SET value='10' WHERE key='version'").run();
  migrate(db);
  assert.equal(db.prepare("SELECT value FROM schema_meta WHERE key='version'").pluck().get(), String(SCHEMA_VERSION));
  enqueueSearchBackfill(db);
  while (drainSearchIndex(db)) { /* Fixture-only synchronous drain. */ }
  assert.deepEqual(searchIndexStatus(db), { version: 1, lexiconVersion: 1, total: 5, indexed: 5, pending: 0, failed: 0,
    contentPending: 0, contentFailed: 0, contentLimited: 0, pathLimitedItems: 0 });
  const ids = (q: string) => repo.listItems({ q, limit: 60, searchDebug: true }).items.map((i) => i.id);
  assert.deepEqual(ids("2222221"), [dress.id]);
  assert.equal(ids("Ｎｏｃｔｕｒｎｅ ワンピース")[0], dress.id);
  assert.deepEqual(ids("黑色"), [dress.id]);
  assert.deepEqual(ids("桔梗长发"), [hair.id]);
  assert.deepEqual(ids("long hair"), [hair.id]);
  assert.deepEqual(ids("玛努卡 妆容"), [makeup.id]);
  assert.deepEqual(ids("抚摸音效插件"), [audio.id]);
  assert.equal(ids("noctune")[0], shoes.id);
  assert.deepEqual(ids("avatar:manuka type:clothes -type:shoes size:>1GB"), [dress.id]);
  assert.deepEqual(ids("超过 1GB 的素材"), [dress.id]);
  assert.deepEqual(ids("file:*.fbx"), [dress.id]);
  assert.deepEqual(ids("file:StarRibbon.fbx"), [dress.id]);
  assert.deepEqual(ids(fullPath), [dress.id]);
  assert.equal(repo.listItems({ q: "file:NocturneBeauty.mat" }).items[0]?.search?.paths?.[0]?.kind, "unitypackage");
  assert.equal(repo.listItems({ q: "Nocturne", limit: 1, offset: 1 }).items[0]?.id, ids("Nocturne")[1]);
  assert.deepEqual(ids("' OR 1=1 --"), []);
  assert.equal((await app.inject("/api/items?q=" + encodeURIComponent('size:"bad"'))).statusCode, 400);
  const facet = await app.inject("/api/search/facets?dimension=avatar&q=" + encodeURIComponent("avatar:kikyo type:clothes"));
  assert.equal(facet.statusCode, 200, facet.body);
  assert.deepEqual(facet.json().options, [{ value: "Manuka", count: 2 }]);
  const colors = await app.inject("/api/search/facets?dimension=color");
  assert.equal(colors.statusCode, 200, colors.body);
  assert.deepEqual(colors.json().options, [{ value: "black", count: 1 }]);
  const formats = await app.inject("/api/search/facets?dimension=format");
  assert.equal(formats.statusCode, 200, formats.body);
  assert.ok(formats.json().options.some((v: { value: string; count: number }) => v.value === "fbx" && v.count === 1));
  const debug = await app.inject("/api/items?q=Nocturne&debug=1");
  assert.equal(debug.statusCode, 200, debug.body);
  assert.equal(debug.json().items[0].search.contributions[0].term, "nocturne");
  assert.ok(debug.json().items[0].search.contributions[0].channels.includes("title"));
  const relaxed = await app.inject("/api/search/alternatives?q=" + encodeURIComponent("avatar:kikyo type:clothes"));
  assert.equal(relaxed.statusCode, 200, relaxed.body);
  assert.deepEqual(relaxed.json().relaxations, [{ query: "avatar:kikyo", removed: "type:clothes", count: 1 }]);
  enqueueSearchBackfill(db, true);
  assert.deepEqual(ids("抚摸音效插件"), [audio.id]);
  while (drainSearchIndex(db)) { /* Preserve the same visible rows through rebuild. */ }
  repo.setItemTags(dress.id, ["银色"], "manual");
  assert.deepEqual(ids("黑色"), []);
  assert.deepEqual(ids("银色"), [dress.id]);
  db.prepare("UPDATE archive_entries SET entry_path='Assets/Clothing/MoonRibbon.fbx' WHERE asset_id=?").run(asset);
  while (drainSearchIndex(db)) { /* Reindex DB metadata only. */ }
  assert.deepEqual(ids("StarRibbon"), []);
  assert.deepEqual(ids("MoonRibbon"), [dress.id]);
  assert.equal(repo.itemRow(dress.id).cat_source, "manual");
  assert.equal(repo.listItemAvatars(dress.id)[0]?.source, "manual");
  assert.equal(db.pragma("quick_check", { simple: true }), "ok");
  const control = await app.inject({ method: "POST", url: "/api/search/index", payload: { action: "rebuild" } });
  assert.equal(control.statusCode, 200, control.body);
  assert.equal(repo.getJob(control.json().jobId)?.created_at.length! >= NOW.length, true);
  const cancel = await app.inject({ method: "POST", url: "/api/search/index", payload: { action: "cancel-rebuild" } });
  assert.equal(cancel.statusCode, 200, cancel.body);
  assert.equal(repo.getJob(control.json().jobId)?.state, "cancelled");
});
