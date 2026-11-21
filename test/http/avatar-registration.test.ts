/**
 * SALT 首次确认：POST /api/items/:id/register-avatar（task-49）。
 *
 * 真实 Fastify.inject + 真实临时 SQLite（schema.sql 建库），不 listen、不碰生产库/7317。
 * 断言真实建档/复用/owned/别名/冲突/回滚/零残余，不只 statusCode。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";
import { openTempDb, addItem, addAvatar, count, type TempDb } from "../schema/_db";
import { Repo } from "../../apps/server/src/db/repo";
import { registerAvatarRegistrationRoutes } from "../../apps/server/src/http/routes/avatar-registration";

type Json = Record<string, unknown>;

function setup(): { t: TempDb; repo: Repo; app: FastifyInstance } {
  const t = openTempDb();
  const repo = new Repo(t.db);
  const app = Fastify({ logger: false });
  registerAvatarRegistrationRoutes(app, { repo, log: () => {} });
  return { t, repo, app };
}

const json = (r: { body: string }): Json => JSON.parse(r.body) as Json;
const errorOf = (b: Json): Json => (b.error ?? {}) as Json;
const detailsOf = (b: Json): Json => (errorOf(b).details ?? {}) as Json;

const post = (app: FastifyInstance, itemId: number | string, payload: Json) =>
  app.inject({ method: "POST", url: `/api/items/${itemId}/register-avatar`, payload });

const snapshot = (db: TempDb["db"]) => ({
  items: db.prepare("SELECT * FROM items ORDER BY id").all(),
  assets: db.prepare("SELECT * FROM assets ORDER BY id").all(),
  images: db.prepare("SELECT * FROM item_images ORDER BY id").all(),
});

test("新建：SALT 建档 + manual 关联 + owned + 别名 + 本地条目无 boothItemId", async () => {
  const { t, repo, app } = setup();
  const item = addItem(t.db, { title: "local", source_site: "local" });
  const before = snapshot(t.db);
  const res = await post(app, item, { name: "SALT", aliases: ["SALT-01", "salt 01", "SALT"], owned: true });
  assert.equal(res.statusCode, 200);
  const body = json(res);
  assert.equal(body.created, true);
  assert.equal(typeof body.avatarId, "number");
  assert.equal(body.name, undefined);
  assert.equal(body.avatar, undefined);
  const id = Number(body.avatarId);
  const av = repo.getAvatar(id);
  assert.ok(av);
  assert.equal(av.name, "SALT");
  assert.equal(av.name_norm, "salt");
  assert.equal(av.kind, "avatar");
  assert.equal(av.owned, 1);
  assert.equal(av.booth_item_id, null);
  const aliases = repo.listAliases(id);
  assert.equal(aliases.length, 1, "SALT-01 与 salt 01 规范相同应去重；SALT 与 name 相同应跳过");
  assert.equal(aliases[0]?.alias_norm, "salt01");
  assert.equal(aliases[0]?.source, "user");
  const links = repo.listItemAvatars(item);
  assert.equal(links.length, 1);
  assert.equal(links[0]?.avatar_id, id);
  assert.equal(links[0]?.source, "manual");
  assert.equal(links[0]?.match, "any");
  assert.equal(links[0]?.confidence, 1);
  assert.deepEqual(snapshot(t.db), before, "items/assets/images 不得变");
  assert.equal(repo.listAvatars({ ownedOnly: true }).some((a) => a.id === id), true);
  await app.close(); t.close();
});

test("新建：booth 条目记录 booth_item_id；owned=false 写 0", async () => {
  const { t, repo, app } = setup();
  const item = addItem(t.db, { title: "booth", source_site: "booth", source_item_id: "1234567" });
  const res = await post(app, item, { name: "BoothAvatar", owned: false });
  assert.equal(res.statusCode, 200);
  const body = json(res);
  assert.equal(body.created, true);
  const av = repo.getAvatar(Number(body.avatarId));
  assert.ok(av);
  assert.equal(av.booth_item_id, "1234567");
  assert.equal(av.owned, 0);
  assert.equal(repo.listAliases(av.id).length, 0);
  await app.close(); t.close();
});

test("显式复用：不建第二档案、owned=true 设 1、重复幂等、owned=false 不撤销", async () => {
  const { t, repo, app } = setup();
  const existing = addAvatar(t.db, "Existing", { kind: "base", owned: 0, booth_item_id: "7654321" });
  const existing2 = addAvatar(t.db, "Existing2", { owned: 0 });
  repo.addAlias(existing, "Ex", null, "user");
  const item = addItem(t.db, { title: "i" });
  const beforeAvatars = count(t.db, "avatars");
  const beforeAliases = count(t.db, "avatar_aliases");
  const r1 = await post(app, item, { existingAvatarId: existing, owned: true });
  assert.equal(r1.statusCode, 200);
  assert.equal(json(r1).created, false);
  assert.equal(json(r1).avatarId, existing);
  assert.equal(count(t.db, "avatars"), beforeAvatars);
  assert.equal(count(t.db, "avatar_aliases"), beforeAliases);
  const av = repo.getAvatar(existing);
  assert.ok(av);
  assert.equal(av.owned, 1);
  assert.equal(av.name, "Existing");
  assert.equal(av.kind, "base");
  assert.equal(av.booth_item_id, "7654321");
  assert.deepEqual(repo.listAliases(existing).map((a) => a.alias), ["Ex"]);
  assert.equal(count(t.db, "item_avatars", "item_id=?", item), 1);
  assert.equal(repo.listAvatars({ ownedOnly: true }).some((a) => a.id === existing), true);
  const r2 = await post(app, item, { existingAvatarId: existing, owned: true });
  assert.equal(r2.statusCode, 200);
  assert.equal(json(r2).created, false);
  assert.equal(count(t.db, "item_avatars", "item_id=?", item), 1, "重复复用幂等");
  const r3 = await post(app, item, { existingAvatarId: existing, owned: false });
  assert.equal(r3.statusCode, 200);
  assert.equal(repo.getAvatar(existing)?.owned, 1, "owned=false 不撤销已有 owned=1");
  const r4 = await post(app, item, { existingAvatarId: existing2, owned: false });
  assert.equal(r4.statusCode, 200);
  assert.equal(repo.getAvatar(existing2)?.owned, 0);
  assert.equal(repo.listAvatars({ ownedOnly: true }).some((a) => a.id === existing2), false);
  await app.close(); t.close();
});

test("409 名称/别名冲突：normKey 归一、details 完整、零残余", async () => {
  const { t, repo, app } = setup();
  const existing = repo.createAvatar({ name: "SALT-01" }).id;
  repo.addAlias(existing, "AliasName", null, "user");
  const item = addItem(t.db, { title: "i" });
  const before = { avatars: count(t.db, "avatars"), aliases: count(t.db, "avatar_aliases"), links: count(t.db, "item_avatars") };
  const nameHit = await post(app, item, { name: "SALT01", owned: true });
  assert.equal(nameHit.statusCode, 409);
  assert.equal(errorOf(json(nameHit)).code, "CONFLICT");
  assert.equal(detailsOf(json(nameHit)).code, "AVATAR_NAME_CONFLICT");
  assert.equal(detailsOf(json(nameHit)).avatarId, existing);
  assert.equal(detailsOf(json(nameHit)).avatarName, "SALT-01");
  const aliasNameHit = await post(app, item, { name: "AliasName", owned: true });
  assert.equal(aliasNameHit.statusCode, 409);
  assert.equal(detailsOf(json(aliasNameHit)).code, "AVATAR_NAME_CONFLICT");
  const aliasHit = await post(app, item, { name: "New", aliases: ["SALT01"], owned: true });
  assert.equal(aliasHit.statusCode, 409);
  assert.equal(detailsOf(json(aliasHit)).code, "AVATAR_ALIAS_CONFLICT");
  assert.equal(detailsOf(json(aliasHit)).avatarId, existing);
  assert.equal(detailsOf(json(aliasHit)).avatarName, "SALT-01");
  const aliasAliasHit = await post(app, item, { name: "New2", aliases: ["AliasName"], owned: true });
  assert.equal(aliasAliasHit.statusCode, 409);
  assert.equal(detailsOf(json(aliasAliasHit)).code, "AVATAR_ALIAS_CONFLICT");
  assert.deepEqual({ avatars: count(t.db, "avatars"), aliases: count(t.db, "avatar_aliases"), links: count(t.db, "item_avatars") }, before);
  await app.close(); t.close();
});

test("400/404：类型、空归一化名、非法 id、混传、未知字段、缺实体", async () => {
  const { t, repo, app } = setup();
  const item = addItem(t.db, { title: "i" });
  const before = { avatars: count(t.db, "avatars"), aliases: count(t.db, "avatar_aliases"), links: count(t.db, "item_avatars") };
  const bad: Json[] = [
    {},
    { name: "", owned: true },
    { name: "---", owned: true },
    { name: 123, owned: true },
    { name: "X", owned: "true" },
    { name: "X", aliases: "a", owned: true },
    { name: "X", aliases: [1], owned: true },
    { existingAvatarId: 0, owned: true },
    { existingAvatarId: "1", owned: true },
    { existingAvatarId: 1, name: "X", owned: true },
    { name: "X", owned: true, boothItemId: "123" },
    { name: "X", owned: true, force: true },
  ];
  for (const payload of bad) {
    const r = await post(app, item, payload);
    assert.equal(r.statusCode, 400, JSON.stringify(payload));
    assert.equal(errorOf(json(r)).code, "INVALID_INPUT", JSON.stringify(payload));
  }
  const badItem = await post(app, "abc", { name: "X", owned: true });
  assert.equal(badItem.statusCode, 400);
  const missingItem = await post(app, 999999, { name: "X", owned: true });
  assert.equal(missingItem.statusCode, 404);
  assert.equal(errorOf(json(missingItem)).code, "NOT_FOUND");
  const missingAvatar = await post(app, item, { existingAvatarId: 999999, owned: true });
  assert.equal(missingAvatar.statusCode, 404);
  assert.equal(errorOf(json(missingAvatar)).code, "NOT_FOUND");
  assert.deepEqual({ avatars: count(t.db, "avatars"), aliases: count(t.db, "avatar_aliases"), links: count(t.db, "item_avatars") }, before);
  await app.close(); t.close();
});

test("别名插入故障真回滚：无档案/别名/关联残余", async () => {
  const { t, repo, app } = setup();
  const item = addItem(t.db, { title: "i" });
  const before = { avatars: count(t.db, "avatars"), aliases: count(t.db, "avatar_aliases"), links: count(t.db, "item_avatars") };
  t.db.exec("CREATE TRIGGER fail_alias BEFORE INSERT ON avatar_aliases BEGIN SELECT RAISE(ABORT, 'alias fail'); END");
  try {
    const res = await post(app, item, { name: "RollbackAlias", aliases: ["A1"], owned: true });
    assert.equal(res.statusCode, 500);
  } finally {
    t.db.exec("DROP TRIGGER fail_alias");
  }
  assert.deepEqual({ avatars: count(t.db, "avatars"), aliases: count(t.db, "avatar_aliases"), links: count(t.db, "item_avatars") }, before);
  assert.equal(count(t.db, "avatars", "name_norm=?", "rollbackalias"), 0);
  assert.equal(repo.listItemAvatars(item).length, 0);
  await app.close(); t.close();
});

test("关联故障真回滚：新建档案/别名/owned 全回滚", async () => {
  const { t, repo, app } = setup();
  const item = addItem(t.db, { title: "i" });
  const before = { avatars: count(t.db, "avatars"), aliases: count(t.db, "avatar_aliases"), links: count(t.db, "item_avatars") };
  t.db.exec("CREATE TRIGGER fail_link BEFORE INSERT ON item_avatars BEGIN SELECT RAISE(ABORT, 'link fail'); END");
  try {
    const res = await post(app, item, { name: "RollbackAssoc", aliases: ["RA"], owned: true });
    assert.equal(res.statusCode, 500);
  } finally {
    t.db.exec("DROP TRIGGER fail_link");
  }
  assert.deepEqual({ avatars: count(t.db, "avatars"), aliases: count(t.db, "avatar_aliases"), links: count(t.db, "item_avatars") }, before);
  assert.equal(count(t.db, "avatars", "name_norm=?", "rollbackassoc"), 0);
  assert.equal(repo.listItemAvatars(item).length, 0);
  await app.close(); t.close();
});

test("复用关联故障回滚 owned 更新", async () => {
  const { t, repo, app } = setup();
  const existing = addAvatar(t.db, "Existing", { owned: 0 });
  const item = addItem(t.db, { title: "i" });
  t.db.exec("CREATE TRIGGER fail_link2 BEFORE INSERT ON item_avatars BEGIN SELECT RAISE(ABORT, 'link fail'); END");
  try {
    const res = await post(app, item, { existingAvatarId: existing, owned: true });
    assert.equal(res.statusCode, 500);
  } finally {
    t.db.exec("DROP TRIGGER fail_link2");
  }
  assert.equal(repo.getAvatar(existing)?.owned, 0, "owned 更新必须随关联失败回滚");
  assert.equal(count(t.db, "item_avatars", "item_id=?", item), 0);
  await app.close(); t.close();
});
