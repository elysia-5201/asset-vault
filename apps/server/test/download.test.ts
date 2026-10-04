import { test } from "node:test";
import assert from "node:assert/strict";
import { parseProtocolUrl, isAllowedBoothUrl, sanitizeFileName } from "../src/services/download";

test("parseProtocolUrl: 解析 BLM 协议 URL（真实形状）", () => {
  const raw = "booth-library-manager://item-import?dlurl=https%3A%2F%2Fbooth.pm%2Fdownloadables%2F8792126%3Fvariation_id%3D13817688&downloadable_filename=BOOTH-Asset-Manager-Free.zip&item_id=8255134&order_id=12345&variation_id=13817688";
  const p = parseProtocolUrl(raw);
  assert.ok(p);
  assert.equal(p!.itemId, "8255134");
  assert.equal(p!.fileName, "BOOTH-Asset-Manager-Free.zip");
  assert.equal(p!.variationId, "13817688");
  assert.match(p!.dlUrl, /^https:\/\/booth\.pm\/downloadables\/8792126/);
});

test("parseProtocolUrl: 非协议/缺 dlurl 一律 null（负例）", () => {
  assert.equal(parseProtocolUrl("https://booth.pm/ja/items/1"), null);
  assert.equal(parseProtocolUrl("booth-library-manager://item-import?item_id=1"), null);
  assert.equal(parseProtocolUrl("booth-library-manager://item-import?dlurl=not-a-url"), null);
  assert.equal(parseProtocolUrl(""), null);
});

test("isAllowedBoothUrl: 只有 https 的 *.booth.pm 通过（正/负例）", () => {
  assert.equal(isAllowedBoothUrl("https://booth.pm/downloadables/1?variation_id=2"), true);
  assert.equal(isAllowedBoothUrl("https://s6.booth.pm/abc/def.zip"), true);
  assert.equal(isAllowedBoothUrl("http://booth.pm/x"), false, "http 必须拒绝");
  assert.equal(isAllowedBoothUrl("https://evil.com/booth.pm/x"), false);
  assert.equal(isAllowedBoothUrl("https://booth.pm.evil.com/x"), false, "后缀伪造必须拒绝");
  assert.equal(isAllowedBoothUrl("file:///etc/passwd"), false);
});

test("sanitizeFileName: 去掉路径与非法字符、防 Windows 保留名", () => {
  assert.equal(sanitizeFileName("../../etc/passwd"), "passwd");
  assert.equal(sanitizeFileName("a/b\\c.zip"), "c.zip");
  assert.equal(sanitizeFileName("CON.zip"), "_CON.zip");
  assert.equal(sanitizeFileName("  trailing.  "), "trailing");
  assert.ok(sanitizeFileName("x".repeat(400)).length <= 180);
});
