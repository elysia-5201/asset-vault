/**
 * avatars/normalize 单测：别名归一（全半角 / 大小写 / 空白标点 / 片假名↔平假名）+ 数量声明解析。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { normKey } from "../../src/contracts";
import { normAlias, foldKana, buildAliasIndex, parseDeclaredCount } from "../../src/avatars/normalize";
import type { KnownAvatar } from "../../src/contracts";

/** 真实语料 + 变体（BOOTH 标签/标题里实际出现过的写法）。 */
const CORPUS: string[] = [
  "✦ ミルフィ :: Milfy 対応 ✦",
  "ミルフィ",
  "みるふぃ",
  "ﾐﾙﾌｨ",
  "ミルフィちゃん",
  "Ｍｉｌｆｙ",
  "Milfy",
  "MANUKA",
  "マヌカ",
  "まぬか",
  "しなの専用",
  "Shinano_ver1.01対応済",
  "しなの",
  "シナノ",
  "愛莉",
  "彼方",
  "ショコラ",
  "Chocolat",
  "Sio",
  "Komano",
  "Milltina",
  "【6Avatars】Cat's Round Eye",
  "  mixed   ＣＡＳＥ  ",
  "Ｃａｔ'ｓ　Ｒｏｕｎｄ Ｅｙｅ",
];

test("normAlias：去空白/标点、大小写、全半角", () => {
  assert.equal(normAlias("Milfy"), "milfy");
  assert.equal(normAlias("Ｍｉｌｆｙ"), "milfy");
  assert.equal(normAlias("  Cat's Round Eye "), "catsroundeye");
  assert.equal(normAlias("Ｃａｔ'ｓ　Ｒｏｕｎｄ Ｅｙｅ"), "catsroundeye");
  assert.equal(normAlias("✦ ミルフィ :: Milfy 対応 ✦"), "✦みるふぃmilfy対応✦");
});

test("normAlias：日文假名归一（片假名/半角片假名 → 平假名）", () => {
  assert.equal(normAlias("みるふぃ"), "みるふぃ");
  assert.equal(normAlias("ミルフィ"), "みるふぃ");
  assert.equal(normAlias("ﾐﾙﾌｨ"), "みるふぃ");
  assert.equal(foldKana("ガギグ"), "がぎぐ");
  assert.equal(foldKana("がぎぐ"), "がぎぐ"); // 幂等
});

test("normAlias：假名↔罗马字不互转（反例：别名表必须两种都列）", () => {
  assert.notEqual(normAlias("マヌカ"), normAlias("Manuka"));
  assert.notEqual(normAlias("しなの"), normAlias("Shinano"));
});

test("不变量：normKey(normAlias(x)) === normAlias(x)（幂等，5 次迭代）", () => {
  for (const s of CORPUS) {
    const once = normAlias(s);
    assert.equal(normKey(once), once, "normKey(normAlias) 应幂等: " + JSON.stringify(s));
    assert.equal(normAlias(once), once, "normAlias 自身应幂等: " + JSON.stringify(s));
  }
});

test("buildAliasIndex：normAlias 与 normKey 两个键都能查到（服务端不分叉）", () => {
  const known: KnownAvatar[] = [
    { name: "Milfy", aliases: ["ミルフィ", "みるふぃ", "Milfy"], kind: "avatar" },
    { name: "Manuka", aliases: ["MANUKA", "マヌカ"], kind: "avatar" },
  ];
  const idx = buildAliasIndex(known);
  assert.equal(idx.get("milfy"), "Milfy");
  assert.equal(idx.get(normKey("Milfy")), "Milfy");
  assert.equal(idx.get(normAlias("ミルフィ")), "Milfy");
  assert.equal(idx.get(normKey("ミルフィ")), "Milfy");
  assert.equal(idx.get(normKey("MANUKA")), "Manuka");
  assert.equal(idx.get("まぬか"), "Manuka");
  // 未登记的名字查不到（不是万能匹配）
  assert.equal(idx.get("shinano"), undefined);
  // 键数 = milfy, みるふぃ, ミルフィ, manuka, まぬか, マヌカ = 6（normAlias 与 normKey 双键，重复的只算一次）
  assert.equal(idx.size, 6);
  assert.deepEqual([...idx.keys()].sort(), ["manuka", "milfy", "まぬか", "みるふぃ", "マヌカ", "ミルフィ"].sort());
});

test("buildAliasIndex：冲突先登记者胜（不静默合并）+ 空输入安全", () => {
  const idx = buildAliasIndex([
    { name: "A", aliases: ["x"], kind: "avatar" },
    { name: "B", aliases: ["X"], kind: "avatar" },
  ]);
  assert.equal(idx.get("x"), "A");
  assert.equal(buildAliasIndex([]).size, 0);
  assert.equal(buildAliasIndex(null as unknown as KnownAvatar[]).size, 0);
});

test("parseDeclaredCount：契约要求的全部写法", () => {
  assert.equal(parseDeclaredCount("【12アバター対応】"), 12);
  assert.equal(parseDeclaredCount("（7アバター対応）"), 7);
  assert.equal(parseDeclaredCount("(7アバター対応)"), 7);
  assert.equal(parseDeclaredCount("[19 Avatars] citrus shop Soft Texture"), 19);
  assert.equal(parseDeclaredCount("【6Avatars】Cat's Round Eye"), 6);
  assert.equal(parseDeclaredCount("21アバター対応"), 21);
  assert.equal(parseDeclaredCount("【4体対応】"), 4);
  assert.equal(parseDeclaredCount("12体セット"), 12);
});

test("parseDeclaredCount：反例（表情数/版本号/无数量都不算）", () => {
  assert.equal(parseDeclaredCount("しなの専用　ロリ化Prefab & 表情16種セット"), null);
  assert.equal(parseDeclaredCount("Shinano_ver1.01対応済"), null);
  assert.equal(parseDeclaredCount("【Fullset】x"), null);
  assert.equal(parseDeclaredCount(""), null);
  assert.equal(parseDeclaredCount(null as unknown as string), null);
});

test("parseDeclaredCount：多个命中取位置最靠前者", () => {
  assert.equal(parseDeclaredCount("【6Avatars】... また 21アバター対応"), 6);
  assert.equal(parseDeclaredCount("21アバター対応 ... 【6Avatars】"), 21);
});
