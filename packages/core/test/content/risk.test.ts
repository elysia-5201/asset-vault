/**
 * risk.ts 纯函数测试（task-50）
 *
 * 覆盖：.cs/.dll/.so·.dylib·.bundle·.a/Editor/.asmdef·.asmref、大小写与路径规范化、
 *       伪装扩展名不误报、未知扩展名不算风险、去重与排序、超限/不完整 → unknown、blockedReason → blocked。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_MAX_HITS,
  RISK_MAGIC_MAX_BYTES,
  RISK_SCANNER_VERSION,
  hasExecutableContent,
  magicKind,
  scanPaths,
  summarizeRisk,
} from "../../src/risk";

describe("scanPaths：扩展名规则", () => {
  test(".cs → code/warning，state=warning；大小写不敏感（.CS）", () => {
    const r = scanPaths(["Assets/Scripts/Plugin.cs", "Assets/Scripts/OTHER.CS"]);
    assert.equal(r.state, "warning");
    assert.equal(r.hits.length, 2);
    assert.deepEqual(r.hits.map((h) => h.type), ["code", "code"]);
    assert.equal(r.hits[0]!.severity, "warning");
    assert.equal(r.scannerVersion, RISK_SCANNER_VERSION);
  });

  test(".dll → assembly；.so/.dylib/.bundle/.a → native（含大写扩展名）", () => {
    const r = scanPaths(["lib/Foo.dll", "lib/libfoo.so", "lib/libbar.DYLIB", "lib/baz.bundle", "lib/qux.a"]);
    assert.equal(r.state, "warning");
    assert.deepEqual(r.hits.map((h) => h.type).sort(), ["assembly", "native", "native", "native", "native"]);
  });

  test("Editor 目录下的 .cs → editor_code（正斜杠/反斜杠/小写都算，MyEditor 不算）", () => {
    const hits = scanPaths(["Assets/Editor/MyTool.cs"]).hits;
    assert.equal(hits[0]!.type, "editor_code");
    assert.equal(scanPaths(["Assets\\Editor\\MyTool.cs"]).hits[0]!.type, "editor_code");
    assert.equal(scanPaths(["assets/editor/tool.cs"]).hits[0]!.type, "editor_code");
    assert.equal(scanPaths(["Assets/MyEditor/Plug.cs"]).hits[0]!.type, "code", "MyEditor 不是 Editor 段");
    assert.deepEqual(scanPaths(["Assets/Editor/icon.png"]).hits, [], "Editor 里的图片不是代码");
  });

  test("asmdef/asmref → asmdef(severity=info)；单独存在不升级 warning（但 hits 仍记录）", () => {
    const r = scanPaths(["Packages/com.x/Runtime/x.asmdef", "Packages/com.x/Editor/y.asmref"]);
    assert.equal(r.hits.length, 2);
    assert.deepEqual(r.hits.map((h) => h.type), ["asmdef", "asmdef"]);
    assert.deepEqual(r.hits.map((h) => h.severity), ["info", "info"]);
    assert.equal(r.state, "clear");
    assert.equal(hasExecutableContent(r), false);
  });

  test("伪装扩展名 / 未知扩展名不算风险（不猜）", () => {
    const r = scanPaths([
      "readme.cs.txt", "evil.dll.txt", "x.cs.bak", "Assets/a.png", "Assets/b.asset",
      "Assets/c.unitypackage", "Assets/noext", "Assets/trailing.",
    ]);
    assert.deepEqual(r.hits, []);
    assert.equal(r.state, "clear");
    assert.equal(r.scanned, 8);
  });
});

describe("scanPaths：规范化 / 去重 / 排序", () => {
  test("路径规范化后去重（同一文件的 / 与 \\ 写法只算一条）", () => {
    const r = scanPaths(["Assets/Editor/A.cs", "Assets\\Editor\\A.cs"]);
    assert.equal(r.hits.length, 1);
    assert.equal(r.scanned, 2);
  });

  test("结果按 severity → type → path 稳定排序（同输入恒等）", () => {
    const input = ["z.cs", "a.asmdef", "b.cs"];
    const r1 = scanPaths(input);
    const r2 = scanPaths([...input].reverse());
    assert.deepEqual(r1.hits.map((h) => h.path), ["b.cs", "z.cs", "a.asmdef"]);
    assert.deepEqual(r2.hits.map((h) => h.path), r1.hits.map((h) => h.path), "顺序与入参顺序无关");
  });

  test("统一路径：unitypackage 的 pathname（包内路径）同样适用", () => {
    const inner = ["Assets/Avatar/Editor/Setup.cs", "Assets/Avatar/Runtime/Avatar.dll"];
    const r = scanPaths(inner);
    // 排序口径：severity → type（字母序）→ path；两者都是 warning，故 assembly 在 editor_code 前
    assert.deepEqual(r.hits.map((h) => h.type), ["assembly", "editor_code"]);
    assert.equal(r.state, "warning");
  });
});

describe("scanPaths：state 与预算", () => {
  test("空输入 → clear / scanned=0 / truncated=false", () => {
    const r = scanPaths([]);
    assert.deepEqual(r, { state: "clear", hits: [], scanned: 0, truncated: false, scannerVersion: 2 });
  });

  test("命中超上限 → 截断 + truncated + state=unknown（不静默报 warning）", () => {
    const r = scanPaths(["a.cs", "b.cs", "c.cs"], { maxHits: 1 });
    assert.equal(r.hits.length, 1);
    assert.equal(r.truncated, true);
    assert.equal(r.state, "unknown");
    assert.equal(DEFAULT_MAX_HITS, 200);
  });

  test("路径超预算 → 只扫前 N 条 + truncated + unknown", () => {
    const r = scanPaths(["a.cs", "b.cs", "c.dll"], { maxPaths: 2 });
    assert.equal(r.scanned, 2);
    assert.equal(r.truncated, true);
    assert.equal(r.state, "unknown");
  });

  test("incomplete=true（解析 partial/超时）→ unknown，即使没有任何命中", () => {
    const r = scanPaths(["Assets/a.png"], { incomplete: true });
    assert.equal(r.state, "unknown");
    assert.deepEqual(r.hits, []);
  });

  test("blockedReason → blocked（优先于 warning/unknown），并回填原因；空白原因忽略", () => {
    const r = scanPaths(["a.cs"], { blockedReason: "工作台设置：禁止含脚本的包自动导入" });
    assert.equal(r.state, "blocked");
    assert.equal(r.blockedReason, "工作台设置：禁止含脚本的包自动导入");
    assert.equal(r.hits.length, 1, "阻断时仍返回命中，便于 UI 说明");
    assert.equal(scanPaths(["a.cs"], { blockedReason: "   " }).state, "warning");
  });
});

describe("便捷函数", () => {
  test("hasExecutableContent：只看 warning 级（asmdef 不算）", () => {
    assert.equal(hasExecutableContent(scanPaths(["a.cs"])), true);
    assert.equal(hasExecutableContent(scanPaths(["a.asmdef"])), false);
    assert.equal(hasExecutableContent(scanPaths(["a.png"])), false);
  });

  test("summarizeRisk：四种 state 都有人类可读摘要", () => {
    assert.match(summarizeRisk(scanPaths([])), /未发现可执行内容/);
    assert.match(summarizeRisk(scanPaths(["a.cs", "b.dll"])), /code×1|assembly×1/);
    assert.match(summarizeRisk(scanPaths([], { incomplete: true })), /风险未知/);
    assert.match(summarizeRisk(scanPaths([], { blockedReason: "禁止" })), /已阻断/);
  });
});

// ---------------------------------------------------------------- 可选魔数检测（task-56）

const PK = "PK\x03\x04";
const PK_EMPTY = "PK\x05\x06";
const MZ = "MZ\x90\x00";
const ELF = "\x7fELF";
const GZIP = "\x1f\x8b";
const PDF = "%PDF-1.7";
const PNG = "\x89PNG\r\n\x1a\n";

const magicMap = (map: Record<string, string | null>, calls?: string[]) =>
  (p: string): string | null => { calls?.push(p); return map[p] ?? null; };

describe("magic 字节检测（task-56）：扩展名与实际内容矛盾 → disguised/warning", () => {
  test(".pdf 实为 PK、.png 实为 MZ → disguised/warning", () => {
    const r = scanPaths(["docs/manual.pdf", "Assets/icon.png"], { magic: magicMap({ "docs/manual.pdf": PK, "Assets/icon.png": MZ }) });
    assert.equal(r.state, "warning");
    assert.equal(r.hits.length, 2);
    assert.deepEqual(r.hits.map((h) => h.type), ["disguised", "disguised"]);
    assert.deepEqual(r.hits.map((h) => h.severity), ["warning", "warning"]);
    assert.match(r.hits[0]!.reason, /扩展名与内容不符/);
  });

  test("PK\\x05\\x06（空 zip）伪装成 .pdf 也算；无扩展名 + MZ 也算（unknownext+MZ）", () => {
    const r = scanPaths(["empty.pdf", "weird"], { magic: magicMap({ "empty.pdf": PK_EMPTY, weird: MZ }) });
    assert.equal(r.hits.length, 2);
    assert.deepEqual(r.hits.map((h) => h.type), ["disguised", "disguised"]);
  });

  test(".zip 实为 PK 不误报；zip 族扩展名（apk/jar/docx/unitypackage）也不误报", () => {
    const r = scanPaths(["a.zip", "b.apk", "c.jar", "d.docx", "e.unitypackage"], {
      magic: magicMap({ "a.zip": PK, "b.apk": PK, "c.jar": PK, "d.docx": PK, "e.unitypackage": GZIP }),
    });
    assert.deepEqual(r.hits, []);
    assert.equal(r.state, "clear");
  });

  test("ELF / gzip 规则：.so 与 .gz 放行；.png 带 ELF、.png 带 gzip → disguised", () => {
    const ok = scanPaths(["libfoo.so", "pack.gz"], { magic: magicMap({ "libfoo.so": ELF, "pack.gz": GZIP }) });
    // .so 本身是名字级风险（native），不应再叠加 disguised；.gz 放行
    assert.equal(ok.hits.some((h) => h.type === "disguised"), false);
    assert.deepEqual(ok.hits.map((h) => h.type), ["native"]);
    const bad = scanPaths(["a.png", "b.png"], { magic: magicMap({ "a.png": ELF, "b.png": GZIP }) });
    assert.equal(bad.hits.length, 2);
    for (const h of bad.hits) assert.equal(h.type, "disguised");
  });

  test("PDF/PNG/JPEG/GIF 魔数不参与判定（无害改名不误报）", () => {
    const r = scanPaths(["photo.png", "doc.pdf"], { magic: magicMap({ "photo.png": "%PDF-1.7", "doc.pdf": PNG }) });
    assert.deepEqual(r.hits, []);
  });

  test("不提供 magic → 完全不调用、行为等同 task-50（pdf/png 判 clear）", () => {
    const r = scanPaths(["a.pdf", "b.png"]);
    assert.deepEqual(r.hits, []);
    assert.equal(r.state, "clear");
  });

  test("惰性：名字级风险（.cs/.dll）不读；其它扩展名每条最多读一次", () => {
    const calls: string[] = [];
    const r = scanPaths(["a.cs", "b.txt", "c.png", "d.zip", "c.png"], { magic: magicMap({ "c.png": PNG, "d.zip": PK }, calls) });
    assert.deepEqual(calls, ["b.txt", "c.png", "d.zip"], "a.cs 已由扩展名判风险，不读；重复路径不重复读");
    assert.deepEqual(r.hits.map((h) => h.type), ["code"]);
  });

  test("magic 返回 null / 太短 / 抛错 → 不判定、不崩（scanned 仍计数）", () => {
    assert.deepEqual(scanPaths(["a.png"], { magic: () => null }).hits, []);
    assert.deepEqual(scanPaths(["a.png"], { magic: () => "\x89" }).hits, [], "太短无法判定");
    const r = scanPaths(["a.png"], { magic: () => { throw new Error("boom"); } });
    assert.deepEqual(r.hits, []);
    assert.equal(r.state, "clear");
    assert.equal(r.scanned, 1);
  });

  test("blockedReason 仍优先于 disguised", () => {
    const r = scanPaths(["a.png"], { magic: magicMap({ "a.png": MZ }), blockedReason: "禁止导入" });
    assert.equal(r.state, "blocked");
    assert.ok(r.hits.some((h) => h.type === "disguised"));
  });
});

describe("magicKind：魔数 → 实际种类（纯函数）", () => {
  test("PK/MZ/%PDF/PNG/JPEG/GIF/ELF/gzip 可识别；其它返回 null", () => {
    assert.equal(magicKind("PK\x03\x04"), "zip");
    assert.equal(magicKind(MZ), "pe");
    assert.equal(magicKind(PDF), "pdf");
    assert.equal(magicKind(PNG), "png");
    assert.equal(magicKind("\xff\xd8\xff\xe0"), "jpeg");
    assert.equal(magicKind("GIF89a"), "gif");
    assert.equal(magicKind(ELF), "elf");
    assert.equal(magicKind(GZIP), "gzip");
    assert.equal(magicKind("\x00\x01\x02"), null);
    assert.equal(magicKind("\x50"), null, "不足 2 字节不判定");
    assert.equal(magicKind(null), null);
    assert.equal(RISK_MAGIC_MAX_BYTES, 8);
  });

  test("也接受 Uint8Array / ArrayBuffer", () => {
    assert.equal(magicKind(Uint8Array.from([0x50, 0x4b, 0x03, 0x04])), "zip");
    assert.equal(magicKind(new Uint8Array([0x4d, 0x5a]).buffer), "pe");
  });
});
