/**
 * v0.6.1-B 缓存身份安全（core-content / task-10）
 *
 * 审计结论的回归测试：weak(size:mtime) 不得冒充内容身份。
 * 场景（对 task-10 的 8 条 + F4 回归）：
 *  1) 跨资产同 size+mtime 不同内容 → 不再共键（F1 回归）
 *  2) 移动/改名 → 弱身份不共用；强身份（sha）同内容可共用
 *  3) 排队期间替换 / 陈旧 sha → 不再走强身份键（F3 回归）
 *  4) 哈希期间文件变化 → 不写 ok（E 回归）
 *  5) 解析器版本变化 → 键变、不命中
 *  6) limitsHash 变化（含 upkg 预算）→ 不命中（F6 回归）
 *  7) 缓存损坏 → 丢弃重算
 *  8) 两资产同内容（强身份）→ 共享一次解析（不过度限域）
 *  +) 命中时 content_sha 不符 → drop + 重算（F4 回归）
 *  +) weak 元数据写入不因 v6 列未迁移而阻塞（F5）
 *
 * 实现：真实 schema 临时库 + 真实 Repo/DerivedCache + 真实 stage 函数（无桩替身）；
 *       压缩包用 fixtures.buildZip / buildTarGz 合成（内容、大小、mtime 完全可控）。
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { closeSync, ftruncateSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, statSync, truncateSync, utimesSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTempDb, addItem, addRoot, type TempDb } from "../schema/_db";
import { Repo } from "../../apps/server/src/db/repo";
import { DerivedCache, cacheKey, type CacheLike } from "../../apps/server/src/services/pipeline/cache";
import { contentIdentity, contentSample, stageArchive, stageHash, stageUnityPackage, type LiveStat, type StageCtx } from "../../apps/server/src/services/pipeline/stages";
import { DEFAULT_LIMITS, type PipelineLimits } from "../../apps/server/src/services/pipeline/limits";
import { buildTarGz, buildZip } from "../../packages/core/test/content/fixtures";
import { ARCHIVE_PARSER_VERSION } from "../../packages/core/src/archive/list";
import type { AssetRow } from "../../packages/core/src/contracts";
import type { MediaStore } from "../../apps/server/src/services/media";

// cp -p 的跨平台等价：就地截断+写入同一文件（inode 不变），再恢复 mtime。
// Windows 无 cp；直接 spawnSync("cp") 会 ENOENT。
function overwriteInPlace(src: string, dst: string): void {
  const data = readFileSync(src);
  const fd = openSync(dst, "r+");
  try {
    ftruncateSync(fd, 0);
    writeSync(fd, data, 0, data.length, 0);
  } finally {
    closeSync(fd);
  }
  const st = statSync(src);
  utimesSync(dst, st.atime, st.mtime);
}

let t: TempDb;
let repo: Repo;
let cache: DerivedCache;
let cacheRoot: string;
let work: string;
let itemId: number;
let rootId: number;

beforeEach(() => {
  t = openTempDb();
  repo = new Repo(t.db);
  cacheRoot = mkdtempSync(join(tmpdir(), "av-cache-id-"));
  cache = new DerivedCache(cacheRoot, repo, () => {});
  work = mkdtempSync(join(tmpdir(), "av-fixture-"));
  itemId = addItem(t.db, { title: "t" });
  rootId = addRoot(t.db, "/lib");
});
afterEach(() => {
  rmSync(cacheRoot, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
  t.close();
});

// ---------------------------------------------------------------- helpers

const liveOf = (p: string): LiveStat => {
  const st = statSync(p);
  return { size: st.size, mtimeMs: st.mtimeMs, ino: Number(st.ino), dev: Number(st.dev) };
};

/** 建立资产行（用 repo 的真实 upsert：size/mtime 取磁盘现状）。 */
function register(path: string, o: { container?: "zip" | "unitypackage"; sha?: string | null; rowSize?: number; rowMtime?: string } = {}): AssetRow {
  const st = statSync(path);
  const { asset } = repo.upsertAsset({
    item_id: itemId, kind: "archive", container: o.container ?? "zip",
    path, path_norm: path.toLowerCase(), root_id: rootId,
    size: o.rowSize ?? st.size, mtime: o.rowMtime ?? st.mtime.toISOString(), discovered_by: "scan",
  });
  if (o.sha) repo.setAssetSha(asset.id, o.sha, "ok");
  return repo.getAsset(asset.id)!;
}

function makeCtx(limits: Partial<PipelineLimits> = {}, onProgress?: (p: { bytesDone?: number }) => void): StageCtx {
  return {
    repo,
    media: {} as unknown as MediaStore,
    cache,
    limits: { ...DEFAULT_LIMITS, maxArchiveBytes: 0, ...limits },
    log: () => {},
    signal: new AbortController().signal,
    progress: (p) => onProgress?.(p),
  };
}

const archiveLimitsHash = (l: PipelineLimits) => cacheKey({ kind: "limits", identity: "l", versionKey: "", extra: {
  maxEntries: l.maxArchiveEntries, maxEntryBytes: l.maxEntryBytes,
  maxTotalReadBytes: l.maxTotalReadBytes, maxCompressionRatio: l.maxCompressionRatio,
} });

/** v0.6.2/FIX-05 起 cacheKey.extra.sample 参与归档缓存键，测试必须用同口径复算。 */
const archiveKey = (identity: string, container: string, l: PipelineLimits, sample: string | null) => cacheKey({
  kind: "archive-listing", identity, versionKey: "archive:" + container + ":v" + ARCHIVE_PARSER_VERSION,
  limitsHash: archiveLimitsHash(l), extra: { sample: sample ?? "unreadable" },
});

/** 按 stages 的真实口径取采样（测试与实现共用 contentSample，避免两套算法漂移）。 */
const sampleOf = async (file: string): Promise<string | null> => contentSample(file, statSync(file).size);

/** 两个"内容不同、字节数相同"的 zip（文件名等长 → 总长一致）。 */
function twinZips(): { a: string; b: string; at: Date } {
  const a = join(work, "A.zip");
  const b = join(work, "B.zip");
  writeFileSync(a, buildZip([{ name: "a1.txt", data: Buffer.alloc(100, 0x61) }]));
  writeFileSync(b, buildZip([{ name: "b1.txt", data: Buffer.alloc(100, 0x62) }]));
  const at = new Date("2026-03-04T05:06:07.890Z");
  utimesSync(a, at, at);
  utimesSync(b, at, at);
  return { a, b, at };
}

// ---------------------------------------------------------------- 1) 跨资产撞键（F1）

describe("场景1：两个不同资产同 size+mtime → 不共键、不互相复用目录", () => {
  test("A/B 内容不同但字节数与 mtime 相同：B 必须真解析，不能吃 A 的缓存", async () => {
    const { a, b } = twinZips();
    assert.equal(statSync(a).size, statSync(b).size, "前置：两个包字节数必须相同");
    assert.equal(statSync(a).mtimeMs, statSync(b).mtimeMs, "前置：mtime 必须相同");

    const ra = register(a);
    const rb = register(b);
    const ia = contentIdentity(ra, liveOf(a));
    const ib = contentIdentity(rb, liveOf(b));
    assert.equal(ia.weak, true);
    assert.equal(ib.weak, true);
    assert.notEqual(ia.identity, ib.identity, "弱身份必须含 assetId/path_norm，不能撞键");

    const first = await stageArchive(makeCtx(), ra);
    assert.match(String(first.note), /entries=/, "首次必须真解析");

    const second = await stageArchive(makeCtx(), rb);
    assert.doesNotMatch(String(second.note), /cache hit/, "不同资产绝不能命中对方的弱键");
    assert.deepEqual(repo.getArchiveEntries(ra.id).map((e: any) => e.path), ["a1.txt"]);
    assert.deepEqual(repo.getArchiveEntries(rb.id).map((e: any) => e.path), ["b1.txt"]);
  });
});

// ---------------------------------------------------------------- 2) 移动/改名

describe("场景2：移动/改名", () => {
  test("弱身份：同内容换路径 → 键变（重新解析），不会拿旧路径条目", async () => {
    const { a } = twinZips();
    const ra = register(a);
    await stageArchive(makeCtx(), ra);
    const moved = join(work, "moved.zip");
    writeFileSync(moved, buildZip([{ name: "a1.txt", data: Buffer.alloc(100, 0x61) }]));
    const st = statSync(a);
    utimesSync(moved, new Date(st.mtimeMs), new Date(st.mtimeMs));
    const rm = register(moved);
    const r = await stageArchive(makeCtx(), rm);
    assert.doesNotMatch(String(r.note), /cache hit/);
    assert.deepEqual(repo.getArchiveEntries(rm.id).map((e: any) => e.path), ["a1.txt"]);
  });

  test("强身份：同内容不同路径可共享（sha 一致 → 一次解析，两边都正确）", async () => {
    // 必须是**真正同内容**（FIX-05 起 sample 参与键：同 sha 但字节不同会 miss，这是正确的防御）
    const { a } = twinZips();
    const b = join(work, "A-copy.zip");
    writeFileSync(b, buildZip([{ name: "a1.txt", data: Buffer.alloc(100, 0x61) }]));
    const sha = "a".repeat(64);
    const ra = register(a, { sha });
    const rb = register(b, { sha });
    const r1 = await stageArchive(makeCtx(), ra);
    assert.doesNotMatch(String(r1.note), /cache hit/);
    const r2 = await stageArchive(makeCtx(), rb);
    assert.match(String(r2.note), /cache hit/, "同 sha 应共享缓存");
    assert.deepEqual(repo.getArchiveEntries(rb.id).map((e: any) => e.path), ["a1.txt"], "共享的条目来自真实解析结果");
  });
});

// ---------------------------------------------------------------- 3) 陈旧 sha / 排队期间替换（F3）

describe("场景3：DB 行 sha 陈旧（文件已被替换）→ 不得走强身份键", () => {
  test("live 与行不一致 → identity 降级 weak；旧 sha 键里的脏条目不会被用", async () => {
    const { a } = twinZips();
    const staleSha = "c".repeat(64);
    // 行里写一个"看起来 ok 但和磁盘不一致"的 sha + 错误尺寸
    const ra = register(a, { sha: staleSha, rowSize: 12345, rowMtime: "2020-01-01T00:00:00.000Z" });
    const live = liveOf(a);
    const id = contentIdentity(ra, live);
    assert.equal(id.weak, true, "磁盘与行不一致时必须降级为弱身份");
    assert.notEqual(id.identity, "sha256:" + staleSha);

    // 在"旧强键"下埋一条错误目录：若实现仍按旧 sha 走强键，就会命中这条
    const limits = { ...DEFAULT_LIMITS, maxArchiveBytes: 0 };
    const strongKey = archiveKey("sha256:" + staleSha, "zip", limits, await sampleOf(a));
    await cache.put("archive-listing", strongKey, { entries: [{ path: "WRONG.txt", size: 1, isDir: false }], limited: null, passwordProtected: false, truncated: false }, { kind: "archive-listing", contentSha: staleSha, versionKey: "archive:zip:v" + ARCHIVE_PARSER_VERSION });

    const r = await stageArchive(makeCtx(), ra);
    assert.doesNotMatch(String(r.note), /cache hit/);
    assert.deepEqual(repo.getArchiveEntries(ra.id).map((e: any) => e.path), ["a1.txt"]);
  });

  test("同一资产名下换文件（size 变）→ 弱身份不同 → 不命中", async () => {
    const f = join(work, "swap.zip");
    writeFileSync(f, buildZip([{ name: "old.txt", data: Buffer.alloc(100, 1) }]));
    const ra = register(f);
    await stageArchive(makeCtx(), ra);
    // 换成另一个包（size 不同），行仍是旧 size/mtime（排队期间被替换）
    writeFileSync(f, buildZip([{ name: "new.txt", data: Buffer.alloc(400, 2) }]));
    const r = await stageArchive(makeCtx(), ra);
    assert.doesNotMatch(String(r.note), /cache hit/);
    assert.deepEqual(repo.getArchiveEntries(ra.id).map((e: any) => e.path), ["new.txt"]);
  });
});

// ---------------------------------------------------------------- 4) 哈希期间文件变化

describe("场景4：哈希期间文件被改写", () => {
  test("解析中改动文件 → 不写 sha=ok，返回 skipped，sha256 置空", async () => {
    const f = join(work, "big.bin");
    writeFileSync(f, Buffer.alloc(8 * 1024 * 1024, 0x5a));
    const ra = register(f);
    let changed = false;
    const ctx = makeCtx({}, () => {
      if (changed) return;
      changed = true;
      writeFileSync(f, Buffer.alloc(1024, 1)); // 原地截断（同 inode，size 变）
    });
    const r = await stageHash(ctx, ra);
    assert.equal(r.skipped, "file changed during hash");
    const row = repo.getAsset(ra.id)!;
    assert.equal(row.sha256, null);
    assert.equal(row.sha256_state, "error");
  });

  test("正例对照：文件不变 → 写入 64 位 hex 且 state=ok", async () => {
    const f = join(work, "stable.bin");
    writeFileSync(f, Buffer.alloc(1024 * 1024, 0x11));
    const ra = register(f);
    const r = await stageHash(makeCtx(), ra);
    assert.equal(r.skipped, undefined);
    const row = repo.getAsset(ra.id)!;
    assert.equal(row.sha256_state, "ok");
    assert.match(String(row.sha256), /^[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------- 5) 解析器版本

describe("场景5：解析器版本变化", () => {
  test("versionKey 变 → 键变；旧版本键下的条目不会被新版本命中", async () => {
    const { a } = twinZips();
    const ra = register(a, { sha: "d".repeat(64) });
    const limits = { ...DEFAULT_LIMITS, maxArchiveBytes: 0 };
    const live = liveOf(a);
    const identity = contentIdentity(ra, live).identity;
    const sample = await sampleOf(a);
    const v3 = archiveKey(identity, "zip", limits, sample);
    const v2 = cacheKey({ kind: "archive-listing", identity, versionKey: "archive:zip:v" + (ARCHIVE_PARSER_VERSION - 1), limitsHash: archiveLimitsHash(limits), extra: { sample: sample ?? "unreadable" } });
    assert.notEqual(v3, v2, "版本必须参与键");
    await cache.put("archive-listing", v2, { entries: [{ path: "OLD-V2.txt", size: 1, isDir: false }], limited: null, passwordProtected: false, truncated: false }, { kind: "archive-listing", contentSha: String(ra.sha256), versionKey: "v2" });
    const r = await stageArchive(makeCtx(), ra);
    assert.doesNotMatch(String(r.note), /cache hit/);
    assert.deepEqual(repo.getArchiveEntries(ra.id).map((e: any) => e.path), ["a1.txt"]);
  });
});

// ---------------------------------------------------------------- 6) limitsHash（含 upkg 预算，F6）

describe("场景6：limitsHash 变化只失效相关 kind", () => {
  test("archive：预算/条目上限变化 → 键变", async () => {
    const { a } = twinZips();
    const ra = register(a, { sha: "e".repeat(64) });
    const identity = contentIdentity(ra, liveOf(a)).identity;
    const base = { ...DEFAULT_LIMITS, maxArchiveBytes: 0 };
    const sample = await sampleOf(a);
    const k1 = archiveKey(identity, "zip", base, sample);
    const k2 = archiveKey(identity, "zip", { ...base, maxTotalReadBytes: 1024 }, sample);
    const k3 = archiveKey(identity, "zip", { ...base, maxArchiveEntries: 10 }, sample);
    assert.notEqual(k1, k2);
    assert.notEqual(k1, k3);
  });

  test("unitypackage：maxTotalReadBytes 变化必须失效（审计 F6 回归）", async () => {
    // 合成 unitypackage：一个 2MiB 资产 + pathname，默认预算(512MiB)不触发、1MiB 预算触发 BYTES
    const guid = "0123456789abcdef0123456789abcdef";
    const upkg = join(work, "pkg.unitypackage");
    writeFileSync(upkg, buildTarGz([
      { name: guid + "/asset", data: Buffer.alloc(2 * 1024 * 1024, 7) },
      { name: guid + "/pathname", data: Buffer.from("Assets/Big.mat") },
    ]));
    const ra = register(upkg, { container: "unitypackage" });

    const big = await stageUnityPackage(makeCtx(), ra);
    assert.equal(big.limited, null, "默认预算下应完整解析");

    const small = await stageUnityPackage(makeCtx({ maxTotalReadBytes: 1024 * 1024 }), ra);
    assert.equal(small.limited?.code, "BYTES", "预算变小后必须重新解析并命中 BYTES；若命中旧缓存会拿到 null");
  });
});

// ---------------------------------------------------------------- 7) 缓存损坏

describe("场景7：缓存损坏", () => {
  test("合法 JSON 但文件被破坏 → get 丢弃、stage 重算", async () => {
    const { a } = twinZips();
    const ra = register(a);
    await stageArchive(makeCtx(), ra);
    const identity = contentIdentity(ra, liveOf(a)).identity;
    const key = archiveKey(identity, "zip", { ...DEFAULT_LIMITS, maxArchiveBytes: 0 }, await sampleOf(a));
    const file = cache.pathFor(key, "archive-listing");
    writeFileSync(file, "{ this is not json");
    const r = await stageArchive(makeCtx(), ra);
    assert.doesNotMatch(String(r.note), /cache hit/);
    assert.deepEqual(repo.getArchiveEntries(ra.id).map((e: any) => e.path), ["a1.txt"]);
    assert.equal(repo.getCacheEntry(key)?.state, "ready", "重算后应写回可用于下次命中的条目");
  });
});

// ---------------------------------------------------------------- 8) 同内容共享（不过度限域）

describe("场景8：两资产同内容（强身份）", () => {
  test("同 sha 的两个资产只解析一次，两边都拿到正确目录", async () => {
    const { a } = twinZips();
    const b = join(work, "A-copy2.zip");
    writeFileSync(b, buildZip([{ name: "a1.txt", data: Buffer.alloc(100, 0x61) }]));
    const sha = "f".repeat(64);
    const ra = register(a, { sha });
    const rb = register(b, { sha });
    const first = await stageArchive(makeCtx(), ra);
    const second = await stageArchive(makeCtx(), rb);
    assert.doesNotMatch(String(first.note), /cache hit/);
    assert.match(String(second.note), /cache hit/);
    assert.deepEqual(repo.getArchiveEntries(rb.id).map((e: any) => e.path), ["a1.txt"]);
  });
});

// ---------------------------------------------------------------- F4 回归：命中校验

describe("F4：命中时 content_sha 不符 → drop + miss", () => {
  test("CacheLike.get 第三参不匹配 → 返回 null 且条目被删", async () => {
    const key = "a".repeat(32);
    await cache.put("archive-listing", key, { entries: [] }, { kind: "archive-listing", contentSha: "deadbeef", versionKey: "v1" });
    const miss = await cache.get("archive-listing", key, { contentSha: "cafebabe" });
    assert.equal(miss, null);
    assert.equal(repo.getCacheEntry(key), null, "不符的条目必须被丢弃，不能留在库里");
    // 对照：匹配 → 命中
    await cache.put("archive-listing", key, { entries: [{ path: "x", size: 1, isDir: false }] }, { kind: "archive-listing", contentSha: "deadbeef", versionKey: "v1" });
    const hit = await cache.get<any>("archive-listing", key, { contentSha: "deadbeef" });
    assert.equal(hit?.entries?.[0]?.path, "x");
  });

  test("stage 层：强身份条目 content_sha 与资产 sha 不符 → 重算而不是复用", async () => {
    const { a } = twinZips();
    const sha = "1".repeat(64);
    const ra = register(a, { sha });
    const identity = contentIdentity(ra, liveOf(a)).identity;
    const key = archiveKey(identity, "zip", { ...DEFAULT_LIMITS, maxArchiveBytes: 0 }, await sampleOf(a));
    await cache.put("archive-listing", key, { entries: [{ path: "POISON.txt", size: 1, isDir: false }], limited: null, passwordProtected: false, truncated: false }, { kind: "archive-listing", contentSha: "9".repeat(64), versionKey: "archive:zip:v" + ARCHIVE_PARSER_VERSION });
    const r = await stageArchive(makeCtx(), ra);
    assert.doesNotMatch(String(r.note), /cache hit/);
    assert.deepEqual(repo.getArchiveEntries(ra.id).map((e: any) => e.path), ["a1.txt"]);
  });
});

// ---------------------------------------------------------------- 残差收口：ino/dev 入弱键

describe("残差收口：ino/dev 纳入弱键", () => {
  test("① 同路径同 size+mtime 但换了文件（rename → 新 inode）→ 必须 miss，不拿旧目录", async () => {
    const { b } = twinZips();
    const victim = join(work, "victim.zip");
    // 先放 A 内容（与 twinZips 的 a1.txt 同长），mtime 对齐 B，保证"同 size + 同 mtime"
    writeFileSync(victim, buildZip([{ name: "a1.txt", data: Buffer.alloc(100, 0x61) }]));
    const bm = statSync(b).mtime;
    utimesSync(victim, bm, bm);
    const ra = register(victim);
    const inoBefore = Number(statSync(victim).ino);
    assert.ok(inoBefore > 0, "前置：本机 stat.ino 有效（否则弱键不含 ino）");

    const first = await stageArchive(makeCtx(), ra);
    assert.doesNotMatch(String(first.note), /cache hit/);
    assert.deepEqual(repo.getArchiveEntries(ra.id).map((e: any) => e.path), ["a1.txt"]);
    const idBefore = contentIdentity(ra, liveOf(victim)).identity;

    // rename 覆盖：内容换成 B、inode 变、size 与 mtime 都不变（唯一变量只剩 ino）
    const sizeBefore = statSync(victim).size;
    renameSync(b, victim);
    const live = liveOf(victim);
    assert.notEqual(Number(live.ino), inoBefore, "前置：rename 必须换 inode");
    assert.equal(live.size, sizeBefore, "前置：size 不变");
    assert.ok(Math.abs(Math.round(live.mtimeMs) - Date.parse(String(ra.mtime))) <= 2, "前置：mtime 不变（≤2ms）");
    const idNow = contentIdentity(ra, live).identity;
    assert.match(idNow, /:\d+:\d+$/, "弱键应带 ino:dev 后缀");
    assert.notEqual(idNow, idBefore, "同 size/mtime 换文件时，ino 必须让弱键变化");

    const second = await stageArchive(makeCtx(), ra);
    assert.doesNotMatch(String(second.note), /cache hit/, "换文件（新 inode）必须 miss");
    assert.deepEqual(repo.getArchiveEntries(ra.id).map((e: any) => e.path), ["b1.txt"]);
  });

  test("② 两个同内容副本（强 sha）→ 仍只解析一次（ino 不能把强身份拆开）", async () => {
    const bytes = buildZip([{ name: "a1.txt", data: Buffer.alloc(100, 0x61) }]);
    const c1 = join(work, "copy1.zip");
    const c2 = join(work, "copy2.zip");
    writeFileSync(c1, bytes);
    writeFileSync(c2, bytes);
    const sha = "3".repeat(64);
    const r1 = register(c1, { sha });
    const r2 = register(c2, { sha });
    assert.notEqual(Number(statSync(c1).ino), Number(statSync(c2).ino), "前置：两个副本 inode 不同");

    const first = await stageArchive(makeCtx(), r1);
    const second = await stageArchive(makeCtx(), r2);
    assert.doesNotMatch(String(first.note), /cache hit/);
    assert.match(String(second.note), /cache hit/, "同 sha 必须共享（强身份不看 ino）");
    assert.equal(repo.listCacheEntries("archive-listing").length, 1, "同内容只应产生一条缓存（一次解析）");
    assert.deepEqual(repo.getArchiveEntries(r2.id).map((e: any) => e.path), ["a1.txt"]);
  });
});

// ---------------------------------------------------------------- F5：weak 元数据不阻塞

describe("F5：meta.weak 写入", () => {
  test("v6 的 weak 列尚未迁移时也能写缓存（降级不阻塞）", async () => {
    const key = "b".repeat(32);
    const r = await cache.put("archive-listing", key, { entries: [] }, { kind: "archive-listing", contentSha: null, versionKey: "v1", weak: true });
    assert.ok(r.bytes > 0);
    assert.ok(await cache.get("archive-listing", key), "弱身份的条目也应能读回");
    // v6 迁移已落地时，weak 标记必须落库（DIAG 可按 weak 统计）；未迁移则跳过该断言
    const cols = (t.db.prepare("PRAGMA table_info(cache_entries)").all() as { name: string }[]).map((c) => c.name);
    if (cols.includes("weak")) {
      assert.equal(Number(repo.getCacheEntry(key)?.weak), 1, "meta.weak=true 必须写进 cache_entries.weak");
    }
  });
});


// ------------------------------------------------- FIX-05（task-33）：内容采样挡住元数据不可见的替换
//
// 采样 = sha256(head 64KiB + tail 64KiB + size) 前 16 hex，写入 cacheKey.extra.sample（强/弱身份都加）。
// 这些替换在 (size, mtime, ino, dev) 上完全不可见，只有采样能发现。

describe("FIX-05 内容采样：元数据不可见的替换", () => {
  /** 造一个"victim"文件：内容 A，size 与 mtime 对齐 B（保证 size/mtime 不变）。 */
  function victimWithA(tag: string, b: string): string {
    const victim = join(work, tag + "-victim.zip");
    writeFileSync(victim, buildZip([{ name: "a1.txt", data: Buffer.alloc(100, 0x61) }]));
    const at = statSync(b).mtime;
    utimesSync(victim, at, at);
    return victim;
  }

  test("① 就地覆盖（同 inode/size/mtime）→ 采样变 → MISS", async () => {
    const { a, b } = twinZips();
    void a;
    const victim = victimWithA("f5cp", b);
    const ra = register(victim);
    const sampleBefore = await sampleOf(victim);
    const first = await stageArchive(makeCtx(), ra);
    assert.match(String(first.note), /entries=/);

    const inoBefore = Number(statSync(victim).ino);
    overwriteInPlace(b, victim);
    assert.equal(Number(statSync(victim).ino), inoBefore, "前置：就地写，inode 不变");
    assert.notEqual(await sampleOf(victim), sampleBefore, "前置：内容变了采样必须变");

    const second = await stageArchive(makeCtx(), ra);
    assert.doesNotMatch(String(second.note), /cache hit/, "采样不同 → 不得命中旧目录");
    assert.deepEqual(repo.getArchiveEntries(ra.id).map((e: any) => e.path), ["b1.txt"]);
  });

  test("② 原地写 + utimes 回写 mtime（同 inode）→ 采样变 → MISS", async () => {
    const { b } = twinZips();
    const victim = victimWithA("f5write", b);
    const ra = register(victim);
    await stageArchive(makeCtx(), ra);
    const inoBefore = Number(statSync(victim).ino);
    const bytes = readFileSync(b);
    writeFileSync(victim, bytes);
    const at = statSync(b).mtime;
    utimesSync(victim, at, at);
    assert.equal(Number(statSync(victim).ino), inoBefore, "前置：写文件不改 inode");
    const second = await stageArchive(makeCtx(), ra);
    assert.doesNotMatch(String(second.note), /cache hit/);
    assert.deepEqual(repo.getArchiveEntries(ra.id).map((e: any) => e.path), ["b1.txt"]);
  });

  test("③ rename 替换（新 inode，同 size+mtime）→ MISS", async () => {
    const { b } = twinZips();
    const victim = victimWithA("f5rename", b);
    const ra = register(victim);
    await stageArchive(makeCtx(), ra);
    const inoBefore = Number(statSync(victim).ino);
    renameSync(b, victim);
    assert.notEqual(Number(statSync(victim).ino), inoBefore, "前置：rename 换 inode");
    const second = await stageArchive(makeCtx(), ra);
    assert.doesNotMatch(String(second.note), /cache hit/);
    assert.deepEqual(repo.getArchiveEntries(ra.id).map((e: any) => e.path), ["b1.txt"]);
  });

  test("④ 同 inode 截断重写 + 回写 mtime → MISS", async () => {
    const { b } = twinZips();
    const victim = victimWithA("f5trunc", b);
    const ra = register(victim);
    await stageArchive(makeCtx(), ra);
    const inoBefore = Number(statSync(victim).ino);
    truncateSync(victim, 0);
    writeFileSync(victim, readFileSync(b));
    const at = statSync(b).mtime;
    utimesSync(victim, at, at);
    assert.equal(Number(statSync(victim).ino), inoBefore, "前置：truncate+write 不改 inode");
    const second = await stageArchive(makeCtx(), ra);
    assert.doesNotMatch(String(second.note), /cache hit/);
    assert.deepEqual(repo.getArchiveEntries(ra.id).map((e: any) => e.path), ["b1.txt"]);
  });

  test("⑤ 陈旧 sha + 同 size+mtime 替换：强身份仍在，但采样让键变（旧 sha 键不被污染）", async () => {
    const { b } = twinZips();
    const victim = victimWithA("f5stale", b);
    const staleSha = "9".repeat(64);
    const ra = register(victim, { sha: staleSha });
    const first = await stageArchive(makeCtx(), ra);
    assert.match(String(first.note), /entries=/);
    const sampleBefore = await sampleOf(victim);
    const keyBefore = archiveKey("sha256:" + staleSha, "zip", { ...DEFAULT_LIMITS, maxArchiveBytes: 0 }, sampleBefore);
    assert.ok(await cache.get("archive-listing", keyBefore), "前置：旧 sha 键下已有条目");

    overwriteInPlace(b, victim); // 同 inode/size/mtime，内容变了
    const row = repo.getAsset(ra.id)!;
    const live = liveOf(victim);
    assert.equal(contentIdentity(row, live).weak, false, "前置：元数据仍匹配 → 仍走强身份");
    assert.notEqual(await sampleOf(victim), sampleBefore);

    const second = await stageArchive(makeCtx(), row);
    assert.doesNotMatch(String(second.note), /cache hit/, "采样不同 → 强身份也必须 miss");
    assert.deepEqual(repo.getArchiveEntries(ra.id).map((e: any) => e.path), ["b1.txt"]);
    // 旧键（旧采样）仍保留旧内容条目，没有被新内容覆盖 → 不会污染拥有旧 sha 的其他资产
    const old = await cache.get<any>("archive-listing", keyBefore, { contentSha: staleSha });
    assert.deepEqual(old?.entries?.map((e: any) => e.path), ["a1.txt"], "旧 sha 键不得被新内容覆盖");
  });

  test("⑥ 两资产同内容（同 sha + 同采样）→ 仍只解析一次", async () => {
    const { a } = twinZips();
    const c1 = join(work, "f5-copy1.zip");
    const c2 = join(work, "f5-copy2.zip");
    const bytes = buildZip([{ name: "a1.txt", data: Buffer.alloc(100, 0x61) }]);
    writeFileSync(c1, bytes);
    writeFileSync(c2, bytes);
    assert.equal(await sampleOf(c1), await sampleOf(c2), "同内容 → 采样相同");
    const sha = "7".repeat(64);
    const r1 = register(c1, { sha });
    const r2 = register(c2, { sha });
    const before = repo.listCacheEntries("archive-listing").length;
    await stageArchive(makeCtx(), r1);
    const second = await stageArchive(makeCtx(), r2);
    assert.match(String(second.note), /cache hit/);
    assert.equal(repo.listCacheEntries("archive-listing").length - before, 1, "同内容只应新增一条缓存");
    assert.deepEqual(repo.getArchiveEntries(r2.id).map((e: any) => e.path), ["a1.txt"]);
    void a;
  });
});

// ------------------------------------------------- AUD-03：scan 重置 sha 与身份降级的联动
// 说明：AUD-03 对抗脚本（scripts/audit-cache-identity-adversarial.ts）覆盖了"同 size+mtime 替换"的残差；
// 这里只钉住**正确路径**：metadata 变化 → scan 重置 sha → 强身份失效 → 重新解析。

describe("AUD-03：scan 重置 sha 后强身份失效", () => {
  test("mtime 变化 → upsertAsset 把 sha 重置为 pending → stageArchive 不再走旧 sha 键", async () => {
    const { a } = twinZips();
    const sha = "5".repeat(64);
    const ra = register(a, { sha });
    const first = await stageArchive(makeCtx(), ra);
    assert.doesNotMatch(String(first.note), /cache hit/);

    // 模拟"文件被替换后又被扫描到"：mtime 变（size 不变也一样触发重置）
    const later = new Date(statSync(a).mtimeMs + 5000);
    utimesSync(a, later, later);
    const st = statSync(a);
    const up = repo.upsertAsset({
      item_id: itemId, kind: "archive", container: "zip",
      path: a, path_norm: a.toLowerCase(), root_id: rootId,
      size: st.size, mtime: st.mtime.toISOString(), discovered_by: "scan",
    });
    const row = repo.getAsset(up.asset.id)!;
    assert.equal(row.sha256, null, "metadata 变化后旧 sha 必须作废");
    assert.equal(row.sha256_state, "pending");

    const id = contentIdentity(row, liveOf(a));
    assert.equal(id.weak, true, "sha 作废后只能走弱身份");
    const second = await stageArchive(makeCtx(), row);
    assert.doesNotMatch(String(second.note), /cache hit/, "弱键含新 mtime，不得命中旧条目");
  });
});
