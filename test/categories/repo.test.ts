/**
 * 物品分类 — Repo 层测试（setItemCategory / applyAutoCategory / 建议 / 统计 / 删除分类）
 *
 * 被测：apps/server/src/db/repo.ts 的分类方法（冻结契约，docs/categories.md §3/§6/§8）
 * 方法：better-sqlite3 :memory: + migrate()（真实 schema 与播种）+ Repo，不用桩替身。
 * 覆盖：
 *  - 归属合法化：传子分类自动归位主分类；不属于主分类的子分类被清空（不留非法关联）；
 *  - 人工优先：manual/confirmed 永不被自动路径覆盖，只写建议；
 *  - 采纳/忽略：confirmed 清建议，dismiss 只清建议；
 *  - 统计一致：categoryStats 与 listItems 的真实查询结果逐分类对齐，软删不计入；
 *  - 删除分类：有子分类拒绝；删子分类保留主分类；删主分类退回未分类。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { migrate } from "../../apps/server/src/db/migrate";
import { Repo } from "../../apps/server/src/db/repo";

const db = new Database(":memory:");
db.pragma("foreign_keys = ON");
migrate(db);
const repo = new Repo(db);

let seq = 0;
/** 造条目：走真实 createItem（含 FTS 同步）。 */
const mkItem = (title = "素材" + (++seq)): number => repo.createItem({ title }).id;
const rowOf = (id: number) => repo.itemRow(id);

/** 断言抛出带 code/status 的错误（repo 用 Object.assign 挂 code/status，由路由层转 HTTP）。 */
function expectThrows(fn: () => unknown, code: string, status: number): string {
  try { fn(); } catch (e) {
    const err = e as { code?: string; status?: number; message?: string };
    assert.equal(err.code, code, "错误 code: " + err.code + " / " + err.message);
    assert.equal(err.status, status, "错误 status: " + err.status + " / " + err.message);
    return String(err.message);
  }
  assert.fail("期望抛出 " + code + "(" + status + ")，但执行成功了");
}

describe("setItemCategory：归属合法化", () => {
  test("传子分类 ID 自动归位到主分类（cat_id=父，cat_sub_id=子）", () => {
    const id = mkItem();
    const row = repo.setItemCategory(id, { categoryId: "clothing.tops", source: "manual" });
    assert.equal(row.cat_id, "clothing");
    assert.equal(row.cat_sub_id, "clothing.tops");
    assert.equal(row.cat_source, "manual");
    assert.equal(row.cat_confidence, 1, "manual 默认置信度 1");
    assert.ok(row.cat_assigned_at, "必须记录归类时间");
  });

  test("传主分类 + 合法子分类：两层都保留", () => {
    const id = mkItem();
    const row = repo.setItemCategory(id, { categoryId: "clothing", subCategoryId: "clothing.dress", source: "manual" });
    assert.equal(row.cat_id, "clothing");
    assert.equal(row.cat_sub_id, "clothing.dress");
  });

  test("子分类不属于主分类时被清空（绝不留非法关联）", () => {
    const id = mkItem();
    const row = repo.setItemCategory(id, { categoryId: "clothing", subCategoryId: "accessories.headwear", source: "manual" });
    assert.equal(row.cat_id, "clothing", "主分类仍然生效");
    assert.equal(row.cat_sub_id, null, "非法子分类必须清空");
  });

  test("未知主分类 → INVALID_INPUT 400，且不写任何归属", () => {
    const id = mkItem();
    expectThrows(() => repo.setItemCategory(id, { categoryId: "no.such.category", source: "manual" }), "INVALID_INPUT", 400);
    assert.equal(rowOf(id).cat_id, null);
  });

  test("categoryId=null 清除归属：source/confidence/reason/evidence/assigned_at 一并清空", () => {
    const id = mkItem();
    repo.setItemCategory(id, { categoryId: "clothing.tops", source: "manual", reason: "手选", evidence: "[]" });
    const row = repo.setItemCategory(id, { categoryId: null, source: "manual" });
    assert.equal(row.cat_id, null);
    assert.equal(row.cat_sub_id, null);
    assert.equal(row.cat_source, null);
    assert.equal(row.cat_confidence, null);
    assert.equal(row.cat_reason, null);
    assert.equal(row.cat_evidence, null);
    assert.equal(row.cat_assigned_at, null);
  });

  test("用户路径（setItemCategory）同时清掉待确认建议", () => {
    const id = mkItem();
    repo.suggestItemCategory(id, { categoryId: "hair", subCategoryId: "hair.model", confidence: 0.5, reason: "自动" });
    assert.equal(rowOf(id).cat_suggest_id, "hair");
    repo.setItemCategory(id, { categoryId: "clothing", source: "manual" });
    const row = rowOf(id);
    assert.equal(row.cat_suggest_id, null);
    assert.equal(row.cat_suggest_sub_id, null);
    assert.equal(row.cat_suggest_at, null);
    assert.equal(row.cat_id, "clothing");
  });

  test("写 audit_log（用户改分类可追溯）", () => {
    const id = mkItem();
    const before = repo.listAudit(500).length;
    repo.setItemCategory(id, { categoryId: "clothing", source: "manual" });
    const audits = repo.listAudit(500);
    assert.ok(audits.length > before, "应新增一条审计");
    assert.ok(audits.some((a: any) => a.action === "item.category" && a.entity_id === String(id)));
  });
});

describe("手动分类保护：manual / confirmed 永不被自动路径覆盖（§6）", () => {
  test("manual 后 applyAutoCategory(其它分类) → applied=false、protected=true、cat_id 不变、写建议", () => {
    const id = mkItem();
    repo.setItemCategory(id, { categoryId: "clothing.tops", source: "manual" });
    const res = repo.applyAutoCategory(id, { categoryId: "hair", subCategoryId: "hair.model", confidence: 0.92, reason: "自动推断", evidence: "[]" });
    assert.deepEqual(res, { applied: false, protected: true });
    const row = rowOf(id);
    assert.equal(row.cat_id, "clothing", "手动分类不得被覆盖");
    assert.equal(row.cat_sub_id, "clothing.tops");
    assert.equal(row.cat_source, "manual");
    assert.equal(row.cat_suggest_id, "hair", "自动结果只能落为建议");
    assert.equal(row.cat_suggest_sub_id, "hair.model");
  });

  test("confirmed（采纳过建议）同样受保护", () => {
    const id = mkItem();
    repo.setItemCategory(id, { categoryId: "audio.music", source: "confirmed" });
    const res = repo.applyAutoCategory(id, { categoryId: "shaders", confidence: 0.9 });
    assert.deepEqual(res, { applied: false, protected: true });
    assert.equal(rowOf(id).cat_id, "audio", "confirmed 不得被覆盖");
    assert.equal(rowOf(id).cat_suggest_id, "shaders");
  });

  test("一致时不打扰：applyAutoCategory(相同分类) → 不写 suggestion", () => {
    const id = mkItem();
    repo.setItemCategory(id, { categoryId: "clothing.tops", source: "manual" });
    const res = repo.applyAutoCategory(id, { categoryId: "clothing", subCategoryId: "clothing.tops", confidence: 0.8 });
    assert.deepEqual(res, { applied: false, protected: true });
    const row = rowOf(id);
    assert.equal(row.cat_id, "clothing");
    assert.equal(row.cat_suggest_id, null, "与用户既有选择一致 → 不该产生打扰性的建议");
    assert.equal(row.cat_suggest_sub_id, null);
  });

  test("正对照：非用户来源（auto）可以被自动路径覆盖", () => {
    const id = mkItem();
    assert.deepEqual(repo.applyAutoCategory(id, { categoryId: "clothing", confidence: 0.8 }), { applied: true, protected: false });
    assert.equal(rowOf(id).cat_source, "auto");
    assert.deepEqual(repo.applyAutoCategory(id, { categoryId: "hair", confidence: 0.8 }), { applied: true, protected: false });
    assert.equal(rowOf(id).cat_id, "hair", "auto 归属应被更新的自动结果取代");
    assert.equal(rowOf(id).cat_suggest_id, null, "自动覆盖不写建议");
  });
});

describe("accept / dismiss：建议的写入与清理", () => {
  test("suggestItemCategory 只写建议，不动归属", () => {
    const id = mkItem();
    repo.suggestItemCategory(id, { categoryId: "hair", subCategoryId: "hair.model", confidence: 0.61, reason: "标题含「ヘアモデル」", evidence: "[{\"rule\":\"hair.model\"}]" });
    const row = rowOf(id);
    assert.equal(row.cat_id, null, "建议不得改变归属");
    assert.equal(row.cat_suggest_id, "hair");
    assert.equal(row.cat_suggest_sub_id, "hair.model");
    assert.equal(row.cat_suggest_confidence, 0.61);
    assert.equal(row.cat_suggest_reason, "标题含「ヘアモデル」");
    assert.ok(row.cat_suggest_at);
  });

  test("采纳：setItemCategory(source='confirmed') 清建议并落地归属", () => {
    const id = mkItem();
    repo.suggestItemCategory(id, { categoryId: "hair", subCategoryId: "hair.model", confidence: 0.61, reason: "r" });
    const row = repo.setItemCategory(id, { categoryId: "hair", subCategoryId: "hair.model", source: "confirmed" });
    assert.equal(row.cat_id, "hair");
    assert.equal(row.cat_sub_id, "hair.model");
    assert.equal(row.cat_source, "confirmed");
    assert.equal(row.cat_suggest_id, null, "采纳后建议必须清空");
    assert.equal(row.cat_suggest_sub_id, null);
    assert.equal(row.cat_suggest_confidence, null);
    assert.equal(row.cat_suggest_reason, null);
    assert.equal(row.cat_suggest_at, null);
  });

  test("忽略：clearItemCategorySuggestion 只清建议，不动归属", () => {
    const id = mkItem();
    repo.setItemCategory(id, { categoryId: "clothing", source: "manual" });
    repo.suggestItemCategory(id, { categoryId: "hair", confidence: 0.5, reason: "r" });
    repo.clearItemCategorySuggestion(id);
    const row = rowOf(id);
    assert.equal(row.cat_suggest_id, null);
    assert.equal(row.cat_id, "clothing", "忽略建议不得影响已有归属");
    assert.equal(row.cat_source, "manual");
  });

  test("非法建议不落库：未知分类 / 不属于该主分类的子分类", () => {
    const bogus = mkItem();
    repo.suggestItemCategory(bogus, { categoryId: "no.such.category", confidence: 0.5 });
    assert.equal(rowOf(bogus).cat_suggest_id, null, "未知分类不得写入");

    const badSub = mkItem();
    repo.suggestItemCategory(badSub, { categoryId: "hair", subCategoryId: "audio.sfx", confidence: 0.5 });
    assert.equal(rowOf(badSub).cat_suggest_id, "hair");
    assert.equal(rowOf(badSub).cat_suggest_sub_id, null, "非法子分类必须清空");

    const ok = mkItem();
    repo.suggestItemCategory(ok, { categoryId: "hair", subCategoryId: "hair.texture", confidence: 0.5 });
    assert.equal(rowOf(ok).cat_suggest_sub_id, "hair.texture");
  });
});

describe("统计一致：categoryStats 与真实查询对齐（§8）", () => {
  test("uncategorized / pending / total 与 listItems 相等", () => {
    const st = repo.categoryStats();
    assert.equal(st.uncategorized, repo.listItems({ uncategorized: true }).total);
    assert.equal(st.pending, repo.listItems({ pendingCategory: true }).total);
    assert.equal(st.total, repo.listItems({}).total);
  });

  test("每个分类的 count 与 listItems({categoryIds:[id]}).total 相等", () => {
    const st = repo.categoryStats();
    assert.equal(st.counts.length, repo.categoryDefs().length, "每个分类都要有计数行");
    const mism: string[] = [];
    for (const c of st.counts) {
      const n = repo.listItems({ categoryIds: [c.id] }).total;
      if (n !== c.count) mism.push(`${c.id}: stats=${c.count} query=${n}`);
    }
    assert.deepEqual(mism, [], "分类计数与真实查询不一致: " + mism.join(", "));
  });

  test("子分类计数只算挂在该子分类上的条目；主分类计数含其所有子分类", () => {
    const before = repo.categoryStats();
    const topCount = before.counts.find((c) => c.id === "clothing")!;
    const subCount = before.counts.find((c) => c.id === "clothing.socks")!;

    const id = mkItem();
    repo.setItemCategory(id, { categoryId: "clothing.socks", source: "manual" });
    const after = repo.categoryStats();
    assert.equal(after.counts.find((c) => c.id === "clothing.socks")!.count, subCount.count + 1);
    assert.equal(after.counts.find((c) => c.id === "clothing")!.count, topCount.count + 1, "主分类计数应包含子分类的条目");
  });

  test("软删（status='trashed'）不计入任何统计与筛选", () => {
    const st0 = repo.categoryStats();
    const trashedUncat = mkItem();
    const trashedCat = mkItem();
    repo.setItemCategory(trashedCat, { categoryId: "accessories.tail", source: "manual" });
    const st1 = repo.categoryStats();
    assert.equal(st1.counts.find((c) => c.id === "accessories.tail")!.count, (st0.counts.find((c) => c.id === "accessories.tail")!.count) + 1);

    repo.updateItem(trashedUncat, { status: "trashed" });
    repo.updateItem(trashedCat, { status: "trashed" });
    const st2 = repo.categoryStats();
    assert.equal(st2.uncategorized, st0.uncategorized, "软删的未分类条目不增加未分类数");
    assert.equal(st2.counts.find((c) => c.id === "accessories.tail")!.count, (st0.counts.find((c) => c.id === "accessories.tail")!.count), "软删的已分类条目减少分类计数");
    assert.equal(st2.total, repo.listItems({}).total);
    assert.equal(repo.listItems({ includeTrashed: true }).total, repo.listItems({}).total + 2);

    // 每个分类再次逐项对齐（软删口径下仍然一致）
    const mism: string[] = [];
    for (const c of st2.counts) {
      const n = repo.listItems({ categoryIds: [c.id] }).total;
      if (n !== c.count) mism.push(`${c.id}: stats=${c.count} query=${n}`);
    }
    assert.deepEqual(mism, []);
  });
});

describe("删除分类（§3）", () => {
  test("有子分类 → 拒绝（409）", () => {
    repo.createCategory({ id: "my.del.top", name: "待删主分类", parentId: null });
    repo.createCategory({ id: "my.del.sub", name: "待删子分类", parentId: "my.del.top" });
    const msg = expectThrows(() => repo.deleteCategory("my.del.top"), "CONFLICT", 409);
    assert.match(msg, /子分类/);
    assert.ok(repo.categoryDefs().some((d) => d.id === "my.del.top"), "拒绝后分类必须还在");
    assert.ok(repo.categoryDefs().some((d) => d.id === "my.del.sub"));
  });

  test("内置分类不能删除（409，应先停用）", () => {
    const msg = expectThrows(() => repo.deleteCategory("clothing"), "CONFLICT", 409);
    assert.match(msg, /内置/);
    assert.ok(repo.categoryDefs().some((d) => d.id === "clothing"));
  });

  test("未知分类 → 404", () => {
    expectThrows(() => repo.deleteCategory("no.such.category"), "NOT_FOUND", 404);
  });

  test("删子分类：cat_sub_id 清空、主分类保留（语义降级为主分类，而非未分类）", () => {
    repo.createCategory({ id: "my.sub.top", name: "自建主", parentId: null });
    repo.createCategory({ id: "my.sub.child", name: "自建子", parentId: "my.sub.top" });
    const id = mkItem();
    repo.setItemCategory(id, { categoryId: "my.sub.child", source: "manual" });
    assert.equal(rowOf(id).cat_id, "my.sub.top");

    const res = repo.deleteCategory("my.sub.child");
    assert.equal(res.movedSubs, 1, "应清掉 1 条 cat_sub_id");
    assert.equal(res.moved, 0);
    const row = rowOf(id);
    assert.equal(row.cat_sub_id, null, "子分类被删 → cat_sub_id 清空");
    assert.equal(row.cat_id, "my.sub.top", "主分类保留");
    assert.equal(row.cat_source, "manual");
    assert.ok(!repo.categoryDefs().some((d) => d.id === "my.sub.child"), "分类已删除");
  });

  test("删主分类：条目退回未分类（cat_id/来源/置信度/时间全清）", () => {
    repo.createCategory({ id: "my.top.del", name: "自建主二", parentId: null });
    repo.createCategory({ id: "my.top.del.sub", name: "自建子二", parentId: "my.top.del" });
    const id = mkItem();
    repo.setItemCategory(id, { categoryId: "my.top.del.sub", source: "manual", reason: "手工", evidence: "[]" });
    repo.deleteCategory("my.top.del.sub");
    const res = repo.deleteCategory("my.top.del");
    assert.equal(res.moved, 1, "应清掉 1 条归属");
    const row = rowOf(id);
    assert.equal(row.cat_id, null, "退回未分类");
    assert.equal(row.cat_sub_id, null);
    assert.equal(row.cat_source, null);
    assert.equal(row.cat_confidence, null);
    assert.equal(row.cat_reason, null);
    assert.equal(row.cat_evidence, null);
    assert.equal(row.cat_assigned_at, null);
    assert.ok(!repo.categoryDefs().some((d) => d.id === "my.top.del"));
  });
});

describe("分类树两层限制（repo 现有守卫）", () => {
  test("子分类不能再改父分类（避免三层）→ 400", () => {
    expectThrows(() => repo.updateCategory("clothing.tops", { parentId: "accessories" }), "INVALID_INPUT", 400);
  });

  test("还有子分类的主分类不能移动 → 409", () => {
    expectThrows(() => repo.updateCategory("clothing", { parentId: "accessories" }), "CONFLICT", 409);
  });

  test("改名/排序/停用只影响该分类（enabled=false 不改变已有归属）", () => {
    const id = mkItem();
    repo.setItemCategory(id, { categoryId: "clothing.bottoms", source: "manual" });
    repo.updateCategory("clothing.bottoms", { name: "下装（改）", sort: 77, enabled: false });
    const def = repo.categoryDefs().find((d) => d.id === "clothing.bottoms")!;
    assert.equal(def.name, "下装（改）");
    assert.equal(def.sort, 77);
    assert.equal(def.enabled, false);
    assert.equal(rowOf(id).cat_id, "clothing", "停用不得静默改数据");
    assert.equal(rowOf(id).cat_sub_id, "clothing.bottoms");
  });
});
