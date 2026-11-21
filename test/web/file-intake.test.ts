/**
 * 全局导入：file-intake 纯逻辑（task-87 fix-r1；G4 F1/F3/F9/F10/F11/F12）。
 * 纯函数 + 假事件对象（**不是**真实 DOM/Electron 事件；真实运行门由 fixture 承接）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createFileIntake, createPrecheckGate, dedupePaths, isEditableTarget, mergePathDraft,
  normalizePath, parsePathText, pathsFromFileList, shouldAcceptExternalBatch,
} from "../../apps/web/src/file-intake";
import * as intake from "../../apps/web/src/file-intake";

function fakeFile(name: string, path?: string): File {
  const f = { name } as File & { path?: string };
  if (path !== undefined) (f as unknown as { path: string }).path = path;
  return f;
}

interface FakeEvent<E = DragEvent> { prevented: boolean; event: E }

function dropEvent(opts: { files?: File[]; types?: string[]; text?: string; target?: unknown } = {}): FakeEvent {
  const state = { prevented: false };
  const files = opts.files ?? [];
  const types = opts.types ?? (files.length ? ["Files"] : []);
  const event = {
    target: opts.target ?? { tagName: "DIV", isContentEditable: false },
    preventDefault: () => { state.prevented = true; },
    dataTransfer: { files, types, getData: (k: string) => (k === "text/plain" ? (opts.text ?? "") : "") },
  } as unknown as DragEvent;
  return { get prevented() { return state.prevented; }, event } as FakeEvent;
}

function pasteEvent(opts: { files?: File[]; text?: string; target?: unknown } = {}): FakeEvent<ClipboardEvent> {
  const state = { prevented: false };
  const event = {
    target: opts.target ?? { tagName: "DIV", isContentEditable: false },
    preventDefault: () => { state.prevented = true; },
    clipboardData: { files: opts.files ?? [], getData: (k: string) => (k === "text/plain" ? (opts.text ?? "") : "") },
  } as unknown as ClipboardEvent;
  return { get prevented() { return state.prevented; }, event } as FakeEvent<ClipboardEvent>;
}

test("normalizePath：盘符/UNC/中文空格/file URI 保留；普通文字与网页 URL 拒绝", () => {
  assert.equal(normalizePath("C:\\素材 库\\a.zip"), "C:\\素材 库\\a.zip");
  assert.equal(normalizePath("file:///C:/x/a.zip"), "C:/x/a.zip");
  assert.equal(normalizePath("file://server/share/a.zip"), "//server/share/a.zip");
  assert.equal(normalizePath("\\\\server\\share\\a.zip"), "\\\\server\\share\\a.zip");
  assert.equal(normalizePath("/home/u/a.zip"), "/home/u/a.zip");
  assert.equal(normalizePath("hello world"), null);
  assert.equal(normalizePath("https://booth.pm/ja/items/1"), null);
  assert.equal(normalizePath(""), null);
});

test("F9：畸形 file URI 不抛、返回 null", () => {
  assert.equal(normalizePath("file://%zz"), null);
  assert.equal(normalizePath("file:///%E0%A4%A"), null);
});

test("parsePathText：只接管合法绝对路径文本；普通文字/URL 不接管", () => {
  assert.deepEqual(parsePathText("C:\\a.zip\nD:\\b 目录\\c.7z"), ["C:\\a.zip", "D:\\b 目录\\c.7z"]);
  assert.deepEqual(parsePathText("\"C:\\a.zip\"; file:///C:/b.zip"), ["C:\\a.zip", "C:/b.zip"]);
  assert.deepEqual(parsePathText("看看这个 https://example.com/x"), []);
});

test("F12：去重仅 Windows 盘符/UNC 大小写无关；POSIX 大小写敏感", () => {
  assert.deepEqual(dedupePaths(["C:\\A.zip", "c:\\a.zip", "D:\\b.zip"]), ["C:\\A.zip", "D:\\b.zip"]);
  assert.deepEqual(dedupePaths(["/Home/A.zip", "/home/a.zip"]), ["/Home/A.zip", "/home/a.zip"]);
});

test("F1：mergePathDraft 保留原草稿（%DOWNLOADS%/相对路径/普通文字），只追加去重", () => {
  const draft = "%DOWNLOADS%/pkg.zip\nrelative/abc.zip\nhello world";
  const merged = mergePathDraft(draft, ["C:\\a.zip", "c:\\a.zip"]);
  assert.equal(merged, draft + "\nC:\\a.zip");
  assert.equal(mergePathDraft("", ["C:\\a.zip"]), "C:\\a.zip");
  assert.equal(mergePathDraft(draft, []), draft, "无新路径时原样返回");
  assert.equal(mergePathDraft("C:\\a.zip", ["c:\\a.zip"]), "C:\\a.zip", "已存在则不重复追加");
});

test("拖入文件：桥优先，桥 null 回退 File.path，都无则计 ignored", () => {
  const intake = createFileIntake({ getPathForFile: (f) => (f.name === "a.zip" ? "C:\\a.zip" : null) });
  const r = intake.handleDrop(dropEvent({ files: [fakeFile("a.zip"), fakeFile("b.zip", "C:\\b.zip"), fakeFile("c.zip")] }).event);
  assert.deepEqual(r.paths, ["C:\\a.zip", "C:\\b.zip"]);
  assert.equal(r.ignored, 1);
});

test("无桥且无 File.path：paths 空、ignored 计数、不伪造", () => {
  const intake = createFileIntake({});
  const r = intake.handleDrop(dropEvent({ files: [fakeFile("a.zip"), fakeFile("b.zip")] }).event);
  assert.deepEqual(r.paths, []);
  assert.equal(r.ignored, 2);
  assert.equal(r.reason, "no-path");
});

test("可编辑区：不接管、不 preventDefault", () => {
  const intake = createFileIntake({ getPathForFile: () => "C:\\a.zip" });
  const ev = dropEvent({ files: [fakeFile("a.zip")], target: { tagName: "TEXTAREA", isContentEditable: false } });
  const r = intake.handleDrop(ev.event);
  assert.equal(r.reason, "editable");
  assert.equal(ev.prevented, false);
  assert.equal(isEditableTarget({ tagName: "INPUT" } as unknown as EventTarget), true);
  assert.equal(isEditableTarget({ tagName: "DIV", isContentEditable: true } as unknown as EventTarget), true);
  assert.equal(isEditableTarget({ tagName: "DIV", isContentEditable: false } as unknown as EventTarget), false);
});

test("纯文本拖入：合法绝对路径接管并 preventDefault；普通文字不接管", () => {
  const intake = createFileIntake({});
  const ok = dropEvent({ text: "C:\\a.zip" });
  assert.deepEqual(intake.handleDrop(ok.event).paths, ["C:\\a.zip"]);
  assert.equal(ok.prevented, true);

  const plain = dropEvent({ text: "这是一段普通文字" });
  assert.deepEqual(intake.handleDrop(plain.event).paths, []);
  assert.equal(plain.prevented, false);
});

test("粘贴：文件优先；无文件时只接管绝对路径文本；可编辑区不抢", () => {
  const intake = createFileIntake({ getPathForFile: () => "C:\\a.zip" });
  const files = pasteEvent({ files: [fakeFile("a.zip")] });
  assert.deepEqual(intake.handlePaste(files.event).paths, ["C:\\a.zip"]);
  assert.equal(files.prevented, true);

  const text = pasteEvent({ text: "D:\\b.zip" });
  assert.deepEqual(intake.handlePaste(text.event).paths, ["D:\\b.zip"]);

  const editable = pasteEvent({ text: "D:\\b.zip", target: { tagName: "INPUT" } });
  assert.equal(intake.handlePaste(editable.event).reason, "editable");
  assert.equal(editable.prevented, false);
});

test("F3：cancel 使在飞响应失效；end 释放后允许新批次", () => {
  const gate = createPrecheckGate();
  const g1 = gate.begin();
  assert.ok(g1 !== null);
  assert.equal(gate.begin(), null, "在飞时第二次 begin 被挡");

  gate.cancel();
  assert.equal(gate.isCurrent(g1 as number), false, "取消后旧 generation 失效");
  assert.equal(gate.isBusy(), false, "取消后释放");

  const g2 = gate.begin();
  assert.ok(g2 !== null && g2 !== g1, "取消后可开新批次且 generation 递增");
  assert.equal(gate.isCurrent(g2 as number), true);
  gate.end(g2 as number);
  assert.equal(gate.isBusy(), false);
});

test("F2：shouldAcceptExternalBatch 把待确认预检也算忙碌", () => {
  assert.equal(shouldAcceptExternalBatch({ prechecking: false, importing: false, pending: false }), true);
  assert.equal(shouldAcceptExternalBatch({ prechecking: true, importing: false, pending: false }), false);
  assert.equal(shouldAcceptExternalBatch({ prechecking: false, importing: true, pending: false }), false);
  assert.equal(shouldAcceptExternalBatch({ prechecking: false, importing: false, pending: true }), false);
});

test("pathsFromFileList：桥优先、桥 null 回退 File.path、都无计 ignored", () => {
  const r = pathsFromFileList(
    [fakeFile("a.zip"), fakeFile("b.zip", "C:\\b.zip"), fakeFile("c.zip")],
    { getPathForFile: (f) => (f.name === "a.zip" ? "C:\\a.zip" : null) },
  );
  assert.deepEqual(r.paths, ["C:\\a.zip", "C:\\b.zip"]);
  assert.equal(r.ignored, 1);
});
// ---------- fix-r2（G6）：H1 / N2 / F3 真实 deferred ----------

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

test("H1：splitDraftPaths 只把严格绝对路径送预检；非法行单独返回且不抛", () => {
  const draft = "%DOWNLOADS%/pkg.zip\nrelative/abc.zip\nhello world\nfile://%zz\nC:\\a.zip\n/home/u/b.zip";
  const r = intake.splitDraftPaths(draft);
  assert.deepEqual(r.valid, ["C:\\a.zip", "/home/u/b.zip"], "只有严格绝对路径进预检");
  assert.deepEqual(r.invalid, ["%DOWNLOADS%/pkg.zip", "relative/abc.zip", "hello world", "file://%zz"], "非法行原样返回用于反馈");
  assert.deepEqual(intake.splitDraftPaths(""), { valid: [], invalid: [] });
  assert.deepEqual(intake.splitDraftPaths("C:\\a.zip; c:\\a.zip").valid, ["C:\\a.zip"], "Windows 大小写去重");
  assert.deepEqual(intake.splitDraftPaths("# 注释\n\"D:\\b.zip\"").valid, ["D:\\b.zip"], "注释跳过、引号剥离");
});

test("N2：批次身份是 id 不是内容；同内容新 id 可再次消费", () => {
  const a = { id: 1, paths: ["C:\\a.zip"] };
  const a2 = { id: 2, paths: ["C:\\a.zip"] };
  assert.deepEqual(intake.pickNextBatch([a], 0), a, "首个批次可消费");
  assert.equal(intake.pickNextBatch([a], 1), null, "已消费的同一批次不再返回");
  assert.deepEqual(intake.pickNextBatch([a, a2], 1), a2, "同内容的新批次仍可消费（内容不作身份）");
  assert.deepEqual(intake.pickNextBatch([a, a2], 0), a, "先处理更早的批次，后者不覆盖");
  assert.equal(intake.pickNextBatch([], 0), null);
});

test("F3：runGuarded 真实 deferred —— 未取消按序回调；取消/卸载后 resolve/reject/finally 都不写", async () => {
  // 正例：不取消
  const g1 = intake.createPrecheckGate();
  const d1 = deferred<string>();
  const seen1: string[] = [];
  const gen1 = intake.runGuarded(g1, () => d1.promise, {
    onValue: (v) => seen1.push("value:" + v),
    onError: () => seen1.push("error"),
    onSettled: () => seen1.push("settled"),
  });
  assert.equal(typeof gen1, "number", "开跑返回 generation");
  assert.equal(g1.isBusy(), true, "开跑即 busy");
  d1.resolve("ok");
  await flush();
  assert.deepEqual(seen1, ["value:ok", "settled"], "正常路径：值 → settled");
  assert.equal(g1.isBusy(), false, "settled 后释放 busy");

  // 反例 1：取消后迟到 resolve
  const g2 = intake.createPrecheckGate();
  const d2 = deferred<string>();
  const seen2: string[] = [];
  intake.runGuarded(g2, () => d2.promise, { onValue: () => seen2.push("value"), onError: () => seen2.push("error"), onSettled: () => seen2.push("settled") });
  g2.cancel();
  d2.resolve("late");
  await flush();
  assert.deepEqual(seen2, [], "取消后迟到 resolve 不写状态");
  assert.equal(g2.isBusy(), false, "取消即释放");

  // 反例 2：取消后迟到 reject
  const g3 = intake.createPrecheckGate();
  const d3 = deferred<string>();
  const seen3: string[] = [];
  intake.runGuarded(g3, () => d3.promise, { onValue: () => seen3.push("value"), onError: () => seen3.push("error"), onSettled: () => seen3.push("settled") });
  g3.cancel();
  d3.reject(new Error("late"));
  await flush();
  assert.deepEqual(seen3, [], "取消后迟到 reject 不写状态");

  // 反例 3：卸载（dispose）后迟到 resolve
  const g4 = intake.createPrecheckGate();
  const d4 = deferred<string>();
  const seen4: string[] = [];
  intake.runGuarded(g4, () => d4.promise, { onValue: () => seen4.push("value"), onError: () => seen4.push("error"), onSettled: () => seen4.push("settled") });
  g4.dispose();
  assert.equal(g4.begin(), null, "卸载后不再接受新批次");
  d4.resolve("late");
  await flush();
  assert.deepEqual(seen4, [], "卸载后迟到 resolve 不写状态");
  assert.equal(g4.isBusy(), false);
});
// ---------- fix-r3（G7）：HB1 挂载生命周期 / m1 types-only / m4 dispose+reject 与旧 settle ----------

test("HB1 反例：永久 dispose 的 gate 重挂后 begin 恒 null（旧接线的缺陷本身）", () => {
  const g = intake.createPrecheckGate();
  g.dispose();
  assert.equal(g.isDisposed(), true);
  assert.equal(g.begin(), null, "永久 dispose 后无法再开批次");
  assert.equal(intake.runGuarded(g, () => Promise.resolve("x"), {
    onValue: () => {}, onError: () => {}, onSettled: () => {},
  }), null, "runGuarded 也拿不到 generation");
});

test("HB1：setupA→cleanupA→setupB —— 新 gate 可用；A 的迟到 resolve/reject/settle 都不改 B", async () => {
  // setupA
  const a = intake.createGateLifecycle();
  const dA = deferred<string>();
  const seenA: string[] = [];
  intake.runGuarded(a.gate, () => dA.promise, {
    onValue: () => seenA.push("value"), onError: () => seenA.push("error"), onSettled: () => seenA.push("settled"),
  });
  assert.equal(a.gate.isBusy(), true);

  // cleanupA（StrictMode 的第一次 cleanup）
  a.dispose();
  assert.equal(a.gate.isDisposed(), true);

  // setupB（第二次 setup）：必须是全新可用 gate
  const b = intake.createGateLifecycle();
  assert.equal(b.gate.isDisposed(), false, "重挂后 gate 不得是已 dispose 的那个");
  assert.equal(b.gate.isBusy(), false);
  const gen = b.gate.begin();
  assert.equal(typeof gen, "number", "重挂后仍能 begin");
  b.gate.end(gen as number);

  const dB = deferred<string>();
  const seenB: string[] = [];
  intake.runGuarded(b.gate, () => dB.promise, {
    onValue: (v) => seenB.push("value:" + v), onError: () => seenB.push("error"), onSettled: () => seenB.push("settled"),
  });
  assert.equal(b.gate.isBusy(), true);

  // A 的迟到 resolve：不写 A、不碰 B、不清 B 的 busy
  dA.resolve("late-a");
  await flush();
  assert.deepEqual(seenA, [], "A 的迟到回调不写");
  assert.deepEqual(seenB, [], "A 的迟到回调不碰 B");
  assert.equal(b.gate.isBusy(), true, "A 的迟到 settle 不清 B 的 busy");

  dB.resolve("b");
  await flush();
  assert.deepEqual(seenB, ["value:b", "settled"], "B 自己的批次正常回调");
  assert.equal(b.gate.isBusy(), false);

  // cleanupB：丢弃其晚回调
  const dB2 = deferred<string>();
  const seenB2: string[] = [];
  intake.runGuarded(b.gate, () => dB2.promise, {
    onValue: () => seenB2.push("value"), onError: () => seenB2.push("error"), onSettled: () => seenB2.push("settled"),
  });
  b.dispose();
  dB2.resolve("late-b");
  await flush();
  assert.deepEqual(seenB2, [], "cleanupB 后迟到 resolve 不写");
});

test("m4：dispose 后 reject 不写；旧批 settle 不清新批 busy", async () => {
  // dispose + reject
  const g = intake.createPrecheckGate();
  const d = deferred<string>();
  const seen: string[] = [];
  intake.runGuarded(g, () => d.promise, {
    onValue: () => seen.push("value"), onError: () => seen.push("error"), onSettled: () => seen.push("settled"),
  });
  g.dispose();
  d.reject(new Error("late"));
  await flush();
  assert.deepEqual(seen, [], "dispose 后迟到 reject 不写");

  // 旧批 settle 不清新批 busy
  const g2 = intake.createPrecheckGate();
  const d1 = deferred<string>();
  intake.runGuarded(g2, () => d1.promise, { onValue: () => {}, onError: () => {}, onSettled: () => {} });
  g2.cancel();
  const d2 = deferred<string>();
  const seen2: string[] = [];
  intake.runGuarded(g2, () => d2.promise, {
    onValue: (v) => seen2.push("value:" + v), onError: () => seen2.push("error"), onSettled: () => seen2.push("settled"),
  });
  assert.equal(g2.isBusy(), true);
  d1.resolve("old");
  await flush();
  assert.equal(g2.isBusy(), true, "旧批迟到 settle 不得清掉新批 busy");
  assert.deepEqual(seen2, [], "旧批迟到回调不写新批");
  d2.resolve("new");
  await flush();
  assert.deepEqual(seen2, ["value:new", "settled"]);
  assert.equal(g2.isBusy(), false);
});

test("m1：types 含 Files 但 files 为空时也阻止浏览器导航；普通 URL 文本不抢", () => {
  const intake = createFileIntake({});
  const ev = dropEvent({ types: ["Files"] });
  const r = intake.handleDrop(ev.event);
  assert.equal(ev.prevented, true, "外部 Files 类型必须 preventDefault（即使 files 为空）");
  assert.deepEqual(r.paths, []);
  assert.equal(r.reason, "no-path");
  assert.equal(r.ignored, 0);

  const url = dropEvent({ types: ["text/plain"], text: "https://example.com/x" });
  assert.deepEqual(intake.handleDrop(url.event).paths, []);
  assert.equal(url.prevented, false, "普通 URL 文本不抢");

  const editable = dropEvent({ types: ["Files"], target: { tagName: "TEXTAREA", isContentEditable: false } });
  assert.equal(intake.handleDrop(editable.event).reason, "editable");
  assert.equal(editable.prevented, false, "可编辑区仍走原生");
});
