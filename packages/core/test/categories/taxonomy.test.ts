/**
 * 物品分类 — 分类定义（taxonomy）契约测试
 *
 * 被测：packages/core/src/categories/taxonomy.ts（冻结契约，见 docs/categories.md §2）
 * 依据：docs/categories.md §2「14 主分类 / 79 子分类 = 93 个」+ 需求给定的分类名（发布后 ID 不得改）
 * 方法：正例（DEFAULT_TAXONOMY 必须合法且与契约逐项一致）+ 负例（validateTaxonomy 必须能抓出
 *       重复 ID / 缺失父 / 三层结构，防止"校验其实永远返回空数组"的假绿）。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_TAXONOMY, CATEGORY_MAX_DEPTH, validateTaxonomy, topCategories, childrenOf,
  categoryById, categoryPath, isAncestor, type CategoryDef,
} from "../../src/categories/taxonomy";

/** 冻结契约：14 主分类 + 各自子分类的 ID/名称（顺序按 sort）。 */
const EXPECTED: { id: string; name: string; subs: { id: string; name: string }[] }[] = [
  { id: "clothing", name: "服装", subs: [
    { id: "clothing.tops", name: "上衣" }, { id: "clothing.bottoms", name: "下装" },
    { id: "clothing.dress", name: "连衣裙" }, { id: "clothing.suit", name: "套装" },
    { id: "clothing.coat", name: "外套" }, { id: "clothing.underwear", name: "内衣" },
    { id: "clothing.swimwear", name: "泳装" }, { id: "clothing.shoes", name: "鞋子" },
    { id: "clothing.socks", name: "袜子" }, { id: "clothing.other", name: "其他服装" },
  ] },
  { id: "tools", name: "工具", subs: [
    { id: "tools.unity", name: "Unity 工具" }, { id: "tools.avatar_edit", name: "Avatar 编辑工具" },
    { id: "tools.modular_avatar", name: "Modular Avatar 工具" }, { id: "tools.upload", name: "上传与管理工具" },
    { id: "tools.automation", name: "自动化工具" }, { id: "tools.other", name: "其他工具" },
  ] },
  { id: "accessories", name: "饰品", subs: [
    { id: "accessories.headwear", name: "头饰" }, { id: "accessories.hair_ornament", name: "发饰" },
    { id: "accessories.earring", name: "耳饰" }, { id: "accessories.necklace", name: "项链" },
    { id: "accessories.hand", name: "手饰" }, { id: "accessories.glasses", name: "眼镜" },
    { id: "accessories.tail", name: "尾巴" }, { id: "accessories.wings", name: "翅膀" },
    { id: "accessories.horns", name: "角与兽耳" }, { id: "accessories.other", name: "其他饰品" },
  ] },
  { id: "makeup", name: "妆容", subs: [
    { id: "makeup.eye", name: "眼妆" }, { id: "makeup.lip", name: "唇妆" },
    { id: "makeup.blush", name: "腮红" }, { id: "makeup.face_texture", name: "面部贴图" },
    { id: "makeup.skin_texture", name: "皮肤贴图" }, { id: "makeup.other", name: "其他妆容" },
  ] },
  { id: "hair", name: "头发", subs: [
    { id: "hair.model", name: "发型模型" }, { id: "hair.texture", name: "发型贴图" },
    { id: "hair.other", name: "其他头发资源" },
  ] },
  { id: "models", name: "Avatar 与模型", subs: [
    { id: "models.avatar", name: "完整 Avatar" }, { id: "models.body", name: "身体模型" },
    { id: "models.head", name: "头部模型" }, { id: "models.parts", name: "模型部件" },
    { id: "models.other", name: "其他模型" },
  ] },
  { id: "textures", name: "纹理与材质", subs: [
    { id: "textures.texture", name: "贴图" }, { id: "textures.material", name: "材质" },
    { id: "textures.material_preset", name: "材质预设" }, { id: "textures.eye", name: "眼睛资源" },
    { id: "textures.skin", name: "皮肤资源" }, { id: "textures.other", name: "其他纹理材质" },
  ] },
  { id: "shaders", name: "Shader 与渲染", subs: [
    { id: "shaders.shader", name: "Shader" }, { id: "shaders.preset", name: "Shader 预设" },
    { id: "shaders.effect", name: "渲染效果" }, { id: "shaders.postprocess", name: "后处理" },
    { id: "shaders.other", name: "其他渲染资源" },
  ] },
  { id: "animation", name: "动画与动作", subs: [
    { id: "animation.anim", name: "动画" }, { id: "animation.dance", name: "舞蹈" },
    { id: "animation.pose", name: "姿势" }, { id: "animation.expression", name: "表情" },
    { id: "animation.gesture", name: "手势" }, { id: "animation.controller", name: "动画控制器" },
    { id: "animation.other", name: "其他动画资源" },
  ] },
  { id: "effects", name: "特效", subs: [
    { id: "effects.particle", name: "粒子系统" }, { id: "effects.preset", name: "特效预设" },
    { id: "effects.light", name: "光效" }, { id: "effects.other", name: "其他特效" },
  ] },
  { id: "audio", name: "音频", subs: [
    { id: "audio.sfx", name: "音效" }, { id: "audio.music", name: "音乐" },
    { id: "audio.voice", name: "语音" }, { id: "audio.other", name: "其他音频" },
  ] },
  { id: "worlds", name: "场景与世界", subs: [
    { id: "worlds.vrchat", name: "VRChat World" }, { id: "worlds.scene", name: "Unity 场景" },
    { id: "worlds.skybox", name: "天空盒" }, { id: "worlds.environment", name: "环境资源" },
    { id: "worlds.other", name: "其他场景资源" },
  ] },
  { id: "ui", name: "UI 与界面", subs: [
    { id: "ui.component", name: "UI 组件" }, { id: "ui.icon", name: "图标" },
    { id: "ui.hud", name: "HUD" }, { id: "ui.menu", name: "菜单" },
    { id: "ui.other", name: "其他 UI 资源" },
  ] },
  { id: "other", name: "其他", subs: [
    { id: "other.uncategorized", name: "未分类" }, { id: "other.review", name: "待人工确认" },
    { id: "other.misc", name: "其他资源" },
  ] },
];

/** 需求给定的每主分类子分类数量（与 EXPECTED 互为交叉校验，防止两边一起写错）。 */
const EXPECTED_SUB_COUNTS: Record<string, number> = {
  clothing: 10, tools: 6, accessories: 10, makeup: 6, hair: 3, models: 5, textures: 6,
  shaders: 5, animation: 7, effects: 4, audio: 4, worlds: 5, ui: 5, other: 3,
};

describe("DEFAULT_TAXONOMY 结构合法", () => {
  test("正例：validateTaxonomy(DEFAULT_TAXONOMY) 返回空错误列表", () => {
    assert.deepEqual(validateTaxonomy(DEFAULT_TAXONOMY), []);
  });

  test("总数 93 = 14 主分类 + 79 子分类（docs/categories.md §2）", () => {
    const tops = topCategories(DEFAULT_TAXONOMY);
    assert.equal(tops.length, 14);
    assert.equal(DEFAULT_TAXONOMY.length, 93);
    assert.equal(DEFAULT_TAXONOMY.length - tops.length, 79);
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
      assert.equal(d.builtin, true, d.id + " 默认必须 builtin");
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
  });
});

describe("14 个主分类：名称与顺序与需求一致", () => {
  test("主分类数量、ID、名称逐项一致（按 sort 排序）", () => {
    const tops = topCategories(DEFAULT_TAXONOMY);
    assert.deepEqual(tops.map((d) => d.id), EXPECTED.map((d) => d.id));
    assert.deepEqual(tops.map((d) => d.name), [
      "服装", "工具", "饰品", "妆容", "头发", "Avatar 与模型", "纹理与材质",
      "Shader 与渲染", "动画与动作", "特效", "音频", "场景与世界", "UI 与界面", "其他",
    ]);
  });

  test("主分类必须 parentId === null（两层结构的第一层）", () => {
    for (const d of topCategories(DEFAULT_TAXONOMY)) assert.equal(d.parentId, null, d.id);
  });
});

describe("各主分类的子分类数量与名称完全符合需求", () => {
  for (const top of EXPECTED) {
    test(top.id + "（" + top.name + "）：" + EXPECTED_SUB_COUNTS[top.id] + " 个子分类，ID/名称/顺序一致", () => {
      const kids = childrenOf(top.id);
      assert.equal(kids.length, EXPECTED_SUB_COUNTS[top.id], top.id + " 子分类数量");
      assert.deepEqual(kids.map((d) => d.id), top.subs.map((s) => s.id));
      assert.deepEqual(kids.map((d) => d.name), top.subs.map((s) => s.name));
    });
  }

  test("交叉校验：EXPECTED 子分类总数 = 79，且每主分类数量与需求表一致", () => {
    const declared = EXPECTED.reduce((n, t) => n + t.subs.length, 0);
    assert.equal(declared, 79);
    let fromDefs = 0;
    for (const top of EXPECTED) fromDefs += childrenOf(top.id).length;
    assert.equal(fromDefs, 79);
    for (const top of EXPECTED) assert.equal(top.subs.length, EXPECTED_SUB_COUNTS[top.id], top.id);
  });
});

describe("两层限制：任何子分类的父必须是主分类", () => {
  test("每个 parentId !== null 的定义，其父存在且父自身 parentId === null", () => {
    const byId = new Map(DEFAULT_TAXONOMY.map((d) => [d.id, d]));
    for (const d of DEFAULT_TAXONOMY) {
      if (d.parentId === null) continue;
      const p = byId.get(d.parentId);
      assert.ok(p, d.id + " 的父分类必须存在: " + d.parentId);
      assert.equal(p!.parentId, null, d.id + " 的父 " + p!.id + " 必须是主分类（不得三层）");
    }
  });

  test("不存在第三层：任何分类的子分类都不会再有子分类", () => {
    for (const d of DEFAULT_TAXONOMY) {
      for (const k of childrenOf(d.id)) assert.equal(k.parentId, d.id);
    }
    const ids = new Set(DEFAULT_TAXONOMY.map((d) => d.id));
    for (const d of DEFAULT_TAXONOMY) if (d.parentId !== null) assert.ok(!DEFAULT_TAXONOMY.some((x) => x.parentId === d.id), d.id + " 不得有孙分类");
    assert.equal(ids.size, 93, "ID 唯一");
  });
});

describe("ID 唯一 + 查询函数行为", () => {
  test("ID 全局唯一（93 个不重复）", () => {
    const ids = DEFAULT_TAXONOMY.map((d) => d.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  test("categoryById：已知 ID 返回定义，未知/空返回 null", () => {
    assert.equal(categoryById("clothing")?.name, "服装");
    assert.equal(categoryById("clothing.tops")?.name, "上衣");
    assert.equal(categoryById("nope"), null);
    assert.equal(categoryById(null), null);
    assert.equal(categoryById(undefined), null);
    assert.equal(categoryById(""), null);
  });

  test("categoryPath：主分类 → [主]，子分类 → [主, 子]，未知 → []", () => {
    assert.deepEqual(categoryPath("clothing").map((d) => d.id), ["clothing"]);
    assert.deepEqual(categoryPath("clothing.tops").map((d) => d.id), ["clothing", "clothing.tops"]);
    assert.deepEqual(categoryPath("clothing.tops").map((d) => d.name), ["服装", "上衣"]);
    assert.deepEqual(categoryPath("nope"), []);
    assert.deepEqual(categoryPath(null), []);
    // 每个子分类的路径都是两层
    for (const d of DEFAULT_TAXONOMY) if (d.parentId !== null) assert.equal(categoryPath(d.id).length, 2, d.id);
  });

  test("childrenOf：只返回直接子分类；未知/叶子返回 []", () => {
    assert.equal(childrenOf("clothing").length, 10);
    assert.deepEqual(childrenOf("clothing.tops"), []);
    assert.deepEqual(childrenOf("nope"), []);
    const all = EXPECTED.flatMap((t) => childrenOf(t.id));
    assert.equal(all.length, 79);
  });

  test("isAncestor：仅直接父返回 true；自身/无关/未知/空返回 false", () => {
    assert.equal(isAncestor("clothing", "clothing.tops"), true);
    assert.equal(isAncestor("clothing", "clothing"), false);
    assert.equal(isAncestor("clothing", "accessories.headwear"), false);
    assert.equal(isAncestor("clothing", null), false);
    assert.equal(isAncestor("clothing", "nope"), false);
    assert.equal(isAncestor("clothing.tops", "clothing.tops"), false);
    for (const d of DEFAULT_TAXONOMY) if (d.parentId !== null) assert.equal(isAncestor(d.parentId, d.id), true, d.id);
  });
});
