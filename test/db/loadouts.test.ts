import { test } from "node:test";
import assert from "node:assert/strict";
import { openTempDb, addRoot, addItem, addAsset, addAvatar, count } from "../schema/_db";
import { Repo } from "../../apps/server/src/db/repo";
import {
  createLoadout, listLoadouts, getLoadout, patchLoadout, deleteLoadout,
  addLoadoutItems, patchLoadoutItem, removeLoadoutItem, reorderLoadoutItems,
} from "../../apps/server/src/db/loadouts";

const isCode = (code: string) => (e: any) => e?.code === code;

test("多清单、状态隔离、墓碑 ABA、counts 三口径", () => {
  const t = openTempDb(); const repo = new Repo(t.db); const rootId = addRoot(t.db, "/lib");
  const av = addAvatar(t.db, "Manuka"); const i1 = addItem(t.db, { title: "i1" }); const i2 = addItem(t.db, { title: "i2" });
  const L1 = createLoadout(repo, av, { name: "日常" }); const L2 = createLoadout(repo, av, { name: "活动" });
  assert.throws(() => createLoadout(repo, av, { name: "日常" }), isCode("CONFLICT"));
  addLoadoutItems(repo, L1.id, { itemIds: [i1, i2] });
  const it1 = patchLoadoutItem(repo, L1.id, i1, { state: "verified", expectedVersion: 1 });
  assert.equal(it1.version, 2);
  assert.equal(getLoadout(repo, L2.id, {}).items.length, 0);
  assert.equal(removeLoadoutItem(repo, L1.id, i1).removed, 1);
  assert.equal(removeLoadoutItem(repo, L1.id, i1).removed, 0);
  const revived = addLoadoutItems(repo, L1.id, { itemIds: [i1] });
  assert.equal(revived.revived, 1);
  assert.equal(revived.items[0].version, 4);
  assert.equal(revived.items[0].position, 1); // 复活位置 = MAX(活跃行)+1（i2 在 0）
  assert.throws(() => patchLoadoutItem(repo, L1.id, i1, { state: "planned", expectedVersion: 2 }), isCode("CONFLICT"));
  t.db.prepare("UPDATE items SET status='trashed' WHERE id=?").run(i2);
  const d = getLoadout(repo, L1.id, {});
  assert.equal(d.stateCounts.planned + d.stateCounts.imported + d.stateCounts.verified, 2);
  assert.equal(d.visibleStateCounts.planned + d.visibleStateCounts.imported + d.visibleStateCounts.verified, 1);
  assert.equal(d.trashedCount, 1);
  assert.equal(d.items.length, 1);
  assert.deepEqual(d.items[0].evidence, { registered: false, referenced: false, verified: false, registeredAt: null, referencedAt: null, verifiedAt: null });
  const pid = repo.ensureProject("P", "/tmp/p"); repo.addProjectImport(pid, i1, null, null);
  const after = getLoadout(repo, L1.id, {});
  assert.equal(after.items[0].evidence.registered, true);
  // spec §6.1:148：复活未显式给 state 时默认 planned（不是墓碑行原值 verified）。
  assert.equal(after.items[0].state, "planned");
  const rowsBefore = count(t.db, "loadout_items"); getLoadout(repo, L1.id, {});
  assert.equal(count(t.db, "loadout_items"), rowsBefore);
  const assetsBefore = count(t.db, "assets"); deleteLoadout(repo, L2.id);
  assert.equal(count(t.db, "assets"), assetsBefore);
  t.close();
});

test("reorder 可见行：隐藏行追加且相对顺序不变", () => {
  const t = openTempDb(); const repo = new Repo(t.db); const av = addAvatar(t.db, "A");
  const ids = [1, 2, 3, 4].map((n) => addItem(t.db, { title: "i" + n }));
  const L = createLoadout(repo, av, { name: "x" });
  addLoadoutItems(repo, L.id, { itemIds: ids });
  t.db.prepare("UPDATE items SET status='trashed' WHERE id=?").run(ids[1]);
  const out = reorderLoadoutItems(repo, L.id, [ids[3], ids[0], ids[2]]);
  assert.deepEqual(out.items.map((r) => r.itemId), [ids[3], ids[0], ids[2], ids[1]]);
  assert.deepEqual(out.items.map((r) => r.position), [0, 1, 2, 3]);
  t.close();
});

test("reorder 形状校验：少行/多行/重复/跨清单/墓碑 → 400 且 position 不变", () => {
  const t = openTempDb(); const repo = new Repo(t.db); const av = addAvatar(t.db, "A");
  const ids = [1, 2, 3].map((n) => addItem(t.db, { title: "r" + n }));
  const other = addItem(t.db, { title: "other" });
  const L = createLoadout(repo, av, { name: "shape" });
  const L2 = createLoadout(repo, av, { name: "other-list" });
  addLoadoutItems(repo, L.id, { itemIds: ids });
  addLoadoutItems(repo, L2.id, { itemIds: [other] });
  const before = getLoadout(repo, L.id, {}).items.map((r) => [r.itemId, r.position]);
  assert.throws(() => reorderLoadoutItems(repo, L.id, [ids[0]]), isCode("INVALID_INPUT"));
  assert.throws(() => reorderLoadoutItems(repo, L.id, [ids[0], ids[1], ids[2], other]), isCode("INVALID_INPUT"));
  assert.throws(() => reorderLoadoutItems(repo, L.id, [ids[0], ids[0], ids[2]]), isCode("INVALID_INPUT"));
  assert.throws(() => reorderLoadoutItems(repo, L.id, []), isCode("INVALID_INPUT"));
  const after = getLoadout(repo, L.id, {}).items.map((r) => [r.itemId, r.position]);
  assert.deepEqual(after, before);
  // 墓碑行不参与 reorder：删除后该 id 不再属于活跃集
  removeLoadoutItem(repo, L.id, ids[1]);
  assert.throws(() => reorderLoadoutItems(repo, L.id, [ids[0], ids[1], ids[2]]), isCode("INVALID_INPUT"));
  t.close();
});

test("reorder 空可见集：[] 合法 no-op；全量重排含回收站 item", () => {
  const t = openTempDb(); const repo = new Repo(t.db); const av = addAvatar(t.db, "A");
  const ids = [1, 2].map((n) => addItem(t.db, { title: "e" + n }));
  const L = createLoadout(repo, av, { name: "empty" });
  addLoadoutItems(repo, L.id, { itemIds: ids });
  reorderLoadoutItems(repo, L.id, [ids[1], ids[0]]);
  const posBefore = getLoadout(repo, L.id, {}).items.map((r) => [r.itemId, r.position]);
  for (const id of ids) t.db.prepare("UPDATE items SET status='trashed' WHERE id=?").run(id);
  const noop = reorderLoadoutItems(repo, L.id, []);
  assert.deepEqual(noop.items.map((r) => [r.itemId, r.position]), posBefore);
  // 全量重排（含回收站 item）合法
  const full = reorderLoadoutItems(repo, L.id, [ids[0], ids[1]]);
  assert.deepEqual(full.items.map((r) => r.itemId), [ids[0], ids[1]]);
  assert.deepEqual(full.items.map((r) => r.position), [0, 1]);
  t.close();
});

test("add 幂等：已有活跃行不覆盖 state/note；state 只作用于新行/复活行", () => {
  const t = openTempDb(); const repo = new Repo(t.db); const av = addAvatar(t.db, "A");
  const i1 = addItem(t.db, { title: "a1" }); const i2 = addItem(t.db, { title: "a2" });
  const L = createLoadout(repo, av, { name: "idem" });
  const first = addLoadoutItems(repo, L.id, { itemIds: [i1], state: "imported", note: "n1" });
  assert.equal(first.added, 1); assert.equal(first.revived, 0); assert.equal(first.existing, 0);
  assert.equal(first.items[0].state, "imported"); assert.equal(first.items[0].note, "n1");
  const second = addLoadoutItems(repo, L.id, { itemIds: [i1, i2], state: "verified", note: "n2" });
  assert.equal(second.added, 1); assert.equal(second.existing, 1);
  const kept = second.items.find((r) => r.itemId === i1)!;
  assert.equal(kept.state, "imported"); assert.equal(kept.note, "n1"); assert.equal(kept.version, 1);
  const fresh = second.items.find((r) => r.itemId === i2)!;
  assert.equal(fresh.state, "verified"); assert.equal(fresh.note, "n2");
  // 成员增删不 bump loadouts.version
  assert.equal(listLoadouts(repo, av)[0].version, 1);
  t.close();
});

test("add 原子性：含不存在 item → 404 且不落半行", () => {
  const t = openTempDb(); const repo = new Repo(t.db); const av = addAvatar(t.db, "A");
  const i1 = addItem(t.db, { title: "ok" });
  const L = createLoadout(repo, av, { name: "atomic" });
  assert.throws(() => addLoadoutItems(repo, L.id, { itemIds: [i1, 999999] }), isCode("NOT_FOUND"));
  assert.equal(count(t.db, "loadout_items"), 0);
  t.close();
});

test("patchLoadout：CAS、同名 409、trim/空名、note 清空", () => {
  const t = openTempDb(); const repo = new Repo(t.db); const av = addAvatar(t.db, "A");
  const L1 = createLoadout(repo, av, { name: " 日常 " });
  assert.equal(L1.name, "日常");
  const L2 = createLoadout(repo, av, { name: "活动" });
  assert.throws(() => createLoadout(repo, av, { name: "   " }), isCode("INVALID_INPUT"));
  assert.throws(() => patchLoadout(repo, L1.id, { name: "活动", expectedVersion: 1 }), isCode("CONFLICT"));
  const p1 = patchLoadout(repo, L1.id, { name: "日常2", note: "备注", sort: 5, expectedVersion: 1 });
  assert.equal(p1.version, 2); assert.equal(p1.name, "日常2"); assert.equal(p1.note, "备注"); assert.equal(p1.sort, 5);
  assert.throws(() => patchLoadout(repo, L1.id, { name: "x", expectedVersion: 1 }), isCode("CONFLICT"));
  const p2 = patchLoadout(repo, L1.id, { note: null, expectedVersion: 2 });
  assert.equal(p2.note, null); assert.equal(p2.version, 3);
  assert.throws(() => patchLoadout(repo, 999999, { name: "x", expectedVersion: 1 }), isCode("NOT_FOUND"));
  t.close();
});

test("getLoadout：includeTrashedItems 与 state 过滤、total 一致、墓碑行永不返回", () => {
  const t = openTempDb(); const repo = new Repo(t.db); const av = addAvatar(t.db, "A");
  const i1 = addItem(t.db, { title: "g1" }); const i2 = addItem(t.db, { title: "g2" }); const i3 = addItem(t.db, { title: "g3" });
  const L = createLoadout(repo, av, { name: "get" });
  addLoadoutItems(repo, L.id, { itemIds: [i1, i2, i3] });
  patchLoadoutItem(repo, L.id, i2, { state: "verified", expectedVersion: 1 });
  removeLoadoutItem(repo, L.id, i3);
  t.db.prepare("UPDATE items SET status='trashed' WHERE id=?").run(i1);
  const hidden = getLoadout(repo, L.id, {});
  assert.equal(hidden.total, 1);
  assert.deepEqual(hidden.items.map((r) => r.itemId), [i2]);
  const shown = getLoadout(repo, L.id, { includeTrashedItems: true });
  assert.equal(shown.total, 2);
  assert.deepEqual(shown.items.map((r) => r.itemId).sort((a, b) => a - b), [i1, i2]);
  const filtered = getLoadout(repo, L.id, { state: "verified", includeTrashedItems: true });
  assert.equal(filtered.total, 1);
  assert.equal(filtered.items[0].itemId, i2);
  assert.equal(filtered.stateCounts.verified, 1);
  assert.equal(filtered.trashedCount, 1);
  assert.throws(() => getLoadout(repo, L.id, { state: "bogus" as any }), isCode("INVALID_INPUT"));
  assert.throws(() => getLoadout(repo, 999999, {}), isCode("NOT_FOUND"));
  t.close();
});

test("deleteLoadout：级联删清单项，不删 item/asset", () => {
  const t = openTempDb(); const repo = new Repo(t.db); const rootId = addRoot(t.db, "/lib");
  const av = addAvatar(t.db, "A"); const i1 = addItem(t.db, { title: "d1" });
  addAsset(t.db, i1, rootId, "/lib/d1.zip");
  const L = createLoadout(repo, av, { name: "del" });
  addLoadoutItems(repo, L.id, { itemIds: [i1] });
  assert.equal(deleteLoadout(repo, L.id).deleted, true);
  assert.equal(count(t.db, "loadout_items"), 0);
  assert.equal(count(t.db, "items"), 1);
  assert.equal(count(t.db, "assets"), 1);
  assert.throws(() => deleteLoadout(repo, L.id), isCode("NOT_FOUND"));
  t.close();
});

test("复活默认 state=planned；显式 state 生效；活跃行不覆写", () => {
  const t = openTempDb(); const repo = new Repo(t.db); const av = addAvatar(t.db, "A");
  const i1 = addItem(t.db, { title: "d1" }); const i2 = addItem(t.db, { title: "d2" });
  const L = createLoadout(repo, av, { name: "revive-default" });
  addLoadoutItems(repo, L.id, { itemIds: [i1, i2], state: "verified", note: "keep" });
  // 活跃行 add 幂等：不覆写 state/note/position/version
  const again = addLoadoutItems(repo, L.id, { itemIds: [i1], state: "planned", note: "overwrite" });
  assert.equal(again.existing, 1);
  assert.equal(again.items[0].state, "verified");
  assert.equal(again.items[0].note, "keep");
  assert.equal(again.items[0].version, 1);
  // 省略 state 复活 → spec §6.1 默认 planned（不是墓碑原值 verified）
  removeLoadoutItem(repo, L.id, i1);
  const omitted = addLoadoutItems(repo, L.id, { itemIds: [i1] });
  assert.equal(omitted.revived, 1);
  assert.equal(omitted.items[0].state, "planned");
  // 显式 state 复活 → 请求值生效
  removeLoadoutItem(repo, L.id, i1);
  const explicit = addLoadoutItems(repo, L.id, { itemIds: [i1], state: "imported" });
  assert.equal(explicit.revived, 1);
  assert.equal(explicit.items[0].state, "imported");
  t.close();
});

test("removeLoadoutItem 实体存在性：缺清单/缺 item → 404；未加入/墓碑 → removed:0 且 version 不增", () => {
  const t = openTempDb(); const repo = new Repo(t.db); const av = addAvatar(t.db, "A");
  const i1 = addItem(t.db, { title: "r1" }); const i2 = addItem(t.db, { title: "r2" });
  const L = createLoadout(repo, av, { name: "remove-entity" });
  const rows0 = count(t.db, "loadout_items");
  // 缺清单 → 404（不是 removed:0），零业务写
  assert.throws(() => removeLoadoutItem(repo, 999999, i1), isCode("NOT_FOUND"));
  assert.equal(count(t.db, "loadout_items"), rows0);
  // 缺 item → 404（不是 removed:0），零业务写
  assert.throws(() => removeLoadoutItem(repo, L.id, 999999), isCode("NOT_FOUND"));
  assert.equal(count(t.db, "loadout_items"), rows0);
  // 两实体存在但成员未加入 → removed:0，且不落行
  assert.equal(removeLoadoutItem(repo, L.id, i1).removed, 0);
  assert.equal(count(t.db, "loadout_items"), 0);
  // 活跃行一次墓碑 version+1；复删 removed:0 且 version 不再增
  addLoadoutItems(repo, L.id, { itemIds: [i1] });
  assert.equal(removeLoadoutItem(repo, L.id, i1).removed, 1);
  const v1 = (t.db.prepare("SELECT version FROM loadout_items WHERE loadout_id=? AND item_id=?").get(L.id, i1) as { version: number }).version;
  assert.equal(v1, 2);
  assert.equal(removeLoadoutItem(repo, L.id, i1).removed, 0);
  const v2 = (t.db.prepare("SELECT version FROM loadout_items WHERE loadout_id=? AND item_id=?").get(L.id, i1) as { version: number }).version;
  assert.equal(v2, 2);
  // 回收站 item 仍是存在实体：不按 status 拒绝，活跃行可正常墓碑
  addLoadoutItems(repo, L.id, { itemIds: [i2] });
  t.db.prepare("UPDATE items SET status='trashed' WHERE id=?").run(i2);
  assert.equal(removeLoadoutItem(repo, L.id, i2).removed, 1);
  t.close();
});
