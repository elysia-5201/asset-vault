import { test } from "node:test";
import assert from "node:assert/strict";
import { productKeysOf, relateItems, type RelatedInput } from "../src/related";

/** 造条目：只写关心的字段。 */
function item(itemId: number, title: string, extra: Partial<RelatedInput> = {}): RelatedInput {
  return { itemId, title, tags: [], entryNames: [], ...extra };
}

// ------------------------------------------------- 正例：真実の穴（模型包 ↔ 材质包）

/** 真实形态：#6 是 BOOTH 条目的 18 个分包，展开后的一级条目名。 */
const CAVE_ENTRIES = [
  "(The Cave of Truth)V1.zip", "AIRI_V2.zip", "CHOCOLAT_CHIFFON_PLUM_V2.zip", "ICHIGO_V2.zip",
  "KUMALY_V2.zip", "LASYUSHA_V2.zip", "LUMINA_V2.zip", "MANUKA_V2.zip", "MAYO_V2.zip",
  "MILFY_EKU_V2.zip", "MILLTINA_V2.zip", "MISAKI.zip", "MOE_V2.zip", "RAMUNE_V2.zip",
  "RURUNE_MIZUKI_V2.zip", "SELESTIA_V2.zip", "SHINANO_V2.zip", "SIO_V2.zip",
];

test("related: 正例 —— 真実の穴 V2.zip ↔ 真実の穴_Material.zip 认成同一商品", () => {
  const a = item(27, "真実の穴_Material", { entryNames: ["READ ME.png", "真実の穴_Material.unitypackage"] });
  const b = item(6, "💗真実の穴 (The Cave of Truth)💗", { entryNames: CAVE_ENTRIES });
  const m = relateItems(a, b);
  assert.ok(m, "必须匹配上");
  assert.equal(m.itemId, 6);
  assert.equal(m.score, 1);
  assert.equal(m.level, "same-product");
  assert.ok(m.shared.includes("真実の穴"), "shared 必须含「真実の穴」");
  // 包内文件（真実の穴_Material.unitypackage）也命中 → reason 用"标题/包内文件"
  assert.equal(m.reason, "标题/包内文件共有「真実の穴」");
});

test("related: 正例方向无关（材质包在前也认得出）", () => {
  const a = item(6, "💗真実の穴 (The Cave of Truth)💗", { entryNames: CAVE_ENTRIES });
  const b = item(27, "真実の穴_Material", { entryNames: ["READ ME.png", "真実の穴_Material.unitypackage"] });
  const m = relateItems(a, b);
  assert.ok(m);
  assert.equal(m.itemId, 27);
  assert.equal(m.level, "same-product");
});

// ------------------------------------------------- 反例

test("related: 反例 —— Marshmallow_PB_DLC0_v2 ↔ Danzai_Bunny_For_Manuka_V1.4 → null", () => {
  assert.equal(relateItems(item(1, "Marshmallow_PB_DLC0_v2"), item(2, "Danzai_Bunny_For_Manuka_V1.4")), null);
});

test("related: 反例 —— 都带 material 但不是同商品（MilkyWay Makeup Texture ↔ 真実の穴_Material）→ null", () => {
  assert.equal(relateItems(item(1, "MilkyWay Makeup Texture"), item(2, "真実の穴_Material")), null);
});

// ------------------------------------------------- 噪音词 / 版本 / 数字

test("related: 噪音词剥离 —— XXX_MaterialPack_v1.2.zip 的 keys 不含 materialpack/v1.2/zip", () => {
  const keys = productKeysOf("XXX_MaterialPack_v1.2.zip").map((k) => k.toLowerCase());
  assert.ok(keys.includes("xxx"), "产品名 XXX 必须保留：" + JSON.stringify(keys));
  assert.ok(!keys.includes("materialpack"), "materialpack 是噪音");
  assert.ok(!keys.includes("v1.2"), "v1.2 是版本号");
  assert.ok(!keys.includes("zip"), "zip 是包装格式");
});

test("related: 版本片段独立判断 —— v2/1.2/1.2.3/バージョン3 丢，007 留", () => {
  for (const v of ["v2", "V2", "1.2", "1.2.3", "v1.4", "バージョン3"]) {
    assert.ok(!productKeysOf("Product " + v).some((k) => k.toLowerCase() === v.toLowerCase()), v + " 应被当版本丢掉");
  }
  assert.deepEqual(productKeysOf("007"), ["007"], "纯数字不是版本号，必须保留");
});

test("related: 数字/短中日文片段不被误丢 —— 25Avatars / 伊吹", () => {
  assert.ok(productKeysOf("25Avatars").includes("25Avatars"), "25Avatars 必须保留");
  assert.ok(productKeysOf("伊吹").includes("伊吹"), "2 字日文片段必须保留");
  assert.ok(productKeysOf("真実の穴").includes("真実の穴"));
});

test("related: 中日文与 ASCII 粘连要切开（真実の穴material → 真実の穴）", () => {
  const keys = productKeysOf("真実の穴material");
  assert.deepEqual(keys, ["真実の穴"], "material 是噪音，真実の穴 必须独立切出来");
});

test("related: READ ME 是短语噪音（不产生 read / me 两个片段）", () => {
  assert.deepEqual(productKeysOf("READ ME.png"), []);
});

// ------------------------------------------------- entryNames / 标签 / 阈值

test("related: entryNames 单独命中是弱证据（0.55，默认 min=0.6 不出现）", () => {
  // 口径更新（Lead）：包内一级条目名单独命中大多是 per-avatar 目录名（LUMINA_V2.zip / MISAKI.zip…），
  // 这些 base 不在头像表里，靠黑名单挡不住 → 只给 0.55，默认阈值下不出现；放宽 min 才看得到。
  const a = item(1, "some pack", { entryNames: ["KikyoOutfit/", "KikyoOutfit/Model.fbx"] });
  const b = item(2, "別商品", { entryNames: ["KikyoOutfit_Material/"] });
  assert.equal(relateItems(a, b), null, "默认 min=0.6 时不该返回");
  const m = relateItems(a, b, 0.5);
  assert.ok(m);
  assert.equal(m.score, 0.55);
  assert.equal(m.level, "likely");
  assert.equal(m.reason, "仅包内文件名共有「KikyoOutfit」");
});

test("related: 标签能参与匹配，但**仅标签**命中的是弱证据（0.65 / likely）", () => {
  // 口径更新（Lead）：标题对不上、只有标签相同 → 不算"同商品"，降级到 0.65 让标题/包内命中排在前面。
  // 起因：#6 有 33 个标签（VRChat / マヌカ …），不降级会导致反向查同商品时前 10 条全是标签误报。
  const m = relateItems(item(1, "Pack A", { tags: ["真実の穴"] }), item(2, "Pack B", { tags: ["真実の穴"] }));
  assert.ok(m);
  assert.equal(m.level, "likely");
  assert.equal(m.score, 0.6);
  assert.equal(m.reason, "仅标签共有「真実の穴」");
});

test("related: 前缀/子串达到 0.6×min 长度 → likely 0.75（不是 same-product）", () => {
  const m = relateItems(item(1, "HoshinoStar"), item(2, "HoshinoStarPlus"));
  assert.ok(m);
  assert.equal(m.score, 0.75);
  assert.equal(m.level, "likely");
});

test("related: 低于 minScore 返回 null（likely 0.75 在 min=0.9 下被滤掉）", () => {
  assert.equal(relateItems(item(1, "HoshinoStar"), item(2, "HoshinoStarPlus"), 0.9), null);
  // exact 1.0 仍然过 0.9
  const m = relateItems(item(1, "真実の穴"), item(2, "真実の穴_Material"), 0.9);
  assert.ok(m);
  assert.equal(m.level, "same-product");
});

test("related: shared 去重、按长度降序、最多 5 个", () => {
  const a = item(1, "AlphaBetaGamma alphabetaGAMMA DeltaEpsilon 伊吹 ZZ");
  const b = item(2, "AlphaBetaGamma DeltaEpsilon 伊吹 ZZ");
  const m = relateItems(a, b);
  assert.ok(m);
  assert.ok(m.shared.length <= 5);
  const lens = m.shared.map((s) => [...s].length);
  assert.deepEqual(lens, [...lens].sort((x, y) => y - x), "必须按长度降序：" + JSON.stringify(m.shared));
  assert.equal(new Set(m.shared).size, m.shared.length, "必须去重");
  assert.equal(m.reason, "标题共有「AlphaBetaGamma」");
});

test("related: 空输入不崩（无标题/无 key）", () => {
  assert.deepEqual(productKeysOf(""), []);
  assert.equal(relateItems(item(1, "!!! ???"), item(2, "真実の穴")), null);
  assert.equal(relateItems(item(1, "真実の穴"), { itemId: 2, title: "" }), null);
});

// ------------------------------------------------- 仅标签命中：必须降级（防止通用标签刷屏）

test("related: 只有标签相同 → 降级 0.65/likely，且排在标题命中之后", () => {
  const a = item(1, "AAA", { tags: ["共通タグ"] });
  const b = item(2, "BBB", { tags: ["共通タグ"] });
  const m = relateItems(a, b);
  assert.ok(m, "默认 min=0.6 时仍应返回（只是弱证据）");
  assert.equal(m!.score, 0.6);
  assert.equal(m!.level, "likely");
  assert.equal(m!.reason, "仅标签共有「共通タグ」");
  assert.equal(relateItems(a, b, 0.7), null, "阈值抬到 0.7 就该被过滤");
});

test("related: 标题命中优先于标签命中（分数不被标签拉低）", () => {
  const a = item(1, "真実の穴", { tags: ["共通タグ"] });
  const b = item(2, "真実の穴_Material", { tags: ["共通タグ"] });
  const m = relateItems(a, b);
  // 两个标题切出来的产品名片段完全相同（"material" 是噪音词）→ exact，1.0；关键是**没有被标签拉到 0.65**
  assert.equal(m!.score, 1);
  assert.equal(m!.level, "same-product");
  assert.match(m!.reason, /标题/);
});
