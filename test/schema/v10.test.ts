import { test } from "node:test";
import assert from "node:assert/strict";
import { openTempDb, expectConstraint, addRoot, addItem, addAsset, count, NOW } from "./_db";
import { migrate, SCHEMA_VERSION } from "../../apps/server/src/db/migrate";

const NEW_TABLES = ["loadout_items","loadouts","cleanup_ignores","cleanup_saved_filters","asset_version_links","import_stage_commits"];

test("v9 → v10 幂等迁移，既有行数不变", () => {
  const t = openTempDb();
  const rootId = addRoot(t.db, "/lib");
  const itemId = addItem(t.db, { title: "keep" });
  addAsset(t.db, itemId, rootId, "/lib/a.zip");
  for (const tbl of NEW_TABLES) t.db.exec("DROP TABLE " + tbl);
  t.db.prepare("INSERT INTO schema_meta(key,value) VALUES('version','9') ON CONFLICT(key) DO UPDATE SET value='9'").run();
  const before = { items: count(t.db, "items"), assets: count(t.db, "assets") };
  migrate(t.db);
  assert.ok(SCHEMA_VERSION >= 10);
  assert.equal((t.db.prepare("SELECT value FROM schema_meta WHERE key='version'").get() as any).value, String(SCHEMA_VERSION));
  for (const tbl of NEW_TABLES) assert.equal(count(t.db, "sqlite_master", "type='table' AND name=?", tbl), 1, tbl);
  assert.deepEqual({ items: count(t.db, "items"), assets: count(t.db, "assets") }, before);
  migrate(t.db);
  assert.deepEqual({ items: count(t.db, "items"), assets: count(t.db, "assets") }, before);
  t.close();
});

test("跨 item 版本关系被触发器拒绝", () => {
  const t = openTempDb();
  const rootId = addRoot(t.db, "/lib");
  const a = addItem(t.db, { title: "A" }); const b = addItem(t.db, { title: "B" });
  const a1 = addAsset(t.db, a, rootId, "/lib/a1.zip"); const b1 = addAsset(t.db, b, rootId, "/lib/b1.zip");
  const e = expectConstraint(() => t.db.prepare("INSERT INTO asset_version_links(item_id,asset_a_id,asset_b_id,relation,basis,state,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)").run(a, a1, b1, "same", "manual", "candidate", 1, NOW, NOW));
  assert.match(e.message, /both assets must belong to item_id/);
  assert.equal(count(t.db, "asset_version_links"), 0);
  t.close();
});

test("CHECK / UNIQUE / CASCADE 成对成立", () => {
  const t = openTempDb();
  const rootId = addRoot(t.db, "/lib"); const a = addItem(t.db, { title: "A" });
  const a1 = addAsset(t.db, a, rootId, "/lib/1.zip"); const a2 = addAsset(t.db, a, rootId, "/lib/2.zip");
  const ins = (rel: string, x: number, y: number) => t.db.prepare("INSERT INTO asset_version_links(item_id,asset_a_id,asset_b_id,relation,basis,state,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)").run(a, x, y, rel, "manual", "candidate", 1, NOW, NOW);
  expectConstraint(() => ins("bogus", a1, a2), "CHECK");
  expectConstraint(() => ins("same", a2, a1), "CHECK");
  ins("same", a1, a2);
  expectConstraint(() => ins("same", a1, a2), "UNIQUE");
  t.db.prepare("DELETE FROM assets WHERE id=?").run(a2);
  assert.equal(count(t.db, "asset_version_links"), 0);
  t.close();
});
