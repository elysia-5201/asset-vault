/**
 * 归档元数据模式：缓存身份 + 落库摘要（新仪器，RED→GREEN）
 *
 * 需求：新语义进 cache 身份 → 旧严格 listing 缓存不得冒充元数据模式结果；
 *       同语义可复用；摘要（完整/停止原因/flags）随缓存与 assets 行持久化。
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTempDb, addItem, addRoot, type TempDb } from "../schema/_db";
import { Repo } from "../../apps/server/src/db/repo";
import { DerivedCache, cacheKey } from "../../apps/server/src/services/pipeline/cache";
import { contentSample, stageArchive, type StageCtx } from "../../apps/server/src/services/pipeline/stages";
import { DEFAULT_LIMITS, type PipelineLimits } from "../../apps/server/src/services/pipeline/limits";
import { ARCHIVE_PARSER_VERSION, listArchive } from "../../packages/core/src/archive/list";
import { buildZip } from "../../packages/core/test/content/fixtures";

const MiB = 1024 * 1024;
let t: TempDb, repo: Repo, root: string, cache: DerivedCache, work: string, itemId: number, rootId: number;

beforeEach(() => {
  t = openTempDb(); repo = new Repo(t.db);
  root = mkdtempSync(join(tmpdir(), "av-meta-cache-root-"));
  work = mkdtempSync(join(tmpdir(), "av-meta-cache-"));
  cache = new DerivedCache(root, repo, () => {});
  itemId = addItem(t.db, { title: "元数据缓存用例" });
  rootId = addRoot(t.db, root.toLowerCase(), root);
});
afterEach(() => { for (const d of [root, work]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } } t.close(); });

function makeCtx(limits: Partial<PipelineLimits> = {}): StageCtx {
  return {
    repo, media: {} as any, cache,
    limits: { ...DEFAULT_LIMITS, maxArchiveBytes: 0, maxTotalReadBytes: 3 * MiB, maxEntryBytes: 1 * MiB, ...limits },
    log: () => {}, signal: new AbortController().signal, progress: () => {},
  };
}

function makeZip(name: string): { path: string; asset: any } {
  const path = join(work, name);
  writeFileSync(path, buildZip([
    { name: "a.txt", data: Buffer.alloc(1024, 0x61) },
    { name: "big.psd", data: Buffer.alloc(2 * MiB, 0) },
    { name: "big2.psd", data: Buffer.alloc(2 * MiB, 0) },
    { name: "pack.unitypackage", data: Buffer.alloc(2048, 0x62) },
  ]));
  const st = statSync(path);
  const { asset } = repo.upsertAsset({
    item_id: itemId, kind: "archive", container: "zip", path, path_norm: path.toLowerCase(),
    root_id: rootId, size: st.size, mtime: st.mtime.toISOString(), discovered_by: "scan",
  });
  return { path, asset: repo.getAsset(asset.id)! };
}

const oldStrictKey = async (path: string, assetId: number, limits: PipelineLimits) => cacheKey({
  kind: "archive-listing", identity: "asset:" + assetId, versionKey: "archive:zip:v" + ARCHIVE_PARSER_VERSION,
  limitsHash: cacheKey({ kind: "limits", identity: "l", versionKey: "", extra: {
    maxEntries: limits.maxArchiveEntries, maxEntryBytes: limits.maxEntryBytes,
    maxTotalReadBytes: limits.maxTotalReadBytes, maxCompressionRatio: limits.maxCompressionRatio,
  } }),
  extra: { sample: (await contentSample(path, statSync(path).size)) ?? "unreadable" },
});

describe("元数据模式：目录列全 + 缓存身份分离", () => {
  test("旧严格 listing 缓存不冒充元数据结果；同语义命中；摘要落库", async () => {
    const { path, asset } = makeZip("meta.zip");
    const limits = { ...DEFAULT_LIMITS, maxArchiveBytes: 0, maxTotalReadBytes: 3 * MiB, maxEntryBytes: 1 * MiB };
    // 埋一条旧严格缓存（前缀）——若实现仍用同一键，就会返回这条假前缀
    const poison = [{ path: "a.txt", size: 1024, isDir: false }];
    const strictLimits = limits;
    const strictListing = await listArchive(path, {
      maxEntries: strictLimits.maxArchiveEntries, maxEntryBytes: strictLimits.maxEntryBytes,
      maxTotalBytes: strictLimits.maxTotalReadBytes, maxCompressionRatio: strictLimits.maxCompressionRatio,
    });
    assert.equal(strictListing.entries.length, 2, "前置：严格模式确实只列前缀");
    const k = await oldStrictKey(path, asset.id, strictLimits);
    await cache.put("archive-listing", k, { entries: poison, limited: null, passwordProtected: false, truncated: false }, {
      kind: "archive-listing", contentSha: null, versionKey: "archive:zip:v" + ARCHIVE_PARSER_VERSION,
    });

    const r1 = await stageArchive(makeCtx(), asset);
    assert.doesNotMatch(String(r1.note), /cache hit/, "旧严格缓存不得命中元数据模式调用");
    assert.equal(r1.itemsTotal, 4, "元数据模式必须列全 4 条");
    assert.deepEqual(repo.getArchiveEntries(asset.id).map((e: any) => e.path).sort(), ["a.txt", "big.psd", "big2.psd", "pack.unitypackage"]);
    const row = repo.getAsset(asset.id) as any;
    const summary = JSON.parse(String(row.archive_listing));
    assert.equal(summary.mode, "metadata");
    assert.equal(summary.complete, true);
    assert.equal(summary.listedEntries, 4);
    assert.equal(summary.contentReadLimited, true, "目录完整不等于文件都能解压");

    const r2 = await stageArchive(makeCtx(), asset);
    assert.match(String(r2.note), /cache hit/, "同语义应复用缓存");
    assert.equal(r2.itemsTotal, 4);
  });
});
