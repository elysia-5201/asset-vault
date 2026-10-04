/**
 * ③ 数据模型约束测试（verifier / task-4）
 *
 * 被测：apps/server/src/db/schema.sql（FROZEN，verifier 只读）
 * 方法：better-sqlite3 在临时目录建真实库 → db.exec(schema.sql) → 逐条断言
 *       每条约束都成对断言：**必须通过的正例** + **必须失败的负例**（防"约束其实不存在"的假绿）。
 * 覆盖：局部唯一索引 / 复合主键 / IFNULL 前缀唯一 / 外键 CASCADE 与 RESTRICT。
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { openTempDb, expectConstraint, expectOk, addRoot, addItem, addAsset, addAvatar, addImage, addJob, count, NOW, type TempDb } from "./_db";

let t: TempDb;
let rootId: number;

before(() => { t = openTempDb(); rootId = addRoot(t.db, "<win-drive>/game/vratchache/素材库"); });
after(() => t.close());

describe("items(source_site, source_item_id) 局部唯一", () => {
  test("正例：同一 site 下 source_item_id = NULL 可多行（NULL 不参与唯一）", () => {
    expectOk(() => addItem(t.db, { source_site: "local", source_item_id: null, uid: "u-null-1" }));
    expectOk(() => addItem(t.db, { source_site: "local", source_item_id: null, uid: "u-null-2" }));
    expectOk(() => addItem(t.db, { source_site: "booth", source_item_id: null, uid: "u-null-3" }));
    assert.equal(count(t.db, "items", "source_item_id IS NULL"), 3);
  });

  test("负例：重复 (source_site, source_item_id) 必须被拒", () => {
    addItem(t.db, { source_site: "booth", source_item_id: "6115428", uid: "u-dup-a" });
    const e = expectConstraint(() => addItem(t.db, { source_site: "booth", source_item_id: "6115428", uid: "u-dup-b" }), "UNIQUE");
    assert.match(e.message, /items\.source_site, items\.source_item_id|ux_items_source/);
  });

  test("正例：同号不同 site 允许（site 是键的一部分）", () => {
    expectOk(() => addItem(t.db, { source_site: "gumroad", source_item_id: "6115428", uid: "u-other-site" }));
  });

  test("负例：uid 全局唯一（旁证唯一索引不是只对某一列失效）", () => {
    addItem(t.db, { uid: "u-uidunique", source_item_id: "1001" });
    expectConstraint(() => addItem(t.db, { uid: "u-uidunique", source_item_id: "1002" }), "UNIQUE");
  });
});

describe("assets.path_norm 全局唯一", () => {
  test("正例：不同 path_norm 可多行；负例：重复 path_norm 必须被拒", () => {
    const itemId = addItem(t.db, { uid: "u-asset-owner", source_item_id: "2001" });
    const a1 = addAsset(t.db, itemId, rootId, "<win-drive>/lib/a.zip");
    const a2 = expectOk(() => addAsset(t.db, itemId, rootId, "<win-drive>/lib/b.zip"));
    assert.notEqual(a1, a2);
    const e = expectConstraint(() => addAsset(t.db, itemId, rootId, "<win-drive>/lib/a.zip"), "UNIQUE");
    assert.match(e.message, /path_norm/);
  });

  test("负例：外键 root_id 无效必须被拒（正例见上一条用真实 root）", () => {
    const itemId = addItem(t.db, { uid: "u-asset-fk", source_item_id: "2002" });
    expectConstraint(() => addAsset(t.db, itemId, 999999, "<win-drive>/lib/fk.zip"), "FOREIGNKEY");
  });

  test("负例：item_id 无效必须被拒", () => {
    expectConstraint(() => addAsset(t.db, 999999, rootId, "<win-drive>/lib/nofk.zip"), "FOREIGNKEY");
  });
});

describe("jobs 在飞局部唯一（done/failed 后可再建同 kind）", () => {
  test("负例：同 item 同 kind 两个在飞作业必须被拒", () => {
    const itemId = addItem(t.db, { uid: "u-job-1", source_item_id: "3001" });
    addJob(t.db, itemId, "scan", "queued");
    const e = expectConstraint(() => addJob(t.db, itemId, "scan", "resolving"), "UNIQUE");
    assert.match(e.message, /ux_jobs_inflight|jobs\.item_id, jobs\.kind/);
  });

  test("正例：前一个作业 done 后，可再建同 (item, kind)", () => {
    const itemId = addItem(t.db, { uid: "u-job-2", source_item_id: "3002" });
    const first = addJob(t.db, itemId, "scan", "queued");
    t.db.prepare("UPDATE jobs SET state='done', finished_at=? WHERE id=?").run(NOW, first);
    expectOk(() => addJob(t.db, itemId, "scan", "queued"));
  });

  test("正例：failed 不在在飞集合内（可再建同 kind）", () => {
    const itemId = addItem(t.db, { uid: "u-job-3", source_item_id: "3003" });
    const first = addJob(t.db, itemId, "import_url", "queued");
    t.db.prepare("UPDATE jobs SET state='failed' WHERE id=?").run(first);
    expectOk(() => addJob(t.db, itemId, "import_url", "queued"));
  });

  test("负例：paused 属于在飞集合（第二个同 kind 必须被拒）", () => {
    const itemId = addItem(t.db, { uid: "u-job-4", source_item_id: "3004" });
    const first = addJob(t.db, itemId, "reindex", "queued");
    t.db.prepare("UPDATE jobs SET state='paused' WHERE id=?").run(first);
    expectConstraint(() => addJob(t.db, itemId, "reindex", "queued"), "UNIQUE");
  });

  test("正例：item_id 为 NULL 时不受局部索引限制（可多行）", () => {
    expectOk(() => addJob(t.db, null, "scan", "queued"));
    expectOk(() => addJob(t.db, null, "scan", "queued"));
    assert.equal(count(t.db, "jobs", "item_id IS NULL AND kind='scan'"), 2);
  });

  test("正例：同 item 不同 kind 可以同时在飞", () => {
    const itemId = addItem(t.db, { uid: "u-job-5", source_item_id: "3005" });
    expectOk(() => addJob(t.db, itemId, "download", "queued"));
    expectOk(() => addJob(t.db, itemId, "check_update", "queued"));
  });

  test("边界：在飞索引覆盖全部 9 个在飞状态（queued..paused），不含终态", () => {
    const inflight = ["queued", "resolving", "fetching", "materializing", "indexing", "matching", "releasing", "releasing_done", "paused"];
    for (const st of inflight) {
      const itemId = addItem(t.db, { uid: "u-job-st-" + st, source_item_id: "31" + st });
      addJob(t.db, itemId, "scan", st);
      expectConstraint(() => addJob(t.db, itemId, "scan", "queued"), "UNIQUE");
    }
    for (const st of ["done", "failed", "cancelled", "abandoned"]) {
      const itemId = addItem(t.db, { uid: "u-job-term-" + st, source_item_id: "32" + st });
      addJob(t.db, itemId, "scan", st);
      expectOk(() => addJob(t.db, itemId, "scan", "queued"));
    }
  });
});

describe("item_avatars 复合主键 / asset_avatars IFNULL 前缀唯一", () => {
  test("负例：item_avatars (item_id, avatar_id) 重复必须被拒；正例：同 item 不同 avatar 允许", () => {
    const itemId = addItem(t.db, { uid: "u-ia", source_item_id: "4001" });
    const av1 = addAvatar(t.db, "Manuka");
    const av2 = addAvatar(t.db, "Shinano");
    t.db.prepare("INSERT INTO item_avatars(item_id, avatar_id) VALUES (?,?)").run(itemId, av1);
    expectConstraint(() => t.db.prepare("INSERT INTO item_avatars(item_id, avatar_id) VALUES (?,?)").run(itemId, av1), "PRIMARYKEY");
    expectOk(() => t.db.prepare("INSERT INTO item_avatars(item_id, avatar_id) VALUES (?,?)").run(itemId, av2));
    assert.equal(count(t.db, "item_avatars", "item_id=?", itemId), 2);
  });

  test("负例：asset_avatars 同 (asset,avatar,NULL) 重复必须被拒", () => {
    const itemId = addItem(t.db, { uid: "u-aa", source_item_id: "4002" });
    const assetId = addAsset(t.db, itemId, rootId, "<win-drive>/lib/aa.zip");
    const av = addAvatar(t.db, "Milfy");
    t.db.prepare("INSERT INTO asset_avatars(asset_id, avatar_id, entry_prefix) VALUES (?,?,NULL)").run(assetId, av);
    expectConstraint(() => t.db.prepare("INSERT INTO asset_avatars(asset_id, avatar_id, entry_prefix) VALUES (?,?,NULL)").run(assetId, av), "UNIQUE");
  });

  test("边界（IFNULL 语义）：NULL 与 '' 视为同一个前缀，必须冲突", () => {
    const itemId = addItem(t.db, { uid: "u-aa2", source_item_id: "4003" });
    const assetId = addAsset(t.db, itemId, rootId, "<win-drive>/lib/aa2.zip");
    const av = addAvatar(t.db, "Manuka2");
    t.db.prepare("INSERT INTO asset_avatars(asset_id, avatar_id, entry_prefix) VALUES (?,?,NULL)").run(assetId, av);
    expectConstraint(() => t.db.prepare("INSERT INTO asset_avatars(asset_id, avatar_id, entry_prefix) VALUES (?,?,?)").run(assetId, av, ""), "UNIQUE");
  });

  test("正例：同 (asset,avatar) 不同非空前缀允许；同前缀重复被拒", () => {
    const itemId = addItem(t.db, { uid: "u-aa3", source_item_id: "4004" });
    const assetId = addAsset(t.db, itemId, rootId, "<win-drive>/lib/aa3.zip");
    const av = addAvatar(t.db, "Shinano2");
    t.db.prepare("INSERT INTO asset_avatars(asset_id, avatar_id, entry_prefix) VALUES (?,?,?)").run(assetId, av, "Assets/Manuka");
    expectOk(() => t.db.prepare("INSERT INTO asset_avatars(asset_id, avatar_id, entry_prefix) VALUES (?,?,?)").run(assetId, av, "Assets/Shinano"));
    expectConstraint(() => t.db.prepare("INSERT INTO asset_avatars(asset_id, avatar_id, entry_prefix) VALUES (?,?,?)").run(assetId, av, "Assets/Manuka"), "UNIQUE");
    assert.equal(count(t.db, "asset_avatars", "asset_id=?", assetId), 2);
  });

  test("旁证：tags(IFNULL(namespace,''), name) 与 item_tags 复合主键同口径", () => {
    const a = t.db.prepare("INSERT INTO tags(name, namespace) VALUES (?,NULL)").run("衣装").lastInsertRowid;
    expectConstraint(() => t.db.prepare("INSERT INTO tags(name, namespace) VALUES (?,?)").run("衣装", ""), "UNIQUE");
    const b = t.db.prepare("INSERT INTO tags(name, namespace) VALUES (?,?)").run("衣装", "booth").lastInsertRowid;
    assert.notEqual(a, b);
    const itemId = addItem(t.db, { uid: "u-tags", source_item_id: "4005" });
    t.db.prepare("INSERT INTO item_tags(item_id, tag_id) VALUES (?,?)").run(itemId, a);
    expectConstraint(() => t.db.prepare("INSERT INTO item_tags(item_id, tag_id) VALUES (?,?)").run(itemId, a), "PRIMARYKEY");
    expectOk(() => t.db.prepare("INSERT INTO item_tags(item_id, tag_id) VALUES (?,?)").run(itemId, b));
  });
});

describe("外键 CASCADE", () => {
  test("删除 item → images/assets/jobs/item_avatars/archive_entries/job_events/asset_avatars/source_snapshots 全清", () => {
    const itemId = addItem(t.db, { uid: "u-cascade", source_item_id: "5001" });
    const assetId = addAsset(t.db, itemId, rootId, "<win-drive>/lib/cascade.zip");
    const av = addAvatar(t.db, "CascadeAvatar");
    addImage(t.db, itemId);
    addJob(t.db, itemId, "scan", "queued");
    t.db.prepare("INSERT INTO item_avatars(item_id, avatar_id) VALUES (?,?)").run(itemId, av);
    t.db.prepare("INSERT INTO asset_avatars(asset_id, avatar_id) VALUES (?,?)").run(assetId, av);
    t.db.prepare("INSERT INTO archive_entries(asset_id, entry_path) VALUES (?,?)").run(assetId, "Assets/x.prefab");
    t.db.prepare("INSERT INTO source_snapshots(item_id, captured_at, provider) VALUES (?,?,?)").run(itemId, NOW, "booth");
    const jobId = Number((t.db.prepare("SELECT id FROM jobs WHERE item_id=?").get(itemId) as { id: number }).id);
    t.db.prepare("INSERT INTO job_events(job_id, at, to_state, event) VALUES (?,?,?,?)").run(jobId, NOW, "queued", "create");
    // 正例对照：删除前都是非零
    for (const [tbl, where, arg] of [
      ["item_images", "item_id=?", itemId], ["assets", "item_id=?", itemId], ["jobs", "item_id=?", itemId],
      ["item_avatars", "item_id=?", itemId], ["archive_entries", "asset_id=?", assetId],
      ["asset_avatars", "asset_id=?", assetId], ["source_snapshots", "item_id=?", itemId], ["job_events", "job_id=?", jobId],
    ] as const) {
      assert.ok(count(t.db, tbl, where, arg) > 0, tbl + " 前置数据缺失");
    }
    t.db.prepare("DELETE FROM items WHERE id=?").run(itemId);
    for (const [tbl, where, arg] of [
      ["item_images", "item_id=?", itemId], ["assets", "item_id=?", itemId], ["jobs", "item_id=?", itemId],
      ["item_avatars", "item_id=?", itemId], ["archive_entries", "asset_id=?", assetId],
      ["asset_avatars", "asset_id=?", assetId], ["source_snapshots", "item_id=?", itemId], ["job_events", "job_id=?", jobId],
    ] as const) {
      assert.equal(count(t.db, tbl, where, arg), 0, tbl + " 未级联删除");
    }
  });

  test("删除 avatar → item_avatars/asset_avatars/avatar_aliases 级联；正例对照删除前非零", () => {
    const itemId = addItem(t.db, { uid: "u-cascade-av", source_item_id: "5002" });
    const assetId = addAsset(t.db, itemId, rootId, "<win-drive>/lib/cascade-av.zip");
    const av = addAvatar(t.db, "CascadeAv2");
    t.db.prepare("INSERT INTO item_avatars(item_id, avatar_id) VALUES (?,?)").run(itemId, av);
    t.db.prepare("INSERT INTO asset_avatars(asset_id, avatar_id) VALUES (?,?)").run(assetId, av);
    t.db.prepare("INSERT INTO avatar_aliases(avatar_id, alias, alias_norm) VALUES (?,?,?)").run(av, "まぬか", "まぬか");
    assert.ok(count(t.db, "item_avatars", "avatar_id=?", av) > 0);
    t.db.prepare("DELETE FROM avatars WHERE id=?").run(av);
    assert.equal(count(t.db, "item_avatars", "avatar_id=?", av), 0);
    assert.equal(count(t.db, "asset_avatars", "avatar_id=?", av), 0);
    assert.equal(count(t.db, "avatar_aliases", "avatar_id=?", av), 0);
  });
});

describe("外键 RESTRICT", () => {
  test("items.cover_image_id → 删除被引用图片必须失败；置 NULL 后可删", () => {
    const itemId = addItem(t.db, { uid: "u-restrict-cover", source_item_id: "6001" });
    const imgId = addImage(t.db, itemId);
    t.db.prepare("UPDATE items SET cover_image_id=? WHERE id=?").run(imgId, itemId);
    expectConstraint(() => t.db.prepare("DELETE FROM item_images WHERE id=?").run(imgId), "FOREIGNKEY");
    t.db.prepare("UPDATE items SET cover_image_id=NULL WHERE id=?").run(itemId);
    expectOk(() => t.db.prepare("DELETE FROM item_images WHERE id=?").run(imgId));
  });

  test("assets.root_id → 删除被引用 library_root 必须失败；删掉 asset 后可删 root", () => {
    const itemId = addItem(t.db, { uid: "u-restrict-root", source_item_id: "6002" });
    const r = addRoot(t.db, "<win-drive>/restrict-root");
    const assetId = addAsset(t.db, itemId, r, "<win-drive>/restrict-root/x.zip");
    expectConstraint(() => t.db.prepare("DELETE FROM library_roots WHERE id=?").run(r), "FOREIGNKEY");
    t.db.prepare("DELETE FROM assets WHERE id=?").run(assetId);
    expectOk(() => t.db.prepare("DELETE FROM library_roots WHERE id=?").run(r));
  });

  test("project_imports.asset_id → RESTRICT；正例对照：asset_id 为 NULL 的导入可随 item 级联删", () => {
    const itemId = addItem(t.db, { uid: "u-restrict-proj", source_item_id: "6003" });
    const assetId = addAsset(t.db, itemId, rootId, "<win-drive>/lib/proj.zip");
    const projId = Number(t.db.prepare("INSERT INTO projects(name, path, path_norm, created_at) VALUES (?,?,?,?)").run("P", "/p", "/p", NOW).lastInsertRowid);
    t.db.prepare("INSERT INTO project_imports(project_id, item_id, asset_id, imported_at) VALUES (?,?,?,?)").run(projId, itemId, assetId, NOW);
    expectConstraint(() => t.db.prepare("DELETE FROM assets WHERE id=?").run(assetId), "FOREIGNKEY");
    t.db.prepare("DELETE FROM project_imports WHERE asset_id=?").run(assetId);
    expectOk(() => t.db.prepare("DELETE FROM assets WHERE id=?").run(assetId));
    // 正例：NULL asset_id 的导入记录随 item 级联消失
    const item2 = addItem(t.db, { uid: "u-restrict-proj2", source_item_id: "6004" });
    t.db.prepare("INSERT INTO project_imports(project_id, item_id, asset_id, imported_at) VALUES (?,?,NULL,?)").run(projId, item2, NOW);
    t.db.prepare("DELETE FROM items WHERE id=?").run(item2);
    assert.equal(count(t.db, "project_imports", "item_id=?", item2), 0);
  });

  test("反例缺口自证：外键 enforcement 确实打开（关掉后同一删除会成功）", () => {
    const itemId = addItem(t.db, { uid: "u-fk-off", source_item_id: "6005" });
    const imgId = addImage(t.db, itemId);
    t.db.prepare("UPDATE items SET cover_image_id=? WHERE id=?").run(imgId, itemId);
    assert.equal(String(t.db.pragma("foreign_keys", { simple: true })), "1");
    t.db.pragma("foreign_keys = OFF");
    try {
      expectOk(() => t.db.prepare("DELETE FROM item_images WHERE id=?").run(imgId)); // OFF 时能删 → 证明上一条失败来自 FK
    } finally {
      t.db.pragma("foreign_keys = ON");
    }
    t.db.prepare("UPDATE items SET cover_image_id=NULL WHERE id=?").run(itemId);
  });
});

describe("schema 自身完整性", () => {
  test("15 张核心表 + FTS5 虚拟表存在", () => {
    const tables = (t.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]).map((r) => r.name)
      .filter((n) => !n.startsWith("sqlite_") && !n.endsWith("_data") && !n.endsWith("_idx") && !n.endsWith("_content") && !n.endsWith("_docsize") && !n.endsWith("_config"));
    const expected = [
      "archive_entries", "asset_avatars", "assets", "audit_log", "avatar_aliases", "avatars", "collection_items",
      "collections", "item_avatars", "item_images", "item_tags", "items", "job_events", "jobs", "library_roots",
      "project_imports", "projects", "schema_meta", "settings", "source_snapshots", "tags", "unitypackage_assets", "updates",
    ];
    for (const e of expected) assert.ok(tables.includes(e), "缺表 " + e);
    assert.ok(tables.includes("items_fts"), "缺 FTS 表");
  });

  test("FTS5 使用 trigram 分词器；content 模式与 DDL 文本自洽（行为对照）", () => {
    const sql = String((t.db.prepare("SELECT sql FROM sqlite_master WHERE name='items_fts'").get() as { sql: string }).sql);
    assert.match(sql, /fts5/i);
    assert.match(sql, /tokenize\s*=\s*'trigram'/i);
    // 行为侧：内容存储型可读回列；contentless(content='') 读回 NULL。两者必须与 DDL 文本一致。
    t.db.prepare("INSERT INTO items_fts(rowid, title) VALUES (99, 'サンプル 見出し')").run();
    const stored = (t.db.prepare("SELECT title FROM items_fts WHERE rowid=99").get() as { title: string | null }).title;
    const declaredContentless = /content\s*=\s*''/.test(sql);
    if (declaredContentless) assert.equal(stored, null, "DDL 声明 content='' 但列可读回 → 声明与实现不一致");
    else assert.equal(stored, "サンプル 見出し", "DDL 未声明 content='' 但列读不回 → 声明与实现不一致");
    console.log("      items_fts mode (DDL vs behavior):", declaredContentless ? "contentless" : "content-storing");
    t.db.prepare("DELETE FROM items_fts WHERE rowid=99").run();
  });

  test("schema_meta/settings 主键可幂等写入（ON CONFLICT 语义的前置条件）", () => {
    t.db.prepare("INSERT INTO schema_meta(key,value) VALUES ('version','1') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
    t.db.prepare("INSERT INTO schema_meta(key,value) VALUES ('version','2') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
    assert.equal(String((t.db.prepare("SELECT value FROM schema_meta WHERE key='version'").get() as { value: string }).value), "2");
  });
});
