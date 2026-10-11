/**
 * unitymeta 单测：GUID 口径与工程内路径过滤。
 * 这里刻意用**真实形状**的 .meta 文本（Unity 2022 导出的头部），并钉上干扰行，
 * 免得"正则看着对"却在真文件上取错。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { isProjectAssetPath, parseMetaGuid } from "../src/unitymeta";

/** 真实 MANUKA 工程里某个 .meta 的头部形状。 */
const REAL_META = [
  "fileFormatVersion: 2",
  "guid: 050e8d468a15580448185d3ad40ad7b8",
  "PrefabImporter:",
  "  externalObjects: {}",
  "  userData: ",
  "  assetBundleName: ",
  "  assetBundleVariant: ",
  "",
].join("\n");

// ---------------------------------------------------------------- parseMetaGuid

test("parseMetaGuid: 正常 .meta → 取出 32 位 guid", () => {
  assert.equal(parseMetaGuid(REAL_META), "050e8d468a15580448185d3ad40ad7b8");
});

test("parseMetaGuid: 大小写混写 → 统一小写返回（求交的规范形式）", () => {
  assert.equal(parseMetaGuid("guid: 0A1B2C3D4E5F60718293A4B5C6D7E8F9"), "0a1b2c3d4e5f60718293a4b5c6d7e8f9");
  assert.equal(parseMetaGuid("guid: ABCDEFabcdefABCDEFabcdefABCDEF12"), "abcdefabcdefabcdefabcdefabcdef12");
});

test("parseMetaGuid: 不是 32 位 hex → null（31/33 位、非 hex 字符、带连字符）", () => {
  assert.equal(parseMetaGuid("guid: 050e8d468a15580448185d3ad40ad7b"), null);   // 31 位
  assert.equal(parseMetaGuid("guid: 050e8d468a15580448185d3ad40ad7b88"), null); // 33 位
  assert.equal(parseMetaGuid("guid: "), null);
  assert.equal(parseMetaGuid("guid: zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"), null); // g-z 不是 hex
  assert.equal(parseMetaGuid("guid: 050e8d46-8a15-5804-4818-5d3ad40ad7b8"), null);
});

test("parseMetaGuid: 缺字段 / 空文本 / 非字符串 → null", () => {
  assert.equal(parseMetaGuid("fileFormatVersion: 2\nPrefabImporter:\n"), null);
  assert.equal(parseMetaGuid(""), null);
  assert.equal(parseMetaGuid("\n\n"), null);
  assert.equal(parseMetaGuid(undefined as unknown as string), null);
});

test("parseMetaGuid: 别的行含 guid 字样不会被误取", () => {
  const distractors = [
    "fileFormatVersion: 2",
    "m_Guid: 050e8d468a15580448185d3ad40ad7b8",          // 前缀 m_：不是 guid 字段
    "# guid: 050e8d468a15580448185d3ad40ad7b8",         // 注释
    "guid_pool: 050e8d468a15580448185d3ad40ad7b8",      // 别的键名
    "SomeField: guid: 050e8d468a15580448185d3ad40ad7b8", // 值里提到 guid
    "text: 本行说明了 guid 字段的写法",
  ].join("\n");
  assert.equal(parseMetaGuid(distractors), null);
});

test("parseMetaGuid: 值后还有别的内容不算；缩进/CRLF/行尾空白算", () => {
  assert.equal(parseMetaGuid("guid: 050e8d468a15580448185d3ad40ad7b8 extra"), null);
  assert.equal(parseMetaGuid("guid:050e8d468a15580448185d3ad40ad7b8"), "050e8d468a15580448185d3ad40ad7b8");
  assert.equal(parseMetaGuid("  guid: 050e8d468a15580448185d3ad40ad7b8  "), "050e8d468a15580448185d3ad40ad7b8");
  assert.equal(parseMetaGuid("fileFormatVersion: 2\r\nguid: 050e8d468a15580448185d3ad40ad7b8\r\n"), "050e8d468a15580448185d3ad40ad7b8");
});

test("parseMetaGuid: 多个 guid 行 → 取第一条", () => {
  const two = "guid: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nguid: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n";
  assert.equal(parseMetaGuid(two), "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
});

// ---------------------------------------------------------------- isProjectAssetPath

test("isProjectAssetPath: Assets/ 下的资源 → true", () => {
  assert.equal(isProjectAssetPath("Assets/MANUKA/Prefab/MANUKA_lilToon.prefab"), true);
  assert.equal(isProjectAssetPath("Assets/a.png"), true);
  assert.equal(isProjectAssetPath("Assets\\Models\\a.fbx"), true);       // 反斜杠
  assert.equal(isProjectAssetPath("./Assets/Models/a.fbx"), true);        // ./ 前缀
  assert.equal(isProjectAssetPath("assets/Models/a.fbx"), true);          // 首段大小写不敏感
  assert.equal(isProjectAssetPath("Assets/Models/a.cs"), true);           // 只看路径，不看类型
});

test("isProjectAssetPath: 排除 Library/ Temp/ obj/ Packages/ 及 .meta 自身", () => {
  assert.equal(isProjectAssetPath("Library/ArtifactDB"), false);
  assert.equal(isProjectAssetPath("Temp/UnityLockfile"), false);
  assert.equal(isProjectAssetPath("obj/Debug/x.dll"), false);
  assert.equal(isProjectAssetPath("Logs/Packages-Update.log"), false);
  assert.equal(isProjectAssetPath("Packages/com.vrchat.base/package.json"), false);
  assert.equal(isProjectAssetPath(".git/config"), false);
  assert.equal(isProjectAssetPath("Assets/MANUKA/Prefab/MANUKA_lilToon.prefab.meta"), false);
  assert.equal(isProjectAssetPath("Assets/Temp/scratch.txt"), false);
  assert.equal(isProjectAssetPath("Assets/Library/x.png"), false);
});

test("isProjectAssetPath: 空串 / 只有 Assets 一段 / 非字符串 → false", () => {
  assert.equal(isProjectAssetPath(""), false);
  assert.equal(isProjectAssetPath("Assets"), false);
  assert.equal(isProjectAssetPath("Assets/"), false);
  assert.equal(isProjectAssetPath("ProjectSettings/ProjectVersion.txt"), false);
  assert.equal(isProjectAssetPath(undefined as unknown as string), false);
});
