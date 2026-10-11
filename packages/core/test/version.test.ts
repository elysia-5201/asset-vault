import { test } from "node:test";
import assert from "node:assert/strict";
import { compareVersions, parseVersion, stripVersionPrefix } from "../src/version";

/** 断言 a > b 的常用简写（顺带把反向也验一遍，防止实现"一边倒"）。 */
function gt(a: string, b: string): void {
  assert.equal(compareVersions(a, b), 1, a + " 应该 > " + b);
  assert.equal(compareVersions(b, a), -1, b + " 应该 < " + a);
}

// ---------------------------------------------------------------- parseVersion

test("parseVersion: 1 / 1.2 / 1.2.3 都吃得下，缺的段补 0", () => {
  assert.deepEqual(parseVersion("1")!.parts, [1]);
  assert.deepEqual(parseVersion("1.2")!.parts, [1, 2]);
  assert.deepEqual(parseVersion("1.2.3")!.parts, [1, 2, 3]);
  const p = parseVersion("1.2")!;
  assert.equal(p.major, 1);
  assert.equal(p.minor, 2);
  assert.equal(p.patch, 0);
});

test("parseVersion: v 前缀被吃掉（前后空白也容忍）", () => {
  assert.equal(parseVersion("v0.2.0")!.raw, "v0.2.0");
  assert.deepEqual(parseVersion(" v0.2.0 ")!.parts, [0, 2, 0]);
  assert.deepEqual(parseVersion("V1.0.0")!.parts, [1, 0, 0]);
  assert.equal(stripVersionPrefix("v0.2.0"), "0.2.0");
  // 不是版本前缀的 v 不吃（"version" 这种词必须留着原样 → 解析失败）
  assert.equal(parseVersion("version"), null);
});

test("parseVersion: 预发布与 build metadata", () => {
  assert.deepEqual(parseVersion("1.0.0-rc.1")!.prerelease, ["rc", "1"]);
  assert.deepEqual(parseVersion("1.0.0+build.5")!.prerelease, []);
  assert.deepEqual(parseVersion("v1.0.0-rc.1+sha.abc")!.prerelease, ["rc", "1"]);
});

test("parseVersion: 非法输入一律 null（不抛错）", () => {
  for (const bad of ["", "   ", "abc", "1.x", "1..2", "1.2.", "-1", "1.0.0-", "v", "1.2.3-+x"]) {
    assert.equal(parseVersion(bad), null, JSON.stringify(bad) + " 应该解析失败");
  }
  assert.equal(parseVersion(undefined as unknown as string), null);
});

// ------------------------------------------------------------ compareVersions

test("compareVersions: 数字段按数值比，不是字典序（1.2.10 > 1.2.9）", () => {
  gt("1.2.10", "1.2.9");
  gt("1.10.0", "1.9.0");
  gt("10.0.0", "9.9.9");
});

test("compareVersions: v 前缀不影响相等（v0.2.0 == 0.2.0）", () => {
  assert.equal(compareVersions("v0.2.0", "0.2.0"), 0);
  assert.equal(compareVersions("0.2.0", "v0.2.0"), 0);
  assert.equal(compareVersions("v1.2", "1.2.0"), 0);
});

test("compareVersions: 预发布 < 正式（1.0.0-rc.1 < 1.0.0）", () => {
  assert.equal(compareVersions("1.0.0-rc.1", "1.0.0"), -1);
  assert.equal(compareVersions("1.0.0", "1.0.0-rc.1"), 1);
  gt("1.0.0", "1.0.0-rc.1");
  gt("1.0.0", "1.0.0-alpha");
  gt("0.2.0", "0.2.0-beta.1");
});

test("compareVersions: 预发布之间按 semver 排序（数字 < 非数字、数字按数值）", () => {
  gt("1.0.0-alpha.1", "1.0.0-alpha");
  gt("1.0.0-alpha.beta", "1.0.0-alpha.1");
  gt("1.0.0-beta", "1.0.0-alpha.beta");
  gt("1.0.0-beta.2", "1.0.0-beta");
  gt("1.0.0-beta.11", "1.0.0-beta.2");
  gt("1.0.0-rc.1", "1.0.0-beta.11");
  gt("1.0.0", "1.0.0-rc.1");
  // 数字标识 < 非数字标识
  assert.equal(compareVersions("1.0.0-1", "1.0.0-alpha"), -1);
  assert.equal(compareVersions("1.0.0-2", "1.0.0-11"), -1);
  // 字典序：a < b（ASCII）
  assert.equal(compareVersions("1.0.0-abc", "1.0.0-abd"), -1);
});

test("compareVersions: build metadata 被忽略", () => {
  assert.equal(compareVersions("1.0.0+build.5", "1.0.0"), 0);
  assert.equal(compareVersions("1.0.0+a", "1.0.0+b"), 0);
});

test("compareVersions: 多于三段继续按数字比，缺的补 0", () => {
  gt("1.2.3.4", "1.2.3");
  assert.equal(compareVersions("1.2.3.0", "1.2.3"), 0);
  gt("1.2.4", "1.2.3.9");
  assert.equal(compareVersions("1.2", "1.2.0.0"), 0);
});

test("compareVersions: 非法输入抛错（HTTP 层负责兜底）", () => {
  assert.throws(() => compareVersions("abc", "1.0.0"), /无法解析/);
  assert.throws(() => compareVersions("1.0.0", ""), /无法解析/);
});

test("compareVersions: 真实 tag 对照（v0.1.0 → v0.2.0 有更新；同版无更新）", () => {
  assert.equal(compareVersions("v0.2.0", "0.1.0"), 1);   // 有更新
  assert.equal(compareVersions("v0.1.0", "0.1.0"), 0);   // 无更新
  assert.equal(compareVersions("v0.0.9", "0.1.0"), -1);  // 旧于当前（不当成"有更新"）
  assert.equal(compareVersions("v0.2.0-rc.1", "0.1.0"), 1);
});
