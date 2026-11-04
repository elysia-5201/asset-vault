/**
 * 清单 HTTP 端点（avatar-loadouts spec §6.1/§6.2/§6.3）。
 *
 * 真实 Fastify.inject + 真实临时 SQLite（schema.sql 建库），不 listen、不碰生产库/7317。
 * 断言真实值：卡片标题/封面/证据/手动 state/version/CAS 子码，不只 statusCode。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { openTempDb, addItem, addAvatar, addImage, count, type TempDb } from "../schema/_db";
import { Repo } from "../../apps/server/src/db/repo";
import { registerLoadoutRoutes } from "../../apps/server/src/http/routes/loadouts";

function setup(t: TempDb) {
  const repo = new Repo(t.db);
  const app = Fastify({ logger: false });
  registerLoadoutRoutes(app, { repo, log: () => {} });
  return { repo, app };
}

const json = (r: { body: string }): any => JSON.parse(r.body);

test("创建/列表/详情/改名/删除：真实 HTTP + 真实卡片", async () => {
  const t = openTempDb();
  const { app } = setup(t);
  const av = addAvatar(t.db, "A");
  const i1 = addItem(t.db, { title: "裙子" });
  const i2 = addItem(t.db, { title: "鞋子" });

  const created = await app.inject({ method: "POST", url: "/api/avatars/" + av + "/loadouts", payload: { name: "日常", note: "备注" } });
  assert.equal(created.statusCode, 201);
  const L = json(created).loadout;
  assert.equal(L.avatarId, av);
  assert.equal(L.name, "日常");
  assert.equal(L.note, "备注");
  assert.equal(L.sort, 0);
  assert.equal(L.version, 1);
  assert.equal(L.itemCount, 0);
  assert.deepEqual(L.stateCounts, { planned: 0, imported: 0, verified: 0 });
  assert.equal(L.trashedCount, 0);
  assert.equal(typeof L.createdAt, "string");
  assert.equal(typeof L.updatedAt, "string");

  const dup = await app.inject({ method: "POST", url: "/api/avatars/" + av + "/loadouts", payload: { name: "日常" } });
  assert.equal(dup.statusCode, 409);
  assert.equal(json(dup).error.code, "CONFLICT");
  assert.equal(json(dup).error.details.code, "LOADOUT_NAME_TAKEN");

  const empty = await app.inject({ method: "POST", url: "/api/avatars/" + av + "/loadouts", payload: { name: "   " } });
  assert.equal(empty.statusCode, 400);
  assert.equal(json(empty).error.code, "INVALID_INPUT");

  const list = await app.inject({ method: "GET", url: "/api/avatars/" + av + "/loadouts" });
  assert.equal(list.statusCode, 200);
  assert.equal(json(list).loadouts.length, 1);
  assert.equal(json(list).loadouts[0].id, L.id);
  assert.equal(json(list).loadouts[0].itemCount, 0);

  const added = await app.inject({ method: "POST", url: "/api/loadouts/" + L.id + "/items", payload: { itemIds: [i1, i2] } });
  assert.equal(added.statusCode, 200);
  const addBody = json(added);
  assert.equal(addBody.added, 2);
  assert.equal(addBody.revived, 0);
  assert.equal(addBody.existing, 0);
  assert.equal(addBody.items.length, 2);
  assert.equal(addBody.items[0].itemId, i1);
  assert.equal(addBody.items[0].item.id, i1);
  assert.equal(addBody.items[0].item.title, "裙子");
  assert.equal(addBody.items[0].state, "planned");
  assert.equal(addBody.items[0].version, 1);
  assert.equal(addBody.items[0].position, 0);
  assert.deepEqual(addBody.items[0].evidence, {
    registered: false, referenced: false, verified: false,
    registeredAt: null, referencedAt: null, verifiedAt: null,
  });

  const detail = await app.inject({ method: "GET", url: "/api/loadouts/" + L.id });
  assert.equal(detail.statusCode, 200);
  const D = json(detail);
  assert.equal(D.total, 2);
  assert.equal(D.items.length, 2);
  assert.equal(D.items[0].item.title, "裙子");
  assert.equal(D.items[1].item.title, "鞋子");
  assert.deepEqual(D.stateCounts, { planned: 2, imported: 0, verified: 0 });
  assert.deepEqual(D.visibleStateCounts, { planned: 2, imported: 0, verified: 0 });
  assert.equal(D.trashedCount, 0);
  assert.equal(D.loadout.itemCount, 2);
  assert.equal(D.loadout.version, 1);

  const patched = await app.inject({ method: "PATCH", url: "/api/loadouts/" + L.id, payload: { name: "日常2", expectedVersion: 1 } });
  assert.equal(patched.statusCode, 200);
  assert.equal(json(patched).loadout.name, "日常2");
  assert.equal(json(patched).loadout.version, 2);
  assert.equal(json(patched).loadout.itemCount, 2);

  const stale = await app.inject({ method: "PATCH", url: "/api/loadouts/" + L.id, payload: { name: "日常3", expectedVersion: 1 } });
  assert.equal(stale.statusCode, 409);
  assert.equal(json(stale).error.details.code, "LOADOUT_VERSION_CONFLICT");

  const itemsBefore = count(t.db, "items");
  const del = await app.inject({ method: "DELETE", url: "/api/loadouts/" + L.id });
  assert.equal(del.statusCode, 200);
  assert.deepEqual(json(del), { deleted: true });
  assert.equal(count(t.db, "items"), itemsBefore);
  assert.equal(count(t.db, "loadout_items", "loadout_id=?", L.id), 0);
  assert.equal((await app.inject({ method: "GET", url: "/api/loadouts/" + L.id })).statusCode, 404);
  t.close();
});

test("成员：添加幂等/手动状态/CAS/墓碑/重排", async () => {
  const t = openTempDb();
  const { app } = setup(t);
  const av = addAvatar(t.db, "A");
  const i1 = addItem(t.db, { title: "i1" });
  const i2 = addItem(t.db, { title: "i2" });
  const i3 = addItem(t.db, { title: "i3" });
  const L = json(await app.inject({ method: "POST", url: "/api/avatars/" + av + "/loadouts", payload: { name: "L" } })).loadout;

  const first = json(await app.inject({ method: "POST", url: "/api/loadouts/" + L.id + "/items", payload: { itemIds: [i1, i2, i3] } }));
  assert.equal(first.added, 3);
  assert.deepEqual(first.items.map((r: any) => r.itemId), [i1, i2, i3]);
  // T1 冻结行为：新行 position 一律 0，顺序由 (position, item_id) 兜底（spec §6.1 排序键）。
  assert.deepEqual(first.items.map((r: any) => r.position), [0, 0, 0]);

  // 幂等：已有活跃行不覆盖 state/note/position（Ruling20）
  const again = json(await app.inject({ method: "POST", url: "/api/loadouts/" + L.id + "/items", payload: { itemIds: [i1], state: "verified" } }));
  assert.equal(again.added, 0);
  assert.equal(again.existing, 1);
  assert.equal(again.items[0].state, "planned");
  assert.equal(again.items[0].version, 1);

  const p1 = await app.inject({ method: "PATCH", url: "/api/loadouts/" + L.id + "/items/" + i1, payload: { state: "verified", expectedVersion: 1 } });
  assert.equal(p1.statusCode, 200);
  assert.equal(json(p1).item.state, "verified");
  assert.equal(json(p1).item.version, 2);
  assert.equal(json(p1).item.item.title, "i1");

  const stale = await app.inject({ method: "PATCH", url: "/api/loadouts/" + L.id + "/items/" + i1, payload: { state: "planned", expectedVersion: 1 } });
  assert.equal(stale.statusCode, 409);
  assert.equal(json(stale).error.details.code, "LOADOUT_ITEM_VERSION_CONFLICT");

  const noted = await app.inject({ method: "PATCH", url: "/api/loadouts/" + L.id + "/items/" + i1, payload: { note: "手动备注", expectedVersion: 2 } });
  assert.equal(json(noted).item.note, "手动备注");
  assert.equal(json(noted).item.version, 3);

  const cleared = await app.inject({ method: "PATCH", url: "/api/loadouts/" + L.id + "/items/" + i1, payload: { note: null, expectedVersion: 3 } });
  assert.equal(json(cleared).item.note, null);
  assert.equal(json(cleared).item.version, 4);

  const badState = await app.inject({ method: "PATCH", url: "/api/loadouts/" + L.id + "/items/" + i1, payload: { state: "done", expectedVersion: 4 } });
  assert.equal(badState.statusCode, 400);

  const missingItem = await app.inject({ method: "PATCH", url: "/api/loadouts/" + L.id + "/items/9999", payload: { state: "planned", expectedVersion: 1 } });
  assert.equal(missingItem.statusCode, 404);

  const removed = await app.inject({ method: "DELETE", url: "/api/loadouts/" + L.id + "/items/" + i1 });
  assert.equal(removed.statusCode, 200);
  assert.deepEqual(json(removed), { removed: 1 });
  const versionOf = () => Number((t.db.prepare("SELECT version FROM loadout_items WHERE loadout_id=? AND item_id=?").get(L.id, i1) as any).version);
  assert.equal(versionOf(), 5);
  const removedAgain = await app.inject({ method: "DELETE", url: "/api/loadouts/" + L.id + "/items/" + i1 });
  assert.deepEqual(json(removedAgain), { removed: 0 });
  assert.equal(versionOf(), 5);

  const removedMissing = await app.inject({ method: "DELETE", url: "/api/loadouts/" + L.id + "/items/9999" });
  assert.equal(removedMissing.statusCode, 404);

  const reordered = await app.inject({ method: "POST", url: "/api/loadouts/" + L.id + "/items/reorder", payload: { itemIds: [i3, i2] } });
  assert.equal(reordered.statusCode, 200);
  assert.deepEqual(json(reordered).items.map((r: any) => r.itemId), [i3, i2]);
  assert.deepEqual(json(reordered).items.map((r: any) => r.position), [0, 1]);

  const badShape = await app.inject({ method: "POST", url: "/api/loadouts/" + L.id + "/items/reorder", payload: { itemIds: [i3] } });
  assert.equal(badShape.statusCode, 400);
  const tombstoneShape = await app.inject({ method: "POST", url: "/api/loadouts/" + L.id + "/items/reorder", payload: { itemIds: [i3, i2, i1] } });
  assert.equal(tombstoneShape.statusCode, 400);
  t.close();
});

test("GET 纯读 + 三口径计数 + includeTrashedItems/state/limit", async () => {
  const t = openTempDb();
  const { app } = setup(t);
  const av = addAvatar(t.db, "A");
  const i1 = addItem(t.db, { title: "可见" });
  const i2 = addItem(t.db, { title: "回收站" });
  const L = json(await app.inject({ method: "POST", url: "/api/avatars/" + av + "/loadouts", payload: { name: "L" } })).loadout;
  await app.inject({ method: "POST", url: "/api/loadouts/" + L.id + "/items", payload: { itemIds: [i1, i2] } });
  t.db.prepare("UPDATE items SET status='trashed' WHERE id=?").run(i2);

  const auditBefore = count(t.db, "audit_log");
  const rowsSql = "SELECT loadout_id,item_id,state,note,position,version,updated_at FROM loadout_items ORDER BY item_id";
  const rowsBefore = t.db.prepare(rowsSql).all();
  const loadoutBefore = t.db.prepare("SELECT * FROM loadouts WHERE id=?").get(L.id);

  const def = json(await app.inject({ method: "GET", url: "/api/loadouts/" + L.id }));
  assert.equal(def.total, 1);
  assert.equal(def.items.length, 1);
  assert.equal(def.items[0].itemId, i1);
  assert.deepEqual(def.stateCounts, { planned: 2, imported: 0, verified: 0 });
  assert.deepEqual(def.visibleStateCounts, { planned: 1, imported: 0, verified: 0 });
  assert.equal(def.trashedCount, 1);
  assert.equal(def.loadout.itemCount, 2);

  const withTrashed = json(await app.inject({ method: "GET", url: "/api/loadouts/" + L.id + "?includeTrashedItems=1" }));
  assert.equal(withTrashed.total, 2);
  assert.equal(withTrashed.items.length, 2);
  assert.equal(withTrashed.items[1].item.title, "回收站");

  const filtered = json(await app.inject({ method: "GET", url: "/api/loadouts/" + L.id + "?state=planned&limit=1" }));
  assert.equal(filtered.total, 1);
  assert.equal(filtered.items.length, 1);

  const paged = json(await app.inject({ method: "GET", url: "/api/loadouts/" + L.id + "?includeTrashedItems=1&limit=1&offset=1" }));
  assert.equal(paged.total, 2);
  assert.equal(paged.items.length, 1);
  assert.equal(paged.items[0].itemId, i2);

  assert.equal((await app.inject({ method: "GET", url: "/api/loadouts/" + L.id + "?state=done" })).statusCode, 400);
  assert.equal((await app.inject({ method: "GET", url: "/api/loadouts/" + L.id + "?limit=abc" })).statusCode, 400);
  assert.equal((await app.inject({ method: "GET", url: "/api/loadouts/" + L.id + "?limit=0" })).statusCode, 400);
  assert.equal((await app.inject({ method: "GET", url: "/api/loadouts/" + L.id + "?includeTrashedItems=2" })).statusCode, 400);

  // 纯读：GET 不写库（审计/行/清单版本都不变）
  assert.equal(count(t.db, "audit_log"), auditBefore);
  assert.deepEqual(t.db.prepare(rowsSql).all(), rowsBefore);
  assert.deepEqual(t.db.prepare("SELECT * FROM loadouts WHERE id=?").get(L.id), loadoutBefore);
  t.close();
});

test("缺失实体与非法参数：400/404 且零业务写", async () => {
  const t = openTempDb();
  const { app } = setup(t);
  const av = addAvatar(t.db, "A");
  const i1 = addItem(t.db, { title: "i1" });
  const L = json(await app.inject({ method: "POST", url: "/api/avatars/" + av + "/loadouts", payload: { name: "L" } })).loadout;

  assert.equal((await app.inject({ method: "GET", url: "/api/avatars/999/loadouts" })).statusCode, 404);
  assert.equal((await app.inject({ method: "POST", url: "/api/avatars/999/loadouts", payload: { name: "x" } })).statusCode, 404);
  assert.equal((await app.inject({ method: "GET", url: "/api/avatars/abc/loadouts" })).statusCode, 400);
  assert.equal((await app.inject({ method: "GET", url: "/api/loadouts/999" })).statusCode, 404);
  assert.equal((await app.inject({ method: "PATCH", url: "/api/loadouts/999", payload: { name: "x", expectedVersion: 1 } })).statusCode, 404);
  assert.equal((await app.inject({ method: "DELETE", url: "/api/loadouts/999" })).statusCode, 404);
  assert.equal((await app.inject({ method: "POST", url: "/api/loadouts/999/items", payload: { itemIds: [i1] } })).statusCode, 404);
  assert.equal((await app.inject({ method: "POST", url: "/api/loadouts/" + L.id + "/items", payload: { itemIds: [] } })).statusCode, 400);
  assert.equal((await app.inject({ method: "POST", url: "/api/loadouts/" + L.id + "/items", payload: { itemIds: Array.from({ length: 201 }, (_, n) => n + 1) } })).statusCode, 400);
  assert.equal((await app.inject({ method: "POST", url: "/api/loadouts/" + L.id + "/items", payload: { itemIds: [9999] } })).statusCode, 404);
  assert.equal((await app.inject({ method: "POST", url: "/api/loadouts/" + L.id + "/items", payload: { itemIds: [i1], state: "done" } })).statusCode, 400);
  assert.equal((await app.inject({ method: "POST", url: "/api/avatars/" + av + "/loadouts", payload: { name: "x".repeat(81) } })).statusCode, 400);
  assert.equal((await app.inject({ method: "POST", url: "/api/avatars/" + av + "/loadouts", payload: { name: "ok", note: "n".repeat(501) } })).statusCode, 400);
  assert.equal((await app.inject({ method: "PATCH", url: "/api/loadouts/" + L.id, payload: { name: "x" } })).statusCode, 400);
  assert.equal((await app.inject({ method: "POST", url: "/api/loadouts/" + L.id + "/items/reorder", payload: { itemIds: "x" } })).statusCode, 400);

  assert.equal(count(t.db, "loadouts"), 1);
  assert.equal(count(t.db, "loadout_items"), 0);
  t.close();
});

test("卡片 DTO 与只读证据：真实标题/封面/证据，不自动改 state", async () => {
  const t = openTempDb();
  const { app, repo } = setup(t);
  const av = addAvatar(t.db, "A");
  const i1 = addItem(t.db, { title: "真实标题", shop_name: "店" });
  const img = addImage(t.db, i1, { role: "cover", origin: "booth" });
  repo.setCover(i1, img);
  const L = json(await app.inject({ method: "POST", url: "/api/avatars/" + av + "/loadouts", payload: { name: "L" } })).loadout;

  const added = json(await app.inject({ method: "POST", url: "/api/loadouts/" + L.id + "/items", payload: { itemIds: [i1] } }));
  const card = added.items[0].item;
  assert.equal(card.id, i1);
  assert.equal(card.title, "真实标题");
  assert.equal(card.shopName, "店");
  assert.equal(card.status, "inbox");
  assert.equal(card.coverImageId, img);
  assert.equal(card.coverUrl, "/api/media/" + img + "?w=480");
  assert.equal(card.imageCount, 1);
  assert.equal(card.assetCount, 0);
  assert.deepEqual(card.avatars, []);
  assert.deepEqual(card.tags, []);
  assert.equal(typeof card.updatedAt, "string");

  const pid = repo.ensureProject("P", "/tmp/p");
  repo.addProjectImport(pid, i1, null, null);
  const detail = json(await app.inject({ method: "GET", url: "/api/loadouts/" + L.id }));
  assert.equal(detail.items[0].evidence.registered, true);
  assert.equal(typeof detail.items[0].evidence.registeredAt, "string");
  assert.equal(detail.items[0].evidence.referenced, false);
  assert.equal(detail.items[0].evidence.verified, false);
  assert.equal(detail.items[0].state, "planned");
  assert.equal(detail.items[0].version, 1);
  t.close();
});
