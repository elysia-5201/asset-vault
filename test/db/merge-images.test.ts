/**
 * FIX-08（task-36）：合并条目后删除缩略图触发 FK constraint
 * 四例（FK ON）：target 无封面合并继承、target 有封面合并、历史脏数据跨条目引用、普通删除封面。
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { openTempDb, addItem, addRoot, type TempDb } from "../schema/_db";
import { Repo } from "../../apps/server/src/db/repo";

let t: TempDb; let repo: Repo; let rootId: number;
beforeEach(() => { t = openTempDb(); repo = new Repo(t.db); rootId = addRoot(t.db, "/lib"); });
afterEach(() => t.close());

const coverOf = (itemId: number) => (t.db.prepare("SELECT cover_image_id c FROM items WHERE id=?").get(itemId) as any).c as number | null;
const imageCount = (itemId: number) => (t.db.prepare("SELECT COUNT(*) c FROM item_images WHERE item_id=?").get(itemId) as any).c as number;
const imageExists = (id: number) => !!t.db.prepare("SELECT 1 x FROM item_images WHERE id=?").get(id);

describe("mergeItems 后的封面引用（FK ON）", () => {
  test("例1：target 无封面 → 继承 source 封面；source.cover 清空；删除该图成功", () => {
    const target = addItem(t.db, { title: "target" });
    const source = addItem(t.db, { title: "source" });
    const sImg = repo.addImage(source, { role: "cover", origin: "booth" }).id;
    assert.equal(coverOf(source), sImg);
    const r = repo.mergeItems(source, target);
    assert.equal(r.movedImages, 1);
    assert.equal(coverOf(target), sImg, "目标无封面时借用来源封面");
    assert.equal(coverOf(source), null, "来源封面必须清空，否则仍引用已迁走的图");
    assert.equal(imageCount(source), 0);
    repo.deleteImage(target, sImg);
    assert.equal(imageExists(sImg), false);
    assert.equal(coverOf(target), null);
  });

  test("例2：target 已有封面 → 保留 target 封面；source.cover 清空；删除来源图成功", () => {
    const target = addItem(t.db, { title: "target" });
    const source = addItem(t.db, { title: "source" });
    const tImg = repo.addImage(target, { role: "cover", origin: "booth" }).id;
    const sImg = repo.addImage(source, { role: "cover", origin: "booth" }).id;
    repo.mergeItems(source, target);
    assert.equal(coverOf(target), tImg, "目标已有封面不应被覆盖");
    assert.equal(coverOf(source), null);
    assert.equal(imageCount(target), 2, "两张图都归 target");
    repo.deleteImage(target, sImg);
    assert.equal(imageExists(sImg), false);
    assert.equal(coverOf(target), tImg, "删非封面图不影响封面");
  });
});

describe("deleteImage 清理所有引用（历史脏数据）", () => {
  test("例3：别的条目仍把该图当封面 → 先清所有引用再删，不触发 RESTRICT", () => {
    const owner = addItem(t.db, { title: "owner" });
    const dirty = addItem(t.db, { title: "dirty" });
    const img = repo.addImage(owner, { role: "cover", origin: "booth" }).id;
    // 模拟历史脏数据：dirty 的 cover 指向 owner 的图（schema 允许该引用）
    t.db.prepare("UPDATE items SET cover_image_id=? WHERE id=?").run(img, dirty);
    assert.equal(coverOf(dirty), img);
    repo.deleteImage(owner, img);
    assert.equal(imageExists(img), false);
    assert.equal(coverOf(dirty), null, "所有引用都必须清空");
    assert.equal(coverOf(owner), null);
  });

  test("例4：普通删除自己的封面图（无外部引用）仍正常", () => {
    const item = addItem(t.db, { title: "normal" });
    const img = repo.addImage(item, { role: "cover", origin: "booth" }).id;
    repo.deleteImage(item, img);
    assert.equal(imageExists(img), false);
    assert.equal(coverOf(item), null);
  });
});
