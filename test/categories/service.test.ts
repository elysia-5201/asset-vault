/**
 * 物品分类 — 服务层测试（applyCategoryEvidence / reclassifyCategories）
 *
 * 被测：apps/server/src/services/categories.ts（docs/categories.md §5/§6，需求 §9-11）
 * 方法：真实 better-sqlite3 :memory: + migrate + Repo；不 mock 分类器（用真实证据驱动）。
 * 覆盖：
 *  - 强证据 → auto 应用，且依据可追溯（cat_reason 里有命中词）；
 *  - 人工优先：manual 之后自动路径只写建议、绝不改归属（protected=true）；
 *  - **永不抛**（§9-11）：内部异常时返回 ok:false，不把异常抛给主流程；
 *  - reclassify 计数器互斥（applied+suggested+cleared+skipped === scanned）；
 *  - reclassify 不指定范围 → 400（不静默全库改分类）。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { migrate } from "../../apps/server/src/db/migrate";
import { Repo } from "../../apps/server/src/db/repo";
import { applyCategoryEvidence, reclassifyCategories } from "../../apps/server/src/services/categories";

function freshRepo(): Repo {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return new Repo(db);
}

describe("分类服务：应用证据与批量重跑", () => {
  test("强证据（标题 + BOOTH 分类）→ 自动应用，且依据可追溯到命中词", () => {
    const repo = freshRepo();
    const id = repo.createItem({ title: "かわいいシャツ 衣装", category_name: "衣装" }).id;
    const r = applyCategoryEvidence(repo, id);
    assert.equal(r.ok, true);
    assert.equal(r.applied, true);
    assert.equal(r.categoryId, "clothing");
    const row = repo.itemRow(id);
    assert.equal(row.cat_id, "clothing");
    assert.equal(row.cat_sub_id, "clothing.tops");
    assert.equal(row.cat_source, "auto");
    assert.match(String(row.cat_reason), /シャツ/);
    assert.ok(row.cat_evidence, "应存下结构化证据 JSON");
  });

  test("人工优先：manual 之后自动路径只写建议，归属一字不改（§6）", () => {
    const repo = freshRepo();
    const id = repo.createItem({ title: "かわいいシャツ 衣装", category_name: "衣装" }).id;
    repo.setItemCategory(id, { categoryId: "tools.unity", source: "manual" });
    const r = applyCategoryEvidence(repo, id);
    assert.equal(r.ok, true);
    assert.equal(r.applied, false);
    assert.equal(r.protected, true);
    const row = repo.itemRow(id);
    assert.equal(row.cat_id, "tools", "手动分类不得被覆盖");
    assert.equal(row.cat_sub_id, "tools.unity");
    assert.equal(row.cat_source, "manual");
    assert.equal(row.cat_suggest_id, "clothing", "冲突应记为待确认建议");
  });

  test("永不抛（§9-11）：内部异常 → ok:false，异常不冒泡到主流程", () => {
    const repo = freshRepo();
    const id = repo.createItem({ title: "シャツ" }).id;
    const logs: string[] = [];
    (repo as any).categoryDefs = () => { throw new Error("boom-categoryDefs"); };
    let r: ReturnType<typeof applyCategoryEvidence> | null = null;
    assert.doesNotThrow(() => { r = applyCategoryEvidence(repo, id, { log: (m) => logs.push(m) }); });
    assert.equal(r!.ok, false);
    assert.match(String(r!.error), /boom-categoryDefs/);
    assert.ok(logs.some((l) => l.includes("分类失败")), "失败要留日志");
    delete (repo as any).categoryDefs; // 恢复原型方法
    const after = applyCategoryEvidence(repo, id);
    assert.equal(after.ok, true, "恢复后应能继续工作");
  });

  test("reclassify：计数器互斥，且 manual 条目记 protected", () => {
    const repo = freshRepo();
    const a = repo.createItem({ title: "かわいいシャツ 衣装", category_name: "衣装" }).id;
    const b = repo.createItem({ title: "lilToon シェーダー" }).id;
    const c = repo.createItem({ title: "アセット" }).id; // 无分类证据
    repo.setItemCategory(a, { categoryId: "clothing.tops", source: "manual" });
    const res = reclassifyCategories(repo, { itemIds: [a, b, c], apply: true });
    assert.equal(res.scanned, 3);
    assert.equal(res.applied + res.suggested + res.cleared + res.skipped, res.scanned);
    const ra = res.results.find((x) => x.itemId === a)!;
    assert.equal(ra.protected, true, "manual 条目必须记 protected");
    assert.equal(ra.applied, false);
    assert.equal(repo.itemRow(a).cat_source, "manual");
    const rc = res.results.find((x) => x.itemId === c)!;
    assert.equal(rc.categoryId, null, "无证据 → 保持未分类");
    assert.equal(repo.itemRow(c).cat_id, null);
  });

  test("reclassify 不指定范围 → 400（不静默全库改分类）", () => {
    const repo = freshRepo();
    repo.createItem({ title: "シャツ" });
    assert.throws(() => reclassifyCategories(repo, {}), (e: any) => e?.status === 400);
  });
});
