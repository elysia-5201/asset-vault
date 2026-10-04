/**
 * identify 单测：真实语料来自 CONTRACT §5（%LIBRARY%/素材库 与 %DOWNLOADS%，
 * 2026-10-04 现场采集），并带反例对照（数字长度不足 / 长数字串 / 版本号）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractItemIds, identifyFromNames, identifyFromUrl, boothUrl } from "../../src/identify";
import { AppError } from "../../src/contracts";

/** 真实文件名语料（现场 ls 采集）。 */
const REAL_MILFY_DIR = "8183383 ✦ ミルフィ  Milfy 対応 ✦ MilkyWay Makeup Texture";
const REAL_MILFY_7Z = REAL_MILFY_DIR + ".7z";
const REAL_SHINANO_ZIP = "Loli_Shinano_6115428 对应1.01.zip";
const REAL_SHINANO_PNG = "Loli_Shinano_6115428 对应1.01.png";
const REAL_ROUND_EYE = "Cat's Round Eye for Shinano_6494376.zip";
const REAL_19AVATARS = "[19 Avatars] citrus shop Soft Texture.7z";
const REAL_MOVIE = "Oppenheimer.2023.IMAX.1080p.BluRay.x264.DTS-WiKi.rar";
const REAL_BODYHAIR = "Shinano_BodyHair_1.2.1_Gracilis_5920335.zip";
const REAL_CIGARETTE = "_Unity_2022__さたにあ式タバコギミック_v1.2.33_4835743.png";
const REAL_LICENSE = "20230130091935vn3license_en.pdf"; // 14 位串：不能截出子串
const REAL_TAIL = "8183383 ✦ ミルフィ  Milfy 対応 ✦ MilkyWay Makeup Texture/MilkyWay For Milfy (Makeup)";

test("extractItemIds：5..9 位数字，按首次出现去重；长串/短数字不截断", () => {
  assert.deepEqual(extractItemIds("8183383 ✦ foo_6115428 (6494376)"), ["8183383", "6115428", "6494376"]);
  assert.deepEqual(extractItemIds(REAL_MILFY_DIR), ["8183383"]);
  assert.deepEqual(extractItemIds("id=8183383 和 8183383"), ["8183383"]);
  // 反例：14 位串、4 位年份、2 位数字都不产生候选
  assert.deepEqual(extractItemIds(REAL_LICENSE), []);
  assert.deepEqual(extractItemIds("Oppenheimer.2023.1080p"), []);
  assert.deepEqual(extractItemIds("衣装_19_対応"), []);
  assert.deepEqual(extractItemIds(""), []);
});

test("identifyFromNames：真实语料正例", () => {
  const a = identifyFromNames([REAL_MILFY_7Z]);
  assert.equal(a.best?.itemId, "8183383");
  assert.equal(a.best?.confidence, 0.9); // 强 token
  assert.equal(a.best?.method, "filename");

  // 同一 id 出现在两个文件（.zip + .png）→ 重复加成 +0.03
  const b = identifyFromNames([REAL_SHINANO_ZIP, REAL_SHINANO_PNG]);
  assert.equal(b.candidates.length, 1);
  assert.equal(b.best?.itemId, "6115428");
  assert.equal(b.best?.confidence, 0.93);
  assert.deepEqual(b.best?.evidence, ["filename: " + REAL_SHINANO_ZIP, "filename: " + REAL_SHINANO_PNG]);

  assert.equal(identifyFromNames([REAL_ROUND_EYE]).best?.itemId, "6494376");
  assert.equal(identifyFromNames([REAL_BODYHAIR]).best?.itemId, "5920335");
  assert.equal(identifyFromNames([REAL_CIGARETTE]).best?.itemId, "4835743");
  assert.equal(identifyFromNames([REAL_TAIL]).best?.itemId, "8183383");
});

test("identifyFromNames：真实语料反例（不能凭文件名硬凑商品号）", () => {
  assert.equal(identifyFromNames([REAL_19AVATARS]).best, null);
  assert.equal(identifyFromNames([REAL_MOVIE]).best, null);
  assert.equal(identifyFromNames([REAL_LICENSE]).best, null);
  assert.equal(identifyFromNames(["Marshmallow_PB_ver2.0.4.zip", "AqLight_Ver0.4.zip"]).best, null);
  assert.equal(identifyFromNames([]).best, null);
  assert.equal(identifyFromNames(null as unknown as string[], undefined).best, null);
});

test("identifyFromNames：弱 token（嵌在字母数字里）0.55", () => {
  const r = identifyFromNames(["abc6115428def.zip"]);
  assert.equal(r.best?.itemId, "6115428");
  assert.equal(r.best?.confidence, 0.55);
});

test("identifyFromNames：同分按 id 升序（确定性排序）", () => {
  const r = identifyFromNames(["x_8183383_6115428.zip"]);
  assert.deepEqual(r.candidates.map((c) => c.itemId), ["6115428", "8183383"]);
  assert.equal(r.best?.itemId, "6115428");
});

test("identifyFromNames：BOOTH downloadable 名字加权（0.95）并与文件名互证（+0.04）", () => {
  const dlOnly = identifyFromNames([], ["lilToon_2.x.x.zip", "Loli_Shinano_6115428.zip"]);
  assert.equal(dlOnly.best?.itemId, "6115428");
  assert.equal(dlOnly.best?.confidence, 0.95);
  assert.equal(dlOnly.best?.method, "downloadable_name");
  assert.deepEqual(dlOnly.best?.evidence, ["downloadable: Loli_Shinano_6115428.zip"]);

  const both = identifyFromNames([REAL_SHINANO_ZIP], ["Loli_Shinano_6115428.zip"]);
  assert.equal(both.best?.confidence, 0.99);
  assert.equal(both.best?.method, "downloadable_name");
  assert.deepEqual(both.best?.evidence, ["downloadable: Loli_Shinano_6115428.zip", "filename: " + REAL_SHINANO_ZIP]);

  // 反例：真实免费商品 lilToon 的 downloadable 名没有商品号 → 无候选
  assert.equal(identifyFromNames([], ["lilToon_2.x.x.zip", "lilToon_1.x.x.zip"]).best, null);
});

test("identifyFromUrl：BOOTH 商品 URL / 裸号 = 1.0；downloadable 与其它站点 = null", () => {
  const c = identifyFromUrl("https://lovable.booth.pm/items/8183383");
  assert.equal(c?.itemId, "8183383");
  assert.equal(c?.confidence, 1);
  assert.equal(c?.method, "url");
  assert.deepEqual(c?.evidence, ["https://lovable.booth.pm/items/8183383", "https://booth.pm/ja/items/8183383"]);
  assert.equal(identifyFromUrl("https://booth.pm/ja/items/8183383")?.itemId, "8183383");
  assert.equal(identifyFromUrl("8183383")?.itemId, "8183383");
  assert.equal(identifyFromUrl("https://booth.pm/ja/items/8183383.json")?.itemId, "8183383");
  // 反例：downloadables id 与 item id 不同命名空间，绝不能当商品号
  assert.equal(identifyFromUrl("https://booth.pm/downloadables/1448437?variation_id=12317982"), null);
  assert.equal(identifyFromUrl("https://gumroad.com/l/abc"), null);
  assert.equal(identifyFromUrl(""), null);
});

test("boothUrl：locale 回落 ja；非法 id 抛 AppError(INVALID_INPUT)", () => {
  assert.equal(boothUrl("8183383"), "https://booth.pm/ja/items/8183383");
  assert.equal(boothUrl("8183383", "en"), "https://booth.pm/en/items/8183383");
  assert.equal(boothUrl("8183383", "not-a-locale"), "https://booth.pm/ja/items/8183383");
  assert.throws(() => boothUrl("12"), (e: unknown) => e instanceof AppError && e.code === "INVALID_INPUT");
  assert.throws(() => boothUrl("https://booth.pm/ja/items/8183383"), (e: unknown) => e instanceof AppError && e.code === "INVALID_INPUT");
});
