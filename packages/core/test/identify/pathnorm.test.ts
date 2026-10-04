/**
 * pathnorm 单测：真实本机路径形态（Windows + 日文/中文目录名 + 长路径 + UNC）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizePath, toWinLongPath, isSubPath, basename, extOf } from "../../src/pathnorm";

test("normalizePath：反斜杠/大小写/尾斜杠/重复斜杠", () => {
  assert.equal(normalizePath("C:\\Games\\VRChat\\素材\\"), "c:/games/vrchat/素材");
  assert.equal(normalizePath("C:/Foo/BAR.TXT"), "c:/foo/bar.txt");
  assert.equal(normalizePath("A//B\\\\C"), "a/b/c");
  assert.equal(normalizePath("/tmp//x/"), "/tmp/x");
});

test("normalizePath：Windows 长路径前缀与 UNC", () => {
  assert.equal(normalizePath("\\\\?\\C:\\x"), "c:/x");
  assert.equal(normalizePath("\\\\?\\UNC\\server\\share\\A"), "//server/share/a");
  assert.equal(normalizePath("//Server/Share/A"), "//server/share/a");
});

test("normalizePath：根路径", () => {
  assert.equal(normalizePath("C:\\"), "c:");
  assert.equal(normalizePath("/"), "/");
});

test("normalizePath：NFC 归一（NFD 输入 == NFC 输入）", () => {
  const nfd = "C:/ア/か\u3099"; // か + 组合浊点
  const nfc = "C:/ア/が";
  assert.notEqual(nfd, nfc);
  assert.equal(normalizePath(nfd), normalizePath(nfc));
  assert.equal(normalizePath(nfd), "c:/ア/が");
});

test("toWinLongPath：>=260 才加 \\\\?\\，且对已是长路径幂等", () => {
  const short = "C:\\" + "a".repeat(256); // 259 字符
  assert.equal(short.length, 259);
  assert.equal(toWinLongPath(short), short);
  const long = "C:\\" + "a".repeat(257); // 260 字符
  assert.equal(long.length, 260);
  assert.equal(toWinLongPath(long), "\\\\?\\" + long);
  assert.equal(toWinLongPath(toWinLongPath(long)), "\\\\?\\" + long);
});

test("toWinLongPath：UNC 用 \\\\?\\UNC\\，相对路径不动，正斜杠转反斜杠", () => {
  const unc = "\\\\server\\share\\" + "b".repeat(250);
  assert.ok(unc.length >= 260);
  assert.equal(toWinLongPath(unc), "\\\\?\\UNC\\server\\share\\" + "b".repeat(250));
  const rel = "a/".repeat(200) + "b.zip";
  assert.equal(toWinLongPath(rel), rel.replace(/\//g, "\\"));
  assert.equal(toWinLongPath("C:/games/x.zip"), "C:\\games\\x.zip");
});

test("isSubPath：含相等、大小写与分隔符无关；裸前缀不算", () => {
  assert.equal(isSubPath("C:\\Games\\A\\b.txt", "c:/games/a"), true);
  assert.equal(isSubPath("/a/b", "/a/b"), true);
  assert.equal(isSubPath("/a/b/", "/a/b"), true);
  assert.equal(isSubPath("/a/b", "/a/b/"), true);
  assert.equal(isSubPath("/a/bc", "/a/b"), false); // 反例：裸前缀比较会误判
  assert.equal(isSubPath("/a/b", ""), false);
  assert.equal(isSubPath("/a/b", "/"), true);
});

test("basename / extOf", () => {
  assert.equal(basename("C:\\a\\b.txt"), "b.txt");
  assert.equal(basename("/a/b/"), "b");
  assert.equal(basename("C:\\"), "c:");
  assert.equal(basename("/"), "/");
  assert.equal(basename("a"), "a");
  assert.equal(extOf("a/b.TXT"), ".txt");
  assert.equal(extOf("a/b.tar.gz"), ".gz");
  assert.equal(extOf(".gitignore"), "");
  assert.equal(extOf("a."), "");
  assert.equal(extOf("noext"), "");
  assert.equal(extOf("dir.d/file"), "");
});
