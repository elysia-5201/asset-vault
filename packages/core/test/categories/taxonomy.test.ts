/**
 * 物品分类 — 分类定义（taxonomy）契约测试
 *
 * 被测：packages/core/src/categories/taxonomy.ts（冻结契约，见 docs/categories-v3.md §1/§2）
 * 依据：docs/categories-v3.md §1「15 个一级分类（全部 is_system=1）」+ §2「80 个二级子分类」
 *       （ID 一旦发布不得修改；v2 的 14 主 / 79 子已被 v3 取代）
 * 方法：正例（DEFAULT_TAXONOMY 必须合法且与契约逐项一致）+ 负例（validateTaxonomy 必须能抓出
 *       重复 ID / 缺失父 / 三层结构 / 未分类异常，防止"校验其实永远返回空数组"的假绿）。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_TAXONOMY, CATEGORY_MAX_DEPTH, UNCATEGORIZED_ID, UNCATEGORIZED_LABEL, TOP_CATEGORY_IDS,
  validateTaxonomy, topCategories, childrenOf, categoryById, categoryPath, isAncestor, isUncategorized, type CategoryDef,
} from "../../src/categories/taxonomy";

/** 冻结契约（v3）：15 个一级分类 + 各自子分类的 ID/名称（顺序按 sort）。 */
const EXPECTED: { id: string; name: string; subs: { id: string; name: string }[] }[] = [
  { id: "clothing", name: "服饰", subs: [
    { id: "clothing.tops", name: "上衣" }, { id: "clothing.bottoms", name: "下装" },
    { id: "clothing.dress", name: "连衣裙" }, { id: "clothing.coat", name: "外套" },
    { id: "clothing.shoes_socks", name: "鞋袜" }, { id: "clothing.underwear", name: "内衣" },
    { id: "clothing.suit", name: "套装" }, { id: "clothing.accessory", name: "服饰配件" },
  ] },
  { id: "makeup", name: "妆容", subs: [
    { id: "makeup.eyeshadow", name: "眼影" }, { id: "makeup.eyeliner", name: "眼线" },
    { id: "makeup.lashes", name: "睫毛" }, { id: "makeup.brows", name: "眉毛" },
    { id: "makeup.blush", name: "腮红" }, { id: "makeup.lips", name: "唇妆" },
    { id: "makeup.fullface", name: "全脸妆" }, { id: "makeup.set", name: "妆容套装" },
  ] },
  { id: "hair", name: "头发", subs: [
    { id: "hair.short", name: "短发" }, { id: "hair.long", name: "长发" },
    { id: "hair.twintails", name: "双马尾" }, { id: "hair.ponytail", name: "单马尾" },
    { id: "hair.braid", name: "辫子" }, { id: "hair.bangs", name: "刘海" },
    { id: "hair.set", name: "发型套装" },
  ] },
  { id: "models", name: "模型", subs: [
    { id: "models.avatar", name: "Avatar" }, { id: "models.body", name: "身体" },
    { id: "models.head", name: "头部" }, { id: "models.animal", name: "动物" },
    { id: "models.pet", name: "宠物" }, { id: "models.prop", name: "道具模型" },
  ] },
  { id: "textures", name: "材质与纹理", subs: [
    { id: "textures.skin", name: "皮肤" }, { id: "textures.eye", name: "眼睛" },
    { id: "textures.hair", name: "头发" }, { id: "textures.clothing", name: "服饰" },
    { id: "textures.normal", name: "法线贴图" }, { id: "textures.pbr", name: "PBR 贴图" },
  ] },
  { id: "shaders", name: "Shader", subs: [
    { id: "shaders.skin", name: "皮肤 Shader" }, { id: "shaders.hair", name: "头发 Shader" },
    { id: "shaders.cloth", name: "布料 Shader" }, { id: "shaders.effect", name: "特效 Shader" },
    { id: "shaders.general", name: "通用 Shader" },
  ] },
  { id: "animation", name: "动画与动作", subs: [
    { id: "animation.idle", name: "待机" }, { id: "animation.walk", name: "行走" },
    { id: "animation.dance", name: "舞蹈" }, { id: "animation.expression", name: "表情" },
    { id: "animation.gesture", name: "手势" }, { id: "animation.pose", name: "姿势" },
    { id: "animation.set", name: "动作套装" },
  ] },
  { id: "effects", name: "特效", subs: [
    { id: "effects.particle", name: "粒子" }, { id: "effects.light", name: "光效" },
    { id: "effects.magic", name: "魔法特效" }, { id: "effects.outline", name: "描边" },
    { id: "effects.screen", name: "屏幕特效" },
  ] },
  { id: "tools", name: "工具", subs: [
    { id: "tools.unity", name: "Unity 编辑器工具" }, { id: "tools.avatar", name: "Avatar 工具" },
    { id: "tools.installer", name: "安装工具" }, { id: "tools.optimize", name: "优化工具" },
    { id: "tools.script", name: "辅助脚本" },
  ] },
  { id: "accessories", name: "饰品", subs: [
    { id: "accessories.earring", name: "耳饰" }, { id: "accessories.necklace", name: "项链" },
    { id: "accessories.ring", name: "戒指" }, { id: "accessories.glasses", name: "眼镜" },
    { id: "accessories.hat", name: "帽子" }, { id: "accessories.hair_ornament", name: "发饰" },
    { id: "accessories.wings", name: "翅膀" }, { id: "accessories.tail", name: "尾巴" },
  ] },
  { id: "audio", name: "音频", subs: [
    { id: "audio.bgm", name: "BGM" }, { id: "audio.ambient", name: "环境音" },
    { id: "audio.sfx", name: "音效" }, { id: "audio.voice", name: "语音" },
  ] },
  { id: "worlds", name: "场景", subs: [
    { id: "worlds.indoor", name: "室内" }, { id: "worlds.outdoor", name: "室外" },
    { id: "worlds.skybox", name: "天空盒" }, { id: "worlds.world", name: "世界场景" },
    { id: "worlds.prop", name: "场景道具" },
  ] },
  { id: "ui", name: "UI", subs: [
    { id: "ui.menu", name: "菜单" }, { id: "ui.icon", name: "图标" },
    { id: "ui.hud", name: "HUD" }, { id: "ui.interactive", name: "交互界面" },
  ] },
  { id: "other", name: "其他", subs: [
    { id: "other.unclassed", name: "暂未归类" }, { id: "other.pending", name: "待整理" },
  ] },
  { id: UNCATEGORIZED_ID, name: UNCATEGORIZED_LABEL, subs: [] },
];

/** 契约给定的每主分类子分类数量（与 EXPECTED 互为交叉校验，防止两边一起写错）。 */
const EXPECTED_SUB_COUNTS: Record<string, number> = {
  clothing: 8, makeup: 8, hair: 7, models: 6, textures: 6, shaders: 5, animation: 7,
  effects: 5, tools: 5, accessories: 8, audio: 4, worlds: 5, ui: 4, other: 2, uncategorized: 0,
};

const TOP_NAMES = ["服饰", "妆容", "头发", "模型", "材质与纹理", "Shader", "动画与动作", "特效", "工具", "饰品", "音频", "场景", "UI", "其他", "未分类"];

describe("DEFAULT_TAXONOMY 结构合法", () => {
  test("正例：validateTaxonomy(DEFAULT_TAXONOMY) 返回空错误列表", () => {
    assert.deepEqual(validateTaxonomy(DEFAULT_TAXONOMY), []);
  });

  test("总数 95 = 15 主分类 + 80 子分类（docs/categories-v3.md §1/§2）", () => {
    const tops = topCategories(DEFAULT_TAXONOMY);
    assert.equal(tops.length, 15);
    assert.equal(DEFAULT_TAXONOMY.length, 95);
    assert.equal(DEFAULT_TAXONOMY.length - tops.length, 80);
  });

  test("契约表交叉校验：子分类数量合计 80（8/8/7/6/6/5/7/5/5/8/4/5/4/2/0）", () => {
    assert.deepEqual(EXPECTED.map((t) => t.subs.length), [8, 8, 7, 6, 6, 5, 7, 5, 5, 8, 4, 5, 4, 2, 0]);
    assert.equal(EXPECTED.reduce((n, t) => n + t.subs.length, 0), 80);
    for (const t of EXPECTED) assert.equal(t.subs.length, EXPECTED_SUB_COUNTS[t.id], t.id);
  });

  test("每条定义的字段都满足契约（非空 id/name、父指向存在、sort 为整数、builtin/enabled 为布尔）", () => {
    for (const d of DEFAULT_TAXONOMY) {
      assert.ok(d.id.length > 0, "id 非空");
      assert.ok(d.name.length > 0, "name 非空: " + d.id);
      assert.equal(typeof d.sort, "number");
      assert.ok(Number.isInteger(d.sort), "sort 必须是整数: " + d.id);
      assert.equal(typeof d.enabled, "boolean");
      assert.equal(typeof d.builtin, "boolean");
      // 默认树里的内置分类全部启用（停用是用户行为，不写回定义真源）
      assert.equal(d.enabled, true, d.id + " 默认必须 enabled");
      assert.equal(d.builtin, true, d.id + " 默认必须 builtin（v3 的 95 个节点全部是系统分类）");
    }
  });

  test("负例：validateTaxonomy 能抓出重复 ID / 缺失父分类 / 三层结构（校验不是永远返回空）", () => {
    const dup: CategoryDef[] = [
      { id: "a", name: "A", parentId: null, sort: 1, enabled: true, builtin: true },
      { id: "a", name: "A2", parentId: null, sort: 2, enabled: true, builtin: true },
    ];
    assert.match(validateTaxonomy(dup).join("\n"), /ID 重复: a/);

    const orphan: CategoryDef[] = [
      { id: "a", name: "A", parentId: null, sort: 1, enabled: true, builtin: true },
      { id: "a.b", name: "B", parentId: "nope", sort: 1, enabled: true, builtin: true },
    ];
    assert.match(validateTaxonomy(orphan).join("\n"), /父分类不存在: nope/);

    const threeLayer: CategoryDef[] = [
      { id: "a", name: "A", parentId: null, sort: 1, enabled: true, builtin: true },
      { id: "a.b", name: "B", parentId: "a", sort: 1, enabled: true, builtin: true },
      { id: "a.b.c", name: "C", parentId: "a.b", sort: 1, enabled: true, builtin: true },
    ];
    const errs = validateTaxonomy(threeLayer);
    assert.match(errs.join("\n"), /超过两层/);
    assert.equal(CATEGORY_MAX_DEPTH, 2);

    // 未分类的两条特殊约束（系统分类、无子分类）
    const uncNotTop: CategoryDef[] = [
      { id: UNCATEGORIZED_ID, name: "未分类", parentId: "other", sort: 1500, enabled: true, builtin: true },
      { id: "other", name: "其他", parentId: null, sort: 1400, enabled: true, builtin: true },
    ];
    assert.match(validateTaxonomy(uncNotTop).join("\n"), /未分类必须是系统一级分类/);
    const uncWithKids: CategoryDef[] = [
      { id: UNCATEGORIZED_ID, name: "未分类", parentId: null, sort: 1500, enabled: true, builtin: true },
      { id: UNCATEGORIZED_ID + ".x", name: "X", parentId: UNCATEGORIZED_ID, sort: 1, enabled: true, builtin: true },
    ];
    assert.match(validateTaxonomy(uncWithKids).join("\n"), /未分类不应有子分类/);
  });
});

describe("15 个一级分类：ID、名称与顺序与 v3 契约一致", () => {
  test("一级分类数量、ID、名称逐项一致（按 sort 排序）", () => {
    const tops = topCategories(DEFAULT_TAXONOMY);
    assert.deepEqual(tops.map((d) => d.id), EXPECTED.map((d) => d.id));
    assert.deepEqual(tops.map((d) => d.name), TOP_NAMES);
    assert.deepEqual(TOP_CATEGORY_IDS, EXPECTED.map((d) => d.id));
  });

  test("一级分类 sort 严格递增（100 → 1500，步长 100；顺序不依赖 ID 字典序）", () => {
    const tops = topCategories(DEFAULT_TAXONOMY);
    assert.deepEqual(tops.map((d) => d.sort), [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1100, 1200, 1300, 1400, 1500]);
    for (let i = 1; i < tops.length; i++) assert.ok(tops[i]!.sort > tops[i - 1]!.sort, tops[i]!.id);
  });

  test("一级分类必须 parentId === null（两层结构的第一层）", () => {
    for (const d of topCategories(DEFAULT_TAXONOMY)) assert.equal(d.parentId, null, d.id);
  });
});

describe("各一级分类的子分类数量与名称完全符合 v3 契约", () => {
  for (const top of EXPECTED) {
    test(top.id + "（" + top.name + "）：" + EXPECTED_SUB_COUNTS[top.id] + " 个子分类，ID/名称/顺序一致", () => {
      const kids = childrenOf(top.id);
      assert.equal(kids.length, EXPECTED_SUB_COUNTS[top.id], top.id + " 子分类数量");
      assert.deepEqual(kids.map((d) => d.id), top.subs.map((s) => s.id));
      assert.deepEqual(kids.map((d) => d.name), top.subs.map((s) => s.name));
      for (const k of kids) assert.equal(k.parentId, top.id, k.id + " 的父必须是 " + top.id);
    });
  }

  test("交叉校验：EXPECTED 子分类总数 = 80，且与 DEFAULT_TAXONOMY 逐分类一致", () => {
    const declared = EXPECTED.reduce((n, t) => n + t.subs.length, 0);
    assert.equal(declared, 80);
    let fromDefs = 0;
    for (const top of EXPECTED) fromDefs += childrenOf(top.id).length;
    assert.equal(fromDefs, 80);
  });

  test("v2 的旧子分类 ID 在 v3 已不存在（防止规则/测试回退到旧 ID）", () => {
    const v2Ids = [
      "clothing.swimwear", "clothing.shoes", "clothing.socks", "clothing.other",
      "tools.avatar_edit", "tools.modular_avatar", "tools.upload", "tools.automation", "tools.other",
      "accessories.headwear", "accessories.hand", "accessories.horns", "accessories.other",
      "makeup.eye", "makeup.lip", "makeup.face_texture", "makeup.skin_texture", "makeup.other",
      "hair.model", "hair.texture", "hair.other", "models.parts", "models.other",
      "textures.texture", "textures.material", "textures.material_preset", "textures.other",
      "shaders.shader", "shaders.preset", "shaders.postprocess", "shaders.other",
      "animation.anim", "animation.controller", "animation.other", "effects.preset", "effects.other",
      "audio.music", "audio.other", "worlds.vrchat", "worlds.scene", "worlds.environment", "worlds.other",
      "ui.component", "ui.other", "other.uncategorized", "other.review", "other.misc",
    ];
    for (const id of v2Ids) assert.equal(categoryById(id), null, "v2 旧 ID 不得再存在: " + id);
  });
});

describe("系统分类「未分类」", () => {
  test("是系统分类（builtin=1）、无子分类、sort=1500", () => {
    const unc = categoryById(UNCATEGORIZED_ID);
    assert.ok(unc, "未分类必须在树里");
    assert.equal(unc!.name, UNCATEGORIZED_LABEL);
    assert.equal(unc!.parentId, null);
    assert.equal(unc!.builtin, true, "未分类是系统分类，不可删除/停用");
    assert.equal(unc!.sort, 1500);
    assert.deepEqual(childrenOf(UNCATEGORIZED_ID), []);
    assert.equal(childrenOf(UNCATEGORIZED_ID).length, EXPECTED_SUB_COUNTS[UNCATEGORIZED_ID]);
  });

  test("isUncategorized：null/空/unknown 与 uncategorized 视为未分类；其它分类不是", () => {
    assert.equal(isUncategorized(null), true);
    assert.equal(isUncategorized(undefined), true);
    assert.equal(isUncategorized(""), true);
    assert.equal(isUncategorized(UNCATEGORIZED_ID), true);
    assert.equal(isUncategorized("clothing"), false);
    assert.equal(isUncategorized("clothing.tops"), false);
    assert.equal(isUncategorized("other.unclassed"), false, "「其他 › 暂未归类」是与未分类不同的分类");
  });
});

describe("两层限制：任何子分类的父必须是一级分类", () => {
  test("每个 parentId !== null 的定义，其父存在且父自身 parentId === null", () => {
    const byId = new Map(DEFAULT_TAXONOMY.map((d) => [d.id, d]));
    for (const d of DEFAULT_TAXONOMY) {
      if (d.parentId === null) continue;
      const p = byId.get(d.parentId);
      assert.ok(p, d.id + " 的父分类必须存在: " + d.parentId);
      assert.equal(p!.parentId, null, d.id + " 的父 " + p!.id + " 必须是一级分类（不得三层）");
    }
  });

  test("不存在第三层：任何分类的子分类都不会再有子分类", () => {
    for (const d of DEFAULT_TAXONOMY) {
      for (const k of childrenOf(d.id)) assert.equal(k.parentId, d.id);
    }
    for (const d of DEFAULT_TAXONOMY) if (d.parentId !== null) assert.ok(!DEFAULT_TAXONOMY.some((x) => x.parentId === d.id), d.id + " 不得有孙分类");
    assert.equal(new Set(DEFAULT_TAXONOMY.map((d) => d.id)).size, 95, "ID 唯一");
  });
});

describe("ID 唯一 + 查询函数行为", () => {
  test("ID 全局唯一（95 个不重复）", () => {
    const ids = DEFAULT_TAXONOMY.map((d) => d.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  test("categoryById：已知 ID 返回定义，未知/空返回 null", () => {
    assert.equal(categoryById("clothing")?.name, "服饰");
    assert.equal(categoryById("clothing.shoes_socks")?.name, "鞋袜");
    assert.equal(categoryById("hair.twintails")?.name, "双马尾");
    assert.equal(categoryById("nope"), null);
    assert.equal(categoryById(null), null);
    assert.equal(categoryById(undefined), null);
    assert.equal(categoryById(""), null);
  });

  test("categoryPath：一级 → [一级]，子分类 → [父, 子]，未知 → []", () => {
    assert.deepEqual(categoryPath("clothing").map((d) => d.id), ["clothing"]);
    assert.deepEqual(categoryPath("clothing.tops").map((d) => d.id), ["clothing", "clothing.tops"]);
    assert.deepEqual(categoryPath("clothing.tops").map((d) => d.name), ["服饰", "上衣"]);
    assert.deepEqual(categoryPath("nope"), []);
    assert.deepEqual(categoryPath(null), []);
    // 每个子分类的路径都是两层
    for (const d of DEFAULT_TAXONOMY) if (d.parentId !== null) assert.equal(categoryPath(d.id).length, 2, d.id);
  });

  test("childrenOf：只返回直接子分类；未知/叶子返回 []", () => {
    assert.equal(childrenOf("clothing").length, 8);
    assert.deepEqual(childrenOf("clothing.tops"), []);
    assert.deepEqual(childrenOf("uncategorized"), []);
    assert.deepEqual(childrenOf("nope"), []);
    assert.equal(EXPECTED.flatMap((t) => childrenOf(t.id)).length, 80);
  });

  test("isAncestor：仅直接父返回 true；自身/无关/未知/空返回 false", () => {
    assert.equal(isAncestor("clothing", "clothing.tops"), true);
    assert.equal(isAncestor("clothing", "clothing"), false);
    assert.equal(isAncestor("clothing", "accessories.hat"), false);
    assert.equal(isAncestor("accessories", "accessories.hat"), true);
    assert.equal(isAncestor("clothing", null), false);
    assert.equal(isAncestor("clothing", "nope"), false);
    assert.equal(isAncestor("clothing.tops", "clothing.tops"), false);
    for (const d of DEFAULT_TAXONOMY) if (d.parentId !== null) assert.equal(isAncestor(d.parentId, d.id), true, d.id);
  });
});
