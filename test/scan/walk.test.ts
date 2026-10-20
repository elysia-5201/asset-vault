/**
 * v0.6.0 阶段 A：walkCandidates 的显式栈 + 有界批次 + 取消，以及 scanpreview 的流式分类等价性。
 *
 * 迁移安全的核心断言：新实现（显式栈 + 分批）与**旧递归实现**在一棵混合树上逐字段相等
 * （files / dirs / bytes / 顺序 / readability / errorCount），避免"改遍历方式顺手改了语义"。
 * 所有树都建在 mkdtemp 的临时目录里，不碰真实素材库。
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, chmodSync, rmSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, extname, basename } from "node:path";
import Database from "better-sqlite3";
import { migrate } from "../../apps/server/src/db/migrate";
import { Repo } from "../../apps/server/src/db/repo";
import {
  walkCandidates, missingWriteGate, createMemoryManifest, createBackpressureGate,
  type ScannedFile, type ScanManifest, type ScanStats,
} from "../../apps/server/src/services/scan";
import { classifyPreview, createPreviewClassifier, generateScanPreview } from "../../apps/server/src/services/scanpreview";
import { normalizePath } from "../../packages/core/src/pathnorm";

const ROOT = mkdtempSync(join(tmpdir(), "av-walk-"));
after(() => { try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* ignore */ } });

const mkFile = (rel: string, bytes = 10): string => {
  const p = join(ROOT, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, Buffer.alloc(bytes, 7));
  return p;
};
const mkDir = (rel: string): string => { const p = join(ROOT, rel); mkdirSync(p, { recursive: true }); return p; };

// ---------------------------------------------------------------- 旧递归实现（对照基准）
const ARCHIVE_EXT = new Set([".zip", ".7z", ".rar", ".unitypackage"]);
const SKIP_DIR = new Set(["node_modules", ".git", "$RECYCLE.BIN", "System Volume Information", ".npm-cache", "dist"]);
const MAX_SCAN_ISSUES = 100;
async function referenceWalk(rootPath: string, opts: { maxDepth?: number; limit?: number } = {}): Promise<ScanStats> {
  const maxDepth = opts.maxDepth ?? 6;
  const limit = opts.limit ?? 20000;
  const out: ScannedFile[] = [];
  const errors: any[] = [];
  const readability = { rootReadable: false, dirsRead: 0, dirsFailed: 0, entriesStatFailed: 0 };
  let files = 0, dirs = 0, bytes = 0, truncated = false, errorCount = 0;
  const note = (path: string, op: "readdir" | "stat", e: unknown) => {
    errorCount++;
    if (errors.length < MAX_SCAN_ISSUES) errors.push({ path, op, code: (e as any)?.code ?? null, message: String((e as any)?.message ?? e) });
  };
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (truncated || depth > maxDepth) return;
    let entries: string[] = [];
    try { entries = readdirSync(dir); } catch (e) { readability.dirsFailed++; note(dir, "readdir", e); return; }
    readability.dirsRead++;
    if (depth === 0) readability.rootReadable = true;
    for (const name of entries) {
      if (truncated) return;
      if (SKIP_DIR.has(name)) continue;
      const p = join(dir, name);
      let st;
      try { st = statSync(p); } catch (e) { readability.entriesStatFailed++; note(p, "stat", e); continue; }
      if (st.isDirectory()) { dirs++; await walk(p, depth + 1); continue; }
      const ext = extname(name).toLowerCase();
      if (!ARCHIVE_EXT.has(ext)) continue;
      if (out.length >= limit) { truncated = true; return; }
      files++; bytes += st.size;
      out.push({ path: p, size: st.size, mtime: st.mtime.toISOString(), container: ext.slice(1) as any, kind: ext === ".unitypackage" ? "unitypackage" : "archive" });
    }
  };
  await walk(rootPath, 0);
  return { files, dirs, bytes, filesOut: out, truncated, errors, errorCount, readability, complete: !truncated && errorCount === 0 && readability.rootReadable };
}
const shape = (s: ScanStats) => ({
  files: s.files, dirs: s.dirs, bytes: s.bytes, truncated: s.truncated,
  errorCount: s.errorCount, readability: s.readability, complete: s.complete,
  paths: s.filesOut.map((f) => f.path),
  errors: s.errors.map((e) => ({ path: e.path, op: e.op, code: e.code })),
});

describe("walkCandidates：显式栈与旧递归实现逐字段等价", () => {
  test("混合树：顺序 / files / dirs / bytes / readability 全等（含 SKIP_DIR 与多层嵌套）", async () => {
    const root = mkDir("eq/mix");
    mkFile("eq/mix/b_second.zip", 11);
    mkFile("eq/mix/a_first.7z", 12);
    mkFile("eq/mix/notes.txt", 5);
    mkFile("eq/mix/sub1/z.zip", 13);
    mkFile("eq/mix/sub1/deeper/x.unitypackage", 14);
    mkFile("eq/mix/sub1/deeper/y.rar", 15);
    mkFile("eq/mix/sub2/m.zip", 16);
    mkFile("eq/mix/node_modules/skip.zip", 17);
    mkFile("eq/mix/.git/skip2.zip", 18);
    mkFile("eq/mix/dist/skip3.zip", 19);
    const got = await walkCandidates(root, {});
    const want = await referenceWalk(root, {});
    assert.deepEqual(shape(got), shape(want));
    assert.equal(got.files, 6, "6 个候选（skip 目录里的 3 个不算）");
    assert.equal(got.filesOut.length, 6);
    assert.equal(got.complete, true);
    assert.equal(got.readability.rootReadable, true);
  });

  test("maxDepth：越界目录计入 dirs 但不下沉（与旧版一致）", async () => {
    const root = mkDir("depth/tree");
    mkFile("depth/tree/top.zip", 10);
    mkFile("depth/tree/d1/one.zip", 11);
    mkFile("depth/tree/d1/d2/two.zip", 12);
    mkFile("depth/tree/d1/d2/d3/three.zip", 13);
    const got = await walkCandidates(root, { maxDepth: 1 });
    const want = await referenceWalk(root, { maxDepth: 1 });
    assert.deepEqual(shape(got), shape(want));
    // 顺序由 readdir 返回顺序决定（这里只断言"哪些"在，顺序以参考实现为准）
    assert.deepEqual(got.filesOut.map((f) => basename(f.path)).sort(), ["one.zip", "top.zip"]);
    // 旧版语义：d1（深度1）与 d2（深度2，被看到但不下沉）计入 dirs；d3 从未被看到 ⇒ dirs=2
    assert.equal(got.dirs, 2, "越界目录被看到则计数、但不展开（与旧递归实现一致）");
    assert.equal(got.dirs, want.dirs);
  });

  test("limit 截断：只收 limit 个候选 + truncated/complete", async () => {
    const root = mkDir("limit/tree");
    for (let i = 0; i < 5; i++) mkFile("limit/tree/f" + i + ".zip", 10 + i);
    const got = await walkCandidates(root, { limit: 3 });
    const want = await referenceWalk(root, { limit: 3 });
    assert.deepEqual(shape(got), shape(want));
    assert.equal(got.filesOut.length, 3);
    assert.equal(got.truncated, true);
    assert.equal(got.complete, false);
    assert.deepEqual(missingWriteGate(got).reasons, ["truncated"]);
  });
});

describe("walkCandidates：读取失败被记录（不再静默吞）", () => {
  test("目录项 stat 失败（悬空符号链接）→ entriesStatFailed + errors(op=stat)", async () => {
    const root = mkDir("err/stat");
    mkFile("err/stat/ok.zip", 10);
    symlinkSync(join(root, "does-not-exist.zip"), join(root, "dangling.zip"));
    const got = await walkCandidates(root, {});
    assert.equal(got.files, 1);
    assert.equal(got.readability.entriesStatFailed, 1);
    assert.equal(got.errorCount, 1);
    assert.equal(got.errors[0].op, "stat");
    assert.equal(got.errors[0].code, "ENOENT");
    assert.equal(got.complete, false, "有读取错误 ⇒ 不得据此判缺");
    assert.deepEqual(missingWriteGate(got).reasons, ["read_errors:1"]);
  });

  test("根是文件 → readdir 失败记为 ENOTDIR（不掉进空树）", async () => {
    const p = mkFile("err/notdir/a.zip", 10);
    const got = await walkCandidates(p, {});
    assert.equal(got.readability.rootReadable, false);
    assert.equal(got.readability.dirsFailed, 1);
    assert.equal(got.readability.dirsRead, 0);
    assert.equal(got.errorCount, 1);
    assert.equal(got.errors[0].op, "readdir");
    assert.equal(got.errors[0].code, "ENOTDIR");
    assert.equal(got.complete, false);
    assert.deepEqual(missingWriteGate(got).reasons.sort(), ["empty_tree_no_readdir", "root_unreadable", "read_errors:1"].sort());
  });

  test("真实 EACCES（0000 目录）→ readdir 失败入 errors（POSIX；root/Windows 跳过）", async (t) => {
    if (process.platform === "win32") {
      // Windows 权限语义不同：chmod 只改只读位（ACL 模型），0000 目录仍可 readdir，构造不出 EACCES。
      // 产品断言不放宽：该用例在 POSIX 上保持原样；Windows 只用上面的 ENOTDIR 用例覆盖 readdir 失败分支。
      t.skip("Windows 权限语义不同：chmod 0000 不产生 readdir EACCES，此断言只在 POSIX 有意义");
      return;
    }
    const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
    if (isRoot) {
      t.skip("以 root 运行时 CAP_DAC_OVERRIDE 会绕过 0000 目录权限，无法构造真实的 readdir EACCES（该分支与上面的 ENOTDIR 同一代码路径）");
      return;
    }
    const root = mkDir("err/eacces");
    const locked = mkDir("err/eacces/locked");
    mkFile("err/eacces/locked/hidden.zip", 10);
    chmodSync(locked, 0o000);
    try {
      const got = await walkCandidates(root, {});
      assert.equal(got.readability.dirsFailed, 1);
      assert.ok(got.errors.some((e) => e.op === "readdir" && e.code === "EACCES"));
      assert.equal(got.complete, false);
    } finally { chmodSync(locked, 0o755); }
  });
});

describe("walkCandidates：有界批次（onBatch / batchSize）", () => {
  test("逐批回调：批数 = ceil(n/batchSize)、filesOut 为空、累计 stats 单调", async () => {
    const root = mkDir("batch/tree");
    const n = 5;
    for (let i = 0; i < n; i++) mkFile("batch/tree/b" + i + ".zip", 10 + i);
    const batches: { n: number; stats: any }[] = [];
    const got = await walkCandidates(root, {
      batchSize: 2,
      onBatch: (files, stats) => { batches.push({ n: files.length, stats: { ...stats } }); },
    });
    assert.deepEqual(batches.map((b) => b.n), [2, 2, 1], "5 条 / 批 2 → 2+2+1");
    assert.deepEqual(batches.map((b) => b.stats.files), [2, 4, 5], "stats 是累计值");
    assert.equal(got.filesOut.length, 0, "流式模式下 filesOut 必须为空（省内存）");
    assert.equal(got.files, n);
    assert.equal(got.complete, true);
    // 批回调拿到的条目必须是完整 ScannedFile（可被 planFromFiles/registerAssets 直接使用）
    assert.ok(batches.length > 0);
  });

  test("流式与非流式给出的路径顺序完全一致（批大小不影响顺序）", async () => {
    const root = mkDir("batch/order");
    mkFile("batch/order/a.zip", 1); mkFile("batch/order/d1/b.zip", 2); mkFile("batch/order/d1/d2/c.unitypackage", 3); mkFile("batch/order/d3/d.zip", 4);
    const plain = await walkCandidates(root, {});
    const seen: string[] = [];
    const streamed = await walkCandidates(root, { batchSize: 1, onBatch: (files) => { for (const f of files) seen.push(f.path); } });
    assert.deepEqual(seen, plain.filesOut.map((f) => f.path));
    assert.equal(streamed.files, plain.files);
    assert.equal(streamed.dirs, plain.dirs);
  });

  test("同步 onBatch 与 async onBatch 都支持；limit 截断信息出现在最后一批 stats", async () => {
    const root = mkDir("batch/limit");
    for (let i = 0; i < 4; i++) mkFile("batch/limit/x" + i + ".zip", 10);
    const stats: any[] = [];
    const got = await walkCandidates(root, {
      limit: 3, batchSize: 2,
      onBatch: async (files, s) => { stats.push({ n: files.length, truncated: s.truncated }); },
    });
    assert.equal(got.truncated, true);
    assert.deepEqual(stats.map((s) => s.n), [2, 1]);
    assert.equal(stats[stats.length - 1].truncated, true, "收尾批次能看到 truncated=true");
  });
});

describe("walkCandidates：取消（AbortSignal → code=CANCELLED）", () => {
  test("预先中止 → 立刻抛 CANCELLED，不返回半成品", async () => {
    const root = mkDir("cancel/pre");
    mkFile("cancel/pre/a.zip", 10);
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(() => walkCandidates(root, { signal: ac.signal }), (e: any) => e.code === "CANCELLED");
  });

  test("批回调里中止 → 下一批检查点抛 CANCELLED", async () => {
    const root = mkDir("cancel/mid");
    for (let i = 0; i < 6; i++) mkFile("cancel/mid/c" + i + ".zip", 10);
    const ac = new AbortController();
    let batches = 0;
    await assert.rejects(
      () => walkCandidates(root, { batchSize: 2, signal: ac.signal, onBatch: () => { batches++; if (batches === 1) ac.abort(); } }),
      (e: any) => e.code === "CANCELLED",
    );
    assert.equal(batches, 1, "中止后不再回调第二批");
  });

  test("非流式模式的**遍历中途**取消：靠中途让出事件循环（每 2000 个非候选目录项）拿到 abort", async () => {
    const root = mkDir("cancel/plain");
    for (let i = 0; i < 2200; i++) mkFile("cancel/plain/plain" + i + ".txt", 1);
    mkFile("cancel/plain/late.zip", 10);
    const ac = new AbortController();
    // 0ms 定时器只会在 walk 让出事件循环（第 2000 个非候选条目）时才可能触发
    setTimeout(() => ac.abort(), 0);
    await assert.rejects(() => walkCandidates(root, { signal: ac.signal }), (e: any) => e.code === "CANCELLED");
  });
});

describe("scanpreview：流式分类与一次性分类完全等价", () => {
  const scanStats = (files: number) => ({ truncated: false, errorCount: 0, readability: { rootReadable: true, dirsRead: files, dirsFailed: 0, entriesStatFailed: 0 }, errors: [] as any[] });
  test("分批 push 与一次性 push 的 rows/counts 深度相等（含疑似重复提示）", () => {
    const existing = [
      { id: 1, path: "C:\\lib\\old\\dup.zip", path_norm: "c:/lib/old/dup.zip", size: 100, mtime: "2026-01-01T00:00:00.000Z", item_id: 1 },
      { id: 99, path: "C:\\lib\\keep.zip", path_norm: "c:/lib/keep.zip", size: 500, mtime: "2026-01-01T00:00:00.000Z", item_id: 1 },
    ];
    const stub = { presentAssetsUnderPath: () => existing } as any;
    const files: ScannedFile[] = [
      { path: "C:\\lib\\new1.zip", size: 42, mtime: "2026-02-01T00:00:00.000Z", container: "zip", kind: "archive" },
      { path: "C:\\lib\\keep.zip", size: 500, mtime: "2026-01-01T00:00:00.000Z", container: "zip", kind: "archive" },
      { path: "C:\\lib\\old\\dup.zip", size: 100, mtime: "2026-02-02T00:00:00.000Z", container: "zip", kind: "archive" },
      { path: "C:\\lib\\brand-new\\dup.zip", size: 100, mtime: "2026-02-03T00:00:00.000Z", container: "zip", kind: "archive" },
    ];
    const all = classifyPreview(stub, "C:\\lib", files, scanStats(2));
    const c = createPreviewClassifier(stub, "C:\\lib");
    c.push([files[0]]);
    c.push([files[1], files[2]]);
    c.push([files[3]]);
    const chunked = c.finish(scanStats(2));
    assert.deepEqual(chunked.rows, all.rows);
    assert.deepEqual(chunked.counts, all.counts);
    assert.deepEqual(chunked.gate, all.gate);
    // 疑似重复提示：只有"同名 + 同尺寸"的新文件算；matches 顺序仍按「已有资产顺序」
    const dup = chunked.rows.filter((r) => r.change === "duplicate_suspected");
    assert.equal(dup.length, 1);
    assert.equal(dup[0].path, "C:\\lib\\brand-new\\dup.zip");
    assert.deepEqual((dup[0].detail as any).matches, ["C:\\lib\\old\\dup.zip"]);
  });

  test("generateScanPreview：真实库 + 真实临时目录，onProgress 报 walk/classify/commit；进度回调抛错不影响完成", async () => {
    const db = new Database(":memory:"); db.pragma("foreign_keys = ON"); migrate(db);
    const repo = new Repo(db);
    const root = mkDir("preview/gen");
    mkFile("preview/gen/one.zip", 32);
    mkFile("preview/gen/sub/two.zip", 64);
    const preview = repo.createScanPreview({ rootId: null, path: root, deep: false });
    const phases: string[] = [];
    const r = await generateScanPreview(repo, preview.id, () => {}, {
      batchSize: 1,
      onProgress: (p) => { phases.push(p.phase); if (p.phase === "walk") throw new Error("进度回调故意抛错"); },
    });
    assert.equal(r.state, "ready");
    assert.equal(r.counts.new, 2);
    assert.deepEqual([...new Set(phases)], ["walk", "classify", "commit"]);
    const rows = repo.listScanPreviewItems(preview.id, { limit: 10 }).items;
    assert.equal(rows.length, 2);
    assert.ok(repo.getScanPreview(preview.id).plan_hash, "planHash 已写入");
    db.close();
  });
});

// ---------------------------------------------------------------- v0.6.1-A：扫描清单 / 背压闸门 / 提交边界

describe("v0.6.1-A：扫描清单（manifest）与旧 seen 等价", () => {
  test("T1 流式 + manifest：清单集合 == 旧 seen（filesOut）集合，filesOut 为空，顺序一致", async () => {
    const root = mkDir("manifest/eq");
    mkFile("manifest/eq/x.zip", 1);
    mkFile("manifest/eq/sub/y.zip", 2);
    mkFile("manifest/eq/sub/deep/z.unitypackage", 3);
    mkFile("manifest/eq/other.rar", 4);
    mkFile("manifest/eq/plain.txt", 5); // 非候选：不得进清单
    const plain = await walkCandidates(root, {});
    const oldSeen = new Set(plain.filesOut.map((f) => normalizePath(f.path)));
    const m = createMemoryManifest();
    const order: string[] = [];
    const streamed = await walkCandidates(root, {
      batchSize: 2, manifest: m,
      onBatch: (files) => { for (const f of files) order.push(normalizePath(f.path)); },
    });
    assert.equal(streamed.filesOut.length, 0, "流式模式 filesOut 必须为空");
    assert.equal(streamed.manifest, m, "stats 回传同一个清单实例");
    assert.equal(m.size, oldSeen.size);
    for (const p of oldSeen) assert.equal(m.has(p), true, "清单缺条目: " + p);
    assert.deepEqual(order, plain.filesOut.map((f) => normalizePath(f.path)), "清单/批次顺序 == 全量顺序");
  });

  test("T1 非流式 + manifest 也等价；每批只调一次 addMany（批边界记账）", async () => {
    const root = mkDir("manifest/batch");
    for (let i = 0; i < 4; i++) mkFile("manifest/batch/b" + i + ".zip", 10 + i);
    const plain = await walkCandidates(root, {});
    const mem = createMemoryManifest();
    const calls: number[] = [];
    let adds = 0;
    const spy: ScanManifest = {
      add: (p) => { adds++; mem.add(p); },
      addMany: (ps) => { calls.push(ps.length); mem.addMany(ps); },
      get size() { return mem.size; },
      has: (p) => mem.has(p),
    };
    await walkCandidates(root, { batchSize: 2, manifest: spy, onBatch: () => {} });
    assert.deepEqual(calls, [2, 2], "4 条 / 批 2 → 两次 addMany，各 2 条");
    assert.equal(adds, 0, "批模式下不得逐条 add");
    assert.equal(mem.size, plain.filesOut.length);
    // 非流式：同一份清单也能拿到完整集合
    const m2 = createMemoryManifest();
    const full = await walkCandidates(root, { manifest: m2 });
    assert.equal(full.filesOut.length, 4);
    assert.equal(m2.size, 4);
  });

  test("T1 finish 钩子：完整可信才调用；截断（limit）不调用", async () => {
    const root = mkDir("manifest/finish");
    for (let i = 0; i < 3; i++) mkFile("manifest/finish/f" + i + ".zip", 10 + i);
    const done: any[] = [];
    const mem = createMemoryManifest();
    const withFinish: ScanManifest = {
      add: (p) => mem.add(p), addMany: (ps) => mem.addMany(ps), get size() { return mem.size; }, has: (p) => mem.has(p),
      finish: (s) => { done.push(s); },
    };
    const ok = await walkCandidates(root, { manifest: withFinish });
    assert.equal(ok.complete, true);
    assert.deepEqual(done, [{ files: 3, truncated: false, complete: true }]);
    const done2: any[] = [];
    const m2 = createMemoryManifest();
    const truncatedManifest: ScanManifest = {
      add: (p) => m2.add(p), addMany: (ps) => m2.addMany(ps), get size() { return m2.size; }, has: (p) => m2.has(p),
      finish: (s) => { done2.push(s); },
    };
    const cut = await walkCandidates(root, { manifest: truncatedManifest, limit: 2 });
    assert.equal(cut.truncated, true);
    assert.equal(done2.length, 0, "截断的一轮不得通知清单收尾");
  });
});

describe("v0.6.1-A：背压闸门（createBackpressureGate）", () => {
  test("T4 低于/等于 highWater 直接放行（不 sleep）", async () => {
    let sleeps = 0;
    const gate = createBackpressureGate({ depth: () => 2000, highWater: 2000, lowWater: 500, sleep: async () => { sleeps++; } });
    const r = await gate.wait();
    assert.deepEqual({ waited: r.waited, throttled: r.throttled, waitedMs: r.waitedMs, depth: r.depth }, { waited: false, throttled: false, waitedMs: 0, depth: 2000 });
    assert.equal(sleeps, 0);
  });

  test("T4 高于 highWater：轮询到 <= lowWater 才放行（wait 的度量=轮询次数×pollMs）", async () => {
    const depths = [5000, 3000, 400];
    let i = 0;
    const slept: number[] = [];
    const gate = createBackpressureGate({
      depth: () => depths[Math.min(i++, depths.length - 1)],
      highWater: 2000, lowWater: 500, pollMs: 100,
      sleep: async (ms) => { slept.push(ms); },
    });
    const r = await gate.wait();
    assert.equal(r.waited, true);
    assert.equal(r.throttled, false);
    assert.equal(r.depth, 400);
    assert.equal(r.waitedMs, 200);
    assert.deepEqual(slept, [100, 100]);
  });

  test("T4 超 maxWaitMs：放行但 throttled=true（绝不静默卡死）", async () => {
    const slept: number[] = [];
    const gate = createBackpressureGate({
      depth: () => 999999, highWater: 2000, lowWater: 500, pollMs: 100, maxWaitMs: 300,
      sleep: async (ms) => { slept.push(ms); },
    });
    const r = await gate.wait();
    assert.equal(r.throttled, true);
    assert.equal(r.waited, true);
    assert.equal(r.waitedMs, 300);
    assert.equal(slept.length, 3);
    // 反例对照：maxWaitMs=0 表示不限制（由调用方自己保证能解除）；这里仅断言不会立刻 throttled
    const gate2 = createBackpressureGate({ depth: () => 999999, highWater: 2000, lowWater: 500, pollMs: 100, maxWaitMs: 0, sleep: async () => { throw new Error("should not finish"); } });
    await assert.rejects(() => gate2.wait(), /should not finish/);
  });

  test("T4 signal 中止 → CANCELLED（预先中止 / 等待中中止）", async () => {
    const pre = new AbortController(); pre.abort();
    await assert.rejects(
      () => createBackpressureGate({ depth: () => 99999, highWater: 1, lowWater: 0, signal: pre.signal }).wait(),
      (e: any) => e.code === "CANCELLED",
    );
    const mid = new AbortController();
    await assert.rejects(
      () => createBackpressureGate({
        depth: () => 99999, highWater: 1, lowWater: 0, pollMs: 50, signal: mid.signal,
        sleep: async () => { mid.abort(); },
      }).wait(),
      (e: any) => e.code === "CANCELLED",
    );
  });

  test("T4 depth 允许 async / NaN 视为 0", async () => {
    const gate = createBackpressureGate({ depth: async () => 10, highWater: 2000, lowWater: 500 });
    assert.equal((await gate.wait()).waited, false);
    const nan = createBackpressureGate({ depth: () => Number.NaN, highWater: 0, lowWater: 0 });
    const r = await nan.wait();
    assert.equal(r.depth, 0);
    assert.equal(r.waited, false);
  });
});

describe("v0.6.1-A：取消与清单提交边界", () => {
  test("T5 批中途取消：只记已提交批次，未提交批次不写", async () => {
    const root = mkDir("manifest/cancel");
    for (let i = 0; i < 6; i++) mkFile("manifest/cancel/c" + i + ".zip", 10 + i);
    const plain = await walkCandidates(root, {});
    const order = plain.filesOut.map((f) => normalizePath(f.path));
    assert.equal(order.length, 6);
    const m = createMemoryManifest();
    const ac = new AbortController();
    let batches = 0;
    await assert.rejects(
      () => walkCandidates(root, {
        batchSize: 2, manifest: m, signal: ac.signal,
        onBatch: () => { batches++; if (batches === 2) ac.abort(); }, // 第 2 批回调里中止
      }),
      (e: any) => e.code === "CANCELLED",
    );
    assert.equal(batches, 2, "第 2 批已回调（随后中止）");
    assert.equal(m.size, 4, "已提交 2 批 × 2 条；第 3 批未提交不得记账");
    for (const p of order.slice(0, 4)) assert.equal(m.has(p), true);
    for (const p of order.slice(4)) assert.equal(m.has(p), false);
  });

  test("T5 消费方抛错：该批不算提交，清单不记；重放可拿全量（幂等）", async () => {
    const root = mkDir("manifest/throw");
    for (let i = 0; i < 5; i++) mkFile("manifest/throw/t" + i + ".zip", 10 + i);
    const plain = await walkCandidates(root, {});
    const m = createMemoryManifest();
    let batches = 0;
    await assert.rejects(
      () => walkCandidates(root, { batchSize: 2, manifest: m, onBatch: () => { if (++batches === 2) throw new Error("consumer failed"); } }),
      /consumer failed/,
    );
    assert.equal(m.size, 2, "只有第 1 批提交成功");
    // 重放（模拟 job retry）：新的清单能拿到完整集合
    const m2 = createMemoryManifest();
    const replay = await walkCandidates(root, { batchSize: 2, manifest: m2, onBatch: () => {} });
    assert.equal(replay.files, plain.files);
    assert.equal(m2.size, plain.filesOut.length);
  });
});

describe("v0.6.1-A A4：预览 limit 是 opt-in（默认不改变旧行为）", () => {
  const scanJson = (repo: Repo, id: number): any => JSON.parse(repo.getScanPreview(id).scan_json ?? "{}");
  test("不传 limit：scan_json 不含 limit 键、state=ready；传 limit 且截断：partial + limitNote", async () => {
    const db = new Database(":memory:"); db.pragma("foreign_keys = ON"); migrate(db);
    const repo = new Repo(db);
    const a = mkDir("preview/optin-a"); mkFile("preview/optin-a/1.zip", 1); mkFile("preview/optin-a/2.zip", 2);
    const pa = repo.createScanPreview({ rootId: null, path: a, deep: false });
    const ra = await generateScanPreview(repo, pa.id, () => {});
    assert.equal(ra.state, "ready");
    assert.equal("limit" in scanJson(repo, pa.id), false, "默认不写 limit 键（旧行为）");

    const b = mkDir("preview/optin-b");
    for (let i = 0; i < 3; i++) mkFile("preview/optin-b/p" + i + ".zip", 10 + i);
    const pb = repo.createScanPreview({ rootId: null, path: b, deep: false });
    const rb = await generateScanPreview(repo, pb.id, () => {}, { limit: 2 });
    assert.equal(rb.state, "partial");
    assert.equal(rb.counts.total, 2);
    const sj = scanJson(repo, pb.id);
    assert.equal(sj.limit, 2);
    assert.equal(typeof sj.limitNote, "string");
    assert.match(sj.limitNote, /仅扫描了前 2 个候选/);
    assert.equal(repo.getScanPreview(pb.id).truncated, 1);
    db.close();
  });
});
