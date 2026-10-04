/**
 * avatars/detect 单测。
 * 真实语料（2026-10-04 抓取/采集）：
 *  - fixtures/booth-{8183383,6115428,6494376}.json：真实 BOOTH 商品 JSON（标题/标签/描述/planned 名单）
 *  - CONTRACT §5 的本机素材库/压缩包清单（zip 条目、unitypackage pathname）
 * 每个断言都配了正例/反例对照，避免退化度量（例如“命中数恒等于声明数”这种没有信息量的指标）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { detectAvatars, avatarNamesFromPaths, extractPlannedRegion } from "../../src/avatars/detect";
import type { AvatarDetectionInput, KnownAvatar } from "../../src/contracts";

const fx = (f: string): any => JSON.parse(readFileSync(new URL("../identify/fixtures/" + f, import.meta.url), "utf8"));

/** 真实 BOOTH 商品 → detectAvatars 入参。 */
function inputFromBooth(item: any): AvatarDetectionInput {
  return {
    title: item.name,
    description: item.description,
    tags: (item.tags ?? []).map((t: any) => t.name),
  };
}

const KNOWN: KnownAvatar[] = [
  { name: "Milfy", aliases: ["ミルフィ", "みるふぃ", "Milfy", "ミルフィちゃん"], kind: "avatar" },
  { name: "Manuka", aliases: ["マヌカ", "MANUKA", "まぬか"], kind: "avatar" },
  { name: "Shinano", aliases: ["しなの", "シナノ", "Shinano", "しなのちゃん"], kind: "avatar" },
  { name: "Sio", aliases: ["Sio", "しお"], kind: "avatar" },
  { name: "Airi", aliases: ["愛莉", "Airi", "あいり"], kind: "avatar" },
  { name: "Chocolat", aliases: ["ショコラ", "Chocolat", "しょこら"], kind: "avatar" },
  { name: "Kanata", aliases: ["彼方", "Kanata", "かなた"], kind: "avatar" },
  { name: "Komano", aliases: ["Komano", "こまの"], kind: "avatar" },
  { name: "Milltina", aliases: ["Milltina", "ミルティナ"], kind: "avatar" },
  { name: "Moe", aliases: ["Moe", "もえ"], kind: "avatar" },
];

test("真实 8183383（✦ ミルフィ :: Milfy 対応 ✦）：标题+标签+描述三证据", () => {
  const item = fx("booth-8183383.json");
  const res = detectAvatars(inputFromBooth(item), KNOWN);
  assert.equal(res.hits.length, 1);
  const h = res.hits[0];
  assert.equal(h.name, "Milfy");
  // 1-(1-.75)(1-.85)(1-.5) = 0.981
  assert.equal(h.confidence, 0.981);
  assert.deepEqual(h.sources, ["title", "booth_tag", "description"]);
  assert.equal(res.declaredCount, null);
  assert.deepEqual(res.planned, []);
});

test("真实 6115428（しなの専用 ロリ化Prefab）：标题的 CJK 包含 + 标签 + 描述支持句", () => {
  const item = fx("booth-6115428.json");
  const res = detectAvatars(inputFromBooth(item), KNOWN);
  assert.equal(res.hits.length, 1);
  assert.equal(res.hits[0].name, "Shinano");
  // 1-(1-.75)(1-.85)(1-.6) = 0.985
  assert.equal(res.hits[0].confidence, 0.985);
  assert.deepEqual(res.hits[0].sources, ["title", "booth_tag", "description"]);
  assert.equal(res.declaredCount, null); // “表情16種”不是模型数
});

test("真实 6494376（【6Avatars】Cat's Round Eye）：6 个命中 + 声明数互证 + planned 不算支持", () => {
  const item = fx("booth-6494376.json");
  const res = detectAvatars(inputFromBooth(item), KNOWN);
  assert.equal(res.declaredCount, 6);
  assert.deepEqual(res.hits.map((h) => h.name), ["Kanata", "Airi", "Chocolat", "Manuka", "Shinano", "Sio"]);
  assert.equal(res.hits.length, res.declaredCount as number);
  for (const h of res.hits) {
    assert.ok(h.sources.includes("declared_count"), h.name + " 应有 declared_count 互证");
  }
  // 1-(1-.85)(1-.6)(1-.25) = 0.955（Kanata 还在描述里出现）
  assert.equal(res.hits[0].confidence, 0.955);
  assert.deepEqual(res.hits[0].sources, ["booth_tag", "description", "declared_count"]);
  // 1-(1-.85)(1-.25) = 0.888
  assert.equal(res.hits[1].confidence, 0.888);
  assert.deepEqual(res.hits[1].sources, ["booth_tag", "declared_count"]);
  // ▼今後対応予定▼ 下的 Komano / Milltina 是 planned，不是已支持
  assert.deepEqual(res.planned, ["Komano", "Milltina"]);
  assert.ok(!res.hits.some((h) => h.name === "Komano" || h.name === "Milltina"));
});

test("planned：不认识的规划名保留原文；已支持的同一名字不再进 planned（反例对照）", () => {
  // 反例 A：known 里没有 Komano → 原文进 planned
  const withoutKomano = KNOWN.filter((k) => k.name !== "Komano" && k.name !== "Milltina");
  const a = detectAvatars(inputFromBooth(fx("booth-6494376.json")), withoutKomano);
  assert.deepEqual(a.planned, ["Komano", "Milltina"]);
  // 反例 B：Komano 同时在 tags（已支持）→ 进 hits，不进 planned
  const b = detectAvatars({
    title: "サンプル",
    description: "▼今後対応予定▼\nKomano\nMilltina",
    tags: ["Komano対応"],
  }, KNOWN);
  assert.deepEqual(b.hits.map((h) => h.name), ["Komano"]);
  assert.deepEqual(b.planned, ["Milltina"]);
});

test("反退化对照：声明数 6 但只有 1 条证据时，不加 declared_count、不硬凑命中", () => {
  const res = detectAvatars({ title: "【6Avatars】Cat's Round Eye", tags: ["Shinano対応"] }, KNOWN);
  assert.equal(res.declaredCount, 6);
  assert.deepEqual(res.hits.map((h) => h.name), ["Shinano"]);
  assert.equal(res.hits[0].confidence, 0.85);
  assert.deepEqual(res.hits[0].sources, ["booth_tag"]); // 声明数没有互证作用
});

test("反例（真实语料）：Milky-Way.zip / 品牌词 MilkyWay 不该命中 Milfy", () => {
  // 真实文件名 %LIBRARY%/素材库/Milky-Way.zip，以及 8183383 描述里的品牌词 "MilkyWayメイク"
  // 边际规则：拉丁别名要词边界 → "milfy" 不在 "milkyway" 里；而模型名真出现时必须命中（下方对照）
  assert.deepEqual(detectAvatars({ fileNames: ["Milky-Way.zip"] }, KNOWN).hits, []);
  assert.deepEqual(detectAvatars({ title: "MilkyWay Makeup Texture" }, KNOWN).hits, []);
  assert.deepEqual(detectAvatars({ fileNames: ["MilkyWay_For_Manuka__Makeup_.zip"] }, KNOWN).hits.map((h) => h.name), ["Manuka"]);
  // 对照正例：真名出现
  assert.deepEqual(detectAvatars({ fileNames: ["Milfy_Texture.zip"] }, KNOWN).hits.map((h) => h.name), ["Milfy"]);
  assert.deepEqual(detectAvatars({ tags: ["ミルフィ対応"] }, KNOWN).hits.map((h) => h.name), ["Milfy"]);
});

test("反例（真实语料）：[19 Avatars] 只有声明数没有模型名 → 0 命中；数量≠命中数时不给互证", () => {
  const only = detectAvatars({ title: "[19 Avatars] citrus shop Soft Texture.7z" }, KNOWN);
  assert.deepEqual(only.hits, []);
  assert.equal(only.declaredCount, 19);
  const mismatch = detectAvatars({ title: "[19 Avatars] citrus shop Soft Texture.7z", tags: ["Milfy対応"] }, KNOWN);
  assert.deepEqual(mismatch.hits.map((h) => h.name), ["Milfy"]);
  assert.equal(mismatch.declaredCount, 19);
  assert.deepEqual(mismatch.hits[0].sources, ["booth_tag"]); // 19 ≠ 1 → 不加 declared_count
});

test("反例：短别名不能落在别的词里（Sio 不该命中 passion / Sion）", () => {
  assert.deepEqual(detectAvatars({ title: "passion flower sion" }, KNOWN).hits, []);
  assert.deepEqual(detectAvatars({ title: "Sioress" }, KNOWN).hits, []);
  // 正例对照：同一个别名在正常位置能命中
  assert.deepEqual(detectAvatars({ title: "Sio対応 Eye Texture" }, KNOWN).hits.map((h) => h.name), ["Sio"]);
  assert.deepEqual(detectAvatars({ title: "【Sio】Cat's Round Eye" }, KNOWN).hits.map((h) => h.name), ["Sio"]);
});

test("BOOTH 标签：〜対応 / 〜用 / 〜専用 后缀去掉后匹配；大小写与全半角无关", () => {
  const r = detectAvatars({ tags: ["ミルフィ対応", "MANUKA用", "しなの専用", "Sio対応", "Chocolat", "ＫＡＮＡＴＡ対応"] }, KNOWN);
  assert.deepEqual(r.hits.map((h) => h.name), ["Chocolat", "Kanata", "Manuka", "Milfy", "Shinano", "Sio"]);
  for (const h of r.hits) assert.deepEqual(h.sources, ["booth_tag"]);
});

test("描述：▼今後対応予定▼ 区不算支持，区外的支持句算", () => {
  const d = "うちの子対応です。\n\n▼今後対応予定▼\nKomano\nMilltina\n\n※予定は変わります";
  const r = detectAvatars({ description: d }, KNOWN);
  assert.deepEqual(r.hits, []); // 区外没有别名 → 没有命中
  assert.deepEqual(r.planned, ["Komano", "Milltina"]);
  const split = extractPlannedRegion(d);
  assert.equal(split.region, "Komano\nMilltina");
  assert.ok(!split.rest.includes("Komano"));
});

test("压缩包路径（真实 zip 清单）：顶层目录名整段相等 0.8", () => {
  const archivePaths = [
    "Shinano/emission/emission&mask.png",
    "Shinano/texture/blue.png",
    "Shinano/texture/NormalMap.png",
    "readme.txt",
  ];
  const r = detectAvatars({ archivePaths }, KNOWN);
  assert.deepEqual(r.hits.map((h) => h.name), ["Shinano"]);
  assert.equal(r.hits[0].confidence, 0.8);
  assert.deepEqual(r.hits[0].sources, ["archive_path"]);
});

test("压缩包路径：段内出现（Outfit_Shinano/…）给 0.6", () => {
  const r = detectAvatars({ archivePaths: ["Outfit_Shinano/Textures/Matcap 4/Matcap4.png"] }, KNOWN);
  assert.deepEqual(r.hits.map((h) => h.name), ["Shinano"]);
  assert.equal(r.hits[0].confidence, 0.6);
  // 反例：无关压缩包路径不给任何命中
  assert.deepEqual(detectAvatars({ archivePaths: ["AqLight/AqLight_Ver0.4.unitypackage"] }, KNOWN).hits, []);
});

test("unitypackage 路径（真实 Assets/… pathname）：整段相等 0.9", () => {
  const unitypackagePaths = [
    "Assets/MANUKA/MANUKA_3.0/Icon/5.png",
    "Assets/MANUKA/Prefab/MANUKA_lilToon.prefab",
    "Assets/MANUKA/Texture/Mask/Manuka_face_mask_1.png",
  ];
  const r = detectAvatars({ unitypackagePaths }, KNOWN);
  assert.deepEqual(r.hits.map((h) => h.name), ["Manuka"]);
  assert.equal(r.hits[0].confidence, 0.9);
  assert.deepEqual(r.hits[0].sources, ["unitypackage_path"]);
});

test("unitypackage 路径：文件名里出现（Daisy 真实样本）给 0.75，可同时命中多个模型", () => {
  const unitypackagePaths = [
    "Assets/ななは/Daisy/FBX/Shinano_Daisy.fbx",
    "Assets/ななは/Daisy/FBX/Manuka_Daisy.fbx",
    "Assets/ななは/Daisy/Tex/White.png",
  ];
  const r = detectAvatars({ unitypackagePaths }, KNOWN);
  assert.deepEqual(r.hits.map((h) => h.name), ["Manuka", "Shinano"]);
  for (const h of r.hits) {
    assert.equal(h.confidence, 0.75);
    assert.deepEqual(h.sources, ["unitypackage_path"]);
  }
});

test("证据合成：unitypackage_path(0.9) + filename(0.6) = 0.96", () => {
  const r = detectAvatars({
    fileNames: ["Shinano_ver1.02.zip"],
    unitypackagePaths: ["Assets/Shinano/Texture/Color/Hair/Shinano_hair.png"],
  }, KNOWN);
  assert.deepEqual(r.hits.map((h) => h.name), ["Shinano"]);
  assert.equal(r.hits[0].confidence, 0.96);
  assert.deepEqual(r.hits[0].sources, ["unitypackage_path", "filename"]);
});

test("文件名证据：整名等于别名 0.7 / 名内含 0.6", () => {
  const exact = detectAvatars({ fileNames: ["Milfy.zip"] }, KNOWN);
  assert.equal(exact.hits[0].confidence, 0.7);
  const contains = detectAvatars({ fileNames: ["Loli_Shinano_6115428 对应1.01.zip"] }, KNOWN);
  assert.equal(contains.hits[0].name, "Shinano");
  assert.equal(contains.hits[0].confidence, 0.6);
});

test("declaredCount：标题优先；标题没有才看描述", () => {
  assert.equal(detectAvatars({ title: "【6Avatars】x" }, KNOWN).declaredCount, 6);
  assert.equal(detectAvatars({ title: "无数量", description: "21アバター対応" }, KNOWN).declaredCount, 21);
  assert.equal(detectAvatars({}, KNOWN).declaredCount, null);
  assert.deepEqual(detectAvatars({}, KNOWN).hits, []);
});

test("avatarNamesFromPaths：整段相等优先 + entry_prefix 到命中段", () => {
  assert.deepEqual(avatarNamesFromPaths(["Shinano/emission/blue.png"], KNOWN), [{ name: "Shinano", prefix: "Shinano/" }]);
  assert.deepEqual(avatarNamesFromPaths(["Assets/#Lovable/#MilkyWay/Milfy/Smile.anim"], KNOWN),
    [{ name: "Milfy", prefix: "Assets/#Lovable/#MilkyWay/Milfy/" }]);
  assert.deepEqual(avatarNamesFromPaths(["Assets/ななは/Daisy/FBX/Shinano_Daisy.fbx"], KNOWN),
    [{ name: "Shinano", prefix: "Assets/ななは/Daisy/FBX/Shinano_Daisy.fbx/" }]);
  assert.deepEqual(avatarNamesFromPaths(["Outfit_Shinano/Textures/Matcap 4/Matcap4.png"], KNOWN),
    [{ name: "Shinano", prefix: "Outfit_Shinano/" }]);
});

test("avatarNamesFromPaths：整段相等压过同路径里的文件名命中（反例对照）", () => {
  // Assets/MANUKA/… 里有 Shinano_face.png，但整段 MANUKA 优先 → 只标 Manuka
  assert.deepEqual(avatarNamesFromPaths(["Assets/MANUKA/Texture/Shinano_face.png"], KNOWN),
    [{ name: "Manuka", prefix: "Assets/MANUKA/" }]);
  // 反例对照：同一文件名放在不含任何整段相等的路径下 → 按名字命中 Shinano
  assert.deepEqual(avatarNamesFromPaths(["Assets/Misc/Shinano_face.png"], KNOWN),
    [{ name: "Shinano", prefix: "Assets/Misc/Shinano_face.png/" }]);
});

test("avatarNamesFromPaths：同 (name,prefix) 去重；无关路径不产生标注", () => {
  const r = avatarNamesFromPaths(["Assets/MANUKA/A.png", "Assets/MANUKA/B.png", "Assets/Other/C.png"], KNOWN);
  assert.deepEqual(r, [{ name: "Manuka", prefix: "Assets/MANUKA/" }]);
  assert.deepEqual(avatarNamesFromPaths([], KNOWN), []);
});

test("真实综合：8183383 的 unitypackage（MilkyWay For Milfy）+ 本地文件名 → 高置信命中", () => {
  const r = detectAvatars({
    title: "✦ ミルフィ :: Milfy 対応 ✦ MilkyWay Makeup Texture",
    tags: ["ミルフィ", "ミルフィ対応", "Milfy"],
    fileNames: ["8183383 ✦ ミルフィ  Milfy 対応 ✦ MilkyWay Makeup Texture.7z"],
    unitypackagePaths: [
      "Assets/#Lovable/#MilkyWay/Milfy/Smile.anim",
      "Assets/#Lovable/#MilkyWay/Milfy/Sad.anim",
    ],
  }, KNOWN);
  assert.deepEqual(r.hits.map((h) => h.name), ["Milfy"]);
  assert.deepEqual(r.hits[0].sources, ["title", "booth_tag", "unitypackage_path", "filename"]);
  // 1-(1-.75)(1-.85)(1-.9)(1-.6) = 0.9985 → 0.999（上限内）
  assert.equal(r.hits[0].confidence, 0.999);
});
