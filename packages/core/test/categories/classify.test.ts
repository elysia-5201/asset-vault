/**
 * 物品分类 — 自动分类推荐（classify）契约测试
 *
 * 被测：packages/core/src/categories/classify.ts（规则表见 docs/categories-v3.md §3）
 * 契约要点：
 *  - 可解释：每条命中都带 field/ruleId/matched/gain，reason 非空；
 *  - 分级：confidence >= autoThreshold → auto；>= suggestThreshold → suggest；否则 none；
 *  - 否定语境：命中词前后 6 字符窗口出现「なし」等 → 该条证据作废；
 *  - 长词优先：同一规则同一字段内，长词命中后不再计被它包含的短词；
 *  - 歧义：与第二分类差距 < 35% → ambiguous + confidence ×0.6；
 *  - 无证据 → categoryId=null / level='none'（未知类型必须保持未分类）；
 *  - **v3 规则表里的 categoryId/subCategoryId 必须真实存在于 taxonomy**：引用不存在的 ID 会被
 *    recommendCategory 静默忽略（规则写了却永远不生效），这是 v2→v3 迁移最容易踩的坑。
 *
 * 说明：本文件断言的是**契约语义**（分级、降权、证据结构、规则落点），不写死所有规则的调参结果
 *      （权重仍可微调）；只有被契约明确固定的常量才做精确断言。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  recommendCategory, CATEGORY_RULES, FIELD_WEIGHT, FIELD_LABEL, DEFAULT_CATEGORY_THRESHOLDS,
  CONFIDENCE_SATURATION, evidenceToJson, type CategoryRule, type CategoryRecommendation,
} from "../../src/categories/classify";
import { DEFAULT_TAXONOMY, categoryById, UNCATEGORIZED_ID } from "../../src/categories/taxonomy";

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
      // 证据里的分类 ID 必须真实存在（否则前端展示的是幽灵分类）
      assert.ok(categoryById(e.categoryId), "evidence.categoryId 必须存在于 taxonomy: " + e.categoryId);
      assert.ok(e.subCategoryId === null || categoryById(e.subCategoryId), "evidence.subCategoryId 必须存在: " + e.subCategoryId);
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

  test("证据字段权重与契约完全一致", () => {
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

describe("v3 规则表：每条规则都必须指向 taxonomy 里存在的分类（防静默失效）", () => {
  test("CATEGORY_RULES 的规则 ID 唯一，且每条规则声明了关键词/正权重", () => {
    const ids = CATEGORY_RULES.map((r) => r.id);
    assert.equal(new Set(ids).size, ids.length, "规则 ID 必须唯一");
    for (const r of CATEGORY_RULES) {
      assert.ok(r.keywords.length > 0, r.id + " 必须有关键词");
      assert.ok(r.weight > 0, r.id + " 权重必须为正");
    }
  });

  test("categoryId 与 subCategoryId 都必须在 DEFAULT_TAXONOMY 里（引用旧 ID 会被静默忽略）", () => {
    const bogus = CATEGORY_RULES.filter(
      (r) => !categoryById(r.categoryId) || (r.subCategoryId != null && !categoryById(r.subCategoryId)),
    );
    assert.deepEqual(bogus.map((r) => r.id + " → " + r.categoryId + "/" + r.subCategoryId), [],
      "以下规则引用了 taxonomy 里不存在的 ID（会被 recommendCategory 静默忽略）");
    // 规则表里不得出现 v2 的旧子分类 ID（规则 ID 与子分类 ID 同名，便于追溯）
    for (const legacy of ["clothing.swimwear", "clothing.shoes", "clothing.socks", "tools.upload", "shaders.shader",
      "accessories.headwear", "makeup.eye", "hair.model", "ui.component", "audio.music", "worlds.vrchat"]) {
      assert.equal(categoryById(legacy), null, "v2 旧 ID 不该存在: " + legacy);
    }
  });

  test("子分类规则 ID == 目标子分类 ID（ID 稳定可追溯），且每个 v3 子分类都有规则", () => {
    for (const r of CATEGORY_RULES) {
      if (r.subCategoryId) assert.equal(r.id, r.subCategoryId, r.id + " 的规则 ID 应等于其子分类 ID");
      else assert.equal(categoryById(r.categoryId)?.parentId, null, r.id + " 只能是把子分类记为 null 的一级规则");
    }
    const covered = new Set(CATEGORY_RULES.map((r) => r.subCategoryId).filter(Boolean) as string[]);
    const missing = DEFAULT_TAXONOMY.filter((d) => d.parentId !== null && !covered.has(d.id)).map((d) => d.id);
    assert.deepEqual(missing, [], "以下 v3 子分类没有任何规则（永远不可能被推荐）");
  });

  test("子分类为 null 的规则只能回落到一级分类（v2「回退到父」的迁移落点）", () => {
    const topOnly = CATEGORY_RULES.filter((r) => !r.subCategoryId);
    assert.ok(topOnly.length >= 10, "每个一级分类都应有 .primary 规则");
    const tops = new Set(DEFAULT_TAXONOMY.filter((d) => d.parentId === null).map((d) => d.id));
    for (const r of topOnly) assert.ok(tops.has(r.categoryId), r.id + " 的目标必须是一级分类");
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
    assert.equal(rec.subCategoryId, "shaders.general", "v2 的 shaders.shader 已在 v3 并入 shaders.general");
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

describe("否定语境：'影なし' / 'シャドウなし' 不给 Shaders›特效 Shader 计分", () => {
  test("正对照：「影」本身是 Shaders›特效 Shader 的证据", () => {
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

  test("'シャドウなし' / 'アウトラインなし' 同样不给 Shaders›特效 Shader 计分", () => {
    for (const title of ["シャドウなし", "アウトラインなし", "影を落とさない", "影が出ない", "no shadow"]) {
      const rec = recommendCategory({ title });
      assert.equal(hitsOf(rec, "shaders.effect").length, 0, title + " 不得命中 shaders.effect");
      assert.notEqual(rec.subCategoryId, "shaders.effect", title + " 不得落到特效 Shader");
    }
  });

  test("否定只作废那一处证据，不牵连同条目的其它证据", () => {
    const rec = recommendCategory({ title: "影なしシェーダー" });
    assert.equal(rec.categoryId, "shaders");
    assert.equal(rec.subCategoryId, "shaders.general", "シェーダー 的证据仍然有效");
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
    const rule: CategoryRule = { id: "test.longword", categoryId: "shaders", subCategoryId: "shaders.general", weight: 1, keywords: ["シェーダー", "シェーダ"] };
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

  test("规则的目标子分类不存在时同样被忽略（v2 旧 ID 静默失效的复现）", () => {
    const stale: CategoryRule = { id: "clothing.swimwear", categoryId: "clothing", subCategoryId: "clothing.swimwear", weight: 1, keywords: ["水着"] };
    const rec = recommendCategory({ title: "水着" }, undefined, undefined, [stale]);
    assert.equal(rec.categoryId, null, "引用已不存在的子分类 ID → 整条规则被忽略");
    assert.equal(rec.level, "none");
  });
});

describe("v3 迁移：旧子分类的落点（一对一改名 / 合并 / 回退到一级）", () => {
  test("clothing.shoes + clothing.socks 合并为 clothing.shoes_socks", () => {
    for (const title of ["靴", "ブーツ", "靴下", "ニーソ", "タイツ"]) {
      const rec = recommendCategory({ title });
      assert.equal(rec.categoryId, "clothing", title);
      assert.equal(rec.subCategoryId, "clothing.shoes_socks", title);
      assert.equal(hitsOf(rec, "clothing.shoes_socks").length > 0, true, title + " 必须命中合并后的规则");
    }
  });

  test("clothing.swimwear 在 v3 没有子分类 → 只归到「服饰」（subCategoryId=null）", () => {
    const rec = recommendCategory({ title: "水着" });
    assert.equal(rec.categoryId, "clothing");
    assert.equal(rec.subCategoryId, null, "回退到一级分类，不得落到别的子分类");
    assert.equal(hitsOf(rec, "clothing.swimwear").length, 0, "旧规则 ID 不得再存在");
  });

  test("shaders.shader / shaders.preset / shaders.postprocess 合并为 shaders.general", () => {
    for (const title of ["シェーダー", "lilToon", "ポストプロセス", "ブルーム"]) {
      const rec = recommendCategory({ title });
      assert.equal(rec.categoryId, "shaders", title);
      assert.equal(rec.subCategoryId, "shaders.general", title);
    }
  });

  test("tools.upload → tools.installer；tools.avatar_edit + tools.modular_avatar → tools.avatar", () => {
    assert.equal(recommendCategory({ title: "アップロード" }).subCategoryId, "tools.installer");
    assert.equal(recommendCategory({ title: "modular avatar" }).categoryId, "tools");
    assert.equal(recommendCategory({ title: "modular avatar" }).subCategoryId, "tools.avatar");
    assert.equal(recommendCategory({ title: "リギング" }).subCategoryId, "tools.avatar");
  });

  test("accessories.headwear → accessories.hat；accessories.hand → accessories.ring", () => {
    assert.equal(recommendCategory({ title: "帽子" }).categoryId, "accessories");
    assert.equal(recommendCategory({ title: "帽子" }).subCategoryId, "accessories.hat");
    assert.equal(recommendCategory({ title: "指輪" }).subCategoryId, "accessories.ring");
  });

  test("audio.music → audio.bgm；ui.component → ui.interactive", () => {
    assert.equal(recommendCategory({ title: "BGM" }).subCategoryId, "audio.bgm");
    assert.equal(recommendCategory({ title: "音楽" }).subCategoryId, "audio.bgm");
    assert.equal(recommendCategory({ title: "交互界面" }).subCategoryId, "ui.interactive");
  });
});

describe("v3 新增子分类：补齐的关键词规则（每个子分类都可被推荐到）", () => {
  /** [输入标题, 期望一级, 期望子分类] —— 任务清单里点名要补规则的子分类。 */
  const CASES: [string, string, string][] = [
    // 头发
    ["双马尾", "hair", "hair.twintails"],
    ["ツインテール", "hair", "hair.twintails"],
    ["ポニーテール", "hair", "hair.ponytail"],
    ["三つ編み", "hair", "hair.braid"],
    ["短发", "hair", "hair.short"],
    ["长发", "hair", "hair.long"],
    ["前髪", "hair", "hair.bangs"],
    // 妆容
    ["眼影", "makeup", "makeup.eyeshadow"],
    ["眼线", "makeup", "makeup.eyeliner"],
    ["つけまつげ", "makeup", "makeup.lashes"],
    ["眉毛", "makeup", "makeup.brows"],
    ["全脸妆", "makeup", "makeup.fullface"],
    ["メイクセット", "makeup", "makeup.set"],
    // 动画与动作
    ["待机", "animation", "animation.idle"],
    ["行走", "animation", "animation.walk"],
    ["モーションセット", "animation", "animation.set"],
    // 特效
    ["魔法特效", "effects", "effects.magic"],
    ["描边", "effects", "effects.outline"],
    ["屏幕特效", "effects", "effects.screen"],
    // 材质与纹理
    ["法线贴图", "textures", "textures.normal"],
    ["PBR贴图", "textures", "textures.pbr"],
    ["服テクスチャ", "textures", "textures.clothing"],
    ["ヘアテクスチャ", "textures", "textures.hair"],
    // Shader
    ["スキンシェーダー", "shaders", "shaders.skin"],
    ["ヘアシェーダー", "shaders", "shaders.hair"],
    ["布シェーダー", "shaders", "shaders.cloth"],
    ["lilToon", "shaders", "shaders.general"],
    // 模型
    ["アバター本体", "models", "models.avatar"],
    ["动物", "models", "models.animal"],
    ["宠物", "models", "models.pet"],
    ["道具模型", "models", "models.prop"],
    // 场景
    ["室内", "worlds", "worlds.indoor"],
    ["室外", "worlds", "worlds.outdoor"],
    ["ステージ", "worlds", "worlds.world"],
    ["背景小物", "worlds", "worlds.prop"],
    // 音频
    ["BGM", "audio", "audio.bgm"],
    ["環境音", "audio", "audio.ambient"],
    // UI
    ["交互界面", "ui", "ui.interactive"],
    // 工具
    ["軽量化", "tools", "tools.optimize"],
    ["アップロード", "tools", "tools.installer"],
    ["自動化", "tools", "tools.script"],
    // 饰品 / 服饰
    ["帽子", "accessories", "accessories.hat"],
    ["指輪", "accessories", "accessories.ring"],
    ["服饰配件", "clothing", "clothing.accessory"],
    // 其他
    ["暂未归类", "other", "other.unclassed"],
    ["待整理", "other", "other.pending"],
  ];

  for (const [title, top, sub] of CASES) {
    test("'" + title + "' → " + sub, () => {
      const rec = recommendCategory({ title });
      assert.equal(rec.categoryId, top, title);
      assert.equal(rec.subCategoryId, sub, title);
      assert.ok(categoryById(sub), "期望的子分类必须在 v3 taxonomy 里: " + sub);
    });
  }

  test("每个新增子分类的规则都可命中（反向覆盖：CASES 覆盖了全部 v3 新增子分类）", () => {
    const covered = new Set(CASES.map(([, , sub]) => sub));
    const v3New = [
      "hair.twintails", "hair.ponytail", "hair.braid", "hair.short", "hair.long", "hair.bangs",
      "makeup.eyeshadow", "makeup.eyeliner", "makeup.lashes", "makeup.brows", "makeup.fullface",
      "animation.idle", "animation.walk", "animation.set",
      "effects.magic", "effects.outline", "effects.screen",
      "textures.normal", "textures.pbr", "textures.hair", "textures.clothing",
      "shaders.skin", "shaders.hair", "shaders.cloth",
      "models.animal", "models.pet", "models.prop",
      "worlds.indoor", "worlds.outdoor", "worlds.prop",
      "audio.ambient", "ui.interactive", "tools.optimize",
      "other.unclassed", "other.pending", "clothing.accessory",
    ];
    const missing = v3New.filter((id) => !covered.has(id));
    assert.deepEqual(missing, [], "以下新增子分类没有可命中的用例: " + missing.join(", "));
  });

  test("系统分类「未分类」不参与自动推荐（它不是一个归属，是空归属）", () => {
    const ids = new Set(CATEGORY_RULES.map((r) => r.categoryId).concat(CATEGORY_RULES.map((r) => r.subCategoryId ?? "")));
    assert.equal(ids.has(UNCATEGORIZED_ID), false, "任何规则都不得把素材推荐到系统分类 uncategorized");
  });
});
