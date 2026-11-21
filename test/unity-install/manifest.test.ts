/**
 * T1 纯核心：manifest 依赖检测/构建/diff（不写真实工程）。
 * 口径：只改 dependencies[packageId]；保留缩进/BOM/其它键；diff 只含目标依赖行。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detectPackage, buildManifestText, diffManifest,
  UNITY_MCP_PACKAGE_ID, UNITY_MCP_PACKAGE_VERSION, UNITY_MCP_PACKAGE_URL, UNITY_INSTALL_TTL_MS,
} from "../../apps/server/src/services/unity-install-core";

const URL = "https://github.com/CoplayDev/unity-mcp.git?path=/MCPForUnity#v10.0.0";
const isUnsafe = (e: unknown): boolean =>
  (e as { details?: { code?: string } })?.details?.code === "UNITY_INSTALL_MANIFEST_UNSAFE";

test("固定常量：包 id/版本/URL/TTL", () => {
  assert.equal(UNITY_MCP_PACKAGE_ID, "com.coplaydev.unity-mcp");
  assert.equal(UNITY_MCP_PACKAGE_VERSION, "10.0.0");
  assert.equal(UNITY_MCP_PACKAGE_URL, URL);
  assert.equal(UNITY_INSTALL_TTL_MS, 600000);
});

test("detectPackage：add / none / replace / conflict", () => {
  assert.equal(detectPackage({}).change, "add");
  assert.equal(detectPackage({ dependencies: {} }).change, "add");
  const none = detectPackage({ dependencies: { [UNITY_MCP_PACKAGE_ID]: URL } });
  assert.equal(none.change, "none");
  assert.equal(none.current?.source, "git");
  assert.equal(none.current?.version, "10.0.0");
  assert.equal(detectPackage({ dependencies: { [UNITY_MCP_PACKAGE_ID]: "file:../local" } }).change, "conflict");
  assert.equal(detectPackage({ dependencies: [] }).change, "conflict");
  assert.equal(detectPackage({ dependencies: null }).change, "conflict");
  const rep = detectPackage({ dependencies: { [UNITY_MCP_PACKAGE_ID]: "https://github.com/CoplayDev/unity-mcp.git?path=/MCPForUnity#v9.0.0" } });
  assert.equal(rep.change, "replace");
  assert.equal(rep.current?.version, "9.0.0");
  const reg = detectPackage({ dependencies: { [UNITY_MCP_PACKAGE_ID]: "1.2.3" } });
  assert.equal(reg.change, "replace");
  assert.equal(reg.current?.source, "registry");
});

test("buildManifestText：保留缩进/BOM/其它键/尾换行", () => {
  const src = '{\n  "dependencies": {\n    "x": "1"\n  }\n}\n';
  const out = buildManifestText(src, UNITY_MCP_PACKAGE_ID, URL);
  assert.match(out, /"x": "1"/);
  assert.match(out, /"com.coplaydev.unity-mcp": "https:\/\/github.com\/CoplayDev\/unity-mcp.git\?path=\/MCPForUnity#v10.0.0"/);
  assert.equal(out.endsWith("\n"), true);
  assert.equal(out.includes("\r"), false);

  const src4 = '{\n    "dependencies": {\n        "x": "1"\n    }\n}\n';
  assert.match(buildManifestText(src4, UNITY_MCP_PACKAGE_ID, URL), /\n        "com.coplaydev.unity-mcp"/);

  const srcT = '{\n\t"dependencies": {\n\t\t"x": "1"\n\t}\n}\n';
  assert.match(buildManifestText(srcT, UNITY_MCP_PACKAGE_ID, URL), /\n\t\t"com.coplaydev.unity-mcp"/);

  const outB = buildManifestText("\uFEFF" + src, UNITY_MCP_PACKAGE_ID, URL);
  assert.equal(outB.charCodeAt(0), 0xFEFF);

  const outNew = buildManifestText('{\n  "name": "p"\n}\n', UNITY_MCP_PACKAGE_ID, URL);
  assert.match(outNew, /"dependencies"/);
  assert.match(outNew, /"com.coplaydev.unity-mcp"/);

  assert.throws(() => buildManifestText('{"dependencies": []}', UNITY_MCP_PACKAGE_ID, URL), isUnsafe);
  assert.throws(() => buildManifestText("not json", UNITY_MCP_PACKAGE_ID, URL), isUnsafe);
});

test("diffManifest：只输出目标依赖行的 -/+", () => {
  const before = '{\n  "dependencies": {\n    "com.coplaydev.unity-mcp": "old"\n  }\n}\n';
  const after = buildManifestText(before, UNITY_MCP_PACKAGE_ID, URL);
  const d = diffManifest(before, after);
  assert.match(d, /-    "com.coplaydev.unity-mcp": "old"/);
  assert.match(d, /\+    "com.coplaydev.unity-mcp": "https:/);
  assert.equal(d.split("\n").filter((l) => l.startsWith("+") || l.startsWith("-")).length, 2);
  assert.equal(diffManifest(before, before), "");

  const empty = '{\n  "dependencies": {}\n}\n';
  const add = diffManifest(empty, buildManifestText(empty, UNITY_MCP_PACKAGE_ID, URL));
  assert.equal(add.split("\n").filter((l) => l.startsWith("+")).length, 1);
  assert.equal(add.split("\n").filter((l) => l.startsWith("-")).length, 0);
});

test("detectPackage：canonical 缺键但异 key 指向 unity-mcp → conflict（spec §7）", () => {
  const otherExact = detectPackage({ dependencies: { "com.example.alias": URL } });
  assert.equal(otherExact.change, "conflict");
  assert.equal(otherExact.current, null);
  const otherRepo = detectPackage({ dependencies: { "com.example.alias": "https://github.com/CoplayDev/unity-mcp.git?path=/MCPForUnity#v9.0.0" } });
  assert.equal(otherRepo.change, "conflict");
  assert.equal(otherRepo.current, null);
  // canonical 缺键且无目标 → add（原断言保全）
  assert.equal(detectPackage({ dependencies: { "com.example.other": "1.0.0" } }).change, "add");
  // canonical 已存在同 URL → none（原断言保全）
  assert.equal(detectPackage({ dependencies: { [UNITY_MCP_PACKAGE_ID]: URL } }).change, "none");
});
