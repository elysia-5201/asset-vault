import { test } from "node:test";
import assert from "node:assert/strict";
import { openTempDb, addRoot, addItem, addAsset, count, NOW } from "../schema/_db";
import { Repo } from "../../apps/server/src/db/repo";

test("非 merge 改 owner 被拒；merge 迁移关系并保留 id/state/version", () => {
  const t = openTempDb(); const repo = new Repo(t.db);
  assert.equal(repo.connection, t.db);
  const rootId = addRoot(t.db, "/lib");
  const A = addItem(t.db, { title: "A" }); const B = addItem(t.db, { title: "B" });
  const a1 = addAsset(t.db, A, rootId, "/lib/a1.zip"); const a2 = addAsset(t.db, A, rootId, "/lib/a2.zip");
  t.db.prepare("INSERT INTO asset_version_links(item_id,asset_a_id,asset_b_id,relation,basis,state,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)").run(A, a1, a2, "same", "manual", "confirmed", 3, NOW, NOW);
  const before = t.db.prepare("SELECT * FROM asset_version_links").get() as any;
  assert.throws(() => repo.upsertAsset({ item_id: B, kind: "archive", container: "zip", path: "/lib/a1.zip", path_norm: "/lib/a1.zip", root_id: rootId, size: 1, mtime: NOW, discovered_by: "manual" }), (e: any) => e.code === "CONFLICT" && e.details?.code === "ASSET_HAS_VERSION_LINKS");
  assert.equal((t.db.prepare("SELECT item_id FROM assets WHERE id=?").get(a1) as any).item_id, A);
  repo.mergeItems(A, B);
  const after = t.db.prepare("SELECT * FROM asset_version_links").get() as any;
  assert.equal(after.item_id, B); assert.equal(after.id, before.id);
  assert.equal(after.state, "confirmed"); assert.equal(after.version, 3);
  assert.equal(count(t.db, "asset_version_links"), 1);
  const audits = t.db.prepare("SELECT * FROM audit_log WHERE action='merge.version_links_moved'").all() as any[];
  assert.equal(audits.length, 1);
  assert.equal(audits[0].entity, "item");
  assert.equal(audits[0].entity_id, String(B));
  assert.deepEqual(JSON.parse(audits[0].before_json), { sourceItemId: A });
  assert.deepEqual(JSON.parse(audits[0].after_json), { links: 1 });
  t.close();
});

test("事务末断言失败 → 资产与关系全回滚", () => {
  const t = openTempDb(); const repo = new Repo(t.db);
  const rootId = addRoot(t.db, "/lib");
  const A = addItem(t.db, { title: "A" }); const B = addItem(t.db, { title: "B" });
  const a1 = addAsset(t.db, A, rootId, "/lib/a1.zip"); const a2 = addAsset(t.db, A, rootId, "/lib/a2.zip");
  t.db.prepare("INSERT INTO asset_version_links(item_id,asset_a_id,asset_b_id,relation,basis,state,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)").run(A, a1, a2, "same", "manual", "candidate", 1, NOW, NOW);
  const orig = repo.moveAssetsAndVersionLinksTx.bind(repo);
  (repo as any).moveAssetsAndVersionLinksTx = () => { t.db.prepare("UPDATE assets SET item_id=? WHERE item_id=?").run(B, A); return { assets: 2, links: 0 }; };
  assert.throws(() => repo.mergeItems(A, B), /归属不一致/);
  assert.equal((t.db.prepare("SELECT item_id FROM assets WHERE id=?").get(a1) as any).item_id, A);
  assert.equal((t.db.prepare("SELECT item_id FROM asset_version_links").get() as any).item_id, A);
  assert.equal(count(t.db, "audit_log", "action=?", "merge.version_links_moved"), 0);
  (repo as any).moveAssetsAndVersionLinksTx = orig;
  t.close();
});
