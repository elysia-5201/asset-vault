/**
 * 全局导入：ImportPanel 外部批次注入与 App 级挂载（task-87 fix-r2；G6 H1/H2/N2/N3/M2/F3）。
 *
 * 证据层级：
 * ① 纯行为：pathsFromFileList / shouldAcceptExternalBatch（含待确认）；
 * ② **真实 SSR 渲染**（react-dom/server，仓库既有用法）：ImportPanel 带 externalBatches props 能渲染、GlobalDrop 初始不渲染覆盖层；
 * ③ 静态补充：唯一入口/取消预检/批次队列/常驻挂载/窄 guard/忙碌门/草稿拆分。
 * 仍**不是** DOM 事件执行；真实 Electron/DOM 门由 fixture 承接。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { pathsFromFileList, shouldAcceptExternalBatch } from "../../apps/web/src/file-intake";
import { ImportPanel } from "../../apps/web/src/components/ImportPanel";
import { GlobalDrop } from "../../apps/web/src/global-drop";

function fakeFile(name: string, path?: string): File {
  const f = { name } as File & { path?: string };
  if (path !== undefined) (f as unknown as { path: string }).path = path;
  return f;
}

test("pathsFromFileList：桥优先、桥 null 回退 File.path、都无计 ignored", () => {
  const r = pathsFromFileList(
    [fakeFile("a.zip"), fakeFile("b.zip", "C:\\b.zip"), fakeFile("c.zip")],
    { getPathForFile: (f) => (f.name === "a.zip" ? "C:\\a.zip" : null) },
  );
  assert.deepEqual(r.paths, ["C:\\a.zip", "C:\\b.zip"]);
  assert.equal(r.ignored, 1);
});

test("F2：待确认预检也算忙碌（新批次不得静默替换）", () => {
  assert.equal(shouldAcceptExternalBatch({ prechecking: false, importing: false, pending: false }), true);
  assert.equal(shouldAcceptExternalBatch({ prechecking: false, importing: false, pending: true }), false);
  assert.equal(shouldAcceptExternalBatch({ prechecking: true, importing: false, pending: false }), false);
  assert.equal(shouldAcceptExternalBatch({ prechecking: false, importing: true, pending: false }), false);
});

test("F6：ImportPanel 真实 SSR 渲染（带 externalBatches props）不崩且含本地面板", () => {
  const html = renderToString(createElement(ImportPanel, {
    roots: [], onToast: () => {}, onJobsChanged: () => {}, onDataChanged: () => {},
    mode: "live", externalBatches: [{ id: 1, paths: ["C:\\a.zip"] }], onExternalPathsConsumed: () => {},
  } as never));
  assert.ok(html.includes("本地路径导入"), "应渲染本地路径导入区");
  assert.ok(html.includes("拖到页面任意位置"), "拖入区应指向全局唯一入口");
});

test("F6：GlobalDrop 初始不渲染覆盖层（SSR）", () => {
  const html = renderToString(createElement(GlobalDrop, { onPaths: () => {}, onToast: () => {} }));
  assert.equal(html, "", "未拖入时不应渲染覆盖层");
});

const PANEL = fileURLToPath(new URL("../../apps/web/src/components/ImportPanel.tsx", import.meta.url));
const APP = fileURLToPath(new URL("../../apps/web/src/App.tsx", import.meta.url));
const DROP = fileURLToPath(new URL("../../apps/web/src/global-drop.tsx", import.meta.url));

/** 从 marker 切到该语句结束的 `\n  };` 或 effect 的 `\n  }, [`（本文件只用于单层箭头/effect 体）。 */
function sliceFn(src: string, marker: string): string {
  const i = src.indexOf(marker);
  assert.ok(i >= 0, "找不到 " + marker);
  const ends = [src.indexOf("\n  };", i), src.indexOf("\n  }, [", i)].filter((x) => x >= 0);
  const j = ends.length ? Math.min(...ends) : -1;
  return src.slice(i, j < 0 ? src.length : j);
}

test("F7：面板不再有独立 drop 处理（唯一入口）；F2：有取消预检动作（静态补充）", () => {
  const src = readFileSync(PANEL, "utf8");
  // F7：面板的 onDrop 只是防导航窄 guard，不得再直接处理 dataTransfer.files。
  assert.equal(/dt\.files/.test(src), false, "面板不得再直接读 dataTransfer.files");
  assert.equal(/onDrop=\{onDrop\}/.test(src), true, "drop 区应挂窄 guard（事件冒泡给 GlobalDrop）");
  assert.match(src, /cancelPrecheck/, "必须有取消预检动作");
  assert.match(src, /createPrecheckGate/, "必须用真实可失效的预检门");
  assert.match(src, /pending: precheck !== null/, "忙碌门必须包含待确认预检");
  assert.match(src, /mergePathDraft\(/, "必须用只追加的草稿合并");
});

test("N3：面板 onDrop 是真正防导航的窄 guard（不读路径、不触预检）", () => {
  const src = readFileSync(PANEL, "utf8");
  const body = sliceFn(src, "const onDrop =");
  assert.match(body, /preventDefault/, "必须阻止浏览器默认导航");
  assert.match(body, /types/, "按 Files 类型判定");
  assert.equal(/files/.test(body), false, "不得读 dataTransfer.files");
  assert.equal(/precheckPaths|doPrecheck/.test(body), false, "不得触发预检");
});

test("M2：选择文件入口与全局同一 busy 门；input 值在正确时机复位", () => {
  const src = readFileSync(PANEL, "utf8");
  const body = sliceFn(src, "const handleFiles =");
  assert.match(body, /shouldAcceptExternalBatch/, "选择文件必须走同一忙碌门");
  assert.match(body, /pending: precheck !== null/, "忙碌门包含待确认预检");
  assert.match(src, /handleFiles\(e\.target\.files\);\s*e\.target\.value = ""/, "选择后复位 input，允许重选同一文件");
});

test("H1：自动预检只送严格绝对路径；非法行给准确反馈；placeholder 不再暗示 env 展开", () => {
  const src = readFileSync(PANEL, "utf8");
  const body = sliceFn(src, "const doPrecheck =");
  assert.match(body, /splitDraftPaths/, "必须用不抛的草稿拆分");
  assert.equal(/splitPaths\(/.test(body), false, "不得再用会抛 URIError 的 splitPaths");
  assert.match(body, /invalid/, "非法行必须单独反馈");
  assert.equal(/%DOWNLOADS%/.test(src), false, "placeholder 不得再暗示环境变量展开");
});

test("F3：组件卸载时 dispose 预检门（真实 cleanup；HB1 后按挂载生命周期，不再 dispose ref 当前值）", () => {
  const src = readFileSync(PANEL, "utf8");
  assert.match(src, /life\.dispose\(\)/, "卸载必须 dispose 本次挂载捕获的 gate");
  assert.match(src, /useEffect\(\(\) => \{/, "必须是 effect setup/cleanup 形式");
});

test("H2：App 保持 ImportPanel 挂载（切 tab 只隐藏，不卸载）", () => {
  const src = readFileSync(APP, "utf8");
  assert.equal(/sideTab === "import"\s*\?\s*<ImportPanel/.test(src), false, "不得用三元表达式卸载 ImportPanel");
  assert.match(src, /display: sideTab === "import"/, "导入面板用 display 切换可见性");
  assert.match(src, /display: sideTab === "jobs"/, "作业面板同样常驻");
  assert.match(src, /<ImportPanel/, "ImportPanel 仍渲染");
  assert.match(src, /<JobsPanel/, "JobsPanel 仍渲染");
});

test("N2：App 用批次队列 + id 消费（CAS），不用内容做身份", () => {
  const src = readFileSync(APP, "utf8");
  assert.match(src, /setExternalBatches\(\(prev\) => \[\.\.\.prev, \{ id, paths \}\]\)/, "追加带 id 的批次");
  assert.match(src, /prev\.filter\(\(b\) => b\.id !== id\)/, "按 id CAS 移除，不抹掉更晚批次");
  assert.equal(/setExternalPaths/.test(src), false, "旧的内容数组已移除");
});

test("F8：App 追加而非替换，并切到导入 tab（静态补充）", () => {
  const src = readFileSync(APP, "utf8");
  assert.match(src, /setExternalBatches\(\(prev\) => \[\.\.\.prev, \{ id, paths \}\]\)/, "必须追加而不是替换");
  assert.match(src, /setSideTab\("import"\)/, "必须切到导入 tab");
  assert.match(src, /setSideOpen\(true\)/, "必须打开侧栏");
});

test("global-drop：注册 5 个 window 监听并在 cleanup 全部移除（静态补充）", () => {
  const src = readFileSync(DROP, "utf8");
  for (const ev of ["dragenter", "dragover", "dragleave", "drop", "paste"]) {
    assert.match(src, new RegExp('addEventListener\\("' + ev + '"'), "缺 addEventListener " + ev);
    assert.match(src, new RegExp('removeEventListener\\("' + ev + '"'), "缺 removeEventListener " + ev);
  }
  assert.match(src, /松开导入/, "必须有覆盖层文案");
  assert.match(src, /zIndex: 50/, "覆盖层必须低于 toast");
});
test("HB1：ImportPanel 用 createGateLifecycle 为每次挂载建 gate，cleanup 只 dispose 自己捕获的那个", () => {
  const src = readFileSync(PANEL, "utf8");
  assert.match(src, /createGateLifecycle/, "必须用生产生命周期原语（每次挂载独立 gate）");
  assert.equal(/gateRef\.current\.dispose\(\)/.test(src), false, "cleanup 不得 dispose ref 里的未来 gate");
  const body = sliceFn(src, "useEffect(() => {\n    const life");
  assert.match(body, /life\.dispose\(\)/, "cleanup 必须 dispose 本次捕获的 lifecycle");
  assert.match(body, /gateRef\.current = life\.gate/, "setup 必须把本次 gate 装进 ref");
});

test("HB1 分层：App 的 externalBatches 初值为空（首次挂载不可能有待消费批次）", () => {
  const src = readFileSync(APP, "utf8");
  assert.match(src, /useState<ExternalBatch\[\]>\(\[\]\)/, "初值必须是空队列");
});
