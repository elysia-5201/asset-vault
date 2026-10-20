/**
 * v0.6.0 冻结契约测试（core-content 所有）：取消 / 超时 / 上限 / 安全路径 / 解析器版本
 *
 * 覆盖 lead 契约 m00344 的每一条导出：
 *   hash.sha256FileChunked({signal,chunkSize,onProgress})
 *   archive.list.{ARCHIVE_PARSER_VERSION, safeEntryPath, listArchive(opts), readArchiveEntry(opts)}
 *   unitypackage.{UNITYPACKAGE_PARSER_VERSION, listUnityPackage(opts), readUnityPackagePreview(opts)}
 *   images.{probeImage(opts), makeThumbnail(opts)}
 *
 * 纪律：每条断言都有"正例 + 反例"或"独立对照"，不做"没抛异常就算过"的度量。
 * 真实样本用例在缺样本时 SKIP（AV_SAMPLES_DIR 未设时仓库不带本机路径）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { AppError } from "../../src/contracts";
import { ARCHIVE_PARSER_VERSION, listArchive, readArchiveEntry, safeEntryPath } from "../../src/archive/list";
import { UNITYPACKAGE_PARSER_VERSION, listUnityPackage, readUnityPackagePreview } from "../../src/unitypackage";
import { HASH_VERSION, sha256File, sha256FileChunked } from "../../src/hash";
import { makeThumbnail, probeImage } from "../../src/images";
import { SAMPLES, buildZip, cleanup, has, PNG_1x1, tmpDir } from "./fixtures";

// ---------------------------------------------------------------- 解析器版本

test("解析器版本导出：HASH/ARCHIVE/UNITYPACKAGE 都是 2（缓存键依赖它，改动必须 +1）", () => {
  assert.equal(HASH_VERSION, 2);
  assert.equal(ARCHIVE_PARSER_VERSION, 2);
  assert.equal(UNITYPACKAGE_PARSER_VERSION, 2);
});

// ---------------------------------------------------------------- safeEntryPath

test("safeEntryPath: 正例原样返回；绝对路径/盘符/UNC/../NUL/空名 全部拒绝（含理由）", () => {
  // 正例：相对路径、反斜杠归一化、目录尾斜杠去掉、带空格/中文/点号的文件名
  assert.deepEqual(safeEntryPath("Assets/Textures/a.png"), { ok: true, path: "Assets/Textures/a.png" });
  assert.deepEqual(safeEntryPath("Assets\\Textures\\a.png"), { ok: true, path: "Assets/Textures/a.png" });
  assert.deepEqual(safeEntryPath("Assets/Textures/"), { ok: true, path: "Assets/Textures" });
  assert.deepEqual(safeEntryPath("根 目录/测试 文件.txt"), { ok: true, path: "根 目录/测试 文件.txt" });
  assert.deepEqual(safeEntryPath("a/./b.txt"), { ok: true, path: "a/./b.txt" });
  assert.deepEqual(safeEntryPath("a..b/c..d.txt"), { ok: true, path: "a..b/c..d.txt" });

  // 反例：逐个判定 + 理由必须说清楚（不能只返回 false）
  const bad: Array<[string, RegExp]> = [
    ["/etc/passwd", /absolute/i],
    ["C:\\Windows\\system32\\evil.dll", /drive|absolute/i],
    ["C:/x/y.txt", /drive/i],
    ["\\\\server\\share\\x.txt", /UNC/i],
    ["//server/share/x.txt", /UNC/i],
    ["../../etc/passwd", /parent traversal/i],
    ["a/../../b.txt", /parent traversal/i],
    ["a\\..\\b.txt", /parent traversal/i],
    ["a\u0000b.txt", /NUL/i],
    ["", /empty/i],
    ["/", /absolute|empty/i], // 单根斜杠先命中「绝对路径」分支
  ];
  for (const [input, re] of bad) {
    const r = safeEntryPath(input);
    assert.equal(r.ok, false, `应拒绝: ${JSON.stringify(input)}`);
    if (!r.ok) assert.match(r.reason, re, `理由不合理: ${input} -> ${r.reason}`);
  }
});

// ---------------------------------------------------------------- sha256FileChunked

test("sha256FileChunked: 分块哈希 == sha256File，progress 递增且末次 bytes==total==文件大小", async () => {
  const dir = tmpDir("hash-chunk");
  try {
    const f = join(dir, "blob.bin");
    const size = 100 * 1024;
    const buf = Buffer.alloc(size);
    for (let i = 0; i < size; i++) buf[i] = (i * 31) & 0xff;
    writeFileSync(f, buf);

    const calls: Array<[number, number | null]> = [];
    const r = await sha256FileChunked(f, { chunkSize: 4096, onProgress: (b, t) => calls.push([b, t]) });
    assert.equal(r.sha256, await sha256File(f)); // 与既有实现（同算法）一致
    assert.equal(r.bytes, size);
    assert.equal(r.streamed, true);
    assert.equal(calls.length, Math.ceil(size / 4096), "chunkSize 应生效（每块一次回调）");
    assert.equal(calls[0]![0], 4096);
    assert.equal(calls[calls.length - 1]![0], size);
    assert.equal(calls[calls.length - 1]![1], size, "total 应是 stat 的大小");
  } finally { cleanup(dir); }
});

test("sha256FileChunked: 预取消 signal → code=CANCELLED/409；不存在 → NOT_FOUND；非法 chunkSize → INVALID_INPUT", async () => {
  const dir = tmpDir("hash-cancel");
  try {
    const f = join(dir, "x.bin");
    writeFileSync(f, Buffer.alloc(2048, 7));
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(() => sha256FileChunked(f, { signal: ac.signal }), (err: any) => err instanceof AppError && err.code === "CANCELLED" && err.status === 409);
    await assert.rejects(() => sha256FileChunked(join(dir, "missing.bin")), (err: any) => err instanceof AppError && err.code === "NOT_FOUND");
    await assert.rejects(() => sha256FileChunked(f, { chunkSize: 1 }), (err: any) => err instanceof AppError && err.code === "INVALID_INPUT");
  } finally { cleanup(dir); }
});

test("sha256FileChunked: 31MB 文件上 timeoutMs=1 → code=TIMEOUT/408（可判别，不是 ENOENT/裸错误）", async (t) => {
  if (!has(SAMPLES.unitypackage)) return t.skip("sample unitypackage missing");
  await assert.rejects(
    () => sha256FileChunked(SAMPLES.unitypackage, { timeoutMs: 1 }),
    (err: any) => err instanceof AppError && err.code === "TIMEOUT" && err.status === 408,
  );
});

// ---------------------------------------------------------------- listArchive 上限

function makeLimitZip(): Buffer {
  return buildZip([
    { name: "a.txt", data: Buffer.from("hello") },
    { name: "b.bin", data: Buffer.alloc(5000, 0), method: "deflate" }, // 高压缩比（5000:≈20）
    { name: "c.txt", data: Buffer.from("world") },
  ]);
}

test("listArchive: 无上限 → limited=null / bytesListed=声明字节合计（旧调用行为不变）", async () => {
  const dir = tmpDir("lim-none");
  try {
    const f = join(dir, "plain.zip");
    writeFileSync(f, makeLimitZip());
    const l = await listArchive(f);
    assert.equal(l.limited, null);
    assert.equal(l.truncated, false);
    assert.equal(l.entries.length, 3);
    assert.equal(l.bytesListed, l.entries.reduce((n, e) => n + e.size, 0));
    // 冻结字段仍在（向后兼容）
    for (const k of ["container", "entries", "truncated", "passwordProtected"]) assert.ok(k in l, `缺字段 ${k}`);
    assert.equal(await readArchiveEntry(f, "a.txt").then((b) => b.toString()), "hello");
  } finally { cleanup(dir); }
});

test("listArchive: maxEntries 截断 → limited.code=ENTRIES；maxTotalBytes → BYTES（早停）", async () => {
  const dir = tmpDir("lim-caps");
  try {
    const f = join(dir, "caps.zip");
    writeFileSync(f, makeLimitZip());

    const byCount = await listArchive(f, { maxEntries: 2 });
    assert.equal(byCount.entries.length, 2);
    assert.equal(byCount.truncated, true);
    assert.equal(byCount.limited?.code, "ENTRIES");

    const byBytes = await listArchive(f, { maxTotalBytes: 100 });
    assert.equal(byBytes.limited?.code, "BYTES");
    assert.equal(byBytes.truncated, true);
    assert.ok(byBytes.entries.length < 3, "超总预算应立即停止，而不是列完再截断");
    assert.ok(byBytes.bytesListed <= 100);

    // 单条过大：只标记不停（目录要完整）
    const byEntry = await listArchive(f, { maxEntryBytes: 1000 });
    assert.equal(byEntry.limited?.code, "BYTES");
    assert.equal(byEntry.truncated, false);
    assert.equal(byEntry.entries.length, 3);
  } finally { cleanup(dir); }
});

test("listArchive: maxCompressionRatio 命中 → limited.code=RATIO（5000:≈20 的条目）", async () => {
  const dir = tmpDir("lim-ratio");
  try {
    const f = join(dir, "bomb.zip");
    writeFileSync(f, makeLimitZip());
    const l = await listArchive(f, { maxCompressionRatio: 50 });
    assert.equal(l.limited?.code, "RATIO");
    assert.match(String(l.limited?.message), /ratio/i);
    assert.equal(l.entries.length, 3, "压缩比异常不应丢掉目录项");
  } finally { cleanup(dir); }
});

test("listArchive: 预取消 signal → limited.code=CANCELLED（不抛，可降级）", async () => {
  const dir = tmpDir("lim-cancel");
  try {
    const f = join(dir, "c.zip");
    writeFileSync(f, makeLimitZip());
    const ac = new AbortController();
    ac.abort();
    const l = await listArchive(f, { signal: ac.signal });
    assert.equal(l.limited?.code, "CANCELLED");
    assert.equal(l.truncated, true);
    assert.equal(l.entries.length, 0);
  } finally { cleanup(dir); }
});

test("readArchiveEntry: 预取消 → CANCELLED/409；超上限 → BYTES；坏参数 → INVALID_INPUT", async () => {
  const dir = tmpDir("read-opts");
  try {
    const f = join(dir, "r.zip");
    writeFileSync(f, makeLimitZip());
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(() => readArchiveEntry(f, "a.txt", 1024, { signal: ac.signal }), (err: any) => err instanceof AppError && err.code === "CANCELLED" && err.status === 409);
    await assert.rejects(() => readArchiveEntry(f, "b.bin", 100), (err: any) => err instanceof AppError && err.code === "BYTES");
    await assert.rejects(() => readArchiveEntry(f, "a.txt", 0), (err: any) => err instanceof AppError && err.code === "INVALID_INPUT");
  } finally { cleanup(dir); }
});

// ---------------------------------------------------------------- unitypackage 上限

test("listUnityPackage: 预取消 → limited.code=CANCELLED；maxTotalBytes 预算生效（bytesRead 受限）", async (t) => {
  if (!has(SAMPLES.unitypackage)) return t.skip("sample unitypackage missing");
  const ac = new AbortController();
  ac.abort();
  const cancelled = await listUnityPackage(SAMPLES.unitypackage, { signal: ac.signal });
  assert.equal(cancelled.limited?.code, "CANCELLED");
  assert.equal(cancelled.truncated, true);
  assert.equal(cancelled.assets.length, 0);

  const full = await listUnityPackage(SAMPLES.unitypackage);
  const budget = await listUnityPackage(SAMPLES.unitypackage, { maxTotalBytes: 4 * 1024 * 1024 });
  assert.equal(budget.limited?.code, "BYTES");
  assert.equal(budget.truncated, true);
  assert.ok(budget.bytesRead <= 8 * 1024 * 1024, `bytesRead 应受预算约束，实际 ${budget.bytesRead}`);
  assert.ok(budget.bytesRead < full.bytesRead / 4, "预算命中时不应读完整个包");
});

test("listUnityPackage: maxAssets=1 真早停（bytesRead 远小于读完）——修复审计发现「maxAssets 不省 IO」", async (t) => {
  if (!has(SAMPLES.unitypackage)) return t.skip("sample unitypackage missing");
  const full = await listUnityPackage(SAMPLES.unitypackage, { maxAssets: 20000 });
  const cut = await listUnityPackage(SAMPLES.unitypackage, { maxAssets: 1 });
  assert.equal(cut.assets.length, 1);
  assert.equal(cut.truncated, true);
  assert.equal(cut.limited?.code, "ENTRIES");
  assert.ok(cut.bytesRead < full.bytesRead / 2, `早停应显著减少读取：cut=${cut.bytesRead} full=${full.bytesRead}`);
});

test("readUnityPackagePreview: maxBytes 上限 → BYTES；预取消 → CANCELLED", async (t) => {
  if (!has(SAMPLES.unitypackage)) return t.skip("sample unitypackage missing");
  const listing = await listUnityPackage(SAMPLES.unitypackage);
  const withPreview = listing.assets.find((a) => a.hasPreview);
  assert.ok(withPreview, "样本里应有 preview");
  const guid = withPreview!.guid;

  const full = await readUnityPackagePreview(SAMPLES.unitypackage, guid);
  assert.ok(full && full.length > 0);
  await assert.rejects(() => readUnityPackagePreview(SAMPLES.unitypackage, guid, { maxBytes: 8 }), (err: any) => err instanceof AppError && err.code === "BYTES");

  const ac = new AbortController();
  ac.abort();
  await assert.rejects(() => readUnityPackagePreview(SAMPLES.unitypackage, guid, { signal: ac.signal }), (err: any) => err instanceof AppError && err.code === "CANCELLED");
});

// ---------------------------------------------------------------- images 上限

async function makePng(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 10, g: 120, b: 200 } } }).png().toBuffer();
}

test("probeImage: maxPixels 命中 → LimitError PIXELS（不是静默放过）", async () => {
  const png = await makePng(200, 100); // 20000 像素
  const ok = await probeImage(png, { maxPixels: 1_000_000 });
  assert.deepEqual(ok, { width: 200, height: 100, format: "png" });
  await assert.rejects(() => probeImage(png, { maxPixels: 1000 }), (err: any) => err instanceof AppError && err.code === "PIXELS");
});

test("makeThumbnail: png 输出魔数 89504e47；limitInputPixels 太小 → PIXELS；quality 越界 → INVALID_INPUT", async () => {
  const png = await makePng(120, 60);
  const out = await makeThumbnail(png, { maxSize: 32, format: "png" });
  assert.equal(out.format, "png");
  assert.deepEqual(Array.from(out.data.subarray(0, 4)), [0x89, 0x50, 0x4e, 0x47]);
  assert.ok(out.width <= 32 && out.height <= 32 && out.width > 0);

  await assert.rejects(() => makeThumbnail(png, { maxSize: 32, limitInputPixels: 100 }), (err: any) => err instanceof AppError && err.code === "PIXELS");
  await assert.rejects(() => makeThumbnail(png, { maxSize: 32, quality: 300 }), (err: any) => err instanceof AppError && err.code === "INVALID_INPUT");
});

test("makeThumbnail: 预取消 signal → CANCELLED（sharp 不可中断时的 race 生效）", async () => {
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    () => makeThumbnail(PNG_1x1, { maxSize: 16, signal: ac.signal }),
    (err: any) => err instanceof AppError && err.code === "CANCELLED",
  );
});
