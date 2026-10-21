/**
 * structure.ts 纯函数测试（task-37）
 *
 * 覆盖：别名/大小写/全半角/假名折叠、多模型、item_avatar=confirmed、文件名/包内路径=probable、
 *       mixed 判定（≥2 证据 / 显式确认）、外层 ZIP 多 upkg=multi、单 upkg 按该包判、损坏=unknown、
 *       关系只到 probable、不误配、limitPerUnit。
 *
 * 归一化复用 avatars/normalize + avatars/detect（不写第二套），因此这里断言的是"对外契约"而非内部实现。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  decidePolicy,
  detectUnitAvatars,
  relationCandidates,
  type AvatarLite,
  type StructureUnit,
} from "../../src/structure";

const AVATARS: AvatarLite[] = [
  { id: 1, name: "MANUKA", aliases: ["マヌカ", "manuka"] },
  { id: 2, name: "Shinano", aliases: ["しなの", "シナノ"] },
  { id: 3, name: "Milfy", aliases: ["ミルフィ", "みるふぃ"] },
];

// ---------------------------------------------------------------- 模型证据

describe("detectUnitAvatars：证据与等级", () => {
  test("全半角/大小写/别名：ＭＡＮＵＫＡ 命中 MANUKA（probable/filename）", () => {
    const out = detectUnitAvatars(["ＭＡＮＵＫＡ_衣装.zip"], AVATARS);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.avatarId, 1);
    assert.equal(out[0]!.via, "filename");
    assert.equal(out[0]!.level, "probable");
    assert.deepEqual(out[0]!.hits, ["ＭＡＮＵＫＡ_衣装.zip"]);
  });

  test("假名折叠：ミルフィ / みるふぃ / ﾐﾙﾌｨ 都命中 Milfy；含平假名别名同样命中", () => {
    for (const text of ["ミルフィ専用テクスチャ.zip", "みるふぃ対応.zip", "ﾐﾙﾌｨ.zip"]) {
      const out = detectUnitAvatars([text], AVATARS);
      assert.equal(out.length, 1, "应命中：" + text);
      assert.equal(out[0]!.avatarId, 3);
    }
  });

  test("一段文本里多个模型 → 每个模型一条证据", () => {
    const out = detectUnitAvatars(["【MANUKA/Shinano】衣装.zip"], AVATARS);
    assert.deepEqual(out.map((e) => e.avatarId).sort((a, b) => a - b), [1, 2]);
  });

  test("包内路径（含 /）→ via=package_path；文件名 → via=filename", () => {
    const out = detectUnitAvatars(["Assets/MANUKA/Body.prefab"], AVATARS);
    assert.equal(out[0]!.via, "package_path");
    const out2 = detectUnitAvatars(["Body_MANUKA.prefab"], AVATARS);
    assert.equal(out2[0]!.via, "filename");
  });

  test("item_avatar → confirmed，且与文本证据合并（等级取高、hits 去重合并）", () => {
    const out = detectUnitAvatars(["MANUKA.zip"], AVATARS, [1]);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.level, "confirmed");
    assert.equal(out[0]!.via, "item_avatar");
    assert.deepEqual(out[0]!.hits, ["MANUKA.zip", "item_avatar:1"]);
  });

  test("同一模型多条文本 → 合并成一条、hits 全保留", () => {
    const out = detectUnitAvatars(["MANUKA_body.fbx", "MANUKA_tex.zip"], AVATARS);
    assert.equal(out.length, 1);
    assert.deepEqual(out[0]!.hits, ["MANUKA_body.fbx", "MANUKA_tex.zip"]);
  });

  test("无命中不返回；未知 itemAvatarId 忽略；空输入返回空", () => {
    assert.deepEqual(detectUnitAvatars(["unknown_pack.zip"], AVATARS), []);
    assert.deepEqual(detectUnitAvatars(["plain.zip"], AVATARS, [999]), []);
    assert.deepEqual(detectUnitAvatars([], AVATARS), []);
    assert.deepEqual(detectUnitAvatars(["MANUKA.zip"], []), []);
  });

  test("不误配：过短拉丁别名被过滤；拉丁词边界（Sio 不落在 passion 里）", () => {
    const short = [{ id: 9, name: "Ai", aliases: [] }];
    assert.deepEqual(detectUnitAvatars(["train.png"], short), [], "2 字符拉丁别名应被过滤");
    const sio = [{ id: 10, name: "Sio", aliases: [] }];
    assert.deepEqual(detectUnitAvatars(["passion.zip"], sio), []);
    assert.equal(detectUnitAvatars(["Sio対応.zip"], sio).length, 1);
  });
});

// ---------------------------------------------------------------- 结构判定

describe("decidePolicy：结构判定", () => {
  const base = { container: "unitypackage", kind: "unitypackage", innerUnitypackagePaths: [], mixedAvatarCount: 0, parseState: "ok" as const };

  test("unitypackage：0/1 个模型证据 → single", () => {
    assert.equal(decidePolicy({ ...base }).policy, "single_unitypackage");
    assert.equal(decidePolicy({ ...base, mixedAvatarCount: 1 }).policy, "single_unitypackage");
  });

  test("unitypackage：≥2 个不同模型 → mixed；显式 mixedConfirmed 也 mixed", () => {
    assert.equal(decidePolicy({ ...base, mixedAvatarCount: 2 }).policy, "mixed_unitypackage");
    assert.equal(decidePolicy({ ...base, mixedConfirmed: true }).policy, "mixed_unitypackage");
  });

  test("unitypackage：解析失败且无证据 → unknown（不猜）；partial + ≥2 证据 → mixed（硬证据）", () => {
    assert.equal(decidePolicy({ ...base, parseState: "failed" }).policy, "unknown_structure");
    assert.equal(decidePolicy({ ...base, parseState: "partial" }).policy, "unknown_structure");
    assert.equal(decidePolicy({ ...base, parseState: "partial", mixedAvatarCount: 3 }).policy, "mixed_unitypackage");
  });

  test("archive：多个 upkg → multi_package_container（不整体当混合包拆）", () => {
    const d = decidePolicy({ container: "zip", kind: "archive", innerUnitypackagePaths: ["a/x.unitypackage", "b/y.unitypackage"], mixedAvatarCount: 5, parseState: "ok" });
    assert.equal(d.policy, "multi_package_container");
    assert.match(d.reason, /独立 unitypackage|逐包/);
  });

  test("archive：单个 upkg 按该包判（≥2→mixed，否则 single）", () => {
    const one = { container: "zip", kind: "archive", innerUnitypackagePaths: ["x.unitypackage"], parseState: "ok" as const };
    assert.equal(decidePolicy({ ...one, mixedAvatarCount: 2 }).policy, "mixed_unitypackage");
    assert.equal(decidePolicy({ ...one, mixedAvatarCount: 1 }).policy, "single_unitypackage");
    assert.equal(decidePolicy({ ...one, mixedConfirmed: true, mixedAvatarCount: 0 }).policy, "mixed_unitypackage");
  });

  test("archive：单 upkg 但解析 partial 且无证据 → unknown", () => {
    assert.equal(decidePolicy({ container: "zip", kind: "archive", innerUnitypackagePaths: ["x.unitypackage"], mixedAvatarCount: 0, parseState: "partial" }).policy, "unknown_structure");
  });

  test("archive：无 upkg → unknown（不是 Unity 包容器）；解析失败 → unknown", () => {
    const none = decidePolicy({ container: "zip", kind: "archive", innerUnitypackagePaths: [], mixedAvatarCount: 0, parseState: "ok" });
    assert.equal(none.policy, "unknown_structure");
    assert.match(none.reason, /未发现 unitypackage|不是 Unity 包容器/);
    assert.equal(decidePolicy({ container: "7z", kind: "archive", innerUnitypackagePaths: [], mixedAvatarCount: 0, parseState: "failed" }).policy, "unknown_structure");
  });

  test("inner 路径去重；其它 kind → unknown", () => {
    const dup = decidePolicy({ container: "zip", kind: "archive", innerUnitypackagePaths: ["x.unitypackage", "x.unitypackage"], mixedAvatarCount: 0, parseState: "ok" });
    assert.equal(dup.policy, "single_unitypackage", "重复路径应按 1 个算");
    assert.equal(decidePolicy({ container: "dir", kind: "folder", innerUnitypackagePaths: [], mixedAvatarCount: 0, parseState: "ok" }).policy, "unknown_structure");
  });
});

// ---------------------------------------------------------------- 关系建议

describe("relationCandidates：只到 probable", () => {
  const unit = (id: string, name: string, avatarIds: number[] = [], kind = "asset"): StructureUnit => ({ id, name, avatarIds, kind });

  test("模型 + 材质/贴图伴生 → suggested_companion/probable", () => {
    const rel = relationCandidates([
      unit("model", "MANUKA", [], "model"),
      unit("tex", "MANUKA_material", [], "texture"),
    ]);
    assert.equal(rel.length, 1);
    assert.equal(rel[0]!.type, "suggested_companion");
    assert.equal(rel[0]!.confidence, "probable");
    assert.equal(rel[0]!.from, "model");
    assert.equal(rel[0]!.to, "tex");
  });

  test("P-6 回归：同 avatar 的 MODEL/MATERIAL/TEXTURE 三件套 → 3 条 suggested_companion（不是 optional_variant）", () => {
    const rel = relationCandidates([
      unit("model", "MANUKA", [1], "model"),
      unit("mat", "MANUKA_material", [1], "material"),
      unit("tex", "MANUKA_texture", [1], "texture"),
    ]);
    assert.equal(rel.length, 3, "三件套两两成对");
    for (const r of rel) assert.equal(r.type, "suggested_companion", "伴生必须优先于同名变体");
    assert.equal(rel.some((r) => r.type === "optional_variant"), false);
  });

  test("B-1c 回归：unit.name 带 .unitypackage 长扩展名也要能配对（伴生与变体都成立）", () => {
    // 服务端传的是磁盘文件名；".unitypackage" 12 字符，旧的 1..6 位扩展名规则剥不掉 → 全部失配
    const companion = relationCandidates([
      unit("model", "MANUKA_model.unitypackage", [1], "unitypackage"),
      unit("mat", "MANUKA_material.unitypackage", [1], "unitypackage"),
    ]);
    assert.equal(companion.length, 1, "带长扩展名也必须判出伴生");
    assert.equal(companion[0]!.type, "suggested_companion");

    const trio = relationCandidates([
      unit("model", "MANUKA_model.unitypackage", [1], "unitypackage"),
      unit("mat", "MANUKA_material.unitypackage", [1], "unitypackage"),
      unit("tex", "MANUKA_texture.unitypackage", [1], "unitypackage"),
    ]);
    assert.equal(trio.length, 3);
    for (const r of trio) assert.equal(r.type, "suggested_companion");

    const variant = relationCandidates([
      unit("a", "Outfit.unitypackage", [1], "unitypackage"),
      unit("b", "Outfit_v2.unitypackage", [1], "unitypackage"),
    ]);
    assert.equal(variant.length, 1);
    assert.equal(variant[0]!.type, "optional_variant");

    // 同一单元换容器扩展名（.unitypackage / .zip）→ 视为同名重复，不产出关系
    assert.deepEqual(relationCandidates([
      unit("a", "MANUKA.unitypackage", [1], "unitypackage"),
      unit("b", "MANUKA.zip", [1], "archive"),
    ]), []);
  });

  test("同模型同名变体（Outfit / Outfit_v2）→ optional_variant/probable", () => {
    const rel = relationCandidates([unit("a", "Outfit", [1], "outfit"), unit("b", "Outfit_v2", [1], "outfit")]);
    assert.equal(rel.length, 1);
    assert.equal(rel[0]!.type, "optional_variant");
    assert.equal(rel[0]!.confidence, "probable");
  });

  test("不会误配：不同主干 / 无 avatar 且无后缀差异 / 完全同名重复条目 → 不产出", () => {
    assert.deepEqual(relationCandidates([unit("a", "OutfitA"), unit("b", "OutfitB")]), []);
    assert.deepEqual(relationCandidates([unit("a", "Body"), unit("b", "Body")]), []);
    assert.deepEqual(relationCandidates([unit("a", "Body", [1]), unit("b", "Body", [2])]), []);
  });

  test("永不输出 confirmed；limitPerUnit 生效；结果按 from/to 稳定排序", () => {
    const units = [unit("m", "MANUKA", [], "model"), unit("t1", "MANUKA_texture"), unit("t2", "MANUKA_material"), unit("t3", "MANUKA_mat")];
    const rel = relationCandidates(units, { limitPerUnit: 2 });
    assert.ok(rel.length > 0);
    for (const r of rel) assert.equal(r.confidence, "probable");
    // limitPerUnit 是**每个单元**的出边上限，不是总条数
    const count = new Map<string, number>();
    for (const r of rel) {
      count.set(r.from, (count.get(r.from) ?? 0) + 1);
      count.set(r.to, (count.get(r.to) ?? 0) + 1);
    }
    for (const [id, n] of count) assert.ok(n <= 2, id + " 的关系数 " + n + " 超过 limitPerUnit=2");
    const sorted = [...rel].sort((x, y) => (x.from === y.from ? (x.to < y.to ? -1 : 1) : x.from < y.from ? -1 : 1));
    assert.deepEqual(rel.map((r) => r.from + ">" + r.to), sorted.map((r) => r.from + ">" + r.to));
  });

  test("空输入与非法单元 → 空数组（不抛）", () => {
    assert.deepEqual(relationCandidates([]), []);
    assert.deepEqual(relationCandidates([{ id: "x", name: "  ", avatarIds: [], kind: "asset" }]), []);
  });
});
