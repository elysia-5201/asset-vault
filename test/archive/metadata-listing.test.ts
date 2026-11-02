/**
 * 归档「元数据枚举」与「内容读取预算」分离（新仪器，RED→GREEN）
 *
 * 真实缺陷（archive-proof §4）：ZIP 目录枚举把「声明解压字节合计」当内容读取预算预扣，
 * 第 7 条的 400,748,487 字节使累计超 512 MiB → 后续 26 条（含唯一 unitypackage）被截掉；
 * 且先到的单条 64 MiB 标记覆盖了真正的停止原因，/tree 也不暴露截断。
 *
 * 本文件只测 core 契约（不碰生产库/真实归档）：
 *  1) 旧默认 strict 语义不变：声明字节预算仍会截断（既有契约保留）
 *  2) opt-in metadata 模式：ZIP 中央目录枚举不受声明解压字节预算限制，能列全
 *  3) metadata 模式仍执行 maxEntries / 路径安全 / 中央目录字节上限
 *  4) 停止原因不被先前 flag 覆盖；flag 单独可查
 *  5) 内容读取（readArchiveEntry）预算不放宽
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listArchive, readArchiveEntry } from "../../packages/core/src/archive/list";
import { LimitError } from "../../packages/core/src/limits";
import { buildZip } from "../../packages/core/test/content/fixtures";

const MiB = 1024 * 1024;
let dir: string;
let zip: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "av-meta-listing-"));
  zip = join(dir, "sample.zip");
  writeFileSync(zip, buildZip([
    { name: "a.txt", data: Buffer.alloc(1024, 0x61) },
    { name: "big.psd", data: Buffer.alloc(2 * MiB, 0) },   // 2 MiB > maxEntryBytes(1 MiB)：只标记
    { name: "big2.psd", data: Buffer.alloc(2 * MiB, 0) },  // 加入后 4 MiB+1KiB > 3 MiB：停止
    { name: "pkg/pack.unitypackage", data: Buffer.alloc(2048, 0x62) },
  ]));
});
after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

const LIMITS = { maxEntries: 20000, maxEntryBytes: 1 * MiB, maxTotalBytes: 3 * MiB };

describe("1) strict 默认契约不变", () => {
  test("声明字节预算仍截断（旧 core listArchive 行为保留）", async () => {
    const l = await listArchive(zip, LIMITS);
    assert.equal(l.truncated, true);
    assert.deepEqual(l.entries.map((e) => e.path), ["a.txt", "big.psd"]);
    assert.equal(l.stoppedReason?.code, "BYTES");
    assert.match(String(l.stoppedReason?.message), /maxTotalBytes/);
    assert.equal(l.mode, "strict");
  });

  test("先 flag 后 stop：limited 必须是真正停止原因（不能被首个 flag 顶掉）", async () => {
    const l = await listArchive(zip, LIMITS);
    assert.equal(l.flags.length >= 1, true, "big.psd 的超单条上限应记入 flags");
    assert.match(String(l.flags[0]?.message), /maxEntryBytes/);
    assert.match(String(l.limited?.message), /maxTotalBytes/, "limited 兼容字段也应给停止原因");
  });
});

describe("2) opt-in metadata 模式：只列目录不预扣内容预算", () => {
  test("列全中央目录（含大 PSD 之后的 unitypackage），complete=true", async () => {
    const l = await listArchive(zip, { ...LIMITS, metadataOnly: true });
    assert.equal(l.mode, "metadata");
    assert.deepEqual(l.entries.map((e) => e.path), ["a.txt", "big.psd", "big2.psd", "pkg/pack.unitypackage"]);
    assert.equal(l.truncated, false);
    assert.equal(l.complete, true);
    assert.equal(l.stoppedReason, null);
    assert.equal(l.entries.filter((e) => e.path.endsWith(".unitypackage")).length, 1);
  });

  test("单条超限仍作为 flag 记录（目录完整 ≠ 文件都能解压）", async () => {
    const l = await listArchive(zip, { ...LIMITS, metadataOnly: true });
    assert.equal(l.flags.length >= 1, true);
    assert.equal(l.flags.some((f) => /maxEntryBytes/.test(f.message)), true);
    assert.equal(l.contentReadLimited, true);
  });

  test("maxEntries 在 metadata 模式仍生效并诚实标 truncated", async () => {
    const l = await listArchive(zip, { ...LIMITS, metadataOnly: true, maxEntries: 2 });
    assert.equal(l.entries.length, 2);
    assert.equal(l.truncated, true);
    assert.equal(l.complete, false);
    assert.equal(l.stoppedReason?.code, "ENTRIES");
  });
});

describe("3) 安全边界不因 metadata 模式放宽", () => {
  test("中央目录字节上限仍约束元数据读取", async () => {
    const l = await listArchive(zip, { ...LIMITS, metadataOnly: true, maxMetadataBytes: 64 });
    assert.equal(l.truncated, true);
    assert.equal(l.complete, false);
    assert.equal(l.stoppedReason?.code, "BYTES");
    assert.match(String(l.stoppedReason?.message), /central directory|metadata/i);
  });

  test("路径穿越条目被跳过（不因放宽预算而进入目录）", async () => {
    const evil = join(dir, "evil.zip");
    writeFileSync(evil, buildZip([
      { name: "ok.txt", data: Buffer.alloc(16, 0x6f) },
      { name: "../escape.txt", data: Buffer.alloc(16, 0x78) },
    ]));
    const l = await listArchive(evil, { ...LIMITS, metadataOnly: true });
    assert.equal(l.entries.some((e) => String(e.path).includes("..")), false);
    assert.equal(l.entries.some((e) => e.path === "ok.txt"), true);
  });

  test("内容读取预算未放宽：超大条目仍抛 LimitError(BYTES)", async () => {
    await assert.rejects(
      () => readArchiveEntry(zip, "big.psd", 1 * MiB),
      (err: unknown) => err instanceof LimitError && String((err as any).code) === "BYTES",
    );
  });
});
