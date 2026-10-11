/**
 * 物品分类 — Repo 层测试（归属 / 人工优先 / 建议 / 统计 / 筛选计数 / 影响面 / 移动 / 合并 / 删除 / 标签）
 *
 * 被测：apps/server/src/db/repo.ts 的分类与标签方法（冻结契约，docs/categories-v3.md §5/§6）
 * 方法：better-sqlite3 :memory: + migrate()（真实 schema 与 v3 播种）+ Repo，不用桩替身。
 * 覆盖：
 *  - 归属合法化：传子分类自动归位主分类；不属于主分类的子分类被清空（不留非法关联）；
 *  - 人工优先：manual/confirmed 永不被自动路径覆盖，只写建议；
 *  - 采纳/忽略：confirmed 清建议，dismiss 只清建议；
 *  - 统计一致：categoryStats / categoryCounts 与 listItems 的真实查询结果逐分类对齐，软删不计入；
 *  - 删除分类：有子分类拒绝；删子分类保留主分类；删主分类退回未分类；transferTo 指定转移目标；
 *  - v3 新 API：categoryCounts（不被分类筛选影响）/ categoryImpact / moveCategory / mergeCategories；
 *  - 标签：updateTag / deleteTag / seedDefaultTags 幂等。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { migrate } from "../../apps/server/src/db/migrate";
import { Repo } from "../../apps/server/src/db/repo";
import { UNCATEGORIZED_ID } from "../../packages/core/src/categories/taxonomy";
import { DEFAULT_TAGS, TAGS_SEED_VERSION } from "../../packages/core/src/categories/default-tags";

const db = new Database(":memory:");
db.pragma("foreign_keys = ON");
migrate(db);
const repo = new Repo(db);

/** 独立库：做"会改动分类树"的用例时别污染共享库。 */
function freshRepo(): Repo {
  const d = new Database(":memory:");
  d.pragma("foreign_keys = ON");
  migrate(d);
  return new Repo(d);
}

let seq = 0;
/** 造条目：走真实 createItem（含 FTS 同步）。 */
const mkItem = (r: Repo = repo, title = "素材" + (++seq)): number => r.createItem({ title }).id;
const rowOf = (id: number) => repo.itemRow(id);

/** 断言抛出带 code/status 的错误（repo 用 Object.assign 挂 code/status，由路由层转 HTTP）。 */
function expectThrows(fn: () => unknown, code: string, status: number, hint = ""): string {
  try { fn(); } catch (e) {
    const err = e as { code?: string; status?: number; message?: string };
    assert.equal(err.code, code, "错误 code: " + err.code + " / " + err.message);
    assert.equal(err.status, status, "错误 status: " + err.status + " / " + err.message);
    return String(err.message);
  }
  assert.fail("期望抛出 " + code + "(" + status + ")，但执行成功了" + (hint ? "；" + hint : ""));
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
    const row = repo.setItemCategory(id, { categoryId: "clothing", subCategoryId: "accessories.hat", source: "manual" });
    assert.equal(row.cat_id, "clothing", "主分类仍然生效");
    assert.equal(row.cat_sub_id, null, "非法子分类必须清空");
  });

  test("v2 旧子分类 ID 不再被接受（v3 迁移后必须清空，不能当成合法子分类）", () => {
    const id = mkItem();
    const row = repo.setItemCategory(id, { categoryId: "clothing", subCategoryId: "clothing.socks", source: "manual" });
    assert.equal(row.cat_id, "clothing");
    assert.equal(row.cat_sub_id, null, "v2 的 clothing.socks 在 v3 不存在");
    assert.equal(rowOf(id).cat_sub_id, null);
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
    repo.suggestItemCategory(id, { categoryId: "hair", subCategoryId: "hair.set", confidence: 0.5, reason: "自动" });
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

describe("手动分类保护：manual / confirmed 永不被自动路径覆盖（§7）", () => {
  test("manual 后 applyAutoCategory(其它分类) → applied=false、protected=true、cat_id 不变、写建议", () => {
    const id = mkItem();
    repo.setItemCategory(id, { categoryId: "clothing.tops", source: "manual" });
    const res = repo.applyAutoCategory(id, { categoryId: "hair", subCategoryId: "hair.set", confidence: 0.92, reason: "自动推断", evidence: "[]" });
    assert.deepEqual(res, { applied: false, protected: true });
    const row = rowOf(id);
    assert.equal(row.cat_id, "clothing", "手动分类不得被覆盖");
    assert.equal(row.cat_sub_id, "clothing.tops");
    assert.equal(row.cat_source, "manual");
    assert.equal(row.cat_suggest_id, "hair", "自动结果只能落为建议");
    assert.equal(row.cat_suggest_sub_id, "hair.set");
  });

  test("confirmed（采纳过建议）同样受保护", () => {
    const id = mkItem();
    repo.setItemCategory(id, { categoryId: "audio.bgm", source: "confirmed" });
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
    repo.suggestItemCategory(id, { categoryId: "hair", subCategoryId: "hair.set", confidence: 0.61, reason: "标题含「ヘアモデル」", evidence: "[{\"rule\":\"hair.set\"}]" });
    const row = rowOf(id);
    assert.equal(row.cat_id, null, "建议不得改变归属");
    assert.equal(row.cat_suggest_id, "hair");
    assert.equal(row.cat_suggest_sub_id, "hair.set");
    assert.equal(row.cat_suggest_confidence, 0.61);
    assert.equal(row.cat_suggest_reason, "标题含「ヘアモデル」");
    assert.ok(row.cat_suggest_at);
  });

  test("采纳：setItemCategory(source='confirmed') 清建议并落地归属", () => {
    const id = mkItem();
    repo.suggestItemCategory(id, { categoryId: "hair", subCategoryId: "hair.set", confidence: 0.61, reason: "r" });
    const row = repo.setItemCategory(id, { categoryId: "hair", subCategoryId: "hair.set", source: "confirmed" });
    assert.equal(row.cat_id, "hair");
    assert.equal(row.cat_sub_id, "hair.set");
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

    const staleSub = mkItem();
    repo.suggestItemCategory(staleSub, { categoryId: "hair", subCategoryId: "hair.texture", confidence: 0.5 });
    assert.equal(rowOf(staleSub).cat_suggest_sub_id, null, "v2 旧子分类 ID 也不得写入");

    const ok = mkItem();
    repo.suggestItemCategory(ok, { categoryId: "hair", subCategoryId: "hair.long", confidence: 0.5 });
    assert.equal(rowOf(ok).cat_suggest_sub_id, "hair.long");
  });
});

describe("统计一致：categoryStats 与真实查询对齐（§5）", () => {
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
      if (c.id === UNCATEGORIZED_ID) continue; // 未分类 = cat_id IS NULL OR ='uncategorized'，与 categoryIds 语义不同，另行断言
      const n = repo.listItems({ categoryIds: [c.id] }).total;
      if (n !== c.count) mism.push(`${c.id}: stats=${c.count} query=${n}`);
    }
    assert.deepEqual(mism, [], "分类计数与真实查询不一致: " + mism.join(", "));
    assert.equal(st.counts.find((c) => c.id === UNCATEGORIZED_ID)!.count, repo.listItems({ uncategorized: true }).total);
  });

  test("子分类计数只算挂在该子分类上的条目；主分类计数含其所有子分类", () => {
    const before = repo.categoryStats();
    const topCount = before.counts.find((c) => c.id === "clothing")!;
    const subCount = before.counts.find((c) => c.id === "clothing.shoes_socks")!;

    const id = mkItem();
    repo.setItemCategory(id, { categoryId: "clothing.shoes_socks", source: "manual" });
    const after = repo.categoryStats();
    assert.equal(after.counts.find((c) => c.id === "clothing.shoes_socks")!.count, subCount.count + 1);
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
      if (c.id === UNCATEGORIZED_ID) continue;
      const n = repo.listItems({ categoryIds: [c.id] }).total;
      if (n !== c.count) mism.push(`${c.id}: stats=${c.count} query=${n}`);
    }
    assert.deepEqual(mism, []);
  });
});

describe("categoryCounts：当前筛选下的分类计数（§5）", () => {
  test("分类筛选本身不参与计数：categoryIds / uncategorized / pendingCategory 传什么都不改结果", () => {
    const base = repo.categoryCounts({});
    assert.deepEqual(repo.categoryCounts({ categoryIds: ["clothing.tops"] }), base);
    assert.deepEqual(repo.categoryCounts({ categoryIds: ["clothing", "hair"], categoryMatch: "all" }), base);
    assert.deepEqual(repo.categoryCounts({ uncategorized: true }), base);
    assert.deepEqual(repo.categoryCounts({ pendingCategory: true }), base);
  });

  test("其它筛选生效：关键词筛选改变 all 与各分类计数", () => {
    const base = repo.categoryCounts({});
    const kw = repo.categoryCounts({ q: "シャツ" });
    assert.equal(kw.all, repo.listItems({ q: "シャツ" }).total, "all 必须等于同筛选下的真实总数");
    assert.ok(kw.all < base.all, "关键词应缩小计数范围");
    assert.equal(kw.uncategorized, repo.listItems({ q: "シャツ", uncategorized: true }).total);
  });

  test("all / uncategorized / tops / subs 与真实查询逐项一致，且未分类同时出现在 tops 里", () => {
    const c = repo.categoryCounts({ status: "active" });
    assert.equal(c.all, repo.listItems({ status: "active" }).total);
    assert.equal(c.uncategorized, repo.listItems({ status: "active", uncategorized: true }).total);
    assert.equal(c.tops[UNCATEGORIZED_ID], c.uncategorized, "未分类也作为一个一级入口参与导航计数");
    const mism: string[] = [];
    for (const [id, n] of Object.entries(c.tops)) {
      if (id === UNCATEGORIZED_ID) continue;
      const real = repo.listItems({ status: "active", categoryIds: [id] }).total;
      if (real !== n) mism.push(`top ${id}: counts=${n} query=${real}`);
    }
    for (const [id, n] of Object.entries(c.subs)) {
      const real = repo.listItems({ status: "active", categoryIds: [id] }).total;
      if (real !== n) mism.push(`sub ${id}: counts=${n} query=${real}`);
    }
    assert.deepEqual(mism, []);
  });

  test("一级计数含其子分类；软删条目不计入", () => {
    const r = freshRepo();
    r.createCategory({ id: "cc.top", name: "计数主", parentId: null });
    r.createCategory({ id: "cc.sub", name: "计数子", parentId: "cc.top" });
    const a = r.createItem({ title: "a" }).id;
    const b = r.createItem({ title: "b" }).id;
    r.setItemCategory(a, { categoryId: "cc.sub", source: "manual" });
    r.setItemCategory(b, { categoryId: "cc.top", source: "manual" });
    let c = r.categoryCounts({});
    assert.equal(c.tops["cc.top"], 2, "一级 = 自身 + 子分类");
    assert.equal(c.subs["cc.sub"], 1);
    r.updateItem(b, { status: "trashed" });
    c = r.categoryCounts({});
    assert.equal(c.tops["cc.top"], 1, "软删不计入");
    assert.equal(c.subs["cc.sub"], 1);
  });
});

describe("categoryImpact：删除/合并前的影响面（§6）", () => {
  test("一级：items 含子分类、direct 只算直接挂载、children 列出子分类", () => {
    const r = freshRepo();
    r.createCategory({ id: "imp", name: "影响面主", parentId: null });
    r.createCategory({ id: "imp.sub", name: "影响面子", parentId: "imp" });
    const a = r.createItem({ title: "a" }).id;
    r.setItemCategory(a, { categoryId: "imp.sub", source: "manual" });
    const b = r.createItem({ title: "b" }).id;
    r.setItemCategory(b, { categoryId: "imp", source: "manual" });
    const c = r.createItem({ title: "c" }).id;
    r.suggestItemCategory(c, { categoryId: "imp", subCategoryId: "imp.sub", confidence: 0.5 });

    // direct（一级）= cat_id 命中（含挂了子分类的条目）；items = direct + 子分类挂载
    assert.deepEqual(r.categoryImpact("imp"), {
      items: 2, direct: 2, subs: 1, suggestions: 1,
      children: [{ id: "imp.sub", name: "影响面子" }],
    }, "一级影响面含其子分类；suggestions 同时统计 cat_suggest_id 与 cat_suggest_sub_id");
    assert.deepEqual(r.categoryImpact("imp.sub"), {
      items: 1, direct: 1, subs: 0, suggestions: 1, children: [],
    });
  });

  test("未知分类 → NOT_FOUND 404", () => {
    const r = freshRepo();
    expectThrows(() => r.categoryImpact("no.such.category"), "NOT_FOUND", 404);
  });
});

describe("moveCategory：子分类换父，ID 不变（§6.2）", () => {
  test("子分类移动到另一个一级分类下：ID 不变、素材归属不变", () => {
    const r = freshRepo();
    r.createCategory({ id: "mv.a", name: "A", parentId: null });
    r.createCategory({ id: "mv.b", name: "B", parentId: null });
    r.createCategory({ id: "mv.sub", name: "子", parentId: "mv.a" });
    const it = r.createItem({ title: "移动" }).id;
    r.setItemCategory(it, { categoryId: "mv.sub", source: "manual" });
    assert.equal(r.itemRow(it).cat_id, "mv.a");

    const moved = r.moveCategory("mv.sub", "mv.b");
    assert.equal(moved.id, "mv.sub", "ID 是稳定标识，不随父变化");
    assert.equal(moved.parentId, "mv.b");
    assert.deepEqual(r.categoryImpact("mv.b").children.map((c) => c.id), ["mv.sub"]);
    assert.deepEqual(r.categoryImpact("mv.a").children, []);
    assert.equal(r.itemRow(it).cat_id, "mv.a", "移动分类不改素材归属");
    assert.equal(r.itemRow(it).cat_sub_id, "mv.sub");
    assert.ok(r.listAudit(200).some((a: any) => a.action === "category.move" && a.entity_id === "mv.sub"), "移动要写审计");
  });

  test("一级分类不可移动 → 400", () => {
    const r = freshRepo();
    expectThrows(() => r.moveCategory("clothing", "hair"), "INVALID_INPUT", 400);
    r.createCategory({ id: "mv.top", name: "自建一级", parentId: null });
    expectThrows(() => r.moveCategory("mv.top", "hair"), "INVALID_INPUT", 400);
  });

  test("目标必须是一级分类：目标不存在 / 目标是子分类 → 400；未知分类 → 404", () => {
    const r = freshRepo();
    r.createCategory({ id: "mv2.top", name: "T", parentId: null });
    r.createCategory({ id: "mv2.sub", name: "S", parentId: "mv2.top" });
    expectThrows(() => r.moveCategory("mv2.sub", "no.such.top"), "INVALID_INPUT", 400);
    expectThrows(() => r.moveCategory("mv2.sub", "clothing.tops"), "INVALID_INPUT", 400);
    expectThrows(() => r.moveCategory("no.such.sub", "clothing"), "NOT_FOUND", 404);
  });

  test("移动到当前父分类（同父）是幂等的空操作", () => {
    const r = freshRepo();
    r.createCategory({ id: "mv3.top", name: "T", parentId: null });
    r.createCategory({ id: "mv3.sub", name: "S", parentId: "mv3.top" });
    const same = r.moveCategory("mv3.sub", "mv3.top");
    assert.equal(same.parentId, "mv3.top");
    assert.equal((r.listAudit(50) as any[]).filter((a) => a.action === "category.move").length, 0, "空操作不写审计");
  });
});

describe("mergeCategories：同级合并，素材与建议迁移后删源（§6）", () => {
  test("一级 → 一级：素材改指目标、源子分类清空并删除、建议迁移", () => {
    const r = freshRepo();
    r.createCategory({ id: "mg.one", name: "一", parentId: null });
    r.createCategory({ id: "mg.one.sub", name: "一子", parentId: "mg.one" });
    r.createCategory({ id: "mg.two", name: "二", parentId: null });
    r.createCategory({ id: "mg.two.sub", name: "二子", parentId: "mg.two" });
    const x = r.createItem({ title: "x" }).id;
    r.setItemCategory(x, { categoryId: "mg.one", source: "manual" });
    const z = r.createItem({ title: "z" }).id;
    r.setItemCategory(z, { categoryId: "mg.one.sub", source: "manual" });
    const sug = r.createItem({ title: "s" }).id;
    r.suggestItemCategory(sug, { categoryId: "mg.one", subCategoryId: "mg.one.sub", confidence: 0.5 });
    const keep = r.createItem({ title: "k" }).id;
    r.setItemCategory(keep, { categoryId: "mg.two.sub", source: "manual" });

    const res = r.mergeCategories("mg.one", "mg.two");
    assert.equal(res.moved, 3, "x 与 z 改指目标 + z 的 cat_sub_id 清空");
    assert.equal(res.movedSuggestions, 1);
    assert.equal(res.deleted, 2, "源一级 + 源子分类");
    assert.equal(r.itemRow(x).cat_id, "mg.two");
    assert.equal(r.itemRow(x).cat_sub_id, null);
    assert.equal(r.itemRow(z).cat_id, "mg.two", "源子分类下的素材归到目标一级");
    assert.equal(r.itemRow(z).cat_sub_id, null, "源子分类已删除 → 清空子分类引用");
    assert.equal(r.itemRow(sug).cat_suggest_id, "mg.two");
    assert.equal(r.itemRow(sug).cat_suggest_sub_id, null);
    assert.equal(r.itemRow(keep).cat_sub_id, "mg.two.sub", "目标分类下的素材不受影响");
    assert.equal(r.categoryDefs().some((d) => d.id === "mg.one"), false);
    assert.equal(r.categoryDefs().some((d) => d.id === "mg.one.sub"), false);
  });

  test("子 → 子（同一父）：素材改指目标子分类", () => {
    const r = freshRepo();
    r.createCategory({ id: "mg4.top", name: "T", parentId: null });
    r.createCategory({ id: "mg4.a", name: "A", parentId: "mg4.top" });
    r.createCategory({ id: "mg4.b", name: "B", parentId: "mg4.top" });
    const it = r.createItem({ title: "i" }).id;
    r.setItemCategory(it, { categoryId: "mg4.a", source: "manual" });
    const res = r.mergeCategories("mg4.a", "mg4.b");
    assert.equal(res.moved, 1);
    assert.equal(res.deleted, 1);
    assert.equal(r.itemRow(it).cat_id, "mg4.top");
    assert.equal(r.itemRow(it).cat_sub_id, "mg4.b");
    assert.equal(r.categoryDefs().some((d) => d.id === "mg4.a"), false);
  });

  test("系统分类不能作为合并源（但可以作为目标）→ 409", () => {
    const r = freshRepo();
    r.createCategory({ id: "mg5.user", name: "自建", parentId: null });
    const msg = expectThrows(() => r.mergeCategories("clothing", "mg5.user"), "CONFLICT", 409);
    assert.match(msg, /系统分类/);
    assert.ok(r.categoryDefs().some((d) => d.id === "clothing"), "拒绝后源分类必须还在");
    // 反向：自建 → 系统分类 是允许的
    const res = r.mergeCategories("mg5.user", "hair");
    assert.equal(res.deleted, 1);
    assert.equal(r.categoryDefs().some((d) => d.id === "mg5.user"), false);
  });

  test("只能同级合并（一级↔子 / 子↔一级）→ 400；合并到自己 → 400；未知 → 404", () => {
    const r = freshRepo();
    r.createCategory({ id: "mg6.top", name: "T", parentId: null });
    r.createCategory({ id: "mg6.sub", name: "S", parentId: "mg6.top" });
    expectThrows(() => r.mergeCategories("mg6.sub", "hair"), "INVALID_INPUT", 400);
    expectThrows(() => r.mergeCategories("mg6.top", "clothing.tops"), "INVALID_INPUT", 400);
    expectThrows(() => r.mergeCategories("clothing", "mg6.top"), "CONFLICT", 409, "系统分类作为源优先报 409");
    expectThrows(() => r.mergeCategories("mg6.top", "mg6.top"), "INVALID_INPUT", 400);
    expectThrows(() => r.mergeCategories("mg6.top", "no.such"), "NOT_FOUND", 404);
    expectThrows(() => r.mergeCategories("no.such", "mg6.top"), "NOT_FOUND", 404);
  });
});

describe("删除分类（§3/§6）", () => {
  test("有子分类 → 拒绝（409）", () => {
    repo.createCategory({ id: "my.del.top", name: "待删主分类", parentId: null });
    repo.createCategory({ id: "my.del.sub", name: "待删子分类", parentId: "my.del.top" });
    const msg = expectThrows(() => repo.deleteCategory("my.del.top"), "CONFLICT", 409);
    assert.match(msg, /子分类/);
    assert.ok(repo.categoryDefs().some((d) => d.id === "my.del.top"), "拒绝后分类必须还在");
    assert.ok(repo.categoryDefs().some((d) => d.id === "my.del.sub"));
  });

  test("系统分类不能删除（409，应先停用）", () => {
    const msg = expectThrows(() => repo.deleteCategory("clothing"), "CONFLICT", 409);
    assert.match(msg, /内置/);
    assert.ok(repo.categoryDefs().some((d) => d.id === "clothing"));
  });

  test("系统分类带 transferTo 也不能删 → 409（转移目标不改变系统分类保护）", () => {
    expectThrows(() => repo.deleteCategory("clothing.tops", { transferTo: "hair" }), "CONFLICT", 409);
    assert.ok(repo.categoryDefs().some((d) => d.id === "clothing.tops"));
  });

  test("未知分类 → 404", () => {
    expectThrows(() => repo.deleteCategory("no.such.category"), "NOT_FOUND", 404);
  });

  test("删子分类（缺省 transferTo）：cat_sub_id 清空、主分类保留（语义降级为主分类，而非未分类）", () => {
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

  test("删主分类（缺省 transferTo）：条目退回未分类（cat_id/来源/置信度/时间全清）", () => {
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

  test("删子分类 + transferTo 指定子分类：cat_sub_id 改指目标，主分类保留", () => {
    const r = freshRepo();
    r.createCategory({ id: "dt.top", name: "删主", parentId: null });
    r.createCategory({ id: "dt.a", name: "待删子", parentId: "dt.top" });
    r.createCategory({ id: "dt.b", name: "转移目标子", parentId: "dt.top" });
    const id = r.createItem({ title: "onSub" }).id;
    r.setItemCategory(id, { categoryId: "dt.a", source: "manual" });
    const res = r.deleteCategory("dt.a", { transferTo: "dt.b" });
    assert.equal(res.movedSubs, 1);
    assert.equal(res.moved, 0);
    const row = r.itemRow(id);
    assert.equal(row.cat_id, "dt.top", "删子分类时主分类保留");
    assert.equal(row.cat_sub_id, "dt.b", "子分类改指转移目标");
    assert.equal(r.categoryDefs().some((d) => d.id === "dt.a"), false);
  });

  test("删一级分类 + transferTo 指定子分类：素材整体改指目标（不留旧父）；带子分类时先拒绝", () => {
    const r = freshRepo();
    r.createCategory({ id: "dt.top", name: "删主", parentId: null });
    r.createCategory({ id: "dt.gone", name: "先删的子", parentId: "dt.top" });
    r.createCategory({ id: "dt.target", name: "目标", parentId: null });
    r.createCategory({ id: "dt.target.sub", name: "目标子", parentId: "dt.target" });
    const direct = r.createItem({ title: "direct" }).id;
    r.setItemCategory(direct, { categoryId: "dt.top", source: "manual" });
    const onSub = r.createItem({ title: "onSub" }).id;
    r.setItemCategory(onSub, { categoryId: "dt.gone", source: "manual" });

    expectThrows(() => r.deleteCategory("dt.top", { transferTo: "dt.target.sub" }), "CONFLICT", 409);
    r.deleteCategory("dt.gone"); // 先删子分类（素材降级为主分类），一级分类才能删
    assert.equal(r.itemRow(onSub).cat_id, "dt.top");

    const res = r.deleteCategory("dt.top", { transferTo: "dt.target.sub" });
    assert.equal(res.moved, 2, "直接挂载的 + 刚从子分类降级的都要转移");
    for (const id of [direct, onSub]) {
      const row = r.itemRow(id);
      assert.equal(row.cat_id, "dt.target", "主分类必须整体改指目标（不留旧父）");
      assert.equal(row.cat_sub_id, "dt.target.sub");
      assert.equal(row.cat_source, "manual");
    }
    assert.equal(r.categoryDefs().some((d) => d.id === "dt.top"), false);
  });

  test("transferTo 指定一级分类：素材落到目标一级（子分类清空）", () => {
    const r = freshRepo();
    r.createCategory({ id: "dt2.top", name: "删主", parentId: null });
    r.createCategory({ id: "dt2.sub", name: "删子", parentId: "dt2.top" });
    const id = r.createItem({ title: "i" }).id;
    r.setItemCategory(id, { categoryId: "dt2.sub", source: "manual" });
    r.deleteCategory("dt2.sub"); // 先删子分类
    const res = r.deleteCategory("dt2.top", { transferTo: "hair" });
    assert.equal(res.moved, 1);
    assert.equal(r.itemRow(id).cat_id, "hair");
    assert.equal(r.itemRow(id).cat_sub_id, null);
  });

  test("transferTo 显式「未分类」：素材整条清空（与缺省一致，但语义显式）", () => {
    const r = freshRepo();
    r.createCategory({ id: "dt3.top", name: "删主", parentId: null });
    r.createCategory({ id: "dt3.sub", name: "删子", parentId: "dt3.top" });
    const id = r.createItem({ title: "i" }).id;
    r.setItemCategory(id, { categoryId: "dt3.sub", source: "manual", reason: "r", evidence: "[]" });
    r.deleteCategory("dt3.sub"); // 先删子分类
    const res = r.deleteCategory("dt3.top", { transferTo: UNCATEGORIZED_ID });
    assert.equal(res.moved, 1);
    const row = r.itemRow(id);
    assert.equal(row.cat_id, null);
    assert.equal(row.cat_sub_id, null);
    assert.equal(row.cat_source, null);
  });

  test("transferTo 不存在 → 400，且分类与素材都不动", () => {
    const r = freshRepo();
    r.createCategory({ id: "dt4.top", name: "删主", parentId: null });
    const id = r.createItem({ title: "i" }).id;
    r.setItemCategory(id, { categoryId: "dt4.top", source: "manual" });
    expectThrows(() => r.deleteCategory("dt4.top", { transferTo: "no.such.category" }), "INVALID_INPUT", 400);
    assert.ok(r.categoryDefs().some((d) => d.id === "dt4.top"), "失败后分类必须还在");
    assert.equal(r.itemRow(id).cat_id, "dt4.top", "失败后归属必须不变");
  });

  test("删除绝不删素材：条目、计数与文件关系都保留", () => {
    const r = freshRepo();
    r.createCategory({ id: "dt5.top", name: "删主", parentId: null });
    const id = r.createItem({ title: "留下的素材" }).id;
    r.setItemCategory(id, { categoryId: "dt5.top", source: "manual" });
    const before = r.listItems({}).total;
    r.deleteCategory("dt5.top");
    assert.equal(r.listItems({}).total, before, "素材总数不变");
    assert.ok(r.itemRow(id), "素材行必须还在");
    assert.equal(r.categoryStats().uncategorized, r.listItems({ uncategorized: true }).total);
  });
});

describe("标签（v3 §4：重命名 / 删除 / 默认标签只播种一次）", () => {
  test("updateTag：改名/改色生效，素材关联按 id 跟随", () => {
    const r = freshRepo();
    const item = r.createItem({ title: "带标签" }).id;
    r.setItemTags(item, ["旧名"], "manual");
    const tag = (r.listTags() as any[]).find((t) => t.name === "旧名")!;
    assert.equal(tag.itemCount, 1);
    const up = r.updateTag(tag.id, { name: "新名", color: "#123456" });
    assert.equal(up.name, "新名");
    assert.equal(up.color, "#123456");
    assert.equal(up.itemCount, 1, "关联数不变（改名不动关联）");
    assert.deepEqual(r.listItemTagNames(item), ["新名"], "素材关联跟随（按 id）");
    assert.equal((r.listTags() as any[]).some((t) => t.name === "旧名"), false);
    // 只改颜色不改名
    assert.equal(r.updateTag(tag.id, { color: null }).name, "新名");
    assert.equal(r.updateTag(tag.id, { sort: 42 }).sort, 42);
  });

  test("updateTag 的错误面：未知 404 / 空名 400 / 同 namespace 重名 409", () => {
    const r = freshRepo();
    const item = r.createItem({ title: "x" }).id;
    r.setItemTags(item, ["t1", "t2"], "manual");
    const t1 = (r.listTags() as any[]).find((t) => t.name === "t1")!;
    expectThrows(() => r.updateTag(999999, { name: "x" }), "NOT_FOUND", 404);
    expectThrows(() => r.updateTag(t1.id, { name: "   " }), "INVALID_INPUT", 400);
    expectThrows(() => r.updateTag(t1.id, { name: "t2" }), "CONFLICT", 409);
  });

  test("deleteTag：删关联不删素材，返回 removed；重复删 404", () => {
    const r = freshRepo();
    const item = r.createItem({ title: "x" }).id;
    r.setItemTags(item, ["t1", "t2"], "manual");
    const t1 = (r.listTags() as any[]).find((t) => t.name === "t1")!;
    const res = r.deleteTag(t1.id);
    assert.equal(res.removed, 1, "应删掉 1 条 item_tags 关联");
    assert.deepEqual(r.listItemTagNames(item), ["t2"]);
    assert.equal((r.listTags() as any[]).some((t) => t.name === "t1"), false);
    assert.ok(r.itemRow(item), "素材不得被删");
    assert.equal(r.listItems({}).total, 1, "素材总数不变");
    expectThrows(() => r.deleteTag(t1.id), "NOT_FOUND", 404);
  });

  test("seedDefaultTags：只播种一次（settings.tags_seed_version 幂等）", () => {
    const r = freshRepo();
    assert.equal((r.listTags() as any[]).length, 0, "新库没有标签");
    assert.equal(r.seedDefaultTags(DEFAULT_TAGS, TAGS_SEED_VERSION), DEFAULT_TAGS.length);
    assert.equal((r.listTags() as any[]).length, DEFAULT_TAGS.length);
    assert.equal(r.seedDefaultTags(DEFAULT_TAGS, TAGS_SEED_VERSION), 0, "第二次 0 新增（版本号已记）");
    assert.equal((r.listTags() as any[]).length, DEFAULT_TAGS.length);
    const goth = (r.listTags() as any[]).find((t) => t.name === "哥特风")!;
    assert.equal(goth.color, "#8b5cf6");
    assert.equal(goth.sort, 10);
  });

  test("默认标签不会被复活：用户删掉后再播种也不回来；换版本号只补缺失的", () => {
    const r = freshRepo();
    r.seedDefaultTags(DEFAULT_TAGS, TAGS_SEED_VERSION);
    const goth = (r.listTags() as any[]).find((t) => t.name === "哥特风")!;
    r.deleteTag(goth.id);
    assert.equal(r.seedDefaultTags(DEFAULT_TAGS, TAGS_SEED_VERSION), 0, "同版本号 → 什么都不做");
    assert.equal((r.listTags() as any[]).some((t) => t.name === "哥特风"), false, "删掉的标签不得复活");
    // 版本号变化 → 允许补播，但只补缺失的（同名同 namespace 的已存在项跳过）
    assert.equal(r.seedDefaultTags(DEFAULT_TAGS, "2"), 1, "只补被删掉的 1 个");
    assert.equal((r.listTags() as any[]).length, DEFAULT_TAGS.length);
  });
});

describe("分类树两层限制（v3 §2 约束：子分类可换父，一级骨架不可移动）", () => {
  test("子分类换父：updateCategory 允许（ID 不变），但父必须已存在的一级分类", () => {
    const r = freshRepo();
    r.createCategory({ id: "tp.a", name: "A", parentId: null });
    r.createCategory({ id: "tp.b", name: "B", parentId: null });
    r.createCategory({ id: "tp.sub", name: "子", parentId: "tp.a" });
    const moved = r.updateCategory("tp.sub", { parentId: "tp.b" });
    assert.equal(moved.id, "tp.sub");
    assert.equal(moved.parentId, "tp.b");
    expectThrows(() => r.updateCategory("tp.sub", { parentId: "no.such.top" }), "INVALID_INPUT", 400);
    expectThrows(() => r.updateCategory("tp.sub", { parentId: null }), "INVALID_INPUT", 400, "不支持把分类提升为一级");
    // 目标本身是子分类 → 会造出三层，必须拒绝
    r.createCategory({ id: "tp.sub2", name: "子2", parentId: "tp.b" });
    expectThrows(() => r.updateCategory("tp.sub", { parentId: "tp.sub2" }), "INVALID_INPUT", 400);
  });

  test("还有子分类的一级分类不能移动 → 409；未知分类 → 404", () => {
    const r = freshRepo();
    r.createCategory({ id: "tp2.top", name: "T", parentId: null });
    r.createCategory({ id: "tp2.sub", name: "S", parentId: "tp2.top" });
    expectThrows(() => r.updateCategory("tp2.top", { parentId: "hair" }), "CONFLICT", 409);
    expectThrows(() => r.updateCategory("no.such.category", { name: "x" }), "NOT_FOUND", 404);
  });

  test("v3：一级骨架的父永远是 null；任何子分类的父都是已存在的一级分类", () => {
    const defs = freshRepo().categoryDefs(); // 用干净库，避免本文件其它用例建的自建分类混进来
    for (const d of defs) {
      if (d.parentId === null) continue;
      const p = defs.find((x) => x.id === d.parentId);
      assert.ok(p, d.id + " 的父必须存在: " + d.parentId);
      assert.equal(p!.parentId, null, d.id + " 不得出现三层");
    }
    assert.equal(defs.length, 95, "v3：15 一级 + 80 子分类");
    assert.equal(defs.filter((d) => d.parentId === null).length, 15);
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
