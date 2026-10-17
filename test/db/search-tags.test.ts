/**
 * 搜索命中标签（v3.1）。
 *
 * 需求：去掉"按标签单独筛选"，标签改为**搜索自动命中**（搜"哥特风"就能找到带该标签的素材）。
 * 实现：items_fts.tags_text 已随标签变更同步；≥3 字符走 FTS(trigram)，<3 字符回退 LIKE 时
 * 也必须把 tags.name 算进去（否则 2 字标签搜不到）。
 * 本测试用**标题里不含标签名**的数据，确保命中只可能来自标签。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { migrate } from "../../apps/server/src/db/migrate";
import { Repo } from "../../apps/server/src/db/repo";

const fresh = () => { const db = new Database(":memory:"); db.pragma("foreign_keys = ON"); migrate(db); return { db, repo: new Repo(db) }; };

describe("搜索命中标签", () => {
  test("≥3 字符标签走 FTS；2 字符标签走 LIKE；标题不含标签名也能命中", () => {
    const { db, repo } = fresh();
    const a = repo.createItem({ title: "连衣裙 A" }).id;
    const b = repo.createItem({ title: "发饰 B" }).id;
    repo.setItemTags(a, ["哥特风格", "黑色"], "manual");
    repo.setItemTags(b, ["可爱风"], "manual");

    assert.equal(repo.listItems({ q: "哥特风格" }).total, 1, "4 字标签应命中（FTS tags_text）");
    assert.equal(repo.listItems({ q: "黑色" }).total, 1, "2 字标签应命中（LIKE tags）");
    assert.equal(repo.listItems({ q: "可爱风" }).total, 1, "3 字标签应命中（FTS）");
    assert.equal(repo.listItems({ q: "可爱" }).total, 1, "2 字前缀应命中（LIKE tags）");

    assert.equal(repo.listItems({ q: "粉色" }).total, 0, "不存在的标签不应命中");
    assert.equal(repo.listItems({ q: "连衣裙" }).total, 1, "标题搜索仍然有效");
    db.close();
  });

  test("改标签后搜索立即跟上（tags_text 同步），移除标签后不再命中", () => {
    const { db, repo } = fresh();
    const id = repo.createItem({ title: "无标签素材" }).id;
    assert.equal(repo.listItems({ q: "赛博风" }).total, 0);
    repo.attachTags(id, ["赛博风"], "manual");
    assert.equal(repo.listItems({ q: "赛博风" }).total, 1, "加标签后应能搜到");
    repo.setItemTags(id, [], "manual");
    assert.equal(repo.listItems({ q: "赛博风" }).total, 0, "移除标签后应搜不到");
    db.close();
  });

  test("标签与其它筛选可组合（关键词 + 分类 + 标签）", () => {
    const { db, repo } = fresh();
    const a = repo.createItem({ title: "素材 X" }).id;
    const b = repo.createItem({ title: "素材 Y" }).id;
    repo.setItemTags(a, ["免费"], "manual");
    repo.setItemTags(b, ["免费"], "manual");
    repo.setItemCategory(a, { categoryId: "clothing.tops", source: "manual" });
    repo.setItemCategory(b, { categoryId: "shaders.general", source: "manual" });
    assert.equal(repo.listItems({ q: "免费" }).total, 2);
    assert.equal(repo.listItems({ q: "免费", categoryIds: ["clothing"] }).total, 1, "标签 + 分类组合应只剩一条");
    db.close();
  });
});
