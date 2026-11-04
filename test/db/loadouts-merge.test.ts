/**
 * P3-T3：mergeLoadoutItemsTx 六格表（spec §9.1:233-252）。
 * 只读消费 T1 表结构 / test/schema/_db helpers；不改旧 instrument。
 * 合成触发器只用于制造真实 DB 异常与 0 行 CAS，不改 schema/旧测试。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { openTempDb, addItem, addAvatar, NOW } from "../schema/_db";
import { Repo } from "../../apps/server/src/db/repo";
import { mergeLoadoutItemsTx, addLoadoutItems, patchLoadoutItem } from "../../apps/server/src/db/loadouts";

type Db = ReturnType<typeof openTempDb>["db"];

const row = (db: Db, l: number, i: number) =>
  db.prepare("SELECT * FROM loadout_items WHERE loadout_id=? AND item_id=?").get(l, i) as any;
const mkLoadout = (db: Db, avatarId: number, name: string) =>
  Number(db.prepare("INSERT INTO loadouts(avatar_id,name,sort,version,created_at,updated_at) VALUES (?,?,0,1,?,?)")
    .run(avatarId, name, NOW, NOW).lastInsertRowid);
interface PutOpts { version: number; state?: string; note?: string | null; position?: number; deletedAt?: string | null; updatedAt?: string }
const put = (db: Db, l: number, i: number, o: PutOpts) =>
  db.prepare("INSERT INTO loadout_items(loadout_id,item_id,state,note,position,version,created_at,updated_at,deleted_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(l, i, o.state ?? "planned", o.note ?? null, o.position ?? 0, o.version, NOW, o.updatedAt ?? NOW, o.deletedAt ?? null);
const audits = (db: Db) => db.prepare("SELECT * FROM audit_log ORDER BY id").all() as any[];
const isCode = (code: string) => (e: any) => e?.code === code;

test("六格表 + target-only 两态 + 无关清单：state/note/position/version/计数/审计", () => {
  const t = openTempDb(); const db = t.db;
  const av = addAvatar(db, "A");
  const S = addItem(db, { title: "S" }); const T = addItem(db, { title: "T" }); const X = addItem(db, { title: "X" });
  const itemsBefore = JSON.stringify(db.prepare("SELECT * FROM items ORDER BY id").all());

  // L1 target 活跃(v2) + source 活跃(v5)：preT < preS
  const L1 = mkLoadout(db, av, "L1");
  put(db, L1, T, { version: 2, state: "verified", note: "t-note", position: 3 });
  put(db, L1, S, { version: 5, state: "imported", note: "s-note", position: 1 });
  // L2 target 墓碑(v3, pos 9) + source 活跃(v4)：复活；MAX 只算活跃行（S pos 2 → 3，不是 10）
  const L2 = mkLoadout(db, av, "L2");
  put(db, L2, T, { version: 3, position: 9, deletedAt: "2026-01-01T00:00:00.000Z" });
  put(db, L2, S, { version: 4, state: "verified", note: "s2", position: 2 });
  // L3 target 活跃(v7) + source 墓碑(v9)：preT < preS；source 全字段不变
  const L3 = mkLoadout(db, av, "L3");
  put(db, L3, T, { version: 7, position: 0 });
  put(db, L3, S, { version: 9, position: 5, deletedAt: "2026-01-02T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z" });
  // L4 双方墓碑：T v2 / S v8
  const L4 = mkLoadout(db, av, "L4");
  put(db, L4, T, { version: 2, position: 4, deletedAt: "2026-01-03T00:00:00.000Z" });
  put(db, L4, S, { version: 8, position: 6, deletedAt: "2026-01-03T00:00:00.000Z" });
  // L5 target 无行 + source 活跃(v3, pos 7)
  const L5 = mkLoadout(db, av, "L5");
  put(db, L5, S, { version: 3, state: "imported", note: "s5", position: 7 });
  // L6 target 无行 + source 墓碑(v6)
  const L6 = mkLoadout(db, av, "L6");
  put(db, L6, S, { version: 6, deletedAt: "2026-01-04T00:00:00.000Z" });
  // L7 target 活跃 only / L8 target 墓碑 only：source 无行 → 字节不变
  const L7 = mkLoadout(db, av, "L7"); put(db, L7, T, { version: 4, position: 2 });
  const L8 = mkLoadout(db, av, "L8"); put(db, L8, T, { version: 5, position: 1, deletedAt: "2026-01-05T00:00:00.000Z" });
  // L9 无关清单（S/T 都不含）
  const L9 = mkLoadout(db, av, "L9"); put(db, L9, X, { version: 1, position: 0 });

  const s3 = JSON.stringify(row(db, L3, S));
  const l7 = JSON.stringify(row(db, L7, T));
  const l8 = JSON.stringify(row(db, L8, T));
  const l9 = JSON.stringify(row(db, L9, X));

  const r = mergeLoadoutItemsTx(db, S, T, NOW);
  assert.deepEqual(r, { conflicts: 1, revived: 1, moved: 1, bothTombstone: 1, noop: 3 });

  // L1：target 赢 state/note/position；version=max(2,5)+1；source 墓碑 +1
  const l1t = row(db, L1, T); const l1s = row(db, L1, S);
  assert.equal(l1t.version, 6); assert.equal(l1t.deleted_at, null);
  assert.equal(l1t.state, "verified"); assert.equal(l1t.note, "t-note"); assert.equal(l1t.position, 3);
  assert.equal(l1s.version, 6); assert.equal(l1s.deleted_at, NOW);
  assert.equal(l1s.state, "imported"); assert.equal(l1s.note, "s-note"); assert.equal(l1s.position, 1);
  // L2：复活取 source state/note，position=MAX(活跃)+1=3（墓碑 pos 9 不参与）
  const l2t = row(db, L2, T); const l2s = row(db, L2, S);
  assert.equal(l2t.version, 5); assert.equal(l2t.deleted_at, null);
  assert.equal(l2t.state, "verified"); assert.equal(l2t.note, "s2"); assert.equal(l2t.position, 3);
  assert.equal(l2s.version, 5); assert.equal(l2s.deleted_at, NOW);
  // L3：target 活跃 + source 墓碑 → target max+1；source 全字段不变
  const l3t = row(db, L3, T);
  assert.equal(l3t.version, 10); assert.equal(l3t.deleted_at, null);
  assert.equal(JSON.stringify(row(db, L3, S)), s3);
  // L4：双方墓碑 → target max+1 仍墓碑；source 不变
  const l4t = row(db, L4, T);
  assert.equal(l4t.version, 9); assert.ok(l4t.deleted_at);
  assert.equal(row(db, L4, S).version, 8);
  // L5：新建 target 取 source state/note/position，version=S+1；source 墓碑 +1
  const l5t = row(db, L5, T); const l5s = row(db, L5, S);
  assert.equal(l5t.version, 4); assert.equal(l5t.deleted_at, null);
  assert.equal(l5t.state, "imported"); assert.equal(l5t.note, "s5"); assert.equal(l5t.position, 7);
  assert.equal(l5s.version, 4); assert.equal(l5s.deleted_at, NOW);
  // L6：不建 target；source 墓碑不变
  assert.equal(row(db, L6, T), undefined);
  assert.equal(row(db, L6, S).version, 6);
  // L7/L8/L9：字节不变（version/position/updated_at 都不碰）
  assert.equal(JSON.stringify(row(db, L7, T)), l7);
  assert.equal(JSON.stringify(row(db, L8, T)), l8);
  assert.equal(JSON.stringify(row(db, L9, X)), l9);
  // 不写 items、不改 key、不物理删行
  assert.equal(JSON.stringify(db.prepare("SELECT * FROM items ORDER BY id").all()), itemsBefore);
  assert.equal((db.prepare("SELECT COUNT(*) n FROM loadout_items WHERE item_id=?").get(S) as any).n, 6);
  assert.equal((db.prepare("SELECT COUNT(*) n FROM loadout_items WHERE item_id=?").get(T) as any).n, 7);
  assert.equal((db.prepare("SELECT COUNT(*) n FROM loadout_items WHERE loadout_id=?").get(L5) as any).n, 2);
  // 成员增删不 bump loadouts.version
  assert.deepEqual((db.prepare("SELECT DISTINCT version FROM loadouts").all() as any[]).map((x) => x.version), [1]);

  // 审计：5 个已列格各一条；target 活跃+source 墓碑（L3）与 target-only（L7/L8）不写
  const a = audits(db);
  assert.deepEqual(a.map((x) => x.action), [
    "loadout.merge_conflict", "loadout.merge_revive", "loadout.merge_both_tombstone", "loadout.merge_move", "loadout.merge_noop",
  ]);
  for (const x of a) { assert.equal(x.entity, "loadout"); assert.equal(x.at, NOW); }
  assert.equal(a[0].entity_id, String(L1));
  const cb = JSON.parse(a[0].before_json); const ca = JSON.parse(a[0].after_json);
  assert.equal(cb.target.version, 2); assert.equal(cb.source.version, 5);
  assert.equal(ca.target.version, 6); assert.equal(ca.source.version, 6);
  assert.equal(ca.source.deletedAt, NOW);
  assert.equal(JSON.parse(a[4].before_json).target, null); // L6：target 无行
  assert.ok(!a.some((x) => [L3, L7, L8].map(String).includes(x.entity_id)));
  t.close();
});

test("CAS/ABA：合并后两端旧 version 均被拒；source 重加不复位；key 不移动", () => {
  const t = openTempDb(); const db = t.db; const repo = new Repo(db);
  const av = addAvatar(db, "A"); const S = addItem(db, { title: "S" }); const T = addItem(db, { title: "T" });
  const L = mkLoadout(db, av, "L");
  put(db, L, T, { version: 2, position: 0 });
  put(db, L, S, { version: 5, state: "verified", note: "s", position: 1 });
  mergeLoadoutItemsTx(db, S, T, NOW);
  // 旧 target version 2 → 409；新 6 可用
  assert.throws(() => patchLoadoutItem(repo, L, T, { state: "imported", expectedVersion: 2 }), isCode("CONFLICT"));
  assert.equal(patchLoadoutItem(repo, L, T, { state: "imported", expectedVersion: 6 }).version, 7);
  // source 已墓碑：旧 version 5 视为不存在（404），不覆盖
  assert.throws(() => patchLoadoutItem(repo, L, S, { state: "planned", expectedVersion: 5 }), isCode("NOT_FOUND"));
  // 重加 source：version=6+1=7，不复位到 1
  const back = addLoadoutItems(repo, L, { itemIds: [S] });
  assert.equal(back.revived, 1);
  assert.equal(back.items[0].version, 7);
  // 重加后旧 version 5/6 仍 409（ABA）
  assert.throws(() => patchLoadoutItem(repo, L, S, { state: "planned", expectedVersion: 5 }), isCode("CONFLICT"));
  assert.throws(() => patchLoadoutItem(repo, L, S, { state: "planned", expectedVersion: 6 }), isCode("CONFLICT"));
  // key 未移动、行未物理删除
  assert.ok(row(db, L, S)); assert.ok(row(db, L, T));
  assert.equal((db.prepare("SELECT COUNT(*) n FROM loadout_items WHERE loadout_id=?").get(L) as any).n, 2);
  // source === target 是未定义格：拒绝而不是自合并
  assert.throws(() => mergeLoadoutItemsTx(db, S, S, NOW), isCode("INVALID_INPUT"));
  t.close();
});

test("CAS 0 行 → 409 且不覆盖：target 侧与 source 侧各一次（RAISE(IGNORE) 合成触发器）", () => {
  const t = openTempDb(); const db = t.db;
  const av = addAvatar(db, "A"); const S = addItem(db, { title: "S" }); const T = addItem(db, { title: "T" });
  const L = mkLoadout(db, av, "L");
  put(db, L, T, { version: 2, position: 0 });
  put(db, L, S, { version: 5, position: 1 });
  // target 的 CAS 更新被跳过 → changes=0 → 409，整笔回滚（source 仍活跃）
  db.exec(`CREATE TRIGGER t3_skip_target BEFORE UPDATE ON loadout_items WHEN NEW.item_id=${T} AND NEW.version=6 BEGIN SELECT RAISE(IGNORE); END;`);
  assert.throws(() => mergeLoadoutItemsTx(db, S, T, NOW), isCode("CONFLICT"));
  assert.equal(row(db, L, T).version, 2); assert.equal(row(db, L, T).deleted_at, null);
  assert.equal(row(db, L, S).version, 5); assert.equal(row(db, L, S).deleted_at, null);
  assert.equal(audits(db).length, 0);
  db.exec("DROP TRIGGER t3_skip_target");
  // source 的墓碑 CAS 被跳过 → 409，target 已做的更新回滚
  db.exec(`CREATE TRIGGER t3_skip_source BEFORE UPDATE ON loadout_items WHEN NEW.item_id=${S} AND NEW.deleted_at IS NOT NULL BEGIN SELECT RAISE(IGNORE); END;`);
  assert.throws(() => mergeLoadoutItemsTx(db, S, T, NOW), isCode("CONFLICT"));
  assert.equal(row(db, L, T).version, 2);
  assert.equal(row(db, L, S).version, 5); assert.equal(row(db, L, S).deleted_at, null);
  assert.equal(audits(db).length, 0);
  db.exec("DROP TRIGGER t3_skip_source");
  // 去掉触发器后同一调用成功
  assert.equal(mergeLoadoutItemsTx(db, S, T, NOW).conflicts, 1);
  assert.equal(row(db, L, T).version, 6);
  t.close();
});

test("审计与业务同事务：audit 写入失败 → 业务更新整体回滚", () => {
  const t = openTempDb(); const db = t.db;
  const av = addAvatar(db, "A"); const S = addItem(db, { title: "S" }); const T = addItem(db, { title: "T" });
  const L = mkLoadout(db, av, "L");
  put(db, L, T, { version: 2, position: 0 });
  put(db, L, S, { version: 5, position: 1 });
  db.exec("CREATE TRIGGER t3_no_audit BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT,'t3 synthetic audit failure'); END;");
  assert.throws(() => mergeLoadoutItemsTx(db, S, T, NOW), /t3 synthetic audit failure/);
  assert.equal(row(db, L, T).version, 2); assert.equal(row(db, L, T).deleted_at, null);
  assert.equal(row(db, L, S).version, 5); assert.equal(row(db, L, S).deleted_at, null);
  assert.equal(audits(db).length, 0);
  db.exec("DROP TRIGGER t3_no_audit");
  assert.equal(mergeLoadoutItemsTx(db, S, T, NOW).conflicts, 1);
  assert.equal(audits(db).length, 1);
  t.close();
});

test("可与调用者外事务组合：外事务回滚带走 helper 写入（同连接 savepoint 证据，非多连接并发证明）", () => {
  const t = openTempDb(); const db = t.db;
  const av = addAvatar(db, "A"); const S = addItem(db, { title: "S" }); const T = addItem(db, { title: "T" });
  const L = mkLoadout(db, av, "L");
  put(db, L, T, { version: 2, position: 0 });
  put(db, L, S, { version: 5, position: 1 });
  const outer = db.transaction(() => { mergeLoadoutItemsTx(db, S, T, NOW); throw new Error("outer abort"); });
  assert.throws(() => outer(), /outer abort/);
  assert.equal(row(db, L, T).version, 2); assert.equal(row(db, L, S).deleted_at, null);
  assert.equal(audits(db).length, 0);
  // 外事务提交时 helper 写入随之落库
  db.transaction(() => { mergeLoadoutItemsTx(db, S, T, NOW); })();
  assert.equal(row(db, L, T).version, 6);
  assert.equal(audits(db).length, 1);
  t.close();
});
