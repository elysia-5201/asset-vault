/**
 * 物品分类 — 自动分类推荐（classify）契约测试
 *
 * 被测：packages/core/src/categories/classify.ts（冻结契约，见 docs/categories.md §2）
 * 契约要点：
 *  - 可解释：每条命中都带 field/ruleId/matched/gain，reason 非空；
 *  - 分级：confidence >= autoThreshold → auto；>= suggestThreshold → suggest；否则 none；
 *  - 否定语境：命中词前后 6 字符窗口出现「なし」等 → 该条证据作废；
 *  - 长词优先：同一规则同一字段内，长词命中后不再计被它包含的短词；
 *  - 歧义：与第二分类差距 < 35% → ambiguous + confidence ×0.6；
 *  - 无证据 → categoryId=null / level='none'（未知类型必须保持未分类）。
 *
 * 说明：本文件断言的是**契约语义**（分级、降权、证据结构），不写死规则库的调参结果
 *      （CATEGORY_RULES 的权重仍在调优）；只有被契约明确固定的常量才做精确断言。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  recommendCategory, CATEGORY_RULES, FIELD_WEIGHT, FIELD_LABEL, DEFAULT_CATEGORY_THRESHOLDS,
  CONFIDENCE_SATURATION, evidenceToJson, type CategoryRule, type CategoryRecommendation,
} from "../../src/categories/classify";

/** 命中某规则的所有证据。 */
const hitsOf = (rec: CategoryRecommendation, ruleId: string) => rec.evidence.filter((e) => e.ruleId === ruleId);

describe("可解释性：命中必带证据，reason 非空", () => {
  test("单关键词命中：evidence 非空且每条证据字段齐全（field/fieldLabel/ruleId/matched/keyword/gain）", () => {
    const rec = recommendCategory({ title: "ドレス" });
    assert.ok(rec.evidence.length > 0, "有命中就必须有证据");
    for (const e of rec.evidence) {
      assert.ok(FIELD_WEIGHT[e.field] !== undefined, "field 必须是已知字段: " + e.field);
      assert.equal(typeof e.fieldLabel, "string");
      assert.ok(e.fieldLabel.length > 0, "fieldLabel 非空");
      assert.equal(typeof e.ruleId, "string");
      assert.ok(e.ruleId.length > 0, "ruleId 非空");
      assert.equal(typeof e.matched, "string");
      assert.ok(e.matched.length > 0, "matched 非空");
      assert.equal(typeof e.keyword, "string");
      assert.ok(e.keyword.length > 0, "keyword 非空");
      assert.equal(typeof e.gain, "number");
      assert.ok(e.gain > 0, "gain 必须为正: " + JSON.stringify(e));
      assert.ok(e.categoryId.length > 0, "categoryId 非空");
      assert.ok(e.subCategoryId === null || typeof e.subCategoryId === "string");
    }
    assert.equal(typeof rec.reason, "string");
    assert.ok(rec.reason.trim().length > 0, "reason 必须非空（可解释要求）");
  });

  test("证据可原样存库：evidenceToJson 是 JSON 数组，字段与 evidence 一一对应", () => {
    const rec = recommendCategory({ title: "ドレス" });
    const parsed = JSON.parse(evidenceToJson(rec)) as { field: string; rule: string; matched: string; gain: number; cat: string; sub: string | null }[];
    assert.ok(Array.isArray(parsed));
    assert.equal(parsed.length, rec.evidence.length);
    for (let i = 0; i < parsed.length; i++) {
      assert.equal(parsed[i]!.field, rec.evidence[i]!.field);
      assert.equal(parsed[i]!.rule, rec.evidence[i]!.ruleId);
      assert.equal(parsed[i]!.matched, rec.evidence[i]!.matched);
      assert.equal(parsed[i]!.gain, rec.evidence[i]!.gain);
      assert.equal(parsed[i]!.cat, rec.evidence[i]!.categoryId);
      assert.equal(parsed[i]!.sub, rec.evidence[i]!.subCategoryId);
    }
  });

  test("证据字段权重与 docs/categories.md §2 完全一致", () => {
    assert.deepEqual(FIELD_WEIGHT, {
      title: 1, filename: 0.9, booth_category: 0.9, tag: 0.8, unitypackage_path: 0.7,
      archive_path: 0.6, description: 0.5, notes: 0.4, shop: 0.3,
    });
    for (const f of Object.keys(FIELD_WEIGHT)) assert.ok(FIELD_LABEL[f as keyof typeof FIELD_LABEL]?.length > 0, f + " 必须有中文标签");
  });

  test("默认阈值 = 契约值 { autoThreshold: 0.75, suggestThreshold: 0.4 }，饱和点 2.0", () => {
    assert.deepEqual(DEFAULT_CATEGORY_THRESHOLDS, { autoThreshold: 0.75, suggestThreshold: 0.4 });
    assert.equal(CONFIDENCE_SATURATION, 2.0);
  });
});

describe("分级：单个关键词不得判为 auto", () => {
  test("关键词只出现在标题时，只能是 suggest/none，绝不 auto", () => {
    const rec = recommendCategory({ title: "ドレス" });
    assert.equal(rec.categoryId, "clothing");
    assert.equal(rec.subCategoryId, "clothing.dress");
    assert.notEqual(rec.level, "auto");
    assert.ok(rec.confidence < DEFAULT_CATEGORY_THRESHOLDS.autoThreshold,
      "单处证据的置信度必须低于 autoThreshold，实际 " + rec.confidence);
    assert.equal(rec.level, "suggest");
  });

  test("同一分类的两处独立证据（标题 + BOOTH 分类）应能到 auto", () => {
    const rec = recommendCategory({ title: "シェーダー", boothCategory: { name: "シェーダー" } });
    assert.equal(rec.categoryId, "shaders");
    assert.equal(rec.level, "auto", "标题 + BOOTH 分类两处证据应达到 auto");
    assert.ok(rec.confidence >= DEFAULT_CATEGORY_THRESHOLDS.autoThreshold, "confidence=" + rec.confidence);
    const fields = new Set(rec.evidence.map((e) => e.field));
    assert.ok(fields.has("title"), "证据里要有标题");
    assert.ok(fields.has("booth_category"), "证据里要有 BOOTH 分类");
    assert.ok(rec.reason.includes("BOOTH 分类"), "reason 要说明 BOOTH 分类这一依据: " + rec.reason);
  });

  test("包内路径是弱证据：单独一条 unitypackage 路径不得判为 auto", () => {
    const rec = recommendCategory({ unitypackagePaths: ["Assets/衣装/dress.fbx"] });
    assert.equal(rec.categoryId, "clothing");
    assert.notEqual(rec.level, "auto", "包内路径单独出现不得 auto");
  });
});

describe("否定语境：'影なし' / 'シャドウなし' 不给 Shaders›渲染效果 计分", () => {
  test("正对照：「影」本身是 Shaders›渲染效果 的证据", () => {
    const rec = recommendCategory({ title: "影" });
    assert.equal(rec.categoryId, "shaders");
    assert.equal(rec.subCategoryId, "shaders.effect");
    assert.ok(hitsOf(rec, "shaders.effect").length > 0);
  });

  test("'影なし' → 证据作废、保持未分类（不得硬塞进 Shaders）", () => {
    const rec = recommendCategory({ title: "影なし" });
    assert.equal(rec.categoryId, null, "否定语境下不得给出分类");
    assert.equal(rec.level, "none");
    assert.deepEqual(rec.evidence, []);
    assert.ok(rec.reason.trim().length > 0, "即便未分类也要说明原因");
  });

  test("'シャドウなし' / 'アウトラインなし' 同样不给 Shaders›渲染效果 计分", () => {
    for (const title of ["シャドウなし", "アウトラインなし", "影を落とさない", "影が出ない", "no shadow"]) {
      const rec = recommendCategory({ title });
      assert.equal(hitsOf(rec, "shaders.effect").length, 0, title + " 不得命中 shaders.effect");
      assert.notEqual(rec.subCategoryId, "shaders.effect", title + " 不得落到渲染效果");
    }
  });

  test("否定只作废那一处证据，不牵连同条目的其它证据", () => {
    const rec = recommendCategory({ title: "影なしシェーダー" });
    assert.equal(rec.categoryId, "shaders");
    assert.equal(rec.subCategoryId, "shaders.shader", "シェーダー 的证据仍然有效");
    assert.equal(hitsOf(rec, "shaders.effect").length, 0, "影 的证据已被否定");
  });

  test("否定窗口是 ±6 字符：窗口外的「なし」不影响命中", () => {
    const rec = recommendCategory({ title: "影XXXXXX影なし" });
    assert.equal(rec.subCategoryId, "shaders.effect", "首个「影」不在否定窗口内");
    assert.ok(hitsOf(rec, "shaders.effect").length > 0);
  });
});

describe("长词优先：同一规则同一字段内不再重复计短词", () => {
  test("契约示例：'シェーダー' 命中后不再计 'シェーダ'（同一规则内只留最长的一条）", () => {
    const rule: CategoryRule = { id: "test.longword", categoryId: "shaders", subCategoryId: "shaders.shader", weight: 1, keywords: ["シェーダー", "シェーダ"] };
    const rec = recommendCategory({ title: "シェーダー" }, undefined, undefined, [rule]);
    assert.equal(rec.evidence.length, 1, "同一字段只应留一条证据: " + JSON.stringify(rec.evidence.map((e) => e.matched)));
    assert.equal(rec.evidence[0]!.matched, "シェーダー");
  });

  test("'ボイス素材' 命中时不再重复计 'ボイス'（真实规则 audio.voice）", () => {
    const rec = recommendCategory({ title: "ボイス素材" });
    const voiceHits = hitsOf(rec, "audio.voice");
    assert.equal(voiceHits.length, 1, "audio.voice 只应有一条标题证据: " + JSON.stringify(voiceHits.map((h) => h.matched)));
    assert.equal(voiceHits[0]!.matched, "ボイス素材");
    assert.equal(voiceHits.some((h) => h.matched === "ボイス"), false, "短词 ボイス 不得重复计分");
  });
});

describe("歧义：两个分类都很强时降权", () => {
  test("歧义输入 ambiguous=true、confidence 按 ×0.6 降权，且低于同分的单义输入", () => {
    const solo = recommendCategory({ title: "シェーダー" });
    const amb = recommendCategory({ title: "シェーダー アニメーション" });
    assert.equal(amb.ambiguous, true, "两个分类都强应判为歧义: " + JSON.stringify({ score: amb.score, ru: amb.runnerUpScore }));
    assert.ok(amb.runnerUpScore > 0, "歧义必须有第二分类得分");
    // 契约：与第二分类差距 < 35% 才叫歧义
    assert.ok(amb.score - amb.runnerUpScore < 0.35 * amb.score, "差距应 < 35%");
    // 契约：歧义时 confidence ×0.6
    const expected = Math.round(Math.min(1, amb.score / CONFIDENCE_SATURATION) * 0.6 * 1000) / 1000;
    assert.equal(amb.confidence, expected, "歧义降权系数应为 0.6");
    assert.ok(amb.confidence < Math.min(1, amb.score / CONFIDENCE_SATURATION), "confidence 必须被降权");
    // 同一条目去掉第二分类证据后分数不降，但置信度更高 → 证明降权来自歧义
    assert.equal(amb.score, solo.score, "最佳分类得分不受第二分类影响");
    assert.ok(amb.confidence < solo.confidence, "歧义输入置信度必须低于单义输入");
  });

  test("非歧义输入 ambiguous=false（正对照）", () => {
    const rec = recommendCategory({ title: "ドレス" });
    assert.equal(rec.ambiguous, false);
    assert.equal(rec.runnerUpScore, 0);
  });
});

describe("阈值可配置", () => {
  test("同一输入在 autoThreshold=0.3 时变 auto、在 0.99 时变 suggest/none", () => {
    const base = recommendCategory({ title: "ドレス" });
    assert.equal(base.level, "suggest");
    const lowAuto = recommendCategory({ title: "ドレス" }, { autoThreshold: 0.3, suggestThreshold: 0.4 });
    assert.equal(lowAuto.level, "auto");
    // 阈值刚好高于该输入置信度 → 退回 suggest
    const higher = Math.min(0.99, Number((base.confidence + 0.01).toFixed(3)));
    const strictAuto = recommendCategory({ title: "ドレス" }, { autoThreshold: higher, suggestThreshold: 0.4 });
    assert.equal(strictAuto.level, "suggest");
    // suggest 阈值也抬高 → none（不硬塞分类）
    const none = recommendCategory({ title: "ドレス" }, { autoThreshold: 0.99, suggestThreshold: 0.99 });
    assert.equal(none.level, "none");
    // 阈值不改变证据与得分，只改变处置级别
    assert.equal(none.score, base.score);
    assert.equal(none.evidence.length, base.evidence.length);
  });
});

describe("无证据：未知类型必须保持未分类", () => {
  test("完全无命中 → categoryId=null、level='none'、evidence=[]", () => {
    const rec = recommendCategory({ title: "zzz qqq" });
    assert.equal(rec.categoryId, null);
    assert.equal(rec.subCategoryId, null);
    assert.equal(rec.level, "none");
    assert.equal(rec.confidence, 0);
    assert.equal(rec.score, 0);
    assert.deepEqual(rec.evidence, []);
    assert.ok(rec.reason.trim().length > 0);
  });

  test("空输入 / 未知类型不得乱归类（宁可未分类）", () => {
    for (const input of [{}, { title: "" }, { title: "謎のオブジェクト" }, { title: "unknown thing" }, { title: "ああああ" }]) {
      const rec = recommendCategory(input);
      assert.equal(rec.level, "none", JSON.stringify(input) + " 不应给出分类");
      assert.equal(rec.categoryId, null);
    }
  });

  test("规则里出现未知分类 ID 时忽略该规则（不产生非法归属）", () => {
    const bogus: CategoryRule = { id: "bogus", categoryId: "no.such.top", subCategoryId: null, weight: 1, keywords: ["ドレス"] };
    const rec = recommendCategory({ title: "ドレス" }, undefined, undefined, [bogus]);
    assert.equal(rec.categoryId, null);
    assert.equal(rec.level, "none");
  });

  test("CATEGORY_RULES 的规则 ID 唯一，且每条规则声明了关键词", () => {
    const ids = CATEGORY_RULES.map((r) => r.id);
    assert.equal(new Set(ids).size, ids.length, "规则 ID 必须唯一");
    for (const r of CATEGORY_RULES) {
      assert.ok(r.keywords.length > 0, r.id + " 必须有关键词");
      assert.ok(r.weight > 0, r.id + " 权重必须为正");
    }
  });
});
